// Where a Python name comes from, by reading the import statements of a file: the module it is
// imported from, and the files of the repository that module can be. Go to definition uses this
// when the language server finds nothing, as for a copy of the pull request outside the
// workspace, where Pylance doesn't resolve imports between the repository's files. It reads only
// import statements: it doesn't evaluate code or follow assignments.

/** A module, by its dotted name, and a name defined in it (undefined for the module itself). */
export interface ImportTarget {
  module: string;
  name?: string;
  /** A relative import: `module` is already a path from the repository's top. */
  fromTop?: boolean;
}

interface Token {
  text: string;
  line: number;
  start: number;
}

/** What an import statement binds and where its words are. */
interface Statement {
  line: number;
  end: number;
  /** Each name it binds, with where that name leads. */
  binds: { name: string; targets: ImportTarget[] }[];
  /** `from m import *`: any name may come from m. */
  star?: ImportTarget;
  /** Each word of the statement, with where a click on it leads. */
  words: { token: Token; targets: ImportTarget[] }[];
}

const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** The words and punctuation of an import statement's lines, without comments. */
function tokens(lines: string[], first: number, last: number): Token[] {
  const out: Token[] = [];
  for (let i = first; i <= last; i++) {
    const text = lines[i].replace(/#.*$/, '');
    for (const m of text.matchAll(/[\p{L}_][\p{L}\p{N}_]*|[.,()*;]/gu)) {
      out.push({ text: m[0], line: i, start: m.index ?? 0 });
    }
  }
  return out;
}

/** The package that a relative import starts from: the file's folder, or a folder above it. */
function relativeBase(filePath: string, level: number): string | undefined {
  const parts = filePath.split('/').slice(0, -1);
  if (level - 1 > parts.length) {
    return undefined;
  }
  return parts.slice(0, parts.length - (level - 1)).join('.');
}

const join = (...parts: (string | undefined)[]) => parts.filter(p => p).join('.');

/** Parses one import statement that starts at `first` (and may go on over several lines). */
function parse(lines: string[], first: number, filePath: string): Statement | undefined {
  // A statement goes on while a bracket is open or a line ends with a backslash, but not into a
  // line that starts at the left edge with something other than `)`: a bracket left open (a
  // syntax error, the end of a notebook cell) mustn't take in the rest of the file.
  let last = first;
  let depth = 0;
  for (let i = first; i < lines.length; i++) {
    const code = lines[i].replace(/#.*$/, '');
    if (i > first && /^[^\s)]/.test(code)) {
      break;
    }
    depth += (code.match(/\(/g)?.length ?? 0) - (code.match(/\)/g)?.length ?? 0);
    last = i;
    if (depth <= 0 && !code.trimEnd().endsWith('\\')) {
      break;
    }
  }
  const t = tokens(lines, first, last);
  let k = 0;
  const peek = () => t[k]?.text;
  const dotted = (): Token[] => {
    const parts: Token[] = [];
    while (t[k] && NAME.test(t[k].text) && t[k].text !== 'import' && t[k].text !== 'as') {
      parts.push(t[k++]);
      if (peek() !== '.') {
        break;
      }
      k++;
    }
    return parts;
  };
  const st: Statement = { line: first, end: last, binds: [], words: [] };
  if (peek() === 'from') {
    k++;
    let level = 0;
    while (peek() === '.') {
      level++;
      k++;
    }
    const parts = dotted();
    if (peek() !== 'import') {
      return undefined;
    }
    k++;
    let module: string;
    let fromTop: boolean | undefined;
    if (level) {
      const base = relativeBase(filePath, level);
      if (base === undefined) {
        return undefined;
      }
      module = join(base, ...parts.map(p => p.text));
      fromTop = true;
    } else {
      module = parts.map(p => p.text).join('.');
    }
    if (!module) {
      return undefined;
    }
    const base = level ? relativeBase(filePath, level) ?? '' : '';
    parts.forEach((p, i) => st.words.push({ token: p, targets: [{ module: join(base, ...parts.slice(0, i + 1).map(q => q.text)), fromTop }] }));
    if (peek() === '*') {
      st.star = { module, fromTop };
      return st;
    }
    while (k < t.length) {
      if (peek() === '(' || peek() === ',' || peek() === ')') {
        k++;
        continue;
      }
      const name = t[k];
      if (!NAME.test(name.text)) {
        break;
      }
      k++;
      // The name may be a variable of the module or a submodule of the package.
      const targets: ImportTarget[] = [{ module, name: name.text, fromTop }, { module: `${module}.${name.text}`, fromTop }];
      st.words.push({ token: name, targets });
      let bound = name.text;
      if (peek() === 'as' && t[k + 1] && NAME.test(t[k + 1].text)) {
        bound = t[k + 1].text;
        st.words.push({ token: t[k + 1], targets });
        k += 2;
      }
      st.binds.push({ name: bound, targets });
    }
    return st;
  }
  if (peek() !== 'import') {
    return undefined;
  }
  k++;
  while (k < t.length) {
    const parts = dotted();
    if (!parts.length) {
      break;
    }
    const module = parts.map(p => p.text).join('.');
    parts.forEach((p, i) => st.words.push({ token: p, targets: [{ module: parts.slice(0, i + 1).map(q => q.text).join('.') }] }));
    if (peek() === 'as' && t[k + 1] && NAME.test(t[k + 1].text)) {
      st.words.push({ token: t[k + 1], targets: [{ module }] });
      st.binds.push({ name: t[k + 1].text, targets: [{ module }] });
      k += 2;
    } else {
      // `import a.b` binds `a`.
      st.binds.push({ name: parts[0].text, targets: [{ module: parts[0].text }] });
    }
    if (peek() !== ',') {
      break;
    }
    k++;
  }
  return st;
}

/** Every import statement of a file's lines (also indented ones, as in a function or a `try`). */
function statements(lines: string[], filePath: string): Statement[] {
  const out: Statement[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:from|import)\s/.test(lines[i])) {
      const st = parse(lines, i, filePath);
      if (st) {
        out.push(st);
        i = st.end;
      }
    }
  }
  return out;
}

/**
 * Where an imported name leads. Python runs top to bottom, so the last import at or before
 * `line` wins (else the first one after it, as in a later notebook cell). A `from m import *`
 * after that import may replace the name, if m has it: those modules come first, latest first.
 */
function bound(all: Statement[], name: string, line: number): ImportTarget[] {
  const explicit = (st: Statement) => st.binds.find(b => b.name === name)?.targets;
  const before = all.filter(st => st.line <= line);
  const last = [...before].reverse().find(st => explicit(st));
  const chosen = last ?? all.find(st => st.line > line && explicit(st));
  const stars = (from: Statement[]) => from.filter(st => st.star).reverse().map(st => ({ ...st.star!, name }));
  if (!chosen) {
    return [...stars(before), ...stars(all.filter(st => st.line > line)).reverse()];
  }
  return [...stars(before.filter(st => st.line > chosen.line)), ...explicit(chosen)!];
}

/** Where an imported name of a module's text leads, as for a re-export in `__init__.py`. */
export function importedName(source: string, name: string, filePath: string): ImportTarget[] {
  const lines = source.split(/\r?\n/);
  return bound(statements(lines, filePath), name, lines.length);
}

/**
 * Whether a column of a line is code: not in a comment or in a string on that line. Strings over
 * several lines (docstrings) aren't seen.
 */
export function inCode(text: string, col: number): boolean {
  let quote: string | undefined;
  for (let i = 0; i < col && i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (text.startsWith(quote, i)) {
        i += quote.length - 1;
        quote = undefined;
      }
    } else if (ch === '#') {
      return false;
    } else if (ch === '"' || ch === "'") {
      quote = text.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      i += quote.length - 1;
    }
  }
  return !quote;
}

/**
 * Where the name clicked at `start` of line `line` leads, from the file's imports: a word of an
 * import statement, a name it imports, or `module.name` after `import module`. Empty when the
 * name isn't imported. A notebook gives the source of its code cells, one after the other.
 */
export function importTargets(lines: string[], line: number, start: number, filePath: string): ImportTarget[] {
  const all = statements(lines, filePath);
  const inside = all.find(st => line >= st.line && line <= st.end);
  if (inside) {
    return inside.words.find(w => w.token.line === line && w.token.start === start)?.targets ?? [];
  }
  // The names before the clicked one, as `geometry.shapes` in `geometry.shapes.area`.
  const text = lines[line] ?? '';
  if (!inCode(text, start)) {
    return [];
  }
  const chain: string[] = [];
  let at = start;
  for (;;) {
    const m = /([\p{L}_][\p{L}\p{N}_]*)\s*\.\s*$/u.exec(text.slice(0, at));
    if (!m) {
      break;
    }
    chain.unshift(m[1]);
    at = m.index;
  }
  // A method call such as `x().area` or `x[0].area` has something other than a name before the dot.
  if (/[)\]'"]\s*\.\s*$/.test(text.slice(0, at))) {
    return [];
  }
  const clicked = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(text.slice(start))?.[0];
  if (!clicked) {
    return [];
  }
  if (!chain.length) {
    return bound(all, clicked, line);
  }
  // `m.a.b`: `m.a.b` may be a submodule, or `b` a name in the module `m.a`.
  const out = new Map<string, ImportTarget>();
  for (const head of bound(all, chain[0], line)) {
    // `from pkg import geometry` then `geometry.area`: geometry is taken as a module.
    const module = head.name !== undefined ? `${head.module}.${head.name}` : head.module;
    const path = join(module, ...chain.slice(1));
    for (const target of [{ module: `${path}.${clicked}`, fromTop: head.fromTop }, { module: path, name: clicked, fromTop: head.fromTop }]) {
      out.set(`${target.module}:${target.name ?? ''}`, target);
    }
  }
  return [...out.values()];
}

/**
 * The repository files a module can be, most likely first: at the top, under `src/`, and beside
 * the importing file. A notebook runs from its own folder, so for a notebook that folder comes
 * first; a module of a package is imported from the top. Empty when the module's name isn't a
 * valid dotted name, so a path can never leave the repository.
 */
export function moduleFiles(target: ImportTarget, filePath: string): string[] {
  const parts = target.module.split('.');
  if (!parts.every(p => NAME.test(p))) {
    return [];
  }
  const folder = filePath.split('/').slice(0, -1).join('/');
  const bases = target.fromTop ? [''] : filePath.endsWith('.ipynb') ? [folder, '', 'src'] : ['', 'src', folder];
  const out: string[] = [];
  for (const base of bases) {
    const path = [base, ...parts].filter(p => p).join('/');
    for (const file of [`${path}.py`, `${path}/__init__.py`]) {
      if (!out.includes(file)) {
        out.push(file);
      }
    }
  }
  return out;
}

/**
 * The line of a top-level `def`, `class` or assignment of a name in a module's text: a fallback for
 * when the language server gives no symbols for the file.
 */
export function topLevelLine(source: string, name: string): number | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(?:(?:async\\s+)?def\\s+${escaped}\\s*[(\\[]|class\\s+${escaped}\\b|${escaped}\\s*(?::[^=]*)?=(?!=))`, 'u');
  const i = source.split(/\r?\n/).findIndex(l => re.test(l));
  return i >= 0 ? i : undefined;
}
