// MuPDF.js 1.28.1 keeps every PDF object it wraps twice and lets go of it once (PLAN 10.19), so
// nothing a wrapper ever touched is freed: merge, extract, insert, every edit.
//   - the PDFObject constructor keeps the pointer it is given; destroy() and the garbage
//     collector's finalizer drop it once;
//   - PDFDocument._fromPDFObjectNew hands the constructor a reference the C call made for it
//     (owned): 2 held, 1 dropped;
//   - PDFDocument._fromPDFObjectKeep keeps a borrowed pointer and the constructor keeps it again:
//     the same.
// The rule here: one wrapper = exactly one reference, dropped by destroy() or the finalizer.
// Fixed in the two helpers (every wrapper but getTrailer's is made through them; getTrailer's is
// right as it is), the constructor left alone - a class constructor cannot be swapped from outside
// without editing MuPDF.js's text:
//   _fromPDFObjectKeep(ptr): wrapped - the constructor's keep is the one keep;
//   _fromPDFObjectNew(ptr):  wrapped, then dropped once - what is left is the reference handed over.
// Exact match or nothing (as mupdf-pre.mjs): only when the text of both helpers and of the
// constructor is today's double keep, and a probe agrees (a throwaway document's new dictionary
// held twice before, once after; a borrowed one +2 a wrapper before, +1 after). Otherwise nothing is
// changed and refsFixed() is false - a MuPDF.js that fixed it itself is so never dropped twice.
// PDFED_OFF=mupdfrefs leaves it out too (support).
// Memory now falls when a wrapper is destroyed or collected; collection needs the event loop to
// yield, so a long synchronous loop frees only what it destroy()s itself.
import type * as M from 'mupdf';

type Helper = (this: unknown, ptr: number) => unknown;
type DocProto = { _fromPDFObjectNew: Helper; _fromPDFObjectKeep: Helper };
type ObjClass = { new (doc: unknown, ptr: number): unknown; Null: unknown; _drop(ptr: number): void };

/** today's text (whitespace aside) of the two helpers and of the PDFObject constructor */
const NEW_TEXT = '_fromPDFObjectNew(ptr) { if (ptr === 0) return PDFObject.Null; return new PDFObject(this, ptr); }';
const KEEP_TEXT = '_fromPDFObjectKeep(ptr) { if (ptr === 0) return PDFObject.Null; return new PDFObject(this, libmupdf._wasm_pdf_keep_obj(ptr)); }';
const CTOR_TEXT = 'constructor(doc, pointer) { super(libmupdf._wasm_pdf_keep_obj(pointer)); this._doc = doc; }';
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** MuPDF's own objects (its built-in names, true, false, null) are numbers under this, not memory */
const NOT_MEMORY = 65536;
/** pdf_obj's kind byte (offset 2): int, real, string, name, array, dict, indirect reference */
const KINDS = new Set([...'ifsnadr'].map((c) => c.charCodeAt(0)));

let lib: typeof M | null = null;
let state: { fixed: boolean; note: string } | null = null;
let on = false;
let probeBuf: { asUint8Array(): Uint8Array } | null = null;

/** MuPDF's memory as bytes (read afresh: it moves when it grows) */
function memory(): Uint8Array | null {
  const m = (globalThis as { $libmupdf_wasm_Module?: { HEAPU8?: Uint8Array } }).$libmupdf_wasm_Module?.HEAPU8;
  if (m && m.buffer.byteLength) return m;
  // (MuPDF.js loaded before mupdf-pre.mjs: a buffer's bytes are a view of the same memory)
  try {
    if (!probeBuf && lib) probeBuf = new lib.Buffer() as unknown as { asUint8Array(): Uint8Array };
    const v = probeBuf?.asUint8Array();
    return v ? new Uint8Array(v.buffer) : null;
  } catch { return null; }
}

/**
 * How many references MuPDF holds on the object `obj` wraps: its `short refs`, the first field of
 * every pdf_obj (proved in tests/refs.test.ts: N wrappers of one object move this number, and only
 * this one, by N). -1 when it is not memory: MuPDF's built-in names, true / false / null, a
 * destroyed wrapper, or bytes that do not read as an object.
 */
export function refsOf(obj: unknown): number {
  const p = (obj as { pointer?: unknown } | null | undefined)?.pointer;
  if (typeof p !== 'number' || p < NOT_MEMORY) return -1;
  const m = memory();
  if (!m || p + 4 > m.length || !KINDS.has(m[p + 2])) return -1;
  return ((m[p] | (m[p + 1] << 8)) << 16) >> 16;
}

/** the fix is in (refsFixed() false: MuPDF.js as it came, every wrapper leaking one reference) */
export function refsFixed(): boolean { return !!state?.fixed && on; }
/** why it is not in, or '' */
export function refsNote(): string { return state?.note ?? 'not looked at yet'; }

/**
 * Put the fix in, once (later calls give the first answer). Before guardMupdf: it reads the
 * helpers' own text, which the guard replaces with its wrappers.
 */
export function fixMupdfRefs(mupdf: typeof M): { fixed: boolean; note: string } {
  if (state) return state;
  lib = mupdf;
  // (support: PDFED_OFF=mupdfrefs leaves MuPDF.js as it came, as mupdfpatch does its .wasm)
  if (typeof process !== 'undefined' && String(process.env?.PDFED_OFF || '').split(',').includes('mupdfrefs')) return (state = { fixed: false, note: 'switched off (PDFED_OFF=mupdfrefs): left as they are' });
  const P = (mupdf as unknown as { PDFObject?: ObjClass }).PDFObject;
  const D = (mupdf as unknown as { PDFDocument?: { prototype: DocProto } }).PDFDocument;
  const no = (note: string) => (state = { fixed: false, note });
  if (!P || !D) return no('MuPDF.js has no PDFObject / PDFDocument');
  const proto = D.prototype;
  const oldNew = proto._fromPDFObjectNew, oldKeep = proto._fromPDFObjectKeep;
  if (typeof oldNew !== 'function' || typeof oldKeep !== 'function') return no('MuPDF.js has no _fromPDFObjectNew / _fromPDFObjectKeep');
  const ctor = flat(Function.prototype.toString.call(P));
  if (flat(Function.prototype.toString.call(oldNew)) !== NEW_TEXT || flat(Function.prototype.toString.call(oldKeep)) !== KEEP_TEXT || ctor.split(CTOR_TEXT).length !== 2)
    return no('MuPDF.js wraps PDF objects differently from 1.28.1: its references are left as they are');
  // the probe: what MuPDF.js does now must be the double keep
  const before = probe(mupdf);
  if (!before || before.made !== 2 || before.borrowed !== 2) return no(`MuPDF.js's references read ${before ? `${before.made} / +${before.borrowed}` : 'nothing'}, not 2 / +2: left as they are`);
  const fixedNew: Helper = function (ptr) {
    if (ptr === 0) return P.Null;
    const o = new P(this, ptr);
    // (the constructor kept it: the reference the C call handed over goes)
    P._drop(ptr);
    return o;
  };
  const fixedKeep: Helper = function (ptr) { return ptr === 0 ? P.Null : new P(this, ptr); };
  // (switchable for tests: setRefsFixForTests)
  const nNew: Helper = function (ptr) { return (on ? fixedNew : oldNew).call(this, ptr); };
  const nKeep: Helper = function (ptr) { return (on ? fixedKeep : oldKeep).call(this, ptr); };
  proto._fromPDFObjectNew = nNew;
  proto._fromPDFObjectKeep = nKeep;
  on = true;
  const after = probe(mupdf);
  if (!after || after.made !== 1 || after.borrowed !== 1) {
    proto._fromPDFObjectNew = oldNew;
    proto._fromPDFObjectKeep = oldKeep;
    on = false;
    return no(`with the fix MuPDF.js's references read ${after ? `${after.made} / +${after.borrowed}` : 'nothing'}, not 1 / +1: taken out again`);
  }
  return (state = { fixed: true, note: '' });
}

/** a throwaway document: a new dictionary's references, and what one more wrapper of a borrowed one adds */
function probe(mupdf: typeof M): { made: number; borrowed: number } | null {
  let doc: M.PDFDocument | null = null;
  try {
    doc = new mupdf.PDFDocument();
    const outer = doc.newDictionary();
    const inner = doc.newDictionary();
    const made = refsOf(inner);
    outer.put('K', inner);
    const a = refsOf(inner);
    const got = outer.get('K');
    const borrowed = refsOf(inner) - a;
    got.destroy(); inner.destroy(); outer.destroy();
    return made > 0 ? { made, borrowed } : null;
  } catch { return null; } finally { try { doc?.destroy(); } catch { /* gone */ } }
}

/**
 * Tests: switch the fix off (false) or back on. Safe at any moment: a wrapper made either way
 * drops what it holds - one made with the fix off just keeps leaking its extra reference.
 * A no-op when the fix is not in.
 */
export function setRefsFixForTests(fix: boolean): boolean {
  if (state?.fixed) on = fix;
  return refsFixed();
}
