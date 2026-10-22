import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, type PrInfo } from '../src/github.ts';

const pr: PrInfo = {
  owner: 'o', repo: 'r', number: 1, nodeId: 'PR_1', title: 't', url: 'u', author: 'a',
  baseRef: 'main', headRef: 'feat', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40),
};

test('submitReview opens a pending review, adds line, file and reply threads, then submits', async () => {
  const calls: { query: string; variables: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query, variables });
    const data = query.includes('reviews(states:PENDING')
      ? { node: { reviews: { nodes: [] } } }
      : query.includes('addPullRequestReview(')
        ? { addPullRequestReview: { pullRequestReview: { id: 'PRR_1' } } }
        : query.includes('submitPullRequestReview')
          ? { submitPullRequestReview: { pullRequestReview: { url: 'https://github.com/o/r/pull/1#pullrequestreview-1' } } }
          : {};
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  try {
    const posted: string[] = [];
    const url = await new GitHub('t').submitReview({
      pr,
      event: 'COMMENT',
      body: 'Looks good',
      threads: [
        { key: 'a', path: 'nbs/x.ipynb', body: 'line', side: 'RIGHT', subjectType: 'LINE', line: 20, startLine: 18 },
        { key: 'b', path: 'nbs/x.ipynb', body: 'file', side: 'RIGHT', subjectType: 'FILE' },
      ],
      replies: [{ key: 'c', threadId: 'PRRT_9', body: 'reply' }],
      onPosted: k => posted.push(k),
    });
    assert.equal(url, 'https://github.com/o/r/pull/1#pullrequestreview-1');
    assert.deepEqual(posted, ['a', 'b', 'c']);
    assert.deepEqual(calls[1].variables, { pr: 'PR_1', sha: pr.headSha });
    assert.deepEqual(calls[2].variables.input, {
      pullRequestReviewId: 'PRR_1', path: 'nbs/x.ipynb', body: 'line', subjectType: 'LINE', line: 20, side: 'RIGHT', startLine: 18, startSide: 'RIGHT',
    });
    assert.deepEqual(calls[3].variables.input, { pullRequestReviewId: 'PRR_1', path: 'nbs/x.ipynb', body: 'file', subjectType: 'FILE' });
    assert.deepEqual(calls[4].variables.input, { pullRequestReviewId: 'PRR_1', pullRequestReviewThreadId: 'PRRT_9', body: 'reply' });
    assert.deepEqual(calls[5].variables, { id: 'PRR_1', event: 'COMMENT', body: 'Looks good' });
  } finally {
    globalThis.fetch = realFetch;
  }
});
