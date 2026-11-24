// Rendered diff of a changed Markdown cell, after the approach of mdiff: the blocks of the two
// versions (paragraphs, headings, list items, table cells, code and maths) are lined up, and a
// paragraph that changed shows the changed words marked, with its formatting kept, instead of
// the whole paragraph being highlighted.
import type MarkdownIt from 'markdown-it';
import { cellMarkdown, codeLinesHtml, escapeHtml, highlightLines, mermaidAttr, quartoMarkdown } from './render.ts';
import { diffLines } from './core/cellDiff.ts';
import { cellHtml, fenceLabel, fenceLanguage, shownOutputs, type CellInfo } from './core/quarto.ts';

type Token = ReturnType<MarkdownIt['parse']>[number];

/** A block-level unit that is compared as a whole or word by word. */
interface Leaf {
  /** Paragraph, heading level, table cell, code, maths... Leaves pair only with the same kind. */
  kind: string;
  /** Index of the leaf's main token: the inline token, or the code/maths token itself. */
  index: number;
  /** Text used to compare and to measure similarity. */
  text: string;
  /**
   * What else makes two leaves differ: the values and outputs of a Quarto build, which change
   * with the data while the source stays the same (the `diffKey` of their tokens).
   */
  extra: string;
}

/** The smallest unit of the word diff: a word, a space, a punctuation mark, or an inline element. */
interface Atom {
  key: string;
  html: string;
  /** The open inline tokens (strong, em, link...) around the atom. */
  ctx: Token[];
  space: boolean;
}

const WORD = /\s+|\p{N}+(?:[.,]\p{N}+)+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/** How the two versions are parsed: by default as notebook Markdown, each with its own env. */
export interface MarkdownDiffOptions {
  md?: MarkdownIt;
  /** Values for the parser rules, such as the front matter and bibliography of a Quarto file. */
  baseEnv?: Record<string, unknown>;
  headEnv?: Record<string, unknown>;
}

/** HTML of both versions of a Markdown cell, with the changes marked. */
export function renderMarkdownDiff(base: string[], head: string[], options: MarkdownDiffOptions = {}): { base: string; head: string } {
  const md = options.md ?? cellMarkdown;
  // One env per side: a Quarto document numbers its own sections and resolves its own references.
  const envA = options.baseEnv ?? {};
  const envB = options.headEnv ?? {};
  const a = md.parse(base.join('\n'), envA);
  const b = md.parse(head.join('\n'), envB);
  const leavesA = leaves(a);
  const leavesB = leaves(b);

  // Line up the leaves: identical ones first, then the changed ones in between by kind and similarity.
  const ops = diffLines(leavesA.map(key), leavesB.map(key));
  let removed: Leaf[] = [];
  let added: Leaf[] = [];
  const flush = () => {
    let j = 0;
    for (const x of removed) {
      const k = added.findIndex((y, i) => i >= j && y.kind === x.kind && similarity(x.text, y.text) >= 0.3);
      if (k < 0) {
        mark(a, x, 'md-removed');
        continue;
      }
      for (; j < k; j++) {
        mark(b, added[j], 'md-added');
      }
      diffPair(md, a, x, b, added[k], envA, envB);
      j = k + 1;
    }
    for (; j < added.length; j++) {
      mark(b, added[j], 'md-added');
    }
    removed = [];
    added = [];
  };
  for (const op of ops) {
    if (op.op === 'del') {
      removed.push(leavesA[op.base]);
    } else if (op.op === 'add') {
      added.push(leavesB[op.head]);
    } else {
      flush();
    }
  }
  flush();
  return { base: md.renderer.render(a, md.options, envA), head: md.renderer.render(b, md.options, envB) };
}

function leaves(tokens: Token[]): Leaf[] {
  const out: Leaf[] = [];
  tokens.forEach((t, index) => {
    if (t.type === 'inline') {
      const open = tokens[index - 1];
      out.push({ kind: open?.tag || open?.type || 'inline', index, text: t.content, extra: (t.children ?? []).map(diffKey).join('\u0001') });
    } else if (t.type === 'fence' || t.type === 'code_block' || t.type.startsWith('math_block') || t.type === 'html_block') {
      out.push({ kind: t.type, index, text: t.content, extra: diffKey(t) });
    }
  });
  return out;
}

function diffKey(t: Token): string {
  return (t.meta as { diffKey?: string } | null)?.diffKey ?? '';
}

function key(leaf: Leaf): string {
  return `${leaf.kind}\u0000${leaf.text}\u0000${leaf.extra}`;
}

/** Share of words the two texts have in common (Dice coefficient). */
function similarity(x: string, y: string): number {
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const wx = words(x);
  const wy = words(y);
  if (!wx.length && !wy.length) {
    return 1;
  }
  const counts = new Map<string, number>();
  for (const w of wx) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  let common = 0;
  for (const w of wy) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      common++;
      counts.set(w, n - 1);
    }
  }
  return (2 * common) / (wx.length + wy.length);
}

/** Adds a class to the element a leaf renders as (the list item, for paragraphs of tight lists). */
function mark(tokens: Token[], leaf: Leaf, cls: string): void {
  let target = tokens[leaf.index];
  if (target.type === 'inline') {
    target = tokens[leaf.index - 1];
    if (target?.hidden) {
      for (let i = leaf.index - 2; i >= 0; i--) {
        if (tokens[i].type === 'list_item_open') {
          target = tokens[i];
          break;
        }
      }
    }
  }
  target?.attrJoin('class', cls);
}

function diffPair(md: MarkdownIt, a: Token[], x: Leaf, b: Token[], y: Leaf, envA: Record<string, unknown>, envB: Record<string, unknown>): void {
  const ta = a[x.index];
  const tb = b[y.index];
  if (isCode(ta) && isCode(tb)) {
    diffOutputs(md, ta, tb);
    if (ta.content === tb.content && ta.info === tb.info) {
      // The same code with other outputs: the outputs are marked, and the code stays as it is.
      return;
    }
    // A long code block (a file tree, a command list) often changes in one line: mark that line.
    const linesA = codeLines(ta);
    const linesB = codeLines(tb);
    const ops = diffLines(linesA, linesB);
    replaceCode(md, ta, linesA, new Set(ops.flatMap(o => (o.op === 'del' ? [o.base] : []))), 'line-del', envA);
    replaceCode(md, tb, linesB, new Set(ops.flatMap(o => (o.op === 'add' ? [o.head] : []))), 'line-ins', envB);
    return;
  }
  if (ta.type !== 'inline' || tb.type !== 'inline') {
    // Code, maths and raw HTML change as a whole.
    mark(a, x, 'md-changed');
    mark(b, y, 'md-changed');
    return;
  }
  mark(a, x, 'md-changed');
  mark(b, y, 'md-changed');
  const atomsA = atomize(md, ta);
  const atomsB = atomize(md, tb);
  const ops = diffLines(atomsA.map(t => t.key), atomsB.map(t => t.key));
  const delA = new Set<number>();
  const insB = new Set<number>();
  for (const op of ops) {
    if (op.op === 'del') {
      delA.add(op.base);
    } else if (op.op === 'add') {
      insB.add(op.head);
    }
  }
  bridge(ops, atomsA, delA, 'base');
  bridge(ops, atomsB, insB, 'head');
  replaceInline(ta, renderAtoms(atomsA, delA, 'x-del'));
  replaceInline(tb, renderAtoms(atomsB, insB, 'x-ins'));
}

/**
 * A space or a single punctuation mark left unmarked between two changed words makes the
 * highlight look broken; mark it too, so each change reads as one run.
 */
function bridge(ops: ReturnType<typeof diffLines>, atoms: Atom[], marked: Set<number>, side: 'base' | 'head'): void {
  const positions = ops
    .map(op => (side === 'base' ? (op.op === 'add' ? undefined : (op as { base: number }).base) : op.op === 'del' ? undefined : (op as { head: number }).head))
    .filter((n): n is number => n !== undefined);
  for (let i = 1; i < positions.length - 1; i++) {
    const p = positions[i];
    if (!marked.has(p) && marked.has(positions[i - 1]) && marked.has(positions[i + 1])) {
      const atom = atoms[p];
      if (atom.space || atom.html.length <= 1) {
        marked.add(p);
      }
    }
  }
}

function atomize(md: MarkdownIt, inline: Token): Atom[] {
  const atoms: Atom[] = [];
  const stack: Token[] = [];
  for (const tok of inline.children ?? []) {
    if (tok.nesting === 1) {
      stack.push(tok);
      continue;
    }
    if (tok.nesting === -1) {
      stack.pop();
      continue;
    }
    const ctx = stack.slice();
    const ctxKey = ctx.map(t => t.type + (t.attrGet('href') ?? '')).join('>');
    if (tok.type === 'text') {
      for (const piece of tok.content.match(WORD) ?? []) {
        const space = /^\s/.test(piece);
        atoms.push({ key: `${ctxKey}|${space ? ' ' : piece}`, html: md.utils.escapeHtml(piece), ctx, space });
      }
    } else if (tok.type === 'softbreak') {
      atoms.push({ key: `${ctxKey}| `, html: '\n', ctx, space: true });
    } else {
      // Code spans, inline maths, images, line breaks: one unit each. A Quarto cross-reference or
      // citation is compared by its source, so a renumbered section isn't a change. An inline
      // expression is compared by its value when both versions were built, and by its source
      // otherwise: a value on one side only isn't a change.
      const html = md.renderer.renderInline([tok], md.options, {});
      const what = tok.type.startsWith('quarto_') ? '' : (tok.meta as { expr?: boolean } | null)?.expr ? diffKey(tok) : html;
      atoms.push({ key: `${ctxKey}|${tok.type}:${tok.content}:${what}`, html, ctx, space: false });
    }
  }
  return atoms;
}

function renderAtoms(atoms: Atom[], marked: Set<number>, cls: string): string {
  let html = '';
  const open: Token[] = [];
  atoms.forEach((atom, i) => {
    let common = 0;
    while (common < open.length && common < atom.ctx.length && open[common] === atom.ctx[common]) {
      common++;
    }
    while (open.length > common) {
      html += `</${open.pop()!.tag}>`;
    }
    for (const tok of atom.ctx.slice(common)) {
      const attrs = (tok.attrs ?? []).map(([k, v]) => ` ${k}="${cellMarkdown.utils.escapeHtml(String(v))}"`).join('');
      html += `<${tok.tag}${attrs}>`;
      open.push(tok);
    }
    html += marked.has(i) ? `<span class="${cls}">${atom.html}</span>` : atom.html;
  });
  while (open.length) {
    html += `</${open.pop()!.tag}>`;
  }
  return html;
}

/**
 * Marks the outputs of two paired Quarto cells that differ in a build of both versions. Tables
 * written as Markdown are compared like the document's own, so the changed numbers are marked.
 */
function diffOutputs(md: MarkdownIt, ta: Token, tb: Token): void {
  const ca = (ta.meta as { cell?: CellInfo } | null)?.cell;
  const cb = (tb.meta as { cell?: CellInfo } | null)?.cell;
  if (!ca?.ran || !cb?.ran || diffKey(ta) === diffKey(tb)) {
    return;
  }
  ca.runChanged = cb.runChanged = true;
  const outA = shownOutputs(ca, ca.run);
  const outB = shownOutputs(cb, cb.run);
  const text = (cell: CellInfo, o: (typeof outA)[number] | undefined) =>
    o?.kind === 'markdown' || (o?.kind === 'stream' && cell.asis && o.name !== 'stderr') ? o.text : undefined;
  outA.forEach((a, i) => {
    const x = text(ca, a);
    const y = text(cb, outB[i]);
    if (x !== undefined && y !== undefined && x !== y) {
      const d = renderMarkdownDiff(x.split('\n'), y.split('\n'), { md });
      const wrap = (html: string) => `<div class="qout-md">${html.replace(/ data-src="[^"]*"/g, '')}</div>`;
      (ca.outputHtml ??= [])[i] = wrap(d.base);
      (cb.outputHtml ??= [])[i] = wrap(d.head);
    }
  });
}

function isCode(t: Token): boolean {
  return t.type === 'fence' || t.type === 'code_block';
}

function codeLines(t: Token): string[] {
  return t.content.replace(/\n$/, '').split('\n');
}

/**
 * Renders a code block as highlighted lines with the given ones marked. The block keeps its
 * source lines (`data-src`) so comments still anchor to it, and `md-changed` for the margin bar.
 */
function replaceCode(md: MarkdownIt, t: Token, lines: string[], marked: Set<number>, cls: string, env: Record<string, unknown>): void {
  const language = fenceLanguage(t.info) || 'plaintext';
  const src = t.attrGet('data-src') ?? (t.map ? `${t.map[0]}-${Math.max(t.map[0], t.map[1] - 1)}` : '');
  // Each line keeps its own source line, after the opening fence, so it takes comments by itself.
  const first = t.map ? t.map[0] + (t.type === 'fence' ? 1 : 0) : undefined;
  const marks = lines.map((_l, i) => (marked.has(i) ? cls : undefined));
  const pre = codeLinesHtml(highlightLines(lines, language), first, marks, { pre: ` class="md-code-diff md-changed" data-src="${escapeHtml(src)}"${mermaidAttr(t, md === quartoMarkdown)}`, code: [['class', 'hljs']] }).trimEnd();
  // A Quarto code cell keeps its label, figures and folding, as when it is rendered unchanged.
  t.content = md === quartoMarkdown && fenceLabel(t.info, escapeHtml) ? cellHtml(md, t, pre, env) : `${pre}\n`;
  t.type = 'html_block';
}

/** Makes an inline token render as the given HTML. */
function replaceInline(inline: Token, html: string): void {
  const raw = new (inline.constructor as new (type: string, tag: string, nesting: number) => Token)('html_inline', '', 0);
  raw.content = html;
  inline.children = [raw];
}
