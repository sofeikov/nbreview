// Code navigation from the review page, done by VS Code's own language servers on the viewer's
// checkout: "go to definition" on a name, and "open in workspace" for a cell or file. It finds the
// clicked line in the local copy of the file and asks VS Code (`vscode.executeDefinitionProvider`,
// then `vscode.executeWorkspaceSymbolProvider`) where the name is defined. Pylance can't do this
// on the pull request's own files, which aren't on disk. Without a clone, the files are copied
// from GitHub to the extension's storage, one at a time as they are needed. Pylance doesn't
// resolve imports between files outside the workspace, so for Python an import is followed by
// reading the import statements (`core/pyImports.ts`), also when a clone is open.
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { ReviewState } from './state.ts';
import type { ReviewSession } from './session.ts';
import { columnOf, headCellOf, headLineOf, isRemoteOf, matchCell, matchLine, shortPlace } from './core/navigate.ts';
import type { PageSpot } from './webview/protocol.ts';
import { importedName, importTargets, moduleFiles, topLevelLine, type ImportTarget } from './core/pyImports.ts';

/** The open folder that is a clone of the pull request's repository, and what it has checked out. */
export interface LocalRepo {
  folder: vscode.Uri;
  branch?: string;
  /** The checkout is at the pull request's latest commit: its lines are the reviewed ones. */
  atHead: boolean;
}

/**
 * Where navigation reads files: a clone, or a copy of the pull request's files at its head (in
 * the extension's storage, outside the workspace) when no clone is open.
 */
interface Place {
  folder: vscode.Uri;
  branch?: string;
  atHead: boolean;
  /**
   * For a copy: the session and commit it was made from. Files are fetched from these, not from
   * the session of the moment, which a refresh or another pull request may have replaced.
   */
  copy?: { session: ReviewSession; sha: string };
}

/** Copies not used for this long are deleted. */
const COPY_DAYS = 7;
/** The file in a copy whose time says when the copy was last used. */
const USED = '.nbreview-used';
/** At most this many modules are looked at for one click: each can be several GitHub requests. */
const MAX_MODULES = 12;

/** A line of the review page: of which file, notebook cell and line, and its text. */
export interface PageLine {
  path: string;
  /** The file's name before the pull request renamed it: a checkout of an older commit has that. */
  oldPath?: string;
  /** The notebook cell, by id and source; undefined for a file that isn't a notebook. */
  cell?: { id: string; source: string };
  line: number;
  text: string;
}

/** What happened, for a short note on the page; undefined when there is nothing to say. */
export type NavNote = string | undefined;

function git(folder: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', ['-C', folder, ...args], { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))));
}

export class Navigator {
  private cached?: { key: string; at: number; repo: Promise<LocalRepo | undefined> };
  private last?: LocalRepo;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the clone found, or what it has checked out, changes. */
  readonly onDidChange = this.changed.event;

  /** The pull request heads whose copies were opened in this session: the note is given once. */
  private readonly copyNoted = new Set<string>();
  private pruning?: Promise<void>;
  /** Files of a copy being fetched: two clicks at once share one fetch and one write. */
  private readonly fetching = new Map<string, Promise<vscode.Uri | undefined>>();

  /**
   * Shows a definition on the review page of its file, when that page shows the pull request's
   * latest version; false when it can't, and the definition opens in an editor instead.
   */
  onPage?: (spot: PageSpot & { path: string }, from?: PageSpot & { path: string }) => Promise<boolean>;

  constructor(private readonly state: ReviewState, private readonly storage: vscode.Uri) {}

  dispose(): void {
    this.changed.dispose();
  }

  /**
   * The workspace folder that clones the pull request's repository (any of its remotes), looked
   * up again after a few seconds so that a branch switch is seen.
   */
  localRepo(): Promise<LocalRepo | undefined> {
    const s = this.state.session;
    if (!s) {
      return Promise.resolve(undefined);
    }
    const key = `${this.state.prKey()}@${s.pr.headSha}`;
    if (!this.cached || this.cached.key !== key || Date.now() - this.cached.at > 5000) {
      const repo = this.findRepo(s.pr.owner, s.pr.repo, s.pr.headSha);
      this.cached = { key, at: Date.now(), repo };
      void repo.then(found => {
        const before = this.last;
        this.last = found;
        if (before?.folder.toString() !== found?.folder.toString() || before?.branch !== found?.branch || before?.atHead !== found?.atHead) {
          this.changed.fire();
        }
      });
    }
    return this.cached.repo;
  }

  /**
   * The clone as last found, without waiting: pages are drawn with it, and redrawn through
   * `onDidChange` when a new look finds something else. Starts that look when it is due.
   */
  current(): LocalRepo | undefined {
    void this.localRepo();
    return this.state.session ? this.last : undefined;
  }

  /** Looks for the clone again now, as after workspace folders were added or removed. */
  refresh(): void {
    this.cached = undefined;
    void this.localRepo();
  }

  private async findRepo(owner: string, repo: string, headSha: string): Promise<LocalRepo | undefined> {
    const found: LocalRepo[] = [];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file') {
        continue;
      }
      try {
        const remotes = await git(f.uri.fsPath, ['remote', '-v']);
        if (!remotes.split('\n').some(l => isRemoteOf(l.split(/\s+/)[1] ?? '', owner, repo))) {
          continue;
        }
        // The repository may be a subfolder's parent: paths are relative to its top.
        const top = await git(f.uri.fsPath, ['rev-parse', '--show-toplevel']);
        const [head, branch] = await Promise.all([
          git(top, ['rev-parse', 'HEAD']).catch(() => ''),
          git(top, ['branch', '--show-current']).catch(() => ''),
        ]);
        const local = { folder: vscode.Uri.file(top), branch: branch || undefined, atHead: head === headSha };
        // With several clones open (worktrees), one at the pull request's head is best.
        if (local.atHead) {
          return local;
        }
        found.push(local);
      } catch {
        // Not a git folder, or git isn't installed.
      }
    }
    return found[0];
  }

  /**
   * Goes to where a name on a line of the review page is defined: in the viewer's checkout, or
   * without one, in a copy of the pull request's files.
   */
  async goToDefinition(at: PageLine, name: string, column: number, from?: PageSpot & { path: string }): Promise<NavNote> {
    // The pull request of the click: another one opened meanwhile has other files and lines.
    const session = this.state.session;
    const repo: Place | undefined = (await this.localRepo()) ?? (await this.copy());
    if (!repo) {
      return this.noRepo();
    }
    const where = await this.locate(repo, at);
    const checkout = repo.copy ? 'this pull request' : repo.branch ? `your checkout (${repo.branch})` : 'your checkout';
    if (repo.copy && !where && repo.copy.session.files.find(f => f.filename === at.path)?.status !== 'removed') {
      return `Couldn't open ${at.path} of this pull request.`;
    }
    if (repo.copy && where?.line === undefined) {
      return 'Without a clone, go to definition works on the pull request\'s own lines, not on lines it removes.';
    }
    let found: (vscode.Location | vscode.LocationLink)[] = [];
    const col = where && where.line !== undefined ? columnOf(where.doc.lineAt(where.line).text, name, column) : undefined;
    if (where && where.line !== undefined && col !== undefined) {
      const position = new vscode.Position(where.line, col);
      // A file the language server has only just been given (or a server that is still starting,
      // as on the first click after VS Code starts) answers nothing at first: ask again for a few
      // seconds before saying there is no definition.
      const until = Date.now() + (where.justOpened ? 8000 : 0);
      // An imported name can be followed to its module of the repository, which the language server
      // may not find (a copy) or not yet (still starting). Its file is the one the server would give,
      // so it is used as soon as the server gives nothing, without waiting for the server.
      let imported: vscode.Location | undefined;
      let triedImports = false;
      const tryImports = async (spot: NonNullable<typeof where>, line: number, c: number) => {
        if (!triedImports) {
          triedImports = true;
          imported = await this.viaImports(repo, spot, line, c, at.path);
        }
      };
      // In a copy, the pull request's own module comes first: the language server may find the same
      // package installed in the selected Python environment, in another version.
      if (repo.copy) {
        await tryImports(where, where.line, col);
      }
      while (!imported) {
        found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', where.doc.uri, position) ?? [];
        if (found.length) {
          break;
        }
        await tryImports(where, where.line, col);
        if (imported || Date.now() >= until) {
          break;
        }
        await new Promise(r => setTimeout(r, 400));
      }
      // The line is there, and the language server knows of no definition (a word in a comment, an
      // attribute it can't resolve): another symbol of the same name would be a guess.
      if (!found.length) {
        if (imported) {
          if (await this.toPage(repo, imported, session, from)) {
            return undefined;
          }
          await reveal(imported);
          return this.foundNote(repo, checkout, true);
        }
        // Usually a word with nothing to go to; but a language server that is still busy starting
        // (many editors restored with the window) answers nothing too.
        return `VS Code found no definition of ${name} here in ${checkout}. If its language server is still starting, try again in a moment.`;
      }
    }
    // The line isn't in the checkout: look the name up instead. Not in a copy, which is outside the
    // workspace: the names found would be from other folders.
    const exact = found.length > 0;
    if (!exact && !repo.copy) {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name) ?? [];
      found = symbols.filter(sym => sym.name === name).map(sym => sym.location);
    }
    if (!found.length) {
      return repo.atHead
        ? `No definition of ${name} found in ${checkout}.`
        : `No definition of ${name} found in ${checkout}. If this pull request adds it, check out its branch to go to it.`;
    }
    if (found.length > 1 && exact && where && where.line !== undefined && col !== undefined) {
      // Several definitions (overloads: pandas' groupby has 17): VS Code's own peek view lists
      // them with previews, at the clicked line in the viewer's copy of the file, as F12 does.
      await this.peek(where, new vscode.Position(where.line, col), found);
    } else {
      const chosen = found.length === 1 ? found[0] : await this.pick(name, found, repo);
      if (chosen && (await this.toPage(repo, chosen, session, from))) {
        return undefined;
      }
      if (chosen) {
        await reveal(chosen);
      }
    }
    return this.foundNote(repo, checkout, exact);
  }

  /**
   * Shows a definition on a review page instead of an editor, when it is in a file that the pull
   * request changes: in the same notebook, or on another file's page. Its line in the clone or the
   * copy is mapped to the pull request's latest version (the same line at that commit, otherwise
   * the line with the same text).
   */
  private async toPage(repo: Place, l: vscode.Location | vscode.LocationLink, s: ReviewSession | undefined, from?: PageSpot & { path: string }): Promise<boolean> {
    if (!s || !this.onPage) {
      return false;
    }
    const { uri, range } = target(l);
    const file = fileOf(uri);
    if (file.scheme !== 'file') {
      return false;
    }
    // Git gives the clone's real path; a language server may give the workspace's (a symbolic
    // link, or another letter case of the drive on Windows).
    const real = (p: string) => realpath(p).then(r => r.replace(/\\/g, '/'), () => p.replace(/\\/g, '/'));
    const [filePath, top] = await Promise.all([real(file.fsPath), real(repo.folder.fsPath)]);
    const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const root = top.replace(/\/$/, '');
    if (!fold(filePath).startsWith(`${fold(root)}/`)) {
      return false;
    }
    const rel = filePath.slice(root.length + 1);
    // A checkout of an older commit may have a file under the name it had before the pull request.
    const changed = s.files.find(f => f.filename === rel) ?? (repo.atHead ? undefined : s.files.find(f => f.previousFilename === rel));
    if (!changed || changed.status === 'removed') {
      return false;
    }
    const path = changed.filename;
    const at = range.start;
    // The name's characters, when the location gives just the name (not a whole function).
    const name = range.isSingleLine && !range.isEmpty ? { col: at.character, length: range.end.character - at.character } : { col: at.character };
    try {
      if (uri.scheme === 'vscode-notebook-cell') {
        const notebook = vscode.workspace.notebookDocuments.find(nb => nb.uri.toString() === file.toString());
        const index = notebook?.getCells().findIndex(c => c.document.uri.toString() === uri.toString()) ?? -1;
        const head = await s.docAt(path, s.pr.headSha);
        if (!notebook || index < 0 || !head) {
          return false;
        }
        const local = notebook.cellAt(index);
        const cells = head.notebook.cells.map(c => ({ id: c.id, source: c.source.join('\n') }));
        const localId = typeof local.metadata?.id === 'string' ? local.metadata.id : undefined;
        const i = headCellOf(cells, { index, id: localId, source: local.document.getText() }, repo.atHead);
        const line = i === undefined ? undefined : headLineOf(head.notebook.cells[i].source, local.document.lineAt(at.line).text, at.line, repo.atHead);
        return i !== undefined && line !== undefined && this.state.session === s
          && (await this.onPage({ path, side: 'RIGHT', cellId: head.notebook.cells[i].id, line, ...name }, from));
      }
      if (this.state.entry(path)) {
        return false;
      }
      const text = await s.textAt(path, s.pr.headSha);
      // A file the review page shows only a notice for (too large, or binary).
      if (text === undefined || text.length > 2_000_000 || text.slice(0, 8000).includes('\u0000')) {
        return false;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const line = headLineOf(text.split(/\r?\n/), doc.lineAt(at.line).text, at.line, repo.atHead);
      return line !== undefined && this.state.session === s && (await this.onPage({ path, side: 'RIGHT', cellId: 'file', line, ...name }, from));
    } catch {
      return false;
    }
  }

  /** What to say after going to a definition: where it was found, when that isn't obvious. */
  private foundNote(repo: Place, checkout: string, exact: boolean): NavNote {
    if (repo.copy) {
      const s = this.state.session;
      const key = `${this.state.prKey()}@${s?.pr.headSha}`;
      if (this.copyNoted.has(key)) {
        return undefined;
      }
      this.copyNoted.add(key);
      return `Go to definition uses a copy of the pull request's files, as no clone of ${s ? `${s.pr.owner}/${s.pr.repo}` : 'the repository'} is open in VS Code.`;
    }
    if (repo.atHead) {
      return undefined;
    }
    return exact
      ? `From ${checkout}, which isn't at the pull request's latest commit.`
      : `From ${checkout}, found by name: this line isn't in your checkout.`;
  }

  /**
   * The copy of the pull request's files at its head, in the extension's storage. Files are
   * added as they are needed (`fileIn`). Old copies are deleted once a session, before the first
   * use; every use marks the copy as used.
   */
  private async copy(): Promise<Place | undefined> {
    const s = this.state.session;
    const safe = (part: string) => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..';
    if (!s || !safe(s.pr.owner) || !safe(s.pr.repo) || !/^[0-9a-f]{40}$/.test(s.pr.headSha)) {
      return undefined;
    }
    const top = vscode.Uri.joinPath(this.storage, 'copies');
    this.pruning ??= this.prune(top).catch(() => undefined);
    await this.pruning;
    const folder = vscode.Uri.joinPath(top, s.pr.owner, s.pr.repo, s.pr.headSha);
    await vscode.workspace.fs.createDirectory(folder).then(() => vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, USED), new Uint8Array()), () => undefined);
    return { folder, atHead: true, copy: { session: s, sha: s.pr.headSha } };
  }

  /**
   * Deletes the copies (`copies/owner/repo/sha`) not used for `COPY_DAYS` days, by the time of
   * their `USED` file (a folder's own time doesn't change when files deeper in it do).
   */
  private async prune(top: vscode.Uri): Promise<void> {
    const old = Date.now() - COPY_DAYS * 24 * 3600 * 1000;
    const fs = vscode.workspace.fs;
    const dirs = async (uri: vscode.Uri) => (await fs.readDirectory(uri).then(e => e, () => []))
      .filter(([, type]) => type === vscode.FileType.Directory).map(([n]) => vscode.Uri.joinPath(uri, n));
    for (const owner of await dirs(top)) {
      for (const repo of await dirs(owner)) {
        for (const sha of await dirs(repo)) {
          const used = await fs.stat(vscode.Uri.joinPath(sha, USED)).then(st => st.mtime, () => fs.stat(sha).then(st => st.mtime));
          if (used < old) {
            await fs.delete(sha, { recursive: true, useTrash: false });
          }
        }
      }
    }
  }

  /**
   * A file of the clone or the copy, by its path in the repository; for the copy, it is fetched
   * from GitHub first. Undefined when it doesn't exist. Only paths inside the folder: a path from
   * the page or from an import can't reach a file outside it.
   */
  private async fileIn(place: Place, path: string): Promise<vscode.Uri | undefined> {
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.' || p === '')) {
      return undefined;
    }
    const uri = vscode.Uri.joinPath(place.folder, path);
    const exists = () => vscode.workspace.fs.stat(uri).then(() => uri, () => undefined);
    const copy = place.copy;
    if (!copy) {
      return exists();
    }
    const key = uri.toString();
    let p = this.fetching.get(key);
    if (!p) {
      p = (async () => {
        if (await exists()) {
          return uri;
        }
        const bytes = await copy.session.bytesAt(path, copy.sha).catch(() => undefined);
        if (!bytes) {
          return undefined;
        }
        // Written under another name, then renamed: a write cut off half-way (VS Code closed, a
        // full disk) mustn't leave a short file that later clicks take as the copy.
        const part = vscode.Uri.joinPath(uri, `../.${uri.path.split('/').pop()}.${process.pid}.part`);
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
          await vscode.workspace.fs.writeFile(part, bytes);
          await vscode.workspace.fs.rename(part, uri, { overwrite: true });
          return uri;
        } catch {
          // A name the file system refuses (`con.py` on Windows), or a full disk.
          await vscode.workspace.fs.delete(part).then(undefined, () => undefined);
          return undefined;
        }
      })();
      this.fetching.set(key, p);
      void p.finally(() => this.fetching.delete(key));
    }
    return p;
  }

  /**
   * Where an imported Python name is defined, by following the import statements of the file
   * (all code cells, for a notebook) to a module of the repository. Undefined when the name isn't
   * imported, or its module isn't in the repository (an installed library is the language
   * server's job).
   */
  private async viaImports(place: Place, where: { doc: vscode.TextDocument; notebook?: vscode.NotebookDocument; cellIndex?: number }, line: number, col: number, path: string): Promise<vscode.Location | undefined> {
    if (where.doc.languageId !== 'python') {
      return undefined;
    }
    let lines = where.doc.getText().split(/\r?\n/);
    if (where.notebook && where.cellIndex !== undefined) {
      lines = [];
      where.notebook.getCells().forEach((c, i) => {
        if (c.kind !== vscode.NotebookCellKind.Code) {
          return;
        }
        if (i === where.cellIndex) {
          line += lines.length;
        }
        lines.push(...c.document.getText().split(/\r?\n/));
      });
    }
    return this.follow(place, importTargets(lines, line, col, path), path, 0, new Set());
  }

  /**
   * The first target that is a module of the repository with that name in it, through re-exports.
   * `seen` holds the targets looked at for this click, so that none is looked at twice and their
   * number stays small.
   */
  private async follow(place: Place, targets: ImportTarget[], from: string, depth: number, seen: Set<string>): Promise<vscode.Location | undefined> {
    for (const target of targets) {
      const key = `${target.fromTop ? '' : `${from}>`}${target.module}:${target.name ?? ''}`;
      if (seen.has(key) || seen.size >= MAX_MODULES) {
        continue;
      }
      seen.add(key);
      // All the files a module can be are asked for together: for a copy, each is a request.
      const files = moduleFiles(target, from);
      const uris = await Promise.all(files.map(f => this.fileIn(place, f)));
      const i = uris.findIndex(u => u);
      const uri = uris[i];
      if (!uri) {
        continue;
      }
      if (target.name === undefined) {
        return new vscode.Location(uri, new vscode.Position(0, 0));
      }
      // A top-level `def`, `class` or assignment is found in the text at once. The language server's
      // symbols (also for a name defined under an `if` or a `try`) can take seconds while it starts.
      const doc = await vscode.workspace.openTextDocument(uri);
      const top = topLevelLine(doc.getText(), target.name);
      if (top !== undefined) {
        const c = columnOf(doc.lineAt(top).text, target.name, 0) ?? 0;
        return new vscode.Location(uri, new vscode.Range(top, c, top, c + target.name.length));
      }
      const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri) ?? [];
      const symbol = symbols.find(sym => sym.name === target.name);
      const range = symbol && ('selectionRange' in symbol ? symbol.selectionRange : symbol.location?.range);
      if (range) {
        return new vscode.Location(uri, range);
      }
      // Imported into this module from another, as in a package's `__init__.py`.
      if (depth < 3) {
        const further = await this.follow(place, importedName(doc.getText(), target.name, files[i]), files[i], depth + 1, seen);
        if (further) {
          return further;
        }
      }
    }
    return undefined;
  }

  /** Opens the local file at the line (a notebook at the cell), in VS Code's own editor. */
  async openInWorkspace(at: PageLine): Promise<NavNote> {
    const repo = await this.localRepo();
    if (!repo) {
      return this.noRepo();
    }
    const where = await this.locate(repo, at);
    if (!where) {
      return `${at.path} isn't in your checkout${repo.branch ? ` (${repo.branch})` : ''}.`;
    }
    const line = where.line ?? 0;
    if (where.notebook) {
      await showCell(where.notebook, where.cellIndex ?? 0, new vscode.Range(line, 0, line, 0));
    } else {
      await vscode.window.showTextDocument(where.doc, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(line, 0, line, 0) });
    }
    if (where.cellIndex === undefined && at.cell) {
      return 'This cell isn\'t in your checkout\'s copy of the notebook: it opens at the top.';
    }
    if (where.line === undefined && at.text.trim()) {
      return `This line isn't in your checkout: the ${at.cell ? 'cell' : 'file'} opens at the top.`;
    }
    return undefined;
  }

  private noRepo(): NavNote {
    const pr = this.state.session?.pr;
    return `Open a clone of ${pr ? `${pr.owner}/${pr.repo}` : 'the repository'} in VS Code to use this: it works on your own checkout, with its language server.`;
  }

  /**
   * The document and line in the checkout that match a line of the review page. For a notebook,
   * the cell (by id, then by source) and a line in it.
   */
  private async locate(repo: Place, at: PageLine): Promise<{
    doc: vscode.TextDocument; line?: number; notebook?: vscode.NotebookDocument; cellIndex?: number; justOpened?: boolean;
  } | undefined> {
    const uri = await this.localFile(repo, at);
    if (!uri) {
      return undefined;
    }
    // Whether VS Code had the file open before: if not, its language server hasn't seen it yet.
    const justOpened = at.cell
      ? !vscode.workspace.notebookDocuments.some(nb => nb.uri.toString() === uri.toString())
      : !vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString());
    try {
      if (at.cell) {
        const notebook = await vscode.workspace.openNotebookDocument(uri);
        if (!notebook.cellCount) {
          return undefined;
        }
        const cells = notebook.getCells().map(c => ({ id: typeof c.metadata?.id === 'string' ? c.metadata.id : undefined, source: c.document.getText() }));
        const index = matchCell(cells, at.cell.id, at.cell.source);
        if (index === undefined) {
          return { doc: notebook.cellAt(0).document, notebook };
        }
        const doc = notebook.cellAt(index).document;
        return { doc, notebook, cellIndex: index, line: matchLine(doc.getText().split(/\r?\n/), at.text, at.line), justOpened };
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      return { doc, line: matchLine(doc.getText().split(/\r?\n/), at.text, at.line), justOpened };
    } catch {
      return undefined;
    }
  }

  /**
   * The file in the checkout: under the pull request's name, else under its old name. Only paths
   * inside the clone: a path from the page can't reach a file outside it.
   */
  private async localFile(repo: Place, at: PageLine): Promise<vscode.Uri | undefined> {
    for (const path of repo.copy ? [at.path] : [at.path, at.oldPath]) {
      const uri = path && (await this.fileIn(repo, path));
      if (uri) {
        return uri;
      }
    }
    return undefined;
  }

  /** Shows the local line beside the page, with VS Code's peek view of the definitions on it. */
  private async peek(where: { doc: vscode.TextDocument; notebook?: vscode.NotebookDocument; cellIndex?: number }, at: vscode.Position, found: (vscode.Location | vscode.LocationLink)[]): Promise<void> {
    const selection = new vscode.Range(at, at);
    if (where.notebook && where.cellIndex !== undefined) {
      await showCell(where.notebook, where.cellIndex, selection);
    } else {
      await vscode.window.showTextDocument(where.doc, { viewColumn: vscode.ViewColumn.Beside, selection });
    }
    const locations = found.map(l => (l instanceof vscode.Location ? l : new vscode.Location(target(l).uri, target(l).range)));
    await vscode.commands.executeCommand('editor.action.goToLocations', where.doc.uri, at, locations, 'peek', 'No definitions found');
  }

  private async pick(name: string, found: (vscode.Location | vscode.LocationLink)[], repo: Place): Promise<vscode.Location | vscode.LocationLink | undefined> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const items = found.map(l => {
      const { uri, range } = target(l);
      const place = shortPlace(fileOf(uri).fsPath, roots);
      return { label: `${place.name}:${range.start.line + 1}`, description: place.where, location: l };
    });
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: `Definitions of ${name}${repo.branch ? ` in ${repo.branch}` : ''}` });
    return chosen?.location;
  }
}

/** The file of a location: a notebook for one of its cells. */
function fileOf(uri: vscode.Uri): vscode.Uri {
  return uri.scheme === 'vscode-notebook-cell' ? uri.with({ scheme: 'file', fragment: '' }) : uri;
}

function target(l: vscode.Location | vscode.LocationLink): { uri: vscode.Uri; range: vscode.Range } {
  return 'targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : { uri: l.uri, range: l.range };
}

/** Shows a definition beside the review page: a file at its line, or a notebook at its cell. */
async function reveal(l: vscode.Location | vscode.LocationLink): Promise<void> {
  const { uri, range } = target(l);
  if (uri.scheme === 'vscode-notebook-cell') {
    const notebook = vscode.workspace.notebookDocuments.find(nb => nb.getCells().some(c => c.document.uri.toString() === uri.toString()));
    const index = notebook?.getCells().findIndex(c => c.document.uri.toString() === uri.toString()) ?? -1;
    if (notebook && index >= 0) {
      await showCell(notebook, index, range);
      return;
    }
  }
  await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, selection: range });
}

/** Shows a notebook beside the review page at a cell, with the cursor on a line of it. */
async function showCell(notebook: vscode.NotebookDocument, index: number, range: vscode.Range): Promise<void> {
  const editor = await vscode.window.showNotebookDocument(notebook, {
    viewColumn: vscode.ViewColumn.Beside,
    selections: [new vscode.NotebookRange(index, index + 1)],
  });
  editor.revealRange(new vscode.NotebookRange(index, index + 1), vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
  // The cell's own editor, for the cursor on the line.
  await vscode.window.showTextDocument(notebook.cellAt(index).document, { viewColumn: editor.viewColumn, selection: range });
}
