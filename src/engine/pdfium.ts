// PDFium (the engine inside Chrome, as WebAssembly): fast drawing of page content,
// text positions for selecting / searching / tables, and links.
// No DOM in here so the tests can run it in Node.
//
// "Page space" everywhere: the page as shown (rotation and crop box applied),
// origin top-left, 1 unit = 1 PDF point. MuPDF uses the same space, so the two agree.
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
// (the package's JavaScript patched to use 4 GB: scripts/patch-pdfium.mjs)
import { init } from './vendor/pdfium-4gb.js';
import type { Reader } from './files';

let P: WrappedPdfiumModule | null = null;

/** the most the engine's memory may grow to: 4 GB less one 64 KB page (as Emscripten's own 4 GB builds) */
export const MEMORY_MAX = 65535 * 65536;

/** what the .wasm's memory may really grow to (a build that cannot be lifted stops at 2 GB) */
let memoryLimitNow = MEMORY_MAX;
export const memoryLimit = () => memoryLimitNow;

/**
 * The .wasm says its memory may grow to 2 GB (32768 pages); raised here to 65535 pages, in a
 * copy (the number is 3 bytes long either way: nothing else moves). Only that exact
 * declaration is changed: anything else (another build) is left as it is - and said so in the
 * log, with the limit it leaves the engine at (memoryLimit(); the host restarts the engine
 * before that: an engine that reaches it stops mid-call instead).
 */
export function liftMemoryMax(wasm: ArrayBuffer): ArrayBuffer {
  const b = new Uint8Array(wasm);
  const leb = (i: number): [number, number] => {
    let r = 0, k = 0;
    for (;;) { const x = b[i++]; r += (x & 0x7f) * 2 ** k; k += 7; if (x < 0x80 || k > 35) return [r, i]; }
  };
  // (what is left as it is: the limit is then taken as the 2 GB the stock build has, or as what the file says)
  const left = (why: string, limit = 32768 * 65536): ArrayBuffer => {
    memoryLimitNow = limit;
    console.error(`PDFium wasm left as it is (${why}): its memory stops at ${(limit / 2 ** 30).toFixed(2)} GB, not 4 GB`);
    return wasm;
  };
  if (b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) return left('not a wasm file');
  for (let i = 8; i < b.length;) {
    const id = b[i];
    const [size, at] = leb(i + 1);
    // the memory section: one memory, with a maximum, 32768 pages as 80 80 02
    if (id === 5) {
      const [count, j] = leb(at);
      if (count !== 1 || b[j] !== 1) return left('memory section is not one memory with a maximum');
      const [, k] = leb(j + 1);
      if (b[k] !== 0x80 || b[k + 1] !== 0x80 || b[k + 2] !== 0x02) {
        // (another build: one that already allows 4 GB is fine as it is)
        const [pages] = leb(k);
        if (pages >= 65535) { memoryLimitNow = MEMORY_MAX; return wasm; }
        return left('memory maximum is not 32768 pages', pages * 65536);
      }
      const out = b.slice();
      out.set([0xff, 0xff, 0x03], k);
      memoryLimitNow = MEMORY_MAX;
      return out.buffer;
    }
    i = at + size;
  }
  return left('no memory section');
}

export async function startPdfium(wasm: ArrayBuffer): Promise<void> {
  if (P) return;
  P = await init({ wasmBinary: liftMemoryMax(wasm) });
  P.PDFiumExt_Init();
}

function Q(): WrappedPdfiumModule {
  if (!P) throw new Error('PDF engine not started');
  return P;
}
const M = () => Q().pdfium as unknown as {
  HEAPU8: Uint8Array; HEAPF64: Float64Array; HEAP32: Int32Array;
  wasmExports: { malloc(n: number): number; free(p: number): void };
  UTF16ToString(p: number): string; stringToUTF16(s: string, p: number, n: number): void;
  getValue(p: number, t: string): number; setValue(p: number, v: number, t: string): void;
  addFunction(f: (...a: number[]) => number, sig: string): number;
};
// (addresses unsigned: past 2 GB they come back from the engine negative. 0 = no memory left:
// a file was then copied over address 0 - the engine's own data - and every later call failed
// "table index is out of bounds"; now it stops as out of memory (fatal: started afresh, and the
// window blames the page, as when PDFium itself runs out))
const malloc = (n: number) => {
  const p = M().wasmExports.malloc(n) >>> 0;
  if (!p && n > 0) throw new Error(`Aborted: the drawing engine is out of memory (${Math.round(n / 2 ** 20)} MB more needed)`);
  return p;
};
const free = (p: number) => M().wasmExports.free(p);

interface PageCache { ptr: number; text: number; aff: number[]; inv: number[]; w: number; h: number; chars?: CharInfo; heavy?: boolean; /** how much the engine's heap grew while the page was read in (PLAN 7.3) */ grew?: number; /** its pictures, decoded (bytes, estimated) */ pics?: number; /** big pictures, few objects: may be drawn in slabs (PLAN 3.5) */ slabby?: boolean; /** drawn in slabs: its second tile was slow (undefined: not known yet) */ slab?: boolean; /** tiles drawn on their own to find that out */ tried?: number }
export interface CharInfo { text: string; box: Float32Array }

interface Doc { mem: number; fa: number; slot: number; reader: Reader | null; doc: number; pages: Map<number, PageCache>; order: number[]; snaps: Map<number, SnapIndex> }
const docs = new Map<string, Doc>();

export interface OpenInfo { pages: { w: number; h: number }[] }

/** documents read on demand: PDFium asks for blocks, we read them from the file */
const readers = new Map<number, Reader>();
let slotSeq = 1;
let getBlockFn = 0;
function getBlock(): number {
  if (!getBlockFn) {
    getBlockFn = M().addFunction((param: number, pos: number, buf: number, len: number) => {
      const r = readers.get(param);
      if (!r) return 0;
      try { return r.read(M().HEAPU8, buf >>> 0, len, pos >>> 0) === len ? 1 : 0; } catch { return 0; }
    }, 'iiiii');
  }
  return getBlockFn;
}

/** open from bytes, or from a reader (the file stays on disk; PDFium reads what it needs) */
export function openDoc(id: string, src: Uint8Array | Reader, password = ''): OpenInfo {
  // (the wrapped functions take the password as a JS string - a pointer there aborted the engine;
  // the copy open so far is closed only once the new one opened: a failed reopen keeps drawing)
  const q = Q();
  let mem = 0, fa = 0, slot = 0;
  let doc = 0;
  const pw = password || '';
  if (src instanceof Uint8Array) {
    mem = malloc(src.length);
    M().HEAPU8.set(src, mem);
    doc = q.FPDF_LoadMemDocument(mem, src.length, pw);
  } else {
    if (src.size > 0xffffffff) throw new Error('Files over 4 GB are not supported');
    slot = slotSeq++;
    readers.set(slot, src);
    fa = malloc(12);
    M().setValue(fa, src.size | 0, 'i32');
    M().setValue(fa + 4, getBlock(), 'i32');
    M().setValue(fa + 8, slot, 'i32');
    doc = (q as unknown as { FPDF_LoadCustomDocument(fa: number, pw: string): number }).FPDF_LoadCustomDocument(fa, pw);
  }
  if (!doc) {
    const err = q.FPDF_GetLastError();
    if (mem) free(mem);
    if (fa) free(fa);
    if (slot) readers.delete(slot);
    throw new Error('PDFium could not open this file (error ' + err + ')');
  }
  const d: Doc = { mem, fa, slot, reader: src instanceof Uint8Array ? null : src, doc, pages: new Map(), order: [], snaps: new Map() };
  const pages: { w: number; h: number }[] = [];
  let sz = 0;
  try {
    sz = malloc(16);
    // (the document is registered only once every page is sized: a throw in here left it in `docs`
    // half made, and for good. Now what was taken for it is given back and the old copy stays open)
    const n = q.FPDF_GetPageCount(doc);
    for (let i = 0; i < n; i++) {
      // size of the page as shown: load lightly (cheap: PDFium parses content lazily)
      // (a page PDFium cannot size leaves the buffer as it was: the one before's size, or whatever
      // was in the memory - so the buffer is cleared first and the result checked; such a page gets
      // the default size rather than its neighbour's)
      M().HEAPU8.fill(0, sz, sz + 16);
      const ok = q.FPDF_GetPageSizeByIndexF(doc, i, sz);
      const f = new Float32Array(M().HEAPU8.buffer, sz, 2);
      pages.push(ok ? { w: f[0], h: f[1] } : { w: DEFAULT_PAGE.w, h: DEFAULT_PAGE.h });
    }
  } catch (e) {
    q.FPDF_CloseDocument(doc);
    if (mem) free(mem);
    if (fa) free(fa);
    if (slot) readers.delete(slot);
    throw e;
  } finally {
    if (sz) free(sz);
  }
  closeDoc(id);
  docs.set(id, d);
  return { pages };
}

/** the size given to a page PDFium cannot size (A4, in points) */
const DEFAULT_PAGE = { w: 595, h: 842 };

// (tests) the PDFium module itself, to stub a call in it
/** (tests, PLAN 7.5 spike) a page's PDFium handle, read in if needed */
export const pageForTests = (id: string, pg: number) => page(mustDoc(id), pg).ptr;
export const engineForTests = () => Q() as unknown as Record<string, unknown> & { pdfium: { wasmExports: { malloc(n: number): number; free(p: number): void } } };

/** closes the document and gives back everything it held, even if closing one page throws (the
 *  first failure is logged; nothing that comes after it is skipped) */
export function closeDoc(id: string): void {
  const d = docs.get(id);
  if (!d) return;
  const q = Q();
  const fails: unknown[] = [];
  const attempt = (f: () => void) => { try { f(); } catch (e) { fails.push(e); } };
  attempt(() => closeProgressive(d));
  for (const p of d.pages.values()) {
    if (p.text) attempt(() => q.FPDFText_ClosePage(p.text));
    attempt(() => q.FPDF_ClosePage(p.ptr));
  }
  for (let k = heavy.length - 1; k >= 0; k--) if (heavy[k].d === d) heavy.splice(k, 1);
  dropSlabs(d);
  attempt(() => dropSnaps(d));
  attempt(() => q.FPDF_CloseDocument(d.doc));
  if (d.mem) attempt(() => free(d.mem));
  if (d.fa) attempt(() => free(d.fa));
  if (d.slot) readers.delete(d.slot);
  if (d.reader) attempt(() => d.reader!.close());
  docs.delete(id);
  if (fails.length) console.error(`closing document ${id}: ${fails.length} step(s) failed, the rest was released:`, fails[0]);
}

export const openIds = () => [...docs.keys()];
/** engine memory in use (WebAssembly memory only grows) */
export const heapBytes = () => M().HEAPU8.buffer.byteLength;
/** (tests) take `n` bytes of the engine's memory until the returned function gives them back -
 *  so what comes after lands past 2 GB; and where the next allocation would land */
export function holdMemory(n: number): () => void { const p = malloc(n); return () => free(p); }
export function nextAddress(n = 16): number { const p = malloc(n); free(p); return p; }
/** (tests) take `top` bytes, then the gaps left below, until what comes next lands past `at` */
export function fillBelow(at: number, top: number): () => void {
  const gives: (() => void)[] = [];
  for (let got = 0; got < top; got += 2 ** 30) gives.push(holdMemory(Math.min(2 ** 30, top - got)));
  for (const n of [1 << 22, 1 << 18, 1 << 14, 1 << 10, 64, 16]) while (nextAddress(n) < at) gives.push(holdMemory(n));
  return () => { for (const g of gives) g(); };
}

function mustDoc(id: string): Doc {
  const d = docs.get(id);
  if (!d) throw new Error('Document is not open');
  return d;
}

/** keep at most this many parsed pages per document (long specs: thousands of pages) */
const KEEP = 24;
/**
 * Heavy pages - dense drawings that take a while to read in and hold hundreds of MB each once
 * read - across all open documents, least recently used first. Once the engine's memory has
 * grown past SOFT_HEAP, older heavy pages are let go before another one is read in (the memory
 * they free is used again), so going through a set of A0 sheets doesn't push the engine to its
 * limit (it would have to start afresh and read everything in again).
 */
const heavy: { d: Doc; i: number; t: number }[] = [];
const HEAVY_MS = 200;
const SOFT_HEAP = 1.2 * 1024 ** 3;
const HEAVY_MAX = 4;
/**
 * Scanned pages read in fast (a few objects) but hold their pictures decoded once drawn - a
 * colour scan at 400-600 dpi is 100-600 MB a page, and with 24 pages kept per file a few such
 * files filled the engine's 2 GB (it stopped mid-drawing; seen in reports). A page whose
 * pictures come to more than PIC_HEAVY counts as heavy, and heavy pages' pictures are held
 * within PIC_BUDGET together (the least recently used let go first).
 */
const PIC_HEAVY = 48 * 1024 ** 2;
const PIC_BUDGET = 640 * 1024 ** 2;
/** a page with more objects than this isn't a scan (its pictures aren't counted: a drawing of
 *  millions of lines would take seconds just to list) */
const PIC_SCAN_OBJECTS = 400;
function picBytes(ptr: number, limit = PIC_SCAN_OBJECTS): number {
  const q = Q();
  const n = q.FPDFPage_CountObjects(ptr);
  if (n <= 0 || n > limit) return 0;
  const wh = malloc(8);
  let total = 0;
  try {
    for (let i = 0; i < n; i++) {
      const o = q.FPDFPage_GetObject(ptr, i);
      if (!o || q.FPDFPageObj_GetType(o) !== 3) continue; // (3: an image)
      if (!q.FPDFImageObj_GetImagePixelSize(o, wh, wh + 4)) continue;
      total += (M().HEAP32[wh >>> 2] >>> 0) * (M().HEAP32[(wh + 4) >>> 2] >>> 0) * 4;
    }
  } finally { free(wh); }
  return total;
}
/** a heavy page used this recently is never let go (what's on screen - the page itself, its
 *  thumbnail, its text - asks for it again and again: reading it in again each time would crawl) */
const HEAVY_IDLE_MS = 8000;
/** pages read in (tests: a page read again and again shows here) */
export const pageStats = { loads: 0, heavyLoads: 0, dropped: 0 };

function loadPage(d: Doc, i: number): PageCache {
  const q = Q();
  const t0 = performance.now();
  const heap0 = heapBytes();
  const ptr = q.FPDF_LoadPage(d.doc, i);
  if (!ptr) throw new Error('Could not read page ' + (i + 1));
  const w = q.FPDF_GetPageWidthF(ptr), h = q.FPDF_GetPageHeightF(ptr);
  const aff = affine(ptr, w, h);
  const slow = performance.now() - t0 > HEAVY_MS;
  const pics = slow ? 0 : picBytes(ptr);
  const isHeavy = slow || pics > PIC_HEAVY;
  pageStats.loads++;
  if (isHeavy) pageStats.heavyLoads++;
  // (big pictures on a page with more objects than a scan - a drawing with photos - count too;
  // and a page slow to read in for its one big scan: its objects are counted, not timed)
  const slabby = (pics || picBytes(ptr, SLAB_SCAN_OBJECTS)) > SLAB_PICS;
  return { ptr, text: 0, aff, inv: invert(aff), w, h, heavy: isHeavy, pics, slabby, grew: Math.max(0, heapBytes() - heap0) };
}
/** how much the heap grew when this page was read in (0: not held by this engine) - PLAN 7.3 */
export const pageGrew = (id: string, i: number) => docs.get(id)?.pages.get(i)?.grew ?? 0;
function freePage(p: PageCache) {
  const q = Q();
  if (p.text) q.FPDFText_ClosePage(p.text);
  q.FPDF_ClosePage(p.ptr);
}
function dropPage(d: Doc, i: number) {
  const o = d.pages.get(i);
  if (!o) return;
  closeProgressive(d, i);
  dropSlabs(d, i);
  freePage(o);
  d.pages.delete(i);
  d.order = d.order.filter((x) => x !== i);
  const k = heavy.findIndex((x) => x.d === d && x.i === i);
  if (k >= 0) heavy.splice(k, 1);
  pageStats.dropped++;
}
/** heavy pages not used for a while, oldest first, while more than `keep` are held */
function dropIdleHeavy(keep: number) {
  const now = performance.now();
  for (let k = 0; k < heavy.length && heavy.length > keep;) {
    if (now - heavy[k].t > HEAVY_IDLE_MS) dropPage(heavy[k].d, heavy[k].i);
    else k++;
  }
}

/** before reading a page in: memory already grown -> keep one heavy page (the newest) besides the one coming */
function makeRoom() {
  if (heapBytes() > SOFT_HEAP) slabs.length = 0;
  if (heavy.length > 1 && heapBytes() > SOFT_HEAP) dropIdleHeavy(1);
}
/** heavy pages' pictures held within PIC_BUDGET: the least recently used go first (the newest - the
 *  one just read in - always stays; pages used in the last moment too, unless far over) */
function trimPictures() {
  const held = () => heavy.reduce((t, x) => t + (x.d.pages.get(x.i)?.pics || 0), 0);
  let total = held();
  if (total <= PIC_BUDGET) return;
  const now = performance.now();
  for (let k = 0; k < heavy.length - 1 && total > PIC_BUDGET;) {
    const e = heavy[k], pics = e.d.pages.get(e.i)?.pics || 0;
    if (pics && (now - e.t > 1500 || total > 2 * PIC_BUDGET)) { dropPage(e.d, e.i); total -= pics; }
    else k++;
  }
}

function page(d: Doc, i: number): PageCache {
  let p = d.pages.get(i);
  if (p) {
    d.order = d.order.filter((x) => x !== i);
    d.order.push(i);
    if (p.heavy) { const k = heavy.findIndex((x) => x.d === d && x.i === i); if (k >= 0) { const e = heavy.splice(k, 1)[0]; e.t = performance.now(); heavy.push(e); } }
    return p;
  }
  makeRoom();
  p = loadPage(d, i);
  d.pages.set(i, p);
  d.order.push(i);
  if (p.heavy) {
    heavy.push({ d, i, t: performance.now() });
    dropIdleHeavy(HEAVY_MAX);
    if (p.pics) trimPictures();
  }
  while (d.order.length > KEEP) dropPage(d, d.order[0]);
  return p;
}

/**
 * Use a page without keeping it: search, plain text of many pages. A page that is already
 * read in is used as it is; any other is read, used and let go (a search through a set of
 * drawings must not fill the engine with every sheet).
 */
function withPage<T>(d: Doc, i: number, fn: (p: PageCache) => T): T {
  const have = d.pages.get(i);
  if (have) return fn(have);
  makeRoom();
  const p = loadPage(d, i);
  try { return fn(p); } finally { freePage(p); }
}

function textPage(p: PageCache): number {
  if (!p.text) p.text = Q().FPDFText_LoadPage(p.ptr);
  return p.text;
}

/** affine from PDF user space to page space: x' = a x + c y + e, y' = b x + d y + f */
function affine(ptr: number, w: number, h: number): number[] {
  const q = Q();
  const K = 64;
  const sx = Math.round(w * K), sy = Math.round(h * K);
  const out = malloc(8);
  const dev = (x: number, y: number): [number, number] => {
    q.FPDF_PageToDevice(ptr, 0, 0, sx, sy, 0, x, y, out, out + 4);
    return [M().getValue(out, 'i32') / K, M().getValue(out + 4, 'i32') / K];
  };
  const o = dev(0, 0), ex = dev(1000, 0), ey = dev(0, 1000);
  free(out);
  return [(ex[0] - o[0]) / 1000, (ex[1] - o[1]) / 1000, (ey[0] - o[0]) / 1000, (ey[1] - o[1]) / 1000, o[0], o[1]];
}

function invert(m: number[]): number[] {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
const apply = (m: number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** box in user space (l, r, b, t) -> page space [x0, y0, x1, y1] */
function boxToPage(m: number[], l: number, r: number, b: number, t: number): [number, number, number, number] {
  const p1 = apply(m, l, b), p2 = apply(m, r, t);
  return [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])];
}

/**
 * Render part of a page. scale = device pixels per point; (x, y) = top-left of the
 * wanted area in device pixels of the whole page at that scale.
 * Page content only: annotations and form fields are drawn by the MuPDF layer.
 */
export function render(id: string, pg: number, scale: number, x: number, y: number, w: number, h: number, annots = false): Uint8ClampedArray {
  const d = mustDoc(id);
  const p = page(d, pg);
  // a page of big pictures: the tile is cut out of a slab drawn once (PLAN 3.5)
  if (!annots && p.slabby && p.slab !== false && slabStats.on && Number.isInteger(x) && Number.isInteger(y)) {
    // (the page's first two tiles are drawn on their own, the second timed - the first pays for
    // reading its pictures in once: only a page whose tiles stay slow - its pictures worked through
    // whole on every call - is worth a slab; many pictures draw fast once read)
    if (p.slab === undefined && slabStats.slowMs > 0) {
      const t = performance.now();
      const px = drawArea(p, scale, x, y, w, h, annots);
      if ((p.tried = (p.tried ?? 0) + 1) >= 2) p.slab = performance.now() - t >= slabStats.slowMs;
      return px;
    }
    const s = slabFor(d, pg, p, scale, x, y, w, h);
    if (s) {
      slabStats.served++;
      const cw = Math.min(w, s.sx + s.w - x), ch = Math.min(h, s.sy + s.h - y);
      const px = new Uint8ClampedArray(w * h * 4);
      // (the window sizes the page with ceil, PDFium with round: a last row or column a pixel past
      // the page is white, as on a tile drawn on its own)
      if (cw < w || ch < h) px.fill(255);
      for (let r = 0; r < ch; r++) { const at = ((y - s.sy + r) * s.w + (x - s.sx)) * 4; px.set(s.px.subarray(at, at + cw * 4), r * w * 4); }
      return px;
    }
  }
  return drawArea(p, scale, x, y, w, h, annots);
}
// ------------------------------------------------------------- drawing that gives way (PLAN 7.5, D6)
/**
 * A tile of line work drawn in slices of about `sliceMs` (PDFium's progressive drawing, its pause
 * hook asked between page objects: at most every 61-69 ms on the merged heavy sheets, no time
 * lost). Between slices `giveWay` runs - short calls waiting (text, snap, links) go then, not
 * after a 4 s tile - and says whether the tile is still wanted; a tile no longer wanted (its zoom
 * level left) stops there. Picture pages draw as before (slabs; inside a picture the hook is asked
 * thousands of times: +18 %).
 */
export class GaveWay extends Error { readonly stale = true; constructor() { super('stale tile'); } }
export const progressiveStats = { on: true, sliceMs: 50, slices: 0, gaveWay: 0 };
let pauseStruct = 0;
let sliceStart = 0;
function pauseHook(): number {
  if (!pauseStruct) {
    const P = (Q() as unknown as { pdfium: { addFunction(f: () => number, sig: string): number } }).pdfium;
    const fn = P.addFunction(() => (performance.now() - sliceStart >= progressiveStats.sliceMs ? 1 : 0), 'ii');
    const at = malloc(12); // (throws when the engine has no 12 bytes left: never written at 0)
    // IFSDK_PAUSE { version = 1, NeedToPauseNow, user }. Unsigned index: an engine past 2 GB (the 4 GB
    // patch) makes it above 2 GB, where `at >> 2` is negative and the writes went nowhere - every
    // line-work tile then failed ("drawing failed", a blank page). Phase 6, found by e2e-4gb.
    const H = M().HEAP32, i = at >>> 2;
    H[i] = 1; H[i + 1] = fn; H[i + 2] = 0;
    pauseStruct = at;
  }
  return pauseStruct;
}
/** the draw in progress (one at a time per engine): closed first when its page or file goes */
let progressive: { d: Doc; pg: number; ptr: number; closed: boolean } | null = null;
function closeProgressive(d: Doc, pg?: number) {
  const g = progressive;
  if (!g || g.d !== d || (pg !== undefined && g.pg !== pg) || g.closed) return;
  g.closed = true;
  Q().FPDF_RenderPage_Close(g.ptr);
}
export async function renderGivingWay(id: string, pg: number, scale: number, x: number, y: number, w: number, h: number, giveWay: () => Promise<boolean>): Promise<Uint8ClampedArray> {
  const d = mustDoc(id);
  const p = page(d, pg);
  if (!progressiveStats.on || p.slabby || progressive || !Number.isInteger(x) || !Number.isInteger(y)) return render(id, pg, scale, x, y, w, h);
  const q = Q();
  const bmp = q.FPDFBitmap_Create(w, h, 1);
  if (!bmp) throw new Error('Out of memory for a ' + w + '×' + h + ' render');
  const me = { d, pg, ptr: p.ptr, closed: false };
  progressive = me;
  try {
    q.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
    slabStats.calls++;
    sliceStart = performance.now();
    let r = q.FPDF_RenderPageBitmap_Start(bmp, p.ptr, -x, -y, Math.round(p.w * scale), Math.round(p.h * scale), 0, 0x10, pauseHook());
    progressiveStats.slices++;
    // (1: to be continued, 2: done, 3: failed)
    while (r === 1) {
      if ((await giveWay()) || me.closed) { progressiveStats.gaveWay++; throw new GaveWay(); }
      sliceStart = performance.now();
      r = q.FPDF_RenderPage_Continue(p.ptr, pauseHook());
      progressiveStats.slices++;
    }
    if (r !== 2) throw new Error('drawing failed');
    const buf = q.FPDFBitmap_GetBuffer(bmp) >>> 0;
    const stride = q.FPDFBitmap_GetStride(bmp);
    const heap = M().HEAPU8;
    if (stride === w * 4) return new Uint8ClampedArray(heap.buffer, buf, w * h * 4).slice();
    const px = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) px.set(heap.subarray(buf + row * stride, buf + row * stride + w * 4), row * w * 4);
    return px;
  } finally {
    if (!me.closed) { me.closed = true; q.FPDF_RenderPage_Close(p.ptr); }
    if (progressive === me) progressive = null;
    q.FPDFBitmap_Destroy(bmp);
  }
}

function drawArea(p: PageCache, scale: number, x: number, y: number, w: number, h: number, annots = false): Uint8ClampedArray {
  const q = Q();
  const bmp = q.FPDFBitmap_Create(w, h, 1);
  if (!bmp) throw new Error('Out of memory for a ' + w + '×' + h + ' render');
  try {
    q.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
    // 0x10 = RGBA byte order (straight into ImageData); 0x01 = annotations (only for thumbnails of other files)
    const flags = 0x10 | (annots ? 0x01 : 0);
    slabStats.calls++;
    q.FPDF_RenderPageBitmap(bmp, p.ptr, -Math.round(x), -Math.round(y), Math.round(p.w * scale), Math.round(p.h * scale), 0, flags);
    const buf = q.FPDFBitmap_GetBuffer(bmp) >>> 0;
    const stride = q.FPDFBitmap_GetStride(bmp);
    const heap = M().HEAPU8;
    if (stride === w * 4) return new Uint8ClampedArray(heap.buffer, buf, w * h * 4).slice();
    const px = new Uint8ClampedArray(w * h * 4);
    for (let r = 0; r < h; r++) px.set(heap.subarray(buf + r * stride, buf + r * stride + w * 4), r * w * 4);
    return px;
  } finally {
    q.FPDFBitmap_Destroy(bmp);
  }
}

// ---------------------------------------------------------------- picture pages in slabs (PLAN 3.5, D1)
/**
 * A page whose pictures are big (a 75-megapixel scan, a drawing with 128 MP of photos) costs about
 * the same to draw whatever the size of the area: PDFium works through the whole picture each time
 * (310-830 ms a call, measured). Drawn as 512 px tiles a view cost 12-48 such calls; now one slab
 * of up to 4,608 x 3,584 px, centred on the first tile asked for (the middle of the view), and
 * the view's tiles are cut out of it: one call a view - on a page of few objects whose tiles,
 * drawn on their own and timed, stay slow. Slabs are held in the engine (RGBA,
 * outside the engine's own memory), two at most. Cut-out tiles look as drawn on their own, not
 * bit for bit: a scaled picture's resampling rounds a few values differently with another clip
 * (up to 2 levels of 255, about 1 value in 1,000).
 */
/** a slab's size: a screen's shape - a 1,920 x 1,080 view at 175 % with the half tile around it
 *  (4,384 x 2,914 px) fits, wherever it falls on the 512 px grid (~63 MB) */
const SLAB_W = 4608, SLAB_H = 3584;
/** pictures (decoded, estimated) above which a page is drawn in slabs: ~16 megapixels */
const SLAB_PICS = 64 * 1024 ** 2;
/** only a page of few objects is drawn in slabs: a scan, photos with a few lines or words (a scanned
 *  sheet: 1 object; a sheet of a drawing set with a site photo: 520). A drawing with pictures (a merged sheet: 16,000 objects and 138 MB of
 *  pictures) costs by the area drawn - a slab there took 5.6 s where the view's tiles took 0.3 s */
const SLAB_SCAN_OBJECTS = 2000;
/** a page's second tile slower than this: its tiles come out of slabs (a scanned sheet: 400-800 ms a tile,
 *  every time; a 228-page set's page of pictures: 450 ms the first time, then ~10 ms - a slab
 *  there cost 0.5 s and 200 MB) */
const SLAB_SLOW_MS = 150;
/** slabs kept: a view takes one (centred on it); the one before stays for going back (up to 64 MB each) */
const SLAB_KEEP = 2;
const SLAB_BYTES = 128 * 1024 ** 2;
type Slab = { d: Doc; pg: number; scale: number; sx: number; sy: number; px: Uint8ClampedArray; w: number; h: number };
const slabs: Slab[] = [];
/** (tests) PDFium draws, slabs drawn, tiles served from them, slabs refused for want of room;
 *  on = slabs used; idleMs = slabs let go after this long unused */
export const slabStats = { calls: 0, drawn: 0, served: 0, refused: 0, on: true, idleMs: 20000, slowMs: SLAB_SLOW_MS };
export const slabsHeld = () => slabs.length;
/**
 * Room for a slab (`bytes`: its picture in the engine's memory and the copy kept) - set by the
 * engine host: the engine's memory stays below its planned restart point, and the PC keeps free
 * memory (the Cloudflare reports: a PC with 355 MB of 16 GB free). No room: the tile is drawn on
 * its own, as before 3.5, and the slabs held are let go. Tests: always room.
 */
let slabRoom: (bytes: number) => boolean = () => true;
export function setSlabRoom(f: (bytes: number) => boolean) { slabRoom = f; }
let slabTimer: ReturnType<typeof setTimeout> | null = null;
/** slabs are let go once a page of pictures hasn't been drawn for a while */
function touchSlabs() {
  if (slabTimer) clearTimeout(slabTimer);
  slabTimer = setTimeout(() => { slabs.length = 0; slabTimer = null; }, slabStats.idleMs);
  (slabTimer as { unref?: () => void }).unref?.();
}
/** a slab holds a tile: inside it, or reaching a pixel past it where the slab ends at the page's edge */
function holds(s: Slab, x: number, y: number, w: number, h: number, W: number, H: number) {
  const fits = (a: number, n: number, sa: number, sn: number, edge: number) => a >= sa && (a + n <= sa + sn || (sa + sn === edge && a + n - (sa + sn) <= 1 && a < sa + sn));
  return fits(x, w, s.sx, s.w, W) && fits(y, h, s.sy, s.h, H);
}
/**
 * The slab a tile comes out of: one already drawn that holds it, or a new one centred on it. The
 * window asks for the tiles of a view centre first, so the first slab - centred on the middle of
 * the view - holds the whole view (a view is smaller than a slab): one draw.
 */
function slabFor(d: Doc, pg: number, p: PageCache, scale: number, x: number, y: number, w: number, h: number): Slab | null {
  const W = Math.round(p.w * scale), H = Math.round(p.h * scale);
  const k = slabs.findIndex((s) => s.d === d && s.pg === pg && s.scale === scale && holds(s, x, y, w, h, W, H));
  if (k >= 0) { const s = slabs.splice(k, 1)[0]; slabs.push(s); touchSlabs(); return s; }
  // (on the 512 px grid of the tiles: PDFium's resampling of a picture then rounds as on a tile
  // drawn on its own; moved back from the page's far edge when it still holds the tile)
  const at = (a: number, n: number, edge: number, size: number) => {
    const c = Math.max(0, Math.round((a + n / 2 - size / 2) / 512) * 512), e = Math.floor(Math.max(0, edge - size) / 512) * 512;
    return e < c && e + size >= a + n ? e : c;
  };
  const sx = at(x, w, W, SLAB_W), sy = at(y, h, H, SLAB_H);
  const sw = Math.min(SLAB_W, W - sx), sh = Math.min(SLAB_H, H - sy);
  if (sw <= 0 || sh <= 0) return null;
  const s: Slab = { d, pg, scale, sx, sy, px: new Uint8ClampedArray(0), w: sw, h: sh };
  // (a tile no slab can hold - more than a slab, or off the page: drawn on its own)
  if (!holds(s, x, y, w, h, W, H)) return null;
  if (!slabRoom(sw * sh * 4 * 2)) { slabStats.refused++; slabs.length = 0; return null; }
  // (no room for a slab after all: the tile is drawn on its own, as before)
  try { s.px = drawArea(p, scale, sx, sy, sw, sh); } catch (e) { if (/out of memory/i.test(String((e as Error)?.message))) { slabs.length = 0; return null; } throw e; }
  slabStats.drawn++;
  slabs.push(s);
  touchSlabs();
  const bytes = () => slabs.reduce((t, x) => t + x.px.length, 0);
  while (slabs.length > SLAB_KEEP || (slabs.length > 1 && bytes() > SLAB_BYTES)) slabs.shift();
  return s;
}
function dropSlabs(d: Doc, pg?: number) { for (let k = slabs.length - 1; k >= 0; k--) if (slabs[k].d === d && (pg === undefined || slabs[k].pg === pg)) slabs.splice(k, 1); }

/** every character on the page with its box in page space (cached per page) */
/** (`keep` false: a page not loaded is loaded for this only and let go after - a whole-file read,
 *  Link the sheets, kept up to 24 parsed pages, dense ones held for 8 s more: sweep S5) */
export function chars(id: string, pg: number, keep = true): CharInfo {
  const d = mustDoc(id);
  if (!keep && !d.pages.has(pg)) return withPage(d, pg, charsOf);
  return charsOf(page(d, pg));
}
function charsOf(p: PageCache): CharInfo {
  if (p.chars) return p.chars;
  const q = Q();
  const tp = textPage(p);
  const n = tp ? q.FPDFText_CountChars(tp) : 0;
  if (n <= 0) return (p.chars = { text: '', box: new Float32Array(0) });
  const text = textAt(tp, 0, n);
  const box = new Float32Array(n * 4);
  const db = malloc(32);
  for (let i = 0; i < n; i++) {
    // loose box = the character's full line height (even selections and highlights)
    if (!q.FPDFText_GetLooseCharBox(tp, i, db)) { box.set([NaN, NaN, NaN, NaN], i * 4); continue; }
    const f = new Float32Array(M().HEAPU8.buffer, db, 4); // left, top, right, bottom
    if (!(f[2] > f[0])) { box.set([NaN, NaN, NaN, NaN], i * 4); continue; }
    const b = boxToPage(p.aff, f[0], f[2], f[3], f[1]);
    box.set(b, i * 4);
  }
  free(db);
  return (p.chars = { text, box });
}

/**
 * The text of chars [start, start + n) with exactly one UTF-16 unit per char index (text[i] is the
 * character whose box is box[i]). GetText leaves out characters it treats as control codes (a
 * hyphen some files map to U+0002...) and says how many units it wrote: when that isn't n, the
 * text is read char by char instead - everything after such a character drifted onto the next
 * one's box (selections copied the wrong letters, the search list bolded the wrong words) and the
 * end of the text held a NUL and leftover memory.
 */
function textAt(tp: number, start: number, n: number): string {
  const q = Q();
  const tb = malloc((n + 1) * 2);
  try {
    const got = q.FPDFText_GetText(tp, start, n, tb) - 1; // (the count includes the closing NUL)
    if (got === n) {
      const u16 = new Uint16Array(M().HEAPU8.buffer, tb, n);
      let text = '';
      for (let i = 0; i < n; i += 4096) text += String.fromCharCode(...u16.subarray(i, Math.min(n, i + 4096)));
      return text;
    }
  } finally { free(tb); }
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = q.FPDFText_GetUnicode(tp, start + i);
    // (control codes a page maps its glyphs to - hidden by GetText - as an invisible soft hyphen;
    // a code point beyond 16 bits can't take one unit: the replacement character)
    out[i] = (u < 32 && u !== 9 && u !== 10 && u !== 13) || (u >= 0x7f && u < 0xa0) || u === 0xfffe ? '\u00ad' : u > 0xffff ? '\ufffd' : String.fromCharCode(u);
  }
  return out.join('');
}

/** merged rectangles (one per line piece) covering chars [start, start+count) */
export function rangeRects(id: string, pg: number, start: number, count: number): number[][] {
  return rectsOf(page(mustDoc(id), pg), start, count);
}
function rectsOf(p: PageCache, start: number, count: number): number[][] {
  const q = Q();
  const tp = textPage(p);
  if (!tp || count <= 0) return [];
  const n = q.FPDFText_CountRects(tp, start, count);
  const out: number[][] = [];
  const db = malloc(32);
  for (let i = 0; i < n; i++) {
    q.FPDFText_GetRect(tp, i, db, db + 8, db + 16, db + 24); // left, top, right, bottom
    const f = new Float64Array(M().HEAPU8.buffer, db, 4);
    out.push(boxToPage(p.aff, f[0], f[2], f[3], f[1]));
  }
  free(db);
  return out;
}

export interface Hit { page: number; start: number; count: number; rects: number[][]; /** the words around it (search list) */ snip?: string }

/** find text on pages [from, to); case-insensitive unless matchCase */
export function find(id: string, needle: string, from: number, to: number, matchCase = false, wholeWord = false, max = 5000): Hit[] {
  const d = mustDoc(id);
  const q = Q();
  const hits: Hit[] = [];
  if (!needle) return hits;
  const n16 = malloc((needle.length + 1) * 2);
  M().stringToUTF16(needle, n16, (needle.length + 1) * 2);
  const flags = (matchCase ? 1 : 0) | (wholeWord ? 2 : 0);
  const count = q.FPDF_GetPageCount(d.doc);
  try {
    for (let i = from; i < Math.min(to, count) && hits.length < max; i++) {
      withPage(d, i, (p) => {
        const tp = textPage(p);
        if (!tp) return;
        const h = q.FPDFText_FindStart(tp, n16, flags, 0);
        if (!h) return;
        const total = q.FPDFText_CountChars(tp);
        while (q.FPDFText_FindNext(h) && hits.length < max) {
          const s = q.FPDFText_GetSchResultIndex(h), c = q.FPDFText_GetSchCount(h);
          hits.push({ page: i, start: s, count: c, rects: rectsOf(p, s, c), snip: snippet(tp, s, c, total) });
        }
        q.FPDFText_FindClose(h);
      });
    }
  } finally {
    free(n16);
  }
  return hits;
}

/** the text around chars [s, s+c) on a text page: 40 before, 50 after, on one line */
function snippet(tp: number, s: number, c: number, total: number): string {
  const a = Math.max(0, s - 40), e = Math.min(total, s + c + 50);
  const n = e - a;
  if (n <= 0) return '';
  // (one unit per char index: the found words are cut out by index)
  const t = textAt(tp, a, n);
  // the found words between \u0001 and \u0002 (the list shows them in bold)
  const one = (x: string) => x.replace(/\s+/g, ' ');
  const i0 = s - a, i1 = s - a + c;
  return ((a > 0 ? '…' : '') + one(t.slice(0, i0)).trimStart() + '\u0001' + one(t.slice(i0, i1)) + '\u0002' + one(t.slice(i1)).trimEnd() + (e < total ? '…' : ''));
}

/** `view`: the destination's view, FPDFDest_GetView's type (2 = /Fit, 1 = /XYZ ...) and its parameters */
export interface LinkInfo { rect: number[]; url?: string; page?: number; view?: { kind: number; params: number[] } }

/** the view of a destination (0 = none given); the parameters it carries (up to 4 numbers) */
function destView(q: WrappedPdfiumModule, dest: number): { kind: number; params: number[] } | null {
  const n = malloc(4), ps = malloc(16);
  try {
    M().HEAP32[n >>> 2] = 0;
    const kind = q.FPDFDest_GetView(dest, n, ps);
    if (!kind) return null;
    const count = Math.min(4, M().HEAP32[n >>> 2]);
    const f = new Float32Array(M().HEAPU8.buffer, ps, 4);
    return { kind, params: Array.from(f.subarray(0, Math.max(0, count))) };
  } finally { free(n); free(ps); }
}

export function links(id: string, pg: number): LinkInfo[] {
  const d = mustDoc(id);
  const p = page(d, pg);
  const q = Q();
  const out: LinkInfo[] = [];
  const pos = malloc(4), lk = malloc(4), rc = malloc(16);
  M().HEAP32[pos >>> 2] = 0;
  try {
    while (q.FPDFLink_Enumerate(p.ptr, pos, lk)) {
      const link = M().HEAP32[lk >>> 2];
      if (!q.FPDFLink_GetAnnotRect(link, rc)) continue;
      const f = new Float32Array(M().HEAPU8.buffer, rc, 4); // left, top, right, bottom
      const info: LinkInfo = { rect: boxToPage(p.aff, f[0], f[2], f[3], f[1]) };
      // (the action first: PDFium gives a link to another file (GoToR) that file's page as a
      // destination - it was followed to that page of THIS file)
      const act = q.FPDFLink_GetAction(link);
      const atype = act ? q.FPDFAction_GetType(act) : 0;
      // (GoToE - into a PDF attached to this one - like GoToR: listed, never followed)
      let dest = atype === 2 || atype === 3 || atype === 4 || atype === 5 ? 0 : q.FPDFLink_GetDest(d.doc, link);
      if (!dest && act) {
        const type = atype;
        if (type === 1) dest = q.FPDFAction_GetDest(d.doc, act);
        else if (type === 2 || type === 4 || type === 5) {
          // another file / a program (GoToR, Launch): listed - never followed - so the window can
          // say it was not opened and the Link tool can show it
          let path = '';
          try {
            const len = q.FPDFAction_GetFilePath(act, 0, 0);
            if (len > 0) { const b = malloc(len); q.FPDFAction_GetFilePath(act, b, len); path = new TextDecoder().decode(M().HEAPU8.slice(b, b + len - 1)); free(b); }
          } catch { /* not in this build */ }
          info.url = 'file:' + (path || '(a file or program)');
        } else if (type === 3) {
          const len = q.FPDFAction_GetURIPath(d.doc, act, 0, 0);
          if (len > 0) {
            const b = malloc(len);
            q.FPDFAction_GetURIPath(d.doc, act, b, len);
            info.url = new TextDecoder().decode(M().HEAPU8.slice(b, b + len - 1));
            free(b);
          }
        }
      }
      if (dest) {
        info.page = q.FPDFDest_GetDestPageIndex(d.doc, dest);
        const view = destView(q, dest);
        if (view) info.view = view;
      }
      if (info.url || info.page != null) out.push(info);
    }
  } finally {
    free(pos); free(lk); free(rc);
  }
  return out;
}

/** page point -> user-space point (for completeness / tests) */
export function toUser(id: string, pg: number, x: number, y: number): [number, number] {
  return apply(page(mustDoc(id), pg).inv, x, y);
}

// ---------------------------------------------------------------- snapping to line work

/** kind (per piece): which of its ends are real line ends (1 = start, 2 = end) and whether its
 *  middle is a real middle (4) - a piece of a curve has none of those but its first / last end */
export interface SnapIndex { seg: Float32Array; kind: Uint8Array; n: number; cols: number; rows: number; cw: number; ch: number; start: Int32Array; ids: Int32Array; w: number; h: number }

let SNAP_MAX = 4e6;
/** most entries of a page's snap grid (4 bytes each); tests may lower it */
let SNAP_CELLS_MAX = 16e6;
export function setSnapCellsMax(n: number) { SNAP_CELLS_MAX = n; }
/** tests: a lower limit (a page over it is quick to make) */
export function setSnapMax(n: number) { SNAP_MAX = n; }
/** tests: what a page cache holds of a page (its handle, matrix and size) - the page is read in if it is not */
export function snapPageForTests(id: string, pg: number): { ptr: number; aff: number[]; w: number; h: number } {
  const p = page(mustDoc(id), pg);
  return { ptr: p.ptr, aff: p.aff, w: p.w, h: p.h };
}
/**
 * Snap indexes held, across all open files, most recent last: they are ordinary memory, outside
 * the engine's own (heapBytes) - kept within a budget besides the 6 per file (several drawing sets
 * open held up to 6 x 14 MB each).
 */
const snapsHeld: { d: Doc; pg: number; bytes: number }[] = [];
const SNAP_BUDGET = 160 * 1024 ** 2;
function holdSnap(d: Doc, pg: number, ix: SnapIndex | null) {
  const k = snapsHeld.findIndex((e) => e.d === d && e.pg === pg);
  const e = k >= 0 ? snapsHeld.splice(k, 1)[0] : null;
  if (!ix) return;
  snapsHeld.push(e ?? { d, pg, bytes: ix.seg.byteLength + ix.kind.byteLength + ix.start.byteLength + ix.ids.byteLength });
  let total = snapsHeld.reduce((t, x) => t + x.bytes, 0);
  while (snapsHeld.length > 1 && total > SNAP_BUDGET) { const old = snapsHeld.shift()!; old.d.snaps.delete(old.pg); total -= old.bytes; }
}
/** a document's snap indexes let go (closed) */
function dropSnaps(d: Doc) { for (let k = snapsHeld.length - 1; k >= 0; k--) if (snapsHeld[k].d === d) snapsHeld.splice(k, 1); }

/** every straight piece of line work on the page (curves as a few chords), in a grid index */
export function buildSnap(id: string, pg: number): SnapIndex {
  const d = mustDoc(id);
  const cached = d.snaps.get(pg);
  if (cached) { d.snaps.delete(pg); d.snaps.set(pg, cached); holdSnap(d, pg, cached); return cached; } // (most recent last)
  const q = Q();
  const p = page(d, pg);
  const { w, h } = p;
  // (the engine's own exports, called straight: the wrappers in `q` pass every call through three
  // layers of argument handling - ~0.4 us a call, ~25 x the call itself: over the objects of a
  // page it was most of the time)
  const X = M().wasmExports as unknown as Record<string, (...a: number[]) => number>;
  let seg = new Float32Array(1 << 18);
  let kd = new Uint8Array(1 << 16);
  let n = 0;
  /** path pieces on the page (counted object by object before any is read) */
  let total = 0, tooMany = false;
  const push = (x0: number, y0: number, x1: number, y1: number, kind = 7) => {
    if (Math.abs(x1 - x0) + Math.abs(y1 - y0) < 0.6) return;
    if (n * 4 + 4 > seg.length) { const g = new Float32Array(seg.length * 2); g.set(seg); seg = g; }
    if (n + 1 > kd.length) { const g = new Uint8Array(kd.length * 2); g.set(kd); kd = g; }
    seg[n * 4] = x0; seg[n * 4 + 1] = y0; seg[n * 4 + 2] = x1; seg[n * 4 + 3] = y1;
    kd[n] = kind;
    n++;
  };
  /**
   * A curve (from x0, y0 through the control points c = [x1 y1 x2 y2 x3 y3]) as a few chords on
   * the curve itself. PDFium hands a curve over as its three points: joined up, they made the
   * control polygon - snap marks floated off arcs and rounded corners, up to 14 % of the radius.
   * Only the curve's own two ends are line ends; the chords have no middles of their own.
   */
  const curve = (x0: number, y0: number, c: ArrayLike<number>) => {
    const len = Math.hypot(c[0] - x0, c[1] - y0) + Math.hypot(c[2] - c[0], c[3] - c[1]) + Math.hypot(c[4] - c[2], c[5] - c[3]);
    const k = Math.max(2, Math.min(16, Math.ceil(len / 8)));
    let ax = x0, ay = y0;
    for (let i = 1; i <= k; i++) {
      const t = i / k, u = 1 - t;
      const bx = u * u * u * x0 + 3 * u * u * t * c[0] + 3 * u * t * t * c[2] + t * t * t * c[4];
      const by = u * u * u * y0 + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5];
      push(ax, ay, bx, by, (i === 1 ? 1 : 0) | (i === k ? 2 : 0));
      ax = bx; ay = by;
    }
  };
  const mat = malloc(24), xy = malloc(8);
  const mod = M();
  // one view over the engine's memory for the whole build, taken again only if the memory grew
  // (a new view per segment was an allocation per segment)
  let f32 = new Float32Array(mod.HEAPU8.buffer);
  const mi = mat >>> 2, xi = xy >>> 2;
  /** the points of the curve being read (a curve comes as three points of type "bezier") */
  const bz = new Float64Array(6);
  /** the object's matrix on the page's: T (6 numbers) x the object's own, the same sums as before, no array per object */
  const visit = (obj: number, t0: number, t1: number, t2: number, t3: number, t4: number, t5: number, depth: number) => {
    const type = X.FPDFPageObj_GetType(obj);
    if (type !== 2 && type !== 5) return;
    let b0 = 1, b1 = 0, b2 = 0, b3 = 1, b4 = 0, b5 = 0;
    if (X.FPDFPageObj_GetMatrix(obj, mat)) {
      if (mod.HEAPU8.buffer !== f32.buffer) f32 = new Float32Array(mod.HEAPU8.buffer);
      b0 = f32[mi]; b1 = f32[mi + 1]; b2 = f32[mi + 2]; b3 = f32[mi + 3]; b4 = f32[mi + 4]; b5 = f32[mi + 5];
    }
    const a0 = t0 * b0 + t2 * b1, a1 = t1 * b0 + t3 * b1, a2 = t0 * b2 + t2 * b3, a3 = t1 * b2 + t3 * b3;
    const a4 = t0 * b4 + t2 * b5 + t4, a5 = t1 * b4 + t3 * b5 + t5;
    if (type === 5) {
      if (depth > 6) return;
      const c = X.FPDFFormObj_CountObjects(obj);
      for (let k = 0; k < c; k++) visit(X.FPDFFormObj_GetObject(obj, k), a0, a1, a2, a3, a4, a5, depth + 1);
      return;
    }
    const cnt = X.FPDFPath_CountSegments(obj);
    let sx = 0, sy = 0, px = 0, py = 0, has = false, nb = 0;
    for (let k = 0; k < cnt; k++) {
      const sg = X.FPDFPath_GetPathSegment(obj, k);
      if (!X.FPDFPathSegment_GetPoint(sg, xy, xy + 4)) continue;
      if (mod.HEAPU8.buffer !== f32.buffer) f32 = new Float32Array(mod.HEAPU8.buffer);
      const ux = f32[xi], uy = f32[xi + 1];
      const gx = a0 * ux + a2 * uy + a4, gy = a1 * ux + a3 * uy + a5;
      const t = X.FPDFPathSegment_GetType(sg);
      if (t === 2 || !has) { sx = gx; sy = gy; has = true; nb = 0; }
      else if (t === 1) {
        bz[nb++] = gx; bz[nb++] = gy;
        // (the curve's start stays where it was until its last point is in)
        if (nb < 6) continue;
        curve(px, py, bz);
        nb = 0;
      } else push(px, py, gx, gy);
      px = gx; py = gy;
      if (X.FPDFPathSegment_GetClose(sg) && (px !== sx || py !== sy)) { push(px, py, sx, sy); px = sx; py = sy; }
    }
  };
  /** adds up the path pieces of an object (forms entered as visit() does) without reading a point; false once over the limit */
  const countPieces = (obj: number, depth: number): boolean => {
    const type = X.FPDFPageObj_GetType(obj);
    if (type === 5) {
      if (depth > 6) return true;
      const c = X.FPDFFormObj_CountObjects(obj);
      for (let k = 0; k < c; k++) if (!countPieces(X.FPDFFormObj_GetObject(obj, k), depth + 1)) return false;
      return true;
    }
    return type !== 2 || (total += X.FPDFPath_CountSegments(obj)) <= SNAP_MAX;
  };
  const count = q.FPDFPage_CountObjects(p.ptr);
  // a page of tens of millions of line pieces (a traced scan): no snapping there - reading them
  // all would take a minute and hundreds of MB. Counted first, piece counts only: it is given up
  // at once (reading pieces until the count ran over took ~2.8 s on the merged heavy sheets)
  for (let i = 0; i < count && !tooMany; i++) if (!countPieces(X.FPDFPage_GetObject(p.ptr, i), 0)) tooMany = true;
  if (!tooMany) for (let i = 0; i < count; i++) visit(X.FPDFPage_GetObject(p.ptr, i), p.aff[0], p.aff[1], p.aff[2], p.aff[3], p.aff[4], p.aff[5], 0);
  free(mat); free(xy);
  const cols = 128, rows = Math.max(16, Math.round((128 * h) / w));
  const cw = w / cols, ch = h / rows;
  // (each piece goes into every cell of its box: long slanting pieces over a whole sheet add up -
  // past SNAP_CELLS_MAX entries the page is too dense to snap, as with too many pieces, rather than
  // an index of gigabytes or a count that wraps; Phase 6 sweep)
  let entries = 0;
  for (let i = 0; i < n && entries <= SNAP_CELLS_MAX; i++) {
    const c0 = Math.max(0, Math.floor(Math.min(seg[i * 4], seg[i * 4 + 2]) / cw)), c1 = Math.min(cols - 1, Math.floor(Math.max(seg[i * 4], seg[i * 4 + 2]) / cw));
    const r0 = Math.max(0, Math.floor(Math.min(seg[i * 4 + 1], seg[i * 4 + 3]) / ch)), r1 = Math.min(rows - 1, Math.floor(Math.max(seg[i * 4 + 1], seg[i * 4 + 3]) / ch));
    entries += Math.max(0, c1 - c0 + 1) * Math.max(0, r1 - r0 + 1);
  }
  if (entries > SNAP_CELLS_MAX) n = 0;
  const counts = new Int32Array(cols * rows + 1);
  // (the cells each piece touches, twice - counted, then filled: written out, not as a callback per cell)
  for (let i = 0; i < n; i++) {
    const x0 = Math.min(seg[i * 4], seg[i * 4 + 2]), x1 = Math.max(seg[i * 4], seg[i * 4 + 2]);
    const y0 = Math.min(seg[i * 4 + 1], seg[i * 4 + 3]), y1 = Math.max(seg[i * 4 + 1], seg[i * 4 + 3]);
    const c0 = Math.max(0, Math.floor(x0 / cw)), c1 = Math.min(cols - 1, Math.floor(x1 / cw));
    const r0 = Math.max(0, Math.floor(y0 / ch)), r1 = Math.min(rows - 1, Math.floor(y1 / ch));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) counts[r * cols + c + 1]++;
  }
  for (let c = 0; c < cols * rows; c++) counts[c + 1] += counts[c];
  const ids = new Int32Array(counts[cols * rows]);
  const fill = counts.slice();
  for (let i = 0; i < n; i++) {
    const x0 = Math.min(seg[i * 4], seg[i * 4 + 2]), x1 = Math.max(seg[i * 4], seg[i * 4 + 2]);
    const y0 = Math.min(seg[i * 4 + 1], seg[i * 4 + 3]), y1 = Math.max(seg[i * 4 + 1], seg[i * 4 + 3]);
    const c0 = Math.max(0, Math.floor(x0 / cw)), c1 = Math.min(cols - 1, Math.floor(x1 / cw));
    const r0 = Math.max(0, Math.floor(y0 / ch)), r1 = Math.min(rows - 1, Math.floor(y1 / ch));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) ids[fill[r * cols + c]++] = i;
  }
  const ix = { seg: seg.slice(0, n * 4), kind: kd.slice(0, n), n, cols, rows, cw, ch, start: counts, ids, w, h };
  d.snaps.set(pg, ix);
  // (a heavy A0 sheet's index is ~14 MB: the few sheets measured on last are kept)
  while (d.snaps.size > 6) { const old = d.snaps.keys().next().value as number; d.snaps.delete(old); holdSnap(d, old, null); }
  holdSnap(d, pg, ix);
  return ix;
}

/** nearest line end / middle / point on a line within r points */
/**
 * from: the point the line being drawn comes from - then a line near the pointer also offers the
 * foot of the perpendicular from it (k 'perp'), when that foot is near the pointer too (the
 * pointer has to come to the right angle - as in the Estimation app since 0.18.1). A line end or
 * middle nearer than the foot wins.
 */
export function snapAt(ix: SnapIndex, x: number, y: number, r: number, from?: number[] | null): { x: number; y: number; k: 'end' | 'mid' | 'on' | 'perp' } | null {
  const c0 = Math.max(0, Math.floor((x - r) / ix.cw)), c1 = Math.min(ix.cols - 1, Math.floor((x + r) / ix.cw));
  const r0 = Math.max(0, Math.floor((y - r) / ix.ch)), r1 = Math.min(ix.rows - 1, Math.floor((y + r) / ix.ch));
  let bestEnd = r * r, end: [number, number] | null = null;
  let bestMid = (r * 0.7) ** 2, mid: [number, number] | null = null;
  let bestOn = (r * 0.6) ** 2, on: [number, number] | null = null;
  let bestPerp = r * r, perp: [number, number] | null = null;
  const fx = from ? from[0] : 0, fy = from ? from[1] : 0;
  const s = ix.seg;
  for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) {
    const cell = rr * ix.cols + cc;
    for (let k = ix.start[cell]; k < ix.start[cell + 1]; k++) {
      const j = ix.ids[k], i = j * 4, kind = ix.kind[j];
      const ax = s[i], ay = s[i + 1], bx = s[i + 2], by = s[i + 3];
      let dd: number;
      if (kind & 1) { dd = (ax - x) ** 2 + (ay - y) ** 2; if (dd < bestEnd) { bestEnd = dd; end = [ax, ay]; } }
      if (kind & 2) { dd = (bx - x) ** 2 + (by - y) ** 2; if (dd < bestEnd) { bestEnd = dd; end = [bx, by]; } }
      if (kind & 4) {
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        dd = (mx - x) ** 2 + (my - y) ** 2;
        if (dd < bestMid) { bestMid = dd; mid = [mx, my]; }
      }
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      if (l2 > 0) {
        let t = ((x - ax) * dx + (y - ay) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx, qy = ay + t * dy;
        dd = (qx - x) ** 2 + (qy - y) ** 2;
        if (dd < bestOn) { bestOn = dd; on = [qx, qy]; }
        // the perpendicular from `from` onto this line (its foot on the line, not at `from` itself)
        if (from && dd < r * r) {
          const u = ((fx - ax) * dx + (fy - ay) * dy) / l2;
          if (u >= 0 && u <= 1) {
            const px = ax + u * dx, py = ay + u * dy;
            if ((px - fx) ** 2 + (py - fy) ** 2 > 1e-6) {
              const dp = (px - x) ** 2 + (py - y) ** 2;
              if (dp < bestPerp) { bestPerp = dp; perp = [px, py]; }
            }
          }
        }
      }
    }
  }
  if (perp && !(end && bestEnd <= bestPerp) && !(mid && bestMid < bestPerp)) return { x: perp[0], y: perp[1], k: 'perp' };
  if (end) return { x: end[0], y: end[1], k: 'end' };
  if (mid) return { x: mid[0], y: mid[1], k: 'mid' };
  if (on) return { x: on[0], y: on[1], k: 'on' };
  return null;
}

export function snap(id: string, pg: number, x: number, y: number, r: number, from?: number[] | null) {
  return snapAt(buildSnap(id, pg), x, y, r, from);
}

/** words with boxes on part of a page (for copy-as-table) */
/** just the text of a page (no positions; cheap) */
export function pageText(id: string, pg: number): string {
  return withPage(mustDoc(id), pg, (p) => {
    if (p.chars) return p.chars.text;
    const q = Q();
    const tp = textPage(p);
    const n = tp ? q.FPDFText_CountChars(tp) : 0;
    if (n <= 0) return '';
    const tb = malloc((n + 1) * 2);
    // (what GetText wrote - it says how many units, closing NUL included: reading n units sent a NUL
    // and leftover memory along when it had left out a control character)
    const got = Math.max(0, Math.min(n, q.FPDFText_GetText(tp, 0, n, tb) - 1));
    const u16 = new Uint16Array(M().HEAPU8.buffer, tb, got);
    let text = '';
    for (let i = 0; i < got; i += 4096) text += String.fromCharCode(...u16.subarray(i, Math.min(got, i + 4096)));
    free(tb);
    return text;
  });
}

export function charsIn(id: string, pg: number, r: number[]): { c: string; b: number[] }[] {
  const ci = chars(id, pg);
  const out: { c: string; b: number[] }[] = [];
  for (let i = 0; i < ci.text.length; i++) {
    const x0 = ci.box[i * 4], y0 = ci.box[i * 4 + 1], x1 = ci.box[i * 4 + 2], y1 = ci.box[i * 4 + 3];
    if (Number.isNaN(x0)) continue;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    if (cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3]) out.push({ c: ci.text[i], b: [x0, y0, x1, y1] });
  }
  return out;
}
