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

/** A folder of changed files, for the tree layout of the Review panel. */
export interface FolderNode {
  /** Shown name; chains of single folders are merged, e.g. `src/pkg/models`. */
  name: string;
  /** Full path of the folder. */
  path: string;
  folders: FolderNode[];
  /** Full paths of the files directly in this folder. */
  files: string[];
}

/** Groups paths into folders, like the Explorer: folders first, then files, by name. */
export function buildFolderTree(paths: string[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: [], files: [] };
  for (const path of paths) {
    let node = root;
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      const sub = node.path ? `${node.path}/${part}` : part;
      let next = node.folders.find(f => f.path === sub);
      if (!next) {
        next = { name: part, path: sub, folders: [], files: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.files.push(path);
  }
  const compact = (node: FolderNode): FolderNode => {
    let n = node;
    while (n.files.length === 0 && n.folders.length === 1) {
      const only = n.folders[0];
      n = { ...only, name: `${n.name}/${only.name}` };
    }
    n.folders = n.folders.map(compact).sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => basename(a).localeCompare(basename(b)));
    return n;
  };
  root.folders = root.folders.map(compact).sort((a, b) => a.name.localeCompare(b.name));
  root.files.sort((a, b) => basename(a).localeCompare(basename(b)));
  return root;
}

/** Files in the order the tree shows them: each folder's subfolders first, then its files. */
export function treeOrder(node: FolderNode): string[] {
  return [...node.folders.flatMap(treeOrder), ...node.files];
}

/** Every folder at every level that holds changed files, by path, with all the files below it. */
export function allFolders(paths: string[]): { path: string; files: string[] }[] {
  const folders = new Map<string, string[]>();
  for (const path of paths) {
    for (let dir = dirname(path); dir; dir = dirname(dir)) {
      folders.set(dir, [...(folders.get(dir) ?? []), path]);
    }
  }
  return [...folders].map(([path, files]) => ({ path, files })).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The review page's tab title. An updated extension finds the file a tab of the previous version
 * shows from it, so its format has to stay the same.
 */
export function pageTitle(path: string, notebook: boolean, pr: number | undefined): string {
  return `${notebook ? '📓' : '📄'} ${basename(path)} · #${pr ?? ''}`;
}

/** The file a review tab shows, from its title: the one file of the pull request it fits, if just one does. */
export function pathFromPageTitle(title: string, pr: number, files: { path: string; notebook: boolean }[]): string | undefined {
  const matches = files.filter(f => pageTitle(f.path, f.notebook, pr) === title);
  return matches.length === 1 ? matches[0].path : undefined;
}
