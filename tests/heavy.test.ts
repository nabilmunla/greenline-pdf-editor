// The merge of a heavy page's content (heavy.ts): the merger must not wait for ever for its deflate.
// PLAN 10.10 (H1): a heavy sheet changed in this session is still merged for display.
import '../src/engine/mupdf-pre.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { makeMerger, countStrokes } from '../src/engine/heavy';
import { lastXref } from '../src/engine/overlay';

test('10.17: a deflate that fails while the merger waits for it makes the merger reject', async () => {
  // enough strokes that the merged output is written while the input is still being read
  const lines: string[] = [];
  for (let i = 0; i < 300000; i++) lines.push(`${i % 900} ${i % 700} m ${(i % 900) + 2} ${(i % 700) + 2} l S`);
  const part = zlib.deflateSync(Buffer.from(lines.join('\n')));
  // the deflate reports "full" at once (the merger waits for its drain), then fails: never a drain
  const realCreate = zlib.createDeflate;
  const patched = ((opts?: zlib.ZlibOptions) => {
    const d = realCreate(opts);
    const write = d.write.bind(d);
    let armed = false;
    (d as unknown as { write: (chunk: Buffer) => boolean }).write = (chunk: Buffer) => {
      write(chunk);
      if (!armed) { armed = true; setTimeout(() => d.emit('error', new Error('deflate failed')), 5); }
      return false;
    };
    return d;
  }) as typeof zlib.createDeflate;
  Object.defineProperty(zlib, 'createDeflate', { value: patched, writable: true, configurable: true });
  try {
    const outcome = await Promise.race([
      makeMerger(undefined, 1)([part], true).then(() => 'settled', () => 'rejected'),
      new Promise<string>((res) => setTimeout(() => res('still waiting'), 1000)),
    ]);
    assert.equal(outcome, 'rejected');
  } finally {
    Object.defineProperty(zlib, 'createDeflate', { value: realCreate, writable: true, configurable: true });
  }
});

// ---------------------------------------------------------------- 10.10

const dir = mkdtempSync(join(tmpdir(), 'h1010-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let stored = 0;
/** merged line work kept in a temp file, as the engine host does */
const store = (b: Uint8Array) => { const p = join(dir, `m${stored++}.bin`); writeFileSync(p, b); return { path: p, size: b.length }; };
const SECRET = 'HIDDENWORD';

/**
 * A generated sheet (invented content): `strokes` short strokes in hatch-like runs, written the way
 * traced / CAD exports write them ("x y m x y l S"), Flate-compressed in one content stream; with a
 * word drawn in the lower left (user space 100,100). One page, 1190 x 842.
 */
function sheet(strokes = 60_000, seed = 3): Uint8Array {
  let r = seed;
  const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
  const out: string[] = ['0 0 0 RG 0.3 w'];
  for (let i = 0; i < strokes;) {
    const cx = 250 + rnd() * 900, cy = 200 + rnd() * 600, run = Math.min(strokes - i, 200 + Math.floor(rnd() * 800));
    let x = cx, y = cy;
    for (let k = 0; k < run; k++, i++) {
      if (k % 60 === 0) { x = cx + rnd() * 40 - 20; y = cy + rnd() * 40 - 20; }
      out.push(`${x.toFixed(2)} ${y.toFixed(2)} m ${(x + 1.6).toFixed(2)} ${(y + 0.9).toFixed(2)} l S`);
      x += 2.4; y += 1.35;
    }
  }
  out.push(`BT /F1 24 Tf 100 100 Td (${SECRET}) Tj ET`);
  const d = new mupdf.PDFDocument();
  const fonts = d.newDictionary();
  fonts.put('F1', d.addSimpleFont(new mupdf.Font('Helvetica')));
  const res = d.newDictionary();
  res.put('Font', fonts);
  const dict = d.newDictionary();
  dict.put('Filter', d.newName('FlateDecode'));
  const content = d.addRawStream(zlib.deflateSync(Buffer.from(out.join('\n'))), dict);
  const pg = d.addPage([0, 0, 1190, 842], 0, res, '');
  pg.put('Contents', content);
  d.insertPage(-1, pg);
  return d.saveToBuffer('').asUint8Array().slice();
}
/** the page's content streams (object numbers) as the file has them */
const contentsOf = (b: Uint8Array, page = 0) => {
  const doc = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  const c = doc.findPage(page).get('Contents');
  return c.isArray() ? [...Array(c.length).keys()].map((k) => c.get(k).asIndirect()) : [c.asIndirect()];
};
/** the drawing engines' copy: the document as it is now + the display update (as host.ts drawSnapshot makes it) */
function drawingCopy(id: string): Uint8Array {
  let snap = new Uint8Array(0);
  mu.snapshotTo(id, (v) => { snap = v.slice(); }, true);
  const extra = mu.displayOverlay(id, snap.length, lastXref(snap.subarray(Math.max(0, snap.length - 4096))));
  assert.ok(extra, 'a display update');
  const parts: Uint8Array[] = [snap];
  for (const x of extra) parts.push('bytes' in x ? x.bytes : new Uint8Array(readFileSync(x.path)));
  return new Uint8Array(Buffer.concat(parts));
}
/** page `page` of a file as MuPDF reads it: its strokes, its text, its content stream objects */
function look(b: Uint8Array, page = 0) {
  const doc = mupdf.Document.openDocument(b, 'application/pdf');
  const pdf = doc.asPDF()!;
  const c = pdf.findPage(page).get('Contents');
  const list = c.isArray() ? [...Array(c.length).keys()].map((k) => c.get(k)) : [c];
  let strokes = 0;
  for (const s of list) strokes += countStrokes(Buffer.from(s.readStream().asUint8Array()));
  return { strokes, text: doc.loadPage(page).toStructuredText().asText(), streams: list.map((s) => s.asIndirect()) };
}
const numbers = [{ kind: 'text' as const, text: 'No. {page}', size: 30, color: [1, 0, 0] as [number, number, number], pos: 'br' as const }];
const ctx = { file: 'sheet.pdf', date: '17 Nov' };

/** the bar lowered (a sheet of 60,000 strokes counts as heavy), a merger and a store as the engine host's */
async function lowered(f: () => Promise<void>) {
  mu.setContentMerger(makeMerger(undefined, 20_000));
  mu.setDisplayStore(store);
  mu.setHeavyRaw(1000);
  try { await f(); } finally { mu.setContentMerger(null); mu.setDisplayStore(null); mu.setHeavyRaw(2e6); }
}

test('10.10 (a): a heavy sheet numbered before it was looked at is still a candidate - its line work only, merged from the file', () => lowered(async () => {
  const bytes = sheet();
  const [line] = contentsOf(bytes);
  assert.ok(mu.open('a', bytes).look);
  mu.markPages('a', numbers, ctx);
  const r = mu.heavyCandidates('a', [0]);
  assert.equal(r.candidates.length, 1, 'still a candidate: ' + JSON.stringify(r));
  const c = r.candidates[0];
  assert.deepEqual(c.streams, [line], 'only the line-work stream (not the wrappers or the number)');
  assert.ok(!c.local, 'its line work is in the file as opened: merged in the batch engine');
  // (the batch engine's way: from the file as opened)
  const f = await mu.mergeForDisplay(bytes, c.streams);
  assert.ok(f, 'merged');
  assert.equal(mu.attachDisplay('a', 0, c.key, c.streams, f!), true);
  const before = look(bytes), now = look(drawingCopy('a'));
  assert.ok(before.strokes >= 60_000 && now.strokes < before.strokes / 50, `drawn merged: strokes ${before.strokes} -> ${now.strokes}`);
  assert.match(now.text, /No\. 1/, 'and the number is drawn with it');
  mu.close('a');
  // Simplify follows the same rule (it failed on such a page: "can't be simplified")
  mu.setHeavyRaw(30e6);
  mu.open('a2', bytes);
  mu.markPages('a2', numbers, ctx);
  assert.equal(await mu.simplifyPage('a2', 0), true, 'a numbered sheet can be simplified');
  assert.ok(look(drawingCopy('a2')).strokes < before.strokes / 50);
  mu.close('a2');
}));

test('10.10 (b): a sheet merged and then numbered keeps its merge: no candidate, no second merge, the overlay still swaps its line work', () => lowered(async () => {
  const bytes = sheet();
  mu.open('b', bytes);
  const c = mu.heavyCandidates('b', [0]).candidates[0];
  assert.ok(c);
  const f = await mu.mergeForDisplay(bytes, c.streams);
  assert.equal(mu.attachDisplay('b', 0, c.key, c.streams, f!), true);
  const files = readdirSync(dir).length;
  mu.markPages('b', numbers, ctx);
  assert.deepEqual(mu.heavyCandidates('b', [0]), { candidates: [], shown: [] }, 'nothing to merge or redraw for it');
  assert.equal(await mu.mergeLocal('b', 0).then((x) => x?.path), f!.path, 'asked to merge it here: the merge it has');
  assert.equal(readdirSync(dir).length, files, 'no second temp file');
  assert.deepEqual(mu.displayFiles('b'), [f!.path]);
  const now = look(drawingCopy('b'));
  assert.ok(now.strokes < 60_000 / 50, 'drawn from the merged line work: ' + now.strokes);
  assert.ok(!now.streams.includes(c.streams[0]), 'its line-work stream swapped for the merged one');
  assert.match(now.text, /No\. 1/);
  mu.close('b');
}));

test('10.10 (c): a redacted heavy sheet (new, unfiltered content) is merged here; the merged copy has no text under the mark', () => lowered(async () => {
  const bytes = sheet();
  assert.match(look(bytes).text, new RegExp(SECRET), 'the word is in the file');
  mu.open('c', bytes);
  // (MuPDF's page space: y down - the word's baseline is at 842 - 100)
  mu.createAnnot('c', 0, { type: 'Redact', rect: [90, 700, 260, 752] });
  assert.equal(mu.applyRedactions('c'), 1);
  const r = mu.heavyCandidates('c', [0]);
  assert.equal(r.candidates.length, 1, 'still a candidate: ' + JSON.stringify(r));
  const c = r.candidates[0];
  assert.equal(c.local, true, 'its content is not in the file as opened: merged in the editing engine');
  assert.ok(!contentsOf(bytes).includes(c.streams[0]), 'the line work is the new content');
  const f = await mu.mergeLocal('c', 0);
  assert.ok(f, 'merged and attached');
  assert.deepEqual(mu.displayFiles('c'), [f!.path]);
  assert.deepEqual(mu.heavyCandidates('c', [0]), { candidates: [], shown: [] }, 'drawn merged from now on');
  const merged = zlib.inflateSync(readFileSync(f!.path)).toString('latin1');
  assert.ok(!merged.includes(SECRET), 'the merged content holds no trace of the word');
  const now = look(drawingCopy('c'));
  assert.ok(now.strokes < 60_000 / 50, 'drawn merged: ' + now.strokes);
  assert.ok(!now.text.includes(SECRET), 'no text under the mark in what is drawn');
  mu.close('c');
}));

test('10.10 (d): a heavy sheet inserted from another file and not saved is merged here (the file as opened has no such objects)', () => lowered(async () => {
  const host = sheet(60_000, 3), other = sheet(70_000, 11);
  mu.open('d', host);
  mu.insertFrom('d', 1, other);
  const r = mu.heavyCandidates('d', [0, 1]);
  assert.deepEqual(r.candidates.map((c) => c.page), [0, 1]);
  assert.ok(!r.candidates[0].local, 'its own sheet: from the file');
  const c = r.candidates[1];
  assert.equal(c.local, true, 'the inserted sheet: merged in the editing engine');
  // (what the batch engine would have done: those objects are not in the file as opened)
  await assert.rejects(async () => { if (!(await mu.mergeForDisplay(host, c.streams))) throw new Error('nothing merged'); });
  const f = await mu.mergeLocal('d', 1);
  assert.ok(f, 'merged and attached');
  const copy = drawingCopy('d');
  assert.ok(look(copy, 1).strokes < 70_000 / 50, 'drawn merged: ' + look(copy, 1).strokes);
  assert.ok(look(copy, 0).strokes >= 60_000, 'its own sheet is not merged (not asked for)');
  mu.close('d');
}));

test('10.10b: a heavy sheet that comes into a light file is looked at from then on - from a file, from an open file, as a revised sheet', () => lowered(async () => {
  const light = (opts = '') => { const d = new mupdf.PDFDocument(); d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, '0 0 1 RG 60 60 200 200 re S')); return d.saveToBuffer(opts).asUint8Array().slice(); };
  const heavy = sheet(70_000, 11);
  assert.ok(light().length < 1000 && heavy.length >= 1000, 'light under the bar, heavy over it');
  const ids: string[] = [];
  const open = (id: string, b: Uint8Array, pw?: string) => { mu.open(id, b, pw); ids.push(id); };
  try {
    // from a file
    open('b1', light());
    mu.insertFrom('b1', 1, heavy);
    // (before: o.look was set once, at open - the inserted sheet was never a candidate, drawn stroke by stroke)
    assert.deepEqual(mu.heavyCandidates('b1', [0, 1]).candidates.map((c) => [c.page, c.local]), [[1, true]], 'the inserted sheet is a candidate, merged here');
    assert.equal(mu.looking('b1'), true, 'the file is looked at once a heavy sheet came in');
    assert.ok(await mu.mergeLocal('b1', 1), 'and merged');
    // from a file open here that is looked at
    open('src', heavy);
    assert.equal(mu.looking('src'), true);
    open('b2', light());
    mu.insertFromOpen('b2', 0, 'src');
    assert.equal(mu.looking('b2'), true);
    assert.deepEqual(mu.heavyCandidates('b2', [0, 1]).candidates.map((c) => c.page), [0]);
    // a revised sheet in place of a light one
    open('b3', light());
    mu.replacePages('b3', [0], { bytes: heavy });
    assert.equal(mu.looking('b3'), true);
    assert.deepEqual(mu.heavyCandidates('b3', [0]).candidates.map((c) => c.page), [0]);
    // light pages in: nothing changes (from a file, from a light open file)
    open('b4', light());
    assert.equal(mu.looking('b4'), false, 'a light file is not looked at');
    open('l', light());
    mu.insertFrom('b4', 1, light());
    mu.insertFromOpen('b4', 0, 'l');
    assert.equal(mu.looking('b4'), false, 'light pages in: still not looked at');
    // a file opened with its password: never looked at (no decrypted copy of it is written)
    open('b5', light('encrypt=aes-256,user-password=pw,owner-password=pw'), 'pw');
    mu.insertFrom('b5', 1, heavy);
    assert.equal(mu.looking('b5'), false, 'a file opened with its password stays as at open');
  } finally { for (const id of ids) mu.close(id); }
}));
