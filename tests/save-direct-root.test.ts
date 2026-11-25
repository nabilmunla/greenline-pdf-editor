// PLAN 13.2.1 (F09): a save in pieces (files from 350 MB) wrote the trailer's /Root only when it
// was a reference to another object - a file whose catalogue sits straight in the trailer was saved
// without it and could not be opened again.
import '../src/engine/mupdf-pre.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { VFile } from '../src/engine/files';

const dir = mkdtempSync(join(tmpdir(), 'dr-'));
after(() => { mu.setStreamSaveForTests(0); rmSync(dir, { recursive: true, force: true }); });

/** a two-page PDF whose catalogue is written straight into the trailer (no object of its own) */
function directRootPdf(): Uint8Array {
  const objs = [
    '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 1 0 R /MediaBox [0 0 200 300] >>',
    '<< /Type /Page /Parent 1 0 R /MediaBox [0 0 300 200] >>',
  ];
  let s = '%PDF-1.7\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f\r\n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n\r\n').join('');
  s += `trailer\n<< /Size ${objs.length + 1} /Root << /Type /Catalog /Pages 1 0 R >> >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(s);
}

test('a catalogue straight in the trailer survives a save in pieces, and the file opens again', () => {
  const src = directRootPdf();
  assert.equal(new mupdf.PDFDocument(src.slice()).countPages(), 2, 'MuPDF reads the original');
  mu.setStreamSaveForTests(1);   // (every save goes in pieces)
  const p = join(dir, 'direct-root.pdf');
  writeFileSync(p, src);
  mu.open('dr', new VFile({ path: p }));   // (from a file, as the app opens: the size picks the save)
  const out = mu.save('dr');
  const text = new TextDecoder('latin1').decode(out);
  assert.match(text, /trailer\s*<<[^]*\/Root \d+ \d+ R/, 'the trailer leads to the catalogue');
  const again = new mupdf.PDFDocument(out);
  assert.equal(again.countPages(), 2);
  assert.deepEqual(again.loadPage(1).getBounds().map(Math.round), [0, 0, 300, 200]);
  mu.close('dr');
});
