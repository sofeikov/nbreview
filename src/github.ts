// Minimal GitHub client: the REST calls for PR files and contents, GraphQL for review threads
// and for posting a review (GraphQL is the only API that can add file-level threads to a review).
import type { Side } from './core/anchor.ts';
import { REACTIONS, type ReactionContent } from './core/reactions.ts';

export type { ReactionContent };

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
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await this.request(`/repos/${owner}/${repo}/contents/${encoded}?ref=${ref}`, { accept: 'application/vnd.github.raw' });
    if (res.status === 404) {
      return undefined;
    }
    if (!res.ok) {
      throw new Error(`GitHub ${res.status} fetching ${path}@${ref.slice(0, 7)}`);
    }
    return await res.text();
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

  async setViewed(prNodeId: string, path: string, viewed: boolean): Promise<void> {
    const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
    const input = viewed ? 'MarkFileAsViewedInput' : 'UnmarkFileAsViewedInput';
    await this.graphql(`mutation($input:${input}!){${mutation}(input:$input){clientMutationId}}`, {
      input: { pullRequestId: prNodeId, path },
    });
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
