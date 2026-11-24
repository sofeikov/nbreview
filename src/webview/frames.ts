// Outputs of a Quarto build that draw themselves with scripts (a Plotly figure written as HTML,
// say), each in a sandboxed frame of its own: its scripts run there, and can reach neither the
// page nor VS Code. The extension marks such an output with its HTML (`data-frame`, URI-encoded);
// core/outputFrame.ts makes the frame's document from it, with the scripts the output loads from
// the web put in as text, which the extension downloads.
//
// A frame is made when its place comes near the view, as a plotting library takes a moment to
// start. The page is built again on every refresh, which would start every frame again, so the
// frames made so far are set aside before a refresh and moved back into their places after it,
// with `moveBefore`, which keeps a frame as it is. Where the browser hasn't that (VS Code before
// 1.100), they are made again.
import { frameDocument, frameScripts, type FrameScript } from '../core/outputFrame.ts';

type ScriptReply = { text?: string; error?: string };
type Movable = HTMLElement & { moveBefore?(node: Node, before: Node | null): void };

let ask: (scripts: FrameScript[]) => void = () => undefined;
/** The scripts downloaded so far, by URL. */
const texts = new Map<string, string>();
const waiting = new Map<string, ((reply: ScriptReply) => void)[]>();
/** The frames in the page, by their place: the output's HTML and which copy of it this is. */
const live = new Map<string, HTMLIFrameElement>();
/** By the number a frame's document reports its height under. */
const byId = new Map<number, HTMLIFrameElement>();
let count = 0;
let parking: Movable | undefined;
let watcher: IntersectionObserver | undefined;

/**
 * Whether a message came from an output's frame, or from a frame inside one. The page's own
 * listener must not take one of these for the extension's: a script of the pull request would
 * then feed the page its data. A sandboxed frame has no origin of its own, and so have the frames
 * it makes: its messages say "null", while the extension's come from the webview's origin. (The
 * window around the page can't be asked for: VS Code takes `window.parent` away.)
 */
export function fromOutputFrame(event: MessageEvent): boolean {
  if (!event.source || event.source === window) {
    return false;
  }
  return event.origin === 'null' || [...byId.values()].some(frame => frame.contentWindow === event.source);
}

/** Starts listening to the frames. `post` asks the extension for scripts. */
export function initFrames(post: (scripts: FrameScript[]) => void): void {
  ask = post;
  window.addEventListener('message', (event: MessageEvent<{ nbreviewFrame?: unknown; height?: unknown } | null>) => {
    const data = event.data;
    if (!data || typeof data.nbreviewFrame !== 'number' || typeof data.height !== 'number') {
      return;
    }
    const frame = byId.get(data.nbreviewFrame);
    // Only a frame's own document sets its height. A frame that isn't laid out yet says 0.
    if (frame && event.source === frame.contentWindow && data.height > 0) {
      frame.style.height = `${Math.min(Math.ceil(data.height), 6000)}px`;
    }
  });
}

/** The extension's answer about one script. */
export function scriptReply(url: string, reply: ScriptReply): void {
  if (reply.text !== undefined) {
    texts.set(url, reply.text);
  }
  const list = waiting.get(url) ?? [];
  waiting.delete(url);
  list.forEach(done => done(reply));
}

function script(s: FrameScript): Promise<ScriptReply> {
  const text = texts.get(s.url);
  if (text !== undefined) {
    return Promise.resolve({ text });
  }
  return new Promise(done => {
    const list = waiting.get(s.url);
    if (list) {
      list.push(done);
    } else {
      waiting.set(s.url, [done]);
      ask([s]);
    }
  });
}

function drop(slot: string, frame: HTMLIFrameElement): void {
  live.delete(slot);
  for (const [id, f] of byId) {
    if (f === frame) {
      byId.delete(id);
    }
  }
  frame.remove();
}

/** Before the page is built again: sets the frames aside, or drops them where they can't be moved. */
export function parkFrames(): void {
  if (!live.size) {
    return;
  }
  if (!parking) {
    parking = document.createElement('div');
    parking.hidden = true;
    document.body.append(parking);
  }
  for (const [slot, frame] of [...live]) {
    if (frame.isConnected && parking.moveBefore) {
      parking.moveBefore(frame, null);
    } else {
      drop(slot, frame);
    }
  }
}

/** The height an output asks for at its start, which its place has until the frame says its own. */
function heightHint(html: string): number | undefined {
  const m = /height:\s*(\d+)px/.exec(html.slice(0, 400));
  return m ? Math.min(Math.max(Number(m[1]), 40), 6000) : undefined;
}

function decode(holder: HTMLElement): string {
  try {
    return decodeURIComponent(holder.dataset.frame ?? '');
  } catch {
    return '';
  }
}

/**
 * After the page is built: puts the frames back in their places under `root`, drops those whose
 * output is no longer shown, and watches the places that have no frame yet.
 */
export function placeFrames(root: ParentNode): void {
  watcher?.disconnect();
  watcher ??= new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        watcher?.unobserve(e.target);
        void fill(e.target as HTMLElement);
      }
    }
  }, { rootMargin: '600px 0px' });
  const copies = new Map<string, number>();
  const placed = new Set<string>();
  for (const holder of root.querySelectorAll<Movable>('.qout-frame[data-frame]')) {
    const key = holder.dataset.frame ?? '';
    const n = copies.get(key) ?? 0;
    copies.set(key, n + 1);
    const slot = `${n}\n${key}`;
    holder.dataset.slot = slot;
    const frame = live.get(slot);
    if (frame && holder.moveBefore) {
      holder.replaceChildren();
      holder.moveBefore(frame, null);
      placed.add(slot);
      continue;
    }
    const hint = heightHint(decode(holder));
    const note = holder.querySelector<HTMLElement>('.qfig-ph');
    if (hint && note) {
      note.style.minHeight = `${hint}px`;
    }
    watcher.observe(holder);
  }
  for (const [slot, frame] of [...live]) {
    if (!placed.has(slot)) {
      drop(slot, frame);
    }
  }
}

async function fill(holder: HTMLElement): Promise<void> {
  const html = decode(holder);
  const slot = holder.dataset.slot ?? '';
  const note = holder.querySelector<HTMLElement>('.qfig-ph');
  const say = (text: string) => {
    if (note) {
      note.textContent = text;
    }
  };
  say('Loading the interactive output…');
  const needed = frameScripts(html);
  const replies = await Promise.all(needed.map(script));
  // The page may have been built again while the scripts were on their way: the new place asks for itself.
  if (!holder.isConnected || live.has(slot)) {
    return;
  }
  const failed = replies.findIndex(r => r.text === undefined);
  if (failed >= 0) {
    say(`Interactive output: couldn’t load ${needed[failed].url} (${replies[failed].error ?? 'no answer'})`);
    return;
  }
  const frame = document.createElement('iframe');
  const id = ++count;
  frame.className = 'qout-iframe';
  frame.title = 'Interactive output';
  // Scripts, and nothing else: not the page's origin, no forms, no popups, no way out of the frame.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.style.height = `${heightHint(html) ?? 150}px`;
  frame.srcdoc = frameDocument(html, texts, document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ?? '', id);
  live.set(slot, frame);
  byId.set(id, frame);
  holder.replaceChildren(frame);
}
