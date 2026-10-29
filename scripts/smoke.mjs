// Pre-release check of the packaged extension, the way users get it, in a real VS Code:
//
//   A. fresh install: install nbreview.vsix and start VS Code;
//   B. update in place: start VS Code with the previous release installed, install the new
//      nbreview.vsix while it runs, and click "Restart Extensions" (no window reload).
//
// In each, a helper extension (scripts/smoke/runner) activates Notebook Review, checks that
// every command in package.json is registered, writes every setting (A only), and runs the
// commands that work without a pull request open. The run fails on any error from them, any
// error notification or extension host error from Notebook Review, or, in B, if the new version
// isn't the one running after the restart.
//
//   npm run smoke -- [--from REV] [--vscode VERSION] [--keep] [--visible]
//
// --from: the previous release to update from (default: the last commit with another version in
// package.json). --vscode: the VS Code to download (default: stable). --keep: keep the profiles.
// On Linux, VS Code runs on a virtual display (Xvfb) when it is installed, so no window opens on
// your screen; --visible shows the windows instead.
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv[i + 1];
};
const keep = argv.includes('--keep');
const visible = argv.includes('--visible');
const vscodeVersion = flag('--vscode', 'stable');

// Commands run with no pull request open. They should do nothing, or work on their own.
const RUN = [
  { command: 'nbreview.viewAsList' },
  { command: 'nbreview.viewAsTree' },
  { command: 'nbreview.hideComments' },
  { command: 'nbreview.showUnresolvedComments' },
  { command: 'nbreview.showAllComments' },
  { command: 'nbreview.refresh' },
  { command: 'nbreview.openVisual' },
  { command: 'nbreview.openNotebookDiff' },
  { command: 'nbreview.openFileDiff', args: ['README.md'] },
  { command: 'nbreview.openChangesSinceReview', args: ['README.md'] },
  { command: 'nbreview.openOnGitHub' },
  { command: 'nbreview.markViewed' },
  { command: 'nbreview.markNotViewed' },
  { command: 'nbreview.markFolderViewed' },
  { command: 'nbreview.markFolderNotViewed' },
  { command: 'nbreview.discardReview' },
  { command: 'nbreview.close' },
];
// Commands that can't run here, and why. A new command must go in one of the two lists.
const SKIP = {
  'nbreview.openPr': 'asks GitHub for pull requests and waits in a picker',
  'nbreview.refreshPrs': 'asks GitHub, and may ask to sign in',
  'nbreview.signIn': 'asks to sign in to GitHub',
  'nbreview.openPrOnGitHub': 'opens the browser',
  'nbreview.submitReview': 'needs a pull request; waits in a picker',
  'nbreview.nextFile': 'waits for an answer to a message when there are no files',
  'nbreview.openNotebook': 'needs a pull request',
  'nbreview.addComment': 'needs a comment widget',
  'nbreview.addSingleComment': 'needs a comment widget',
  'nbreview.editDraft': 'needs a comment widget',
  'nbreview.saveDraft': 'needs a comment widget',
  'nbreview.cancelEditDraft': 'needs a comment widget',
  'nbreview.deleteDraft': 'needs a comment widget',
  'nbreview.resolveThread': 'needs a comment thread',
  'nbreview.unresolveThread': 'needs a comment thread',
};

const repo = resolve('.');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const work = mkdtempSync(join(tmpdir(), 'nbreview-smoke-'));
const log = (...a) => console.log('•', ...a);

let failed = false;
let display;
try {
  log(`packaging ${version}`);
  execSync('npm run package', { stdio: 'ignore' });
  const vsix = join(work, `nbreview-${version}.vsix`);
  execSync(`cp nbreview.vsix ${vsix}`);
  const from = flag('--from', previousRelease());
  const old = packageAt(from);

  log(`downloading VS Code ${vscodeVersion}`);
  const exe = await downloadAndUnzipVSCode({ version: vscodeVersion, cachePath: join(repo, '.vscode-test') });
  const cli = resolveCliPathFromVSCodeExecutablePath(exe);

  display = visible ? undefined : await virtualDisplay();

  const results = [];
  results.push(await scenario('A. fresh install', { exe, cli, install: vsix, fresh: true, expect: version }));
  results.push(await scenario(`B. update in place from ${old.version}`, { exe, cli, install: old.vsix, update: vsix, fresh: false, expect: version }));

  console.log('');
  for (const r of results) {
    console.log(`${r.failures.length ? '✗' : '✓'} ${r.name}${r.failures.length ? '' : ` (${r.ran} commands run)`}`);
    for (const f of r.failures) {
      console.log(`    ✗ ${f}`);
    }
    for (const n of r.notes) {
      console.log(`    · ${n}`);
    }
  }
  failed = results.some(r => r.failures.length);
} finally {
  display?.stop();
  if (keep) {
    log(`profiles kept in ${work}`);
  } else {
    rmSync(work, { recursive: true, force: true });
  }
}
console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE OK');
process.exit(failed ? 1 : 0);

/**
 * A virtual X display for VS Code, so no window opens on the screen or takes the focus. Without
 * Xvfb (or off Linux), the windows open on the screen.
 */
async function virtualDisplay() {
  if (process.platform !== 'linux') {
    return undefined;
  }
  try {
    execFileSync('sh', ['-c', 'command -v Xvfb'], { stdio: 'ignore' });
  } catch {
    log('Xvfb is not installed, so VS Code windows will open on your screen (install it with `sudo apt install xvfb`)');
    return undefined;
  }
  // Xvfb picks a free display number and writes it to file descriptor 3.
  const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const number = await new Promise((ok, fail) => {
    let out = '';
    xvfb.stdio[3].on('data', d => {
      out += d;
      if (out.includes('\n')) {
        ok(out.trim());
      }
    });
    xvfb.once('exit', code => fail(new Error(`Xvfb exited (${code})`)));
    setTimeout(() => fail(new Error('Xvfb did not start')), 10000);
  });
  log(`VS Code runs on virtual display :${number}`);
  const env = { ...process.env, DISPLAY: `:${number}`, XDG_SESSION_TYPE: 'x11' };
  delete env.WAYLAND_DISPLAY;
  return { env, stop: () => xvfb.kill() };
}

/** The last commit whose package.json has another version than the working tree's. */
function previousRelease() {
  for (const rev of execFileSync('git', ['log', '--format=%H', '--', 'package.json'], { encoding: 'utf8' }).trim().split('\n')) {
    if (JSON.parse(execFileSync('git', ['show', `${rev}:package.json`], { encoding: 'utf8' })).version !== version) {
      return rev;
    }
  }
  throw new Error('no earlier version in the git history; pass --from REV');
}

/** Packages the extension at a git revision, in a scratch copy that shares node_modules. */
function packageAt(rev) {
  const dir = join(work, 'previous');
  mkdirSync(dir);
  execSync(`git archive ${rev} | tar -x -C ${dir}`);
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
  const old = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  log(`packaging ${old} (${rev.slice(0, 7)}) to update from`);
  execSync('npm run package', { cwd: dir, stdio: 'ignore' });
  return { version: old, vsix: join(dir, 'nbreview.vsix') };
}

async function scenario(name, { exe, cli, install, update, fresh, expect }) {
  log(name);
  const dir = join(work, fresh ? 'fresh' : 'update');
  const profile = { userData: join(dir, 'user-data'), extensions: join(dir, 'extensions') };
  const folder = join(dir, 'workspace');
  const smoke = join(folder, '.smoke');
  mkdirSync(join(profile.userData, 'User'), { recursive: true });
  mkdirSync(smoke, { recursive: true });
  writeFileSync(join(folder, 'README.md'), '# smoke\n');
  writeFileSync(join(profile.userData, 'User', 'settings.json'), JSON.stringify({
    // Dialogs in the page, where the driver can see them, instead of native ones.
    'window.dialogStyle': 'custom',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'extensions.autoRestart': false,
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
  }));
  const control = phase => writeFileSync(join(smoke, 'control.json'), JSON.stringify({ phase, fresh, run: RUN, skip: SKIP }));
  const installVsix = file => execFileSync(cli, ['--user-data-dir', profile.userData, '--extensions-dir', profile.extensions, '--install-extension', file, '--force'], { stdio: 'ignore' });

  installVsix(install);
  control(update ? 'wait' : 'sweep');
  const port = 9400 + Math.floor(Math.random() * 500);
  const app = spawn(exe, [
    '--user-data-dir', profile.userData,
    '--extensions-dir', profile.extensions,
    `--extensionDevelopmentPath=${join(repo, 'scripts', 'smoke', 'runner')}`,
    `--remote-debugging-port=${port}`,
    '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--no-sandbox', '--new-window',
    // No keyring prompt: the throwaway profile keeps nothing secret.
    '--password-store=basic',
    ...(display ? ['--ozone-platform=x11'] : []),
    folder,
  ], { stdio: 'ignore', env: display?.env ?? process.env });
  const exited = new Promise(r => app.once('exit', r));
  const failures = [];
  const notes = [];
  let ran = 0;
  let page;
  try {
    page = await connect(port);
    if (update) {
      const before = await waitFor(() => lastActivation(smoke), 60000, 'the runner did not start');
      if (before.version === expect) {
        throw new Error(`the old version installed is already ${expect}; pass --from an older revision`);
      }
      installVsix(update);
      control('sweep');
      // The button VS Code shows once it notices the new version: it restarts the extension
      // host with the new version, without reloading the window.
      await waitFor(() => page.eval(`(() => {
        const label = [...document.querySelectorAll('a, button, [role=button], span, div')]
          .find(e => e.childElementCount === 0 && e.textContent.trim() === 'Restart Extensions' && e.getClientRects().length);
        const b = label?.closest('a, button, [role=button]') ?? label;
        return b ? (b.click(), true) : false;
      })()`), 60000, 'no Restart Extensions button appeared');
    }
    const result = await waitFor(() => existsSync(join(smoke, 'result.json')) && JSON.parse(readFileSync(join(smoke, 'result.json'), 'utf8')), 90000, 'the runner did not report');
    failures.push(...result.failures);
    notes.push(...result.notes);
    ran = result.ran?.length ?? 0;
    if (result.version !== expect) {
      failures.push(`Notebook Review ${result.version} is running, not ${expect}`);
    }
    // Errors shown to the user: notifications and dialogs.
    await new Promise(r => setTimeout(r, 1500));
    const shown = await page.eval(`[...document.querySelectorAll('.notification-list-item, .monaco-dialog-box')]
      .filter(e => e.querySelector('.codicon-error, .codicon-notifications-error, .dialog-message-row .codicon-error'))
      .map(e => e.textContent.replace(/\\s+/g, ' ').trim())`);
    for (const text of shown ?? []) {
      (/notebook review|nbreview/i.test(text) ? failures : notes).push(`error shown: ${text}`);
    }
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
    if (page && keep) {
      await page.screenshot(join(dir, 'failure.png'));
      notes.push(`screenshot: ${join(dir, 'failure.png')}`);
    }
  } finally {
    page?.close();
    writeFileSync(join(smoke, 'close'), '');
    const closed = await Promise.race([exited.then(() => true), new Promise(r => setTimeout(() => r(false), 20000))]);
    if (!closed) {
      failures.push('VS Code did not close; stopping it');
      app.kill('SIGTERM');
      await Promise.race([exited, new Promise(r => setTimeout(r, 10000))]);
    }
  }
  // Errors from Notebook Review in the extension host log.
  for (const line of extensionHostLog(profile.userData)) {
    if (/\[error\]/.test(line) && /nbreview/i.test(line)) {
      failures.push(`extension host: ${line.slice(0, 300)}`);
    }
  }
  return { name, failures, notes, ran };
}

function lastActivation(smoke) {
  const file = join(smoke, 'activations.jsonl');
  return existsSync(file) && JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1));
}

function extensionHostLog(userData) {
  const lines = [];
  const walk = d => {
    for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name === 'exthost.log') {
        lines.push(...readFileSync(p, 'utf8').split('\n'));
      }
    }
  };
  walk(join(userData, 'logs'));
  return lines;
}

async function waitFor(check, ms, text) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(text);
}

/** A DevTools connection to the workbench page. Every call has a time limit. */
async function connect(port) {
  const list = await waitFor(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      return pages.find(p => p.type === 'page' && p.url.includes('workbench'));
    } catch {
      return undefined;
    }
  }, 60000, 'VS Code did not start');
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true });
    setTimeout(() => fail(new Error('DevTools connection timed out')), 5000);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  const send = (method, params) => new Promise(ok => {
    const i = ++id;
    pending.set(i, m => ok(m.result));
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => pending.delete(i) && ok(undefined), 5000);
  });
  return {
    eval: async expression => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value,
    screenshot: async file => {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot) {
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
      }
    },
    close: () => ws.close(),
  };
}

