// The review page: one webview panel per changed file, showing a notebook's rendered cells and
// outputs, or any other file as one highlighted (or, for Markdown, rendered) cell, with the same
// comment threads as the text diff and the same toolbar for both.
import * as vscode from 'vscode';
import type { NewFileComment, ReviewState } from './state.ts';
import { planFileComment } from './core/fileComments.ts';
import { imageMime } from './core/binary.ts';
import type { Anchor } from './webview/protocol.ts';
import type { TextReview } from './textReview.ts';
import { docLinesForAnchor, headerLine } from './core/reviewDoc.ts';
import type { Finding, HostMessage, PageSpot, RangeState, ViewModel, WebviewMessage } from './webview/protocol.ts';
import { resolveRange, type RangeChoice, type ResolvedRange } from './core/range.ts';
import { Navigator, type LocalRepo } from './navigation.ts';
import { pageTitle, pathFromPageTitle } from './paths.ts';
import { showIfGitHubDown } from './notify.ts';
import { pendingInOrder } from './tree.ts';

export class VisualReview implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  /** Tabs from before a reload that VS Code has handed back, while they wait for the pull request. */
  private readonly reviving = new Set<vscode.WebviewPanel>();
  private staleTimer?: ReturnType<typeof setTimeout>;
  /**
   * The range picked in a page, used by every page of that pull request until another is picked;
   * none picked means the default (see `range`).
   */
  private chosen?: { pr: string; choice: RangeChoice };
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * The latest sync of each page that sends a model. Loading a range can take a while, so an
   * earlier sync that finishes later must not replace a newer page.
   */
  private readonly modelSyncs = new Map<vscode.WebviewPanel, number>();
  private readonly nav: Navigator;

  /** The workspace folder that clones the pull request's repository, if one is open. */
  localRepo(): Promise<LocalRepo | undefined> {
    return this.nav.localRepo();
  }
  /**
   * Where Back returns to, latest last: the places that go to definition left for another place
   * on the review pages. Kept for one pull request.
   */
  private back: { pr: string; path: string; spot: PageSpot }[] = [];
  private syncCount = 0;

  constructor(
    private readonly state: ReviewState,
    private readonly text: TextReview,
    private readonly ctx: vscode.ExtensionContext,
  ) {
    // VS Code gives the storage folder as a `vscode-userdata:` URI; language servers such as Pylance
    // only read `file:` documents, so the copies are opened by their path on disk.
    const storage = ctx.globalStorageUri.scheme === 'vscode-userdata' ? vscode.Uri.file(ctx.globalStorageUri.fsPath) : ctx.globalStorageUri;
    this.nav = new Navigator(state, storage);
    this.nav.onPage = (spot, from) => this.showOnPage(spot, from);
    this.disposables.push(
      this.nav,
      this.nav.onDidChange(() => [...this.panels].forEach(([path, panel]) => void this.sync(panel, path, {}))),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.nav.refresh()),
    );
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer('nbreview.visual', {
        deserializeWebviewPanel: (panel, saved) => this.restore(panel, saved),
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.checkStaleTabs()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.checkStaleTabs()),
      { dispose: () => clearTimeout(this.staleTimer) },
      // Changing the setting takes over from the last switch in a page.
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('nbreview.hideNoise')) {
          void this.setHideNoise(undefined);
        }
        if (e.affectsConfiguration('nbreview.checks')) {
          [...this.panels].forEach(([path, panel]) => void this.sync(panel, path, { model: true }));
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
    this.checkStaleTabs();
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    vscode.Disposable.from(...this.disposables).dispose();
  }

  open(nbPath: string, revealCellId?: string, options: { since?: boolean; viewColumn?: vscode.ViewColumn; goTo?: PageSpot; thread?: string } = {}): void {
    // The history button is on files changed since the review, which the default shows since
    // then: going back to the default shows it, and leaves the other files as they were.
    if (options.since && this.chosen) {
      this.setRange(undefined);
    }
    const existing = this.panels.get(nbPath);
    if (existing) {
      existing.reveal();
      if (revealCellId) {
        this.post(existing, { type: 'reveal', cellKey: revealCellId });
      }
      if (options.goTo) {
        this.post(existing, { type: 'goTo', spot: options.goTo });
      }
      if (options.thread) {
        this.post(existing, { type: 'revealThread', threadId: options.thread });
      }
      return;
    }
    if (!this.state.session || !this.reviewable(nbPath)) {
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'nbreview.visual',
      '',
      { viewColumn: options.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.dist()], enableFindWidget: true },
    );
    this.adopt(panel, nbPath, revealCellId, options.goTo, options.thread);
  }

  /** Brings back review tabs that were open when VS Code was reloaded. */
  private async restore(panel: vscode.WebviewPanel, saved: unknown): Promise<void> {
    this.reviving.add(panel);
    try {
      await this.state.restoring;
    } finally {
      this.reviving.delete(panel);
    }
    const nbPath = (saved as { path?: string } | undefined)?.path;
    if (nbPath && this.reviewable(nbPath) && !this.panels.has(nbPath)) {
      panel.webview.options = { enableScripts: true, localResourceRoots: [this.dist()] };
      this.adopt(panel, nbPath);
    } else {
      panel.dispose();
    }
  }

  private checkStaleTabs(): void {
    clearTimeout(this.staleTimer);
    // A tab restored with the window goes to the serializer as soon as it is shown; this leaves
    // time for that before a tab nobody owns counts as stale.
    this.staleTimer = setTimeout(() => void this.replaceStaleTabs(), 2000);
  }

  /**
   * After an update with Restart Extensions, review tabs that were open keep the old version's
   * page, which nothing answers any more: VS Code hands an extension back only the tabs restored
   * with the window. A shown review tab this extension doesn't own is such a page, so it is
   * closed and its file opened again in its place.
   */
  private async replaceStaleTabs(): Promise<void> {
    await this.state.restoring;
    const s = this.state.session;
    if (!s) {
      return;
    }
    const ours = [...this.panels.values(), ...this.reviving];
    const files = [...new Set([...s.notebooks.keys(), ...s.files.map(f => f.filename)])].map(path => ({ path, notebook: s.notebooks.has(path) }));
    for (const group of vscode.window.tabGroups.all) {
      const tab = group.activeTab;
      if (!(tab?.input instanceof vscode.TabInputWebview) || !tab.input.viewType.endsWith('nbreview.visual')) {
        continue;
      }
      if (ours.some(p => p.visible && p.viewColumn === group.viewColumn)) {
        continue;
      }
      const path = pathFromPageTitle(tab.label, s.pr.number, files);
      await vscode.window.tabGroups.close(tab, true);
      if (path) {
        this.open(path, undefined, { viewColumn: group.viewColumn });
      }
    }
  }

  private title(path: string): string {
    return pageTitle(path, !!this.state.entry(path), this.state.session?.pr.number);
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

  private adopt(panel: vscode.WebviewPanel, nbPath: string, revealCellId?: string, goTo?: PageSpot, thread?: string): void {
    panel.title = this.title(nbPath);
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(panel.webview, this.dist(), nbPath);
    this.panels.set(nbPath, panel);
    let pendingReveal = revealCellId;
    let pendingGoTo = goTo;
    let pendingThread = thread;
    panel.onDidDispose(() => {
      this.panels.delete(nbPath);
      this.modelSyncs.delete(panel);
    });
    panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this.handle(nbPath, panel, msg).catch(e => {
        showIfGitHubDown(e);
        this.post(panel, { type: 'error', message: e instanceof Error ? e.message : String(e) });
      });
      if (msg.type === 'ready' && pendingReveal) {
        this.post(panel, { type: 'reveal', cellKey: pendingReveal });
        pendingReveal = undefined;
      }
      // The page keeps it until its model has come and been drawn.
      if (msg.type === 'ready' && pendingGoTo) {
        this.post(panel, { type: 'goTo', spot: pendingGoTo });
        pendingGoTo = undefined;
      }
      // The page keeps it until the thread has come and been drawn.
      if (msg.type === 'ready' && pendingThread) {
        this.post(panel, { type: 'revealThread', threadId: pendingThread });
        pendingThread = undefined;
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
        const range = (await this.range(nbPath))?.resolved;
        if (range?.readOnly) {
          throw new Error('This range ends before the latest commit, and GitHub takes comments on the latest version only. Pick a range that ends at the latest commit to comment.');
        }
        if (msg.anchor.side === 'LEFT' && range?.from) {
          throw new Error('The old side is an earlier commit, which is not part of the pull request\'s diff: comment on the new side.');
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
      case 'setCommentFilter':
        await this.state.setCommentFilter(msg.filter);
        return;
      case 'setRange':
        this.setRange(msg.choice);
        // A choice is made to see what the pull request is now, so it is read again: new commits
        // change what "since your review" and the commit list are.
        void vscode.commands.executeCommand('nbreview.refresh');
        return;
      case 'loadCommits':
        await this.sendCommits(panel, nbPath);
        return;
      case 'goToDefinition':
      case 'openInWorkspace': {
        // The path is the page's own, whatever the message says.
        const oldPath = this.state.session?.files.find(f => f.filename === nbPath)?.previousFilename;
        const at = { ...msg.at, path: nbPath, oldPath };
        // Where Back returns to, if the definition is shown on a review page.
        const from = { path: nbPath, side: msg.at.side ?? 'RIGHT', cellId: msg.at.cell?.id ?? 'file', line: msg.at.line, ...(msg.type === 'goToDefinition' ? { col: msg.column, length: msg.name.length } : {}) };
        const note = msg.type === 'goToDefinition' ? await this.nav.goToDefinition(at, msg.name, msg.column, from) : await this.nav.openInWorkspace(at);
        if (note) {
          this.post(panel, { type: 'toast', message: note });
        }
        return;
      }
      case 'back':
        this.goBack();
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
      case 'openOverview':
        await vscode.commands.executeCommand('nbreview.openOverview');
        return;
      case 'goToPendingComment': {
        const comment = this.state.pendingComments().find(c => c.id === msg.id);
        if (comment) {
          await vscode.commands.executeCommand('nbreview.goToPendingComment', comment);
        }
        return;
      }
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

  /** Picks the range every page of the pull request compares, and shows it in the open pages. */
  private setRange(choice: RangeChoice | undefined): void {
    const pr = this.state.prKey();
    this.chosen = pr && choice ? { pr, choice } : undefined;
    for (const [path, panel] of this.panels) {
      this.sync(panel, path, { model: true, threads: true }).catch(e => {
        this.post(panel, { type: 'error', message: `Couldn't show this range: ${e instanceof Error ? e.message : String(e)}` });
      });
    }
  }

  /** Sends the page the pull request's commits for the range picker, marking those that changed its file. */
  private async sendCommits(panel: vscode.WebviewPanel, path: string): Promise<void> {
    const s = this.state.session;
    if (!s) {
      return;
    }
    try {
      const [commits, touching] = await Promise.all([s.commits(), s.commitsTouching(path).catch(() => undefined)]);
      // GitHub lists the file's latest 100 commits: when it hits that, an older commit not in
      // the list may still have changed the file.
      const touches = (sha: string) => (!touching ? undefined : touching.has(sha) ? true : touching.size >= 100 ? undefined : false);
      this.post(panel, { type: 'commits', head: s.pr.headSha, commits: commits.map(c => ({ ...c, touches: touches(c.sha) })) });
    } catch (e) {
      this.post(panel, { type: 'commits', head: s.pr.headSha, commits: [], error: `Couldn't load the commits: ${e instanceof Error ? e.message : String(e)}` });
    }
  }


  /** Sends the page what changed, in order: the notebook, then its threads, then the toolbar state. */
  private async sync(panel: vscode.WebviewPanel, nbPath: string, what: { model?: boolean; threads?: boolean }): Promise<void> {
    const id = ++this.syncCount;
    if (what.model) {
      this.modelSyncs.set(panel, id);
    }
    // A newer sync with a model has started: this one's range may be out of date.
    const stale = () => (this.modelSyncs.get(panel) ?? 0) > id;
    const vm = await (this.viewModel ??= import('./viewModel.ts'));
    const s = this.state.session;
    const entry = this.state.entry(nbPath);
    // The clone isn't waited for (git can be slow): a new look that finds otherwise redraws the state.
    const local = this.nav.current();
    const range = await this.range(nbPath);
    const r = range?.resolved;
    // The page's range, when it isn't the whole pull request.
    const page = r && (r.from || r.to) ? { describe: r.describe, readOnly: r.readOnly } : undefined;
    const file = s?.files.find(f => f.filename === nbPath);
    if (s && file && !entry) {
      if (what.model) {
        const model = await this.fileModel(vm, nbPath, r, page);
        if (stale()) {
          return;
        }
        this.post(panel, { type: 'model', model: { ...model, findings: this.findingsFor(nbPath, model, r) } });
      }
      if (stale()) {
        return;
      }
      if (what.threads) {
        const list = (s.fileThreads.get(nbPath) ?? []).filter(f => keepThread(f.side, r));
        this.post(panel, { type: 'threads', threads: vm.buildFileThreads(list, gh => this.state.describe(gh)) });
      }
      this.post(panel, this.stateMessage(nbPath, range?.state, local, vm));
      return;
    }
    if (s && entry && what.model) {
      const [base, head] = await Promise.all([r?.from ? s.docAt(nbPath, r.from) : undefined, r?.to ? s.docAt(nbPath, r.to) : undefined]);
      const pr = { number: s.pr.number, title: s.pr.title, url: s.pr.url };
      const model = vm.buildViewModel(entry, pr, page && { base, head, ...page }, { hideNoise: this.hideNoise() });
      if (stale()) {
        return;
      }
      this.post(panel, { type: 'model', model: { ...model, findings: this.findingsFor(nbPath, model, r) } });
    }
    if (stale()) {
      return;
    }
    if (what.threads) {
      const placed = s ? s.threadsFor(nbPath).filter(p => keepThread(p.side, r)) : [];
      const threads = s && entry ? vm.buildThreads(entry, placed, p => this.state.describe(p.gh)) : [];
      this.post(panel, { type: 'threads', threads });
    }
    this.post(panel, this.stateMessage(nbPath, range?.state, local, vm));
  }

  /**
   * The checks' findings for the page. They are about the latest version, so a range that ends
   * earlier shows none, and one that starts later than the base shows those on what it changed.
   */
  private findingsFor(path: string, model: ViewModel, r: ResolvedRange | undefined): Finding[] {
    const all = this.state.findings(path);
    if (r?.readOnly) {
      return [];
    }
    if (!r?.from) {
      return all;
    }
    return all.filter(f => {
      const c = model.cells.find(x => x.headId === f.cellId);
      return !!c && c.status !== 'unchanged' && (f.kind !== 'source' || c.ops.some(o => o.op === 'add' && o.h === f.line));
    });
  }

  /** An ordinary file as one cell; binary and very large files get a notice instead. */
  private async fileModel(vm: typeof import('./viewModel.ts'), path: string, r: ResolvedRange | undefined, page: ViewModel['range']): Promise<ViewModel> {
    const s = this.state.session!;
    const file = s.files.find(f => f.filename === path)!;
    const pr = { number: s.pr.number, title: s.pr.title, url: s.pr.url };
    const mime = imageMime(path);
    if (mime && mime !== 'image/svg+xml') {
      return this.imageModel(vm, path, r, page);
    }
    const [old, head] = await Promise.all([
      r?.from ? s.textAt(path, r.from) : s.content(path, 'LEFT'),
      r?.to ? s.textAt(path, r.to) : s.content(path, 'RIGHT'),
    ]);
    const unreadable = [old, head].find(t => t !== undefined && (t.length > 2_000_000 || t.slice(0, 8000).includes('\u0000')));
    if (unreadable !== undefined) {
      const notice = unreadable.length > 2_000_000
        ? 'This file is too large to show here.'
        : 'This is a binary file, so there is nothing to show line by line.';
      return { ...vm.buildFileViewModel(file, undefined, undefined, pr, page), notice };
    }
    return vm.buildFileViewModel(file, old, head, pr, page, { hideNoise: this.hideNoise() });
  }

  /** An image file as its old and new pictures. */
  private async imageModel(vm: typeof import('./viewModel.ts'), path: string, r: ResolvedRange | undefined, page: ViewModel['range']): Promise<ViewModel> {
    const s = this.state.session!;
    const file = s.files.find(f => f.filename === path)!;
    const pr = { number: s.pr.number, title: s.pr.title, url: s.pr.url };
    const [old, head] = await Promise.all([
      r?.from ? s.bytesAtCommit(path, r.from) : s.bytes(path, 'LEFT'),
      r?.to ? s.bytesAtCommit(path, r.to) : s.bytes(path, 'RIGHT'),
    ]);
    // The pictures go to the page inside its data, as base64.
    if ([old, head].some(b => b && b.length > 10_000_000)) {
      return { ...vm.buildFileViewModel(file, undefined, undefined, pr, page), notice: 'This image is too large to show here.' };
    }
    return vm.buildImageViewModel(file, old, head, pr, page);
  }

  /** "your review on 22 Oct (abc1234)". */
  private reviewLabel(): string | undefined {
    const last = this.state.session?.lastReview;
    if (!last) {
      return undefined;
    }
    const date = new Date(last.submittedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `your review on ${date} (${last.sha.slice(0, 7)})`;
  }

  /**
   * What a file's page compares, and the range picker's state. A range picked in any page is used
   * by every page of the pull request. Until one is picked, a file that changed after the viewer's
   * last review shows the changes since then, and any other file all its changes. Undefined when
   * there is nothing to pick: one commit and no review.
   */
  private async range(path: string): Promise<{ resolved: ResolvedRange; state: RangeState } | undefined> {
    const s = this.state.session;
    if (!s) {
      return undefined;
    }
    const last = s.lastReview;
    if (s.pr.commits <= 1 && !last) {
      return undefined;
    }
    const label = this.reviewLabel() ?? '';
    const what = this.state.entry(path) ? 'notebook' : 'file';
    const problem = !last ? undefined : s.sinceReviewProblem ?? (s.changedSince(path) ? undefined : `No changes to this ${what} since ${label}.`);
    const picked = this.chosen?.pr === this.state.prKey() ? this.chosen.choice : undefined;
    const commits = picked?.kind === 'commits' ? await s.commits().catch(() => undefined) : undefined;
    const pr = { headSha: s.pr.headSha, baseSha: s.pr.baseSha, commits, lastReview: last && !s.sinceReviewProblem ? { sha: last.sha, label } : undefined };
    // A picked range of commits that are gone (after a force push) falls back to the default.
    const chosen = picked && resolveRange(picked, pr);
    // A file removed after the review has only an old side then, which takes no comments: the
    // default for it is all changes, where it can be commented on as a whole.
    const removed = s.files.find(f => f.filename === path)?.status === 'removed';
    const resolved = chosen ?? resolveRange(pr.lastReview && !problem && !removed ? { kind: 'since' } : { kind: 'all' }, pr)!;
    return {
      resolved,
      state: {
        choice: resolved.choice,
        label: resolved.label,
        auto: !chosen,
        readOnly: resolved.readOnly,
        ...(last ? { review: { label, sha: last.sha, ...(problem ? { problem } : {}), ...(s.sinceReviewProblem ? { blocked: true } : {}) } } : {}),
        commits: s.pr.commits,
        head: s.pr.headSha,
      },
    };
  }

  /**
   * The Back places of the open pull request at its latest commit: those of another pull request,
   * or from before new commits (whose lines may have moved), are dropped.
   */
  private backStack(): { pr: string; path: string; spot: PageSpot }[] {
    const pr = `${this.state.prKey()}@${this.state.session?.pr.headSha}`;
    this.back = this.back.filter(b => b.pr === pr);
    return this.back;
  }

  /** Goes back to where go to definition was last used on a review page. */
  goBack(): void {
    const last = this.backStack().pop();
    if (last) {
      this.goTo(last.path, last.spot);
    }
    this.syncStates();
  }

  /**
   * Shows a definition on the review page of its file, from where go to definition was clicked
   * (`from`, kept for Back). False when that page doesn't show the pull request's latest version
   * (a range that ends at an older commit), so its lines aren't the definition's.
   */
  private async showOnPage(spot: PageSpot & { path: string }, from?: PageSpot & { path: string }): Promise<boolean> {
    if (!this.state.session || !this.reviewable(spot.path) || (await this.range(spot.path))?.resolved.readOnly) {
      return false;
    }
    // A click on a definition's own name goes nowhere: Back would return to the same place.
    const same = from && from.path === spot.path && from.side === spot.side && from.cellId === spot.cellId && from.line === spot.line;
    if (from && !same) {
      const back = this.backStack();
      back.push({ pr: `${this.state.prKey()}@${this.state.session.pr.headSha}`, path: from.path, spot: strip(from) });
      back.splice(0, Math.max(0, back.length - 50));
    }
    this.goTo(spot.path, strip(spot));
    this.syncStates();
    return true;
  }

  /**
   * Shows a conversation on its file's review page, opening the page if it isn't open. A page of
   * an earlier commit takes no threads, so it goes back to the default range first.
   */
  async showThread(path: string, threadId: string): Promise<void> {
    if (!this.state.session || !this.reviewable(path)) {
      return;
    }
    if ((await this.range(path))?.resolved.readOnly) {
      this.setRange(undefined);
    }
    this.open(path, undefined, { thread: threadId });
  }

  /** Shows a place on a file's review page, opening the page if it isn't open. */
  private goTo(path: string, spot: PageSpot): void {
    this.open(path, undefined, { goTo: spot });
  }

  /** Sends every page its state again: the Back button follows the stack. */
  private syncStates(): void {
    [...this.panels].forEach(([path, panel]) => void this.sync(panel, path, {}));
  }

  private stateMessage(nbPath: string, range: RangeState | undefined, local: LocalRepo | undefined, vm: typeof import('./viewModel.ts')): HostMessage {
    const last = this.backStack().at(-1);
    return {
      type: 'state',
      state: {
        viewed: this.state.isViewed(nbPath),
        pending: this.state.pendingCount(),
        pendingList: vm.buildPendingList(pendingInOrder(this.state)),
        pendingReview: this.state.hasPendingReview(),
        comments: this.state.commentFilter(),
        ...(range ? { range } : {}),
        ...(local ? { local: { branch: local.branch, atHead: local.atHead } } : {}),
        ...(last ? { back: last.path === nbPath ? 'Back' : `Back to ${last.path.split('/').pop()}` } : {}),
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

/**
 * Whether a thread shows in a range. Threads are placed on the pull request's own versions: the
 * old side's only when that is the base, and none when the new side is an earlier commit.
 */
function keepThread(side: 'LEFT' | 'RIGHT', r: ResolvedRange | undefined): boolean {
  return !r?.readOnly && (side === 'RIGHT' || !r?.from);
}

/** A page place without the path of its file. */
function strip(spot: PageSpot & { path?: string }): PageSpot {
  const { path: _path, ...rest } = spot;
  return rest;
}
