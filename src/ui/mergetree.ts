// The Combine list as a tree (14.9): folders hold files and sub-folders, a folder moves as a whole,
// and the result flattens to the file order plus each file's folder path (the nested bookmarks).
// Pure and immutable: every change returns a new tree (or the same one when nothing changed), so
// the dialog's undo-free editing stays simple and React sees each change.

export type MFile = { kind: 'file'; id: string; name: string; path: string; seq: number };
export type MFolder = { kind: 'folder'; id: string; name: string; path: string; seq: number; children: MNode[] };
export type MNode = MFile | MFolder;
export type GatherFolder = { name: string; path: string; folders: GatherFolder[]; files: { name: string; path: string }[] };
export type SortBy = 'name' | 'date' | 'found';

const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const nameCompare = (a: string, b: string): number => coll.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

let next = 0;
const newId = () => 'm' + (++next).toString(36);

/** the walk's tree (gather.cjs): sub-folders first, then the folder's own files - as found */
export function fromGather(g: GatherFolder): MFolder {
  let seq = 0;
  const go = (f: GatherFolder): MFolder => ({
    kind: 'folder', id: newId(), name: f.name, path: f.path, seq: seq++,
    children: [...f.folders.map(go), ...f.files.map((x): MFile => ({ kind: 'file', id: newId(), name: x.name, path: x.path, seq: seq++ }))],
  });
  return go(g);
}

/** a plain selection of files: one flat list (what Combine has always shown) */
export function fromFiles(paths: string[]): MFolder {
  return { kind: 'folder', id: newId(), name: '', path: '', seq: 0, children: paths.map((p, i): MFile => ({ kind: 'file', id: newId(), name: baseName(p), path: p, seq: i + 1 })) };
}

export function findNode(t: MNode, id: string): MNode | null {
  if (t.id === id) return t;
  if (t.kind === 'folder') for (const c of t.children) { const r = findNode(c, id); if (r) return r; }
  return null;
}
const contains = (t: MNode, id: string): boolean => findNode(t, id) !== null;

export function countFiles(t: MNode): number {
  return t.kind === 'file' ? 1 : t.children.reduce((s, c) => s + countFiles(c), 0);
}

/** the tree without node `id` (the same tree if it isn't there) */
export function removeNode(t: MFolder, id: string): MFolder {
  if (!t.children.some((c) => c.id === id || (c.kind === 'folder' && contains(c, id)))) return t;
  return { ...t, children: t.children.filter((c) => c.id !== id).map((c) => (c.kind === 'folder' ? removeNode(c, id) : c)) };
}

function insertInto(t: MFolder, parentId: string, index: number, node: MNode): MFolder {
  if (t.id === parentId) {
    const ch = t.children.slice();
    ch.splice(Math.max(0, Math.min(index, ch.length)), 0, node);
    return { ...t, children: ch };
  }
  return { ...t, children: t.children.map((c) => (c.kind === 'folder' && contains(c, parentId) ? insertInto(c, parentId, index, node) : c)) };
}

/** move node `id` into folder `parentId` at `index` (counted in the folder's list without the
 *  moved node). A folder never goes into itself or below itself; a file is never a target. */
export function moveNode(t: MFolder, id: string, parentId: string, index: number): MFolder {
  const node = findNode(t, id);
  const parent = findNode(t, parentId);
  if (!node || !parent || parent.kind !== 'folder' || node === t) return t;
  if (node.kind === 'folder' && contains(node, parentId)) return t;
  return insertInto(removeNode(t, id), parentId, index, node);
}

/** re-sort every folder: folders first, then files.
 *  name: by name (numbers as numbers); date: files by date modified, oldest first, ties by name
 *  (folders keep name order - a folder has no single date); found: the walk's order. */
export function sortTree(t: MFolder, by: SortBy, dates?: Map<string, number>): MFolder {
  const cmp = (a: MNode, b: MNode): number => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    if (by === 'found') return a.seq - b.seq;
    if (by === 'date' && a.kind === 'file' && b.kind === 'file') {
      const d = (dates?.get(a.path) ?? 0) - (dates?.get(b.path) ?? 0);
      if (d) return d;
    }
    return nameCompare(a.name, b.name);
  };
  return { ...t, children: t.children.map((c) => (c.kind === 'folder' ? sortTree(c, by, dates) : c)).sort(cmp) };
}

/** combine order: each file with the folder names above it (below the root) */
export function flatten(t: MFolder): { path: string; group: string[] }[] {
  const out: { path: string; group: string[] }[] = [];
  const go = (n: MFolder, group: string[]) => {
    for (const c of n.children) {
      if (c.kind === 'file') out.push({ path: c.path, group });
      else go(c, [...group, c.name]);
    }
  };
  go(t, []);
  return out;
}

/** every file's path, in combine order */
export const filePaths = (t: MFolder): string[] => flatten(t).map((x) => x.path);
export const hasFolders = (t: MFolder): boolean => t.children.some((c) => c.kind === 'folder');

/** files at the end of the top level (one already in the list is not added again) */
export function addFiles(t: MFolder, paths: string[]): MFolder {
  const have = new Set(filePaths(t));
  const seq = maxSeq(t);
  const add = [...new Set(paths)].filter((x) => !have.has(x)).map((x, i): MFile => ({ kind: 'file', id: newId(), name: baseName(x), path: x, seq: seq + 1 + i }));
  return add.length ? { ...t, children: [...t.children, ...add] } : t;
}

/** a walked folder at the end of the top level, as a folder (files already in the list left out;
 *  folders left empty by that dropped) */
export function addFolder(t: MFolder, g: GatherFolder): MFolder {
  const have = new Set(filePaths(t));
  const prune = (f: GatherFolder): GatherFolder => ({ ...f, folders: f.folders.map(prune).filter((x) => x.files.length || x.folders.length), files: f.files.filter((x) => !have.has(x.path)) });
  const pg = prune(g);
  if (!pg.files.length && !pg.folders.length) return t;
  const node = fromGather(pg);
  const base = maxSeq(t) + 1;
  const renum = (n: MNode): MNode => (n.kind === 'file' ? { ...n, seq: n.seq + base } : { ...n, seq: n.seq + base, children: n.children.map(renum) });
  return { ...t, children: [...t.children, renum(node)] };
}
function maxSeq(t: MNode): number { return t.kind === 'file' ? t.seq : Math.max(t.seq, ...t.children.map(maxSeq)); }

export interface MRow { node: MNode; depth: number; parentId: string; index: number; /** the file's place in the combined file (files only) */ num?: number; /** folders: files inside */ files?: number }
/** the rows the list shows: folded folders' contents left out (their files still counted) */
export function visibleRows(t: MFolder, folded: Set<string>): MRow[] {
  const out: MRow[] = [];
  let num = 0;
  const go = (f: MFolder, depth: number) => {
    f.children.forEach((c, index) => {
      if (c.kind === 'file') { out.push({ node: c, depth, parentId: f.id, index, num: ++num }); return; }
      out.push({ node: c, depth, parentId: f.id, index, files: countFiles(c) });
      if (folded.has(c.id)) num += countFiles(c); else go(c, depth + 1);
    });
  };
  go(t, 0);
  return out;
}
