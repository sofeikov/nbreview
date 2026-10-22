// Builds what the visual review page shows from a notebook pair, its threads and pending comments.
import type { NotebookEntry, PlacedThread } from './session.ts';
import type { NbCell, NbOutput } from './core/notebook.ts';
import { diffCells } from './core/cellDiff.ts';
import { anchorForDocLines, type ReviewDoc } from './core/reviewDoc.ts';
import { parseBody } from './core/anchor.ts';
import { highlightLines, renderCommentBody, renderMarkdownCell } from './render.ts';
import type { CellVM, OutputVM, ThreadVM, ViewModel } from './webview/protocol.ts';

export function buildViewModel(entry: NotebookEntry, pr: { number: number; title: string; url: string }): ViewModel {
  const language = entry.head.notebook.language || entry.base.notebook.language || 'python';
  const pairs = diffCells(entry.base.notebook.cells, entry.head.notebook.cells);
  const cells: CellVM[] = pairs.map(p => {
    const any = (p.head ?? p.base)!;
    const lang = any.type === 'code' ? language : any.type === 'markdown' ? 'markdown' : 'plaintext';
    const same = !!p.base && !!p.head && p.base.type === p.head.type && p.lines.every(l => l.op === 'same') && p.base.source.length === p.head.source.length;
    return {
      key: (p.head ?? p.base)!.id + (p.head ? '' : ':removed'),
      status: p.status,
      moved: p.moved,
      sourceChanged: p.sourceChanged,
      outputsChanged: p.outputsChanged,
      type: any.type,
      baseId: p.base?.id,
      headId: p.head?.id,
      baseNumber: p.base ? p.base.index + 1 : undefined,
      headNumber: p.head ? p.head.index + 1 : undefined,
      baseLines: p.base && !same ? highlightLines(p.base.source, lang) : [],
      headLines: p.head ? highlightLines(p.head.source, lang) : [],
      baseSource: same ? [] : p.base?.source ?? [],
      headSource: p.head?.source ?? [],
      baseSameAsHead: same || undefined,
      ops: p.lines.map(l => (l.op === 'same' ? { op: 'same', b: l.base, h: l.head } : l.op === 'del' ? { op: 'del', b: l.base } : { op: 'add', h: l.head })),
      baseHtml: p.base?.type === 'markdown' && !same ? renderMarkdownCell(p.base.source) : undefined,
      headHtml: p.head?.type === 'markdown' ? renderMarkdownCell(p.head.source) : undefined,
      baseOutputs: (p.base?.outputs ?? []).map(outputVM),
      headOutputs: (p.head?.outputs ?? []).map(outputVM),
      title: cellTitle(any),
    };
  });
  const count = (s: CellVM['status']) => cells.filter(c => c.status === s).length;
  return {
    pr,
    path: entry.path,
    stats: {
      additions: entry.file.additions,
      deletions: entry.file.deletions,
      modified: count('modified'),
      added: count('added'),
      removed: count('removed'),
      moved: cells.filter(c => c.moved).length,
    },
    cells,
  };
}

function outputVM(o: NbOutput, index: number): OutputVM {
  const vm: OutputVM = { index, kind: o.kind, label: o.label };
  if (o.kind === 'image' && o.data) {
    vm.imageSrc = o.mime === 'image/svg+xml'
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(o.data)}`
      : `data:${o.mime};base64,${o.data}`;
  } else if (o.html) {
    vm.html = o.html;
  } else if (o.textLines.length) {
    vm.text = o.textLines.join('\n');
  }
  return vm;
}

function cellTitle(cell: NbCell): string {
  const line = cell.type === 'markdown'
    ? cell.source.find(l => l.trim())?.replace(/^#+\s*/, '')
    : cell.source.find(l => l.trim() && !/^#\s?\|/.test(l));
  return (line ?? '').trim().slice(0, 100);
}

export function buildThreads(entry: NotebookEntry, placed: PlacedThread[], describe: (p: PlacedThread) => string): ThreadVM[] {
  const docOf = (side: 'LEFT' | 'RIGHT'): ReviewDoc => (side === 'LEFT' ? entry.base : entry.head);
  const out: ThreadVM[] = [];
  for (const p of placed) {
    const a = anchorForDocLines(docOf(p.side), p.startDocLine ?? p.docLine, p.docLine);
    if (!a) {
      continue;
    }
    // A thread of only pending comments is the reviewer's own, not yet on the pull request.
    const ownPending = p.gh.comments.every(c => c.pending);
    const labelBits = [p.gh.isResolved ? 'Resolved' : 'GitHub'];
    if (p.movedFrom) {
      labelBits.push(`from ${p.movedFrom}`);
    }
    if (p.note) {
      labelBits.push(p.note);
    }
    out.push({
      id: p.gh.id,
      anchor: { side: p.side, ...a },
      label: ownPending ? describe(p) : labelBits.join(' · '),
      resolved: p.gh.isResolved,
      outdated: p.gh.isOutdated && !ownPending,
      draft: ownPending,
      canReply: true,
      comments: p.gh.comments.map(c => {
        const text = parseBody(c.body).text;
        return c.pending
          ? { author: 'You', html: renderCommentBody(text), createdAt: c.createdAt, pending: true, draftKey: c.id, text }
          : { author: c.author, avatarUrl: c.avatarUrl, html: renderCommentBody(text), createdAt: c.createdAt, url: c.url, pending: false };
      }),
    });
  }
  return out;
}

