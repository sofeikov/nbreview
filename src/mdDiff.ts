// Rendered diff of a changed Markdown cell, after the approach of mdiff: the blocks of the two
// versions (paragraphs, headings, list items, table cells, code and maths) are lined up, and a
// paragraph that changed shows the changed words marked, with its formatting kept, instead of
// the whole paragraph being highlighted.
import type MarkdownIt from 'markdown-it';
import { cellMarkdown, escapeHtml, highlightLines } from './render.ts';
import { diffLines } from './core/cellDiff.ts';

type Token = ReturnType<MarkdownIt['parse']>[number];

/** A block-level unit that is compared as a whole or word by word. */
interface Leaf {
  /** Paragraph, heading level, table cell, code, maths... Leaves pair only with the same kind. */
  kind: string;
  /** Index of the leaf's main token: the inline token, or the code/maths token itself. */
  index: number;
  /** Text used to compare and to measure similarity. */
  text: string;
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

/** HTML of both versions of a Markdown cell, with the changes marked. */
export function renderMarkdownDiff(base: string[], head: string[]): { base: string; head: string } {
  const md = cellMarkdown;
  const env = {};
  const a = md.parse(base.join('\n'), env);
  const b = md.parse(head.join('\n'), env);
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
      diffPair(a, x, b, added[k]);
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
  return { base: md.renderer.render(a, md.options, env), head: md.renderer.render(b, md.options, env) };
}

function leaves(tokens: Token[]): Leaf[] {
  const out: Leaf[] = [];
  tokens.forEach((t, index) => {
    if (t.type === 'inline') {
      const open = tokens[index - 1];
      out.push({ kind: open?.tag || open?.type || 'inline', index, text: t.content });
    } else if (t.type === 'fence' || t.type === 'code_block' || t.type.startsWith('math_block') || t.type === 'html_block') {
      out.push({ kind: t.type, index, text: t.content });
    }
  });
  return out;
}

function key(leaf: Leaf): string {
  return `${leaf.kind}\u0000${leaf.text}`;
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

function diffPair(a: Token[], x: Leaf, b: Token[], y: Leaf): void {
  const ta = a[x.index];
  const tb = b[y.index];
  if (isCode(ta) && isCode(tb)) {
    // A long code block (a file tree, a command list) often changes in one line: mark that line.
    const linesA = codeLines(ta);
    const linesB = codeLines(tb);
    const ops = diffLines(linesA, linesB);
    replaceCode(ta, linesA, new Set(ops.flatMap(o => (o.op === 'del' ? [o.base] : []))), 'line-del');
    replaceCode(tb, linesB, new Set(ops.flatMap(o => (o.op === 'add' ? [o.head] : []))), 'line-ins');
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
  const atomsA = atomize(ta);
  const atomsB = atomize(tb);
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

function atomize(inline: Token): Atom[] {
  const md = cellMarkdown;
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
      // Code spans, inline maths, images, line breaks: one unit each.
      const html = md.renderer.renderInline([tok], md.options, {});
      atoms.push({ key: `${ctxKey}|${tok.type}:${tok.content}:${html}`, html, ctx, space: false });
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
function replaceCode(t: Token, lines: string[], marked: Set<number>, cls: string): void {
  const language = t.info.trim().split(/\s+/)[0] || 'plaintext';
  const html = highlightLines(lines, language)
    .map((line, i) => `<span class="code-line${marked.has(i) ? ` ${cls}` : ''}">${line || '&#8203;'}</span>`)
    .join('');
  const src = t.attrGet('data-src') ?? (t.map ? `${t.map[0]}-${Math.max(t.map[0], t.map[1] - 1)}` : '');
  t.type = 'html_block';
  t.content = `<pre class="md-code-diff md-changed" data-src="${escapeHtml(src)}"><code class="hljs">${html}</code></pre>\n`;
}

/** Makes an inline token render as the given HTML. */
function replaceInline(inline: Token, html: string): void {
  const raw = new (inline.constructor as new (type: string, tag: string, nesting: number) => Token)('html_inline', '', 0);
  raw.content = html;
  inline.children = [raw];
}
