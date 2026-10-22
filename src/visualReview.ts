// The visual review: one webview panel per notebook showing rendered cells, outputs and the same
// comment threads as the text diff.
import * as vscode from 'vscode';
import type { ReviewState } from './state.ts';
import type { TextReview } from './textReview.ts';
import { buildThreads, buildViewModel } from './viewModel.ts';
import { docLinesForAnchor, headerLine } from './core/reviewDoc.ts';
import type { HostMessage, WebviewMessage } from './webview/protocol.ts';
import { basename } from './paths.ts';

export class VisualReview implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly state: ReviewState,
    private readonly text: TextReview,
    private readonly ctx: vscode.ExtensionContext,
  ) {
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer('nbreview.visual', {
        deserializeWebviewPanel: (panel, saved) => this.restore(panel, saved),
      }),
      state.onDidChange(e => {
        for (const [path, panel] of this.panels) {
          if (e.session) {
            if (!state.entry(path)) {
              panel.dispose();
              continue;
            }
            this.post(panel, this.modelMessage(path));
          }
          if (e.session || e.drafts || e.threads) {
            this.post(panel, this.threadsMessage(path));
          }
          this.post(panel, this.stateMessage(path));
        }
      }),
    );
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    vscode.Disposable.from(...this.disposables).dispose();
  }

  open(nbPath: string, revealCellId?: string): void {
    const existing = this.panels.get(nbPath);
    if (existing) {
      existing.reveal();
      if (revealCellId) {
        this.post(existing, { type: 'reveal', cellKey: revealCellId });
      }
      return;
    }
    if (!this.state.session || !this.state.entry(nbPath)) {
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'nbreview.visual',
      '',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.dist()], enableFindWidget: true },
    );
    this.adopt(panel, nbPath, revealCellId);
  }

  /** Brings back review tabs that were open when VS Code was reloaded. */
  private async restore(panel: vscode.WebviewPanel, saved: unknown): Promise<void> {
    await this.state.restoring;
    const nbPath = (saved as { path?: string } | undefined)?.path;
    if (nbPath && this.state.entry(nbPath) && !this.panels.has(nbPath)) {
      panel.webview.options = { enableScripts: true, localResourceRoots: [this.dist()] };
      this.adopt(panel, nbPath);
    } else {
      panel.dispose();
    }
  }

  private dist(): vscode.Uri {
    return vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
  }

  private adopt(panel: vscode.WebviewPanel, nbPath: string, revealCellId?: string): void {
    panel.title = `📓 ${basename(nbPath)} · #${this.state.session!.pr.number}`;
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(panel.webview, this.dist(), nbPath);
    this.panels.set(nbPath, panel);
    let pendingReveal = revealCellId;
    panel.onDidDispose(() => this.panels.delete(nbPath));
    panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this.handle(nbPath, panel, msg).catch(e => {
        this.post(panel, { type: 'error', message: e instanceof Error ? e.message : String(e) });
      });
      if (msg.type === 'ready' && pendingReveal) {
        this.post(panel, { type: 'reveal', cellKey: pendingReveal });
        pendingReveal = undefined;
      }
    });
  }

  private async handle(nbPath: string, panel: vscode.WebviewPanel, msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post(panel, this.modelMessage(nbPath));
        this.post(panel, this.threadsMessage(nbPath));
        this.post(panel, this.stateMessage(nbPath));
        return;
      case 'plan': {
        const doc = this.state.doc(nbPath, msg.anchor.side);
        const lines = doc && docLinesForAnchor(doc, msg.anchor);
        const plan = lines && this.state.plan({ nbPath, side: msg.anchor.side, startDocLine: lines.start, endDocLine: lines.end, text: '' });
        this.post(panel, { type: 'plan', requestId: msg.requestId, describe: plan ? `Will post as a ${plan.describe}` : '' });
        return;
      }
      case 'addComment': {
        const doc = this.state.doc(nbPath, msg.anchor.side);
        const lines = doc && docLinesForAnchor(doc, msg.anchor);
        if (!lines) {
          throw new Error('That cell is no longer in the notebook.');
        }
        await this.state.addDraft(
          { nbPath, side: msg.anchor.side, startDocLine: lines.start, endDocLine: lines.end, text: msg.text },
          'visual',
        );
        return;
      }
      case 'reply': {
        const placed = this.state.session?.placed.find(p => p.gh.id === msg.threadId);
        if (!placed) {
          throw new Error('That thread is no longer on the pull request.');
        }
        await this.state.addDraft(
          { nbPath: placed.nbPath, side: placed.side, startDocLine: placed.docLine, endDocLine: placed.docLine, text: msg.text, replyTo: msg.threadId },
          'visual',
        );
        return;
      }
      case 'editDraft':
        await this.state.updateDraft(msg.key, msg.text, 'visual');
        return;
      case 'deleteDraft':
        await this.state.removeDraft(msg.key, 'visual');
        return;
      case 'submitReview':
        try {
          const url = await vscode.commands.executeCommand<string>('nbreview.submitReview', { event: msg.event, body: msg.body });
          this.post(panel, { type: 'submitted', ok: true, url });
        } catch (e) {
          this.post(panel, { type: 'submitted', ok: false, message: e instanceof Error ? e.message : String(e) });
        }
        return;
      case 'setViewed':
        await this.state.setViewed([nbPath], msg.viewed);
        return;
      case 'openTextDiff': {
        const doc = this.state.doc(nbPath, 'RIGHT');
        const line = msg.cellId && doc ? headerLine(doc, msg.cellId) : undefined;
        await this.text.openDiff(nbPath, line === undefined ? undefined : { side: 'RIGHT', docLine: line });
        return;
      }
      case 'openExternal':
        if (/^https:\/\//.test(msg.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        return;
    }
  }

  private modelMessage(nbPath: string): HostMessage {
    const s = this.state.session!;
    return { type: 'model', model: buildViewModel(this.state.entry(nbPath)!, { number: s.pr.number, title: s.pr.title, url: s.pr.url }) };
  }

  private threadsMessage(nbPath: string): HostMessage {
    const s = this.state.session;
    const entry = this.state.entry(nbPath);
    if (!s || !entry) {
      return { type: 'threads', threads: [] };
    }
    return {
      type: 'threads',
      threads: buildThreads(entry, s.threadsFor(nbPath), this.state.draftsFor(nbPath), d => this.state.describe(d)),
    };
  }

  private stateMessage(nbPath: string): HostMessage {
    return { type: 'state', state: { viewed: this.state.isViewed(nbPath), pending: this.state.drafts().length } };
  }

  private post(panel: vscode.WebviewPanel, msg: HostMessage): void {
    void panel.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview, dist: vscode.Uri, nbPath: string): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...p)).toString();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('katex', 'katex.min.css')}">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('webview.css')}">
</head>
<body data-path="${escapeAttr(nbPath)}">
<div id="app"><div class="loading">Loading notebook…</div></div>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
  }
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
