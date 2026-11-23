// Mermaid diagrams (```mermaid blocks), drawn as github.com draws them, on the Overview and on the
// review page. The Mermaid library is large, so it is a separate script that a page loads only when
// it has a diagram to draw; its URL is on the body (`data-mermaid`). A block that can't be drawn
// stays code, with a note saying why.

interface Mermaid {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

export type Drawing = { svg: string } | { error: string };

/** The drawings made so far, by theme and source, as the pages are built again on every refresh. */
const drawings = new Map<string, Promise<Drawing>>();
const done = new Map<string, Drawing>();
let library: Promise<Mermaid | undefined> | undefined;
let theme: string | undefined;
let count = 0;

/** Mermaid's theme for VS Code's: the dark one for dark and high contrast themes. */
export function mermaidTheme(bodyClass: string): 'dark' | 'default' {
  return /\bvscode-(dark|high-contrast)\b/.test(bodyClass) && !/\bvscode-high-contrast-light\b/.test(bodyClass) ? 'dark' : 'default';
}

/**
 * Mermaid runs in an empty frame of its own. The pages' classes (`label`, `node`, `note`…) are also
 * Mermaid's, and it lays out labels by measuring them in the document, so in the page itself the
 * page's styles would change what it measured. The frame is about:blank, which shares the page's
 * origin and its content security policy, so the page's nonce lets the script in. The page fetches
 * the script and puts it in as text: a VS Code webview's files are served by its service worker,
 * which doesn't serve the frame.
 */
function load(): Promise<Mermaid | undefined> {
  const src = document.body.dataset.mermaid;
  if (!src) {
    return Promise.resolve(undefined);
  }
  return library ??= fetch(src)
    .then(r => (r.ok ? r.text() : undefined))
    .then(code => {
      if (code === undefined) {
        return undefined;
      }
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      // Laid out (labels are measured), but out of sight.
      frame.style.cssText = 'position: fixed; left: -10000px; top: 0; width: 1600px; height: 900px; border: 0; visibility: hidden;';
      document.body.append(frame);
      const doc = frame.contentDocument;
      if (!doc) {
        return undefined;
      }
      const script = doc.createElement('script');
      const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
      if (nonce) {
        script.nonce = nonce;
      }
      script.textContent = code;
      doc.head.append(script);
      return (frame.contentWindow as unknown as { mermaid?: Mermaid }).mermaid;
    }, () => undefined);
}

/** The diagram drawn from `source` in the current colour theme, or why it couldn't be drawn. */
export function drawMermaid(source: string): Promise<Drawing> {
  const now = mermaidTheme(document.body.className);
  const key = `${now}\n${source}`;
  let drawing = drawings.get(key);
  if (!drawing) {
    drawing = load().then(async mermaid => {
      if (!mermaid) {
        return { error: 'Mermaid didn’t load' };
      }
      if (theme !== now) {
        theme = now;
        // `strict` escapes HTML in labels and turns off click handlers.
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: now, suppressErrorRendering: true });
      }
      try {
        return { svg: (await mermaid.render(`nbreview-mermaid-${++count}`, source)).svg };
      } catch (e) {
        return { error: (e instanceof Error ? e.message : String(e)).split('\n')[0].replace(/^Error: /, '') };
      }
    }).then(d => {
      done.set(key, d);
      return d;
    });
    drawings.set(key, drawing);
  }
  return drawing;
}

/**
 * The element that shows a drawing. The SVG goes in a shadow root, where the page's styles don't
 * reach it, and as markup, so a script in it would never run (nor would the page's policy let it).
 */
export function diagramElement(drawing: Drawing): HTMLElement {
  if ('error' in drawing) {
    const note = document.createElement('div');
    note.className = 'mermaid-error';
    note.textContent = `Couldn’t draw this Mermaid diagram: ${drawing.error}`;
    return note;
  }
  const figure = document.createElement('div');
  figure.className = 'mermaid-diagram';
  figure.setAttribute('role', 'img');
  figure.setAttribute('aria-label', 'Mermaid diagram');
  const host = document.createElement('div');
  host.attachShadow({ mode: 'open' }).innerHTML = `<style>:host { all: initial; display: block; } svg { display: block; height: auto; margin: 0 auto; }</style>${drawing.svg}`;
  figure.append(host);
  return figure;
}

/**
 * Draws the diagrams under `root`: on the Overview, each ```mermaid block of GitHub Markdown, which
 * the diagram replaces; on the review page, each code block the extension marked with its source
 * (`data-mermaid`, URI-encoded), which the diagram follows, as the code takes comments and shows
 * changes. A diagram drawn before goes in at once, so the page keeps its scroll position when it is
 * built again; a new one goes in when it is ready.
 */
export function drawDiagrams(root: ParentNode): void {
  const theme = mermaidTheme(document.body.className);
  for (const code of root.querySelectorAll<HTMLElement>('.markdown pre > code.language-mermaid')) {
    place(code.parentElement!, code.textContent ?? '', theme, 'replace');
  }
  for (const pre of root.querySelectorAll<HTMLElement>('pre[data-mermaid]')) {
    place(pre, decodeURIComponent(pre.dataset.mermaid ?? ''), theme, 'after');
  }
}

function place(pre: HTMLElement, source: string, theme: string, how: 'replace' | 'after'): void {
  const put = (drawing: Drawing) => {
    // The page may have been built again while drawing; the call after that refresh draws the new copy.
    if (!pre.isConnected || pre.dataset.drawn) {
      return;
    }
    pre.dataset.drawn = 'true';
    if (how === 'replace' && 'svg' in drawing) {
      pre.replaceWith(diagramElement(drawing));
    } else {
      pre.after(diagramElement(drawing));
    }
  };
  const ready = done.get(`${theme}\n${source}`);
  if (ready) {
    put(ready);
  } else {
    void drawMermaid(source).then(put);
  }
}
