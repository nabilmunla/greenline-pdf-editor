// Builds tests/fixtures/drawing-set-6.pdf (6 dense A0 sheets, ~180 MB) for tests/probe-set.mjs - not kept in the source package.
import * as mupdf from 'mupdf';
import fs from 'node:fs';
const out = new mupdf.PDFDocument();
for (const f of ['tests/real/area-gf-18mb.pdf', 'tests/real/b1-floor-22mb.pdf', 'tests/real/doc-sheet-50mb.pdf', 'tests/real/area-gf-18mb.pdf', 'tests/real/b1-floor-22mb.pdf', 'tests/real/doc-sheet-50mb.pdf']) {
  const src = mupdf.Document.openDocument(fs.readFileSync(f), 'application/pdf').asPDF();
  out.graftPage(-1, src, 0);
}
fs.writeFileSync('tests/fixtures/drawing-set-6.pdf', out.saveToBuffer('compress').asUint8Array());
console.log('pages', out.countPages(), (fs.statSync('tests/fixtures/drawing-set-6.pdf').size / 1e6).toFixed(0), 'MB');
