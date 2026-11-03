// Builds the Overview page's data from GitHub's answer and the open review session: the status
// lines, the description and the conversation, with each review thread under the review that
// started it and a few lines of the code it is on. Loaded with the page, like viewModel.ts.
import type { GhOverview, GhReaction, GhThread, GhTimelineItem, GhUser } from './github.ts';
import type { FileThread, PlacedThread, ReviewSession } from './session.ts';
import type { ReactionVM } from './webview/protocol.ts';
import type { OverviewVM, OvThreadVM, SnippetVM, TimelineVM } from './webview/overviewProtocol.ts';
import { mergeVerdict, summarizeBranch, summarizeChecks, summarizeReviews, type Check } from './core/prStatus.ts';
import { parseBody } from './core/anchor.ts';
import { escapeHtml, highlightLines, renderCommentBody, renderGitHubMarkdown } from './render.ts';
import { fileLanguage } from './viewModel.ts';

/** Lines of code shown above a commented line, as on github.com. */
const SNIPPET_CONTEXT = 3;
const SNIPPET_MAX = 8;

export async function buildOverview(o: GhOverview, s: ReviewSession, now = new Date()): Promise<OverviewVM> {
  const repoUrl = `https://github.com/${s.pr.owner}/${s.pr.repo}`;
  const checks = summarizeChecks(o.checks);
  const input = { ...o, checks };
  const threads = await threadIndex(s);
  const author = o.author.login;
  return {
    pr: {
      number: s.pr.number,
      repo: `${s.pr.owner}/${s.pr.repo}`,
      title: o.title,
      url: o.url,
      state: o.state,
      isDraft: o.isDraft,
      author: o.author,
      createdAt: o.createdAt,
      mergedAt: o.mergedAt,
      mergedBy: o.mergedBy,
      closedAt: o.closedAt,
      baseRef: o.baseRef,
      headRef: o.headOwner ? `${o.headOwner}:${o.headRef}` : o.headRef,
      additions: o.additions,
      deletions: o.deletions,
      changedFiles: o.changedFiles,
      commits: o.commits,
    },
    viewer: o.viewer,
    bodyHtml: o.body.trim() ? renderGitHubMarkdown(o.body, repoUrl) : '',
    bodyReactions: reactionVMs(o.reactions),
    verdict: mergeVerdict(input),
    reviews: { ...summarizeReviews(o.reviewDecision, o.reviewers), reviewers: o.reviewers },
    checks: { ...checks, list: o.checks.map(checkVM) },
    branch: summarizeBranch(input),
    assignees: o.assignees,
    labels: o.labels.map(l => ({ name: l.name, ...labelColors(l.color) })),
    milestone: o.milestone,
    closingIssues: o.closingIssues,
    timeline: buildTimeline(o.timeline, threads, { author, repoUrl, headRef: o.headRef, baseRef: o.baseRef }),
    timelineMissing: o.timelineMissing,
    fetchedAt: now.toISOString(),
  };
}

function checkVM(c: Check) {
  const ms = c.startedAt && c.completedAt ? new Date(c.completedAt).getTime() - new Date(c.startedAt).getTime() : undefined;
  // Skipped and cancelled checks take no time worth showing.
  const ran = c.state === 'success' || c.state === 'failure' || c.state === 'neutral';
  return { name: c.name, workflow: c.workflow, state: c.state, description: c.description, url: c.url, required: c.required, duration: ms === undefined || !ran ? undefined : duration(ms) };
}

/** For example "45s", "3m 12s" or "1h 4m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** A label's colours: GitHub's own background, with black or white text, whichever reads better on it. */
export function labelColors(hex: string): { background: string; foreground: string } {
  const m = /^#?([\da-f]{6})$/i.exec(hex);
  if (!m) {
    return { background: 'transparent', foreground: 'inherit' };
  }
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { background: `#${m[1]}`, foreground: luminance > 0.4 ? '#1f2328' : '#ffffff' };
}

function reactionVMs(list: GhReaction[]): ReactionVM[] {
  return list.map(r => ({ content: r.content, count: r.count, mine: r.viewerHasReacted }));
}

interface Located {
  gh: GhThread;
  thread: OvThreadVM;
}

/** Every thread of the session with where it is and the lines it is on, by the id of its first comment. */
async function threadIndex(s: ReviewSession): Promise<Map<string, Located>> {
  const byComment = new Map<string, Located>();
  const add = (gh: GhThread, thread: OvThreadVM) => {
    const first = gh.comments[0];
    if (first && !byComment.has(first.id)) {
      byComment.set(first.id, { gh, thread });
    }
  };
  for (const p of s.placed) {
    add(p.gh, threadVM(p.gh, p.movedFrom ?? p.nbPath, notebookSnippet(s, p), notebookTarget(s, p)));
  }
  await Promise.all([...s.fileThreads.values()].flat().map(async f => {
    add(f.gh, threadVM(f.gh, f.path, await fileSnippet(s, f), { path: f.path }));
  }));
  return byComment;
}

function threadVM(gh: GhThread, path: string, snippet: SnippetVM | undefined, open: OvThreadVM['open']): OvThreadVM {
  return {
    id: gh.id,
    path,
    resolved: gh.isResolved,
    outdated: gh.isOutdated,
    snippet,
    open,
    comments: gh.comments.filter(c => !c.pending).map(c => ({
      id: c.id,
      author: { login: c.author, avatarUrl: c.avatarUrl },
      isAuthor: false,
      createdAt: c.createdAt,
      html: renderCommentBody(parseBody(c.body).text),
      url: c.url,
      reactions: reactionVMs(c.reactions),
    })),
  };
}

function notebookTarget(s: ReviewSession, p: PlacedThread): OvThreadVM['open'] {
  const entry = s.notebooks.get(p.nbPath);
  const doc = entry && (p.side === 'LEFT' ? entry.base : entry.head);
  const cell = doc?.lines[p.docLine]?.cell;
  return { path: p.nbPath, cellKey: cell?.id };
}

/** The commented cell lines, with a few lines above them, highlighted. */
function notebookSnippet(s: ReviewSession, p: PlacedThread): SnippetVM | undefined {
  const entry = s.notebooks.get(p.nbPath);
  const doc = entry && (p.side === 'LEFT' ? entry.base : entry.head);
  const line = doc?.lines[p.docLine];
  if (!doc || !line) {
    return undefined;
  }
  const cell = line.cell;
  const number = doc.notebook.cells.indexOf(cell) + 1;
  const where = `cell ${number}`;
  if (line.kind === 'output') {
    return { where: `${where} · output`, lines: [{ html: escapeHtml(`▸ ${line.output?.label ?? 'output'}`), marked: true }] };
  }
  if (!cell.source.length) {
    return undefined;
  }
  const html = cell.type === 'code' ? highlightLines(cell.source, 'python') : cell.source.map(escapeHtml);
  const startInfo = doc.lines[p.startDocLine ?? p.docLine];
  // A comment on a cell's header line is on the whole cell: its first lines stand for it.
  const end = line.kind === 'source' ? line.sourceLine! : Math.min(cell.source.length, SNIPPET_MAX - SNIPPET_CONTEXT) - 1;
  const start = line.kind === 'source' && startInfo?.kind === 'source' && startInfo.cell === cell ? startInfo.sourceLine! : end;
  return { where: line.kind === 'source' ? `${where} · ${lineRange(start, end)}` : where, lines: snippetLines(html, line.kind === 'source' ? start : -1, end) };
}

async function fileSnippet(s: ReviewSession, f: FileThread): Promise<SnippetVM | undefined> {
  if (f.gh.subjectType === 'FILE') {
    return undefined;
  }
  const text = await s.content(f.path, f.side).catch(() => undefined);
  if (text === undefined || text.length > 2_000_000) {
    return undefined;
  }
  const source = text.split('\n');
  if (f.docLine >= source.length) {
    return undefined;
  }
  const start = f.startDocLine ?? f.docLine;
  // Highlighting from a little further up keeps most strings and comments coloured right.
  const from = Math.max(0, f.docLine - SNIPPET_MAX - 20);
  const html = highlightLines(source.slice(from, f.docLine + 1), fileLanguage(f.path));
  return { where: lineRange(start, f.docLine), lines: snippetLines(html, start, f.docLine, from) };
}

function lineRange(start: number, end: number): string {
  return start === end ? `line ${end + 1}` : `lines ${start + 1}–${end + 1}`;
}

/** Up to SNIPPET_MAX lines ending at `end`, those from `start` on marked (none when `start` is -1). `html[0]` is line `offset`. */
export function snippetLines(html: string[], start: number, end: number, offset = 0): SnippetVM['lines'] {
  const from = Math.max(offset, Math.min(start < 0 ? end : start, end) - SNIPPET_CONTEXT, end - SNIPPET_MAX + 1);
  const out: SnippetVM['lines'] = [];
  for (let i = from; i <= end && i - offset < html.length; i++) {
    out.push({ number: i + 1, html: html[i - offset] || ' ', marked: start >= 0 && i >= start });
  }
  return out;
}

const EVENT_TEXT: Record<Extract<GhTimelineItem, { kind: 'event' }>['event'], [icon: string, text: (subject: string, refs: { headRef: string; baseRef: string }) => string, tone?: 'merged' | 'danger' | 'success']> = {
  merged: ['git-merge', (_, r) => `merged this into ${r.baseRef}`, 'merged'],
  closed: ['git-pull-request-closed', () => 'closed this', 'danger'],
  reopened: ['git-pull-request', () => 'reopened this', 'success'],
  ready: ['eye', () => 'marked this as ready for review'],
  draft: ['git-pull-request-draft', () => 'marked this as a draft'],
  forcePushed: ['repo-force-push', (_, r) => `force-pushed the ${r.headRef} branch`],
  reviewRequested: ['person', s => `asked ${s ? `@${s}` : 'someone'} to review`],
  reviewDismissed: ['circle-slash', s => `dismissed ${s ? `@${s}’s` : 'a'} review`],
  renamed: ['edit', s => `changed the title from “${s}”`],
  baseChanged: ['git-compare', s => `changed the base branch to ${s}`],
};

/**
 * The conversation in time order. Pushes in a row become one entry, and each review carries the
 * threads it started; the viewer's pending review is left out, as it isn't on the pull request.
 */
export function buildTimeline(
  items: GhTimelineItem[],
  threads: Map<string, Located>,
  ctx: { author: string; repoUrl: string; headRef: string; baseRef: string },
): TimelineVM[] {
  const out: TimelineVM[] = [];
  const user = (u: GhUser) => ({ login: u.login, avatarUrl: u.avatarUrl });
  for (const item of items) {
    switch (item.kind) {
      case 'comment':
        out.push({
          kind: 'comment',
          id: item.id,
          author: user(item.author),
          isAuthor: item.author.login === ctx.author,
          createdAt: item.createdAt,
          html: renderGitHubMarkdown(item.body, ctx.repoUrl),
          url: item.url,
          reactions: reactionVMs(item.reactions),
        });
        break;
      case 'review': {
        if (item.state === 'PENDING') {
          break;
        }
        const started = item.commentIds.map(id => threads.get(id)).filter((t): t is Located => !!t);
        const threadVMs = started.map(t => ({
          ...t.thread,
          comments: t.thread.comments.map(c => ({ ...c, isAuthor: c.author.login === ctx.author })),
        }));
        const inThreads = new Set(started.flatMap(t => t.gh.comments.map(c => c.id)));
        out.push({
          kind: 'review',
          id: item.id,
          author: user(item.author),
          isAuthor: item.author.login === ctx.author,
          state: item.state,
          createdAt: item.createdAt,
          html: item.body.trim() ? renderGitHubMarkdown(parseBody(item.body).text, ctx.repoUrl) : '',
          url: item.url,
          reactions: reactionVMs(item.reactions),
          threads: threadVMs,
          otherComments: item.commentIds.filter(id => !inThreads.has(id)).length,
        });
        break;
      }
      case 'commit': {
        const commit = { oid: item.oid, message: item.message, author: user(item.author), createdAt: item.createdAt, url: item.url };
        const last = out[out.length - 1];
        if (last?.kind === 'commits') {
          last.commits.push(commit);
        } else {
          out.push({ kind: 'commits', id: `commits-${item.oid}`, createdAt: item.createdAt, commits: [commit] });
        }
        break;
      }
      case 'event': {
        const [icon, text, tone] = EVENT_TEXT[item.event];
        out.push({
          kind: 'event',
          id: `${item.event}-${item.createdAt}`,
          icon,
          actor: user(item.actor),
          createdAt: item.createdAt,
          text: text(item.subject ?? '', ctx),
          ...(tone ? { tone } : {}),
        });
        break;
      }
    }
  }
  return out;
}
