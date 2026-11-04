// Finds, in the viewer's own checkout, the line of code they clicked in the review page, so that
// VS Code's language server (Pylance, for Python) can say where a name is defined. The checkout
// may be at another commit than the pull request, so lines are matched by their text.

export interface Identifier {
  name: string;
  /** Where it is in the line: `start` included, `end` not. */
  start: number;
  end: number;
}

/** Words that are never defined anywhere: a click on one goes nowhere. */
const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or',
  'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

/** The name at a character of a line (or just after it), such as `area` in `x = area(2, 3)`. */
export function identifierAt(text: string, offset: number): Identifier | undefined {
  // Python names may have letters of any alphabet.
  const word = /[\p{L}\p{N}_]/u;
  let start = Math.min(Math.max(offset, 0), text.length);
  // A click just after the last letter still means that word.
  if ((start === text.length || !word.test(text[start])) && start > 0 && word.test(text[start - 1])) {
    start--;
  }
  if (!word.test(text[start] ?? '')) {
    return undefined;
  }
  let end = start;
  while (start > 0 && word.test(text[start - 1])) {
    start--;
  }
  while (end < text.length && word.test(text[end])) {
    end++;
  }
  const name = text.slice(start, end);
  return /^\p{N}/u.test(name) || KEYWORDS.has(name) ? undefined : { name, start, end };
}

/**
 * Where a line of the reviewed version is in the local one: the same line when it is unchanged,
 * otherwise the nearest line with the same text. Undefined when no line matches, or when the line
 * is blank and so matches anything.
 */
export function matchLine(local: string[], text: string, near: number): number | undefined {
  const wanted = text.trimEnd();
  if (!wanted.trim()) {
    return undefined;
  }
  const same = (i: number) => i >= 0 && i < local.length && local[i].trimEnd() === wanted;
  // `near` can be past the end of a shorter local file: the search goes back as far as needed.
  const reach = Math.max(near, local.length - near);
  for (let d = 0; d <= reach; d++) {
    if (same(near - d)) {
      return near - d;
    }
    if (same(near + d)) {
      return near + d;
    }
  }
  return undefined;
}

/** The column of a name in a line, as a whole word, at the occurrence nearest `near`. */
export function columnOf(line: string, name: string, near: number): number | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu');
  let best: number | undefined;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (best === undefined || Math.abs(m.index - near) < Math.abs(best - near)) {
      best = m.index;
    }
  }
  return best;
}

/**
 * The local cell that is the reviewed one: the cell with the same id, otherwise the first one
 * whose source is the same. Undefined when the cell isn't in the local notebook.
 */
export function matchCell(local: { id?: string; source: string }[], id: string | undefined, source: string): number | undefined {
  if (id) {
    const byId = local.findIndex(c => c.id === id);
    if (byId >= 0) {
      return byId;
    }
  }
  const text = source.trimEnd();
  const bySource = local.findIndex(c => c.source.trimEnd() === text);
  return bySource >= 0 ? bySource : undefined;
}

/**
 * Whether a git remote URL is the given GitHub repository, in any of its forms:
 * `git@github.com:o/r.git`, `https://github.com/o/r`, `ssh://git@github.com/o/r.git`, and SSH
 * host aliases such as `git@github.com-work:o/r.git` (one key per GitHub account).
 */
export function isRemoteOf(url: string, owner: string, repo: string): boolean {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?github\.com(?:-[\w.-]+)?(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return !!m && m[1].toLowerCase() === owner.toLowerCase() && m[2].toLowerCase() === repo.toLowerCase();
}
