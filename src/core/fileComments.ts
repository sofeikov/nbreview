// Review comments on ordinary files (not notebooks): their lines are the file's own lines, so a
// comment lands where it was made, as a line comment when GitHub allows it, else on the file.
import type { CommentableLines } from './patch.ts';
import type { GhThreadTarget, Side } from './anchor.ts';

export interface FileThreadLocation {
  side: Side;
  /** 0-based line in that side's version of the file. */
  docLine: number;
  /** First line, for comments on several lines. */
  startDocLine?: number;
  note?: string;
}

/** Where a GitHub thread on an ordinary file goes in its diff. */
export function locateFileThread(t: {
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  diffSide: Side;
  subjectType: string;
  isOutdated: boolean;
}): FileThreadLocation {
  if (t.subjectType === 'FILE') {
    return { side: 'RIGHT', docLine: 0, note: 'file comment' };
  }
  if (t.line !== null) {
    const docLine = t.line - 1;
    const start = t.startLine !== null && t.startLine < t.line ? t.startLine - 1 : undefined;
    return { side: t.diffSide, docLine, ...(start !== undefined ? { startDocLine: start } : {}), ...(t.isOutdated ? { note: 'outdated' } : {}) };
  }
  // Outdated threads have no current line; their original one is the best guess.
  return { side: t.diffSide, docLine: Math.max(0, (t.originalLine ?? 1) - 1), note: 'outdated' };
}

/** Where a new comment on lines `startLine`–`endLine` (1-based) of an ordinary file lands. */
export function planFileComment(args: {
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  commentable: CommentableLines;
  text: string;
}): GhThreadTarget {
  const { path, side, startLine, endLine, text } = args;
  const allowed = side === 'RIGHT' ? args.commentable.right : args.commentable.left;
  if (allowed.has(endLine)) {
    let all = true;
    for (let l = startLine; l <= endLine; l++) {
      all &&= allowed.has(l);
    }
    const multi = all && startLine < endLine;
    return {
      path,
      side,
      subjectType: 'LINE',
      line: endLine,
      startLine: multi ? startLine : undefined,
      body: text,
      describe: `line comment → ${path} L${multi ? `${startLine}-` : ''}${endLine}`,
    };
  }
  return { path, side, subjectType: 'FILE', body: text, describe: `file comment on ${path} (line ${endLine} is outside the diff)` };
}
