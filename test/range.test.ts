import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCommits, resolveRange, sameChoice, type PrCommit } from '../src/core/range.ts';

const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const commits: PrCommit[] = [1, 2, 3, 4].map(n => ({ sha: sha(n), parent: sha(n - 1), headline: `commit ${n}`, author: 'tom', date: '2026-11-01T10:00:00Z' }));
const pr = { headSha: sha(4), commits, lastReview: { sha: sha(2), label: 'your review on 1 Nov (2222222)' } };

test('all changes compare the pull request itself', () => {
  assert.deepEqual(resolveRange({ kind: 'all' }, pr), { choice: { kind: 'all' }, label: 'All changes', describe: '', readOnly: false });
});

test('since your review starts at the reviewed commit and ends at the latest', () => {
  const r = resolveRange({ kind: 'since' }, pr)!;
  assert.equal(r.from, sha(2));
  assert.equal(r.to, undefined);
  assert.equal(r.readOnly, false);
  assert.equal(r.describe, 'since your review on 1 Nov (2222222)');
  assert.equal(resolveRange({ kind: 'since' }, { ...pr, lastReview: undefined }), undefined);
});

test('one commit compares it with its parent; one that is not the latest is read-only', () => {
  const r = resolveRange({ kind: 'commits', first: sha(2), last: sha(2) }, pr)!;
  assert.deepEqual([r.from, r.to, r.label, r.describe, r.readOnly], [sha(1), sha(2), 'Commit 2222222', 'in 2222222', true]);
  const latest = resolveRange({ kind: 'commits', first: sha(4), last: sha(4) }, pr)!;
  assert.deepEqual([latest.from, latest.to, latest.readOnly], [sha(3), undefined, false]);
});

test('a run of commits goes from the parent of the first to the last', () => {
  const r = resolveRange({ kind: 'commits', first: sha(2), last: sha(4) }, pr)!;
  assert.deepEqual([r.from, r.to, r.label, r.describe, r.readOnly], [sha(1), undefined, '3 commits', 'in 3 commits (2222222…4444444)', false]);
});

test('commits that are gone, or a backwards range, cannot be resolved', () => {
  assert.equal(resolveRange({ kind: 'commits', first: sha(9), last: sha(9) }, pr), undefined);
  assert.equal(resolveRange({ kind: 'commits', first: sha(3), last: sha(2) }, pr), undefined);
  assert.equal(resolveRange({ kind: 'commits', first: sha(2), last: sha(2) }, { headSha: sha(4) }), undefined);
});

test('the first commit without a known parent starts at the pull request base', () => {
  const noParent = [{ ...commits[0], parent: undefined }, ...commits.slice(1)];
  assert.equal(resolveRange({ kind: 'commits', first: sha(1), last: sha(2) }, { ...pr, commits: noParent })!.from, undefined);
  // A later one without a parent starts at the commit before it.
  const gap = [commits[0], { ...commits[1], parent: undefined }, ...commits.slice(2)];
  assert.equal(resolveRange({ kind: 'commits', first: sha(2), last: sha(2) }, { ...pr, commits: gap })!.from, sha(1));
});

test('a click picks one commit; Shift-click extends from the other end, in either direction', () => {
  const one = pickCommits(commits, sha(2), { kind: 'all' }, true);
  assert.deepEqual(one, { kind: 'commits', first: sha(2), last: sha(2) });
  assert.deepEqual(pickCommits(commits, sha(4), one, true), { kind: 'commits', first: sha(2), last: sha(4) });
  assert.deepEqual(pickCommits(commits, sha(1), one, true), { kind: 'commits', first: sha(1), last: sha(2) });
  // From 2…4, Shift-clicking 1 keeps 4 as the far end.
  assert.deepEqual(pickCommits(commits, sha(1), { kind: 'commits', first: sha(2), last: sha(4) }, true), { kind: 'commits', first: sha(1), last: sha(4) });
  // Shift-clicking inside 1…4 shrinks it from the first commit.
  assert.deepEqual(pickCommits(commits, sha(3), { kind: 'commits', first: sha(1), last: sha(4) }, true), { kind: 'commits', first: sha(1), last: sha(3) });
  assert.deepEqual(pickCommits(commits, sha(3), { kind: 'commits', first: sha(1), last: sha(4) }, false), { kind: 'commits', first: sha(3), last: sha(3) });
});

test('sameChoice compares kinds and commits', () => {
  assert.ok(sameChoice({ kind: 'all' }, { kind: 'all' }));
  assert.ok(!sameChoice({ kind: 'all' }, { kind: 'since' }));
  assert.ok(sameChoice({ kind: 'commits', first: 'a', last: 'b' }, { kind: 'commits', first: 'a', last: 'b' }));
  assert.ok(!sameChoice({ kind: 'commits', first: 'a', last: 'b' }, { kind: 'commits', first: 'a', last: 'c' }));
  assert.ok(!sameChoice(undefined, { kind: 'all' }));
});

test('a range from the first commit, whose parent is the base, is the pull request\'s own diff', () => {
  const r = resolveRange({ kind: 'commits', first: sha(1), last: sha(4) }, { ...pr, baseSha: sha(0) })!;
  assert.deepEqual([r.from, r.to, r.readOnly, r.label], [undefined, undefined, false, '4 commits']);
  // The first commit alone: the base on the old side, the commit on the new side.
  const one = resolveRange({ kind: 'commits', first: sha(1), last: sha(1) }, { ...pr, baseSha: sha(0) })!;
  assert.deepEqual([one.from, one.to, one.readOnly], [undefined, sha(1), true]);
  // When the base branch moved on after the first commit, the parent is not the base.
  assert.equal(resolveRange({ kind: 'commits', first: sha(1), last: sha(1) }, { ...pr, baseSha: sha(9) })!.from, sha(0));
});
