// Writes out/demo/index.html: the visual review page for the demo notebooks in docs/demo, with a
// sample review thread, running outside VS Code. Used for the README screenshots and to work on
// the page without a pull request. Run with `npm run demo`, then serve out/demo over HTTP.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseNotebook } from '../src/core/notebook.ts';
import { buildReviewDoc, docLineForSource } from '../src/core/reviewDoc.ts';
import { parsePatch } from '../src/core/patch.ts';
import { buildThreads, buildViewModel } from '../src/viewModel.ts';
import type { NotebookEntry, PlacedThread } from '../src/session.ts';
import type { Draft } from '../src/state.ts';

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
      comments: [
        { author: 'maria', body: 'Why `C=0.5`? Was it tuned on the validation folds?', createdAt: hoursAgo(5), url: 'https://github.com/' },
        { author: 'tom', body: 'Yes, a grid search over 0.1–2.0. The sweep is in `03_tuning.ipynb`.', createdAt: hoursAgo(2), url: 'https://github.com/' },
      ],
    },
  },
] as unknown as PlacedThread[];
const outputLine = entry.head.lines.findIndex(l => l.kind === 'output' && l.cell.id === 'fit');
const drafts: Draft[] = [
  {
    key: 'draft-1',
    nbPath: path,
    side: 'RIGHT',
    startDocLine: outputLine,
    endDocLine: outputLine,
    text: 'The curve is **much closer to the diagonal** now. Can we add the Brier score next to it?',
  },
];
const threads = buildThreads(entry, placed, drafts, () => 'Pending · comment on the output → nbs/02_xg_model.ipynb L48');

mkdirSync('out/demo', { recursive: true });
cpSync('dist', 'out/demo/dist', { recursive: true });
writeFileSync('out/demo/data.js', `window.__MODEL__ = ${JSON.stringify(model)};\nwindow.__THREADS__ = ${JSON.stringify(threads)};\n`);
writeFileSync('out/demo/index.html', `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Notebook Review demo</title>
<link rel="stylesheet" href="dist/katex/katex.min.css">
<link rel="stylesheet" href="dist/codicons/codicon.css">
<link rel="stylesheet" href="dist/webview.css">
<style>
/* The theme variables VS Code gives a webview, from the Dark Modern theme. */
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
}
</style>
</head>
<body class="vscode-dark" data-path="${path}">
<div id="app"></div>
<script>
// Messages are delivered synchronously so the page is fully drawn when the load event fires
// (headless screenshots are taken then).
const deliver = data => window.dispatchEvent(new MessageEvent('message', { data }));
window.acquireVsCodeApi = () => ({
  postMessage(m) {
    // Answer like the extension does, so a new comment shows where it will land on GitHub.
    if (m.type === 'plan') {
      deliver({ type: 'plan', requestId: m.requestId, describe: 'Will post as a line comment · cell line 2 → ${path} L41' });
    }
  },
  getState() { return undefined; },
  setState() {},
});
</script>
<script src="data.js"></script>
<script src="dist/webview.js"></script>
<script>
deliver({ type: 'model', model: window.__MODEL__ });
deliver({ type: 'threads', threads: window.__THREADS__ });
deliver({ type: 'state', state: { viewed: false, pending: 1 } });
// Scenes for the README screenshots: index.html#outputs, #comment, #submit.
const scene = location.hash.slice(1);
// Headless Firefox captures from the top of the page, so a scene hides the cells above its subject.
const scrollTo = el => {
  const card = el && el.closest('main > *');
  for (let prev = card && card.previousElementSibling; prev; prev = prev.previousElementSibling) {
    prev.style.display = 'none';
  }
};
if (scene === 'outputs') {
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
