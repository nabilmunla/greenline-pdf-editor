// The editing engine's .wasm patched at start (mupdf-pre.mjs, docs/ENGINE-STUDY.md; 0.12, the user:
// "do the 4GB fix here"): files from 2 up to 4 GB open (positions unsigned), 4 GB and more are refused
// with a message; MuPDF errors no longer leak its C stack (the guard puts the pointer back).
// Sparse files: the gigabytes are a hole, no disk is used.
import '../src/engine/mupdf-pre.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { openSync, writeSync, closeSync, ftruncateSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import * as pf from '../src/engine/pdfium';
import { VFile } from '../src/engine/files';
import { guardMupdf, mupdfErrors, mupdfLeaks, mupdfStack } from '../src/engine/mupdf-guard';
import { patchMupdf } from '../src/engine/mupdf-pre.mjs';

guardMupdf(mupdf);
const TMP = resolve('tests/tmp-4gb');
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));

/**
 * A two-page PDF whose second page (and the cross-reference table) sit past `gap` bytes of a dummy
 * stream: the hole is never written (a sparse file).
 */
function sparsePdf(name: string, gap: number): string {
  const p = join(TMP, name);
  const fd = openSync(p, 'w');
  let at = 0;
  const offs: number[] = [];
  const put = (s: string) => { const b = Buffer.from(s, 'latin1'); writeSync(fd, b, 0, b.length, at); at += b.length; };
  const page = (n: number, text: string) => {
    const c = `BT /F1 40 Tf 60 400 Td (${text}) Tj ET 0 0 1 rg 60 100 200 100 re f`;
    offs[n] = at; put(`${n} 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 3 0 R>>>>/Contents ${n + 1} 0 R>>\nendobj\n`);
    offs[n + 1] = at; put(`${n + 1} 0 obj\n<</Length ${c.length}>>\nstream\n${c}\nendstream\nendobj\n`);
  };
  put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  offs[1] = at; put('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n');
  offs[2] = at; put('2 0 obj\n<</Type/Pages/Kids[4 0 R 7 0 R]/Count 2>>\nendobj\n');
  offs[3] = at; put('3 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n');
  page(4, 'FIRST PAGE');
  // a dummy stream of `gap` bytes, never written
  offs[6] = at; put(`6 0 obj\n<</Length ${gap}>>\nstream\n`);
  at += gap;
  put('\nendstream\nendobj\n');
  page(7, 'PAGE PAST THE GAP');
  const xref = at;
  let t = `xref\n0 9\n0000000000 65535 f \n`;
  for (let k = 1; k <= 8; k++) t += `${String(offs[k]).padStart(10, '0')} 00000 n \n`;
  put(t + `trailer\n<</Size 9/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
  ftruncateSync(fd, at);
  closeSync(fd);
  return p;
}

test('the installed MuPDF .wasm takes the three patches, exactly once each', () => {
  const p = resolve('node_modules/mupdf/dist/mupdf-wasm.wasm');
  const b = readFileSync(p);
  const r = patchMupdf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  // (PLAN 14.7: bomb - a build where its bytes are not found fails here, not at a user's)
  assert.deepEqual([r.unsigned, r.sp, r.bomb, r.notes], [true, true, true, []]);
  assert.ok(WebAssembly.validate(new Uint8Array(r.bytes)), 'still a valid module');
  // a copy already patched: the seek test is no longer there - left as it is, said so
  const again = patchMupdf(r.bytes);
  assert.equal(again.unsigned, false);
  assert.equal(again.bomb, false);
  assert.ok(again.notes.some((n: string) => /seek test was found 0 times/.test(n)));
  assert.ok(again.notes.some((n: string) => /size limit was found 0 times/.test(n)));
  // in use here (mupdf-pre.mjs ran first)
  assert.deepEqual((globalThis as { $mupdfPatch?: unknown }).$mupdfPatch, { unsigned: true, sp: true, bomb: true });
  assert.equal(mu.openLimit(), 2 ** 32 - 1);
});

test('a 2.05 GB file opens in both engines; its page past 2 GB is read, drawn and marked up', async () => {
  const f = sparsePdf('two-gb.pdf', Math.round(2.05 * 2 ** 30));
  const vf = new VFile({ path: f });
  assert.ok(vf.size > 2 ** 31);
  const info = mu.open('g2', vf, undefined, 'Tester');
  assert.equal(info.pages.length, 2);
  assert.equal(info.repaired, false, 'read through its own index, not rebuilt');
  assert.match(mu.textBlocks('g2', 1).map((b) => b.lines.map((l) => l.text).join(' ')).join(' '), /PAGE PAST THE GAP/);
  const a = mu.createAnnot('g2', 1, { type: 'Square', rect: [100, 100, 200, 160], color: [1, 0, 0] });
  assert.ok(a.id > 0);
  assert.equal(mu.annots('g2', 1).length, 1);
  mu.close('g2');
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  pf.openDoc('g2p', new VFile({ path: f }));
  const px = pf.render('g2p', 1, 1, 0, 0, 595, 842);
  const i = ((842 - 150) * 595 + 160) * 4; // the blue box on page 2
  assert.ok(px[i + 2] > 200 && px[i] < 60, 'the page past 2 GB drawn: ' + [px[i], px[i + 1], px[i + 2]]);
  pf.closeDoc('g2p');
});

test('4 GB and more: refused with a message, nothing thrown from inside MuPDF', () => {
  const f = sparsePdf('four-gb.pdf', 2 ** 32 + 10);
  const vf = new VFile({ path: f });
  assert.throws(() => mu.open('g4', vf, undefined, 'Tester'), /4 GB or more can't be opened here/);
  vf.close?.();
});

test('MuPDF errors no longer leak its stack', () => {
  const sp0 = mupdfStack();
  assert.ok(sp0 > 0, 'the stack pointer is readable');
  const e0 = mupdfErrors(), l0 = mupdfLeaks();
  const junk = new Uint8Array(200).fill(7);
  for (let k = 0; k < 5000; k++) { try { mupdf.Document.openDocument(junk, 'application/pdf'); } catch { /* expected */ } }
  assert.ok(mupdfErrors() - e0 >= 5000, 'the errors happened: ' + (mupdfErrors() - e0));
  assert.equal(mupdfLeaks() - l0, 0, 'none leaked');
  assert.equal(mupdfStack(), sp0, 'the stack pointer where it was');
  // and MuPDF still works
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 100, 100], 0, {}, ''));
  assert.equal(mupdf.Document.openDocument(d.saveToBuffer('').asUint8Array().slice(), 'application/pdf').countPages(), 1);
});
