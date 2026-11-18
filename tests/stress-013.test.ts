// 0.13 stress run (Deep ritual, real tender files in the PC's VM): after Insert pages of a big file
// into a small one, the drawing copy (and every save) was built whole in MuPDF's memory - chosen by
// the size of the file the document was opened from, not by what it had become - and failed
// ("realloc (827430261 bytes) failed": 200 sheets of a 522 MB set into a 53 MB file). Generated
// files only: small ones with the limits lowered (setWholeAt, setStreamSaveForTests), the real size
// with PDFED_BIG_TESTS=1.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { VFile } from '../src/engine/files';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-013-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
const MB = 1e6;

/** `pages` pages, each with its own picture of about `bytes` bytes that does not compress (as a
 *  scanned or rendered set): written as text and random bytes, without MuPDF */
function imageSet(file: string, pages: number, bytes: number): string {
  const side = Math.max(1, Math.floor(Math.sqrt(bytes)));
  const fd = fs.openSync(file, 'w');
  let pos = 0;
  const offs: number[] = [];
  const put = (b: string | Uint8Array) => { const v = typeof b === 'string' ? Buffer.from(b, 'latin1') : b; fs.writeSync(fd, v); pos += v.length; };
  const obj = (k: number, body: string, stream?: Uint8Array) => {
    offs[k] = pos;
    put(`${k} 0 obj\n${body}`);
    if (stream) { put('\nstream\n'); put(stream); put('\nendstream'); }
    put('\nendobj\n');
  };
  put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  const page = (i: number) => 3 + 3 * i;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${page(i)} 0 R`).join(' ')}] >>`);
  for (let i = 0; i < pages; i++) {
    const p = page(i), c = `q 500 0 0 500 50 50 cm /Im0 Do Q BT /F1 12 Tf 50 20 Td (sheet ${i}) Tj ET`;
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << /XObject << /Im0 ${p + 1} 0 R >> /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${p + 2} 0 R >>`);
    obj(p + 1, `<< /Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${side * side} >>`, crypto.randomBytes(side * side));
    obj(p + 2, `<< /Length ${c.length} >>`, Buffer.from(c, 'latin1'));
  }
  const x = pos, n = offs.length;
  put(`xref\n0 ${n}\n0000000000 65535 f \n` + offs.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  put(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`);
  fs.closeSync(fd);
  return file;
}

/** the drawing copy as the engine host asks for it: { whole: written in pieces, else the changes past `base` } */
function drawingCopy(id: string) {
  const parts: Uint8Array[] = [];
  let whole = false;
  const r = mu.snapshotTo(id, (v) => { parts.push(v.slice()); }, false, (fill) => { whole = true; fill((b) => parts.push(typeof b === 'string' ? Buffer.from(b, 'latin1') : b.slice())); });
  return { whole, base: r.base, bytes: new Uint8Array(Buffer.concat(parts)) };
}
/** pages of a PDF (bytes) and the size of the last page's picture */
function pagesOf(b: Uint8Array): { pages: number; lastPicture: number } {
  const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  try {
    const n = d.countPages();
    const im = d.findPage(n - 1).get('Resources').get('XObject').get('Im0');
    return { pages: n, lastPicture: im.readRawStream().getLength() };
  } finally { d.destroy?.(); }
}

test('the drawing copy after pages of a big file are inserted into a small one is written whole in pieces (by what the document became, not the file it was opened from)', () => {
  const small = imageSet(path.join(scratch, 'small.pdf'), 6, 0.1 * MB);
  const big = imageSet(path.join(scratch, 'big.pdf'), 20, 0.5 * MB);
  mu.setWholeAt(12 * MB);
  try {
    mu.open('d1', new VFile({ path: small }));
    // a page or two of it: still "original + changes" (a few hundred KB written, not the whole file)
    mu.insertFrom('d1', 6, new VFile({ path: big }), [0]);
    const few = drawingCopy('d1');
    assert.equal(few.whole, false, 'a small insert keeps the changes-only copy');
    assert.ok(few.base > 0);
    // all 20 (10 MB in a 1 MB file): past the limit as it now stands - a whole copy, in pieces
    mu.insertFrom('d1', 7, new VFile({ path: big }));
    const all = drawingCopy('d1');
    assert.equal(all.whole, true, 'the drawing copy of the grown document is written whole in pieces (old code: "original + changes" built in memory)');
    assert.equal(all.base, 0);
    const got = pagesOf(all.bytes);
    assert.equal(got.pages, 27);
    assert.ok(got.lastPicture >= 0.49 * MB, 'the inserted pictures are in the copy');
  } finally { mu.close('d1'); mu.setWholeAt(600e6); }
});

test('at full size (PDFED_BIG_TESTS=1): 200 pages of a 520 MB set inserted into a 50 MB file, then the drawing copy', { skip: !process.env.PDFED_BIG_TESTS }, () => {
  const small = imageSet(path.join(scratch, 'small50.pdf'), 497, 0.1 * MB);
  const big = imageSet(path.join(scratch, 'big520.pdf'), 200, 2.6 * MB);
  try {
    mu.open('d2', new VFile({ path: small }));
    mu.insertFrom('d2', 497, new VFile({ path: big }));
    // (old code: "realloc (827430261 bytes) failed")
    const target = path.join(scratch, 'copy.pdf');
    const fd = fs.openSync(target, 'w');
    let whole = false;
    try { mu.snapshotTo('d2', (v) => { fs.writeSync(fd, v); }, false, (fill) => { whole = true; fill((b) => { fs.writeSync(fd, typeof b === 'string' ? Buffer.from(b, 'latin1') : b); }); }); } finally { fs.closeSync(fd); }
    assert.equal(whole, true);
    const d = mupdf.Document.openDocument(fs.readFileSync(target), 'application/pdf');
    assert.equal(d.countPages(), 697);
    d.destroy?.();
    fs.rmSync(target, { force: true });
  } finally { mu.close('d2'); fs.rmSync(big, { force: true }); }
});

/** a save as the editing engine makes it (bytes: no sink set) */
const written = (b: Uint8Array) => { const t = Buffer.from(b.subarray(0, Math.min(b.length, 64 << 20))).toString('latin1') + Buffer.from(b.subarray(Math.max(0, b.length - (8 << 20)))).toString('latin1'); return { inPieces: /\nxref\n0 \d+\n/.test(t) && !/\/ObjStm/.test(t) }; };

test('a save after pages of a big file are inserted into a small one is written in pieces (Save and Save as)', () => {
  const small = imageSet(path.join(scratch, 'small-s.pdf'), 6, 0.1 * MB);
  const big = imageSet(path.join(scratch, 'big-s.pdf'), 20, 0.5 * MB);
  mu.setStreamSaveForTests(12 * MB);
  try {
    mu.open('s1', new VFile({ path: small }));
    mu.insertFrom('s1', 6, new VFile({ path: big }));
    for (const incremental of [true, false]) {
      const b = mu.save('s1', { incremental });
      assert.equal(written(b).inPieces, true, `${incremental ? 'Save' : 'Save as'}: written in pieces (old code: MuPDF's save, built whole in memory)`);
      const got = pagesOf(b);
      assert.equal(got.pages, 26);
      assert.ok(got.lastPicture >= 0.49 * MB);
    }
  } finally { mu.close('s1'); mu.setStreamSaveForTests(0); }
});

test('at full size (PDFED_BIG_TESTS=1): Save after 200 pages of a 520 MB set were inserted into a 50 MB file', { skip: !process.env.PDFED_BIG_TESTS }, () => {
  const small = imageSet(path.join(scratch, 'small50s.pdf'), 497, 0.1 * MB);
  const big = imageSet(path.join(scratch, 'big520s.pdf'), 200, 2.6 * MB);
  const target = path.join(scratch, 'saved.pdf');
  try {
    mu.open('s2', new VFile({ path: small }));
    mu.insertFrom('s2', 497, new VFile({ path: big }));
    // (old code: "realloc (551620174 bytes) failed")
    const fd = fs.openSync(target, 'w');
    try { mu.withSink((v) => { fs.writeSync(fd, v); }, () => mu.save('s2', { incremental: true })); } finally { fs.closeSync(fd); }
    const d = mupdf.Document.openDocument(fs.readFileSync(target), 'application/pdf');
    assert.equal(d.countPages(), 697);
    d.destroy?.();
  } finally { mu.close('s2'); fs.rmSync(target, { force: true }); fs.rmSync(big, { force: true }); }
});

test('a save written in pieces lets go of what it looked at as it goes (JavaScript memory after it, in the same task)', async () => {
  // @ts-expect-error (a plain .mjs generator)
  const { makeLinkSet } = await import('./gen/linkset.mjs');
  const file = path.join(scratch, 'links.pdf');
  makeLinkSet(file, 100, 1000);
  const v8 = await import('node:v8');
  const vm = await import('node:vm');
  v8.setFlagsFromString('--expose_gc');
  const gc = vm.runInNewContext('gc') as () => void;
  mu.setStreamSaveForTests(1);
  try {
    mu.open('j1', new VFile({ path: file }));
    mu.createAnnot('j1', 0, { type: 'Square', rect: [10, 10, 60, 60], color: [1, 0, 0] });
    gc();
    const before = process.memoryUsage().heapUsed;
    // (no task boundary from here: the wrappers' finalizers can't run - what is still held is what the save keeps)
    const b = mu.save('j1', { incremental: true });
    gc();
    const held = (process.memoryUsage().heapUsed - before) / MB;
    assert.equal(written(b).inPieces, true);
    assert.ok(held < 40, `JavaScript memory held after the save: ${held.toFixed(0)} MB (old code: about 1.7 KB per link)`);
    const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
    try {
      assert.equal(d.countPages(), 100);
      assert.equal(d.findPage(99).get('Annots').length, 1000);
      assert.equal(d.findPage(0).get('Annots').length, 1001);
    } finally { d.destroy?.(); }
  } finally { mu.close('j1'); mu.setStreamSaveForTests(0); }
});
