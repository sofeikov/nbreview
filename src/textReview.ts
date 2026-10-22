// The text review: notebooks as plain-text documents in VS Code's diff editor, with native
// comment threads, cell header decorations, outline/sticky scroll, folding and hovers.
import * as vscode from 'vscode';
import { mkdir, writeFile } from 'node:fs/promises';
import type { GhThread } from './github.ts';
import type { NotebookEntry, PlacedThread } from './session.ts';
import { parseBody, type Side } from './core/anchor.ts';
import type { ReviewDoc } from './core/reviewDoc.ts';
import type { Draft, ReviewState } from './state.ts';
import { basename } from './paths.ts';

export const SCHEME = 'nbreview';
export const RAW_SCHEME = 'nbreview-raw';

class NbComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  constructor(
    public body: vscode.MarkdownString | string,
    public author: vscode.CommentAuthorInformation,
    public timestamp?: Date,
    public label?: string,
    public contextValue?: string,
    public draftKey?: string,
    public parent?: vscode.CommentThread,
  ) {}
}

export class TextReview implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly controller: vscode.CommentController;
  private readonly ghThreads = new Map<string, vscode.CommentThread>(); // GitHub thread id → UI thread
  private readonly draftThreads = new Map<string, vscode.CommentThread>(); // draft key → UI thread
  private readonly contentChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly headerDeco: vscode.TextEditorDecorationType;
  private readonly outputDeco: vscode.TextEditorDecorationType;

  constructor(
    private readonly state: ReviewState,
    private readonly ctx: vscode.ExtensionContext,
  ) {
    this.controller = vscode.comments.createCommentController('nbreview', 'Notebook Review');
    this.controller.options = {
      prompt: 'Comment on this notebook line',
      placeHolder: 'Review comment (Markdown; ```suggestion blocks become GitHub suggestions)',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => {
        if (!this.docFor(document.uri) || document.lineCount === 0) {
          return [];
        }
        return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
      },
    };
    this.headerDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('nbreview.cellHeaderBackground'),
      after: { color: new vscode.ThemeColor('descriptionForeground'), fontStyle: 'italic' },
    });
    this.outputDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      fontStyle: 'italic',
      color: new vscode.ThemeColor('descriptionForeground'),
    });

    const provider: vscode.TextDocumentContentProvider = {
      onDidChange: this.contentChanged.event,
      provideTextDocumentContent: async uri => {
        if (uri.scheme === RAW_SCHEME) {
          const side = new URLSearchParams(uri.query).get('side') === 'LEFT' ? 'LEFT' : 'RIGHT';
          return (await this.state.session?.content(uri.path.slice(1), side)) ?? '';
        }
        return this.docFor(uri)?.doc.text ?? '';
      },
    };
    const symbols = new ReviewSymbols(uri => this.docFor(uri));
    this.disposables.push(
      this.controller,
      this.headerDeco,
      this.outputDeco,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
      vscode.workspace.registerTextDocumentContentProvider(RAW_SCHEME, provider),
      vscode.languages.registerHoverProvider({ scheme: SCHEME }, new ReviewHover(uri => this.docFor(uri), ctx)),
      vscode.languages.registerDocumentSymbolProvider({ scheme: SCHEME }, symbols),
      vscode.languages.registerFoldingRangeProvider({ scheme: SCHEME }, symbols),
      vscode.window.onDidChangeVisibleTextEditors(editors => this.decorate(editors)),
      vscode.commands.registerCommand('nbreview.addComment', (reply: vscode.CommentReply) => this.addFromReply(reply)),
      vscode.commands.registerCommand('nbreview.deleteDraft', (c: NbComment) => c.draftKey && this.state.removeDraft(c.draftKey, 'system')),
      vscode.commands.registerCommand('nbreview.editDraft', (c: NbComment) => this.setEditing(c, true)),
      vscode.commands.registerCommand('nbreview.cancelEditDraft', (c: NbComment) => this.setEditing(c, false)),
      vscode.commands.registerCommand('nbreview.saveDraft', (c: NbComment) => this.saveEdit(c)),
      state.onDidChange(e => {
        if (e.session) {
          for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.scheme === SCHEME) {
              this.contentChanged.fire(editor.document.uri);
            }
          }
        }
        if ((e.drafts && e.origin !== 'text') || e.threads || e.session) {
          this.renderThreads();
        }
      }),
    );
    this.decorate(vscode.window.visibleTextEditors);
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  reviewUri(nbPath: string, side: Side): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: `/${nbPath}.nbreview`, query: `side=${side}&pr=${this.state.prKey()}` });
  }

  docFor(uri: vscode.Uri): { entry: NotebookEntry; doc: ReviewDoc; side: Side } | undefined {
    if (uri.scheme !== SCHEME) {
      return undefined;
    }
    const side: Side = new URLSearchParams(uri.query).get('side') === 'LEFT' ? 'LEFT' : 'RIGHT';
    const entry = this.state.entry(uri.path.slice(1).replace(/\.nbreview$/, ''));
    return entry && { entry, side, doc: side === 'LEFT' ? entry.base : entry.head };
  }

  async openDiff(nbPath: string, reveal?: { side: Side; docLine: number }): Promise<void> {
    if (!this.state.entry(nbPath)) {
      return;
    }
    const selection = reveal && reveal.side === 'RIGHT' ? new vscode.Range(reveal.docLine, 0, reveal.docLine, 0) : undefined;
    await vscode.commands.executeCommand(
      'vscode.diff',
      this.reviewUri(nbPath, 'LEFT'),
      this.reviewUri(nbPath, 'RIGHT'),
      `📓 ${basename(nbPath)} (#${this.state.session!.pr.number})`,
      { preview: false, selection },
    );
  }

  async openFileDiff(path: string): Promise<void> {
    const s = this.state.session;
    if (!s) {
      return;
    }
    const raw = (side: Side) => vscode.Uri.from({ scheme: RAW_SCHEME, path: `/${path}`, query: `side=${side}&pr=${this.state.prKey()}` });
    await vscode.commands.executeCommand('vscode.diff', raw('LEFT'), raw('RIGHT'), `${basename(path)} (#${s.pr.number})`, { preview: true });
  }

  // --- Comment threads ------------------------------------------------------------------------

  private renderThreads(): void {
    for (const t of [...this.ghThreads.values(), ...this.draftThreads.values()]) {
      t.dispose();
    }
    this.ghThreads.clear();
    this.draftThreads.clear();
    const s = this.state.session;
    if (!s) {
      return;
    }
    const pending = this.state.drafts();
    for (const p of s.placed) {
      const thread = this.controller.createCommentThread(this.reviewUri(p.nbPath, p.side), lineRange(p.docLine), []);
      thread.comments = [
        ...p.gh.comments.map(ghComment),
        ...pending.filter(d => d.replyTo === p.gh.id).map(d => this.draftComment(d, thread)),
      ];
      thread.label = threadLabel(p);
      thread.contextValue = 'github';
      thread.canReply = true;
      thread.state = p.gh.isResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      thread.collapsibleState = p.gh.isResolved || p.gh.isOutdated
        ? vscode.CommentThreadCollapsibleState.Collapsed
        : vscode.CommentThreadCollapsibleState.Expanded;
      this.ghThreads.set(p.gh.id, thread);
    }
    for (const d of pending.filter(d => !d.replyTo)) {
      const thread = this.controller.createCommentThread(
        this.reviewUri(d.nbPath, d.side),
        new vscode.Range(d.startDocLine, 0, d.endDocLine, 0),
        [],
      );
      thread.comments = [this.draftComment(d, thread)];
      this.markDraftThread(thread, d);
    }
  }

  private draftComment(d: Draft, parent: vscode.CommentThread): NbComment {
    return new NbComment(new vscode.MarkdownString(d.text), { name: 'You' }, undefined, 'Pending', 'draft', d.key, parent);
  }

  private markDraftThread(thread: vscode.CommentThread, d: Draft): void {
    thread.label = this.state.describe(d);
    thread.contextValue = 'draft';
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.draftThreads.set(d.key, thread);
  }

  private async addFromReply(reply: vscode.CommentReply): Promise<void> {
    const target = this.docFor(reply.thread.uri);
    if (!target || !reply.text.trim()) {
      return;
    }
    const replyTo = [...this.ghThreads.entries()].find(([, t]) => t === reply.thread)?.[0];
    const range = reply.thread.range ?? lineRange(0);
    const d = await this.state.addDraft(
      {
        nbPath: target.entry.path,
        side: target.side,
        startDocLine: range.start.line,
        endDocLine: range.end.line,
        text: reply.text,
        replyTo,
      },
      'text',
    );
    if (replyTo) {
      reply.thread.comments = [...reply.thread.comments, this.draftComment(d, reply.thread)];
    } else {
      reply.thread.comments = [this.draftComment(d, reply.thread)];
      this.markDraftThread(reply.thread, d);
    }
  }

  private setEditing(comment: NbComment, editing: boolean): void {
    const thread = comment.parent;
    if (!thread) {
      return;
    }
    if (!editing) {
      const d = this.state.drafts().find(x => x.key === comment.draftKey);
      comment.body = new vscode.MarkdownString(d?.text ?? '');
    }
    comment.mode = editing ? vscode.CommentMode.Editing : vscode.CommentMode.Preview;
    thread.comments = [...thread.comments];
  }

  private async saveEdit(comment: NbComment): Promise<void> {
    if (!comment.draftKey) {
      return;
    }
    const text = typeof comment.body === 'string' ? comment.body : comment.body.value;
    comment.body = new vscode.MarkdownString(text);
    comment.mode = vscode.CommentMode.Preview;
    if (comment.parent) {
      comment.parent.comments = [...comment.parent.comments];
    }
    await this.state.updateDraft(comment.draftKey, text, 'text');
    const d = this.state.drafts().find(x => x.key === comment.draftKey);
    const thread = this.draftThreads.get(comment.draftKey);
    if (d && thread) {
      thread.label = this.state.describe(d);
    }
  }

  // --- Decorations ----------------------------------------------------------------------------

  private decorate(editors: readonly vscode.TextEditor[]): void {
    for (const editor of editors) {
      const target = this.docFor(editor.document.uri);
      if (!target) {
        continue;
      }
      const headers: vscode.DecorationOptions[] = [];
      const outputs: vscode.Range[] = [];
      const total = target.doc.notebook.cells.length;
      target.doc.lines.forEach((info, line) => {
        const range = new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length);
        if (info.kind === 'header') {
          headers.push({ range, renderOptions: { after: { contentText: `  cell ${info.cell.index + 1}/${total}` } } });
        } else if (info.kind === 'output') {
          outputs.push(range);
        }
      });
      editor.setDecorations(this.headerDeco, headers);
      editor.setDecorations(this.outputDeco, outputs);
    }
  }
}

function ghComment(c: GhThread['comments'][number]): NbComment {
  const { text } = parseBody(c.body);
  const md = new vscode.MarkdownString(`${text}\n\n[View on GitHub](${c.url})`);
  md.supportHtml = true;
  return new NbComment(
    md,
    { name: c.author, iconPath: c.avatarUrl ? vscode.Uri.parse(c.avatarUrl) : undefined },
    new Date(c.createdAt),
    undefined,
    'github',
  );
}

function threadLabel(p: PlacedThread): string {
  const bits = [p.gh.isResolved ? 'Resolved' : 'GitHub'];
  if (p.movedFrom) {
    bits.push(`from ${p.movedFrom}`);
  }
  if (p.note) {
    bits.push(p.note);
  }
  return bits.join(' · ');
}

function lineRange(line: number): vscode.Range {
  return new vscode.Range(line, 0, line, 0);
}

type DocLookup = (uri: vscode.Uri) => { doc: ReviewDoc } | undefined;

/** Cells (and the classes/functions inside code cells) for the outline, breadcrumbs and sticky scroll. */
class ReviewSymbols implements vscode.DocumentSymbolProvider, vscode.FoldingRangeProvider {
  constructor(private readonly docFor: DocLookup) {}

  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const target = this.docFor(document.uri);
    if (!target) {
      return [];
    }
    return cellSpans(target.doc).map(({ cell, start, end }) => {
      const title = cell.type === 'markdown'
        ? (cell.source.find(l => l.trim()) ?? '').replace(/^#+\s*/, '')
        : (cell.source.find(l => l.trim() && !l.startsWith('#|') && !l.startsWith('# |')) ?? '');
      const symbol = new vscode.DocumentSymbol(
        `cell ${cell.index + 1}`,
        title.slice(0, 60),
        cell.type === 'markdown' ? vscode.SymbolKind.String : vscode.SymbolKind.Module,
        new vscode.Range(start, 0, end, 0),
        new vscode.Range(start, 0, start, 0),
      );
      if (cell.type === 'code') {
        symbol.children = pythonSymbols(document, start + 1, end);
      }
      return symbol;
    });
  }

  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    const target = this.docFor(document.uri);
    return target ? cellSpans(target.doc).filter(s => s.end > s.start).map(s => new vscode.FoldingRange(s.start, s.end)) : [];
  }
}

function cellSpans(doc: ReviewDoc): { cell: ReviewDoc['lines'][number]['cell']; start: number; end: number }[] {
  const spans: { cell: ReviewDoc['lines'][number]['cell']; start: number; end: number }[] = [];
  doc.lines.forEach((info, line) => {
    if (info.kind === 'header') {
      spans.push({ cell: info.cell, start: line, end: line });
    } else if (spans.length && info.kind !== 'blank') {
      spans[spans.length - 1].end = line;
    }
  });
  return spans;
}

function pythonSymbols(document: vscode.TextDocument, from: number, to: number): vscode.DocumentSymbol[] {
  const roots: vscode.DocumentSymbol[] = [];
  const stack: { indent: number; symbol: vscode.DocumentSymbol }[] = [];
  const close = (indent: number, line: number) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      const { symbol } = stack.pop()!;
      symbol.range = new vscode.Range(symbol.range.start, new vscode.Position(Math.max(symbol.range.start.line, line), 0));
    }
  };
  let lastCode = from;
  for (let line = from; line <= to && line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (!text.trim()) {
      continue;
    }
    const indent = text.length - text.trimStart().length;
    const m = /^\s*(class|def|async def)\s+(\w+)/.exec(text);
    if (m || indent === 0) {
      close(indent, lastCode);
    }
    if (m) {
      const symbol = new vscode.DocumentSymbol(
        m[2],
        '',
        m[1] === 'class' ? vscode.SymbolKind.Class : stack.length ? vscode.SymbolKind.Method : vscode.SymbolKind.Function,
        new vscode.Range(line, 0, line, 0),
        new vscode.Range(line, 0, line, text.length),
      );
      (stack.length ? stack[stack.length - 1].symbol.children : roots).push(symbol);
      stack.push({ indent, symbol });
    }
    lastCode = line;
  }
  close(-1, lastCode);
  return roots;
}

class ReviewHover implements vscode.HoverProvider {
  constructor(
    private readonly docFor: DocLookup,
    private readonly ctx: vscode.ExtensionContext,
  ) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const info = this.docFor(document.uri)?.doc.lines[position.line];
    if (!info) {
      return undefined;
    }
    if (info.kind === 'output' && info.output?.kind === 'image' && info.output.data) {
      const ext = info.output.mime === 'image/svg+xml' ? 'svg' : info.output.mime === 'image/jpeg' ? 'jpg' : 'png';
      const dir = vscode.Uri.joinPath(this.ctx.globalStorageUri, 'outputs');
      await mkdir(dir.fsPath, { recursive: true });
      const file = vscode.Uri.joinPath(dir, `${info.output.hash}.${ext}`);
      await writeFile(file.fsPath, ext === 'svg' ? info.output.data : Buffer.from(info.output.data, 'base64'));
      const md = new vscode.MarkdownString(`**Output** · cell ${info.cell.index + 1}\n\n![output](${file.toString()}|width=480)`);
      md.supportHtml = true;
      return new vscode.Hover(md);
    }
    if (info.cell.type === 'markdown' && info.cell.source.length) {
      const md = new vscode.MarkdownString(`*Rendered markdown · cell ${info.cell.index + 1}*\n\n---\n\n${info.cell.source.join('\n')}`);
      md.supportHtml = true;
      return new vscode.Hover(md);
    }
    return undefined;
  }
}
