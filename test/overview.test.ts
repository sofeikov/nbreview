import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRunState, defaultCommitMessage, defaultMergeMethod, failingText, latestChecks, mergeBlocker, mergeReviewers, mergeVerdict,
  sortChecks, statusContextState, summarizeBranch, summarizeChecks, summarizeReviews, type Check, type MergeInput, type MergeSettings,
} from '../src/core/prStatus.ts';
import { GitHub, checksFrom, timelineItem, type GhOverview, type GhTimelineItem } from '../src/github.ts';
import { renderGitHubMarkdown } from '../src/render.ts';
import { buildTimeline, duration, labelColors, mergeVM, snippetLines } from '../src/overviewModel.ts';

const check = (name: string, state: Check['state'], extra: Partial<Check> = {}): Check => ({ name, state, required: false, ...extra });

test('check states from check runs and commit statuses', () => {
  assert.equal(checkRunState('IN_PROGRESS', null), 'pending');
  assert.equal(checkRunState('QUEUED', null), 'pending');
  assert.equal(checkRunState('COMPLETED', 'SUCCESS'), 'success');
  assert.equal(checkRunState('COMPLETED', 'TIMED_OUT'), 'failure');
  assert.equal(checkRunState('COMPLETED', 'ACTION_REQUIRED'), 'failure');
  assert.equal(checkRunState('COMPLETED', 'CANCELLED'), 'cancelled');
  assert.equal(checkRunState('COMPLETED', 'SKIPPED'), 'skipped');
  assert.equal(checkRunState('COMPLETED', 'STALE'), 'neutral');
  assert.equal(statusContextState('EXPECTED'), 'pending');
  assert.equal(statusContextState('ERROR'), 'failure');
  assert.equal(statusContextState('SUCCESS'), 'success');
});

test('a re-run check counts once, at its latest run; failing and required ones sort first', () => {
  const checks = [
    check('test', 'failure', { workflow: 'CI', startedAt: '2026-11-01T10:00:00Z' }),
    check('test', 'success', { workflow: 'CI', startedAt: '2026-11-01T11:00:00Z' }),
    check('test', 'success', { workflow: 'Nightly', startedAt: '2026-11-01T09:00:00Z' }),
  ];
  const latest = latestChecks(checks);
  assert.equal(latest.length, 2);
  assert.ok(latest.every(c => c.state === 'success'));
  const sorted = sortChecks([check('a', 'success'), check('b', 'pending'), check('c', 'failure'), check('d', 'failure', { required: true })]);
  assert.deepEqual(sorted.map(c => c.name), ['d', 'c', 'b', 'a']);
});

test('checks summary: failing, running, passing, none', () => {
  const failing = summarizeChecks([check('lint', 'success'), check('test', 'failure', { required: true }), check('docs', 'cancelled')]);
  assert.equal(failing.tone, 'danger');
  assert.equal(failing.title, '2 checks were not successful');
  assert.match(failing.detail, /1 failing, 1 cancelled, 1 successful · 1 required/);
  assert.deepEqual(failing.failing.map(f => f.name), ['test', 'docs']);
  assert.equal(failingText(failing.failing), '“test” and “docs” failed, 1 of them required.');
  assert.equal(failingText([{ name: 'test', required: true }]), '“test” failed, and it is required.');
  assert.equal(failingText(['a', 'b', 'c', 'd'].map(name => ({ name, required: false }))), '“a”, “b” and 2 more failed.');
  assert.equal(summarizeChecks([check('a', 'failure')]).title, 'All checks have failed');
  assert.equal(summarizeChecks([check('a', 'success'), check('b', 'pending')]).tone, 'running');
  assert.equal(summarizeChecks([check('a', 'success'), check('b', 'skipped')]).title, 'All checks have passed');
  assert.equal(summarizeChecks([]).title, 'No checks');
});

test('reviewers: an approval outlasts a later comment, and asking again makes them "requested"', () => {
  const list = mergeReviewers(
    [{ login: 'maria', state: 'APPROVED' }, { login: 'tom', state: 'CHANGES_REQUESTED' }],
    [{ login: 'maria', state: 'COMMENTED' }, { login: 'tom', state: 'CHANGES_REQUESTED' }, { login: 'ann', state: 'COMMENTED' }],
    [{ login: 'tom', state: 'REQUESTED' }, { login: 'core', state: 'REQUESTED', team: true }],
  );
  assert.deepEqual(list.map(r => [r.login, r.state]), [['maria', 'APPROVED'], ['core', 'REQUESTED'], ['tom', 'REQUESTED'], ['ann', 'COMMENTED']]);
  const s = summarizeReviews('REVIEW_REQUIRED', list);
  assert.equal(s.title, 'Review required');
  assert.equal(s.detail, '1 approval · waiting on core, @tom');
  assert.equal(summarizeReviews('CHANGES_REQUESTED', [{ login: 'x', state: 'CHANGES_REQUESTED' }]).tone, 'danger');
  assert.equal(summarizeReviews(undefined, []).title, 'No reviews yet');
  assert.equal(summarizeReviews(undefined, [{ login: 'x', state: 'APPROVED' }]).title, 'Approved');
});

test('merge verdict: the first thing in the way, in the order a reviewer fixes them', () => {
  const ok = summarizeChecks([check('test', 'success')]);
  const base: MergeInput = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', baseRef: 'main', checks: ok };
  assert.equal(mergeVerdict(base).title, 'Ready to merge');
  assert.equal(mergeVerdict({ ...base, state: 'MERGED', mergedBy: 'maria' }).detail, '@maria merged it into main.');
  assert.equal(mergeVerdict({ ...base, state: 'CLOSED' }).title, 'Closed');
  assert.equal(mergeVerdict({ ...base, isDraft: true, mergeStateStatus: 'DRAFT' }).title, 'Still a draft');
  assert.equal(mergeVerdict({ ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'CHANGES_REQUESTED' }).title, 'Has conflicts');
  assert.equal(mergeVerdict({ ...base, reviewDecision: 'CHANGES_REQUESTED' }).title, 'Changes requested');
  const failing = summarizeChecks([check('test', 'failure', { required: true })]);
  assert.equal(mergeVerdict({ ...base, mergeStateStatus: 'BLOCKED', checks: failing }).detail, '“test” failed, and it is required.');
  assert.equal(mergeVerdict({ ...base, mergeStateStatus: 'UNSTABLE', checks: summarizeChecks([check('lint', 'failure')]) }).title, 'Ready to merge, with failing checks');
  assert.equal(mergeVerdict({ ...base, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }).title, 'Waiting for review');
  assert.equal(mergeVerdict({ ...base, mergeStateStatus: 'BLOCKED', checks: summarizeChecks([check('t', 'pending')]) }).title, 'Checks running');
  assert.equal(mergeVerdict({ ...base, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }).tone, 'running');
  assert.equal(mergeVerdict({ ...base, mergeStateStatus: 'BEHIND' }).title, 'Out of date');
  assert.equal(mergeVerdict({ ...base, mergeStateStatus: 'BLOCKED' }).title, 'Merging is blocked');
  assert.equal(summarizeBranch({ ...base, mergeStateStatus: 'DIRTY' }).tone, 'danger');
  assert.equal(summarizeBranch(base).title, 'No conflicts with the base branch');
});

test('GitHub markdown: task lists, issue and user links, emoji, but not in code or links', () => {
  const html = renderGitHubMarkdown('- [x] done\n- [ ] todo\n\nFixes #12, thanks @ann-b :tada: `#3 @x` [see #4](https://e.com) a@b.com', 'https://github.com/o/r');
  assert.match(html, /<li class="task-item"><span class="task-box done"[^>]*><\/span>done/);
  assert.match(html, /<span class="task-box" aria-label="not done"><\/span>todo/);
  assert.match(html, /<a class="ref" href="https:\/\/github.com\/o\/r\/issues\/12">#12<\/a>/);
  assert.match(html, /<a class="mention" href="https:\/\/github.com\/ann-b">@ann-b<\/a>/);
  assert.match(html, /🎉/);
  assert.match(html, /<code>#3 @x<\/code>/);
  assert.match(html, /<a href="https:\/\/e.com">see #4<\/a>/);
  assert.match(html, /a@b\.com/);
  assert.doesNotMatch(html, /mention" href="https:\/\/github.com\/b/);
  // Text is still escaped.
  assert.match(renderGitHubMarkdown('1 < 2 & #5'), /1 &lt; 2 &amp; #5/);
});

test('timeline nodes from GraphQL, and checks from the status rollup', () => {
  assert.deepEqual(timelineItem({ __typename: 'ReviewRequestedEvent', createdAt: 't', actor: { login: 'tom' }, requestedReviewer: { name: 'core' } }),
    { kind: 'event', event: 'reviewRequested', actor: { login: 'tom', avatarUrl: undefined }, createdAt: 't', subject: 'core' });
  const review = timelineItem({ __typename: 'PullRequestReview', id: 'R', state: 'APPROVED', createdAt: 'a', submittedAt: 'b', body: '', url: 'u', author: null, comments: { nodes: [{ id: 'C1' }] } });
  assert.deepEqual(review, { kind: 'review', id: 'R', author: { login: 'ghost', avatarUrl: undefined }, state: 'APPROVED', createdAt: 'b', body: '', url: 'u', reactions: [], commentIds: ['C1'] });
  assert.equal(timelineItem({ __typename: 'LabeledEvent' }), undefined);
  assert.deepEqual(timelineItem({ __typename: 'HeadRefDeletedEvent', createdAt: 't', actor: { login: 'ann' }, headRefName: 'feat' }),
    { kind: 'event', event: 'branchDeleted', actor: { login: 'ann', avatarUrl: undefined }, createdAt: 't', subject: 'feat' });
  const commit = timelineItem({ __typename: 'PullRequestCommit', url: 'u', commit: { oid: 'abc', messageHeadline: 'm', committedDate: 'd', author: { name: 'Bot Person', user: null } } });
  assert.deepEqual((commit as Extract<GhTimelineItem, { kind: 'commit' }>).author, { login: 'Bot Person' });
  const checks = checksFrom({ contexts: { nodes: [
    { __typename: 'CheckRun', name: 'test', title: null, status: 'IN_PROGRESS', conclusion: null, isRequired: true, checkSuite: { app: { name: 'GitHub Actions' }, workflowRun: { workflow: { name: 'CI' } } } },
    { __typename: 'StatusContext', context: 'ci/circle', state: 'ERROR', description: 'boom', targetUrl: 'https://x', isRequired: false },
  ] } });
  assert.deepEqual(checks.map(c => [c.name, c.workflow, c.state, c.description, c.required]), [['test', 'CI', 'pending', 'In progress', true], ['ci/circle', undefined, 'failure', 'boom', false]]);
});

test('getOverview reads every timeline page it needs and keeps the fork owner', async () => {
  const realFetch = globalThis.fetch;
  const pages: string[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    pages.push(variables.after ?? 'first');
    const timelineItems = {
      pageInfo: { hasNextPage: !variables.after, endCursor: 'c1' },
      totalCount: 2,
      nodes: [{ __typename: 'IssueComment', id: variables.after ? 'IC2' : 'IC1', createdAt: 't', body: 'hi', url: 'u', author: { login: 'ann' } }],
    };
    const pr = query.includes('viewer{login}')
      ? {
        title: 'T', url: 'U', state: 'OPEN', isDraft: false, createdAt: 'c', body: null, baseRefName: 'main', headRefName: 'feat',
        headRepositoryOwner: { login: 'fork' }, repository: { owner: { login: 'o' } }, additions: 1, deletions: 2, changedFiles: 3,
        mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, author: { login: 'ann' },
        reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', name: 'core' } }] },
        latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
        commits: { totalCount: 4, nodes: [{ commit: { statusCheckRollup: null } }] },
        timelineItems,
      }
      : { timelineItems };
    return new Response(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { pullRequest: pr } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const o = await new GitHub('t').getOverview('o', 'r', 1);
    assert.deepEqual(pages, ['first', 'c1']);
    assert.deepEqual(o.timeline.map(t => (t as { id: string }).id), ['IC1', 'IC2']);
    assert.equal(o.headOwner, 'fork');
    assert.equal(o.commits, 4);
    assert.equal(o.body, '');
    assert.deepEqual(o.reviewers, [{ login: 'core', avatarUrl: undefined, state: 'REQUESTED', team: true }]);
    assert.deepEqual(o.checks, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('conversation: pushes in a row group, threads sit under the review that started them, pending reviews are left out', () => {
  const thread = { id: 'T1', path: 'a.py', resolved: false, outdated: false, comments: [{ id: 'C1', author: { login: 'ann' }, isAuthor: false, createdAt: 't', html: 'x', reactions: [] }] };
  const gh = { comments: [{ id: 'C1' }, { id: 'C2' }] } as any;
  const threads = new Map([['C1', { gh, thread }]]);
  const commit = (oid: string): GhTimelineItem => ({ kind: 'commit', oid, message: oid, author: { login: 'tom' }, createdAt: 't', url: 'u' });
  const review = (id: string, state: any, commentIds: string[]): GhTimelineItem => ({ kind: 'review', id, author: { login: 'ann' }, state, createdAt: 't', body: '', url: 'u', reactions: [], commentIds });
  const items = buildTimeline([
    commit('a'), commit('b'),
    review('R1', 'COMMENTED', ['C1']),
    commit('c'),
    review('R2', 'COMMENTED', ['C2', 'C9']),
    review('R3', 'PENDING', ['C7']),
    { kind: 'event', event: 'merged', actor: { login: 'tom' }, createdAt: 't' },
  ], threads, { author: 'tom', repoUrl: 'https://github.com/o/r', headRef: 'feat', baseRef: 'main' });
  assert.deepEqual(items.map(i => i.kind), ['commits', 'review', 'commits', 'review', 'event']);
  assert.equal((items[0] as any).commits.length, 2);
  assert.deepEqual((items[1] as any).threads.map((t: any) => t.id), ['T1']);
  assert.equal((items[3] as any).threads.length, 0);
  assert.equal((items[3] as any).otherComments, 2);
  assert.equal((items[4] as any).text, 'merged this into main');
});

test('label colours, durations and code snippets', () => {
  assert.deepEqual(labelColors('fbca04'), { background: '#fbca04', foreground: '#1f2328' });
  assert.deepEqual(labelColors('1d76db'), { background: '#1d76db', foreground: '#ffffff' });
  assert.equal(labelColors('nope').background, 'transparent');
  assert.equal(duration(45_000), '45s');
  assert.equal(duration(192_000), '3m 12s');
  assert.equal(duration(3_840_000), '1h 4m');
  const html = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const lines = snippetLines(html, 10, 11);
  assert.deepEqual(lines.map(l => [l.number, l.marked]), [[8, false], [9, false], [10, false], [11, true], [12, true]]);
  assert.equal(snippetLines(html, 0, 19).length, 8);
  assert.ok(snippetLines(html, -1, 2).every(l => !l.marked));
  // html[0] is line `offset`.
  assert.deepEqual(snippetLines(['x', 'y'], 101, 101, 100).map(l => [l.number, l.html, l.marked]), [[101, 'x', false], [102, 'y', true]]);
});

test('merge method: the one the viewer used last, while it is still allowed', () => {
  assert.equal(defaultMergeMethod({ methods: ['MERGE', 'SQUASH'], preferred: 'SQUASH' }), 'SQUASH');
  assert.equal(defaultMergeMethod({ methods: ['MERGE', 'REBASE'], preferred: 'SQUASH' }), 'MERGE');
  assert.equal(defaultMergeMethod({ methods: [] }), undefined);
});

test('default commit messages follow the settings of the repository', () => {
  const pr = { number: 7, title: 'Add X', body: 'Why X.', head: 'ann/x', commits: [{ headline: 'a', body: '' }, { headline: 'b', body: 'more' }], commitCount: 2 };
  const s: MergeSettings = { methods: ['MERGE', 'SQUASH', 'REBASE'] };
  assert.deepEqual(defaultCommitMessage('SQUASH', { ...s, squashTitle: 'COMMIT_OR_PR_TITLE', squashMessage: 'COMMIT_MESSAGES' }, pr), { title: 'Add X (#7)', body: '* a\n\n* b\n\nmore' });
  const one = { ...pr, commits: [{ headline: 'only', body: 'detail' }], commitCount: 1 };
  assert.deepEqual(defaultCommitMessage('SQUASH', { ...s, squashTitle: 'COMMIT_OR_PR_TITLE', squashMessage: 'COMMIT_MESSAGES' }, one), { title: 'only (#7)', body: 'detail' });
  assert.deepEqual(defaultCommitMessage('SQUASH', { ...s, squashTitle: 'PR_TITLE', squashMessage: 'PR_BODY' }, one), { title: 'Add X (#7)', body: 'Why X.' });
  assert.equal(defaultCommitMessage('SQUASH', { ...s, squashMessage: 'BLANK' }, pr)!.body, '');
  assert.deepEqual(defaultCommitMessage('MERGE', { ...s, mergeTitle: 'MERGE_MESSAGE', mergeMessage: 'PR_TITLE' }, pr), { title: 'Merge pull request #7 from ann/x', body: 'Add X' });
  assert.deepEqual(defaultCommitMessage('MERGE', { ...s, mergeTitle: 'PR_TITLE', mergeMessage: 'PR_BODY' }, pr), { title: 'Add X (#7)', body: 'Why X.' });
  assert.equal(defaultCommitMessage('REBASE', s, pr), undefined);
});

test('merge blocker: the merge state from GitHub decides, and failing checks it lets through are fine', () => {
  const verdict = { tone: 'warning' as const, title: 'Merging is blocked', detail: 'A rule is not met.' };
  const open = { state: 'OPEN' as const, isDraft: false, canMerge: true };
  assert.equal(mergeBlocker({ ...open, mergeStateStatus: 'CLEAN' }, verdict), undefined);
  assert.equal(mergeBlocker({ ...open, mergeStateStatus: 'UNSTABLE' }, verdict), undefined);
  assert.equal(mergeBlocker({ ...open, mergeStateStatus: 'HAS_HOOKS' }, verdict), undefined);
  assert.equal(mergeBlocker({ ...open, mergeStateStatus: 'BLOCKED' }, verdict), 'A rule is not met.');
  assert.match(mergeBlocker({ ...open, mergeStateStatus: 'UNKNOWN' }, verdict)!, /still working out/);
  assert.match(mergeBlocker({ ...open, isDraft: true, mergeStateStatus: 'DRAFT' }, verdict)!, /draft/);
  assert.match(mergeBlocker({ ...open, canMerge: false, mergeStateStatus: 'CLEAN' }, verdict)!, /write access/);
  assert.match(mergeBlocker({ ...open, state: 'MERGED', mergeStateStatus: 'CLEAN' }, verdict)!, /already merged/);
});

test('merge box: new commits, update branch, ready for review, delete branch', () => {
  const o = {
    title: 'T', body: '', url: 'u', state: 'OPEN', isDraft: false, headRef: 'feat', baseRef: 'main', commits: 1, headSha: 'h2',
    headRefId: 'REF', canMerge: true, canPushHead: true, canUpdate: true, mergeStateStatus: 'BEHIND',
    merge: { methods: ['SQUASH', 'REBASE'], preferred: 'SQUASH' }, lastCommit: { headline: 'c', body: '' }, timeline: [],
  } as unknown as GhOverview;
  const verdict = { tone: 'warning' as const, title: 'Out of date', detail: 'behind' };
  const vm = mergeVM(o, verdict, { number: 3, owner: 'o', sessionHead: 'h1' });
  assert.equal(vm.newCommits, true);
  assert.equal(vm.canUpdateBranch, true);
  assert.equal(vm.canMarkReady, false);
  assert.equal(vm.canDeleteBranch, false);
  assert.equal(vm.blocker, 'behind');
  assert.deepEqual(vm.methods.map(m => m.method), ['SQUASH', 'REBASE']);
  assert.deepEqual(Object.keys(vm.messages), ['SQUASH']);
  assert.equal(vm.messages.SQUASH!.title, 'c (#3)');
  assert.equal(mergeVM({ ...o, isDraft: true } as GhOverview, verdict, { number: 3, owner: 'o', sessionHead: 'h2' }).canMarkReady, true);
  assert.equal(mergeVM({ ...o, isDraft: true, canUpdate: false } as GhOverview, verdict, { number: 3, owner: 'o', sessionHead: 'h2' }).canMarkReady, false);
  const merged = mergeVM({ ...o, state: 'MERGED' } as GhOverview, verdict, { number: 3, owner: 'o', sessionHead: 'h1' });
  assert.equal(merged.canDeleteBranch, true);
  assert.equal(merged.newCommits, false);
  assert.equal(mergeVM({ ...o, state: 'MERGED', headRefId: undefined } as GhOverview, verdict, { number: 3, owner: 'o', sessionHead: 'h1' }).canDeleteBranch, false);
});

test('merging sends the head GitHub must still be at, and only the message parts given', async () => {
  const realFetch = globalThis.fetch;
  const calls: { query: string; variables: any }[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    const gh = new GitHub('t');
    await gh.mergePullRequest('PR_1', { method: 'SQUASH', expectedHeadOid: 'abc', title: 'T' });
    await gh.mergePullRequest('PR_1', { method: 'REBASE', expectedHeadOid: 'abc' });
    await gh.markReadyForReview('PR_1');
    await gh.updateBranch('PR_1', 'abc');
    await gh.deleteBranch('REF_1');
    assert.deepEqual(calls.map(c => c.variables.input), [
      { pullRequestId: 'PR_1', mergeMethod: 'SQUASH', expectedHeadOid: 'abc', commitHeadline: 'T' },
      { pullRequestId: 'PR_1', mergeMethod: 'REBASE', expectedHeadOid: 'abc' },
      { pullRequestId: 'PR_1' },
      { pullRequestId: 'PR_1', expectedHeadOid: 'abc', updateMethod: 'MERGE' },
      { refId: 'REF_1' },
    ]);
    assert.deepEqual(calls.map(c => /mutation\(\$input:(\w+)!\)\{(\w+)/.exec(c.query)?.slice(1)), [
      ['MergePullRequestInput', 'mergePullRequest'], ['MergePullRequestInput', 'mergePullRequest'],
      ['MarkPullRequestReadyForReviewInput', 'markPullRequestReadyForReview'],
      ['UpdatePullRequestBranchInput', 'updatePullRequestBranch'], ['DeleteRefInput', 'deleteRef'],
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
