import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, type PrInfo } from '../src/github.ts';

const pr: PrInfo = {
  owner: 'o', repo: 'r', number: 1, nodeId: 'PR_1', title: 't', url: 'u', author: 'a',
  baseRef: 'main', headRef: 'feat', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40),
};

/** Replaces fetch with a fake GitHub GraphQL endpoint that records the calls. */
function fakeGraphql(answer: (query: string) => unknown) {
  const calls: { query: string; variables: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query, variables });
    return new Response(JSON.stringify({ data: answer(query) }), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

test('pending review: start it, add threads and replies, edit, delete, discard', async () => {
  const fake = fakeGraphql(q => (q.includes('addPullRequestReview(') ? { addPullRequestReview: { pullRequestReview: { id: 'PRR_1' } } } : {}));
  try {
    const gh = new GitHub('t');
    assert.equal(await gh.startPendingReview(pr), 'PRR_1');
    await gh.addPendingThread('PRR_1', { path: 'nbs/x.ipynb', body: 'line', side: 'RIGHT', subjectType: 'LINE', line: 20, startLine: 18 });
    await gh.addPendingThread('PRR_1', { path: 'nbs/x.ipynb', body: 'file', side: 'RIGHT', subjectType: 'FILE' });
    await gh.addPendingReply('PRR_1', 'PRRT_9', 'reply');
    await gh.updateComment('PRRC_5', 'edited');
    await gh.deleteComment('PRRC_5');
    await gh.deleteReview('PRR_1');
    const v = fake.calls.map(c => c.variables);
    assert.deepEqual(v[0], { pr: 'PR_1', sha: pr.headSha });
    assert.deepEqual(v[1].input, { pullRequestReviewId: 'PRR_1', path: 'nbs/x.ipynb', body: 'line', subjectType: 'LINE', line: 20, side: 'RIGHT', startLine: 18, startSide: 'RIGHT' });
    assert.deepEqual(v[2].input, { pullRequestReviewId: 'PRR_1', path: 'nbs/x.ipynb', body: 'file', subjectType: 'FILE' });
    assert.deepEqual(v[3].input, { pullRequestReviewId: 'PRR_1', pullRequestReviewThreadId: 'PRRT_9', body: 'reply' });
    assert.deepEqual(v[4].input, { pullRequestReviewCommentId: 'PRRC_5', body: 'edited' });
    assert.match(fake.calls[4].query, /updatePullRequestReviewComment/);
    assert.deepEqual(v[5].input, { id: 'PRRC_5' });
    assert.match(fake.calls[5].query, /deletePullRequestReviewComment/);
    assert.deepEqual(v[6].input, { pullRequestReviewId: 'PRR_1' });
    assert.match(fake.calls[6].query, /deletePullRequestReview\(/);
  } finally {
    fake.restore();
  }
});

test('submitting: the pending review if there is one, otherwise a review with just a summary', async () => {
  const fake = fakeGraphql(q =>
    q.includes('submitPullRequestReview')
      ? { submitPullRequestReview: { pullRequestReview: { url: 'https://github.com/r/1' } } }
      : { addPullRequestReview: { pullRequestReview: { url: 'https://github.com/r/2' } } },
  );
  try {
    const gh = new GitHub('t');
    assert.equal(await gh.submitReview(pr, 'PRR_1', 'COMMENT', 'Looks good'), 'https://github.com/r/1');
    assert.deepEqual(fake.calls[0].variables, { id: 'PRR_1', event: 'COMMENT', body: 'Looks good' });
    assert.equal(await gh.submitReview(pr, undefined, 'APPROVE', ''), 'https://github.com/r/2');
    assert.deepEqual(fake.calls[1].variables, { pr: 'PR_1', sha: pr.headSha, event: 'APPROVE', body: null });
  } finally {
    fake.restore();
  }
});

test('threads include the viewer\'s pending comments and the pending review id', async () => {
  const fake = fakeGraphql(() => ({
    repository: { pullRequest: {
      reviews: { nodes: [{ id: 'PRR_other', viewerDidAuthor: false }, { id: 'PRR_mine', viewerDidAuthor: true }] },
      reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
        id: 'T1', path: 'a.ipynb', line: 3, startLine: null, originalLine: 3, diffSide: 'RIGHT', subjectType: 'LINE', isResolved: false, isOutdated: false,
        viewerCanResolve: true, viewerCanUnresolve: false,
        comments: { nodes: [
          {
            id: 'C1', databaseId: 1, body: 'published', createdAt: 'x', url: 'u', author: { login: 'maria' }, pullRequestReview: { state: 'COMMENTED' },
            viewerCanUpdate: false, viewerCanDelete: false,
            reactionGroups: [
              { content: 'THUMBS_UP', viewerHasReacted: true, reactors: { totalCount: 2 } },
              { content: 'HEART', viewerHasReacted: false, reactors: { totalCount: 0 } },
              { content: 'ROCKET', viewerHasReacted: false, reactors: { totalCount: 1 } },
            ],
          },
          { id: 'C2', databaseId: 2, body: 'my draft reply', createdAt: 'x', url: 'u', author: { login: 'me' }, pullRequestReview: { state: 'PENDING' } },
          { id: 'C3', databaseId: 3, body: 'left over from a discarded review', createdAt: 'x', url: 'u', author: { login: 'me' }, pullRequestReview: null },
        ] },
      }] },
    } },
  }));
  try {
    const { threads, pendingReviewId } = await new GitHub('t').getThreads('o', 'r', 1);
    assert.equal(pendingReviewId, 'PRR_mine');
    assert.deepEqual(threads[0].comments.map(c => [c.id, c.pending]), [['C1', false], ['C2', true]]);
    assert.equal(threads[0].viewerCanResolve, true);
    assert.equal(threads[0].viewerCanUnresolve, false);
    // Reactions nobody gave are left out; the viewer's own are flagged.
    assert.deepEqual(threads[0].comments[0].reactions, [
      { content: 'THUMBS_UP', count: 2, viewerHasReacted: true },
      { content: 'ROCKET', count: 1, viewerHasReacted: false },
    ]);
    assert.equal(threads[0].comments[0].viewerCanUpdate, false);
    assert.deepEqual(threads[0].comments[1].reactions, []);
  } finally {
    fake.restore();
  }
});

test('single comments post straight to the pull request, outside any review', async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return new Response('{}', { status: 201 });
  }) as typeof fetch;
  try {
    const gh = new GitHub('t');
    await gh.postSingleComment(pr, { path: 'nbs/x.ipynb', body: 'line', side: 'RIGHT', subjectType: 'LINE', line: 20 });
    await gh.postSingleComment(pr, { path: 'nbs/x.ipynb', body: 'range', side: 'LEFT', subjectType: 'LINE', line: 20, startLine: 18 });
    await gh.postSingleComment(pr, { path: 'nbs/x.ipynb', body: 'file', side: 'RIGHT', subjectType: 'FILE' });
    await gh.postSingleReply(pr, 4242, 'reply');
    assert.deepEqual(calls.map(c => [c.method, c.url]), [
      ['POST', 'https://api.github.com/repos/o/r/pulls/1/comments'],
      ['POST', 'https://api.github.com/repos/o/r/pulls/1/comments'],
      ['POST', 'https://api.github.com/repos/o/r/pulls/1/comments'],
      ['POST', 'https://api.github.com/repos/o/r/pulls/1/comments/4242/replies'],
    ]);
    assert.deepEqual(calls[0].body, { body: 'line', commit_id: pr.headSha, path: 'nbs/x.ipynb', line: 20, side: 'RIGHT' });
    assert.deepEqual(calls[1].body, { body: 'range', commit_id: pr.headSha, path: 'nbs/x.ipynb', line: 20, side: 'LEFT', start_line: 18, start_side: 'LEFT' });
    assert.deepEqual(calls[2].body, { body: 'file', commit_id: pr.headSha, path: 'nbs/x.ipynb', subject_type: 'file' });
    assert.deepEqual(calls[3].body, { body: 'reply' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a rejected single comment reports GitHub\'s reason', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'line must be part of the diff' }] }), { status: 422 })) as typeof fetch;
  try {
    await assert.rejects(
      new GitHub('t').postSingleComment(pr, { path: 'a.ipynb', body: 'x', side: 'RIGHT', subjectType: 'LINE', line: 1 }),
      /GitHub 422: Validation Failed: line must be part of the diff/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('resolving, reacting, and editing or deleting a published comment', async () => {
  const fake = fakeGraphql(() => ({}));
  try {
    const gh = new GitHub('t');
    await gh.setResolved('PRRT_1', true);
    await gh.setResolved('PRRT_1', false);
    await gh.react('PRRC_2', 'HOORAY', true);
    await gh.react('PRRC_2', 'HOORAY', false);
    await gh.updateComment('PRRC_2', 'better wording');
    await gh.deleteComment('PRRC_2');
    const [resolve, unresolve, add, remove, update, del] = fake.calls;
    assert.match(resolve.query, /resolveReviewThread\(/);
    assert.doesNotMatch(resolve.query, /unresolveReviewThread/);
    assert.match(unresolve.query, /unresolveReviewThread\(/);
    assert.deepEqual(resolve.variables.input, { threadId: 'PRRT_1' });
    assert.match(add.query, /addReaction\(/);
    assert.match(remove.query, /removeReaction\(/);
    assert.deepEqual(add.variables.input, { subjectId: 'PRRC_2', content: 'HOORAY' });
    assert.match(update.query, /updatePullRequestReviewComment/);
    assert.deepEqual(update.variables.input, { pullRequestReviewCommentId: 'PRRC_2', body: 'better wording' });
    assert.deepEqual(del.variables.input, { id: 'PRRC_2' });
  } finally {
    fake.restore();
  }
});

test('the last review is the viewer\'s latest submitted one', async () => {
  const fake = fakeGraphql(() => ({
    repository: { pullRequest: { reviews: { nodes: [
      { viewerDidAuthor: true, state: 'COMMENTED', submittedAt: '2026-10-01T10:00:00Z', commit: { oid: 'a'.repeat(40) } },
      { viewerDidAuthor: true, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-02T10:00:00Z', commit: { oid: 'b'.repeat(40) } },
      { viewerDidAuthor: false, state: 'APPROVED', submittedAt: '2026-10-03T10:00:00Z', commit: { oid: 'c'.repeat(40) } },
      { viewerDidAuthor: true, state: 'PENDING', submittedAt: null, commit: { oid: 'd'.repeat(40) } },
    ] } } },
  }));
  try {
    assert.deepEqual(await new GitHub('t').lastReview('o', 'r', 1), { sha: 'b'.repeat(40), submittedAt: '2026-10-02T10:00:00Z' });
  } finally {
    fake.restore();
  }
  const none = fakeGraphql(() => ({ repository: { pullRequest: { reviews: { nodes: [] } } } }));
  try {
    assert.equal(await new GitHub('t').lastReview('o', 'r', 1), undefined);
  } finally {
    none.restore();
  }
});

test('files changed between two commits, with renames, and no answer when GitHub can\'t compare', async () => {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  let status = 200;
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return status === 200
      ? new Response(JSON.stringify({ files: [{ filename: 'nbs/a.ipynb' }, { filename: 'new.py', previous_filename: 'old.py' }] }), { status })
      : new Response('{}', { status });
  }) as typeof fetch;
  try {
    const gh = new GitHub('t');
    assert.deepEqual(await gh.changedBetween('o', 'r', 'aaa', 'bbb'), ['nbs/a.ipynb', 'new.py', 'old.py']);
    assert.match(urls[0], /\/repos\/o\/r\/compare\/aaa\.\.\.bbb/);
    status = 404;
    assert.equal(await gh.changedBetween('o', 'r', 'gone', 'bbb'), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('viewed flags, and the files GitHub unchecked because they changed', async () => {
  const fake = fakeGraphql(() => ({
    repository: { pullRequest: { files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { path: 'a.ipynb', viewerViewedState: 'VIEWED' },
      { path: 'b.py', viewerViewedState: 'DISMISSED' },
      { path: 'c.py', viewerViewedState: 'UNVIEWED' },
    ] } } },
  }));
  try {
    const { viewed, dismissed } = await new GitHub('t').getViewed('o', 'r', 1);
    assert.deepEqual([...viewed], [['a.ipynb', true], ['b.py', false], ['c.py', false]]);
    assert.deepEqual([...dismissed], ['b.py']);
  } finally {
    fake.restore();
  }
});

test('marking many files viewed sends them as aliased mutations, 50 to a request', async () => {
  const fake = fakeGraphql(() => ({}));
  try {
    const paths = Array.from({ length: 51 }, (_, i) => `tests/t${i}.py`);
    await new GitHub('t').setViewed('PR_1', paths, true);
    assert.equal(fake.calls.length, 2);
    assert.match(fake.calls[0].query, /f49:markFileAsViewed\(input:\{pullRequestId:\$pr,path:\$p49\}\)/);
    assert.deepEqual(fake.calls[1].variables, { pr: 'PR_1', p0: 'tests/t50.py' });
    await new GitHub('t').setViewed('PR_1', ['a.py'], false);
    assert.match(fake.calls[2].query, /^mutation\(\$pr:ID!,\$p0:String!\)\{f0:unmarkFileAsViewed/);
  } finally {
    fake.restore();
  }
});
