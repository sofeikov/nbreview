// The review in progress: the loaded pull request, pending comments and viewed flags. Both the
// text diff and the visual review read from here and react to its change events, so a comment
// made in one view shows up in the other.
import * as vscode from 'vscode';
import type { ReviewSession, NotebookEntry } from './session.ts';
import { planComment, type GhThreadTarget, type Side } from './core/anchor.ts';
import type { ReviewDoc } from './core/reviewDoc.ts';

export interface Draft {
  key: string;
  nbPath: string;
  side: Side;
  startDocLine: number;
  endDocLine: number;
  text: string;
  /** GitHub thread id when this draft is a reply. */
  replyTo?: string;
}

/** Which view caused a change, so it can skip redrawing what it already shows. */
export type Origin = 'text' | 'visual' | 'system';

export interface ChangeEvent {
  session?: boolean;
  drafts?: boolean;
  threads?: boolean;
  viewed?: boolean;
  origin: Origin;
}

export class ReviewState {
  session?: ReviewSession;
  /** Settles once the PR that was open before a reload has been loaded again (or failed to). */
  restoring: Promise<unknown> = Promise.resolve();
  private readonly changed = new vscode.EventEmitter<ChangeEvent>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  setSession(session: ReviewSession | undefined): void {
    this.session = session;
    this.changed.fire({ session: true, drafts: true, threads: true, viewed: true, origin: 'system' });
  }

  prKey(): string {
    const pr = this.session?.pr;
    return pr ? `${pr.owner}/${pr.repo}/${pr.number}` : '';
  }

  entry(nbPath: string): NotebookEntry | undefined {
    return this.session?.notebooks.get(nbPath);
  }

  doc(nbPath: string, side: Side): ReviewDoc | undefined {
    const entry = this.entry(nbPath);
    return entry && (side === 'LEFT' ? entry.base : entry.head);
  }

  // --- Pending comments -------------------------------------------------------------------

  drafts(): Draft[] {
    return this.ctx.globalState.get<Draft[]>(`drafts:${this.prKey()}`, []);
  }

  draftsFor(nbPath: string): Draft[] {
    return this.drafts().filter(d => d.nbPath === nbPath);
  }

  private async save(list: Draft[], origin: Origin): Promise<void> {
    await this.ctx.globalState.update(`drafts:${this.prKey()}`, list);
    this.changed.fire({ drafts: true, origin });
  }

  async addDraft(draft: Omit<Draft, 'key'>, origin: Origin): Promise<Draft> {
    const d: Draft = { key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...draft };
    await this.save([...this.drafts(), d], origin);
    return d;
  }

  async updateDraft(key: string, text: string, origin: Origin): Promise<void> {
    await this.save(this.drafts().map(d => (d.key === key ? { ...d, text } : d)), origin);
  }

  async removeDraft(key: string, origin: Origin): Promise<void> {
    await this.save(this.drafts().filter(d => d.key !== key), origin);
  }

  /** Where a pending comment will land on GitHub. */
  plan(d: Pick<Draft, 'nbPath' | 'side' | 'startDocLine' | 'endDocLine' | 'text'>): GhThreadTarget | undefined {
    const entry = this.entry(d.nbPath);
    if (!entry) {
      return undefined;
    }
    return planComment({
      doc: d.side === 'LEFT' ? entry.base : entry.head,
      path: d.nbPath,
      side: d.side,
      startDocLine: d.startDocLine,
      endDocLine: d.endDocLine,
      commentable: entry.commentable,
      text: d.text,
    });
  }

  describe(d: Draft): string {
    return d.replyTo ? 'Pending reply' : `Pending · ${this.plan(d)?.describe ?? 'comment'}`;
  }

  // --- GitHub threads and viewed state ----------------------------------------------------

  async reloadThreads(): Promise<void> {
    if (!this.session) {
      return;
    }
    await this.session.loadThreads();
    this.changed.fire({ threads: true, origin: 'system' });
  }

  isViewed(path: string): boolean {
    return this.session?.viewed.get(path) ?? false;
  }

  /** Marks files viewed on GitHub. Marking a notebook also marks the modules nbdev generated from it. */
  async setViewed(paths: string[], viewed: boolean): Promise<void> {
    const s = this.session;
    if (!s) {
      return;
    }
    const all = new Set(paths);
    if (vscode.workspace.getConfiguration('nbreview').get<boolean>('markGeneratedFilesViewed', true)) {
      for (const p of paths) {
        for (const generated of s.generatedFrom(p)) {
          all.add(generated);
        }
      }
    }
    const previous = new Map([...all].map(p => [p, s.viewed.get(p) ?? false]));
    for (const p of all) {
      s.viewed.set(p, viewed);
    }
    this.changed.fire({ viewed: true, origin: 'system' });
    try {
      await Promise.all([...all].map(p => s.gh.setViewed(s.pr.nodeId, p, viewed)));
    } catch (e) {
      for (const [p, v] of previous) {
        s.viewed.set(p, v);
      }
      this.changed.fire({ viewed: true, origin: 'system' });
      throw e;
    }
  }
}
