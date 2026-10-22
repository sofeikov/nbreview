// The text review: notebooks as plain-text documents in VS Code's diff editor, with native
// comment threads, cell header decorations, outline/sticky scroll, folding and hovers.
import * as vscode from 'vscode';
import { mkdir, writeFile } from 'node:fs/promises';
import type { GhComment, GhThread } from './github.ts';
import { REACTIONS, reactionLabel, type ReactionContent } from './core/reactions.ts';
import type { NotebookEntry } from './session.ts';
import { parseBody, type Side } from './core/anchor.ts';
import type { ReviewDoc } from './core/reviewDoc.ts';
import type { NewComment, NewFileComment, ReviewState } from './state.ts';
import { basename } from './paths.ts';

export const SCHEME = 'nbreview';
export const RAW_SCHEME = 'nbreview-raw';

class NbComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  reactions?: vscode.CommentReaction[];
  /** The body shown before an edit started, to go back to when it is cancelled. */
  preview?: vscode.MarkdownString | string;
  constructor(
    public body: vscode.MarkdownString | string,
    public author: vscode.CommentAuthorInformation,
    public timestamp?: Date,
    public label?: string,
    /** `draft` (pending), `mine` (published, the viewer's own) or `github`; the comment menus use it. */
    public contextValue?: string,
    /** GitHub id. */
    public ghId?: string,
    public parent?: vscode.CommentThread,
    /** The saved text of the viewer's comment, to go back to when an edit is cancelled. */
    public savedText?: string,
    public pending = false,
  ) {}
}

export class TextReview implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly controller: vscode.CommentController;
  /** The comment threads shown, with the GitHub thread each one is. */
  private shown: vscode.CommentThread[] = [];
  private readonly ghIds = new WeakMap<vscode.CommentThread, string>();
  private readonly contentChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly headerDeco: vscode.TextEditorDecorationType;
  private readonly outputDeco: vscode.TextEditorDecorationType;

  constructor(
    private readonly state: ReviewState,
    private readonly ctx: vscode.ExtensionContext,
  ) {
    this.controller = vscode.comments.createCommentController('nbreview', 'Notebook Review');
    this.controller.options = {
      prompt: 'Comment on this line',
      placeHolder: 'Review comment (Markdown; ```suggestion blocks become GitHub suggestions)',
    };
    this.controller.reactionHandler = (comment, reaction) => this.react(comment as NbComment, reaction);
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => {
        if ((!this.docFor(document.uri) && !this.rawFor(document.uri)) || document.lineCount === 0) {
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
          const side = new URLSearchParams(uri.query).get('side');
          const s = this.state.session;
          if (side === 'SINCE') {
            return (s?.lastReview && (await s.contentAt(uri.path.slice(1), s.lastReview.sha))) ?? '';
          }
          return (await s?.content(uri.path.slice(1), side === 'LEFT' ? 'LEFT' : 'RIGHT')) ?? '';
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
      vscode.commands.registerCommand('nbreview.addSingleComment', (reply: vscode.CommentReply) => this.postFromReply(reply)),
      vscode.commands.registerCommand('nbreview.deleteDraft', (c: NbComment) => this.delete(c)),
      vscode.commands.registerCommand('nbreview.resolveThread', (arg: vscode.CommentThread | vscode.CommentReply) => this.resolve(arg, true)),
      vscode.commands.registerCommand('nbreview.unresolveThread', (arg: vscode.CommentThread | vscode.CommentReply) => this.resolve(arg, false)),
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
        if (e.drafts || e.threads || e.session) {
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

  /**
   * A changed ordinary file at one side of the pull request, as opened in its diff, or (`SINCE`)
   * as it was at the viewer's last review.
   */
  rawUri(path: string, side: Side | 'SINCE'): vscode.Uri {
    return vscode.Uri.from({ scheme: RAW_SCHEME, path: `/${path}`, query: `side=${side}&pr=${this.state.prKey()}` });
  }

  rawFor(uri: vscode.Uri): { path: string; side: Side } | undefined {
    if (uri.scheme !== RAW_SCHEME || !this.state.session) {
      return undefined;
    }
    const path = uri.path.slice(1);
    const side = new URLSearchParams(uri.query).get('side');
    // The version at the last review isn't part of the pull request, so it takes no comments.
    if (side === 'SINCE' || !this.state.session.others.some(o => o.file.filename === path)) {
      return undefined;
    }
    return { path, side: side === 'LEFT' ? 'LEFT' : 'RIGHT' };
  }

  async openFileDiff(path: string): Promise<void> {
    const s = this.state.session;
    if (!s) {
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', this.rawUri(path, 'LEFT'), this.rawUri(path, 'RIGHT'), `${basename(path)} (#${s.pr.number})`, {
      preview: false,
    });
  }

  /** The file as it was at the viewer's last review, against the pull request's version. */
  async openSinceReviewDiff(path: string): Promise<void> {
    const s = this.state.session;
    if (!s?.lastReview) {
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', this.rawUri(path, 'SINCE'), this.rawUri(path, 'RIGHT'), `${basename(path)} (since your review, #${s.pr.number})`, {
      preview: false,
    });
  }

  // --- Comment threads ------------------------------------------------------------------------

  private renderThreads(): void {
    for (const t of this.shown) {
      t.dispose();
    }
    this.shown = [];
    const s = this.state.session;
    if (!s) {
      return;
    }
    for (const p of s.placed) {
      this.showThread(p.gh, this.reviewUri(p.nbPath, p.side), p.startDocLine ?? p.docLine, p.docLine, p);
    }
    for (const list of s.fileThreads.values()) {
      for (const f of list) {
        this.showThread(f.gh, this.rawUri(f.path, f.side), f.startDocLine ?? f.docLine, f.docLine, f);
      }
    }
  }

  private showThread(gh: GhThread, uri: vscode.Uri, start: number, end: number, where: { note?: string; movedFrom?: string }): void {
    const thread = this.controller.createCommentThread(uri, new vscode.Range(start, 0, end, 0), []);
    thread.comments = gh.comments.map(c => (c.pending ? this.draftComment(c, thread) : this.ghComment(c, thread)));
    // A thread of only pending comments is the reviewer's own, not yet on the pull request.
    const ownPending = gh.comments.every(c => c.pending);
    thread.label = ownPending ? this.state.describe(gh) : threadLabel(gh, where);
    // The thread menus look for `canResolve` and `canUnresolve` in this.
    thread.contextValue = [
      ownPending ? 'draft' : 'github',
      !ownPending && gh.viewerCanResolve ? 'canResolve' : '',
      !ownPending && gh.viewerCanUnresolve ? 'canUnresolve' : '',
    ].filter(Boolean).join(' ');
    thread.canReply = true;
    thread.state = gh.isResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    thread.collapsibleState = !ownPending && (gh.isResolved || gh.isOutdated)
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
    this.shown.push(thread);
    this.ghIds.set(thread, gh.id);
  }

  private draftComment(c: GhComment, parent: vscode.CommentThread): NbComment {
    const { text } = parseBody(c.body);
    return new NbComment(new vscode.MarkdownString(text), { name: 'You' }, new Date(c.createdAt), 'Pending', 'draft', c.id, parent, text, true);
  }

  private ghComment(c: GhComment, parent: vscode.CommentThread): NbComment {
    const { text } = parseBody(c.body);
    const md = new vscode.MarkdownString(`${text}\n\n[View on GitHub](${c.url})`);
    md.supportHtml = true;
    const comment = new NbComment(
      md,
      { name: c.author, iconPath: c.avatarUrl ? vscode.Uri.parse(c.avatarUrl) : undefined },
      new Date(c.createdAt),
      undefined,
      c.viewerCanUpdate ? 'mine' : 'github',
      c.id,
      parent,
      text,
    );
    // Every reaction is listed, so VS Code's picker offers them all; those with no count aren't shown.
    comment.reactions = (Object.keys(REACTIONS) as ReactionContent[]).map(content => {
      const r = c.reactions.find(x => x.content === content);
      return {
        label: reactionLabel(content),
        iconPath: vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'reactions', `${content}.svg`),
        count: r?.count ?? 0,
        authorHasReacted: r?.viewerHasReacted ?? false,
      };
    });
    return comment;
  }

  private async react(comment: NbComment, reaction: vscode.CommentReaction): Promise<void> {
    const content = (Object.keys(REACTIONS) as ReactionContent[]).find(c => reactionLabel(c) === reaction.label);
    if (comment.ghId && content) {
      await this.withGitHub('Reacting', () => this.state.react(comment.ghId!, content, !reaction.authorHasReacted));
    }
  }

  private async resolve(arg: vscode.CommentThread | vscode.CommentReply, resolved: boolean): Promise<void> {
    const id = this.ghIds.get('thread' in arg ? arg.thread : arg);
    if (id) {
      await this.withGitHub(resolved ? 'Resolving the conversation' : 'Unresolving the conversation', () => this.state.setResolved(id, resolved));
    }
  }

  /** Deletes the viewer's comment; a published one only after they confirm. */
  private async delete(comment: NbComment): Promise<void> {
    if (!comment.ghId) {
      return;
    }
    if (!comment.pending) {
      const choice = await vscode.window.showWarningMessage('Delete this comment from the pull request on GitHub?', { modal: true }, 'Delete');
      if (!choice) {
        return;
      }
    }
    await this.withGitHub('Deleting the comment', () => this.state.deleteComment(comment.ghId!));
  }

  /** Runs a GitHub change with progress in the status bar; failures are shown, and reported as false. */
  private async withGitHub(what: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `${what}…` }, fn);
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  private commentFromReply(reply: vscode.CommentReply): NewComment | NewFileComment | undefined {
    if (!reply.text.trim()) {
      return undefined;
    }
    const replyTo = this.ghIds.get(reply.thread);
    const range = reply.thread.range ?? lineRange(0);
    const raw = this.rawFor(reply.thread.uri);
    if (raw) {
      return { ...raw, startLine: range.start.line + 1, endLine: range.end.line + 1, text: reply.text, replyTo };
    }
    const target = this.docFor(reply.thread.uri);
    if (!target) {
      return undefined;
    }
    return {
      nbPath: target.entry.path,
      side: target.side,
      startDocLine: range.start.line,
      endDocLine: range.end.line,
      text: reply.text,
      replyTo,
    };
  }

  /** "Add Review Comment": adds to the pending review on GitHub. */
  private async addFromReply(reply: vscode.CommentReply): Promise<void> {
    const comment = this.commentFromReply(reply);
    if (comment && (await this.withGitHub('Adding to your review', () => this.state.addDraft(comment))) && !comment.replyTo) {
      // The comment comes back from GitHub as a pending thread; the one it was typed in goes.
      reply.thread.dispose();
    }
  }

  /** "Add Single Comment": posts to GitHub now, outside the review. */
  private async postFromReply(reply: vscode.CommentReply): Promise<void> {
    const comment = this.commentFromReply(reply);
    if (comment && (await this.withGitHub('Posting the comment', () => this.state.postSingle(comment))) && !comment.replyTo) {
      reply.thread.dispose();
    }
  }

  private setEditing(comment: NbComment, editing: boolean): void {
    const thread = comment.parent;
    if (!thread) {
      return;
    }
    if (editing) {
      // The text alone: a published comment's body also has its "View on GitHub" link.
      comment.preview = comment.body;
      comment.body = comment.savedText ?? '';
    } else {
      comment.body = comment.preview ?? new vscode.MarkdownString(comment.savedText ?? '');
    }
    comment.mode = editing ? vscode.CommentMode.Editing : vscode.CommentMode.Preview;
    thread.comments = [...thread.comments];
  }

  private async saveEdit(comment: NbComment): Promise<void> {
    if (!comment.ghId) {
      return;
    }
    const text = typeof comment.body === 'string' ? comment.body : comment.body.value;
    if (await this.withGitHub('Saving the comment', () => this.state.editComment(comment.ghId!, text))) {
      return; // redrawn from GitHub
    }
    // Keep the edit open with the text so nothing is lost.
    comment.mode = vscode.CommentMode.Editing;
    if (comment.parent) {
      comment.parent.comments = [...comment.parent.comments];
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

function threadLabel(gh: GhThread, where: { note?: string; movedFrom?: string }): string {
  const bits = [gh.isResolved ? 'Resolved' : 'GitHub'];
  if (where.movedFrom) {
    bits.push(`from ${where.movedFrom}`);
  }
  if (where.note) {
    bits.push(where.note);
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
