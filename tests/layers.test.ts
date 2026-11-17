// Layers (optional content), the engine side (PLAN 7.7): listed in the file's order, switched for
// display only (the drawing copy gets an appended update; the file is unchanged), saved as the
// file's state only when asked (one undo step). The line-work merge never joins strokes across a
// layer boundary. Rule R: files with no layers list none, quickly.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import * as pf from '../src/engine/pdfium';
import { overlay as _o, lastXref } from '../src/engine/overlay';
import { mergeStrokes } from '../src/engine/strokes';
void _o;

/** one page, four squares on four layers: Walls (black), Furniture (red, off in the file), Grid
 *  (blue, listed under Walls), Notes (green, locked) */
function layered(): Uint8Array {
  const d = new mupdf.PDFDocument();
  const mk = (name: string) => { const g = d.newDictionary(); g.put('Type', d.newName('OCG')); g.put('Name', d.newString(name)); return d.addObject(g); };
  const walls = mk('Walls'), furn = mk('Furniture'), grid = mk('Grid'), notes = mk('Notes');
  const props = d.newDictionary();
  props.put('L1', walls); props.put('L2', furn); props.put('L3', grid); props.put('L4', notes);
  const res = d.newDictionary();
  res.put('Properties', props);
  const content = '/OC /L1 BDC 0 0 0 rg 50 50 100 100 re f EMC /OC /L2 BDC 1 0 0 rg 200 50 100 100 re f EMC /OC /L3 BDC 0 0 1 rg 350 50 100 100 re f EMC /OC /L4 BDC 0 1 0 rg 500 50 60 100 re f EMC';
  d.insertPage(-1, d.addPage([0, 0, 600, 200], 0, res, content));
  const ocp = d.newDictionary();
  const arr = (...x: mupdf.PDFObject[]) => { const a = d.newArray(); for (const y of x) a.push(y); return a; };
  ocp.put('OCGs', arr(walls, furn, grid, notes));
  const D = d.newDictionary();
  D.put('Order', arr(walls, arr(grid), furn, notes));
  D.put('OFF', arr(furn));
  D.put('Locked', arr(notes));
  ocp.put('D', D);
  d.getTrailer().get('Root').put('OCProperties', ocp);
  return d.saveToBuffer('').asUint8Array().slice();
}
/** the colour in the middle of each square, drawn by PDFium (1 px per point) */
function squares(id: string): string[] {
  const px = pf.render(id, 0, 1, 0, 0, 600, 200);
  const at = (x: number) => { const i = (100 * 600 + x) * 4; const [r, g, b] = [px[i], px[i + 1], px[i + 2]]; return r > 200 && g > 200 && b > 200 ? '-' : r > 200 ? 'red' : g > 120 ? 'green' : b > 200 ? 'blue' : 'black'; };
  return [100, 250, 400, 530].map(at);
}
/** the drawing copy as the app makes it: the file + the display update */
function drawCopy(id: string, file: Uint8Array): Uint8Array {
  const extra = mu.displayOverlay(id, file.length, lastXref(file.subarray(Math.max(0, file.length - 4096))));
  if (!extra) return file;
  const parts = [file, ...extra.map((e) => ('bytes' in e ? e.bytes : readFileSync(e.path).subarray(0, e.size)))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}

test('layers: listed, switched for display only, saved when asked, undone', async () => {
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const file = layered();
  mu.open('ly', file, undefined, 'Tester');
  const l = mu.layers('ly');
  assert.deepEqual(l.map((x) => [x.name, x.on, x.locked, x.depth]), [['Walls', true, false, 0], ['Grid', true, false, 1], ['Furniture', false, false, 0], ['Notes', true, true, 0]]);
  pf.openDoc('ly0', file);
  assert.deepEqual(squares('ly0'), ['black', '-', 'blue', 'green'], 'the file as it says');
  pf.closeDoc('ly0');
  // Walls off, Furniture on, Notes (locked) off -> refused for Notes
  const byName = Object.fromEntries(l.map((x) => [x.name, x.num]));
  assert.equal(mu.setLayersShown('ly', { [byName.Walls]: false, [byName.Furniture]: true, [byName.Notes]: false }), true);
  assert.deepEqual(mu.layers('ly').map((x) => [x.name, x.shown]), [['Walls', false], ['Grid', true], ['Furniture', true], ['Notes', true]]);
  assert.equal(mu.layerStateSet('ly'), true);
  pf.openDoc('ly1', drawCopy('ly', mu.snapshot('ly')));
  assert.deepEqual(squares('ly1'), ['-', 'red', 'blue', 'green'], 'the drawing copy shows the switched layers');
  pf.closeDoc('ly1');
  // nothing in the file changed: no undo step, the saved file as it was
  assert.deepEqual(mu.history('ly').undo, []);
  const plain = mupdf.Document.openDocument(mu.save('ly'), 'application/pdf') as mupdf.PDFDocument;
  assert.equal(plain.getTrailer().get('Root').get('OCProperties').get('D').get('OFF').length, 1, 'the file still has only Furniture off');
  // saved as the file's state: one step; fresh MuPDF and PDFium see it
  mu.saveLayerState('ly');
  assert.deepEqual(mu.history('ly').undo, ['Save the layer state']);
  assert.equal(mu.layerStateSet('ly'), false, 'nothing shown differently any more');
  const saved = mu.save('ly');
  mu.open('ly2', saved, undefined, 'Tester');
  assert.deepEqual(mu.layers('ly2').map((x) => [x.name, x.on]), [['Walls', false], ['Grid', true], ['Furniture', true], ['Notes', true]]);
  mu.close('ly2');
  pf.openDoc('ly3', saved);
  assert.deepEqual(squares('ly3'), ['-', 'red', 'blue', 'green'], 'PDFium draws the saved state');
  pf.closeDoc('ly3');
  // undo: the file's own state again
  mu.undo('ly');
  assert.deepEqual(mu.layers('ly').map((x) => [x.name, x.on, x.shown]), [['Walls', true, true], ['Grid', true, true], ['Furniture', false, false], ['Notes', true, true]]);
  // back to the file's state: no display update needed
  mu.setLayersShown('ly', null);
  assert.equal(mu.layerStateSet('ly'), false);
  mu.close('ly');
});

test('the layer settings held directly in the catalog, or in their own object: both switch', async () => {
  // (layered() puts /OCProperties directly in the catalog; here /D is its own object)
  const d = mupdf.Document.openDocument(layered(), 'application/pdf') as mupdf.PDFDocument;
  const ocp = d.getTrailer().get('Root').get('OCProperties');
  ocp.put('D', d.addObject(ocp.get('D')));
  const file = d.saveToBuffer('').asUint8Array().slice();
  mu.open('ly4', file, undefined, 'Tester');
  const walls = mu.layers('ly4')[0].num;
  mu.setLayersShown('ly4', { [walls]: false });
  pf.openDoc('ly5', drawCopy('ly4', mu.snapshot('ly4')));
  assert.deepEqual(squares('ly5'), ['-', '-', 'blue', 'green']);
  pf.closeDoc('ly5');
  mu.close('ly4');
});

test('the line-work merge never joins strokes across a layer boundary', () => {
  const run = (n: number) => Array.from({ length: n }, (_, i) => `${i} 0 m ${i} 10 l S`).join(' ');
  const src = new TextEncoder().encode(`/OC /L1 BDC ${run(50)} EMC /OC /L2 BDC ${run(50)} EMC`);
  const r = mergeStrokes(src, 10)!;
  assert.ok(r, 'merged');
  const t = new TextDecoder().decode(r.out);
  // each layer's strokes merged on their own: the markers still around them, in place
  const a = t.indexOf('/L1 BDC'), e1 = t.indexOf('EMC'), b = t.indexOf('/L2 BDC'), e2 = t.lastIndexOf('EMC');
  assert.ok(a >= 0 && a < e1 && e1 < b && b < e2);
  const s1 = (t.slice(a, e1).match(/\bS\b/g) || []).length, s2 = (t.slice(b, e2).match(/\bS\b/g) || []).length;
  assert.equal(s1 + s2, r.strokesOut);
  assert.ok(s1 >= 1 && s2 >= 1);
});

test('files with no layers: none listed, quickly (rule R)', () => {
  for (const f of ['tests/data/long-spec.pdf', 'tests/data/scan.pdf']) {
    mu.open('ly6', new Uint8Array(readFileSync(f)), undefined, 'Tester');
    const t0 = performance.now();
    assert.deepEqual(mu.layers('ly6'), []);
    assert.equal(mu.setLayersShown('ly6', { 5: false }), false);
    assert.equal(mu.saveLayerState('ly6'), null);
    assert.equal(mu.displayOverlay('ly6', 1000, 10), null, 'no display update');
    assert.ok(performance.now() - t0 < 2000);
    assert.deepEqual(mu.history('ly6').undo, []);
    mu.close('ly6');
  }
});

test('print preview, the print file and the batch copy follow the layers shown (PLAN 7.8)', () => {
  // (MuPDF's own layer list is by object number, not the order of /OCGs: the switches must land on the right layers)
  const cls = (d: Uint8ClampedArray | Uint8Array, ch: number) => {
    const n = { black: 0, red: 0, blue: 0, green: 0 };
    for (let i = 0; i < d.length; i += ch) { const r = d[i], g = d[i + 1], b = d[i + 2]; if (r < 70 && g < 70 && b < 70) n.black++; else if (r > 170 && g < 80 && b < 80) n.red++; else if (b > 170 && r < 80 && g < 80) n.blue++; else if (g > 170 && r < 80 && b < 80) n.green++; }
    return Object.entries(n).filter(([, v]) => v > 100).map(([k]) => k).join('+');
  };
  const of = (bytes: Uint8Array) => { const p = (mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument).loadPage(0); return cls(p.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, true).getPixels(), 3); };
  mu.open('ly7', layered(), undefined, 'Tester');
  const by = Object.fromEntries(mu.layers('ly7').map((x) => [x.name, x.num]));
  const opts = { pages: [0], region: null, paper: null, orient: 'auto', scale: 'fit', pct: 100, margin: 0, markups: true, send: 'vector', gray: false } as never;
  assert.equal(cls(mu.printPreview('ly7', opts, 0, 900)!.px, 4), 'black+blue+green', 'the file as it says');
  assert.equal(mu.layerOverlay('ly7'), null);
  mu.setLayersShown('ly7', { [by.Walls]: false, [by.Furniture]: true });
  assert.deepEqual(mu.layerOverlay('ly7'), { [by.Walls]: false, [by.Furniture]: true });
  assert.equal(cls(mu.printPreview('ly7', opts, 0, 900)!.px, 4), 'red+blue+green', 'print preview');
  const printed = mu.printFile('ly7', opts) as Uint8Array;
  assert.equal(of(printed), 'red+blue+green', 'the file made for the printer');
  // the document itself is as it was: no step, the saved file as the file says
  assert.deepEqual(mu.history('ly7').undo, []);
  assert.equal(of(mu.save('ly7')), 'black+blue+green');
  // a batch copy (pictures, exports) knows nothing of the window: given the state, it shows it
  const plain = mu.save('ly7');
  const png = (id: string) => { const pix = new mupdf.Image(mu.pageImage(id, 0, { dpi: 72, format: 'png' }).bytes).toPixmap(); return cls(pix.getPixels(), pix.getNumberOfComponents() + (pix.getAlpha() ? 1 : 0)); };
  const b = mu.batchOpen(plain, undefined, mu.layerOverlay('ly7'));
  assert.equal(png(b), 'red+blue+green', 'batch copy');
  mu.close(b);
  const b2 = mu.batchOpen(plain);
  assert.equal(png(b2), 'black+blue+green', 'without it: as the file says');
  mu.close(b2);
  mu.close('ly7');
});

test('a protected file: layers switched off are switched off on screen too (sweep S2)', async () => {
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  // (a string in the settings: an encrypted copy can't take it as it is)
  const src = mupdf.Document.openDocument(layered(), 'application/pdf') as mupdf.PDFDocument;
  src.getTrailer().get('Root').get('OCProperties').get('D').put('Name', src.newString('Default view'));
  for (const [what, user] of [['permissions only', ''], ['a password to open', 'open']] as const) {
    const file = src.saveToBuffer(`encrypt=aes-256,owner-password=owner,user-password=${user},permissions=-4`).asUint8Array().slice();
    mu.open('pl', file, user || undefined, 'Tester');
    const byName = Object.fromEntries(mu.layers('pl').map((x) => [x.name, x.num]));
    mu.setLayersShown('pl', { [byName.Walls]: false, [byName.Furniture]: true });
    pf.openDoc('pl1', drawCopy('pl', mu.snapshot('pl')), user || undefined);
    assert.deepEqual(squares('pl1'), ['-', 'red', 'blue', 'green'], `${what}: the drawing copy shows the switched layers`);
    pf.closeDoc('pl1');
    mu.close('pl');
  }
});

test('layers with no names: the switches still land on the right layers in MuPDF (sweep S3)', () => {
  // (the names can't confirm MuPDF's order then: its own order, by object number, is taken - and
  // /OCGs is listed here the other way round, so the other guess would hide the wrong layers)
  const d = mupdf.Document.openDocument(layered(), 'application/pdf') as mupdf.PDFDocument;
  const ocp = d.getTrailer().get('Root').get('OCProperties');
  const ocgs = ocp.get('OCGs');
  const list: mupdf.PDFObject[] = [];
  for (let i = 0; i < ocgs.length; i++) { list.push(ocgs.get(i)); ocgs.get(i).delete('Name'); }
  const rev = d.newArray();
  for (const x of list.reverse()) rev.push(x);
  ocp.put('OCGs', rev);
  mu.open('ln', d.saveToBuffer('').asUint8Array().slice(), undefined, 'Tester');
  const l = mu.layers('ln');
  assert.equal(l.length, 4);
  const opts = { pages: [0], region: null, paper: null, orient: 'auto', scale: 'fit', pct: 100, margin: 0, markups: true, send: 'vector', gray: false } as never;
  const px = () => { const p = mu.printPreview('ln', opts, 0, 900)!.px; let red = 0, black = 0; for (let i = 0; i < p.length; i += 4) { if (p[i] > 170 && p[i + 1] < 80 && p[i + 2] < 80) red++; else if (p[i] < 70 && p[i + 1] < 70 && p[i + 2] < 70) black++; } return { red: red > 100, black: black > 100 }; };
  assert.deepEqual(px(), { red: false, black: true }, 'as the file says');
  // (l[0] is the first in /Order: Walls, black; l[2] Furniture, red)
  mu.setLayersShown('ln', { [l[0].num]: false, [l[2].num]: true });
  assert.deepEqual(px(), { red: true, black: false }, 'Walls hidden, Furniture shown');
  mu.close('ln');
});
