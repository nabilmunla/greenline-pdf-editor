// PLAN 10.3a (ENGINE-STUDY-2 R6, and the Insert part of R2): the link test reads the source, not
// the copy (Combine's steps empty a shared action's copy - reading it back failed inside MuPDF);
// Insert / Replace pages copy markups in steps (each its own part of the one undo step) and are
// refused up front when the markups cannot fit in the editing engine's memory. Extract in steps
// to disk is 10.3b. Generated sets only (tests/gen/linkset.mjs).
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { VFile } from '../src/engine/files';
// @ts-expect-error (a plain .mjs generator)
import { makeLinkSet } from './gen/linkset.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-10-3-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
const MB = 2 ** 20;

/** MuPDF's "cannot find object" lines while `f` runs (MuPDF writes its warnings to stderr) */
async function findErrors<T>(f: () => Promise<T>): Promise<{ value: T; lines: number }> {
  let lines = 0;
  const w = process.stderr.write.bind(process.stderr), e = console.error;
  (process.stderr as any).write = (s: unknown, ...a: unknown[]) => { if (/cannot find object/.test(String(s))) lines++; return (w as any)(s, ...a); };
  console.error = (...a: unknown[]) => { if (/cannot find object/.test(a.join(' '))) lines++; e(...a); };
  try { return { value: await f(), lines }; } finally { (process.stderr as any).write = w; console.error = e; }
}
/** Combine's stepped merge of one file (pages: all, or these), as the batch engine runs it - a moment between the steps */
async function combine(file: string, pages?: number[]): Promise<Uint8Array> {
  const st = mu.mergeStart();
  const parts: Uint8Array[] = [];
  let size = 0;
  const spill = (raw: Uint8Array) => { parts.push(raw.slice()); const at = size; size += raw.length; return at; };
  try {
    const it = mu.mergeFileSteps(st, path.basename(file), new VFile({ path: file }), spill, pages);
    for (let r = it.next(); !r.done; r = it.next()) await new Promise((res) => setImmediate(res));
    const all = Buffer.concat(parts);
    const out: Uint8Array[] = [];
    mu.mergeWrite(st, false, (b) => out.push(typeof b === 'string' ? Buffer.from(b, 'latin1') : b), (off, len) => out.push(all.subarray(off, off + len)));
    return new Uint8Array(Buffer.concat(out));
  } finally { mu.mergeDrop(st); }
}
/** a file's links: per page, each one's target (a page number, or the web address) */
function linksOf(b: Uint8Array) {
  const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  const pageNo = new Map<number, number>();
  for (let i = 0; i < d.countPages(); i++) pageNo.set(d.findPage(i).asIndirect(), i);
  const target = (a: mupdf.PDFObject): string => {
    const dest = a.get('Dest'), act = a.get('A');
    const arr = !dest.isNull() ? dest : act.get('S').asName() === 'GoTo' ? act.get('D') : null;
    return arr ? 'page ' + pageNo.get(arr.get(0).asIndirect()) : act.get('URI').asString();
  };
  const pages: string[][] = [];
  let n = 0;
  for (let i = 0; i < d.countPages(); i++) {
    const an = d.findPage(i).get('Annots');
    const l: string[] = [];
    if (an.isArray()) for (let j = 0; j < an.length; j++) { l.push(target(an.get(j).resolve())); n++; }
    pages.push(l);
  }
  return { pages, n };
}

test('10.3a (R6): links to a shared action or destination are kept or dropped by their target, decided from the source - no read of an emptied copy', async () => {
  // (40 sheets of 30 links: Combine writes the markups out 8 sheets at a time, so the shared
  // action's and destination's copies are emptied after the first step)
  const set = path.join(scratch, 'links-40.pdf');
  makeLinkSet(set, 40, 30);
  const all = await findErrors(() => combine(set));
  assert.equal(all.lines, 0, `no "cannot find object" read of an emptied copy (${all.lines})`);
  const a = linksOf(all.value);
  assert.equal(a.n, 40 * 30, 'every link');
  assert.ok(a.pages.every((l) => l[0] === 'page 0' && l[1] === 'page 39'), 'the shared action (sheet 1) and destination (the last) on every sheet');
  // sheet 1 left behind: the shared action goes from every sheet, and sheet 40's links to the next sheet
  const part = await findErrors(() => combine(set, [...Array(39).keys()].map((i) => i + 1)));
  assert.equal(part.lines, 0);
  const p = linksOf(part.value);
  assert.equal(p.n, 39 * 30 - 39 - 3, 'every link but those to sheet 1');
  assert.ok(p.pages.every((l) => l[0] === 'page 38'), 'the shared destination (the last sheet) on every sheet');
  assert.deepEqual(p.pages[0].slice(1, 3), ['page 1', 'https://example.com/sheet/2/3'], 'sheet 2: its link to sheet 3 follows it');
});

/** an open file of `n` plain pages with one markup (the step before the insert) */
function host(id: string, n = 3) {
  const d = new mupdf.PDFDocument();
  for (let i = 0; i < n; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, '0 0 1 RG 60 60 200 200 re S'));
  mu.open(id, d.saveToBuffer('').asUint8Array().slice());
  mu.createAnnot(id, 0, { type: 'Square', rect: [10, 10, 60, 60], color: [1, 0, 0] });
}
const position = (id: string) => mu.journalBothWays(id).quick.position;
const big = path.join(scratch, 'links-1500.pdf');

test('10.3a: 1,500 sheets with 60,000 links inserted into an open file - in steps, one Ctrl+Z takes them all out', () => {
  makeLinkSet(big, 1500, 40);
  host('h');
  const p0 = position('h'), h0 = mu.heap(), t0 = Date.now();
  const r = mu.insertFrom('h', 1, new VFile({ path: big }));
  const ms = Date.now() - t0, parts = position('h') - p0;
  console.log(`   insert of 1,500 sheets / 60,000 links: ${ms} ms, ${parts} parts in the journal, MuPDF ${Math.round(h0 / MB)} -> ${Math.round(mu.heap() / MB)} MB`);
  assert.equal(r.length, 1503);
  // (the pages are grafted in parts of 100 sheets - 15 here, as before; the links now in parts of 8
  // sheets too: before, all 60,000 went in one part - 62.9 s, against 2.7 s)
  assert.ok(parts >= 15 + 10, `the journal moved on by ${parts} parts`);
  const doc = mupdf.Document.openDocument(mu.save('h'), 'application/pdf').asPDF()!;
  let links = 0;
  for (let i = 1; i <= 1500; i++) { const a = doc.findPage(i).get('Annots'); if (a.isArray()) links += a.length; }
  assert.equal(links, 60000, 'every link came along');
  assert.deepEqual(mu.history('h').undo.length, 2, 'one undo step for the insert');
  assert.equal(mu.undo('h').ok, true);
  assert.equal(mu.pageInfos('h').length, 3, 'one undo takes every inserted page out');
  assert.equal(position('h'), p0, 'the journal back where it was');
  assert.equal(mu.undo('h').ok, true);
  assert.equal(position('h'), p0 - 1, 'the second undo takes the markup before it');
  mu.close('h');
});

test('10.3a: an insert that cannot fit is refused before anything is copied; one that outgrows its room is put back', () => {
  if (!fs.existsSync(big)) makeLinkSet(big, 1500, 40);
  host('r');
  const p0 = position('r'), pages0 = mu.pageInfos('r').length;
  try {
    // 60,000 links at 1.4 KB each do not fit in 10 MB more than MuPDF has now
    mu.setInsertRoom(mu.heap() + 10 * MB);
    assert.throws(() => mu.insertFrom('r', 1, new VFile({ path: big })), (e: Error) => e.message === mu.TOO_MANY_MARKUPS);
    assert.equal(mu.pageInfos('r').length, pages0, 'no page came in');
    assert.equal(position('r'), p0, 'the journal did not move');
    // (Replace pages too)
    assert.throws(() => mu.replacePages('r', [1], { bytes: new VFile({ path: big }) }), (e: Error) => e.message === mu.TOO_MANY_MARKUPS);
    assert.equal(position('r'), p0);
    // what fits still goes in: a few sheets
    assert.equal(mu.insertFrom('r', 1, new VFile({ path: big }), [0, 1]).length, pages0 + 2);
    assert.equal(mu.undo('r').ok, true);
    // the room runs out between the steps: the step throws, the file is as it was
    mu.setInsertRoom(Infinity, mu.heap() - 1);
    assert.throws(() => mu.insertFrom('r', 1, new VFile({ path: big })), (e: Error) => e.message === mu.TOO_MANY_MARKUPS);
    assert.equal(mu.pageInfos('r').length, pages0, 'the pages grafted so far are taken out again');
    assert.equal(position('r'), p0, 'the parts already made are undone');
  } finally { mu.setInsertRoom(); }
  // a markup can still be added, and undone; the one before the insert is still there
  mu.createAnnot('r', 2, { type: 'Square', rect: [10, 10, 60, 60], color: [0, 0, 1] });
  assert.equal(position('r'), p0 + 1);
  assert.equal(mu.undo('r').ok, true);
  assert.equal(mu.undo('r').ok, true, 'and the markup before the insert');
  assert.equal(position('r'), p0 - 1);
  mu.close('r');
});

test('14.5: an insert refused because the editing engine itself is past its limit says so, not "too many links and markups"', () => {
  // a sheet with no links at all: the markups cannot be the reason
  const plain = path.join(scratch, 'plain-3.pdf');
  makeLinkSet(plain, 3, 0);
  host('m');
  const p0 = position('m'), pages0 = mu.pageInfos('m').length;
  const MEMORY_TEXT = 'The editing engine is nearly out of memory, so nothing was inserted. Restart it (the app asks; the line in the status bar does the same), then insert again.';
  try {
    mu.setInsertRoom(mu.heap() - 1);
    assert.throws(() => mu.insertFrom('m', 1, new VFile({ path: plain }), [0]), (e: Error) => e.message === MEMORY_TEXT);
    assert.throws(() => mu.replacePages('m', [1], { bytes: new VFile({ path: plain }) }), (e: Error) => e.message === MEMORY_TEXT);
    assert.equal(mu.pageInfos('m').length, pages0, 'no page came in');
    assert.equal(position('m'), p0, 'the journal did not move');
  } finally { mu.setInsertRoom(); }
  mu.close('m');
});
