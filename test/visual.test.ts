import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNotebook, type NbCell } from '../src/core/notebook.ts';
import { diffCells, diffLines } from '../src/core/cellDiff.ts';
import { anchorForDocLines, buildReviewDoc, docLineForSource, docLinesForAnchor } from '../src/core/reviewDoc.ts';
import { parsePatch } from '../src/core/patch.ts';
import { highlightLines, renderMarkdownCell } from '../src/render.ts';
import { buildThreads, buildViewModel } from '../src/viewModel.ts';
import type { NotebookEntry } from '../src/session.ts';

const fx = (name: string) => readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8');

function cell(id: string, source: string[], type: NbCell['type'] = 'code', index = 0): NbCell {
  return { id, type, source, index, jsonLines: source.map((_, i) => i + 1), cellJsonLine: 0, outputs: [] };
}

test('line diff keeps common lines and marks changes', () => {
  const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
  assert.deepEqual(ops, [
    { op: 'same', base: 0, head: 0 },
    { op: 'del', base: 1 },
    { op: 'add', head: 1 },
    { op: 'same', base: 2, head: 2 },
    { op: 'same', base: 3, head: 3 },
    { op: 'add', head: 4 },
  ]);
});

test('cells match by id; moved cells show at their new place, removed ones before the next kept cell', () => {
  const base = [cell('a', ['1']), cell('b', ['2']), cell('c', ['3']), cell('d', ['4'])];
  const head = [cell('a', ['1']), cell('d', ['4']), cell('c', ['3 changed']), cell('new', ['5'])];
  const pairs = diffCells(base, head);
  assert.deepEqual(
    pairs.map(p => [p.base?.id, p.head?.id, p.status, p.moved]),
    [
      ['a', 'a', 'unchanged', false],
      ['d', 'd', 'unchanged', true],
      ['b', undefined, 'removed', false],
      ['c', 'c', 'modified', false],
      [undefined, 'new', 'added', false],
    ],
  );
});

test('cells without ids are matched by content', () => {
  const base = [cell('index-0', ['x']), cell('index-1', ['y'])];
  const head = [cell('index-0', ['new']), cell('index-1', ['x']), cell('index-2', ['y'])];
  assert.deepEqual(diffCells(base, head).map(p => p.status), ['added', 'unchanged', 'unchanged']);
});

test('highlighted code splits into lines without breaking multi-line strings', () => {
  const lines = highlightLines(['def f():', '    """Doc', '    more"""', '    return 1'], 'python');
  assert.equal(lines.length, 4);
  for (const l of lines) {
    assert.equal((l.match(/<span/g) ?? []).length, (l.match(/<\/span>/g) ?? []).length, l);
  }
  assert.match(lines[2], /^<span class="hljs-string">/);
});

test('rendered markdown blocks carry their source lines, and maths renders', () => {
  const html = renderMarkdownCell(['# Title', '', 'Some text', 'continued $x^2$', '', '- a', '- b']);
  assert.match(html, /<h1 data-src="0-0">Title<\/h1>/);
  assert.match(html, /<p data-src="2-3">/);
  assert.match(html, /<ul data-src="5-6">/);
  assert.match(html, /class="katex"/);
});

test('anchors round-trip through review document lines', () => {
  const doc = buildReviewDoc(parseNotebook(fx('small.head.ipynb')));
  const lines = docLinesForAnchor(doc, { cellId: 'loss-def', kind: 'source', start: 1, end: 2 })!;
  assert.deepEqual(anchorForDocLines(doc, lines.start, lines.end), { cellId: 'loss-def', kind: 'source', start: 1, end: 2 });
  const out = docLinesForAnchor(doc, { cellId: 'demo', kind: 'output', outputIndex: 1 })!;
  assert.deepEqual(anchorForDocLines(doc, out.start, out.end), { cellId: 'demo', kind: 'output', outputIndex: 1 });
  const header = docLinesForAnchor(doc, { cellId: 'intro', kind: 'cell' })!;
  assert.deepEqual(anchorForDocLines(doc, header.start, header.end), { cellId: 'intro', kind: 'cell' });
});

function entry(baseText: string, headText: string, patch: string, path = 'nbs/losses.ipynb'): NotebookEntry {
  return {
    path,
    file: { filename: path, status: 'modified', additions: 3, deletions: 2, patch },
    base: buildReviewDoc(parseNotebook(baseText)),
    head: buildReviewDoc(parseNotebook(headText)),
    commentable: parsePatch(patch),
  };
}

test('view model: changed cells, outputs and pending threads', () => {
  const e = entry(fx('small.base.ipynb'), fx('small.head.ipynb'), fx('small.patch'));
  const vm = buildViewModel(e, { number: 1, title: 't', url: 'u' });
  assert.deepEqual(vm.cells.map(c => [c.key, c.status]), [['intro', 'modified'], ['loss-def', 'modified'], ['demo', 'modified']]);
  const demo = vm.cells[2];
  assert.equal(demo.sourceChanged, false);
  assert.equal(demo.outputsChanged, true);
  assert.equal(demo.headOutputs[1].imageSrc?.startsWith('data:image/png;base64,'), true);
  assert.match(vm.cells[0].headHtml!, /data-src/);

  const startDocLine = docLineForSource(e.head, 'loss-def', 1)!;
  const threads = buildThreads(e, [], [
    { key: 'd1', nbPath: e.path, side: 'RIGHT', startDocLine, endDocLine: startDocLine + 1, text: 'hi **there**' },
  ], () => 'Pending · x');
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].anchor, { side: 'RIGHT', cellId: 'loss-def', kind: 'source', start: 1, end: 2 });
  assert.match(threads[0].comments[0].html, /<strong>there<\/strong>/);
});

test('display maths keeps its source lines', () => {
  const html = renderMarkdownCell(['Intro', '', '$$', 'x^2', '$$', '', 'After']);
  assert.match(html, /<div data-src="2-4">[^]*?katex-display/);
});

test('every icon the page uses is built into it', () => {
  const page = readFileSync(join(process.cwd(), 'src', 'webview', 'main.ts'), 'utf8');
  const built = new Set(JSON.parse(readFileSync(join(process.cwd(), 'src', 'webview', 'icons.json'), 'utf8')));
  const used = new Set<string>();
  for (const call of page.match(/icon\([^)]*\)/g) ?? []) {
    for (const name of call.match(/'([a-z-]+)'/g) ?? []) {
      used.add(name.slice(1, -1));
    }
  }
  assert.ok(used.size >= 10);
  assert.deepEqual([...used].filter(n => !built.has(n)), []);
});

test('unchanged cells share the new version instead of repeating it', () => {
  const e = entry(fx('small.base.ipynb'), fx('small.head.ipynb'), fx('small.patch'));
  const demo = buildViewModel(e, { number: 1, title: 't', url: 'u' }).cells.find(c => c.key === 'demo')!;
  assert.equal(demo.baseSameAsHead, true);
  assert.deepEqual(demo.baseLines, []);
  assert.ok(demo.headLines.length > 0);
  const changed = buildViewModel(e, { number: 1, title: 't', url: 'u' }).cells.find(c => c.key === 'loss-def')!;
  assert.equal(changed.baseSameAsHead, undefined);
});
