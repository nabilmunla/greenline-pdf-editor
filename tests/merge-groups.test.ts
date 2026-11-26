// 14.11: Combine a folder - the combined file's bookmarks nest as the folders did:
// Folder > (sub-folder >) file > the file's own bookmarks. Without folders: as before.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';

function smallPdf(pages: number, mark: string): Uint8Array {
  const d = new mupdf.PDFDocument();
  for (let i = 0; i < pages; i++) d.insertPage(-1, d.addPage([0, 0, 200, 200], 0, {}, ''));
  const it = d.outlineIterator();
  it.insert({ title: mark, uri: '#page=2', open: false });
  return d.saveToBuffer('').asUint8Array().slice();
}
type T = [string, number, ...any[]];
const conv = (items: any[] | undefined): T[] => (items || []).map((x) => [x.title, x.page, ...(x.down ? [conv(x.down)] : [])]);
async function combine(files: { name: string; group?: string[] }[]): Promise<T[]> {
  const st = mu.mergeStart();
  const parts: Uint8Array[] = []; let size = 0;
  const spill = (raw: Uint8Array) => { parts.push(raw.slice()); const at = size; size += raw.length; return at; };
  for (const f of files) {
    const it = mu.mergeFileSteps(st, f.name, smallPdf(2, 'Own ' + f.name), spill, undefined, undefined, f.group);
    for (let r = it.next(); !r.done; r = it.next()) { /* steps */ }
  }
  const all = Buffer.concat(parts); const out: Uint8Array[] = [];
  mu.mergeWrite(st, true, (b) => out.push(typeof b === 'string' ? Buffer.from(b, 'latin1') : b), (off, len) => out.push(all.subarray(off, off + len)));
  mu.mergeDrop(st);
  const d = mupdf.Document.openDocument(new Uint8Array(Buffer.concat(out)), 'application/pdf');
  return conv(d.loadOutline() as any);
}

test('two folders of two files: Folder > file > own bookmarks; loose files stay at the top', async () => {
  const got = await combine([
    { name: 'A1.pdf', group: ['Arch'] }, { name: 'A2.pdf', group: ['Arch'] },
    { name: 'S1.pdf', group: ['Struct'] }, { name: 'S2.pdf', group: ['Struct'] },
    { name: 'Cover.pdf', group: [] },
  ]);
  assert.deepEqual(got, [
    ['Arch', 0, [['A1', 0, [['Own A1.pdf', 1]]], ['A2', 2, [['Own A2.pdf', 3]]]]],
    ['Struct', 4, [['S1', 4, [['Own S1.pdf', 5]]], ['S2', 6, [['Own S2.pdf', 7]]]]],
    ['Cover', 8, [['Own Cover.pdf', 9]]],
  ]);
});

test('sub-folders nest; a folder name met again after another folder starts a new entry', async () => {
  const got = await combine([
    { name: 'P1.pdf', group: ['Arch', 'Plans'] }, { name: 'A1.pdf', group: ['Arch'] },
    { name: 'X.pdf', group: ['Other'] }, { name: 'A9.pdf', group: ['Arch'] },
  ]);
  assert.deepEqual(got.map((x) => x[0]), ['Arch', 'Other', 'Arch']);
  assert.deepEqual((got[0][2] as T[]).map((x) => x[0]), ['Plans', 'A1']);
  assert.deepEqual(((got[0][2] as T[])[0][2] as T[]).map((x) => x[0]), ['P1']);
});

test('no folders: the bookmarks are what Combine made before (one entry per file)', async () => {
  const got = await combine([{ name: 'a.pdf' }, { name: 'b.pdf' }]);
  assert.deepEqual(got, [['a', 0, [['Own a.pdf', 1]]], ['b', 2, [['Own b.pdf', 3]]]]);
});

test('everything in one folder: that folder is the top level (no lone wrapper entry)', async () => {
  const got = await combine([{ name: 'a.pdf', group: ['Job'] }, { name: 'b.pdf', group: ['Job'] }]);
  assert.deepEqual(got.map((x) => x[0]), ['a', 'b']);
});
