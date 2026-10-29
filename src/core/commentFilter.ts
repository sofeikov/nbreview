// Which comment threads are shown: all of them, only the unresolved ones, or none. The choice is
// shared by the review page, the text diff and the Review panel's counts.

export type CommentFilter = 'all' | 'unresolved' | 'none';

export const COMMENT_FILTERS: readonly CommentFilter[] = ['all', 'unresolved', 'none'];

export function isCommentFilter(value: unknown): value is CommentFilter {
  return COMMENT_FILTERS.includes(value as CommentFilter);
}

/**
 * Whether a thread is shown. A thread with one of the viewer's pending comments is always shown,
 * so a comment just written never disappears and nothing pending is forgotten before submitting.
 */
export function showsThread(filter: CommentFilter, thread: { isResolved: boolean; comments: { pending: boolean }[] }): boolean {
  if (filter === 'all' || thread.comments.some(c => c.pending)) {
    return true;
  }
  return filter === 'unresolved' && !thread.isResolved;
}
