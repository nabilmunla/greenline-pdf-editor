// 13.2.11: a link made by "Link the sheets" carries /Fit; the viewer must get that view (PDFium's link
// list dropped it) and show the whole target sheet instead of landing top-left. Invented sheets only.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import * as pf from '../src/engine/pdfium';
import { jumpOf, VIEW_FIT } from '../src/ui/linkview';

function three(): Uint8Array {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < 3; i++) d.insertPage(-1, d.addPage([0, 0, 1190, 842], 0, { Font: { F1: f } }, `BT /F1 14 Tf 100 700 Td (SEE X-10${(i + 1) % 3}) Tj ET`));
  return d.saveToBuffer('').asUint8Array().slice();
}

test('a sheet link read by PDFium carries its /Fit view', async () => {
  mu.open('lv', three(), undefined, 'Tester');
  mu.linkSheets('lv', [{ page: 0, box: [100, 130, 190, 146], target: 2 }], null);
  const saved = mu.save('lv');
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  pf.openDoc('lvp', saved);
  const l = pf.links('lvp', 0).filter((x) => x.page === 2);
  assert.equal(l.length, 1);
  assert.equal(l[0].view?.kind, VIEW_FIT);
  pf.closeDoc?.('lvp');
  mu.close('lv');
});

test('a link with a /Fit view shows the whole target sheet; any other goes to the page as before', () => {
  assert.deepEqual(jumpOf({ rect: [0, 0, 1, 1], page: 4, view: { kind: VIEW_FIT, params: [] } }), { page: 4, fit: true });
  assert.deepEqual(jumpOf({ rect: [0, 0, 1, 1], page: 4 }), { page: 4, fit: false });
  assert.deepEqual(jumpOf({ rect: [0, 0, 1, 1], page: 4, view: { kind: 1, params: [0, 800, 0] } }), { page: 4, fit: false }); // /XYZ: left to 13.2.12
  assert.equal(jumpOf({ rect: [0, 0, 1, 1], url: 'https://example.com' }), null);
  assert.equal(jumpOf({ rect: [0, 0, 1, 1], page: -1 }), null);
});
