// Quarto syntax on top of Markdown, for .qmd files on the review page: attributes of headings,
// section numbers, cross-references, table captions, equation labels, citations, fenced divs,
// code cells and shortcodes. Also the YAML front matter of Markdown and Quarto files.
//
// Nothing runs Quarto. The rules imitate the text Quarto shows, close enough for a review. They
// come from the author's mdiff extension (src/core/quarto.ts there). Numbers and citations are
// resolved when a document is parsed, one document at a time, so each side of a diff shows its
// own numbers. The diff compares a cross-reference or a citation by its source (see mdDiff.ts),
// so a new section that renumbers the ones after it doesn't mark the references to them.
import type MarkdownIt from 'markdown-it';
import yaml from 'js-yaml';

type Token = ReturnType<MarkdownIt['parse']>[number];
type CoreRule = Parameters<MarkdownIt['core']['ruler']['push']>[1];
type BlockRule = Parameters<MarkdownIt['block']['ruler']['push']>[1];
type InlineRule = Parameters<MarkdownIt['inline']['ruler']['push']>[1];
type StateCore = Parameters<CoreRule>[0];
type StateBlock = Parameters<BlockRule>[0];
// `linkLevel` (above zero inside the text of a link) is missing from the type definitions.
type StateInline = Parameters<InlineRule>[0] & { linkLevel?: number };
type RendererRule = NonNullable<MarkdownIt['renderer']['rules'][string]>;

/** The author names and year of each entry of a bibliography, by key. */
export type Bibliography = Map<string, { authors: string[]; year: string }>;

/** What a cross-reference can point to. */
interface Target {
  /** For example `Section`, `Table`. */
  prefix: string;
  /** The number, or undefined for an unnumbered section. */
  num?: string;
  /** The heading text, for an unnumbered section. */
  title?: string;
}

/** The state of the Quarto rules for one document, in the parser env. */
interface QuartoState {
  /** Equation labels by the 0-based line of the closing `$$`. */
  eqLabels: Map<number, string>;
  targets: Map<string, Target>;
}

const XREF_PREFIXES: Record<string, string> = {
  sec: 'Section',
  fig: 'Figure',
  tbl: 'Table',
  eq: 'Equation',
  lst: 'Listing',
  thm: 'Theorem',
  lem: 'Lemma',
  cor: 'Corollary',
  prp: 'Proposition',
  cnj: 'Conjecture',
  def: 'Definition',
  exm: 'Example',
  exr: 'Exercise',
  sol: 'Solution',
  rem: 'Remark',
  alg: 'Algorithm',
};

const CALLOUTS = new Set(['note', 'tip', 'warning', 'important', 'caution']);

/** A citation key: Pandoc allows some punctuation inside a key, but not at its end. */
const KEY = /[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&\-+?<>~/]*[\p{L}\p{N}_])?/uy;

/** `{...}` at the end of a heading or a caption. */
const TRAILING_ATTRS = /\s*\{([^{}]*)\}\s*$/;

export interface Attrs {
  id?: string;
  classes: string[];
  values: Record<string, string>;
}

/** Parses Pandoc attributes, for example `#sec-x .unnumbered title="A title"`. A bare word is a class. */
export function parseAttrs(text: string): Attrs {
  const out: Attrs = { classes: [], values: {} };
  const re = /([\w-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))|#(\S+)|\.(\S+)|(\S+)/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) {
      out.values[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
    } else if (m[5]) {
      out.id = m[5];
    } else if (m[6]) {
      out.classes.push(m[6]);
    } else if (m[7] === '-') {
      out.classes.push('unnumbered');
    } else if (m[7]) {
      out.classes.push(m[7]);
    }
  }
  return out;
}

function state(env: Record<string, unknown>): QuartoState {
  let s = env.quarto as QuartoState | undefined;
  if (!s) {
    s = { eqLabels: new Map(), targets: new Map() };
    env.quarto = s;
  }
  return s;
}

/** True when the front matter asks for section numbers, at the top level or in one of its formats. */
function numberSections(frontMatter: unknown): boolean {
  if (!frontMatter || typeof frontMatter !== 'object') {
    return false;
  }
  const fm = frontMatter as Record<string, unknown>;
  if (fm['number-sections'] === true) {
    return true;
  }
  const format = fm.format;
  if (format && typeof format === 'object') {
    return Object.values(format).some(f => !!f && typeof f === 'object' && (f as Record<string, unknown>)['number-sections'] === true);
  }
  return false;
}

// Front matter -----------------------------------------------------------------------------------

/** One top-level key of the front matter, with its source lines (0-based, inclusive). */
export interface FrontMatterField {
  key: string;
  start: number;
  end: number;
  /** The field's source, its key included, to compare the two versions. */
  text: string;
  /** The value as written: the rest of the key's line and the lines under it. */
  raw: string;
}

export interface FrontMatter {
  /** The lines the front matter takes, with its `---` lines; 0 when there is none. */
  lines: number;
  data?: Record<string, unknown>;
  error?: string;
  fields: FrontMatterField[];
}

/**
 * Reads the YAML front matter at the top of a Markdown or Quarto file. Dates are kept as text
 * (the core schema has no timestamps), so `2026-11-16` shows as written.
 */
export function readFrontMatter(source: string[]): FrontMatter {
  if (!/^---[ \t]*$/.test(source[0] ?? '')) {
    return { lines: 0, fields: [] };
  }
  const close = source.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
  // A `---` right after the first one is a horizontal rule, not an empty front matter.
  if (close < 2) {
    return { lines: 0, fields: [] };
  }
  const body = source.slice(1, close);
  const fm: FrontMatter = { lines: close + 1, fields: [] };
  try {
    const data = yaml.load(body.join('\n'), { schema: yaml.CORE_SCHEMA });
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      fm.data = data as Record<string, unknown>;
    } else if (data !== undefined && data !== null) {
      fm.error = 'The front matter is not a list of keys.';
    }
  } catch (e) {
    fm.error = e instanceof Error ? e.message.split('\n')[0] : String(e);
  }
  for (let i = 1; i < close; i++) {
    const m = /^([^\s#'"-][^:]*?|"[^"]*"|'[^']*'):(?:[ \t]|$)(.*)$/.exec(source[i]);
    if (!m) {
      continue;
    }
    let end = i;
    while (end + 1 < close && (/^[ \t]|^-[ \t]|^-$|^#/.test(source[end + 1]) || !source[end + 1].trim())) {
      end++;
    }
    while (end > i && !source[end].trim()) {
      end--;
    }
    const rest = source.slice(i + 1, end + 1);
    const raw = [m[2].trim(), ...rest].filter((l, k) => k > 0 || l).join('\n');
    fm.fields.push({ key: m[1].replace(/^["']|["']$/g, ''), start: i, end, text: source.slice(i, end + 1).join('\n'), raw: dedent(raw) });
    i = end;
  }
  return fm;
}

function dedent(text: string): string {
  const lines = text.split('\n');
  const indent = Math.min(...lines.filter(l => l.trim()).map(l => /^[ \t]*/.exec(l)![0].length));
  return Number.isFinite(indent) && indent > 0 ? lines.map(l => l.slice(indent)).join('\n') : text;
}

/** The source with its front matter turned into blank lines, so the parser's line numbers stay right. */
export function blankFrontMatter(source: string[], fm: FrontMatter): string[] {
  return fm.lines ? [...new Array<string>(fm.lines).fill(''), ...source.slice(fm.lines)] : source;
}

/** The names in an `author` value: a name, a list of names, or objects with a `name`, as Quarto writes them. */
export function authorNames(value: unknown): string[] {
  const one = (v: unknown): string | undefined => {
    if (typeof v === 'string' || typeof v === 'number') {
      return String(v);
    }
    if (v && typeof v === 'object') {
      const name = (v as Record<string, unknown>).name;
      if (typeof name === 'string') {
        return name;
      }
      if (name && typeof name === 'object') {
        const n = name as Record<string, unknown>;
        return typeof n.literal === 'string' ? n.literal : [n.given, n.family].filter(x => typeof x === 'string').join(' ') || undefined;
      }
    }
    return undefined;
  };
  return (Array.isArray(value) ? value : [value]).map(one).filter((x): x is string => !!x);
}

// Bibliography ---------------------------------------------------------------------------------

/** The BibTeX files that the front matter names, relative to the repository root. */
export function bibliographyPaths(docPath: string, frontMatter: Record<string, unknown> | undefined): string[] {
  const b = frontMatter?.bibliography;
  const names = typeof b === 'string' ? [b] : Array.isArray(b) ? b.filter((x): x is string => typeof x === 'string') : [];
  const dir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')).split('/') : [];
  const out: string[] = [];
  for (const name of names) {
    // A URL or an absolute path can't be read from the pull request.
    if (!/\.bib$/i.test(name) || /^([a-z]+:|\/)/i.test(name)) {
      continue;
    }
    const parts = [...dir];
    let ok = true;
    for (const p of name.split('/')) {
      if (p === '..') {
        ok = parts.pop() !== undefined;
      } else if (p && p !== '.') {
        parts.push(p);
      }
      if (!ok) {
        break;
      }
    }
    if (ok) {
      out.push(parts.join('/'));
    }
  }
  return out;
}

/** Reads the author names and the year of each entry of a BibTeX file. Other fields are ignored. */
export function parseBibtex(text: string): Bibliography {
  const bib: Bibliography = new Map();
  const entry = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  for (let m = entry.exec(text); m; m = entry.exec(text)) {
    if (/^(comment|string|preamble)$/i.test(m[1])) {
      continue;
    }
    const fields = new Map<string, string>();
    let i = entry.lastIndex;
    // Fields: name = {value} | "value" | bare, up to the closing brace of the entry.
    const field = /\s*([\w-]+)\s*=\s*/y;
    for (;;) {
      field.lastIndex = i;
      const f = field.exec(text);
      if (!f) {
        break;
      }
      i = field.lastIndex;
      let value = '';
      if (text[i] === '{') {
        let depth = 0;
        const start = i;
        for (; i < text.length; i++) {
          if (text[i] === '{') {
            depth++;
          } else if (text[i] === '}' && --depth === 0) {
            break;
          }
        }
        value = text.slice(start + 1, i);
        i++;
      } else if (text[i] === '"') {
        const end = text.indexOf('"', i + 1);
        value = text.slice(i + 1, end < 0 ? text.length : end);
        i = end < 0 ? text.length : end + 1;
      } else {
        const bare = /[^,}\s]*/y;
        bare.lastIndex = i;
        value = bare.exec(text)![0];
        i = bare.lastIndex;
      }
      fields.set(f[1].toLowerCase(), value);
      while (i < text.length && /\s/.test(text[i])) {
        i++;
      }
      if (text[i] !== ',') {
        break;
      }
      i++;
    }
    entry.lastIndex = i;
    const names = fields.get('author') ?? fields.get('editor') ?? '';
    const authors = names ? names.split(/\s+and\s+/).map(lastName).filter(Boolean) : [];
    const year = (fields.get('year') ?? fields.get('date') ?? '').match(/\d{4}/)?.[0] ?? 'n.d.';
    bib.set(m[2], { authors, year });
  }
  return bib;
}

/** The family name of a BibTeX name: `Last, First` or `First Last`. Braces and accents are removed. */
function lastName(name: string): string {
  const clean = name
    .replace(/\\[`'^"~=.]\{?(\w)\}?/g, '$1')
    .replace(/[{}]/g, '')
    .trim();
  if (clean.includes(',')) {
    return clean.split(',')[0].trim();
  }
  // A braced name such as {Real Analytics} is one name.
  if (/^\{[^{}]*\}$/.test(name.trim())) {
    return clean;
  }
  const words = clean.split(/\s+/);
  return words[words.length - 1];
}

function authorText(authors: string[]): string {
  if (authors.length <= 1) {
    return authors[0] ?? '';
  }
  return authors.length === 2 ? `${authors[0]} and ${authors[1]}` : `${authors[0]} et al.`;
}

// Parser rules ---------------------------------------------------------------------------------

/** The meta of a `quarto_xref` token. */
interface XrefMeta {
  refs: { id: string; suppress: boolean }[];
  text?: string;
  missing?: boolean;
}

/** The meta of a `quarto_cite` token. */
interface CiteMeta {
  items: CiteItem[];
  bracket: boolean;
  text?: string;
  missing?: boolean;
}

interface CiteItem {
  prefix: string;
  suppress: boolean;
  key: string;
  suffix: string;
}

/**
 * The text of a citation, in the author-date style of Quarto's default. Without a bibliography
 * (none named, or none that could be read) a citation shows its keys.
 */
function citeText(items: CiteItem[], bracket: boolean, bib: Bibliography | undefined): { text: string; missing: boolean } {
  let missing = false;
  const one = (it: CiteItem, inText: boolean) => {
    if (!bib) {
      return it.key;
    }
    const e = bib.get(it.key);
    if (!e) {
      missing = true;
      return `?${it.key}`;
    }
    const who = authorText(e.authors) || it.key;
    if (it.suppress) {
      return e.year;
    }
    return inText ? `${who} (${e.year})` : `${who} ${e.year}`;
  };
  if (!bracket) {
    return { text: one(items[0], true), missing };
  }
  const parts = items.map(it => [it.prefix.trim(), one(it, false)].filter(Boolean).join(' ') + it.suffix.replace(/\s+$/, ''));
  return { text: `(${parts.join('; ')})`, missing };
}

function xrefKind(key: string): string | undefined {
  const m = /^([A-Za-z]+)-/.exec(key);
  return m && XREF_PREFIXES[m[1].toLowerCase()] ? m[1].toLowerCase() : undefined;
}

/** Core rule before `block`: removes the `{#eq-…}` label after a closing `$$`, which the KaTeX plugin doesn't read. */
function eqLabelsRule(s: StateCore): void {
  if (!s.src.includes('{#eq-')) {
    return;
  }
  const labels = state(s.env);
  const lines = s.src.split('\n');
  lines.forEach((line, k) => {
    const m = /^(.*\$\$)[ \t]*\{#(eq-[^}\s]+)\}[ \t]*$/.exec(line);
    if (m) {
      labels.eqLabels.set(k, m[2]);
      lines[k] = m[1];
    }
  });
  s.src = lines.join('\n');
}

/**
 * Core rule between `block` and `inline`: reads the attributes of headings, table captions,
 * images and divs, and numbers sections, tables, figures and equations in document order.
 */
function blocksRule(s: StateCore): void {
  const q = state(s.env);
  const tokens = s.tokens;
  const numbered = numberSections(s.env.frontMatter);
  const count: Record<string, number> = {};
  const next = (kind: string) => String((count[kind] = (count[kind] ?? 0) + 1));
  const register = (id: string | undefined, target: Target) => {
    if (id && !q.targets.has(id)) {
      q.targets.set(id, target);
    }
  };

  // Section numbers start at the highest heading level of the body, as Quarto does.
  let top = 7;
  for (const t of tokens) {
    if (t.type === 'heading_open') {
      top = Math.min(top, Number(t.tag.slice(1)));
    }
  }
  const counters: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const inline = tokens[i + 1]?.type === 'inline' ? tokens[i + 1] : undefined;
    if (tok.type === 'heading_open' && inline) {
      const m = TRAILING_ATTRS.exec(inline.content);
      const attrs: Attrs = m ? parseAttrs(m[1]) : { classes: [], values: {} };
      if (m) {
        inline.content = inline.content.slice(0, m.index);
      }
      if (attrs.id) {
        tok.attrSet('id', attrs.id);
      }
      let num: string | undefined;
      if (numbered && !attrs.classes.includes('unnumbered')) {
        const depth = Number(tok.tag.slice(1)) - top;
        counters.length = depth + 1;
        for (let d = 0; d < depth; d++) {
          counters[d] ??= 0;
        }
        counters[depth] = (counters[depth] ?? 0) + 1;
        num = counters.join('.');
      }
      tok.meta = { ...tok.meta, secnum: num };
      if (attrs.id?.startsWith('sec-')) {
        register(attrs.id, { prefix: XREF_PREFIXES.sec, num, title: inline.content.trim() });
      }
    } else if (tok.type === 'paragraph_open' && inline && isCaption(tokens, i, inline)) {
      let content = inline.content.replace(/^(?:Table)?:\s+/, '');
      const m = TRAILING_ATTRS.exec(content);
      const id = m ? parseAttrs(m[1]).id : undefined;
      if (m) {
        content = content.slice(0, m.index);
      }
      inline.content = content;
      tok.attrSet('class', 'tbl-cap');
      const num = id?.startsWith('tbl-') ? next('tbl') : undefined;
      tok.meta = { ...tok.meta, caption: num ? `Table ${num}` : undefined };
      if (id && num) {
        tok.attrSet('id', id);
        register(id, { prefix: XREF_PREFIXES.tbl, num });
      }
    } else if (tok.type === 'math_block' && tok.map) {
      const label = q.eqLabels.get(tok.map[1] - 1);
      if (label) {
        const num = next('eq');
        tok.meta = { ...tok.meta, eqnum: num };
        register(label, { prefix: XREF_PREFIXES.eq, num });
      }
    } else if (tok.type === 'quarto_div_open') {
      const id = (tok.meta as { attrs: Attrs }).attrs.id;
      const kind = id ? xrefKind(id) : undefined;
      if (id && kind && kind !== 'sec') {
        register(id, { prefix: XREF_PREFIXES[kind], num: next(kind) });
      }
    } else if (tok.type === 'inline' && tok.content.includes('){#fig-')) {
      // A figure: ![caption](path){#fig-x}. Remove the attributes, which markdown-it shows as text.
      tok.content = tok.content.replace(/(!\[[^\]]*\]\([^)]*\))\{([^}]*)\}/g, (_all, image: string, text: string) => {
        const id = parseAttrs(text).id;
        if (id?.startsWith('fig-')) {
          register(id, { prefix: XREF_PREFIXES.fig, num: next('fig') });
        }
        return image;
      });
    }
  }
}

/** A paragraph that starts with `: ` or `Table: ` right before or after a table is its caption. */
function isCaption(tokens: Token[], open: number, inline: Token): boolean {
  if (!/^(?:Table)?:\s/.test(inline.content)) {
    return false;
  }
  return tokens[open - 1]?.type === 'table_close' || tokens[open + 3]?.type === 'table_open';
}

/** Core rule after `inline`: resolves cross-references and citations to their text. */
function resolveRule(s: StateCore): void {
  const q = state(s.env);
  const bib = s.env.bibliography as Bibliography | undefined;
  for (const tok of s.tokens) {
    if (tok.type !== 'inline') {
      continue;
    }
    for (const child of tok.children ?? []) {
      if (child.type === 'quarto_xref') {
        const meta = child.meta as XrefMeta;
        meta.text = meta.refs
          .map(({ id, suppress }) => {
            const t = q.targets.get(id);
            if (!t) {
              meta.missing = true;
              return `?@${id}`;
            }
            if (t.num === undefined) {
              return t.title ?? id;
            }
            return suppress ? t.num : `${t.prefix} ${t.num}`;
          })
          .join('; ');
      } else if (child.type === 'quarto_cite') {
        const meta = child.meta as CiteMeta;
        const r = citeText(meta.items, meta.bracket, bib);
        meta.text = r.text;
        meta.missing = r.missing;
      }
    }
  }
}

/** Reads one citation item: `prefix @key suffix` or `prefix -@key suffix`. */
function citeItem(text: string): CiteItem | undefined {
  const at = /(^|[\s(])(-?)@/.exec(text);
  if (!at) {
    return undefined;
  }
  KEY.lastIndex = at.index + at[1].length + at[2].length + 1;
  const key = KEY.exec(text);
  if (!key) {
    return undefined;
  }
  return { prefix: text.slice(0, at.index + at[1].length), suppress: at[2] === '-', key: key[0], suffix: text.slice(KEY.lastIndex) };
}

/** Inline rule: `[@key; see @other, p. 3]`, `[@sec-x]`. Runs before `link`. */
function bracketRule(s: StateInline, silent: boolean): boolean {
  if (s.src.charCodeAt(s.pos) !== 0x5b /* [ */ || (s.linkLevel ?? 0) > 0) {
    return false;
  }
  const end = s.src.indexOf(']', s.pos);
  if (end < 0) {
    return false;
  }
  const body = s.src.slice(s.pos + 1, end);
  if (!body.includes('@') || body.includes('[')) {
    return false;
  }
  // `[text](url)` and `[text][ref]` are links.
  const after = s.src.charCodeAt(end + 1);
  if (after === 0x28 /* ( */ || after === 0x5b /* [ */) {
    return false;
  }
  const items: CiteItem[] = [];
  for (const part of body.split(';')) {
    const item = citeItem(part);
    if (!item) {
      return false;
    }
    items.push(item);
  }
  if (!silent) {
    const raw = s.src.slice(s.pos, end + 1);
    if (items.every(it => xrefKind(it.key))) {
      pushXref(s, items.map(it => ({ id: it.key, suppress: it.suppress })));
    } else {
      pushCite(s, items, true, raw);
    }
  }
  s.pos = end + 1;
  return true;
}

/** Inline rule: `@key`, `-@key`, `@sec-x`, `@Sec-x`. Not inside a word, so an e-mail address is text. */
function atRule(s: StateInline, silent: boolean): boolean {
  let pos = s.pos;
  const c = s.src.charCodeAt(pos);
  // Not inside the text of a link.
  if ((c !== 0x40 /* @ */ && c !== 0x2d /* - */) || (s.linkLevel ?? 0) > 0) {
    return false;
  }
  const suppress = c === 0x2d;
  if (suppress) {
    if (s.src.charCodeAt(pos + 1) !== 0x40) {
      return false;
    }
    pos++;
  }
  const before = s.pos > 0 ? s.src[s.pos - 1] : '';
  if (/[\p{L}\p{N}_\\]/u.test(before)) {
    return false;
  }
  KEY.lastIndex = pos + 1;
  const key = KEY.exec(s.src);
  if (!key) {
    return false;
  }
  if (!silent) {
    const raw = s.src.slice(s.pos, KEY.lastIndex);
    if (xrefKind(key[0])) {
      pushXref(s, [{ id: key[0], suppress }]);
    } else {
      pushCite(s, [{ prefix: '', suppress, key: key[0], suffix: '' }], false, raw);
    }
  }
  s.pos = KEY.lastIndex;
  return true;
}

function pushXref(s: StateInline, refs: { id: string; suppress: boolean }[]): void {
  // Quarto writes ids as given, but `@Sec-x` points to `sec-x`.
  const norm = refs.map(r => ({ ...r, id: r.id.replace(/^[A-Z][a-z]*-/, p => p.toLowerCase()) }));
  const tok = s.push('quarto_xref', '', 0);
  // The content is what the diff compares: the ids, not the numbers they show.
  tok.content = norm.map(r => (r.suppress ? '-' : '') + r.id).join(';');
  tok.meta = { refs: norm } satisfies XrefMeta;
}

function pushCite(s: StateInline, items: CiteItem[], bracket: boolean, raw: string): void {
  const tok = s.push('quarto_cite', '', 0);
  tok.content = raw;
  tok.meta = { items, bracket } satisfies CiteMeta;
}

/** Inline rule: a shortcode, `{{< name args >}}`, shown as it is written. */
function shortcodeRule(s: StateInline, silent: boolean): boolean {
  if (!s.src.startsWith('{{<', s.pos)) {
    return false;
  }
  const end = s.src.indexOf('>}}', s.pos + 3);
  if (end < 0) {
    return false;
  }
  if (!silent) {
    s.push('quarto_shortcode', '', 0).content = s.src.slice(s.pos, end + 3);
  }
  s.pos = end + 3;
  return true;
}

/** Block rule: a fenced div, `::: {.callout-note}` … `:::`. Divs nest. */
function divRule(s: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (s.sCount[startLine] - s.blkIndent >= 4) {
    return false;
  }
  const lineText = (n: number) => s.src.slice(s.bMarks[n] + s.tShift[n], s.eMarks[n]);
  const open = /^(:{3,})\s*(.*?)\s*:*\s*$/.exec(lineText(startLine));
  if (!open || !open[2]) {
    return false;
  }
  if (silent) {
    return true;
  }

  let depth = 0;
  let close = startLine + 1;
  let found = false;
  for (; close < endLine; close++) {
    // A line with less indent than the div ends it, as for other containers.
    if (s.bMarks[close] + s.tShift[close] < s.eMarks[close] && s.sCount[close] < s.blkIndent) {
      break;
    }
    const text = lineText(close);
    if (/^:{3,}\s*$/.test(text)) {
      if (depth === 0) {
        found = true;
        break;
      }
      depth--;
    } else if (/^:{3,}\s*\S/.test(text)) {
      depth++;
    }
  }

  const info = open[2].replace(/^\{(.*)\}$/, '$1');
  const oldParent = s.parentType;
  const oldMax = s.lineMax;
  s.parentType = 'quarto_div' as typeof s.parentType;
  s.lineMax = close;
  const tokOpen = s.push('quarto_div_open', 'div', 1);
  tokOpen.markup = open[1];
  tokOpen.info = info;
  tokOpen.block = true;
  tokOpen.map = [startLine, close + (found ? 1 : 0)];
  tokOpen.meta = { attrs: parseAttrs(info) };
  s.md.block.tokenize(s, startLine + 1, close);
  const tokClose = s.push('quarto_div_close', 'div', -1);
  tokClose.markup = open[1];
  tokClose.block = true;
  s.parentType = oldParent;
  s.lineMax = oldMax;
  s.line = close + (found ? 1 : 0);
  return true;
}

/** How a fenced div shows: a callout box, the generated reference list, or only its content. */
function divKind(tok: Token): { kind: 'callout'; type: string; title: string } | { kind: 'refs' } | { kind: 'plain' } {
  const attrs = (tok.meta as { attrs: Attrs }).attrs;
  if (attrs.id === 'refs') {
    return { kind: 'refs' };
  }
  for (const c of attrs.classes) {
    const m = /^callout-(\w+)$/.exec(c);
    if (m && CALLOUTS.has(m[1])) {
      return { kind: 'callout', type: m[1], title: attrs.values.title ?? m[1][0].toUpperCase() + m[1].slice(1) };
    }
  }
  return { kind: 'plain' };
}

/** The label of a code cell or a raw block, for example `python` or `raw latex`; empty for a plain fence. */
export function fenceLabel(info: string, esc: (s: string) => string): string {
  const m = /^\{(=?)([\w.+-]+)[^}]*\}/.exec(info.trim());
  return m ? `<div class="cell-label">${m[1] ? 'raw ' : ''}${esc(m[2])}</div>` : '';
}

/** The language of a fence, without the braces of a Quarto cell: `{python}` → `python`. */
export function fenceLanguage(info: string): string {
  return /^\{?=?([\w.+-]+)/.exec(info.trim())?.[1] ?? '';
}

/** The section number of a heading or the label of a table caption, shown before its text but not compared. */
function blockPrefix(tok: Token | undefined): string {
  const meta = tok?.meta as { secnum?: string; caption?: string } | undefined;
  if (meta?.secnum) {
    return `<span class="secnum">${meta.secnum}</span> `;
  }
  return meta?.caption ? `<span class="cap-label">${meta.caption}:</span> ` : '';
}

/** Adds the Quarto rules to a parser. */
export function quartoPlugin(md: MarkdownIt): void {
  md.core.ruler.before('block', 'quarto_eq_labels', eqLabelsRule);
  md.core.ruler.after('block', 'quarto_blocks', blocksRule);
  md.core.ruler.after('inline', 'quarto_resolve', resolveRule);
  md.block.ruler.before('fence', 'quarto_div', divRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.inline.ruler.before('link', 'quarto_bracket', bracketRule);
  md.inline.ruler.before('link', 'quarto_at', atRule);
  md.inline.ruler.before('link', 'quarto_shortcode', shortcodeRule);

  const esc = md.utils.escapeHtml;
  const r = md.renderer.rules;
  r.quarto_xref = (tokens, idx) => xrefHtml(tokens[idx], esc);
  r.quarto_cite = (tokens, idx) => {
    const tok = tokens[idx];
    const meta = tok.meta as CiteMeta;
    return `<span class="${meta.missing ? 'cite missing' : 'cite'}" title="${esc(tok.content)}">${esc(meta.text ?? tok.content)}</span>`;
  };
  r.quarto_shortcode = (tokens, idx) => `<code class="shortcode">${esc(tokens[idx].content)}</code>`;
  // Every div gets `qdiv`, so the review page looks into it for blocks to comment on, as it does
  // for a quote. The div's own lines are its `:::` fences, which have nothing to comment on.
  r.quarto_div_open = (tokens, idx) => {
    const tok = tokens[idx];
    const d = divKind(tok);
    if (d.kind === 'callout') {
      return `<div class="qdiv callout callout-${d.type}"><div class="callout-title">${esc(d.title)}</div>\n`;
    }
    if (d.kind === 'refs') {
      return '<div class="qdiv quarto-refs">References: the list Quarto makes from the citations.';
    }
    const attrs = (tok.meta as { attrs: Attrs }).attrs;
    return `<div${attrs.id ? ` id="${esc(attrs.id)}"` : ''} class="${esc(['qdiv', ...attrs.classes].join(' '))}">\n`;
  };
  r.quarto_div_close = () => '</div>\n';

  const fence = r.fence!;
  r.fence = (tokens, idx, options, env, self) => {
    const tok = tokens[idx];
    const label = fenceLabel(tok.info, esc);
    if (!label) {
      return fence(tokens, idx, options, env, self);
    }
    // Show a cell as code in its language, without the braces and the options.
    const info = tok.info;
    tok.info = fenceLanguage(info);
    const html = fence(tokens, idx, options, env, self);
    tok.info = info;
    return `<div class="qcell${info.trim().startsWith('{=') ? ' raw' : ''}">${label}${html}</div>\n`;
  };

  for (const type of ['heading_open', 'paragraph_open']) {
    const open: RendererRule = r[type] ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
    r[type] = (tokens, idx, options, env, self) => open(tokens, idx, options, env, self) + blockPrefix(tokens[idx]);
  }

  const math = r.math_block;
  if (math) {
    r.math_block = (tokens, idx, options, env, self) => {
      const html = math(tokens, idx, options, env, self);
      const n = tokens[idx].meta?.eqnum as string | undefined;
      return n ? `<div class="eq">${html}<span class="eqnum">(${n})</span></div>\n` : html;
    };
  }
}

function xrefHtml(tok: Token, esc: (s: string) => string): string {
  const meta = tok.meta as XrefMeta;
  return `<a class="${meta.missing ? 'xref missing' : 'xref'}" href="#${esc(meta.refs[0].id)}">${esc(meta.text ?? tok.content)}</a>`;
}
