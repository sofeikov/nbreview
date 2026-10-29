import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNotebook } from '../src/core/notebook.ts';
import { buildReviewDoc, docLineForSource, headerLine } from '../src/core/reviewDoc.ts';
import { parsePatch } from '../src/core/patch.ts';
import {
  replaceBodyText,
  locateNotebookThread,
  matchExportedLine,
  nbdevSourceForLine,
  parseBody,
  planComment,
} from '../src/core/anchor.ts';
import { isCommentFilter, showsThread } from '../src/core/commentFilter.ts';

const fx = (name: string) => readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8');
const base = parseNotebook(fx('small.base.ipynb'));
const head = parseNotebook(fx('small.head.ipynb'));
const baseDoc = buildReviewDoc(base);
const headDoc = buildReviewDoc(head);
const commentable = parsePatch(fx('small.patch'));
const PATH = 'nbs/losses.ipynb';

test('source lines know their raw JSON line', () => {
  const cell = head.cells[1];
  assert.equal(cell.id, 'loss-def');
  assert.deepEqual(cell.source, ['#| export', 'def loss(x, y, eps=1e-9):', '    return (x - y) ** 2 + eps']);
  const raw = fx('small.head.ipynb').split('\n');
  assert.match(raw[cell.jsonLines[1] - 1], /def loss\(x, y, eps=1e-9\)/);
});

test('review document has headers, source and output summaries', () => {
  const text = headDoc.text.split('\n');
  assert.match(text[0], /^━━━ markdown · intro ━+$/);
  assert.ok(text.includes('def loss(x, y, eps=1e-9):'));
  assert.ok(text.includes('  ▸ out: stream stdout'));
  assert.ok(text.includes('  │ 0.250000001'));
  assert.ok(text.some(l => /▸ out: image\/png 640×480 #[0-9a-f]{8}/.test(l)));
});

test('patch parsing lists commentable lines per side', () => {
  assert.ok(commentable.right.has(head.cells[1].jsonLines[1]));
  assert.ok(commentable.left.has(base.cells[1].jsonLines[1]));
  assert.ok(!commentable.right.has(1));
});

test('comment on a changed code line becomes a line comment on the ipynb', () => {
  const docLine = docLineForSource(headDoc, 'loss-def', 1)!;
  const plan = planComment({ doc: headDoc, path: PATH, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, commentable, text: 'Why eps here?' });
  assert.equal(plan.subjectType, 'LINE');
  assert.equal(plan.line, head.cells[1].jsonLines[1]);
  assert.equal(plan.startLine, undefined);
  const parsed = parseBody(plan.body);
  assert.deepEqual(parsed.marker, { v: 1, cell: 'loss-def', side: 'RIGHT', kind: 'source', start: 1, end: 1 });
  assert.equal(parsed.text, 'Why eps here?');
  assert.match(plan.body, /cell 2 · `loss-def` · code · line 2/);
  assert.match(plan.body, /> def loss\(x, y, eps=1e-9\):/);
});

test('multi-line selection inside the diff uses startLine', () => {
  const a = docLineForSource(headDoc, 'loss-def', 1)!;
  const plan = planComment({ doc: headDoc, path: PATH, side: 'RIGHT', startDocLine: a, endDocLine: a + 1, commentable, text: 'x' });
  assert.equal(plan.startLine, head.cells[1].jsonLines[1]);
  assert.equal(plan.line, head.cells[1].jsonLines[2]);
});

test('markdown line outside the diff falls back to a file comment that keeps the cell', () => {
  const big = buildReviewDoc(head);
  const docLine = docLineForSource(big, 'intro', 0)!; // "# Losses" is context, but pretend no diff
  const plan = planComment({ doc: big, path: PATH, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, commentable: { left: new Set(), right: new Set() }, text: 'Title?' });
  assert.equal(plan.subjectType, 'FILE');
  assert.equal(parseBody(plan.body).marker?.cell, 'intro');
});

test('comment on an output line is a cell comment', () => {
  const docLine = headDoc.lines.findIndex(l => l.kind === 'output' && l.output?.kind === 'image');
  const plan = planComment({ doc: headDoc, path: PATH, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, commentable, text: 'Axis labels?' });
  assert.equal(parseBody(plan.body).marker?.kind, 'output');
  assert.equal(plan.subjectType, 'FILE'); // first source line of "demo" is not in the diff
});

test('suggestions are re-encoded as notebook JSON lines', () => {
  const docLine = docLineForSource(headDoc, 'loss-def', 2)!;
  const plan = planComment({
    doc: headDoc, path: PATH, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, commentable,
    text: 'Use a clamp:\n```suggestion\n    d = x - y\n    return d * d + eps\n```',
  });
  assert.equal(plan.subjectType, 'LINE');
  assert.match(plan.body, /```suggestion\n {4}"    d = x - y\\n",\n {4}"    return d \* d \+ eps"\n```/);
  // Read back, the reviewer sees and edits the code they wrote, and editing encodes it only once.
  const text = parseBody(plan.body).text;
  assert.equal(text, 'Use a clamp:\n```suggestion\n    d = x - y\n    return d * d + eps\n```');
  const again = planComment({ doc: headDoc, path: PATH, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, commentable, text });
  assert.equal(again.body, plan.body);
});

test('a suggestion without the marker (a reply, or a comment from github.com) is left as written', () => {
  const body = 'Like this:\n```suggestion\n"just a string",\n```';
  assert.equal(parseBody(body).text, body);
});

test('suggestion on a middle line keeps newline and comma', () => {
  const docLine = docLineForSource(headDoc, 'loss-def', 1)!;
  const plan = planComment({ doc: headDoc, path: PATH, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, commentable, text: '```suggestion\ndef loss(x, y, *, eps=1e-9):\n```' });
  assert.match(plan.body, /```suggestion\n {4}"def loss\(x, y, \*, eps=1e-9\):\\n",\n```/);
});

test('a suggestion on lines only partly in the diff is not committable', () => {
  // Only the last line can carry the comment, and committing would replace it with all three.
  const cell = head.cells[1];
  const partial = { left: new Set<number>(), right: new Set([cell.jsonLines[2]]) };
  const plan = planComment({
    doc: headDoc, path: PATH, side: 'RIGHT', commentable: partial,
    startDocLine: docLineForSource(headDoc, 'loss-def', 0)!, endDocLine: docLineForSource(headDoc, 'loss-def', 2)!,
    text: '```suggestion\n#| export\ndef loss(x, y):\n    return (x - y) ** 2\n```',
  });
  assert.equal(plan.line, cell.jsonLines[2]);
  assert.equal(plan.startLine, undefined);
  assert.doesNotMatch(plan.body, /```suggestion/);
  assert.match(plan.body, /```python\n#\| export\ndef loss/);
});

const inlineNotebook = (source: string | string[]) => parseNotebook(JSON.stringify({
  cells: [{ cell_type: 'markdown', id: 'md', metadata: {}, source }],
  metadata: {}, nbformat: 4, nbformat_minor: 5,
}, null, 1));
const allLines = (nb: ReturnType<typeof parseNotebook>) => ({ left: new Set<number>(), right: new Set(nb.rawLines.map((_, i) => i + 1)) });

test('a suggestion keeps the dollar signs it was written with', () => {
  const nb = inlineNotebook(['$$a + b$$\n', 'Cost in $&.']);
  const doc = buildReviewDoc(nb);
  const docLine = docLineForSource(doc, 'md', 0)!;
  const text = '```suggestion\n$$a - b$$ and $& and $1\n```';
  const plan = planComment({ doc, path: PATH, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, commentable: allLines(nb), text });
  assert.ok(plan.body.includes('```suggestion\n    "$$a - b$$ and $& and $1\\n",\n```'));
  assert.equal(parseBody(plan.body).text, text);
});

test('a suggestion on a cell stored as one string is not committable', () => {
  // The whole source is on one raw line, so committing would replace every line of the cell.
  const nb = inlineNotebook('a = 1\nb = 2\n');
  const doc = buildReviewDoc(nb);
  const docLine = docLineForSource(doc, 'md', 1)!;
  const plan = planComment({ doc, path: PATH, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, commentable: allLines(nb), text: '```suggestion\nb = 3\n```' });
  assert.equal(plan.subjectType, 'LINE');
  assert.doesNotMatch(plan.body, /```suggestion/);
});

test('threads are put back on their cell by marker, by JSON line, or at the top', () => {
  const docLine = docLineForSource(headDoc, 'loss-def', 1)!;
  const plan = planComment({ doc: headDoc, path: PATH, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, commentable, text: 'hi' });
  const t = { line: plan.line!, startLine: null, originalLine: plan.line!, diffSide: 'RIGHT' as const, subjectType: 'LINE', isOutdated: false };
  assert.deepEqual(locateNotebookThread({ ...t, body: plan.body }, { base: baseDoc, head: headDoc }), { side: 'RIGHT', docLine, note: undefined });
  assert.equal(locateNotebookThread({ ...t, body: 'plain comment' }, { base: baseDoc, head: headDoc })?.docLine, docLine);
  assert.equal(locateNotebookThread({ ...t, subjectType: 'FILE', body: 'x' }, { base: baseDoc, head: headDoc })?.docLine, 0);
  assert.equal(headerLine(headDoc, 'intro'), 0);
});

test('nbdev markers map .py lines to notebook cells', () => {
  const py = [
    '# AUTOGENERATED! DO NOT EDIT! File to edit: ../../nbs/losses.ipynb.',
    '',
    '# %% auto #0',
    "__all__ = ['loss']",
    '',
    '# %% ../../nbs/losses.ipynb #loss-def',
    'def loss(x, y, eps=1e-9):',
    '    return (x - y) ** 2 + eps',
  ].join('\n');
  const src = nbdevSourceForLine('src/pkg/losses.py', py, 8)!;
  assert.equal(src.notebookPath, 'nbs/losses.ipynb');
  assert.equal(src.cellId, 'loss-def');
  assert.equal(matchExportedLine(head.cells[1], src), 2);
  const old = nbdevSourceForLine('src/pkg/losses.py', py.replace('#loss-def', '1'), 7)!;
  assert.equal(old.cellId, 'index-1');
});

test('output comments remember which output, and come back on it', () => {
  const imageLine = headDoc.lines.findIndex(l => l.kind === 'output' && l.output?.kind === 'image');
  const plan = planComment({ doc: headDoc, path: PATH, side: 'RIGHT', startDocLine: imageLine, endDocLine: imageLine, commentable, text: 'Axis labels?' });
  assert.equal(parseBody(plan.body).marker?.outputIndex, 1);
  const where = locateNotebookThread(
    { line: null, startLine: null, originalLine: null, diffSide: 'RIGHT', subjectType: 'FILE', isOutdated: false, body: plan.body },
    { base: baseDoc, head: headDoc },
  );
  assert.equal(where?.docLine, imageLine);
});

test('multi-line comments come back with their whole range', () => {
  const a = docLineForSource(headDoc, 'loss-def', 1)!;
  const plan = planComment({ doc: headDoc, path: PATH, side: 'RIGHT', startDocLine: a, endDocLine: a + 1, commentable, text: 'x' });
  const where = locateNotebookThread(
    { line: plan.line!, startLine: plan.startLine!, originalLine: plan.line!, diffSide: 'RIGHT', subjectType: 'LINE', isOutdated: false, body: plan.body },
    { base: baseDoc, head: headDoc },
  );
  assert.deepEqual([where?.startDocLine, where?.docLine], [a, a + 1]);
});

test('editing a comment keeps its cell header and marker', () => {
  const docLine = docLineForSource(headDoc, 'loss-def', 1)!;
  const plan = planComment({ doc: headDoc, path: PATH, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, commentable, text: 'old' });
  const edited = replaceBodyText(plan.body, 'new text');
  assert.equal(parseBody(edited).text, 'new text');
  assert.deepEqual(parseBody(edited).marker, parseBody(plan.body).marker);
  assert.equal(replaceBodyText('a plain reply', 'changed'), 'changed');
});

import { locateFileThread, planFileComment } from '../src/core/fileComments.ts';

test('comments on ordinary files: line comments in the diff, file comments outside it', () => {
  const commentable = { left: new Set([3, 4]), right: new Set([10, 11, 12]) };
  const line = planFileComment({ path: 'src/a.py', side: 'RIGHT', startLine: 11, endLine: 11, commentable, text: 'x' });
  assert.deepEqual([line.subjectType, line.line, line.startLine, line.body], ['LINE', 11, undefined, 'x']);
  const range = planFileComment({ path: 'src/a.py', side: 'RIGHT', startLine: 10, endLine: 12, commentable, text: 'x' });
  assert.deepEqual([range.line, range.startLine], [12, 10]);
  const partly = planFileComment({ path: 'src/a.py', side: 'RIGHT', startLine: 8, endLine: 11, commentable, text: 'x' });
  assert.deepEqual([partly.subjectType, partly.line, partly.startLine], ['LINE', 11, undefined]);
  const outside = planFileComment({ path: 'src/a.py', side: 'RIGHT', startLine: 40, endLine: 40, commentable, text: 'x' });
  assert.equal(outside.subjectType, 'FILE');
  const old = planFileComment({ path: 'src/a.py', side: 'LEFT', startLine: 4, endLine: 4, commentable, text: 'x' });
  assert.deepEqual([old.subjectType, old.side, old.line], ['LINE', 'LEFT', 4]);
});

test('threads on ordinary files go on their own line', () => {
  const base = { startLine: null, originalLine: 7, diffSide: 'RIGHT' as const, subjectType: 'LINE', isOutdated: false };
  assert.deepEqual(locateFileThread({ ...base, line: 7 }), { side: 'RIGHT', docLine: 6 });
  assert.deepEqual(locateFileThread({ ...base, line: 9, startLine: 7 }), { side: 'RIGHT', docLine: 8, startDocLine: 6 });
  assert.deepEqual(locateFileThread({ ...base, line: null, isOutdated: true }), { side: 'RIGHT', docLine: 6, note: 'outdated' });
  assert.deepEqual(locateFileThread({ ...base, line: null, subjectType: 'FILE' }), { side: 'RIGHT', docLine: 0, note: 'file comment' });
});

import { allFolders, buildFolderTree, treeOrder } from '../src/paths.ts';

test('changed files group into folders, single-folder chains merged', () => {
  const root = buildFolderTree([
    'src/pkg/models/graph.py', 'src/pkg/models/gnn.py', 'src/pkg/trainer.py',
    'configs/a.yaml', 'tests/test_x.py', 'pyproject.toml', 'nbs/steps/val.ipynb',
  ]);
  assert.deepEqual(root.folders.map(f => f.name), ['configs', 'nbs/steps', 'src/pkg', 'tests']);
  assert.deepEqual(root.files, ['pyproject.toml']);
  const pkg = root.folders.find(f => f.name === 'src/pkg')!;
  assert.deepEqual(pkg.folders.map(f => [f.name, f.path]), [['models', 'src/pkg/models']]);
  assert.deepEqual(pkg.files, ['src/pkg/trainer.py']);
  assert.deepEqual(treeOrder(root), [
    'configs/a.yaml', 'nbs/steps/val.ipynb', 'src/pkg/models/gnn.py', 'src/pkg/models/graph.py', 'src/pkg/trainer.py', 'tests/test_x.py', 'pyproject.toml',
  ]);
});

test('every folder at every level, with all the files below it', () => {
  const folders = allFolders(['tests/unit/test_a.py', 'tests/unit/test_b.py', 'tests/test_c.ipynb', 'src/pkg/m.py', 'README.md']);
  assert.deepEqual(folders, [
    { path: 'src', files: ['src/pkg/m.py'] },
    { path: 'src/pkg', files: ['src/pkg/m.py'] },
    { path: 'tests', files: ['tests/unit/test_a.py', 'tests/unit/test_b.py', 'tests/test_c.ipynb'] },
    { path: 'tests/unit', files: ['tests/unit/test_a.py', 'tests/unit/test_b.py'] },
  ]);
});

test('the Comments filter shows all threads, the unresolved ones, or none', () => {
  const thread = (isResolved: boolean, ...pending: boolean[]) => ({ isResolved, comments: pending.map(p => ({ pending: p })) });
  const open = thread(false, false);
  const resolved = thread(true, false, false);
  assert.deepEqual([open, resolved].map(t => showsThread('all', t)), [true, true]);
  assert.deepEqual([open, resolved].map(t => showsThread('unresolved', t)), [true, false]);
  assert.deepEqual([open, resolved].map(t => showsThread('none', t)), [false, false]);
});

test('threads with a pending comment of the viewer show whatever the filter', () => {
  const newThread = { isResolved: false, comments: [{ pending: true }] };
  const replyToResolved = { isResolved: true, comments: [{ pending: false }, { pending: true }] };
  for (const filter of ['all', 'unresolved', 'none'] as const) {
    assert.equal(showsThread(filter, newThread), true);
    assert.equal(showsThread(filter, replyToResolved), true);
  }
});

test('only the three Comments filters are accepted', () => {
  assert.deepEqual(['all', 'unresolved', 'none', 'resolved', undefined, 1].map(isCommentFilter), [true, true, true, false, false, false]);
});
