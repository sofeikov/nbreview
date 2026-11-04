// Code navigation from the review page, done by VS Code's own language servers on the viewer's
// checkout: "go to definition" on a name, and "open in workspace" for a cell or file. Nothing
// here understands code. It finds the clicked line in the local copy of the file and asks VS Code
// (`vscode.executeDefinitionProvider`, then `vscode.executeWorkspaceSymbolProvider`) where the
// name is defined. Pylance can't do this on the pull request's own files, which aren't on disk.
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import type { ReviewState } from './state.ts';
import { columnOf, isRemoteOf, matchCell, matchLine } from './core/navigate.ts';

/** The open folder that is a clone of the pull request's repository, and what it has checked out. */
export interface LocalRepo {
  folder: vscode.Uri;
  branch?: string;
  /** The checkout is at the pull request's latest commit: its lines are the reviewed ones. */
  atHead: boolean;
}

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

  constructor(private readonly state: ReviewState) {}

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

  /** Goes to where a name on a line of the review page is defined, in the viewer's checkout. */
  async goToDefinition(at: PageLine, name: string, column: number): Promise<NavNote> {
    const repo = await this.localRepo();
    if (!repo) {
      return this.noRepo();
    }
    const where = await this.locate(repo, at);
    const checkout = repo.branch ? `your checkout (${repo.branch})` : 'your checkout';
    let found: (vscode.Location | vscode.LocationLink)[] = [];
    const col = where && where.line !== undefined ? columnOf(where.doc.lineAt(where.line).text, name, column) : undefined;
    if (where && where.line !== undefined && col !== undefined) {
      found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider', where.doc.uri, new vscode.Position(where.line, col)) ?? [];
      // The line is there, and the language server knows of no definition (a word in a comment, an
      // attribute it can't resolve): another symbol of the same name would be a guess.
      if (!found.length) {
        return `VS Code found no definition of ${name} here in ${checkout}.`;
      }
    }
    // The line isn't in the checkout: look the name up instead.
    const exact = found.length > 0;
    if (!exact) {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name) ?? [];
      found = symbols.filter(sym => sym.name === name).map(sym => sym.location);
    }
    if (!found.length) {
      return repo.atHead
        ? `No definition of ${name} found in ${checkout}.`
        : `No definition of ${name} found in ${checkout}. If this pull request adds it, check out its branch to go to it.`;
    }
    const target = found.length === 1 ? found[0] : await this.pick(name, found, repo);
    if (target) {
      await reveal(target);
    }
    if (repo.atHead) {
      return undefined;
    }
    return exact
      ? `From ${checkout}, which isn't at the pull request's latest commit.`
      : `From ${checkout}, found by name: this line isn't in your checkout.`;
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
  private async locate(repo: LocalRepo, at: PageLine): Promise<{
    doc: vscode.TextDocument; line?: number; notebook?: vscode.NotebookDocument; cellIndex?: number;
  } | undefined> {
    const uri = await this.localFile(repo, at);
    if (!uri) {
      return undefined;
    }
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
        return { doc, notebook, cellIndex: index, line: matchLine(doc.getText().split(/\r?\n/), at.text, at.line) };
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      return { doc, line: matchLine(doc.getText().split(/\r?\n/), at.text, at.line) };
    } catch {
      return undefined;
    }
  }

  /**
   * The file in the checkout: under the pull request's name, else under its old name. Only paths
   * inside the clone: a path from the page can't reach a file outside it.
   */
  private async localFile(repo: LocalRepo, at: PageLine): Promise<vscode.Uri | undefined> {
    for (const path of [at.path, at.oldPath]) {
      if (!path || path.startsWith('/') || path.split(/[\\/]/).includes('..')) {
        continue;
      }
      const uri = vscode.Uri.joinPath(repo.folder, path);
      if (await vscode.workspace.fs.stat(uri).then(() => true, () => false)) {
        return uri;
      }
    }
    return undefined;
  }

  private async pick(name: string, found: (vscode.Location | vscode.LocationLink)[], repo: LocalRepo): Promise<vscode.Location | vscode.LocationLink | undefined> {
    const items = found.map(l => {
      const { uri, range } = target(l);
      const path = vscode.workspace.asRelativePath(uri.scheme === 'vscode-notebook-cell' ? uri.with({ scheme: 'file', fragment: '' }) : uri);
      return { label: `${path}:${range.start.line + 1}`, location: l };
    });
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: `Definitions of ${name}${repo.branch ? ` in ${repo.branch}` : ''}` });
    return chosen?.location;
  }
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
