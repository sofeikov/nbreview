// Lines up the cells of two notebook versions and diffs each pair line by line, for the visual
// review page. Cells are matched by id first (nbdev keeps ids stable), then by identical content.
import type { NbCell } from './notebook.ts';

export type CellStatus = 'unchanged' | 'modified' | 'added' | 'removed';

export interface CellPair {
  base?: NbCell;
  head?: NbCell;
  status: CellStatus;
  /** Matched cell whose position relative to the others changed. */
  moved: boolean;
  /** Source changed (as opposed to only outputs). */
  sourceChanged: boolean;
  outputsChanged: boolean;
  lines: LineOp[];
}

export type LineOp =
  | { op: 'same'; base: number; head: number }
  | { op: 'del'; base: number }
  | { op: 'add'; head: number };

export function diffCells(base: NbCell[], head: NbCell[]): CellPair[] {
  const matchOfHead = new Map<number, number>(); // head index → base index
  const usedBase = new Set<number>();
  const baseById = new Map(base.map((c, i) => [c.id, i]));
  head.forEach((c, h) => {
    const b = c.id.startsWith('index-') ? undefined : baseById.get(c.id);
    if (b !== undefined && !usedBase.has(b)) {
      matchOfHead.set(h, b);
      usedBase.add(b);
    }
  });
  // Cells without stable ids: match identical content, in order.
  const restHead = head.map((_, h) => h).filter(h => !matchOfHead.has(h));
  const restBase = base.map((_, b) => b).filter(b => !usedBase.has(b));
  const key = (c: NbCell) => `${c.type}\u0000${c.source.join('\n')}`;
  for (const [h, b] of lcsPairs(restHead.map(h => key(head[h])), restBase.map(b => key(base[b])))) {
    matchOfHead.set(restHead[h], restBase[b]);
    usedBase.add(restBase[b]);
  }

  // Matched cells that are not part of the longest in-order run were moved.
  const matched = [...matchOfHead.entries()].sort((a, b) => a[0] - b[0]);
  const inOrder = new Set(longestIncreasing(matched.map(([, b]) => b)).map(i => matched[i][0]));

  const pairs: CellPair[] = [];
  let nextBase = 0;
  const flushRemoved = (upTo: number) => {
    for (; nextBase < upTo; nextBase++) {
      if (!usedBase.has(nextBase)) {
        pairs.push(makePair(base[nextBase], undefined, false));
      }
    }
  };
  head.forEach((cell, h) => {
    const b = matchOfHead.get(h);
    if (b !== undefined && inOrder.has(h)) {
      flushRemoved(b);
      nextBase = Math.max(nextBase, b + 1);
    }
    pairs.push(makePair(b === undefined ? undefined : base[b], cell, b !== undefined && !inOrder.has(h)));
  });
  flushRemoved(base.length);
  return pairs;
}

function makePair(base: NbCell | undefined, head: NbCell | undefined, moved: boolean): CellPair {
  if (!base || !head) {
    const cell = (base ?? head)!;
    return {
      base,
      head,
      status: base ? 'removed' : 'added',
      moved: false,
      sourceChanged: true,
      outputsChanged: cell.outputs.length > 0,
      lines: base ? base.source.map((_, i) => ({ op: 'del', base: i })) : head!.source.map((_, i) => ({ op: 'add', head: i })),
    };
  }
  const lines = diffLines(base.source, head.source);
  const sourceChanged = lines.some(l => l.op !== 'same') || base.type !== head.type;
  const outputsChanged = base.outputs.map(o => o.hash).join() !== head.outputs.map(o => o.hash).join();
  return {
    base,
    head,
    status: sourceChanged || outputsChanged ? 'modified' : 'unchanged',
    moved,
    sourceChanged,
    outputsChanged,
    lines,
  };
}

/** Line diff: common prefix/suffix, then LCS on the middle. */
export function diffLines(a: string[], b: string[]): LineOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: LineOp[] = [];
  for (let i = 0; i < start; i++) {
    ops.push({ op: 'same', base: i, head: i });
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > 4_000_000) {
    midA.forEach((_, i) => ops.push({ op: 'del', base: start + i }));
    midB.forEach((_, i) => ops.push({ op: 'add', head: start + i }));
  } else {
    let i = 0;
    let j = 0;
    for (const [pi, pj] of lcsPairs(midA, midB)) {
      for (; i < pi; i++) {
        ops.push({ op: 'del', base: start + i });
      }
      for (; j < pj; j++) {
        ops.push({ op: 'add', head: start + j });
      }
      ops.push({ op: 'same', base: start + i++, head: start + j++ });
    }
    for (; i < midA.length; i++) {
      ops.push({ op: 'del', base: start + i });
    }
    for (; j < midB.length; j++) {
      ops.push({ op: 'add', head: start + j });
    }
  }
  for (let k = 0; k < a.length - endA; k++) {
    ops.push({ op: 'same', base: endA + k, head: endB + k });
  }
  return ops;
}

/** Index pairs of a longest common subsequence. */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (!n || !m) {
    return [];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i++, j++]);
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** Indexes of a longest strictly increasing subsequence. */
function longestIncreasing(values: number[]): number[] {
  const tails: number[] = [];
  const prev = new Array<number>(values.length).fill(-1);
  values.forEach((v, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < v) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0) {
      prev[i] = tails[lo - 1];
    }
    tails[lo] = i;
  });
  const out: number[] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) {
    out.push(k);
  }
  return out.reverse();
}
