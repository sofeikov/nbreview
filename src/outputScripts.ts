// The scripts that interactive outputs of a Quarto build load from the web (plotly.js from its
// CDN, say). The review page loads nothing from the web, and the frame it draws such an output in
// can't either, so the extension downloads each script once and keeps it in its storage
// (`scripts/<hash of the URL>.js`); the page puts the text into the frame (core/outputFrame.ts).
// Scripts not used for a month are deleted.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FrameScript } from './core/outputFrame.ts';

/** A library of this kind is a few megabytes; more than this isn't one. */
const SIZE_LIMIT = 30 * 1024 * 1024;
const TIME_LIMIT = 60 * 1000;
const KEEP_DAYS = 30;

export type ScriptResult = { text: string } | { error: string };

/** Whether the bytes have one of the hashes of an `integrity` attribute. One without a hash we know says nothing. */
export function integrityHolds(integrity: string | undefined, bytes: Uint8Array): boolean {
  const hashes = (integrity ?? '').split(/\s+/).map(h => /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)/.exec(h)).filter((m): m is RegExpExecArray => !!m);
  return !hashes.length || hashes.some(m => createHash(m[1]).update(bytes).digest('base64') === m[2]);
}

export class OutputScripts {
  private readonly got = new Map<string, Promise<ScriptResult>>();
  private pruned = false;

  /** `root` is the extension's storage folder. */
  constructor(private readonly root: string) {}

  /** The text of a script, from the storage or else from the web. A failure isn't kept: the next page asks again. */
  get(script: FrameScript): Promise<ScriptResult> {
    const key = `${script.url}\n${script.integrity ?? ''}`;
    let result = this.got.get(key);
    if (!result) {
      result = this.load(script).catch((e: unknown): ScriptResult => ({ error: e instanceof Error ? e.message : String(e) }));
      this.got.set(key, result);
      void result.then(r => {
        if ('error' in r) {
          this.got.delete(key);
        }
      });
    }
    return result;
  }

  private async load(script: FrameScript): Promise<ScriptResult> {
    if (typeof script.url !== 'string' || !/^https:\/\/[^\s/]+\//i.test(script.url)) {
      return { error: 'not an https address' };
    }
    const integrity = typeof script.integrity === 'string' ? script.integrity : undefined;
    const dir = path.join(this.root, 'scripts');
    const file = path.join(dir, `${createHash('sha256').update(script.url).digest('hex')}.js`);
    void this.prune(dir);
    const kept = await fs.readFile(file).catch(() => undefined);
    if (kept && integrityHolds(integrity, kept)) {
      const now = new Date();
      void fs.utimes(file, now, now).catch(() => undefined);
      return { text: kept.toString('utf8') };
    }
    const res = await fetch(script.url, { signal: AbortSignal.timeout(TIME_LIMIT), redirect: 'follow' });
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > SIZE_LIMIT) {
      return { error: 'too large' };
    }
    if (!integrityHolds(integrity, bytes)) {
      return { error: 'not the script the output expects (its integrity hash differs)' };
    }
    await fs.mkdir(dir, { recursive: true });
    // Written under another name first, so a script that is half written is never read.
    const part = `${file}.${process.pid}.part`;
    await fs.writeFile(part, bytes);
    await fs.rename(part, file);
    return { text: Buffer.from(bytes).toString('utf8') };
  }

  private async prune(dir: string): Promise<void> {
    if (this.pruned) {
      return;
    }
    this.pruned = true;
    const old = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat?.isFile() && stat.mtimeMs < old) {
        await fs.rm(file, { force: true }).catch(() => undefined);
      }
    }
  }
}
