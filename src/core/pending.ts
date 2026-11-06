// The viewer's pending (unsubmitted) comments as a flat list, for finding one again: what it
// says and where it is, in words. It has no VS Code API; `ReviewState.pendingComments` fills it.
import { anchorForDocLines, type ReviewDoc } from './reviewDoc.ts';

/** One pending comment, with the file whose review page shows it. */
export interface PendingComment {
  /** GitHub id of the comment. */
  id: string;
  /** GitHub id of its thread: the page scrolls to the thread. */
  threadId: string;
  /** The notebook or file whose review page shows the comment. */
  path: string;
  /** "Cell 4, line 2", "lines 12–14" or "whole file". */
  where: string;
  /** A reply to a conversation that is already on the pull request. */
  reply: boolean;
  /** What the comment says, in one line. */
  preview: string;
  /** For a notebook's text diff: the side and 0-based line of the review document. */
  docLine?: { side: 'LEFT' | 'RIGHT'; line: number };
}

/** The comment's text as one short line: spaces collapsed, cut with an ellipsis. */
export function previewText(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) {
    return '(empty comment)';
  }
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** "line 12" or "lines 12–14", from 0-based lines. */
export function linesText(start: number, end: number): string {
  return end > start ? `lines ${start + 1}–${end + 1}` : `line ${end + 1}`;
}

/** Where a comment on lines of a notebook's review document is, as the reader counts: cell 1 is the first. */
export function notebookPlace(doc: ReviewDoc | undefined, start: number, end: number): string {
  const anchor = doc && anchorForDocLines(doc, start, end);
  const cell = anchor && doc.lines[end]?.cell;
  if (!anchor || !cell) {
    return 'notebook';
  }
  const where = `Cell ${cell.index + 1}`;
  if (anchor.kind === 'source' && anchor.start !== undefined && anchor.end !== undefined) {
    return `${where}, ${linesText(anchor.start, anchor.end)}`;
  }
  return anchor.kind === 'output' ? `${where}, output` : where;
}
