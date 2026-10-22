// Builds what the visual review page shows from a notebook pair, its threads and pending comments.
import type { NotebookEntry, PlacedThread } from './session.ts';
import type { NbCell, NbOutput } from './core/notebook.ts';
import { diffCells } from './core/cellDiff.ts';
import { anchorForDocLines, type ReviewDoc } from './core/reviewDoc.ts';
import { parseBody } from './core/anchor.ts';
import { highlightLines, renderCommentBody, renderMarkdownCell } from './render.ts';
import type { Anchor, CellVM, OutputVM, ThreadVM, ViewModel } from './webview/protocol.ts';
import type { Draft } from './state.ts';

export function buildViewModel(entry: NotebookEntry, pr: { number: number; title: string; url: string }): ViewModel {
  const language = entry.head.notebook.language || entry.base.notebook.language || 'python';
  const pairs = diffCells(entry.base.notebook.cells, entry.head.notebook.cells);
  const cells: CellVM[] = pairs.map(p => {
    const any = (p.head ?? p.base)!;
    const lang = any.type === 'code' ? language : any.type === 'markdown' ? 'markdown' : 'plaintext';
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
      baseLines: p.base ? highlightLines(p.base.source, lang) : [],
      headLines: p.head ? highlightLines(p.head.source, lang) : [],
      baseSource: p.base?.source ?? [],
      headSource: p.head?.source ?? [],
      ops: p.lines.map(l => (l.op === 'same' ? { op: 'same', b: l.base, h: l.head } : l.op === 'del' ? { op: 'del', b: l.base } : { op: 'add', h: l.head })),
      baseHtml: p.base?.type === 'markdown' ? renderMarkdownCell(p.base.source) : undefined,
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

export function buildThreads(
  entry: NotebookEntry,
  placed: PlacedThread[],
  drafts: Draft[],
  describe: (d: Draft) => string,
): ThreadVM[] {
  const docOf = (side: 'LEFT' | 'RIGHT'): ReviewDoc => (side === 'LEFT' ? entry.base : entry.head);
  const out: ThreadVM[] = [];
  for (const p of placed) {
    const a = anchorForDocLines(docOf(p.side), p.docLine, p.docLine);
    if (!a) {
      continue;
    }
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
      label: labelBits.join(' · '),
      resolved: p.gh.isResolved,
      outdated: p.gh.isOutdated,
      draft: false,
      canReply: true,
      comments: [
        ...p.gh.comments.map(c => ({
          author: c.author,
          avatarUrl: c.avatarUrl,
          html: renderCommentBody(parseBody(c.body).text),
          createdAt: c.createdAt,
          url: c.url,
          pending: false,
        })),
        ...drafts.filter(d => d.replyTo === p.gh.id).map(draftComment),
      ],
    });
  }
  for (const d of drafts.filter(d => !d.replyTo && d.nbPath === entry.path)) {
    const a = anchorForDocLines(docOf(d.side), d.startDocLine, d.endDocLine);
    if (!a) {
      continue;
    }
    const anchor: Anchor = { side: d.side, ...a };
    out.push({
      id: d.key,
      anchor,
      label: describe(d),
      resolved: false,
      outdated: false,
      draft: true,
      canReply: false,
      comments: [draftComment(d)],
    });
  }
  return out;
}

function draftComment(d: Draft) {
  return { author: 'You', html: renderCommentBody(d.text), pending: true, draftKey: d.key, text: d.text };
}
