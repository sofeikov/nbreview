import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNotebook } from '../src/core/notebook.ts';
import { buildReviewDoc, docLineForSource, headerLine } from '../src/core/reviewDoc.ts';
import { linesText, notebookPlace, previewText } from '../src/core/pending.ts';
import { buildPendingList } from '../src/viewModel.ts';

const head = parseNotebook(readFileSync(join(process.cwd(), 'test', 'fixtures', 'small.head.ipynb'), 'utf8'));
const doc = buildReviewDoc(head);

test('a pending comment is previewed as one short line', () => {
  assert.equal(previewText('  Why not\n\n  use   `eps`?  '), 'Why not use `eps`?');
  assert.equal(previewText(''), '(empty comment)');
  const long = previewText('word '.repeat(50), 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));
});

test('lines are counted from 1 in the words of a comment place', () => {
  assert.equal(linesText(11, 11), 'line 12');
  assert.equal(linesText(11, 13), 'lines 12–14');
});

test('a notebook comment is placed by cell and line, counted from 1', () => {
  const line = docLineForSource(doc, 'loss-def', 1)!;
  assert.equal(notebookPlace(doc, line, line), 'Cell 2, line 2');
  const both = docLineForSource(doc, 'loss-def', 0)!;
  assert.equal(notebookPlace(doc, both, line), 'Cell 2, lines 1–2');
  const header = headerLine(doc, 'loss-def')!;
  assert.equal(notebookPlace(doc, header, header), 'Cell 2');
  assert.equal(notebookPlace(doc, 9999, 9999), 'notebook');
  assert.equal(notebookPlace(undefined, 0, 0), 'notebook');
});

test('the Submit review box gets each pending comment rendered, with code highlighted', () => {
  const [one, two] = buildPendingList([
    { id: 'a', threadId: 't', path: 'src/a.py', where: 'lines 3–4', reply: true, preview: '', text: 'Use **this**' },
    { id: 'b', threadId: 'u', path: 'n.ipynb', where: 'Cell 1', reply: false, preview: '', text: '```python\nx = 1\n```' },
  ]);
  assert.deepEqual({ id: one.id, path: one.path, where: one.where, reply: one.reply }, { id: 'a', path: 'src/a.py', where: 'lines 3–4', reply: true });
  assert.match(one.html, /<strong>this<\/strong>/);
  assert.match(two.html, /hljs-number/);
});
