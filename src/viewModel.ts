// Builds what the review page shows: a notebook pair, or the two versions of any other changed
// file as a single code (or Markdown) cell, with its threads and pending comments.
import type { FileThread, NotebookEntry, PlacedThread } from './session.ts';
import type { GhThread, PrFile } from './github.ts';
import { fnv, type NbCell, type NbOutput } from './core/notebook.ts';
import { formatSize, imageMime, imageSize } from './core/binary.ts';
import { diffCells, onlyWhitespaceDiffers } from './core/cellDiff.ts';
import { anchorForDocLines, type ReviewDoc } from './core/reviewDoc.ts';
import { parseBody } from './core/anchor.ts';
import type { PendingComment } from './core/pending.ts';
import { highlightLines, renderCommentBody, renderMarkdownCell } from './render.ts';
import { renderMarkdownDiff } from './mdDiff.ts';
import { renderDocument, renderDocumentDiff } from './mdDoc.ts';
import { bibliographyPaths, includePaths, mergeMeta, parentDirs, parseBibtex, readFrontMatter, readYaml, type QuartoContext } from './core/quarto.ts';
import type { Anchor, CellVM, CommentVM, OutputVM, PendingVM, ThreadVM, ViewModel } from './webview/protocol.ts';

/** What a page compares when it isn't the whole pull request (see ViewModel.range). */
export type PageRange = NonNullable<ViewModel['range']>;

/**
 * The page's data for a notebook. With `range`, the sides are the notebook at two commits of the
 * pull request (`base` and `head`, each the pull request's own when left out) instead of its base
 * and head. With `hideNoise`, cells whose only change is their outputs, or whitespace in their
 * source, show as unchanged.
 */
export function buildViewModel(
  prEntry: NotebookEntry,
  pr: { number: number; title: string; url: string },
  range?: { base?: ReviewDoc; head?: ReviewDoc } & PageRange,
  options: { hideNoise?: boolean } = {},
): ViewModel {
  const base = range?.base ?? prEntry.base;
  const head = range?.head ?? prEntry.head;
  return modelFromCells({
    kind: 'notebook',
    path: prEntry.path,
    language: head.notebook.language || base.notebook.language || 'python',
    baseCells: base.notebook.cells,
    headCells: head.notebook.cells,
    file: prEntry.file,
    pr,
    range: range && { describe: range.describe, readOnly: range.readOnly },
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

/** The language a file is highlighted in, or `markdown` and `quarto` for the files that are rendered. */
export function fileLanguage(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (/^(Dockerfile|Containerfile)(\..*)?$/.test(name)) {
    return 'dockerfile';
  }
  if (/^(GNU)?[Mm]akefile$/.test(name)) {
    return 'makefile';
  }
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (ext === 'qmd') {
    return 'quarto';
  }
  return ext === 'md' || ext === 'markdown' ? 'markdown' : LANGUAGES[ext] ?? 'plaintext';
}

/**
 * What a Quarto file takes from the files around it, read with `read` at the same commit as the
 * file: the nearest `_quarto.yml` above it and the `_metadata.yml` files between, the project's
 * `_variables.yml`, the BibTeX files its metadata names (merged), and the files it includes.
 * Undefined for any other file. A file that isn't there reads as undefined.
 */
export async function loadQuartoContext(path: string, text: string | undefined, read: (path: string) => Promise<string | undefined>): Promise<QuartoContext | undefined> {
  if (text === undefined || fileLanguage(path) !== 'quarto') {
    return undefined;
  }
  const get = (p: string) => read(p).catch(() => undefined);
  const at = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
  const dirs = parentDirs(path);
  const projects = await Promise.all(dirs.map(d => get(at(d, '_quarto.yml'))));
  const k = projects.findIndex(t => t !== undefined);
  const projectDir = k < 0 ? undefined : dirs[k];
  // Directory metadata applies from the project folder down to the document's.
  const metaDirs = projectDir === undefined ? [] : dirs.slice(0, k + 1).reverse();
  const [metas, vars] = await Promise.all([
    Promise.all(metaDirs.map(d => get(at(d, '_metadata.yml')))),
    projectDir === undefined ? undefined : get(at(projectDir, '_variables.yml')),
  ]);
  // `project:` holds the project's own settings, not metadata.
  const projectMeta = { ...readYaml(projects[k]) };
  delete projectMeta.project;
  const project = projectDir === undefined ? undefined : mergeMeta(projectMeta, ...metas.map(readYaml));
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const own = readFrontMatter(lines).data;
  // A bibliography is relative to the file that names it: the document, or the project.
  const bibFiles = own?.bibliography !== undefined
    ? bibliographyPaths(path, own)
    : project?.bibliography !== undefined ? bibliographyPaths(at(projectDir!, '_quarto.yml'), project) : [];
  const ctx: QuartoContext = { path, projectDir, project, vars: readYaml(vars), includes: new Map() };
  // Includes, and what they include, two levels down.
  let todo = includePaths(path, text, projectDir);
  for (let depth = 0; depth < 3 && todo.length; depth++) {
    const texts = await Promise.all(todo.map(get));
    const next: string[] = [];
    todo.forEach((p, i) => {
      const t = texts[i];
      if (t !== undefined && !ctx.includes!.has(p)) {
        ctx.includes!.set(p, t);
        next.push(...includePaths(p, t, projectDir));
      }
    });
    todo = next.filter(p => !ctx.includes!.has(p));
  }
  const bibs = (await Promise.all(bibFiles.map(get))).filter((t): t is string => t !== undefined);
  if (bibs.length) {
    ctx.bibliography = new Map();
    for (const t of bibs) {
      for (const [key, v] of parseBibtex(t)) {
        ctx.bibliography.set(key, v);
      }
    }
  }
  return ctx;
}

/**
 * The page's data for a changed file that isn't a notebook: its two versions as one cell. `base`
 * or `head` is undefined when the file was added or removed; with `range`, they are the file at
 * two commits of the pull request.
 */
export function buildFileViewModel(
  file: PrFile,
  base: string | undefined,
  head: string | undefined,
  pr: { number: number; title: string; url: string },
  range?: PageRange,
  options: { hideNoise?: boolean; quarto?: { base?: QuartoContext; head?: QuartoContext } } = {},
): ViewModel {
  const language = fileLanguage(file.filename);
  const rendered = language === 'markdown' || language === 'quarto';
  // An SVG is shown as its source and, below it, as the picture.
  const svg = imageMime(file.filename) === 'image/svg+xml';
  const cell = (text: string | undefined): NbCell[] => (text === undefined ? [] : [{
    index: 0,
    id: 'file',
    type: rendered ? 'markdown' : 'code',
    source: text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'),
    jsonLines: [],
    cellJsonLine: 0,
    outputs: svg ? [{ kind: 'image', label: `SVG · ${formatSize(new TextEncoder().encode(text).length)}`, textLines: [], mime: 'image/svg+xml', data: text, hash: fnv(text) }] : [],
  }]);
  return modelFromCells({
    kind: 'file',
    path: file.filename,
    language,
    baseCells: cell(base),
    headCells: cell(head),
    file,
    pr,
    range,
    hideNoise: !!options.hideNoise,
    quarto: options.quarto,
  });
}

/**
 * The page's data for an image file (not an SVG, whose source is text): one cell with the old and
 * the new picture, so a changed image gets the same comparison as a changed plot.
 */
export function buildImageViewModel(
  file: PrFile,
  base: Uint8Array | undefined,
  head: Uint8Array | undefined,
  pr: { number: number; title: string; url: string },
  range?: PageRange,
): ViewModel {
  const mime = imageMime(file.filename) ?? 'application/octet-stream';
  const picture = (bytes: Uint8Array | undefined): OutputVM[] => {
    if (!bytes) {
      return [];
    }
    const data = Buffer.from(bytes).toString('base64');
    const size = imageSize(bytes);
    const type = file.filename.slice(file.filename.lastIndexOf('.') + 1).toUpperCase();
    return [{
      index: 0,
      hash: fnv(data),
      kind: 'image',
      label: [type, size && `${size.w}×${size.h}`, formatSize(bytes.length)].filter(Boolean).join(' · '),
      imageSrc: `data:${mime};base64,${data}`,
    }];
  };
  const baseOutputs = picture(base);
  const headOutputs = picture(head);
  const status: CellVM['status'] = !base ? 'added' : !head ? 'removed' : baseOutputs[0].hash === headOutputs[0].hash ? 'unchanged' : 'modified';
  const cell: CellVM = {
    key: head ? 'file' : 'file:removed',
    status,
    moved: false,
    sourceChanged: false,
    outputsChanged: status === 'modified',
    type: 'raw',
    baseId: base && 'file',
    headId: head && 'file',
    baseNumber: base && 1,
    headNumber: head && 1,
    baseLines: [],
    headLines: [],
    baseSource: [],
    headSource: [],
    ops: [],
    baseOutputs,
    headOutputs,
    title: '',
  };
  return {
    pr,
    path: file.filename,
    kind: 'file',
    image: true,
    ...(range ? { range } : {}),
    hideNoise: false,
    noise: { cells: 0, outputs: 0, whitespace: 0 },
    fileStats: { additions: file.additions, deletions: file.deletions },
    stats: { additions: 0, deletions: 0, modified: status === 'modified' ? 1 : 0, added: status === 'added' ? 1 : 0, removed: status === 'removed' ? 1 : 0, moved: 0 },
    cells: base || head ? [cell] : [],
  };
}

function modelFromCells(args: {
  kind: 'notebook' | 'file';
  path: string;
  language: string;
  baseCells: NbCell[];
  headCells: NbCell[];
  file: PrFile;
  pr: { number: number; title: string; url: string };
  range?: PageRange;
  hideNoise: boolean;
  /** For a Quarto file: what each version takes from its project (see loadQuartoContext). */
  quarto?: { base?: QuartoContext; head?: QuartoContext };
}): ViewModel {
  const { range, language } = args;
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
    // A file's only output is its own picture (an SVG), which changes with its source: never noise.
    const outputNoise = p.outputsChanged && args.kind === 'notebook';
    const outputsOnly = !!p.base && !!p.head && !sourceChanged && !whitespace && outputNoise;
    noise.outputs += outputsOnly || (whitespace && outputNoise) ? 1 : 0;
    noise.whitespace += whitespace ? 1 : 0;
    noise.cells += outputsOnly || whitespace ? 1 : 0;
    const hidden = hide && !!p.base && !!p.head && !sourceChanged && (outputNoise || whitespace);
    return {
      key: (p.head ?? p.base)!.id + (p.head ? '' : ':removed'),
      status: hidden ? 'unchanged' : p.status,
      moved: p.moved,
      sourceChanged,
      outputsChanged: p.outputsChanged && !hidden,
      ...(hidden ? { noiseHidden: outputNoise && whitespace ? 'outputs and whitespace' : outputNoise ? 'outputs' : 'whitespace' } : {}),
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
      ...(args.kind === 'file' ? documentHtml(p, same, args) : markdownHtml(p, same)),
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
    ...(range ? { range } : {}),
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

/** Rendered Markdown or Quarto file of each version, its front matter as a title block. */
function documentHtml(
  p: ReturnType<typeof diffCells>[number],
  same: boolean,
  args: { language: string; quarto?: { base?: QuartoContext; head?: QuartoContext } },
): { baseHtml?: string; headHtml?: string } {
  const base = p.base?.type === 'markdown' ? p.base : undefined;
  const head = p.head?.type === 'markdown' ? p.head : undefined;
  const quarto = args.language === 'quarto';
  const ctx = args.quarto;
  if (base && head && p.sourceChanged) {
    const diff = renderDocumentDiff(base.source, head.source, { quarto, base: ctx?.base, head: ctx?.head });
    return { baseHtml: diff.base, headHtml: diff.head };
  }
  return {
    baseHtml: base && !same ? renderDocument(base.source, { quarto, context: ctx?.base }) : undefined,
    headHtml: head ? renderDocument(head.source, { quarto, context: ctx?.head }) : undefined,
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

/** The pending comments for the Submit review box, each rendered as it is in its thread. */
export function buildPendingList(comments: PendingComment[]): PendingVM[] {
  return comments.map(c => ({ id: c.id, path: c.path, where: c.where, reply: c.reply, html: renderCommentBody(c.text) }));
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
