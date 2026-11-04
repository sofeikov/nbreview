// Writes out/demo/index.html, the visual review page for the demo notebooks in docs/demo with
// sample review threads, and out/demo/overview.html, the Overview page of the same made-up pull
// request, both running outside VS Code. Used for the README screenshots and to work on the pages
// without a pull request. Run with `npm run demo`, then serve out/demo over HTTP.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseNotebook } from '../src/core/notebook.ts';
import { buildReviewDoc, docLineForSource } from '../src/core/reviewDoc.ts';
import { parsePatch } from '../src/core/patch.ts';
import { buildFileThreads, buildFileViewModel, buildThreads, buildViewModel } from '../src/viewModel.ts';
import type { FileThread, NotebookEntry, PlacedThread, ReviewSession } from '../src/session.ts';
import type { GhOverview } from '../src/github.ts';
import { buildOverview } from '../src/overviewModel.ts';
import { diffCells } from '../src/core/cellDiff.ts';
import { checkFile, checkNotebook } from '../src/core/checks.ts';

const path = 'nbs/02_xg_model.ipynb';
const patch = readFileSync('docs/demo/xg_model.patch', 'utf8');
const entry: NotebookEntry = {
  path,
  file: { filename: path, status: 'modified', additions: 11, deletions: 6, patch },
  base: buildReviewDoc(parseNotebook(readFileSync('docs/demo/xg_model.base.ipynb', 'utf8'))),
  head: buildReviewDoc(parseNotebook(readFileSync('docs/demo/xg_model.head.ipynb', 'utf8'))),
  commentable: parsePatch(patch),
};
const model = buildViewModel(entry, { number: 42, title: 'Add a body-part term to the xG model', url: 'https://github.com/' });

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
const placed = [
  {
    nbPath: path,
    side: 'RIGHT',
    docLine: docLineForSource(entry.head, 'fit', 0)!,
    gh: {
      id: 'thread-1',
      isResolved: false,
      isOutdated: false,
      viewerCanResolve: true,
      viewerCanUnresolve: false,
      comments: [
        {
          id: 'c-1', author: 'maria', body: 'Why `C=0.5`? Was it tuned on the validation folds?', createdAt: hoursAgo(5), url: 'https://github.com/', pending: false,
          viewerCanUpdate: false, viewerCanDelete: false, reactions: [],
        },
        {
          id: 'c-2', author: 'tom', body: 'Yes, a grid search over 0.1–2.0. The sweep is in `03_tuning.ipynb`.', createdAt: hoursAgo(2), url: 'https://github.com/', pending: false,
          viewerCanUpdate: false, viewerCanDelete: false,
          reactions: [{ content: 'THUMBS_UP', count: 2, viewerHasReacted: true }, { content: 'HOORAY', count: 1, viewerHasReacted: false }],
        },
      ],
    },
  },
  {
    // A comment in the reviewer's pending review, on the new plot.
    nbPath: path,
    side: 'RIGHT',
    docLine: entry.head.lines.findIndex(l => l.kind === 'output' && l.cell.id === 'fit'),
    gh: {
      id: 'thread-2',
      isResolved: false,
      isOutdated: false,
      viewerCanResolve: false,
      viewerCanUnresolve: false,
      subjectType: 'LINE',
      path,
      line: 48,
      comments: [
        {
          id: 'pending-1', author: 'you', body: 'The curve is **much closer to the diagonal** now. Can we add the Brier score next to it?', createdAt: hoursAgo(0.1), url: '', pending: true,
          viewerCanUpdate: true, viewerCanDelete: true, reactions: [],
        },
      ],
    },
  },
] as unknown as PlacedThread[];
const threads = buildThreads(entry, placed, () => 'Pending · comment on the output → nbs/02_xg_model.ipynb L48');

// Another file of the same pull request, shown as one cell: the training module.
const trainBase = `"""Train the xG model on the latest shots."""
import pandas as pd
from sklearn.linear_model import LogisticRegression


def train(path: str) -> LogisticRegression:
    shots = pd.read_parquet(path)
    model = LogisticRegression()
    model.fit(shots[["distance", "angle"]], shots["goal"])
    return model
`;
const trainHead = `"""Train the xG model on the latest shots."""
import pandas as pd
from sklearn.linear_model import LogisticRegression

FEATURES = ["distance", "angle", "header"]


def train(path: str, c: float = 0.5) -> LogisticRegression:
    shots = pd.read_parquet(path)
    shots["header"] = (shots["body_part"] == "head").astype(int)
    model = LogisticRegression(C=c, max_iter=500)
    model.fit(shots[FEATURES], shots["goal"])
    return model
`;
const trainFile = { filename: 'src/xg/train.py', status: 'modified' as const, additions: 6, deletions: 3, patch: '' };
const fileModel = buildFileViewModel(trainFile, trainBase, trainHead, { number: 42, title: 'Add a body-part term to the xG model', url: 'https://github.com/' });
const fileThreads = buildFileThreads([
  {
    path: trainFile.filename,
    side: 'RIGHT',
    docLine: 7,
    gh: {
      id: 'file-thread-1', isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: false, subjectType: 'LINE',
      comments: [{
        id: 'fc-1', author: 'maria', body: 'Could `c` come from `configs/xg.toml` instead of a default here, so the notebook and the pipeline agree?',
        createdAt: hoursAgo(3), url: 'https://github.com/', pending: false, viewerCanUpdate: false, viewerCanDelete: false,
        reactions: [{ content: 'THUMBS_UP', count: 1, viewerHasReacted: true }],
      }],
    },
  },
] as unknown as FileThread[], () => '');

// --- The checks: a notebook and a module that add a key, a password, a local path and more -------

// Made-up keys, put together at run time so this file has nothing that looks like a key (GitHub's
// push protection would refuse it).
const fakeKey = (n: number, seed: number) => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let x = seed;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out += chars[(x >>> 16) % chars.length];
  }
  return out;
};
const hfToken = ['hf', fakeKey(34, 11)].join('_');
const dbPassword = fakeKey(16, 12);
const ghToken = ['ghp', fakeKey(36, 13)].join('_');

const checksPath = 'nbs/03_shot_map.ipynb';
const code = (id: string, source: string, count: number | null, outputs: unknown[] = []) =>
  ({ cell_type: 'code', id, metadata: {}, execution_count: count, outputs, source });
const md = (id: string, source: string) => ({ cell_type: 'markdown', id, metadata: {}, source });
const result = (count: number, text: string) => ({ output_type: 'execute_result', execution_count: count, data: { 'text/plain': text }, metadata: {} });
const notebookJson = (cells: unknown[]) => JSON.stringify({ cells, metadata: { kernelspec: { language: 'python', name: 'python3' } }, nbformat: 4, nbformat_minor: 5 }, null, 1);
const checksBase = notebookJson([
  md('intro', '# Shot map\n\nShots of the 2024 season on one pitch.'),
  code('setup', 'import pandas as pd\nfrom sqlalchemy import create_engine', 1),
  code('load', 'shots = pd.read_parquet("data/shots_2024.parquet")\nlen(shots)', 2, [result(2, '18234')]),
  code('xg', 'shots["xg"] = model.predict_proba(shots[FEATURES])[:, 1]\nshots["xg"].sum()', 3, [result(3, '1912.4')]),
]);
const checksHead = notebookJson([
  md('intro', '# Shot map\n\nShots of the 2024 season on one pitch.'),
  code('setup', `import pandas as pd\nfrom sqlalchemy import create_engine\nfrom huggingface_hub import login\n\nlogin("${hfToken}")\nengine = create_engine("postgresql://analyst:${dbPassword}@db.internal:5432/shots")`, 1),
  code('load', 'shots = pd.read_sql("select * from shots where season = 2024", engine)\nshots.to_parquet("/home/maria/data/shots_2024.parquet")\nprint("Saved to /home/maria/data/shots_2024.parquet")\nlen(shots)', 4, [
    { output_type: 'stream', name: 'stdout', text: 'Saved to /home/maria/data/shots_2024.parquet\n' },
    result(4, '18311'),
  ]),
  code('xg', 'shots["xg"] = model.predict_proba(shots[FEATURES + ["header"]])[:, 1]\nshots["xg"].sum()', 3, [result(3, '1912.4')]),
  code('plot', 'plot_shot_map(shots, by="body_part")', 5, [{
    output_type: 'error', ename: 'KeyError', evalue: "'body_part'",
    traceback: ['KeyError                                  Traceback (most recent call last)', 'Cell In[5], line 1', '----> 1 plot_shot_map(shots, by="body_part")', "KeyError: 'body_part'"],
  }]),
]);
const checksEntry: NotebookEntry = {
  path: checksPath,
  file: { filename: checksPath, status: 'modified', additions: 14, deletions: 5, patch: '' },
  base: buildReviewDoc(parseNotebook(checksBase)),
  head: buildReviewDoc(parseNotebook(checksHead)),
  commentable: parsePatch(''),
};
const checksPr = { number: 43, title: 'Shot map from the database', url: 'https://github.com/' };
const checksModel = {
  ...buildViewModel(checksEntry, checksPr),
  findings: checkNotebook(diffCells(checksEntry.base.notebook.cells, checksEntry.head.notebook.cells)),
};

const syncBase = `"""Copy the shot data to the analytics bucket."""
import requests


def upload(path: str) -> None:
    with open(path, "rb") as f:
        requests.put(BUCKET_URL, data=f)
`;
const syncHead = `"""Copy the shot data to the analytics bucket."""
import requests

GITHUB_TOKEN = "${ghToken}"
CACHE = "/Users/tom/Library/Caches/shots"


def upload(path: str) -> None:
    with open(path, "rb") as f:
        requests.put(BUCKET_URL, data=f, headers={"Authorization": f"Bearer {GITHUB_TOKEN}"})
`;
const syncFile = { filename: 'src/xg/sync.py', status: 'modified' as const, additions: 3, deletions: 1, patch: '' };
const syncModel = buildFileViewModel(syncFile, syncBase, syncHead, checksPr);
const syncAdded = syncModel.cells[0].ops.flatMap(o => (o.op === 'add' ? [{ index: o.h, text: syncHead.split('\n')[o.h] }] : []));
const checksFileModel = { ...syncModel, findings: checkFile(syncFile.filename, syncBase.split('\n'), syncAdded) };

// --- The range picker: the same pull request after a review and two more commits -----------------

// The notebook as it was at the reviewer's last review: as now, except the fit cell.
const reviewedJson = JSON.parse(readFileSync('docs/demo/xg_model.head.ipynb', 'utf8'));
const reviewedFit = reviewedJson.cells.find((c: { id: string }) => c.id === 'fit');
reviewedFit.source = (reviewedFit.source as string[]).map(l => l.replace('C=0.5', 'C=1.0'));
const reviewedDoc = buildReviewDoc(parseNotebook(JSON.stringify(reviewedJson)));
const demoPr = { number: 42, title: 'Add a body-part term to the xG model', url: 'https://github.com/' };
const sha = (seed: string) => (seed.repeat(40)).slice(0, 40);
const rangeCommits = [
  { sha: sha('3fa9c1'), parent: sha('0b11e2'), headline: 'Add a header flag to the shot loader', author: 'tom', date: hoursAgo(50), touches: true },
  { sha: sha('8d02be'), parent: sha('3fa9c1'), headline: 'Refit the model with the new feature', author: 'tom', date: hoursAgo(49), touches: true },
  { sha: sha('c41f7a'), parent: sha('8d02be'), headline: 'Bump scikit-learn to 1.5', author: 'tom', date: hoursAgo(30), touches: false },
  { sha: sha('e7a3d5'), parent: sha('c41f7a'), headline: 'Tune C on the validation folds', author: 'tom', date: hoursAgo(3), touches: true },
];
const reviewSha = rangeCommits[1].sha;
const sinceModel = buildViewModel(entry, demoPr, { base: reviewedDoc, describe: 'since your review on 2 Nov (8d02be8)', readOnly: false });
const commitModel = buildViewModel(entry, demoPr, { head: reviewedDoc, describe: 'in 3fa9c13', readOnly: true });

const THEME = `/* The theme variables VS Code gives a webview, from the Dark Modern theme. */
html {
  --vscode-font-family: system-ui, "Segoe UI", Ubuntu, sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: "Droid Sans Mono", "DejaVu Sans Mono", monospace; --vscode-editor-font-size: 13px;
  --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d; --vscode-editor-background: #1f1f1f;
  --vscode-sideBar-background: #181818; --vscode-widget-border: #313131; --vscode-editorWidget-background: #202020;
  --vscode-button-background: #0078d4; --vscode-button-foreground: #ffffff; --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc;
  --vscode-badge-background: #616161; --vscode-badge-foreground: #f8f8f8;
  --vscode-diffEditor-insertedLineBackground: rgba(155, 185, 85, 0.2); --vscode-diffEditor-removedLineBackground: rgba(255, 0, 0, 0.2);
  --vscode-textLink-foreground: #4daafc; --vscode-input-background: #313131; --vscode-input-border: #3c3c3c;
  --vscode-input-foreground: #cccccc; --vscode-focusBorder: #0078d4; --vscode-textCodeBlock-background: #2b2b2b;
  --vscode-editorLineNumber-foreground: #6e7681; --vscode-toolbar-hoverBackground: rgba(90, 93, 94, 0.31);
  --vscode-textBlockQuote-background: #2b2b2b; --vscode-textBlockQuote-border: #616161;
  --vscode-list-hoverBackground: #2a2d2e; --vscode-list-inactiveSelectionBackground: #37373d;
  --vscode-errorForeground: #f85149; --vscode-widget-shadow: rgba(0, 0, 0, 0.36);
}`;

mkdirSync('out/demo', { recursive: true });
cpSync('dist', 'out/demo/dist', { recursive: true });
writeFileSync('out/demo/data.js', [
  `window.__MODEL__ = ${JSON.stringify(model)};`,
  `window.__THREADS__ = ${JSON.stringify(threads)};`,
  `window.__FILE_MODEL__ = ${JSON.stringify(fileModel)};`,
  `window.__FILE_THREADS__ = ${JSON.stringify(fileThreads)};`,
  `window.__CHECKS_MODEL__ = ${JSON.stringify(checksModel)};`,
  `window.__CHECKS_FILE_MODEL__ = ${JSON.stringify(checksFileModel)};`,
  `window.__SINCE_MODEL__ = ${JSON.stringify(sinceModel)};`,
  `window.__COMMIT_MODEL__ = ${JSON.stringify(commitModel)};`,
  `window.__COMMITS__ = ${JSON.stringify(rangeCommits)};`,
  `window.__REVIEW_SHA__ = ${JSON.stringify(reviewSha)};`,
].join('\n') + '\n');
writeFileSync('out/demo/index.html', `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Notebook Review demo</title>
<link rel="stylesheet" href="dist/katex/katex.min.css">
<link rel="stylesheet" href="dist/webview.css">
<style>
${THEME}
</style>
</head>
<body class="vscode-dark" data-path="${path}">
<div id="app"></div>
<script>
// Messages are delivered synchronously so the page is fully drawn when the load event fires
// (headless screenshots are taken then).
const deliver = data => window.dispatchEvent(new MessageEvent('message', { data }));
const panelState = { viewed: false, pending: 1, pendingReview: true, comments: 'all' };
window.__posted = [];
window.acquireVsCodeApi = () => ({
  postMessage(m) {
    window.__posted.push(m);
    // Answer like the extension does, so a new comment shows where it will land on GitHub.
    if (m.type === 'plan') {
      deliver({ type: 'plan', requestId: m.requestId, describe: location.hash.startsWith('#checks') ? 'Will post as a line comment → ' + model.path : 'Will post as a line comment · cell line 2 → ${path} L41' });
    }
    if (m.type === 'loadCommits') {
      deliver({ type: 'commits', head: window.__COMMITS__[3].sha, commits: window.__COMMITS__ });
    }
    if (m.type === 'setCommentFilter') {
      panelState.comments = m.filter;
      deliver({ type: 'state', state: panelState });
    }
  },
  getState() { return undefined; },
  setState() {},
});
</script>
<script src="data.js"></script>
<script src="dist/webview.js"></script>
<script>
// Scenes for the README screenshots: index.html#outputs (a changed plot), #comment, #submit, and
// #file (another file of the pull request). The checks: #checks (a notebook with findings),
// #checks-list (their list in the toolbar), #checks-comment (a comment started from one) and
// #checks-file (a Python module with findings). #nav shows code navigation (Ctrl held over a
// name) and #navtest checks Ctrl+click in the browser, writing the results on the page.
const scene = location.hash.slice(1);
// The range picker: #range (on "Since your review", the default) and #range-commit (one earlier
// commit picked, so the page is read-only).
const checks = scene.startsWith('checks');
const models = { file: window.__FILE_MODEL__, 'checks-file': window.__CHECKS_FILE_MODEL__, range: window.__SINCE_MODEL__, 'range-commit': window.__COMMIT_MODEL__ };
const model = models[scene] ?? (checks ? window.__CHECKS_MODEL__ : window.__MODEL__);
deliver({ type: 'model', model });
deliver({ type: 'threads', threads: scene === 'file' ? window.__FILE_THREADS__ : checks || scene === 'range-commit' ? [] : window.__THREADS__ });
if (scene.startsWith('range')) {
  const first = window.__COMMITS__[0].sha;
  panelState.range = scene === 'range'
    ? { choice: { kind: 'since' }, label: 'Since your review', auto: true, readOnly: false, review: { label: 'your review on 2 Nov (8d02be8)', sha: window.__REVIEW_SHA__ }, commits: 4, head: window.__COMMITS__[3].sha }
    : { choice: { kind: 'commits', first, last: first }, label: 'Commit ' + first.slice(0, 7), auto: false, readOnly: true, review: { label: 'your review on 2 Nov (8d02be8)', sha: window.__REVIEW_SHA__ }, commits: 4, head: window.__COMMITS__[3].sha };
}
deliver({ type: 'state', state: panelState });
// Headless Firefox captures from the top of the page, so a scene hides the cells above its subject.
const scrollTo = el => {
  const card = el && el.closest('main > *');
  for (let prev = card && card.previousElementSibling; prev; prev = prev.previousElementSibling) {
    prev.style.display = 'none';
  }
};
if (scene === 'outputs') {
  // The changed plot, in the Swipe view: the old curve left of the divider, the new one right.
  const swipe = [...document.querySelectorAll('section.cell[data-key="fit"] .image-compare .segmented button')].find(b => b.textContent === 'Swipe');
  swipe.click();
  scrollTo(document.querySelector('section.cell[data-key="fit"] .outputs'));
}
if (scene === 'comment') {
  const plus = document.querySelector('.code[data-cell="load"][data-side="RIGHT"][data-line="1"] .add-comment');
  plus.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  window.dispatchEvent(new MouseEvent('mouseup'));
  const area = document.querySelector('.composer textarea');
  area.value = 'Should other body parts (chest, knee) get their own flag, or is "header vs. not" enough?';
  area.dispatchEvent(new Event('input'));
  scrollTo(document.querySelector('section.cell[data-key="load"]'));
}
if (scene.startsWith('range')) {
  document.querySelector('.range-wrap > button').click();
}
// #navtest: Ctrl+click checked in a real browser; the results are written on the page.
if (scene === 'navtest') {
  panelState.local = { branch: 'main', atHead: true };
  deliver({ type: 'state', state: panelState });
  const out = {};
  const text = document.querySelector('.code[data-cell="fit"][data-side="RIGHT"] .text');
  const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
  let node, hit;
  while ((node = walker.nextNode())) { const i = node.textContent.indexOf('LogisticRegression'); if (i >= 0) { hit = [node, i]; break; } }
  const r = document.createRange();
  r.setStart(hit[0], hit[1] + 5);
  r.setEnd(hit[0], hit[1] + 6);
  const b = r.getBoundingClientRect();
  const ev = (type, ctrlKey) => new MouseEvent(type, { bubbles: true, cancelable: true, ctrlKey, clientX: b.left + 1, clientY: b.top + b.height / 2 });
  text.dispatchEvent(ev('mousemove', true));
  out.underlined = CSS.highlights && CSS.highlights.has('nav-target') ? [...CSS.highlights.get('nav-target')][0].toString() : null;
  out.pointer = document.body.classList.contains('nav-target');
  text.dispatchEvent(ev('click', false));
  out.plainClickSent = window.__posted.filter(m => m.type === 'goToDefinition').length;
  text.dispatchEvent(ev('click', true));
  out.sent = window.__posted.filter(m => m.type === 'goToDefinition').map(m => ({ name: m.name, column: m.column, line: m.at.line, text: m.at.text, cell: m.at.cell && m.at.cell.id }));
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }));
  out.clearedOnKeyup = !(CSS.highlights && CSS.highlights.has('nav-target'));
  document.body.insertAdjacentHTML('afterbegin', '<pre id="navtest" style="position:fixed;top:0;left:0;right:0;z-index:99;background:#000;color:#0f0;font-size:16px;padding:12px;white-space:pre-wrap">' + JSON.stringify(out, null, 1).replace(/</g, '&lt;') + '</pre>');
}
// #nav: code navigation, with a clone of the repository open on main. Ctrl is held over a name,
// which is underlined, and the note a definition from another commit gets is shown.
if (scene === 'nav') {
  panelState.local = { branch: 'main', atHead: false };
  deliver({ type: 'state', state: panelState });
  scrollTo(document.querySelector('section.cell[data-key="fit"]'));
  const text = document.querySelector('.code[data-cell="fit"][data-side="RIGHT"] .text');
  const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
  let node, hit;
  while ((node = walker.nextNode())) { const i = node.textContent.indexOf('LogisticRegression'); if (i >= 0) { hit = [node, i]; break; } }
  const r = document.createRange();
  r.setStart(hit[0], hit[1] + 5);
  r.setEnd(hit[0], hit[1] + 6);
  const b = r.getBoundingClientRect();
  text.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ctrlKey: true, clientX: b.left + 1, clientY: b.top + b.height / 2 }));
  deliver({ type: 'toast', message: 'From your checkout (main), which isn’t at the pull request’s latest commit.' });
}
if (scene === 'checks-list') {
  document.querySelector('.checks-wrap > button').click();
}
if (scene === 'checks-comment') {
  document.querySelector('.finding[data-finding="0"] button').click();
}
if (scene === 'submit') {
  document.querySelector('.submit-wrap > button').click();
  const area = document.querySelector('.submit-box textarea');
  area.value = 'Nice improvement. One question on the tuning, otherwise good to go.';
  area.dispatchEvent(new Event('input'));
}
</script>
</body>
</html>
`);
console.log('wrote out/demo/index.html');

// --- The Overview page ---------------------------------------------------------------------------

const daysAgo = (d: number) => hoursAgo(d * 24);
const people = {
  maria: { login: 'maria', avatarUrl: undefined },
  tom: { login: 'tom', avatarUrl: undefined },
  priya: { login: 'priya', avatarUrl: undefined },
};
const resolvedThread = {
  nbPath: path,
  side: 'RIGHT',
  docLine: docLineForSource(entry.head, 'load', 1)!,
  gh: {
    id: 'thread-3', isResolved: true, isOutdated: false, viewerCanResolve: false, viewerCanUnresolve: true, subjectType: 'LINE', path,
    comments: [{
      id: 'c-3', author: 'priya', body: 'Nit: `body_part` has `"Head"` capitalised in the 2023 data.', createdAt: daysAgo(1.2), url: 'https://github.com/',
      pending: false, viewerCanUpdate: false, viewerCanDelete: false, reactions: [],
    }, {
      id: 'c-4', author: 'tom', body: 'Good catch, lower-cased it in the loader.', createdAt: daysAgo(1.1), url: 'https://github.com/',
      pending: false, viewerCanUpdate: false, viewerCanDelete: false, reactions: [{ content: 'HEART', count: 1, viewerHasReacted: false }],
    }],
  },
} as unknown as PlacedThread;
const session = {
  pr: { owner: 'example-org', repo: 'xg-models', number: 42, title: 'Add a body-part term to the xG model', url: 'https://github.com/' },
  notebooks: new Map([[path, entry]]),
  placed: [...placed, resolvedThread],
  fileThreads: new Map([[trainFile.filename, [{
    path: trainFile.filename, side: 'RIGHT', docLine: 7,
    gh: {
      id: 'file-thread-1', isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: false, subjectType: 'LINE', path: trainFile.filename,
      comments: [{
        id: 'fc-1', author: 'maria', body: 'Could `c` come from `configs/xg.toml` instead of a default here, so the notebook and the pipeline agree?',
        createdAt: hoursAgo(3), url: 'https://github.com/', pending: false, viewerCanUpdate: false, viewerCanDelete: false,
        reactions: [{ content: 'THUMBS_UP', count: 1, viewerHasReacted: true }],
      }],
    },
  }]]]),
  content: async () => trainHead,
} as unknown as ReviewSession;
const check = (name: string, workflow: string | undefined, state: string, minutes: number, extra: object = {}) =>
  ({ name, workflow, state, required: false, startedAt: hoursAgo(2), completedAt: state === 'pending' ? undefined : new Date(Date.now() - 2 * 3600e3 + minutes * 60e3).toISOString(), url: 'https://github.com/', ...extra });
const scenes: Record<string, Partial<GhOverview>> = {
  // The default: approved by one reviewer, waiting on another, one check failing.
  '': {},
  ready: {
    reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
    reviewers: [{ ...people.maria, state: 'APPROVED', submittedAt: hoursAgo(1) }, { ...people.priya, state: 'APPROVED', submittedAt: daysAgo(1) }],
    checks: [check('test (3.12)', 'CI', 'success', 4, { required: true }), check('lint', 'CI', 'success', 1), check('docs', 'Docs', 'success', 2)] as any,
  },
  running: {
    mergeStateStatus: 'BLOCKED', mergeable: 'UNKNOWN',
    checks: [check('test (3.12)', 'CI', 'pending', 0, { required: true, description: 'In progress' }), check('lint', 'CI', 'success', 1)] as any,
  },
  merged: { state: 'MERGED', mergedBy: 'maria', mergedAt: hoursAgo(0.5), reviewDecision: 'APPROVED' },
  draft: { isDraft: true, mergeStateStatus: 'DRAFT', reviewDecision: undefined, reviewers: [] },
  behind: {
    reviewDecision: 'APPROVED', mergeStateStatus: 'BEHIND',
    reviewers: [{ ...people.maria, state: 'APPROVED', submittedAt: hoursAgo(1) }],
    checks: [check('test (3.12)', 'CI', 'success', 4, { required: true }), check('lint', 'CI', 'success', 1)] as any,
  },
};
const HEAD_SHA = 'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5';
// OVERVIEW_SCENE=ready-pushed is "ready" with commits pushed after the files were loaded.
const sceneName = process.env.OVERVIEW_SCENE ?? '';
(session.pr as { headSha: string }).headSha = sceneName.endsWith('-pushed') ? 'a1b2c3d4e5f6' : HEAD_SHA;
const scene = scenes[sceneName.replace(/-pushed$/, '')] ?? {};
const overview: GhOverview = {
  viewer: 'you',
  nodeId: 'PR_42',
  headSha: HEAD_SHA,
  headRefId: 'REF_1',
  canMerge: true,
  canPushHead: true,
  canUpdate: true,
  merge: {
    methods: ['MERGE', 'SQUASH', 'REBASE'],
    preferred: 'SQUASH',
    squashTitle: 'COMMIT_OR_PR_TITLE',
    squashMessage: 'COMMIT_MESSAGES',
    mergeTitle: 'MERGE_MESSAGE',
    mergeMessage: 'PR_TITLE',
  },
  lastCommit: { headline: 'Read C from configs/xg.toml', body: 'The notebook and the pipeline now share one value.' },
  title: 'Add a body-part term to the xG model',
  url: 'https://github.com/',
  state: 'OPEN',
  isDraft: false,
  author: people.tom,
  createdAt: daysAgo(2),
  body: [
    'Headers convert at about half the rate of shots with the foot from the same spot, so the model now gets a `header` flag.',
    '',
    '## What changed',
    '- `02_xg_model.ipynb`: adds the feature, refits, and redraws the calibration curve',
    '- `src/xg/train.py`: the same feature in the pipeline, with `C` as a parameter',
    '',
    '## Checklist',
    '- [x] Calibration curve redrawn',
    '- [x] Pipeline and notebook agree',
    '- [ ] Brier score in the model card',
    '',
    'Closes #31. cc @maria :tada:',
  ].join('\n'),
  reactions: [{ content: 'HOORAY', count: 2, viewerHasReacted: false }, { content: 'EYES', count: 1, viewerHasReacted: true }],
  baseRef: 'main',
  headRef: 'xg-body-part',
  additions: 128,
  deletions: 41,
  changedFiles: 4,
  commits: 5,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  reviewers: [
    { ...people.maria, state: 'APPROVED', submittedAt: hoursAgo(1) },
    { ...people.priya, state: 'REQUESTED' },
    { login: 'data-science', state: 'REQUESTED', team: true },
  ],
  assignees: [people.tom],
  labels: [{ name: 'model', color: '1d76db' }, { name: 'needs-review', color: 'fbca04' }, { name: 'xg', color: 'c5def5' }],
  milestone: 'Season 26/27 models',
  closingIssues: [{ number: 31, title: 'xG overrates headers from close range', url: 'https://github.com/', state: 'OPEN' }],
  checks: [
    check('test (3.11)', 'CI', 'failure', 3, { required: true, description: '2 tests failed' }),
    check('test (3.12)', 'CI', 'success', 4, { required: true }),
    check('lint', 'CI', 'success', 1),
    check('notebooks run', 'Notebooks', 'success', 9),
    check('docs', 'Docs', 'skipped', 0),
  ] as any,
  timeline: [
    { kind: 'commit', oid: 'a1b2c3d4e5f6', message: 'Add a header flag to the shot features', author: people.tom, createdAt: daysAgo(2.1), url: 'https://github.com/' },
    { kind: 'commit', oid: 'b2c3d4e5f6a1', message: 'Refit and redraw the calibration curve', author: people.tom, createdAt: daysAgo(2.05), url: 'https://github.com/' },
    { kind: 'event', event: 'reviewRequested', actor: people.tom, createdAt: daysAgo(2), subject: 'priya' },
    { kind: 'comment', id: 'ic-1', author: people.priya, createdAt: daysAgo(1.5), body: 'Is the 2023 data in yet? The headers there look odd.', url: 'https://github.com/', reactions: [] },
    { kind: 'review', id: 'r-1', author: people.priya, state: 'COMMENTED', createdAt: daysAgo(1.2), body: '', url: 'https://github.com/', reactions: [], commentIds: ['c-3'] },
    { kind: 'commit', oid: 'c3d4e5f6a1b2', message: 'Lower-case body_part when loading', author: people.tom, createdAt: daysAgo(1.1), url: 'https://github.com/' },
    { kind: 'event', event: 'forcePushed', actor: people.tom, createdAt: daysAgo(1) },
    { kind: 'review', id: 'r-2', author: people.maria, state: 'CHANGES_REQUESTED', createdAt: hoursAgo(5), body: 'Two things before this goes in: the `C` default, and where the tuning lives.', url: 'https://github.com/', reactions: [], commentIds: ['c-1', 'fc-1'] },
    { kind: 'review', id: 'r-3', author: people.tom, state: 'COMMENTED', createdAt: hoursAgo(2), body: '', url: 'https://github.com/', reactions: [], commentIds: ['c-2'] },
    { kind: 'commit', oid: 'd4e5f6a1b2c3', message: 'Read C from configs/xg.toml', author: people.tom, createdAt: hoursAgo(1.5), url: 'https://github.com/' },
    { kind: 'review', id: 'r-4', author: people.maria, state: 'APPROVED', createdAt: hoursAgo(1), body: 'Thanks, looks good now :rocket:', url: 'https://github.com/', reactions: [{ content: 'THUMBS_UP', count: 1, viewerHasReacted: false }], commentIds: [] },
  ],
  timelineMissing: 0,
  ...scene,
};
// The variables of VS Code's Light Modern theme that differ from the dark ones above.
const LIGHT_THEME = [
  '--vscode-foreground: #3b3b3b', '--vscode-descriptionForeground: #3b3b3b', '--vscode-editor-background: #ffffff',
  '--vscode-sideBar-background: #f8f8f8', '--vscode-widget-border: #e5e5e5', '--vscode-editorWidget-background: #f8f8f8',
  '--vscode-button-secondaryBackground: #e5e5e5', '--vscode-button-secondaryForeground: #3b3b3b',
  '--vscode-textLink-foreground: #005fb8', '--vscode-textCodeBlock-background: #f2f2f2', '--vscode-toolbar-hoverBackground: rgba(184, 184, 184, 0.31)',
  '--vscode-list-hoverBackground: #f2f2f2', '--vscode-widget-shadow: rgba(0, 0, 0, 0.16)', '--vscode-focusBorder: #005fb8',
  '--vscode-button-background: #005fb8', '--vscode-button-hoverBackground: #0258a8',
].join('; ');
const overviewVM = await buildOverview(overview, session);
writeFileSync('out/demo/overview-data.js', `window.__OVERVIEW__ = ${JSON.stringify(overviewVM)};\n`);
writeFileSync('out/demo/overview.html', `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Notebook Review overview demo</title>
<link rel="stylesheet" href="dist/overview.css">
<style>
${THEME}
</style>
</head>
<body class="vscode-dark" data-pr="example-org/xg-models#42">
<div id="app"></div>
<script>
const deliver = data => window.dispatchEvent(new MessageEvent('message', { data }));
window.acquireVsCodeApi = () => ({ postMessage(m) { console.log('message', m); }, getState() { return undefined; }, setState() {} });
</script>
<script>
// overview.html?still has no animations, for screenshots taken as soon as the page loads, and
// ?light shows the page in VS Code's Light Modern theme.
if (location.search.includes('still')) {
  document.head.insertAdjacentHTML('beforeend', '<style>*, *::before { animation: none !important; transition: none !important; }</style>');
}
if (location.search.includes('light')) {
  document.body.className = 'vscode-light';
  document.documentElement.style.cssText = ${JSON.stringify(LIGHT_THEME)};
}
</script>
<script src="overview-data.js"></script>
<script src="dist/overview.js"></script>
<script>
deliver({ type: 'overview', overview: window.__OVERVIEW__ });
deliver({ type: 'progress', progress: { files: 4, viewed: 2, pending: 1, pendingReview: true, unresolved: 2, nextFile: 'src/xg/train.py' } });
deliver({ type: 'loading', loading: false });
</script>
</body>
</html>
`);
console.log('wrote out/demo/overview.html');
