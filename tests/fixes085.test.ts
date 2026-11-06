// 0.8.5 blind review: the fixes of the engine (B1) and of the measuring maths (B3), kept as tests.
//   npx tsx --test tests/fixes085.test.ts
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { PAPERS } from '../src/engine/printlayout';
import { selfCrosses, inViewport, fmtArea, polyArea } from '../src/ui/geom';
import { sameMeasure, isAutoLabel } from '../src/ui/relabel';
import { countNumbers } from '../src/ui/tagcount';

mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));

/** reddish pixels of a page drawn with its markups */
function red(bytes: Uint8Array, page = 0): number {
  const d = mupdf.Document.openDocument(bytes, 'application/pdf');
  const pix = d.loadPage(page).toPixmap(mupdf.Matrix.scale(0.5, 0.5), mupdf.ColorSpace.DeviceRGB, false, true);
  const px = pix.getPixels();
  let n = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] > 200 && px[i + 1] < 80 && px[i + 2] < 80) n++;
  return n;
}
/** a page with a red square markup on a layer, on or off */
function onLayer(on: boolean): Uint8Array {
  const d = new mupdf.PDFDocument();
  const ocg = d.addObject(d.newDictionary());
  ocg.put('Type', d.newName('OCG'));
  ocg.put('Name', d.newString('Markups'));
  const ocp = d.newDictionary();
  const ocgs = d.newArray(); ocgs.push(ocg); ocp.put('OCGs', ocgs);
  const D = d.newDictionary();
  const list = d.newArray(); list.push(ocg);
  D.put(on ? 'ON' : 'OFF', list);
  ocp.put('D', D);
  d.getTrailer().get('Root').put('OCProperties', ocp);
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  const p = d.loadPage(0) as mupdf.PDFPage;
  const an = p.createAnnotation('Square');
  an.setRect([100, 100, 300, 300]); an.setColor([1, 0, 0]); an.setInteriorColor([1, 0, 0]); an.setFlags(4); an.update();
  an.getObject().put('OC', ocg);
  return d.saveToBuffer('').asUint8Array().slice();
}
const A4 = PAPERS.find((x) => x.id === 'A4') ?? PAPERS[0];

test('B1-02 print: a markup on a layer turned off is not printed; on a layer that is on, it is', () => {
  for (const on of [false, true]) {
    mu.open('pl', onLayer(on));
    const f = mu.printFile('pl', { pages: [0], markups: true, paper: A4, orient: 'auto', scale: 'fit', margin: 10 } as never);
    mu.close('pl');
    const bytes = f instanceof Uint8Array ? f : (f as { bytes: Uint8Array }).bytes;
    const n = red(bytes);
    if (on) assert.ok(n > 1000, 'a markup on a layer that is on prints: ' + n); else assert.equal(n, 0, 'hidden layer printed');
  }
});

test('B1-03 flatten: a markup on a layer keeps to it (off: still hidden; on: shown)', () => {
  for (const on of [false, true]) {
    mu.open('fl', onLayer(on));
    mu.flatten('fl', null);
    const after = mu.save('fl', {});
    mu.close('fl');
    const n = red(after);
    if (on) assert.ok(n > 1000, 'shown layer: ' + n); else assert.equal(n, 0, 'hidden layer shown after flatten');
  }
});

test('B1-07 batch flatten keeps redaction marks still to apply, and layers', () => {
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  const p = d.loadPage(0) as mupdf.PDFPage;
  const r = p.createAnnotation('Redact');
  r.setRect([100, 100, 300, 150]); r.update();
  const sq = p.createAnnotation('Square');
  sq.setRect([100, 400, 200, 500]); sq.setColor([1, 0, 0]); sq.setInteriorColor([1, 0, 0]); sq.update();
  const out = mu.batchFlatten(d.saveToBuffer('').asUint8Array().slice());
  const o = mupdf.Document.openDocument(out, 'application/pdf').loadPage(0) as mupdf.PDFPage;
  const types = o.getAnnotations().map((a) => a.getType());
  assert.deepEqual(types, ['Redact'], 'the redaction mark stays a mark; the square is burnt in');
  assert.ok(red(out) > 500, 'the square is in the page');
});

test('B1-05 a page inserted into a labelled file runs on in the range before it', () => {
  const d = new mupdf.PDFDocument();
  for (let i = 0; i < 6; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  const pl = d.newDictionary(), nums = d.newArray();
  const r = d.newDictionary(); r.put('S', d.newName('r'));
  const D = d.newDictionary(); D.put('S', d.newName('D'));
  nums.push(0); nums.push(r); nums.push(2); nums.push(D);
  pl.put('Nums', nums);
  d.getTrailer().get('Root').put('PageLabels', d.addObject(pl));
  mu.open('lb', d.saveToBuffer('').asUint8Array().slice());
  mu.insertBlank('lb', 2, 595, 842, 1);
  assert.deepEqual(mu.pageInfos('lb').map((x) => x.label), ['i', 'ii', 'iii', '1', '2', '3', '4']);
  mu.close('lb');
});

test('B1-04 a bookmark to another file is not read as page 1 of this one, nor rewritten so', () => {
  const d = new mupdf.PDFDocument();
  for (let i = 0; i < 2; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  const it = d.outlineIterator();
  it.insert({ title: 'Drawing A-101 (other file)', uri: 'file:A-101.pdf#page=1', open: false } as never);
  it.insert({ title: 'Page two', uri: '#page=2', open: false } as never);
  // (MuPDF writes a file: link as a page here: the GoToR action is put in by hand, as other programs write it)
  const first = d.getTrailer().get('Root', 'Outlines', 'First').resolve();
  first.delete('Dest');
  const act = d.newDictionary();
  act.put('S', d.newName('GoToR')); act.put('F', d.newString('A-101.pdf'));
  const dest = d.newArray(); dest.push(0); dest.push(d.newName('Fit')); act.put('D', dest);
  first.put('A', act);
  mu.open('bm', d.saveToBuffer('').asUint8Array().slice());
  const marks = mu.outline('bm') as unknown as { title: string; page: number }[];
  const other = marks.find((m) => m.title.startsWith('Drawing'));
  assert.equal(other?.page, -1, 'read as a page of this file');
  const ex = mupdf.Document.openDocument(mu.extract('bm', [0, 1]), 'application/pdf');
  const out = (ex.loadOutline() || []) as { title: string; uri?: string }[];
  const bad = out.find((m) => m.title.startsWith('Drawing') && m.uri?.startsWith('#page='));
  assert.ok(!bad, 'Extract turned it into a bookmark to a page here: ' + bad?.uri);
  assert.ok(out.some((m) => m.title === 'Page two'), 'the bookmark to a page here is kept');
  mu.close('bm');
});

test('B1-01 a file of 2 GB or more is refused with words, not "TRYLATER"', () => {
  const fake = { size: 2 ** 31 + 5, read: () => 0 } as never;
  assert.throws(() => mu.openIn(fake), /2 GB or more/);
});

test('B3-04 Extract carries the page scale', () => {
  const d = new mupdf.PDFDocument();
  for (let i = 0; i < 3; i++) d.insertPage(-1, d.addPage([0, 0, 1191, 842], 0, {}, ''));
  d.getTrailer().get('Root').put('GCCData', d.newString(JSON.stringify({ scales: { 1: { k: 0.0254 / 72 * 50, label: '1:50' }, '*': { k: 0.0254 / 72 * 100, label: '1:100' } }, viewports: { 1: [{ rect: [0, 0, 100, 100], scale: { k: 0.01, label: '1:20' }, name: 'D' }] } })));
  mu.open('sc', d.saveToBuffer('').asUint8Array().slice());
  const ex = mupdf.Document.openDocument(mu.extract('sc', [1, 2]), 'application/pdf') as mupdf.PDFDocument;
  const data = JSON.parse(ex.getTrailer().get('Root', 'GCCData').asString());
  assert.equal(data.scales['0'].label, '1:50');
  assert.equal(data.scales['1'].label, '1:100', "a page without its own scale takes the file's");
  assert.equal(data.viewports['0'][0].name, 'D');
  mu.close('sc');
});

test('B3-02 labels the same to the last digit count as the app\'s own', () => {
  assert.ok(sameMeasure('31272.64 m²', '31272.63 m²'));
  assert.ok(!sameMeasure('31272.64 m²', '31272.61 m²'));
  assert.ok(sameMeasure('7.056 m', '7.056 m'));
  assert.ok(!sameMeasure('7.10 m', '7.06 m'));
  assert.ok(!sameMeasure('Kitchen', '7.06 m'));
  assert.ok(sameMeasure('12\' 6.00"', '12\' 6.01"'));
  // marked as the app's: always; a name: never
  const a = { kind: 'measure-length', contents: '9.99 m', line: [[0, 0], [100, 0]], autoLabel: true } as never;
  assert.ok(isAutoLabel(a, null));
  assert.ok(!isAutoLabel({ kind: 'measure-length', contents: 'Kitchen', line: [[0, 0], [100, 0]] } as never, null));
});

test('B3-06 a viewport follows a page turn', () => {
  const v = { rect: [700, 100, 1100, 500], scale: { rot: 0 } };
  // A3 landscape turned 90°: shown 842 × 1191; the detail is now at x 342..742, y 700..1100
  assert.ok(inViewport(v, 540, 900, { w: 842, h: 1191, rot: 90 }));
  assert.ok(!inViewport(v, 900, 300, { w: 842, h: 1191, rot: 90 }));
  assert.ok(inViewport(v, 900, 300, { w: 1191, h: 842, rot: 0 }));
  // turned back to where it was drawn (180 and 270 too)
  assert.ok(inViewport(v, 1191 - 900, 842 - 300, { w: 1191, h: 842, rot: 180 }));
  assert.ok(inViewport({ rect: [700, 100, 1100, 500] }, 900, 300, { w: 842, h: 1191, rot: 90 }), 'no turn known: as it is');
});

test('B3-10 square feet exactly; B3-11 a bow tie is found', () => {
  const s = { k: (0.0254 / 72) * 48, label: '1/4" = 1\'-0"', imperial: true } as never;
  assert.equal(fmtArea(1800 * 1800, s, { da: 2 } as never), '10000.00 sq ft');
  assert.ok(selfCrosses([[0, 0], [200, 0], [0, 100], [200, 100]]));
  assert.ok(!selfCrosses([[0, 0], [200, 0], [200, 100], [0, 100]]));
  assert.ok(!selfCrosses([[0, 0], [200, 0], [100, 50], [200, 100], [0, 100]]), 'a notch is no crossing');
  assert.equal(polyArea([[0, 0], [200, 0], [200, 100], [0, 100]]), 20000);
});

test('B2-03 / B3-09 count numbers go on after the highest', () => {
  const m = (g: string, t: string) => ({ kind: 'measure-count', group: g, contents: t });
  const hi = countNumbers([m('Doors', 'Doors #1'), m('Doors', 'Doors #3'), m('Win', 'Win #2'), m('Win', 'renamed')]);
  assert.equal(hi.get('Doors'), 3);
  assert.equal(hi.get('Win'), 2);
  assert.equal(countNumbers([m('X', 'a'), m('X', 'b'), m('X', 'c')]).get('X'), 3, 'renamed marks still count');
});
