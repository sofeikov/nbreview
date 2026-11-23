// HTML rendering for the visual review page: markdown with maths, syntax-highlighted code split
// into lines, and comment bodies. Output is sanitized again inside the webview.
import MarkdownIt from 'markdown-it';
import katex from '@vscode/markdown-it-katex';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import json from 'highlight.js/lib/languages/json';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import makefile from 'highlight.js/lib/languages/makefile';
import r from 'highlight.js/lib/languages/r';
import { quartoPlugin } from './core/quarto.ts';

type Token = ReturnType<MarkdownIt['parse']>[number];

// Python for notebooks; the rest for the other files of a pull request (see fileLanguage).
for (const [name, language] of Object.entries({ python, bash, sql, yaml, json, ini, dockerfile, javascript, typescript, xml, css, makefile, r })) {
  hljs.registerLanguage(name, language);
}

function highlightFence(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  }
  return '';
}

/**
 * A code block as highlighted lines, each with its source line (`data-src`): `skip` is the number
 * of lines before the code, 1 for the opening fence. The block keeps its own source lines on `<code>`.
 */
function codeBlockHtml(t: Token, lang: string, skip: number, quarto: boolean): string {
  const lines = t.content.replace(/\n$/, '').split('\n');
  const known = !!lang && !!hljs.getLanguage(lang);
  const first = t.map ? t.map[0] + skip : undefined;
  return codeLinesHtml(highlightLines(lines, known ? lang : 'plaintext'), first, [], {
    pre: mermaidAttr(t, quarto),
    code: [...(t.attrs ?? []).filter(([k]) => k !== 'class'), ['class', ['hljs', known ? `language-${lang}` : '', t.attrGet('class') ?? ''].filter(Boolean).join(' ')]],
  });
}

/**
 * ` data-mermaid="…"` with the diagram's source when a code block is a Mermaid diagram, which the
 * review page draws below the code: a ```mermaid block in Markdown, as GitHub draws it, and a
 * `{mermaid}` cell in Quarto, as Quarto does (a plain ```mermaid block stays code there).
 */
export function mermaidAttr(t: Token, quarto: boolean): string {
  const cell = (t.meta as { cell?: { lang: string; diagram: boolean; code: string } } | null)?.cell;
  const mermaid = quarto
    ? !!cell?.diagram && cell.lang.toLowerCase() === 'mermaid' && cell.code !== 'excluded'
    : t.type === 'fence' && t.info.trim().split(/\s+/)[0].toLowerCase() === 'mermaid';
  // Encoded, as the page's sanitizer drops an attribute with `-->` in it, and every arrow has one.
  return mermaid ? ` data-mermaid="${encodeURIComponent(t.content)}"` : '';
}

/**
 * Highlighted lines in a `<pre>`: each line a `code-line` span with its source line when `first`
 * is known, and the class in `marks[i]` (a changed line) when given.
 */
export function codeLinesHtml(lines: string[], first: number | undefined, marks: (string | undefined)[], attrs: { pre: string; code: [string, string][] }): string {
  const body = lines
    .map((line, i) => `<span class="code-line${marks[i] ? ` ${marks[i]}` : ''}"${first !== undefined ? ` data-src="${first + i}-${first + i}"` : ''}>${line || '&#8203;'}</span>`)
    .join('');
  const code = attrs.code.map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
  return `<pre${attrs.pre}><code${code}>${body}</code></pre>\n`;
}

/**
 * A parser for Markdown that is shown on the review page (notebook cells, Markdown and Quarto
 * files), with maths, and with the source lines of every block (see below).
 */
function documentMarkdown(quarto = false): MarkdownIt {
  const md = new MarkdownIt({ html: true, linkify: true, highlight: highlightFence });
  (md as any).use((katex as any).default ?? katex, { throwOnError: false });

  // Tag every block with the cell source lines it came from, so a comment on a rendered
  // paragraph can be anchored to those lines. A comment lands on the last line of its range, so
  // the range must end on the block's own text: markdown-it counts the blank lines after a list
  // item as part of it, and a list item's lines include its nested list.
  md.core.ruler.push('nbreview_source_lines', state => {
    const lines = state.src.split('\n');
    state.tokens.forEach((token, i) => {
      if (!token.map || token.nesting === -1 || !token.block) {
        return;
      }
      let [start, end] = [token.map[0], token.map[1] - 1];
      const first = state.tokens[i + 1];
      if (token.type === 'list_item_open' && first?.type === 'paragraph_open' && first.map) {
        [start, end] = [first.map[0], first.map[1] - 1];
      }
      while (end > start && !lines[end]?.trim()) {
        end--;
      }
      token.attrSet('data-src', `${start}-${Math.max(start, end)}`);
    });
  });

  // A code block is drawn line by line, each line with its own source line, so a comment can go on
  // one line of it, as on a line of a code cell. (The KaTeX plugin is set up without fenced maths,
  // so a ```math block is code here too.)
  md.renderer.rules.fence = (tokens, idx) => codeBlockHtml(tokens[idx], tokens[idx].info.trim().split(/\s+/)[0] ?? '', 1, quarto);
  md.renderer.rules.code_block = (tokens, idx) => codeBlockHtml(tokens[idx], '', 0, quarto);

  // Display maths is rendered by the KaTeX plugin, which drops token attributes; wrap it so it keeps
  // its source lines like every other block.
  for (const name of Object.keys(md.renderer.rules).filter(n => n.startsWith('math_block'))) {
    const original = md.renderer.rules[name]!;
    md.renderer.rules[name] = (tokens, idx, options, env, self) => {
      const src = tokens[idx].attrGet('data-src');
      const cls = tokens[idx].attrGet('class');
      const html = original(tokens, idx, options, env, self);
      return src ? `<div data-src="${src}"${cls ? ` class="${cls}"` : ''}>${html}</div>` : html;
    };
  }
  return md;
}

const cellMd = documentMarkdown();
/** The renderer for notebook Markdown cells and Markdown files, shared with the Markdown diff. */
export const cellMarkdown = cellMd;

/** The renderer for Quarto (.qmd) files: Markdown with Quarto's syntax (see core/quarto.ts). */
export const quartoMarkdown = documentMarkdown(true);
quartoPlugin(quartoMarkdown);

const commentMd = new MarkdownIt({ html: true, linkify: true, breaks: true, highlight: highlightFence });

// GitHub's flavour for pull request descriptions and conversation comments: task lists, links
// for #123 and @someone, and the commonest emoji shortcodes.
const githubMd = new MarkdownIt({ html: true, linkify: true, breaks: true, highlight: highlightFence });

const EMOJI: Record<string, string> = {
  '+1': '👍', '-1': '👎', thumbsup: '👍', thumbsdown: '👎', tada: '🎉', rocket: '🚀', eyes: '👀', heart: '❤️', fire: '🔥',
  smile: '😄', laughing: '😆', confused: '😕', thinking: '🤔', pray: '🙏', clap: '👏', wave: '👋', ok_hand: '👌', raised_hands: '🙌',
  point_left: '👈', point_right: '👉', point_up: '☝️', point_down: '👇', warning: '⚠️', white_check_mark: '✅', heavy_check_mark: '✔️',
  x: '❌', bug: '🐛', sparkles: '✨', memo: '📝', bulb: '💡', construction: '🚧', '100': '💯', boom: '💥', zap: '⚡', lock: '🔒',
  question: '❓', exclamation: '❗', star: '⭐', package: '📦', wrench: '🔧', hammer: '🔨', recycle: '♻️', art: '🎨', chart_with_upwards_trend: '📈',
  bar_chart: '📊', notebook: '📓', snake: '🐍', test_tube: '🧪', broom: '🧹', lipstick: '💄', see_no_evil: '🙈', sweat_smile: '😅', joy: '😂',
};

const REF_RE = /(^|[^\w/&#@.-])(?:#(\d+)|@([A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38})|:([\w+-]+):)(?![\w-])/g;

githubMd.core.ruler.push('nbreview_github', state => {
  const repoUrl: string | undefined = state.env?.repoUrl;
  state.tokens.forEach((block, i) => {
    if (block.type !== 'inline' || !block.children) {
      return;
    }
    // "- [x] done" as a ticked box, like GitHub's (read-only) task lists.
    const first = block.children[0];
    const task = first?.type === 'text' && state.tokens[i - 2]?.type === 'list_item_open' ? /^\[([ xX])\]\s/.exec(first.content) : null;
    if (task) {
      first.content = first.content.slice(task[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<span class="task-box${task[1] === ' ' ? '' : ' done'}" aria-label="${task[1] === ' ' ? 'not done' : 'done'}"></span>`;
      block.children.unshift(box);
      state.tokens[i - 2].attrJoin('class', 'task-item');
    }
    let inLink = 0;
    const out: typeof block.children = [];
    for (const t of block.children) {
      if (t.type === 'link_open') {
        inLink++;
      } else if (t.type === 'link_close') {
        inLink--;
      }
      if (t.type !== 'text' || inLink || !REF_RE.test(t.content)) {
        REF_RE.lastIndex = 0;
        out.push(t);
        continue;
      }
      REF_RE.lastIndex = 0;
      const html = escapeHtml(t.content).replace(REF_RE, (whole, lead: string, issue?: string, login?: string, emoji?: string) => {
        if (issue && repoUrl) {
          return `${lead}<a class="ref" href="${repoUrl}/issues/${issue}">#${issue}</a>`;
        }
        if (login) {
          return `${lead}<a class="mention" href="https://github.com/${login}">@${login}</a>`;
        }
        if (emoji && EMOJI[emoji]) {
          return `${lead}${EMOJI[emoji]}`;
        }
        return whole;
      });
      const token = new state.Token('html_inline', '', 0);
      token.content = html;
      out.push(token);
    }
    block.children = out;
  });
});

/** A pull request description or conversation comment, rendered as github.com does (mostly). */
export function renderGitHubMarkdown(text: string, repoUrl?: string): string {
  return githubMd.render(text, { repoUrl });
}

export function renderMarkdownCell(source: string[]): string {
  return cellMd.render(source.join('\n'));
}

export function renderCommentBody(text: string): string {
  return commentMd.render(text);
}

/**
 * Highlights a whole cell (so multi-line strings and docstrings are coloured correctly) and splits
 * the result into one HTML fragment per line, closing and reopening spans at line breaks.
 */
export function highlightLines(source: string[], language: string): string[] {
  if (!source.length) {
    return [];
  }
  const code = source.join('\n');
  const html = hljs.getLanguage(language)
    ? hljs.highlight(code, { language, ignoreIllegals: true }).value
    : escapeHtml(code);
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  const tagRe = /<\/?span[^>]*>|\n/g;
  let last = 0;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    current += html.slice(last, m.index);
    last = m.index + m[0].length;
    const tag = m[0];
    if (tag === '\n') {
      lines.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else if (tag.startsWith('</')) {
      open.pop();
      current += tag;
    } else {
      open.push(tag);
      current += tag;
    }
  }
  current += html.slice(last);
  lines.push(current);
  return lines;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
