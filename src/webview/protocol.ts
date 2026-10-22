// Messages and data shared by the extension host and the visual review page.

export type Side = 'LEFT' | 'RIGHT';

export interface ViewModel {
  pr: { number: number; title: string; url: string };
  path: string;
  stats: { additions: number; deletions: number; modified: number; added: number; removed: number; moved: number };
  cells: CellVM[];
}

export interface CellVM {
  /** Stable key for the pair (head id, or base id for removed cells). */
  key: string;
  status: 'unchanged' | 'modified' | 'added' | 'removed';
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
  author: string;
  avatarUrl?: string;
  html: string;
  createdAt?: string;
  url?: string;
  pending: boolean;
  draftKey?: string;
  /** Raw markdown of a pending comment, for editing. */
  text?: string;
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
  comments: CommentVM[];
}

export interface PanelState {
  viewed: boolean;
  pending: number;
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
  | { type: 'addComment'; anchor: Anchor; text: string; requestId: number }
  | { type: 'reply'; threadId: string; text: string; requestId: number }
  | { type: 'editDraft'; key: string; text: string }
  | { type: 'deleteDraft'; key: string }
  | { type: 'plan'; anchor: Anchor; requestId: number }
  | { type: 'submitReview'; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body: string }
  | { type: 'setViewed'; viewed: boolean }
  | { type: 'openTextDiff'; cellId?: string; side?: Side }
  | { type: 'openExternal'; url: string };
