// MuPDF (mupdf.js 1.28) reports errors by throwing a JavaScript exception from inside its
// WebAssembly code. The C stack is never unwound when that happens: every error leaks a few
// dozen bytes of MuPDF's stack, and after roughly a thousand errors the stack runs into
// MuPDF's own data - the engine then corrupts memory ("memory access out of bounds", wrong
// results, or a damaged save). Measured: 1,178-1,478 errors on mupdf 1.28.1.
//
// So: (1) the engine code avoids calls that fail in normal use (checks first), and (2) every
// error that does happen is counted here. Once too many have happened, the engine asks to be
// restarted at a safe moment - long before the limit (see host.ts).
import type * as M from 'mupdf';

let count = 0;
let depth = 0;
let trace: ((method: string, e: unknown) => void) | null = null;
/** tests: see which calls fail */
export function traceMupdfErrors(f: ((method: string, e: unknown) => void) | null) { trace = f; }
/** errors thrown by MuPDF since this engine started */
export const mupdfErrors = () => count;
/**
 * MuPDF's C stack pointer (exported by the .wasm patched in mupdf-pre.mjs): after an error the
 * guard sets it back to where it was before the call - nothing leaks, the restart below stays a
 * backstop. Without it every error leaks (counted in `leaks`).
 */
// (read when needed: MuPDF.js may finish starting after this module is loaded)
let SP: WebAssembly.Global | null = null;
const sp = () => SP ?? (SP = ((globalThis as { $mupdfExports?: { sp?: WebAssembly.Global } }).$mupdfExports?.sp) ?? null);
let leaks = 0;
/** errors whose leaked stack could not be put back (without the patch: every one) */
export const mupdfLeaks = () => leaks;
/** the stack pointer now (tests; -1 without the patch) */
export const mupdfStack = () => (sp() ? (SP!.value as number) : -1);
/** restart well before the ~1,200 where corruption starts */
export const MUPDF_ERROR_LIMIT = 400;

const CLASSES = ['Document', 'PDFDocument', 'Page', 'PDFPage', 'PDFAnnotation', 'PDFWidget', 'PDFObject', 'PDFGraftMap', 'Font', 'Image', 'Pixmap', 'ColorSpace', 'Buffer', 'StructuredText', 'DrawDevice', 'Device', 'DisplayList', 'OutlineIterator', 'Link', 'Stream', 'Path', 'Text'];

let done = false;
/** count every error that comes out of MuPDF (each one leaked a little of its stack) */
export function guardMupdf(mupdf: typeof M) {
  if (done) return;
  done = true;
  const lib = mupdf as unknown as Record<string, unknown>;
  for (const name of CLASSES) {
    const C = lib[name] as { prototype?: object } | undefined;
    if (!C || !C.prototype) continue;
    for (const proto of [C.prototype, C as object]) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(proto, key);
        if (!d || typeof d.value !== 'function' || !d.writable) continue;
        const f = d.value as (...a: unknown[]) => unknown;
        if ((f as { __guarded?: boolean }).__guarded) continue;
        const g = function (this: unknown, ...a: unknown[]) {
          depth++;
          // (the stack pointer as it was before the outermost call: put back after an error)
          const sp0 = depth === 1 && sp() ? (SP!.value as number) : -1;
          // counted once, where it leaves MuPDF (not again by every wrapper it passes through)
          try { return f.apply(this, a); } catch (e) {
            if (depth === 1) {
              count++;
              if (sp0 >= 0 && SP) { if (SP.value !== sp0) SP.value = sp0; } else leaks++;
              if (trace) trace(key, e);
            }
            throw e;
          } finally { depth--; }
        };
        (g as { __guarded?: boolean }).__guarded = true;
        try { Object.defineProperty(proto, key, { ...d, value: g }); } catch { /* frozen: leave it */ }
      }
    }
  }
}
