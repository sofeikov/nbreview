// Experimental: builds a Quarto document of a pull request with Quarto itself, so the review page
// can show what the document computes (see core/quartoRun.ts). Nothing else runs code, so this
// only happens when the reviewer asks for it and confirms.
//
// A build needs the whole repository at one commit: the document imports the project's own
// package and reads its data. So each commit is fetched from GitHub, by itself, into a folder of
// its own in the extension's storage (`builds/owner/repo/sha`, a real git checkout, as tools that
// read the version from git need one), and Quarto runs there. Each side of a diff gets its own
// checkout, so the old side is built from the old code and data. What a build gave is kept by
// commit and path (`renders/owner/repo/sha/path.json`): a commit never changes, so it is built
// once. A checkout is deleted as soon as its build ends: with the project's environment in it, it
// can take gigabytes. Results not used for a week are deleted.
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { keptNotebook, parseQuartoRun, quartoCommand, readQuartoRun, type QuartoRun } from './core/quartoRun.ts';

/** A document at one commit. */
export interface BuildTarget {
  owner: string;
  repo: string;
  sha: string;
  path: string;
}

/** Results not used for this long are deleted. */
const KEEP_DAYS = 7;
/** A build that takes longer than this is stopped. */
const TIME_LIMIT = 30 * 60 * 1000;
/** The file among a commit's results whose time says when they were last used. */
const USED = '.nbreview-used';

class Cancelled extends Error {}

function key(t: BuildTarget): string {
  return `${t.owner}/${t.repo}@${t.sha}:${t.path}`;
}

/** Only names that are one folder each, and paths that stay inside the checkout. */
function safe(t: BuildTarget): boolean {
  const part = (p: string) => /^[\w.-]+$/.test(p) && p !== '.' && p !== '..';
  return part(t.owner) && part(t.repo) && /^[0-9a-f]{40}$/.test(t.sha)
    && !!t.path && !t.path.startsWith('/') && !t.path.includes('\\') && t.path.split('/').every(p => p && p !== '.' && p !== '..');
}

export class QuartoBuilds implements vscode.Disposable {
  private readonly runs = new Map<string, Promise<QuartoRun | undefined>>();
  private readonly changed = new vscode.EventEmitter<{ results: boolean }>();
  /** Fires when a build starts, moves on or ends, and with `results` when a document's run was made or removed. */
  readonly onDidChange = this.changed.event;
  private log?: vscode.OutputChannel;
  private current?: { paths: Set<string>; note: string };
  /** Stops the command that is running, if one is. */
  private stop?: () => void;
  private pruned = false;

  /** `root` is the extension's storage folder; `gitEnv` gives git the signed-in user's access. */
  constructor(private readonly root: string, private readonly gitEnv: () => Record<string, string> | undefined) {}

  dispose(): void {
    // A build must not outlive the window that started it.
    this.stop?.();
    this.changed.dispose();
    this.log?.dispose();
  }

  /** What a build of this document at this commit gave; undefined when none was made. */
  run(t: BuildTarget): Promise<QuartoRun | undefined> {
    if (!safe(t)) {
      return Promise.resolve(undefined);
    }
    let run = this.runs.get(key(t));
    if (!run) {
      run = fs.readFile(this.resultFile(t), 'utf8').then(parseQuartoRun, () => undefined);
      this.runs.set(key(t), run);
      void run.then(r => {
        if (r) {
          // Marks the commit's results as used, which keeps them from being deleted as old.
          void fs.writeFile(path.join(this.root, 'renders', t.owner, t.repo, t.sha, USED), '').catch(() => undefined);
        }
      });
    }
    return run;
  }

  /** What is being built for a path of the pull request, for the page to show; undefined when nothing is. */
  building(filePath: string): string | undefined {
    return this.current?.paths.has(filePath) ? this.current.note : undefined;
  }

  /** Forgets and deletes what was built of these targets. */
  async remove(targets: BuildTarget[]): Promise<void> {
    for (const t of targets.filter(safe)) {
      this.runs.delete(key(t));
      await fs.rm(this.resultFile(t), { force: true });
    }
    this.changed.fire({ results: true });
  }

  /**
   * Builds the targets one after the other, the first one first (the new side, which is read
   * most), with a notification that can cancel. `paths` are the pull request's files they are
   * the versions of. Resolves when all are done; a target that fails is reported and the rest
   * still build.
   */
  async build(targets: BuildTarget[], paths: string[], labels: string[]): Promise<void> {
    if (this.current) {
      throw new Error('A Quarto build is already running. Wait for it, or cancel it from its notification.');
    }
    if (targets.some(t => !safe(t))) {
      throw new Error('This file can\'t be built: its path or its repository has an unusual name.');
    }
    const setting = vscode.workspace.getConfiguration('nbreview').get<string>('quarto.command', '').trim();
    this.current = { paths: new Set(paths), note: 'Starting…' };
    this.changed.fire({ results: false });
    const failures: string[] = [];
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Quarto build', cancellable: true }, async (progress, token) => {
        if (!this.pruned) {
          this.pruned = true;
          await this.prune().catch(() => undefined);
        }
        for (const [i, t] of targets.entries()) {
          const name = `${labels[i]} (${t.sha.slice(0, 7)})`;
          const say = (what: string) => {
            this.current!.note = `${what} ${name}…`;
            progress.report({ message: `${what} ${name}…` });
            this.changed.fire({ results: false });
          };
          try {
            await this.buildOne(t, setting, say, token);
          } catch (e) {
            if (e instanceof Cancelled) {
              this.say(`Cancelled.`);
              return;
            }
            const message = e instanceof Error ? e.message : String(e);
            this.say(`Failed: ${message}`);
            failures.push(`${name}: ${message}`);
            continue;
          } finally {
            await fs.rm(this.checkout(t), { recursive: true, force: true }).catch(() => undefined);
          }
          this.changed.fire({ results: true });
        }
      });
    } finally {
      this.current = undefined;
      this.changed.fire({ results: false });
    }
    if (failures.length) {
      const pick = await vscode.window.showWarningMessage(`The Quarto build failed for ${failures.join('; ')}`, 'Show Log');
      if (pick) {
        this.log?.show(true);
      }
    }
  }

  private say(line: string): void {
    this.log ??= vscode.window.createOutputChannel('Notebook Review: Quarto');
    this.log.appendLine(line);
  }

  private resultFile(t: BuildTarget): string {
    return path.join(this.root, 'renders', t.owner, t.repo, t.sha, ...`${t.path}.json`.split('/'));
  }

  private checkout(t: BuildTarget): string {
    return path.join(this.root, 'builds', t.owner, t.repo, t.sha);
  }

  private async buildOne(t: BuildTarget, setting: string, say: (what: string) => void, token: vscode.CancellationToken): Promise<void> {
    const dir = this.checkout(t);
    this.say(`\n=== ${t.owner}/${t.repo} ${t.path} at ${t.sha} ===`);
    say('Fetching');
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const env = { ...process.env, ...(this.gitEnv() ?? {}) };
    await this.exec(['git', 'init', '-q'], dir, env, token);
    await this.exec(['git', 'fetch', '-q', '--depth', '1', '--no-tags', `https://github.com/${t.owner}/${t.repo}.git`, t.sha], dir, env, token);
    await this.exec(['git', 'checkout', '-q', '--detach', 'FETCH_HEAD'], dir, env, token);
    const file = path.join(dir, ...t.path.split('/'));
    if (!(await exists(file))) {
      throw new Error('the file isn\'t in the repository at this commit');
    }
    const folder = path.dirname(file);
    const command = quartoCommand(setting, path.basename(file), await hasAbove(folder, dir, 'uv.lock'));
    say('Building');
    const started = Date.now();
    await this.exec(command, folder, process.env, token);
    const kept = keptNotebook(path.basename(file), await fs.readdir(folder));
    const stat = kept ? await fs.stat(path.join(folder, kept)).catch(() => undefined) : undefined;
    if (!kept || !stat || stat.mtimeMs < started - 2000) {
      throw new Error('Quarto kept no notebook of the document: only documents run by its Jupyter engine (Python, for one) can be built');
    }
    const run = readQuartoRun(await fs.readFile(path.join(folder, kept), 'utf8'));
    const out = this.resultFile(t);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(run));
    this.runs.set(key(t), Promise.resolve(run));
    this.say(`Done in ${Math.round((Date.now() - started) / 1000)} s: ${run.exprs.length} inline values, ${run.cells.length} cells.`);
  }

  /** Runs a command to its end, its output going to the log. Rejects when it fails, is cancelled or takes too long. */
  private exec(command: string[], cwd: string, env: NodeJS.ProcessEnv, token: vscode.CancellationToken): Promise<void> {
    this.say(`$ ${command.join(' ')}`);
    return new Promise((resolve, reject) => {
      if (token.isCancellationRequested) {
        reject(new Cancelled());
        return;
      }
      const windows = process.platform === 'win32';
      // Its own process group, so that cancelling also stops the kernel Quarto started.
      const child = spawn(command[0], command.slice(1), { cwd, env, shell: windows, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      let cancelled = false;
      const out = (chunk: Buffer) => {
        const text = chunk.toString();
        tail = (tail + text).slice(-400);
        this.log?.append(text);
      };
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      const kill = () => {
        if (child.pid === undefined) {
          return;
        }
        try {
          if (windows) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
          } else {
            process.kill(-child.pid, 'SIGTERM');
            setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, 3000).unref();
          }
        } catch { /* already gone */ }
      };
      const sub = token.onCancellationRequested(() => { cancelled = true; kill(); });
      this.stop = () => { cancelled = true; kill(); };
      let late = false;
      const timer = setTimeout(() => { late = true; kill(); }, TIME_LIMIT);
      const end = (err?: Error) => {
        sub.dispose();
        clearTimeout(timer);
        this.stop = undefined;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
      child.on('error', e => end((e as NodeJS.ErrnoException).code === 'ENOENT'
        ? new Error(`"${command[0]}" wasn't found. Install it, or set the command in the setting nbreview.quarto.command`)
        : e));
      child.on('close', code => {
        if (cancelled) {
          end(new Cancelled());
        } else if (late) {
          end(new Error(`stopped after ${TIME_LIMIT / 60000} minutes`));
        } else if (code !== 0) {
          const last = tail.trim().split('\n').filter(l => l.trim()).slice(-2).join(' ').slice(-240);
          end(new Error(`${command[0]} ended with code ${code}${last ? `: ${last}` : ''}`));
        } else {
          end();
        }
      });
    });
  }

  /**
   * Deletes the results (`renders/owner/repo/sha`) not used for `KEEP_DAYS` days, and the
   * checkouts older than a day: one that is still there was left by a build that VS Code was
   * closed on (a newer one may be another window's, still building).
   */
  private async prune(): Promise<void> {
    const day = 24 * 3600 * 1000;
    const dirs = async (dir: string) => (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory()).map(e => path.join(dir, e.name));
    for (const [top, age] of [['renders', KEEP_DAYS * day], ['builds', day]] as const) {
      for (const owner of await dirs(path.join(this.root, top))) {
        for (const repo of await dirs(owner)) {
          for (const sha of await dirs(repo)) {
            const used = await fs.stat(path.join(sha, USED)).then(s => s.mtimeMs, () => fs.stat(sha).then(s => s.mtimeMs, () => Date.now()));
            if (used < Date.now() - age && /^[0-9a-f]{40}$/.test(path.basename(sha))) {
              await fs.rm(sha, { recursive: true, force: true });
            }
          }
        }
      }
    }
  }
}

function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}

/** Whether `name` is in `folder` or a folder above it, up to `top`. */
async function hasAbove(folder: string, top: string, name: string): Promise<boolean> {
  for (let dir = folder; dir.startsWith(top); dir = path.dirname(dir)) {
    if (await exists(path.join(dir, name))) {
      return true;
    }
    if (dir === top) {
      break;
    }
  }
  return false;
}
