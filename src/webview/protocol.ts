// Messages and data shared by the extension host and the visual review page.
import type { ReactionContent } from '../core/reactions.ts';

export type Side = 'LEFT' | 'RIGHT';

export interface ViewModel {
  pr: { number: number; title: string; url: string };
  path: string;
  /**
   * Set when the old side is the notebook as it was at the viewer's last review rather than the
   * pull request's base. Comments can't be made on that side: it isn't part of the pull request.
   */
  since?: { label: string };
  /** Cells whose only change is their outputs or whitespace show as unchanged. */
  hideNoise: boolean;
  /** Cells whose only changes are noise; of those, ones with changed outputs, and ones whose source changed only in whitespace. */
  noise: { cells: number; outputs: number; whitespace: number };
  /** GitHub's counts for the .ipynb file, JSON lines included; `stats` counts source lines. */
  fileStats: { additions: number; deletions: number };
  stats: { additions: number; deletions: number; modified: number; added: number; removed: number; moved: number };
  cells: CellVM[];
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

export interface PanelState {
  viewed: boolean;
  /** Comments in the pending review on GitHub, on any file. */
  pending: number;
  /** The viewer has a pending review; GitHub doesn't take single comments next to one. */
  pendingReview: boolean;
  /** Comparing with the viewer's last review: possible for this notebook, and switched on. */
  since?: SinceState;
}

export interface SinceState {
  /** Whether "Since your review" can be chosen: there is a review and this notebook changed after it. */
  available: boolean;
  on: boolean;
  /** For example "your review on 22 Oct (abc1234)". */
  label: string;
  /** Why it isn't available, when there is a review. */
  problem?: string;
}

export type HostMessage =
  | { type: 'model'; model: ViewModel }
  | { type: 'threads'; threads: ThreadVM[] }
  | { type: 'state'; state: PanelState }
  | { type: 'plan'; requestId: number; describe: string }
  | { type: 'reveal'; cellKey: string }
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
  | { type: 'setSince'; on: boolean }
  | { type: 'setHideNoise'; on: boolean }
  | { type: 'discardReview' }
  | { type: 'nextFile' }
  | { type: 'plan'; anchor: Anchor; requestId: number }
  | { type: 'submitReview'; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body: string }
  | { type: 'setViewed'; viewed: boolean }
  | { type: 'openTextDiff'; cellId?: string; side?: Side }
  | { type: 'openExternal'; url: string };
