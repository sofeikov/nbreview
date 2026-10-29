import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { GitHub, type ReviewEvent } from './github.ts';
import { ReviewSession } from './session.ts';
import { ReviewState } from './state.ts';
import { TextReview } from './textReview.ts';
import { VisualReview } from './visualReview.ts';
import { FilesTree, fileLayout, initFileLayout, nodePath, nodePaths, onDidChangeFileLayout, reviewOrder, setFileLayout, type Node } from './tree.ts';
import { allFolders } from './paths.ts';
import { PrBadges, PrList, pickPullRequest, type RepoRef } from './prList.ts';

let ctx: vscode.ExtensionContext;
let log: vscode.OutputChannel;
let state: ReviewState;
let text: TextReview;
let visual: VisualReview;
let treeView: vscode.TreeView<Node>;
let status: vscode.StatusBarItem;
let prList: PrList;

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  log = vscode.window.createOutputChannel('Notebook Review');
  state = new ReviewState(context);
  text = new TextReview(state, context);
  visual = new VisualReview(state, text, context);
  context.subscriptions.push(initFileLayout(context.globalState));
  treeView = vscode.window.createTreeView('nbreview.files', {
    treeDataProvider: new FilesTree(state),
    showCollapseAll: true,
    manageCheckboxStateManually: true,
  });
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  prList = new PrList({
    github: async interactive => {
      const token = await getToken(interactive);
      return token ? new GitHub(token) : undefined;
    },
    currentRepo,
    activeKey: () => (state.session ? `${state.session.pr.owner}/${state.session.pr.repo}#${state.session.pr.number}` : undefined),
  });
  const prsView = vscode.window.createTreeView('nbreview.prs', { treeDataProvider: prList });
  const refreshIfStale = () => {
    if (prsView.visible && (!prList.sections || prList.isStale())) {
      void prList.refresh();
    }
  };

  context.subscriptions.push(
    prList,
    prsView,
    vscode.window.registerFileDecorationProvider(new PrBadges()),
    prsView.onDidChangeVisibility(refreshIfStale),
    vscode.window.onDidChangeWindowState(e => e.focused && refreshIfStale()),
    state.onDidChange(e => e.session && prList.redraw()),
    vscode.commands.registerCommand('nbreview.refreshPrs', () => prList.refresh(true)),
    vscode.commands.registerCommand('nbreview.signIn', () => prList.refresh(true)),
    vscode.commands.registerCommand('nbreview.openPrOnGitHub', (node?: { pr?: { url: string } }) =>
      node?.pr && vscode.env.openExternal(vscode.Uri.parse(node.pr.url))),
    log,
    text,
    visual,
    treeView,
    status,
    state.onDidChange(updateStatus),
    vscode.commands.registerCommand('nbreview.viewAsTree', () => setFileLayout('tree')),
    vscode.commands.registerCommand('nbreview.viewAsList', () => setFileLayout('list')),
    onDidChangeFileLayout(updateLayoutContext),
    vscode.commands.registerCommand('nbreview.showAllComments', () => state.setCommentFilter('all')),
    vscode.commands.registerCommand('nbreview.showUnresolvedComments', () => state.setCommentFilter('unresolved')),
    vscode.commands.registerCommand('nbreview.hideComments', () => state.setCommentFilter('none')),
    state.onDidChange(e => e.filter && updateFilterContext()),
    // Changing the setting takes over from the last choice.
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('nbreview.showComments') && void state.setCommentFilter(undefined)),
    // "Add Single Comment" is hidden while a review is pending, as on github.com.
    state.onDidChange(() => void vscode.commands.executeCommand('setContext', 'nbreview.pendingReview', state.hasPendingReview())),
    treeView.onDidChangeCheckboxState(e => {
      const byState = new Map<boolean, string[]>();
      for (const [node, checked] of e.items) {
        const viewed = checked === vscode.TreeItemCheckboxState.Checked;
        byState.set(viewed, [...(byState.get(viewed) ?? []), ...nodePaths(node)]);
      }
      for (const [viewed, paths] of byState) {
        state.setViewed(paths, viewed).catch(showError);
      }
    }),
    vscode.commands.registerCommand('nbreview.openPr', (arg?: string) => openPr(typeof arg === 'string' ? arg : undefined).catch(showError)),
    vscode.commands.registerCommand('nbreview.refresh', () => {
      const pr = state.session?.pr;
      return pr && openPr(`${pr.owner}/${pr.repo}#${pr.number}`, false).catch(showError);
    }),
    // Opens any changed file, notebook or not, in the view chosen in the settings.
    vscode.commands.registerCommand('nbreview.openNotebook', (path: string) => {
      const view = vscode.workspace.getConfiguration('nbreview').get<string>('defaultView', 'visual');
      if (view === 'text') {
        return state.entry(path) ? text.openDiff(path) : text.openFileDiff(path);
      }
      return visual.open(path);
    }),
    vscode.commands.registerCommand('nbreview.openVisual', (arg?: Node | vscode.Uri | string) => {
      const path = pathFromArg(arg);
      return path && visual.open(path);
    }),
    vscode.commands.registerCommand('nbreview.openNotebookDiff', (arg?: Node | vscode.Uri | string) => {
      const path = pathFromArg(arg);
      return path && text.openDiff(path);
    }),
    vscode.commands.registerCommand('nbreview.openFileDiff', (arg?: Node | string) => {
      const path = typeof arg === 'string' ? arg : arg && nodePath(arg);
      return path && text.openFileDiff(path);
    }),
    vscode.commands.registerCommand('nbreview.openChangesSinceReview', (arg?: Node | vscode.Uri | string) => {
      const path = pathFromArg(arg);
      if (!path || !state.session?.lastReview) {
        return;
      }
      const view = vscode.workspace.getConfiguration('nbreview').get<string>('defaultView', 'visual');
      return state.session.notebooks.has(path) || view === 'visual' ? visual.open(path, undefined, { since: true }) : text.openSinceReviewDiff(path);
    }),
    vscode.commands.registerCommand('nbreview.openOnGitHub', () => state.session && vscode.env.openExternal(vscode.Uri.parse(state.session.pr.url))),
    vscode.commands.registerCommand('nbreview.submitReview', (request?: SubmitRequest) =>
      request?.event ? submit(request) : submitInteractive().catch(showError)),
    vscode.commands.registerCommand('nbreview.markViewed', (arg?: vscode.Uri | string) => setActiveViewed(arg, true)),
    vscode.commands.registerCommand('nbreview.markNotViewed', (arg?: vscode.Uri | string) => setActiveViewed(arg, false)),
    vscode.commands.registerCommand('nbreview.markFolderViewed', (node?: Node) => setFolderViewed(node, true).catch(showError)),
    vscode.commands.registerCommand('nbreview.markFolderNotViewed', (node?: Node) => setFolderViewed(node, false).catch(showError)),
    vscode.commands.registerCommand('nbreview.nextFile', (arg?: vscode.Uri | string) => nextFile(arg).catch(showError)),
    vscode.window.onDidChangeActiveTextEditor(updateActiveContext),
    state.onDidChange(updateActiveContext),
    vscode.commands.registerCommand('nbreview.discardReview', async () => {
      const n = state.pendingCount();
      if (!state.hasPendingReview()) {
        void vscode.window.showInformationMessage('You have no pending review on this pull request.');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Discard your pending review${n ? ` and its ${n} comment${n === 1 ? '' : 's'}` : ''}? This can't be undone.`,
        { modal: true },
        'Discard review',
      );
      if (choice) {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Discarding review…' }, () => state.discardReview()).then(undefined, showError);
      }
    }),
    vscode.commands.registerCommand('nbreview.close', async () => {
      state.setSession(undefined);
      await ctx.globalState.update('activePr', undefined);
      await vscode.commands.executeCommand('setContext', 'nbreview.active', false);
    }),
  );

  updateLayoutContext();
  updateFilterContext();
  refreshIfStale();
  watchBranch(context);

  // Pick up where the reviewer left off after a reload.
  const active = ctx.globalState.get<string>('activePr');
  if (active) {
    state.restoring = openPr(active, false).catch(e => log.appendLine(`Couldn't reopen ${active}: ${e}`));
  }
}

export function deactivate(): void {}

function pathFromArg(arg?: Node | vscode.Uri | string): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg instanceof vscode.Uri) {
    return text.docFor(arg)?.entry.path ?? text.rawFor(arg)?.path;
  }
  if (arg) {
    return nodePath(arg);
  }
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri && text.docFor(uri)?.entry.path;
}

/** Refreshes the pull request list when the checked-out branch changes ("This branch" follows it). */
function watchBranch(context: vscode.ExtensionContext): void {
  const git = vscode.extensions.getExtension('vscode.git');
  const hook = (api: any) => {
    const branches = new Map<unknown, string | undefined>();
    const watch = (repo: any) => {
      branches.set(repo, repo.state?.HEAD?.name);
      context.subscriptions.push(repo.state.onDidChange(() => {
        const name = repo.state?.HEAD?.name;
        if (name !== branches.get(repo)) {
          branches.set(repo, name);
          void prList.refresh();
        }
      }));
    };
    api.repositories?.forEach(watch);
    if (api.onDidOpenRepository) {
      context.subscriptions.push(api.onDidOpenRepository(watch));
    }
  };
  if (!git) {
    return;
  }
  const activate = git.isActive ? Promise.resolve(git.exports) : git.activate();
  activate.then(exports => hook(exports.getAPI(1)), () => undefined);
}

/** The changed file shown in an editor (a notebook's text diff or another file's diff), by path. */
function reviewPath(arg?: vscode.Uri | string): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  const uri = arg ?? vscode.window.activeTextEditor?.document.uri;
  return uri && (text.docFor(uri)?.entry.path ?? text.rawFor(uri)?.path);
}

/** Lets the editor title show "Mark as viewed" or "Viewed" for the file in the active diff. */
function updateActiveContext(): void {
  const path = reviewPath();
  void vscode.commands.executeCommand('setContext', 'nbreview.activeViewed', !!path && state.isViewed(path));
}

function updateLayoutContext(): void {
  void vscode.commands.executeCommand('setContext', 'nbreview.fileLayout', fileLayout());
}

/** Picks the title bar's Comments button for the choice in force: its tooltip names it, and its menu offers the other two. */
function updateFilterContext(): void {
  void vscode.commands.executeCommand('setContext', 'nbreview.commentFilter', state.commentFilter());
}

function setActiveViewed(arg: vscode.Uri | string | undefined, viewed: boolean): Promise<void> | undefined {
  const path = reviewPath(arg);
  return path ? state.setViewed([path], viewed).catch(showError) : undefined;
}

/**
 * Marks every file in a folder, at any depth. From the Review panel the folder is the node; from
 * the Command Palette it is picked from every folder with changed files, notebooks and others
 * together, which also works in the list layout.
 */
async function setFolderViewed(node: Node | undefined, viewed: boolean): Promise<void> {
  const s = state.session;
  if (!s) {
    return;
  }
  let paths = node ? nodePaths(node) : undefined;
  if (!paths) {
    const count = (files: string[]) => files.filter(p => state.isViewed(p)).length;
    const folders = allFolders(s.files.map(f => f.filename))
      .filter(f => (viewed ? count(f.files) < f.files.length : count(f.files) > 0));
    if (!folders.length) {
      void vscode.window.showInformationMessage(viewed ? 'Every folder is already marked viewed.' : 'No folder has files marked viewed.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      folders.map(f => ({
        label: `$(folder) ${f.path}`,
        description: `${count(f.files)}/${f.files.length} viewed`,
        files: f.files,
      })),
      { placeHolder: viewed ? 'Mark every file in a folder as viewed' : 'Unmark every file in a folder' },
    );
    paths = picked?.files;
  }
  if (paths?.length) {
    await state.setViewed(paths, viewed);
  }
}

/** Opens the next file not marked viewed, in the panel's order, after the given one. */
async function nextFile(arg?: vscode.Uri | string): Promise<void> {
  const order = reviewOrder(state);
  const current = reviewPath(arg);
  const from = current ? order.indexOf(current) : -1;
  const rest = [...order.slice(from + 1), ...order.slice(0, from + 1)].filter(p => p !== current);
  const next = rest.find(p => !state.isViewed(p));
  if (!next) {
    const choice = await vscode.window.showInformationMessage('Every file is marked viewed.', 'Submit review');
    if (choice) {
      await vscode.commands.executeCommand('nbreview.submitReview');
    }
    return;
  }
  await vscode.commands.executeCommand('nbreview.openNotebook', next);
}

function showError(e: unknown): void {
  void vscode.window.showErrorMessage(`Notebook Review: ${e instanceof Error ? e.message : String(e)}`);
}

function updateStatus(): void {
  const s = state.session;
  if (!s) {
    status.hide();
    treeView.badge = undefined;
    treeView.description = undefined;
    return;
  }
  const n = state.pendingCount();
  status.text = `$(notebook) #${s.pr.number}${n ? ` · ${n} pending` : ''}`;
  status.tooltip = n ? `Submit your notebook review on #${s.pr.number}` : `Reviewing ${s.pr.title}`;
  status.command = 'nbreview.submitReview';
  status.show();
  treeView.badge = n ? { value: n, tooltip: `${n} pending review comment${n === 1 ? '' : 's'}` } : undefined;
  treeView.description = `${s.pr.owner}/${s.pr.repo}`;
}

// --- Opening a pull request --------------------------------------------------------------------

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
  );
}

/**
 * A GitHub token: the GitHub CLI's login, then VS Code's GitHub sign-in. Without `interactive`
 * nobody is asked to sign in, and undefined means "not signed in".
 */
async function getToken(interactive: true): Promise<string>;
async function getToken(interactive: boolean): Promise<string | undefined>;
async function getToken(interactive: boolean): Promise<string | undefined> {
  if (vscode.workspace.getConfiguration('nbreview').get<boolean>('useGhCli', true)) {
    try {
      const token = await run('gh', ['auth', 'token']);
      if (token) {
        return token;
      }
    } catch {
      // gh not installed or not signed in: fall back to VS Code's GitHub sign-in.
    }
  }
  const auth = await vscode.authentication.getSession('github', ['repo'], interactive ? { createIfNone: true } : { silent: true });
  return auth?.accessToken;
}

async function currentRepo(): Promise<RepoRef | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    return undefined;
  }
  try {
    const remote = await run('git', ['remote', 'get-url', 'origin'], folder);
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
    if (!m) {
      return undefined;
    }
    const branch = await run('git', ['branch', '--show-current'], folder).catch(() => undefined);
    return { owner: m[1], repo: m[2], branch };
  } catch {
    return undefined;
  }
}

function parsePrInput(input: string, fallback?: { owner: string; repo: string }): { owner: string; repo: string; number: number } | undefined {
  const url = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(input);
  if (url) {
    return { owner: url[1], repo: url[2], number: Number(url[3]) };
  }
  const short = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(input.trim());
  if (short) {
    return { owner: short[1], repo: short[2], number: Number(short[3]) };
  }
  const num = /^#?(\d+)$/.exec(input.trim());
  if (num && fallback) {
    return { ...fallback, number: Number(num[1]) };
  }
  return undefined;
}

async function openPr(arg?: string, focus = true): Promise<void> {
  let input = arg;
  if (!input) {
    input = await pickPullRequest(prList, text => {
      const ref = parsePrInput(text, prList.repo);
      return ref && `${ref.owner}/${ref.repo}#${ref.number}`;
    });
  }
  if (!input) {
    return;
  }
  const target = parsePrInput(input, prList.repo ?? (await currentRepo()));
  if (!target) {
    void vscode.window.showErrorMessage(`Couldn't read a pull request from "${input}".`);
    return;
  }
  const gh = new GitHub(await getToken(true));
  let session: ReviewSession | undefined;
  const title = `Loading #${target.number}`;
  await vscode.window.withProgress({ location: { viewId: 'nbreview.prs' }, title }, () =>
    vscode.window.withProgress({ location: { viewId: 'nbreview.files' }, title }, () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Notebook review' }, async progress => {
        session = await ReviewSession.load(gh, target.owner, target.repo, target.number, msg => progress.report({ message: msg }));
      }),
    ),
  );
  const key = `${target.owner}/${target.repo}#${target.number}`;
  await ctx.globalState.update('lastPr', key);
  await ctx.globalState.update('activePr', key);
  await vscode.commands.executeCommand('setContext', 'nbreview.active', true);
  state.setSession(session);
  if (focus) {
    await vscode.commands.executeCommand('nbreview.files.focus');
  }
}

// --- Submitting --------------------------------------------------------------------------------

export interface SubmitRequest {
  event: ReviewEvent;
  body: string;
}

/** Why a review can't be submitted as asked, or undefined when it can. */
function submitProblem(event: ReviewEvent, body: string): string | undefined {
  const pending = state.pendingCount();
  if (event === 'REQUEST_CHANGES' && !pending && !body.trim()) {
    return 'GitHub needs a summary or at least one comment to request changes.';
  }
  if (event === 'COMMENT' && !pending && !body.trim()) {
    return 'There is nothing to send yet: add a comment or write a summary.';
  }
  return undefined;
}

/**
 * One step: the summary is typed into the picker's input, and the item picked says how to submit
 * (Enter submits as a comment).
 */
async function submitInteractive(): Promise<void> {
  const s = state.session;
  if (!s) {
    return;
  }
  const n = state.pendingCount();
  const pendingText = n ? `${n} pending comment${n === 1 ? '' : 's'}` : 'no pending comments';
  type Item = vscode.QuickPickItem & { event: ReviewEvent };
  const items: Item[] = [
    { label: '$(comment) Comment', description: 'Send feedback without approving', event: 'COMMENT', alwaysShow: true },
    { label: '$(check) Approve', description: 'Approve the pull request', event: 'APPROVE', alwaysShow: true },
    { label: '$(request-changes) Request changes', description: 'Ask for changes before merging', event: 'REQUEST_CHANGES', alwaysShow: true },
  ];
  const picker = vscode.window.createQuickPick<Item>();
  picker.title = `Submit review on #${s.pr.number} · ${pendingText}`;
  picker.placeholder = 'Optional summary: type it here, then choose how to submit (Enter = Comment)';
  picker.items = items;
  picker.matchOnDescription = false;
  picker.ignoreFocusOut = true;
  const choice = await new Promise<SubmitRequest | undefined>(resolve => {
    picker.onDidAccept(() => {
      const item = picker.selectedItems[0] ?? picker.activeItems[0] ?? items[0];
      const problem = submitProblem(item.event, picker.value);
      if (problem) {
        picker.title = `$(warning) ${problem}`;
        return;
      }
      resolve({ event: item.event, body: picker.value.trim() });
      picker.hide();
    });
    const title = picker.title;
    picker.onDidChangeValue(() => (picker.title = title));
    picker.onDidHide(() => resolve(undefined));
    picker.show();
  });
  picker.dispose();
  if (choice) {
    await submit(choice).catch(() => undefined);
  }
}

/** Posts the pending comments as one review. Returns the review URL; throws if it failed. */
async function submit({ event, body }: SubmitRequest): Promise<string> {
  const s = state.session;
  if (!s) {
    throw new Error('No pull request is open.');
  }
  const problem = submitProblem(event, body);
  if (problem) {
    throw new Error(problem);
  }
  const verb = event === 'APPROVE' ? 'Approval' : event === 'REQUEST_CHANGES' ? 'Change request' : 'Review';
  try {
    const url = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Submitting review on #${s.pr.number}…` },
      () => s.gh.submitReview(s.pr, s.pendingReviewId, event, body),
    );
    void vscode.window.showInformationMessage(`${verb} submitted on #${s.pr.number}.`, 'Open on GitHub').then(open => {
      if (open) {
        void vscode.env.openExternal(vscode.Uri.parse(url));
      }
    });
    return url;
  } catch (e) {
    const message = `Submitting the review failed: ${e instanceof Error ? e.message : e}. Your pending comments are still in your review on GitHub.`;
    void vscode.window.showErrorMessage(message);
    throw new Error(message);
  } finally {
    await state.reloadThreads();
    void prList.refresh();
  }
}
