// Runs inside the VS Code that `npm run smoke` starts, next to the installed Notebook Review.
// It reads `.smoke/control.json` in the opened folder, writes what it sees to `.smoke/`, and
// closes the window when the driver asks. See scripts/smoke.mjs.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');

const ID = 'KonstantinSofeikov.nbreview';

async function activate() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const dir = path.join(folder.uri.fsPath, '.smoke');
  const control = JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8'));
  const ext = vscode.extensions.getExtension(ID);
  fs.appendFileSync(path.join(dir, 'activations.jsonl'), JSON.stringify({ version: ext?.packageJSON.version ?? null }) + '\n');
  if (control.phase === 'wait') {
    // The driver installs the new version next, and clicks Restart Extensions in this view.
    await vscode.commands.executeCommand('workbench.view.extensions');
    return;
  }
  const result = await sweep(ext, control);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  // The driver looks for error notifications before the window goes.
  const close = path.join(dir, 'close');
  const timer = setInterval(() => {
    if (fs.existsSync(close)) {
      clearInterval(timer);
      void vscode.commands.executeCommand('workbench.action.closeWindow');
    }
  }, 200);
}

async function sweep(ext, control) {
  const failures = [];
  const notes = [];
  if (!ext) {
    return { version: null, failures: [`${ID} is not installed`], notes };
  }
  const manifest = ext.packageJSON;
  try {
    await ext.activate();
  } catch (e) {
    failures.push(`activation failed: ${message(e)}`);
    return { version: manifest.version, failures, notes };
  }

  // Every contributed command is registered, and is either run here or skipped for a reason.
  const registered = new Set(await vscode.commands.getCommands(true));
  const run = new Map(control.run.map(r => [r.command, r.args ?? []]));
  for (const { command } of manifest.contributes.commands) {
    if (!registered.has(command)) {
      failures.push(`${command} is in package.json but not registered`);
    }
    if (!run.has(command) && !control.skip[command]) {
      failures.push(`${command} is neither run nor skipped by the smoke test; add it to RUN or SKIP in scripts/smoke.mjs`);
    }
  }

  // Settings: after a fresh install every one is registered and can be written. After an update
  // without a window reload, new ones are not registered yet, so nothing may write them then.
  const config = vscode.workspace.getConfiguration();
  for (const [key, schema] of Object.entries(manifest.contributes.configuration.properties)) {
    const registeredKey = config.inspect(key)?.defaultValue !== undefined || schema.default === undefined;
    if (!registeredKey) {
      (control.fresh ? failures : notes).push(
        control.fresh ? `${key} is not registered after a fresh install` : `${key} is not registered until the window reloads; commands must not write it`,
      );
      continue;
    }
    if (control.fresh) {
      try {
        await config.update(key, schema.default, vscode.ConfigurationTarget.Global);
        await config.update(key, undefined, vscode.ConfigurationTarget.Global);
      } catch (e) {
        failures.push(`writing ${key}: ${message(e)}`);
      }
    }
  }

  for (const [command, args] of run) {
    try {
      await withTimeout(vscode.commands.executeCommand(command, ...args), 10000, `${command} did not finish in 10 s`);
    } catch (e) {
      failures.push(`${command}: ${message(e)}`);
    }
  }
  return { version: manifest.version, ran: [...run.keys()], failures, notes };
}

function withTimeout(promise, ms, text) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(text)), ms))),
  ]);
}

function message(e) {
  return e instanceof Error ? e.message : String(e);
}

module.exports = { activate };
