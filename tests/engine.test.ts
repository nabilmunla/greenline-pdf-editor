// Engine tests: MuPDF edit core + PDFium drawing core on generated files.
// (before MuPDF.js, as in the engine: the quick journal reads)
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import * as pf from '../src/engine/pdfium';
import { guardMupdf, mupdfErrors, traceMupdfErrors } from '../src/engine/mupdf-guard';
import { after } from 'node:test';
import { mergeStrokes } from '../src/engine/strokes';
import { visualOrder, layoutText } from '../src/engine/shape';
import { fontStack } from '../src/engine/fonts';
// MuPDF errors leak its stack (see mupdf-guard.ts): normal work must not cause any
guardMupdf(mupdf);
const errs = new Map<string, number>();
traceMupdfErrors((m, e) => { const k = m + ': ' + String((e as Error)?.message).slice(0, 70); errs.set(k, (errs.get(k) ?? 0) + 1); });
after(() => { console.log('MuPDF errors in engine tests:', mupdfErrors(), JSON.stringify([...errs])); });

mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));
const spec = new Uint8Array(readFileSync('tests/data/long-spec.pdf'));
const heavy = new Uint8Array(readFileSync('tests/data/heavy-a0.pdf'));

function rotatedDoc(): Uint8Array {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const p = d.addPage([0, 0, 842, 595], 90, { Font: { F1: f } }, 'BT /F1 20 Tf 100 300 Td (ROTATED SHEET TEXT) Tj ET');
  d.insertPage(-1, p);
  return d.saveToBuffer('compress').asUint8Array().slice();
}

function textOf(bytes: Uint8Array, page = 0): string {
  const d = mupdf.Document.openDocument(bytes, 'application/pdf');
  return d.loadPage(page).toStructuredText('').asText();
}

test('open, markups, move/resize, lock, delete, undo/redo', () => {
  const info = mu.open('a', spec, undefined, 'Tester');
  assert.equal(info.pages.length, 1500);
  assert.equal(Math.round(info.pages[0].w), 595);
  const sq = mu.createAnnot('a', 0, { type: 'Square', rect: [100, 100, 200, 160], color: [1, 0, 0], bw: 2, cloudy: 1 });
  assert.equal(sq.author, 'Tester');
  const moved = mu.moveAnnots('a', [{ page: 0, id: sq.id }], 10, 20)[0];
  // (moved by exactly 10, 20 - compared with where it was, not with itself)
  assert.deepEqual(moved.rect.map(Math.round), [sq.rect[0] + 10, sq.rect[1] + 20, sq.rect[2] + 10, sq.rect[3] + 20].map(Math.round));
  const r = mu.resizeAnnot('a', 0, sq.id, [110, 120, 310, 220]);
  assert.ok(r.rect[2] - r.rect[0] > 190);
  // arrow
  const ln = mu.createAnnot('a', 0, { type: 'Line', line: [[50, 400], [300, 400]], le: ['None', 'ClosedArrow'], color: [0, 0, 1] });
  const ln2 = mu.moveAnnots('a', [{ page: 0, id: ln.id }], 5, 5)[0];
  assert.deepEqual(ln2.line!.map((p) => p.map(Math.round)), [[55, 405], [305, 405]]);
  // lock -> delete refused
  mu.updateAnnots('a', [{ page: 0, id: ln.id, patch: { locked: true } }]);
  assert.equal(mu.deleteAnnots('a', [{ page: 0, id: ln.id }]), 0);
  assert.equal(mu.annots('a', 0).length, 2);
  // reply hidden from drawing, deleted with parent
  const rep = mu.createAnnot('a', 0, { type: 'Text', irt: sq.id, contents: 'agreed' });
  assert.equal(rep.irt, sq.id);
  assert.equal(mu.deleteAnnots('a', [{ page: 0, id: sq.id }]), 1);
  assert.equal(mu.annots('a', 0).length, 1);
  // undo the delete brings both back; redo removes again
  let u = mu.undo('a');
  assert.equal(u.kind, 'a');
  assert.equal(mu.annots('a', 0).length, 3);
  mu.redo('a');
  assert.equal(mu.annots('a', 0).length, 1);
  // drawing the markup layer of a tile
  const px = mu.renderAnnots('a', 0, 2, 0, 0, 800, 1000)!;
  assert.ok(px && px.some((v, i) => i % 4 === 3 && v > 0), 'arrow drawn');
  // everywhere else the markup layer must be see-through (it sits on top of the page)
  let clear = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] === 0) clear++;
  assert.ok(clear > (px.length / 4) * 0.9, 'markup layer is transparent around the markups: ' + clear);
  // and the markup is drawn exactly where it is: line at y=405 pt -> 810 px at 2x, x 110..610 px
  const row = (y: number) => { let n = 0; for (let x = 0; x < 800; x++) if (px[(y * 800 + x) * 4 + 3]) n++; return n; };
  assert.ok(row(810) > 400, 'line drawn on its own row: ' + row(810));
  assert.equal(row(700), 0, 'nothing drawn where there is no markup');
  // a tile that doesn't start at 0,0 (zoomed in): same line, shifted
  const t2 = mu.renderAnnots('a', 0, 4, 400, 1500, 512, 512)!;
  let hit = 0;
  for (let x = 0; x < 512; x++) if (t2[((1620 - 1500) * 512 + x) * 4 + 3]) hit++;
  assert.ok(hit > 300, 'line in a zoomed tile at the right place: ' + hit);
  mu.close('a');
});

test('callout, stamp design, image stamp, flatten one', () => {
  mu.open('b', spec);
  const c = mu.createAnnot('b', 0, { type: 'FreeText', rect: [300, 40, 500, 100], contents: 'Check beam', font: { size: 11, color: [0, 0, 1] }, intent: 'FreeTextCallout', callout: [[250, 200], [280, 100], [300, 70]], kind: 'callout' });
  assert.equal(c.kind, 'callout');
  assert.equal(c.callout!.length, 3);
  const st = mu.createAnnot('b', 0, { type: 'Stamp', rect: [50, 600, 250, 660], design: { lines: [{ text: 'RECEIVED - CHECKED', size: 16, bold: true }, { text: 'Tester 22/10/2026', size: 9 }], color: [0.035, 0.19, 0.18], border: 'double' } });
  assert.ok(st.rect[3] > st.rect[1]);
  const before = textOf(mu.save('b'));
  assert.ok(!before.includes('RECEIVED - CHECKED'), 'stamp is a markup, not page text yet');
  assert.equal(mu.flatten('b', [{ page: 0, id: st.id }]), 1);
  const after = mu.save('b');
  assert.ok(textOf(after).includes('RECEIVED - CHECKED'), 'flattened stamp is page content');
  assert.equal(mu.annots('b', 0).filter((a) => a.type === 'FreeText').length, 1, 'callout untouched');
  mu.close('b');
});

test('copy to pages: a picture stamp onto sheets of other sizes, same spot from the corner, one undo', () => {
  const d = new mupdf.PDFDocument();
  for (const [w, h] of [[1191, 842], [2384, 1684], [595, 842]]) d.insertPage(-1, d.addPage([0, 0, w, h], 0, {}, ''));
  mu.open('cp', d.saveToBuffer('').asUint8Array().slice());
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 40], true);
  pm.clear(); // transparent
  const px = pm.getPixels();
  for (let i = 0; i < 40 * 40; i++) { const x = i % 40, y = (i / 40) | 0; if ((x - 20) ** 2 + (y - 20) ** 2 < 300) { px[i * 4] = 20; px[i * 4 + 1] = 60; px[i * 4 + 2] = 200; px[i * 4 + 3] = 255; } }
  const st = mu.createAnnot('cp', 0, { type: 'Stamp', image: pm.asPNG(), rect: [991, 692, 1141, 792], kind: 'image', subject: 'Seal' });
  const targets = [{ page: 1, dx: 2384 - 1191, dy: 1684 - 842 }, { page: 2, dx: 595 - 1191, dy: 0 }];
  const made = mu.copyToPages('cp', [{ items: [{ page: 0, id: st.id }], targets }]);
  assert.equal(made.length, 2);
  const r1 = mu.annots('cp', 1)[0].rect, r2 = mu.annots('cp', 2)[0].rect;
  assert.ok(Math.abs(2384 - r1[2] - 50) < 0.6 && Math.abs(1684 - r1[3] - 50) < 0.6, 'A1: 50 pt from the right and bottom edges, as on the A3: ' + r1.map(Math.round));
  assert.ok(Math.abs(595 - r2[2] - 50) < 0.6 && Math.abs(842 - r2[3] - 50) < 0.6, 'A4 portrait too: ' + r2.map(Math.round));
  // the picture came along (MuPDF can't draw a picture stamp again)
  const f = new mupdf.PDFDocument(mu.save('cp'));
  const ap = (f.loadPage(1) as mupdf.PDFPage).getAnnotations()[0].getObject().get('AP', 'N');
  let images = 0;
  const walk = (o: mupdf.PDFObject, depth: number) => { if (depth > 6 || o.isNull()) return; const x = o.get('Resources').get('XObject'); if (x.isDictionary()) x.forEach((v: mupdf.PDFObject) => { if (v.get('Subtype').asName() === 'Image') images++; else walk(v, depth + 1); }); };
  walk(ap, 0);
  assert.ok(images >= 1, 'the copy has the picture');
  // resized (a tester's video: a round seal came out 3.8 : 1 - MuPDF's own stamp shape): the box asked for
  mu.resizeAnnot('cp', 1, mu.annots('cp', 1)[0].id, [100, 100, 200, 200]);
  const rr = mu.annots('cp', 1)[0].rect;
  assert.ok(Math.abs(rr[2] - rr[0] - 100) < 0.6 && Math.abs(rr[3] - rr[1] - 100) < 0.6, 'a resized picture stamp keeps the box it was given: ' + rr.map(Math.round));
  mu.undo('cp');
  mu.undo('cp');
  assert.equal(mu.annots('cp', 1).length + mu.annots('cp', 2).length, 0, 'one Ctrl+Z takes back every copy');
  assert.equal(mu.annots('cp', 0).length, 1, 'the original stays');
  mu.close('cp');
});

test('copy to pages on a long file: in parts, quick, still one undo / redo', () => {
  const d = new mupdf.PDFDocument();
  for (let i = 0; i < 400; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  mu.open('cpl', d.saveToBuffer('').asUint8Array().slice());
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 30, 30], true);
  pm.clear();
  const st = mu.createAnnot('cpl', 0, { type: 'Stamp', image: pm.asPNG(), rect: [400, 700, 550, 800], kind: 'image' });
  const sq = mu.createAnnot('cpl', 0, { type: 'Square', rect: [380, 690, 570, 810], color: [1, 0, 0], bw: 1 });
  const t0 = performance.now();
  const made = mu.copyToPages('cpl', [{ items: [{ page: 0, id: st.id }, { page: 0, id: sq.id }], targets: [...Array(399).keys()].map((i) => ({ page: i + 1, dx: 0, dy: 0 })) }]);
  const ms = performance.now() - t0;
  assert.equal(made.length, 798);
  assert.ok(ms < 8000, '399 pages x 2 markups in ' + Math.round(ms) + ' ms (one MuPDF operation: 26 s for 400)');
  assert.deepEqual(mu.history('cpl').undo.slice(-1), ['Copy to pages'], 'one step in the list');
  mu.undo('cpl');
  let left = 0;
  for (let i = 1; i < 400; i++) left += mu.annots('cpl', i).length;
  assert.equal(left, 0, 'one undo takes back every part');
  assert.equal(mu.annots('cpl', 0).length, 2);
  mu.redo('cpl');
  let back = 0;
  for (let i = 1; i < 400; i++) back += mu.annots('cpl', i).length;
  assert.equal(back, 798, 'one redo puts them all back');
  mu.undo('cpl');
  mu.undo('cpl');
  assert.equal(mu.annots('cpl', 0).length, 1, 'and the step before is untouched');
  mu.close('cpl');
});

test('a picture stamp on a page turned a quarter stays upright and keeps its shape', () => {
  for (const rot of [0, 90, 180, 270]) {
    const d = new mupdf.PDFDocument();
    d.insertPage(-1, d.addPage([0, 0, 595, 842], rot as mupdf.Rotate, {}, ''));
    mu.open('rp' + rot, d.saveToBuffer('').asUint8Array().slice());
    // a picture: red top half, blue bottom half, twice as wide as tall
    const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false);
    const px = pm.getPixels();
    for (let i = 0; i < 40 * 20; i++) { const top = ((i / 40) | 0) < 10; px[i * 3] = top ? 230 : 20; px[i * 3 + 1] = 20; px[i * 3 + 2] = top ? 20 : 230; }
    const a = mu.createAnnot('rp' + rot, 0, { type: 'Stamp', image: pm.asPNG(), rect: [100, 100, 300, 200], kind: 'image' });
    mu.resizeAnnot('rp' + rot, 0, a.id, [100, 100, 300, 200]); // (redrawn by finish)
    const f = new mupdf.PDFDocument(mu.save('rp' + rot));
    const page = f.loadPage(0);
    const pix = page.toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
    const W = pix.getWidth(), q = pix.getPixels(), n = pix.getNumberOfComponents();
    const at = (x: number, y: number) => { const i = (y * W + x) * n; return [q[i], q[i + 1], q[i + 2]]; };
    // (page space as shown: the box 100..300 x 100..200)
    const top = at(200, 120), bottom = at(200, 180), outsideRight = at(305, 150);
    assert.ok(top[0] > 150 && top[2] < 100, `rotation ${rot}: red at the top of the box as shown (${top})`);
    assert.ok(bottom[2] > 150 && bottom[0] < 100, `rotation ${rot}: blue at the bottom (${bottom})`);
    assert.ok(outsideRight[0] > 200 && outsideRight[1] > 200, `rotation ${rot}: nothing outside the box (${outsideRight})`);
    mu.close('rp' + rot);
  }
});

test('callouts on pages turned 270 degrees keep their tip (MuPDF garbled the line there)', () => {
  for (const rot of [0, 90, 180, 270]) {
    const d = new mupdf.PDFDocument();
    d.insertPage(-1, d.addPage([0, 0, 595, 842], rot as mupdf.Rotate, {}, ''));
    d.insertPage(-1, d.addPage([0, 0, 595, 842], 270, {}, ''));
    const id = 'co' + rot;
    mu.open(id, d.saveToBuffer('').asUint8Array().slice());
    const c = mu.createAnnot(id, 0, { type: 'FreeText', rect: [300, 100, 450, 140], contents: 'Check', font: { size: 11, color: [0, 0, 1] }, intent: 'FreeTextCallout', callout: [[200, 300], [250, 120], [300, 120]], kind: 'callout', autoWidth: 360 });
    const tip = () => mu.annots(id, 0)[0].callout![0].map(Math.round);
    assert.deepEqual(tip(), [200, 300], rot + ': made');
    mu.updateAnnots(id, [{ page: 0, id: c.id, patch: { contents: 'Check the beam size against the structural drawings, level 3' } }]);
    assert.deepEqual(tip(), [200, 300], rot + ': grown with its text');
    mu.moveAnnots(id, [{ page: 0, id: c.id }], 10, 10);
    mu.resizeAnnot(id, 0, c.id, [310, 110, 480, 190]);
    assert.deepEqual(tip(), [200, 300], rot + ': moved and resized');
    mu.copyToPages(id, [{ items: [{ page: 0, id: c.id }], targets: [{ page: 1, dx: 0, dy: 0 }] }]);
    assert.deepEqual(mu.annots(id, 1)[0].callout![0].map(Math.round), [200, 300], rot + ': copied onto a 270-degree page');
    mu.close(id);
  }
});

test('pages: rotate, delete, reorder, insert, extract, merge; undo restores', () => {
  mu.open('c', spec);
  let pages = mu.rotatePages('c', [0], 90);
  assert.equal(pages[0].rot, 90);
  assert.equal(Math.round(pages[0].w), 842);
  pages = mu.deletePages('c', [1, 2]);
  assert.equal(pages.length, 1498);
  pages = mu.arrangePages('c', [2, 1, 0, ...Array.from({ length: 1495 }, (_, i) => i + 3)]);
  const u = mu.undo('c');
  assert.equal(u.kind, 'c');
  assert.equal(u.pages!.length, 1498);
  mu.undo('c');
  assert.equal(mu.countPages('c'), 1500);
  pages = mu.insertBlank('c', 0, 595, 842);
  assert.equal(pages.length, 1501);
  pages = mu.insertFrom('c', 1, rotatedDoc());
  assert.equal(pages.length, 1502);
  assert.equal(pages[1].rot, 90);
  const ex = mu.extract('c', [1, 5]);
  assert.equal(mu.pageCountOf(ex), 2);
  const m = mu.merge([{ name: 'a.pdf', bytes: ex }, { name: 'b.pdf', bytes: rotatedDoc() }]);
  assert.equal(mu.pageCountOf(m), 3);
  mu.close('c');
});

test('redaction really removes the text; text edit replaces it', () => {
  mu.open('d', spec);
  const hits = mu.searchQuads('d', 5, 'clause 17');
  assert.equal(hits.length, 1);
  mu.createAnnot('d', 5, { type: 'Redact', rect: mu.tighten(hits[0]) });
  assert.equal(mu.applyRedactions('d'), 1);
  const b = mu.save('d');
  assert.ok(!textOf(b, 5).includes('clause 17.'), 'redacted text gone from the file');
  assert.ok(textOf(b, 5).includes('clause 16.'), 'neighbours kept');
  // edit a line
  const blocks = mu.textBlocks('d', 0);
  const line = blocks[0].lines[0];
  assert.match(line.text, /SECTION 1/);
  mu.replaceText('d', 0, [line.bbox], 'SECTION 1 - SPECIFICATION FOR STEEL WORKS', line.origin, { size: line.size, color: line.color, family: 'serif' });
  const t = textOf(mu.save('d'), 0);
  assert.ok(t.includes('STEEL WORKS'));
  assert.ok(!t.includes('CONCRETE WORKS'));
  assert.ok(t.includes('The Contractor shall'), 'other lines untouched');
  mu.close('d');
});

test('OCR text layer is searchable, also on a rotated page', () => {
  mu.open('e', rotatedDoc());
  const info = mu.pageInfos('e')[0];
  mu.addTextLayer('e', 0, [{ text: 'HELLO', box: [100, 100, 200, 130] }, { text: 'مرحبا', box: [220, 100, 300, 130] }]);
  const b = mu.save('e');
  const d = mupdf.Document.openDocument(b, 'application/pdf');
  const hits = d.loadPage(0).search('HELLO', '');
  assert.equal(hits.length, 1);
  const q = hits[0][0] as unknown as number[];
  assert.ok(Math.abs(q[0] - 100) < 3 && Math.abs(q[1] - 100) < 8, 'found where it was put: ' + q.map(Math.round));
  assert.ok(d.loadPage(0).toStructuredText('').asText().includes('مرحبا'), 'Arabic text kept');
  assert.equal(Math.round(info.w), 595);
  // re-running replaces, doesn't stack
  mu.addTextLayer('e', 0, [{ text: 'HELLO', box: [100, 100, 200, 130] }]);
  const d2 = mupdf.Document.openDocument(mu.save('e'), 'application/pdf');
  assert.equal(d2.loadPage(0).search('HELLO', '').length, 1);
  mu.close('e');
});

test('page marks: numbers, bates, watermark; batch stamping', () => {
  mu.open('f', rotatedDoc());
  mu.markPages('f', [
    { kind: 'text', text: 'Page {page} of {pages}', pos: 'bc', size: 9 },
    { kind: 'text', text: '{bates}', pos: 'br', size: 8 },
    { kind: 'text', text: 'FOR TENDER ONLY', pos: 'mc', size: 60, angle: 45, opacity: 0.2, color: [0.8, 0, 0] },
  ], { file: 'x.pdf', date: '22/10/2026', batesPrefix: 'DOC-', batesStart: 7, batesDigits: 5 });
  const t = textOf(mu.save('f'));
  assert.ok(t.includes('Page 1 of 1'));
  assert.ok(t.includes('DOC-00007'));
  assert.ok(t.includes('FOR TENDER ONLY'));
  mu.close('f');
  const r = mu.batchMark(spec, [{ kind: 'stamp', pos: 'tr', width: 120, design: { lines: [{ text: 'T0001 SAMPLE', size: 12, bold: true }], color: [0, 0.2, 0.2], border: 'box' } }], { file: 's', date: 'd', pageTo: 3 });
  assert.equal(r.pages, 3);
});

test('save with password; compress keeps line work', () => {
  mu.open('g', spec);
  const enc = mu.save('g', { password: { user: 'abc', owner: 'own' } });
  const o = mu.open('g2', enc);
  assert.equal(o.needsPassword, true);
  assert.equal(mu.open('g2', enc, 'abc').pages.length, 1500);
  mu.close('g'); mu.close('g2');
  // picture-heavy file: a big photo-like image on a page
  const d = new mupdf.PDFDocument();
  const raw = new Uint8Array(3000 * 2000 * 3);
  let sd = 1;
  for (let i = 0; i < raw.length; i++) { sd = (sd * 1103515245 + 12345) & 0x7fffffff; raw[i] = ((i / 3) % 3000) / 12 + ((sd >> 24) % 40); }
  const img = d.addStream(raw, { Type: 'XObject', Subtype: 'Image', Width: 3000, Height: 2000, BitsPerComponent: 8, ColorSpace: 'DeviceRGB' });
  d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, { XObject: { Im0: img } }, 'q 842 0 0 595 0 0 cm /Im0 Do Q 0 0 1 RG 10 10 m 800 500 l S'));
  const big = d.saveToBuffer('compress').asUint8Array().slice();
  const { bytes, report } = mu.compress(big, { dpi: 150, quality: 70 });
  assert.equal(report.changed, 1);
  assert.ok(bytes && bytes.length < big.length / 3, `shrunk ${big.length} -> ${bytes?.length}`);
});

test('PDFium: draws, finds text where MuPDF has it, same page space on rotated pages', async () => {
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const rot = rotatedDoc();
  const info = pf.openDoc('r', rot);
  assert.equal(Math.round(info.pages[0].w), 595, 'rotated size as shown');
  const hits = pf.find('r', 'ROTATED', 0, 1);
  assert.equal(hits.length, 1);
  mu.open('r', rot);
  const mq = mu.searchQuads('r', 0, 'ROTATED')[0];
  const pr = hits[0].rects[0];
  assert.ok(Math.abs((pr[0] + pr[2]) / 2 - (mq[0] + mq[2]) / 2) < 4 && Math.abs((pr[1] + pr[3]) / 2 - (mq[1] + mq[3]) / 2) < 4, `pdfium ${pr.map(Math.round)} vs mupdf ${mq.map(Math.round)}`);
  const ch = pf.chars('r', 0);
  assert.ok(ch.text.startsWith('ROTATED SHEET'));
  // heavy sheet: open + zoomed tile
  let t = performance.now();
  const h = pf.openDoc('h', heavy);
  const open = performance.now() - t;
  t = performance.now();
  const tile = pf.render('h', 0, 4, 6000, 4000, 512, 512);
  const tileMs = performance.now() - t;
  console.log(`  heavy A0: open ${open.toFixed(0)} ms, 512px tile at 4x ${tileMs.toFixed(0)} ms`);
  assert.equal(tile.length, 512 * 512 * 4);
  assert.equal(Math.round(h.pages[0].w), 3370);
  // long spec: search all 1500 pages
  pf.openDoc('s', spec);
  t = performance.now();
  const all = pf.find('s', 'clause 17', 0, 1500);
  console.log(`  search 1500 pages: ${all.length} hits in ${(performance.now() - t).toFixed(0)} ms`);
  assert.equal(all.length, 1500);
  pf.closeDoc('r'); pf.closeDoc('h'); pf.closeDoc('s');
});

test('markup ids survive saving; rotation; stamp keeps its design when moved', () => {
  mu.open('h', spec);
  const st = mu.createAnnot('h', 0, { type: 'Stamp', rect: [50, 50, 250, 110], design: { lines: [{ text: 'SITE RECEIVED', size: 16, bold: true }], color: [0, 0.3, 0.3], border: 'box' } });
  mu.save('h');
  mu.save('h', { incremental: true });
  const moved = mu.moveAnnots('h', [{ page: 0, id: st.id }], 10, 10)[0];
  assert.equal(moved.id, st.id);
  let t = textOf(mu.save('h'));
  void t;
  const d = mupdf.Document.openDocument(mu.save('h'), 'application/pdf');
  const ap = (d.loadPage(0) as mupdf.PDFPage).getAnnotations()[0].getObject().get('AP', 'N').readStream().asString();
  assert.ok(ap.includes('SITE RECEIVED') || ap.includes('/FB'), 'still our stamp after moving');
  const r = mu.updateAnnots('h', [{ page: 0, id: st.id, patch: { angle: 30 } }])[0];
  assert.equal(r.angle, 30);
  assert.ok(r.rect[3] - r.rect[1] > r.box![3] - r.box![1], 'rotated bounds are taller');
  const back = mu.updateAnnots('h', [{ page: 0, id: st.id, patch: { angle: 0 } }])[0];
  assert.ok(!back.angle);
  assert.equal(mu.undo('h').ok, true);
  mu.close('h');
});

test('redacted text is not left anywhere in the saved file', () => {
  mu.open('k', spec);
  const hits = mu.searchQuads('k', 3, 'clause 9');
  mu.createAnnot('k', 3, { type: 'Redact', rect: mu.tighten(hits[0]) });
  mu.applyRedactions('k');
  const b = mu.save('k');
  // decompress everything and look for the words
  const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  const raw = d.saveToBuffer('decompress').asUint8Array();
  const s = new TextDecoder('latin1').decode(raw);
  assert.ok(!s.includes('(3.9 The Contractor shall provide all labour plant and materials as required by clause 9.)'), 'old line not in file');
  assert.ok(s.includes('(3.8 The Contractor'), 'sanity: neighbours are there');
  mu.close('k');
});

test('text edit with characters beyond Western European (embedded font)', () => {
  mu.open('u', spec);
  const line = mu.textBlocks('u', 0)[0].lines[0];
  // (any TrueType font with these letters: the Linux test machine's, or Windows' own)
  const font = new Uint8Array(readFileSync(['/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'times.ttf')].find((f) => existsSync(f)) || 'DejaVuSerif.ttf'));
  mu.replaceText('u', 0, [line.bbox], 'SECTION 1 – f′c ≥ 40 MPa, Ø16 @ 150 → Δ', line.origin, { size: line.size, color: line.color, family: 'serif' }, [1, 0], font);
  const t = textOf(mu.save('u'), 0);
  assert.ok(t.includes('≥ 40 MPa') && t.includes('→ Δ'), t.split('\n')[0]);
  mu.close('u');
});

test('rotated sheets: stamps, labels, text boxes look the same at 0/90/180/270', () => {
  const layers: Uint8ClampedArray[] = [];
  for (const rot of [0, 90, 180, 270]) {
    const d = new mupdf.PDFDocument();
    d.insertPage(-1, d.addPage([0, 0, 842, 595], rot, {}, ''));
    const id = 'rot' + rot;
    mu.open(id, d.saveToBuffer('').asUint8Array().slice());
    mu.createAnnot(id, 0, { type: 'Polygon', vertices: [[40, 40], [200, 40], [200, 150], [40, 150]], color: [0, 0, 1], ic: [0.7, 0.8, 1], kind: 'measure-area', contents: '149.34 m²' });
    const st = mu.createAnnot(id, 0, { type: 'Stamp', rect: [230, 40, 400, 90], design: { lines: [{ text: 'APPROVED', size: 18, bold: true }, { text: 'name – date', size: 8 }], color: [0, 0.5, 0.2], border: 'double' } });
    mu.updateAnnots(id, [{ page: 0, id: st.id, patch: { angle: 30 } }]);
    mu.createAnnot(id, 0, { type: 'FreeText', rect: [230, 130, 400, 165], contents: 'Text box', font: { size: 14, color: [1, 0, 0] }, bw: 1, angle: -20 });
    mu.createAnnot(id, 0, { type: 'Line', line: [[40, 230], [260, 230]], le: ['OpenArrow', 'OpenArrow'], contents: '6.25 m', kind: 'measure-length', color: [0, 0, 1] });
    // a status change and a move must not stack labels
    const area = mu.annots(id, 0).find((a) => a.kind === 'measure-area')!;
    mu.updateAnnots(id, [{ page: 0, id: area.id, patch: { state: 'Accepted' } }]);
    mu.moveAnnots(id, [{ page: 0, id: area.id }], 0, 0);
    mu.open(id + 's', mu.save(id));
    layers.push(mu.renderAnnots(id + 's', 0, 1, 0, 0, 480, 300)!);
    mu.close(id); mu.close(id + 's');
  }
  for (let k = 1; k < 4; k++) {
    let diff = 0, ink = 0;
    for (let i = 3; i < layers[0].length; i += 4) {
      if (layers[0][i] > 40 || layers[k][i] > 40) ink++;
      if (Math.abs(layers[0][i] - layers[k][i]) > 90) diff++;
    }
    assert.ok(diff / ink < 0.06, `rotation ${k * 90}: ${(100 * diff / ink).toFixed(1)}% of the markup pixels differ`);
  }
});

test('a measured length: its arrows are sized from its number, not from its line width', () => {
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, {}, ''));
  mu.open('arw', d.saveToBuffer('').asUint8Array().slice());
  // (measured zoomed in: a 3 pt number, a thin line)
  const m = mu.createAnnot('arw', 0, { type: 'Line', line: [[40, 230], [260, 230]], le: ['OpenArrow', 'OpenArrow'], contents: '6.250 m', kind: 'measure-length', color: [0, 0, 1], bw: 0.2, labelSize: 3 });
  const look = () => {
    const f = new mupdf.PDFDocument(mu.save('arw'));
    const a = (f.loadPage(0) as mupdf.PDFPage).getAnnotations()[0];
    const ap = a.getObject().get('AP', 'N');
    const outer = ap.readStream().asString();
    const inner = ap.get('Resources').get('XObject').get('X0').readStream().asString();
    const le = a.getObject().get('LE');
    const seg = outer.slice(outer.indexOf('[] 0 d'), outer.indexOf('Q', outer.indexOf('[] 0 d')));
    const nums = (seg.match(/-?\d+(\.\d+)?/g) || []).map(Number).slice(1); // (after the "0" of "[] 0 d")
    const xs = nums.filter((_, i) => i % 2 === 0);
    const left = xs.filter((x) => x < 150);
    return { outer, inner, le: [le.get(0).asName(), le.get(1).asName()], head: Math.max(...left) - Math.min(...left), rect: a.getObject().get('Rect').asJS() as number[] };
  };
  let r = look();
  assert.deepEqual(r.le, ['OpenArrow', 'OpenArrow'], 'its line endings are still named in the file (other programs)');
  assert.equal((r.inner.match(/(^|\s)S(?=\s|$)/g) || []).length, 1, "MuPDF's drawing is just the line");
  assert.ok(Math.abs(r.head - 2.7) < 0.15, `the arrow about as long as the number is tall: ${r.head.toFixed(2)} pt for a 3 pt number`);
  assert.ok(r.rect[3] - r.rect[1] < 9, 'its box is small too (no 10 pt arrows): ' + (r.rect[3] - r.rect[1]).toFixed(1));
  // the number made bigger (the file's number size): the arrows grow with it
  mu.updateAnnots('arw', [{ page: 0, id: m.id, patch: { labelSize: 24 } }]);
  r = look();
  assert.ok(Math.abs(r.head - 21.6) < 0.5, `24 pt number: ${r.head.toFixed(2)} pt arrow`);
  // other endings too, and a closed arrow is filled
  mu.updateAnnots('arw', [{ page: 0, id: m.id, patch: { le: ['Slash', 'ClosedArrow'] } }]);
  r = look();
  assert.deepEqual(r.le, ['Slash', 'ClosedArrow']);
  assert.ok(/ h b\n/.test(r.outer.slice(0, r.outer.indexOf('/GSb'))) && !/\b[fb]\b/.test(r.inner), 'the closed arrow drawn (filled) with the number');
  mu.close('arw');
});

test('a measured length the app draws no number for keeps the PDF engine\'s own arrows', () => {
  const painted = (t: string) => (t.match(/(^|\s)[fbBsS]\*?(?=\s|$)/g) || []).length;
  const drawn = (id: string) => {
    const f = new mupdf.PDFDocument(mu.save(id));
    const ap = (f.loadPage(0) as mupdf.PDFPage).getAnnotations()[0].getObject().get('AP', 'N');
    const res = ap.get('Resources');
    const x0 = res.isNull() || res.get('XObject').isNull() ? null : res.get('XObject').get('X0');
    return painted(ap.readStream().asString()) + (x0 && !x0.isNull() ? painted(x0.readStream().asString()) : 0);
  };
  // an older file: its number is MuPDF's caption
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, {}, ''));
  const a = (d.loadPage(0) as mupdf.PDFPage).createAnnotation('Line');
  a.setLine([100, 230] as never, [400, 230] as never);
  a.setLineEndingStyles('ClosedArrow', 'ClosedArrow');
  a.setContents('6.250 m');
  a.setLineCaption(true);
  a.getObject().put('GCCKind', d.newName('measure-length'));
  a.update();
  mu.open('cap', d.saveToBuffer('').asUint8Array().slice());
  const m = mu.annots('cap', 0)[0];
  mu.updateAnnots('cap', [{ page: 0, id: m.id, patch: { color: [1, 0, 0] } }]);
  mu.updateAnnots('cap', [{ page: 0, id: m.id, patch: { labelSize: 12 } }]);
  assert.equal(drawn('cap'), 3, 'captioned: line + both arrows after changes');
  mu.close('cap');
  // its number cleared
  const e = new mupdf.PDFDocument();
  e.insertPage(-1, e.addPage([0, 0, 842, 595], 0, {}, ''));
  mu.open('nolab', e.saveToBuffer('').asUint8Array().slice());
  const n = mu.createAnnot('nolab', 0, { type: 'Line', line: [[40, 230], [260, 230]], le: ['ClosedArrow', 'ClosedArrow'], contents: '6.250 m', kind: 'measure-length', color: [0, 0, 1], labelSize: 10 });
  mu.updateAnnots('nolab', [{ page: 0, id: n.id, patch: { contents: '' } }]);
  assert.equal(drawn('nolab'), 3, 'no number: line + both arrows');
  mu.close('nolab');
});

test('files read on demand: open from disk, changes written as a small delta, drawn by PDFium', async () => {
  const { VFile, tempPath, writeView } = await import('../src/engine/files');
  const { writeFileSync, statSync } = await import('node:fs');
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const orig = tempPath('spec.pdf');
  writeFileSync(orig, spec);
  const r = mu.open('vf', new VFile({ path: orig }));
  assert.ok(r.pages.length > 100);
  // a content change: rotate page 3
  mu.rotatePages('vf', [2], 90);
  const delta = tempPath('changes.bin');
  const s = mu.snapshotTo('vf', (v, from) => writeView(delta, v, from));
  assert.equal(s.base, spec.length, 'incremental: the original + appended changes');
  assert.ok(statSync(delta).size < 200_000, 'delta is small: ' + statSync(delta).size);
  // PDFium reads original + delta as one file and sees the rotation
  const info = pf.openDoc('vf', new VFile({ path: orig, size: s.base, delta }));
  const p2 = info.pages[2], p1 = info.pages[1];
  assert.ok(Math.abs(p2.w - p1.h) < 1 && Math.abs(p2.h - p1.w) < 1, 'page 3 rotated in the drawing engine');
  const px = pf.render('vf', 2, 0.5, 0, 0, 100, 100);
  assert.equal(px.length, 100 * 100 * 4);
  // MuPDF can open the same pair too (recovery), and markups made after survive a reopen
  mu.createAnnot('vf', 0, { type: 'Square', rect: [50, 50, 150, 150] } as never);
  const d2 = tempPath('changes2.bin');
  const s2 = mu.snapshotTo('vf', (v, from) => writeView(d2, v, from));
  mu.close('vf');
  mu.open('vf2', new VFile({ path: orig, size: s2.base, delta: d2 }));
  assert.equal(mu.annots('vf2', 0).filter((a) => a.type === 'Square').length, 1);
  assert.equal(mu.pageInfos('vf2')[2].w, mu.pageInfos('vf2')[1].h);
  mu.close('vf2');
  pf.closeDoc('vf');
});

test('saving twice in a row (incremental) gives a clean file each time', () => {
  mu.open('inc', spec);
  mu.createAnnot('inc', 0, { type: 'Square', rect: [50, 50, 150, 150] } as never);
  const b1 = mu.save('inc', { incremental: true });
  mu.createAnnot('inc', 0, { type: 'Square', rect: [250, 50, 350, 150] } as never);
  const b2 = mu.save('inc', { incremental: true });
  mu.close('inc');
  for (const [b, n] of [[b1, 1], [b2, 2]] as const) {
    const r = mu.open('inc2', b);
    assert.equal(r.repaired, false, 'not damaged');
    assert.equal(mu.annots('inc2', 0).filter((a) => a.type === 'Square').length, n);
    mu.close('inc2');
  }
});

test('a file whose index merely points off is repaired quietly; a cut-short one is told', () => {
  // (as a quotation from Excel 2016: the body's line ends don't match what the index says)
  const head = spec.indexOf(10) + 1;
  const tail = new TextDecoder('latin1').decode(spec.subarray(spec.length - 4096));
  assert.ok(tail.includes('startxref'), 'fixture has a classic end');
  const off = new Uint8Array(spec.length + 7);
  off.set(spec.subarray(0, head));
  off.fill(32, head, head + 7); // 7 spaces near the top: every offset after them is off
  off.set(spec.subarray(head), head + 7);
  const r = mu.open('rq', off);
  assert.equal(r.repaired, true, 'index rebuilt');
  assert.equal(r.lossy, false, 'nothing missing: not told');
  assert.equal(r.pages.length, mu.open('rq0', spec).pages.length, 'every page there');
  mu.close('rq'); mu.close('rq0');
  const cut = spec.slice(0, Math.floor(spec.length * 0.6));
  const c = mu.open('rc', cut);
  assert.equal(c.repaired, true);
  assert.equal(c.lossy, true, 'cut short: told');
  mu.close('rc');
  // a page's content cut out of the middle (the index off after it): the page dict is there, its
  // content leads nowhere - told (0.9.7 run 1 quietly opened it blank)
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, 'BT /F1 24 Tf 72 700 Td (KEEP) Tj ET'));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, 'BT /F1 24 Tf 72 700 Td (LOST PAGE CONTENT) Tj ET'));
  const raw = new TextDecoder('latin1').decode(d.saveToBuffer('').asUint8Array());
  const m = /\n(\d+) 0 obj\s*<<[^>]*\/Length[^>]*>>\s*stream\s*BT \/F1 24 Tf 72 700 Td \(LOST/.exec(raw)!;
  const at = m.index + 1, end = raw.indexOf('endobj', at) + 6;
  const holed = Uint8Array.from(raw.slice(0, at) + raw.slice(end), (ch) => ch.charCodeAt(0));
  const h = mu.open('rh', holed);
  assert.equal(h.repaired, true);
  assert.equal(h.pages.length, 2);
  assert.equal(h.lossy, true, 'a page\'s content gone: told');
  mu.close('rh');
  // junk after the end (5 KB - more than the 4 KB looked at up to 0.9.6), nothing missing: quiet
  const junk = new Uint8Array(off.length + 5000); junk.set(off); junk.fill(32, off.length);
  const j = mu.open('rj', junk);
  assert.equal(j.lossy, false, 'junk after %%EOF: not told');
  mu.close('rj');
});

test('after a redaction, later saves never bring the removed text back (no incremental)', () => {
  mu.open('k2', spec);
  const hits = mu.searchQuads('k2', 3, 'clause 9');
  mu.createAnnot('k2', 3, { type: 'Redact', rect: mu.tighten(hits[0]) });
  mu.applyRedactions('k2');
  mu.save('k2');
  mu.createAnnot('k2', 0, { type: 'Square', rect: [50, 50, 150, 150] } as never);
  const b = mu.save('k2', { incremental: true });
  const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  const s = new TextDecoder('latin1').decode(d.saveToBuffer('decompress').asUint8Array());
  assert.ok(!s.includes('(3.9 The Contractor shall provide all labour plant and materials as required by clause 9.)'), 'redacted line not in the second save');
  mu.close('k2');
});

test('OCR text again after undo: clean text (no font left over from the undone layer)', async () => {
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const id = 'ou';
  mu.open(id, rotatedDoc());
  const words = [{ text: 'Variation', box: [100, 100, 200, 120] as mu.Rect }, { text: 'request', box: [210, 100, 290, 120] as mu.Rect }];
  const texts: string[] = [];
  for (let k = 0; k < 3; k++) {
    mu.addTextLayer(id, 0, words);
    pf.openDoc('ou', mu.snapshot(id));
    texts.push(pf.chars('ou', 0).text);
    mu.undo(id);
  }
  pf.closeDoc('ou');
  mu.close(id);
  for (const t of texts) {
    assert.ok(t.includes('Variation') && t.includes('request'), JSON.stringify(t));
    assert.ok(!/[\u0000-\u0008]/.test(t), 'no garbage: ' + JSON.stringify(t));
  }
  assert.equal(texts[1], texts[0]);
});

test('Arabic and PC fonts in text boxes: shaped, embedded (subset), drawn by PDFium, text kept; edited Arabic page text is findable', async () => {
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  if (!mu.fontFamilies().length) return; // no fonts on this machine
  const id = 'ar';
  mu.open(id, spec);
  const AR = 'ملاحظة: يرجى مراجعة البند 4.2';
  const ink = (bytes: Uint8Array, r: number[]) => {
    pf.openDoc('ink', bytes);
    const s = 2, w = Math.round((r[2] - r[0]) * s), h = Math.round((r[3] - r[1]) * s);
    const px = pf.render('ink', 0, s, r[0] * s, r[1] * s, w, h, true);
    pf.closeDoc('ink');
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.min(px[i], px[i + 1], px[i + 2]) < 110) n++;
    return n;
  };
  const a = mu.createAnnot(id, 0, { type: 'FreeText', rect: [60, 100, 300, 150], contents: AR, color: [1, 1, 0.85], bw: 1, font: { size: 12, color: [0, 0, 0] } });
  assert.equal(a.contents, AR, 'the Arabic text stays the markup\'s text');
  assert.ok(ink(mu.snapshot(id), a.rect) > 300, 'Arabic drawn (was an empty box)');
  const c = mu.createAnnot(id, 0, { type: 'FreeText', rect: [60, 200, 300, 240], contents: 'Calibri note', color: null, bw: 0, font: { size: 14, color: [0, 0, 0.6], family: 'Calibri', bold: true } });
  assert.deepEqual([c.font?.family, c.font?.bold], ['Calibri', true]);
  // an undo removes the embedded font: the next box must embed it again (not point at nothing)
  mu.undo(id); mu.undo(id);
  const b = mu.createAnnot(id, 0, { type: 'FreeText', rect: [60, 300, 300, 340], contents: AR, color: null, bw: 0, font: { size: 12, color: [0, 0, 0] } });
  const saved = mu.save(id);
  assert.ok(ink(saved, b.rect) > 300, 'drawn after an undo too');
  const d = mupdf.Document.openDocument(saved, 'application/pdf').asPDF()!;
  const fa = (d.loadPage(0) as mupdf.PDFPage).getAnnotations().find((x) => x.getType() === 'FreeText')!;
  assert.equal(fa.getContents(), AR);
  const f = fa.getObject().get('AP', 'N', 'Resources', 'Font');
  let sub = '';
  f.forEach((v: mupdf.PDFObject) => { const n = v.resolve().get('BaseFont'); if (n.isName() && n.asName().includes('+')) sub = n.asName(); });
  assert.ok(sub, 'the PC font is embedded as a subset');
  // Arabic typed onto the page: real text, found the right way round
  const lines = JSON.parse(mupdf.Document.openDocument(spec, 'application/pdf').loadPage(0).toStructuredText('').asJSON()).blocks[0].lines;
  const L = lines[4].bbox;
  mu.replaceText(id, 0, [[L.x, L.y, L.x + L.w, L.y + L.h]], 'يجب على المقاول توفير العمالة', [L.x, L.y + L.h * 0.8], { size: 11, color: [0, 0, 0] }, [1, 0]);
  pf.openDoc('art', mu.save(id));
  assert.equal(pf.find('art', 'المقاول', 0, 1).length, 1, 'Arabic page text is searchable');
  pf.closeDoc('art');
  mu.close(id);
});

// ---- found in the 0.5.0 review (bug hunt run 1)
function mini(opts = '', rotate: number | null = null, text = 'PAGE TEXT'): Uint8Array {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const p = d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, `BT /F1 20 Tf 100 700 Td (${text}) Tj ET`);
  if (rotate != null) p.put('Rotate', rotate);
  d.insertPage(-1, p);
  return d.saveToBuffer(opts).asUint8Array().slice();
}

test('count groups and review status are kept as text (were names - every count said #1)', () => {
  mu.open('cg', spec);
  const a = mu.createAnnot('cg', 0, { type: 'Circle', rect: [10, 10, 20, 20], kind: 'measure-count', group: 'Doors D1', contents: 'Doors D1 #1' } as never);
  assert.equal(a.group, 'Doors D1');
  const b = mu.updateAnnots('cg', [{ page: 0, id: a.id, patch: { state: 'Accepted' } }], 'Set status')[0];
  assert.equal(b.state, 'Accepted');
  const c = mu.updateAnnots('cg', [{ page: 0, id: a.id, patch: { state: '' } }], 'Set status')[0];
  assert.ok(!c.state, 'no status again');
  const d = mupdf.Document.openDocument(mu.save('cg'), 'application/pdf').asPDF()!;
  const o = (d.loadPage(0) as mupdf.PDFPage).getAnnotations().find((x) => x.getType() === 'Circle')!.getObject();
  assert.ok(o.get('GCCGroup').isString());
  mu.close('cg');
});

test('cut + paste: the copies kept aside are pasted after the originals are deleted', () => {
  mu.open('cut', spec);
  const a = mu.createAnnot('cut', 1, { type: 'Square', rect: [100, 100, 200, 150], color: [1, 0, 0] } as never);
  const kept = mu.clipStore('cut', [{ page: 1, id: a.id }]);
  mu.deleteAnnots('cut', [{ page: 1, id: a.id }]);
  const out = mu.copyAnnots(mu.CLIP, kept, 'cut', 1, 0, 0);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].rect.map(Math.round), [100, 100, 200, 150], 'back where it was');
  mu.close('cut');
});

test('editing a line of text leaves the person\'s redaction marks alone; text running down the sheet', () => {
  mu.open('rx', spec);
  const lines = JSON.parse(mupdf.Document.openDocument(spec, 'application/pdf').loadPage(0).toStructuredText('').asJSON()).blocks[0].lines;
  const L1 = lines[1].bbox, L2 = lines[2].bbox;
  mu.createAnnot('rx', 0, { type: 'Redact', rect: [L1.x, L1.y, L1.x + L1.w, L1.y + L1.h] } as never);
  mu.replaceText('rx', 0, [[L2.x, L2.y, L2.x + L2.w, L2.y + L2.h]], 'EDITED LINE', [L2.x, L2.y + L2.h * 0.8], { size: 11, color: [0, 0, 0] }, [1, 0]);
  assert.equal(mu.annots('rx', 0).filter((a) => a.type === 'Redact').length, 1, 'the mark is still there');
  const t = textOf(mu.save('rx'));
  assert.ok(t.includes(lines[1].text.slice(0, 20)), 'and its text is still there (not applied)');
  assert.ok(t.includes('EDITED LINE'));
  mu.close('rx');
  // vertical text: the whole line goes (was: first and last letters left over)
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, 'BT /F1 14 Tf 0 -1 1 0 300 700 Tm (VERTICAL TEXT) Tj ET'));
  mu.open('vt', d.saveToBuffer('').asUint8Array().slice());
  const bl = mu.textBlocks('vt', 0).flatMap((b) => b.lines).find((l) => l.text.includes('VERTICAL'))!;
  mu.replaceText('vt', 0, [bl.bbox], 'NEW', bl.origin, { size: 14, color: [0, 0, 0] }, bl.dir);
  const tv = mu.textBlocks('vt', 0).flatMap((b) => b.lines).map((l) => l.text.trim()).filter(Boolean);
  assert.deepEqual(tv, ['NEW'], JSON.stringify(tv));
  mu.close('vt');
});

test('permissions-only protection is kept on save; no commas in passwords; odd /Rotate', () => {
  // owner password only ("print only"): still protected after a save
  const own = mini('encrypt=aes-256,owner-password=own,permissions=4');
  mu.open('ow', own);
  mu.createAnnot('ow', 0, { type: 'Square', rect: [50, 50, 150, 150] } as never);
  mu.rotatePages('ow', [0], 90);
  const sv = mupdf.Document.openDocument(mu.save('ow'), 'application/pdf').asPDF()!;
  assert.ok(!sv.getTrailer().get('Encrypt').isNull(), 'still encrypted');
  assert.ok(!sv.hasPermission('edit'), 'still edit-protected');
  mu.close('ow');
  assert.throws(() => { mu.open('pw', spec); try { mu.save('pw', { password: { user: 'a,b' } }); } finally { mu.close('pw'); } }, /comma/);
  // /Rotate 45: set to MuPDF's quarter turn (the drawing engine then gets that copy)
  const r = mu.open('rot', mini('', 45));
  assert.equal(r.pages[0].rot, 90);
  assert.equal(r.fixedTurn, true);
  mu.close('rot');
});

test('a password-protected file: the drawing engine opens the snapshots with the password', async () => {
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const enc = mini('encrypt=aes-256,user-password=abc,owner-password=own', null, 'SECRET TEXT');
  const r = mu.open('pw2', enc, 'abc');
  assert.equal(r.needsPassword, false);
  mu.createAnnot('pw2', 0, { type: 'Square', rect: [50, 50, 150, 150] } as never);
  pf.openDoc('pw2', mu.snapshot('pw2'), 'abc');
  assert.ok(pf.pageText('pw2', 0).includes('SECRET TEXT'));
  // a failed reopen keeps the copy that was open
  assert.throws(() => pf.openDoc('pw2', mu.snapshot('pw2'), 'wrong'));
  assert.ok(pf.pageText('pw2', 0).includes('SECRET TEXT'), 'still drawing the old copy');
  pf.closeDoc('pw2');
  mu.close('pw2');
});

test('heavy pages: millions of little strokes merged - same drawing, far fewer objects', async () => {
  const { mergeStrokes } = await import('../src/engine/strokes');
  // 60,000 separate short strokes (not touching), a fill, a clip, text with ( ) and \\ in it, an inline picture
  let c = 'q 0.5 w 0 0 1 RG\n';
  // (far enough apart that no pixel is shared: where anti-aliased edges overlap, two strokes and
  // one merged stroke shade that pixel a little differently - not visible, but not "equal")
  for (let i = 0; i < 60000; i++) { const x = 20 + (i % 400) * 4.5, y = 20 + Math.floor(i / 400) * 6; c += `${x.toFixed(1)} ${y.toFixed(1)} m ${(x + 1).toFixed(1)} ${(y + 1).toFixed(1)} l S\n`; if (i === 30000) c += '1 0 0 RG\n'; }
  c += 'Q q 0 1 0 rg 10 10 50 50 re f Q q 100 100 50 50 re W n 0 g 90 90 80 80 re f Q\n';
  c += 'BT /F1 12 Tf 50 960 Td (a \\(tricky\\) S m l string) Tj ET\n';
  c += 'q 10 0 0 10 500 960 cm BI /W 2 /H 2 /CS /G /BPC 8 ID A S m EI Q\n'; // (its data "A S " looks like operators)
  const bytes = new TextEncoder().encode(c);
  const r = mergeStrokes(bytes, 50000)!;
  assert.ok(r, 'merged');
  assert.equal(r.strokesIn, 60000);
  assert.ok(r.strokesOut < 60, 'strokes after merging: ' + r.strokesOut);
  const out = new TextDecoder('latin1').decode(r.out);
  assert.ok(out.includes('(a \\(tricky\\) S m l string) Tj'), 'text untouched');
  assert.ok(out.includes('re W n') && out.includes('re f'), 'fills / clips untouched');
  assert.ok(out.includes('ID A S m EI'), 'inline picture untouched');
  assert.ok(out.indexOf('1 0 0 RG') > out.indexOf('S\n') && out.indexOf('1 0 0 RG') < out.lastIndexOf('S\n'), 'colour change still between the strokes before and after it');
  // and it draws the same
  const mk = (content: string) => {
    const d = new mupdf.PDFDocument();
    const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
    d.insertPage(-1, d.addPage([0, 0, 1900, 1000], 0, { Font: { F1: f } }, content));
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 1900, 1000], false);
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    d.loadPage(0).run(dev, mupdf.Matrix.identity); dev.close();
    return pix.getPixels().slice();
  };
  const a = mk(c), b = mk(out);
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert.equal(diff, 0, 'pixels that differ');
  assert.equal(mergeStrokes(new TextEncoder().encode('0 0 m 1 1 l S 2 2 m 3 3 l S')), null, 'a normal page is left alone');
  // strokes whose path is interrupted (clip + stroke, colour / width set inside the path) or goes
  // on from the last point: written as they were, never dropped (debug run A)
  let c2 = 'q 0 0 1 RG 1 w\n';
  for (let i = 0; i < 4000; i++) {
    const x = 20 + (i % 200) * 9, y = 20 + Math.floor(i / 200) * 40;
    c2 += `${x} ${y} m ${x + 4} ${y + 4} l S\n`;
    if (i === 500) c2 += `${x} ${y + 10} 30 20 re W S\n`;
    if (i === 900) c2 += `${x} ${y + 12} m ${x + 6} ${y + 18} l 1 0 0 RG S 0 0 1 RG\n`;
    if (i === 1300) c2 += `${x} ${y + 12} m ${x + 6} ${y + 18} l 4 w S 1 w\n`;
    if (i === 1700) c2 += `${x} ${y + 12} m ${x + 6} ${y + 18} l S ${x + 12} ${y + 12} l S\n`;
  }
  c2 += 'Q\n';
  const r2 = mergeStrokes(new TextEncoder().encode(c2), 1000)!;
  assert.ok(r2 && r2.strokesOut < 100, 'merged: ' + r2?.strokesOut);
  const a2 = mk(c2), b2 = mk(new TextDecoder('latin1').decode(r2.out));
  let diff2 = 0;
  for (let i = 0; i < a2.length; i++) if (a2[i] !== b2[i]) diff2++;
  assert.equal(diff2, 0, 'interrupted strokes: pixels that differ');
});

/** a typewriter box as another program writes it: its own font resource, rich text, no colour in /DA */
function foreignTextDoc(withP = true): Uint8Array {
  const d = new mupdf.PDFDocument();
  const p = d.addPage([0, 0, 842, 1190], 0, {}, '');
  d.insertPage(-1, p);
  const page = d.findPage(0);
  const font = d.addObject(d.newDictionary());
  font.put('Type', d.newName('Font')); font.put('Subtype', d.newName('TrueType')); font.put('BaseFont', d.newName('Arial-BoldMT')); font.put('Encoding', d.newName('WinAnsiEncoding'));
  const ap = d.addStream('q 0 -15.624 123.018 15.624 re W n BT 1 0.078431 0.094118 rg 0 -6.335 Td /FXF1 7 Tf (Tower areas 255 days =  8.5 months, ) Tj 0 -7.812 Td (None tower 365 days = 12 Months ) Tj ET Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, -15.624, 123.018, 0], Resources: { Font: { FXF1: font } } });
  const an = d.addObject(d.newDictionary());
  const span = 'font-size:7pt;font-style:normal;font-weight:bold;color:#FF1418;font-family:Arial';
  for (const [k, v] of Object.entries({ Type: d.newName('Annot'), Subtype: d.newName('FreeText'), IT: d.newName('FreeTextTypewriter'), Rect: [428.18, 442.1, 551.2, 457.72], F: 4, T: d.newString('Someone'),
    Contents: d.newString('Tower areas 255 days =  8.5 months, \r\nNone tower 365 days = 12 Months '), DA: d.newString(' /Arial 7 Tf'), DS: d.newString("font: 'Arial' ,sans-serif 20.00pt;color:#FF0000"),
    RC: d.newString(`<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"><p dir="ltr"><span style="${span}">Tower areas 255 days =  8.5 months, </span></p><p><span style="${span}">None tower 365 days = 12 Months </span></p></body>`) }))
    an.put(k, v as never);
  const apd = d.newDictionary(); apd.put('N', ap); an.put('AP', apd);
  if (withP) an.put('P', page);
  const annots = d.newArray(); annots.push(an); page.put('Annots', annots);
  return d.saveToBuffer('').asUint8Array().slice();
}
/** every font the markup's drawing uses (through its wrapped forms) */
function apFonts(a: mupdf.PDFAnnotation): string[] {
  const out: string[] = [];
  const walk = (s: mupdf.PDFObject, depth: number) => {
    if (depth > 5 || !s.isStream()) return;
    const f = s.get('Resources', 'Font');
    if (f.isDictionary()) f.forEach((v: mupdf.PDFObject) => { const b = v.resolve().get('BaseFont'); out.push(b.isName() ? b.asName() : '?'); });
    const x = s.get('Resources', 'XObject');
    if (x.isDictionary()) x.forEach((v: mupdf.PDFObject) => walk(v, depth + 1));
  };
  walk(a.getObject().get('AP', 'N'), 0);
  return out;
}
function reopenedFreeText(bytes: Uint8Array): mupdf.PDFAnnotation[] {
  const d = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF()!;
  return (d.loadPage(0) as mupdf.PDFPage).getAnnotations().filter((x) => x.getType() === 'FreeText');
}

test('another program\'s text box: turned / pasted with its own drawing; edited or resized - redrawn in its own size, colour, bold (was garbled)', () => {
  mu.open('ft', foreignTextDoc());
  const [a] = mu.annots('ft', 0);
  assert.ok(a.font && a.font.size === 7 && a.font.bold && Math.abs(a.font.color[0] - 1) < 0.01 && a.font.color[1] < 0.1, 'shows its real look: ' + JSON.stringify(a.font));
  // turned: its own drawing (its own font), never MuPDF's drawing of the rich text
  mu.updateAnnots('ft', [{ page: 0, id: a.id, patch: { angle: 30 } }], 'Rotate');
  mu.moveAnnots('ft', [{ page: 0, id: a.id }], 15, 10);
  mu.updateAnnots('ft', [{ page: 0, id: a.id, patch: { angle: 60 } }], 'Rotate');
  let [t] = reopenedFreeText(mu.save('ft'));
  assert.deepEqual(apFonts(t), ['Arial-BoldMT'], 'still its own drawing after turn, move, turn: ' + apFonts(t));
  assert.equal(mu.annots('ft', 0)[0].angle, 60);
  // pasted: the copy keeps the look too
  const [c] = mu.copyAnnots('ft', [{ page: 0, id: a.id }], 'ft', 0, 0, 80);
  let fts = reopenedFreeText(mu.save('ft'));
  assert.equal(fts.length, 2);
  for (const f of fts) assert.deepEqual(apFonts(f), ['Arial-BoldMT'], 'copy keeps its drawing');
  // its text changed: drawn by this app - same size, colour, bold, a standard font; text readable
  const [e] = mu.updateAnnots('ft', [{ page: 0, id: c.id, patch: { contents: 'Tower areas 255 days = 8.5 months, EDITED' } }]);
  assert.ok(e.font!.bold && e.font!.size === 7 && Math.abs(e.font!.color[0] - 1) < 0.01 && e.font!.color[2] < 0.1, 'kept its look: ' + JSON.stringify(e.font));
  fts = reopenedFreeText(mu.save('ft'));
  t = fts.find((f) => /EDITED/.test(f.getContents()))!;
  assert.ok(apFonts(t).includes('Helvetica-Bold') && apFonts(t).every((n) => /^Helvetica/.test(n)), 'a standard bold font: ' + apFonts(t));
  assert.ok(t.getObject().get('RC').isNull(), 'its rich text is dropped (it no longer matches)');
  assert.match(t.toDisplayList().toStructuredText('').asText(), /EDITED/);
  // resized: redrawn to the new width, by this app
  const r = mu.annots('ft', 0).find((x) => x.id === a.id)!;
  mu.resizeAnnot('ft', 0, r.id, [r.rect[0], r.rect[1], r.rect[2] + 40, r.rect[3]] as never);
  fts = reopenedFreeText(mu.save('ft'));
  for (const f of fts) assert.ok(!apFonts(f).some((n) => /Nimbus/.test(n)), 'never MuPDF\'s own drawing of the rich text: ' + apFonts(f));
  mu.close('ft');
});

test('heavy page merging: a path split across content parts, two pages sharing one content - merged once, same drawing', async () => {
  const zlib = await import('node:zlib');
  const { mergeStrokes } = await import('../src/engine/strokes');
  // (the app's merger, with a low stroke count so a test-sized page qualifies)
  mu.setContentMerger((parts) => {
    const decs = parts.map((raw) => zlib.inflateSync(raw));
    const dec = Buffer.concat(decs.flatMap((b, k) => (k ? [Buffer.from('\n'), b] : [b])));
    const r = mergeStrokes(new Uint8Array(dec.buffer, dec.byteOffset, dec.byteLength), 1000);
    if (!r) return null;
    const out = zlib.deflateSync(r.out);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  });
  try {
    // ~1M short strokes at scattered places (scattered so the content stays big when compressed)
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const lines: string[] = [];
    for (let i = 0; i < 1_000_000; i++) { const x = (rnd() * 1180).toFixed(3), y = (rnd() * 830).toFixed(3); lines.push(`${x} ${y} m ${(+x + 0.8).toFixed(3)} ${(+y + 0.6).toFixed(3)} l S`); }
    const d = new mupdf.PDFDocument();
    // part 1 ends in the middle of a path (red), part 2 strokes it and goes on
    const p1 = d.addStream('q 1 0 0 RG 2 w 100 100 m 600 500 l', {});
    const p2 = d.addStream('S 0 0 1 RG 0.1 w\n' + lines.join('\n') + '\nQ', {});
    const contents = d.newArray(); contents.push(p1); contents.push(p2);
    for (let k = 0; k < 2; k++) { const pg = d.addPage([0, 0, 1190, 842], 0, {}, ''); pg.put('Contents', contents); d.insertPage(-1, pg); }
    const bytes = d.saveToBuffer('compress').asUint8Array().slice();
    mu.setHeavyRaw(8e6);
    assert.ok(bytes.length > 9e6, 'test file big enough to be looked at: ' + bytes.length);
    const r = mu.open('hv', bytes);
    assert.equal(r.heavy, 2, 'both pages (one shared content)');
    const saved = mu.save('hv');
    mu.close('hv');
    assert.ok(saved.length < bytes.length * 1.2, `merged once, not twice: ${bytes.length} -> ${saved.length}`);
    const draw = (b: Uint8Array, page: number) => {
      const doc = mupdf.Document.openDocument(b, 'application/pdf');
      const pix = doc.loadPage(page).toPixmap(mupdf.Matrix.scale(0.5, 0.5), mupdf.ColorSpace.DeviceRGB, false, true);
      let red = 0; const px = pix.getPixels();
      for (let i = 0; i < px.length; i += 3) if (px[i] > 200 && px[i + 1] < 80 && px[i + 2] < 80) red++;
      return red;
    };
    const red0 = draw(bytes, 0);
    assert.ok(red0 > 100, 'the red line is there: ' + red0);
    assert.equal(draw(saved, 0), red0, 'the stroke split across the parts is still drawn (page 1)');
    assert.equal(draw(saved, 1), red0, 'page 2 too');
    const sd = mupdf.Document.openDocument(saved, 'application/pdf').asPDF()!;
    assert.equal(sd.findPage(0).get('Contents').asIndirect(), sd.findPage(1).get('Contents').asIndirect(), 'still one shared content');
    // saved again: still in full (the old line work isn't appended back - it doubled the file)
    const r2 = mu.open('hv2', saved);
    void r2;
    mu.close('hv2');
    mu.setHeavyRaw(30e6);
    // a page below the bar when opening, simplified on request (it took the drawing engine down)
    mu.open('hv3', bytes);
    assert.equal(mu.simplifyPage('hv3', 0), true);
    const s3 = mu.save('hv3', { incremental: true });
    const s4 = mu.save('hv3', { incremental: true });
    assert.ok(s4.length < bytes.length * 1.2 && s3.length < bytes.length * 1.2, `simplified page saved in full both times: ${bytes.length} -> ${s3.length}, ${s4.length}`);
    assert.equal(draw(s4, 0), red0, 'simplified page: the split stroke still drawn');
    assert.ok(mu.undo('hv3').ok, 'one undo step');
    mu.close('hv3');
    mu.open('hv4', new Uint8Array(readFileSync('tests/data/long-spec.pdf')));
    assert.throws(() => mu.simplifyPage('hv4', 0), /can't be simplified/, 'a text page: nothing to simplify');
    mu.close('hv4');
  } finally {
    mu.setContentMerger(null);
    mu.setHeavyRaw(30e6);
  }
});

test('another program\'s text box without /P turns the same way as its frame (clockwise as seen)', () => {
  mu.open('fp', foreignTextDoc(false));
  const [a] = mu.annots('fp', 0);
  mu.updateAnnots('fp', [{ page: 0, id: a.id, patch: { angle: 30 } }], 'Rotate');
  const r = mu.annots('fp', 0)[0].rect;
  const doc = mupdf.Document.openDocument(mu.save('fp'), 'application/pdf');
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
  const W = pix.getWidth(), px = pix.getPixels();
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let y = Math.round(r[1] * 2); y < r[3] * 2; y++) for (let x = Math.round(r[0] * 2); x < r[2] * 2; x++) {
    const i = (y * W + x) * 3; if (px[i] > 180 && px[i + 1] < 100 && px[i + 2] < 100) { n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
  }
  const mx = sx / n, my = sy / n;
  const deg = 0.5 * Math.atan2(2 * (sxy / n - mx * my), (sxx / n - mx * mx) - (syy / n - my * my)) * 180 / Math.PI;
  assert.ok(n > 300 && Math.abs(deg - 30) < 4, `text turned ${deg.toFixed(1)} deg (want 30, clockwise as seen), ${n} px`);
  mu.close('fp');
});

test('OCR text layer: selections and highlights sit on the words (the line\'s top to bottom), not above them', async () => {
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  mu.open('ob', d.saveToBuffer('').asUint8Array());
  // "Hardware" (no descenders) and "type" (one) on one line, a second line below
  mu.addTextLayer('ob', 0, [{ text: 'Hardware', box: [100, 100, 160, 112] }, { text: 'type', box: [170, 101, 200, 115] }, { text: 'Next', box: [100, 130, 130, 142] }]);
  pf.openDoc('ob', mu.snapshot('ob'));
  const c = pf.chars('ob', 0);
  const boxOf = (ch: string) => { const i = c.text.indexOf(ch); return [...c.box.slice(i * 4, i * 4 + 4)]; };
  const H = boxOf('H'), y = boxOf('y'), N = boxOf('N');
  assert.ok(Math.abs(H[1] - 100) < 1 && Math.abs(H[3] - 115) < 1, 'first line top to bottom: ' + H);
  assert.ok(Math.abs(y[1] - H[1]) < 0.5 && Math.abs(y[3] - H[3]) < 0.5, 'the same height across the line: ' + y);
  assert.ok(Math.abs(N[1] - 130) < 1 && Math.abs(N[3] - 142) < 1, 'next line on its own words: ' + N);
  for (const b of mu.textBlocks('ob', 0)) for (const l of b.lines) assert.ok(l.bbox[1] > 99 && l.bbox[3] < 143, 'MuPDF agrees: ' + l.bbox);
  pf.closeDoc('ob');
  mu.close('ob');
});

// ---------------------------------------------------------------- 0.7.0 audit findings (engine)

const blankPdf = (n = 1, w = 595, h = 842, rot = 0) => { const d = new mupdf.PDFDocument(); for (let i = 0; i < n; i++) d.insertPage(-1, d.addPage([0, 0, w, h], rot as 0, {}, '')); return d.saveToBuffer('').asUint8Array().slice(); };
/** dark pixels of a page drawn at 72 dpi (inside box = [x0, y0, x1, y1] in page space, if given) */
function darkOf(bytes: Uint8Array, page = 0, box?: number[]): number {
  const d = mupdf.Document.openDocument(bytes, 'application/pdf');
  const pix = d.loadPage(page).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true);
  const px = pix.getPixels(), w = pix.getWidth();
  let n = 0;
  for (let i = 0; i < px.length; i++) { const x = i % w, y = (i / w) | 0; if (box && (x < box[0] || x > box[2] || y < box[1] || y > box[3])) continue; if (px[i] < 128) n++; }
  return n;
}
async function startPf() { const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm'); await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)); }

test('text, page numbers and flattened text boxes added after OCR show (the OCR layer left text invisible)', () => {
  mu.open('ocr3', blankPdf());
  mu.addTextLayer('ocr3', 0, [{ text: 'scanned', box: [100, 100, 180, 115] }]);
  mu.addText('ocr3', 0, 'ADDED', [100, 300], { size: 30, color: [0, 0, 0] });
  mu.markPages('ocr3', [{ kind: 'text', text: 'Page {page}', pos: 'bc', size: 20 }], { file: 'f', date: 'd' });
  const tb = mu.createAnnot('ocr3', 0, { type: 'FreeText', rect: [100, 400, 300, 440], contents: 'BOX TEXT', font: { size: 20, color: [0, 0, 0] }, kind: 'textbox' });
  mu.flatten('ocr3', [{ page: 0, id: tb.id }]);
  const out = mu.save('ocr3');
  assert.ok(darkOf(out, 0, [95, 270, 260, 310]) > 50, 'text added after OCR is drawn');
  assert.ok(darkOf(out, 0, [240, 790, 360, 842]) > 30, 'page number added after OCR is drawn');
  assert.ok(darkOf(out, 0, [95, 395, 300, 445]) > 50, 'flattened text box is drawn');
  // a page whose OCR layer came from 0.8.0 or before (it ends with the text still invisible): marks added now show
  const old = new mupdf.PDFDocument(out);
  old.findPage(0).get('Contents').push(old.addStream('%GCC-OCR\nBT 3 Tr 40 Tz ET\n', {}));
  mu.open('ocr3b', old.saveToBuffer('').asUint8Array().slice());
  mu.markPages('ocr3b', [{ kind: 'text', text: 'LATER', pos: 'tc', size: 24 }], { file: 'f', date: 'd' });
  assert.ok(darkOf(mu.save('ocr3b'), 0, [240, 0, 360, 60]) > 50, 'a mark after an old OCR layer is drawn');
  mu.close('ocr3'); mu.close('ocr3b');
});

test('many markups at once: made in parts, still one undo step, and quick', () => {
  mu.open('many', blankPdf(3));
  const items = Array.from({ length: 150 }, (_, k) => ({ page: k % 3, spec: { type: 'Square', rect: [10 + (k % 20) * 25, 10 + Math.floor(k / 20) * 25, 30 + (k % 20) * 25, 30 + Math.floor(k / 20) * 25], color: [1, 0, 0], bw: 1 } as mu.AnnotSpec }));
  const t = Date.now();
  const made = mu.createAnnots('many', items);
  assert.equal(made.length, 150);
  assert.ok(Date.now() - t < 5000, 'took ' + (Date.now() - t) + ' ms');
  assert.equal(mu.history('many').undo.length, 1, 'one undo step');
  assert.equal([0, 1, 2].reduce((n, p) => n + mu.annots('many', p).length, 0), 150);
  mu.undo('many');
  assert.equal([0, 1, 2].reduce((n, p) => n + mu.annots('many', p).length, 0), 0, 'all undone at once');
  mu.redo('many');
  assert.equal([0, 1, 2].reduce((n, p) => n + mu.annots('many', p).length, 0), 150, 'all redone at once');
  mu.close('many');
});

test('OCR redo leaves pages with real text alone; one OCR run is one undo step', () => {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, 'BT /F1 14 Tf 72 700 Td (TYPED TEXT ON THIS PAGE) Tj ET'));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  mu.open('redo', d.saveToBuffer('').asUint8Array().slice());
  const words = [{ text: 'Scanned', box: [100, 100, 180, 115] as [number, number, number, number] }, { text: 'words', box: [190, 100, 240, 115] as [number, number, number, number] }];
  assert.equal(mu.ocrState('redo', 0), 'text');
  assert.equal(mu.ocrState('redo', 1), 'none');
  mu.addTextLayer('redo', 1, words, true, false);
  mu.addTextLayer('redo', 2, words, true, true);
  assert.equal(mu.ocrState('redo', 1), 'ours', 'our OCR layer is told apart from real text');
  assert.equal(mu.history('redo').undo.length, 1, 'one undo step for the run');
  mu.undo('redo');
  assert.equal(mu.ocrState('redo', 1), 'none');
  assert.equal(mu.ocrState('redo', 2), 'none', 'both pages undone together');
  mu.redo('redo');
  assert.equal(mu.ocrState('redo', 1), 'ours');
  assert.equal(mu.ocrState('redo', 2), 'ours', 'both pages redone together');
  // read again: our layer is replaced, not doubled
  mu.addTextLayer('redo', 1, words, true, false);
  const st = mupdf.Document.openDocument(mu.save('redo'), 'application/pdf').loadPage(1).toStructuredText('').asText();
  assert.equal((st.match(/Scanned/g) || []).length, 1, 'read again: once, not twice');
  mu.close('redo');
});

/** a file with markups, a reply, a filled-in form, a link to page 2, a hidden layer, labels, bookmarks, a title */
function richPdf(): Uint8Array {
  const d = new mupdf.PDFDocument();
  const ocg = d.addObject({ Type: d.newName('OCG'), Name: d.newString('Revision cloud layer') });
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Properties: { oc1: ocg } }, '/OC /oc1 BDC 0 0 0 rg 100 100 200 200 re f EMC'));
  d.getTrailer().get('Root').put('OCProperties', { OCGs: [ocg], D: { OFF: [ocg], Order: [ocg] } });
  const p1 = d.findPage(0);
  const tf = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Widget'), FT: d.newName('Tx'), T: d.newString('Contractor'), V: d.newString('GOOD BUILDERS'), Rect: [100, 600, 300, 620], P: p1, F: 4, DA: d.newString('/Helv 12 Tf 0 g') });
  const link = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Link'), Rect: [10, 10, 50, 30], Dest: [d.findPage(1), d.newName('Fit')] });
  p1.put('Annots', [tf, link]);
  d.getTrailer().get('Root').put('AcroForm', d.addObject({ Fields: [tf], DA: d.newString('/Helv 0 Tf 0 g') }));
  d.setPageLabels(0, 'D', 'A-', 101);
  const it = d.outlineIterator();
  it.insert({ title: 'Sheet 2', uri: '#page=2', open: false } as never); it.next();
  it.insert({ title: 'Sheet 1', uri: '#page=1', open: false } as never);
  d.setMetaData('info:Title', 'Tender drawings');
  mu.open('rich0', d.saveToBuffer('').asUint8Array().slice(), undefined, 'Tester');
  const sq = mu.createAnnot('rich0', 0, { type: 'Square', rect: [100, 100, 200, 160], color: [1, 0, 0], contents: 'check this' });
  mu.createAnnot('rich0', 0, { type: 'Text', irt: sq.id, contents: 'agreed' });
  mu.createAnnot('rich0', 1, { type: 'Text', rect: [50, 50, 70, 70], contents: 'note on sheet 2' });
  const b = mu.save('rich0');
  mu.close('rich0');
  return b;
}
function describe(b: Uint8Array) {
  const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  let pageObjs = 0;
  for (let i = 1; i < d.countObjects(); i++) { try { const o = d.newIndirect(i).resolve(); if (o.isDictionary() && o.get('Type').isName() && o.get('Type').asName() === 'Page') pageObjs++; } catch { /* free */ } }
  const pages = [...Array(d.countPages()).keys()].map((i) => {
    const p = d.loadPage(i) as mupdf.PDFPage;
    return {
      label: p.getLabel(),
      annots: p.getAnnotations().map((a) => a.getType() + (a.getObject().get('IRT').isNull() ? '' : '>' + (p.getAnnotations().find((x) => x.getObject().asIndirect() === a.getObject().get('IRT').asIndirect())?.getType() ?? '?')) + ':' + a.getContents()),
      fields: p.getWidgets().map((w) => w.getName() + '=' + w.getValue()),
      links: p.getLinks().map((l) => l.getURI()),
    };
  });
  const fields = d.getTrailer().get('Root', 'AcroForm', 'Fields');
  const off = d.getTrailer().get('Root', 'OCProperties', 'D', 'OFF');
  const conv = (items: any[] | undefined): any[] => (items || []).map((x) => [x.title, x.page, ...(x.down ? [conv(x.down)] : [])]);
  return { pages, pageObjs, fields: fields.isArray() ? fields.length : 0, off: off.isArray() ? off.length : 0, outline: conv(d.loadOutline() as any), title: d.getMetaData('info:Title') };
}

test('extract, merge and insert pages keep markups, replies, form fields, layers, links, bookmarks, labels', () => {
  const src = richPdf();
  mu.open('rich', src);
  const one = describe(mu.extract('rich', [0]));
  assert.deepEqual(one.pages[0].annots, ['Square:check this', 'Text>Square:agreed'], 'markups and the reply came along');
  assert.deepEqual(one.pages[0].fields, ['Contractor=GOOD BUILDERS'], 'the filled-in field came along');
  assert.equal(one.fields, 1, 'and is in the form');
  assert.deepEqual(one.pages[0].links, [], 'a link to a page left behind is dropped');
  assert.equal(one.pageObjs, 1, 'no stray copy of another page');
  assert.equal(one.pages[0].label, 'A-101', 'page label kept');
  assert.deepEqual(one.outline, [['Sheet 1', 0]], 'only the bookmarks of the pages taken');
  assert.equal(one.title, 'Tender drawings', 'title kept');
  const two = describe(mu.extract('rich', [1, 0]));
  assert.deepEqual(two.pages[1].links, ['#page=1&view=Fit'], 'a link follows its page');
  assert.equal(two.off, 1, 'the hidden layer is listed as off');
  const ex1 = mu.extract('rich', [1]);
  assert.equal(darkOf(ex1, 0, [90, 630, 210, 750]), 0, 'the hidden layer stays hidden in the new file');
  const m = describe(mu.merge([{ name: 'a.pdf', bytes: src }, { name: 'b.pdf', bytes: src }]));
  assert.equal(m.pages.length, 4);
  assert.deepEqual(m.pages[2].annots, ['Square:check this', 'Text>Square:agreed']);
  assert.equal(m.fields, 2, 'both files\' fields are in the form');
  assert.equal(m.off, 2, 'both files\' hidden layers stay off');
  assert.deepEqual(m.outline, [['a', 0, [['Sheet 2', 1], ['Sheet 1', 0]]], ['b', 2, [['Sheet 2', 3], ['Sheet 1', 2]]]], 'each file\'s bookmarks under its own');
  assert.equal(m.pageObjs, 4);
  mu.open('richIns', blankPdf());
  mu.insertFrom('richIns', 1, src);
  const ins = describe(mu.save('richIns'));
  assert.deepEqual(ins.pages[1].annots, ['Square:check this', 'Text>Square:agreed']);
  assert.deepEqual(ins.pages[1].fields, ['Contractor=GOOD BUILDERS']);
  assert.equal(ins.off, 1);
  mu.undo('richIns');
  const back = describe(mu.save('richIns'));
  assert.equal(back.pages.length, 1);
  assert.equal(back.fields, 0, 'undo takes the inserted fields away again');
  mu.close('rich'); mu.close('richIns');
});

test('a digitally signed file is saved as original + changes (Save as and page changes too); a rewrite is said', () => {
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  const sigv = d.addObject({ Type: d.newName('Sig'), Filter: d.newName('Adobe.PPKLite'), SubFilter: d.newName('adbe.pkcs7.detached'), ByteRange: [0, 10, 20, 10], Contents: d.newByteString(new Uint8Array(8)) });
  const sig = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Widget'), FT: d.newName('Sig'), T: d.newString('Signature1'), V: sigv, Rect: [0, 0, 0, 0], P: d.findPage(0), F: 132 });
  d.findPage(0).put('Annots', [sig]);
  d.getTrailer().get('Root').put('AcroForm', d.addObject({ Fields: [sig], SigFlags: 3 }));
  const signed = d.saveToBuffer('').asUint8Array().slice();
  const r = mu.open('sig', signed);
  assert.equal(r.signed, true, 'seen as signed');
  mu.rotatePages('sig', [1], 90);
  mu.createAnnot('sig', 1, { type: 'Square', rect: [100, 100, 200, 160], color: [1, 0, 0] });
  assert.equal(mu.breaksSignatures('sig'), false);
  const out = mu.save('sig'); // (as Save as: not asked for "original + changes")
  assert.ok(out.length > signed.length && signed.every((v, i) => out[i] === v), 'the signed bytes are untouched, the changes appended');
  assert.equal(mupdf.Document.openDocument(out, 'application/pdf').loadPage(1).getBounds()[2], 842, 'the page turn is in it');
  // removing pages can only be saved by rewriting the file: said before saving
  mu.deletePages('sig', [1]);
  assert.equal(mu.breaksSignatures('sig'), true);
  // a file that isn't signed: Save as writes it afresh, as before
  mu.open('unsigned', blankPdf());
  assert.equal(mu.open('unsigned', blankPdf()).signed, false);
  mu.rotatePages('unsigned', [0], 90);
  const u = mu.save('unsigned');
  assert.ok(!blankPdf().every((v, i) => u[i] === v), 'rewritten');
  mu.close('sig'); mu.close('unsigned');
});

test('a deleted comment that came with the file is not left in the saved file; a PC font is cut down on Ctrl+S', () => {
  mu.open('dc0', blankPdf());
  mu.createAnnot('dc0', 0, { type: 'Text', rect: [50, 50, 70, 70], contents: 'SECRET-REMARK-1234' });
  const withNote = mu.save('dc0');
  mu.close('dc0');
  const holds = (b: Uint8Array, s: string) => {
    const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
    for (let i = 1; i < d.countObjects(); i++) { try { if (d.newIndirect(i).resolve().toString().includes(s)) return true; } catch { /* free */ } }
    return false;
  };
  assert.ok(holds(withNote, 'SECRET-REMARK-1234'));
  mu.open('dc', withNote);
  const note = mu.annots('dc', 0)[0];
  mu.deleteAnnots('dc', [{ page: 0, id: note.id }]);
  assert.ok(!holds(mu.save('dc', { incremental: true }), 'SECRET-REMARK-1234'), 'the comment\'s text is gone from the file');
  // one made and deleted since opening was never in the file: Ctrl+S still only appends
  mu.open('dc2', withNote);
  const n2 = mu.createAnnot('dc2', 0, { type: 'Square', rect: [100, 100, 200, 160] });
  mu.deleteAnnots('dc2', [{ page: 0, id: n2.id }]);
  const inc = mu.save('dc2', { incremental: true });
  assert.ok(withNote.every((v, i) => inc[i] === v), 'still original + changes');
  // a text box in a font from the PC: the font is cut down to the letters used on Ctrl+S too
  mu.open('pcfont', blankPdf());
  mu.createAnnot('pcfont', 0, { type: 'FreeText', rect: [100, 100, 300, 140], contents: 'مرحبا بكم', font: { size: 14, color: [0, 0, 0], family: 'Arial' }, kind: 'textbox' });
  const saved = mu.save('pcfont', { incremental: true });
  assert.ok(saved.length < 150_000, 'subset font, not the whole typeface: ' + saved.length);
  mu.close('dc'); mu.close('dc2'); mu.close('pcfont');
});

/** a form: radio group R (A, B; B chosen), text T1 (MaxLen 5, no drawing), combo C1 (export values), list L1 (two chosen) */
function formPdf(extra?: (d: mupdf.PDFDocument) => void): Uint8Array {
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  const p = d.findPage(0);
  const helv = d.addObject({ Type: d.newName('Font'), Subtype: d.newName('Type1'), BaseFont: d.newName('Helvetica'), Encoding: d.newName('WinAnsiEncoding') });
  const fields = d.newArray(), annots = d.newArray();
  const onAP = (name: string) => { const n = d.newDictionary(); n.put(name, d.addStream('0 g 2 2 10 10 re f', { BBox: [0, 0, 14, 14], Subtype: d.newName('Form') })); n.put('Off', d.addStream('', { BBox: [0, 0, 14, 14], Subtype: d.newName('Form') })); const ap = d.newDictionary(); ap.put('N', n); return ap; };
  const grp = d.addObject({ FT: d.newName('Btn'), Ff: (1 << 15) | (1 << 14), T: d.newString('R'), V: d.newName('B'), Kids: [] });
  for (const [k, nm] of [[0, 'A'], [1, 'B']] as const) {
    const w = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Widget'), Rect: [100 + k * 40, 700, 114 + k * 40, 714], Parent: grp, P: p, F: 4, AS: d.newName(nm === 'B' ? 'B' : 'Off'), AP: onAP(nm) });
    grp.get('Kids').push(w); annots.push(w);
  }
  fields.push(grp);
  const tf = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Widget'), FT: d.newName('Tx'), T: d.newString('T1'), V: d.newString('hello world'), MaxLen: 5, Rect: [100, 600, 300, 620], P: p, F: 4, DA: d.newString('/Helv 12 Tf 0 g') });
  annots.push(tf); fields.push(tf);
  const ch = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Widget'), FT: d.newName('Ch'), Ff: 1 << 17, T: d.newString('C1'), Opt: [[d.newString('ex1'), d.newString('First option')], [d.newString('ex2'), d.newString('Second option')]], V: d.newString('ex2'), Rect: [100, 500, 300, 520], P: p, F: 4, DA: d.newString('/Helv 12 Tf 0 g') });
  annots.push(ch); fields.push(ch);
  const ls = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Widget'), FT: d.newName('Ch'), Ff: 1 << 21, T: d.newString('L1'), Opt: [d.newString('a'), d.newString('b'), d.newString('c')], V: [d.newString('a'), d.newString('c')], Rect: [100, 400, 300, 460], P: p, F: 4, DA: d.newString('/Helv 12 Tf 0 g') });
  annots.push(ls); fields.push(ls);
  p.put('Annots', annots);
  d.getTrailer().get('Root').put('AcroForm', d.addObject({ Fields: fields, DA: d.newString('/Helv 0 Tf 0 g'), DR: { Font: { Helv: helv } } }));
  extra?.(d);
  return d.saveToBuffer('').asUint8Array().slice();
}

test('form fields: a radio option\'s own state, export values, multi-select lists, MaxLen, flattening fields without a drawing', () => {
  mu.open('form', formPdf());
  const w = () => mu.annots('form', 0).filter((a) => a.type === 'Widget');
  const radios = () => w().filter((a) => a.field!.ftype === 'radiobutton');
  assert.deepEqual(radios().map((a) => a.field!.checked), [false, true], 'only the chosen option reads as checked');
  mu.setField('form', 0, radios()[0].id, true);
  assert.deepEqual(radios().map((a) => a.field!.checked), [true, false], 'choosing A turns B off');
  const C1 = () => w().find((a) => a.field!.name === 'C1')!;
  assert.equal(C1().field!.value, 'Second option', 'shown as its label');
  mu.setField('form', 0, C1().id, 'First option');
  assert.equal(C1().field!.value, 'First option');
  const L1 = w().find((a) => a.field!.name === 'L1')!;
  assert.equal(L1.field!.value, 'a, c', 'both choices shown');
  assert.equal(L1.field!.readOnly, true, 'not offered for a one-choice edit (it dropped the other choice)');
  const T1 = w().find((a) => a.field!.name === 'T1')!;
  assert.equal(T1.field!.maxLen, 5);
  mu.setField('form', 0, T1.id, 'abcdefghij');
  assert.equal(w().find((a) => a.id === T1.id)!.field!.value, 'abcde', 'no more than the field takes');
  const saved = new mupdf.PDFDocument(mu.save('form'));
  const c1 = saved.findPage(0).get('Annots').get(3);
  assert.equal(c1.get('V').asString(), 'ex1', 'the field keeps the option\'s export value');
  assert.ok(c1.get('AP', 'N').readStream().asString().includes('First option'), 'and shows its label');
  mu.close('form');
  // flatten form fields: fields without a drawing of their own keep their value on the page
  mu.open('ff', formPdf());
  mu.flatten('ff', null, { widgets: true, types: ['Widget'] });
  const flat = mu.save('ff');
  const txt = mupdf.Document.openDocument(flat, 'application/pdf').loadPage(0).toStructuredText('').asText();
  assert.ok(txt.includes('hello world'), 'the text field\'s value is on the page: ' + JSON.stringify(txt));
  assert.ok(txt.includes('Second option'), 'the combo box shows its label');
  const left = mu.open('ff2', flat);
  assert.equal(left.hasForms, true, 'the list with two choices is left as a field');
  assert.equal(new mupdf.PDFDocument(flat).getTrailer().get('Root', 'AcroForm', 'Fields').length, 1, 'flattened fields are off the form\'s list');
  // an empty form is no form
  assert.equal(mu.open('ff3', formPdf((d) => d.getTrailer().get('Root', 'AcroForm').put('Fields', d.newArray()))).hasForms, false);
  mu.close('ff'); mu.close('ff2'); mu.close('ff3');
});

test('turned markups stay where they are when their page is turned or cropped (and on the next change)', () => {
  for (const kind of ['text', 'square', 'stamp'] as const) {
    mu.open('turn', blankPdf());
    const spec: mu.AnnotSpec = kind === 'text' ? { type: 'FreeText', rect: [100, 100, 260, 140], contents: 'Turned text', font: { size: 14, color: [0, 0, 0] }, kind: 'textbox', angle: 30 }
      : kind === 'square' ? { type: 'Square', rect: [300, 300, 400, 340], color: [1, 0, 0], bw: 3, angle: 20 }
      : { type: 'Stamp', rect: [100, 500, 260, 550], design: { lines: [{ text: 'APPROVED', size: 16, bold: true }], color: [0, 0.4, 0], border: 'rounded' }, kind: 'stamp', angle: 15 };
    const a = mu.createAnnot('turn', 0, spec);
    const ink = () => {
      const inf = mu.pageInfos('turn')[0];
      const W = Math.round(inf.w), H = Math.round(inf.h);
      const px = mu.renderAnnots('turn', 0, 1, 0, 0, W, H)!;
      let n = 0, sx = 0, sy = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3] > 128) { n++; sx += x; sy += y; }
      return [sx / n, sy / n, n];
    };
    for (const step of ['rotate', 'crop'] as const) {
      if (step === 'rotate') mu.rotatePages('turn', [0], 90); else mu.cropPages('turn', [0], [40, 40, 760, 540]);
      const before = ink();
      const angle = mu.annots('turn', 0)[0].angle;
      mu.updateAnnots('turn', [{ page: 0, id: a.id, patch: { opacity: step === 'rotate' ? 0.99 : 1 } }]);
      const after = ink();
      assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1]) < 3 && Math.abs(after[2] - before[2]) < before[2] * 0.1, `${kind} after ${step}: the next change leaves it where it is (${before.map(Math.round)} -> ${after.map(Math.round)})`);
      assert.equal(mu.annots('turn', 0)[0].angle, angle, 'its turn as shown is kept');
    }
    assert.equal(mu.annots('turn', 0)[0].angle, (spec.angle! + 90) % 360, 'turned on with the page');
    mu.close('turn');
  }
});

test('page marks and stamps: Arabic text shows (was "?"), the page-mark stamp is drawn like the stamp markup', async () => {
  mu.open('marks', blankPdf());
  const design: mu.StampDesign = { lines: [{ text: 'مستلم', size: 18, bold: true }, { text: 'RECEIVED 27/10', size: 9 }], color: [0, 0.3, 0.6], border: 'double' };
  mu.markPages('marks', [{ kind: 'text', text: 'صفحة {page} من {pages}', pos: 'bc', size: 12 }, { kind: 'stamp', design, pos: 'tr', width: 120 }], { file: 'x', date: 'today' });
  mu.createAnnot('marks', 0, { type: 'Stamp', rect: [50, 600, 250, 660], design });
  const out = mu.save('marks');
  await startPf();
  pf.openDoc('marks', out);
  const t = pf.pageText('marks', 0);
  assert.ok(t.includes('صفحة 1 من 1') && t.includes('مستلم') && !t.includes('?'), JSON.stringify(t));
  const d = new mupdf.PDFDocument(out);
  const ap = (d.loadPage(0) as mupdf.PDFPage).getAnnotations()[0].getObject().get('AP', 'N').readStream().asString();
  let xo = '';
  d.findPage(0).get('Resources', 'XObject').forEach((v: mupdf.PDFObject) => { const s = v.readStream().asString(); if (s.includes('RG 2 w')) xo = s; });
  assert.equal(xo, ap, 'one drawing for both (rounded corners, the same text position)');
  assert.ok(out.length < 150_000, 'the font is cut down: ' + out.length);
  pf.closeDoc('marks');
  mu.close('marks');
});

test('PDFium text: one character per index when a page maps a glyph to a control code; snippets bold the right words', async () => {
  const d = new mupdf.PDFDocument();
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <2D> <0002> <58> <D835DC00> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  const f = d.addObject({ Type: d.newName('Font'), Subtype: d.newName('Type1'), BaseFont: d.newName('Helvetica'), Encoding: d.newName('WinAnsiEncoding'), ToUnicode: d.addStream(cmap, {}) });
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, 'BT /F1 20 Tf 100 700 Td (AB-CD XY end) Tj ET'));
  await startPf();
  pf.openDoc('ctl', d.saveToBuffer('').asUint8Array().slice());
  assert.ok(!pf.pageText('ctl', 0).includes('\u0000'), 'no NUL / leftover memory in the plain text');
  const c = pf.chars('ctl', 0);
  assert.equal(c.text.length, c.box.length / 4);
  const at = (ch: string) => Math.round(c.box[c.text.indexOf(ch) * 4]);
  assert.ok(Math.abs(at('C') - 133) <= 1 && Math.abs(at('Y') - 181) <= 1, `each letter on its own box: C at ${at('C')}, Y at ${at('Y')}`);
  const hit = pf.find('ctl', 'end', 0, 1)[0];
  assert.ok(hit.snip!.includes('\u0001end\u0002'), JSON.stringify(hit.snip));
  pf.closeDoc('ctl');
});

test('snapping on curves: on the arc itself, never on its control points', async () => {
  const k = 100 * 0.5523, cx = 300, cy = 400, R = 100;
  const circle = `${cx + R} ${cy} m ${cx + R} ${cy + k} ${cx + k} ${cy + R} ${cx} ${cy + R} c ${cx - k} ${cy + R} ${cx - R} ${cy + k} ${cx - R} ${cy} c ${cx - R} ${cy - k} ${cx - k} ${cy - R} ${cx} ${cy - R} c ${cx + k} ${cy - R} ${cx + R} ${cy - k} ${cx + R} ${cy} c S 50 100 m 250 100 l S`;
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, circle));
  await startPf();
  pf.openDoc('arc', d.saveToBuffer('').asUint8Array().slice());
  const pcy = 842 - cy;
  assert.equal(pf.snap('arc', 0, cx + R, pcy - k, 6), null, 'nothing to snap to at a control point');
  const on = pf.snap('arc', 0, cx + R * Math.SQRT1_2 + 3, pcy - R * Math.SQRT1_2 - 3, 8)!;
  assert.ok(on && Math.abs(Math.hypot(on.x - cx, on.y - pcy) - R) < 0.5, 'a point on the arc: ' + JSON.stringify(on));
  assert.equal(pf.snap('arc', 0, cx + R + 1, pcy + 1, 8)!.k, 'end', 'the curve\'s own end is an end');
  assert.equal(pf.snap('arc', 0, 151, 842 - 98, 8)!.k, 'mid', 'a straight line still has its middle');
  pf.closeDoc('arc');
});

test('stroke merging passes over a stray ")" (it looped for ever and froze the editing engine)', { timeout: 10000 }, () => {
  const strokes = Array.from({ length: 40 }, (_, i) => `${i} 0 m ${i + 1} 1 l S`);
  strokes.splice(20, 0, ')');
  const src = new TextEncoder().encode(strokes.join('\n') + '\n');
  const r = mergeStrokes(src, 10)!;
  assert.ok(r && r.strokesIn === 40 && r.strokesOut < 10, JSON.stringify(r && { i: r.strokesIn, o: r.strokesOut }));
  assert.ok(new TextDecoder().decode(r.out).includes(')'), 'the content is kept as it was');
});

test('a change note after an operation that changed nothing stays off the step before', () => {
  mu.open('note', blankPdf(2));
  mu.rotatePages('note', [0], 90);
  mu.noteChange('note', { pages: [0] });
  assert.equal(mu.markPages('note', [{ kind: 'text', text: 'x', pos: 'tl' }], { file: 'f', date: 'd', pages: [] }), 0);
  mu.noteChange('note', { pages: [] });
  assert.deepEqual(mu.undo('note').change, { pages: [0] }, 'undoing the turn still redraws page 1');
  mu.close('note');
});

test('another kind of file named .pdf, or an empty one, says so; a base file shorter than its changes is refused', async () => {
  assert.throws(() => mu.open('notpdf', new TextEncoder().encode('PK\u0003\u0004 a Word file renamed')), /Not a PDF file/);
  assert.throws(() => mu.open('notpdf', new Uint8Array(0)), /empty/);
  const { VFile } = await import('../src/engine/files');
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync(join((await import('node:os')).tmpdir(), 'pdfed-'));
  try {
    writeFileSync(join(dir, 'base.pdf'), new Uint8Array(1000));
    writeFileSync(join(dir, 'changes.bin'), new Uint8Array(10));
    assert.throws(() => new VFile({ path: join(dir, 'base.pdf'), size: 2000, delta: join(dir, 'changes.bin') }), /changed/);
    const ok = new VFile({ path: join(dir, 'base.pdf'), size: 1000, delta: join(dir, 'changes.bin') });
    assert.equal(ok.size, 1010);
    assert.equal(ok.opened.size, 1000, 'how the file was when opened, from the open handle');
    ok.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Arabic: OCR words keep their numbers in order; a long word breaks between whole letters', async () => {
  assert.equal(visualOrder('٢٠٢٤'), '٢٠٢٤', 'Arabic-Indic numbers keep their order');
  assert.equal(visualOrder('مرحبا'), 'ابحرم');
  assert.equal(visualOrder('C40م'), 'مC40', 'Latin and numbers inside keep theirs');
  mu.open('ocrar', blankPdf());
  mu.addTextLayer('ocrar', 0, [{ text: 'مرحبا', box: [300, 100, 360, 115] }, { text: '٢٠٢٤', box: [240, 100, 290, 115] }]);
  await startPf();
  pf.openDoc('ocrar', mu.save('ocrar'));
  assert.equal(pf.find('ocrar', '٢٠٢٤', 0, 1).length, 1, 'the year is found as typed');
  pf.closeDoc('ocrar');
  mu.close('ocrar');
  const stack = fontStack('Helv', false, false);
  if (stack.length) {
    const lines = layoutText('بِسْمِ'.repeat(6), 3, stack);
    assert.ok(lines.length > 2 && !lines.some((l) => /^\p{M}/u.test(l.text)), 'no line starts with a mark: ' + lines.map((l) => l.text).join(' | '));
  }
});

test('document properties: the XMP packet follows the title / author; "remove hidden info" removes it', () => {
  const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" pdf:Keywords="old words"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Old title</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>Old Author</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const d = new mupdf.PDFDocument(blankPdf());
  d.getTrailer().get('Root').put('Metadata', d.addStream(xmp, { Type: d.newName('Metadata'), Subtype: d.newName('XML') }));
  mu.open('xmp', d.saveToBuffer('').asUint8Array().slice());
  mu.setMeta('xmp', { Title: 'New & better', Author: 'Site Engineer', Keywords: 'BOQ' });
  const s = new mupdf.PDFDocument(mu.save('xmp')).getTrailer().get('Root', 'Metadata').readStream().asString();
  assert.ok(s.includes('>New &amp; better<') && s.includes('>Site Engineer<') && s.includes('pdf:Keywords="BOQ"') && !s.includes('Old'), s);
  assert.ok(new mupdf.PDFDocument(mu.save('xmp', { clearMetadata: true })).getTrailer().get('Root', 'Metadata').isNull(), 'gone from the cleaned copy');
  mu.close('xmp');
});

/** a set of sheets: "<word> 1".. on each, labels A-101.., bookmarks to sheets 2 and 3, a link on sheet 1 to sheet 3, a markup on sheet 2 */
function sheetSet(id: string, word: string, n: number, first: number[] = [0, 0, 595, 842]): Uint8Array {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < n; i++) d.insertPage(-1, d.addPage(i ? [0, 0, 595, 842] : first, 0, { Font: { F1: f } }, `BT /F1 30 Tf 100 400 Td (${word} ${i + 1}) Tj ET`));
  const link = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Link'), Rect: [10, 10, 50, 30], Dest: [d.findPage(Math.min(2, n - 1)), d.newName('Fit')] });
  d.findPage(0).put('Annots', [link]);
  d.setPageLabels(0, 'D', 'A-', 101);
  const it = d.outlineIterator();
  it.insert({ title: 'Sheet 2', uri: '#page=2', open: false } as never); it.next();
  it.insert({ title: 'Sheet 3', uri: '#page=3', open: false } as never);
  mu.open(id + '0', d.saveToBuffer('').asUint8Array().slice(), undefined, 'Tester');
  mu.createAnnot(id + '0', Math.min(1, n - 1), { type: 'Square', rect: [100, 100, 200, 160], color: [1, 0, 0], contents: word + ' markup' });
  const b = mu.save(id + '0');
  mu.close(id + '0');
  return b;
}

test('replace pages: revised sheets take the old ones\' places - bookmarks, links, labels kept; old markups go; one undo. Insert from an open file (unsaved changes too)', () => {
  const oldB = sheetSet('rpOld', 'OLD', 4);
  const revB = sheetSet('rpRev', 'REV', 3, [0, 0, 842, 1191]);
  mu.open('rp', oldB, undefined, 'Tester');
  mu.open('rv', revB, undefined, 'Tester');
  const texts = (b: Uint8Array) => { const d = mupdf.Document.openDocument(b, 'application/pdf'); return [...Array(d.countPages()).keys()].map((i) => d.loadPage(i).toStructuredText('').asText().trim()); };
  // one for one: sheet 2 <- revised sheet 1 (an A3)
  let pages = mu.replacePages('rp', [1], { open: 'rv' }, [0]);
  assert.equal(pages.length, 4);
  assert.equal(Math.round(pages[1].w), 842, 'the new sheet\'s size');
  let d = describe(mu.save('rp'));
  assert.deepEqual(texts(mu.save('rp')), ['OLD 1', 'REV 1', 'OLD 3', 'OLD 4']);
  assert.deepEqual(d.pages.map((p) => p.label), ['A-101', 'A-102', 'A-103', 'A-104'], 'labels stay with their places');
  assert.deepEqual(d.outline, [['Sheet 2', 1], ['Sheet 3', 2]], 'bookmarks still point at sheets 2 and 3');
  assert.deepEqual(d.pages[1].annots, [], 'the old sheet\'s markup went with it (the revised sheet 1 has none)');
  assert.equal(d.pageObjs, 4, 'no stray page objects left behind');
  mu.undo('rp');
  assert.deepEqual(texts(mu.save('rp')), ['OLD 1', 'OLD 2', 'OLD 3', 'OLD 4'], 'one undo puts the old sheet back');
  assert.deepEqual(describe(mu.save('rp')).pages[1].annots, ['Square:OLD markup'], 'with its markup');
  // a run of 2 replaced by 3: the extra one goes in after
  pages = mu.replacePages('rp', [1, 2], { open: 'rv' }, [0, 1, 2]);
  assert.deepEqual(texts(mu.save('rp')), ['OLD 1', 'REV 1', 'REV 2', 'REV 3', 'OLD 4']);
  d = describe(mu.save('rp'));
  assert.deepEqual(d.pages[2].annots, ['Square:REV markup'], 'the revised sheet\'s own markup came along');
  assert.deepEqual(d.outline, [['Sheet 2', 1], ['Sheet 3', 2]]);
  assert.equal(d.pages[4].label, 'A-104');
  assert.deepEqual(d.pages[0].links, ['#page=3&view=Fit'], 'the link to sheet 3 still goes to sheet 3');
  mu.undo('rp');
  // 3 replaced by 1 from a file on disk: the old ones left over go, their bookmarks too
  pages = mu.replacePages('rp', [0, 1, 2], { bytes: revB }, [2]);
  assert.deepEqual(texts(mu.save('rp')), ['REV 3', 'OLD 4']);
  d = describe(mu.save('rp'));
  assert.ok(d.outline.every((x: any[]) => x[1] >= 0 && x[1] < 2), 'no bookmark left pointing at a page that went: ' + JSON.stringify(d.outline));
  mu.undo('rp');
  assert.equal(mu.save('rp').length > 0 && texts(mu.save('rp')).length, 4);
  // what can't be done is said
  assert.throws(() => mu.replacePages('rp', [0, 2], { open: 'rv' }, [0]), /as many of each/);
  assert.throws(() => mu.replacePages('rp', [7], { open: 'rv' }, [0]), /has 4 pages/);
  assert.throws(() => mu.replacePages('rp', [0], { open: 'rv' }, [5]), /has 3 pages/);
  assert.throws(() => mu.replacePages('rp', [0], { open: 'rp' }, [0]), /another file/);
  // insert from an open file, as it is now (a note added and not saved)
  mu.createAnnot('rv', 2, { type: 'Text', rect: [50, 50, 70, 70], contents: 'fresh note' });
  pages = mu.insertFromOpen('rp', 0, 'rv', [2, 0]);
  assert.equal(pages.length, 6);
  assert.deepEqual(texts(mu.save('rp')).slice(0, 3), ['REV 3', 'REV 1', 'OLD 1'], 'in the order asked, at the start');
  assert.deepEqual(describe(mu.save('rp')).pages[0].annots, ['Text:fresh note'], 'the unsaved note came along');
  assert.throws(() => mu.insertFromOpen('rp', 0, 'rp'), /this file already/);
  mu.undo('rp');
  assert.deepEqual(texts(mu.save('rp')), ['OLD 1', 'OLD 2', 'OLD 3', 'OLD 4']);
  assert.deepEqual(texts(mu.save('rv')), ['REV 1', 'REV 2', 'REV 3'], 'the other file is left as it was');
  mu.close('rp'); mu.close('rv');
});

test('a deleted page leaves nothing of itself in the saved file: calculation order, article threads (chain re-linked); undo puts them back', () => {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < 3; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, `BT /F1 20 Tf 100 700 Td (PAGE${i + 1}SECRET) Tj ET`));
  const ws = [0, 1].map((i) => { const w = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Widget'), FT: d.newName('Tx'), T: d.newString('f' + i), Rect: [100, 600, 300, 620], P: d.findPage(i), F: 4 }); d.findPage(i).put('Annots', [w]); return w; });
  d.getTrailer().get('Root').put('AcroForm', d.addObject({ Fields: ws, CO: ws }));
  const t = d.addObject({ Type: d.newName('Thread') });
  const beads = [0, 1, 2].map((i) => d.addObject({ Type: d.newName('Bead'), P: d.findPage(i), R: [0, 0, 9, 9] }));
  beads.forEach((b, i) => { b.put('N', beads[(i + 1) % 3]); b.put('V', beads[(i + 2) % 3]); d.findPage(i).put('B', [b]); });
  beads[0].put('T', t);
  t.put('F', beads[0]);
  d.getTrailer().get('Root').put('Threads', [t]);
  mu.open('dl', d.saveToBuffer('').asUint8Array().slice(), undefined, 'Tester');
  const holds = (b: Uint8Array, s: string) => { const x = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!; for (let i = 1; i < x.countObjects(); i++) { const r = x.newIndirect(i); try { if (r.isStream() && Buffer.from(r.readStream().asUint8Array()).toString('latin1').includes(s)) return true; } catch { /* */ } } return false; };
  const chain = (b: Uint8Array) => {
    const x = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
    const th = x.getTrailer().get('Root').get('Threads');
    if (!th.isArray()) return null;
    const pageNo = (p: mupdf.PDFObject) => { for (let i = 0; i < x.countPages(); i++) if (x.findPage(i).asIndirect() === p.asIndirect()) return i; return -1; };
    const out: number[] = [];
    let b0 = th.get(0).resolve().get('F'), cur = b0;
    for (let n = 0; n < 10; n++) { out.push(pageNo(cur.resolve().get('P'))); assert.equal(cur.resolve().get('N').resolve().get('V').asIndirect(), cur.asIndirect(), 'N/V agree'); cur = cur.resolve().get('N'); if (cur.asIndirect() === b0.asIndirect()) break; }
    return out;
  };
  const co = (b: Uint8Array) => mupdf.Document.openDocument(b, 'application/pdf').asPDF()!.getTrailer().get('Root').get('AcroForm').get('CO').length;
  mu.deletePages('dl', [1]);
  let saved = mu.save('dl');
  assert.equal(holds(saved, 'PAGE2SECRET'), false, 'page 2 gone for good');
  assert.equal(holds(saved, 'PAGE3SECRET'), true);
  assert.equal(co(saved), 1, 'its field out of the calculation order');
  assert.deepEqual(chain(saved), [0, 1], 'the thread runs page 1 -> page 2 (was 3)');
  mu.deletePages('dl', [0, 1].slice(0, 1));
  saved = mu.save('dl');
  assert.deepEqual(chain(saved), [0], 'one bead left, linked to itself');
  mu.undo('dl'); mu.undo('dl');
  saved = mu.save('dl');
  assert.equal(holds(saved, 'PAGE2SECRET'), true, 'undo: page 2 back');
  assert.equal(co(saved), 2);
  assert.deepEqual(chain(saved), [0, 1, 2], 'undo: the thread as it was');
  mu.close('dl');
});

test('page delete / move / replace keep the file\'s attachments and scripts (MuPDF writes a new /Names); named pages of a deleted page go; a /Names without named places is fine', () => {
  const make = (withDests: boolean) => {
    const d = new mupdf.PDFDocument();
    const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
    for (let i = 0; i < 3; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, `BT /F1 20 Tf 100 700 Td (NAMED${i + 1}) Tj ET`));
    const file = d.addStream('BOQ attached', { Type: d.newName('EmbeddedFile') });
    const spec = d.addObject({ Type: d.newName('Filespec'), F: d.newString('boq.xlsx'), EF: { F: file } });
    const names = d.newDictionary();
    if (withDests) names.put('Dests', d.addObject({ Names: [d.newString('sec2'), [d.findPage(1), d.newName('Fit')]] }));
    names.put('EmbeddedFiles', d.addObject({ Names: [d.newString('boq.xlsx'), spec] }));
    names.put('JavaScript', d.addObject({ Names: [d.newString('init'), { S: d.newName('JavaScript'), JS: d.newString('1;') }] }));
    names.put('Pages', d.addObject({ Names: [d.newString('p2'), d.findPage(1), d.newString('p3'), d.findPage(2)] }));
    d.getTrailer().get('Root').put('Names', names);
    return d.saveToBuffer('').asUint8Array().slice();
  };
  const keys = (b: Uint8Array) => { const n = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!.getTrailer().get('Root').get('Names'); const k: string[] = []; if (n.isDictionary()) n.forEach((_v, key) => { k.push(String(key)); }); return k.sort().join(','); };
  const named = (b: Uint8Array) => { const x = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!; const arr = x.getTrailer().get('Root').get('Names').get('Pages').resolve().get('Names'); const out: string[] = []; for (let i = 0; i < arr.length; i += 2) out.push(arr.get(i).asString()); return out.join(','); };
  for (const withDests of [true, false]) {
    const all = withDests ? 'Dests,EmbeddedFiles,JavaScript,Pages' : 'EmbeddedFiles,JavaScript,Pages';
    mu.open('nm', make(withDests), undefined, 'Tester');
    mu.arrangePages('nm', [2, 0, 1]);
    assert.equal(keys(mu.save('nm')), all, 'move: all kept (' + withDests + ')');
    mu.undo('nm');
    mu.deletePages('nm', [1]);
    let b = mu.save('nm');
    assert.equal(keys(b), all, 'delete: all kept');
    assert.equal(named(b), 'p3', 'the deleted page\'s name went');
    mu.undo('nm');
    assert.equal(named(mu.save('nm')), 'p2,p3', 'undo: back');
    mu.open('nmR', make(false), undefined, 'Tester');
    mu.replacePages('nm', [0], { open: 'nmR' }, [2]);
    b = mu.save('nm');
    assert.equal(keys(b), all, 'replace: all kept');
    assert.match(mupdf.Document.openDocument(b, 'application/pdf').loadPage(0).toStructuredText('').asText(), /NAMED3/);
    mu.close('nm'); mu.close('nmR');
  }
});

test('bookmark edits after the file was reopened under the same id (full save renumbered it): no target taken from another object', () => {
  const b = sheetSet('obA', 'OB', 4);
  mu.open('ob', b, undefined, 'Tester');
  const items = mu.outlineFull('ob');
  assert.ok(items.length >= 2 && items.every((m) => m.ref));
  // the same file, reopened from a copy whose objects are numbered differently
  const x = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  for (let i = 0; i < 40; i++) x.addObject({ Type: x.newName('Annot'), Subtype: x.newName('Link'), Rect: [0, 0, 1, 1], A: { S: x.newName('URI'), URI: x.newString('https://other.example/' + i) } });
  const re = x.saveToBuffer('garbage=compact').asUint8Array().slice();
  mu.close('ob');
  mu.open('ob', re, undefined, 'Tester');
  // the panel's old list (refs of the old numbering - now the numbers of web links): one renamed
  const y = mupdf.Document.openDocument(re, 'application/pdf').asPDF()!;
  const linkNums: number[] = [];
  for (let i = 1; i < y.countObjects(); i++) { const o = y.newIndirect(i).resolve(); if (o.isDictionary() && o.get('Subtype').isName() && o.get('Subtype').asName() === 'Link') linkNums.push(i); }
  const stale = items.map((m, i) => ({ ...m, ref: linkNums[i] }));
  stale[0].title += ' (renamed)';
  mu.setOutline('ob', stale);
  const got = mu.outlineFull('ob');
  assert.deepEqual(got.map((m) => [m.title, m.page]), items.map((m, i) => [m.title + (i ? '' : ' (renamed)'), m.page]));
  for (const m of got) assert.doesNotMatch(String(m.uri), /other\.example/, 'no web address taken from another object');
  mu.close('ob');
});

test('the engine reads the undo journal the quick way (mupdf-pre first) - the same as MuPDF.js reads it', () => {
  assert.ok(mu.journalFast(), 'mupdf-pre.mjs loaded before MuPDF.js');
  mu.open('jq', sheetSet('jqA', 'J', 3), undefined, 'Tester');
  mu.createAnnot('jq', 0, { type: 'Square', rect: [10, 10, 60, 60], color: [1, 0, 0] });
  mu.rotatePages('jq', [1], 90);
  mu.createAnnot('jq', 2, { type: 'Circle', rect: [10, 10, 60, 60], color: [0, 0, 1] });
  mu.undo('jq');
  const b = mu.journalBothWays('jq');
  assert.deepEqual(b.quick, b.slow);
  assert.equal(b.quick.position, 2);
  assert.equal(b.quick.steps.length, 3);
  mu.close('jq');
});

test('a long page insert / replace is cut into journal steps (fast) - still one Undo, one Redo, and all taken back if it fails half way', () => {
  const big = sheetSet('lgSrc', 'NEW', 250);
  mu.open('lg', sheetSet('lgOld', 'OLD', 5), undefined, 'Tester');
  mu.open('lgs', big, undefined, 'Tester');
  const texts = () => { const d = mupdf.Document.openDocument(mu.save('lg'), 'application/pdf'); return [...Array(d.countPages()).keys()].map((i) => d.loadPage(i).toStructuredText('').asText().trim()); };
  const labels = () => mu.pageInfos('lg').map((p) => p.label);
  const before = texts(), labs0 = labels();
  // 250 pages after page 2: three journal steps, one entry in the history
  let t = Date.now();
  mu.insertFromOpen('lg', 2, 'lgs');
  assert.ok(Date.now() - t < 5000, 'quick: ' + (Date.now() - t) + ' ms');
  let now = texts();
  assert.equal(now.length, 255);
  assert.deepEqual(now.slice(0, 4), ['OLD 1', 'OLD 2', 'NEW 1', 'NEW 2']);
  assert.equal(now[251], 'NEW 250');
  assert.equal(now[252], 'OLD 3');
  assert.equal(labels()[0], 'A-101');
  assert.deepEqual(mu.history('lg').undo.slice(-1), ['Insert pages']);
  assert.equal(mu.history('lg').undo.length, 1, 'one step in the history');
  mu.undo('lg');
  assert.deepEqual(texts(), before, 'one Undo: the file as it was');
  assert.deepEqual(labels(), labs0, 'labels as they were');
  assert.equal(mu.freshPageInfos('lg').length, 5);
  mu.redo('lg');
  assert.equal(texts().length, 255, 'one Redo: all of it back');
  assert.equal(texts()[251], 'NEW 250');
  mu.undo('lg');
  // replace 2 pages by 250: the same
  mu.replacePages('lg', [1, 2], { open: 'lgs' });
  now = texts();
  assert.equal(now.length, 253);
  assert.deepEqual([now[0], now[1], now[250], now[251]], ['OLD 1', 'NEW 1', 'NEW 250', 'OLD 4']);
  mu.undo('lg');
  assert.deepEqual(texts(), before, 'replace: one Undo');
  // a failure half way (in the third step): nothing left of it, history as it was, undo still right
  mu.rotatePages('lg', [0], 90);
  const hist = mu.history('lg').undo.length;
  const proto = mupdf.PDFGraftMap.prototype as unknown as { graftPage: (...a: unknown[]) => unknown };
  const orig = proto.graftPage;
  let calls = 0;
  proto.graftPage = function (this: unknown, ...a: unknown[]) { if (++calls === 230) throw new Error('disk gone'); return orig.apply(this, a); };
  try { assert.throws(() => mu.insertFromOpen('lg', 2, 'lgs'), /disk gone/); } finally { proto.graftPage = orig; }
  assert.equal(calls, 230);
  assert.equal(mu.history('lg').undo.length, hist, 'nothing recorded');
  assert.equal(mu.freshPageInfos('lg').length, 5, 'no page of it left in the file');
  assert.deepEqual(texts(), before);
  assert.deepEqual(labels(), labs0);
  if (hist) { mu.undo('lg'); assert.equal(mu.freshPageInfos('lg')[0].rot, 0, 'the step before still undoes'); }
  // failing after an Undo: Redo must not redo the parts taken back (nor the step MuPDF dropped)
  assert.deepEqual(mu.history('lg').redo, ['Rotate pages']);
  calls = 0;
  proto.graftPage = function (this: unknown, ...a: unknown[]) { if (++calls === 150) throw new Error('disk gone'); return orig.apply(this, a); };
  try { assert.throws(() => mu.insertFromOpen('lg', 2, 'lgs'), /disk gone/); } finally { proto.graftPage = orig; }
  const r = mu.redo('lg');
  assert.equal(r.ok, false, 'nothing to redo');
  assert.equal(mu.freshPageInfos('lg').length, 5, 'Redo put no pages in');
  assert.deepEqual(mu.history('lg').redo, []);
  mu.close('lg'); mu.close('lgs');
});


test('bookmarks edited: written back as they were (nesting, closed, colour, bold, web link, view); one undo per edit; saved', () => {
  const d = new mupdf.PDFDocument();
  for (let i = 0; i < 5; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  const it = d.outlineIterator();
  it.insert({ title: 'Architecture', uri: '#page=1', open: true } as never);
  it.prev(); it.down();
  it.insert({ title: 'A-101 Ground floor', uri: '#page=2&view=FitH,500', open: false } as never);
  it.insert({ title: 'A-102 First floor', uri: '#page=3', open: false } as never);
  it.up(); it.next();
  it.insert({ title: 'Structure', uri: '#page=4', open: false } as never);
  it.insert({ title: 'Tender portal', uri: 'https://example.com/tender', open: false } as never);
  // colour + bold on "Structure"
  const raw = d.getTrailer().get('Root').get('Outlines').get('First').get('Next');
  raw.put('C', [1, 0, 0]); raw.put('F', 2);
  mu.open('bm', d.saveToBuffer('').asUint8Array().slice(), undefined, 'Tester');
  const t0 = mu.outlineFull('bm');
  assert.deepEqual(t0.map((m) => m.title), ['Architecture', 'Structure', 'Tender portal']);
  assert.deepEqual(t0[0].children.map((m) => [m.title, m.page]), [['A-101 Ground floor', 1], ['A-102 First floor', 2]]);
  assert.deepEqual([t0[1].c, t0[1].f], [[1, 0, 0], 2], 'colour and bold read');
  assert.equal(t0[2].uri, 'https://example.com/tender');
  // written back unchanged: the same
  // (the items are new objects: their numbers differ, nothing else)
  const noRef = (l: any[]): any[] => l.map(({ ref, children, ...x }) => ({ ...x, children: noRef(children) }));
  const same = mu.setOutline('bm', t0, 'Rewrite');
  assert.deepEqual(noRef(same), noRef(t0), 'a rewrite changes nothing');
  // rename, delete, move a child to the top level, add a new one (on the list the rewrite gave
  // back, as the panel does: its items are the outline's objects now)
  const t1 = structuredClone(same);
  t1[1].title = 'Structure (rev B)';
  const moved = t1[0].children.splice(1, 1)[0];
  t1.splice(1, 0, moved);
  t1.pop();
  t1.push({ title: 'Page 5', page: 4, uri: null, open: false, children: [] });
  const r1 = mu.setOutline('bm', t1, 'Edit bookmarks');
  assert.deepEqual(r1.map((m) => [m.title, m.page]), [['Architecture', 0], ['A-102 First floor', 2], ['Structure (rev B)', 3], ['Page 5', 4]]);
  assert.deepEqual([r1[2].c, r1[2].f], [[1, 0, 0], 2], 'colour and bold kept after the edit');
  assert.equal(r1[0].children[0].uri, t0[0].children[0].uri, 'the view of a bookmark kept');
  assert.equal(mu.history('bm').undo.length, 2);
  const u = mu.undo('bm');
  assert.equal(u.kind, 'm', 'a bookmark step');
  assert.deepEqual(noRef(mu.outlineFull('bm')), noRef(t0), 'undo: as before');
  mu.redo('bm');
  // saved (in full and as changes) and read back
  for (const opts of [{}, { incremental: true }]) {
    const b = mu.save('bm', opts as never);
    const back = mupdf.Document.openDocument(b, 'application/pdf');
    const conv = (l: any[]): any[] => l.map((x) => [x.title, x.page ?? -1, ...(x.down ? [conv(x.down)] : [])]);
    assert.deepEqual(conv(back.loadOutline() as any), [['Architecture', 0, [['A-101 Ground floor', 1]]], ['A-102 First floor', 2], ['Structure (rev B)', 3], ['Page 5', 4]], 'saved ' + JSON.stringify(opts));
  }
  // all deleted
  assert.deepEqual(mu.setOutline('bm', [], 'Delete bookmarks'), []);
  mu.undo('bm');
  assert.equal(mu.outlineFull('bm').length, 4);
  mu.close('bm');
});

test('links: made to a web address or a page, changed, deleted; one undo each; only web / e-mail / page targets', () => {
  const d = new mupdf.PDFDocument();
  for (let i = 0; i < 3; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  mu.open('lk', d.saveToBuffer('').asUint8Array().slice(), undefined, 'Tester');
  mu.addLink('lk', 0, [100, 100, 200, 120], { uri: 'https://example.com/spec' });
  mu.addLink('lk', 0, [100, 200, 200, 220], { page: 2 });
  let l = mu.linksOf('lk', 0);
  assert.deepEqual(l.map((x) => [x.uri?.startsWith('#') ? 'page' : x.uri, x.page, x.rect.map(Math.round)]), [['https://example.com/spec', -1, [100, 100, 200, 120]], ['page', 2, [100, 200, 200, 220]]]);
  mu.setLink('lk', 0, 0, { uri: 'mailto:tenders@example.com' });
  assert.equal(mu.linksOf('lk', 0)[0].uri, 'mailto:tenders@example.com');
  mu.setLink('lk', 0, 1, null);
  assert.equal(mu.linksOf('lk', 0).length, 1, 'deleted');
  assert.deepEqual(mu.history('lk').undo, ['Add link', 'Add link', 'Change link', 'Delete link']);
  mu.undo('lk');
  assert.equal(mu.linksOf('lk', 0).length, 2, 'undo: back');
  for (const bad of ['file:///C:/Windows/system32/calc.exe', 'javascript:alert(1)', '\\\\server\\share\\x.exe', 'ms-settings:', 'https://x y']) assert.throws(() => mu.addLink('lk', 0, [0, 0, 10, 10], { uri: bad }), /web address/, bad);
  const back = mupdf.Document.openDocument(mu.save('lk'), 'application/pdf');
  assert.deepEqual(back.loadPage(0).getLinks().map((x) => x.getURI().replace(/^#page=3.*/, '#page=3')), ['mailto:tenders@example.com', '#page=3'], 'saved');
  // links read from a file: deleted for good too
  mu.open('lk2', mu.save('lk'), undefined, 'Tester');
  mu.setLink('lk2', 0, 0, null);
  assert.deepEqual(mu.linksOf('lk2', 0).map((x) => x.page), [2]);
  const back2 = mupdf.Document.openDocument(mu.save('lk2'), 'application/pdf');
  assert.equal(back2.loadPage(0).getLinks().length, 1, 'gone from the saved file');
  mu.close('lk'); mu.close('lk2');
});

test('page changes keep the catalogue: form, page scales, names, open action (MuPDF rebuilt /Root); what points at a deleted page goes; undo puts it back', () => {
  const d = new mupdf.PDFDocument();
  for (let i = 0; i < 3; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  const root = d.getTrailer().get('Root');
  const p2 = d.findPage(1), p3 = d.findPage(2);
  const w2 = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Widget'), FT: d.newName('Tx'), T: d.newString('OnPage2'), V: d.newString('a'), Rect: [100, 600, 300, 620], P: p2, F: 4 });
  const w3 = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Widget'), FT: d.newName('Tx'), T: d.newString('OnPage3'), V: d.newString('b'), Rect: [100, 600, 300, 620], P: p3, F: 4 });
  p2.put('Annots', [w2]); p3.put('Annots', [w3]);
  root.put('AcroForm', d.addObject({ Fields: [w2, w3], DA: d.newString('/Helv 0 Tf 0 g') }));
  root.put('Lang', d.newString('en-GB'));
  root.put('Names', { Dests: { Names: [d.newString('one'), [d.findPage(0), d.newName('Fit')], d.newString('three'), [p3, d.newName('Fit')]] } });
  root.put('OpenAction', [p3, d.newName('Fit')]);
  mu.open('cat', d.saveToBuffer('').asUint8Array().slice(), undefined, 'T');
  mu.setData('cat', { scales: { '*': { unit: 'm', k: 0.05 }, '2': { unit: 'm', k: 0.1 } } });
  const look = () => {
    const x = mupdf.Document.openDocument(mu.save('cat'), 'application/pdf').asPDF()!;
    const r = x.getTrailer().get('Root');
    const keys: string[] = []; r.forEach((_v, k) => keys.push(String(k)));
    const f = r.get('AcroForm').get('Fields'), n = r.get('Names').get('Dests').get('Names');
    return { keys: keys.sort().join(','), fields: f.isArray() ? f.length : 0, named: n.isArray() ? n.length / 2 : 0, scales: (mu.getData('cat') as any).scales };
  };
  const start = look();
  mu.deletePages('cat', [2]);
  let l = look();
  assert.ok(/AcroForm/.test(l.keys) && /GCCData/.test(l.keys) && /Lang/.test(l.keys) && /Names/.test(l.keys), 'kept: ' + l.keys);
  assert.ok(!/OpenAction/.test(l.keys), 'the open action to the deleted page went');
  assert.equal(l.fields, 1, 'the deleted page\'s field left the form');
  assert.equal(l.named, 1, 'its named place went');
  assert.deepEqual(l.scales, { '*': { unit: 'm', k: 0.05 } }, 'its page scale went');
  mu.undo('cat');
  assert.deepEqual(look(), start, 'undo: all back');
  mu.arrangePages('cat', [2, 0, 1]);
  l = look();
  assert.deepEqual(l.scales, { '*': { unit: 'm', k: 0.05 }, '0': { unit: 'm', k: 0.1 } }, 'a page\'s scale moves with it');
  assert.equal(l.fields, 2);
  mu.undo('cat');
  mu.insertBlank('cat', 0, 595, 842, 2);
  assert.deepEqual(look().scales, { '*': { unit: 'm', k: 0.05 }, '4': { unit: 'm', k: 0.1 } }, 'and moves along when pages go in before it');
  mu.close('cat');
});
