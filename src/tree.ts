// The "Review" side panel: the pull request, its notebooks and its other files, with GitHub
// "Viewed" checkboxes, shown as a folder tree or as a flat list (setting `nbreview.fileLayout`).
import * as vscode from 'vscode';
import type { NotebookEntry, OtherFile } from './session.ts';
import type { ReviewState } from './state.ts';
import { basename, buildFolderTree, dirname, shortPath, treeOrder, type FolderNode } from './paths.ts';

export type Node =
  | { kind: 'pr' }
  | { kind: 'group'; id: Group; label: string; paths: string[] }
  | { kind: 'folder'; group: Group; folder: FolderNode }
  | { kind: 'notebook'; entry: NotebookEntry }
  | { kind: 'file'; other: OtherFile };

type Group = 'notebooks' | 'other';

export type FileLayout = 'tree' | 'list';

// As in Source Control, the title bar buttons remember a choice of their own instead of writing
// the setting, which only gives the default. Writing a setting fails when VS Code hasn't
// registered it yet, as after an update without a window reload.
let memento: vscode.Memento | undefined;
const layoutChanged = new vscode.EventEmitter<void>();

export function initFileLayout(state: vscode.Memento): vscode.Disposable {
  memento = state;
  return vscode.Disposable.from(
    layoutChanged,
    // Changing the setting takes over from the last button press.
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('nbreview.fileLayout') && void setFileLayout(undefined)),
  );
}

export function fileLayout(): FileLayout {
  const chosen = memento?.get<FileLayout>('fileLayout') ?? vscode.workspace.getConfiguration('nbreview').get<FileLayout>('fileLayout');
  return chosen === 'list' ? 'list' : 'tree';
}

export async function setFileLayout(layout: FileLayout | undefined): Promise<void> {
  await memento?.update('fileLayout', layout);
  layoutChanged.fire();
}

export const onDidChangeFileLayout = layoutChanged.event;

export class FilesTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly state: ReviewState) {
    state.onDidChange(() => this.changed.fire());
    onDidChangeFileLayout(() => this.changed.fire());
  }

  getChildren(node?: Node): Node[] {
    const s = this.state.session;
    if (!s) {
      return [];
    }
    if (!node) {
      const nodes: Node[] = [{ kind: 'pr' }, { kind: 'group', id: 'notebooks', label: 'Notebooks', paths: [...s.notebooks.keys()] }];
      if (s.others.length) {
        nodes.push({ kind: 'group', id: 'other', label: 'Other files', paths: s.others.map(o => o.file.filename) });
      }
      return nodes;
    }
    if (node.kind === 'group') {
      if (fileLayout() === 'tree') {
        return this.folderChildren(node.id, buildFolderTree(node.paths));
      }
      return node.id === 'notebooks' ? notebookNodes(this.state) : s.others.map(other => ({ kind: 'file', other }));
    }
    if (node.kind === 'folder') {
      return this.folderChildren(node.group, node.folder);
    }
    return [];
  }

  private folderChildren(group: Group, folder: FolderNode): Node[] {
    const s = this.state.session!;
    const others = new Map(s.others.map(o => [o.file.filename, o]));
    return [
      ...folder.folders.map(f => ({ kind: 'folder' as const, group, folder: f })),
      ...folder.files.map((p): Node => (group === 'notebooks' ? { kind: 'notebook', entry: s.notebooks.get(p)! } : { kind: 'file', other: others.get(p)! })),
    ];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const s = this.state.session!;
    switch (node.kind) {
      case 'pr': {
        const item = new vscode.TreeItem(`#${s.pr.number} ${s.pr.title}`);
        item.description = `${s.pr.headRef} → ${s.pr.baseRef}`;
        item.tooltip = new vscode.MarkdownString(`**${s.pr.title}**\n\n${s.pr.owner}/${s.pr.repo}#${s.pr.number} by @${s.pr.author}\n\n\`${s.pr.headRef}\` → \`${s.pr.baseRef}\``);
        item.iconPath = new vscode.ThemeIcon('git-pull-request');
        item.contextValue = 'pr';
        item.command = { command: 'nbreview.openOnGitHub', title: 'Open on GitHub' };
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(
          node.label,
          node.id === 'notebooks' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
        );
        const viewed = node.paths.filter(p => this.state.isViewed(p)).length;
        item.description = viewed ? `${viewed}/${node.paths.length} viewed` : String(node.paths.length);
        item.iconPath = new vscode.ThemeIcon(node.id === 'notebooks' ? 'notebook' : 'files');
        return item;
      }
      case 'folder': {
        const { folder } = node;
        const item = new vscode.TreeItem(folder.name, vscode.TreeItemCollapsibleState.Expanded);
        const files = treeOrder(folder);
        const viewed = files.filter(p => this.state.isViewed(p)).length;
        item.id = `${node.group}:${folder.path}`;
        item.description = viewed ? `${viewed}/${files.length} viewed` : undefined;
        item.tooltip = folder.path;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.resourceUri = vscode.Uri.file(`/${folder.path}`);
        return item;
      }
      case 'notebook': {
        const { entry } = node;
        const threads = s.threadsFor(entry.path).length;
        const drafts = this.state.draftsFor(entry.path).length;
        const item = new vscode.TreeItem(fileLayout() === 'tree' ? basename(entry.path) : shortPath(entry.path, [...s.notebooks.keys()]));
        item.description = [threads ? `💬${threads}` : '', drafts ? `✎${drafts}` : '', `+${entry.file.additions} −${entry.file.deletions}`]
          .filter(Boolean)
          .join(' ');
        item.tooltip = `${entry.path}\n${entry.file.status}${entry.error ? `\n⚠ ${entry.error}` : ''}`;
        item.iconPath = new vscode.ThemeIcon('notebook', statusColor(entry.file.status));
        item.contextValue = 'notebook';
        item.checkboxState = this.checkbox(entry.path);
        item.command = { command: 'nbreview.openNotebook', title: 'Review notebook', arguments: [entry.path] };
        return item;
      }
      case 'file': {
        const { other } = node;
        const item = new vscode.TreeItem(basename(other.file.filename));
        const threads = s.fileThreads.get(other.file.filename) ?? [];
        const pending = threads.reduce((n, f) => n + f.gh.comments.filter(c => c.pending).length, 0);
        const published = threads.filter(f => f.gh.comments.some(c => !c.pending)).length;
        item.description = [
          published ? `💬${published}` : '',
          pending ? `✎${pending}` : '',
          `+${other.file.additions} −${other.file.deletions}`,
          fileLayout() === 'list' ? dirname(other.file.filename) : '',
        ].filter(Boolean).join(' ');
        item.tooltip = other.file.filename;
        item.iconPath = new vscode.ThemeIcon('file', statusColor(other.file.status));
        item.contextValue = 'file';
        item.checkboxState = this.checkbox(other.file.filename);
        item.command = { command: 'nbreview.openFileDiff', title: 'Open diff', arguments: [other.file.filename] };
        return item;
      }
    }
  }

  private checkbox(path: string): vscode.TreeItemCheckboxState {
    return this.state.isViewed(path) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
  }
}

function notebookNodes(state: ReviewState): Node[] {
  return reviewOrder(state)
    .filter(p => state.session!.notebooks.has(p))
    .map(p => ({ kind: 'notebook', entry: state.session!.notebooks.get(p)! }));
}

/** Every changed file in the order the panel shows them: notebooks first, then the others. */
export function reviewOrder(state: ReviewState): string[] {
  const s = state.session;
  if (!s) {
    return [];
  }
  const notebooks = [...s.notebooks.keys()];
  const others = s.others.map(o => o.file.filename);
  if (fileLayout() === 'tree') {
    return [...treeOrder(buildFolderTree(notebooks)), ...treeOrder(buildFolderTree(others))];
  }
  return [...notebooks.sort((a, b) => a.localeCompare(b)), ...others];
}

export function nodePath(node: Node): string | undefined {
  return node.kind === 'notebook' ? node.entry.path : node.kind === 'file' ? node.other.file.filename : undefined;
}

function statusColor(status: string): vscode.ThemeColor {
  if (status === 'added') {
    return new vscode.ThemeColor('gitDecoration.addedResourceForeground');
  }
  if (status === 'removed') {
    return new vscode.ThemeColor('gitDecoration.deletedResourceForeground');
  }
  return new vscode.ThemeColor('gitDecoration.modifiedResourceForeground');
}
