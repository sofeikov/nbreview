// The "Review" side panel: the pull request, its notebooks and its other files, with GitHub
// "Viewed" checkboxes.
import * as vscode from 'vscode';
import type { NotebookEntry, OtherFile } from './session.ts';
import type { ReviewState } from './state.ts';
import { basename, dirname, shortPath } from './paths.ts';

export type Node =
  | { kind: 'pr' }
  | { kind: 'group'; id: 'notebooks' | 'other'; label: string; paths: string[] }
  | { kind: 'notebook'; entry: NotebookEntry }
  | { kind: 'file'; other: OtherFile };

export class FilesTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly state: ReviewState) {
    state.onDidChange(() => this.changed.fire());
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
      return node.id === 'notebooks' ? notebookNodes(this.state) : s.others.map(other => ({ kind: 'file', other }));
    }
    return [];
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
      case 'notebook': {
        const { entry } = node;
        const threads = s.threadsFor(entry.path).length;
        const drafts = this.state.draftsFor(entry.path).length;
        const item = new vscode.TreeItem(shortPath(entry.path, [...s.notebooks.keys()]));
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
          dirname(other.file.filename),
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

/** Every changed file in the order the panel lists them: notebooks first, then the others. */
export function reviewOrder(state: ReviewState): string[] {
  const s = state.session;
  if (!s) {
    return [];
  }
  return [...[...s.notebooks.keys()].sort((a, b) => a.localeCompare(b)), ...s.others.map(o => o.file.filename)];
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
