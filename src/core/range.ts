// Which two versions of a pull request the review page compares: all its changes, the changes
// since the viewer's last review, or the changes in some of its commits (one, or a run of them),
// as in the commit picker on github.com.

export type RangeChoice =
  | { kind: 'all' }
  | { kind: 'since' }
  /** Commits `first` to `last` (oldest to newest, both included). */
  | { kind: 'commits'; first: string; last: string };

export interface PrCommit {
  sha: string;
  /** The first parent: the version before this commit. */
  parent?: string;
  headline: string;
  author: string;
  /** ISO date the commit was made. */
  date: string;
}

export interface ResolvedRange {
  choice: RangeChoice;
  /** The commit of the old side; undefined for the pull request's base. */
  from?: string;
  /** The commit of the new side; undefined for the pull request's head. */
  to?: string;
  /** For the toolbar button: "All changes", "Since your review", "Commit abc1234", "3 commits". */
  label: string;
  /** For the summary, after what changed: "since your review on 22 Oct (abc1234)", "in abc1234". */
  describe: string;
  /**
   * The new side isn't the latest version. GitHub anchors review comments to the latest commit,
   * so nothing can be commented on, and the threads (placed on the latest version) aren't shown.
   */
  readOnly: boolean;
}

export const short = (sha: string): string => sha.slice(0, 7);

/**
 * What a choice compares. `commits` is the pull request's commits, oldest first, and
 * `lastReview` the viewer's last review with a label for it ("your review on 22 Oct (abc1234)").
 * Undefined when the choice can't be made: no review, or commits that are no longer in the pull
 * request (after a force push).
 */
export function resolveRange(
  choice: RangeChoice,
  pr: { headSha: string; baseSha?: string; commits?: PrCommit[]; lastReview?: { sha: string; label: string } },
): ResolvedRange | undefined {
  if (choice.kind === 'all') {
    return { choice, label: 'All changes', describe: '', readOnly: false };
  }
  if (choice.kind === 'since') {
    const last = pr.lastReview;
    if (!last) {
      return undefined;
    }
    return { choice, from: last.sha, label: 'Since your review', describe: `since ${last.label}`, readOnly: false };
  }
  const commits = pr.commits ?? [];
  const i = commits.findIndex(c => c.sha === choice.first);
  const j = commits.findIndex(c => c.sha === choice.last);
  if (i < 0 || j < 0 || j < i) {
    return undefined;
  }
  const first = commits[i];
  const last = commits[j];
  const to = last.sha === pr.headSha ? undefined : last.sha;
  const n = j - i + 1;
  // From the first commit, the old side is usually the pull request's base itself: then it is
  // the pull request's own diff, which takes comments on both sides.
  const parent = first.parent ?? (i > 0 ? commits[i - 1].sha : undefined);
  return {
    choice,
    from: parent === pr.baseSha ? undefined : parent,
    to,
    label: n === 1 ? `Commit ${short(first.sha)}` : `${n} commits`,
    describe: n === 1 ? `in ${short(first.sha)}` : `in ${n} commits (${short(first.sha)}…${short(last.sha)})`,
    readOnly: to !== undefined,
  };
}

/**
 * The commits a click selects, as on github.com: a click picks one commit; a Shift-click extends
 * the selection from the commit picked before, in either direction.
 */
export function pickCommits(commits: PrCommit[], clicked: string, previous: RangeChoice | undefined, extend: boolean): RangeChoice {
  if (extend && previous?.kind === 'commits') {
    const index = (sha: string) => commits.findIndex(c => c.sha === sha);
    const at = index(clicked);
    const ends = [index(previous.first), index(previous.last), at].filter(n => n >= 0);
    // The anchor is the end of the old selection away from the click.
    const anchor = at < index(previous.first) ? index(previous.last) : index(previous.first);
    if (at >= 0 && anchor >= 0 && ends.length === 3) {
      const [a, b] = at < anchor ? [at, anchor] : [anchor, at];
      return { kind: 'commits', first: commits[a].sha, last: commits[b].sha };
    }
  }
  return { kind: 'commits', first: clicked, last: clicked };
}

export function sameChoice(a: RangeChoice | undefined, b: RangeChoice | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && (a.kind !== 'commits' || (b.kind === 'commits' && a.first === b.first && a.last === b.last));
}
