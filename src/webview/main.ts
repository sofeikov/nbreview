// The visual review page. Renders the notebook pair as cell cards (rendered markdown, highlighted
// code diffs, outputs) and the review threads, and sends comment actions back to the extension.
import DOMPurify from 'dompurify';
import type { Anchor, CellVM, CommentVM, HostMessage, OutputVM, PanelState, ReactionVM, Side, ThreadVM, ViewModel, WebviewMessage } from './protocol.ts';
import { REACTIONS, REACTION_NAMES, type ReactionContent } from '../core/reactions.ts';
import { diffPixels, pairImages, type ImagePair } from './imageDiff.ts';

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();

interface UiState {
  layout?: 'split' | 'unified';
  showAll: boolean;
  /** Markdown cells switched to their source diff. */
  mdSource: Record<string, boolean>;
  /** Expanded folds (unchanged cell groups and unchanged line runs). */
  expanded: Record<string, boolean>;
  /** Threads opened or closed by hand (resolved ones start closed). */
  threadOpen: Record<string, boolean>;
  /** Leave resolved threads out of the page. */
  hideResolved?: boolean;
  /** How a changed plot is compared with its old version. */
  imageMode?: ImageMode;
  scrollY?: number;
}

interface Composer {
  anchor: Anchor;
  text: string;
  describe?: string;
  saving?: number;
  savingMode?: 'review' | 'single';
}

const saved = (vscode.getState() ?? {}) as Partial<UiState>;
const ui: UiState = { showAll: false, mdSource: {}, expanded: {}, threadOpen: {}, ...saved };
let model: ViewModel | undefined;
let threads: ThreadVM[] = [];
/** The threads on the page: all of them, or the unresolved ones. */
let shown: ThreadVM[] = [];
let panel: PanelState = { viewed: false, pending: 0, pendingReview: false };
let requestSeq = 0;
const composers = new Map<string, Composer>();
const replies = new Map<string, { text: string; saving?: number; savingMode?: 'review' | 'single' }>();
/** The viewer's comments being edited, by id: their text, and whether the edit is being saved to GitHub. */
const edits = new Map<string, { text: string; saving?: boolean }>();
/** The comment whose reaction picker is open. */
let reactingTo: string | undefined;
let focusKey: string | undefined;
let restoredScroll = false;

const app = document.getElementById('app')!;

function post(msg: WebviewMessage): void {
  vscode.postMessage(msg);
}

function persist(): void {
  // `path` lets the extension reopen this tab after VS Code reloads.
  vscode.setState({ ...ui, scrollY: window.scrollY, path: document.body.dataset.path });
}

// --- DOM helpers -------------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) {
      continue;
    }
    if (k === 'class') {
      el.className = String(v);
    } else if (k === 'html') {
      el.innerHTML = sanitize(String(v));
    } else if (k === 'text') {
      el.textContent = String(v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2), v as EventListener);
    } else if (k === 'data') {
      for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) {
        if (dv !== undefined) {
          el.dataset[dk] = String(dv);
        }
      }
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids) {
    if (kid !== null && kid !== undefined && kid !== false) {
      el.append(kid);
    }
  }
  return el;
}

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'input', 'button'] });
}

/** SVGs of the codicons in icons.json, put in at build time. */
declare const __ICONS__: Record<string, string>;

function icon(name: string): HTMLElement {
  const el = h('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });
  el.innerHTML = __ICONS__[name] ?? '';
  return el;
}

function button(label: Child | Child[], onclick: (e: MouseEvent) => void, props: Record<string, unknown> = {}): HTMLButtonElement {
  return h('button', { type: 'button', ...props, onclick }, ...(Array.isArray(label) ? label : [label]));
}

function timeAgo(iso?: string): string {
  if (!iso) {
    return '';
  }
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return fmt.format(Math.round(seconds / size), unit);
    }
  }
  return 'just now';
}

function layout(): 'split' | 'unified' {
  return ui.layout ?? (window.innerWidth >= 960 ? 'split' : 'unified');
}

function anchorKey(a: Anchor): string {
  return [a.side, a.cellId, a.kind, a.start ?? '', a.end ?? '', a.outputIndex ?? ''].join('|');
}

// --- Rendering ---------------------------------------------------------------------------------

function render(): void {
  if (!model) {
    return;
  }
  const scroll = window.scrollY;
  const active = document.activeElement as HTMLElement | null;
  focusKey = active?.dataset.focusKey;
  const caret = active instanceof HTMLTextAreaElement ? active.selectionStart : undefined;

  shown = ui.hideResolved ? threads.filter(t => !t.resolved) : threads;
  app.replaceChildren(renderToolbar(model), renderCells(model), h('div', { class: 'toast', id: 'toast' }));
  if (!restoredScroll) {
    restoredScroll = true;
    window.scrollTo(0, ui.scrollY ?? 0);
  } else {
    window.scrollTo(0, scroll);
  }
  if (focusKey) {
    const el = app.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (el instanceof HTMLTextAreaElement && caret !== undefined && caret !== null) {
        el.setSelectionRange(caret, caret);
      }
    }
  }
}

function renderToolbar(m: ViewModel): HTMLElement {
  const slash = m.path.lastIndexOf('/');
  const linesTitle = `Source lines. GitHub counts +${m.fileStats.additions} −${m.fileStats.deletions} in the .ipynb file, outputs and metadata included.`;
  const chips: Child[] = [
    h('span', { class: 'chip add', text: `+${m.stats.additions}`, title: linesTitle }),
    h('span', { class: 'chip del', text: `−${m.stats.deletions}`, title: linesTitle }),
  ];
  const describe: string[] = [];
  if (m.stats.modified) describe.push(`${m.stats.modified} modified`);
  if (m.stats.added) describe.push(`${m.stats.added} added`);
  if (m.stats.removed) describe.push(`${m.stats.removed} removed`);
  if (m.stats.moved) describe.push(`${m.stats.moved} moved`);
  const segmented = (options: [string, string, boolean, () => void][]) =>
    h('div', { class: 'segmented' }, ...options.map(([label, title, on, act]) => button(label, act, { class: on ? 'on' : '', title })));
  return h(
    'header',
    { class: 'toolbar' },
    h(
      'div',
      { class: 'title' },
      icon('notebook'),
      h('span', { class: 'dir', text: slash >= 0 ? m.path.slice(0, slash + 1) : '' }),
      h('span', { class: 'file', text: m.path.slice(slash + 1) }),
      h('a', { class: 'pr', href: m.pr.url, title: `${m.pr.title} (open on GitHub)`, text: `#${m.pr.number}` }),
      ...chips,
      h('span', { class: 'summary', text: (describe.join(' · ') || 'no cell changes') + (m.since ? ` since ${m.since.label}` : '') }),
    ),
    h(
      'div',
      { class: 'controls' },
      panel.since && h('div', { class: 'segmented' },
        button('Whole PR', () => post({ type: 'setSince', on: false }), { class: panel.since.on ? '' : 'on', title: 'Compare with the base of the pull request' }),
        button([icon('history'), 'Since your review'], () => post({ type: 'setSince', on: true }), {
          class: panel.since.on ? 'on' : '',
          disabled: !panel.since.available,
          title: panel.since.problem ?? `Only what changed after ${panel.since.label}`,
        })),
      noiseButton(m),
      segmented([
        ['Changes', 'Show changed cells; fold the rest', !ui.showAll, () => { ui.showAll = false; persist(); render(); }],
        ['All cells', 'Show every cell', ui.showAll, () => { ui.showAll = true; persist(); render(); }],
      ]),
      segmented([
        ['Split', 'Old and new side by side', layout() === 'split', () => { ui.layout = 'split'; persist(); render(); }],
        ['Unified', 'One column', layout() === 'unified', () => { ui.layout = 'unified'; persist(); render(); }],
      ]),
      h('div', { class: 'segmented' },
        button(icon('arrow-up'), () => jump(-1), { title: 'Previous change (p)' }),
        button(icon('arrow-down'), () => jump(1), { title: 'Next change (n)' })),
      threads.length > 0 && h('div', { class: 'segmented' },
        button([icon('comment-discussion'), threadCount()], () => jumpThread(1), {
          title: 'Next comment (c). The count is of unresolved threads, out of all of them.',
        }),
        threads.some(t => t.resolved) && button(icon(ui.hideResolved ? 'filter-filled' : 'filter'), () => { ui.hideResolved = !ui.hideResolved; persist(); render(); }, {
          class: ui.hideResolved ? 'on' : '',
          title: ui.hideResolved ? 'Show resolved threads' : 'Hide resolved threads',
          'aria-pressed': ui.hideResolved ? 'true' : 'false',
        })),
      button([icon('diff'), 'Text diff'], () => post({ type: 'openTextDiff' }), { class: 'ghost', title: 'Open the line-by-line text diff' }),
      button([icon('arrow-right'), 'Next file'], () => post({ type: 'nextFile' }), { class: 'ghost', title: 'Open the next file not marked viewed' }),
      h('label', { class: 'viewed', title: 'Mark this notebook as viewed on GitHub' },
        h('input', { type: 'checkbox', checked: panel.viewed, onchange: (e: Event) => post({ type: 'setViewed', viewed: (e.target as HTMLInputElement).checked }) }),
        'Viewed'),
      h('div', { class: 'submit-wrap' },
        button(
          h('span', {}, 'Submit review', panel.pending ? h('span', { class: 'count', text: String(panel.pending) }) : null, icon('chevron-down')),
          () => { submitBox.open = !submitBox.open; render(); if (submitBox.open) { focus('submit-summary'); } },
          { class: 'primary', title: 'Send your pending comments as one review', 'aria-expanded': submitBox.open ? 'true' : 'false' },
        ),
        submitBox.open && renderSubmitBox()),
    ),
  );
}

/**
 * "Hide noise": cells whose only change is their outputs (a notebook run again) or whitespace in
 * their source (code reformatted) fold away like unchanged ones.
 */
function noiseButton(m: ViewModel): HTMLElement | false {
  if (!m.noise.cells && !m.hideNoise) {
    return false;
  }
  const cells = (n: number) => `${n} cell${n === 1 ? '' : 's'}`;
  const what = [
    m.noise.outputs && `${cells(m.noise.outputs)} whose outputs changed but not their source`,
    m.noise.whitespace && `${cells(m.noise.whitespace)} whose source changed only in whitespace`,
  ].filter(Boolean).join(', and ');
  const title = (m.hideNoise ? `Hidden: ${what || 'nothing in this notebook'}. Click to show them.` : `Hide ${what}.`)
    + ' Execution counts and metadata are always left out.';
  return button([icon(m.hideNoise ? 'eye-closed' : 'eye'), m.hideNoise ? 'Noise hidden' : 'Hide noise', m.noise.cells ? h('span', { class: 'count', text: String(m.noise.cells) }) : null], () => post({ type: 'setHideNoise', on: !m.hideNoise }), {
    class: `ghost noise${m.hideNoise ? ' on' : ''}`,
    title,
    'aria-pressed': m.hideNoise ? 'true' : 'false',
  });
}

/** "3" when every thread is open, "2/5" when some are resolved. */
function threadCount(): string {
  const open = threads.filter(t => !t.resolved).length;
  return open === threads.length ? String(open) : `${open}/${threads.length}`;
}

/** Comments can't be made on the old side when it shows the last review: it isn't part of the pull request. */
function commentable(side: Side): boolean {
  return !(model?.since && side === 'LEFT');
}

// "Finish your review", like on GitHub: a summary, how to submit, and the pending count.
const submitBox: { open: boolean; text: string; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; sending: boolean; error?: string } = {
  open: false,
  text: '',
  event: 'COMMENT',
  sending: false,
};

function submitProblem(): string | undefined {
  if (submitBox.event === 'REQUEST_CHANGES' && !panel.pending && !submitBox.text.trim()) {
    return 'Write a summary or add a comment to request changes.';
  }
  if (submitBox.event === 'COMMENT' && !panel.pending && !submitBox.text.trim()) {
    return 'Add a comment or write a summary first.';
  }
  return undefined;
}

function renderSubmitBox(): HTMLElement {
  const send = () => {
    if (submitBox.sending || submitProblem()) {
      return;
    }
    submitBox.sending = true;
    submitBox.error = undefined;
    post({ type: 'submitReview', event: submitBox.event, body: submitBox.text.trim() });
    render();
  };
  const close = () => { submitBox.open = false; render(); };
  const area = textarea('submit-summary', submitBox.text, v => { submitBox.text = v; updateSubmitState(); }, send, close);
  area.placeholder = 'Leave a summary (optional)';
  const options: [typeof submitBox.event, string, string][] = [
    ['COMMENT', 'Comment', 'Send feedback without approving.'],
    ['APPROVE', 'Approve', 'Approve the pull request.'],
    ['REQUEST_CHANGES', 'Request changes', 'Ask for changes before merging.'],
  ];
  const n = panel.pending;
  const problem = submitProblem();
  return h('div', { class: 'submit-box', role: 'dialog', 'aria-label': 'Finish your review' },
    h('div', { class: 'submit-head' }, h('b', { text: 'Finish your review' }), h('span', { class: 'spacer' }),
      h('span', { class: 'muted', text: n ? `${n} pending comment${n === 1 ? '' : 's'}` : 'no pending comments' })),
    area,
    h('div', { class: 'submit-options' }, ...options.map(([value, label, hint]) =>
      h('label', { class: `option${submitBox.event === value ? ' on' : ''}` },
        h('input', { type: 'radio', name: 'event', value, checked: submitBox.event === value, onchange: () => { submitBox.event = value; render(); focus('submit-summary'); } }),
        h('span', {}, h('b', { text: label }), h('span', { class: 'muted', text: hint }))))),
    submitBox.error && h('div', { class: 'submit-error', text: submitBox.error }),
    h('div', { class: 'actions' },
      panel.pendingReview && discardButton(),
      h('span', { class: 'hint', id: 'submit-hint', text: problem ?? 'Ctrl+Enter to submit' }),
      button('Cancel', close),
      button(submitBox.sending ? 'Submitting…' : 'Submit review', send, { class: 'primary', id: 'submit-send', disabled: submitBox.sending || !!problem })));
}

/** "Discard review", with a second click to confirm: it deletes every pending comment on GitHub. */
function discardButton(): HTMLButtonElement {
  const btn = button('Discard review', () => {
    if (btn.dataset.armed) {
      submitBox.open = false;
      post({ type: 'discardReview' });
      render();
    } else {
      btn.dataset.armed = '1';
      btn.classList.add('armed');
      btn.textContent = `Discard ${panel.pending} pending comment${panel.pending === 1 ? '' : 's'}?`;
      setTimeout(() => { delete btn.dataset.armed; btn.classList.remove('armed'); btn.textContent = 'Discard review'; }, 4000);
    }
  }, { class: 'ghost danger', title: 'Delete your pending review and all its comments on GitHub' });
  return btn;
}

/** Updates the hint and button while typing, without re-rendering the text box. */
function updateSubmitState(): void {
  const problem = submitProblem();
  const hint = document.getElementById('submit-hint');
  const sendButton = document.getElementById('submit-send') as HTMLButtonElement | null;
  if (hint) {
    hint.textContent = problem ?? 'Ctrl+Enter to submit';
  }
  if (sendButton) {
    sendButton.disabled = submitBox.sending || !!problem;
  }
}

function threadsFor(pred: (t: ThreadVM) => boolean): ThreadVM[] {
  return shown.filter(pred);
}

function cellHasThreads(c: CellVM): boolean {
  return shown.some(t => (t.anchor.side === 'LEFT' ? t.anchor.cellId === c.baseId : t.anchor.cellId === c.headId))
    || [...composers.values()].some(x => (x.anchor.side === 'LEFT' ? x.anchor.cellId === c.baseId : x.anchor.cellId === c.headId));
}

function renderCells(m: ViewModel): HTMLElement {
  const root = h('main', { class: `cells ${layout()}` });
  let group: CellVM[] = [];
  const flush = () => {
    if (!group.length) {
      return;
    }
    const key = `group:${group[0].key}`;
    if (ui.expanded[key]) {
      group.forEach(c => root.append(renderCell(c)));
    } else {
      const cells = group;
      const titles = cells.map(c => c.title).filter(Boolean).slice(0, 3).join(' · ');
      const noisy = cells.filter(c => c.noiseHidden).length;
      root.append(
        h('div', { class: 'fold-cells', role: 'button', tabindex: '0', title: 'Show these cells', onclick: () => { ui.expanded[key] = true; persist(); render(); } },
          icon('unfold'),
          h('span', { class: 'n', text: `${cells.length} unchanged cell${cells.length === 1 ? '' : 's'}` }),
          noisy > 0 && h('span', { class: 'noisy', text: `${noisy} with only outputs or whitespace changed` }),
          h('span', { class: 'titles', text: titles })),
      );
    }
    group = [];
  };
  for (const c of m.cells) {
    if (!ui.showAll && c.status === 'unchanged' && !c.moved && !cellHasThreads(c)) {
      group.push(c);
    } else {
      flush();
      root.append(renderCell(c));
    }
  }
  flush();
  if (!m.cells.length) {
    root.append(h('div', { class: 'empty', text: 'This notebook has no cells.' }));
  }
  return root;
}

function renderCell(c: CellVM): HTMLElement {
  const isMd = c.type === 'markdown';
  const rendered = isMd && !ui.mdSource[c.key];
  const number = c.headNumber ?? c.baseNumber;
  const renumbered = c.headNumber && c.baseNumber && c.headNumber !== c.baseNumber ? ` (was ${c.baseNumber})` : '';
  const cellAnchor = (): Anchor => (c.headId ? { side: 'RIGHT', cellId: c.headId, kind: 'cell' } : { side: 'LEFT', cellId: c.baseId!, kind: 'cell' });
  const head = h(
    'div',
    { class: 'cell-head' },
    h('span', { class: `type ${c.type}`, text: c.type }),
    h('span', { class: 'num', text: `cell ${number}${renumbered}` }),
    h('span', { class: 'id', text: c.headId ?? c.baseId }),
    c.status !== 'unchanged' && h('span', { class: `status ${c.status}`, text: c.status === 'modified' && !c.sourceChanged ? 'outputs changed' : c.status }),
    c.moved && h('span', { class: 'status moved', text: 'moved' }),
    c.noiseHidden && h('span', { class: 'status noise', text: `${c.noiseHidden} changed`, title: 'Hidden as noise. Switch "Noise hidden" off in the toolbar to see the change.' }),
    c.sourceChanged && c.outputsChanged && c.status === 'modified' && h('span', { class: 'status outputs', text: 'outputs changed' }),
    h('span', { class: 'spacer' }),
    isMd && h('div', { class: 'segmented small' },
      button('Rendered', () => { delete ui.mdSource[c.key]; persist(); render(); }, { class: rendered ? 'on' : '' }),
      button('Source', () => { ui.mdSource[c.key] = true; persist(); render(); }, { class: rendered ? '' : 'on' })),
    commentable(cellAnchor().side) && button(icon('comment'), () => openComposer(cellAnchor()), { class: 'icon-btn', title: 'Comment on this cell' }),
    c.headId && button(icon('diff'), () => post({ type: 'openTextDiff', cellId: c.headId }), { class: 'icon-btn', title: 'Show in text diff' }),
  );
  const card = h('section', { class: `cell ${c.status}${c.moved ? ' moved' : ''}`, data: { key: c.key, head: c.headId, base: c.baseId } }, head);
  const cellThreads = threadsFor(t => t.anchor.kind === 'cell' && matchesCell(t.anchor, c));
  const cellComposers = [...composers.values()].filter(x => x.anchor.kind === 'cell' && matchesCell(x.anchor, c));
  if (cellThreads.length || cellComposers.length) {
    card.append(h('div', { class: 'cell-threads' }, ...cellThreads.map(renderThread), ...cellComposers.map(renderComposer)));
  }
  card.append(rendered ? renderMarkdown(c) : renderSource(c));
  const outputs = renderOutputs(c);
  if (outputs) {
    card.append(outputs);
  }
  return card;
}

function matchesCell(a: Anchor, c: CellVM): boolean {
  return a.side === 'LEFT' ? a.cellId === c.baseId : a.cellId === c.headId;
}

// Source diffs ---------------------------------------------------------------------------------

interface Half {
  side: Side;
  line: number;
  number: number;
  html: string;
  kind: 'same' | 'del' | 'add';
}

interface Row {
  left?: Half;
  right?: Half;
  /** Unified layout: old and new line numbers of one line. */
  kind: 'same' | 'del' | 'add' | 'mod';
}

/** Cells with one side (added, removed) or two identical sides use the full width. */
function oneColumn(c: CellVM): boolean {
  return layout() === 'unified' || c.status === 'added' || c.status === 'removed' || (c.status === 'unchanged' && !c.moved) || (c.status === 'modified' && !c.sourceChanged);
}

/** The old version's highlighted lines; unchanged cells share the new version's. */
function baseLines(c: CellVM): string[] {
  return c.baseSameAsHead ? c.headLines : c.baseLines;
}

function buildRows(c: CellVM): Row[] {
  const rows: Row[] = [];
  const unified = oneColumn(c);
  let dels: Half[] = [];
  let adds: Half[] = [];
  const flush = () => {
    if (unified) {
      dels.forEach(d => rows.push({ left: d, kind: 'del' }));
      adds.forEach(a => rows.push({ right: a, kind: 'add' }));
    } else {
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
        rows.push({ left: dels[i], right: adds[i], kind: dels[i] && adds[i] ? 'mod' : dels[i] ? 'del' : 'add' });
      }
    }
    dels = [];
    adds = [];
  };
  for (const op of c.ops) {
    if (op.op === 'del') {
      dels.push({ side: 'LEFT', line: op.b, number: op.b + 1, html: baseLines(c)[op.b] ?? '', kind: 'del' });
    } else if (op.op === 'add') {
      adds.push({ side: 'RIGHT', line: op.h, number: op.h + 1, html: c.headLines[op.h] ?? '', kind: 'add' });
    } else {
      flush();
      rows.push({
        left: { side: 'LEFT', line: op.b, number: op.b + 1, html: baseLines(c)[op.b] ?? '', kind: 'same' },
        right: { side: 'RIGHT', line: op.h, number: op.h + 1, html: c.headLines[op.h] ?? '', kind: 'same' },
        kind: 'same',
      });
    }
  }
  flush();
  return rows;
}

function sourceThreads(c: CellVM, half: Half | undefined): ThreadVM[] {
  if (!half) {
    return [];
  }
  const id = half.side === 'LEFT' ? c.baseId : c.headId;
  return shown.filter(t => t.anchor.kind === 'source' && t.anchor.side === half.side && t.anchor.cellId === id && (t.anchor.end ?? t.anchor.start) === half.line);
}

function sourceComposers(c: CellVM, half: Half | undefined): Composer[] {
  if (!half) {
    return [];
  }
  const id = half.side === 'LEFT' ? c.baseId : c.headId;
  return [...composers.values()].filter(x => x.anchor.kind === 'source' && x.anchor.side === half.side && x.anchor.cellId === id && (x.anchor.end ?? x.anchor.start) === half.line);
}

function renderSource(c: CellVM): HTMLElement {
  const unified = oneColumn(c);
  const rows = buildRows(c);
  const body = h('div', { class: `source ${unified ? 'unified' : 'split'}` });
  if (!rows.length) {
    body.append(h('div', { class: 'empty-cell', text: 'empty cell' }));
    return body;
  }
  const hasAnchor = (r: Row) =>
    sourceThreads(c, r.left).length + sourceThreads(c, r.right).length + sourceComposers(c, r.left).length + sourceComposers(c, r.right).length > 0;
  // Removed code is rarely what a review is about: show its start and fold the rest.
  const removedKey = `${c.key}:removed`;
  if (c.status === 'removed' && rows.length > 12 && !ui.expanded[removedKey] && !rows.some(hasAnchor)) {
    rows.slice(0, 6).forEach(r => appendRow(body, c, r));
    const more = rows.length - 6;
    body.append(h('div', { class: 'fold-lines', role: 'button', tabindex: '0', onclick: () => { ui.expanded[removedKey] = true; persist(); render(); } },
      icon('unfold'), `${more} more removed line${more === 1 ? '' : 's'}`));
    return body;
  }
  // Fold long unchanged runs, keeping three lines of context. An unchanged cell shown in
  // "Changes" mode only because it has a comment folds down to the lines around the comment; one
  // the reviewer expanded on purpose shows in full.
  const foldable = c.status !== 'unchanged' || (!ui.showAll && cellHasThreads(c));
  let i = 0;
  while (i < rows.length) {
    if (foldable && rows[i].kind === 'same') {
      let j = i;
      while (j < rows.length && rows[j].kind === 'same' && !hasAnchor(rows[j])) {
        j++;
      }
      const ctxBefore = i === 0 ? 0 : 3;
      const ctxAfter = j === rows.length ? 0 : 3;
      const hidden = j - i - ctxBefore - ctxAfter;
      const key = `${c.key}:${i}`;
      if (hidden >= 4 && !ui.expanded[key]) {
        for (let k = i; k < i + ctxBefore; k++) {
          appendRow(body, c, rows[k]);
        }
        body.append(h('div', { class: 'fold-lines', role: 'button', tabindex: '0', onclick: () => { ui.expanded[key] = true; persist(); render(); } },
          icon('unfold'), `${hidden} unchanged line${hidden === 1 ? '' : 's'}`));
        for (let k = j - ctxAfter; k < j; k++) {
          appendRow(body, c, rows[k]);
        }
        i = j;
        continue;
      }
      for (let k = i; k < Math.max(j, i + 1); k++) {
        appendRow(body, c, rows[k]);
      }
      i = Math.max(j, i + 1);
      continue;
    }
    appendRow(body, c, rows[i]);
    i++;
  }
  return body;
}

function appendRow(body: HTMLElement, c: CellVM, r: Row): void {
  const unified = oneColumn(c);
  if (unified) {
    // In one column, unchanged lines take comments on the new version.
    const half = r.kind === 'del' ? r.left! : r.right!;
    const old = r.kind === 'add' ? undefined : r.left?.number;
    const row = h('div', { class: `row ${r.kind}` },
      h('span', { class: 'ln', text: old ?? '' }),
      h('span', { class: 'ln', text: r.kind === 'del' ? '' : r.right?.number ?? '' }),
      halfCells(c, half, false));
    body.append(row);
    const ts = [...sourceThreads(c, half), ...(r.kind === 'same' ? sourceThreads(c, r.left) : [])];
    const cs = sourceComposers(c, half);
    if (ts.length || cs.length) {
      body.append(h('div', { class: 'thread-row' }, h('div', { class: 'thread-col full' }, ...ts.map(renderThread), ...cs.map(renderComposer))));
    }
    return;
  }
  const row = h('div', { class: `row ${r.kind}` },
    r.left ? h('span', { class: 'ln', text: r.left.number }) : h('span', { class: 'ln blank' }),
    r.left ? halfCells(c, r.left, true) : h('div', { class: 'code blank' }),
    r.right ? h('span', { class: 'ln', text: r.right.number }) : h('span', { class: 'ln blank' }),
    r.right ? halfCells(c, r.right, true) : h('div', { class: 'code blank' }));
  body.append(row);
  const left = [...sourceThreads(c, r.left).map(renderThread), ...sourceComposers(c, r.left).map(renderComposer)];
  const right = [...sourceThreads(c, r.right).map(renderThread), ...sourceComposers(c, r.right).map(renderComposer)];
  if (left.length || right.length) {
    body.append(h('div', { class: 'thread-row' }, h('div', { class: 'thread-col' }, ...left), h('div', { class: 'thread-col' }, ...right)));
  }
}

function halfCells(c: CellVM, half: Half, split: boolean): HTMLElement {
  const cellId = half.side === 'LEFT' ? c.baseId : c.headId;
  const code = h('div', { class: `code ${half.kind}${split ? ` side-${half.side}` : ''}`, data: { side: half.side, line: half.line, cell: cellId } });
  if (!commentable(half.side)) {
    code.append(h('span', { class: 'text', html: half.html || '&#8203;' }));
    return code;
  }
  const add = h('button', {
    type: 'button',
    class: 'add-comment',
    title: 'Comment on this line (drag to select several)',
    'aria-label': 'Add comment',
  }, '+');
  add.addEventListener('mousedown', e => startLineSelection(e, cellId!, half));
  code.append(add, h('span', { class: 'text', html: half.html || '&#8203;' }));
  return code;
}

// Dragging the "+" across lines selects a range, like on GitHub.
let selection: { cellId: string; side: Side; from: number; to: number } | undefined;

function startLineSelection(e: MouseEvent, cellId: string, half: Half): void {
  e.preventDefault();
  selection = { cellId, side: half.side, from: half.line, to: half.line };
  highlightSelection();
  const move = (ev: MouseEvent) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.code[data-line]');
    if (el && selection && el.dataset.cell === selection.cellId && el.dataset.side === selection.side) {
      selection.to = Number(el.dataset.line);
      highlightSelection();
    }
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (selection) {
      const { cellId: id, side, from, to } = selection;
      selection = undefined;
      highlightSelection();
      openComposer({ side, cellId: id, kind: 'source', start: Math.min(from, to), end: Math.max(from, to) });
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function highlightSelection(): void {
  for (const el of app.querySelectorAll<HTMLElement>('.code.selected')) {
    el.classList.remove('selected');
  }
  if (!selection) {
    return;
  }
  const lo = Math.min(selection.from, selection.to);
  const hi = Math.max(selection.from, selection.to);
  for (const el of app.querySelectorAll<HTMLElement>(`.code[data-cell="${CSS.escape(selection.cellId)}"][data-side="${selection.side}"]`)) {
    const n = Number(el.dataset.line);
    if (n >= lo && n <= hi) {
      el.classList.add('selected');
    }
  }
}

// Rendered markdown ----------------------------------------------------------------------------

function renderMarkdown(c: CellVM): HTMLElement {
  const sides: { side: Side; html: string; cellId: string }[] = [];
  const both = c.baseHtml !== undefined && c.headHtml !== undefined && c.sourceChanged;
  if (c.baseHtml !== undefined && (both ? layout() === 'split' : c.headHtml === undefined)) {
    sides.push({ side: 'LEFT', html: c.baseHtml, cellId: c.baseId! });
  }
  if (c.headHtml !== undefined) {
    sides.push({ side: 'RIGHT', html: c.headHtml, cellId: c.headId! });
  }
  const wrap = h('div', { class: `rendered${sides.length === 2 ? ' two' : ''}` });
  for (const s of sides) {
    const col = h('div', { class: `md-col side-${s.side} ${c.status}`, html: s.html });
    if (sides.length === 2) {
      col.prepend(h('div', { class: 'col-label', text: s.side === 'LEFT' ? 'Before' : 'After' }));
    }
    decorateBlocks(col, c, s.side, s.cellId);
    wrap.append(col);
  }
  if (!sides.length || !c.headHtml && !c.baseHtml) {
    wrap.append(h('div', { class: 'empty-cell', text: 'empty cell' }));
  }
  return wrap;
}

function blockRange(el: HTMLElement): [number, number] | undefined {
  const own = el.dataset.src ?? el.querySelector<HTMLElement>('[data-src]')?.dataset.src;
  if (!own) {
    return undefined;
  }
  const ranges = [el, ...el.querySelectorAll<HTMLElement>('[data-src]')]
    .map(x => x.dataset.src)
    .filter((x): x is string => !!x)
    .map(x => x.split('-').map(Number) as [number, number]);
  return [Math.min(...ranges.map(r => r[0])), Math.max(...ranges.map(r => r[1]))];
}

function decorateBlocks(col: HTMLElement, c: CellVM, side: Side, cellId: string): void {
  const blocks = [...col.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.classList.contains('col-label'));
  const placed = new Set<ThreadVM | Composer>();
  const items = [
    ...shown.filter(t => t.anchor.kind === 'source' && t.anchor.side === side && t.anchor.cellId === cellId),
    ...[...composers.values()].filter(x => x.anchor.kind === 'source' && x.anchor.side === side && x.anchor.cellId === cellId),
  ];
  for (const block of blocks) {
    const range = blockRange(block);
    if (!range) {
      continue;
    }
    block.classList.add('md-block');
    // The extension marks changed words and paragraphs; a bar in the margin points them out.
    if (block.matches('.md-changed, .md-added, .md-removed') || block.querySelector('.md-changed, .md-added, .md-removed')) {
      block.classList.add(side === 'LEFT' ? 'changed-del' : 'changed-add');
    }
    if (commentable(side)) {
      block.prepend(button('+', () => openComposer({ side, cellId, kind: 'source', start: range[0], end: range[1] }), {
        class: 'add-comment block',
        title: 'Comment on this paragraph',
        'aria-label': 'Add comment',
      }));
    }
    const here = items.filter(x => {
      const line = x.anchor.end ?? x.anchor.start ?? -1;
      return line >= range[0] && line <= range[1] && !placed.has(x);
    });
    if (here.length) {
      here.forEach(x => placed.add(x));
      block.after(h('div', { class: 'md-threads' }, ...here.map(x => ('comments' in x ? renderThread(x) : renderComposer(x)))));
    }
  }
  const rest = items.filter(x => !placed.has(x));
  if (rest.length) {
    col.append(h('div', { class: 'md-threads' }, ...rest.map(x => ('comments' in x ? renderThread(x) : renderComposer(x)))));
  }
  void c;
}

// Outputs --------------------------------------------------------------------------------------

function renderOutputs(c: CellVM): HTMLElement | undefined {
  if (!c.baseOutputs.length && !c.headOutputs.length) {
    return undefined;
  }
  const wrap = h('div', { class: 'outputs' });
  const changed = c.outputsChanged && c.status !== 'added' && c.status !== 'removed';
  if (!changed) {
    const side: Side = c.headId ? 'RIGHT' : 'LEFT';
    const list = side === 'RIGHT' ? c.headOutputs : c.baseOutputs;
    wrap.append(h('div', { class: 'outputs-col' }, ...list.map(o => renderOutput(c, side, o))));
    return wrap;
  }
  // Changed plots get a comparison of their own; the other outputs stay before and after.
  const pairs = pairImages(c.baseOutputs, c.headOutputs);
  const paired = new Set(pairs.flatMap(p => [p.base, p.head]));
  const baseRest = c.baseOutputs.filter(o => !paired.has(o));
  const headRest = c.headOutputs.filter(o => !paired.has(o));
  if (!pairs.length || baseRest.length || headRest.length) {
    wrap.append(h('div', { class: `output-cols ${layout() === 'split' ? 'two' : 'stacked'}` },
      h('div', { class: 'outputs-col before' }, h('div', { class: 'col-label', text: 'Before' }), ...(baseRest.length ? baseRest.map(o => renderOutput(c, 'LEFT', o)) : [h('div', { class: 'none', text: 'no output' })])),
      h('div', { class: 'outputs-col after' }, h('div', { class: 'col-label', text: 'After' }), ...(headRest.length ? headRest.map(o => renderOutput(c, 'RIGHT', o)) : [h('div', { class: 'none', text: 'no output' })]))));
  }
  for (const pair of pairs) {
    wrap.append(renderImageCompare(c, pair));
  }
  return wrap;
}

// Changed plots ---------------------------------------------------------------------------------

type ImageMode = 'side' | 'swipe' | 'onion' | 'diff';

const IMAGE_MODES: [ImageMode, string, string][] = [
  ['side', 'Side by side', 'The old and the new plot next to each other'],
  ['swipe', 'Swipe', 'The new plot over the old one; drag across to swipe between them'],
  ['onion', 'Onion skin', 'Fade from the old plot to the new one'],
  ['diff', 'Difference', 'The pixels that changed, in magenta, over a faded copy of the new plot'],
];

/** Swipe and fade positions (0 = old, 100 = new) by pair, kept while the page redraws. */
const sliders = new Map<string, number>();
/** Pixel comparisons by pair: worked out once, in the page, from the two images. */
const pixelDiffs = new Map<string, { url: string; percent: number; box?: string; note?: string } | { error: string } | 'pending'>();

function renderImageCompare(c: CellVM, { base, head }: ImagePair): HTMLElement {
  const key = `${base.hash}:${head.hash}`;
  const mode = ui.imageMode ?? 'side';
  const ends = (side: Side, o: OutputVM) => {
    const cellId = (side === 'LEFT' ? c.baseId : c.headId)!;
    return h('span', { class: `compare-end ${side === 'LEFT' ? 'before' : 'after'}` },
      h('span', { class: 'col-label', text: side === 'LEFT' ? 'Before' : 'After' }),
      h('span', { class: 'output-label', text: o.label }),
      commentable(side) && button(icon('comment'), () => openComposer({ side, cellId, kind: 'output', outputIndex: o.index }), {
        class: 'icon-btn',
        title: `Comment on the ${side === 'LEFT' ? 'old' : 'new'} plot`,
      }));
  };
  const modes = h('div', { class: 'segmented small' }, ...IMAGE_MODES.map(([m, label, title]) =>
    button(label, () => { ui.imageMode = m; persist(); render(); }, { class: mode === m ? 'on' : '', title, 'aria-pressed': mode === m ? 'true' : 'false' })));
  const pos = sliders.get(key) ?? 50;
  const slide = (apply: (v: number) => void) => (e: Event) => {
    const v = Number((e.target as HTMLInputElement).value);
    sliders.set(key, v);
    apply(v);
  };
  let body: HTMLElement;
  if (mode === 'swipe') {
    const before = h('img', { class: 'before', src: base.imageSrc, alt: base.label, style: `clip-path: inset(0 ${100 - pos}% 0 0)` });
    const handle = h('div', { class: 'swipe-handle', style: `left: ${pos}%` });
    body = h('div', { class: 'compare-stage swipe' },
      h('img', { class: 'after', src: head.imageSrc, alt: head.label }),
      before,
      handle,
      h('input', {
        type: 'range', min: 0, max: 100, value: pos, class: 'swipe-range', 'aria-label': 'Swipe between the old plot (left) and the new one (right)',
        oninput: slide(v => { before.style.clipPath = `inset(0 ${100 - v}% 0 0)`; handle.style.left = `${v}%`; }),
      }));
  } else if (mode === 'onion') {
    const before = h('img', { class: 'before', src: base.imageSrc, alt: base.label, style: `opacity: ${1 - pos / 100}` });
    body = h('div', { class: 'compare-onion' },
      h('div', { class: 'compare-stage' }, h('img', { class: 'after', src: head.imageSrc, alt: head.label }), before),
      h('label', { class: 'onion-slider' }, 'Before',
        h('input', { type: 'range', min: 0, max: 100, value: pos, 'aria-label': 'Fade from the old plot to the new one', oninput: slide(v => (before.style.opacity = String(1 - v / 100))) }),
        'After'));
  } else if (mode === 'diff') {
    const d = pixelDiffs.get(key);
    if (!d) {
      comparePixels(key, base.imageSrc!, head.imageSrc!);
    }
    body = !d || d === 'pending'
      ? h('div', { class: 'compare-wait', text: 'Comparing pixels…' })
      : 'error' in d
        ? h('div', { class: 'none', text: d.error })
        : h('figure', { class: 'compare-diff' },
          h('img', { src: d.url, alt: 'Changed pixels' }),
          h('figcaption', {}, d.percent === 0 ? 'No visible difference' : `${d.percent < 0.1 ? '<0.1' : d.percent.toFixed(1)}% of pixels changed`, d.box ? ` · in ${d.box}` : '', d.note ? ` · ${d.note}` : ''));
  } else {
    body = h('div', { class: 'compare-side-by-side' },
      h('img', { src: base.imageSrc, alt: base.label }),
      h('img', { src: head.imageSrc, alt: head.label }));
  }
  const on = (t: { anchor: Anchor }) => t.anchor.kind === 'output'
    && ((t.anchor.side === 'LEFT' && t.anchor.cellId === c.baseId && t.anchor.outputIndex === base.index)
      || (t.anchor.side === 'RIGHT' && t.anchor.cellId === c.headId && t.anchor.outputIndex === head.index));
  return h('div', { class: `image-compare ${mode}` },
    h('div', { class: 'compare-head' }, ends('LEFT', base), modes, ends('RIGHT', head)),
    h('div', { class: 'compare-body' }, body),
    ...shown.filter(on).map(renderThread),
    ...[...composers.values()].filter(on).map(renderComposer));
}

/** Draws both plots at the new one's size and marks the pixels that differ, then redraws the page. */
function comparePixels(key: string, beforeSrc: string, afterSrc: string): void {
  pixelDiffs.set(key, 'pending');
  const load = (src: string) => new Promise<HTMLImageElement>((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error('could not load the image'));
    img.src = src;
  });
  Promise.all([load(beforeSrc), load(afterSrc)]).then(([before, after]) => {
    const w = after.naturalWidth || 300;
    const hgt = after.naturalHeight || 150;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const pixelsOf = (img: HTMLImageElement) => {
      ctx.clearRect(0, 0, w, hgt);
      ctx.drawImage(img, 0, 0, w, hgt);
      return ctx.getImageData(0, 0, w, hgt).data;
    };
    const a = pixelsOf(before);
    const b = pixelsOf(after);
    const diff = diffPixels(a, b, w, hgt);
    ctx.putImageData(new ImageData(diff.pixels, w, hgt), 0, 0);
    if (diff.box) {
      ctx.strokeStyle = 'rgba(255, 0, 170, 0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(diff.box.x - 3, diff.box.y - 3, diff.box.w + 6, diff.box.h + 6);
    }
    const sameSize = before.naturalWidth === after.naturalWidth && before.naturalHeight === after.naturalHeight;
    pixelDiffs.set(key, {
      url: canvas.toDataURL('image/png'),
      percent: (diff.changed / (w * hgt)) * 100,
      ...(diff.box ? { box: `${diff.box.w}×${diff.box.h} px at (${diff.box.x}, ${diff.box.y})` } : {}),
      ...(sameSize ? {} : { note: `the old plot was ${before.naturalWidth}×${before.naturalHeight}, stretched to ${w}×${hgt}` }),
    });
  }).catch((e: unknown) => {
    pixelDiffs.set(key, { error: `Can't compare these images: ${e instanceof Error ? e.message : String(e)}` });
  }).finally(() => render());
}

function renderOutput(c: CellVM, side: Side, o: OutputVM): HTMLElement {
  const cellId = (side === 'LEFT' ? c.baseId : c.headId)!;
  const anchor: Anchor = { side, cellId, kind: 'output', outputIndex: o.index };
  let content: HTMLElement;
  if (o.imageSrc) {
    content = h('img', { src: o.imageSrc, alt: o.label, loading: 'lazy' });
  } else if (o.html) {
    content = h('div', { class: 'html-output', html: o.html });
  } else if (o.text !== undefined) {
    content = h('pre', { class: o.kind === 'error' ? 'error' : '', text: o.text });
  } else {
    content = h('div', { class: 'none', text: o.label });
  }
  const ts = shown.filter(t => t.anchor.kind === 'output' && t.anchor.side === side && t.anchor.cellId === cellId && t.anchor.outputIndex === o.index);
  const cs = [...composers.values()].filter(x => x.anchor.kind === 'output' && x.anchor.side === side && x.anchor.cellId === cellId && x.anchor.outputIndex === o.index);
  return h('div', { class: `output ${o.kind}` },
    h('div', { class: 'output-head' },
      h('span', { text: o.label }),
      h('span', { class: 'spacer' }),
      commentable(side) && button(icon('comment'), () => openComposer(anchor), { class: 'icon-btn', title: 'Comment on this output' })),
    h('div', { class: 'output-body' }, content),
    ...ts.map(renderThread),
    ...cs.map(renderComposer));
}

// Threads and composers ------------------------------------------------------------------------

function renderThread(t: ThreadVM): HTMLElement {
  const open = ui.threadOpen[t.id] ?? !(t.resolved || t.outdated);
  const el = h('div', { class: `thread${t.resolved ? ' resolved' : ''}${t.draft ? ' draft' : ''}${open ? '' : ' closed'}`, data: { thread: t.id } });
  el.append(h('div', { class: 'thread-head', role: 'button', tabindex: '0', onclick: () => { ui.threadOpen[t.id] = !open; persist(); render(); } },
    icon(open ? 'chevron-down' : 'chevron-right'),
    icon(t.draft ? 'edit' : 'comment'),
    h('span', { class: 'label', text: t.label }),
    t.resolved && h('span', { class: 'pill', text: 'resolved' }),
    t.outdated && h('span', { class: 'pill', text: 'outdated' }),
    !open && h('span', { class: 'preview', text: `${t.comments[0]?.author ?? ''}: ${stripTags(t.comments[0]?.html ?? '')}` })));
  if (!open) {
    return el;
  }
  for (const c of t.comments) {
    el.append(renderComment(c));
  }
  if (t.canReply) {
    el.append(renderReply(t));
  }
  if (t.canResolve || t.canUnresolve) {
    const busy = resolving.has(t.id);
    el.append(h('div', { class: 'thread-actions' },
      button(
        [icon(t.canResolve ? 'check' : 'issue-reopened'), busy ? (t.canResolve ? 'Resolving…' : 'Unresolving…') : t.canResolve ? 'Resolve conversation' : 'Unresolve conversation'],
        () => {
          resolving.add(t.id);
          post({ type: 'resolve', threadId: t.id, resolved: t.canResolve });
          render();
        },
        { class: 'ghost', disabled: busy, title: t.canResolve ? 'Mark this thread resolved on GitHub' : 'Open this thread again on GitHub' },
      )));
  }
  return el;
}

/** Threads being resolved or unresolved on GitHub. */
const resolving = new Set<string>();

function stripTags(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = sanitize(html);
  return (div.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120);
}

function renderComment(c: CommentVM): HTMLElement {
  const editing = edits.has(c.id);
  const avatar = c.avatarUrl ? h('img', { class: 'avatar', src: c.avatarUrl, alt: '' }) : h('span', { class: 'avatar me', text: c.author.slice(0, 1) });
  const meta = h('div', { class: 'meta' },
    h('b', { text: c.author }),
    c.createdAt && h('span', { class: 'time', title: new Date(c.createdAt).toLocaleString(), text: timeAgo(c.createdAt) }),
    c.pending && h('span', { class: 'pill pending', text: 'Pending' }),
    h('span', { class: 'spacer' }),
    c.reactions && !editing && reactionPicker(c, c.reactions),
    c.url && button(icon('link-external'), () => post({ type: 'openExternal', url: c.url! }), { class: 'icon-btn', title: 'View on GitHub' }),
    c.canEdit && !editing && button(icon('edit'), () => { edits.set(c.id, { text: c.text ?? '' }); focusKey = `edit:${c.id}`; render(); focus(`edit:${c.id}`); }, { class: 'icon-btn', title: 'Edit' }),
    c.canDelete && !editing && deleteButton(c));
  let body: HTMLElement;
  if (editing) {
    const edit = edits.get(c.id)!;
    const area = textarea(`edit:${c.id}`, edit.text, v => (edit.text = v), () => save(), () => cancel());
    // The editor stays open until GitHub has the new text; if saving fails, the text is still here.
    const save = () => {
      if (!edit.saving && area.value.trim()) {
        edit.saving = true;
        post({ type: 'editComment', id: c.id, text: area.value });
        render();
      }
    };
    const cancel = () => { edits.delete(c.id); render(); };
    body = h('div', { class: 'editor' }, area, h('div', { class: 'actions' },
      button('Cancel', cancel),
      button(edit.saving ? 'Saving…' : 'Save', save, { class: 'primary', disabled: !!edit.saving })));
  } else {
    body = h('div', { class: 'body markdown', html: c.html });
  }
  const given = c.reactions?.filter(r => r.count > 0) ?? [];
  return h('div', { class: 'comment' }, avatar, h('div', { class: 'content' }, meta, body,
    !editing && given.length > 0 && h('div', { class: 'reactions' },
      ...given.map(r => button([h('span', { class: 'emoji', text: REACTIONS[r.content] }), String(r.count)], () => react(c, c.reactions!, r.content), {
        class: `reaction${r.mine ? ' mine' : ''}`,
        title: `${REACTION_NAMES[r.content]}: ${r.mine ? 'click to take back your reaction' : 'click to react too'}`,
      })))));
}

/** Adds or takes back the viewer's reaction. Shown at once; GitHub's answer replaces it when the threads come back. */
function react(c: CommentVM, reactions: ReactionVM[], content: ReactionContent): void {
  reactingTo = undefined;
  const r = reactions.find(x => x.content === content);
  const add = !r?.mine;
  if (r) {
    r.mine = add;
    r.count += add ? 1 : -1;
  } else {
    reactions.push({ content, count: 1, mine: true });
  }
  post({ type: 'react', commentId: c.id, content, add });
  render();
}

/** The smiley button among the comment's icons, and the eight reactions it offers, as on github.com. */
function reactionPicker(c: CommentVM, reactions: ReactionVM[]): HTMLElement {
  return h('span', { class: 'reaction-wrap' },
    button(icon('reactions'), () => { reactingTo = reactingTo === c.id ? undefined : c.id; render(); }, {
      class: 'icon-btn',
      title: 'Add a reaction',
      'aria-expanded': reactingTo === c.id ? 'true' : 'false',
    }),
    reactingTo === c.id && h('div', { class: 'reaction-picker', role: 'menu' },
      ...(Object.keys(REACTIONS) as ReactionContent[]).map(content => button(REACTIONS[content], () => react(c, reactions, content), {
        class: reactions.some(r => r.content === content && r.mine) ? 'mine' : '',
        title: REACTION_NAMES[content],
        role: 'menuitem',
      }))));
}

function deleteButton(c: CommentVM): HTMLButtonElement {
  const btn = button(icon('trash'), () => {
    if (btn.dataset.armed) {
      post({ type: 'deleteComment', id: c.id });
    } else {
      btn.dataset.armed = '1';
      btn.classList.add('armed');
      btn.title = 'Click again to delete';
      btn.append(' Delete?');
      setTimeout(() => { delete btn.dataset.armed; btn.classList.remove('armed'); btn.lastChild?.remove(); }, 3000);
    }
  }, { class: 'icon-btn', title: c.pending ? 'Delete pending comment' : 'Delete this comment from GitHub' });
  return btn;
}

function renderReply(t: ThreadVM): HTMLElement {
  const state = replies.get(t.id);
  if (!state) {
    return h('div', { class: 'reply' }, h('div', {
      class: 'reply-stub', role: 'button', tabindex: '0', text: 'Reply…',
      onclick: () => { replies.set(t.id, { text: '' }); render(); focus(`reply:${t.id}`); },
    }));
  }
  const submit = (mode: 'review' | 'single') => {
    if (!area.value.trim() || state.saving) {
      return;
    }
    const requestId = ++requestSeq;
    replies.set(t.id, { text: area.value, saving: requestId, savingMode: mode });
    post({ type: 'reply', threadId: t.id, text: area.value, requestId, mode });
    render();
  };
  const cancel = () => { replies.delete(t.id); render(); };
  const area = textarea(`reply:${t.id}`, state.text, v => (state.text = v), () => submit('review'), cancel);
  return h('div', { class: 'reply open' }, area,
    h('div', { class: 'actions' },
      h('span', { class: 'hint', text: 'Ctrl+Enter adds it to your review' }),
      button('Cancel', cancel),
      submitButtons(state, submit, 'Add to review')));
}

/**
 * GitHub's two ways to send a comment: "Add single comment" posts it now; the primary button
 * adds it to the review, which goes out with "Submit review".
 */
function submitButtons(state: { saving?: number; savingMode?: 'review' | 'single' }, submit: (mode: 'review' | 'single') => void, reviewLabel: string): HTMLElement {
  const busy = !!state.saving;
  return h('span', { class: 'submit-buttons' },
    button(busy && state.savingMode === 'single' ? 'Posting…' : 'Add single comment', () => submit('single'), {
      class: 'ghost',
      disabled: busy || panel.pendingReview,
      title: panel.pendingReview
        ? 'You have a pending review: submit or discard it to post single comments (as on GitHub)'
        : 'Post this comment on GitHub now, on its own',
    }),
    button(busy && state.savingMode === 'review' ? 'Adding…' : panel.pending ? reviewLabel : 'Start a review', () => submit('review'), {
      class: 'primary',
      disabled: busy,
      title: 'Add this comment to your pending review on GitHub; it is sent with your other comments when you submit the review (Ctrl+Enter)',
    }));
}

function renderComposer(x: Composer): HTMLElement {
  const key = anchorKey(x.anchor);
  const submit = (mode: 'review' | 'single') => {
    if (!area.value.trim() || x.saving) {
      return;
    }
    const requestId = ++requestSeq;
    x.text = area.value;
    x.saving = requestId;
    x.savingMode = mode;
    post({ type: 'addComment', anchor: x.anchor, text: area.value, requestId, mode });
    render();
  };
  const cancel = () => { composers.delete(key); render(); };
  const area = textarea(`compose:${key}`, x.text, v => (x.text = v), () => submit('review'), cancel);
  const what = x.anchor.kind === 'source'
    ? x.anchor.start === x.anchor.end ? `line ${x.anchor.start! + 1}` : `lines ${x.anchor.start! + 1}–${x.anchor.end! + 1}`
    : x.anchor.kind === 'output' ? 'this output' : 'this cell';
  const suggest = x.anchor.kind === 'source' && x.anchor.side === 'RIGHT'
    ? button([icon('git-pull-request-create'), 'Suggest change'], () => {
      const lines = sourceText(x.anchor);
      const block = '```suggestion\n' + lines.join('\n') + '\n```\n';
      area.value = area.value ? `${area.value}\n${block}` : block;
      area.dispatchEvent(new Event('input'));
      area.focus();
    }, { class: 'ghost', title: 'Propose replacement lines that the author can commit from GitHub' })
    : null;
  return h('div', { class: 'composer' },
    h('div', { class: 'composer-head' }, icon('comment'), h('span', { text: `Comment on ${what}${x.anchor.side === 'LEFT' ? ' (old version)' : ''}` })),
    area,
    h('div', { class: 'actions' },
      h('span', { class: 'hint', text: x.describe ?? '' }),
      suggest,
      button('Cancel', cancel),
      submitButtons(x, submit, 'Add review comment')));
}

function sourceText(a: Anchor): string[] {
  const c = model?.cells.find(x => (a.side === 'LEFT' ? x.baseId : x.headId) === a.cellId);
  const lines = (a.side === 'LEFT' ? (c?.baseSameAsHead ? c.headSource : c?.baseSource) : c?.headSource) ?? [];
  return lines.slice(a.start ?? 0, (a.end ?? a.start ?? 0) + 1);
}

function textarea(focusId: string, value: string, onInput: (v: string) => void, onSubmit: () => void, onCancel: () => void): HTMLTextAreaElement {
  const area = h('textarea', {
    rows: '3',
    placeholder: 'Leave a comment (Markdown supported)',
    data: { focusKey: focusId },
  });
  area.value = value;
  const grow = () => {
    area.style.height = 'auto';
    area.style.height = `${Math.min(400, area.scrollHeight + 2)}px`;
  };
  area.addEventListener('input', () => { onInput(area.value); grow(); });
  area.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
    e.stopPropagation();
  });
  requestAnimationFrame(grow);
  return area;
}

function focus(key: string): void {
  requestAnimationFrame(() => app.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)?.focus());
}

function openComposer(anchor: Anchor): void {
  if (!commentable(anchor.side)) {
    return;
  }
  const key = anchorKey(anchor);
  if (!composers.has(key)) {
    const requestId = ++requestSeq;
    composers.set(key, { anchor, text: '' });
    planRequests.set(requestId, key);
    post({ type: 'plan', anchor, requestId });
  }
  render();
  focus(`compose:${key}`);
}

const planRequests = new Map<number, string>();


// --- Navigation --------------------------------------------------------------------------------

function jump(dir: 1 | -1): void {
  const cards = [...app.querySelectorAll<HTMLElement>('section.cell')].filter(el => !el.classList.contains('unchanged') || el.querySelector('.thread'));
  if (!cards.length) {
    return;
  }
  const top = toolbarHeight() + 4;
  const positions = cards.map(el => el.getBoundingClientRect().top - top);
  let target = dir > 0 ? positions.findIndex(p => p > 4) : positions.map((p, i) => [p, i] as const).filter(([p]) => p < -4).pop()?.[1] ?? -1;
  if (target < 0) {
    target = dir > 0 ? cards.length - 1 : 0;
  }
  reveal(cards[target]);
}

let threadCursor = -1;

function jumpThread(dir: 1 | -1): void {
  const all = [...app.querySelectorAll<HTMLElement>('.thread')];
  if (!all.length) {
    return;
  }
  threadCursor = (threadCursor + dir + all.length) % all.length;
  reveal(all[threadCursor]);
}

/** Height of the sticky toolbar, which wraps onto two rows in narrow editors. */
function toolbarHeight(): number {
  return (app.querySelector<HTMLElement>('.toolbar')?.offsetHeight ?? 50) + 10;
}

function reveal(el: HTMLElement): void {
  window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - toolbarHeight(), behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// Every link opens once, in the browser. Without this, VS Code also follows the link itself, and
// other extensions (such as GitHub Pull Requests) can open github.com links inside VS Code too.
window.addEventListener('click', e => {
  const link = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!link) {
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  const href = link.getAttribute('href') ?? '';
  if (/^https?:\/\//.test(href)) {
    post({ type: 'openExternal', url: href });
  }
}, true);

window.addEventListener('mousedown', e => {
  if (submitBox.open && !submitBox.sending && !(e.target as HTMLElement).closest('.submit-wrap')) {
    submitBox.open = false;
    render();
  }
});

window.addEventListener('keydown', e => {
  const target = e.target as HTMLElement;
  if (target.closest('textarea, input') || e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }
  if (e.key === 'n' || e.key === 'j') {
    jump(1);
  } else if (e.key === 'p' || e.key === 'k') {
    jump(-1);
  } else if (e.key === 'c') {
    jumpThread(1);
  } else if (e.key === 'C') {
    jumpThread(-1);
  }
});

let scrollTimer: number | undefined;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(persist, 200);
});

let lastLayout = layout();
window.addEventListener('resize', () => {
  if (!ui.layout && layout() !== lastLayout) {
    lastLayout = layout();
    render();
  }
});

function toast(message: string): void {
  const el = document.getElementById('toast');
  if (!el) {
    return;
  }
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 6000);
}

// --- Messages from the extension ---------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'model':
      model = msg.model;
      render();
      break;
    case 'threads':
      threads = msg.threads;
      // Comments that were being saved are now part of the threads.
      for (const [key, x] of composers) {
        if (x.saving) {
          composers.delete(key);
        }
      }
      for (const [key, r] of replies) {
        if (r.saving) {
          replies.delete(key);
        }
      }
      for (const [key, e] of edits) {
        if (e.saving) {
          edits.delete(key);
        }
      }
      resolving.clear();
      render();
      break;
    case 'state':
      panel = msg.state;
      render();
      break;
    case 'plan': {
      const key = planRequests.get(msg.requestId);
      planRequests.delete(msg.requestId);
      const x = key ? composers.get(key) : undefined;
      if (x) {
        x.describe = msg.describe;
        const hint = app.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(`compose:${key}`)}"]`)?.parentElement?.querySelector('.hint');
        if (hint) {
          hint.textContent = msg.describe;
        }
      }
      break;
    }
    case 'reveal': {
      const card = app.querySelector<HTMLElement>(`section.cell[data-head="${CSS.escape(msg.cellKey)}"], section.cell[data-key="${CSS.escape(msg.cellKey)}"]`);
      if (card) {
        reveal(card);
      }
      break;
    }
    case 'submitted':
      submitBox.sending = false;
      if (msg.ok) {
        submitBox.open = false;
        submitBox.text = '';
        submitBox.event = 'COMMENT';
      } else {
        submitBox.error = msg.message;
      }
      render();
      break;
    case 'error':
      for (const x of composers.values()) {
        x.saving = undefined;
        x.savingMode = undefined;
      }
      for (const r of replies.values()) {
        r.saving = undefined;
        r.savingMode = undefined;
      }
      for (const e of edits.values()) {
        e.saving = undefined;
      }
      resolving.clear();
      render();
      toast(msg.message);
      break;
  }
});

persist();
post({ type: 'ready' });
