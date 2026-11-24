// Markdown and Quarto files on the review page: the YAML front matter as a title block, and the
// body rendered, or diffed, with the right parser. The page puts comment buttons and change bars
// on top-level blocks that carry their source lines (`data-src`), so each field of the front
// matter is one such block, and the body is parsed with the front matter blanked out so its
// line numbers stay those of the file.
import type MarkdownIt from 'markdown-it';
import { cellMarkdown, escapeHtml, quartoMarkdown } from './render.ts';
import { renderMarkdownDiff } from './mdDiff.ts';
import { authorNames, blankFrontMatter, mergeMeta, readFrontMatter, type FrontMatter, type FrontMatterField, type QuartoContext } from './core/quarto.ts';

export interface DocOptions {
  /** Read Quarto's syntax (a .qmd file). */
  quarto?: boolean;
  /** For a Quarto file: its project, bibliography and included files. */
  context?: QuartoContext;
}

/** The fields of a title block, in the order Quarto shows them. */
const TITLE_BLOCK = ['title', 'subtitle', 'author', 'date', 'abstract'];

/** HTML of one version of a Markdown or Quarto file. */
export function renderDocument(source: string[], options: DocOptions = {}): string {
  const md = options.quarto ? quartoMarkdown : cellMarkdown;
  const fm = readFrontMatter(source);
  const env = docEnv(fm, options.context);
  return frontMatterHtml(md, fm, new Map(), env) + md.render(blankFrontMatter(source, fm).join('\n'), env);
}

/** HTML of both versions of a Markdown or Quarto file, with the changes marked. */
export function renderDocumentDiff(
  base: string[],
  head: string[],
  options: { quarto?: boolean; base?: QuartoContext; head?: QuartoContext } = {},
): { base: string; head: string } {
  const md = options.quarto ? quartoMarkdown : cellMarkdown;
  const fmA = readFrontMatter(base);
  const fmB = readFrontMatter(head);
  // With a Quarto build of both versions, their values and outputs are compared too.
  const compare = !!options.base?.run && !!options.head?.run;
  const baseEnv = { ...docEnv(fmA, options.base), quartoCompare: compare };
  const headEnv = { ...docEnv(fmB, options.head), quartoCompare: compare };
  const diff = renderMarkdownDiff(blankFrontMatter(base, fmA), blankFrontMatter(head, fmB), { md, baseEnv, headEnv });
  return {
    base: frontMatterHtml(md, fmA, fieldMarks(fmA, fmB, 'md-removed'), baseEnv) + diff.base,
    head: frontMatterHtml(md, fmB, fieldMarks(fmB, fmA, 'md-added'), headEnv) + diff.head,
  };
}

/**
 * The parser env of one version: the project's metadata under the front matter's, which is what
 * section numbers and cell options read, the bibliography, and the rest of the context.
 */
function docEnv(fm: FrontMatter, context: QuartoContext | undefined): Record<string, unknown> {
  return {
    frontMatter: context?.project ? mergeMeta(context.project, fm.data) : fm.data,
    bibliography: context?.bibliography,
    quartoContext: context,
  };
}

/** The fields of one side that changed: `md-changed`, or `alone` when the other side hasn't the key. */
function fieldMarks(own: FrontMatter, other: FrontMatter, alone: string): Map<FrontMatterField, string> {
  const marks = new Map<FrontMatterField, string>();
  for (const f of own.fields) {
    const o = other.fields.find(x => x.key === f.key);
    if (!o) {
      marks.set(f, alone);
    } else if (o.text !== f.text) {
      marks.set(f, 'md-changed');
    }
  }
  return marks;
}

function frontMatterHtml(md: MarkdownIt, fm: FrontMatter, marks: Map<FrontMatterField, string>, env: Record<string, unknown>): string {
  if (!fm.lines) {
    return '';
  }
  const titled = fm.data ? TITLE_BLOCK.flatMap(k => fm.fields.filter(f => f.key === k)) : [];
  const rest = fm.fields.filter(f => !titled.includes(f));
  const block = (f: FrontMatterField, cls: string, inner: string) => {
    const mark = marks.get(f);
    return `<div class="qmd-fm ${cls}${mark ? ` ${mark}` : ''}" data-src="${f.start}-${f.end}">${inner}</div>\n`;
  };
  const inline = (text: string) => md.renderInline(text, { ...env });
  let html = '';
  if (fm.error) {
    html += `<p class="qmd-fm-error">The front matter isn't valid YAML: ${escapeHtml(fm.error)}</p>\n`;
  }
  for (const f of titled) {
    const value = fm.data![f.key];
    if (f.key === 'author') {
      const names = authorNames(value);
      html += block(f, 'qmd-author', names.length ? names.map(escapeHtml).join(', ') : rawHtml(f));
    } else if (f.key === 'date') {
      // As written: `today` and `last-modified` are Quarto's, and a date isn't reformatted.
      html += block(f, 'qmd-date', escapeHtml(f.raw.replace(/^(["'])(.*)\1$/s, '$2')));
    } else if (typeof value !== 'string' && typeof value !== 'number') {
      html += block(f, `qmd-meta`, `<span class="qmd-key">${escapeHtml(f.key)}</span> ${rawHtml(f)}`);
    } else if (f.key === 'abstract') {
      const paragraphs = String(value).split(/\n\s*\n/).map(p => `<p>${inline(p.trim())}</p>`).join('');
      html += block(f, 'qmd-abstract', `<div class="qmd-abstract-label">Abstract</div>${paragraphs}`);
    } else {
      html += block(f, `qmd-${f.key}`, inline(String(value)));
    }
  }
  for (const f of rest) {
    html += block(f, 'qmd-meta', `<span class="qmd-key">${escapeHtml(f.key)}</span> ${rawHtml(f)}`);
  }
  return `${html}<hr class="qmd-fm-end">\n`;
}

/**
 * A field's value as written: one line as code. More lines (output options such as `format:`)
 * are folded under a summary of their keys, since Quarto doesn't show them either.
 */
function rawHtml(f: FrontMatterField): string {
  if (!f.raw.includes('\n')) {
    return `<code>${escapeHtml(f.raw)}</code>`;
  }
  const lines = f.raw.split('\n');
  const keys = lines.flatMap(l => /^([^\s#'"-][^:]*?):(?:\s|$)/.exec(l)?.[1] ?? []);
  const items = lines.filter(l => /^-(\s|$)/.test(l)).length;
  const summary = keys.length ? keys.join(', ') : items ? `${items} item${items === 1 ? '' : 's'}` : `${lines.length} lines`;
  return `<details class="qmd-more"><summary>${escapeHtml(summary)}</summary><pre><code>${escapeHtml(f.raw)}</code></pre></details>`;
}
