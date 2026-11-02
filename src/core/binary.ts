// Recognises binary files, and the images among them that the review page can show as pictures.

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/** The image type of a file, from its extension, or undefined when it isn't an image a page can show. */
export function imageMime(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] : undefined;
}

/** Whether a file is binary: like git, a NUL byte near the start says so. */
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** Width and height read from a PNG, GIF or JPEG header; undefined for other types or a header it can't read. */
export function imageSize(bytes: Uint8Array): { w: number; h: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (has(0x89, 0x50, 0x4e, 0x47) && bytes.length >= 24) {
    return { w: view.getUint32(16), h: view.getUint32(20) };
  }
  if (has(0x47, 0x49, 0x46) && bytes.length >= 10) {
    return { w: view.getUint16(6, true), h: view.getUint16(8, true) };
  }
  if (has(0xff, 0xd8)) {
    // Walks the JPEG segments to the frame header (SOF0–SOF15, except the markers that aren't frames).
    let i = 2;
    while (i + 9 < bytes.length && bytes[i] === 0xff) {
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: view.getUint16(i + 7), h: view.getUint16(i + 5) };
      }
      i += 2 + view.getUint16(i + 2);
    }
  }
  return undefined;
}

/** "812 B", "52 KB", "1.4 MB". */
export function formatSize(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${Math.round(n / 1024)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
