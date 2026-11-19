// Loaded before MuPDF.js (the engine bundle's first import; tests import it first too).
// MuPDF.js builds its WebAssembly module on this object, which leaves two cheap journal
// functions reachable (where the undo journal is, how many steps it has): MuPDF.js's own
// getJournal() also reads every step's name, each found by walking the list from the start -
// with 2,000 undo steps each markup took 20 ms more, growing with the square of the steps.
// mu.ts uses them when they are there and getJournal() when not (MuPDF.js loaded first).
//
// It also hands MuPDF.js a patched copy of its .wasm (docs/ENGINE-STUDY.md; 0.12, the user:
// "do the 4GB fix here"), made at start - the file on disk is never changed:
//  1. file positions read as unsigned: MuPDF.js's stream glue passes them as signed 32-bit
//     numbers, so a file of 2 GB or more failed to open ("TRYLATER"); now up to 4 GB (the
//     drawing engine's own limit). One byte: the "negative = try later" test (i32.lt_s) becomes
//     an unsigned one (i32.lt_u) that never fires; the next instruction already reads it unsigned.
//  2. the C stack pointer exported: every MuPDF error is thrown out of the WebAssembly code
//     without unwinding it, leaking 64 bytes of a 64 KB stack each time (the engine was
//     restarted every 400 errors for it); mupdf-guard.ts now puts it back after each error.
//  3. (PLAN 14.7) no "compression bomb" limit of its own where the caller states none: MuPDF's
//     fz_read_best limits a stream loaded whole to `initial * 200` bytes (100 MiB at least) - a
//     size_t, 32 bits here, which wraps once `initial` passes 21.47 MB. A stream of L bytes over
//     100 MiB in a file was then refused ("compression bomb detected") when 200 × L mod 2^32 < L:
//     raw loads, MuPDF's own save, a decoded Flate load (600 × L). Six bytes: "initial * 200"
//     becomes all ones (no limit); a limit the caller states (an image: width × height) stays.
//     A real bomb is still stopped, later (Fable, 18 Nov): a 2 KB stream packed twice (Flate on
//     Flate) that unpacks to 1 GB was refused as a "bomb" at 431 MiB of engine memory before; now
//     it ends in a handled "realloc ... failed" at 1,746 MiB after 2.5 s, and the document still
//     answers. 3 GB packed once reaches 1,897 MiB either way. The bound is the .wasm's memory
//     maximum (2 GiB) and MuPDF's handled realloc failure.
// Exact match or nothing: a byte pattern that is not there exactly once (another MuPDF.js build)
// leaves the .wasm as it is - with today's limits - and the log says so.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

globalThis.$libmupdf_wasm_Module ??= {};

/** js_stm_seek's "n < 0 -> try later": ... local.tee 3, i32.const 0, i32.lt_s (+6), if ... */
const SEEK_TEST = [0x10, 0x00, 0x22, 0x03, 0x41, 0x00, 0x48, 0x04, 0x40, 0x20, 0x00, 0x41, 0x09];
const LT_S = 0x48, LT_U = 0x49;
/** fz_read_best's "worst_case ? worst_case : initial * 200": local.get 3, local.get 2, i32.const 200,
 *  i32.mul, local.get 3, select, local.set 13 (+2: "local.get 2, i32.const 200, i32.mul" becomes
 *  "i32.const -1" - all ones - and four nops) */
const BOMB_TEST = [0x20, 0x03, 0x20, 0x02, 0x41, 0xc8, 0x01, 0x6c, 0x20, 0x03, 0x1b, 0x21, 0x0d];
const BOMB_NONE = [0x41, 0x7f, 0x01, 0x01, 0x01, 0x01];

function leb(b, i) { let r = 0, k = 0; for (;;) { const x = b[i++]; r += (x & 0x7f) * 2 ** k; k += 7; if (x < 0x80 || k > 35) return [r, i]; } }
function lebBytes(n) { const out = []; do { let x = n % 128; n = Math.floor(n / 128); if (n) x |= 0x80; out.push(x); } while (n); return out; }
function findAll(b, pat) {
  const at = [];
  outer: for (let i = b.indexOf(pat[0]); i >= 0 && i <= b.length - pat.length; i = b.indexOf(pat[0], i + 1)) {
    for (let k = 1; k < pat.length; k++) if (b[i + k] !== pat[k]) continue outer;
    at.push(i);
  }
  return at;
}

/**
 * The patched copy: { bytes, unsigned, sp, bomb, notes }. `unsigned`: file positions up to 4 GB;
 * `sp`: the stack pointer is exported as "sp" (global 0, the mutable i32 every emscripten build
 * keeps it in); `bomb`: no stream-length limit of its own (3. above). Any may be false (left as
 * it is), never half-done.
 */
export function patchMupdf(input) {
  let b = new Uint8Array(input);
  const notes = [];
  if (b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) return { bytes: input, unsigned: false, sp: false, bomb: false, notes: ['not a wasm file'] };
  let unsigned = false, sp = false, bomb = false;
  // 1. unsigned positions
  const hits = findAll(b, SEEK_TEST);
  if (hits.length === 1) { b = b.slice(); b[hits[0] + 6] = LT_U; unsigned = true; }
  else notes.push(`the stream seek test was found ${hits.length} times, not once: files stay under 2 GB`);
  // 3. no stream-length limit of its own (before 2: that one moves the code section)
  const bombs = findAll(b, BOMB_TEST);
  if (bombs.length === 1) { if (!unsigned) b = b.slice(); b.set(BOMB_NONE, bombs[0] + 2); bomb = true; }
  else notes.push(`the stream size limit was found ${bombs.length} times, not once: a stream over 100 MiB in a file may be refused ("compression bomb detected")`);
  // 2. the stack pointer as an export: global 0 must be a mutable i32, and no export may be called "sp"
  let i = 8, globalOk = false, exp = -1, expEnd = -1, expSizeAt = -1;
  while (i < b.length) {
    const id = b[i];
    const [size, at] = leb(b, i + 1);
    if (id === 6) { const [n, j] = leb(b, at); globalOk = n >= 1 && b[j] === 0x7f && b[j + 1] === 0x01; }
    if (id === 7) { exp = i; expSizeAt = i + 1; expEnd = at + size; }
    i = at + size;
  }
  if (globalOk && exp > 0) {
    const [size, at] = leb(b, expSizeAt);
    const [count, j] = leb(b, at);
    // (names already there: "sp" must be free)
    let k = j, taken = false;
    for (let e = 0; e < count; e++) { const [l, q] = leb(b, k); if (l === 2 && b[q] === 0x73 && b[q + 1] === 0x70) taken = true; k = q + l + 1; k = leb(b, k)[1]; }
    if (!taken && k === expEnd) {
      const body = [...lebBytes(count + 1), ...b.subarray(j, expEnd), 0x02, 0x73, 0x70, 0x03, 0x00];
      const sec = [0x07, ...lebBytes(body.length), ...body];
      const out = new Uint8Array(b.length - (expEnd - exp) + sec.length);
      out.set(b.subarray(0, exp), 0);
      out.set(sec, exp);
      out.set(b.subarray(expEnd), exp + sec.length);
      b = out;
      sp = true;
      void size;
    } else notes.push(taken ? 'an export is already called "sp"' : 'the export section did not read as expected');
  } else notes.push(globalOk ? 'no export section' : 'global 0 is not the stack pointer');
  if (!sp) notes.push('MuPDF errors still leak its stack (restart every 400 errors, as before)');
  return { bytes: unsigned || sp || bomb ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : input, unsigned, sp, bomb, notes };
}

function wasmPath() {
  // (the engine bundle: next to this file; tests and the dev tree: in the mupdf package)
  try { const here = fileURLToPath(new URL('./mupdf-wasm.wasm', import.meta.url)); if (existsSync(here)) return here; } catch { /* not a file URL */ }
  try { const p = join(dirname(createRequire(import.meta.url).resolve('mupdf')), 'mupdf-wasm.wasm'); if (existsSync(p)) return p; } catch { /* not installed here */ }
  return null;
}

const M = globalThis.$libmupdf_wasm_Module;
const off = String(process.env.PDFED_OFF || '').split(',').includes('mupdfpatch');
if (!off && !M.wasmBinary && !M.instantiateWasm) {
  const p = wasmPath();
  if (p) {
    const orig = readFileSync(p);
    const r = patchMupdf(orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.byteLength));
    globalThis.$mupdfPatch = { unsigned: r.unsigned, sp: r.sp, bomb: r.bomb };
    if (r.notes.length) console.error('MuPDF wasm: ' + r.notes.join('; '));
    if (r.unsigned || r.sp || r.bomb) {
      // (instantiated here so the exports - "sp" among them - are kept; a patched copy that
      // fails to compile falls back to the file as it is, never no engine at all)
      M.instantiateWasm = (imports, done) => {
        const use = ({ instance, module }) => { globalThis.$mupdfExports = instance.exports; done(instance, module); };
        WebAssembly.instantiate(r.bytes, imports).then(use, (e) => {
          console.error('MuPDF wasm: the patched copy failed (' + (e && e.message) + '), the file as it is');
          globalThis.$mupdfPatch = { unsigned: false, sp: false, bomb: false };
          return WebAssembly.instantiate(orig, imports).then(use);
        });
        return {};
      };
    }
  } else globalThis.$mupdfPatch = { unsigned: false, sp: false, bomb: false };
} else globalThis.$mupdfPatch ??= { unsigned: false, sp: false, bomb: false };
