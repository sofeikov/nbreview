// Translates between "a comment on line N of the review document" and "a GitHub review comment".
//
// Outgoing: a comment becomes a line comment on the raw .ipynb line when GitHub allows it (the
// line is in the diff), otherwise a file-level comment. Either way the body carries a readable
// header quoting the cell and a hidden marker with the cell id, so it can be put back on the right
// cell later even after lines move.
//
// Incoming: GitHub threads on the .ipynb are placed by marker or by JSON line; threads on nbdev's
// generated .py files are moved onto the notebook cell named in the `# %% <nb> #<cell>` markers.
import type { CommentableLines } from './patch.ts';
import type { LineInfo, ReviewDoc } from './reviewDoc.ts';
import { docLineForJsonLine, docLineForSource, findCell, headerLine } from './reviewDoc.ts';
import type { NbCell } from './notebook.ts';

export type Side = 'LEFT' | 'RIGHT';

export interface Marker {
  v: 1;
  cell: string;
  side: Side;
  kind: 'source' | 'cell' | 'output';
  /** 0-based source lines within the cell. */
  start?: number;
  end?: number;
}

export interface GhThreadTarget {
  path: string;
  side: Side;
  subjectType: 'LINE' | 'FILE';
  line?: number;
  startLine?: number;
  body: string;
  /** Human-readable summary of where it will land, shown on the pending comment. */
  describe: string;
}

const MARKER_RE = /<!--\s*nbreview:(\{.*?\})\s*-->/;
const HEADER_END = '<!-- /nbreview -->';

/** Plans where a new comment on doc lines [startDocLine, endDocLine] will land on GitHub. */
export function planComment(args: {
  doc: ReviewDoc;
  path: string;
  side: Side;
  startDocLine: number;
  endDocLine: number;
  commentable: CommentableLines;
  text: string;
}): GhThreadTarget {
  const { doc, path, side } = args;
  const endInfo = infoAt(doc, args.endDocLine);
  if (!endInfo) {
    return fileLevel(path, side, args.text, undefined, 'notebook');
  }
  const cell = endInfo.cell;
  // A selection that crosses cells is clamped to the cell where it ends.
  let startInfo = infoAt(doc, args.startDocLine);
  if (!startInfo || startInfo.cell !== cell) {
    startInfo = endInfo;
  }
  const allowed = side === 'RIGHT' ? args.commentable.right : args.commentable.left;

  if (endInfo.kind === 'source' && startInfo.kind === 'source') {
    const start = startInfo.sourceLine!;
    const end = endInfo.sourceLine!;
    const marker: Marker = { v: 1, cell: cell.id, side, kind: 'source', start, end };
    const jsonStart = cell.jsonLines[start];
    const jsonEnd = cell.jsonLines[end];
    const header = renderHeader(path, cell, marker);
    const lineSpan = `cell line${start === end ? ` ${start + 1}` : `s ${start + 1}–${end + 1}`}`;
    if (allowed.has(jsonEnd)) {
      const multi = jsonStart !== jsonEnd && rangeAllowed(allowed, jsonStart, jsonEnd);
      const fromJson = multi ? jsonStart : jsonEnd;
      const text = convertSuggestion(args.text, doc, cell, multi ? start : end, end, side);
      return {
        path,
        side,
        subjectType: 'LINE',
        line: jsonEnd,
        startLine: multi ? jsonStart : undefined,
        body: compose(marker, header, text),
        describe: `line comment · ${lineSpan} → ${path} L${multi ? `${fromJson}-` : ''}${jsonEnd}`,
      };
    }
    return fileLevel(path, side, args.text, marker, `${lineSpan} (outside the diff)`, header);
  }

  // Header, output and blank lines are comments on the whole cell. Anchor them to the cell's
  // first source line when GitHub allows it, so they still sit next to the cell on github.com.
  const kind: Marker['kind'] = endInfo.kind === 'output' ? 'output' : 'cell';
  const marker: Marker = { v: 1, cell: cell.id, side, kind };
  const header = renderHeader(path, cell, marker);
  const first = cell.jsonLines[0];
  if (first !== undefined && allowed.has(first)) {
    return {
      path,
      side,
      subjectType: 'LINE',
      line: first,
      body: compose(marker, header, args.text),
      describe: `${kind === 'output' ? 'output' : 'cell'} comment → ${path} L${first}`,
    };
  }
  return fileLevel(path, side, args.text, marker, kind === 'output' ? 'cell output' : 'whole cell', header);
}

function fileLevel(path: string, side: Side, text: string, marker: Marker | undefined, what: string, header = ''): GhThreadTarget {
  const body = marker ? compose(marker, header, defuseSuggestion(text)) : text;
  return { path, side, subjectType: 'FILE', body, describe: `file comment on ${path} · ${what}` };
}

function rangeAllowed(allowed: Set<number>, from: number, to: number): boolean {
  for (let l = from; l <= to; l++) {
    if (!allowed.has(l)) {
      return false;
    }
  }
  return true;
}

function infoAt(doc: ReviewDoc, line: number): LineInfo | undefined {
  return doc.lines[Math.max(0, Math.min(line, doc.lines.length - 1))];
}

function renderHeader(path: string, cell: NbCell, marker: Marker): string {
  const where =
    marker.kind === 'source'
      ? marker.start === marker.end
        ? `line ${marker.start! + 1}`
        : `lines ${marker.start! + 1}–${marker.end! + 1}`
      : marker.kind === 'output'
        ? 'output'
        : 'whole cell';
  const title = `**📓 cell ${cell.index + 1} · \`${cell.id}\` · ${cell.type} · ${where}** — \`${path}\`${marker.side === 'LEFT' ? ' (old version)' : ''}`;
  const lang = cell.type === 'code' ? 'python' : cell.type === 'markdown' ? 'markdown' : '';
  const quoted =
    marker.kind === 'source'
      ? cell.source.slice(marker.start, marker.end! + 1)
      : cell.source.slice(0, 3);
  if (!quoted.length) {
    return title;
  }
  const shown = quoted.slice(0, 6);
  const fence = ['```' + lang, ...shown, ...(quoted.length > shown.length ? ['…'] : []), '```'];
  return [title, ...fence.map(l => `> ${l}`)].join('\n');
}

function compose(marker: Marker, header: string, text: string): string {
  return `<!-- nbreview:${JSON.stringify(marker)} -->\n${header}\n${HEADER_END}\n\n${text}`;
}

export function parseBody(body: string): { marker?: Marker; text: string } {
  const m = MARKER_RE.exec(body);
  if (!m) {
    return { text: body };
  }
  let marker: Marker | undefined;
  try {
    marker = JSON.parse(m[1]);
  } catch {
    marker = undefined;
  }
  const endAt = body.indexOf(HEADER_END);
  const text = endAt >= 0 ? body.slice(endAt + HEADER_END.length).trim() : body.replace(MARKER_RE, '').trim();
  return { marker, text };
}

// --- Suggestions -----------------------------------------------------------------------------
// GitHub's "Commit suggestion" replaces raw file lines. In a notebook those are JSON strings, so a
// suggestion written as plain code is re-encoded in the notebook's own JSON layout.

const SUGGESTION_RE = /```suggestion[^\n]*\n([\s\S]*?)```/;

function convertSuggestion(text: string, doc: ReviewDoc, cell: NbCell, start: number, end: number, side: Side): string {
  const m = SUGGESTION_RE.exec(text);
  if (!m) {
    return text;
  }
  if (side !== 'RIGHT') {
    return defuseSuggestion(text);
  }
  const jsonLines = cell.jsonLines.slice(start, end + 1);
  const distinct = new Set(jsonLines);
  if (distinct.size !== jsonLines.length) {
    // The cell source is one multi-line string, so lines can't be replaced one by one.
    return defuseSuggestion(text);
  }
  const replacement = m[1].replace(/\n$/, '').split('\n');
  const isLast = end === cell.source.length - 1;
  if (m[1] === '' && isLast && start > 0) {
    // Deleting the last lines would leave a trailing comma on the line before, outside the range.
    return defuseSuggestion(text);
  }
  const sample = doc.notebook.rawLines[jsonLines[0] - 1] ?? '    ""';
  const indent = /^\s*/.exec(sample)![0];
  const encoded = m[1] === ''
    ? []
    : replacement.map((line, i) => {
        const last = isLast && i === replacement.length - 1;
        return indent + JSON.stringify(last ? line : line + '\n') + (last ? '' : ',');
      });
  return text.replace(SUGGESTION_RE, '```suggestion\n' + encoded.join('\n') + (encoded.length ? '\n' : '') + '```');
}

function defuseSuggestion(text: string): string {
  return text.replace(/```suggestion/g, '```python');
}

// --- Incoming threads ------------------------------------------------------------------------

export interface GhThreadLocation {
  side: Side;
  /** 0-based line in the review document of that side. */
  docLine: number;
  /** Set when the thread could only be placed approximately. */
  note?: string;
}

/** Places a GitHub thread on a notebook (.ipynb) path into the review documents. */
export function locateNotebookThread(
  thread: { line: number | null; startLine: number | null; originalLine: number | null; diffSide: Side; subjectType: string; isOutdated: boolean; body: string },
  docs: { base: ReviewDoc; head: ReviewDoc },
): GhThreadLocation | undefined {
  const { marker } = parseBody(thread.body);
  if (marker) {
    // Comments always live on the head side once outdated, because that's the version people review.
    const preferred = marker.side === 'LEFT' ? docs.base : docs.head;
    for (const [doc, side] of [[preferred, marker.side], [docs.head, 'RIGHT'], [docs.base, 'LEFT']] as const) {
      const cell = findCell(doc, marker.cell);
      if (!cell) {
        continue;
      }
      const line =
        marker.kind === 'source' && marker.end !== undefined && marker.end < cell.source.length
          ? docLineForSource(doc, cell.id, marker.end)
          : headerLine(doc, cell.id);
      if (line !== undefined) {
        return { side, docLine: line, note: thread.isOutdated ? 'outdated' : undefined };
      }
    }
  }
  if (thread.subjectType === 'FILE') {
    return { side: 'RIGHT', docLine: 0, note: 'file comment' };
  }
  const doc = thread.diffSide === 'LEFT' ? docs.base : docs.head;
  if (thread.line !== null) {
    const docLine = docLineForJsonLine(doc, thread.line);
    if (docLine !== undefined) {
      return { side: thread.diffSide, docLine };
    }
  }
  if (thread.originalLine !== null) {
    const docLine = docLineForJsonLine(doc, thread.originalLine);
    return { side: thread.diffSide, docLine: docLine ?? 0, note: 'outdated, position approximate' };
  }
  return { side: 'RIGHT', docLine: 0, note: 'position unknown' };
}

export interface NbdevSource {
  /** Notebook path, resolved relative to the repo root. */
  notebookPath: string;
  /** Cell id, or `index-N` when nbdev wrote a cell index instead of an id. */
  cellId: string;
  /** Lines of the cell as exported into the .py file. */
  exportedLines: string[];
  /** 0-based offset of the commented line within exportedLines. */
  offset: number;
}

/** Finds which notebook cell produced a given 1-based line of an nbdev-generated .py file. */
export function nbdevSourceForLine(pyPath: string, pyText: string, pyLine: number): NbdevSource | undefined {
  const lines = pyText.split('\n');
  let markerAt = -1;
  for (let i = Math.min(pyLine - 1, lines.length - 1); i >= 0; i--) {
    if (lines[i].startsWith('# %% ')) {
      markerAt = i;
      break;
    }
  }
  if (markerAt < 0) {
    return undefined;
  }
  // nbdev >= 2.4 writes `#<cell id>`; older versions write the cell index.
  const m = /^# %% (\S+\.ipynb) (#?)(\S+)/.exec(lines[markerAt]);
  if (!m) {
    return undefined;
  }
  let next = lines.length;
  for (let i = markerAt + 1; i < lines.length; i++) {
    if (lines[i].startsWith('# %% ')) {
      next = i;
      break;
    }
  }
  return {
    notebookPath: joinPath(dirname(pyPath), m[1]),
    cellId: m[2] ? m[3] : `index-${m[3]}`,
    exportedLines: lines.slice(markerAt + 1, next),
    offset: pyLine - 1 - (markerAt + 1),
  };
}

/** Picks the cell source line that matches the commented .py line. */
export function matchExportedLine(cell: NbCell, src: NbdevSource): number {
  const wanted = (src.exportedLines[src.offset] ?? '').trim();
  let best = -1;
  let bestDistance = Infinity;
  cell.source.forEach((line, i) => {
    if (wanted && line.trim() === wanted) {
      const d = Math.abs(i - src.offset);
      if (d < bestDistance) {
        best = i;
        bestDistance = d;
      }
    }
  });
  if (best >= 0) {
    return best;
  }
  return Math.max(0, Math.min(src.offset, cell.source.length - 1));
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function joinPath(base: string, rel: string): string {
  const parts = base ? base.split('/') : [];
  for (const piece of rel.split('/')) {
    if (piece === '..') {
      parts.pop();
    } else if (piece !== '.' && piece !== '') {
      parts.push(piece);
    }
  }
  return parts.join('/');
}
