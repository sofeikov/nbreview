# Notes for coding agents

Notebook Review (`KonstantinSofeikov.nbreview`) is a VS Code extension for reviewing the Jupyter notebooks, and every other file, in a GitHub pull request. Comments made in it are ordinary GitHub review comments. README.md is the user documentation; this file explains how the code is put together, how to test it, and how changes ship.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | esbuild bundles `src/extension.ts` into `dist/extension.js` and `src/webview/main.ts` into `dist/webview.js`, then copies the CSS and the KaTeX woff2 fonts. Minified, with no source maps. |
| `npm run typecheck` | `tsc` over `src`, `test` and `scripts`. Nothing is emitted. |
| `npm test` | esbuild bundles each `test/*.test.ts` into `out/test/` and runs them with `node --test`. Node can't run the `.ts` sources directly. |
| `npm run smoke` | The pre-release check of the packaged extension in a real VS Code. See [Testing](#testing). |
| `npm run package` | Builds `nbreview.vsix`. `.vscodeignore` excludes everything by default and lists only what ships. |
| `npm run bench -- …` | Compares the speed of a git ref with the working tree, with a 95% bootstrap confidence interval. Use it before claiming a speed-up. |
| `npm run demo` | Writes `out/demo/index.html`, the review page for `docs/demo/` outside VS Code. The README screenshots come from it. |

## How it fits together

- **The core is in `src/core/`.** It is pure TypeScript with no VS Code API, and it is unit-tested in `test/core.test.ts`.
  - `notebook.ts` parses a notebook and records the raw JSON line of every source line. GitHub anchors comments to lines of the raw `.ipynb` file.
  - `reviewDoc.ts` builds the text form of a notebook used by the text diff.
  - `cellDiff.ts` matches cells (by id, then by content with an LCS) and diffs lines.
  - `patch.ts` works out which lines GitHub accepts comments on, from the patch.
  - `anchor.ts` decides where a notebook comment lands. A line comment is used when the line is in the diff; otherwise it becomes a file comment. It also handles the hidden marker `<!-- nbreview:{…} -->` that puts a thread back on its cell, suggestions re-encoded as notebook JSON lines, and the optional nbdev mapping.
  - `fileComments.ts` does the same for ordinary files.
- **`src/github.ts`** is a small GitHub client. GraphQL handles threads, the viewer's pending review, viewed flags and PR search. REST handles files, contents and single comments.
- **`src/session.ts`** holds everything known about the open PR. It has no VS Code API.
- **`src/state.ts`** (`ReviewState`) is the review in progress. Both views listen to its change events.
- **The views:**
  - `textReview.ts` is the text diff. VS Code's Comments API doesn't work inside notebook cells, so notebooks are shown as a virtual document (scheme `nbreview:`) in the diff editor. Other files use `nbreview-raw:`.
  - `visualReview.ts` and `src/webview/` are the rendered review page: a webview with a CSP nonce, `retainContextWhenHidden`, and a panel serializer. The page's codicons are built into the page script from `src/webview/icons.json`.
  - `viewModel.ts` builds the page's data, and `mdDiff.ts` does the word-level diff of Markdown cells.
- **The side panels:**
  - `tree.ts` is the Review panel, with Viewed checkboxes and a tree or list layout.
  - `prList.ts` is the Pull Requests panel, with the PR picker and badges.
- **`src/extension.ts`** wires everything up: commands, context keys and the status bar. The token comes from `gh auth token` first, then from VS Code's GitHub sign-in.

## Decisions to keep

- **Pending comments live on GitHub, in the viewer's pending review,** as on github.com. Nothing is kept locally. "Add single comment" posts at once and is hidden while a review is pending.
- **Commands must not write settings.** Right after an in-place update with Restart Extensions, VS Code runs the new code before it has registered the new settings, so writing one fails with "not a registered configuration". This shipped in 0.8.1. Keep UI choices in `globalState`, and treat settings as defaults that are only read (see `fileLayout` in `tree.ts`).
- **The extension is generic, not nbdev-first.** The nbdev mapping (`# %% path.ipynb #cellid` in the generated `.py`) is a passive extra. Generated files are listed and commented on like any other file.
- **Only Python notebooks get syntax highlighting.** Don't add other kernels' languages.
- **Keep the package and start-up small.** Bundle, minify, emit no source maps, and ship only the woff2 fonts. Load `viewModel.ts` lazily. Measure with `npm run bench` before and after any change made for speed.

## Testing

**Unit tests** cover the core and the view model. Add one for every pure function you write.

**The smoke test (`npm run smoke`) must pass before a release.**
- It packages the working tree and the previous release, both built from git.
- It downloads VS Code into `.vscode-test/` and runs two cases. **A** is a fresh install. **B** is an update in place: the old version is running, the new one is installed over it, and the driver clicks the real **Restart Extensions** button through the DevTools protocol. That button has no command id.
- The helper extension `scripts/smoke/runner/` checks that every contributed command is registered, and every command must be listed in `RUN` or `SKIP` in `scripts/smoke.mjs`. It writes every setting (case A only) and runs the commands that work without a PR.
- The driver fails on errors from those commands, on Notebook Review error notifications or dialogs, and on errors in the extension host log.
- On Linux it runs on a virtual display (Xvfb, already installed), so no window opens. `--visible` shows the windows, `--keep` keeps the profiles and a screenshot of any failure, and `--from REV` picks the version to update from.

**Check every feature in the packaged `.vsix`, not only in an `--extensionDevelopmentPath` window.** A development window loads the manifest fresh and hides update-time bugs. Try the feature after a fresh install and after an update in place. When you report, say which of these you actually tried.

**Driving a test VS Code by hand** (for screenshots, or for flows that need a PR):
- Launch it with `--user-data-dir` and `--extensions-dir` in a scratch folder, `--remote-debugging-port`, and `--password-store=basic`.
- Run it on Xvfb (`DISPLAY=:N`, `WAYLAND_DISPLAY` unset, `--ozone-platform=x11`), not on the user's screen: they are working on the same desktop.
- Put a time limit on every DevTools call. A crashed window never answers.
- Close the window from inside it (Command Palette → Close Window), then check that the debug port has gone.
- Never `pkill -f <pattern>`: the pattern is also in your own shell's command line. Kill exact PIDs only.

**End-to-end tests against real pull requests:**
- Pending-review traces (start, comment, discard) are fine.
- Don't post visible comments or reviews on someone else's PR without the maintainer's permission.
- Data from private repositories goes in `test/fixtures/private/`, which is git-ignored. Never commit it, and never put screenshots of private code in this public repo.

**What can't be tested here:** what happens when the author pushes new commits while a pending review is open.

## Conventions

- **Code style:** TypeScript, 2-space indent, single quotes, braces on every `if`.
- **Comments:**
  - Every module opens with a comment saying what it is.
  - Other comments explain why, in plain sentences. Match the comment density of the code around them.
- **README.md** is the Marketplace page. Write it for users, with search-friendly wording: Jupyter notebook, code review, GitHub pull request, VS Code.
  - The changelog is at the end of the README, one `### x.y.z` per version.
  - Every user-visible change bumps `version` in `package.json` (a patch for fixes, a minor for features) and adds a changelog entry.
  - Update the Settings table when a setting is added or changed.
- **Commits:** a one-line summary, then a body saying what changed and why. Only the maintainer publishes to the Marketplace.

## Maintainer workflow

- Agents work in a git worktree on a feature branch, never in the maintainer's own checkout (`~/my/nbreview`).
- Before merging, run `npm run typecheck`, `npm test` and `npm run smoke`, and check the feature by hand in the packaged build.
- **When the maintainer says so**, merge:
  1. Fast-forward: `git push origin <branch>:main`.
  2. Update the checkout: `git -C ~/my/nbreview pull --ff-only`.
  3. Detach the worktree (`git switch --detach origin/main`) and delete the branch.
  4. Rebuild in `~/my/nbreview`: `npm ci`, `npm run typecheck`, `npm test`, `npm run smoke` and `npm run package`. The `.vsix` it leaves is the build.
- Don't install the extension into the maintainer's VS Code unless asked: the maintainer installs it from the Marketplace.
- Don't touch global git config, or history outside this repository.
