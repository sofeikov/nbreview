// One benchmark run, in its own process: `node bench-entry.mjs <task> <args…>` prints JSON timings.
// scripts/bench.mjs bundles this file twice, against the sources at a git ref and in the working
// tree, and compares the two.
import { readFileSync } from 'node:fs';
import { parseNotebook } from '../src/core/notebook.ts';
import { buildReviewDoc } from '../src/core/reviewDoc.ts';
import { parsePatch } from '../src/core/patch.ts';
import { buildViewModel } from '../src/viewModel.ts';
import { GitHub } from '../src/github.ts';
import { ReviewSession } from '../src/session.ts';

const [task, ...args] = process.argv.slice(2);

/** Time to build the review page data for notebook pairs: `base.ipynb head.ipynb [patch]` triples. */
function viewModel(paths: string[]): Record<string, number> {
  const pairs: { base: string; head: string; patch: string }[] = [];
  for (let i = 0; i < paths.length; i += 3) {
    pairs.push({ base: readFileSync(paths[i], 'utf8'), head: readFileSync(paths[i + 1], 'utf8'), patch: paths[i + 2] ? readFileSync(paths[i + 2], 'utf8') : '' });
  }
  const once = () => {
    let bytes = 0;
    for (const p of pairs) {
      const entry = {
        path: 'nb.ipynb',
        file: { filename: 'nb.ipynb', status: 'modified' as const, additions: 0, deletions: 0, patch: p.patch },
        base: buildReviewDoc(parseNotebook(p.base)),
        head: buildReviewDoc(parseNotebook(p.head)),
        commentable: parsePatch(p.patch),
      };
      // The page receives the model as a message, so serialising it is part of the cost.
      bytes += JSON.stringify(buildViewModel(entry, { number: 1, title: '', url: '' })).length;
    }
    return bytes;
  };
  const t0 = performance.now();
  const bytes = once();
  const cold = performance.now() - t0;
  const runs = 15;
  const t1 = performance.now();
  for (let i = 0; i < runs; i++) {
    once();
  }
  return { cold, warm: (performance.now() - t1) / runs, bytes };
}

/** Time to open a pull request: everything the extension fetches and prepares before showing it. */
async function openPr(ref: string): Promise<Record<string, number>> {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref);
  if (!m || !process.env.GH_TOKEN) {
    throw new Error('usage: openPr owner/repo#123, with GH_TOKEN set');
  }
  const t0 = performance.now();
  const session = await ReviewSession.load(new GitHub(process.env.GH_TOKEN), m[1], m[2], Number(m[3]));
  return { total: performance.now() - t0, notebooks: session.notebooks.size, files: session.files.length, threads: session.placed.length, viewed: [...session.viewed.values()].filter(Boolean).length };
}

const result = task === 'viewModel' ? viewModel(args) : task === 'openPr' ? await openPr(args[0]) : undefined;
if (!result) {
  throw new Error(`unknown task ${task}`);
}
console.log(JSON.stringify(result));
