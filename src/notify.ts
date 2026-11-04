// Error notifications. A failure on GitHub's side gets a button that opens GitHub's status page,
// because the only fix is to wait until GitHub works again.
import * as vscode from 'vscode';
import { GitHubDownError } from './github.ts';

const STATUS_PAGE = 'https://www.githubstatus.com';
const CHECK_STATUS = 'Check GitHub Status';

/** Shows an error notification. `message` replaces the error's own text when given. */
export function showError(e: unknown, message?: string): void {
  const text = message ?? `Notebook Review: ${e instanceof Error ? e.message : String(e)}`;
  if (!(e instanceof GitHubDownError)) {
    void vscode.window.showErrorMessage(text);
    return;
  }
  void vscode.window.showErrorMessage(text, CHECK_STATUS).then(picked => {
    if (picked === CHECK_STATUS) {
      void vscode.env.openExternal(vscode.Uri.parse(STATUS_PAGE));
    }
  });
}

/** Shows the notification only for a failure on GitHub's side (pages show other errors in place). */
export function showIfGitHubDown(e: unknown): void {
  if (e instanceof GitHubDownError) {
    showError(e);
  }
}
