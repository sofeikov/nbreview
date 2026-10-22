// Parses an .ipynb file while remembering where every source line sits in the raw JSON.
// GitHub anchors review comments to lines of the raw file, so this mapping is what lets a
// comment on "cell 12, line 3" land on the right line of the notebook diff.
import { parseTree, type Node } from 'jsonc-parser';

export type CellType = 'code' | 'markdown' | 'raw';

export interface NbOutput {
  kind: 'stream' | 'text' | 'image' | 'error' | 'other';
  /** Short description shown in the review document, e.g. "stream stdout" or "image/png 640×480". */
  label: string;
  textLines: string[];
  mime?: string;
  /** Base64 payload for images (SVG as text), used for hovers and the visual review. */
  data?: string;
  /** Raw HTML for text/html outputs such as pandas tables. */
  html?: string;
  /** Content hash so changed outputs show up as changed lines in the diff. */
  hash: string;
}

export interface NbCell {
  index: number;
  id: string;
  type: CellType;
  /** Source lines without trailing newlines. */
  source: string[];
  /** 1-based line in the raw JSON for each source line. */
  jsonLines: number[];
  /** 1-based line of the cell's opening brace in the raw JSON. */
  cellJsonLine: number;
  outputs: NbOutput[];
}

export interface Notebook {
  cells: NbCell[];
  language: string;
  /** Raw lines of the .ipynb file, used to build GitHub suggestions in the file's own format. */
  rawLines: string[];
}

export function emptyNotebook(): Notebook {
  return { cells: [], language: 'python', rawLines: [] };
}

export function parseNotebook(text: string): Notebook {
  const root = parseTree(text);
  if (!root || root.type !== 'object') {
    throw new Error('Not a JSON notebook');
  }
  const lineOf = lineLocator(text);
  const language = stringAt(prop(prop(prop(root, 'metadata'), 'kernelspec'), 'language'))
    ?? stringAt(prop(prop(prop(root, 'metadata'), 'language_info'), 'name'))
    ?? 'python';

  const cellsNode = prop(root, 'cells');
  const cells: NbCell[] = [];
  for (const [index, cellNode] of (cellsNode?.children ?? []).entries()) {
    const type = (stringAt(prop(cellNode, 'cell_type')) ?? 'code') as CellType;
    const id = stringAt(prop(cellNode, 'id')) ?? `index-${index}`;
    const { source, jsonLines } = readSource(prop(cellNode, 'source'), lineOf);
    cells.push({
      index,
      id,
      type,
      source,
      jsonLines,
      cellJsonLine: lineOf(cellNode.offset),
      outputs: readOutputs(prop(cellNode, 'outputs')),
    });
  }
  return { cells, language, rawLines: text.split('\n') };
}

function readSource(node: Node | undefined, lineOf: (offset: number) => number) {
  const source: string[] = [];
  const jsonLines: number[] = [];
  if (!node) {
    return { source, jsonLines };
  }
  // nbformat allows either a list of lines or one multi-line string.
  const parts = node.type === 'array' ? node.children ?? [] : [node];
  for (const part of parts) {
    if (part.type !== 'string') {
      continue;
    }
    const line = lineOf(part.offset);
    const pieces = String(part.value).split('\n');
    if (pieces.length > 1 && pieces[pieces.length - 1] === '') {
      pieces.pop();
    }
    for (const piece of pieces) {
      source.push(piece);
      jsonLines.push(line);
    }
  }
  return { source, jsonLines };
}

function readOutputs(node: Node | undefined): NbOutput[] {
  const outputs: NbOutput[] = [];
  for (const outNode of node?.children ?? []) {
    const out = nodeValue(outNode) as Record<string, any>;
    const type = out.output_type;
    if (type === 'stream') {
      const text = joinText(out.text);
      outputs.push({ kind: 'stream', label: `stream ${out.name ?? 'stdout'}`, textLines: splitText(text), hash: fnv(text) });
    } else if (type === 'error') {
      const trace = stripAnsi((out.traceback ?? []).join('\n'));
      outputs.push({ kind: 'error', label: `error ${out.ename}: ${out.evalue}`, textLines: splitText(trace).slice(-8), hash: fnv(trace) });
    } else if (type === 'execute_result' || type === 'display_data') {
      outputs.push(readRichOutput(out.data ?? {}));
    } else {
      outputs.push({ kind: 'other', label: String(type), textLines: [], hash: fnv(JSON.stringify(out)) });
    }
  }
  return outputs;
}

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/gif'];

function readRichOutput(data: Record<string, unknown>): NbOutput {
  const plain = joinText(data['text/plain']);
  for (const mime of IMAGE_MIMES) {
    if (data[mime] !== undefined) {
      const payload = joinText(data[mime]).replace(/\s+/g, mime === 'image/svg+xml' ? ' ' : '');
      const size = mime === 'image/png' ? pngSize(payload) : undefined;
      const hash = fnv(payload);
      return {
        kind: 'image',
        label: `${mime}${size ? ` ${size.w}×${size.h}` : ''} #${hash}`,
        textLines: [],
        mime,
        data: payload,
        hash,
      };
    }
  }
  if (data['text/html'] !== undefined) {
    const html = joinText(data['text/html']);
    return { kind: 'text', label: 'text/html', mime: 'text/html', textLines: splitText(plain), html, hash: fnv(html) };
  }
  const mimes = Object.keys(data);
  if (data['text/plain'] !== undefined) {
    return { kind: 'text', label: 'text/plain', mime: 'text/plain', textLines: splitText(plain), hash: fnv(plain) };
  }
  return { kind: 'other', label: mimes.join(', ') || 'empty output', textLines: [], hash: fnv(JSON.stringify(data)) };
}

function pngSize(base64: string): { w: number; h: number } | undefined {
  try {
    const head = Buffer.from(base64.slice(0, 48), 'base64');
    if (head.length < 24 || head.toString('ascii', 1, 4) !== 'PNG') {
      return undefined;
    }
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } catch {
    return undefined;
  }
}

function prop(node: Node | undefined, key: string): Node | undefined {
  if (!node || node.type !== 'object') {
    return undefined;
  }
  for (const p of node.children ?? []) {
    const [k, v] = p.children ?? [];
    if (k?.value === key) {
      return v;
    }
  }
  return undefined;
}

function stringAt(node: Node | undefined): string | undefined {
  return node?.type === 'string' ? String(node.value) : undefined;
}

function nodeValue(node: Node): unknown {
  switch (node.type) {
    case 'object':
      return Object.fromEntries((node.children ?? []).map(p => [p.children![0].value, nodeValue(p.children![1])]));
    case 'array':
      return (node.children ?? []).map(nodeValue);
    default:
      return node.value;
  }
}

function lineLocator(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return offset => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo + 1;
  };
}

function joinText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join('');
  }
  return value === undefined || value === null ? '' : String(value);
}

function splitText(text: string): string[] {
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

export function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
