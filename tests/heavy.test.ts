// The merge of a heavy page's content (heavy.ts): the merger must not wait for ever for its deflate.
// PLAN 10.10 (H1): a heavy sheet changed in this session is still merged for display.
// PLAN 14.4: what an edit wrote anew counts as put in (the drawing copy and a save go in pieces).
// PLAN 14.8: a save in pieces packs what was written unpacked.
import '../src/engine/mupdf-pre.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { makeMerger, countStrokes } from '../src/engine/heavy';
import { lastXref } from '../src/engine/overlay';
import { VFile } from '../src/engine/files';

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

// ---------------------------------------------------------------- 14.1

/** the merged-line-work files the drawing copy names now (as host.ts drawSnapshot gives them) */
function named(id: string): string[] {
  let snap = new Uint8Array(0);
  mu.snapshotTo(id, (v) => { snap = v.slice(); }, true);
  const extra = mu.displayOverlay(id, snap.length, lastXref(snap.subarray(Math.max(0, snap.length - 4096)))) ?? [];
  return extra.flatMap((x) => ('path' in x ? [x.path] : []));
}
/** the sheet open as `id`, merged in the batch engine's way (file A) */
async function mergedSheet(id: string) {
  const bytes = sheet();
  mu.open(id, bytes);
  const c = mu.heavyCandidates(id, [0]).candidates[0];
  assert.ok(c && !c.local, 'a candidate from the file as opened');
  const A = await mu.mergeForDisplay(bytes, c.streams);
  assert.ok(A, 'merged');
  assert.equal(mu.attachDisplay(id, 0, c.key, c.streams, A!), true);
  assert.deepEqual(named(id), [A!.path], 'the drawing copy names A');
  return { bytes, c, A: A!.path };
}
/** a redaction across the line work, applied (two undo steps: the mark, its application) */
function redact(id: string) {
  mu.createAnnot(id, 0, { type: 'Redact', rect: [400, 250, 700, 450] });
  assert.equal(mu.applyRedactions(id), 1);
}

test('14.1 (a): redaction applied on a merged sheet - its merged copy is let go; two Undos make the sheet a candidate again, with its first streams', () => lowered(async () => {
  const { c, A } = await mergedSheet('ea');
  redact('ea');
  assert.deepEqual(named('ea'), [], 'the drawing copy no longer names A');
  assert.deepEqual(mu.dropDisplay('ea', [A]), [A], 'A is let go');
  assert.deepEqual(mu.displayFiles('ea'), [], 'no entry names it');
  assert.ok(mu.undo('ea').ok && mu.undo('ea').ok);
  // (0.13.0: no candidate - the entry still named A, a file the window had deleted)
  const r = mu.heavyCandidates('ea', [0]);
  assert.deepEqual(r.candidates.map((x) => [x.page, x.streams, !!x.local]), [[0, c.streams, false]], 'a candidate again, from the file as opened: ' + JSON.stringify(r));
  mu.close('ea');
}));

test('14.1 (b): merged, nothing edited - dropDisplay keeps the entry, the drawing copy still swaps the line work', () => lowered(async () => {
  const { c, A } = await mergedSheet('eb');
  assert.deepEqual(mu.dropDisplay('eb', [A]), [], 'in use: not let go');
  assert.deepEqual(mu.displayFiles('eb'), [A]);
  assert.deepEqual(named('eb'), [A]);
  const now = look(drawingCopy('eb'));
  assert.ok(now.strokes < 60_000 / 50, 'drawn merged: ' + now.strokes);
  assert.ok(!now.streams.includes(c.streams[0]), 'its line-work stream swapped for the merged one');
  mu.close('eb');
}));

test('14.1 (c): redaction applied and merged here (file B), two Undos, B let go; two Redos make the redacted sheet a candidate again (local)', () => lowered(async () => {
  const bytes = sheet();
  mu.open('ec', bytes);
  redact('ec');
  const c = mu.heavyCandidates('ec', [0]).candidates[0];
  assert.ok(c && c.local);
  const B = (await mu.mergeLocal('ec', 0))?.path;
  assert.ok(B, 'merged');
  assert.deepEqual(named('ec'), [B]);
  assert.ok(mu.undo('ec').ok && mu.undo('ec').ok);
  assert.deepEqual(named('ec'), [], 'the sheet shows its first content: B is not named');
  assert.deepEqual(mu.dropDisplay('ec', [B!]), [B], 'B is let go');
  assert.deepEqual(mu.displayFiles('ec'), []);
  assert.ok(mu.redo('ec').ok && mu.redo('ec').ok);
  // (0.13.0: no candidate - drawn from B, which the window had deleted)
  const r = mu.heavyCandidates('ec', [0]);
  assert.deepEqual(r.candidates.map((x) => [x.page, x.streams, x.local]), [[0, c.streams, true]], 'the redacted sheet is a candidate again, merged here: ' + JSON.stringify(r));
  mu.close('ec');
}));

test('14.1 (d): an Undo before the drop - the entry is in use again: kept, its file not let go, the drawing copy names it', () => lowered(async () => {
  const { A } = await mergedSheet('ed');
  redact('ed');
  assert.deepEqual(named('ed'), []);
  assert.ok(mu.undo('ed').ok && mu.undo('ed').ok);
  assert.deepEqual(mu.dropDisplay('ed', [A]), [], 'shown again: kept');
  assert.deepEqual(mu.displayFiles('ed'), [A]);
  assert.deepEqual(named('ed'), [A], 'the drawing copy names A');
  assert.deepEqual(mu.heavyCandidates('ed', [0]), { candidates: [], shown: [] }, 'drawn merged, nothing to merge');
  mu.close('ed');
}));

test('14.1 (e): (a) with a text edit in place of the redaction', () => lowered(async () => {
  const { c, A } = await mergedSheet('ee');
  const line = mu.textBlocks('ee', 0).flatMap((b) => b.lines).find((l) => l.text.includes(SECRET));
  assert.ok(line, 'the word on the sheet');
  mu.replaceText('ee', 0, [line!.bbox], 'EDITED', line!.origin, { size: line!.size, color: line!.color }, line!.dir);
  assert.deepEqual(named('ee'), [], 'the drawing copy no longer names A');
  assert.deepEqual(mu.dropDisplay('ee', [A]), [A], 'A is let go');
  assert.deepEqual(mu.displayFiles('ee'), []);
  // (one undo step: the edit)
  assert.ok(mu.undo('ee').ok);
  const r = mu.heavyCandidates('ee', [0]);
  assert.deepEqual(r.candidates.map((x) => [x.page, x.streams, !!x.local]), [[0, c.streams, false]], 'a candidate again, from the file as opened: ' + JSON.stringify(r));
  mu.close('ee');
}));

// ---------------------------------------------------------------- 14.4

/**
 * The drawing copy as the engine host asks for it of a document opened from a file: 'pieces' (a
 * whole copy written object by object) or 'one buffer' (MuPDF's "original + changes", built whole
 * in its memory); the pieces are opened again (pages counted)
 */
function copyWay(id: string): { way: string; pages: number } {
  const parts: Uint8Array[] = [];
  let pieces = false, buffers = 0;
  mu.snapshotTo(id, () => { buffers++; }, false, (fill) => { pieces = true; fill((b) => parts.push(typeof b === 'string' ? Buffer.from(b, 'latin1') : b.slice())); });
  let pages = 0;
  if (pieces) { const d = mupdf.Document.openDocument(Buffer.concat(parts), 'application/pdf'); pages = d.countPages(); d.destroy?.(); }
  return { way: pieces ? 'pieces' : buffers === 1 ? 'one buffer' : `${buffers} buffers`, pages };
}
/** a sheet with over 30 MB of content unpacked (1 million strokes, about 34 MB; the file about 11 MB) */
let bigSheetFile = '';
function bigSheet(): string {
  if (!bigSheetFile) { bigSheetFile = join(dir, 'big-sheet.pdf'); writeFileSync(bigSheetFile, sheet(1_000_000, 5)); }
  assert.ok(statSync(bigSheetFile).size < 30e6, 'the file itself is under the bar');
  return bigSheetFile;
}
/** wholeAt and the piece-wise save lowered to 30 MB for `f` */
async function at30(f: () => void | Promise<void>) {
  mu.setWholeAt(30e6);
  mu.setStreamSaveForTests(30e6);
  try { await f(); } finally { mu.setWholeAt(600e6); mu.setStreamSaveForTests(0); }
}
/** a save as the editing engine writes it (no sink: bytes) - in pieces: one plain cross-reference table, no object streams */
const savedInPieces = (b: Uint8Array) => { const t = Buffer.from(b.subarray(Math.max(0, b.length - (1 << 20)))).toString('latin1'); return /\nxref\n0 \d+\n/.test(t) && !/\/ObjStm/.test(Buffer.from(b.subarray(0, 1 << 20)).toString('latin1')); };

test('14.4 (a): a markup alone keeps the copy in one buffer; a redaction (its content written anew, unpacked) makes the copy and a save go in pieces', () => at30(() => {
  mu.open('ra', new VFile({ path: bigSheet() }));
  try {
    mu.createAnnot('ra', 0, { type: 'Square', rect: [50, 50, 200, 200], color: [1, 0, 0] });
    assert.equal(copyWay('ra').way, 'one buffer', 'a markup alone: "original + changes", as before');
    mu.createAnnot('ra', 0, { type: 'Redact', rect: [400, 250, 700, 450] });
    assert.equal(mu.applyRedactions('ra'), 1);
    // (0985986: one buffer - the file and the page's whole content, unpacked, built in MuPDF's memory)
    assert.deepEqual(copyWay('ra'), { way: 'pieces', pages: 1 }, 'after a redaction: written in pieces');
    assert.ok(savedInPieces(mu.save('ra')), 'a save too: in pieces');
  } finally { mu.close('ra'); }
}));

test('14.4 (b): a text edit (its page content written anew) makes the copy go in pieces', () => at30(() => {
  mu.open('rb', new VFile({ path: bigSheet() }));
  try {
    const line = mu.textBlocks('rb', 0).flatMap((b) => b.lines).find((l) => l.text.includes(SECRET));
    assert.ok(line, 'the word on the sheet');
    mu.replaceText('rb', 0, [line!.bbox], 'EDITED', line!.origin, { size: line!.size, color: line!.color }, line!.dir);
    // (0985986: one buffer)
    assert.deepEqual(copyWay('rb'), { way: 'pieces', pages: 1 }, 'after a text edit: written in pieces');
  } finally { mu.close('rb'); }
}));

// ---------------------------------------------------------------- 14.8

/** a save's bytes written to the temp folder and opened from there as `id`, as a file on disk is */
function reopen(id: string, b: Uint8Array) {
  const f = join(dir, id + '.pdf');
  writeFileSync(f, b);
  mu.open(id, new VFile({ path: f }));
}
/** the sheet's biggest content stream in a saved file: its filter and its length there */
function sheetContent(b: Uint8Array) {
  const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  try {
    const c = d.findPage(0).get('Contents');
    const s = (c.isArray() ? [...Array(c.length).keys()].map((k) => c.get(k)) : [c]).sort((x, y) => y.get('Length').asNumber() - x.get('Length').asNumber())[0];
    return { filter: String(s.get('Filter')), length: s.get('Length').asNumber() };
  } finally { d.destroy?.(); }
}
/** the page's text as the editing engine reads it */
const textOf = (id: string) => mu.textBlocks(id, 0).flatMap((b) => b.lines).map((l) => l.text).join(' ');

for (const how of ['redaction', 'text edit'] as const) {
  test(`14.8: after a ${how}, a save in pieces packs the sheet's content; the file opens again as a sheet like any other`, () => lowered(() => at30(() => {
    const id = how === 'redaction' ? 'pa' : 'pb';
    mu.open(id, new VFile({ path: bigSheet() }));
    let word = SECRET;
    try {
      if (how === 'redaction') redact(id);
      else {
        const line = mu.textBlocks(id, 0).flatMap((b) => b.lines).find((l) => l.text.includes(SECRET));
        assert.ok(line, 'the word on the sheet');
        mu.replaceText(id, 0, [line!.bbox], 'EDITED', line!.origin, { size: line!.size, color: line!.color }, line!.dir);
        word = 'EDITED';
      }
      // (the same document saved whole by MuPDF's own writer, for its size)
      const whole = mu.save(id, { clearMetadata: true });
      const pieces = mu.save(id);
      assert.ok(savedInPieces(pieces), 'saved in pieces (what an edit wrote counts as put in: 14.4)');
      const c = sheetContent(pieces);
      // (14.4 alone: no filter - the content as MuPDF wrote it, 4 times the whole save)
      assert.equal(c.filter, '/FlateDecode', `the sheet's content packed (${c.length} bytes)`);
      assert.ok(pieces.length < 1.5 * whole.length, `under 1.5 x the whole save: ${pieces.length} against ${whole.length}`);
      console.log(`after a ${how}: saved in pieces ${(pieces.length / 1e6).toFixed(1)} MB (content ${(c.length / 1e6).toFixed(1)} MB packed), saved whole ${(whole.length / 1e6).toFixed(1)} MB`);
      // opened again from the file: its text, a candidate merged from the file, a markup, saved in pieces again
      reopen(id + '2', pieces);
      assert.ok(textOf(id + '2').includes(word), 'the text is there');
      assert.deepEqual(mu.heavyCandidates(id + '2', [0]).candidates.map((x) => [x.page, !!x.local]), [[0, false]], 'a candidate from the file as opened');
      mu.createAnnot(id + '2', 0, { type: 'Square', rect: [50, 50, 200, 200], color: [1, 0, 0] });
      mu.setStreamSaveForTests(1e6);
      const again = mu.save(id + '2');
      assert.ok(savedInPieces(again) && sheetContent(again).filter === '/FlateDecode', 'saved in pieces again, still packed');
      const d = mupdf.Document.openDocument(again, 'application/pdf');
      assert.ok(d.loadPage(0).toStructuredText().asText().includes(word), 'and it opens with its text');
      d.destroy?.();
    } finally { mu.close(id); try { mu.close(id + '2'); } catch { /* not opened */ } }
  })));
}

// ---------------------------------------------------------------- 14.8b

/** a picture's pixels, RGB (invented: a scanned drawing - white, a grid and diagonals in colour; packs to a few %) */
function pixels(w: number, h: number, seed = 0): Buffer {
  const px = Buffer.alloc(w * h * 3, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const grid = (x + seed) % 24 < 2 || (y + seed) % 18 < 2, diag = (x + 2 * y + seed) % 61 < 3;
    if (!grid && !diag) continue;
    const i = (y * w + x) * 3;
    px[i] = grid ? 20 : 200; px[i + 1] = grid ? 40 + (seed & 63) : 30; px[i + 2] = diag ? 90 : 160;
  }
  return px;
}
/** the decode parameters of an RGB picture with PNG predictors */
function pngParms(d: mupdf.PDFDocument, w: number) {
  const p = d.newDictionary();
  p.put('Predictor', 15); p.put('Colors', 3); p.put('Columns', w);
  return p;
}
/** an RGB picture's dictionary, without filter or decode parameters */
function imageDict(d: mupdf.PDFDocument, w: number, h: number) {
  const dict = d.newDictionary();
  dict.put('Type', d.newName('XObject')); dict.put('Subtype', d.newName('Image'));
  dict.put('Width', w); dict.put('Height', h);
  dict.put('ColorSpace', d.newName('DeviceRGB')); dict.put('BitsPerComponent', 8);
  return dict;
}
/** the pictures of page 0 of a saved file, by resource name: filter, decode parameters left (/DecodeParms or /DP), length in the file, decoded bytes */
function picturesOf(b: Uint8Array) {
  const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  try {
    const pics = new Map<string, { filter: string; parms: boolean; length: number; data: Buffer }>();
    d.findPage(0).get('Resources').get('XObject').forEach((v: mupdf.PDFObject, k: string | number) => {
      if (v.get('Subtype').asName() !== 'Image') return;
      pics.set(String(k), { filter: String(v.get('Filter')), parms: !v.get('DecodeParms').isNull() || !v.get('DP').isNull(), length: v.readRawStream().getLength(), data: Buffer.from(v.readStream().asUint8Array()) });
    });
    return pics;
  } finally { d.destroy?.(); }
}

test('14.8b (a): pictures written decoded with their decode parameters left on (/DecodeParms, /DP, an array) and no filter are packed by a save in pieces; the parameters go, the pixels stay', () => {
  const W = 800, H = 600; // 1.44 MB each, unpacked
  const d = new mupdf.PDFDocument();
  const px = [0, 1, 2].map((k) => pixels(W, H, 50 * k));
  const left: [string, () => mupdf.PDFObject][] = [
    ['DecodeParms', () => pngParms(d, W)],
    ['DP', () => pngParms(d, W)],
    ['DecodeParms', () => { const a = d.newArray(); a.push(pngParms(d, W)); return a; }],
  ];
  const xo = d.newDictionary();
  left.forEach(([key, parms], k) => {
    const dict = imageDict(d, W, H);
    dict.put(key, parms());
    xo.put('Im' + k, d.addRawStream(px[k], dict));
  });
  const res = d.newDictionary();
  res.put('XObject', xo);
  d.insertPage(-1, d.addPage([0, 0, 600, 150], 0, res, left.map((_, k) => `q 200 0 0 150 ${200 * k} 0 cm /Im${k} Do Q`).join('\n')));
  reopen('pp', d.saveToBuffer('').asUint8Array().slice());
  mu.setStreamSaveForTests(1e6);
  try {
    const out = mu.save('pp');
    assert.ok(savedInPieces(out), 'saved in pieces');
    const pics = picturesOf(out);
    left.forEach(([key], k) => {
      const p = pics.get('Im' + k)!;
      // (0.13.1: written as it is - no filter, the parameters left on)
      assert.equal(p.filter, '/FlateDecode', `/${key} ${k === 2 ? '(an array) ' : ''}: packed (${p.length} bytes)`);
      assert.ok(!p.parms, `/${key}: the parameters taken off (left on, the predictor would be applied to the new filter)`);
      assert.ok(p.data.equals(px[k]), `/${key}: the pixels byte for byte`);
    });
    const raw = 3 * px[0].length;
    assert.ok(out.length < raw / 5, `the file a fraction of the pixels unpacked: ${out.length} against ${raw}`);
    console.log(`14.8b (a): saved in pieces ${(out.length / 1e6).toFixed(2)} MB for ${(raw / 1e6).toFixed(2)} MB of pixels`);
  } finally { mu.setStreamSaveForTests(0); mu.close('pp'); }
});

/** a generated sheet with a picture under its line work, kept as pictures are (Flate with PNG predictors: rows "Sub") */
function sheetWithPicture(px: Buffer, w: number, h: number): Uint8Array {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const r = Buffer.alloc(1 + 3 * w);
    r[0] = 1;
    for (let k = 0; k < 3 * w; k++) r[1 + k] = (px[3 * w * y + k] - (k >= 3 ? px[3 * w * y + k - 3] : 0)) & 255;
    rows.push(r);
  }
  const d = mupdf.Document.openDocument(sheet(), 'application/pdf').asPDF()!;
  try {
    const page = d.findPage(0);
    const dict = imageDict(d, w, h);
    dict.put('Filter', d.newName('FlateDecode'));
    dict.put('DecodeParms', pngParms(d, w));
    const xo = d.newDictionary();
    xo.put('Pic', d.addRawStream(zlib.deflateSync(Buffer.concat(rows)), dict));
    page.get('Resources').put('XObject', xo);
    const parts = d.newArray();
    parts.push(d.addStream(`q ${w} 0 0 ${h} 200 100 cm /Pic Do Q`, {}));
    parts.push(page.get('Contents'));
    page.put('Contents', parts);
    return d.saveToBuffer('').asUint8Array().slice();
  } finally { d.destroy?.(); }
}

test('14.8b (b): a redaction across a picture on a heavy sheet (MuPDF writes the picture decoded, its decode parameters left on), then a save in pieces: the picture is packed, the parameters go, the pixels are the redacted ones', () => lowered(async () => {
  const W = 800, H = 600;
  const px = pixels(W, H, 7);
  const src = sheetWithPicture(px, W, H);
  assert.ok(picturesOf(src).get('Pic')!.data.equals(px), 'the picture as made reads back as its pixels');
  reopen('pr', src);
  mu.setStreamSaveForTests(1e6);
  try {
    redact('pr');
    // (MuPDF's own writer, for the redacted pixels and its size)
    const whole = mu.save('pr', { clearMetadata: true });
    const pieces = mu.save('pr');
    assert.ok(savedInPieces(pieces), 'saved in pieces');
    const [w] = [...picturesOf(whole).values()];
    const pics = [...picturesOf(pieces).values()];
    assert.equal(pics.length, 1, 'one picture on the page');
    const p = pics[0];
    // (0.13.1: no filter, /DecodeParms left on - 1.44 MB of pixels in the file)
    assert.equal(p.filter, '/FlateDecode', `the picture packed (${p.length} bytes)`);
    assert.ok(!p.parms, 'its decode parameters taken off');
    assert.ok(!p.data.equals(px), 'the redaction changed the pixels');
    assert.ok(p.data.equals(w.data), 'the pixels byte for byte those of the whole save');
    assert.ok(p.length < px.length / 5, `a fraction of the pixels unpacked: ${p.length} against ${px.length}`);
    assert.ok(pieces.length < 1.5 * whole.length, `the file under 1.5 x the whole save: ${pieces.length} against ${whole.length}`);
    console.log(`14.8b (b): saved in pieces ${(pieces.length / 1e6).toFixed(2)} MB (picture ${(p.length / 1e6).toFixed(2)} MB packed), saved whole ${(whole.length / 1e6).toFixed(2)} MB`);
  } finally { mu.setStreamSaveForTests(0); mu.close('pr'); }
}));
