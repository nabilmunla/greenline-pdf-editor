// Phase 6, feature checks: 7.5's drawing in slices with the drawing engine past 2 GB (the 4 GB
// patch, 0.9.7). Found by e2e-4gb: with the engine's memory filled to 2.1 GB first, line-work tiles
// came out blank - the pause hook's struct is allocated above 2 GB and was written with a signed
// index (`at >> 2`, negative there), so PDFium read garbage. Its own process (2.2 GB taken).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as pf from '../src/engine/pdfium';

const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

/** a page of 20,000 strokes across it */
function linePdf(): Uint8Array {
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let c = '0.3 w\n';
  for (let i = 0; i < 20000; i++) c += `${(rnd() * 600).toFixed(1)} ${(rnd() * 600).toFixed(1)} m ${(rnd() * 600).toFixed(1)} ${(rnd() * 600).toFixed(1)} l S\n`;
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 600, 600], 0, {}, c));
  return d.saveToBuffer('compress').asUint8Array().slice();
}

test('Phase 6: a tile drawn in slices past 2 GB of engine memory is the same as one call (not blank)', async () => {
  // (everything after this lands above 2 GB - also the pause hook's struct, made at the first tile)
  const give = pf.fillBelow(2.1 * 2 ** 30, 2.1 * 2 ** 30);
  try {
    pf.openDoc('h', linePdf());
    pf.render('h', 0, 0.1, 0, 0, 8, 8); // (read in)
    const want = pf.render('h', 0, 1, 0, 0, 512, 512);
    const inked = (px: Uint8ClampedArray) => { let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] < 128) n++; return n; };
    assert.ok(inked(want) > 1000, 'the one-call tile has line work');
    pf.progressiveStats.sliceMs = 2;
    const got = await pf.renderGivingWay('h', 0, 1, 0, 0, 512, 512, async () => false);
    assert.ok(Buffer.from(got).equals(Buffer.from(want)), `same pixels (inked ${inked(got)} of ${inked(want)})`);
    pf.closeDoc('h');
  } finally {
    pf.progressiveStats.sliceMs = 50;
    give();
  }
});
