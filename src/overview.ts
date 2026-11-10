// The pull request Overview: one webview tab with where the open pull request stands (reviews,
// checks, conflicts), the reviewer's progress, the description and the conversation, with a merge
// box that merges it. It also keeps the short status the Review panel shows on the pull
// request's row.
import * as vscode from 'vscode';
import type { ReviewState } from './state.ts';
import type { VisualReview } from './visualReview.ts';
import type { GhOverview } from './github.ts';
import { mergeVerdict, summarizeChecks, summarizeReviews, type StatusLine } from './core/prStatus.ts';
import { reviewOrder } from './tree.ts';
import { showIfGitHubDown } from './notify.ts';
import type { MergeAction, OverviewHostMessage, OverviewMessage, ProgressVM } from './webview/overviewProtocol.ts';

/** How often the page asks GitHub again while checks run or mergeability is being worked out. */
const POLL_MS = 15_000;
/** After this long, showing the tab again fetches fresh data. */
const STALE_MS = 60_000;

/** The status of the open pull request, short enough for the Review panel. */
export interface PrStatus {
  verdict: StatusLine;
  reviews: StatusLine;
  checks: StatusLine;
}

export class OverviewPage implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  /** A tab from before a reload that VS Code handed back, while it waits for the pull request. */
  private reviving?: vscode.WebviewPanel;
  /** The last answer from GitHub, for the pull request it belongs to. */
  private data?: { key: string; overview: GhOverview; full: boolean; at: number };
  private loading?: Promise<void>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private refetchTimer?: ReturnType<typeof setTimeout>;
  private staleTimer?: ReturnType<typeof setTimeout>;
  private readonly statusChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeStatus = this.statusChanged.event;
  private readonly disposables: vscode.Disposable[] = [];
  // Rendering is in the lazily loaded view model, as for the review page.
  private model?: Promise<typeof import('./overviewModel.ts')>;

  constructor(
    private readonly state: ReviewState,
    private readonly visual: VisualReview,
    private readonly ctx: vscode.ExtensionContext,
  ) {
    this.disposables.push(
      this.statusChanged,
      vscode.window.registerWebviewPanelSerializer('nbreview.overview', {
        deserializeWebviewPanel: panel => this.restore(panel),
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.checkStaleTabs()),
      { dispose: () => [this.pollTimer, this.refetchTimer, this.staleTimer].forEach(t => clearTimeout(t)) },
      state.onDidChange(e => {
        if (e.session) {
          this.data = undefined;
          this.statusChanged.fire();
          if (!state.session) {
            this.panel?.dispose();
            return;
          }
          if (this.panel) {
            this.panel.title = this.title();
          }
          void this.fetch(!!this.panel);
        } else if (e.threads) {
          // A submitted review changes the decision, and new comments the conversation.
          clearTimeout(this.refetchTimer);
          this.refetchTimer = setTimeout(() => void this.fetch(!!this.panel), 1500);
        }
        if (e.viewed || e.drafts || e.threads || e.session) {
          this.postProgress();
        }
      }),
    );
    // Right after Restart Extensions no tab changes, but a tab of the old version may be showing.
    this.checkStaleTabs();
  }

  dispose(): void {
    this.panel?.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  /** The open pull request's status, once GitHub has answered. */
  status(): PrStatus | undefined {
    const d = this.data;
    if (!d || d.key !== this.state.prKey()) {
      return undefined;
    }
    const checks = summarizeChecks(d.overview.checks);
    return {
      verdict: mergeVerdict({ ...d.overview, checks }),
      reviews: summarizeReviews(d.overview.reviewDecision, d.overview.reviewers),
      checks,
    };
  }

  open(viewColumn = vscode.ViewColumn.Active): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    if (!this.state.session) {
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'nbreview.overview',
      this.title(),
      { viewColumn, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.dist()], enableFindWidget: true },
    );
    this.adopt(panel);
  }

  refresh(): Promise<void> {
    return this.fetch(true);
  }

  private async restore(panel: vscode.WebviewPanel): Promise<void> {
    this.reviving = panel;
    try {
      await this.state.restoring;
    } finally {
      this.reviving = undefined;
    }
    if (this.state.session && !this.panel) {
      panel.webview.options = { enableScripts: true, localResourceRoots: [this.dist()] };
      this.adopt(panel);
    } else {
      panel.dispose();
    }
  }

  private checkStaleTabs(): void {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => void this.replaceStaleTab(), 2000);
  }

  /**
   * After an update with Restart Extensions, an Overview tab left open keeps the old version's
   * page, which nothing answers any more (see VisualReview.replaceStaleTabs). It is closed and
   * opened again in its place.
   */
  private async replaceStaleTab(): Promise<void> {
    await this.state.restoring;
    if (!this.state.session) {
      return;
    }
    for (const group of vscode.window.tabGroups.all) {
      const tab = group.activeTab;
      if (!(tab?.input instanceof vscode.TabInputWebview) || !tab.input.viewType.endsWith('nbreview.overview')) {
        continue;
      }
      const ours = [this.panel, this.reviving].some(p => p?.visible && p.viewColumn === group.viewColumn);
      if (!ours) {
        await vscode.window.tabGroups.close(tab, true);
        this.open(group.viewColumn);
      }
    }
  }

  private title(): string {
    return `Overview · #${this.state.session?.pr.number ?? ''}`;
  }

  private dist(): vscode.Uri {
    return vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.title = this.title();
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        clearTimeout(this.pollTimer);
      }
    });
    panel.onDidChangeViewState(() => {
      if (panel.visible && (!this.data?.full || Date.now() - this.data.at > STALE_MS)) {
        void this.fetch(true);
      } else if (panel.visible) {
        this.schedulePoll();
      }
    });
    panel.webview.onDidReceiveMessage((msg: OverviewMessage) => {
      this.handle(msg).catch(e => {
        showIfGitHubDown(e);
        this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    });
  }

  private async handle(msg: OverviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.postProgress();
        if (this.data?.full && this.data.key === this.state.prKey()) {
          await this.postOverview();
          if (Date.now() - this.data.at > STALE_MS) {
            await this.fetch(true);
          }
        } else {
          await this.fetch(true);
        }
        return;
      case 'refresh':
        await this.fetch(true);
        return;
      case 'openFile':
        this.visual.open(msg.path, msg.cellKey);
        return;
      case 'nextFile':
        await vscode.commands.executeCommand('nbreview.nextFile');
        return;
      case 'submitReview':
        await vscode.commands.executeCommand('nbreview.submitReview');
        return;
      case 'merge':
        await this.act('merge', o => this.state.session!.gh.mergePullRequest(o.nodeId, msg));
        // It leaves the lists of pull requests to review.
        void vscode.commands.executeCommand('nbreview.refreshPrs');
        return;
      case 'markReady':
        await this.act('markReady', o => this.state.session!.gh.markReadyForReview(o.nodeId));
        return;
      case 'updateBranch':
        if (await this.act('updateBranch', o => this.state.session!.gh.updateBranch(o.nodeId, msg.expectedHeadOid), false)) {
          // The branch has a new commit: the files are loaded again, and the page with them.
          await vscode.commands.executeCommand('nbreview.refresh');
        }
        return;
      case 'reloadPr':
        await vscode.commands.executeCommand('nbreview.refresh');
        return;
      case 'deleteBranch':
        await this.act('deleteBranch', o => (o.headRefId ? this.state.session!.gh.deleteBranch(o.headRefId) : Promise.resolve()));
        return;
      case 'openExternal':
        if (/^https?:\/\//.test(msg.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        return;
      case 'copyLink':
        await vscode.commands.executeCommand('nbreview.copyPrLink');
        return;
    }
  }

  /**
   * Runs one of the merge box's actions on the pull request the page shows, tells the page how it
   * went, and (unless `refetch` is false) asks GitHub for the new state.
   */
  private async act(action: MergeAction, run: (o: GhOverview) => Promise<void>, refetch = true): Promise<boolean> {
    const o = this.data?.overview;
    if (!o || this.data?.key !== this.state.prKey()) {
      this.post({ type: 'done', action, ok: false, message: 'The pull request changed; look again before trying.' });
      return false;
    }
    try {
      await run(o);
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).replace(/^GitHub GraphQL: /, '');
      this.post({ type: 'done', action, ok: false, message });
      return false;
    }
    this.post({ type: 'done', action, ok: true });
    if (refetch) {
      await this.fetch(true);
    }
    return true;
  }

  /**
   * Asks GitHub where the pull request stands; `full` also fetches the conversation, for the
   * page. Calls made while one is under way wait for it, and then fetch again only if they need
   * more than it got.
   */
  private async fetch(full: boolean): Promise<void> {
    while (this.loading) {
      await this.loading.catch(() => undefined);
    }
    const s = this.state.session;
    if (!s) {
      return;
    }
    const key = this.state.prKey();
    clearTimeout(this.pollTimer);
    this.post({ type: 'loading', loading: true });
    this.loading = (async () => {
      try {
        const overview = await s.gh.getOverview(s.pr.owner, s.pr.repo, s.pr.number, full);
        if (this.state.prKey() !== key) {
          return;
        }
        // A status-only answer keeps the conversation fetched before.
        const keep = !full && this.data?.key === key && this.data.full;
        this.data = keep
          ? { ...this.data!, overview: { ...overview, timeline: this.data!.overview.timeline, timelineMissing: this.data!.overview.timelineMissing }, at: Date.now() }
          : { key, overview, full, at: Date.now() };
        this.statusChanged.fire();
        await this.postOverview();
      } catch (e) {
        this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      } finally {
        this.post({ type: 'loading', loading: false });
      }
    })();
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
    this.schedulePoll();
  }

  /** While checks run or GitHub works out whether it merges, the open page asks again now and then. */
  private schedulePoll(): void {
    clearTimeout(this.pollTimer);
    const o = this.data?.overview;
    if (!this.panel?.visible || !o || o.state !== 'OPEN') {
      return;
    }
    const unknown = o.mergeable === 'UNKNOWN' || o.mergeStateStatus === 'UNKNOWN';
    if (unknown || o.checks.some(c => c.state === 'pending')) {
      // Mergeability is usually worked out within seconds of being asked for.
      this.pollTimer = setTimeout(() => void this.fetch(true), unknown ? 3000 : POLL_MS);
    }
  }

  private async postOverview(): Promise<void> {
    const s = this.state.session;
    if (!this.panel || !s || !this.data?.full) {
      return;
    }
    const model = await (this.model ??= import('./overviewModel.ts'));
    this.post({ type: 'overview', overview: await model.buildOverview(this.data.overview, s, new Date(this.data.at)) });
  }

  private postProgress(): void {
    const s = this.state.session;
    if (!this.panel || !s) {
      return;
    }
    const order = reviewOrder(this.state);
    const progress: ProgressVM = {
      files: order.length,
      viewed: order.filter(p => this.state.isViewed(p)).length,
      pending: this.state.pendingCount(),
      pendingReview: this.state.hasPendingReview(),
      unresolved: s.allThreads().filter(t => !t.isResolved && t.comments.some(c => !c.pending)).length,
      nextFile: order.find(p => !this.state.isViewed(p)),
    };
    this.post({ type: 'progress', progress });
  }

  private post(msg: OverviewHostMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.dist(), ...p)).toString();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const pr = this.state.session?.pr;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('overview.css')}">
</head>
<body data-pr="${pr ? `${pr.owner}/${pr.repo}#${pr.number}` : ''}">
<div id="app"></div>
<script nonce="${nonce}" src="${uri('overview.js')}"></script>
</body>
</html>`;
  }
}
