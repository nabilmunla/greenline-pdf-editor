// The drawing engine past 2 GB (0.9.7): everything it hands back is the same when its memory
// sits above 2 GB - pages drawn (from bytes and from a file read in blocks), text, search,
// links, snapping. (Up to 0.9.6 an address past 2 GB came back negative: nothing was read.)
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as mupdf from 'mupdf';
import * as pf from '../src/engine/pdfium';
import { PATCHED_FROM } from '../src/engine/vendor/pdfium-4gb.js';
import type { Reader } from '../src/engine/files';

const GB = 1024 ** 3;
const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
const ab = () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);
const spec = new Uint8Array(readFileSync('tests/data/long-spec.pdf'));
const steel = new Uint8Array(readFileSync('tests/data/steel-sections-3p.pdf'));
const scan = new Uint8Array(readFileSync('tests/data/scan.pdf'));
const hash = (b: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) =>
  createHash('sha1').update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)).digest('hex');

function linkDoc(): Uint8Array {
  const d = new mupdf.PDFDocument();
  const page = d.addPage([0, 0, 595, 842], 0, {}, 'BT /F1 12 Tf 72 700 Td (link) Tj ET');
  const link = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Link'), Rect: [70, 690, 200, 720], Border: [0, 0, 0],
    A: { S: d.newName('URI'), URI: d.newString('https://example.com/past-2gb') } });
  page.put('Annots', [link]);
  d.insertPage(-1, page);
  return d.saveToBuffer('').asUint8Array().slice();
}
const links = linkDoc();

const readerOf = (b: Uint8Array): Reader => ({
  size: b.length,
  read(buf, off, len, pos) { buf.set(b.subarray(pos, pos + len), off); return len; },
  close() { /* in memory */ },
});

/** everything compared, for one run */
function sample(tag: string) {
  const out: Record<string, unknown> = {};
  pf.openDoc(tag + 's', spec);
  out.specText = pf.pageText(tag + 's', 0);
  out.specChars = hash(pf.chars(tag + 's', 0).box);
  out.find = JSON.stringify(pf.find(tag + 's', 'contract', 0, 3).map((h) => [h.page, h.rects.map((r) => r.map((v) => Math.round(v * 100)))]));
  out.specPx = hash(pf.render(tag + 's', 0, 1.5, 0, 0, 600, 800));
  pf.closeDoc(tag + 's');
  // read in blocks from the "file" (the blocks land in the engine's memory)
  pf.openDoc(tag + 'r', readerOf(steel));
  out.steelPx = hash(pf.render(tag + 'r', 1, 2, 100, 100, 700, 500));
  const snap = pf.snap(tag + 'r', 1, 300, 300, 40);
  out.snap = JSON.stringify(snap && [Math.round(snap.x * 100), Math.round(snap.y * 100), snap.k]);
  pf.closeDoc(tag + 'r');
  pf.openDoc(tag + 'i', scan);
  out.scanPx = hash(pf.render(tag + 'i', 0, 1, 0, 0, 595, 842));
  pf.closeDoc(tag + 'i');
  pf.openDoc(tag + 'l', links);
  out.links = JSON.stringify(pf.links(tag + 'l', 0));
  out.linkPx = hash(pf.render(tag + 'l', 0, 1, 0, 0, 595, 842, true));
  pf.closeDoc(tag + 'l');
  return out;
}

test('the patched engine is from the installed @embedpdf/pdfium (else: node scripts/patch-pdfium.mjs)', () => {
  const v = JSON.parse(readFileSync('node_modules/@embedpdf/pdfium/package.json', 'utf8')).version;
  assert.equal(PATCHED_FROM, v);
});

test('the .wasm memory limit is raised from 2 GB to 4 GB less a page (nothing else changed)', () => {
  const a = new Uint8Array(wasm), b = new Uint8Array(pf.liftMemoryMax(ab()));
  assert.equal(a.length, b.length);
  const diff = [...a.keys()].filter((i) => a[i] !== b[i]);
  assert.equal(diff.length, 3, 'three bytes: the limit');
  assert.deepEqual([...b.subarray(diff[0], diff[0] + 3)], [0xff, 0xff, 0x03]);
  assert.ok(new WebAssembly.Module(b.slice().buffer), 'still a valid module');
  // anything else is left alone
  const other = new Uint8Array(a); other[diff[0]] = 0x81;
  assert.equal(pf.liftMemoryMax(other.buffer), other.buffer);
});

test('past 2 GB: pages, text, search, links and snapping come out the same', { timeout: 300_000 }, async () => {
  await pf.startPdfium(ab());
  const low = sample('a');
  assert.ok(pf.nextAddress() < 2 ** 31, 'first run below 2 GB');
  assert.ok(String(low.specText).length > 100 && low.links !== '[]' && JSON.parse(low.find as string).length > 0, 'the samples are real');
  // everything after this lands past 2 GB
  const give = pf.fillBelow(2 ** 31, 2.1 * GB);
  try {
    assert.ok(pf.nextAddress() > 2 ** 31, `next allocation past 2 GB (${(pf.nextAddress() / GB).toFixed(2)} GB)`);
    assert.ok(pf.heapBytes() > 2 * GB);
    const high = sample('b');
    for (const k of Object.keys(low)) assert.equal(high[k], low[k], k + ' differs past 2 GB');
    // and further: up to the 4 GB limit
    const give2 = pf.fillBelow(3.6 * GB, 1.5 * GB);
    try {
      assert.ok(pf.nextAddress() > 3.6 * GB);
      assert.ok(pf.heapBytes() > 3.7 * GB, `grew to ${(pf.heapBytes() / GB).toFixed(2)} GB`);
      assert.ok(pf.heapBytes() <= pf.MEMORY_MAX);
      const top = sample('c');
      for (const k of Object.keys(low)) assert.equal(top[k], low[k], k + ' differs near 4 GB');
    } finally { give2(); }
  } finally { give(); }
  assert.equal(pf.openIds().length, 0);
});
