'use strict';
// "Combine a folder": the walk that finds the PDFs under a folder (14.8). Async and cancellable, so
// a big share never blocks the app. Order per level as Explorer's default name sort: folders first,
// then files, names compared with numbers as numbers and case ignored ("2" before "10").
// Links and junctions are never followed (a loop can't hang the walk, and a link can't pull in files
// from elsewhere). Hidden things are skipped by name: dot-names, Office's "~$" temp files, the
// recycle bin and "System Volume Information" (the Windows hidden attribute needs a shell call per
// file - slow on a share and fragile with non-Latin names). Unreadable folders are counted and
// passed over. The walk only reads: nothing is written anywhere near the sources.
const fsp = require('node:fs/promises');
const path = require('node:path');

const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Explorer-like name order (also the order Combine has always used for a selection) */
const nameCompare = (a, b) => coll.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information']);
const skipped = (name, dir) => name.startsWith('.') || name.startsWith('~$') || (dir && SKIP_DIRS.has(name.toLowerCase()));
const isPdf = (name) => /\.pdf$/i.test(name);

/**
 * @param {string} root the folder
 * @param {{ max?: number, maxDepth?: number, signal?: AbortSignal, onProgress?: (found: number) => void }} [o]
 * @returns {Promise<{ root: string, tree: Folder, count: number, capped: boolean, cancelled: boolean, unreadable: string[] }>}
 * Folder = { name, path, folders: Folder[], files: { name, path }[] } - folders without PDFs are left out.
 */
async function gather(root, o = {}) {
  const max = o.max ?? 5000;
  const maxDepth = o.maxDepth ?? 32;
  let st;
  try { st = await fsp.stat(root); } catch (_) { st = null; }
  if (!st || !st.isDirectory()) throw new Error('not a folder: ' + root);
  const res = { root, tree: null, count: 0, capped: false, cancelled: false, unreadable: [] };
  let full = false; // the file cap stops the whole walk; the depth cap only that branch
  const stop = () => full || res.cancelled || (o.signal?.aborted && (res.cancelled = true));

  async function walk(dir, depth) {
    const node = { name: path.basename(dir) || dir, path: dir, folders: [], files: [] };
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { res.unreadable.push(dir); return node; }
    const dirs = [];
    const files = [];
    for (const e of ents) {
      if (e.isSymbolicLink()) continue; // links and junctions: never followed
      if (e.isDirectory()) { if (!skipped(e.name, true)) dirs.push(e.name); }
      else if (e.isFile() && isPdf(e.name) && !skipped(e.name, false)) files.push(e.name);
    }
    dirs.sort(nameCompare);
    files.sort(nameCompare);
    for (const d of dirs) {
      if (stop()) return node;
      if (depth + 1 > maxDepth) { res.capped = true; continue; }
      const sub = await walk(path.join(dir, d), depth + 1);
      if (sub.files.length || sub.folders.length) node.folders.push(sub);
    }
    for (const f of files) {
      if (stop()) return node;
      if (res.count >= max) { res.capped = true; full = true; return node; }
      node.files.push({ name: f, path: path.join(dir, f) });
      res.count++;
      o.onProgress?.(res.count);
    }
    return node;
  }
  res.tree = await walk(root, 0);
  stop();
  return res;
}

/** the tree as one list, in combine order (each folder's sub-folders, then its own files) */
function flatFiles(node) {
  const out = [];
  const go = (n) => { for (const f of n.folders) go(f); for (const f of n.files) out.push(f.path); };
  go(node);
  return out;
}

module.exports = { gather, nameCompare, flatFiles };
