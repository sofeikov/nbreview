// End-to-end check against real GitHub of what can't be faked convincingly: published comments
// edited and deleted, reactions, resolving threads, and "since your last review".
//
//   npm run e2e -- --repo owner/name [--keep]
//
// It makes a throwaway branch and a draft pull request in that repository (changing the demo
// notebook in docs/demo/ and adding a file), comments, reacts, resolves and reviews there through
// the extension's own session and state code, then closes the pull request and deletes the
// branch. The comments stay on the closed pull request, visible to anyone who can see the
// repository: use a repository where that is fine. The token comes from GH_TOKEN or `gh auth token`.
// --keep leaves the pull request open, to look at in VS Code; close it and delete its branch after.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { GitHub } from '../src/github.ts';
import { ReviewSession } from '../src/session.ts';
import { ReviewState } from '../src/state.ts';
import { docLineForSource } from '../src/core/reviewDoc.ts';
import { parseBody } from '../src/core/anchor.ts';
import { buildViewModel } from '../src/viewModel.ts';

const argv = process.argv.slice(2);
const repoArg = argv[argv.indexOf('--repo') + 1];
if (!argv.includes('--repo') || !repoArg?.includes('/')) {
  console.error('usage: npm run e2e -- --repo owner/name   (makes visible comments on a draft pull request there)');
  process.exit(1);
}
const [owner, repo] = repoArg.split('/');
const keep = argv.includes('--keep');
const token = process.env.GH_TOKEN ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const gh = new GitHub(token);
const NOTEBOOK = 'docs/demo/xg_model.base.ipynb';
const NOTES = 'e2e/notes.md';
const log = (...a: unknown[]) => console.log('•', ...a);

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'nbreview-e2e' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? undefined : res.json();
}

/** Commits files on top of a commit and moves the branch there. */
async function commit(branch: string, parent: string, message: string, files: Record<string, string>): Promise<string> {
  const { tree } = await api('GET', `/git/commits/${parent}`);
  const entries = await Promise.all(Object.entries(files).map(async ([path, content]) => {
    const blob = await api('POST', '/git/blobs', { content, encoding: 'utf-8' });
    return { path, mode: '100644', type: 'blob', sha: blob.sha };
  }));
  const newTree = await api('POST', '/git/trees', { base_tree: tree.sha, tree: entries });
  const c = await api('POST', '/git/commits', { message, tree: newTree.sha, parents: [parent] });
  await api('PATCH', `/git/refs/heads/${branch}`, { sha: c.sha, force: false });
  return c.sha;
}

/** GitHub takes a moment to show some changes; tries again for up to 20 s. */
async function eventually<T>(what: string, fn: () => Promise<T | undefined | false>): Promise<T> {
  for (let i = 0; i < 20; i++) {
    const v = await fn();
    if (v) {
      return v;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const branch = `nbreview-e2e-${Date.now()}`;
const main = await api('GET', '/git/ref/heads/main');
await api('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: main.object.sha });
log(`branch ${branch}`);
let prNumber: number | undefined;
let failed = false;
try {
  // Commit 1: the demo notebook's change, and a new ordinary file.
  const head = readFileSync('docs/demo/xg_model.head.ipynb', 'utf8');
  const first = await commit(branch, main.object.sha, 'nbreview e2e: change the demo notebook', {
    [NOTEBOOK]: head,
    [NOTES]: '# Notes\n\nA file for the end-to-end test of Notebook Review.\n',
  });
  const pr = await api('POST', '/pulls', {
    title: 'nbreview end-to-end test (closed automatically)',
    head: branch,
    base: 'main',
    draft: true,
    body: 'Opened by `npm run e2e` to test Notebook Review against GitHub. It is closed and its branch deleted when the test ends.',
  });
  prNumber = pr.number;
  log(`draft pull request #${pr.number}: ${pr.html_url}`);

  const state = new ReviewState({} as never);
  const load = async () => {
    state.setSession(await ReviewSession.load(gh, owner, repo, pr.number));
    return state.session!;
  };
  let s = await eventually('the pull request files', async () => {
    const x = await load();
    return x.notebooks.has(NOTEBOOK) && x;
  });
  assert.equal(s.lastReview, undefined, 'no review yet');

  // A single comment on an added line of the notebook, then edited: the cell header and marker stay.
  const nb = s.notebooks.get(NOTEBOOK)!;
  const load_ = nb.head.notebook.cells.find(c => c.id === 'load')!;
  const docLine = docLineForSource(nb.head, 'load', load_.source.findIndex(l => l.includes('"header"')))!;
  await state.postSingle({ nbPath: NOTEBOOK, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, text: 'e2e: first wording' });
  const find = () => state.session!.placed.find(p => p.gh.comments.some(c => c.body.includes('e2e: ')));
  let thread = find()!;
  assert.ok(thread, 'the comment is on the notebook');
  assert.equal(thread.docLine, docLine);
  const first_ = thread.gh.comments[0];
  assert.equal(first_.viewerCanUpdate, true);
  assert.equal(thread.gh.viewerCanResolve, true);
  assert.equal(parseBody(first_.body).marker?.cell, 'load');
  await state.editComment(first_.id, 'e2e: better wording\n```suggestion\nshots["header"] = shots["body_part"].eq("head").astype(int)\n```');
  thread = find()!;
  const edited = thread.gh.comments[0];
  assert.equal(parseBody(edited.body).marker?.cell, 'load', 'the edit keeps the marker');
  assert.match(edited.body, /e2e: better wording/);
  assert.match(edited.body, /```suggestion\n {4}"shots\[\\"header\\"\]/, 'the suggestion is written as a notebook JSON line');
  assert.equal(thread.docLine, docLine, 'still on its line');
  log('published comment edited; marker kept, suggestion re-encoded, still on its line');

  // Reactions.
  await state.react(edited.id, 'ROCKET', true);
  let reactions = find()!.gh.comments[0].reactions;
  assert.deepEqual(reactions, [{ content: 'ROCKET', count: 1, viewerHasReacted: true }]);
  await state.react(edited.id, 'ROCKET', false);
  reactions = find()!.gh.comments[0].reactions;
  assert.deepEqual(reactions, []);
  log('reaction added and removed');

  // Resolve and unresolve.
  await state.setResolved(thread.gh.id, true);
  assert.equal(find()!.gh.isResolved, true);
  assert.equal(find()!.gh.viewerCanUnresolve, true);
  await state.setResolved(thread.gh.id, false);
  assert.equal(find()!.gh.isResolved, false);
  log('thread resolved and unresolved');

  // A published reply, deleted.
  await state.postSingle({ nbPath: NOTEBOOK, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, text: 'e2e: a reply', replyTo: thread.gh.id });
  const reply = find()!.gh.comments.find(c => c.body === 'e2e: a reply')!;
  assert.ok(reply);
  await state.deleteComment(reply.id);
  assert.equal(find()!.gh.comments.length, 1, 'the reply is gone');
  log('published reply deleted');

  // A comment on the ordinary file: edited, then deleted.
  await state.postSingle({ path: NOTES, side: 'RIGHT', startLine: 3, endLine: 3, text: 'e2e: on the notes' });
  const fileThread = () => state.session!.fileThreads.get(NOTES)?.[0];
  const note = fileThread()!.gh.comments[0];
  await state.editComment(note.id, 'e2e: on the notes, edited');
  assert.equal(fileThread()!.gh.comments[0].body, 'e2e: on the notes, edited', 'an ordinary file comment is only text');
  await state.deleteComment(note.id);
  assert.equal(fileThread(), undefined);
  log('file comment edited and deleted');

  // A review, then a new commit: what changed since.
  await gh.setViewed(s.pr.nodeId, NOTEBOOK, true);
  await gh.setViewed(s.pr.nodeId, NOTES, true);
  await gh.submitReview(s.pr, undefined, 'COMMENT', 'e2e: reviewed');
  s = await eventually('the review', async () => {
    const x = await load();
    return x.lastReview?.sha === first && x;
  });
  assert.equal(s.changedSinceReview?.size, 0, 'nothing changed since the review yet');
  const second = JSON.parse(head);
  const fit = second.cells.find((c: any) => c.id === 'fit');
  fit.source[0] = fit.source[0].replace('C=0.5', 'C=1.0');
  await commit(branch, first, 'nbreview e2e: change one cell after the review', { [NOTEBOOK]: JSON.stringify(second, null, 1) + '\n' });
  s = await eventually('the new commit', async () => {
    const x = await load();
    return x.pr.headSha !== first && x;
  });
  assert.equal(s.lastReview?.sha, first);
  assert.deepEqual([...(s.changedSinceReview ?? [])], [NOTEBOOK], 'only the notebook changed since the review');
  assert.equal(s.changedSince(NOTES), false);
  assert.ok(s.viewedDismissed.has(NOTEBOOK), 'GitHub unchecked the changed notebook');
  assert.equal(s.viewed.get(NOTES), true, 'the unchanged file is still viewed');
  const since = await s.sinceReviewDoc(NOTEBOOK)!;
  const vm = buildViewModel(s.notebooks.get(NOTEBOOK)!, { number: pr.number, title: '', url: '' }, { base: since, label: 'your review' });
  assert.deepEqual(vm.cells.filter(c => c.status !== 'unchanged').map(c => c.key), ['fit'], 'since the review, only the fit cell changed');
  assert.deepEqual([vm.stats.additions, vm.stats.deletions], [1, 1]);
  log('since the review: only the notebook, only its fit cell; the notebook is no longer marked viewed');
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  if (keep && !failed) {
    log(`kept #${prNumber} and ${branch} open; close and delete them when done`);
  } else {
    await cleanUp();
  }
}
console.log(failed ? 'E2E FAILED' : 'E2E OK');
process.exit(failed ? 1 : 0);

async function cleanUp(): Promise<void> {
  if (prNumber) {
    await api('PATCH', `/pulls/${prNumber}`, { state: 'closed' }).catch(e => console.error('closing the pull request:', e.message));
  }
  await api('DELETE', `/git/refs/heads/${branch}`).catch(e => console.error('deleting the branch:', e.message));
  log(`closed #${prNumber ?? '?'} and deleted ${branch}`);
}
