// Damaged files: sample PDFs cut short, with bytes flipped, xref damaged, garbage, empty - each
// opened by both engines (MuPDF edit, PDFium draw) and drawn. Expected: open + draw, or a clean
// error. Not expected: hangs, crashes, engines that stop working for the next (good) file.
// npx tsx tests/fuzz-files.ts [cases]
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import * as pf from '../src/engine/pdfium';
import { guardMupdf } from '../src/engine/mupdf-guard';

guardMupdf(mupdf);
mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));
const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
const N = Number(process.argv[2] || 120);
let s = 12345;
const R = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const srcs = ['tests/data/long-spec.pdf', 'tests/data/scan.pdf', 'tests/data/heavy-a0.pdf'].map((f) => new Uint8Array(readFileSync(f)));
const good = srcs[0];
let bad = 0, opened = 0, refused = 0;
function mutate(b: Uint8Array, k: number): Uint8Array {
  const c = b.slice();
  switch (k % 6) {
    case 0: return c.subarray(0, Math.floor(R() * c.length)); // cut short
    case 1: for (let i = 0; i < 40; i++) c[Math.floor(R() * c.length)] = Math.floor(R() * 256); return c; // flipped bytes
    case 2: { const t = new TextDecoder('latin1').decode(c.subarray(c.length - 2048)); const i = t.lastIndexOf('startxref'); if (i >= 0) c[c.length - 2048 + i + 12] = 0x39; return c; } // wrong startxref
    case 3: return c.subarray(Math.floor(R() * 1000)); // header missing
    case 4: { const z = new Uint8Array(Math.floor(R() * 5000)); for (let i = 0; i < z.length; i++) z[i] = Math.floor(R() * 256); return z; } // garbage
    default: { for (let i = 0; i < 400; i++) { const p = Math.floor(R() * c.length); c[p] = 0; } return c; } // zeroed bytes
  }
}
for (let k = 0; k < N; k++) {
  const b = mutate(srcs[k % srcs.length], k);
  const t0 = Date.now();
  let ok1 = false;
  try {
    const info = mu.open('f', b);
    if (info.pages.length) mu.annots('f', 0);
    mu.save('f');
    mu.close('f');
    ok1 = true;
  } catch { try { mu.close('f'); } catch { /* not open */ } }
  try {
    const inf = pf.openDoc('p', b);
    if (inf.pages.length) pf.render('p', 0, 0.2, 0, 0, 100, 100, true);
    pf.closeDoc('p');
  } catch { try { pf.closeDoc('p'); } catch { /* not open */ } }
  if (ok1) opened++; else refused++;
  const ms = Date.now() - t0;
  if (ms > 20000) { console.log(`SLOW case ${k} (kind ${k % 6}): ${ms} ms`); bad++; }
  // the engines still work for a good file
  try { mu.open('g', good); mu.close('g'); pf.openDoc('g', good); pf.render('g', 0, 0.2, 0, 0, 50, 50); pf.closeDoc('g'); } catch (e) { console.log(`BROKEN after case ${k} (kind ${k % 6}): ${String((e as Error).message).slice(0, 160)}`); bad++; break; }
}
console.log(`${N} damaged files: ${opened} opened (repaired), ${refused} refused cleanly, ${bad} problems`);
process.exit(bad ? 1 : 0);
