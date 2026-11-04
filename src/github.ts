// Minimal GitHub client: the REST calls for PR files and contents, GraphQL for review threads
// and for posting a review (GraphQL is the only API that can add file-level threads to a review).
import type { Side } from './core/anchor.ts';
import { REACTIONS, type ReactionContent } from './core/reactions.ts';
import type { PrCommit } from './core/range.ts';
import {
  checkRunState, latestChecks, mergeReviewers, sortChecks, statusContextState,
  type Check, type MergeMethod, type MergeSettings, type MergeStateStatus, type ReviewDecision, type Reviewer, type ReviewState,
} from './core/prStatus.ts';

export type { ReactionContent };

/** Files marked viewed per request. */
const VIEWED_BATCH = 50;

export interface PrInfo {
  owner: string;
  repo: string;
  number: number;
  nodeId: string;
  title: string;
  url: string;
  author: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  /** How many commits the pull request has. */
  commits: number;
}

export interface PrFile {
  filename: string;
  previousFilename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GhComment {
  id: string;
  /** Part of the viewer's pending (unsubmitted) review: visible only to them, editable. */
  pending: boolean;
  /** REST id, for replying with a single comment. */
  databaseId?: number;
  body: string;
  createdAt: string;
  url: string;
  author: string;
  avatarUrl?: string;
  /** The viewer wrote it (or may otherwise change it), so it can be edited or deleted. */
  viewerCanUpdate: boolean;
  viewerCanDelete: boolean;
  /** Reactions given so far (none on pending comments: GitHub doesn't allow them). */
  reactions: GhReaction[];
}

export interface GhReaction {
  content: ReactionContent;
  count: number;
  viewerHasReacted: boolean;
}

/** The viewer's last submitted review of a pull request. */
export interface LastReview {
  /** The commit the review was made on. */
  sha: string;
  submittedAt: string;
}

export interface GhThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  diffSide: Side;
  subjectType: 'LINE' | 'FILE';
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  comments: GhComment[];
}

export interface NewThread {
  path: string;
  body: string;
  side: Side;
  subjectType: 'LINE' | 'FILE';
  line?: number;
  startLine?: number;
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/** A pull request as listed in the Pull Requests view and the picker. */
export interface PrSummary {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  headRef: string;
  baseRef: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
  /** Changed notebook paths (among the first 100 changed files). */
  notebooks: string[];
  changedFiles: number;
}

export interface GhUser {
  login: string;
  avatarUrl?: string;
}

/** The pull request's status, people, description and conversation, for the Overview page. */
export interface GhOverview {
  viewer: string;
  nodeId: string;
  /** The commit the pull request's branch is at; a merge is refused if it has moved on. */
  headSha: string;
  /** The head branch, while it exists (it is deleted after a merge, by hand or by GitHub). */
  headRefId?: string;
  /** The viewer may merge into the base repository, and push to (so delete) the head branch. */
  canMerge: boolean;
  canPushHead: boolean;
  /** The viewer may edit the pull request, so mark it ready for review. */
  canUpdate: boolean;
  merge: MergeSettings;
  /** The last commit's message, for the default squash commit message. */
  lastCommit?: { headline: string; body: string };
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: GhUser;
  createdAt: string;
  body: string;
  reactions: GhReaction[];
  baseRef: string;
  headRef: string;
  /** The owner of the head branch's repository, when it is a fork. */
  headOwner?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus?: MergeStateStatus;
  reviewDecision?: ReviewDecision;
  mergedAt?: string;
  mergedBy?: string;
  closedAt?: string;
  reviewers: Reviewer[];
  assignees: GhUser[];
  labels: { name: string; color: string }[];
  milestone?: string;
  closingIssues: { number: number; title: string; url: string; state: 'OPEN' | 'CLOSED' }[];
  checks: Check[];
  timeline: GhTimelineItem[];
  /** Timeline items left out because there were too many. */
  timelineMissing: number;
}

export type GhTimelineItem =
  | { kind: 'comment'; id: string; author: GhUser; createdAt: string; body: string; url: string; reactions: GhReaction[] }
  | {
    kind: 'review';
    id: string;
    author: GhUser;
    state: ReviewState;
    createdAt: string;
    body: string;
    url: string;
    reactions: GhReaction[];
    /** Ids of the comments made in this review, to put each thread under the review that started it. */
    commentIds: string[];
  }
  | { kind: 'commit'; oid: string; message: string; author: GhUser; createdAt: string; url: string }
  | {
    kind: 'event';
    event: 'merged' | 'closed' | 'reopened' | 'ready' | 'draft' | 'forcePushed' | 'branchDeleted' | 'reviewRequested' | 'reviewDismissed' | 'renamed' | 'baseChanged';
    actor: GhUser;
    createdAt: string;
    /** Who was asked to review, the old title, the new base branch, the deleted branch. */
    subject?: string;
  };

/** Timeline pages read at most; a long-running pull request can have thousands of events. */
const TIMELINE_PAGES = 5;

const TIMELINE_TYPES = [
  'ISSUE_COMMENT', 'PULL_REQUEST_REVIEW', 'PULL_REQUEST_COMMIT', 'HEAD_REF_FORCE_PUSHED_EVENT', 'HEAD_REF_DELETED_EVENT', 'MERGED_EVENT', 'CLOSED_EVENT',
  'REOPENED_EVENT', 'READY_FOR_REVIEW_EVENT', 'CONVERT_TO_DRAFT_EVENT', 'REVIEW_REQUESTED_EVENT', 'REVIEW_DISMISSED_EVENT',
  'RENAMED_TITLE_EVENT', 'BASE_REF_CHANGED_EVENT',
].join(',');

const REACTION_FIELDS = 'reactionGroups{content viewerHasReacted reactors{totalCount}}';

const TIMELINE_FIELDS = `pageInfo{hasNextPage endCursor} totalCount nodes{__typename
  ... on IssueComment{id createdAt body url author{login avatarUrl} ${REACTION_FIELDS}}
  ... on PullRequestReview{id state createdAt submittedAt body url author{login avatarUrl} ${REACTION_FIELDS} comments(first:100){nodes{id}}}
  ... on PullRequestCommit{url commit{oid messageHeadline committedDate author{name user{login avatarUrl}}}}
  ... on HeadRefForcePushedEvent{createdAt actor{login avatarUrl}}
  ... on HeadRefDeletedEvent{createdAt actor{login avatarUrl} headRefName}
  ... on MergedEvent{createdAt actor{login avatarUrl}}
  ... on ClosedEvent{createdAt actor{login avatarUrl}}
  ... on ReopenedEvent{createdAt actor{login avatarUrl}}
  ... on ReadyForReviewEvent{createdAt actor{login avatarUrl}}
  ... on ConvertToDraftEvent{createdAt actor{login avatarUrl}}
  ... on ReviewRequestedEvent{createdAt actor{login avatarUrl} requestedReviewer{... on User{login} ... on Team{name} ... on Bot{login}}}
  ... on ReviewDismissedEvent{createdAt actor{login avatarUrl} review{author{login}}}
  ... on RenamedTitleEvent{createdAt actor{login avatarUrl} previousTitle}
  ... on BaseRefChangedEvent{createdAt actor{login avatarUrl} currentRefName}}`;

function user(u: any): GhUser {
  return { login: u?.login ?? 'ghost', avatarUrl: u?.avatarUrl ?? undefined };
}

function reactions(groups: any[] | undefined): GhReaction[] {
  return (groups ?? [])
    .filter((g: any) => g.content in REACTIONS && (g.reactors?.totalCount > 0 || g.viewerHasReacted))
    .map((g: any) => ({ content: g.content, count: g.reactors?.totalCount ?? 0, viewerHasReacted: !!g.viewerHasReacted }));
}

/** One timeline node as an item, or undefined for kinds the page doesn't show. */
export function timelineItem(n: any): GhTimelineItem | undefined {
  const event = (event: Extract<GhTimelineItem, { kind: 'event' }>['event'], subject?: string): GhTimelineItem =>
    ({ kind: 'event', event, actor: user(n.actor), createdAt: n.createdAt, ...(subject ? { subject } : {}) });
  switch (n.__typename) {
    case 'IssueComment':
      return { kind: 'comment', id: n.id, author: user(n.author), createdAt: n.createdAt, body: n.body ?? '', url: n.url, reactions: reactions(n.reactionGroups) };
    case 'PullRequestReview':
      return {
        kind: 'review',
        id: n.id,
        author: user(n.author),
        state: n.state,
        createdAt: n.submittedAt ?? n.createdAt,
        body: n.body ?? '',
        url: n.url,
        reactions: reactions(n.reactionGroups),
        commentIds: (n.comments?.nodes ?? []).map((c: any) => c.id),
      };
    case 'PullRequestCommit': {
      const c = n.commit;
      return {
        kind: 'commit',
        oid: c.oid,
        message: c.messageHeadline ?? '',
        author: c.author?.user ? user(c.author.user) : { login: c.author?.name ?? 'unknown' },
        createdAt: c.committedDate,
        url: n.url,
      };
    }
    case 'HeadRefForcePushedEvent':
      return event('forcePushed');
    case 'HeadRefDeletedEvent':
      return event('branchDeleted', n.headRefName);
    case 'MergedEvent':
      return event('merged');
    case 'ClosedEvent':
      return event('closed');
    case 'ReopenedEvent':
      return event('reopened');
    case 'ReadyForReviewEvent':
      return event('ready');
    case 'ConvertToDraftEvent':
      return event('draft');
    case 'ReviewRequestedEvent':
      return event('reviewRequested', n.requestedReviewer?.login ?? n.requestedReviewer?.name);
    case 'ReviewDismissedEvent':
      return event('reviewDismissed', n.review?.author?.login);
    case 'RenamedTitleEvent':
      return event('renamed', n.previousTitle);
    case 'BaseRefChangedEvent':
      return event('baseChanged', n.currentRefName);
    default:
      return undefined;
  }
}

/** The checks on the head commit, from its status rollup. */
export function checksFrom(rollup: any): Check[] {
  return (rollup?.contexts?.nodes ?? []).map((c: any): Check => {
    if (c.__typename === 'StatusContext') {
      return {
        name: c.context,
        state: statusContextState(c.state),
        description: c.description ?? undefined,
        url: c.targetUrl ?? undefined,
        required: !!c.isRequired,
        startedAt: c.createdAt ?? undefined,
      };
    }
    const state = checkRunState(c.status, c.conclusion);
    return {
      name: c.name,
      workflow: c.checkSuite?.workflowRun?.workflow?.name ?? c.checkSuite?.app?.name ?? undefined,
      state,
      description: c.title || (c.status === 'COMPLETED' ? undefined : c.status === 'IN_PROGRESS' ? 'In progress' : 'Queued'),
      url: c.detailsUrl ?? undefined,
      required: !!c.isRequired,
      startedAt: c.startedAt ?? undefined,
      completedAt: c.completedAt ?? undefined,
    };
  });
}

const PR_FIELDS = `... on PullRequest {
  number title url isDraft updatedAt headRefName baseRefName additions deletions reviewDecision
  author { login } repository { nameWithOwner }
  files(first: 100) { totalCount nodes { path } }
}`;

export class GitHub {
  constructor(private readonly token: string) {}

  private async request(url: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
    const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: init.accept ?? 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nbreview-vscode',
        ...(init.headers ?? {}),
      },
    });
    return res;
  }

  private async json<T>(url: string): Promise<T> {
    const res = await this.request(url);
    if (!res.ok) {
      throw new Error(`GitHub ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.request('/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
    const payload = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || payload.errors?.length) {
      throw new Error(`GitHub GraphQL: ${payload.errors?.map(e => e.message).join('; ') ?? res.status}`);
    }
    return payload.data!;
  }

  async getPr(owner: string, repo: string, number: number): Promise<PrInfo> {
    const pr = await this.json<any>(`/repos/${owner}/${repo}/pulls/${number}`);
    return {
      owner,
      repo,
      number,
      nodeId: pr.node_id,
      title: pr.title,
      url: pr.html_url,
      author: pr.user?.login ?? '',
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      commits: pr.commits ?? 0,
    };
  }

  async listFiles(owner: string, repo: string, number: number): Promise<PrFile[]> {
    const page = (n: number) => this.json<any[]>(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${n}`);
    // Pages 1 and 2 together: most pull requests fit, and the rest are rare enough to fetch in turn.
    const batches: any[][] = await Promise.all([page(1), page(2)]);
    for (let n = 3; n <= 30 && batches[batches.length - 1].length === 100; n++) {
      batches.push(await page(n));
    }
    if (batches[0].length < 100) {
      batches.length = 1;
    }
    return batches.flat().map(f => ({
      filename: f.filename,
      previousFilename: f.previous_filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }));
  }

  /** Raw file content at a commit, or undefined when the file doesn't exist there. */
  async getContent(owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
    const bytes = await this.getBytes(owner, repo, path, ref);
    return bytes && new TextDecoder().decode(bytes);
  }

  /** The file's bytes at a commit, which images and other binary files need: text would garble them. */
  async getBytes(owner: string, repo: string, path: string, ref: string): Promise<Uint8Array | undefined> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await this.request(`/repos/${owner}/${repo}/contents/${encoded}?ref=${ref}`, { accept: 'application/vnd.github.raw' });
    if (res.status === 404) {
      return undefined;
    }
    if (!res.ok) {
      throw new Error(`GitHub ${res.status} fetching ${path}@${ref.slice(0, 7)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * The review threads of a pull request, including the comments of the viewer's pending review
   * (GitHub shows those to their author only), and the id of that pending review if there is one.
   */
  async getThreads(owner: string, repo: string, number: number): Promise<{ threads: GhThread[]; pendingReviewId?: string }> {
    const threads: GhThread[] = [];
    let pendingReviewId: string | undefined;
    let after: string | null = null;
    for (;;) {
      const data: any = await this.graphql(
        `query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){
          reviews(states:PENDING, first:10){nodes{id viewerDidAuthor}}
          reviewThreads(first:100, after:$after){pageInfo{hasNextPage endCursor} nodes{
            id path line startLine originalLine diffSide subjectType isResolved isOutdated viewerCanResolve viewerCanUnresolve
            comments(first:100){nodes{id databaseId body createdAt url author{login avatarUrl} pullRequestReview{state}
              viewerCanUpdate viewerCanDelete reactionGroups{content viewerHasReacted reactors{totalCount}}}}}}}}}`,
        { o: owner, r: repo, n: number, after },
      );
      const pr = data.repository.pullRequest;
      pendingReviewId ??= pr.reviews.nodes.find((r: any) => r.viewerDidAuthor)?.id;
      const page = pr.reviewThreads;
      for (const t of page.nodes) {
        threads.push({
          id: t.id,
          path: t.path,
          line: t.line,
          startLine: t.startLine,
          originalLine: t.originalLine,
          diffSide: t.diffSide,
          subjectType: t.subjectType,
          isResolved: t.isResolved,
          isOutdated: t.isOutdated,
          viewerCanResolve: !!t.viewerCanResolve,
          viewerCanUnresolve: !!t.viewerCanUnresolve,
          comments: t.comments.nodes
            // Every posted review comment belongs to a review. Right after a pending review is
            // discarded, GitHub can briefly return its comments with no review; they are gone.
            .filter((c: any) => c.pullRequestReview)
            .map((c: any) => ({
            id: c.id,
            pending: c.pullRequestReview?.state === 'PENDING',
            databaseId: c.databaseId ?? undefined,
            body: c.body,
            createdAt: c.createdAt,
            url: c.url,
            author: c.author?.login ?? 'ghost',
            avatarUrl: c.author?.avatarUrl,
            viewerCanUpdate: !!c.viewerCanUpdate,
            viewerCanDelete: !!c.viewerCanDelete,
            reactions: (c.reactionGroups ?? [])
              .filter((g: any) => g.content in REACTIONS && (g.reactors?.totalCount > 0 || g.viewerHasReacted))
              .map((g: any) => ({ content: g.content, count: g.reactors?.totalCount ?? 0, viewerHasReacted: !!g.viewerHasReacted })),
          })),
        });
      }
      if (!page.pageInfo.hasNextPage) {
        break;
      }
      after = page.pageInfo.endCursor;
    }
    return { threads: threads.filter(t => t.comments.length > 0), pendingReviewId };
  }

  /**
   * Runs several pull request searches in one request, e.g.
   * `{ mine: 'repo:o/r is:pr is:open author:@me' }`, newest activity first.
   */
  async searchPullRequests<K extends string>(queries: Record<K, string>, perQuery = 30): Promise<Record<K, PrSummary[]>> {
    const keys = Object.keys(queries) as K[];
    if (!keys.length) {
      return {} as Record<K, PrSummary[]>;
    }
    const vars = keys.map((_, i) => `$q${i}: String!`).join(', ');
    const body = keys.map((_, i) => `s${i}: search(query: $q${i}, type: ISSUE, first: ${perQuery}) { nodes { ${PR_FIELDS} } }`).join('\n');
    const data: any = await this.graphql(
      `query(${vars}) { ${body} }`,
      Object.fromEntries(keys.map((k, i) => [`q${i}`, `${queries[k]} sort:updated-desc`])),
    );
    const out = {} as Record<K, PrSummary[]>;
    keys.forEach((k, i) => {
      out[k] = (data[`s${i}`]?.nodes ?? [])
        .filter((n: any) => n && n.number)
        .map((n: any): PrSummary => {
          const [owner, repo] = String(n.repository.nameWithOwner).split('/');
          return {
            owner,
            repo,
            number: n.number,
            title: n.title,
            url: n.url,
            author: n.author?.login ?? 'ghost',
            isDraft: n.isDraft,
            headRef: n.headRefName,
            baseRef: n.baseRefName,
            updatedAt: n.updatedAt,
            additions: n.additions,
            deletions: n.deletions,
            reviewDecision: n.reviewDecision ?? undefined,
            notebooks: (n.files?.nodes ?? []).map((f: any) => f.path).filter((p: string) => p.endsWith('.ipynb')),
            changedFiles: n.files?.totalCount ?? 0,
          };
        });
    });
    return out;
  }

  /**
   * GitHub's per-file "Viewed" checkboxes for the signed-in user, and the files GitHub unchecked
   * because they changed after being marked viewed.
   */
  async getViewed(owner: string, repo: string, number: number): Promise<{ viewed: Map<string, boolean>; dismissed: Set<string> }> {
    const viewed = new Map<string, boolean>();
    const dismissed = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const data: any = await this.graphql(
        `query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){
          files(first:100, after:$after){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}`,
        { o: owner, r: repo, n: number, after },
      );
      const page = data.repository.pullRequest.files;
      for (const f of page.nodes) {
        viewed.set(f.path, f.viewerViewedState === 'VIEWED');
        if (f.viewerViewedState === 'DISMISSED') {
          dismissed.add(f.path);
        }
      }
      if (!page.pageInfo.hasNextPage) {
        break;
      }
      after = page.pageInfo.endCursor;
    }
    return { viewed, dismissed };
  }

  /** The viewer's last submitted review of the pull request, if any. */
  async lastReview(owner: string, repo: string, number: number): Promise<LastReview | undefined> {
    const data: any = await this.graphql(
      `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
        reviews(last:100){nodes{viewerDidAuthor state submittedAt commit{oid}}}}}}`,
      { o: owner, r: repo, n: number },
    );
    const mine = (data.repository.pullRequest.reviews.nodes as any[])
      .filter(r => r.viewerDidAuthor && r.state !== 'PENDING' && r.submittedAt && r.commit?.oid);
    const last = mine[mine.length - 1];
    return last && { sha: last.commit.oid, submittedAt: last.submittedAt };
  }

  /**
   * Everything the Overview page shows, in one request (more only for a long timeline). Without
   * `timeline` it is only the status, for the Review panel.
   */
  async getOverview(owner: string, repo: string, number: number, timeline = true): Promise<GhOverview> {
    const data: any = await this.graphql(
      `query($o:String!,$r:String!,$n:Int!,$t:Boolean!){viewer{login} repository(owner:$o,name:$r){
        viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod
        squashMergeCommitTitle squashMergeCommitMessage mergeCommitTitle mergeCommitMessage
        pullRequest(number:$n){
        id headRefOid headRef{id} headRepository{viewerPermission} viewerCanUpdate
        title url state isDraft createdAt body baseRefName headRefName headRepositoryOwner{login} repository{owner{login}}
        additions deletions changedFiles mergeable mergeStateStatus reviewDecision mergedAt mergedBy{login} closedAt
        author{login avatarUrl} ${REACTION_FIELDS}
        assignees(first:20){nodes{login avatarUrl}}
        labels(first:30){nodes{name color}}
        milestone{title}
        closingIssuesReferences(first:10){nodes{number title url state}}
        reviewRequests(first:30){nodes{requestedReviewer{__typename ... on User{login avatarUrl} ... on Team{name avatarUrl} ... on Bot{login avatarUrl}}}}
        latestOpinionatedReviews(first:50){nodes{state submittedAt author{login avatarUrl}}}
        latestReviews(first:50){nodes{state submittedAt author{login avatarUrl}}}
        commits(last:1){totalCount nodes{commit{messageHeadline messageBody statusCheckRollup{contexts(first:100){nodes{__typename
          ... on CheckRun{name title status conclusion detailsUrl startedAt completedAt isRequired(pullRequestNumber:$n)
            checkSuite{app{name} workflowRun{workflow{name}}}}
          ... on StatusContext{context state description targetUrl createdAt isRequired(pullRequestNumber:$n)}}}}}}}
        timelineItems(first:100, itemTypes:[${TIMELINE_TYPES}]) @include(if:$t){${TIMELINE_FIELDS}}
      }}}`,
      { o: owner, r: repo, n: number, t: timeline },
    );
    const repository = data.repository;
    const pr = repository.pullRequest;
    const writes = (permission: string | null | undefined) => permission === 'ADMIN' || permission === 'MAINTAIN' || permission === 'WRITE';
    const methods = ([['MERGE', repository.mergeCommitAllowed], ['SQUASH', repository.squashMergeAllowed], ['REBASE', repository.rebaseMergeAllowed]] as [MergeMethod, boolean][])
      .filter(([, allowed]) => allowed)
      .map(([m]) => m);
    const last = pr.commits?.nodes?.[0]?.commit;
    const reviewer = (r: any): Reviewer => ({ ...user(r.author), state: r.state, submittedAt: r.submittedAt ?? undefined });
    const requested = (pr.reviewRequests?.nodes ?? []).map((n: any): Reviewer | undefined => {
      const who = n.requestedReviewer;
      if (!who) {
        return undefined;
      }
      return who.__typename === 'Team'
        ? { login: who.name, avatarUrl: who.avatarUrl ?? undefined, state: 'REQUESTED', team: true }
        : { login: who.login, avatarUrl: who.avatarUrl ?? undefined, state: 'REQUESTED' };
    }).filter(Boolean) as Reviewer[];
    const items: GhTimelineItem[] = [];
    let page = pr.timelineItems;
    let missing = 0;
    for (let n = 1; page; n++) {
      items.push(...page.nodes.map(timelineItem).filter(Boolean));
      if (!page.pageInfo.hasNextPage) {
        break;
      }
      if (n >= TIMELINE_PAGES) {
        missing = page.totalCount - n * 100;
        break;
      }
      const more: any = await this.graphql(
        `query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){
          timelineItems(first:100, after:$after, itemTypes:[${TIMELINE_TYPES}]){${TIMELINE_FIELDS}}}}}`,
        { o: owner, r: repo, n: number, after: page.pageInfo.endCursor },
      );
      page = more.repository.pullRequest.timelineItems;
    }
    const headOwner = pr.headRepositoryOwner?.login;
    return {
      viewer: data.viewer.login,
      nodeId: pr.id,
      headSha: pr.headRefOid,
      headRefId: pr.headRef?.id ?? undefined,
      canMerge: writes(repository.viewerPermission),
      canPushHead: writes(pr.headRepository?.viewerPermission),
      canUpdate: !!pr.viewerCanUpdate,
      merge: {
        methods,
        preferred: repository.viewerDefaultMergeMethod ?? undefined,
        squashTitle: repository.squashMergeCommitTitle ?? undefined,
        squashMessage: repository.squashMergeCommitMessage ?? undefined,
        mergeTitle: repository.mergeCommitTitle ?? undefined,
        mergeMessage: repository.mergeCommitMessage ?? undefined,
      },
      ...(last ? { lastCommit: { headline: last.messageHeadline ?? '', body: last.messageBody ?? '' } } : {}),
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: !!pr.isDraft,
      author: user(pr.author),
      createdAt: pr.createdAt,
      body: pr.body ?? '',
      reactions: reactions(pr.reactionGroups),
      baseRef: pr.baseRefName,
      headRef: pr.headRefName,
      ...(headOwner && headOwner !== pr.repository?.owner?.login ? { headOwner } : {}),
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      commits: pr.commits?.totalCount ?? 0,
      mergeable: pr.mergeable ?? 'UNKNOWN',
      mergeStateStatus: pr.mergeStateStatus ?? undefined,
      reviewDecision: pr.reviewDecision ?? undefined,
      mergedAt: pr.mergedAt ?? undefined,
      mergedBy: pr.mergedBy?.login,
      closedAt: pr.closedAt ?? undefined,
      reviewers: mergeReviewers(
        (pr.latestOpinionatedReviews?.nodes ?? []).map(reviewer),
        (pr.latestReviews?.nodes ?? []).map(reviewer),
        requested,
      ),
      assignees: (pr.assignees?.nodes ?? []).map(user),
      labels: (pr.labels?.nodes ?? []).map((l: any) => ({ name: l.name, color: l.color })),
      milestone: pr.milestone?.title,
      closingIssues: (pr.closingIssuesReferences?.nodes ?? []).map((i: any) => ({ number: i.number, title: i.title, url: i.url, state: i.state })),
      checks: sortChecks(latestChecks(checksFrom(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup))),
      timeline: items,
      timelineMissing: Math.max(0, missing),
    };
  }

  /**
   * Merges the pull request. GitHub refuses if its branch is no longer at `expectedHeadOid`, so
   * commits pushed after the reviewer last looked are never merged unseen. A title or body left
   * out is GitHub's own default.
   */
  async mergePullRequest(prNodeId: string, o: { method: MergeMethod; expectedHeadOid: string; title?: string; body?: string }): Promise<void> {
    await this.graphql(`mutation($input:MergePullRequestInput!){mergePullRequest(input:$input){pullRequest{state}}}`, {
      input: {
        pullRequestId: prNodeId,
        mergeMethod: o.method,
        expectedHeadOid: o.expectedHeadOid,
        ...(o.title !== undefined ? { commitHeadline: o.title } : {}),
        ...(o.body !== undefined ? { commitBody: o.body } : {}),
      },
    });
  }

  async markReadyForReview(prNodeId: string): Promise<void> {
    await this.graphql(`mutation($input:MarkPullRequestReadyForReviewInput!){markPullRequestReadyForReview(input:$input){pullRequest{isDraft}}}`, {
      input: { pullRequestId: prNodeId },
    });
  }

  /** Merges the base branch into the pull request's branch, as github.com's "Update branch" does. */
  async updateBranch(prNodeId: string, expectedHeadOid: string): Promise<void> {
    await this.graphql(`mutation($input:UpdatePullRequestBranchInput!){updatePullRequestBranch(input:$input){pullRequest{headRefOid}}}`, {
      input: { pullRequestId: prNodeId, expectedHeadOid, updateMethod: 'MERGE' },
    });
  }

  /** Deletes a branch, such as a merged pull request's (github.com can restore it). */
  async deleteBranch(refId: string): Promise<void> {
    await this.graphql(`mutation($input:DeleteRefInput!){deleteRef(input:$input){clientMutationId}}`, { input: { refId } });
  }

  /** The pull request's commits, oldest first (GitHub lists up to 250). */
  async listCommits(owner: string, repo: string, number: number): Promise<PrCommit[]> {
    const out: PrCommit[] = [];
    let after: string | null = null;
    do {
      const data: any = await this.graphql(
        `query($o:String!,$r:String!,$n:Int!,$a:String){repository(owner:$o,name:$r){pullRequest(number:$n){
          commits(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{commit{
            oid messageHeadline committedDate parents(first:1){nodes{oid}} author{name user{login}}}}}}}}`,
        { o: owner, r: repo, n: number, a: after },
      );
      const page = data.repository.pullRequest.commits;
      for (const { commit: c } of page.nodes as any[]) {
        out.push({
          sha: c.oid,
          parent: c.parents?.nodes?.[0]?.oid,
          headline: c.messageHeadline ?? '',
          author: c.author?.user?.login ?? c.author?.name ?? '',
          date: c.committedDate,
        });
      }
      after = page.pageInfo.hasNextPage && out.length < 250 ? page.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  /**
   * The commits, reachable from `head`, that changed a file: GitHub's history of one path. Up to
   * 100, the newest first, which covers the commits of almost any pull request.
   */
  async commitsTouching(owner: string, repo: string, head: string, path: string): Promise<Set<string>> {
    const list = await this.json<any[]>(`/repos/${owner}/${repo}/commits?sha=${head}&path=${encodeURIComponent(path)}&per_page=100`);
    return new Set(list.map(c => c.sha as string));
  }

  /**
   * Paths changed between two commits, or undefined when GitHub can't compare them (for example
   * when the older one was rewritten away by a force push).
   */
  async changedBetween(owner: string, repo: string, from: string, to: string): Promise<string[] | undefined> {
    const res = await this.request(`/repos/${owner}/${repo}/compare/${from}...${to}?per_page=300`);
    if (res.status === 404 || res.status === 422) {
      return undefined;
    }
    if (!res.ok) {
      throw new Error(`GitHub ${res.status} comparing ${from.slice(0, 7)}...${to.slice(0, 7)}`);
    }
    const files = ((await res.json()) as any).files ?? [];
    return files.flatMap((f: any) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]);
  }

  /**
   * Marks files viewed or not. GitHub has one mutation per file, so a folder's files go as aliased
   * mutations in a few requests rather than one request each.
   */
  async setViewed(prNodeId: string, paths: string[], viewed: boolean): Promise<void> {
    const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
    for (let i = 0; i < paths.length; i += VIEWED_BATCH) {
      const chunk = paths.slice(i, i + VIEWED_BATCH);
      const fields = chunk.map((_, j) => `f${j}:${mutation}(input:{pullRequestId:$pr,path:$p${j}}){clientMutationId}`);
      const vars = chunk.map((_, j) => `$p${j}:String!`);
      await this.graphql(`mutation($pr:ID!,${vars.join(',')}){${fields.join(' ')}}`, {
        pr: prNodeId,
        ...Object.fromEntries(chunk.map((p, j) => [`p${j}`, p])),
      });
    }
  }

  /**
   * Posts one comment straight away, outside any review ("Add single comment" on GitHub). It
   * doesn't touch a review the user has pending on github.com.
   */
  async postSingleComment(pr: PrInfo, t: NewThread): Promise<void> {
    const where = t.subjectType === 'FILE'
      ? { subject_type: 'file' }
      : { line: t.line, side: t.side, ...(t.startLine ? { start_line: t.startLine, start_side: t.side } : {}) };
    await this.post(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`, {
      body: t.body,
      commit_id: pr.headSha,
      path: t.path,
      ...where,
    });
  }

  /** Replies to a review thread straight away, outside any review. */
  async postSingleReply(pr: PrInfo, commentDatabaseId: number, body: string): Promise<void> {
    await this.post(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments/${commentDatabaseId}/replies`, { body });
  }

  private async post(url: string, payload: unknown): Promise<unknown> {
    const res = await this.request(url, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) {
      const detail = await res.text();
      let message = detail.slice(0, 300);
      try {
        const parsed = JSON.parse(detail);
        message = [parsed.message, ...(parsed.errors ?? []).map((e: any) => e.message ?? e.code ?? JSON.stringify(e))].filter(Boolean).join(': ');
      } catch {
        // not JSON
      }
      throw new Error(`GitHub ${res.status}: ${message}`);
    }
    return res.json();
  }

  // --- The pending review ----------------------------------------------------------------------
  // Comments made with "Start a review" go into the viewer's pending review on GitHub, which only
  // they can see until they submit it. It is the same review github.com uses, so either can be
  // used to add to it, edit it or submit it.

  /** Opens a pending review on the pull request and returns its id. */
  async startPendingReview(pr: PrInfo): Promise<string> {
    const data: any = await this.graphql(
      `mutation($pr:ID!,$sha:GitObjectID!){addPullRequestReview(input:{pullRequestId:$pr,commitOID:$sha}){pullRequestReview{id}}}`,
      { pr: pr.nodeId, sha: pr.headSha },
    );
    return data.addPullRequestReview.pullRequestReview.id;
  }

  async addPendingThread(reviewId: string, t: NewThread): Promise<void> {
    await this.graphql(`mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){thread{id}}}`, {
      input: {
        pullRequestReviewId: reviewId,
        path: t.path,
        body: t.body,
        subjectType: t.subjectType,
        ...(t.subjectType === 'LINE' ? { line: t.line, side: t.side, ...(t.startLine ? { startLine: t.startLine, startSide: t.side } : {}) } : {}),
      },
    });
  }

  async addPendingReply(reviewId: string, threadId: string, body: string): Promise<void> {
    await this.graphql(
      `mutation($input:AddPullRequestReviewThreadReplyInput!){addPullRequestReviewThreadReply(input:$input){comment{id}}}`,
      { input: { pullRequestReviewId: reviewId, pullRequestReviewThreadId: threadId, body } },
    );
  }

  /** Discards a pending review and all its comments. */
  async deleteReview(reviewId: string): Promise<void> {
    await this.graphql(
      `mutation($input:DeletePullRequestReviewInput!){deletePullRequestReview(input:$input){clientMutationId}}`,
      { input: { pullRequestReviewId: reviewId } },
    );
  }

  /**
   * Submits the pending review, or, without one, a review with just a summary (for example an
   * approval). Returns the review's URL.
   */
  async submitReview(pr: PrInfo, pendingReviewId: string | undefined, event: ReviewEvent, body: string): Promise<string> {
    if (pendingReviewId) {
      const data: any = await this.graphql(
        `mutation($id:ID!,$event:PullRequestReviewEvent!,$body:String){submitPullRequestReview(input:{pullRequestReviewId:$id,event:$event,body:$body}){pullRequestReview{url}}}`,
        { id: pendingReviewId, event, body: body || null },
      );
      return data.submitPullRequestReview.pullRequestReview.url;
    }
    const data: any = await this.graphql(
      `mutation($pr:ID!,$sha:GitObjectID!,$event:PullRequestReviewEvent!,$body:String){addPullRequestReview(input:{pullRequestId:$pr,commitOID:$sha,event:$event,body:$body}){pullRequestReview{url}}}`,
      { pr: pr.nodeId, sha: pr.headSha, event, body: body || null },
    );
    return data.addPullRequestReview.pullRequestReview.url;
  }

  // --- Comments and threads, pending or published ---------------------------------------------

  /** Changes the text of a comment: a pending one, or a published one the viewer wrote. */
  async updateComment(commentId: string, body: string): Promise<void> {
    await this.graphql(
      `mutation($input:UpdatePullRequestReviewCommentInput!){updatePullRequestReviewComment(input:$input){pullRequestReviewComment{id}}}`,
      { input: { pullRequestReviewCommentId: commentId, body } },
    );
  }

  /** Deletes a comment: a pending one, or a published one the viewer wrote. */
  async deleteComment(commentId: string): Promise<void> {
    await this.graphql(
      `mutation($input:DeletePullRequestReviewCommentInput!){deletePullRequestReviewComment(input:$input){clientMutationId}}`,
      { input: { id: commentId } },
    );
  }

  async setResolved(threadId: string, resolved: boolean): Promise<void> {
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    const input = resolved ? 'ResolveReviewThreadInput' : 'UnresolveReviewThreadInput';
    await this.graphql(`mutation($input:${input}!){${mutation}(input:$input){thread{id isResolved}}}`, { input: { threadId } });
  }

  async react(subjectId: string, content: ReactionContent, add: boolean): Promise<void> {
    const mutation = add ? 'addReaction' : 'removeReaction';
    const input = add ? 'AddReactionInput' : 'RemoveReactionInput';
    await this.graphql(`mutation($input:${input}!){${mutation}(input:$input){reaction{content}}}`, { input: { subjectId, content } });
  }
}
