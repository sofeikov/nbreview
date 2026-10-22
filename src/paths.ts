export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Path relative to the folder shared by all paths, e.g. `steps/validation.ipynb`. */
export function shortPath(path: string, all: string[]): string {
  const dirs = all.map(dirname);
  let common = dirs[0] ?? '';
  for (const d of dirs) {
    while (common && d !== common && !d.startsWith(common + '/')) {
      common = dirname(common);
    }
  }
  return common ? path.slice(common.length + 1) : path;
}
