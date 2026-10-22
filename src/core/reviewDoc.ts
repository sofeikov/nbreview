// Turns a notebook into a plain-text "review document": one header line per cell, then the
// cell's source, then a short summary of its outputs. VS Code's normal diff editor and
// Comments API work on these documents, and every line remembers which cell it came from.
import type { NbCell, NbOutput, Notebook } from './notebook.ts';

export type LineKind = 'header' | 'source' | 'output' | 'blank';

export interface LineInfo {
  kind: LineKind;
  cell: NbCell;
  /** 0-based line within the cell source, for 'source' lines. */
  sourceLine?: number;
  output?: NbOutput;
}

export interface ReviewDoc {
  text: string;
  /** Indexed by 0-based document line. */
  lines: LineInfo[];
  notebook: Notebook;
}

export const HEADER_PREFIX = '━━━ ';
const HEADER_WIDTH = 56;
const MAX_OUTPUT_LINES = 12;

export function headerText(cell: NbCell): string {
  const base = `${HEADER_PREFIX}${cell.type} · ${cell.id} `;
  return base + '━'.repeat(Math.max(3, HEADER_WIDTH - base.length));
}

export function buildReviewDoc(notebook: Notebook): ReviewDoc {
  const out: string[] = [];
  const lines: LineInfo[] = [];
  const push = (text: string, info: LineInfo) => {
    out.push(text);
    lines.push(info);
  };

  for (const cell of notebook.cells) {
    push(headerText(cell), { kind: 'header', cell });
    cell.source.forEach((text, sourceLine) => push(text, { kind: 'source', cell, sourceLine }));
    for (const output of cell.outputs) {
      push(`  ▸ out: ${output.label}`, { kind: 'output', cell, output });
      const shown = output.textLines.slice(0, MAX_OUTPUT_LINES);
      for (const text of shown) {
        push(`  │ ${text}`, { kind: 'output', cell, output });
      }
      if (output.textLines.length > shown.length) {
        push(`  │ … ${output.textLines.length - shown.length} more lines`, { kind: 'output', cell, output });
      }
    }
    push('', { kind: 'blank', cell });
  }
  return { text: out.join('\n'), lines, notebook };
}

export function findCell(doc: ReviewDoc, cellId: string): NbCell | undefined {
  return doc.notebook.cells.find(c => c.id === cellId);
}

export function headerLine(doc: ReviewDoc, cellId: string): number | undefined {
  const i = doc.lines.findIndex(l => l.kind === 'header' && l.cell.id === cellId);
  return i < 0 ? undefined : i;
}

export function docLineForSource(doc: ReviewDoc, cellId: string, sourceLine: number): number | undefined {
  const i = doc.lines.findIndex(l => l.kind === 'source' && l.cell.id === cellId && l.sourceLine === sourceLine);
  return i < 0 ? undefined : i;
}

export function docLineForJsonLine(doc: ReviewDoc, jsonLine: number): number | undefined {
  const i = doc.lines.findIndex(l => l.kind === 'source' && l.cell.jsonLines[l.sourceLine!] === jsonLine);
  if (i >= 0) {
    return i;
  }
  // Lines in the JSON that are not source lines (metadata, outputs...) fall back to their cell.
  let best: NbCell | undefined;
  for (const cell of doc.notebook.cells) {
    if (cell.cellJsonLine <= jsonLine) {
      best = cell;
    }
  }
  return best ? headerLine(doc, best.id) : undefined;
}

/** Where a comment sits, in terms people (and the visual review) use: a cell, a line, an output. */
export interface CellAnchor {
  cellId: string;
  kind: 'source' | 'cell' | 'output';
  /** 0-based source lines, for 'source'. */
  start?: number;
  end?: number;
  outputIndex?: number;
}

export function docLinesForAnchor(doc: ReviewDoc, anchor: CellAnchor): { start: number; end: number } | undefined {
  if (anchor.kind === 'source' && anchor.start !== undefined) {
    const start = docLineForSource(doc, anchor.cellId, anchor.start);
    const end = docLineForSource(doc, anchor.cellId, anchor.end ?? anchor.start);
    if (start !== undefined && end !== undefined) {
      return { start, end };
    }
  }
  if (anchor.kind === 'output' && anchor.outputIndex !== undefined) {
    const cell = findCell(doc, anchor.cellId);
    const output = cell?.outputs[anchor.outputIndex];
    const line = output ? doc.lines.findIndex(l => l.kind === 'output' && l.output === output) : -1;
    if (line >= 0) {
      return { start: line, end: line };
    }
  }
  const header = headerLine(doc, anchor.cellId);
  return header === undefined ? undefined : { start: header, end: header };
}

export function anchorForDocLines(doc: ReviewDoc, start: number, end: number): CellAnchor | undefined {
  const info = doc.lines[end];
  if (!info) {
    return undefined;
  }
  const cellId = info.cell.id;
  if (info.kind === 'source') {
    const first = doc.lines[start];
    const from = first?.kind === 'source' && first.cell === info.cell ? first.sourceLine! : info.sourceLine!;
    return { cellId, kind: 'source', start: from, end: info.sourceLine! };
  }
  if (info.kind === 'output' && info.output) {
    return { cellId, kind: 'output', outputIndex: info.cell.outputs.indexOf(info.output) };
  }
  return { cellId, kind: 'cell' };
}
