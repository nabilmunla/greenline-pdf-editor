// PLAN 10.19: MuPDF.js 1.28.1 kept every PDF object it wrapped twice and let go of it once, so
// nothing a wrapper ever touched was freed. src/engine/mupdf-refs.ts fixes its two helpers: one
// wrapper = one reference. Counts are read from MuPDF's memory (refsOf: the object's `short refs`).
// Generated files only.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { VFile } from '../src/engine/files';
import { guardMupdf, mupdfErrors } from '../src/engine/mupdf-guard';
import { refsFixed, refsOf, refsNote, setRefsFixForTests, fixMupdfRefs } from '../src/engine/mupdf-refs';
// @ts-expect-error (a plain .mjs generator)
import { makeLinkSet } from './gen/linkset.mjs';

guardMupdf(mupdf);
v8.setFlagsFromString('--expose-gc');
const gcNow: () => void = vm.runInNewContext('gc');
/** the collector, then a moment for its finalizers (they run as tasks of their own) */
async function collect() { for (let i = 0; i < 3; i++) { gcNow(); await new Promise((r) => setTimeout(r, 0)); } }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
const MB = 2 ** 20;
type O = mupdf.PDFObject;
const ptr = (o: unknown) => (o as { pointer: number }).pointer;
const mem = () => (globalThis as unknown as { $libmupdf_wasm_Module: { HEAPU8: Uint8Array } }).$libmupdf_wasm_Module.HEAPU8;
/** both ways round: with the fix (as built) and without (MuPDF.js as it came) */
async function bothWays<T>(f: (fix: boolean) => T | Promise<T>): Promise<[T, T]> {
  try {
    setRefsFixForTests(true); const on = await f(true);
    setRefsFixForTests(false); const off = await f(false);
    return [on, off];
  } finally { setRefsFixForTests(true); }
}

test('10.19: 200,000 new dictionaries let go of - MuPDF\'s memory does not grow (it grew with every one)', async () => {
  // (first in this file: MuPDF's memory only grows, and freed room inside it would hide a leak)
  assert.equal(refsFixed(), true, 'the fix is in: ' + refsNote());
  const doc = new mupdf.PDFDocument();
  const [on, off] = await bothWays(() => {
    const h0 = mu.heap();
    for (let i = 0; i < 200000; i++) doc.newDictionary().destroy();
    return mu.heap() - h0;
  });
  console.log(`   200,000 x newDictionary + destroy: MuPDF grew ${(on / MB).toFixed(2)} MB with the fix, ${(off / MB).toFixed(2)} MB without`);
  assert.ok(on < MB, `under 1 MB with the fix (${(on / MB).toFixed(2)} MB)`);
  doc.destroy();
});

test('10.19: the reference count is pdf_obj\'s first field - N wrappers move it by N (by 2N without the fix), nothing else moves', async () => {
  const doc = new mupdf.PDFDocument();
  const ind = doc.addObject(doc.newDictionary());
  const first = ind.resolve();
  const p = ptr(first);
  const fields = () => { const v = new DataView(mem().buffer); return [0, 2, 4, 6, 8, 10, 12, 14].map((k) => v.getInt16(p + k, true)); };
  await bothWays((fix) => {
    for (const n of [1, 5, 37]) {
      const f0 = fields();
      const ws = [...Array(n)].map(() => ind.resolve());
      const f1 = fields();
      assert.deepEqual(f1.map((v, k) => v - f0[k]), [fix ? n : 2 * n, 0, 0, 0, 0, 0, 0, 0], `${n} wrappers, fix ${fix}`);
      assert.equal(refsOf(ws[0]), f1[0], 'refsOf reads that field');
      ws.forEach((w) => w.destroy());
      // (without the fix each wrapper leaves one reference behind)
      assert.equal(fields()[0] - f0[0], fix ? 0 : n);
    }
  });
  assert.equal(String.fromCharCode(mem()[p + 2]), 'd', 'and the kind byte after it says dictionary');
  assert.equal(refsOf(doc.newBoolean(true)), -1, 'true is not memory');
  assert.equal(refsOf(doc.newName('Type')), -1, 'nor a built-in name');
  assert.equal(refsOf(mupdf.PDFObject.Null), -1);
  first.destroy(); ind.destroy(); doc.destroy();
});

/** MuPDF.js's lines that make wrappers: by the constructor, through each helper */
function wrapperLines() {
  const src = fs.readFileSync(path.join(process.cwd(), 'node_modules', 'mupdf', 'dist', 'mupdf.js'), 'utf8').split('\n');
  const at = (re: RegExp) => src.map((l, i) => (re.test(l) ? i + 1 : 0)).filter(Boolean);
  return { ctor: at(/new PDFObject\(/), owned: at(/\._fromPDFObjectNew\(/), borrowed: at(/\._fromPDFObjectKeep\(/) };
}
const OWNED = [1876, 1879, 1880, 1881, 1882, 1883, 1892, 1898, 1899, 1900, 1909, 1912, 1915, 1922, 1933, 1939, 1943, 1947, 1964, 1984, 2457];
const BORROWED = [1955, 2210, 2330, 2353, 2357, 2358, 2410, 2411, 2474, 2824];

test('10.19: MuPDF.js is the one the fix was made for - the same 4 + 31 places make wrappers', () => {
  const w = wrapperLines();
  assert.deepEqual(w.ctor, [1814, 1820, 1872, 2448]);
  assert.deepEqual(w.owned, OWNED);
  assert.deepEqual(w.borrowed, BORROWED);
});

/** a generated file: two pages, text in a font, an image, a square, a file attachment with its embedded file */
function generated() {
  const doc = new mupdf.PDFDocument();
  const font = new mupdf.Font('Times-Roman');
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
  pix.clear(128);
  const image = new mupdf.Image(pix);
  const f1 = doc.addSimpleFont(font);
  const im = doc.addImage(image);
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: f1 }, XObject: { Im1: im } }, 'BT /F1 12 Tf 72 720 Td (Sheet 1) Tj ET q 100 0 0 100 72 500 cm /Im1 Do Q'));
  doc.insertPage(-1, doc.addPage([0, 0, 842, 595], 0, {}, '0 0 1 RG 60 60 200 200 re S'));
  const p0 = doc.loadPage(0) as mupdf.PDFPage;
  const sq = p0.createAnnotation('Square'); sq.setRect([100, 100, 200, 160]); sq.update();
  const ef = doc.addEmbeddedFile('notes.txt', 'text/plain', new TextEncoder().encode('sheet notes'), new Date(2026, 0, 1), new Date(2026, 0, 2));
  const fa = p0.createAnnotation('FileAttachment'); fa.setRect([300, 300, 320, 320]); fa.setFileSpec(ef); fa.update();
  const other = new mupdf.PDFDocument();
  const oleaf = other.newString('from the other file');
  const odict = other.addObject({ Kind: other.newName('ZzOther'), N: 7, Arr: [1, 2, other.newString('x')] });
  const holder = doc.addObject({ ZzKey: { A: 1, B: [doc.newString('in the holder')] }, Arr: [1, 2, 3] });
  doc.getTrailer().get('Root').put('ZzHolder', holder);
  return { doc, font, image, p0, sq, fa, other, oleaf, odict, holder };
}
/** a dictionary key's own wrapper, as forEach makes it (2410): caught on its way through the helper */
function forEachKey(doc: mupdf.PDFDocument, dict: O, want: string): O {
  const d = doc as unknown as { _fromPDFObjectKeep(p: number): O };
  const was = Object.getPrototypeOf(d)._fromPDFObjectKeep as (p: number) => O;
  let got: O | null = null, n = 0;
  d._fromPDFObjectKeep = function (p: number) { const w = was.call(this, p); if (n++ % 2 === 0 && !got && w.isName() && w.asName() === want) got = w; return w; };
  try { dict.forEach(() => { /* (the keys go through the helper) */ }); } finally { delete (d as { _fromPDFObjectKeep?: unknown })._fromPDFObjectKeep; }
  assert.ok(got, 'forEach made a wrapper of the key');
  return got!;
}

test('10.19: each of the 31 places and getTrailer - one wrapper holds one reference (two without the fix), N hold N, all let go of: as before, intact', async () => {
  const G = generated();
  const { doc } = G;
  // [name, MuPDF.js line, make a wrapper, how the object is reached again]. "owned": the C call
  // made or kept it for us; "same": calling again gives the same object (a cache, or an object
  // that already was), so what one more wrapper adds can be counted; "fresh": a new object each
  // time - nothing else holds it, so its count with one wrapper is 0 + 1
  const owned: [string, number, () => O, 'fresh' | 'same'][] = [
    ['createObject', 1876, () => doc.createObject(), 'fresh'],
    ['newInteger', 1880, () => doc.newInteger(12345), 'fresh'],
    ['newReal', 1881, () => doc.newReal(1.5), 'fresh'],
    ['newName', 1882, () => doc.newName('ZzSheetKey'), 'fresh'],
    ['newString', 1883, () => doc.newString('Sheet A-101'), 'fresh'],
    ['newByteString', 1892, () => doc.newByteString(new Uint8Array([1, 2, 3])), 'fresh'],
    ['newIndirect', 1898, () => doc.newIndirect(1), 'fresh'],
    ['newArray', 1899, () => doc.newArray(), 'fresh'],
    ['newDictionary', 1900, () => doc.newDictionary(), 'fresh'],
    ['addObject', 1909, () => doc.addObject(doc.newDictionary()), 'fresh'],
    ['addObject of a reference', 1909, () => doc.addObject(G.holder), 'same'],
    ['addStream', 1912, () => doc.addStream('0 0 m 1 1 l S', {}), 'fresh'],
    ['addRawStream', 1915, () => doc.addRawStream('0 0 m 1 1 l S', {}), 'fresh'],
    ['graftObject of a dictionary', 1922, () => doc.graftObject(G.odict.resolve()), 'fresh'],
    ['graftObject of a reference', 1922, () => doc.graftObject(G.odict), 'fresh'],
    ['graftObject of a string', 1922, () => doc.graftObject(G.oleaf), 'same'],
    ['addSimpleFont', 1933, () => doc.addSimpleFont(G.font), 'same'],
    ['addCJKFont', 1939, () => doc.addCJKFont(G.font, 'zh-Hans'), 'same'],
    ['addFont', 1943, () => doc.addFont(G.font), 'same'],
    ['addImage', 1947, () => doc.addImage(G.image), 'same'],
    ['addPage', 1964, () => doc.addPage([0, 0, 100, 100], 0, {}, ''), 'fresh'],
    ['addEmbeddedFile', 1984, () => doc.addEmbeddedFile('a.txt', 'text/plain', new TextEncoder().encode('x'), new Date(2026, 0, 1), new Date(2026, 0, 1)), 'fresh'],
    ['PDFGraftMap.graftObject of a reference', 2457, () => doc.newGraftMap().graftObject(G.odict), 'fresh'],
    ['PDFGraftMap.graftObject of a string', 2457, () => doc.newGraftMap().graftObject(G.oleaf), 'same'],
  ];
  const holderDict = G.holder.resolve();
  const borrowed: [string, number, () => O][] = [
    ['findPage', 1955, () => doc.findPage(0)],
    ['PDFPage.getObject', 2210, () => G.p0.getObject()],
    ['resolve', 2330, () => G.holder.resolve()],
    ['get', 2353, () => G.holder.get('ZzKey')],
    ['getInheritable (a name object)', 2357, () => doc.findPage(0).getInheritable(doc.newName('MediaBox'))],
    ['getInheritable (a key)', 2358, () => doc.findPage(0).getInheritable('MediaBox')],
    ['forEach key', 2410, () => forEachKey(doc, holderDict, 'ZzKey')],
    ['forEach value', 2411, () => { let v: O | null = null; holderDict.forEach((x, k) => { if (k === 'ZzKey') v = x; }); return v!; }],
    ['PDFAnnotation.getObject', 2474, () => G.sq.getObject()],
    ['getFileSpec', 2824, () => G.fa.getFileSpec()],
  ];
  const trailer: [string, number, () => O] = ['getTrailer', 1872, () => doc.getTrailer()];
  // newBoolean (1879) gives MuPDF's own true: no memory, nothing to count
  assert.equal(refsOf(doc.newBoolean(true)), -1);
  // (every one of the 31 places is measured below; addObject and the two graftObjects more than one way)
  assert.deepEqual([...new Set([...owned.map((o) => o[1]), 1879])].sort(), [...OWNED].sort(), 'every owned place');
  assert.deepEqual(borrowed.map((o) => o[1]), BORROWED, 'every borrowed place');
  await bothWays((fix) => {
    const per = fix ? 1 : 2;
    for (const [name, line, make, how] of owned) {
      const a = make();
      if (how === 'fresh') { assert.equal(refsOf(a), per, `${name} (${line}): count with one wrapper, fix ${fix}`); continue; }
      const c1 = refsOf(a);
      const more = [...Array(4)].map(() => make());
      assert.ok(more.every((m) => ptr(m) === ptr(a)), `${name}: the same object again`);
      assert.equal(refsOf(a) - c1, 4 * per, `${name} (${line}): 4 wrappers more, fix ${fix}`);
      more.forEach((m) => m.destroy());
      assert.equal(refsOf(a), c1 + (fix ? 0 : 4), `${name}: let go of - as before (without the fix: one each left)`);
    }
    for (const [name, line, make] of [...borrowed, trailer]) {
      const k = name === 'getTrailer' ? 1 : per;
      const a = make();
      const c1 = refsOf(a);
      const more = [...Array(5)].map(() => make());
      assert.ok(more.every((m) => ptr(m) === ptr(a)), `${name}: the same object again`);
      assert.equal(refsOf(a) - c1, 5 * k, `${name} (${line}): 5 wrappers more, fix ${fix}`);
      more.forEach((m) => m.destroy());
      assert.equal(refsOf(a), c1 + (fix || name === 'getTrailer' ? 0 : 5), `${name}: let go of - as before`);
      a.destroy();
    }
  });
  // with the fix, every object let go of and collected: what the file holds is intact, read again
  // through its parent - and what each borrowed place gives is held by its parent once more than before
  const js = (o: O) => JSON.stringify(o.asJS({}));
  // (wrappers left to the collector so far are gone first: their references with them)
  await collect();
  const before = borrowed.map(([, , make]) => { const w = make(); const r = [refsOf(w), js(w)] as const; w.destroy(); return r; });
  // (fresh objects put in a parent first: the parent's reference is then the only one)
  const parent = doc.addObject({});
  const parentDict = parent.resolve();
  const putIn: string[] = [];
  for (const [name, , make] of owned) { const w = make(); parentDict.put('K' + putIn.length, w); putIn.push(js(w)); w.destroy(); }
  parentDict.destroy();
  await collect();
  borrowed.forEach(([name, , make], i) => { const w = make(); assert.deepEqual([refsOf(w), js(w)], before[i], `${name}: intact, held as before`); w.destroy(); });
  const back = parent.resolve();
  putIn.forEach((j, i) => {
    const w = back.get('K' + i);
    assert.equal(js(w), j, `${owned[i][0]}: intact through its parent`);
    // (the parent, and this wrapper; more where something else holds it too - a cache, the file)
    assert.ok(refsOf(w) === -1 || refsOf(w) >= 2, `${owned[i][0]}: still held by its parent (${refsOf(w)})`);
    if (owned[i][3] === 'fresh' && !w.isIndirect()) assert.equal(refsOf(w), 2, `${owned[i][0]}: the parent and this wrapper only`);
    w.destroy();
  });
  // and the file saves and reads back the same
  const saved = doc.saveToBuffer('').asUint8Array().slice();
  const again = mupdf.Document.openDocument(saved, 'application/pdf').asPDF()!;
  assert.equal(again.countPages(), 2);
  assert.equal(JSON.stringify(again.newIndirect(parent.asIndirect()).resolve().asJS()), JSON.stringify(back.asJS()));
  again.destroy();
  back.destroy(); parent.destroy();
});

test('10.19: setters - a dictionary and an array filled every way, every wrapper let go of and collected: every child held, the file reads back the same', async () => {
  const before = mupdfErrors();
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, {}, ''));
  const root = doc.getTrailer().get('Root');
  const dict = doc.addObject(doc.newDictionary());
  const arr = doc.addObject(doc.newArray());
  root.put('ZzDict', dict); root.put('ZzArr', arr);
  const d = dict.resolve(), a = arr.resolve();
  const target = doc.addObject({ Is: 'Target', N: 3 });
  // numbers, strings, names, wrapped direct objects, indirect references, JS values made into objects
  const values: [string, () => unknown][] = [
    ['int', () => 42], ['real', () => 2.5], ['name', () => 'ZzName'], ['string', () => '(a string)'],
    ['obj int', () => doc.newInteger(7)], ['obj string', () => doc.newString('wrapped')], ['obj name', () => doc.newName('ZzWrapped')],
    ['dict', () => doc.newDictionary()], ['array', () => doc.newArray()], ['js dict', () => ({ A: 1, B: [doc.newString('deep')] })], ['js array', () => [1, doc.newDictionary(), target]],
    ['indirect', () => target], ['new indirect', () => doc.addObject({ Fresh: true })], ['byte string', () => doc.newByteString(new Uint8Array([0, 255]))],
  ];
  values.forEach(([k, v], i) => {
    d.put('S' + i, v());                              // dict, by a key
    d.put(doc.newName('N' + i), v());                 // dict, by a name object
    a.push(v());                                      // array, at the end
    a.push(null); a.put(a.length - 1, v());           // array, at an index
    void k;
  });
  d.put('Gone', doc.newDictionary()); d.delete('Gone'); d.put('Gone2', 1); d.delete(doc.newName('Gone2'));
  a.push(5); a.delete(a.length - 1);
  // writeObject, writeStream, writeRawStream; addStream with its dictionary; insertPage of an added page with resources
  const w1 = doc.addObject({}); w1.writeObject({ Written: doc.newString('over'), Ref: target }); d.put('W1', w1);
  const s1 = doc.addStream('0 0 m 10 10 l S', { ZzS: 1 }); s1.writeStream('1 1 m 20 20 l S'); d.put('S1', s1);
  const s2 = doc.addRawStream('2 2 m 3 3 l S', { ZzR: doc.newDictionary() }); s2.writeRawStream('4 4 m 5 5 l S'); d.put('S2', s2);
  doc.insertPage(-1, doc.addPage([0, 0, 100, 100], 0, { ExtGState: { G: { CA: 0.5 } } }, 'q /G gs Q'));
  // markups: a file spec, an appearance with resources
  const pg = doc.loadPage(1) as mupdf.PDFPage;
  const fa = pg.createAnnotation('FileAttachment'); fa.setRect([10, 10, 20, 20]);
  fa.setFileSpec(doc.addEmbeddedFile('x.txt', 'text/plain', new TextEncoder().encode('x'), new Date(2026, 0, 1), new Date(2026, 0, 1)));
  const st = pg.createAnnotation('Square'); st.setRect([30, 30, 60, 60]);
  st.setAppearance(null, null, [1, 0, 0, 1, 0, 0], [0, 0, 30, 30], { ExtGState: { H: { ca: 0.3 } } }, 'q /H gs 0 0 30 30 re f Q');
  const want = { d: JSON.stringify(d.asJS()), a: JSON.stringify(a.asJS()), w1: JSON.stringify(w1.resolve().asJS()), s1: s1.readStream().asString(), s2: s2.readRawStream().asString() };
  const nums = { dict: dict.asIndirect(), arr: arr.asIndirect(), w1: w1.asIndirect(), s1: s1.asIndirect(), s2: s2.asIndirect() };
  // every wrapper let go of, then the collector: what the containers hold must still be there
  for (const x of [d, a, root, target, w1, s1, s2]) x.destroy();
  fa.destroy(); st.destroy(); pg.destroy();
  await collect();
  const d2 = dict.resolve(), a2 = arr.resolve();
  const low: string[] = [];
  d2.forEach((v, k) => { const r = refsOf(v); if (r !== -1 && r < 2) low.push('dict ' + k + ': ' + r); });
  a2.forEach((v, i) => { const r = refsOf(v); if (r !== -1 && r < 2) low.push('array ' + i + ': ' + r); });
  assert.deepEqual(low, [], 'every child held by its container (and the wrapper reading it)');
  assert.equal(JSON.stringify(d2.asJS()), want.d);
  assert.equal(JSON.stringify(a2.asJS()), want.a);
  const saved = doc.saveToBuffer('').asUint8Array().slice();
  const r = mupdf.Document.openDocument(saved, 'application/pdf').asPDF()!;
  const R = (n: number) => r.newIndirect(n);
  assert.equal(JSON.stringify(R(nums.dict).resolve().asJS()).length, want.d.length, 'the dictionary read back');
  assert.equal(JSON.stringify(R(nums.arr).resolve().asJS()).length, want.a.length, 'the array read back');
  assert.equal(JSON.stringify(R(nums.w1).resolve().asJS()), want.w1);
  assert.equal(R(nums.s1).readStream().asString(), want.s1);
  assert.equal(R(nums.s2).readRawStream().asString(), want.s2);
  assert.equal(r.countPages(), 2);
  const annots = (r.loadPage(1) as mupdf.PDFPage).getAnnotations();
  assert.deepEqual(annots.map((x) => x.getType()), ['FileAttachment', 'Square']);
  assert.equal(r.getFilespecParams(annots[0].getFileSpec()).filename, 'x.txt');
  r.destroy();
  for (const x of [dict, arr, d2, a2]) x.destroy();
  doc.destroy();
  assert.equal(mupdfErrors() - before, 0, 'no MuPDF errors');
});

test('10.19: wrappers that outlive their document - let go of after it, collected, then a new file opened, edited and saved', async () => {
  const before = mupdfErrors();
  const src = generated();
  const doc = src.doc;
  const saved0 = doc.saveToBuffer('').asUint8Array().slice();
  // wrappers of every kind, made every way; the page and markup objects let go of (they hold the document)
  const keep: O[] = [
    doc.getTrailer(), doc.getTrailer().get('Root'), doc.findPage(0), doc.findPage(0).resolve(), src.p0.getObject(), src.sq.getObject(), src.fa.getFileSpec(),
    doc.newDictionary(), doc.newArray(), doc.newString('s'), doc.newName('ZzKept'), doc.newInteger(9), doc.newReal(0.5), doc.newByteString(new Uint8Array([7])),
    doc.newIndirect(2), doc.createObject(), doc.addObject({ K: [1, doc.newDictionary()] }), doc.addStream('x', {}), doc.graftObject(src.odict), doc.newGraftMap().graftObject(src.odict.resolve()),
    doc.addSimpleFont(src.font), doc.addImage(src.image), src.holder, src.holder.resolve(), src.holder.get('ZzKey', 'B'),
  ];
  const filled = doc.newDictionary(); filled.put('Kids', keep.slice(7, 14)); keep.push(filled);
  src.sq.destroy(); src.fa.destroy(); src.p0.destroy();
  doc.destroy();
  for (const w of keep) w.destroy();
  await collect();
  src.other.destroy(); src.oleaf.destroy(); src.odict.destroy();
  await collect();
  // a new file: opened, edited, saved, opened again
  mu.open('after', saved0);
  mu.createAnnot('after', 0, { type: 'Square', rect: [10, 10, 60, 60], color: [1, 0, 0] });
  mu.createAnnot('after', 1, { type: 'Text', rect: [50, 50, 70, 70], contents: 'after the other file' });
  const out = mu.save('after');
  mu.close('after');
  const r = mupdf.Document.openDocument(out, 'application/pdf').asPDF()!;
  assert.equal(r.countPages(), 2);
  assert.equal((r.loadPage(1) as mupdf.PDFPage).getAnnotations()[0].getContents(), 'after the other file');
  r.destroy();
  assert.equal(mupdfErrors() - before, 0, 'no MuPDF errors');
});

/** a file's objects, each as text (streams: their bytes too); dates set aside */
function objectsOf(b: Uint8Array): string[] {
  const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  const out: string[] = [];
  try {
    for (let i = 1; i < d.countObjects(); i++) {
      const r = d.newIndirect(i);
      const o = r.resolve();
      let s = o.toString();
      // (the objects an object stream holds are compared one by one: its packed bytes, and so its
      // length, change with the dates in them)
      const type = o.isDictionary() ? o.get('Type') : null;
      if (type?.isName() && /^(ObjStm|XRef)$/.test(type.asName())) s = type.asName();
      else if (r.isStream()) s += ' stream:' + Buffer.from(r.readRawStream().asUint8Array()).toString('base64');
      out.push(s.replace(/\(D:[^)]*\)/g, '(D:)').replace(/<D:[0-9A-Fa-f]*>/g, '<D:>'));
      r.destroy();
    }
  } finally { d.destroy(); }
  return out;
}
const sameObjects = (a: string[], b: string[], what: string) => {
  assert.equal(a.length, b.length, `${what}: as many objects`);
  const diff = a.map((x, i) => (x === b[i] ? -1 : i + 1)).filter((i) => i > 0);
  assert.deepEqual(diff, [], `${what}: every object the same${diff.length ? ` (${diff[0]}: ${a[diff[0] - 1].slice(0, 300)} | ${b[diff[0] - 1].slice(0, 300)})` : ''}`);
};

test('10.19: the journal - add, undo, redo, undo a markup with the collector between each: the file as before the add, by object', async () => {
  const before = mupdfErrors();
  const G = generated();
  const bytes = G.doc.saveToBuffer('').asUint8Array().slice();
  G.doc.destroy();
  mu.open('j', bytes);
  const at0 = objectsOf(mu.save('j'));
  mu.createAnnot('j', 0, { type: 'Square', rect: [10, 10, 60, 60], color: [1, 0, 0], contents: 'journal' });
  mu.createAnnot('j', 1, { type: 'Ink', ink: [[[10, 10], [30, 50], [70, 20]]], color: [0, 0, 1] });
  await collect();
  const added = objectsOf(mu.save('j'));
  for (const step of ['undo', 'undo', 'redo', 'redo', 'undo', 'undo'] as const) {
    assert.equal(mu[step]('j').ok, true, step);
    await collect();
  }
  const back = objectsOf(mu.save('j'));
  // (undone objects stay in the xref as free slots: what was there is compared)
  sameObjects(back.slice(0, at0.length), at0, 'after the undos');
  assert.ok(back.slice(at0.length).every((s) => s === 'null'), 'what the markups added is gone');
  for (const step of ['redo', 'redo'] as const) { assert.equal(mu[step]('j').ok, true); await collect(); }
  sameObjects(objectsOf(mu.save('j')), added, 'redone');
  mu.close('j');
  assert.equal(mupdfErrors() - before, 0, 'no MuPDF errors');
});

test('10.19: Combine, Extract, Insert and 200 edits give the same file, object by object, with the fix on and off', async () => {
  const set = path.join(scratch, 'links-24.pdf');
  makeLinkSet(set, 24, 30);
  const G = generated();
  const rich = G.doc.saveToBuffer('').asUint8Array().slice();
  G.doc.destroy();
  const before = mupdfErrors();
  const [on, off] = await bothWays(async () => {
    // Combine (the batch engine's stepped merge, a moment and the collector between the steps)
    const st = mu.mergeStart();
    const parts: Uint8Array[] = [];
    let size = 0;
    const spill = (raw: Uint8Array) => { parts.push(raw.slice()); const at = size; size += raw.length; return at; };
    let combined: Uint8Array;
    try {
      for (const [name, src] of [['links', new VFile({ path: set })], ['rich', rich]] as const) {
        const it = mu.mergeFileSteps(st, name, src, spill);
        for (let r = it.next(); !r.done; r = it.next()) await collect();
      }
      const all = Buffer.concat(parts);
      const out: Uint8Array[] = [];
      mu.mergeWrite(st, true, (b) => out.push(typeof b === 'string' ? Buffer.from(b, 'latin1') : b), (o, l) => out.push(all.subarray(o, o + l)));
      combined = new Uint8Array(Buffer.concat(out));
    } finally { mu.mergeDrop(st); }
    // Extract, Insert
    mu.open('x', new VFile({ path: set }));
    const extracted = mu.extract('x', [3, 0, 7, 7, 23]);
    mu.close('x');
    await collect();
    mu.open('i', rich);
    mu.insertFrom('i', 1, new VFile({ path: set }), [0, 5, 6]);
    await collect();
    const inserted = mu.save('i', { incremental: false });
    mu.close('i');
    // 200 edits: markups made, changed, moved, deleted, pages turned, added, taken out, undone, redone
    mu.open('e', rich);
    const made: { page: number; id: number }[] = [];
    const types = ['Square', 'Circle', 'Text', 'FreeText', 'Ink', 'Line', 'Highlight'] as const;
    for (let i = 0; i < 200; i++) {
      const page = i % 2;
      const k = i % 10;
      if (k < 4 || !made.length) {
        const type = types[i % types.length];
        const x = 20 + (i * 7) % 400, y = 20 + (i * 13) % 600;
        const spec: Record<string, unknown> = { type, rect: [x, y, x + 40, y + 30], color: [i % 2, 0, 1 - (i % 2)], contents: 'edit ' + i };
        if (type === 'Ink') spec.ink = [[[x, y], [x + 20, y + 25], [x + 40, y]]];
        if (type === 'Line') spec.line = [[x, y], [x + 40, y + 30]];
        if (type === 'Highlight') spec.quads = [[x, y, x + 40, y, x, y + 12, x + 40, y + 12]];
        if (type === 'FreeText') spec.font = { size: 10, color: [0, 0, 0] };
        const a = mu.createAnnot('e', page, spec as never);
        made.push({ page, id: a.id });
      } else if (k === 4) mu.updateAnnots('e', [{ ...made[i % made.length], patch: { color: [0, 1, 0], contents: 'changed ' + i } }]);
      else if (k === 5) mu.moveAnnots('e', [made[(i * 3) % made.length]], 5, -3);
      else if (k === 6) { const [g] = made.splice(i % made.length, 1); mu.deleteAnnots('e', [g]); }
      else if (k === 7) mu.rotatePages('e', [page], 90);
      else if (k === 8) { if (i % 20 === 8) { mu.insertBlank('e', 2, 300, 300); mu.deletePages('e', [2]); } else { mu.undo('e'); mu.redo('e'); } }
      else mu.updateAnnots('e', [{ ...made[(i * 7) % made.length], patch: { opacity: 0.5 } }]);
      if (i % 20 === 19) await collect();
    }
    const edited = mu.save('e', { incremental: false });
    mu.close('e');
    await collect();
    return { combined: objectsOf(combined), extracted: objectsOf(extracted), inserted: objectsOf(inserted), edited: objectsOf(edited) };
  });
  for (const k of ['combined', 'extracted', 'inserted', 'edited'] as const) sameObjects(on[k], off[k], k);
  console.log(`   objects: combined ${on.combined.length}, extracted ${on.extracted.length}, inserted ${on.inserted.length}, edited ${on.edited.length}`);
  assert.equal(mupdfErrors() - before, 0, 'no MuPDF errors');
});

test('10.19: not 1.28.1\'s text (a doctored helper) - nothing patched, refsFixed() false, and the log says why', async () => {
  // a fresh copy of the module would be another MuPDF.js; here the text check is run on a doctored
  // stand-in with this module's own classes
  const P = mupdf.PDFObject;
  class Doc { _fromPDFObjectNew(ptr: number) { return ptr === 0 ? P.Null : new (P as never as new (d: unknown, p: number) => O)(this, ptr); } _fromPDFObjectKeep(ptr: number) { return this._fromPDFObjectNew(ptr); } }
  const stand = { PDFObject: P, PDFDocument: Doc } as unknown as typeof mupdf;
  // (fixMupdfRefs answers once per process: its check is reached through a fresh copy of the file)
  const copy = path.join(scratch, 'mupdf-refs-copy.ts');
  fs.copyFileSync('src/engine/mupdf-refs.ts', copy);
  const fresh = await import(pathToFileURL(copy).href) as typeof import('../src/engine/mupdf-refs');
  const r = fresh.fixMupdfRefs(stand);
  assert.equal(r.fixed, false);
  assert.match(r.note, /differently from 1\.28\.1/);
  assert.equal(fresh.refsFixed(), false);
  assert.equal(fresh.setRefsFixForTests(true), false, 'and the setter cannot switch it on');
  assert.equal(Doc.prototype._fromPDFObjectNew.toString().includes('_drop'), false, 'its helpers left as they were');
  // the real one: in, and the setter switches it off and on
  assert.equal(fixMupdfRefs(mupdf).fixed, true);
  assert.equal(setRefsFixForTests(false), false);
  const d = new mupdf.PDFDocument();
  assert.equal(refsOf(d.newDictionary()), 2, 'off: as MuPDF.js came');
  assert.equal(setRefsFixForTests(true), true);
  assert.equal(refsOf(d.newDictionary()), 1);
  d.destroy();
});
