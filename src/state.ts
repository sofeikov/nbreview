// The review in progress: the loaded pull request, pending comments and viewed flags. Both the
// text diff and the visual review read from here and react to its change events, so a comment
// made in one view shows up in the other.
//
// Pending comments live in the viewer's pending review on GitHub (as on github.com), not on this
// computer: they survive restarts and other machines, and github.com can add to or submit the
// same review.
import * as vscode from 'vscode';
import type { ReviewSession, NotebookEntry } from './session.ts';
import { parseBody, planComment, replaceBodyText, type GhThreadTarget, type Side } from './core/anchor.ts';
import { planFileComment } from './core/fileComments.ts';
import type { GhThread } from './github.ts';
import type { ReviewDoc } from './core/reviewDoc.ts';

/** A comment in the pending review, where it sits in the review documents. */
export interface Draft {
  /** GitHub id of the pending comment. */
  key: string;
  nbPath: string;
  side: Side;
  startDocLine: number;
  endDocLine: number;
  /** The reviewer's text, without the cell header and marker. */
  text: string;
  /** Thread id when this comment is a reply rather than the start of a thread. */
  replyTo?: string;
}

/** A new comment on a notebook. */
export type NewComment = Omit<Draft, 'key'>;

/** A new comment on an ordinary file, on 1-based lines of one side of its diff. */
export interface NewFileComment {
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  text: string;
  /** Thread id when this is a reply. */
  replyTo?: string;
}

function isFileComment(c: NewComment | NewFileComment): c is NewFileComment {
  return 'path' in c;
}

export interface ChangeEvent {
  session?: boolean;
  drafts?: boolean;
  threads?: boolean;
  viewed?: boolean;
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
    this.changed.fire({ session: true, drafts: true, threads: true, viewed: true });
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

  /** Pending comments on notebooks, from the pending review on GitHub. */
  drafts(): Draft[] {
    const out: Draft[] = [];
    for (const p of this.session?.placed ?? []) {
      p.gh.comments.forEach((c, i) => {
        if (c.pending) {
          out.push({
            key: c.id,
            nbPath: p.nbPath,
            side: p.side,
            startDocLine: p.startDocLine ?? p.docLine,
            endDocLine: p.docLine,
            text: parseBody(c.body).text,
            replyTo: i > 0 ? p.gh.id : undefined,
          });
        }
      });
    }
    return out;
  }

  draftsFor(nbPath: string): Draft[] {
    return this.drafts().filter(d => d.nbPath === nbPath);
  }

  /** Comments in the pending review, on any file. */
  pendingCount(): number {
    return this.session?.pendingCount ?? 0;
  }

  /** Whether the viewer has a pending review, which GitHub doesn't allow single comments next to. */
  hasPendingReview(): boolean {
    return !!this.session?.pendingReviewId;
  }

  /** Adds a comment or reply to the pending review on GitHub, starting the review if needed. */
  async addDraft(d: NewComment | NewFileComment): Promise<void> {
    const s = this.requireSession();
    const reviewId = s.pendingReviewId ?? (s.pendingReviewId = await s.gh.startPendingReview(s.pr));
    if (d.replyTo) {
      await s.gh.addPendingReply(reviewId, d.replyTo, d.text);
    } else {
      await s.gh.addPendingThread(reviewId, this.target(d));
    }
    await this.reloadThreads();
  }

  async updateDraft(key: string, text: string): Promise<void> {
    const s = this.requireSession();
    const thread = s.allThreads().find(t => t.comments.some(c => c.id === key));
    const comment = thread?.comments.find(c => c.id === key);
    if (!thread || !comment) {
      throw new Error('That pending comment is no longer on GitHub.');
    }
    // The first comment of a notebook thread carries the cell header; suggestions are re-encoded.
    let body = text;
    const placed = s.placed.find(p => p.gh.id === thread.id);
    if (placed && thread.comments[0] === comment) {
      const d = this.drafts().find(x => x.key === key);
      body = (d && this.plan({ ...d, text })?.body) ?? replaceBodyText(comment.body, text);
    }
    await s.gh.updatePendingComment(key, body);
    await this.reloadThreads();
  }

  /** Deletes a pending comment; deleting the last one also discards the then empty review. */
  async removeDraft(key: string): Promise<void> {
    const s = this.requireSession();
    await s.gh.deletePendingComment(key);
    await this.reloadThreads();
    if (s.pendingReviewId && s.pendingCount === 0) {
      await this.discardReview();
    }
  }

  /** Discards the pending review and all its comments. */
  async discardReview(): Promise<void> {
    const s = this.requireSession();
    if (s.pendingReviewId) {
      await s.gh.deleteReview(s.pendingReviewId);
    }
    await this.reloadThreads();
  }

  /** Where a comment will land on GitHub. */
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

  /** Where a new comment lands on GitHub, with its body. */
  private target(d: NewComment | NewFileComment): GhThreadTarget {
    const s = this.requireSession();
    if (isFileComment(d)) {
      return planFileComment({ ...d, commentable: s.commentable(d.path) });
    }
    const plan = this.plan(d);
    if (!plan) {
      throw new Error('That notebook is no longer in the pull request.');
    }
    return plan;
  }

  /**
   * Posts a comment or a reply to GitHub straight away, outside any review, then reloads the
   * threads so it shows like any other GitHub comment.
   */
  async postSingle(d: NewComment | NewFileComment): Promise<void> {
    const s = this.requireSession();
    if (s.pendingReviewId) {
      throw new Error('You have a pending review. Submit or discard it to post single comments, as on GitHub.');
    }
    if (d.replyTo) {
      const thread = s.allThreads().find(t => t.id === d.replyTo);
      const first = thread?.comments.find(c => c.databaseId !== undefined && !c.pending);
      if (!first?.databaseId) {
        throw new Error('That thread is no longer on the pull request.');
      }
      await s.gh.postSingleReply(s.pr, first.databaseId, d.text);
    } else {
      await s.gh.postSingleComment(s.pr, this.target(d));
    }
    await this.reloadThreads();
  }

  /** The label of a thread made of pending comments: where it is on GitHub. */
  describe(t: GhThread): string {
    if (t.comments.some(c => !c.pending)) {
      return 'Pending reply';
    }
    if (t.subjectType === 'FILE') {
      return `Pending · file comment on ${t.path}`;
    }
    const lines = t.startLine && t.startLine !== t.line ? `L${t.startLine}-${t.line}` : `L${t.line ?? t.originalLine}`;
    return `Pending · line comment → ${t.path} ${lines}`;
  }

  private requireSession(): ReviewSession {
    if (!this.session) {
      throw new Error('No pull request is open.');
    }
    return this.session;
  }

  // --- GitHub threads and viewed state ----------------------------------------------------

  async reloadThreads(): Promise<void> {
    if (!this.session) {
      return;
    }
    await this.session.loadThreads();
    this.changed.fire({ threads: true, drafts: true });
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
    if (vscode.workspace.getConfiguration('nbreview').get<boolean>('markGeneratedFilesViewed', false)) {
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
    this.changed.fire({ viewed: true });
    try {
      await Promise.all([...all].map(p => s.gh.setViewed(s.pr.nodeId, p, viewed)));
    } catch (e) {
      for (const [p, v] of previous) {
        s.viewed.set(p, v);
      }
      this.changed.fire({ viewed: true });
      throw e;
    }
  }
}
