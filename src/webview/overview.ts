// The pull request Overview page: whether it can be merged and what is in the way (reviews,
// checks, conflicts), the reviewer's own progress, the description, and the whole conversation
// with each review's threads, as on github.com's Conversation tab. Its merge box merges, marks a
// draft ready, updates the branch and deletes it after the merge; comments are made from the
// review pages.
import type { ReactionVM } from './protocol.ts';
import type { CheckVM, MergeAction, OverviewHostMessage, OverviewMessage, OverviewVM, OvCommentVM, OvThreadVM, ProgressVM, TimelineVM, UserVM } from './overviewProtocol.ts';
import type { MergeMethod, Reviewer, StatusLine, Tone } from '../core/prStatus.ts';
import { REACTIONS, REACTION_NAMES } from '../core/reactions.ts';
import { button, h, icon, timeAgo, type Child } from './dom.ts';

declare function acquireVsCodeApi(): {
  postMessage(msg: OverviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();

interface UiState {
  /** Everything, or only what people wrote (no pushes or events). */
  filter: 'all' | 'comments';
  hideResolved: boolean;
  /** Sections and threads opened or closed by hand. */
  open: Record<string, boolean>;
  /** The merge method last picked here. */
  method?: MergeMethod;
  scrollY?: number;
}

const saved = (vscode.getState() ?? {}) as Partial<UiState>;
const ui: UiState = { filter: 'all', hideResolved: false, open: {}, ...saved };
let vm: OverviewVM | undefined;
let progress: ProgressVM | undefined;
let loading = true;
let error: string | undefined;
let restoredScroll = false;
/** Cards fade in the first time only, not on every refresh. */
let firstPaint = true;
const CHECKS_SHOWN = 8;

const app = document.getElementById('app')!;

function post(msg: OverviewMessage): void {
  vscode.postMessage(msg);
}

function persist(): void {
  // `pr` lets the extension reopen this tab after VS Code reloads.
  vscode.setState({ ...ui, scrollY: window.scrollY, pr: document.body.dataset.pr });
}

function toggle(key: string, fallback: boolean): void {
  ui.open[key] = !(ui.open[key] ?? fallback);
  persist();
  render();
}

// --- Small pieces ------------------------------------------------------------------------------

const TONE_ICON: Record<Tone, string> = {
  success: 'pass-filled',
  danger: 'error',
  warning: 'warning',
  running: 'loading',
  neutral: 'circle-large',
  merged: 'git-merge',
};

function toneIcon(tone: Tone): HTMLElement {
  const el = icon(TONE_ICON[tone]);
  el.classList.add(`tone-${tone}`);
  if (tone === 'running') {
    el.classList.add('spin');
  }
  return el;
}

function avatar(u: UserVM, size: 'xs' | 's' | 'm' = 'm'): HTMLElement {
  if (u.avatarUrl) {
    const src = `${u.avatarUrl}${u.avatarUrl.includes('?') ? '&' : '?'}s=${size === 'm' ? 80 : 40}`;
    return h('img', { class: `av av-${size}`, src, alt: '', loading: 'lazy' });
  }
  return h('span', { class: `av av-${size} av-letter`, text: u.login.slice(0, 1).toUpperCase() });
}

function who(u: UserVM): HTMLElement {
  return h('a', { class: 'who', href: `https://github.com/${u.login}`, text: u.login });
}

function time(iso: string): HTMLElement {
  return h('time', { class: 'when', datetime: iso, title: new Date(iso).toLocaleString(), text: timeAgo(iso) });
}

function pill(text: string, cls = ''): HTMLElement {
  return h('span', { class: `pill ${cls}`, text });
}

function reactions(list: ReactionVM[]): HTMLElement | false {
  const given = list.filter(r => r.count > 0);
  return given.length > 0 && h('div', { class: 'reactions' }, ...given.map(r => h('span', {
    class: `reaction${r.mine ? ' mine' : ''}`,
    title: `${REACTION_NAMES[r.content]}${r.mine ? ' (you reacted)' : ''}`,
  }, h('span', { class: 'emoji', text: REACTIONS[r.content] }), String(r.count))));
}

function external(url: string, label: string, cls = 'icon-btn'): HTMLButtonElement {
  return button(cls === 'icon-btn' ? icon('link-external') : [label, icon('link-external')], () => post({ type: 'openExternal', url }), { class: cls, title: label });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function stateOf(m: OverviewVM): { label: string; icon: string; cls: string } {
  if (m.pr.state === 'MERGED') {
    return { label: 'Merged', icon: 'git-merge', cls: 'merged' };
  }
  if (m.pr.state === 'CLOSED') {
    return { label: 'Closed', icon: 'git-pull-request-closed', cls: 'closed' };
  }
  return m.pr.isDraft ? { label: 'Draft', icon: 'git-pull-request-draft', cls: 'draft' } : { label: 'Open', icon: 'git-pull-request', cls: 'open' };
}

function statePill(m: OverviewVM): HTMLElement {
  const s = stateOf(m);
  return h('span', { class: `state ${s.cls}` }, icon(s.icon), s.label);
}

/** GitHub's five-block bar of added and removed lines. */
function diffBar(add: number, del: number): HTMLElement {
  const total = add + del;
  const green = total ? Math.round((add / total) * 5) : 0;
  const red = total ? Math.min(5 - green, Math.max(del ? 1 : 0, Math.round((del / total) * 5))) : 0;
  return h('span', { class: 'diffbar', 'aria-hidden': 'true' },
    ...Array.from({ length: 5 }, (_, i) => h('span', { class: i < green ? 'add' : i < green + red ? 'del' : '' })));
}

function branch(name: string): HTMLElement {
  return h('code', { class: 'branch', title: name, text: name });
}

// --- Page --------------------------------------------------------------------------------------

function render(): void {
  const scroll = window.scrollY;
  // A refresh while the commit message is being written keeps the cursor where it was.
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusKey = active?.dataset?.focusKey;
  const caret = focusKey ? [active!.selectionStart, active!.selectionEnd] : undefined;
  if (!vm) {
    app.replaceChildren(error ? renderError(error) : renderSkeleton());
    return;
  }
  app.replaceChildren(h('div', { class: `ov${firstPaint ? ' enter' : ''}` },
    renderHeader(vm),
    renderSticky(vm),
    h('div', { class: 'ov-grid' },
      h('main', { class: 'ov-main' }, renderVerdict(vm), renderDescription(vm), renderConversation(vm)),
      h('aside', { class: 'ov-side' }, renderProgress(), renderSidebar(vm))),
    h('div', { class: 'toast', id: 'toast' })));
  firstPaint = false;
  watchHeader();
  if (focusKey) {
    const el = app.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-focus-key="${focusKey}"]`);
    el?.focus({ preventScroll: true });
    if (el && caret?.[0] !== null && caret?.[0] !== undefined) {
      el.setSelectionRange(caret[0], caret[1] ?? caret[0]);
    }
  }
  if (!restoredScroll) {
    restoredScroll = true;
    window.scrollTo(0, ui.scrollY ?? 0);
  } else {
    window.scrollTo(0, scroll);
  }
}

function renderSkeleton(): HTMLElement {
  const bar = (w: string, cls = '') => h('div', { class: `sk ${cls}`, style: `width:${w}` });
  return h('div', { class: 'ov skeleton', 'aria-busy': 'true', 'aria-label': 'Loading the pull request' },
    h('header', { class: 'ov-head' }, bar('180px', 'sk-s'), bar('60%', 'sk-l'), bar('45%', 'sk-s')),
    h('div', { class: 'ov-grid' },
      h('main', { class: 'ov-main' },
        h('div', { class: 'card' }, h('div', { class: 'sk-block' }, bar('40%', 'sk-m'), bar('70%', 'sk-s'), bar('55%', 'sk-s'), bar('62%', 'sk-s'))),
        h('div', { class: 'card' }, h('div', { class: 'sk-block' }, bar('30%', 'sk-s'), bar('90%', 'sk-s'), bar('80%', 'sk-s'), bar('50%', 'sk-s')))),
      h('aside', { class: 'ov-side' }, h('div', { class: 'card' }, h('div', { class: 'sk-block' }, bar('50%', 'sk-s'), bar('100%', 'sk-s'), bar('70%', 'sk-s'))))));
}

function renderError(message: string): HTMLElement {
  return h('div', { class: 'ov' }, h('div', { class: 'card problem' },
    toneIcon('danger'),
    h('div', {}, h('div', { class: 'problem-title', text: 'Couldn’t load the pull request' }), h('div', { class: 'muted', text: message })),
    button([icon('refresh'), 'Try again'], () => post({ type: 'refresh' }), { class: 'ghost' })));
}

function refreshButton(): HTMLButtonElement {
  const btn = button(icon('refresh'), () => post({ type: 'refresh' }), { class: `icon-btn${loading ? ' busy' : ''}`, title: 'Refresh from GitHub', disabled: loading });
  return btn;
}

function renderHeader(m: OverviewVM): HTMLElement {
  const p = m.pr;
  return h('header', { class: 'ov-head' },
    h('div', { class: 'crumbs' },
      icon('github'),
      h('a', { class: 'repo', href: `https://github.com/${p.repo}`, text: p.repo }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'fetched', title: `Fetched ${new Date(m.fetchedAt).toLocaleString()}`, text: loading ? 'Updating…' : `Updated ${timeAgo(m.fetchedAt)}` }),
      refreshButton(),
      button(icon('copy'), () => post({ type: 'copyLink', url: p.url }), { class: 'icon-btn', title: 'Copy the link to this pull request' }),
      button([icon('github'), 'Open on GitHub'], () => post({ type: 'openExternal', url: p.url }), { class: 'ghost', title: p.url })),
    h('h1', { class: 'ov-title', id: 'ov-title' }, h('span', { text: p.title }), ' ', h('span', { class: 'num', text: `#${p.number}` })),
    h('div', { class: 'ov-meta' },
      statePill(m),
      h('span', { class: 'meta-text' },
        ...(p.state === 'MERGED' && p.mergedBy ? [who({ login: p.mergedBy })] : [avatar(p.author, 'xs'), who(p.author)]),
        p.state === 'MERGED' ? ' merged ' : ' wants to merge ',
        h('b', { text: plural(p.commits, 'commit') }), ' into ', branch(p.baseRef), ' from ', branch(p.headRef),
        p.mergedAt ? ' · ' : ' · opened ', time(p.mergedAt ?? p.createdAt))),
    h('div', { class: 'ov-stats' },
      h('span', { class: 'add', text: `+${p.additions.toLocaleString()}` }),
      h('span', { class: 'del', text: `−${p.deletions.toLocaleString()}` }),
      diffBar(p.additions, p.deletions),
      h('span', { class: 'muted', text: `${plural(p.changedFiles, 'file')} changed` })));
}

/** A slim bar with the title and the verdict, shown once the header has scrolled away. */
function renderSticky(m: OverviewVM): HTMLElement {
  return h('div', { class: 'ov-sticky', id: 'ov-sticky', 'aria-hidden': 'true' },
    statePill(m),
    h('span', { class: 'sticky-title', text: m.pr.title }),
    h('span', { class: 'num', text: `#${m.pr.number}` }),
    h('span', { class: 'spacer' }),
    h('span', { class: `chip tone-${m.verdict.tone}` }, toneIcon(m.verdict.tone), m.verdict.title),
    refreshButton());
}

let headerObserver: IntersectionObserver | undefined;

function watchHeader(): void {
  headerObserver?.disconnect();
  const title = document.getElementById('ov-title');
  const bar = document.getElementById('ov-sticky');
  if (!title || !bar) {
    return;
  }
  headerObserver = new IntersectionObserver(([e]) => bar.classList.toggle('shown', !e.isIntersecting && e.boundingClientRect.top < 0));
  headerObserver.observe(title);
}

// --- Verdict and status rows -------------------------------------------------------------------

function verdictIcon(m: OverviewVM): string {
  switch (m.verdict.tone) {
    case 'success':
      return 'check';
    case 'danger':
      return 'close';
    case 'merged':
      return 'git-merge';
    case 'running':
      return 'loading';
    case 'warning':
      return 'warning';
    default:
      return m.pr.state === 'CLOSED' ? 'git-pull-request-closed' : 'git-pull-request-draft';
  }
}

function renderVerdict(m: OverviewVM): HTMLElement {
  const v = m.verdict;
  const ic = icon(verdictIcon(m));
  if (v.tone === 'running') {
    ic.classList.add('spin');
  }
  const open = m.pr.state === 'OPEN';
  return h('section', { class: `card verdict tone-${v.tone}`, 'aria-label': 'Merge status' },
    h('div', { class: 'verdict-head' },
      h('span', { class: 'verdict-icon' }, ic),
      h('div', { class: 'verdict-text' }, h('div', { class: 'verdict-title', text: v.title }), h('div', { class: 'verdict-detail', text: v.detail }))),
    open && h('div', { class: 'rows' },
      statusRow('reviews', m.reviews, m.reviews.reviewers.length > 0, false, () => renderReviewers(m.reviews.reviewers, 'row')),
      statusRow('checks', m.checks, m.checks.list.length > 0, m.checks.tone === 'danger', () => renderChecks(m.checks.list), checksMeter(m)),
      statusRow('branch', m.branch, false, false, () => h('div'))),
    renderMergeBox(m));
}

// --- Merging -----------------------------------------------------------------------------------

/** The merge box's own state: the confirm form, the method menu, and the action under way. */
const box: {
  menu: boolean;
  confirming: boolean;
  /** The commit message being written, per method; unset means GitHub's default. */
  title: Partial<Record<MergeMethod, string>>;
  body: Partial<Record<MergeMethod, string>>;
  busy?: MergeAction;
  error?: string;
  /** Delete branch was clicked once and waits for the second click. */
  armed?: boolean;
} = { menu: false, confirming: false, title: {}, body: {} };

function chosenMethod(m: OverviewVM): MergeMethod | undefined {
  const allowed = m.merge.methods.map(x => x.method);
  return [ui.method, m.merge.preferred, allowed[0]].find((x): x is MergeMethod => !!x && allowed.includes(x));
}

function act(action: MergeAction, msg: OverviewMessage): void {
  box.busy = action;
  box.error = undefined;
  post(msg);
  render();
}

function renderMergeBox(m: OverviewVM): HTMLElement | false {
  const g = m.merge;
  const open = m.pr.state === 'OPEN';
  const parts: Child[] = [];
  if (open && g.newCommits) {
    parts.push(h('div', { class: 'mb-note tone-warning' }, toneIcon('warning'),
      h('span', { class: 'mb-text' }, h('b', { text: 'New commits were pushed' }), ' after you loaded the files. Merging includes them.'),
      button([icon('refresh'), 'Load them'], () => post({ type: 'reloadPr' }), { class: 'ghost' })));
  }
  if (g.canMarkReady) {
    parts.push(h('div', { class: 'mb-row' },
      h('span', { class: 'mb-text' }, h('b', { text: 'This is a draft.' }), ' Mark it ready when it can be reviewed and merged; reviewers asked are notified.'),
      button(box.busy === 'markReady' ? [spinner(), 'Marking…'] : [icon('eye'), 'Ready for review'], () => act('markReady', { type: 'markReady' }), { class: 'ghost', disabled: !!box.busy })));
  }
  const method = chosenMethod(m);
  if (open && method && !m.pr.isDraft) {
    parts.push(box.confirming ? renderConfirm(m, method) : renderMergeButton(m, method));
  } else if (open && !g.methods.length) {
    parts.push(h('div', { class: 'mb-row muted' }, 'This repository doesn’t allow any way of merging that GitHub’s API offers.'));
  }
  if (g.canDeleteBranch) {
    parts.push(h('div', { class: 'mb-row' },
      h('span', { class: 'mb-text' }, 'The ', branch(m.pr.headRef), ` branch is ${m.pr.state === 'MERGED' ? 'merged' : 'no longer needed'} and can be deleted.`),
      button(box.busy === 'deleteBranch' ? [spinner(), 'Deleting…'] : box.armed ? [icon('trash'), 'Click again to delete'] : [icon('trash'), 'Delete branch'], () => {
        if (!box.armed) {
          box.armed = true;
          render();
          setTimeout(() => { box.armed = false; render(); }, 4000);
          return;
        }
        box.armed = false;
        act('deleteBranch', { type: 'deleteBranch' });
      }, { class: `ghost danger${box.armed ? ' armed' : ''}`, disabled: !!box.busy, title: 'github.com can restore it afterwards' })));
  }
  if (box.error && !box.confirming) {
    parts.push(h('div', { class: 'mb-error', role: 'alert' }, toneIcon('danger'), h('span', { text: box.error })));
  }
  return parts.length > 0 && h('div', { class: 'merge-box' }, ...parts);
}

function spinner(): HTMLElement {
  const el = icon('loading');
  el.classList.add('spin');
  return el;
}

function renderMergeButton(m: OverviewVM, method: MergeMethod): HTMLElement {
  const g = m.merge;
  const chosen = g.methods.find(x => x.method === method)!;
  const blocked = !!g.blocker;
  const many = g.methods.length > 1;
  return h('div', { class: 'mb-merge' },
    h('div', { class: 'mb-actions' },
      h('div', { class: `split${blocked ? ' blocked' : ''}` },
        button([icon('git-merge'), chosen.label], () => {
          box.confirming = true;
          box.menu = false;
          box.error = undefined;
          render();
          app.querySelector<HTMLElement>('[data-focus-key="merge-title"], .mb-confirm button.merge-btn')?.focus();
        }, { class: 'merge-btn', disabled: blocked, title: blocked ? g.blocker : chosen.describe }),
        many && button(icon(box.menu ? 'chevron-up' : 'chevron-down'), () => { box.menu = !box.menu; render(); }, {
          class: 'merge-btn caret',
          title: 'Choose how to merge',
          'aria-haspopup': 'menu',
          'aria-expanded': String(box.menu),
        })),
      g.canUpdateBranch && button(box.busy === 'updateBranch' ? [spinner(), 'Updating…'] : [icon('repo-pull'), 'Update branch'],
        () => act('updateBranch', { type: 'updateBranch', expectedHeadOid: g.headSha }),
        { class: 'ghost', disabled: !!box.busy, title: `Merge ${m.pr.baseRef} into ${m.pr.headRef}` }),
      h('span', { class: 'mb-hint', text: !blocked ? chosen.describe
        // The verdict above already says why; repeating it here says nothing new.
        : g.blocker !== m.verdict.detail ? g.blocker!
          : g.canUpdateBranch ? `Update the branch with ${m.pr.baseRef}, then merge.` : 'Merging opens up once that is sorted.' })),
    box.menu && h('div', { class: 'mb-menu', role: 'menu' }, ...g.methods.map(x => button([
      h('span', { class: 'mb-check' }, x.method === method && icon('check')),
      h('span', { class: 'mb-option' }, h('b', { text: x.label }), h('span', { class: 'muted', text: x.describe }))],
    () => { ui.method = x.method; box.menu = false; persist(); render(); },
    { class: 'mb-item', role: 'menuitemradio', 'aria-checked': String(x.method === method) }))));
}

function renderConfirm(m: OverviewVM, method: MergeMethod): HTMLElement {
  const g = m.merge;
  const chosen = g.methods.find(x => x.method === method)!;
  const defaults = g.messages[method];
  const busy = box.busy === 'merge';
  const confirm = () => {
    if (busy || g.blocker) {
      return;
    }
    // Only what was changed is sent; the rest is GitHub's own default.
    const title = box.title[method];
    const body = box.body[method];
    act('merge', {
      type: 'merge',
      method,
      expectedHeadOid: g.headSha,
      ...(title !== undefined && title !== defaults?.title ? { title } : {}),
      ...(body !== undefined && body !== defaults?.body ? { body } : {}),
    });
  };
  const cancel = () => { box.confirming = false; box.error = undefined; render(); };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      confirm();
    } else if (e.key === 'Escape') {
      cancel();
    }
  };
  return h('div', { class: 'mb-confirm', onkeydown: keys },
    h('div', { class: 'mb-confirm-head' }, icon('git-merge'), h('b', { text: chosen.label }), h('span', { class: 'muted', text: ` into ${m.pr.baseRef}` })),
    defaults
      ? h('div', { class: 'mb-fields' },
        h('input', {
          type: 'text',
          class: 'mb-title',
          'aria-label': 'Commit title',
          value: box.title[method] ?? defaults.title,
          disabled: busy,
          data: { focusKey: 'merge-title' },
          oninput: (e: Event) => { box.title[method] = (e.target as HTMLInputElement).value; },
        }),
        h('textarea', {
          class: 'mb-body',
          rows: '5',
          'aria-label': 'Commit description',
          placeholder: 'Add an optional description',
          disabled: busy,
          data: { focusKey: 'merge-body' },
          oninput: (e: Event) => { box.body[method] = (e.target as HTMLTextAreaElement).value; },
        }, box.body[method] ?? defaults.body))
      : h('div', { class: 'mb-text muted', text: chosen.describe }),
    h('div', { class: 'mb-meta muted' },
      `${plural(m.pr.commits, 'commit')} at `, h('code', { class: 'sha', text: g.headSha.slice(0, 7) }),
      ' · GitHub refuses the merge if anything is pushed before it goes through.'),
    box.error && h('div', { class: 'mb-error', role: 'alert' }, toneIcon('danger'), h('span', { text: box.error })),
    h('div', { class: 'mb-actions' },
      button(busy ? [spinner(), 'Merging…'] : [icon('git-merge'), chosen.confirm], confirm, { class: 'merge-btn', disabled: busy || !!g.blocker }),
      button('Cancel', cancel, { class: 'ghost', disabled: busy }),
      h('span', { class: 'mb-hint', text: 'Ctrl+Enter to confirm' })));
}

function statusRow(key: string, line: StatusLine, expandable: boolean, openByDefault: boolean, body: () => HTMLElement, extra?: Child): HTMLElement {
  const open = expandable && (ui.open[`row:${key}`] ?? openByDefault);
  const head = h(expandable ? 'button' : 'div', {
    class: 'row-head',
    ...(expandable ? { type: 'button', 'aria-expanded': String(open), onclick: () => toggle(`row:${key}`, openByDefault) } : {}),
  },
  toneIcon(line.tone),
  h('span', { class: 'row-text' }, h('span', { class: 'row-title', text: line.title }), line.detail && h('span', { class: 'row-detail', text: line.detail })),
  extra,
  expandable && h('span', { class: 'chev' }, icon(open ? 'chevron-up' : 'chevron-down')));
  return h('div', { class: `row tone-${line.tone}${open ? ' open' : ''}` }, head, open && h('div', { class: 'row-body' }, body()));
}

/** The checks as a thin bar of their states, in GitHub's colours. */
function checksMeter(m: OverviewVM): Child {
  const c = m.checks.counts;
  const total = m.checks.list.length;
  if (!total) {
    return false;
  }
  const seg = (n: number, cls: string) => n > 0 && h('span', { class: cls, style: `flex-grow:${n}` });
  return h('span', { class: 'meter', title: m.checks.detail },
    seg(c.success, 'success'), seg(c.failure + c.cancelled, 'danger'), seg(c.pending, 'running'), seg(c.skipped + c.neutral, 'neutral'));
}

const CHECK_ICON: Record<CheckVM['state'], [string, Tone]> = {
  success: ['pass-filled', 'success'],
  failure: ['error', 'danger'],
  cancelled: ['circle-slash', 'neutral'],
  pending: ['loading', 'running'],
  skipped: ['circle-slash', 'neutral'],
  neutral: ['circle-large', 'neutral'],
};

function renderChecks(list: CheckVM[]): HTMLElement {
  const all = ui.open['checks:all'] ?? false;
  const shown = all ? list : list.slice(0, CHECKS_SHOWN);
  return h('div', { class: 'checks' },
    ...shown.map(c => {
      const [name, tone] = CHECK_ICON[c.state];
      const ic = icon(name);
      ic.classList.add(`tone-${tone}`);
      if (c.state === 'pending') {
        ic.classList.add('spin');
      }
      return h('div', { class: `check state-${c.state}` },
        ic,
        h('span', { class: 'check-name' }, c.workflow && h('span', { class: 'wf', text: `${c.workflow} / ` }), h('b', { text: c.name })),
        h('span', { class: 'check-desc', text: c.description ?? (c.state === 'skipped' ? 'Skipped' : c.state === 'cancelled' ? 'Cancelled' : '') }),
        c.required && pill('Required', 'required'),
        c.duration && h('span', { class: 'dur', text: c.duration }),
        c.url ? button('Details', () => post({ type: 'openExternal', url: c.url! }), { class: 'link-btn', title: c.url }) : h('span'));
    }),
    list.length > CHECKS_SHOWN && button(all ? 'Show fewer' : `Show all ${list.length} checks`, () => toggle('checks:all', false), { class: 'more' }));
}

const REVIEW_STATE: Record<Reviewer['state'], [text: string, icon: string, tone: Tone]> = {
  APPROVED: ['approved', 'pass-filled', 'success'],
  CHANGES_REQUESTED: ['requested changes', 'request-changes', 'danger'],
  COMMENTED: ['commented', 'comment', 'neutral'],
  DISMISSED: ['review dismissed', 'circle-slash', 'neutral'],
  PENDING: ['review pending', 'circle-filled', 'warning'],
  REQUESTED: ['awaiting review', 'circle-filled', 'warning'],
};

function renderReviewers(list: Reviewer[], style: 'row' | 'side'): HTMLElement {
  return h('div', { class: `reviewers ${style}` }, ...list.map(r => {
    const [text, name, tone] = REVIEW_STATE[r.state];
    const ic = icon(name);
    ic.classList.add(`tone-${tone}`);
    return h('div', { class: 'reviewer', title: `${r.login} ${text}${r.submittedAt ? ` ${timeAgo(r.submittedAt)}` : ''}` },
      r.team ? h('span', { class: 'av av-s av-team' }, icon('organization')) : avatar(r, 's'),
      r.team ? h('span', { class: 'who', text: r.login }) : who(r),
      style === 'row' && h('span', { class: 'muted', text }),
      h('span', { class: 'spacer' }),
      ic);
  }));
}

// --- Your review -------------------------------------------------------------------------------

function renderProgress(): HTMLElement | false {
  const p = progress;
  if (!p || !vm) {
    return false;
  }
  const pct = p.files ? Math.round((p.viewed / p.files) * 100) : 0;
  const done = p.files > 0 && p.viewed === p.files;
  const next = done
    ? button([icon('check-all'), 'Submit review…'], () => post({ type: 'submitReview' }), { class: 'primary wide' })
    : button([p.viewed ? 'Continue reviewing' : 'Start reviewing', icon('arrow-right')], () => post({ type: 'nextFile' }), {
      class: 'primary wide',
      title: p.nextFile ? `Open ${p.nextFile}` : undefined,
    });
  return h('section', { class: 'card side-card mine' },
    h('div', { class: 'side-title' }, 'Your review', h('span', { class: 'spacer' }), h('span', { class: 'pct', text: `${pct}%` })),
    h('div', { class: `progress${done ? ' done' : ''}`, role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
      h('span', { style: `width:${pct}%` })),
    h('div', { class: 'progress-text' }, h('b', { text: `${p.viewed}` }), ` of ${plural(p.files, 'file')} viewed`),
    h('div', { class: 'facts' },
      fact('edit', p.pending ? plural(p.pending, 'pending comment') : p.pendingReview ? 'Review started' : 'No pending comments', p.pending > 0 ? 'warning' : undefined),
      fact('comment-discussion', p.unresolved ? `${plural(p.unresolved, 'unresolved thread')}` : 'No unresolved threads', p.unresolved > 0 ? 'running' : undefined)),
    vm.pr.state === 'OPEN' && next,
    vm.pr.state === 'OPEN' && !done && (p.pending > 0 || p.pendingReview) && button([icon('check-all'), 'Submit review…'], () => post({ type: 'submitReview' }), { class: 'ghost wide' }));
}

function fact(name: string, text: string, tone?: Tone): HTMLElement {
  const ic = icon(name);
  if (tone) {
    ic.classList.add(`tone-${tone}`);
  }
  return h('div', { class: 'fact' }, ic, h('span', { text }));
}

function renderSidebar(m: OverviewVM): HTMLElement {
  const section = (title: string, body: Child, empty: string) =>
    h('section', { class: 'side-sec' }, h('div', { class: 'side-label', text: title }), body || h('div', { class: 'muted small', text: empty }));
  return h('div', { class: 'side-list' },
    section('Reviewers', m.reviews.reviewers.length > 0 && renderReviewers(m.reviews.reviewers, 'side'), 'No reviewers'),
    section('Assignees', m.assignees.length > 0 && h('div', { class: 'people' }, ...m.assignees.map(a => h('div', { class: 'reviewer' }, avatar(a, 's'), who(a)))), 'Nobody'),
    section('Labels', m.labels.length > 0 && h('div', { class: 'labels' }, ...m.labels.map(l =>
      h('span', { class: 'label', style: `background:${l.background};color:${l.foreground}`, text: l.name }))), 'None yet'),
    m.milestone && section('Milestone', h('div', { class: 'fact' }, icon('milestone'), h('span', { text: m.milestone })), ''),
    m.closingIssues.length > 0 && section('Closes', h('div', { class: 'issues' }, ...m.closingIssues.map(i => {
      const ic = icon(i.state === 'OPEN' ? 'issues' : 'pass');
      ic.classList.add(i.state === 'OPEN' ? 'tone-success' : 'tone-merged');
      return h('a', { class: 'issue', href: i.url, title: i.title }, ic, h('span', { class: 'num', text: `#${i.number}` }), h('span', { class: 'issue-title', text: i.title }));
    })), ''));
}

// --- Description and conversation ---------------------------------------------------------------

function renderDescription(m: OverviewVM): HTMLElement {
  return commentCard({
    id: 'description',
    author: m.pr.author,
    isAuthor: true,
    createdAt: m.pr.createdAt,
    html: m.bodyHtml,
    url: m.pr.url,
    reactions: m.bodyReactions,
  }, 'opened this', 'No description provided.', 'description');
}

function commentCard(c: OvCommentVM, verb: string, empty: string, cls = ''): HTMLElement {
  return h('article', { class: `tl-item tl-comment ${cls}`, data: { id: c.id } },
    h('div', { class: 'tl-av' }, avatar(c.author)),
    h('div', { class: `card comment-card${c.author.login === vm?.viewer ? ' viewer' : ''}` },
      h('div', { class: 'comment-head' },
        who(c.author), h('span', { class: 'muted', text: ` ${verb} ` }), time(c.createdAt),
        h('span', { class: 'spacer' }),
        c.isAuthor && pill('Author'),
        c.author.login === vm?.viewer && pill('You', 'you'),
        c.url && external(c.url, 'View on GitHub')),
      c.html ? h('div', { class: 'markdown comment-body', html: c.html }) : h('div', { class: 'comment-body muted empty-body', text: empty }),
      reactions(c.reactions)));
}

function shownItems(m: OverviewVM): TimelineVM[] {
  return m.timeline.filter(t => {
    if (ui.filter === 'comments' && (t.kind === 'commits' || t.kind === 'event')) {
      return false;
    }
    if (ui.filter === 'comments' && t.kind === 'review' && !t.html && !t.threads.length) {
      return false;
    }
    return true;
  });
}

function renderConversation(m: OverviewVM): HTMLElement {
  const items = shownItems(m);
  const comments = m.timeline.reduce((n, t) => n + (t.kind === 'comment' ? 1 : t.kind === 'review' ? (t.html ? 1 : 0) + t.threads.reduce((k, th) => k + th.comments.length, 0) : 0), 0);
  const seg = (value: UiState['filter'], label: string) => button(label, () => { ui.filter = value; persist(); render(); }, {
    class: `seg${ui.filter === value ? ' on' : ''}`,
    'aria-pressed': String(ui.filter === value),
  });
  return h('section', { class: 'conversation', 'aria-label': 'Conversation' },
    h('div', { class: 'conv-head' },
      h('h2', {}, 'Conversation', h('span', { class: 'count', text: String(comments) })),
      h('span', { class: 'spacer' }),
      h('label', { class: 'check-toggle' },
        h('input', { type: 'checkbox', checked: ui.hideResolved, onchange: (e: Event) => { ui.hideResolved = (e.target as HTMLInputElement).checked; persist(); render(); } }),
        'Hide resolved'),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show' }, seg('all', 'Everything'), seg('comments', 'Comments'))),
    h('div', { class: 'timeline' },
      m.timelineMissing > 0 && h('div', { class: 'tl-item tl-event' },
        h('span', { class: 'badge' }, icon('history')),
        h('span', { class: 'muted' }, `${plural(m.timelineMissing, 'later event')} aren’t shown here. `),
        external(m.pr.url, 'See them on GitHub', 'link-btn')),
      ...items.map(renderItem),
      !items.length && h('div', { class: 'tl-item tl-event muted' }, h('span', { class: 'badge' }, icon('comment')), 'No comments yet.')));
}

function renderItem(t: TimelineVM): HTMLElement {
  switch (t.kind) {
    case 'comment':
      return commentCard(t, 'commented', '');
    case 'review':
      return renderReview(t);
    case 'commits':
      return renderCommits(t);
    case 'event':
      return h('div', { class: `tl-item tl-event${t.tone ? ` tone-${t.tone}` : ''}` },
        h('span', { class: 'badge' }, icon(t.icon)),
        h('span', { class: 'event-text' }, avatar(t.actor, 'xs'), who(t.actor), ` ${t.text} `, time(t.createdAt)));
  }
}

const REVIEW_BADGE: Record<Extract<TimelineVM, { kind: 'review' }>['state'], [icon: string, verb: string, tone?: Tone]> = {
  APPROVED: ['check', 'approved these changes', 'success'],
  CHANGES_REQUESTED: ['request-changes', 'requested changes', 'danger'],
  COMMENTED: ['eye', 'reviewed'],
  DISMISSED: ['circle-slash', 'reviewed (dismissed)'],
  PENDING: ['edit', 'started a review'],
};

function renderReview(t: Extract<TimelineVM, { kind: 'review' }>): HTMLElement {
  const [name, verb, tone] = REVIEW_BADGE[t.state];
  const threads = t.threads.filter(th => !(ui.hideResolved && th.resolved));
  const hidden = t.threads.length - threads.length;
  const left = t.threads.length ? '' : t.otherComments ? ` and left ${plural(t.otherComments, 'comment')}` : '';
  return h('div', { class: `tl-item tl-review${tone ? ` tone-${tone}` : ''}`, data: { id: t.id } },
    h('span', { class: 'badge' }, icon(name)),
    h('div', { class: 'review-line' },
      avatar(t.author, 'xs'), who(t.author), ` ${verb}${left} `, time(t.createdAt),
      h('span', { class: 'spacer' }),
      t.isAuthor && pill('Author'),
      external(t.url, 'View on GitHub')),
    t.html && h('div', { class: 'card comment-card review-body' }, h('div', { class: 'markdown comment-body', html: t.html }), reactions(t.reactions)),
    threads.length > 0 && h('div', { class: 'review-threads' }, ...threads.map(renderThread)),
    hidden > 0 && h('div', { class: 'muted small hidden-note', text: `${plural(hidden, 'resolved thread')} hidden` }));
}

function renderThread(t: OvThreadVM): HTMLElement {
  const open = ui.open[`thread:${t.id}`] ?? !t.resolved;
  const slash = t.path.lastIndexOf('/');
  const notebook = t.path.endsWith('.ipynb');
  return h('div', { class: `card thread${t.resolved ? ' resolved' : ''}${open ? '' : ' closed'}`, data: { thread: t.id } },
    h('div', { class: 'thread-head' },
      button([icon(open ? 'chevron-down' : 'chevron-right'), icon(notebook ? 'notebook' : 'file'),
        h('span', { class: 'path' }, slash >= 0 && h('span', { class: 'dir', text: t.path.slice(0, slash + 1) }), h('b', { text: t.path.slice(slash + 1) })),
        t.snippet && h('span', { class: 'where', text: t.snippet.where })],
      () => toggle(`thread:${t.id}`, !t.resolved), { class: 'thread-toggle', 'aria-expanded': String(open) }),
      h('span', { class: 'spacer' }),
      t.outdated && pill('Outdated', 'outdated'),
      t.resolved && pill('Resolved', 'resolved'),
      !open && h('span', { class: 'muted small', text: plural(t.comments.length, 'comment') }),
      t.open && button([notebook ? 'Show in notebook' : 'Show in file', icon('arrow-right')], () => post({ type: 'openFile', path: t.open!.path, cellKey: t.open!.cellKey }), {
        class: 'link-btn',
        title: `Open ${t.open.path} in the review page`,
      })),
    open && t.snippet && h('div', { class: 'snippet' }, ...t.snippet.lines.map(l =>
      h('div', { class: `ln${l.marked ? ' marked' : ''}` }, h('span', { class: 'n', text: l.number ? String(l.number) : '' }), h('code', { html: l.html })))),
    open && h('div', { class: 'thread-comments' }, ...t.comments.map(c =>
      h('div', { class: 'tc' },
        avatar(c.author, 's'),
        h('div', { class: 'tc-main' },
          h('div', { class: 'tc-head' }, who(c.author), time(c.createdAt), c.isAuthor && pill('Author'), h('span', { class: 'spacer' }), c.url && external(c.url, 'View on GitHub')),
          h('div', { class: 'markdown comment-body', html: c.html }),
          reactions(c.reactions))))));
}

function renderCommits(t: Extract<TimelineVM, { kind: 'commits' }>): HTMLElement {
  const authors = [...new Set(t.commits.map(c => c.author.login))];
  const one = authors.length === 1 ? t.commits[0].author : undefined;
  const key = `commits:${t.id}`;
  const many = t.commits.length > 5;
  const open = !many || (ui.open[key] ?? false);
  const shown = open ? t.commits : t.commits.slice(-3);
  return h('div', { class: 'tl-item tl-commits' },
    h('span', { class: 'badge' }, icon('git-commit')),
    h('div', { class: 'review-line' },
      one && avatar(one, 'xs'), one ? who(one) : h('span', { text: `${authors.length} authors` }),
      ` pushed ${plural(t.commits.length, 'commit')} `, time(t.commits[t.commits.length - 1].createdAt)),
    h('div', { class: 'commits' },
      !open && button(`Show ${t.commits.length - shown.length} earlier commits`, () => toggle(key, false), { class: 'more' }),
      ...shown.map(c => h('div', { class: 'commit' },
        icon('git-commit'),
        h('a', { class: 'commit-msg', href: c.url, title: c.message, text: c.message }),
        !one && h('span', { class: 'muted small', text: c.author.login }),
        h('a', { class: 'sha', href: c.url, text: c.oid.slice(0, 7) })))));
}

// --- Events ------------------------------------------------------------------------------------

function toast(message: string, kind: 'error' | 'success' = 'error'): void {
  const el = document.getElementById('toast');
  if (!el) {
    return;
  }
  el.textContent = message;
  el.classList.toggle('success', kind === 'success');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 6000);
}

// Every link opens once, in the browser (see the review page for why).
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

// The merge method menu closes on a click elsewhere, or Escape.
window.addEventListener('mousedown', e => {
  if (box.menu && !(e.target as HTMLElement).closest('.mb-merge')) {
    box.menu = false;
    render();
  }
});

let scrollTimer: number | undefined;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(persist, 200);
});

// Relative times ("3 minutes ago") are brought up to date once a minute.
setInterval(() => {
  for (const el of app.querySelectorAll<HTMLTimeElement>('time.when')) {
    el.textContent = timeAgo(el.dateTime);
  }
  const fetched = app.querySelector<HTMLElement>('.fetched');
  if (fetched && vm && !loading) {
    fetched.textContent = `Updated ${timeAgo(vm.fetchedAt)}`;
  }
}, 60_000);

window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && box.menu) {
    box.menu = false;
    render();
    return;
  }
  if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
    post({ type: 'refresh' });
  }
});

window.addEventListener('message', (event: MessageEvent<OverviewHostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'overview':
      vm = msg.overview;
      error = undefined;
      render();
      break;
    case 'progress':
      progress = msg.progress;
      render();
      break;
    case 'loading':
      loading = msg.loading;
      if (vm) {
        // Only the refresh buttons and the "Updated" text change.
        for (const b of app.querySelectorAll<HTMLButtonElement>('button.icon-btn[title="Refresh from GitHub"]')) {
          b.classList.toggle('busy', loading);
          b.disabled = loading;
        }
        const fetched = app.querySelector<HTMLElement>('.fetched');
        if (fetched) {
          fetched.textContent = loading ? 'Updating…' : `Updated ${timeAgo(vm.fetchedAt)}`;
        }
      }
      break;
    case 'done':
      box.busy = undefined;
      if (msg.ok) {
        box.error = undefined;
        if (msg.action === 'merge') {
          box.confirming = false;
          box.title = {};
          box.body = {};
          toast(`Merged into ${vm?.pr.baseRef ?? 'the base branch'}.`, 'success');
        } else if (msg.action === 'deleteBranch') {
          toast('Branch deleted.', 'success');
        }
      } else {
        box.error = msg.message ?? 'GitHub refused.';
      }
      render();
      break;
    case 'error':
      if (vm) {
        toast(msg.message);
      } else {
        error = msg.message;
        render();
      }
      break;
  }
});

render();
persist();
post({ type: 'ready' });
