// Comparing a changed plot with its old version: which old and new images go together, and which
// pixels differ. Pure functions, so they can be tested outside the page.
import type { OutputVM } from './protocol.ts';

export interface ImagePair {
  base: OutputVM;
  head: OutputVM;
}

/**
 * The cell's old and new images, paired in order. Images that didn't change aren't paired: there
 * is nothing to compare.
 */
export function pairImages(base: OutputVM[], head: OutputVM[]): ImagePair[] {
  const images = (list: OutputVM[]) => list.filter(o => o.kind === 'image' && o.imageSrc);
  const b = images(base);
  const h = images(head);
  const pairs: ImagePair[] = [];
  for (let i = 0; i < Math.min(b.length, h.length); i++) {
    if (b[i].hash !== h[i].hash) {
      pairs.push({ base: b[i], head: h[i] });
    }
  }
  return pairs;
}

export interface PixelDiff {
  /** RGBA pixels: changed ones in magenta, the rest a faded grey copy of the new image. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
  changed: number;
  /** The smallest box around the changed pixels. */
  box?: { x: number; y: number; w: number; h: number };
}

/**
 * Compares two RGBA images of the same size. A pixel counts as changed when a channel differs by
 * more than `threshold`, so anti-aliasing noise from re-rendering doesn't light up the plot.
 */
export function diffPixels(before: Uint8ClampedArray, after: Uint8ClampedArray, width: number, height: number, threshold = 24): PixelDiff {
  const pixels = new Uint8ClampedArray(width * height * 4);
  let changed = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const d = Math.max(
        Math.abs(before[i] - after[i]),
        Math.abs(before[i + 1] - after[i + 1]),
        Math.abs(before[i + 2] - after[i + 2]),
        Math.abs(before[i + 3] - after[i + 3]),
      );
      if (d > threshold) {
        changed++;
        pixels[i] = 255;
        pixels[i + 1] = 0;
        pixels[i + 2] = 170;
        pixels[i + 3] = 255;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      } else {
        // Transparent pixels count as white, as plots are shown on white.
        const a = after[i + 3] / 255;
        const grey = (0.299 * after[i] + 0.587 * after[i + 1] + 0.114 * after[i + 2]) * a + 255 * (1 - a);
        const faded = 255 - (255 - grey) * 0.3;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = faded;
        pixels[i + 3] = 255;
      }
    }
  }
  return { pixels, changed, ...(changed ? { box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } } : {}) };
}
