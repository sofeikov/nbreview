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

const cellMd = new MarkdownIt({ html: true, linkify: true, highlight: highlightFence });
/** The renderer for notebook Markdown cells, shared with the Markdown diff. */
export const cellMarkdown = cellMd;
(cellMd as any).use((katex as any).default ?? katex, { throwOnError: false });

// Tag every block with the cell source lines it came from, so a comment on a rendered
// paragraph can be anchored to those lines.
cellMd.core.ruler.push('nbreview_source_lines', state => {
  for (const token of state.tokens) {
    if (token.map && token.nesting !== -1 && token.block) {
      token.attrSet('data-src', `${token.map[0]}-${Math.max(token.map[0], token.map[1] - 1)}`);
    }
  }
});

// Display maths is rendered by the KaTeX plugin, which drops token attributes; wrap it so it keeps
// its source lines like every other block.
for (const name of Object.keys(cellMd.renderer.rules).filter(n => n.startsWith('math_block'))) {
  const original = cellMd.renderer.rules[name]!;
  cellMd.renderer.rules[name] = (tokens, idx, options, env, self) => {
    const src = tokens[idx].attrGet('data-src');
    const cls = tokens[idx].attrGet('class');
    const html = original(tokens, idx, options, env, self);
    return src ? `<div data-src="${src}"${cls ? ` class="${cls}"` : ''}>${html}</div>` : html;
  };
}

const commentMd = new MarkdownIt({ html: true, linkify: true, breaks: true, highlight: highlightFence });

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
