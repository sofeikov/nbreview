// DOM helpers shared by the review page and the Overview page: building elements, sanitizing
// HTML from GitHub and notebooks, codicons, and relative times.
import DOMPurify from 'dompurify';

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) {
      continue;
    }
    if (k === 'class') {
      el.className = String(v);
    } else if (k === 'html') {
      el.innerHTML = sanitize(String(v));
    } else if (k === 'text') {
      el.textContent = String(v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2), v as EventListener);
    } else if (k === 'data') {
      for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) {
        if (dv !== undefined) {
          el.dataset[dk] = String(dv);
        }
      }
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids) {
    if (kid !== null && kid !== undefined && kid !== false) {
      el.append(kid);
    }
  }
  return el;
}

export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'input', 'button'] });
}

/** SVGs of the codicons in icons.json, put in at build time. */
declare const __ICONS__: Record<string, string>;

export function icon(name: string): HTMLElement {
  const el = h('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });
  el.innerHTML = __ICONS__[name] ?? '';
  return el;
}

export function button(label: Child | Child[], onclick: (e: MouseEvent) => void, props: Record<string, unknown> = {}): HTMLButtonElement {
  return h('button', { type: 'button', ...props, onclick }, ...(Array.isArray(label) ? label : [label]));
}

export function timeAgo(iso?: string): string {
  if (!iso) {
    return '';
  }
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return fmt.format(Math.round(seconds / size), unit);
    }
  }
  return 'just now';
}

