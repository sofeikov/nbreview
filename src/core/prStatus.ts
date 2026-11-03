// Where a pull request stands: its checks, its reviews and whether it can be merged, worked out
// from what GitHub reports, in the words the Overview page shows.

export type CheckState = 'success' | 'failure' | 'pending' | 'cancelled' | 'skipped' | 'neutral';

export interface Check {
  name: string;
  /** The Actions workflow it belongs to, or the app that ran it. */
  workflow?: string;
  state: CheckState;
  /** A commit status's own text, or the check's conclusion when it has none. */
  description?: string;
  url?: string;
  required: boolean;
  startedAt?: string;
  completedAt?: string;
}

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
export type MergeStateStatus = 'BEHIND' | 'BLOCKED' | 'CLEAN' | 'DIRTY' | 'DRAFT' | 'HAS_HOOKS' | 'UNKNOWN' | 'UNSTABLE';

export interface Reviewer {
  login: string;
  avatarUrl?: string;
  /** Their latest review, or 'REQUESTED' when they have been asked and haven't answered. */
  state: ReviewState | 'REQUESTED';
  /** A team asked to review. */
  team?: boolean;
  submittedAt?: string;
}

/** A check run's state from its status and conclusion. Anything not finished is pending. */
export function checkRunState(status: string, conclusion: string | null | undefined): CheckState {
  if (status !== 'COMPLETED') {
    return 'pending';
  }
  switch (conclusion) {
    case 'SUCCESS':
      return 'success';
    case 'CANCELLED':
      return 'cancelled';
    case 'SKIPPED':
      return 'skipped';
    case 'NEUTRAL':
    case 'STALE':
      return 'neutral';
    default:
      // FAILURE, TIMED_OUT, ACTION_REQUIRED and STARTUP_FAILURE all need someone to look.
      return 'failure';
  }
}

/** A commit status's state (the older Statuses API, used by many CI services). */
export function statusContextState(state: string): CheckState {
  return state === 'SUCCESS' ? 'success' : state === 'PENDING' || state === 'EXPECTED' ? 'pending' : 'failure';
}

/**
 * The latest run of each check. A re-run adds a second check run of the same name to the
 * commit, and only the newest one counts, as on github.com.
 */
export function latestChecks(checks: Check[]): Check[] {
  const latest = new Map<string, Check>();
  for (const c of checks) {
    const key = `${c.workflow ?? ''}\u0000${c.name}`;
    const seen = latest.get(key);
    if (!seen || (c.startedAt ?? '') > (seen.startedAt ?? '')) {
      latest.set(key, c);
    }
  }
  return [...latest.values()];
}

const CHECK_ORDER: CheckState[] = ['failure', 'pending', 'cancelled', 'success', 'neutral', 'skipped'];

/** Failing checks first, then running ones, then the rest; required ones first within each. */
export function sortChecks(checks: Check[]): Check[] {
  return [...checks].sort((a, b) =>
    CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state)
    || Number(b.required) - Number(a.required)
    || (a.workflow ?? '').localeCompare(b.workflow ?? '')
    || a.name.localeCompare(b.name));
}

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'merged' | 'running';

export interface StatusLine {
  tone: Tone;
  title: string;
  detail: string;
}

export interface ChecksSummary extends StatusLine {
  counts: Record<CheckState, number>;
  /** Checks that failed or were cancelled, required ones first. */
  failing: { name: string; required: boolean }[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function summarizeChecks(checks: Check[]): ChecksSummary {
  const counts: Record<CheckState, number> = { success: 0, failure: 0, pending: 0, cancelled: 0, skipped: 0, neutral: 0 };
  for (const c of checks) {
    counts[c.state]++;
  }
  const parts = [
    counts.failure && `${counts.failure} failing`,
    counts.cancelled && `${counts.cancelled} cancelled`,
    counts.pending && `${counts.pending} in progress`,
    counts.success && `${counts.success} successful`,
    counts.skipped && `${counts.skipped} skipped`,
    counts.neutral && `${counts.neutral} neutral`,
  ].filter(Boolean);
  const detail = parts.join(', ');
  const failing = checks.filter(c => c.state === 'failure' || c.state === 'cancelled')
    .sort((a, b) => Number(b.required) - Number(a.required))
    .map(c => ({ name: c.name, required: c.required }));
  if (!checks.length) {
    return { tone: 'neutral', title: 'No checks', detail: 'Nothing runs on this pull request’s commits.', counts, failing };
  }
  const requiredFailing = checks.filter(c => c.required && (c.state === 'failure' || c.state === 'cancelled')).length;
  if (counts.failure || counts.cancelled) {
    const n = counts.failure + counts.cancelled;
    return {
      tone: 'danger',
      title: n === checks.length ? 'All checks have failed' : `${plural(n, 'check')} ${n === 1 ? 'was' : 'were'} not successful`,
      detail: requiredFailing ? `${detail} · ${requiredFailing} required` : detail,
      counts,
      failing,
    };
  }
  if (counts.pending) {
    return { tone: 'running', title: 'Some checks haven’t completed yet', detail, counts, failing };
  }
  return { tone: 'success', title: 'All checks have passed', detail, counts, failing };
}

/** For example "“test (3.11)” failed, and it is required." or "“a”, “b” and 3 more failed." */
export function failingText(failing: ChecksSummary['failing']): string {
  const names = failing.map(f => `“${f.name}”`);
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  const required = failing.filter(f => f.required).length;
  const note = !required ? '' : failing.length === 1 ? ', and it is required' : required === failing.length ? ', all required' : `, ${required} of them required`;
  return `${list} failed${note}.`;
}

/**
 * Who has reviewed and who is still asked to. A reviewer's latest review that approves or asks
 * for changes counts over a later plain comment, as in GitHub's own review summary.
 */
export function mergeReviewers(
  opinionated: Reviewer[],
  latest: Reviewer[],
  requested: Reviewer[],
): Reviewer[] {
  const byLogin = new Map<string, Reviewer>();
  for (const r of latest) {
    if (r.state !== 'PENDING') {
      byLogin.set(r.login, r);
    }
  }
  for (const r of opinionated) {
    byLogin.set(r.login, r);
  }
  // Asking someone again after their review puts them back to "requested".
  for (const r of requested) {
    byLogin.set(r.login, { ...byLogin.get(r.login), ...r, state: 'REQUESTED' });
  }
  const order: (Reviewer['state'])[] = ['CHANGES_REQUESTED', 'APPROVED', 'REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'];
  return [...byLogin.values()].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.login.localeCompare(b.login));
}

export function summarizeReviews(decision: ReviewDecision | undefined, reviewers: Reviewer[]): StatusLine {
  const n = (s: Reviewer['state']) => reviewers.filter(r => r.state === s).length;
  const approvals = n('APPROVED');
  const changes = n('CHANGES_REQUESTED');
  const waiting = reviewers.filter(r => r.state === 'REQUESTED');
  const waitingText = waiting.length
    ? `waiting on ${waiting.slice(0, 3).map(r => (r.team ? r.login : `@${r.login}`)).join(', ')}${waiting.length > 3 ? ` and ${waiting.length - 3} more` : ''}`
    : '';
  const detail = [approvals && plural(approvals, 'approval'), changes && `${plural(changes, 'reviewer')} asked for changes`, waitingText]
    .filter(Boolean)
    .join(' · ');
  if (decision === 'CHANGES_REQUESTED' || (!decision && changes)) {
    return { tone: 'danger', title: 'Changes requested', detail: detail || 'A reviewer asked for changes.' };
  }
  if (decision === 'APPROVED') {
    return { tone: 'success', title: 'Approved', detail: detail || 'The required reviews are in.' };
  }
  if (decision === 'REVIEW_REQUIRED') {
    return { tone: 'warning', title: 'Review required', detail: detail || 'At least one approving review is required to merge.' };
  }
  if (approvals) {
    return { tone: 'success', title: 'Approved', detail };
  }
  if (waiting.length) {
    return { tone: 'warning', title: 'Waiting for review', detail };
  }
  return { tone: 'neutral', title: reviewers.length ? 'Reviewed' : 'No reviews yet', detail: detail || 'Nobody is asked to review, and no review is required.' };
}

export interface MergeInput {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus?: MergeStateStatus;
  reviewDecision?: ReviewDecision;
  baseRef: string;
  checks: ChecksSummary;
  mergedBy?: string;
}

/** Whether the branch itself can go in: conflicts, being behind its base, branch protection. */
export function summarizeBranch(o: MergeInput): StatusLine {
  if (o.mergeable === 'CONFLICTING' || o.mergeStateStatus === 'DIRTY') {
    return { tone: 'danger', title: 'This branch has conflicts', detail: `Resolve the conflicts with ${o.baseRef} before it can be merged.` };
  }
  if (o.mergeable === 'UNKNOWN' || o.mergeStateStatus === 'UNKNOWN') {
    return { tone: 'running', title: 'Checking for conflicts…', detail: 'GitHub is working out whether this branch merges cleanly.' };
  }
  if (o.mergeStateStatus === 'BEHIND') {
    return { tone: 'warning', title: 'This branch is out of date', detail: `${o.baseRef} has commits this branch doesn’t have yet, and the base branch requires them.` };
  }
  return { tone: 'success', title: 'No conflicts with the base branch', detail: `It merges cleanly into ${o.baseRef}.` };
}

/**
 * The one-line answer at the top of the page: can this be merged now, and if not, the first
 * thing in the way. The order is what a reviewer would fix first.
 */
export function mergeVerdict(o: MergeInput): StatusLine {
  if (o.state === 'MERGED') {
    return { tone: 'merged', title: 'Merged', detail: `${o.mergedBy ? `@${o.mergedBy} merged it` : 'It was merged'} into ${o.baseRef}.` };
  }
  if (o.state === 'CLOSED') {
    return { tone: 'neutral', title: 'Closed', detail: 'This pull request was closed without being merged.' };
  }
  if (o.isDraft || o.mergeStateStatus === 'DRAFT') {
    return { tone: 'neutral', title: 'Still a draft', detail: 'It has to be marked ready for review before it can be merged.' };
  }
  const branch = summarizeBranch(o);
  if (branch.tone === 'danger') {
    return { tone: 'danger', title: 'Has conflicts', detail: branch.detail };
  }
  if (o.reviewDecision === 'CHANGES_REQUESTED') {
    return { tone: 'danger', title: 'Changes requested', detail: 'A reviewer asked for changes before this is merged.' };
  }
  if (o.checks.tone === 'danger' && o.mergeStateStatus !== 'UNSTABLE') {
    return { tone: 'danger', title: 'Checks failing', detail: failingText(o.checks.failing) };
  }
  if (o.reviewDecision === 'REVIEW_REQUIRED') {
    return { tone: 'warning', title: 'Waiting for review', detail: 'An approving review is required before it can be merged.' };
  }
  if (o.checks.tone === 'running') {
    return { tone: 'running', title: 'Checks running', detail: 'Some checks haven’t finished yet.' };
  }
  if (branch.tone === 'running') {
    return { tone: 'running', title: 'Checking mergeability…', detail: branch.detail };
  }
  if (o.mergeStateStatus === 'BEHIND') {
    return { tone: 'warning', title: 'Out of date', detail: branch.detail };
  }
  if (o.mergeStateStatus === 'BLOCKED') {
    return { tone: 'warning', title: 'Merging is blocked', detail: `A branch protection rule on ${o.baseRef} isn’t met yet.` };
  }
  if (o.mergeStateStatus === 'UNSTABLE' || o.checks.tone === 'danger') {
    return { tone: 'warning', title: 'Ready to merge, with failing checks', detail: 'The failing checks aren’t required, so GitHub will let it merge.' };
  }
  return { tone: 'success', title: 'Ready to merge', detail: `Every requirement is met: it can be merged into ${o.baseRef}.` };
}
