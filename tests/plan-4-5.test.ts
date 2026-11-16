// PLAN 4.5 (mu.ts fitText): each pass of its loop made a MuPDF display list of the annotation and
// never destroyed it. Called directly 200 times: no display list may stay alive, and the wasm heap
// must grow by under 10 MB (the measuring as in 1.3: MuPDF memory is not seen by the garbage
// collector; every Userdata made is remembered and counted until its destroy()).
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

test('4.5: fitText destroys the display list of every pass (200 calls: none alive, heap +< 10 MB)', () => {
  assert.ok(mem, 'found the MuPDF wasm memory');
  // a FreeText box too small for its text: every call measures it, and grows it on the first
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  const a = (d.loadPage(0) as mupdf.PDFPage).createAnnotation('FreeText');
  a.setRect([100, 100, 130, 110]);
  a.setContents('A line of text that does not fit in the small box at all, so the box grows.');
  a.update();
  // (a plain FreeText is not a callout: fitText reads nothing from the open document but this)
  const o = { doc: d, pages: new Map() } as never;
  const lists = watch(mupdf.PDFAnnotation.prototype, 'toDisplayList');
  const grown = (() => {
    mu.fitText(o, a);                            // warm up (first allocations)
    const before = mem!.buffer.byteLength;
    for (let i = 0; i < 200; i++) mu.fitText(o, a);
    return mem!.buffer.byteLength - before;
  })();
  console.log(`fitText: ${lists.size} display lists made, ${alive(lists)} alive, heap +${(grown / MB).toFixed(2)} MB`);
  assert.ok(lists.size >= 200, 'the branch ran');
  assert.equal(alive(lists), 0, 'no display list left alive');
  assert.ok(grown < 10 * MB, `heap grew ${grown}`);
});
