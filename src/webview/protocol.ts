// Messages and data shared by the extension host and the visual review page.
import type { ReactionContent } from '../core/reactions.ts';
import type { CommentFilter } from '../core/commentFilter.ts';
import type { Finding } from '../core/checks.ts';
import type { PrCommit, RangeChoice } from '../core/range.ts';

export type { Finding, PrCommit, RangeChoice };

export type Side = 'LEFT' | 'RIGHT';

export interface ViewModel {
  pr: { number: number; title: string; url: string };
  path: string;
  /** A notebook, or any other changed file shown as one cell. */
  kind: 'notebook' | 'file';
  /** For files: the language they are highlighted in (`markdown` ones are rendered). */
  language?: string;
  /** An image file: its one cell has the old and new pictures as outputs, and no lines. */
  image?: boolean;
  /** Why the file isn't shown (binary, too large), instead of its cells. */
  notice?: string;
  /**
   * Set when the page compares something other than the whole pull request: the changes since
   * the viewer's last review, or in some of its commits. The old side then isn't part of the pull
   * request, so it takes no comments; when the new side isn't the latest version either
   * (`readOnly`), nothing does.
   */
  range?: { describe: string; readOnly: boolean };
  /** Cells whose only change is their outputs or whitespace show as unchanged. */
  hideNoise: boolean;
  /** Cells whose only changes are noise; of those, ones with changed outputs, and ones whose source changed only in whitespace. */
  noise: { cells: number; outputs: number; whitespace: number };
  /** GitHub's counts for the .ipynb file, JSON lines included; `stats` counts source lines. */
  fileStats: { additions: number; deletions: number };
  stats: { additions: number; deletions: number; modified: number; added: number; removed: number; moved: number };
  cells: CellVM[];
  /** Hygiene checks on what the pull request adds to this file: keys, local paths, run order, outputs. */
  findings?: Finding[];
}

export interface CellVM {
  /** Stable key for the pair (head id, or base id for removed cells). */
  key: string;
  status: 'unchanged' | 'modified' | 'added' | 'removed';
  /** Shown as unchanged because only this changed, and noise is hidden. */
  noiseHidden?: 'outputs' | 'whitespace' | 'outputs and whitespace';
  moved: boolean;
  sourceChanged: boolean;
  outputsChanged: boolean;
  type: 'code' | 'markdown' | 'raw';
  baseId?: string;
  headId?: string;
  /** 1-based cell numbers in each version. */
  baseNumber?: number;
  headNumber?: number;
  /** Syntax-highlighted lines (HTML) of each version. */
  baseLines: string[];
  headLines: string[];
  /** Raw source lines, for suggestions. */
  baseSource: string[];
  headSource: string[];
  /**
   * The old source is the same as the new one, so baseLines, baseSource and baseHtml are left
   * empty and the head versions stand for both (most cells don't change).
   */
  baseSameAsHead?: boolean;
  ops: ({ op: 'same'; b: number; h: number } | { op: 'del'; b: number } | { op: 'add'; h: number })[];
  /** Rendered markdown (HTML with data-src="start-end" on blocks). */
  baseHtml?: string;
  headHtml?: string;
  baseOutputs: OutputVM[];
  headOutputs: OutputVM[];
  /** Short summary for collapsed cells. */
  title: string;
}

export interface OutputVM {
  index: number;
  /** Content hash: the same output in both versions has the same one. */
  hash: string;
  kind: 'stream' | 'text' | 'image' | 'error' | 'other';
  label: string;
  text?: string;
  imageSrc?: string;
  html?: string;
}

export interface Anchor {
  side: Side;
  cellId: string;
  kind: 'source' | 'cell' | 'output';
  start?: number;
  end?: number;
  outputIndex?: number;
}

export interface CommentVM {
  /** GitHub id. */
  id: string;
  author: string;
  avatarUrl?: string;
  html: string;
  createdAt?: string;
  url?: string;
  pending: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** The viewer's own text (without the cell header), for editing. */
  text?: string;
  /** Reactions given so far; undefined on pending comments, which GitHub doesn't take reactions on. */
  reactions?: ReactionVM[];
}

export interface ReactionVM {
  content: ReactionContent;
  count: number;
  mine: boolean;
}

export interface ThreadVM {
  /** GitHub thread id, or the draft key for a new pending thread. */
  id: string;
  anchor: Anchor;
  label: string;
  resolved: boolean;
  outdated: boolean;
  draft: boolean;
  canReply: boolean;
  canResolve: boolean;
  canUnresolve: boolean;
  comments: CommentVM[];
}

/** One of the viewer's pending comments, for the list in the Submit review box. */
export interface PendingVM {
  id: string;
  path: string;
  /** "Cell 4, line 2", "lines 12–14" or "whole file". */
  where: string;
  reply: boolean;
  /** The comment rendered as Markdown, code highlighted. */
  html: string;
}

export interface PanelState {
  viewed: boolean;
  /** Comments in the pending review on GitHub, on any file. */
  pending: number;
  /** The same comments, in the Review panel's order of files. */
  pendingList: PendingVM[];
  /** The viewer has a pending review; GitHub doesn't take single comments next to one. */
  pendingReview: boolean;
  /** Which threads are shown; the page gets all of them and leaves the others out. */
  comments: CommentFilter;
  /** What the page compares, and the choices of the range picker; undefined when there is nothing to pick. */
  range?: RangeState;
  /**
   * The open workspace folder clones the pull request's repository: code navigation works, on
   * that checkout. `atHead` says it is at the pull request's latest commit.
   */
  local?: { branch?: string; atHead: boolean };
  /** The label of the Back button, after go to definition moved within the review pages. */
  back?: string;
}

/** A line of the page for code navigation: its text, and its notebook cell (id and whole source). */
export interface NavLine {
  cell?: { id: string; source: string };
  /** The side of the line: the old version (`LEFT`) or the new one. */
  side?: Side;
  line: number;
  text: string;
}

/**
 * A place on a review page that go to definition shows: a line of a cell (`file` for a file that
 * isn't a notebook) on one side, and the name on it from `col`, `length` characters long.
 */
export interface PageSpot {
  side: Side;
  cellId: string;
  line: number;
  col?: number;
  length?: number;
}

export interface RangeState {
  choice: RangeChoice;
  /** For the picker's button: "All changes", "Since your review", "Commit abc1234", "3 commits". */
  label: string;
  /** Not picked: the default, which follows the file (since the last review if it changed after it). */
  auto: boolean;
  readOnly: boolean;
  /**
   * The viewer's last review, for "Since your review". `problem` says why this file has nothing
   * to show since then; `blocked`, that it can't be picked at all (its commit is gone).
   */
  review?: { label: string; sha: string; problem?: string; blocked?: boolean };
  /** How many commits the pull request has. */
  commits: number;
  /** The latest commit: when it changes, the page's list of commits is out of date. */
  head: string;
}

/** A commit in the picker; `touches` says whether it changed the page's file (undefined: unknown). */
export interface CommitVM extends PrCommit {
  touches?: boolean;
}

export type HostMessage =
  | { type: 'model'; model: ViewModel }
  | { type: 'threads'; threads: ThreadVM[] }
  | { type: 'state'; state: PanelState }
  | { type: 'plan'; requestId: number; describe: string }
  | { type: 'reveal'; cellKey: string }
  /** Show a line, unfolded, and mark the name on it: a definition, or where Back returns to. */
  | { type: 'goTo'; spot: PageSpot }
  /** Scroll to a conversation, unfolded, and flash it: where "Your pending comments" leads. */
  | { type: 'revealThread'; threadId: string }
  | { type: 'commits'; head: string; commits: CommitVM[]; error?: string }
  /** A short note, such as where a definition came from. */
  | { type: 'toast'; message: string }
  | { type: 'error'; message: string }
  | { type: 'submitted'; ok: boolean; url?: string; message?: string };

export type WebviewMessage =
  | { type: 'ready' }
  /** `single` posts to GitHub straight away; `review` adds a pending comment to the review. */
  | { type: 'addComment'; anchor: Anchor; text: string; requestId: number; mode: 'review' | 'single' }
  | { type: 'reply'; threadId: string; text: string; requestId: number; mode: 'review' | 'single' }
  | { type: 'editComment'; id: string; text: string }
  | { type: 'deleteComment'; id: string }
  | { type: 'resolve'; threadId: string; resolved: boolean }
  | { type: 'react'; commentId: string; content: ReactionContent; add: boolean }
  | { type: 'setRange'; choice: RangeChoice }
  | { type: 'loadCommits' }
  | { type: 'goToDefinition'; at: NavLine; name: string; column: number }
  | { type: 'openInWorkspace'; at: NavLine }
  | { type: 'back' }
  | { type: 'setHideNoise'; on: boolean }
  | { type: 'setCommentFilter'; filter: CommentFilter }
  | { type: 'discardReview' }
  | { type: 'nextFile' }
  | { type: 'plan'; anchor: Anchor; requestId: number }
  | { type: 'submitReview'; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body: string }
  | { type: 'setViewed'; viewed: boolean }
  | { type: 'openTextDiff'; cellId?: string; side?: Side }
  | { type: 'openOverview' }
  /** Jump to one of the viewer's pending comments, on this file or another. */
  | { type: 'goToPendingComment'; id: string }
  | { type: 'openExternal'; url: string }
  /** Copies the pull request's GitHub link to the clipboard. */
  | { type: 'copyLink'; url: string };
