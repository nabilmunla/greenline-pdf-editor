// The file made for the printer: pages on their sheets, scaled and centred, markups in or out.
// npx tsx --test tests/print.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { sheetLayout, PAPERS } from '../src/engine/printlayout';

mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));
const A4 = PAPERS[0], A3 = PAPERS[1];

function doc(): Uint8Array {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  // an A1 landscape drawing (with a frame) and an A4 portrait page turned 90
  d.insertPage(-1, d.addPage([0, 0, 2384, 1684], 0, { Font: { F1: f } }, '2 w 20 20 2344 1644 re S BT /F1 40 Tf 100 1500 Td (DRAWING TITLE) Tj ET'));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 90, { Font: { F1: f } }, 'BT /F1 14 Tf 60 780 Td (Turned page text) Tj ET'));
  return d.saveToBuffer('').asUint8Array().slice();
}
const text = (d: mupdf.Document, i: number) => d.loadPage(i).toStructuredText('').asText();

test('layout: fit, actual, shrink, custom, auto orientation, region', () => {
  const o = { paper: A3, orient: 'auto' as const, scale: 'fit' as const, margin: 10 };
  const L = sheetLayout(2384, 1684, null, o);
  assert.ok(L.W > L.H, 'landscape for a landscape drawing');
  // (A1 landscape on A3 landscape: the height decides - 10 pt margin above and below, the rest
  // shared left and right; worked out here from the paper, not with the layout's own numbers)
  const k = Math.min((A3.h - 20) / 2384, (A3.w - 20) / 1684);
  assert.ok(Math.abs(L.k - k) < 1e-9, 'fitted inside the margin');
  assert.ok(Math.abs(L.oy - 10) < 0.01 && Math.abs(L.ox - (A3.h - 2384 * k) / 2) < 0.01 && L.ox > 10, `centred inside the margin: ${L.ox}, ${L.oy}`);
  assert.equal(sheetLayout(2384, 1684, null, { ...o, scale: 'actual' }).k, 1);
  assert.equal(sheetLayout(300, 300, null, { ...o, scale: 'shrink' }).k, 1, 'small page not enlarged');
  assert.equal(sheetLayout(300, 300, null, { ...o, scale: 'custom', pct: 50 }).k, 0.5);
  assert.ok(sheetLayout(2384, 1684, null, { ...o, orient: 'portrait' }).W < sheetLayout(2384, 1684, null, { ...o, orient: 'portrait' }).H);
  const R = sheetLayout(2384, 1684, [100, 100, 500, 400], o);
  assert.ok(Math.abs(R.k - Math.min((L.W - 20) / 400, (L.H - 20) / 300)) < 1e-6, 'a region is enlarged to the paper');
  const own = sheetLayout(2384, 1684, null, { ...o, paper: null });
  assert.deepEqual([own.W, own.H, own.k], [2384, 1684, 1]);
  // the margin as used (a quarter of the paper's short side at most) - the preview draws its
  // dashed line there, not at the 50 mm typed (on A5 the page started inside the line)
  const A5 = { w: 419.53, h: 595.28 }, mm50 = 50 * 72 / 25.4;
  const S = sheetLayout(595, 842, null, { paper: A5, orient: 'portrait', scale: 'fit', margin: mm50 });
  assert.ok(Math.abs(S.m - A5.w / 4) < 1e-6, 'margin used: ' + S.m);
  assert.ok(S.ox >= S.m - 1e-6 && S.oy >= S.m - 1e-6, 'the page starts at the margin used');
});

test('print file: A1 drawing fitted on A3, turned page upright on A4, markups baked in or left out', () => {
  mu.open('p', doc());
  mu.createAnnot('p', 0, { type: 'FreeText', rect: [200, 200, 600, 260], contents: 'MARKUP NOTE', font: { size: 20, color: [1, 0, 0] }, kind: 'textbox' });
  for (const markups of [true, false]) {
    const out = mu.printFile('p', { pages: [0, 1], paper: A3, orient: 'auto', scale: 'fit', margin: 14, markups });
    const d = mupdf.Document.openDocument(out, 'application/pdf');
    assert.equal(d.countPages(), 2);
    const b0 = d.loadPage(0).getBounds();
    assert.ok(Math.abs(b0[2] - A3.h) < 1 && Math.abs(b0[3] - A3.w) < 1, 'sheet 1 is A3 landscape: ' + b0);
    const t0 = text(d, 0);
    assert.ok(t0.includes('DRAWING TITLE'), 'drawing content printed');
    assert.equal(t0.includes('MARKUP NOTE'), markups, 'markup ' + (markups ? 'baked in' : 'left out'));
    assert.equal((d.loadPage(0) as mupdf.PDFPage).getAnnotations().length, 0, 'no annotations left: all in the content');
    // the title sits where it should: x 100/2384 of the drawing width, scaled into the sheet
    const L = sheetLayout(2384, 1684, null, { paper: A3, orient: 'auto', scale: 'fit', margin: 14 });
    let tx = -1;
    d.loadPage(0).toStructuredText('').walk({ onChar(c: string, o: number[]) { if (tx < 0 && c === 'D') tx = o[0]; } } as never);
    assert.ok(Math.abs(tx - (L.ox + 100 * L.k)) < 2, `title x ${tx} vs ${L.ox + 100 * L.k}`);
    const b1 = d.loadPage(1).getBounds();
    assert.ok(Math.abs(b1[2] - A3.h) < 1 && Math.abs(b1[3] - A3.w) < 1, 'turned page: landscape sheet for its shown shape ' + b1);
    assert.ok(text(d, 1).includes('Turned page text'));
  }
  // the region: only the part in view, enlarged
  const out = mu.printFile('p', { pages: [0], region: [80, 120, 700, 300], paper: A4, orient: 'auto', scale: 'fit', margin: 10, markups: true });
  const d = mupdf.Document.openDocument(out, 'application/pdf');
  assert.equal(d.countPages(), 1);
  // the preview draws the same thing
  const pv = mu.printPreview('p', { pages: [0], paper: A3, orient: 'auto', scale: 'fit', margin: 14, markups: true }, 0, 600);
  assert.ok(pv && pv.W > pv.H && pv.w > 500 && pv.x > 0, 'preview of the sheet');
  mu.close('p');
});

// ---------------------------------------------------------------- heavy sheets as pictures (0.8.5)

/** a "scan": A4 landscape pages, each one colour JPEG at about `dpi` - plus a text-only page */
function scanDoc(pages: number, dpi: number): Uint8Array {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const W = 842, H = 595;
  const pw = Math.round((W / 72) * dpi), ph = Math.round((H / 72) * dpi);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, pw, ph], false);
  pix.clear(240);
  const px = pix.getPixels();
  // some ink so the JPEG isn't trivially small: dark bands and a red stamp-like block
  for (let y = 0; y < ph; y += 37) for (let x = 0; x < pw; x++) { const i = (y * pw + x) * 3; px[i] = px[i + 1] = px[i + 2] = 30; }
  for (let y = Math.round(ph * 0.6); y < Math.round(ph * 0.8); y++) for (let x = Math.round(pw * 0.6); x < Math.round(pw * 0.85); x++) { const i = (y * pw + x) * 3; px[i] = 200; px[i + 1] = 30; px[i + 2] = 40; }
  const jpg = pix.asJPEG(80);
  pix.destroy?.();
  const img = d.addImage(new mupdf.Image(jpg));
  for (let i = 0; i < pages; i++) d.insertPage(-1, d.addPage([0, 0, W, H], 0, { XObject: { Im0: img } }, `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, 'BT /F1 14 Tf 60 780 Td (Plain text page) Tj ET'));
  return d.saveToBuffer('').asUint8Array().slice();
}
/** what the print panel does with a printFile answer: the sheets it names made into pictures
 *  (batch engine: printPicBegin, printPicSheet each, printPicFinish) */
function withPictures(r: unknown, gray: boolean): { bytes: Uint8Array; pictures: number } {
  const v = r as { bytes: Uint8Array; pictures: number[] };
  if (!v.pictures.length) return { bytes: v.bytes, pictures: 0 };
  // (as the batch engine does it: each picture spilled to a "temp file" and copied back at the end)
  const st = mu.picStart(v.bytes);
  const spill: Uint8Array[] = [];
  let size = 0;
  try {
    for (const k of v.pictures) mu.picSheet(st, k, gray, (raw) => { const off = size; spill.push(raw.slice()); size += raw.length; return off; });
    const all = Buffer.concat(spill);
    const parts: Uint8Array[] = [];
    mu.picWrite(st, (b) => parts.push(typeof b === 'string' ? Buffer.from(b, 'latin1') : b.slice()), (off, len) => parts.push(all.subarray(off, off + len)));
    return { bytes: new Uint8Array(Buffer.concat(parts)), pictures: v.pictures.length };
  } finally { mu.picDrop(st); }
}
const imagesOn = (d: mupdf.PDFDocument, i: number) => {
  const out: { w: number; h: number; cs: string }[] = [];
  const xo = d.findPage(i).get('Resources').get('XObject');
  if (xo.isDictionary()) xo.forEach((v: mupdf.PDFObject) => { const x = v.resolve(); if (x.get('Subtype').asName() === 'Image') out.push({ w: x.get('Width').asNumber(), h: x.get('Height').asNumber(), cs: (() => { const c = x.get('ColorSpace').resolve(); if (c.isName()) return c.asName(); if (c.isArray() && c.get(0).asName() === 'ICCBased') return 'ICC' + c.get(1).get('N').asNumber(); return String(c); })() }); });
  return out;
};

test('print file: heavy scans go as one 300 dpi picture per sheet (grey for black & white), text pages stay as they are', () => {
  mu.open('scan', scanDoc(3, 600));
  const base = { pages: [0, 1, 2, 3], paper: A4, orient: 'auto' as const, scale: 'fit' as const, margin: 14, markups: true };
  // as they are: the 600 dpi scan goes to the printer whole
  const v = mu.printFile('scan', { ...base, send: 'vector' });
  assert.ok(v instanceof Uint8Array && v.length > 0, 'vector: plain bytes');
  const dv = mupdf.Document.openDocument(v, 'application/pdf') as mupdf.PDFDocument;
  assert.ok(imagesOn(dv, 0)[0].w > 6000, 'vector: the scan at its own size');
  // auto, black & white: the scan pages as grey pictures of the sheet, the text page untouched
  const t0 = Date.now();
  const r = withPictures(mu.printFile('scan', { ...base, send: 'auto', gray: true }), true);
  const ms = Date.now() - t0;
  assert.equal(r.pictures, 3, 'three sheets as pictures');
  const d = mupdf.Document.openDocument(r.bytes, 'application/pdf') as mupdf.PDFDocument;
  assert.equal(d.countPages(), 4);
  for (let i = 0; i < 3; i++) {
    const im = imagesOn(d, i);
    assert.equal(im.length, 1, 'one picture on sheet ' + (i + 1));
    const b = d.loadPage(i).getBounds();
    assert.ok(Math.abs(b[2] - A4.h) < 1 && Math.abs(b[3] - A4.w) < 1, 'still the A4 landscape sheet');
    assert.ok(Math.abs(im[0].w - Math.round((A4.h / 72) * 300)) <= 2, '300 dpi across the sheet: ' + im[0].w);
    assert.ok(im[0].cs === 'DeviceGray' || im[0].cs === 'ICC1', 'grey for black & white: ' + im[0].cs);
  }
  assert.ok(text(d, 3).includes('Plain text page'), 'text page printed as it is');
  assert.equal(imagesOn(d, 3).length, 0);
  assert.ok(r.bytes.length < v.length, `smaller than the scan as it is: ${r.bytes.length} vs ${v.length}`);
  // the picture shows the page: a dark band and the red block (grey) where they were
  const pix = d.loadPage(0).toPixmap(mupdf.Matrix.scale(0.25, 0.25), mupdf.ColorSpace.DeviceGray, false, true);
  const g = pix.getPixels(), w = pix.getWidth(), h = pix.getHeight();
  const at = (fx: number, fy: number) => g[Math.round(fy * (h - 1)) * w + Math.round(fx * (w - 1))];
  assert.ok(at(0.7, 0.7) < 140, 'the red block shows (grey): ' + at(0.7, 0.7));
  assert.ok(at(0.3, 0.3) > 180, 'paper stays light: ' + at(0.3, 0.3));
  pix.destroy?.();
  console.log(`    3 scan sheets at 600 dpi -> pictures in ${ms} ms; ${Math.round(v.length / 1024)} KB -> ${Math.round(r.bytes.length / 1024)} KB`);
  // colour printing of a 300 dpi scan on A4: not heavy - sent as it is
  mu.open('scan300', scanDoc(1, 300));
  const c = withPictures(mu.printFile('scan300', { ...base, pages: [0], send: 'auto', gray: false }), false);
  assert.equal(c.pictures, 0, 'a 300 dpi colour scan in colour stays as it is');
  // ... in black & white: grey picture (a third of the data)
  const c2 = withPictures(mu.printFile('scan300', { ...base, pages: [0], send: 'auto', gray: true }), true);
  assert.equal(c2.pictures, 1, 'a colour scan printed black & white goes grey');
  // "pictures" for everything: the text page too
  const all = withPictures(mu.printFile('scan', { ...base, send: 'picture' }), false);
  assert.equal(all.pictures, 4);
  mu.close('scan'); mu.close('scan300');
});

test('print file: auto leaves big sheets (plotters) and ordinary drawings as they are', () => {
  mu.open('dwg', doc());
  const r = withPictures(mu.printFile('dwg', { pages: [0, 1], paper: PAPERS[4], orient: 'auto', scale: 'fit', margin: 14, markups: true, send: 'auto' }), false);
  assert.equal(r.pictures, 0, 'A0 sheets never auto');
  const r2 = withPictures(mu.printFile('dwg', { pages: [0, 1], paper: A3, orient: 'auto', scale: 'fit', margin: 14, markups: true, send: 'auto' }), false);
  assert.equal(r2.pictures, 0, 'light drawing on A3 stays vector');
  // the heavy test sheet (dense line work) on A3: a picture
  mu.open('heavy', new Uint8Array(readFileSync('tests/data/heavy-a0.pdf')));
  const t0 = Date.now();
  const h = withPictures(mu.printFile('heavy', { pages: [0], paper: A3, orient: 'auto', scale: 'fit', margin: 14, markups: true, send: 'auto' }), false);
  console.log(`    heavy A0 sheet on A3 -> picture: ${h.pictures} in ${Date.now() - t0} ms, ${Math.round(h.bytes.length / 1024)} KB`);
  assert.equal(h.pictures, 1, 'dense line work on A3 goes as a picture');
  mu.close('dwg'); mu.close('heavy');
});

test('print file: pictures follow the print settings of layers; auto leaves files with layers as they are', () => {
  // a layer that shows on screen but must not print (a "screen only" watermark)
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const ocg = d.addObject(d.newDictionary());
  ocg.put('Type', d.newName('OCG')); ocg.put('Name', d.newString('Screen only'));
  const usage = d.newDictionary(); const pr = d.newDictionary(); pr.put('PrintState', d.newName('OFF')); usage.put('Print', pr); ocg.put('Usage', usage);
  const props = d.newDictionary(); props.put('L1', ocg);
  const pg = d.addPage([0, 0, 595, 842], 0, { Font: { F1: f }, Properties: props }, 'BT /F1 30 Tf 60 700 Td (KEEP) Tj ET /OC /L1 BDC 0 g 50 50 500 400 re f EMC');
  d.insertPage(-1, pg);
  const ocp = d.newDictionary(); const ocgs = d.newArray(); ocgs.push(ocg); ocp.put('OCGs', ocgs);
  const dd = d.newDictionary(); dd.put('Order', ocgs); const as = d.newArray(); const ev = d.newDictionary(); ev.put('Event', d.newName('Print')); ev.put('OCGs', ocgs); const cat = d.newArray(); cat.push(d.newName('Print')); ev.put('Category', cat); as.push(ev); dd.put('AS', as); ocp.put('D', dd);
  d.getTrailer().get('Root').put('OCProperties', ocp);
  mu.open('ly', d.saveToBuffer('').asUint8Array().slice());
  const base = { pages: [0], paper: A4, orient: 'auto' as const, scale: 'fit' as const, margin: 14, markups: true };
  const a = withPictures(mu.printFile('ly', { ...base, send: 'auto', gray: true }), true);
  assert.equal(a.pictures, 0, 'auto: a file with layers goes as it is');
  const pic = withPictures(mu.printFile('ly', { ...base, send: 'picture', gray: true }), true);
  assert.equal(pic.pictures, 1);
  const px = mupdf.Document.openDocument(pic.bytes, 'application/pdf').loadPage(0).toPixmap(mupdf.Matrix.scale(0.2, 0.2), mupdf.ColorSpace.DeviceGray, false, true);
  const g = px.getPixels(), w = px.getWidth(), h = px.getHeight();
  // the non-printing black box (lower half of the page) left out of the picture
  assert.ok(g[Math.round(h * 0.75) * w + Math.round(w / 2)] > 200, 'the layer set not to print is not in the picture');
  mu.close('ly');
});

test('print file: a long job of pictures is written in pieces (each picture out of the engine as it is made)', () => {
  mu.open('long', new Uint8Array(readFileSync('tests/data/long-spec.pdf')));
  const r = mu.printFile('long', { pages: [...Array(40).keys()], paper: A4, orient: 'auto', scale: 'fit', margin: 14, markups: true, send: 'picture', gray: true }) as unknown as { bytes: Uint8Array; pictures: number[] };
  const st = mu.picStart(r.bytes);
  let spilled = 0, biggestKept = 0;
  try {
    for (const k of r.pictures) {
      mu.picSheet(st, k, true, (raw) => { const off = spilled; spilled += raw.length; return off; });
      // nothing of the pictures stays in the engine: every new stream emptied
      for (let num = 1; num < st.doc.countObjects(); num++) { const ref = st.doc.newIndirect(num); if (st.spilled.has(num) && ref.isStream()) { const raw = ref.readRawStream(); biggestKept = Math.max(biggestKept, raw.asUint8Array().length); raw.destroy?.(); } }
    }
  } finally { mu.picDrop(st); mu.close('long'); }
  assert.ok(spilled > 40 * 100_000, '40 sheets of pictures went out: ' + spilled);
  assert.equal(biggestKept, 0, 'no picture kept in the engine');
});
