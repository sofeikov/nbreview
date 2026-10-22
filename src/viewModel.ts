// Builds what the review page shows: a notebook pair, or the two versions of any other changed
// file as a single code (or Markdown) cell, with its threads and pending comments.
import type { FileThread, NotebookEntry, PlacedThread } from './session.ts';
import type { GhThread, PrFile } from './github.ts';
import type { NbCell, NbOutput } from './core/notebook.ts';
import { diffCells, onlyWhitespaceDiffers } from './core/cellDiff.ts';
import { anchorForDocLines, type ReviewDoc } from './core/reviewDoc.ts';
import { parseBody } from './core/anchor.ts';
import { highlightLines, renderCommentBody, renderMarkdownCell } from './render.ts';
import { renderMarkdownDiff } from './mdDiff.ts';
import type { Anchor, CellVM, CommentVM, OutputVM, ThreadVM, ViewModel } from './webview/protocol.ts';

/**
 * The page's data for a notebook. With `since`, the old side is the notebook as it was at the
 * viewer's last review instead of the pull request's base. With `hideNoise`, cells whose only
 * change is their outputs, or whitespace in their source, show as unchanged.
 */
export function buildViewModel(
  prEntry: NotebookEntry,
  pr: { number: number; title: string; url: string },
  since?: { base: ReviewDoc; label: string },
  options: { hideNoise?: boolean } = {},
): ViewModel {
  const base = since ? since.base : prEntry.base;
  return modelFromCells({
    kind: 'notebook',
    path: prEntry.path,
    language: prEntry.head.notebook.language || base.notebook.language || 'python',
    baseCells: base.notebook.cells,
    headCells: prEntry.head.notebook.cells,
    file: prEntry.file,
    pr,
    since: since && { label: since.label },
    hideNoise: !!options.hideNoise,
  });
}

/** Highlight.js names of the languages the page colours, by file extension. */
const LANGUAGES: Record<string, string> = {
  py: 'python', pyi: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', yml: 'yaml', yaml: 'yaml',
  json: 'json', jsonc: 'json', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', js: 'javascript', mjs: 'javascript',
  cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript', html: 'xml', xml: 'xml',
  svg: 'xml', css: 'css', r: 'r', mk: 'makefile',
};

/** The language a file is highlighted in, or `markdown` for Markdown files, which are rendered. */
export function fileLanguage(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (/^(Dockerfile|Containerfile)(\..*)?$/.test(name)) {
    return 'dockerfile';
  }
  if (/^(GNU)?[Mm]akefile$/.test(name)) {
    return 'makefile';
  }
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return ext === 'md' || ext === 'markdown' ? 'markdown' : LANGUAGES[ext] ?? 'plaintext';
}

/**
 * The page's data for a changed file that isn't a notebook: its two versions as one cell. `base`
 * or `head` is undefined when the file was added or removed; with `since`, `base` is the file at
 * the viewer's last review.
 */
export function buildFileViewModel(
  file: PrFile,
  base: string | undefined,
  head: string | undefined,
  pr: { number: number; title: string; url: string },
  since?: { label: string },
  options: { hideNoise?: boolean } = {},
): ViewModel {
  const language = fileLanguage(file.filename);
  const cell = (text: string | undefined): NbCell[] => (text === undefined ? [] : [{
    index: 0,
    id: 'file',
    type: language === 'markdown' ? 'markdown' : 'code',
    source: text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'),
    jsonLines: [],
    cellJsonLine: 0,
    outputs: [],
  }]);
  return modelFromCells({
    kind: 'file',
    path: file.filename,
    language,
    baseCells: cell(base),
    headCells: cell(head),
    file,
    pr,
    since,
    hideNoise: !!options.hideNoise,
  });
}

function modelFromCells(args: {
  kind: 'notebook' | 'file';
  path: string;
  language: string;
  baseCells: NbCell[];
  headCells: NbCell[];
  file: PrFile;
  pr: { number: number; title: string; url: string };
  since?: { label: string };
  hideNoise: boolean;
}): ViewModel {
  const { since, language } = args;
  const hide = args.hideNoise;
  const pairs = diffCells(args.baseCells, args.headCells, { ignoreWhitespace: hide });
  const noise = { cells: 0, outputs: 0, whitespace: 0 };
  const cells: CellVM[] = pairs.map(p => {
    const any = (p.head ?? p.base)!;
    const lang = any.type === 'code' ? language : any.type === 'markdown' ? 'markdown' : 'plaintext';
    const same = !!p.base && !!p.head && p.base.type === p.head.type && p.lines.every(l => l.op === 'same') && p.base.source.length === p.head.source.length;
    // Counted whether or not it is hidden, so the page can say how much there is to hide.
    const whitespace = !!p.base && !!p.head && p.base.type === p.head.type && onlyWhitespaceDiffers(p.base.source, p.head.source);
    const sourceChanged = p.sourceChanged && !(hide && whitespace);
    const outputsOnly = !!p.base && !!p.head && !sourceChanged && !whitespace && p.outputsChanged;
    noise.outputs += outputsOnly || (whitespace && p.outputsChanged) ? 1 : 0;
    noise.whitespace += whitespace ? 1 : 0;
    noise.cells += outputsOnly || whitespace ? 1 : 0;
    const hidden = hide && !!p.base && !!p.head && !sourceChanged && (p.outputsChanged || whitespace);
    return {
      key: (p.head ?? p.base)!.id + (p.head ? '' : ':removed'),
      status: hidden ? 'unchanged' : p.status,
      moved: p.moved,
      sourceChanged,
      outputsChanged: p.outputsChanged && !hidden,
      ...(hidden ? { noiseHidden: p.outputsChanged && whitespace ? 'outputs and whitespace' : p.outputsChanged ? 'outputs' : 'whitespace' } : {}),
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
      ...markdownHtml(p, same),
      baseOutputs: (p.base?.outputs ?? []).map(outputVM),
      headOutputs: (p.head?.outputs ?? []).map(outputVM),
      title: cellTitle(any),
    };
  });
  const count = (s: CellVM['status']) => cells.filter(c => c.status === s).length;
  // Source lines, not the JSON lines GitHub counts, which for a notebook are mostly outputs and metadata.
  const lines = (op: 'add' | 'del') => cells.reduce((n, c) => n + (c.sourceChanged ? c.ops.filter(o => o.op === op).length : 0), 0);
  return {
    pr: args.pr,
    path: args.path,
    kind: args.kind,
    ...(args.kind === 'file' ? { language } : {}),
    ...(since ? { since: { label: since.label } } : {}),
    hideNoise: hide,
    noise,
    fileStats: { additions: args.file.additions, deletions: args.file.deletions },
    stats: {
      additions: lines('add'),
      deletions: lines('del'),
      modified: count('modified'),
      added: count('added'),
      removed: count('removed'),
      moved: cells.filter(c => c.moved).length,
    },
    cells,
  };
}

/** Rendered Markdown of each version; a changed cell gets its changed words and paragraphs marked. */
function markdownHtml(p: ReturnType<typeof diffCells>[number], same: boolean): { baseHtml?: string; headHtml?: string } {
  const base = p.base?.type === 'markdown' ? p.base : undefined;
  const head = p.head?.type === 'markdown' ? p.head : undefined;
  if (base && head && p.sourceChanged) {
    const diff = renderMarkdownDiff(base.source, head.source);
    return { baseHtml: diff.base, headHtml: diff.head };
  }
  return {
    baseHtml: base && !same ? renderMarkdownCell(base.source) : undefined,
    headHtml: head ? renderMarkdownCell(head.source) : undefined,
  };
}

function outputVM(o: NbOutput, index: number): OutputVM {
  const vm: OutputVM = { index, hash: o.hash, kind: o.kind, label: o.label };
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
    if (a) {
      out.push(threadVM(p.gh, { side: p.side, ...a }, [p.movedFrom && `from ${p.movedFrom}`, p.note], () => describe(p)));
    }
  }
  return out;
}

/**
 * The threads of a file shown as one cell: a line comment on its lines, a comment on the whole
 * file at the top.
 */
export function buildFileThreads(threads: FileThread[], describe: (gh: GhThread) => string): ThreadVM[] {
  return threads.map(f => {
    const anchor: Anchor = f.gh.subjectType === 'FILE'
      ? { side: 'RIGHT', cellId: 'file', kind: 'cell' }
      : { side: f.side, cellId: 'file', kind: 'source', start: f.startDocLine ?? f.docLine, end: f.docLine };
    return threadVM(f.gh, anchor, [f.note], () => describe(f.gh));
  });
}

function threadVM(gh: GhThread, anchor: Anchor, notes: (string | undefined)[], describe: () => string): ThreadVM {
  // A thread of only pending comments is the reviewer's own, not yet on the pull request.
  const ownPending = gh.comments.every(c => c.pending);
  return {
    id: gh.id,
    anchor,
    label: ownPending ? describe() : [gh.isResolved ? 'Resolved' : 'GitHub', ...notes].filter(Boolean).join(' · '),
    resolved: gh.isResolved,
    outdated: gh.isOutdated && !ownPending,
    draft: ownPending,
    canReply: true,
    canResolve: gh.viewerCanResolve && !ownPending,
    canUnresolve: gh.viewerCanUnresolve && !ownPending,
    comments: gh.comments.map((c): CommentVM => {
      const text = parseBody(c.body).text;
      const canEdit = c.pending || c.viewerCanUpdate;
      const canDelete = c.pending || c.viewerCanDelete;
      return c.pending
        ? { id: c.id, author: 'You', html: renderCommentBody(text), createdAt: c.createdAt, pending: true, canEdit, canDelete, text }
        : {
          id: c.id,
          author: c.author,
          avatarUrl: c.avatarUrl,
          html: renderCommentBody(text),
          createdAt: c.createdAt,
          url: c.url,
          pending: false,
          canEdit,
          canDelete,
          ...(canEdit ? { text } : {}),
          reactions: c.reactions.map(r => ({ content: r.content, count: r.count, mine: r.viewerHasReacted })),
        };
    }),
  };
}
