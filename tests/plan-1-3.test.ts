// PLAN 1.3 (AUDIT B3, B11 in mu.ts): MuPDF memory is not seen by the garbage collector, so every
// document, page, graft map it makes must be destroyed by hand. Each fixed path is repeated 200
// times with nothing collected (no await) and the objects still alive are counted: a Userdata
// method that makes an object is wrapped to remember what it returns, Userdata.destroy to forget
// it. The MuPDF wasm heap is read too (WebAssembly.instantiate is wrapped before MuPDF loads) and
// must grow by under 10 MB.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let mem: WebAssembly.Memory | null = null;
const origInst = WebAssembly.instantiate.bind(WebAssembly) as (...a: unknown[]) => Promise<unknown>;
(WebAssembly as unknown as { instantiate: unknown }).instantiate = async (...a: unknown[]) => {
  const r = await origInst(...a);
  const ex = ((r as { instance?: WebAssembly.Instance }).instance ?? (r as WebAssembly.Instance)).exports as Record<string, unknown>;
  if (!mem && !('hb_buffer_create' in ex)) for (const v of Object.values(ex)) if (v instanceof WebAssembly.Memory) mem = v;
  return r;
};
const mupdf = await import('mupdf');
const mu = await import('../src/engine/mu');
mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));

const Userdata = Object.getPrototypeOf(mupdf.Buffer.prototype) as { destroy(this: object): void };
const gone = new Set<object>();
const realDestroy = Userdata.destroy;
Userdata.destroy = function (this: object) { gone.add(this); return realDestroy.call(this); };
type Fn = (this: unknown, ...a: unknown[]) => unknown;
/** remember every object `owner[name]` returns (found up the prototype chain) */
function watch(owner: object, name: string): Set<object> {
  const made = new Set<object>();
  let o: Record<string, unknown> | null = owner as Record<string, unknown>;
  while (o && !Object.prototype.hasOwnProperty.call(o, name)) o = Object.getPrototypeOf(o);
  const orig = o![name] as Fn;
  o![name] = function (this: unknown, ...a: unknown[]) { const r = orig.apply(this, a); if (r && typeof r === 'object') made.add(r as object); return r; };
  return made;
}
const alive = (made: Set<object>) => [...made].filter((x) => !gone.has(x)).length;
const MB = 1048576;
/** run `f` 200 times; the heap growth in bytes */
function repeat(f: () => void): number {
  f();                                           // warm up (first allocations)
  const before = mem!.buffer.byteLength;
  for (let i = 0; i < 200; i++) f();
  return mem!.buffer.byteLength - before;
}

/** a 3-page PDF, optionally encrypted */
function pdf(pages = 3, password?: string, extra?: (d: mupdf.PDFDocument, p: mupdf.PDFObject) => void): Uint8Array {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < pages; i++) {
    const p = d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, `BT /F1 20 Tf 100 700 Td (Page ${i + 1}) Tj ET`);
    d.insertPage(-1, p);
  }
  if (extra) extra(d, d.findPage(0));
  return d.saveToBuffer(password ? `encrypt=aes-256,user-password=${password},owner-password=${password}` : 'compress').asUint8Array().slice();
}

test('1.3 B3: a wrong password leaves no MuPDF document alive (openOther)', () => {
  assert.ok(mem, 'found the MuPDF wasm memory');
  const locked = pdf(3, 'secret');
  const docs = watch(mupdf.Document, 'openDocument');
  const grown = repeat(() => {
    // (compress is one of the users of openOther: insert, replace, merge, repair take the same path)
    assert.throws(() => mu.compress(locked, { dpi: 150, quality: 70 }, 'wrong'), /needs a password/);
    assert.throws(() => mu.compress(locked, { dpi: 150, quality: 70 }), /needs a password/);
  });
  console.log(`openOther: ${docs.size} documents opened, ${alive(docs)} alive, heap +${(grown / MB).toFixed(2)} MB`);
  assert.equal(alive(docs), 0, 'every document opened and rejected was destroyed');
  assert.ok(grown < 10 * MB, `heap grew ${grown}`);
});

test('1.3 B11: compress destroys every page it loads to measure the sheets', () => {
  const src = pdf(8);
  const pages = watch(mupdf.PDFDocument.prototype, 'loadPage');
  const grown = repeat(() => { mu.compress(src, { dpi: 150, quality: 70 }); });
  console.log(`compress: ${pages.size} pages loaded, ${alive(pages)} alive, heap +${(grown / MB).toFixed(2)} MB`);
  assert.equal(alive(pages), 0, 'no page left alive');
  assert.ok(grown < 10 * MB, `heap grew ${grown}`);
});

test('1.3 B11: printFile destroys its graft map', () => {
  mu.open('pf', pdf(2));
  const maps = watch(mupdf.PDFDocument.prototype, 'newGraftMap');
  const A4 = { w: 595.28, h: 841.89 };
  const grown = repeat(() => { mu.printFile('pf', { pages: [0, 1], paper: A4, orient: 'auto', scale: 'fit', margin: 14, markups: true }); });
  console.log(`printFile: ${maps.size} graft maps made, ${alive(maps)} alive, heap +${(grown / MB).toFixed(2)} MB`);
  assert.equal(alive(maps), 0, 'no graft map left alive');
  assert.ok(grown < 10 * MB, `heap grew ${grown}`);
});

test('1.3 B11: renderAnnots shows the markups again when the draw fails after hiding them', () => {
  mu.open('ra', pdf(1));
  mu.createAnnot('ra', 0, { type: 'Square', rect: [100, 100, 200, 200], color: [1, 0, 0], bw: 4 } as never);
  mu.createAnnot('ra', 0, { type: 'Highlight', rect: [100, 300, 300, 320], color: [1, 1, 0] } as never);
  const draw = () => mu.renderAnnots('ra', 0, 1, 0, 0, 400, 400, [], 'rest');
  assert.ok(draw(), 'the square draws before');
  // a tile too big for memory: the pixmap fails after the markups of the other pass (the square)
  // were hidden for editing - on the page object the engine keeps
  assert.throws(() => mu.renderAnnots('ra', 0, 1, 0, 0, 1 << 20, 1 << 20, [], 'hl'));
  assert.ok(draw(), 'the square still draws after the failed call (it stayed hidden before the fix)');
});
