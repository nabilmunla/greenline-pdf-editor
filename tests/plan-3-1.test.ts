// PLAN 3.1 + 3.3 (D2): heavy pages are found by an estimate of their strokes (not by compressed
// size) and drawn from merged line work for DISPLAY ONLY: the drawing engines get it as one more
// update on top of their copy; a save keeps the original line work; nothing goes on the undo stack.
import '../src/engine/mupdf-pre.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import * as pf from '../src/engine/pdfium';
import { estimateStrokes, makeMerger, countStrokes } from '../src/engine/heavy';
import { lastXref } from '../src/engine/overlay';

const dir = mkdtempSync(join(tmpdir(), 'p31-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const store = (b: Uint8Array) => { const p = join(dir, `m${n++}.bin`); writeFileSync(p, b); return { path: p, size: b.length }; };

/** `strokes` short scattered strokes + a red line split across two content parts; `pages` pages sharing that content */
function heavyDoc(strokes: number, pages = 1): Uint8Array {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const lines: string[] = [];
  for (let i = 0; i < strokes; i++) { const x = (rnd() * 1180).toFixed(3), y = (rnd() * 830).toFixed(3); lines.push(`${x} ${y} m ${(+x + 0.8).toFixed(3)} ${(+y + 0.6).toFixed(3)} l S`); }
  const d = new mupdf.PDFDocument();
  const p1 = d.addStream('q 1 0 0 RG 2 w 100 100 m 600 500 l', {});
  const p2 = d.addStream('S 0 0 1 RG 0.1 w\n' + lines.join('\n') + '\nQ', {});
  const contents = d.newArray(); contents.push(p1); contents.push(p2);
  for (let k = 0; k < pages; k++) { const pg = d.addPage([0, 0, 1190, 842], 0, {}, ''); pg.put('Contents', contents); d.insertPage(-1, pg); }
  return d.saveToBuffer('compress').asUint8Array().slice();
}
/** the drawing engines' copy: the file + the display update (as host.ts drawSnapshot makes it) */
function drawingCopy(id: string, bytes: Uint8Array): Uint8Array {
  const extra = mu.displayOverlay(id, bytes.length, lastXref(bytes.subarray(bytes.length - 4096)));
  assert.ok(extra, 'a display update');
  const parts: Uint8Array[] = [bytes];
  for (const x of extra) parts.push('bytes' in x ? x.bytes : new Uint8Array(readFileSync(x.path)));
  return new Uint8Array(Buffer.concat(parts));
}
const red = (b: Uint8Array, page: number) => {
  const doc = mupdf.Document.openDocument(b, 'application/pdf');
  const pix = doc.loadPage(page).toPixmap(mupdf.Matrix.scale(0.5, 0.5), mupdf.ColorSpace.DeviceRGB, false, true);
  let r = 0; const px = pix.getPixels();
  for (let i = 0; i < px.length; i += 3) if (px[i] > 200 && px[i + 1] < 80 && px[i + 2] < 80) r++;
  return r;
};
/** strokes in a page's content as MuPDF sees the file */
const strokesOf = (b: Uint8Array, page: number) => {
  const doc = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  const c = doc.findPage(page).get('Contents');
  let s = 0;
  for (let i = 0, k = c.isArray() ? c.length : 1; i < k; i++) s += countStrokes(Buffer.from((c.isArray() ? c.get(i) : c).readStream().asUint8Array()));
  return s;
};

test('3.1: the stroke estimate from a 1 MB sample is within 30 % (and cheap for a dense ordinary page)', () => {
  const lines: string[] = [];
  for (let i = 0; i < 400_000; i++) lines.push(`${(i * 7) % 1600} ${(i * 13) % 1100} m ${(i * 7) % 1600 + 2} ${(i * 13) % 1100 + 1} l S`);
  const raw = zlib.deflateSync(Buffer.from(lines.join('\n')));
  const est = estimateStrokes([new Uint8Array(raw)]);
  assert.ok(Math.abs(est - 400_000) / 400_000 < 0.3, 'estimate ' + Math.round(est));
  const fills = zlib.deflateSync(Buffer.from(Array.from({ length: 200_000 }, (_, i) => `${i % 900} ${i % 700} 3 3 re f`).join('\n')));
  assert.ok(estimateStrokes([new Uint8Array(fills)]) < 1000, 'fills are not strokes');
});

test('3.1/3.3: a heavy page is drawn merged on top of the copy; the file, its save and the undo stack keep the original', async () => {
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  mu.setContentMerger(makeMerger(undefined, 100_000));
  mu.setDisplayStore(store);
  mu.setHeavyRaw(1e6);
  try {
    const bytes = heavyDoc(300_000, 2);
    assert.ok(bytes.length > 1e6, 'big enough to be looked at: ' + bytes.length);
    const r = mu.open('h', bytes);
    assert.ok(r.look && !r.fixedTurn, 'pages to look at; no whole copy needed');
    // (3.2: looked at when about to be drawn; merged in the batch engine; attached here)
    const look = mu.heavyCandidates('h', [0, 1]);
    assert.equal(look.candidates.length, 2, 'both pages are candidates (one shared content)');
    const c = look.candidates[0];
    const f = await mu.mergeForDisplay(bytes, c.streams);
    assert.ok(f, 'merged');
    assert.equal(mu.attachDisplay('h', 0, c.key, c.streams, f!), true);
    assert.deepEqual(mu.heavyCandidates('h', [1]), { candidates: [], shown: [1] }, 'page 2 shows the same content: drawn merged too');
    assert.equal(mu.history('h').undo.length, 0, 'nothing on the undo stack');
    const copy = drawingCopy('h', bytes);
    // the drawing copy: few strokes, same drawing (the red stroke split across the parts too)
    const s0 = strokesOf(bytes, 0), s1 = strokesOf(copy, 0);
    assert.ok(s0 >= 300_000 && s1 < s0 / 50, `strokes ${s0} -> ${s1}`);
    assert.equal(strokesOf(copy, 1), s1, 'page 2 too');
    const r0 = red(bytes, 0);
    assert.ok(r0 > 100);
    assert.equal(red(copy, 0), r0, 'same drawing');
    // PDFium reads the copy (classic xref after MuPDF's): page sizes as the file's, a tile drawn
    const info = pf.openDoc('hc', copy);
    assert.equal(info.pages.length, 2);
    assert.equal(Math.round(info.pages[0].w), 1190);
    assert.ok(pf.render('hc', 0, 0.25, 0, 0, 64, 64).length === 64 * 64 * 4);
    pf.closeDoc('hc');
    // a markup added: the copy is the file + the change + the display update; a save keeps the original line work
    mu.createAnnot('h', 0, { type: 'Square', rect: [10, 10, 50, 50], color: [1, 0, 0] } as never);
    const inc = mu.save('h', { incremental: true });
    assert.deepEqual(inc.subarray(0, bytes.length), bytes, 'saved as original + changes');
    assert.ok(inc.length - bytes.length < 50_000, 'no merged line work appended: +' + (inc.length - bytes.length));
    assert.equal(strokesOf(inc, 0), s0, 'saved file: the original strokes');
    const full = mu.save('h');
    assert.equal(strokesOf(full, 0), s0, 'full save: the original strokes');
    assert.ok(!new TextDecoder('latin1').decode(full).includes('GCCMerged'));
    mu.close('h');
    // a page below the bar, simplified on request: display only, no undo step
    mu.setHeavyRaw(30e6);
    mu.open('h3', bytes);
    assert.equal(mu.displayFiles('h3').length, 0);
    assert.equal(await mu.simplifyPage('h3', 0), true);
    assert.equal(mu.history('h3').undo.length, 0, 'simplify is not an undo step');
    const c3 = drawingCopy('h3', bytes);
    assert.ok(strokesOf(c3, 1) < s0 / 50, 'the page sharing the content is simplified too');
    assert.equal(strokesOf(mu.save('h3'), 0), s0, 'saved: original strokes');
    mu.close('h3');
    mu.open('h4', new Uint8Array(readFileSync('tests/data/long-spec.pdf')));
    await assert.rejects(() => mu.simplifyPage('h4', 0), /can't be simplified/, 'a text page: nothing to simplify');
    mu.close('h4');
  } finally {
    mu.setContentMerger(null);
    mu.setDisplayStore(null);
    mu.setHeavyRaw(2e6);
  }
});

test('3.1: content that opens with megabytes of fills and only then holds its strokes is still merged (the old size bar stays)', async () => {
  const { deflateSync } = await import('node:zlib');
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const fills: string[] = [], strokes: string[] = [];
  // (hatching fills first: well over the 1 MB sample, compressed, and not a stroke among them)
  while (fills.length < 120_000) { const x = (rnd() * 9000).toFixed(0), y = (rnd() * 9000).toFixed(0); fills.push(`${x} ${y} m ${+x + 1} ${+y + 1} l ${x} ${+y + 1} l h f`); }
  for (let i = 0; i < 150_000; i++) { const x = (rnd() * 1180).toFixed(3), y = (rnd() * 830).toFixed(3); strokes.push(`${x} ${y} m ${(+x + 0.8).toFixed(3)} ${(+y + 0.6).toFixed(3)} l S`); }
  const raw = new Uint8Array(deflateSync(Buffer.from(fills.join('\n') + '\n' + strokes.join('\n'))));
  assert.ok(raw.length > (1 << 20) * 1.2, 'fills fill the sample: ' + raw.length);
  assert.ok(estimateStrokes([raw]) < 100_000 * 0.8, 'the sample alone misses the strokes');
  // (the size bar, scaled down for the test: content past it is counted in full)
  assert.equal(await makeMerger(undefined, 100_000, Infinity)([raw]), null);
  const merged = await makeMerger(undefined, 100_000, raw.length)([raw]);
  assert.ok(merged && merged.length > 0, 'merged once counted in full');
});
