// 14.8: the folder walk behind "Combine a folder" - which PDFs it finds, in what order, what it skips
// and where it stops. Temp trees with invented names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { gather, nameCompare, flatFiles } = require('../electron/gather.cjs');

const tree = (spec: Record<string, string | null>) => {
  const root = mkdtempSync(join(tmpdir(), 'gather-'));
  for (const [rel, body] of Object.entries(spec)) {
    const p = join(root, rel);
    if (body === null) mkdirSync(p, { recursive: true });
    else { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); }
  }
  return root;
};
const names = (r: { files: { name: string }[] }) => r.files.map((f) => f.name);

test('natural order: 2 before 10, case-blind; folders before files at each level', async () => {
  const root = tree({ 'b 10.pdf': 'x', 'b 2.pdf': 'x', 'A.PDF': 'x', 'notes.txt': 'x', 'Sub 10/x.pdf': 'x', 'sub 9/y.pdf': 'x' });
  const r = await gather(root);
  assert.deepEqual(r.tree.folders.map((f: { name: string }) => f.name), ['sub 9', 'Sub 10']);
  assert.deepEqual(names(r.tree), ['A.PDF', 'b 2.pdf', 'b 10.pdf']);
  assert.equal(r.count, 5);
  assert.deepEqual(flatFiles(r.tree).map((p: string) => p.slice(root.length + 1)), [join('sub 9', 'y.pdf'), join('Sub 10', 'x.pdf'), 'A.PDF', 'b 2.pdf', 'b 10.pdf']);
  assert.equal(r.capped, false);
  rmSync(root, { recursive: true, force: true });
});

test('nameCompare matches the order Explorer uses for names', () => {
  const l = ['Sheet 10', 'sheet 2', 'Sheet 1', 'sheet 1a', 'Sheet 01'];
  assert.deepEqual(l.slice().sort(nameCompare).slice(0, 3).map((s) => s.toLowerCase().replace(/^sheet 0?/, '')), ['1', '1', '1a']);
  assert.ok(nameCompare('2', '10') < 0);
  assert.ok(nameCompare('b', 'A') > 0);
});

test('skips dot-names, Office temp files, the recycle bin and system folders; empty folders dropped', async () => {
  const root = tree({ '.hidden/a.pdf': 'x', '.b.pdf': 'x', '~$draft.pdf': 'x', '$RECYCLE.BIN/c.pdf': 'x', 'System Volume Information/d.pdf': 'x', 'empty': null, 'nopdf/readme.txt': 'x', 'ok.pdf': 'x' });
  const r = await gather(root);
  assert.deepEqual(names(r.tree), ['ok.pdf']);
  assert.deepEqual(r.tree.folders, []);
  assert.equal(r.count, 1);
  rmSync(root, { recursive: true, force: true });
});

test('links are never followed (a loop does not hang the walk)', async () => {
  const root = tree({ 'A/one.pdf': 'x' });
  symlinkSync(root, join(root, 'A', 'loop'), 'dir');
  symlinkSync(join(root, 'A', 'one.pdf'), join(root, 'link.pdf'));
  const r = await gather(root);
  assert.equal(r.count, 1);
  assert.deepEqual(r.tree.folders[0].folders, []);
  assert.deepEqual(names(r.tree), []);
  rmSync(root, { recursive: true, force: true });
});

test('an unreadable folder is counted, not fatal', { skip: process.getuid?.() === 0 ? 'root reads everything' : false }, async () => {
  const root = tree({ 'locked/a.pdf': 'x', 'open/b.pdf': 'x' });
  chmodSync(join(root, 'locked'), 0o000);
  const r = await gather(root);
  chmodSync(join(root, 'locked'), 0o755);
  assert.equal(r.count, 1);
  assert.equal(r.unreadable.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('stops at the file cap and at the depth cap, and says so', async () => {
  const spec: Record<string, string> = {};
  for (let i = 0; i < 30; i++) spec[`f${i}.pdf`] = 'x';
  const root = tree(spec);
  const r = await gather(root, { max: 12 });
  assert.equal(r.count, 12);
  assert.equal(r.capped, true);
  rmSync(root, { recursive: true, force: true });
  let deep = '';
  for (let i = 0; i < 6; i++) deep = join(deep, 'd' + i);
  const root2 = tree({ [join(deep, 'z.pdf')]: 'x', 'top.pdf': 'x' });
  const r2 = await gather(root2, { maxDepth: 3 });
  assert.equal(r2.count, 1);
  assert.equal(r2.capped, true);
  rmSync(root2, { recursive: true, force: true });
});

test('cancel stops the walk', async () => {
  const spec: Record<string, string> = {};
  for (let i = 0; i < 40; i++) spec[`d${i}/f.pdf`] = 'x';
  const root = tree(spec);
  const ac = new AbortController();
  let seen = 0;
  const r = await gather(root, { signal: ac.signal, onProgress: (n: number) => { seen = n; if (n >= 3) ac.abort(); } });
  assert.equal(r.cancelled, true);
  assert.ok(r.count < 40 && seen >= 3);
  rmSync(root, { recursive: true, force: true });
});

test('a file given instead of a folder, or a missing path, is refused cleanly', async () => {
  const root = tree({ 'a.pdf': 'x' });
  await assert.rejects(gather(join(root, 'a.pdf')), /not a folder/);
  await assert.rejects(gather(join(root, 'nope')), /not a folder/);
  rmSync(root, { recursive: true, force: true });
});
