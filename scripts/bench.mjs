// Compares the speed of a git ref (default HEAD) with the working tree, and prints the mean time
// difference with a 95% bootstrap confidence interval. Runs alternate between the two versions,
// each in a fresh process.
//
//   npm run bench -- [--before REF] [--runs N] viewModel BASE.ipynb HEAD.ipynb PATCH [...]
//   npm run bench -- [--before REF] [--runs N] activate
//   GH_TOKEN=$(gh auth token) npm run bench -- [--runs N] openPr owner/repo#123
import { build } from 'esbuild';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i < 0) {
    return fallback;
  }
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};
const before = flag('--before', 'HEAD');
const runs = Number(flag('--runs', '20'));
const [task, ...taskArgs] = argv;
if (!task) {
  console.error('usage: npm run bench -- [--before REF] [--runs N] viewModel|activate|openPr ARGS…');
  process.exit(1);
}

const root = resolve('out/bench');
rmSync(root, { recursive: true, force: true });
mkdirSync(`${root}/before`, { recursive: true });
execSync(`git archive ${before} | tar -x -C ${root}/before`);
symlinkSync(resolve('node_modules'), `${root}/before/node_modules`);

// The bench entry and the extension bundle, for both versions.
const common = { bundle: true, minify: true, platform: 'node', mainFields: ['module', 'main'], logLevel: 'error' };
async function prepare(dir, name) {
  const out = `${root}/${name}`;
  mkdirSync(`${out}`, { recursive: true });
  // The same bench entry for both versions, next to that version's sources.
  if (dir !== resolve('.')) {
    mkdirSync(`${dir}/scripts`, { recursive: true });
    execSync(`cp scripts/bench-entry.ts ${dir}/scripts/bench-entry.ts`);
  }
  await build({ ...common, format: 'esm', entryPoints: [`${dir}/scripts/bench-entry.ts`], outfile: `${out}/entry.mjs` });
  execSync('node scripts/build.mjs', { cwd: dir, stdio: 'ignore' });
  // Activation: load the extension bundle with a stand-in for the vscode module.
  writeFileSync(`${out}/activate.cjs`, `
const Module = require('module');
const load = Module._load;
const stub = new Proxy(function () {}, { get: (_, k) => (k === '__esModule' ? false : stub), apply: () => stub, construct: () => stub });
Module._load = (request, ...rest) => (request === 'vscode' ? stub : load(request, ...rest));
const t0 = performance.now();
require(${JSON.stringify(`${dir}/dist/extension.js`)});
console.log(JSON.stringify({ require: performance.now() - t0 }));
`);
  return out;
}
const sides = { before: await prepare(`${root}/before`, 'before-out'), after: await prepare(resolve('.'), 'after-out') };

function runOnce(side) {
  const dir = sides[side];
  const cmd = task === 'activate' ? ['node', [`${dir}/activate.cjs`]] : ['node', [`${dir}/entry.mjs`, task, ...taskArgs]];
  return JSON.parse(execFileSync(cmd[0], cmd[1], { encoding: 'utf8', env: process.env }).trim().split('\n').pop());
}

const samples = { before: [], after: [] };
for (let i = 0; i < runs; i++) {
  const order = Math.random() < 0.5 ? ['before', 'after'] : ['after', 'before'];
  for (const side of order) {
    samples[side].push(runOnce(side));
  }
  process.stderr.write(`\r${i + 1}/${runs}`);
}
process.stderr.write('\n');

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
function bootstrapCi(a, b, iterations = 10000) {
  const diffs = [];
  for (let k = 0; k < iterations; k++) {
    const pick = xs => mean(Array.from({ length: xs.length }, () => xs[Math.floor(Math.random() * xs.length)]));
    diffs.push(pick(a) - pick(b));
  }
  diffs.sort((x, y) => x - y);
  return [diffs[Math.floor(iterations * 0.025)], diffs[Math.floor(iterations * 0.975)]];
}

console.log(`\n${task}: ${before} vs working tree, ${runs} runs each`);
for (const metric of Object.keys(samples.before[0])) {
  const a = samples.before.map(s => s[metric]);
  const b = samples.after.map(s => s[metric]);
  const [lo, hi] = bootstrapCi(a, b);
  const verdict = lo > 0 ? 'faster/smaller' : hi < 0 ? 'SLOWER/LARGER' : 'no clear difference';
  console.log(
    `${metric.padEnd(10)} before ${mean(a).toFixed(2).padStart(9)}  after ${mean(b).toFixed(2).padStart(9)}  ` +
    `saved ${(mean(a) - mean(b)).toFixed(2).padStart(8)} (95% CI ${lo.toFixed(2)} … ${hi.toFixed(2)}, ${((1 - mean(b) / mean(a)) * 100).toFixed(1)}%)  ${verdict}`,
  );
}
