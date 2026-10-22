// The "Pull Requests" view and the "Open Pull Request…" picker: pull requests to review, grouped
// like GitHub's own dashboard, with how many notebooks each one changes.
import * as vscode from 'vscode';
import type { GitHub, PrSummary } from './github.ts';

export interface RepoRef {
  owner: string;
  repo: string;
  branch?: string;
}

interface Section {
  id: 'branch' | 'review' | 'notebooks' | 'mine';
  label: string;
  icon: string;
  empty: string;
  prs: PrSummary[];
}

type Node =
  | { kind: 'section'; section: Section }
  | { kind: 'pr'; pr: PrSummary; section: Section }
  | { kind: 'message'; text: string; icon?: string; command?: vscode.Command; tooltip?: string };

export interface PrListDeps {
  /** A GitHub client, or undefined when not signed in and `interactive` is false. */
  github(interactive: boolean): Promise<GitHub | undefined>;
  currentRepo(): Promise<RepoRef | undefined>;
  /** `owner/repo#number` of the pull request under review, if any. */
  activeKey(): string | undefined;
}

const STALE_MS = 3 * 60_000;

export class PrList implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  /** Fires when a load finishes, for the picker. */
  private readonly loaded = new vscode.EventEmitter<void>();
  readonly onDidLoad = this.loaded.event;

  sections: Section[] | undefined;
  repo: RepoRef | undefined;
  loading = false;
  private error: string | undefined;
  private signedOut = false;
  private loadedAt = 0;
  private pending: Promise<void> | undefined;

  constructor(private readonly deps: PrListDeps) {}

  dispose(): void {
    this.changed.dispose();
    this.loaded.dispose();
  }

  /** Redraws without fetching, e.g. when the reviewed pull request changes. */
  redraw(): void {
    this.changed.fire();
  }

  isStale(): boolean {
    return Date.now() - this.loadedAt > STALE_MS;
  }

  refresh(interactive = false): Promise<void> {
    if (this.pending) {
      return this.pending;
    }
    this.pending = this.load(interactive).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async load(interactive: boolean): Promise<void> {
    this.loading = true;
    this.error = undefined;
    this.changed.fire();
    try {
      const gh = await this.deps.github(interactive);
      if (!gh) {
        this.signedOut = true;
        this.sections = undefined;
        return;
      }
      this.signedOut = false;
      this.repo = await this.deps.currentRepo();
      const scope = this.repo ? `repo:${this.repo.owner}/${this.repo.repo} ` : '';
      const queries: Record<string, string> = {
        review: `${scope}is:pr is:open review-requested:@me`,
        notebooks: this.repo ? `${scope}is:pr is:open` : 'is:pr is:open involves:@me',
        mine: `${scope}is:pr is:open author:@me`,
      };
      if (this.repo?.branch) {
        queries.branch = `${scope}is:pr is:open head:${this.repo.branch}`;
      }
      const found = await gh.searchPullRequests(queries);
      const withNotebooksFirst = (prs: PrSummary[]) =>
        [...prs].sort((a, b) => Number(b.notebooks.length > 0) - Number(a.notebooks.length > 0));
      const sections: Section[] = [];
      if (found.branch?.length) {
        sections.push({ id: 'branch', label: 'This branch', icon: 'git-branch', empty: '', prs: found.branch });
      }
      sections.push(
        { id: 'review', label: 'Waiting for my review', icon: 'inbox', empty: 'No review requests', prs: withNotebooksFirst(found.review) },
        {
          id: 'notebooks',
          label: 'Changing notebooks',
          icon: 'notebook',
          empty: 'No open pull requests change notebooks',
          prs: found.notebooks.filter(pr => pr.notebooks.length > 0),
        },
        { id: 'mine', label: 'Created by me', icon: 'account', empty: 'You have no open pull requests', prs: withNotebooksFirst(found.mine) },
      );
      this.sections = sections;
      this.loadedAt = Date.now();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
      this.changed.fire();
      this.loaded.fire();
    }
  }

  getChildren(node?: Node): Node[] {
    if (node?.kind === 'section') {
      return node.section.prs.length
        ? node.section.prs.map(pr => ({ kind: 'pr', pr, section: node.section }))
        : [{ kind: 'message', text: node.section.empty }];
    }
    if (node) {
      return [];
    }
    if (this.signedOut) {
      return [{
        kind: 'message',
        text: 'Sign in to GitHub to see pull requests',
        icon: 'github',
        command: { command: 'nbreview.signIn', title: 'Sign in' },
      }];
    }
    if (this.error && !this.sections) {
      return [{
        kind: 'message',
        text: "Couldn't load pull requests. Click to retry.",
        icon: 'warning',
        tooltip: this.error,
        command: { command: 'nbreview.refreshPrs', title: 'Retry' },
      }];
    }
    if (!this.sections) {
      return [{ kind: 'message', text: 'Loading pull requests…', icon: 'loading~spin' }];
    }
    return this.sections.map(section => ({ kind: 'section', section }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.text);
      item.iconPath = node.icon ? new vscode.ThemeIcon(node.icon) : undefined;
      item.command = node.command;
      item.tooltip = node.tooltip;
      item.contextValue = 'message';
      return item;
    }
    if (node.kind === 'section') {
      const { section } = node;
      const collapsed = section.id === 'mine' && section.prs.length === 0;
      const item = new vscode.TreeItem(
        section.label,
        collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `section:${section.id}`;
      item.iconPath = new vscode.ThemeIcon(section.icon);
      item.description = section.prs.length ? String(section.prs.length) : '';
      item.contextValue = 'section';
      return item;
    }
    return prItem(node.pr, node.section, this.deps.activeKey(), this.repo);
  }

  /** The listed pull requests, each once, in section order. */
  all(): { pr: PrSummary; section: Section }[] {
    const seen = new Set<string>();
    const out: { pr: PrSummary; section: Section }[] = [];
    for (const section of this.sections ?? []) {
      for (const pr of section.prs) {
        const key = prKey(pr);
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ pr, section });
        }
      }
    }
    return out;
  }
}

const BADGE_SCHEME = 'nbreview-pr';

/** Shows how many notebooks a pull request changes as a badge on its row. */
export class PrBadges implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== BADGE_SCHEME) {
      return undefined;
    }
    const more = uri.query.endsWith('+');
    const n = Number.parseInt(uri.query, 10);
    if (!n) {
      return undefined;
    }
    return new vscode.FileDecoration(n > 99 ? '99' : String(n), `${n}${more ? '+' : ''} notebook${n === 1 && !more ? '' : 's'} changed`);
  }
}

export function prKey(pr: { owner: string; repo: string; number: number }): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

function prItem(pr: PrSummary, section: Section, activeKey: string | undefined, repo: RepoRef | undefined): vscode.TreeItem {
  const key = prKey(pr);
  const active = key === activeKey;
  const item = new vscode.TreeItem(`#${pr.number} ${pr.title}`);
  item.id = `${section.id}:${key}`;
  // The notebook count is a badge at the right edge (see PrBadges), so long titles can't hide it.
  item.resourceUri = vscode.Uri.from({ scheme: BADGE_SCHEME, path: `/${pr.owner}/${pr.repo}/${pr.number}`, query: String(pr.notebooks.length) + (pr.changedFiles > 100 ? '+' : '') });
  const otherRepo = !repo || repo.owner !== pr.owner || repo.repo !== pr.repo;
  item.description = [
    active ? 'reviewing' : '',
    pr.notebooks.length ? '' : 'no notebooks',
    otherRepo ? pr.repo : '',
    pr.author,
    shortAge(pr.updatedAt),
    decisionMark(pr),
  ].filter(Boolean).join(' · ');
  item.iconPath = active
    ? new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.blue'))
    : pr.isDraft
      ? new vscode.ThemeIcon('git-pull-request-draft', new vscode.ThemeColor('disabledForeground'))
      : new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor(pr.notebooks.length ? 'gitDecoration.addedResourceForeground' : 'disabledForeground'));
  item.tooltip = prTooltip(pr);
  item.contextValue = 'pr';
  item.command = { command: 'nbreview.openPr', title: 'Review notebooks', arguments: [key] };
  return item;
}

export function notebookCount(pr: PrSummary, short = false): string {
  const n = pr.notebooks.length;
  if (!n) {
    return short ? 'no notebooks' : 'No notebooks';
  }
  const more = pr.changedFiles > 100 ? '+' : '';
  return short ? `📓 ${n}${more}` : `📓 ${n}${more} notebook${n === 1 && !more ? '' : 's'}`;
}

function decisionMark(pr: PrSummary): string {
  return pr.reviewDecision === 'APPROVED' ? '✓' : pr.reviewDecision === 'CHANGES_REQUESTED' ? '✗' : '';
}

export function prTooltip(pr: PrSummary): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**#${pr.number} ${escapeMd(pr.title)}**${pr.isDraft ? ' · _draft_' : ''}\n\n`);
  md.appendMarkdown(`${pr.owner}/${pr.repo} · @${pr.author} · updated ${longAge(pr.updatedAt)}\n\n`);
  md.appendMarkdown(`\`${pr.headRef}\` → \`${pr.baseRef}\` · +${pr.additions} −${pr.deletions} · ${pr.changedFiles} files\n\n`);
  if (pr.reviewDecision) {
    const text = { APPROVED: '$(check) Approved', CHANGES_REQUESTED: '$(request-changes) Changes requested', REVIEW_REQUIRED: '$(eye) Review required' }[pr.reviewDecision];
    md.appendMarkdown(`${text}\n\n`);
  }
  if (pr.notebooks.length) {
    md.appendMarkdown(`**${notebookCount(pr)}**\n\n`);
    for (const path of pr.notebooks.slice(0, 8)) {
      md.appendMarkdown(`- \`${path}\`\n`);
    }
    if (pr.notebooks.length > 8) {
      md.appendMarkdown(`- …and ${pr.notebooks.length - 8} more\n`);
    }
  } else {
    md.appendMarkdown('_This pull request does not change any notebooks._');
  }
  return md;
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, m => `\\${m}`);
}

export function shortAge(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) {
    return `${Math.max(1, Math.round(s / 60))}m`;
  }
  if (s < 86400) {
    return `${Math.round(s / 3600)}h`;
  }
  if (s < 86400 * 30) {
    return `${Math.round(s / 86400)}d`;
  }
  return `${Math.round(s / (86400 * 30))}mo`;
}

export function longAge(iso: string): string {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
    if (Math.abs(s) >= size) {
      return fmt.format(Math.round(s / size), unit);
    }
  }
  return 'just now';
}

// --- Picker ------------------------------------------------------------------------------------

type PickItem = vscode.QuickPickItem & { key?: string };

/**
 * A searchable list of the pull requests in the view; a typed number, `owner/repo#123` or URL
 * opens that pull request directly. Resolves to `owner/repo#number`, or undefined when dismissed.
 */
export async function pickPullRequest(list: PrList, parseRef: (text: string) => string | undefined): Promise<string | undefined> {
  const picker = vscode.window.createQuickPick<PickItem>();
  picker.title = 'Review notebooks in a pull request';
  picker.placeholder = 'Search by title, number, author or branch, or paste a pull request URL';
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.ignoreFocusOut = false;

  const listed = (): PickItem[] => {
    const items: PickItem[] = [];
    let section: string | undefined;
    for (const { pr, section: s } of list.all()) {
      if (s.label !== section) {
        section = s.label;
        items.push({ label: s.label, kind: vscode.QuickPickItemKind.Separator });
      }
      const otherRepo = !list.repo || list.repo.owner !== pr.owner || list.repo.repo !== pr.repo;
      items.push({
        key: prKey(pr),
        label: `${pr.isDraft ? '$(git-pull-request-draft)' : '$(git-pull-request)'} #${pr.number} ${pr.title}`,
        description: notebookCount(pr),
        detail: [otherRepo ? `${pr.owner}/${pr.repo}` : '', `@${pr.author}`, `${pr.headRef} → ${pr.baseRef}`, `updated ${longAge(pr.updatedAt)}`]
          .filter(Boolean)
          .join('  ·  '),
      });
    }
    return items;
  };
  const update = () => {
    const typed = parseRef(picker.value);
    const items = listed();
    const direct: PickItem[] = typed && !items.some(i => i.key === typed)
      ? [{
          key: typed,
          label: `$(arrow-right) Open ${list.repo && typed.startsWith(`${list.repo.owner}/${list.repo.repo}#`) ? typed.slice(typed.indexOf('#')) : typed}`,
          description: list.repo && typed.startsWith(`${list.repo.owner}/${list.repo.repo}#`) ? `${list.repo.owner}/${list.repo.repo} · not in the list` : 'not in the list',
          alwaysShow: true,
        }]
      : [];
    picker.items = [...direct, ...items];
    picker.busy = list.loading;
    if (!items.length && !list.loading && !direct.length) {
      picker.placeholder = 'No pull requests found. Paste a pull request number or URL';
    }
  };

  update();
  const listener = list.onDidLoad(update);
  if (!list.sections || list.isStale()) {
    void list.refresh(true);
    picker.busy = true;
  }
  picker.onDidChangeValue(update);
  const result = await new Promise<string | undefined>(resolve => {
    picker.onDidAccept(() => {
      const chosen = picker.selectedItems[0] ?? picker.activeItems[0];
      const key = chosen?.key ?? parseRef(picker.value);
      if (key) {
        resolve(key);
        picker.hide();
      }
    });
    picker.onDidHide(() => resolve(undefined));
    picker.show();
  });
  listener.dispose();
  picker.dispose();
  return result;
}
