// An output of a Quarto build that draws itself with scripts (a Plotly figure written as HTML,
// say), made into the document of a frame of its own on the review page. The page itself runs no
// script of a pull request: the frame is sandboxed, so its scripts can't reach the page or VS Code.
//
// The frame gets the page's content security policy, which lets a script in only with the page's
// nonce and loads none from the web. So every script of the output is given the nonce, and one
// that the output loads by URL (plotly.js from its CDN) is downloaded by the extension and put in
// as text.

/** A script an output loads by URL, with the hash the output expects it to have, when it gives one. */
export interface FrameScript {
  url: string;
  integrity?: string;
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** Whether an HTML output needs scripts to show, and so a frame. */
export function needsFrame(html: string): boolean {
  return /<script[\s>]/i.test(html);
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return (m?.[1] ?? m?.[2] ?? m?.[3])?.replace(/&amp;/g, '&');
}

/** The address of a script on the web; undefined for one that isn't loaded over https. */
function scriptUrl(attrs: string): string | undefined {
  const src = attr(attrs, 'src')?.trim();
  if (!src) {
    return undefined;
  }
  const url = src.startsWith('//') ? `https:${src}` : src;
  return /^https:\/\/[^\s/]+\//i.test(url) ? url : undefined;
}

/** The scripts an output loads by URL, each once, in the order it loads them. */
export function frameScripts(html: string): FrameScript[] {
  const out = new Map<string, FrameScript>();
  for (const m of html.matchAll(SCRIPT)) {
    const url = scriptUrl(m[1]);
    if (url && !out.has(url)) {
      const integrity = attr(m[1], 'integrity');
      out.set(url, integrity ? { url, integrity } : { url });
    }
  }
  return [...out.values()];
}

/** Script text that can't end the `<script>` element it is put in, or start an HTML comment there. */
function inScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/**
 * The document of an output's frame. `scripts` has the text of the scripts the output loads by
 * URL; one that is missing is left out. Scripts keep their order, and all run as the document is
 * read, as they would with the library already in the browser's cache. The last script tells the
 * page the height of the content, under the frame's `id`, so the frame can be as tall.
 */
export function frameDocument(html: string, scripts: ReadonlyMap<string, string>, nonce: string, id: number): string {
  const body = html.replace(SCRIPT, (_all, attrs: string, code: string) => {
    const type = attr(attrs, 'type');
    const open = `<script nonce="${nonce}"${type ? ` type="${type.replace(/"/g, '')}"` : ''}>`;
    if (/(?:^|\s)src\s*=/i.test(attrs)) {
      const url = scriptUrl(attrs);
      const text = url === undefined ? undefined : scripts.get(url);
      return text === undefined ? '' : `${open}${inScript(text)}</script>`;
    }
    return `${open}${code}</script>`;
  });
  const report = `(function () { var last = -1; function say() { var h = Math.ceil(document.documentElement.getBoundingClientRect().height); `
    + `if (h !== last) { last = h; parent.postMessage({ nbreviewFrame: ${id}, height: h }, '*'); } } `
    + `new ResizeObserver(say).observe(document.documentElement); addEventListener('load', say); })();`;
  // Outputs are made for a white page, whatever the colour theme of the editor.
  const style = 'html { color-scheme: light; } body { margin: 0; background: #fff; color: #1f2328; font: 14px system-ui, sans-serif; overflow-y: hidden; }';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${style}</style></head><body>${body}<script nonce="${nonce}">${report}</script></body></html>`;
}

/**
 * An output's HTML without the ids its library made up for this run: Plotly, Bokeh and Altair name
 * the element they draw in at random, so two runs of the same figure differ only in that.
 */
export function withoutRunIds(html: string): string {
  return html.replace(/\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi, 'id');
}
