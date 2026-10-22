// Minimal GitHub client: the REST calls for PR files and contents, GraphQL for review threads
// and for posting a review (GraphQL is the only API that can add file-level threads to a review).
import type { Side } from './core/anchor.ts';

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
  body: string;
  createdAt: string;
  url: string;
  author: string;
  avatarUrl?: string;
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

  async getThreads(owner: string, repo: string, number: number): Promise<GhThread[]> {
    const threads: GhThread[] = [];
    let after: string | null = null;
    for (;;) {
      const data: any = await this.graphql(
        `query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){
          reviewThreads(first:100, after:$after){pageInfo{hasNextPage endCursor} nodes{
            id path line startLine originalLine diffSide subjectType isResolved isOutdated
            comments(first:100){nodes{id body createdAt url author{login avatarUrl} pullRequestReview{state}}}}}}}}`,
        { o: owner, r: repo, n: number, after },
      );
      const page = data.repository.pullRequest.reviewThreads;
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
          comments: t.comments.nodes
            // Our own unsubmitted comments from github.com are not shown; they'd confuse the drafts.
            .filter((c: any) => c.pullRequestReview?.state !== 'PENDING')
            .map((c: any) => ({
              id: c.id,
              body: c.body,
              createdAt: c.createdAt,
              url: c.url,
              author: c.author?.login ?? 'ghost',
              avatarUrl: c.author?.avatarUrl,
            })),
        });
      }
      if (!page.pageInfo.hasNextPage) {
        break;
      }
      after = page.pageInfo.endCursor;
    }
    return threads.filter(t => t.comments.length > 0);
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

  /** GitHub's per-file "Viewed" checkboxes for the signed-in user. */
  async getViewed(owner: string, repo: string, number: number): Promise<Map<string, boolean>> {
    const viewed = new Map<string, boolean>();
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
      }
      if (!page.pageInfo.hasNextPage) {
        break;
      }
      after = page.pageInfo.endCursor;
    }
    return viewed;
  }

  async setViewed(prNodeId: string, path: string, viewed: boolean): Promise<void> {
    const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
    const input = viewed ? 'MarkFileAsViewedInput' : 'UnmarkFileAsViewedInput';
    await this.graphql(`mutation($input:${input}!){${mutation}(input:$input){clientMutationId}}`, {
      input: { pullRequestId: prNodeId, path },
    });
  }

  /**
   * Posts a whole review: opens (or reuses) the viewer's pending review, adds every new thread
   * and reply, then submits it. `onPosted` is called after each item so callers can drop drafts
   * that made it, and a retry after a failure doesn't post them twice.
   */
  async submitReview(args: {
    pr: PrInfo;
    event: ReviewEvent;
    body: string;
    threads: (NewThread & { key: string })[];
    replies: { key: string; threadId: string; body: string }[];
    onPosted: (key: string) => void;
  }): Promise<string> {
    const { pr } = args;
    const existing: any = await this.graphql(
      `query($id:ID!){node(id:$id){... on PullRequest{reviews(states:PENDING,first:20){nodes{id viewerDidAuthor}}}}}`,
      { id: pr.nodeId },
    );
    let reviewId: string | undefined = existing.node.reviews.nodes.find((r: any) => r.viewerDidAuthor)?.id;
    if (!reviewId) {
      const created: any = await this.graphql(
        `mutation($pr:ID!,$sha:GitObjectID!){addPullRequestReview(input:{pullRequestId:$pr,commitOID:$sha}){pullRequestReview{id}}}`,
        { pr: pr.nodeId, sha: pr.headSha },
      );
      reviewId = created.addPullRequestReview.pullRequestReview.id as string;
    }
    for (const t of args.threads) {
      await this.graphql(
        `mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){thread{id}}}`,
        {
          input: {
            pullRequestReviewId: reviewId,
            path: t.path,
            body: t.body,
            subjectType: t.subjectType,
            ...(t.subjectType === 'LINE'
              ? { line: t.line, side: t.side, ...(t.startLine ? { startLine: t.startLine, startSide: t.side } : {}) }
              : {}),
          },
        },
      );
      args.onPosted(t.key);
    }
    for (const r of args.replies) {
      await this.graphql(
        `mutation($input:AddPullRequestReviewThreadReplyInput!){addPullRequestReviewThreadReply(input:$input){comment{id}}}`,
        { input: { pullRequestReviewId: reviewId, pullRequestReviewThreadId: r.threadId, body: r.body } },
      );
      args.onPosted(r.key);
    }
    const submitted: any = await this.graphql(
      `mutation($id:ID!,$event:PullRequestReviewEvent!,$body:String){submitPullRequestReview(input:{pullRequestReviewId:$id,event:$event,body:$body}){pullRequestReview{url}}}`,
      { id: reviewId, event: args.event, body: args.body || null },
    );
    return submitted.submitPullRequestReview.pullRequestReview.url;
  }
}
