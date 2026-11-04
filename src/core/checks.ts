// Hygiene checks on what a pull request adds: keys and passwords, absolute local paths and, in
// notebooks, cells run out of order, outputs left from old code, error outputs and very large
// outputs. Only what the pull request adds is checked: a key that is already on the base branch
// isn't reported again.
import { onlyWhitespaceDiffers, type CellPair } from './cellDiff.ts';
import type { NbCell, NbOutput } from './notebook.ts';
import { formatSize } from './binary.ts';

export type CheckRule = 'secret' | 'local-path' | 'run-order' | 'stale-output' | 'error-output' | 'large-output';

export interface Finding {
  rule: CheckRule;
  /** `high` for keys and passwords; `low` for the others. */
  severity: 'high' | 'low';
  /** The head cell (`file` for a file that isn't a notebook). */
  cellId: string;
  /** 1-based cell number in the head notebook; undefined for files. */
  cellNumber?: number;
  /** What the finding is on: a source line, an output, or the whole cell. */
  kind: 'source' | 'output' | 'cell';
  /** 0-based source line in the cell, for `source`. */
  line?: number;
  /** Index of the output in the head cell, for `output`. */
  outputIndex?: number;
  /** Short, for example "Possible GitHub token". */
  title: string;
  /** One or two sentences: why it matters and what to do. */
  detail: string;
  /** What was found, with any key masked. Never the key itself. */
  evidence?: string;
  /** A review comment the reviewer can start from. It never contains the key. */
  comment: string;
}

/** Outputs larger than this are reported. */
export const LARGE_OUTPUT = 1_000_000;

// --- Keys and passwords ------------------------------------------------------------------------

export interface SecretMatch {
  /** What it looks like, for example "GitHub token". */
  kind: string;
  index: number;
  length: number;
  /** The secret part itself, used to tell whether the base already has it. Not for display. */
  value: string;
  /** For display: the start of the secret only. */
  masked: string;
}

interface SecretPattern {
  kind: string;
  re: RegExp;
  /** Group with the secret; 0 for the whole match. */
  group: number;
  /** Text shown before the masked value, built from the match (for example the variable name). */
  label?: (m: RegExpExecArray) => string;
  /** Prefixed tokens are found by their prefix; the others also need a value that looks random. */
  prefixed: boolean;
  /** Group with a variable name, which must be one that holds a secret (`api_key`, `DB_PASSWORD`). */
  name?: number;
  /** The value must have capitals, small letters and digits, as real keys of this kind do. */
  mixed?: boolean;
  /** Only in configuration files (YAML, INI, TOML, .env), where values often have no quotes. */
  config?: boolean;
}

/** Names of variables and settings that hold a key, a token or a password. */
const SECRET_NAME = /(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|credentials?)$/i;

/** Names that end like a secret's but hold something else: pagination cursors, file names. */
const NOT_SECRET_NAME = /(?:next|page|cursor|continuation|pagination|sync|start|end)[_-]?token$/i;

// Most specific first: a match that overlaps an earlier one is dropped.
const SECRET_PATTERNS: SecretPattern[] = [
  { kind: 'private key', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g, group: 0, prefixed: true },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/g, group: 0, prefixed: true },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, group: 0, prefixed: true },
  { kind: 'Slack token', re: /\b(?:xox[abprs]|xapp)-[A-Za-z0-9-]{10,255}/g, group: 0, prefixed: true },
  { kind: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,255}/g, group: 0, prefixed: true },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, group: 0, prefixed: true },
  { kind: 'Stripe live key', re: /\b[rs]k_live_[0-9A-Za-z]{20,255}\b/g, group: 0, prefixed: true },
  // `sk-` also starts scikit-learn's CSS classes and many names: these need a long, mixed value.
  { kind: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{32,255}(?![\w-])/g, group: 0, prefixed: true, mixed: true },
  { kind: 'OpenAI API key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,255}(?![\w-])/g, group: 0, prefixed: true, mixed: true },
  { kind: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,255}\b/g, group: 0, prefixed: true },
  { kind: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,2000}/g, group: 0, prefixed: true },
  {
    kind: 'password in a URL',
    re: /\b([a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@"'`]{1,100}:)([^\s@/"'`]{3,200})@/gi,
    group: 2,
    label: m => m[1],
    prefixed: false,
  },
  {
    kind: 'key or password',
    re: /(["']?)([A-Za-z_][\w.-]{0,63})\1\]?[ \t]{0,8}(?::=|=>|=|:)[ \t]{0,8}[rbuRBU]?(["'])([^"'\s]{8,512})\3/g,
    group: 4,
    name: 2,
    label: m => `${m[2]} = `,
    prefixed: false,
  },
  {
    // A shell or .env line, `API_KEY=abc…`: not indented, and no spaces round the `=` (an
    // indented `api_key=x` is more likely a Python keyword argument).
    kind: 'key or password',
    re: /^(?:export[ \t]+)?([A-Za-z_]\w{0,63})=([A-Za-z0-9_\-+/=.~]{12,512})[ \t]*$/gm,
    group: 2,
    name: 1,
    label: m => `${m[1]}=`,
    prefixed: false,
  },
  {
    // `password: abc…` in YAML, `secret_key = abc…` in INI: values without quotes.
    kind: 'key or password',
    re: /^[ \t]{0,32}(?:-[ \t]+)?([A-Za-z_][\w.-]{0,63})[ \t]{0,8}[:=][ \t]{0,8}([^\s"'#]{8,512})[ \t]*$/gm,
    group: 2,
    name: 1,
    label: m => `${m[1]}: `,
    prefixed: false,
    config: true,
  },
  {
    kind: 'bearer token',
    re: /\bBearer[ \t]+([A-Za-z0-9._~+/=-]{20,512})/g,
    group: 1,
    label: () => 'Bearer ',
    prefixed: false,
  },
  {
    kind: 'key in a URL',
    re: /[?&]((?:api[_-]?key|apikey|access[_-]?token|token|secret|password)=)([^&\s"'#]{12,512})/gi,
    group: 2,
    label: m => m[1],
    prefixed: false,
  },
];

/** Values that stand for a key in examples and templates. */
const PLACEHOLDER = /x{4,}|\*{3,}|\.{3}|…|[<>{}$%]|your[_-]?|example|placeholder|dummy|redacted|changeme|replace[_-]?me|fake|sample|secret[_-]?here|0{8,}/i;

/** Shannon entropy in bits per character. */
export function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A file name or a short relative path, such as `keys/sa-key-2024.json`: names a key, isn't one. */
function looksLikeFile(value: string): boolean {
  return /\.(json|ya?ml|txt|csv|pem|key|crt|p12|pfx|env|ini|cfg|toml|pkl|parquet|py|ipynb)$/i.test(value)
    || /^id_(rsa|ed25519|ecdsa|dsa)/.test(value)
    || /^(?:[~.]{0,2}\/)/.test(value)
    || (value.includes('/') && value.length < 30);
}

/** A dotted name such as `config.openai_key_v2`: a reference to a value, not the value. */
function looksLikeReference(value: string): boolean {
  return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value);
}

/** A value that looks like a real key: not a placeholder, and random enough. */
function looksRandom(value: string, needsDigitsAndLetters: boolean): boolean {
  // A date in it (`ckpt-2024-01-05`) makes it a name or a version.
  if (PLACEHOLDER.test(value) || looksLikeFile(value) || looksLikeReference(value) || /\d{4}-\d{2}-\d{2}/.test(value)) {
    return false;
  }
  if (needsDigitsAndLetters && !(/\d/.test(value) && /[A-Za-z]/.test(value))) {
    return false;
  }
  return entropy(value) >= Math.min(3, Math.log2(value.length) - 0.5);
}

/** The start of a value only: four characters of a prefixed token (mostly its prefix), two of a password. */
function mask(value: string, prefixed: boolean): string {
  return `${value.slice(0, prefixed ? 4 : 2)}… (${value.length} characters)`;
}

/** Inline images are base64, which can contain anything; they are left out of the search. */
function withoutDataUris(text: string): string {
  return text.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, m => ' '.repeat(m.length));
}

/**
 * Keys, tokens and passwords in a piece of text. `config` adds values without quotes, for YAML,
 * INI, TOML and .env files, where they are common; in code they would mostly be names.
 */
export function findSecrets(text: string, options: { config?: boolean } = {}): SecretMatch[] {
  const clean = withoutDataUris(text);
  const found: SecretMatch[] = [];
  const overlaps = (start: number, end: number) => found.some(f => start < f.index + f.length && f.index < end);
  for (const p of SECRET_PATTERNS) {
    if (p.config && !options.config) {
      continue;
    }
    p.re.lastIndex = 0;
    for (let m = p.re.exec(clean); m; m = p.re.exec(clean)) {
      if (m[0].length === 0) {
        p.re.lastIndex++;
        continue;
      }
      const value = m[p.group];
      if (p.name !== undefined && (!SECRET_NAME.test(m[p.name]) || NOT_SECRET_NAME.test(m[p.name]))) {
        continue;
      }
      if (p.mixed && !(/[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value))) {
        continue;
      }
      const ok = p.kind === 'private key' || looksRandom(p.prefixed ? value.replace(/^[a-z]+[-_]/i, '') : value, !p.prefixed);
      if (!ok || overlaps(m.index, m.index + m[0].length)) {
        continue;
      }
      found.push({
        kind: p.kind,
        index: m.index,
        length: m[0].length,
        value,
        masked: p.kind === 'private key' ? m[0] : `${p.label ? p.label(m) : ''}${mask(value, p.prefixed)}`,
      });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

// --- Local paths -------------------------------------------------------------------------------

// `/home/jovyan/` is the user of the Jupyter Docker images: the same on every machine.
const LOCAL_PATHS = [
  /(?<![\w.~-])\/home\/(?!jovyan\/)[A-Za-z0-9_][\w.-]*\//g,
  /(?<![\w.~-])\/Users\/(?!Shared\/)[A-Za-z0-9_][\w.-]*\//g,
  /(?<![\w])[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9_][\w.-]*\\{1,2}/g,
];

/** Text with every key in it hidden, for showing text that may hold one (an error message). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const s of findSecrets(text).reverse()) {
    const match = out.slice(s.index, s.index + s.length).replace(s.value, `[hidden, ${s.value.length} characters]`);
    out = out.slice(0, s.index) + match + out.slice(s.index + s.length);
  }
  return out;
}

/** Absolute paths into someone's home folder, such as `/home/alice/`. */
export function findLocalPaths(text: string): string[] {
  const out: string[] = [];
  for (const re of LOCAL_PATHS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      out.push(m[0]);
    }
  }
  return out;
}

// --- Checks ------------------------------------------------------------------------------------

/** A line of a cell or file, by its 0-based index. */
export interface IndexedLine {
  index: number;
  text: string;
}

function secretFinding(s: SecretMatch, where: string, at: Omit<Finding, 'rule' | 'severity' | 'title' | 'detail' | 'comment'>): Finding {
  const article = /^[aeiou]/i.test(s.kind) ? 'an' : 'a';
  return {
    rule: 'secret',
    severity: 'high',
    ...at,
    title: `Possible ${s.kind}`,
    detail: `${where} looks like it has ${article} ${s.kind}. If it is real, revoke it and make a new one: removing it from the file isn't enough, because it stays in the git history.`,
    evidence: s.masked,
    comment: `${where} looks like it has ${article} ${s.kind}. If it is real, please revoke it and make a new one, and load it from an environment variable or a secrets store. Removing it from the file isn't enough: it stays in the git history of this branch.`,
  };
}

function pathFinding(path: string, where: string, at: Omit<Finding, 'rule' | 'severity' | 'title' | 'detail' | 'comment'>): Finding {
  return {
    rule: 'local-path',
    severity: 'low',
    ...at,
    title: 'Absolute local path',
    detail: `${where} has a path into a home folder. It won't work on other machines, and it shows a user name.`,
    evidence: path,
    comment: `${where} has an absolute path (\`${path}\`) that only works on one machine. Could it be relative to the project, or come from a setting?`,
  };
}

/**
 * Secrets and local paths in added lines. Those already in `known` (the old version) are left
 * out: the pull request didn't add them.
 */
function lineFindings(lines: IndexedLine[], known: Known, at: { cellId: string; cellNumber?: number }, options: { paths: boolean; config?: boolean }): Finding[] {
  const out: Finding[] = [];
  for (const l of lines) {
    for (const s of findSecrets(l.text, { config: options.config })) {
      if (!known(s.value)) {
        out.push(secretFinding(s, 'This line', { ...at, kind: 'source', line: l.index }));
      }
    }
    if (options.paths) {
      const [first] = findLocalPaths(l.text).filter(p => !known(p));
      if (first) {
        out.push(pathFinding(first, 'This line', { ...at, kind: 'source', line: l.index }));
      }
    }
  }
  return out;
}

/** Whether a key was already in the old version: anywhere in its text, whatever it was called there. */
type Known = (value: string) => boolean;

function knownIn(texts: string[]): Known {
  const all = texts.join('\n');
  return value => all.includes(value);
}

/** The text of an output that is searched: streams, plain text, and the text of HTML. Not images. */
function outputText(o: NbOutput): string {
  if (o.kind === 'image') {
    return '';
  }
  // Only the start of a very large output (a Plotly figure carries megabytes of script). Styles
  // and scripts are left out: scikit-learn's CSS classes start with `sk-`, like OpenAI keys.
  const html = o.html
    ? withoutStylesAndScripts(o.html.slice(0, 400_000))
      .replace(/<[^<>]*>/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    : '';
  const label = o.kind === 'error' ? o.label : '';
  return [label, o.textLines.join('\n'), html].filter(Boolean).join('\n').slice(0, 200_000);
}

/** HTML without its `<style>` and `<script>` elements, in one pass (a regex is slow on unclosed ones). */
export function withoutStylesAndScripts(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const style = lower.indexOf('<style', i);
    const script = lower.indexOf('<script', i);
    const start = style < 0 ? script : script < 0 ? style : Math.min(style, script);
    if (start < 0) {
      return out + html.slice(i);
    }
    const tag = start === style ? 'style' : 'script';
    const end = lower.indexOf(`</${tag}`, start);
    out += `${html.slice(i, start)} `;
    if (end < 0) {
      return out;
    }
    // The rest of the closing tag (`>`) goes with the other tags.
    i = end + tag.length + 2;
  }
}

function cellTexts(cells: NbCell[]): string[] {
  return cells.flatMap(c => [c.source.join('\n'), ...c.outputs.map(outputText)]);
}

/** The findings in a notebook's changes, in the order of its cells. */
export function checkNotebook(pairs: CellPair[]): Finding[] {
  const baseCells = pairs.flatMap(p => (p.base ? [p.base] : []));
  // Keys anywhere in the base notebook were there before this pull request.
  const known = knownIn(cellTexts(baseCells));
  const out: Finding[] = [];
  const cleanRun = !runOrderProblem(pairs.flatMap(p => (p.head ? [p.head] : [])));
  for (const p of pairs) {
    const cell = p.head;
    if (!cell) {
      continue;
    }
    const at = { cellId: cell.id, cellNumber: cell.index + 1 };
    const added: IndexedLine[] = p.lines.flatMap(l => (l.op === 'add' ? [{ index: l.head, text: cell.source[l.head] }] : []));
    out.push(...lineFindings(added, known, at, { paths: cell.type !== 'markdown' }));

    const oldOutputs = new Set((p.base?.outputs ?? []).map(o => o.hash));
    cell.outputs.forEach((o, outputIndex) => {
      if (oldOutputs.has(o.hash)) {
        return;
      }
      const where = { ...at, kind: 'output' as const, outputIndex };
      const text = outputText(o);
      const secret = findSecrets(text).find(s => !known(s.value));
      if (secret) {
        out.push(secretFinding(secret, 'This output', where));
      }
      if (o.kind === 'error') {
        // An error message can hold a key (a URL with `?api_key=…`): it is shown masked.
        const error = redactSecrets(o.label.replace(/^error /, ''));
        out.push({
          rule: 'error-output',
          severity: 'low',
          ...where,
          title: 'Error in the outputs',
          detail: 'The cell stopped with an error when it was last run.',
          evidence: error,
          comment: `This cell has an error output (\`${error}\`). Is that expected? If not, please fix it and run the notebook again.`,
        });
      } else {
        // Paths in tracebacks are left out: the error is reported already.
        const [path] = findLocalPaths(text).filter(x => !known(x));
        if (path) {
          out.push(pathFinding(path, 'This output', where));
        }
      }
      if ((o.size ?? 0) > LARGE_OUTPUT) {
        const size = formatSize(o.size!);
        out.push({
          rule: 'large-output',
          severity: 'low',
          ...where,
          title: `Large output (${size})`,
          detail: 'Large outputs make the notebook slow to open and its diffs hard to read.',
          evidence: o.label,
          comment: `This output is ${size}. Could it be cleared, made smaller, or saved to a file instead?`,
        });
      }
    });

    // After "Restart and run all" every count is 1, 2, 3… again, so an unchanged count says
    // nothing; nor does a change in whitespace only, which needs no run.
    const base = p.base;
    if (base && base.type === 'code' && cell.type === 'code' && p.sourceChanged && cell.outputs.length
      && cell.executionCount !== null && cell.executionCount !== undefined && cell.executionCount === base.executionCount
      && !p.outputsChanged && !onlyWhitespaceDiffers(base.source, cell.source) && !cleanRun) {
      out.push({
        rule: 'stale-output',
        severity: 'low',
        ...at,
        kind: 'cell',
        title: 'Outputs not updated',
        detail: `The code changed, but the execution count [${cell.executionCount}] and the outputs are the same as before. The outputs probably come from the old code.`,
        comment: 'The code in this cell changed, but its outputs and execution count did not. Please run the notebook again so the outputs match the code.',
      });
    }
  }
  const order = runOrder(pairs);
  if (order) {
    out.push(order);
  }
  const position = (f: Finding) => pairs.findIndex(p => p.head?.id === f.cellId);
  return out.sort((a, b) => position(a) - position(b));
}

/**
 * Whether the notebook ran once, from top to bottom: its execution counts are 1, 2, 3… down the
 * page. Reported only when the pull request ran cells (some count changed), on the first cell
 * that breaks the order.
 */
function runOrder(pairs: CellPair[]): Finding | undefined {
  const ran = pairs.some(p => p.head?.type === 'code' && typeof p.head.executionCount === 'number'
    && (!p.base || p.base.executionCount !== p.head.executionCount));
  return ran ? runOrderProblem(pairs.flatMap(p => (p.head ? [p.head] : []))) : undefined;
}

/** The first cell that breaks the order 1, 2, 3… of the execution counts, as a finding. */
function runOrderProblem(cells: NbCell[]): Finding | undefined {
  const heads = cells.filter(c => c.type === 'code' && typeof c.executionCount === 'number');
  const at = (cell: NbCell) => ({ cellId: cell.id, cellNumber: cell.index + 1, kind: 'cell' as const });
  const count = (cell: NbCell) => cell.executionCount as number;
  // Out of order is worse than gaps, so it is looked for first, over the whole notebook.
  for (let i = 1; i < heads.length; i++) {
    const [previous, cell] = [heads[i - 1], heads[i]];
    if (count(cell) <= count(previous)) {
      return {
        rule: 'run-order',
        severity: 'low',
        ...at(cell),
        title: 'Cells ran out of order',
        detail: `This cell [${count(cell)}] ran before cell ${previous.index + 1} [${count(previous)}] above it. The outputs may depend on state that running the notebook in order doesn't make.`,
        comment: `The cells didn't run from top to bottom: this cell [${count(cell)}] ran before cell ${previous.index + 1} [${count(previous)}]. Please restart the kernel and run all cells, so the outputs match the code.`,
      };
    }
  }
  for (let i = 0; i < heads.length; i++) {
    const previous = heads[i - 1];
    const cell = heads[i];
    if (count(cell) !== (previous ? count(previous) + 1 : 1)) {
      const what = previous ? `goes from [${count(previous)}] to [${count(cell)}]` : `starts at [${count(cell)}]`;
      return {
        rule: 'run-order',
        severity: 'low',
        ...at(cell),
        title: 'Not one clean run',
        detail: `The execution count ${what}: some cells ran more than once, or code ran that isn't in the notebook.`,
        comment: `The execution count ${what} here, so the notebook wasn't run once from the top. Could you restart the kernel and run all cells?`,
      };
    }
  }
  return undefined;
}

/**
 * The findings in an ordinary file: keys and local paths in its added lines. `base` is the old
 * file's lines (or its removed lines): keys already there aren't reported.
 */
export function checkFile(path: string, base: string[], added: IndexedLine[]): Finding[] {
  const markdown = /\.(md|markdown|rst|txt)$/i.test(path);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const config = /\.(ya?ml|ini|cfg|conf|toml|properties|env)$/i.test(name) || /^\.env(\..*)?$/.test(name);
  return lineFindings(added, knownIn(base), { cellId: 'file' }, { paths: !markdown, config });
}

/** The added lines (0-based head line index) and removed lines of a unified patch. */
export function patchLines(patch: string | undefined): { added: IndexedLine[]; removed: string[] } {
  const added: IndexedLine[] = [];
  const removed: string[] = [];
  let r = 0;
  for (const line of (patch ?? '').split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      r = Number(hunk[1]);
    } else if (line.startsWith('+')) {
      added.push({ index: r - 1, text: line.slice(1) });
      r++;
    } else if (line.startsWith('-')) {
      removed.push(line.slice(1));
    } else if (!line.startsWith('\\')) {
      r++;
    }
  }
  return { added, removed };
}

/** Where a finding is, for lists: "cell 3, line 2", "line 14", "cell 5, output 1". */
export function findingPlace(f: Finding): string {
  const cell = f.cellNumber ? `cell ${f.cellNumber}` : '';
  const part = f.kind === 'source' ? `line ${f.line! + 1}` : f.kind === 'output' ? `output ${f.outputIndex! + 1}` : '';
  return [cell, part].filter(Boolean).join(', ') || 'file';
}
