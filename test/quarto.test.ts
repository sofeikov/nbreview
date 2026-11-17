import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorNames, bibliographyPaths, parseAttrs, parseBibtex, readFrontMatter } from '../src/core/quarto.ts';
import { renderDocument, renderDocumentDiff } from '../src/mdDoc.ts';
import { buildFileViewModel, fileLanguage, loadBibliography } from '../src/viewModel.ts';
import { renderMarkdownCell } from '../src/render.ts';

const fx = (name: string) => readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8');
const lines = (text: string) => text.replace(/\n$/, '').split('\n');
const bibliography = parseBibtex(fx('quarto.bib'));
const text = (html: string) => html.replace(/<[^>]+>/g, '');
const numbered = (body: string) => `---\nnumber-sections: true\n---\n\n${body}`;
const render = (src: string, bib = bibliography) => renderDocument(lines(src), { quarto: true, bibliography: bib });

test('parseAttrs reads an id, classes, values, and - for unnumbered', () => {
  assert.deepEqual(parseAttrs('#sec-a .x title="A title" -'), { id: 'sec-a', classes: ['x', 'unnumbered'], values: { title: 'A title' } });
  assert.deepEqual(parseAttrs('callout-note'), { classes: ['callout-note'], values: {} });
});

test('parseBibtex reads family names and years', () => {
  assert.deepEqual(bibliography.get('smith2020'), { authors: ['Smith', 'Doe'], year: '2020' });
  assert.deepEqual(bibliography.get('lee2019'), { authors: ['Lee', 'Lee', 'Kim'], year: '2019' });
  assert.deepEqual(bibliography.get('muller2021'), { authors: ['Muller'], year: '2021' });
  assert.deepEqual(bibliography.get('team2018'), { authors: ['Real Analytics Team'], year: '2018' });
});

test('bibliography files are found relative to the document, inside the repository', () => {
  assert.deepEqual(bibliographyPaths('docs/paper.qmd', { bibliography: 'refs.bib' }), ['docs/refs.bib']);
  assert.deepEqual(bibliographyPaths('docs/a/paper.qmd', { bibliography: ['../refs.bib', './b.bib'] }), ['docs/refs.bib', 'docs/a/b.bib']);
  assert.deepEqual(bibliographyPaths('paper.qmd', { bibliography: ['../outside.bib', '/abs.bib', 'https://x.org/a.bib', 'refs.json'] }), []);
  assert.deepEqual(bibliographyPaths('paper.qmd', undefined), []);
});

test('front matter: its keys with their lines, values as written, and dates kept as text', () => {
  const fm = readFrontMatter(lines('---\ntitle: "A: B"\nauthor:\n  - name: Jane Smith\n  - Tom\n\ndate: 2026-11-16\n---\n\nText.'));
  assert.equal(fm.lines, 8);
  assert.equal(fm.data?.date, '2026-11-16');
  assert.deepEqual(fm.fields.map(f => [f.key, f.start, f.end]), [['title', 1, 1], ['author', 2, 4], ['date', 6, 6]]);
  assert.equal(fm.fields[1].raw, '- name: Jane Smith\n- Tom');
  assert.deepEqual(authorNames(fm.data?.author), ['Jane Smith', 'Tom']);
  assert.deepEqual(authorNames({ name: { given: 'Ada', family: 'Lovelace' } }), ['Ada Lovelace']);
  assert.equal(readFrontMatter(['---', '---', 'Text']).lines, 0, 'two rules are not a front matter');
  assert.equal(readFrontMatter(['# Title']).lines, 0);
  assert.match(readFrontMatter(['---', 'title: [unclosed', '---']).error ?? '', /./);
});

test('Quarto: heading attributes go, ids stay, and sections are numbered', () => {
  const html = render(numbered('## Intro {#sec-intro}\n\n### Part\n\n## Notes {.unnumbered}\n\n## Method\n'));
  assert.match(html, /<h2 id="sec-intro" data-src="4-4"><span class="secnum">1<\/span> Intro<\/h2>/);
  assert.match(html, /<span class="secnum">1\.1<\/span> Part/);
  assert.match(html, /<h2 data-src="8-8">Notes<\/h2>/);
  assert.match(html, /<span class="secnum">2<\/span> Method/);
  assert.doesNotMatch(render('## Intro {#sec-intro}\n'), /secnum/, 'no numbers without number-sections');
  assert.match(render('---\nformat:\n  html:\n    number-sections: true\n---\n\n## A\n'), /<span class="secnum">1<\/span> A/);
});

test('Quarto: cross-references, captions, equations and citations', () => {
  const html = render(fx('quarto-old.qmd'));
  assert.match(text(html), /The method is in Section 2\./);
  assert.match(text(html), /The loss is Equation 1\. The rungs are in Table 1\./);
  assert.match(html, /<p class="tbl-cap" id="tbl-rungs" data-src="25-25"><span class="cap-label">Table 1:<\/span> The rungs<\/p>/);
  assert.match(html, /<span class="eqnum">\(1\)<\/span>/);
  assert.match(text(html), /We follow Smith and Doe \(2020\) and the set encoders of \(Lee et al\. 2019, p\. 3\)/);
  assert.match(text(html), /Write to someone@example\.com\./, 'an e-mail address is not a citation');
  assert.match(text(renderDocument(['A [@smith2020]'], { quarto: true })), /A \(smith2020\)/, 'without a bibliography a citation shows its key');
  assert.match(render('[@nobody]\n'), /<span class="cite missing" title="\[@nobody\]">\(\?nobody\)<\/span>/);
  assert.match(text(render(numbered('## A {#sec-a}\n\n@Sec-a, -@sec-a and @sec-none.\n'))), /Section 1, 1 and \?@sec-none\./);
});

test('Quarto: callouts, divs, code cells, raw blocks and shortcodes', () => {
  const callout = render('::: {.callout-warning title="Careful"}\nText.\n:::\n');
  assert.match(callout, /<div class="qdiv callout callout-warning"><div class="callout-title">Careful<\/div>\n<p data-src="1-1">Text\.<\/p>/);
  assert.match(render('::: {.panel-tabset}\nA\n:::\n'), /<div class="qdiv panel-tabset">/);
  assert.match(render('```{python}\nx = 1\n```\n'), /<div class="qcell"><div class="cell-label">python<\/div><pre><code[^>]*>x = <span class="hljs-number">1<\/span>/, 'highlighted as Python');
  assert.match(render('```{=latex}\n\\newpage\n```\n'), /<div class="qcell raw"><div class="cell-label">raw latex<\/div>/);
  assert.match(render('{{< pagebreak >}}\n'), /<code class="shortcode">\{\{&lt; pagebreak &gt;\}\}<\/code>/);
  assert.doesNotMatch(render('![A plot](plot.png){#fig-plot}\n'), /\{#fig-plot\}/);
});

test('front matter shows as a title block, each field with its own lines', () => {
  const html = render('---\ntitle: The *title*\nsubtitle: Sub\nauthor:\n  - name: Jane Smith\ndate: 2026-11-16\nformat: html\n---\n\nText.\n');
  assert.match(html, /<div class="qmd-fm qmd-title" data-src="1-1">The <em>title<\/em><\/div>/);
  assert.match(html, /<div class="qmd-fm qmd-author" data-src="3-4">Jane Smith<\/div>/);
  assert.match(html, /<div class="qmd-fm qmd-date" data-src="5-5">2026-11-16<\/div>/);
  assert.match(html, /<div class="qmd-fm qmd-meta" data-src="6-6"><span class="qmd-key">format<\/span> <code>html<\/code><\/div>/);
  assert.match(html, /<p data-src="9-9">Text\.<\/p>/, 'the body keeps the file line numbers');
  assert.doesNotMatch(html, /<h2/, 'the front matter is not read as a heading');
  // Output options are folded under their keys.
  const folded = render('---\nformat:\n  html:\n    toc: true\n  pdf:\n    toc: false\n---\n\nText.\n');
  assert.match(folded, /<div class="qmd-fm qmd-meta" data-src="1-5"><span class="qmd-key">format<\/span> <details class="qmd-more"><summary>html, pdf<\/summary><pre><code>html:\n  toc: true\npdf:\n  toc: false<\/code><\/pre><\/details><\/div>/);
  // A Markdown file gets the title block too, without the Quarto syntax.
  const md = renderDocument(lines('---\ntitle: Notes\n---\n\nSee @sec-a.'));
  assert.match(md, /qmd-title" data-src="1-1">Notes</);
  assert.match(md, /See @sec-a\./);
});

test('Quarto diff: a new section renumbers the rest, and only the edits are marked', () => {
  const { base, head } = renderDocumentDiff(lines(fx('quarto-old.qmd')), lines(fx('quarto-new.qmd')), { quarto: true, baseBibliography: bibliography, headBibliography: bibliography });
  // Each side shows its own numbers, but the renumbered reference is not marked.
  assert.match(text(base), /The method is in Section 2\./);
  assert.match(text(head), /The method is in Section 3\./);
  assert.doesNotMatch(head, /x-ins"><a class="xref/);
  assert.match(head, /<h2 id="sec-data" data-src="12-12" class="md-added">/);
  assert.match(head, /strictly/);
  assert.match(head, /<span class="x-ins">strictly<\/span>/);
  // A changed code cell keeps its label and marks its line.
  assert.match(head, /<div class="qcell"><div class="cell-label">python<\/div><pre class="md-code-diff md-changed" data-src="\d+-\d+">.*line-ins/s);
  assert.doesNotMatch(base, /class="qmd-fm[^"]* md-(changed|added|removed)/, 'an unchanged front matter is not marked');
});

test('Quarto diff marks a changed citation as one unit, and front matter fields that changed', () => {
  const { base, head } = renderDocumentDiff(
    lines('---\ntitle: Old\nformat: html\n---\n\nSee [@smith2020].'),
    lines('---\ntitle: New\nformat: html\ntoc: true\n---\n\nSee [@lee2019].'),
    { quarto: true, baseBibliography: bibliography, headBibliography: bibliography },
  );
  assert.match(base, /<span class="x-del"><span class="cite" title="\[@smith2020\]">\(Smith and Doe 2020\)<\/span><\/span>/);
  assert.match(head, /<span class="x-ins"><span class="cite" title="\[@lee2019\]">\(Lee et al\. 2019\)<\/span><\/span>/);
  assert.match(base, /qmd-title md-changed" data-src="1-1">Old/);
  assert.match(head, /qmd-title md-changed" data-src="1-1">New/);
  assert.match(head, /qmd-meta md-added" data-src="3-3"><span class="qmd-key">toc/);
  assert.match(head, /qmd-meta" data-src="2-2"><span class="qmd-key">format/);
});

test('a .qmd file is rendered as a Quarto document on the review page', async () => {
  assert.equal(fileLanguage('docs/paper.qmd'), 'quarto');
  assert.equal(fileLanguage('README.md'), 'markdown');
  const file = { filename: 'docs/paper.qmd', status: 'modified' as const, additions: 1, deletions: 1 };
  const bib = await loadBibliography('docs/paper.qmd', fx('quarto-new.qmd'), async p => (p === 'docs/quarto.bib' ? fx('quarto.bib') : undefined));
  assert.deepEqual(bib?.get('smith2020'), { authors: ['Smith', 'Doe'], year: '2020' });
  assert.equal(await loadBibliography('docs/notes.md', fx('quarto-new.qmd'), async () => fx('quarto.bib')), undefined, 'only Quarto files');
  const vm = buildFileViewModel(file, fx('quarto-old.qmd'), fx('quarto-new.qmd'), { number: 1, title: 't', url: 'u' }, undefined, { bibliography: { base: bib, head: bib } });
  const [c] = vm.cells;
  assert.equal(c.type, 'markdown');
  assert.match(c.headHtml ?? '', /Smith and Doe \(2020\)/);
  assert.match(c.headHtml ?? '', /<span class="secnum">2<\/span> Data/);
});

test('notebook Markdown cells keep plain Markdown', () => {
  assert.match(renderMarkdownCell(['## A {#sec-a}', '', 'See @sec-a.']), /A \{#sec-a\}/);
});
