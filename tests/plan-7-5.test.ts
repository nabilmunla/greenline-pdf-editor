// PLAN 7.5 (D6): a tile of line work is drawn in slices; between them short calls can run and a
// tile no longer wanted stops. Same pixels as one call; a page or file closed meanwhile ends it
// cleanly; picture pages draw as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import * as mupdf from 'mupdf';
import * as pf from '../src/engine/pdfium';
import { CallQueue, VIEW_TILE, type QCall } from '../src/engine/callq';

const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

/** a page of 60,000 long strokes across it (slow to draw at any size) */
function linePdf(): Uint8Array {
  let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let c = '0.2 w\n';
  for (let i = 0; i < 60000; i++) c += `${(rnd() * 600).toFixed(1)} ${(rnd() * 600).toFixed(1)} m ${(rnd() * 600).toFixed(1)} ${(rnd() * 600).toFixed(1)} l S\n`;
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 600, 600], 0, {}, c));
  return d.saveToBuffer('compress').asUint8Array().slice();
}
const bytes = linePdf();
const tick = () => new Promise((r) => setImmediate(r));

test('7.5: drawn in slices, the same pixels as one call; short work runs in between', async () => {
  pf.openDoc('a', bytes);
  pf.render('a', 0, 0.1, 0, 0, 8, 8); // (read in)
  const want = pf.render('a', 0, 2, 256, 256, 512, 512);
  pf.progressiveStats.sliceMs = 2;
  let pauses = 0;
  try {
    const got = await pf.renderGivingWay('a', 0, 2, 256, 256, 512, 512, async () => { pauses++; await tick(); pf.chars('a', 0); return false; });
    assert.ok(pauses >= 2, 'slices: ' + pauses);
    assert.ok(Buffer.from(got).equals(Buffer.from(want)), 'same pixels');
  } finally { pf.progressiveStats.sliceMs = 50; }
  pf.closeDoc('a');
});

test('7.5: a tile no longer wanted stops; the page draws normally after', async () => {
  pf.openDoc('b', bytes);
  pf.render('b', 0, 0.1, 0, 0, 8, 8);
  pf.progressiveStats.sliceMs = 1;
  try {
    let n = 0;
    await assert.rejects(pf.renderGivingWay('b', 0, 2, 0, 0, 512, 512, async () => ++n >= 2), (e: { stale?: boolean }) => e.stale === true);
    const a = await pf.renderGivingWay('b', 0, 2, 0, 0, 512, 512, async () => false);
    assert.ok(Buffer.from(a).equals(Buffer.from(pf.render('b', 0, 2, 0, 0, 512, 512))));
  } finally { pf.progressiveStats.sliceMs = 50; }
  pf.closeDoc('b');
});

test('7.5: the file closed while a tile waits between slices: the tile ends, nothing breaks', async () => {
  pf.openDoc('c', bytes);
  pf.render('c', 0, 0.1, 0, 0, 8, 8);
  pf.progressiveStats.sliceMs = 1;
  try {
    let closed = false;
    await assert.rejects(pf.renderGivingWay('c', 0, 2, 0, 0, 512, 512, async () => { if (!closed) { closed = true; pf.closeDoc('c'); } return false; }), (e: { stale?: boolean }) => e.stale === true);
    // (the engine goes on: the file opened again, a tile drawn in slices to the end)
    pf.openDoc('c', bytes);
    const px = await pf.renderGivingWay('c', 0, 2, 0, 0, 256, 256, async () => false);
    assert.equal(px.length, 256 * 256 * 4);
  } finally { pf.progressiveStats.sliceMs = 50; }
  pf.closeDoc('c');
});

test('7.5: a picture page draws as before (no slices)', async () => {
  const d = new mupdf.PDFDocument();
  const img = Buffer.alloc(4200 * 4200, 128);
  const im = d.addRawStream(zlib.deflateSync(img, { level: 1 }), { Type: 'XObject', Subtype: 'Image', Width: 4200, Height: 4200, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' } as never);
  d.insertPage(-1, d.addPage([0, 0, 600, 600], 0, { XObject: { Im0: im } }, 'q 600 0 0 600 0 0 cm /Im0 Do Q'));
  pf.openDoc('d', d.saveToBuffer('compress').asUint8Array().slice());
  let pauses = 0;
  await pf.renderGivingWay('d', 0, 1, 0, 0, 300, 300, async () => { pauses++; return false; });
  assert.equal(pauses, 0);
  pf.closeDoc('d');
});

test('7.5: only a short call at the front is taken into a pause (never one queued behind an open or an edit)', () => {
  let seq = 0;
  const q = new CallQueue<QCall>();
  const c = (method: string): QCall => ({ method, args: ['x', 0, 1], seq: seq++ });
  q.push(c(VIEW_TILE)); q.push(c('chars'));
  assert.equal(q.takeShort()?.method, 'chars');
  assert.equal(q.takeShort(), undefined, 'a tile is not taken');
  const q2 = new CallQueue<QCall>();
  q2.push(c('open')); q2.push(c('chars'));
  assert.equal(q2.takeShort(), undefined, 'the open comes first');
  q2.wantScales('x', [2]);
  assert.equal(q2.isStale({ method: VIEW_TILE, args: ['x', 0, 1], seq: 9 }), true);
  assert.equal(q2.isStale({ method: VIEW_TILE, args: ['x', 0, 2], seq: 9 }), false);
});
