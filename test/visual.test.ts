import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNotebook, type NbCell } from '../src/core/notebook.ts';
import { diffCells, diffLines, notebookChanges, onlyWhitespaceDiffers } from '../src/core/cellDiff.ts';
import { anchorForDocLines, buildReviewDoc, docLineForSource, docLinesForAnchor } from '../src/core/reviewDoc.ts';
import { parsePatch } from '../src/core/patch.ts';
import { highlightLines, renderMarkdownCell } from '../src/render.ts';
import { buildFileThreads, buildFileViewModel, buildThreads, buildViewModel, fileLanguage } from '../src/viewModel.ts';
import { planFileComment } from '../src/core/fileComments.ts';
import { diffPixels, pairImages } from '../src/webview/imageDiff.ts';
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

  // A pending comment from GitHub on two lines comes back with its range and as the reviewer's own.
  const startDocLine = docLineForSource(e.head, 'loss-def', 1)!;
  const placed = [{
    nbPath: e.path, side: 'RIGHT', docLine: startDocLine + 1, startDocLine,
    gh: { id: 'T1', isResolved: false, isOutdated: false, viewerCanResolve: false, viewerCanUnresolve: false, comments: [{ id: 'C1', pending: true, body: 'hi **there**', createdAt: 'x', url: '', author: 'me', viewerCanUpdate: true, viewerCanDelete: true, reactions: [] }] },
  }] as any;
  const threads = buildThreads(e, placed, () => 'Pending · x');
  assert.equal(threads.length, 1);
  assert.equal(threads[0].draft, true);
  assert.equal(threads[0].label, 'Pending · x');
  assert.equal(threads[0].comments[0].id, 'C1');
  assert.equal(threads[0].comments[0].canEdit, true);
  assert.equal(threads[0].comments[0].reactions, undefined, 'no reactions on pending comments');
  assert.equal(threads[0].canResolve, false, "a thread of pending comments can't be resolved");
  assert.deepEqual(threads[0].anchor, { side: 'RIGHT', cellId: 'loss-def', kind: 'source', start: 1, end: 2 });
  assert.match(threads[0].comments[0].html, /<strong>there<\/strong>/);
});

test('list items and quote paragraphs carry only their own lines', () => {
  /** Tag and source lines of every block, in order. */
  const ranges = (source: string[]) => [...renderMarkdownCell(source).matchAll(/<(\w+) data-src="([\d-]+)"/g)].map(m => `${m[1]} ${m[2]}`);
  // A comment lands on the last line of its range: it must not be the blank line after an item,
  // or a line of the item's nested list.
  assert.deepEqual(ranges(['- one', '- two', '  - nested a', '  - nested b', '- three', '', 'After']), [
    'ul 0-4', 'li 0-0', 'li 1-1', 'ul 2-3', 'li 2-2', 'li 3-3', 'li 4-4', 'p 6-6',
  ]);
  assert.deepEqual(ranges(['1. one', '   still one', '2. two', '', '', 'After']), ['ol 0-2', 'li 0-1', 'li 2-2', 'p 5-5']);
  // A loose list: every paragraph of an item has its own lines.
  assert.deepEqual(ranges(['- one', '', '  more of one', '', '- two', '']), ['ul 0-4', 'li 0-0', 'p 0-0', 'p 2-2', 'li 4-4', 'p 4-4']);
  assert.deepEqual(ranges(['> first', '>', '> second', '', 'After']), ['blockquote 0-2', 'p 0-0', 'p 2-2', 'p 4-4']);
  // An item that starts with code, not text, keeps its own lines without the blank one after it.
  assert.deepEqual(ranges(['- ```', '  x = 1', '  ```', '', '- two']).slice(0, 3), ['ul 0-4', 'li 0-2', 'code 0-2']);
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

import { renderMarkdownDiff } from '../src/mdDiff.ts';

test('markdown diff marks changed words, not whole paragraphs, and keeps formatting', () => {
  const { base, head } = renderMarkdownDiff(
    ['A **logistic** regression that gives the probability that a shot is scored.'],
    ['A **logistic** regression that gives the chance that a shot is scored, with the body part.'],
  );
  assert.match(base, /<span class="x-del">probability<\/span>/);
  assert.match(head, /<span class="x-ins">chance<\/span>/);
  assert.match(head, /<span class="x-ins">body<\/span>/);
  assert.match(head, /<strong>logistic<\/strong>/, 'unchanged bold text stays bold and unmarked');
  assert.doesNotMatch(head, /x-ins">regression/);
  assert.match(head, /<p data-src="0-0" class="md-changed">/, 'source lines and a changed marker on the paragraph');
});

test('markdown diff marks added and removed paragraphs as a whole', () => {
  const { base, head } = renderMarkdownDiff(
    ['# Title', '', 'Old note that goes away entirely.', '', 'Kept paragraph.'],
    ['# Title', '', 'Kept paragraph.', '', 'A completely new closing remark.'],
  );
  assert.match(base, /<p data-src="2-2" class="md-removed">Old note/);
  assert.match(head, /<p data-src="4-4" class="md-added">A completely new/);
  assert.doesNotMatch(head, /<h1[^>]*md-/, 'unchanged heading is not marked');
});

test('markdown diff works inside list items and on display maths', () => {
  const { base, head } = renderMarkdownDiff(
    ['- first item', '- second item here', '', '$$x^2$$'],
    ['- first item', '- second item there', '', '$$x^3$$'],
  );
  assert.match(head, /<li[^>]*class="md-changed"[^>]*>second item <span class="x-ins">there<\/span>/);
  assert.match(base, /<span class="x-del">here<\/span>/);
  assert.match(head, /<div data-src="3-3" class="md-changed">/);
});

test('compared with the last review: only what changed since, and no comments on the old side', () => {
  const e = entry(fx('small.base.ipynb'), fx('small.head.ipynb'), fx('small.patch'));
  // At the last review the notebook was already as it is now, except for one line of loss-def.
  const reviewed = JSON.parse(fx('small.head.ipynb'));
  const lossDef = reviewed.cells.find((c: any) => c.id === 'loss-def');
  lossDef.source[0] = '# reviewed version\n';
  const since = { base: buildReviewDoc(parseNotebook(JSON.stringify(reviewed))), label: 'your review on 1 Oct (abc1234)' };
  const vm = buildViewModel(e, { number: 1, title: 't', url: 'u' }, since);
  assert.deepEqual(vm.since, { label: 'your review on 1 Oct (abc1234)' });
  assert.deepEqual(vm.cells.filter(c => c.status !== 'unchanged').map(c => c.key), ['loss-def']);
  assert.deepEqual([vm.stats.additions, vm.stats.deletions], [1, 1], 'the source lines changed since the review');
  // The whole pull request, for comparison.
  assert.equal(buildViewModel(e, { number: 1, title: 't', url: 'u' }).since, undefined);
});

test('published threads: resolve flags, reactions, and editing only the viewer\'s own comments', () => {
  const e = entry(fx('small.base.ipynb'), fx('small.head.ipynb'), fx('small.patch'));
  const docLine = docLineForSource(e.head, 'loss-def', 0)!;
  const comment = (id: string, mine: boolean) => ({
    id, pending: false, body: `text ${id}`, createdAt: 'x', url: `u/${id}`, author: mine ? 'me' : 'maria',
    viewerCanUpdate: mine, viewerCanDelete: mine, reactions: mine ? [] : [{ content: 'HEART', count: 1, viewerHasReacted: true }],
  });
  const placed = [{
    nbPath: e.path, side: 'RIGHT', docLine,
    gh: { id: 'T2', isResolved: true, isOutdated: false, viewerCanResolve: false, viewerCanUnresolve: true, comments: [comment('C1', false), comment('C2', true)] },
  }] as any;
  const [t] = buildThreads(e, placed, () => '');
  assert.equal(t.resolved, true);
  assert.equal(t.canUnresolve, true);
  assert.equal(t.canResolve, false);
  assert.match(t.label, /^Resolved/);
  const [theirs, mine] = t.comments;
  assert.deepEqual([theirs.canEdit, theirs.canDelete, theirs.text], [false, false, undefined]);
  assert.deepEqual(theirs.reactions, [{ content: 'HEART', count: 1, mine: true }]);
  assert.deepEqual([mine.canEdit, mine.canDelete, mine.text], [true, true, 'text C2']);
});

test('ignoring whitespace: reformatted code and blank lines are not a change, real edits still are', () => {
  const base = [cell('a', ['def f(x):', '    return x+1']), cell('b', ['y = 1'])];
  const head = [cell('a', ['def f(x):', '', '    return  x+1  ']), cell('b', ['y = 2'])];
  const [a, b] = diffCells(base, head, { ignoreWhitespace: true });
  assert.equal(a.sourceChanged, false);
  assert.equal(a.status, 'unchanged');
  assert.equal(b.sourceChanged, true);
  assert.equal(diffCells(base, head)[0].sourceChanged, true, 'without the option, whitespace counts');
  assert.equal(onlyWhitespaceDiffers(base[0].source, head[0].source), true);
  assert.equal(onlyWhitespaceDiffers(base[1].source, head[1].source), false);
  assert.equal(onlyWhitespaceDiffers(['x'], ['x']), false, 'identical is not a whitespace change');
  // Cells without ids are still matched when only their whitespace changed.
  const pairs = diffCells([cell('index-0', ['z  =  3'])], [cell('index-0', ['x = 0']), cell('index-1', ['z = 3'])], { ignoreWhitespace: true });
  assert.deepEqual(pairs.map(p => [p.base?.source[0], p.head?.source[0], p.status]), [[undefined, 'x = 0', 'added'], ['z  =  3', 'z = 3', 'unchanged']]);
});

test('what changed in a notebook, in source lines rather than JSON lines', () => {
  const base = parseNotebook(fx('small.base.ipynb')).cells;
  const head = parseNotebook(fx('small.head.ipynb')).cells;
  assert.deepEqual(notebookChanges(base, head), { additions: 4, deletions: 3, sourceCells: 2, outputCells: 1 });
  assert.deepEqual(notebookChanges(base, base), { additions: 0, deletions: 0, sourceCells: 0, outputCells: 0 });
});

test('hiding noise folds cells whose only change is outputs or whitespace, and counts them either way', () => {
  const e = entry(fx('small.base.ipynb'), fx('small.head.ipynb'), fx('small.patch'));
  const pr = { number: 1, title: 't', url: 'u' };
  const shown = buildViewModel(e, pr);
  assert.equal(shown.hideNoise, false);
  assert.deepEqual(shown.noise, { cells: 1, outputs: 1, whitespace: 0 });
  assert.equal(shown.cells.find(c => c.key === 'demo')!.status, 'modified');
  assert.deepEqual([shown.stats.additions, shown.stats.deletions], [4, 3], 'source lines, not the file\'s JSON lines');
  assert.deepEqual(shown.fileStats, { additions: 3, deletions: 2 });

  const hidden = buildViewModel(e, pr, undefined, { hideNoise: true });
  const demo = hidden.cells.find(c => c.key === 'demo')!;
  assert.equal(demo.status, 'unchanged');
  assert.equal(demo.noiseHidden, 'outputs');
  assert.equal(demo.outputsChanged, false, 'the outputs show once, as they are now');
  assert.deepEqual(hidden.noise, { cells: 1, outputs: 1, whitespace: 0 });
  assert.deepEqual(hidden.cells.filter(c => c.status !== 'unchanged').map(c => c.key), ['intro', 'loss-def']);

  // A cell that was only reformatted.
  const reformatted = JSON.parse(fx('small.head.ipynb'));
  const lossDef = reformatted.cells.find((c: any) => c.id === 'loss-def');
  lossDef.source = lossDef.source.map((l: string) => l.replace('(x - y)', '( x - y )'));
  const e2 = entry(fx('small.head.ipynb'), JSON.stringify(reformatted), '');
  assert.deepEqual(buildViewModel(e2, pr).noise, { cells: 1, outputs: 0, whitespace: 1 });
  assert.equal(buildViewModel(e2, pr).cells.find(c => c.key === 'loss-def')!.status, 'modified');
  const quiet = buildViewModel(e2, pr, undefined, { hideNoise: true });
  assert.equal(quiet.cells.find(c => c.key === 'loss-def')!.noiseHidden, 'whitespace');
  assert.deepEqual([quiet.stats.additions, quiet.stats.deletions], [0, 0]);
});

test('changed plots are paired in order; unchanged ones are not compared', () => {
  const img = (index: number, hash: string) => ({ index, hash, kind: 'image' as const, label: `image/png #${hash}`, imageSrc: `data:image/png;base64,${hash}` });
  const text = (index: number, hash: string) => ({ index, hash, kind: 'stream' as const, label: 'stream stdout', text: hash });
  const pairs = pairImages([text(0, 't1'), img(1, 'a'), img(2, 'b')], [text(0, 't2'), img(1, 'a'), img(2, 'c'), img(3, 'd')]);
  assert.deepEqual(pairs.map(p => [p.base.hash, p.head.hash]), [['b', 'c']]);
  // A plot that was added has nothing to be compared with. Outputs carry the hash the page pairs by.
  const e = entry(fx('small.base.ipynb'), fx('small.head.ipynb'), fx('small.patch'));
  const demo = buildViewModel(e, { number: 1, title: 't', url: 'u' }).cells.find(c => c.key === 'demo')!;
  assert.deepEqual(pairImages(demo.baseOutputs, demo.headOutputs), []);
  assert.match(demo.headOutputs[1].hash, /^[0-9a-f]+$/);
});

test('pixel comparison marks what changed and boxes it, and ignores tiny differences', () => {
  const w = 4;
  const h = 3;
  const white = () => new Uint8ClampedArray(w * h * 4).fill(255);
  const before = white();
  const after = white();
  const paint = (img: Uint8ClampedArray, x: number, y: number, rgb: number[]) => img.set([...rgb, 255], (y * w + x) * 4);
  paint(after, 1, 1, [0, 0, 255]);
  paint(after, 2, 2, [0, 0, 255]);
  paint(after, 3, 0, [250, 250, 250]); // re-rendering noise
  const d = diffPixels(before, after, w, h);
  assert.equal(d.changed, 2);
  assert.deepEqual(d.box, { x: 1, y: 1, w: 2, h: 2 });
  assert.deepEqual([...d.pixels.slice((1 * w + 1) * 4, (1 * w + 1) * 4 + 4)], [255, 0, 170, 255], 'changed pixels are magenta');
  assert.deepEqual([...d.pixels.slice(0, 4)], [255, 255, 255, 255], 'unchanged white stays white');
  assert.equal(diffPixels(before, before, w, h).box, undefined);
});

test('other files: highlighted by their language, Markdown rendered', () => {
  assert.equal(fileLanguage('src/pkg/train.py'), 'python');
  assert.equal(fileLanguage('pyproject.toml'), 'ini');
  assert.equal(fileLanguage('configs/a.YAML'), 'yaml');
  assert.equal(fileLanguage('docker/Dockerfile'), 'dockerfile');
  assert.equal(fileLanguage('Makefile'), 'makefile');
  assert.equal(fileLanguage('README.md'), 'markdown');
  assert.equal(fileLanguage('LICENSE'), 'plaintext');
});

test('a changed file is one cell, with its lines diffed and counted', () => {
  const pr = { number: 7, title: 't', url: 'u' };
  const file = { filename: 'src/train.py', status: 'modified' as const, additions: 1, deletions: 1, patch: '' };
  const vm = buildFileViewModel(file, 'import os\ndef f():\n    return 1\n', 'import os\ndef f():\n    return 2\n', pr);
  assert.equal(vm.kind, 'file');
  assert.equal(vm.language, 'python');
  assert.equal(vm.cells.length, 1);
  const [c] = vm.cells;
  assert.deepEqual([c.status, c.type, c.baseId, c.headId], ['modified', 'code', 'file', 'file']);
  assert.deepEqual(c.headSource, ['import os', 'def f():', '    return 2']);
  assert.match(c.headLines[0], /hljs-keyword/, 'Python is highlighted');
  assert.deepEqual([vm.stats.additions, vm.stats.deletions], [1, 1]);

  const added = buildFileViewModel({ ...file, status: 'added' }, undefined, 'x = 1\n', pr);
  assert.equal(added.cells[0].status, 'added');
  const removed = buildFileViewModel({ ...file, status: 'removed' }, 'x = 1\n', undefined, pr);
  assert.equal(removed.cells[0].status, 'removed');

  const md = buildFileViewModel({ ...file, filename: 'README.md' }, '# Title\n\nOld words here.\n', '# Title\n\nNew words here.\n', pr);
  assert.equal(md.cells[0].type, 'markdown');
  assert.match(md.cells[0].headHtml!, /x-ins/, 'changed words are marked');

  const quiet = buildFileViewModel(file, 'x=1\n', 'x = 1\n', pr, undefined, { hideNoise: true });
  assert.equal(quiet.cells[0].noiseHidden, 'whitespace');
  const since = buildFileViewModel(file, 'a\n', 'b\n', pr, { label: 'your review' });
  assert.deepEqual(since.since, { label: 'your review' });
});

test('threads on a file sit on their lines; file comments on the whole file', () => {
  const gh = (id: string, subjectType: 'LINE' | 'FILE') => ({
    id, path: 'a.py', line: 3, startLine: null, originalLine: 3, diffSide: 'RIGHT', subjectType, isResolved: false, isOutdated: false,
    viewerCanResolve: true, viewerCanUnresolve: false,
    comments: [{ id: `${id}c`, pending: false, body: 'hi', createdAt: 'x', url: 'u', author: 'm', viewerCanUpdate: false, viewerCanDelete: false, reactions: [] }],
  });
  const threads = buildFileThreads([
    { gh: gh('T1', 'LINE'), path: 'a.py', side: 'RIGHT', docLine: 2, startDocLine: 1 },
    { gh: gh('T2', 'FILE'), path: 'a.py', side: 'RIGHT', docLine: 0, note: 'file comment' },
  ] as any, () => '');
  assert.deepEqual(threads[0].anchor, { side: 'RIGHT', cellId: 'file', kind: 'source', start: 1, end: 2 });
  assert.deepEqual(threads[1].anchor, { side: 'RIGHT', cellId: 'file', kind: 'cell' });
  assert.equal(threads[1].label, 'GitHub · file comment');
  assert.equal(threads[0].canResolve, true);
  // A comment on the whole file is a file comment on GitHub, wherever the lines are.
  const plan = planFileComment({ path: 'a.py', side: 'RIGHT', startLine: 1, endLine: 1, commentable: { left: new Set(), right: new Set([1]) }, text: 'x', wholeFile: true });
  assert.equal(plan.subjectType, 'FILE');
});

test('a changed code block in Markdown marks the changed lines, not the whole block', () => {
  const tree = ['# Layout', '', '```', 'nbs/', '  a.ipynb    Loads data', '  c.ipynb    Trains', '```'];
  const grown = ['# Layout', '', '```', 'nbs/', '  a.ipynb    Loads data', '  b.ipynb    The pitch grid', '  c.ipynb    Trains', '```'];
  const { base, head } = renderMarkdownDiff(tree, grown);
  const marked = (html: string, cls: string) => [...html.matchAll(new RegExp(`class="code-line ${cls}">([^<]*)`, 'g'))].map(m => m[1]);
  assert.deepEqual(marked(head, 'line-ins'), ['  b.ipynb    The pitch grid']);
  assert.deepEqual(marked(base, 'line-del'), []);
  assert.match(head, /<pre class="md-code-diff md-changed" data-src="2-7">/, 'the block keeps its source lines for comments');
  assert.equal((head.match(/class="code-line/g) ?? []).length, 4);
});
