import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  authorNames, bibliographyPaths, cellInfo, cellOptions, includePaths, inlineExpr, joinPath, mergeMeta, metaValue, parentDirs, parseAttrs,
  parseBibtex, readFrontMatter, shortcodeArgs,
} from '../src/core/quarto.ts';
import { renderDocument, renderDocumentDiff } from '../src/mdDoc.ts';
import { buildFileViewModel, fileLanguage, loadQuartoContext } from '../src/viewModel.ts';
import { renderMarkdownCell } from '../src/render.ts';

const fx = (name: string) => readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8');
const lines = (text: string) => text.replace(/\n$/, '').split('\n');
const bibliography = parseBibtex(fx('quarto.bib'));
const text = (html: string) => html.replace(/<[^>]+>/g, '');
const numbered = (body: string) => `---\nnumber-sections: true\n---\n\n${body}`;
const render = (src: string, bib = bibliography) => renderDocument(lines(src), { quarto: true, context: { bibliography: bib } });

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
  assert.match(render('```{python}\nx = 1\n```\n'), /<div class="qcell"><div class="cell-label">python<\/div><pre><code data-src="0-2" class="hljs language-python"><span class="code-line" data-src="1-1">x = <span class="hljs-number">1<\/span><\/span>/, 'highlighted as Python, line by line');
  assert.match(render('```{=latex}\n\\newpage\n```\n'), /<div class="qcell raw"><div class="cell-label">raw latex<\/div>/);
  assert.match(render('{{< pagebreak >}}\n'), /<span class="pagebreak">page break<\/span>/);
  assert.match(render('{{< lipsum 2 >}}\n'), /<code class="shortcode" title="Filled in by Quarto[^"]*">\{\{&lt; lipsum 2 &gt;\}\}<\/code>/);
  assert.doesNotMatch(render('![A plot](plot.png){#fig-plot}\n'), /\{#fig-plot\}/);
});

test('Quarto: equations, tables and figures carry the id a cross-reference scrolls to', () => {
  assert.match(render('$$\nx = 1\n$$ {#eq-one}\n\nSee @eq-one.\n'), /<div class="eq" id="eq-one">/);
  assert.match(render('| a |\n|---|\n| 1 |\n\n: Caption {#tbl-a}\n'), /<p class="tbl-cap" id="tbl-a"/);
  assert.match(render('![A plot](plot.png){#fig-plot}\n'), /<p id="fig-plot"[^>]*><img/);
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
  const { base, head } = renderDocumentDiff(lines(fx('quarto-old.qmd')), lines(fx('quarto-new.qmd')), { quarto: true, base: { bibliography }, head: { bibliography } });
  // Each side shows its own numbers, but the renumbered reference is not marked.
  assert.match(text(base), /The method is in Section 2\./);
  assert.match(text(head), /The method is in Section 3\./);
  assert.doesNotMatch(head, /x-ins"><a class="xref/);
  assert.match(head, /<h2 id="sec-data" data-src="12-12" class="md-added">/);
  assert.match(head, /strictly/);
  assert.match(head, /<span class="x-ins">strictly<\/span>/);
  // A changed code cell keeps its label and marks its line; its code isn't in the document, but a
  // change is never folded away.
  assert.match(head, /<div class="qcell code-hidden"><details class="qcode" open><summary class="cell-label">python · 2 lines · not shown in the document<\/summary><pre class="md-code-diff md-changed" data-src="\d+-\d+">.*line-ins/s);
  assert.doesNotMatch(base, /class="qmd-fm[^"]* md-(changed|added|removed)/, 'an unchanged front matter is not marked');
});

test('Quarto diff marks a changed citation as one unit, and front matter fields that changed', () => {
  const { base, head } = renderDocumentDiff(
    lines('---\ntitle: Old\nformat: html\n---\n\nSee [@smith2020].'),
    lines('---\ntitle: New\nformat: html\ntoc: true\n---\n\nSee [@lee2019].'),
    { quarto: true, base: { bibliography }, head: { bibliography } },
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
  const ctx = await loadQuartoContext('docs/paper.qmd', fx('quarto-new.qmd'), async (p: string) => (p === 'docs/quarto.bib' ? fx('quarto.bib') : undefined));
  assert.deepEqual(ctx?.bibliography?.get('smith2020'), { authors: ['Smith', 'Doe'], year: '2020' });
  assert.equal(await loadQuartoContext('docs/notes.md', fx('quarto-new.qmd'), async () => fx('quarto.bib')), undefined, 'only Quarto files');
  const vm = buildFileViewModel(file, fx('quarto-old.qmd'), fx('quarto-new.qmd'), { number: 1, title: 't', url: 'u' }, undefined, { quarto: { base: ctx, head: ctx } });
  const [c] = vm.cells;
  assert.equal(c.type, 'markdown');
  assert.match(c.headHtml ?? '', /Smith and Doe \(2020\)/);
  assert.match(c.headHtml ?? '', /<span class="secnum">2<\/span> Data/);
});

test('cell options: `#|` lines, `# |` as formatters write them, and invalid YAML', () => {
  assert.deepEqual(cellOptions('#| echo: false\n# | label: fig-a\n#|fig-cap: "A: b"\nx = 1\n#| not: this'), { echo: false, label: 'fig-a', 'fig-cap': 'A: b' });
  assert.deepEqual(cellOptions('%%| label: fig-m\nflowchart TD'), { label: 'fig-m' });
  assert.deepEqual(cellOptions('x = 1'), {});
  assert.deepEqual(cellOptions('#| a: [unclosed'), {});
});

test('cell info: echo, include and code-fold from the cell, execute: and the format', () => {
  const info = (code: string, meta?: unknown) => cellInfo('python', code, meta);
  assert.equal(info('x').code, 'shown');
  assert.equal(info('x', { execute: { echo: false } }).code, 'hidden');
  assert.equal(info('#| echo: true\nx', { execute: { echo: false } }).code, 'shown', 'the cell wins');
  assert.equal(info('#| echo: fenced\nx').code, 'shown');
  assert.equal(info('#| include: false\nx').code, 'excluded');
  assert.equal(info('x', { format: { html: { 'code-fold': true } } }).code, 'folded');
  assert.equal(info('#| code-fold: show\nx', { 'code-fold': true }).code, 'shown');
  assert.equal(cellInfo('mermaid', 'flowchart TD', undefined).diagram, true);
  assert.deepEqual(info('#| label: fig-a\n#| fig-cap: The cap\nplot()').targets, [{ id: 'fig-a', kind: 'fig', caption: 'The cap' }]);
  // A cell that writes a table names it in a string, with braces doubled in an f-string.
  const asis = info('#| output: asis\nprint(f": Rows {{#tbl-rows}}")\nprint(": Cols {#tbl-cols}")');
  assert.equal(asis.asis, true);
  assert.deepEqual(asis.targets.map(t => t.id), ['tbl-rows', 'tbl-cols']);
  assert.deepEqual(info('#| include: false\n#| label: fig-a\nx').targets, [], 'a left-out cell makes nothing');
});

test('Quarto: hidden code is folded, and figures and tables of cells are numbered with the rest', () => {
  const doc = [
    '---', 'execute:', '  echo: false', '---', '',
    'See @fig-a, @tbl-made, @tbl-lit and @fig-flow.', '',
    '```{python}', '#| label: fig-a', '#| fig-cap: "A *plot* of @tbl-lit"', 'plot()', '```', '',
    '| a |', '|---|', '| 1 |', '', ': Literal {#tbl-lit}', '',
    '```{python}', '#| output: asis', 'print(": Made {{#tbl-made}}")', '```', '',
    '```{mermaid}', '%%| label: fig-flow', '%%| fig-cap: The flow', 'flowchart TD', '```', '',
    '```{python}', '#| echo: true', 'shown = 1', '```', '',
  ].join('\n');
  const html = render(doc);
  assert.match(text(html), /See Figure 1, Table 2, Table 1 and Figure 2\./);
  assert.match(html, /<div class="qcell code-hidden"><details class="qcode"><summary class="cell-label">python · 3 lines · not shown in the document<\/summary><pre>/);
  assert.match(html, /<figure class="qfig" id="fig-a"><div class="qfig-ph">Figure made by this cell when the document is rendered<\/div><figcaption><span class="cap-label">Figure 1:<\/span> A <em>plot<\/em> of <a class="xref" href="#tbl-lit">Table 1<\/a><\/figcaption><\/figure>/);
  assert.match(html, /<figure class="qfig" id="tbl-made">.*<span class="cap-label">Table 2<\/span> <code class="qfig-id">tbl-made<\/code>/);
  assert.match(html, /<div class="qcell diagram"><div class="cell-label">mermaid diagram · drawn when the document is rendered<\/div><figure class="qfig" id="fig-flow"><pre>.*<figcaption><span class="cap-label">Figure 2:<\/span> The flow<\/figcaption>/s);
  assert.match(html, /<div class="qcell"><div class="cell-label">python<\/div><pre><code[^>]*><span class="code-line" data-src="\d+-\d+"><span class="hljs-comment">#\| echo: true<\/span><\/span><span class="code-line" data-src="\d+-\d+">shown/, 'options stay in the code under review');
  // A caption right after a cell that writes Markdown is that of the table the cell writes.
  const written = render('See @tbl-w.\n\n```{python}\n#| output: asis\nprint(table)\n```\n\n: Written {#tbl-w}\n');
  assert.match(text(written), /See Table 1\./);
  assert.match(written, /<div class="qfig-ph">Table made by this cell when the document is rendered<\/div><\/div>\n<p class="tbl-cap" id="tbl-w" data-src="7-7"><span class="cap-label">Table 1:<\/span> Written<\/p>/);
  // The project's settings count, under the document's own.
  const project = renderDocument(lines('```{python}\nx\n```\n'), { quarto: true, context: { project: { execute: { echo: false } } } });
  assert.match(project, /code-hidden/);
});

test('Quarto: inline expressions show as values to be computed', () => {
  const html = render('Covers `{python} f"{n_matches:,}"` matches and `{r} nrow(df)` rows, `not {python} code`.\n');
  assert.match(html, /<code class="qexpr" title="Computed when the document is rendered · python: f&quot;\{n_matches:,\}&quot;">n_matches<\/code>/);
  assert.match(html, /<code class="qexpr" title="[^"]*r: nrow\(df\)">nrow\(df\)<\/code>/);
  assert.equal(inlineExpr('{python} f"{x[1:2]!r:>8}"')?.short, 'x[1:2]', 'a slice is not a format spec');
  assert.equal(inlineExpr('{python} f"{d[\'a\']:.0%}"')?.short, 'd[\'a\']');
  assert.match(html, /<code>not \{python\} code<\/code>/);
  assert.equal(inlineExpr('{python} ' + 'x'.repeat(60))?.short.length, 48);
  assert.equal(inlineExpr('{python}'), undefined);
});

test('Quarto: meta, var, kbd and video shortcodes; includes in place', () => {
  const ctx = {
    path: 'docs/a/paper.qmd',
    projectDir: 'docs',
    vars: { version: '1.2', org: { name: 'RA' } },
    includes: new Map([['docs/a/_part.qmd', '## Included {#sec-inc}\n\nFrom the part.\n'], ['docs/_shared.qmd', 'Shared.\n']]),
  };
  const src = '---\ntitle: The paper\n---\n\n{{< meta title >}} v{{< var version >}} by {{< var org.name >}}, {{< meta nope >}}. Press {{< kbd Ctrl-C >}}.\n\n'
    + '{{< include _part.qmd >}}\n\n{{< include /_shared.qmd >}}\n\n{{< include missing.qmd >}}\n';
  const html = renderDocument(lines(src), { quarto: true, context: ctx });
  assert.match(text(html), /The paper v1\.2 by RA, \{\{&lt; meta nope &gt;\}\}\. Press Ctrl-C\./);
  assert.match(html, /<code class="shortcode missing" title="Not found: from the front matter and the project">/);
  assert.match(html, /<div class="qinclude" data-src="6-6"><div class="qinclude-label">Included from <code>docs\/a\/_part\.qmd<\/code><\/div><h2 id="sec-inc">Included<\/h2>\n<p>From the part\.<\/p>/);
  assert.match(html, /Included from <code>docs\/_shared\.qmd<\/code><\/div><p>Shared\.<\/p>/);
  assert.match(html, /<div class="qinclude missing" data-src="10-10"><div class="qinclude-label">Includes <code>docs\/a\/missing\.qmd<\/code>, which isn't in the repository/);
  assert.match(render('{{< video https://youtu.be/x >}}\n'), /<a class="shortcode-video" href="https:\/\/youtu\.be\/x">Video: https:\/\/youtu\.be\/x<\/a>/);
});

test('Quarto: layout and conditional divs say what they do', () => {
  assert.match(render('::: {.panel-tabset}\n## A\n:::\n'), /<div class="qdiv panel-tabset"><div class="qdiv-label">Tabs: each heading below is a tab<\/div>/);
  assert.match(render('::: {.content-visible when-format="html"}\nX\n:::\n'), /Only in html output/);
  assert.match(render('::: {.content-hidden unless-format="pdf"}\nX\n:::\n'), /Only in pdf output/);
  assert.match(render('::: {.column-margin}\nX\n:::\n'), /In the margin/);
  assert.match(render('::: {.column width="40%"}\nX\n:::\n'), /<div class="qdiv column" style="flex: 0 1 40%">/);
  assert.match(render('::: {layout-ncol=2}\nX\n:::\n'), /style="display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 12px"/);
  assert.match(render('::: {.column width="calc(1)"}\nX\n:::\n'), /<div class="qdiv column">/, 'only plain widths');
});

test('a Quarto file reads its project, directory metadata, variables and includes', async () => {
  const files: Record<string, string> = {
    'docs/_quarto.yml': 'project:\n  type: default\nexecute:\n  echo: false\nbibliography: refs/all.bib\n',
    'docs/reports/_metadata.yml': 'number-sections: true\n',
    'docs/_variables.yml': 'version: 3\n',
    'docs/refs/all.bib': fx('quarto.bib'),
    'docs/reports/_inc.qmd': 'Inc {{< include _deeper.qmd >}}\n\n{{< include _deeper.qmd >}}\n',
    'docs/reports/_deeper.qmd': 'Deeper.\n',
  };
  const read: string[] = [];
  const ctx = await loadQuartoContext('docs/reports/r.qmd', '# R\n\n{{< include _inc.qmd >}}\n', async (p: string) => {
    read.push(p);
    return files[p];
  });
  assert.equal(ctx?.projectDir, 'docs');
  assert.deepEqual(ctx?.project, { execute: { echo: false }, bibliography: 'refs/all.bib', 'number-sections': true });
  assert.deepEqual(ctx?.vars, { version: 3 });
  assert.ok(ctx?.bibliography?.has('smith2020'), 'the project\'s bibliography, relative to the project');
  assert.deepEqual([...ctx!.includes!.keys()], ['docs/reports/_inc.qmd', 'docs/reports/_deeper.qmd']);
  assert.ok(!read.includes('_metadata.yml'), 'directory metadata only from the project down');
  const html = renderDocument(lines('# R {#sec-r}\n\n{{< include _inc.qmd >}}\n'), { quarto: true, context: ctx });
  assert.match(html, /<span class="secnum">1<\/span> R/, 'number-sections from _metadata.yml');
  assert.match(html, /<p>Deeper\.<\/p>/);
  assert.equal(await loadQuartoContext('x.qmd', 'Text', async () => undefined).then(c => c?.projectDir), undefined);
});

test('project helpers: folders, paths, includes and merged metadata', () => {
  assert.deepEqual(parentDirs('docs/a/x.qmd'), ['docs/a', 'docs', '']);
  assert.deepEqual(parentDirs('x.qmd'), ['']);
  assert.equal(joinPath('docs/a', '../b/c.qmd'), 'docs/b/c.qmd');
  assert.equal(joinPath('', '../x'), undefined);
  assert.deepEqual(includePaths('docs/a/x.qmd', '{{< include b.qmd >}} {{< include "/c d.qmd" >}} {{< include b.qmd >}}', 'docs'), ['docs/a/b.qmd', 'docs/c d.qmd']);
  assert.deepEqual(mergeMeta({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] } }, undefined), { a: { b: 1, c: [2] }, d: 1 });
  assert.deepEqual(shortcodeArgs('{{< kbd mac=Cmd "Ctrl C" >}}'), ['kbd', 'mac=Cmd', 'Ctrl C']);
  assert.equal(metaValue({ a: { b: 'x' } }, 'a.b'), 'x');
  assert.equal(metaValue({ a: 'x' }, 'a.b'), undefined);
});

test('notebook Markdown cells keep plain Markdown', () => {
  assert.match(renderMarkdownCell(['## A {#sec-a}', '', 'See @sec-a.']), /A \{#sec-a\}/);
});
