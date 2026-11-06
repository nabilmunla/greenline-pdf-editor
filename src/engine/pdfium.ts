// PDFium (the engine inside Chrome, as WebAssembly): fast drawing of page content,
// text positions for selecting / searching / tables, and links.
// No DOM in here so the tests can run it in Node.
//
// "Page space" everywhere: the page as shown (rotation and crop box applied),
// origin top-left, 1 unit = 1 PDF point. MuPDF uses the same space, so the two agree.
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { Reader } from './files';

let P: WrappedPdfiumModule | null = null;

export async function startPdfium(wasm: ArrayBuffer): Promise<void> {
  if (P) return;
  P = await init({ wasmBinary: wasm });
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
const malloc = (n: number) => M().wasmExports.malloc(n);
const free = (p: number) => M().wasmExports.free(p);

interface PageCache { ptr: number; text: number; aff: number[]; inv: number[]; w: number; h: number; chars?: CharInfo; heavy?: boolean }
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
      try { return r.read(M().HEAPU8, buf, len, pos >>> 0) === len ? 1 : 0; } catch { return 0; }
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
  closeDoc(id);
  const d: Doc = { mem, fa, slot, reader: src instanceof Uint8Array ? null : src, doc, pages: new Map(), order: [], snaps: new Map() };
  docs.set(id, d);
  const n = q.FPDF_GetPageCount(doc);
  const pages: { w: number; h: number }[] = [];
  const sz = malloc(16);
  for (let i = 0; i < n; i++) {
    // size of the page as shown: load lightly (cheap: PDFium parses content lazily)
    q.FPDF_GetPageSizeByIndexF(doc, i, sz);
    const f = new Float32Array(M().HEAPU8.buffer, sz, 2);
    pages.push({ w: f[0], h: f[1] });
  }
  free(sz);
  return { pages };
}

export function closeDoc(id: string): void {
  const d = docs.get(id);
  if (!d) return;
  const q = Q();
  for (const p of d.pages.values()) {
    if (p.text) q.FPDFText_ClosePage(p.text);
    q.FPDF_ClosePage(p.ptr);
  }
  for (let k = heavy.length - 1; k >= 0; k--) if (heavy[k].d === d) heavy.splice(k, 1);
  dropSnaps(d);
  q.FPDF_CloseDocument(d.doc);
  if (d.mem) free(d.mem);
  if (d.fa) free(d.fa);
  if (d.slot) readers.delete(d.slot);
  d.reader?.close();
  docs.delete(id);
}

export const openIds = () => [...docs.keys()];
/** engine memory in use (WebAssembly memory only grows) */
export const heapBytes = () => M().HEAPU8.buffer.byteLength;

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
/** a heavy page used this recently is never let go (what's on screen - the page itself, its
 *  thumbnail, its text - asks for it again and again: reading it in again each time would crawl) */
const HEAVY_IDLE_MS = 8000;
/** pages read in (tests: a page read again and again shows here) */
export const pageStats = { loads: 0, heavyLoads: 0, dropped: 0 };

function loadPage(d: Doc, i: number): PageCache {
  const q = Q();
  const t0 = performance.now();
  const ptr = q.FPDF_LoadPage(d.doc, i);
  if (!ptr) throw new Error('Could not read page ' + (i + 1));
  const w = q.FPDF_GetPageWidthF(ptr), h = q.FPDF_GetPageHeightF(ptr);
  const aff = affine(ptr, w, h);
  const isHeavy = performance.now() - t0 > HEAVY_MS;
  pageStats.loads++;
  if (isHeavy) pageStats.heavyLoads++;
  return { ptr, text: 0, aff, inv: invert(aff), w, h, heavy: isHeavy };
}
function freePage(p: PageCache) {
  const q = Q();
  if (p.text) q.FPDFText_ClosePage(p.text);
  q.FPDF_ClosePage(p.ptr);
}
function dropPage(d: Doc, i: number) {
  const o = d.pages.get(i);
  if (!o) return;
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
  if (heavy.length > 1 && heapBytes() > SOFT_HEAP) dropIdleHeavy(1);
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
  const q = Q();
  const d = mustDoc(id);
  const p = page(d, pg);
  const bmp = q.FPDFBitmap_Create(w, h, 1);
  if (!bmp) throw new Error('Out of memory for a ' + w + '×' + h + ' render');
  try {
    q.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
    // 0x10 = RGBA byte order (straight into ImageData); 0x01 = annotations (only for thumbnails of other files)
    const flags = 0x10 | (annots ? 0x01 : 0);
    q.FPDF_RenderPageBitmap(bmp, p.ptr, -Math.round(x), -Math.round(y), Math.round(p.w * scale), Math.round(p.h * scale), 0, flags);
    const buf = q.FPDFBitmap_GetBuffer(bmp);
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

/** every character on the page with its box in page space (cached per page) */
export function chars(id: string, pg: number): CharInfo {
  const d = mustDoc(id);
  const p = page(d, pg);
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

export interface LinkInfo { rect: number[]; url?: string; page?: number }

export function links(id: string, pg: number): LinkInfo[] {
  const d = mustDoc(id);
  const p = page(d, pg);
  const q = Q();
  const out: LinkInfo[] = [];
  const pos = malloc(4), lk = malloc(4), rc = malloc(16);
  M().HEAP32[pos >> 2] = 0;
  try {
    while (q.FPDFLink_Enumerate(p.ptr, pos, lk)) {
      const link = M().HEAP32[lk >> 2];
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
      if (dest) info.page = q.FPDFDest_GetDestPageIndex(d.doc, dest);
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

const SNAP_MAX = 4e6;
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
  let seg = new Float32Array(1 << 18);
  let kd = new Uint8Array(1 << 16);
  let n = 0;
  /** path pieces seen so far (counted while indexing, not in a pass of its own: that cost seconds) */
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
  const curve = (x0: number, y0: number, c: number[]) => {
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
  const F = () => new Float32Array(M().HEAPU8.buffer);
  const mulM = (A: number[], B: number[]) => [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ];
  const visit = (obj: number, T: number[], depth: number) => {
    const type = q.FPDFPageObj_GetType(obj);
    if (type !== 2 && type !== 5) return;
    let Mx = [1, 0, 0, 1, 0, 0];
    if (q.FPDFPageObj_GetMatrix(obj, mat)) { const f = F(); const i = mat >> 2; Mx = [f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5]]; }
    const A = mulM(T, Mx);
    if (type === 5) {
      if (depth > 6) return;
      const c = q.FPDFFormObj_CountObjects(obj);
      for (let k = 0; k < c; k++) visit(q.FPDFFormObj_GetObject(obj, k), A, depth + 1);
      return;
    }
    const cnt = q.FPDFPath_CountSegments(obj);
    // (a page of tens of millions of line pieces: given up as soon as that's clear)
    if ((total += cnt) > SNAP_MAX) { n = 0; tooMany = true; return; }
    let sx = 0, sy = 0, px = 0, py = 0, has = false;
    /** the points of a curve being read (a curve comes as three points of type "bezier") */
    const bz: number[] = [];
    for (let k = 0; k < cnt; k++) {
      const sg = q.FPDFPath_GetPathSegment(obj, k);
      if (!q.FPDFPathSegment_GetPoint(sg, xy, xy + 4)) continue;
      const f = F();
      const ux = f[xy >> 2], uy = f[(xy >> 2) + 1];
      const X = A[0] * ux + A[2] * uy + A[4], Y = A[1] * ux + A[3] * uy + A[5];
      const t = q.FPDFPathSegment_GetType(sg);
      if (t === 2 || !has) { sx = X; sy = Y; has = true; bz.length = 0; }
      else if (t === 1) {
        bz.push(X, Y);
        // (the curve's start stays where it was until its last point is in)
        if (bz.length < 6) continue;
        curve(px, py, bz);
        bz.length = 0;
      } else push(px, py, X, Y);
      px = X; py = Y;
      if (q.FPDFPathSegment_GetClose(sg) && (px !== sx || py !== sy)) { push(px, py, sx, sy); px = sx; py = sy; }
    }
  };
  const count = q.FPDFPage_CountObjects(p.ptr);
  // a page of tens of millions of line pieces (a traced scan): no snapping there - reading them
  // all would take a minute and hundreds of MB
  for (let i = 0; i < count && !tooMany; i++) visit(q.FPDFPage_GetObject(p.ptr, i), p.aff, 0);
  if (tooMany) n = 0;
  free(mat); free(xy);
  const cols = 128, rows = Math.max(16, Math.round((128 * h) / w));
  const cw = w / cols, ch = h / rows;
  const counts = new Int32Array(cols * rows + 1);
  const cellsOf = (i: number, f: (c: number) => void) => {
    const x0 = Math.min(seg[i * 4], seg[i * 4 + 2]), x1 = Math.max(seg[i * 4], seg[i * 4 + 2]);
    const y0 = Math.min(seg[i * 4 + 1], seg[i * 4 + 3]), y1 = Math.max(seg[i * 4 + 1], seg[i * 4 + 3]);
    const c0 = Math.max(0, Math.floor(x0 / cw)), c1 = Math.min(cols - 1, Math.floor(x1 / cw));
    const r0 = Math.max(0, Math.floor(y0 / ch)), r1 = Math.min(rows - 1, Math.floor(y1 / ch));
    if (c1 < c0 || r1 < r0) return;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) f(r * cols + c);
  };
  for (let i = 0; i < n; i++) cellsOf(i, (c) => counts[c + 1]++);
  for (let c = 0; c < cols * rows; c++) counts[c + 1] += counts[c];
  const ids = new Int32Array(counts[cols * rows]);
  const fill = counts.slice();
  for (let i = 0; i < n; i++) cellsOf(i, (c) => (ids[fill[c]++] = i));
  const ix = { seg: seg.slice(0, n * 4), kind: kd.slice(0, n), n, cols, rows, cw, ch, start: counts, ids, w, h };
  d.snaps.set(pg, ix);
  // (a heavy A0 sheet's index is ~14 MB: the few sheets measured on last are kept)
  while (d.snaps.size > 6) { const old = d.snaps.keys().next().value as number; d.snaps.delete(old); holdSnap(d, old, null); }
  holdSnap(d, pg, ix);
  return ix;
}

/** nearest line end / middle / point on a line within r points */
export function snapAt(ix: SnapIndex, x: number, y: number, r: number): { x: number; y: number; k: 'end' | 'mid' | 'on' } | null {
  const c0 = Math.max(0, Math.floor((x - r) / ix.cw)), c1 = Math.min(ix.cols - 1, Math.floor((x + r) / ix.cw));
  const r0 = Math.max(0, Math.floor((y - r) / ix.ch)), r1 = Math.min(ix.rows - 1, Math.floor((y + r) / ix.ch));
  let bestEnd = r * r, end: [number, number] | null = null;
  let bestMid = (r * 0.7) ** 2, mid: [number, number] | null = null;
  let bestOn = (r * 0.6) ** 2, on: [number, number] | null = null;
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
      }
    }
  }
  if (end) return { x: end[0], y: end[1], k: 'end' };
  if (mid) return { x: mid[0], y: mid[1], k: 'mid' };
  if (on) return { x: on[0], y: on[1], k: 'on' };
  return null;
}

export function snap(id: string, pg: number, x: number, y: number, r: number) {
  return snapAt(buildSnap(id, pg), x, y, r);
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
