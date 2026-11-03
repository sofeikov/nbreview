// Messages and data shared by the extension host and the pull request Overview page.
import type { ReactionVM } from './protocol.ts';
import type { ChecksSummary, CheckState, Reviewer, StatusLine } from '../core/prStatus.ts';

export interface UserVM {
  login: string;
  avatarUrl?: string;
}

export interface OverviewVM {
  pr: {
    number: number;
    repo: string;
    title: string;
    url: string;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    isDraft: boolean;
    author: UserVM;
    createdAt: string;
    mergedAt?: string;
    mergedBy?: string;
    closedAt?: string;
    baseRef: string;
    /** `owner:branch` when the branch is in a fork. */
    headRef: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    commits: number;
  };
  viewer: string;
  bodyHtml: string;
  bodyReactions: ReactionVM[];
  verdict: StatusLine;
  reviews: StatusLine & { reviewers: Reviewer[] };
  checks: ChecksSummary & { list: CheckVM[] };
  branch: StatusLine;
  assignees: UserVM[];
  labels: { name: string; background: string; foreground: string }[];
  milestone?: string;
  closingIssues: { number: number; title: string; url: string; state: 'OPEN' | 'CLOSED' }[];
  timeline: TimelineVM[];
  timelineMissing: number;
  /** ISO time the data was fetched from GitHub. */
  fetchedAt: string;
}

export interface CheckVM {
  name: string;
  workflow?: string;
  state: CheckState;
  description?: string;
  url?: string;
  required: boolean;
  /** For example "1m 12s", for finished checks. */
  duration?: string;
}

export interface OvCommentVM {
  id: string;
  author: UserVM;
  /** The pull request's author, marked as on github.com. */
  isAuthor: boolean;
  createdAt: string;
  html: string;
  url?: string;
  reactions: ReactionVM[];
}

export interface SnippetVM {
  /** 1-based line numbers, or none for notebook outputs. */
  lines: { number?: number; html: string; marked: boolean }[];
  /** For example "cell 4" or "L12–14". */
  where: string;
}

export interface OvThreadVM {
  id: string;
  path: string;
  resolved: boolean;
  outdated: boolean;
  snippet?: SnippetVM;
  /** Where the page can open it: a changed file and, in a notebook, the cell. */
  open?: { path: string; cellKey?: string };
  comments: OvCommentVM[];
}

export type TimelineVM =
  | ({ kind: 'comment' } & OvCommentVM)
  | {
    kind: 'review';
    id: string;
    author: UserVM;
    isAuthor: boolean;
    state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
    createdAt: string;
    html: string;
    url: string;
    reactions: ReactionVM[];
    threads: OvThreadVM[];
    /** Comments of this review on threads started elsewhere (replies), or on files not shown. */
    otherComments: number;
  }
  | { kind: 'commits'; id: string; createdAt: string; commits: { oid: string; message: string; author: UserVM; createdAt: string; url: string }[] }
  | { kind: 'event'; id: string; icon: string; actor: UserVM; createdAt: string; text: string; tone?: 'merged' | 'danger' | 'success' };

/** The reviewer's own progress, from the extension's state rather than GitHub's page. */
export interface ProgressVM {
  files: number;
  viewed: number;
  pending: number;
  pendingReview: boolean;
  unresolved: number;
  /** The next file not marked viewed, in the Review panel's order. */
  nextFile?: string;
}

export type OverviewHostMessage =
  | { type: 'overview'; overview: OverviewVM }
  | { type: 'progress'; progress: ProgressVM }
  | { type: 'loading'; loading: boolean }
  | { type: 'error'; message: string };

export type OverviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openFile'; path: string; cellKey?: string }
  | { type: 'nextFile' }
  | { type: 'submitReview' }
  | { type: 'openExternal'; url: string };
