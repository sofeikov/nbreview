import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunCursor, cellCode, outputsKey, parseQuartoRun, readQuartoRun, type QuartoRun } from '../src/core/quartoRun.ts';
import { renderDocument, renderDocumentDiff } from '../src/mdDoc.ts';
import { frameDocument, frameScripts, needsFrame, withoutRunIds } from '../src/core/outputFrame.ts';
import { integrityHolds } from '../src/outputScripts.ts';
import { createHash } from 'node:crypto';

// The fixtures are a small document at two versions, and the notebooks Quarto 1.6 kept of them
// (`quarto render x.qmd --to gfm -M keep-ipynb:true`).
const fx = (name: string) => readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8');
const lines = (text: string) => text.replace(/\n$/, '').split('\n');
const text = (html: string) => html.replace(/<[^>]+>/g, '');
const baseRun = readQuartoRun(fx('quarto-run.base.ipynb'));
const headRun = readQuartoRun(fx('quarto-run.head.ipynb'));
const base = lines(fx('quarto-run.base.qmd'));
const head = lines(fx('quarto-run.head.qmd'));

test('a run has every inline expression with its value, and every cell with its outputs', () => {
  assert.deepEqual(headRun.exprs, [
    { expr: `f"{facts['shots']:,}"`, text: '12,345' },
    { expr: `facts['name']`, text: 'E1' },
    { expr: `f"{facts['ll']:.4f}"`, text: '0.2731' },
    { expr: `f"{facts['shots']:,}"`, text: '12,345' },
    { expr: 'str(10)', text: '10' },
  ]);
  assert.deepEqual(headRun.cells.map(c => c.outputs.map(o => o.kind)), [[], ['markdown'], ['image'], ['stream']]);
  // Without the option lines, which Quarto writes again (`# | label` becomes `#| label`).
  assert.ok(headRun.cells[2].code.startsWith('import matplotlib'));
  assert.equal(headRun.cells[3].outputs[0].kind === 'stream' && headRun.cells[3].outputs[0].text, 'plain text\n');
});

test('a run survives being stored, and anything else is not a run', () => {
  assert.deepEqual(parseQuartoRun(JSON.stringify(headRun)), headRun);
  assert.equal(parseQuartoRun('{"cells": 1}'), undefined);
  assert.equal(parseQuartoRun('not json'), undefined);
  assert.throws(() => readQuartoRun('{"nbformat": 4}'));
});

test('values are quoted strings without the quotes, Markdown as it is, and nothing for an error', () => {
  const nb = (result: unknown) => JSON.stringify({ cells: [{ cell_type: 'markdown', metadata: { user_expressions: [{ expression: ' x ', result }] } }] });
  const value = (result: unknown) => readQuartoRun(nb(result)).exprs[0];
  assert.deepEqual(value({ status: 'ok', data: { 'text/plain': '"it\'s"' } }), { expr: 'x', text: "it's" });
  assert.deepEqual(value({ status: 'ok', data: { 'text/plain': '42' } }), { expr: 'x', text: '42' });
  assert.deepEqual(value({ status: 'ok', data: { 'text/plain': '<M>', 'text/markdown': '**b**' } }), { expr: 'x', text: '**b**', markdown: true });
  assert.deepEqual(value({ status: 'error', ename: 'NameError' }), { expr: 'x' });
});

test('cellCode drops the option lines, however they are written', () => {
  assert.equal(cellCode('#| label: a\n# | echo: false\n\nx = 1  \ny = 2\n'), 'x = 1\ny = 2');
  assert.equal(cellCode('x = 1\n#| not: an option here'), 'x = 1\n#| not: an option here');
});

test('the cursor matches by text, in order, and leaves what the run has not', () => {
  const run: QuartoRun = {
    exprs: [{ expr: 'n', text: '1' }, { expr: 'm', text: '5' }, { expr: 'n', text: '2' }],
    cells: [{ code: 'x', outputs: [{ kind: 'text', text: 'a' }] }],
  };
  const c = new RunCursor(run);
  assert.equal(c.expr('other'), undefined);
  assert.equal(c.expr(' n ')?.text, '1');
  assert.equal(c.expr('n')?.text, '2');
  assert.equal(c.expr('n'), undefined);
  assert.equal(c.expr('m')?.text, '5');
  assert.equal(c.cell('#| echo: false\nx\n')?.outputs.length, 1);
  assert.equal(c.cell('x'), undefined);
  assert.notEqual(outputsKey(run.cells[0].outputs), outputsKey([]));
});

test('a document with a run shows the values in its sentences and the outputs of its cells', () => {
  const html = renderDocument(head, { quarto: true, context: { run: headRun } });
  assert.match(text(html), /On 12,345 shots the log loss of E1 is 0\.2731\. Again: 12,345 shots\./);
  assert.match(html, /<span class="qval" title="python: facts\['name'\]">E1<\/span>/);
  // The table the cell wrote, under its number and caption; no placeholder is left.
  assert.match(html, /<figure class="qfig" id="tbl-a"><div class="qout"><div class="qout-md"><table>/);
  assert.match(html, /<td>0\.2731<\/td>/);
  assert.match(html, /<figcaption><span class="cap-label">Table 1:<\/span> A table\.<\/figcaption>/);
  assert.match(html, /<figure class="qfig" id="fig-b"><div class="qout"><img class="qout-img" alt="" src="data:image\/png;base64,/);
  assert.match(html, /<pre class="qout-text">plain text<\/pre>/);
  assert.doesNotMatch(html, /made by this cell when the document is rendered/);
  // An output's blocks take no comments: only the document's own lines carry them.
  assert.doesNotMatch(html.slice(html.indexOf('class="qout"'), html.indexOf('</figure>')), /data-src/);
});

test('without a run the document is as before, and a run that lacks a piece says so', () => {
  const plain = renderDocument(head, { quarto: true });
  assert.match(plain, /<code class="qexpr" title="Computed when the document is rendered/);
  assert.match(plain, /Table made by this cell when the document is rendered/);
  const partial = renderDocument(head, { quarto: true, context: { run: { exprs: headRun.exprs.slice(0, 1), cells: [] } } });
  assert.match(text(partial), /On 12,345 shots/);
  assert.match(partial, /<code class="qexpr missing" title="Not in the Quarto build of this version/);
  assert.match(partial, /<div class="qfig-ph">Not in the Quarto build of this version<\/div>/);
});

test('a cell with output: false shows none, and an interactive output goes to a frame, not into the page', () => {
  const src = lines('```{python}\n#| output: false\nx\n```\n\n```{python}\ny\n```');
  const run: QuartoRun = {
    exprs: [],
    cells: [
      { code: 'x', outputs: [{ kind: 'text', text: 'hidden' }] },
      { code: 'y', outputs: [{ kind: 'html', html: '<div id="p"></div><script>draw()</script>', text: 'Figure' }, { kind: 'html', html: '<table><tr><td>1</td></tr></table>', text: '1' }] },
    ],
  };
  const html = renderDocument(src, { quarto: true, context: { run } });
  assert.doesNotMatch(html, /hidden/);
  // The output's HTML is there for the page to make a frame of, encoded: nothing of it is markup of the page.
  assert.doesNotMatch(html, /<script/);
  const holder = /<div class="qout-frame" data-frame="([^"]*)">/.exec(html);
  assert.equal(decodeURIComponent(holder?.[1] ?? ''), '<div id="p"></div><script>draw()</script>');
  assert.match(html, /<div class="qout-html html-output"><table>/);
});

test('with a run of both versions, a value that changed is marked though its source did not', () => {
  // The two versions differ in one line of the first cell; the prose is the same text.
  const d = renderDocumentDiff(base, head, { quarto: true, base: { run: baseRun }, head: { run: headRun } });
  assert.match(d.base, /<span class="x-del"><span class="qval"[^>]*>12,000<\/span><\/span>/);
  assert.match(d.head, /<span class="x-ins"><span class="qval"[^>]*>12,345<\/span><\/span>/);
  // The value that is the same on both sides is not.
  assert.doesNotMatch(d.head, /<span class="x-ins"><span class="qval"[^>]*>E1/);
  assert.match(d.head, /<span class="qval"[^>]*>E1<\/span>/);
  // The paragraph whose values are all the same is not a change.
  assert.doesNotMatch(d.head, /<p class="md-changed"[^>]*>The model reads/);
});

test('with a run of both versions, a table whose numbers changed has them marked, and its code stays folded', () => {
  const d = renderDocumentDiff(base, head, { quarto: true, base: { run: baseRun }, head: { run: headRun } });
  const table = (html: string) => html.slice(html.indexOf('id="tbl-a"'), html.indexOf('</figure>', html.indexOf('id="tbl-a"')));
  assert.match(table(d.head), /<div class="qout md-changed">/);
  assert.match(table(d.head), /<span class="x-ins">0\.2731<\/span>/);
  assert.match(table(d.base), /<span class="x-del">0\.2810<\/span>/);
  // The unchanged row is not marked.
  assert.doesNotMatch(table(d.head), /<span class="x-ins">champion/);
  // Its code didn't change, so it isn't opened or shown as a code diff.
  const cell = d.head.slice(d.head.lastIndexOf('<div class="qcell', d.head.indexOf('id="tbl-a"')), d.head.indexOf('id="tbl-a"'));
  assert.doesNotMatch(cell, /md-code-diff|<details class="qcode" open/);
  // The plot changed too; the printed text did not.
  assert.match(d.head, /id="fig-b"><div class="qout md-changed">/);
  assert.match(d.head, /<div class="qout"><pre class="qout-text">plain text/);
});

test('with a run of one version only, its values show and nothing is marked for them', () => {
  const d = renderDocumentDiff(base, head, { quarto: true, head: { run: headRun } });
  assert.match(d.head, /<span class="qval"[^>]*>12,345<\/span>/);
  assert.match(d.base, /<code class="qexpr"/);
  assert.doesNotMatch(d.head, /<span class="x-ins"><span class="qval"/);
  assert.doesNotMatch(d.head, /qout md-changed/);
});

const PLOTLY = (id: string, y: number[]) => '<div style="height:440px; width:100%;">'
  + '<script>window.PlotlyConfig = {MathJaxConfig: \'local\'};</script>\n'
  + '<script charset="utf-8" src="https://cdn.plot.ly/plotly-3.0.1.min.js" integrity="sha256-abc=" crossorigin="anonymous"></script>'
  + `<div id="${id}" class="plotly-graph-div" style="height:100%; width:100%;"></div>`
  + `<script>if (document.getElementById("${id}")) { Plotly.newPlot("${id}", [{"y":${JSON.stringify(y)}}], {}, {"responsive": true}) }</script></div>`;

test('an output needs a frame when it has a script, and loads the scripts it names over https', () => {
  assert.equal(needsFrame('<table><tr><td>1</td></tr></table>'), false);
  assert.equal(needsFrame(PLOTLY('a', [1])), true);
  assert.deepEqual(frameScripts(PLOTLY('a', [1])), [{ url: 'https://cdn.plot.ly/plotly-3.0.1.min.js', integrity: 'sha256-abc=' }]);
  // Each once, `//host` as https, and nothing that isn't on the web over https.
  assert.deepEqual(
    frameScripts('<script src="//cdn.jsdelivr.net/npm/vega@5?a=1&amp;b=2"></script><script src=\'https://cdn.plot.ly/x.js\'></script><script src="https://cdn.plot.ly/x.js"></script><script src="http://example.org/a.js"></script><script src="lib/b.js"></script><script src="file:///etc/passwd"></script>'),
    [{ url: 'https://cdn.jsdelivr.net/npm/vega@5?a=1&b=2' }, { url: 'https://cdn.plot.ly/x.js' }],
  );
});

test('the frame document gives every script the nonce, and puts the downloaded ones in as text', () => {
  const lib = 'window.Plotly = { newPlot: function () { return "</script><!-- x -->"; } };';
  const doc = frameDocument(PLOTLY('fig1', [1, 2]), new Map([['https://cdn.plot.ly/plotly-3.0.1.min.js', lib]]), 'N0nce', 7);
  // No script without the nonce, and none that the frame would have to load.
  const scripts = [...doc.matchAll(/<script\b([^>]*)>/g)].map(m => m[1]);
  assert.equal(scripts.length, 4);
  assert.ok(scripts.every(a => / nonce="N0nce"/.test(a) && !/src=/.test(a)));
  // The library's text can't end its script element early.
  assert.ok(doc.includes('return "<\\/script><\\!-- x -->"; } };</script><div id="fig1"'));
  assert.ok(doc.includes('Plotly.newPlot("fig1", [{"y":[1,2]}]'));
  assert.match(doc, /parent\.postMessage\(\{ nbreviewFrame: 7, height: h \}, '\*'\)/);
  assert.match(doc, /^<!DOCTYPE html>/);
});

test('a script that could not be downloaded, or is not on the web, is left out of the frame', () => {
  const doc = frameDocument('<script src="https://cdn.example.org/a.js"></script><script src="lib/b.js"></script><script type="module">go()</script>', new Map(), 'n', 1);
  assert.doesNotMatch(doc, /a\.js|b\.js/);
  assert.match(doc, /<script nonce="n" type="module">go\(\)<\/script>/);
});

test('two runs of the same figure differ only in the id the library made up, which does not count', () => {
  const a = PLOTLY('99a5c6d6-316c-4570-a5c7-584093b1c791', [1, 2]);
  const b = PLOTLY('bff3fcf1-736d-46de-9f4a-04470445c0b3', [1, 2]);
  const c = PLOTLY('1a739377-c29a-4a3f-aee8-911051efe7cf', [1, 3]);
  assert.equal(withoutRunIds(a), withoutRunIds(b));
  const key = (html: string) => outputsKey([{ kind: 'html', html, text: '' }]);
  assert.equal(key(a), key(b));
  assert.notEqual(key(a), key(c));

  const src = lines('```{python}\n#| echo: false\nshow(fig)\n```');
  const run = (html: string): QuartoRun => ({ exprs: [], cells: [{ code: 'show(fig)', outputs: [{ kind: 'html', html, text: '' }] }] });
  const diff = (x: string, y: string) => renderDocumentDiff(src, src, { quarto: true, base: { run: run(x) }, head: { run: run(y) } });
  assert.doesNotMatch(diff(a, b).head, /md-changed/);
  const changed = diff(a, c);
  assert.match(changed.base, /<div class="qout md-changed"><div class="qout-frame"/);
  assert.match(changed.head, /<div class="qout md-changed"><div class="qout-frame"/);
});

test('a downloaded script must have the hash its output expects, when it gives one', () => {
  const bytes = new TextEncoder().encode('window.x = 1;');
  const hash = (alg: string) => `${alg}-${createHash(alg).update(bytes).digest('base64')}`;
  assert.equal(integrityHolds(undefined, bytes), true);
  assert.equal(integrityHolds(hash('sha256'), bytes), true);
  assert.equal(integrityHolds(`sha384-AAAA ${hash('sha512')}`, bytes), true);
  assert.equal(integrityHolds(hash('sha256'), new TextEncoder().encode('window.x = 2;')), false);
  // A hash of a kind we don't know says nothing either way.
  assert.equal(integrityHolds('md5-AAAA', bytes), true);
});

test('the build command: Quarto as installed, through uv for a uv project, or the user\'s own', async () => {
  const { failureLine, hiddenPath, keptNotebook, quartoCommand, splitCommand } = await import('../src/core/quartoRun.ts');
  // Quarto leaves a file under a hidden folder out of its project; VS Code's storage is under one on Linux.
  assert.equal(hiddenPath('/home/a/.config/Code/User/globalStorage/x/builds/o/r/sha'), true);
  assert.equal(hiddenPath('C:\\Users\\a\\.vscode-server\\data'), true);
  assert.equal(hiddenPath('/tmp/nbreview-Ab12/build'), false);
  assert.equal(hiddenPath('C:\\Users\\john.doe\\AppData\\Roaming\\Code'), false);
  // The reason of a failure is Quarto's ERROR line, not the end of its stack trace.
  assert.equal(failureLine('Installed 265 packages\n\u001b[91mERROR: The --output-dir flag can only be used when rendering projects.\n\nStack trace:\n    at a (x.js:1:2)\n    at b (x.js:3:4)\u001b[39m\n'), 'ERROR: The --output-dir flag can only be used when rendering projects.');
  assert.equal(failureLine('one\ntwo\nthree\n'), 'two three');
  const tail = ['a.qmd', '--to', 'gfm', '-M', 'keep-ipynb:true', '--no-execute-daemon'];
  assert.deepEqual(quartoCommand('', 'a.qmd', false), ['quarto', 'render', ...tail]);
  assert.deepEqual(quartoCommand('', 'a.qmd', true), ['uv', 'run', 'quarto', 'render', ...tail]);
  assert.deepEqual(quartoCommand('conda run -n "my env" quarto render', 'a.qmd', true), ['conda', 'run', '-n', 'my env', 'quarto', 'render', ...tail]);
  assert.deepEqual(splitCommand(`  a 'b c'  "d"  `), ['a', 'b c', 'd']);
  assert.equal(keptNotebook('a.qmd', ['a.qmd', 'a.quarto_ipynb', 'b.quarto_ipynb']), 'a.quarto_ipynb');
  assert.equal(keptNotebook('a.qmd', ['a.qmd', 'a.quarto_ipynb_1']), 'a.quarto_ipynb_1');
  assert.equal(keptNotebook('a.qmd', ['a.qmd', 'a.ipynb']), 'a.ipynb');
  assert.equal(keptNotebook('a.qmd', ['a.qmd', 'ab.ipynb']), undefined);
});
