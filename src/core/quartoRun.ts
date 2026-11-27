// What a Quarto document computes when it is rendered: the value of every inline expression and
// the outputs of every code cell. It is read from the executed notebook that Quarto's Jupyter
// engine leaves next to the document when asked to (`keep-ipynb`): a Markdown cell carries its
// expressions and their results in `metadata.user_expressions`, a code cell its outputs.
//
// The review page still renders the document from its source, so comments keep their lines; a
// run only fills in what the source can't say. Values are matched to the source by their text,
// in document order (`RunCursor`), so a piece Quarto read differently leaves a placeholder and
// doesn't shift the values after it.
import { fnv } from './notebook.ts';
import { withoutRunIds } from './outputFrame.ts';

/** A cell option line: `#| key: value`, also `# | ` as code formatters write it, `%%|`, `//|` and `--|`. */
export const OPTION_LINE = /^[ \t]*(?:#|%%|\/\/|--)[ \t]*\|[ \t]?(.*)$/;

/** An inline expression and what it gave: text, or Markdown; neither when it failed. */
export interface RunExpr {
  expr: string;
  text?: string;
  /** The value is Markdown (an `IPython.display.Markdown`), shown formatted and not escaped. */
  markdown?: boolean;
}

/** One output of a code cell. */
export type RunOutput =
  | { kind: 'markdown'; text: string }
  /** Base64, or the text of an SVG. */
  | { kind: 'image'; mime: string; data: string }
  /** `text` is the plain form of the same output, shown when the HTML needs scripts. */
  | { kind: 'html'; html: string; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'stream'; name: string; text: string }
  | { kind: 'error'; text: string };

export interface RunCell {
  /** The cell's code without its option lines, which Quarto writes again in its own way. */
  code: string;
  outputs: RunOutput[];
}

export interface QuartoRun {
  exprs: RunExpr[];
  cells: RunCell[];
}

const IMAGES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/gif'];

/** nbformat text: a string, or a list of strings to join. */
function joined(value: unknown): string {
  return Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : '';
}

/** The code of a cell without its option lines and the blank lines around it. */
export function cellCode(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let k = 0;
  while (k < lines.length && OPTION_LINE.test(lines[k])) {
    k++;
  }
  return lines.slice(k).map(l => l.replace(/\s+$/, '')).join('\n').trim();
}

/**
 * The value of an inline expression as Quarto writes it into the text: Markdown as it is, and the
 * `repr` of anything else, a string without its quotes.
 */
function exprValue(result: unknown): Pick<RunExpr, 'text' | 'markdown'> {
  const r = result as { status?: string; data?: Record<string, unknown> } | undefined;
  if (!r || r.status !== 'ok' || !r.data) {
    return {};
  }
  if (r.data['text/markdown'] !== undefined) {
    return { text: joined(r.data['text/markdown']), markdown: true };
  }
  const plain = joined(r.data['text/plain']);
  const quoted = /^(['"])([\s\S]*)\1$/.exec(plain);
  return { text: quoted ? quoted[2].replace(/\\(['"\\])/g, '$1').replace(/\\n/g, ' ') : plain };
}

function readOutput(out: Record<string, unknown>): RunOutput | undefined {
  const type = out.output_type;
  if (type === 'stream') {
    return { kind: 'stream', name: String(out.name ?? 'stdout'), text: joined(out.text) };
  }
  if (type === 'error') {
    // eslint-disable-next-line no-control-regex
    const trace = (Array.isArray(out.traceback) ? out.traceback.join('\n') : '').replace(/\u001b\[[0-9;]*m/g, '');
    return { kind: 'error', text: trace || `${String(out.ename)}: ${String(out.evalue)}` };
  }
  if (type !== 'execute_result' && type !== 'display_data') {
    return undefined;
  }
  const data = (out.data ?? {}) as Record<string, unknown>;
  // In the order Quarto prefers them for a Markdown document: a table written as Markdown is
  // Markdown, a plot is a picture, and HTML comes before the plain text every output also has.
  if (data['text/markdown'] !== undefined) {
    return { kind: 'markdown', text: joined(data['text/markdown']) };
  }
  for (const mime of IMAGES) {
    if (data[mime] !== undefined) {
      return { kind: 'image', mime, data: mime === 'image/svg+xml' ? joined(data[mime]) : joined(data[mime]).replace(/\s+/g, '') };
    }
  }
  if (data['text/html'] !== undefined) {
    return { kind: 'html', html: joined(data['text/html']), text: joined(data['text/plain']) };
  }
  if (data['text/plain'] !== undefined) {
    return { kind: 'text', text: joined(data['text/plain']) };
  }
  return undefined;
}

/** Reads the run of a document from its executed notebook. Throws when the text isn't a notebook. */
export function readQuartoRun(notebook: string): QuartoRun {
  const nb = JSON.parse(notebook) as { cells?: unknown };
  if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells)) {
    throw new Error('Not a notebook');
  }
  const run: QuartoRun = { exprs: [], cells: [] };
  for (const cell of nb.cells as Record<string, unknown>[]) {
    if (cell.cell_type === 'markdown') {
      const list = (cell.metadata as { user_expressions?: unknown } | undefined)?.user_expressions;
      for (const e of Array.isArray(list) ? list as { expression?: unknown; result?: unknown }[] : []) {
        if (typeof e.expression === 'string') {
          run.exprs.push({ expr: e.expression.trim(), ...exprValue(e.result) });
        }
      }
    } else if (cell.cell_type === 'code') {
      const outputs = (Array.isArray(cell.outputs) ? cell.outputs as Record<string, unknown>[] : []).map(readOutput).filter((o): o is RunOutput => !!o);
      run.cells.push({ code: cellCode(joined(cell.source)), outputs });
    }
  }
  return run;
}

/** A run read back from the extension's storage; undefined when it isn't one. */
export function parseQuartoRun(text: string): QuartoRun | undefined {
  try {
    const run = JSON.parse(text) as QuartoRun;
    return Array.isArray(run?.exprs) && Array.isArray(run?.cells) ? run : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hands out a run's values to the document's source, in document order. Each expression and
 * cell is looked up by its text, and the same text twice gets its values in the order they ran.
 */
export class RunCursor {
  private readonly exprs = new Map<string, RunExpr[]>();
  private readonly cells = new Map<string, RunCell[]>();

  constructor(run: QuartoRun) {
    const add = <T>(map: Map<string, T[]>, key: string, value: T) => {
      const list = map.get(key);
      if (list) {
        list.push(value);
      } else {
        map.set(key, [value]);
      }
    };
    run.exprs.forEach(e => add(this.exprs, e.expr, e));
    run.cells.forEach(c => add(this.cells, c.code, c));
  }

  /** The next result of an inline expression, by its code; undefined when the run hasn't it. */
  expr(code: string): RunExpr | undefined {
    return this.exprs.get(code.trim())?.shift();
  }

  /** The next run of a cell, by its source (option lines and all). */
  cell(source: string): RunCell | undefined {
    return this.cells.get(cellCode(source))?.shift();
  }
}

/**
 * A short key of a cell's outputs: two runs of a cell with the same key show the same. The ids a
 * plotting library makes up for each run don't count.
 */
export function outputsKey(outputs: RunOutput[]): string {
  return fnv(JSON.stringify(outputs.map(o => (o.kind === 'html' ? { ...o, html: withoutRunIds(o.html) } : o))));
}

/** Splits a command line into its words; quotes keep spaces in a word. */
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/**
 * The command that builds one document, run in the document's folder. `setting` is the user's
 * command up to the file (`nbreview.quarto.command`); empty means Quarto as it is installed, run
 * through uv when the project has a `uv.lock`, so the build gets the project's own packages at
 * that commit. With all the project's extras (`allExtras`): a project that keeps a package its
 * documents import in an extra installs it with `uv sync --all-extras`, and plain `uv run` would
 * leave it out. A project whose extras conflict can't have them all; the build then runs again
 * without (see extrasConflict). The kept notebook is what the build is for: `gfm` is the cheapest
 * format to write, and needs none of the project's format extensions. Without Quarto's kernel
 * daemon, which would stay alive for minutes after the build, out of reach of a cancel. And
 * without `--output-dir`: Quarto refuses it for a file it doesn't count as part of a project, and
 * the checkout is thrown away anyway.
 */
export function quartoCommand(setting: string, file: string, uvProject: boolean, allExtras = true): string[] {
  const words = splitCommand(setting);
  const uv = ['uv', 'run', ...(allExtras ? ['--all-extras'] : []), 'quarto', 'render'];
  const start = words.length ? words : uvProject ? uv : ['quarto', 'render'];
  return [...start, file, '--to', 'gfm', '-M', 'keep-ipynb:true', '--no-execute-daemon'];
}

/** Whether uv refused to run because the project declares some of its extras in conflict, so `--all-extras` can't be met. */
export function extrasConflict(message: string): boolean {
  return /incompatible with the declared conflicts/.test(message);
}

/**
 * Whether a path has a folder or file whose name starts with a dot. Quarto leaves such paths out
 * of a project, and its rule looks at the whole path, not at the part inside the project: under
 * `~/.config`, where VS Code keeps an extension's storage on Linux, no file is part of its project.
 */
export function hiddenPath(path: string): boolean {
  return /[/\\]\./.test(path);
}

/**
 * The line of a failed command's output that says why. When a cell failed, the exception that
 * ended the cell's traceback, with the cell's number (`cell 2/6: ModuleNotFoundError: …`); Quarto
 * prints the cell's source above it, whose last line says nothing. Otherwise Quarto's `ERROR:`
 * line, or else the output's last lines.
 */
export function failureLine(output: string): string {
  // eslint-disable-next-line no-control-regex
  const text = output.replace(/\u001b\[[0-9;]*m/g, '');
  const cell = cellFailure(text);
  if (cell !== undefined) {
    return cell.slice(0, 300);
  }
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const error = lines.filter(l => /^(ERROR|Error|error)\b/.test(l)).pop();
  return (error ?? lines.slice(-2).join(' ')).slice(0, 300);
}

const CELL_ERROR = 'An error occurred while executing the following cell:';

/**
 * Why a cell failed, from Quarto's report of it: the cell's source between two lines of dashes,
 * then its traceback. Undefined when no cell failed. A traceback can be empty: a library that
 * draws tracebacks itself (Rich's, which ZenML installs) prints it as the cell's output, which
 * Quarto doesn't show.
 */
function cellFailure(text: string): string | undefined {
  const at = text.lastIndexOf(CELL_ERROR);
  if (at < 0) {
    return undefined;
  }
  const which = [...text.slice(0, at).matchAll(/Cell (\d+\/\d+)/g)].pop()?.[1];
  const name = which ? `cell ${which}` : 'a cell';
  const parts = text.slice(at + CELL_ERROR.length).split(/^-{10,}[ \t]*$/m);
  const traceback = parts.length >= 3 ? parts.slice(2).join('\n') : '';
  const last = traceback.split('\n').map(l => l.trim()).filter(Boolean).pop();
  return last ? `${name}: ${last}` : `${name} failed, and its error wasn't reported`;
}

/**
 * Whether a document's source has executable code: a fenced cell with a language (`{python}`; a
 * raw block `{=html}` or a class `{.callout}` is not one) or an inline expression (`` `{python} x` ``).
 * Quarto starts no engine for a document without any, so it keeps no notebook of it, and a build
 * of such a document has nothing to compute. It is not a failed build.
 */
export function hasExecutableCode(source: string): boolean {
  return /^[ \t]*(?:`{3,}|~{3,})[ \t]*\{[A-Za-z]/m.test(source) || /`\{[A-Za-z][\w-]*\}[ \t]+[^`\n]+`/.test(source);
}

/** The notebook Quarto kept of a document, among the names in its folder: `x.quarto_ipynb`, or `x.ipynb` before Quarto 1.5. */
export function keptNotebook(file: string, names: string[]): string | undefined {
  const stem = file.replace(/\.[^.]+$/, '');
  return names.find(n => n.startsWith(`${stem}.quarto_ipynb`)) ?? names.find(n => n === `${stem}.ipynb`);
}
