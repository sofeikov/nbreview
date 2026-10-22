// GitHub only accepts line comments on lines that appear in the PR diff (changed lines plus
// their context). This reads the unified patch GitHub returns for a file and lists those lines.

export interface CommentableLines {
  left: Set<number>;
  right: Set<number>;
}

export function parsePatch(patch: string | undefined): CommentableLines {
  const left = new Set<number>();
  const right = new Set<number>();
  if (!patch) {
    return { left, right };
  }
  let l = 0;
  let r = 0;
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      l = Number(hunk[1]);
      r = Number(hunk[2]);
      continue;
    }
    if (line.startsWith('\\')) {
      continue;
    }
    const tag = line[0];
    if (tag === '+') {
      right.add(r++);
    } else if (tag === '-') {
      left.add(l++);
    } else if (tag === ' ' || line === '') {
      left.add(l++);
      right.add(r++);
    }
  }
  return { left, right };
}
