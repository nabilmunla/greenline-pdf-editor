// PLAN 1.4 (AUDIT B4): a page PDFium cannot size gets a default size (not its neighbour's, not
// leftover memory), a failed open leaves nothing registered, and closeDoc releases everything
// even when closing one page throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as pf from '../src/engine/pdfium';
import type { Reader } from '../src/engine/files';

const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

/** a PDF written by hand (as in fuzz-evil.ts): objects as strings, xref computed */
function raw(objs: string[]): Uint8Array {
  let out = '%PDF-1.7\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array([...out].map((c) => c.charCodeAt(0) & 255));
}
const page = (mb: string) => `<< /Type /Page /Parent 2 0 R /MediaBox ${mb} /Contents 5 0 R >>`;
const content = '<< /Length 17 >>\nstream\n0 0 m 10 10 l S \nendstream';
/** three kids: a 300 x 400 page, one that is not a page at all (object 9 does not exist), a 500 x 600 page */
const broken = (kids: string) => raw(['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count 3 >>`, page('[0 0 300 400]'), page('[0 0 500 600]'), content]);

/** spy on the engine's malloc/free (its export table is read-only: the module object is swapped for one that inherits from it) */
function spyMemory() {
  const e = pf.engineForTests();
  const orig = e.pdfium;
  const mallocs: number[] = [], frees: number[] = [];
  const ex = orig.wasmExports;
  const wasmExports = Object.create(ex, {
    malloc: { value: (n: number) => { const p = ex.malloc(n); mallocs.push(p >>> 0); return p; } },
    free: { value: (p: number) => { frees.push(p >>> 0); ex.free(p); } },
  });
  e.pdfium = Object.create(orig, { wasmExports: { value: wasmExports } });
  return { mallocs, frees, stop: () => { e.pdfium = orig; } };
}

test('1.4: an unsizable page in the middle gets the default size, not the page before it', () => {
  const info = pf.openDoc('p14a', broken('3 0 R 9 0 R 4 0 R'));
  assert.equal(info.pages.length, 3);
  assert.deepEqual(info.pages[0], { w: 300, h: 400 });
  assert.deepEqual(info.pages[1], { w: 595, h: 842 });
  assert.deepEqual(info.pages[2], { w: 500, h: 600 });
  pf.closeDoc('p14a');
  assert.deepEqual(pf.openIds(), []);
});

test('1.4: an unsizable first page gets the default size (not an uncleared buffer)', () => {
  // dirty the memory a 16-byte buffer is likely to reuse
  const give = pf.holdMemory(16);
  give();
  const info = pf.openDoc('p14b', broken('9 0 R 3 0 R 4 0 R'));
  assert.deepEqual(info.pages[0], { w: 595, h: 842 });
  assert.deepEqual(info.pages[1], { w: 300, h: 400 });
  pf.closeDoc('p14b');
});

test('1.4: a throw while sizing pages leaves nothing registered, frees what was taken, keeps the old copy', () => {
  pf.openDoc('p14c', broken('3 0 R 4 0 R 3 0 R'));
  const e = pf.engineForTests();
  const spy = spyMemory();
  const oSize = e.FPDF_GetPageSizeByIndexF as (...a: number[]) => number;
  let calls = 0;
  e.FPDF_GetPageSizeByIndexF = (...a: number[]) => { if (++calls === 2) throw new Error('boom'); return oSize(...a); };
  try {
    const fresh = broken('3 0 R 4 0 R 3 0 R');
    assert.throws(() => pf.openDoc('p14c', fresh), /boom/);
  } finally {
    e.FPDF_GetPageSizeByIndexF = oSize;
    spy.stop();
  }
  // the old copy is still open and every buffer the failed open took was given back
  assert.deepEqual(pf.openIds(), ['p14c']);
  assert.equal(pf.pageText('p14c', 0), '');
  assert.deepEqual(spy.mallocs.filter((p) => !spy.frees.includes(p)), [], 'every buffer taken by the failed open was freed');
  assert.ok(spy.mallocs.length >= 2, 'the open did take buffers (source and size buffer)');
  // a failed first open of a new id leaves no trace in the list
  e.FPDF_GetPageSizeByIndexF = () => { throw new Error('boom'); };
  try { assert.throws(() => pf.openDoc('p14d', broken('3 0 R 4 0 R 3 0 R')), /boom/); } finally { e.FPDF_GetPageSizeByIndexF = oSize; }
  assert.deepEqual(pf.openIds(), ['p14c']);
  pf.closeDoc('p14c');
});

test('1.4: closeDoc releases everything even if FPDF_ClosePage throws', () => {
  const bytes = broken('3 0 R 4 0 R 3 0 R');
  let closed = 0;
  const reader: Reader = { size: bytes.length, read: (buf, off, len, pos) => { buf.set(bytes.subarray(pos, pos + len), off); return len; }, close: () => { closed++; } };
  pf.openDoc('p14e', reader);
  // load two pages into the page cache
  pf.chars('p14e', 0); pf.chars('p14e', 1);
  const e = pf.engineForTests();
  const oClose = e.FPDF_ClosePage as (p: number) => void, oDoc = e.FPDF_CloseDocument as (p: number) => void;
  const spy = spyMemory();
  let pageCloses = 0, docCloses = 0;
  e.FPDF_ClosePage = (p: number) => { pageCloses++; oClose(p); throw new Error('close failed'); };
  e.FPDF_CloseDocument = (p: number) => { docCloses++; oDoc(p); };
  const log = console.error; const logged: unknown[][] = [];
  console.error = (...a: unknown[]) => { logged.push(a); };
  try { pf.closeDoc('p14e'); } finally { e.FPDF_ClosePage = oClose; e.FPDF_CloseDocument = oDoc; spy.stop(); console.error = log; }
  assert.equal(pageCloses, 2, 'both pages were tried');
  assert.equal(docCloses, 1, 'the document was closed');
  assert.equal(spy.frees.length, 1, 'the file-access block (fa) was freed');
  assert.equal(closed, 1, 'the reader was closed');
  assert.deepEqual(pf.openIds(), [], 'the entry is gone');
  assert.equal(logged.length, 1, 'the failure was logged');
});
