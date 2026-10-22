// The review page: one webview panel per changed file, showing a notebook's rendered cells and
// outputs, or any other file as one highlighted (or, for Markdown, rendered) cell, with the same
// comment threads as the text diff and the same toolbar for both.
import * as vscode from 'vscode';
import type { NewFileComment, ReviewState } from './state.ts';
import { planFileComment } from './core/fileComments.ts';
import type { Anchor } from './webview/protocol.ts';
import type { TextReview } from './textReview.ts';
import { docLinesForAnchor, headerLine } from './core/reviewDoc.ts';
import type { HostMessage, SinceState, ViewModel, WebviewMessage } from './webview/protocol.ts';
import { basename } from './paths.ts';

export class VisualReview implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  /** Notebooks shown compared with the viewer's last review instead of the pull request's base. */
  private readonly sinceOn = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly state: ReviewState,
    private readonly text: TextReview,
    private readonly ctx: vscode.ExtensionContext,
  ) {
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer('nbreview.visual', {
        deserializeWebviewPanel: (panel, saved) => this.restore(panel, saved),
      }),
      // Changing the setting takes over from the last switch in a page.
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('nbreview.hideNoise')) {
          void this.setHideNoise(undefined);
        }
      }),
      state.onDidChange(e => {
        for (const [path, panel] of this.panels) {
          if (e.session) {
            if (!this.reviewable(path)) {
              panel.dispose();
              continue;
            }
            panel.title = this.title(path);
          }
          void this.sync(panel, path, { model: !!e.session, threads: !!(e.session || e.drafts || e.threads) });
        }
      }),
    );
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    vscode.Disposable.from(...this.disposables).dispose();
  }

  open(nbPath: string, revealCellId?: string, options: { since?: boolean } = {}): void {
    if (options.since !== undefined) {
      this.setSince(nbPath, options.since);
    }
    const existing = this.panels.get(nbPath);
    if (existing) {
      existing.reveal();
      if (options.since !== undefined) {
        void this.sync(existing, nbPath, { model: true, threads: true });
      }
      if (revealCellId) {
        this.post(existing, { type: 'reveal', cellKey: revealCellId });
      }
      return;
    }
    if (!this.state.session || !this.reviewable(nbPath)) {
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'nbreview.visual',
      '',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.dist()], enableFindWidget: true },
    );
    this.adopt(panel, nbPath, revealCellId);
  }

  /** Brings back review tabs that were open when VS Code was reloaded. */
  private async restore(panel: vscode.WebviewPanel, saved: unknown): Promise<void> {
    await this.state.restoring;
    const nbPath = (saved as { path?: string } | undefined)?.path;
    if (nbPath && this.reviewable(nbPath) && !this.panels.has(nbPath)) {
      panel.webview.options = { enableScripts: true, localResourceRoots: [this.dist()] };
      this.adopt(panel, nbPath);
    } else {
      panel.dispose();
    }
  }

  private title(path: string): string {
    return `${this.state.entry(path) ? '📓' : '📄'} ${basename(path)} · #${this.state.session?.pr.number ?? ''}`;
  }

  /** A notebook or another file of the pull request under review. */
  private reviewable(path: string): boolean {
    return !!this.state.entry(path) || !!this.state.session?.files.some(f => f.filename === path);
  }

  /** A comment on an ordinary file, from where it was made in the page: some of its lines, or the whole file. */
  private fileComment(path: string, anchor: Anchor, text: string): NewFileComment {
    if (anchor.kind !== 'source' || anchor.start === undefined) {
      return { path, side: 'RIGHT', startLine: 1, endLine: 1, text, wholeFile: true };
    }
    return { path, side: anchor.side, startLine: anchor.start + 1, endLine: (anchor.end ?? anchor.start) + 1, text };
  }

  private dist(): vscode.Uri {
    return vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
  }

  private adopt(panel: vscode.WebviewPanel, nbPath: string, revealCellId?: string): void {
    panel.title = this.title(nbPath);
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(panel.webview, this.dist(), nbPath);
    this.panels.set(nbPath, panel);
    let pendingReveal = revealCellId;
    panel.onDidDispose(() => this.panels.delete(nbPath));
    panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this.handle(nbPath, panel, msg).catch(e => {
        this.post(panel, { type: 'error', message: e instanceof Error ? e.message : String(e) });
      });
      if (msg.type === 'ready' && pendingReveal) {
        this.post(panel, { type: 'reveal', cellKey: pendingReveal });
        pendingReveal = undefined;
      }
    });
  }

  private async handle(nbPath: string, panel: vscode.WebviewPanel, msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.sync(panel, nbPath, { model: true, threads: true });
        return;
      case 'plan': {
        if (!this.state.entry(nbPath)) {
          const c = this.fileComment(nbPath, msg.anchor, '');
          const plan = planFileComment({ ...c, commentable: this.state.session!.commentable(nbPath) });
          this.post(panel, { type: 'plan', requestId: msg.requestId, describe: `Will post as ${/^[aeiou]/.test(plan.describe) ? 'an' : 'a'} ${plan.describe}` });
          return;
        }
        const doc = this.state.doc(nbPath, msg.anchor.side);
        const lines = doc && docLinesForAnchor(doc, msg.anchor);
        const plan = lines && this.state.plan({ nbPath, side: msg.anchor.side, startDocLine: lines.start, endDocLine: lines.end, text: '' });
        this.post(panel, { type: 'plan', requestId: msg.requestId, describe: plan ? `Will post as ${/^[aeiou]/.test(plan.describe) ? 'an' : 'a'} ${plan.describe}` : '' });
        return;
      }
      case 'addComment': {
        if (msg.anchor.side === 'LEFT' && this.since(nbPath)?.on) {
          throw new Error('The old side shows your last review, which is not part of the pull request: comment on the new side.');
        }
        if (!this.state.entry(nbPath)) {
          const comment = this.fileComment(nbPath, msg.anchor, msg.text);
          await (msg.mode === 'single' ? this.state.postSingle(comment) : this.state.addDraft(comment));
          return;
        }
        const doc = this.state.doc(nbPath, msg.anchor.side);
        const lines = doc && docLinesForAnchor(doc, msg.anchor);
        if (!lines) {
          throw new Error('That cell is no longer in the notebook.');
        }
        const draft = { nbPath, side: msg.anchor.side, startDocLine: lines.start, endDocLine: lines.end, text: msg.text };
        await (msg.mode === 'single' ? this.state.postSingle(draft) : this.state.addDraft(draft));
        return;
      }
      case 'reply': {
        const placed = this.state.session?.placed.find(p => p.gh.id === msg.threadId);
        const onFile = this.state.session?.fileThreads.get(nbPath)?.find(f => f.gh.id === msg.threadId);
        if (!placed && onFile) {
          const line = onFile.docLine + 1;
          const reply = { path: nbPath, side: onFile.side, startLine: line, endLine: line, text: msg.text, replyTo: msg.threadId };
          await (msg.mode === 'single' ? this.state.postSingle(reply) : this.state.addDraft(reply));
          return;
        }
        if (!placed) {
          throw new Error('That thread is no longer on the pull request.');
        }
        const draft = { nbPath: placed.nbPath, side: placed.side, startDocLine: placed.docLine, endDocLine: placed.docLine, text: msg.text, replyTo: msg.threadId };
        await (msg.mode === 'single' ? this.state.postSingle(draft) : this.state.addDraft(draft));
        return;
      }
      case 'editComment':
        await this.state.editComment(msg.id, msg.text);
        return;
      case 'deleteComment':
        await this.state.deleteComment(msg.id);
        return;
      case 'resolve':
        await this.state.setResolved(msg.threadId, msg.resolved);
        return;
      case 'react':
        await this.state.react(msg.commentId, msg.content, msg.add);
        return;
      case 'setHideNoise':
        await this.setHideNoise(msg.on);
        return;
      case 'setSince':
        this.setSince(nbPath, msg.on);
        await this.sync(panel, nbPath, { model: true, threads: true });
        return;
      case 'discardReview':
        await this.state.discardReview();
        return;
      case 'submitReview':
        try {
          const url = await vscode.commands.executeCommand<string>('nbreview.submitReview', { event: msg.event, body: msg.body });
          this.post(panel, { type: 'submitted', ok: true, url });
        } catch (e) {
          this.post(panel, { type: 'submitted', ok: false, message: e instanceof Error ? e.message : String(e) });
        }
        return;
      case 'setViewed':
        await this.state.setViewed([nbPath], msg.viewed);
        return;
      case 'openTextDiff': {
        if (!this.state.entry(nbPath)) {
          await this.text.openFileDiff(nbPath);
          return;
        }
        const doc = this.state.doc(nbPath, 'RIGHT');
        const line = msg.cellId && doc ? headerLine(doc, msg.cellId) : undefined;
        await this.text.openDiff(nbPath, line === undefined ? undefined : { side: 'RIGHT', docLine: line });
        return;
      }
      case 'nextFile':
        await vscode.commands.executeCommand('nbreview.nextFile', nbPath);
        return;
      case 'openExternal':
        if (/^https?:\/\//.test(msg.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        return;
    }
  }

  // Rendering (KaTeX, markdown-it, highlight.js) is most of the bundle; it is only loaded once a
  // notebook is opened in the visual review, so the extension itself starts quickly.
  private viewModel?: Promise<typeof import('./viewModel.ts')>;

  /**
   * Whether cells whose only change is outputs or whitespace are folded away. The page's switch
   * is remembered for every notebook; the setting gives the default. (Commands don't write
   * settings: right after an update VS Code may not have registered a new one yet.)
   */
  private hideNoise(): boolean {
    return this.ctx.globalState.get<boolean>('hideNoise') ?? vscode.workspace.getConfiguration('nbreview').get<boolean>('hideNoise', false);
  }

  private async setHideNoise(on: boolean | undefined): Promise<void> {
    await this.ctx.globalState.update('hideNoise', on);
    await Promise.all([...this.panels].map(([path, panel]) => this.sync(panel, path, { model: true })));
  }

  private setSince(nbPath: string, on: boolean): void {
    if (on) {
      this.sinceOn.add(nbPath);
    } else {
      this.sinceOn.delete(nbPath);
    }
  }

  /** Sends the page what changed, in order: the notebook, then its threads, then the toolbar state. */
  private async sync(panel: vscode.WebviewPanel, nbPath: string, what: { model?: boolean; threads?: boolean }): Promise<void> {
    const vm = await (this.viewModel ??= import('./viewModel.ts'));
    const s = this.state.session;
    const entry = this.state.entry(nbPath);
    const since = this.since(nbPath);
    const file = s?.files.find(f => f.filename === nbPath);
    if (s && file && !entry) {
      if (what.model) {
        this.post(panel, { type: 'model', model: await this.fileModel(vm, nbPath, since) });
      }
      if (what.threads) {
        const list = (s.fileThreads.get(nbPath) ?? []).filter(f => !since?.on || f.side === 'RIGHT');
        this.post(panel, { type: 'threads', threads: vm.buildFileThreads(list, gh => this.state.describe(gh)) });
      }
      this.post(panel, this.stateMessage(nbPath));
      return;
    }
    if (s && entry && what.model) {
      const base = since?.on ? await s.sinceReviewDoc(nbPath) : undefined;
      const pr = { number: s.pr.number, title: s.pr.title, url: s.pr.url };
      const model = vm.buildViewModel(entry, pr, base && since ? { base, label: since.label } : undefined, { hideNoise: this.hideNoise() });
      this.post(panel, { type: 'model', model });
    }
    if (what.threads) {
      // Compared with the last review, the old side isn't the pull request's: its threads are left out.
      const placed = s ? s.threadsFor(nbPath).filter(p => !since?.on || p.side === 'RIGHT') : [];
      const threads = s && entry ? vm.buildThreads(entry, placed, p => this.state.describe(p.gh)) : [];
      this.post(panel, { type: 'threads', threads });
    }
    this.post(panel, this.stateMessage(nbPath));
  }

  /** An ordinary file as one cell; binary and very large files get a notice instead. */
  private async fileModel(vm: typeof import('./viewModel.ts'), path: string, since: SinceState | undefined): Promise<ViewModel> {
    const s = this.state.session!;
    const file = s.files.find(f => f.filename === path)!;
    const pr = { number: s.pr.number, title: s.pr.title, url: s.pr.url };
    const [base, head] = await Promise.all([s.content(path, 'LEFT'), s.content(path, 'RIGHT')]);
    let old = base;
    if (since?.on && s.lastReview) {
      old = (await s.contentAt(path, s.lastReview.sha)) ?? (file.previousFilename ? await s.contentAt(file.previousFilename, s.lastReview.sha) : undefined);
    }
    const unreadable = [old, head].find(t => t !== undefined && (t.length > 2_000_000 || t.slice(0, 8000).includes('\u0000')));
    if (unreadable !== undefined) {
      const notice = unreadable.length > 2_000_000
        ? 'This file is too large to show here.'
        : 'This is a binary file, so there is nothing to show line by line.';
      return { ...vm.buildFileViewModel(file, undefined, undefined, pr), notice };
    }
    return vm.buildFileViewModel(file, old, head, pr, since?.on ? { label: since.label } : undefined, { hideNoise: this.hideNoise() });
  }

  /** Whether the file can be, and is, compared with the viewer's last review. */
  private since(nbPath: string): SinceState | undefined {
    const s = this.state.session;
    const last = s?.lastReview;
    if (!s || !last) {
      return undefined;
    }
    const date = new Date(last.submittedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const label = `your review on ${date} (${last.sha.slice(0, 7)})`;
    if (s.sinceReviewProblem) {
      return { available: false, on: false, label, problem: s.sinceReviewProblem };
    }
    const available = s.changedSince(nbPath);
    return {
      available,
      on: available && this.sinceOn.has(nbPath),
      label,
      ...(available ? {} : { problem: `No changes to this ${this.state.entry(nbPath) ? 'notebook' : 'file'} since ${label}.` }),
    };
  }

  private stateMessage(nbPath: string): HostMessage {
    return {
      type: 'state',
      state: {
        viewed: this.state.isViewed(nbPath),
        pending: this.state.pendingCount(),
        pendingReview: this.state.hasPendingReview(),
        since: this.since(nbPath),
      },
    };
  }

  private post(panel: vscode.WebviewPanel, msg: HostMessage): void {
    void panel.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview, dist: vscode.Uri, nbPath: string): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...p)).toString();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('katex', 'katex.min.css')}">
<link rel="stylesheet" href="${uri('webview.css')}">
</head>
<body data-path="${escapeAttr(nbPath)}">
<div id="app"><div class="loading">Loading…</div></div>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
  }
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
