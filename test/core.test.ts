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
});

test('suggestion on a middle line keeps newline and comma', () => {
  const docLine = docLineForSource(headDoc, 'loss-def', 1)!;
  const plan = planComment({ doc: headDoc, path: PATH, side: 'RIGHT', startDocLine: docLine, endDocLine: docLine, commentable, text: '```suggestion\ndef loss(x, y, *, eps=1e-9):\n```' });
  assert.match(plan.body, /```suggestion\n {4}"def loss\(x, y, \*, eps=1e-9\):\\n",\n```/);
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
