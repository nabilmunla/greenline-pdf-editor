// Link the sheets in the editing engine (PLAN 7.5): links and the Sheets group in one undo step,
// readable by MuPDF and PDFium after a save; the file's own bookmark and link untouched; a rerun
// replaces; nothing to write -> no step. Invented sheets only.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import * as pf from '../src/engine/pdfium';

/** 6 sheets (one turned 90°), a bookmark and a link of the file's own */
function set(): Uint8Array {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < 6; i++) d.insertPage(-1, d.addPage([0, 0, 1190, 842], i === 4 ? 90 : 0, { Font: { F1: f } }, `BT /F1 14 Tf 100 700 Td (SEE A-10${(i + 2) % 6}) Tj ET BT /F1 20 Tf 1000 60 Td (A-10${i}) Tj ET`));
  const out = d.saveToBuffer('').asUint8Array().slice();
  const o = mupdf.Document.openDocument(out, 'application/pdf') as mupdf.PDFDocument;
  const it = o.outlineIterator();
  it.insert({ title: 'Cover notes', uri: '#page=1', open: false });
  o.loadPage(1).createLink([50, 50, 150, 80], '#page=6');
  return o.saveToBuffer('').asUint8Array().slice();
}
const pageObj = (b: Uint8Array) => mupdf.Document.openDocument(b, 'application/pdf') as mupdf.PDFDocument;
const ownBookmark = (d: mupdf.PDFDocument) => d.getTrailer().get('Root').get('Outlines').get('First').resolve().toString();
const ownLink = (d: mupdf.PDFDocument) => { const a = d.loadPage(1).getObject().get('Annots'); return a.get(0).resolve().toString(); };

test('links and the Sheets group: one step, read back by MuPDF and PDFium, a rerun replaces', async () => {
  const src = set();
  const before = pageObj(src);
  const bm0 = ownBookmark(before), ln0 = ownLink(before);
  mu.open('ls', src, undefined, 'Tester');
  const links = [0, 1, 2, 3, 4, 5].map((p) => ({ page: p, box: [100, 130, 190, 146] as [number, number, number, number], target: (p + 2) % 6 }));
  // (page 4 is turned: its box is as shown, like the drawing engine's text)
  const marks = [0, 1, 2, 3, 4, 5].map((p) => ({ page: p, title: `A-10${p} Plan ${p}` }));
  const r = mu.linkSheets('ls', links, marks);
  assert.equal(r.links, 6);
  assert.equal(r.bookmarks, 6);
  assert.deepEqual(mu.history('ls').undo, ['Link the sheets']);
  // MuPDF: each page's new link goes to its sheet, where it was asked for
  for (let p = 0; p < 6; p++) {
    const l = mu.linksOf('ls', p).filter((x) => x.page === (p + 2) % 6 && Math.abs(x.rect[0] - 100) < 1 && Math.abs(x.rect[1] - 130) < 1);
    assert.equal(l.length, 1, 'page ' + p + ': ' + JSON.stringify(mu.linksOf('ls', p)));
  }
  const ol = mu.outlineFull('ls');
  assert.deepEqual(ol.map((x) => x.title), ['Cover notes', 'Sheets']);
  assert.deepEqual(ol[1].children.map((x) => [x.title, x.page]), marks.map((m) => [m.title, m.page]));
  // saved and read by a fresh MuPDF and by PDFium
  const saved = mu.save('ls');
  const fresh = pageObj(saved);
  // (the last of the file's own bookmarks gains a /Next to the group after it - nothing else changes)
  assert.equal(ownBookmark(fresh).replace(/\/Next \d+ 0 R/, ''), bm0, 'the file\'s own bookmark unchanged');
  assert.equal(ownLink(fresh), ln0, 'the file\'s own link unchanged');
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  pf.openDoc('lsp', saved);
  for (let p = 0; p < 6; p++) {
    const l = pf.links('lsp', p).filter((x) => x.page === (p + 2) % 6);
    assert.equal(l.length, 1, 'PDFium page ' + p);
    assert.ok(Math.abs(l[0].rect[0] - 100) < 1 && Math.abs(l[0].rect[1] - 130) < 1, 'PDFium sees it where it was put on page ' + p + ': ' + l[0].rect.map(Math.round));
  }
  pf.closeDoc?.('lsp');
  // a rerun replaces: same counts, no second group
  const r2 = mu.linkSheets('ls', links.slice(0, 3), marks.slice(0, 2));
  assert.equal(r2.removed, 6);
  assert.equal(r2.links, 3);
  assert.equal([0, 1, 2, 3, 4, 5].reduce((n, p) => n + mu.linksOf('ls', p).length, 0), 3 + 1, 'three of ours and the file\'s own');
  assert.deepEqual(mu.outlineFull('ls').map((x) => [x.title, x.children.length]), [['Cover notes', 0], ['Sheets', 2]]);
  // one undo takes the rerun back, a second one everything
  mu.undo('ls');
  assert.equal(mu.outlineFull('ls')[1].children.length, 6);
  mu.undo('ls');
  assert.deepEqual(mu.outlineFull('ls').map((x) => x.title), ['Cover notes']);
  assert.equal([0, 1, 2, 3, 4, 5].reduce((n, p) => n + mu.linksOf('ls', p).length, 0), 1);
  mu.redo('ls');
  assert.equal(mu.linksOf('ls', 0).length, 1);
  // only the bookmarks asked for (links null): the links of the run before stay (sweep S8)
  mu.redo('ls');
  const r3 = mu.linkSheets('ls', null, marks);
  assert.equal(r3.removed, 0);
  assert.equal(r3.links, 0);
  assert.equal([0, 1, 2, 3, 4, 5].reduce((n, p) => n + mu.linksOf('ls', p).length, 0), 3 + 1, 'the three links stay');
  assert.deepEqual(mu.outlineFull('ls').map((x) => [x.title, x.children.length]), [['Cover notes', 0], ['Sheets', 6]]);
  mu.close('ls');
});

test('a reference under a link the file has is left alone; nothing to write -> no step (rule R)', () => {
  mu.open('ls2', set(), undefined, 'Tester');
  // page 1's own link was made over 50,50..150,80 as shown
  const r = mu.linkSheets('ls2', [{ page: 1, box: [60, 55, 140, 78], target: 3 }], null);
  assert.equal(r.links, 0);
  assert.equal(r.skipped, 1);
  mu.undo('ls2');
  const none = mu.linkSheets('ls2', [], []);
  assert.deepEqual([none.links, none.bookmarks, none.removed], [0, 0, 0]);
  assert.deepEqual(mu.history('ls2').undo, [], 'no step when there is nothing to write');
  // junk in: pages that don't exist, boxes that aren't boxes - dropped, no throw
  const junk = mu.linkSheets('ls2', [{ page: 99, box: [0, 0, 1, 1], target: 0 }, { page: 0, box: [NaN, 0, 1, 1], target: 1 }, { page: 0, box: [5, 5, 1, 1], target: 1 }, { page: 0, box: [0, 0, 1, 1], target: 0 }] as never, null);
  assert.equal(junk.links, 0);
  assert.deepEqual(mu.history('ls2').undo, []);
  mu.close('ls2');
});

test('the spec: no sheets, nothing changed', () => {
  const spec = new Uint8Array(readFileSync('tests/data/long-spec.pdf'));
  mu.open('ls3', spec, undefined, 'Tester');
  const t0 = performance.now();
  const r = mu.linkSheets('ls3', [], []);
  assert.equal(r.links + r.bookmarks + r.removed, 0);
  assert.deepEqual(mu.history('ls3').undo, []);
  assert.ok(performance.now() - t0 < 5000, 'took ' + Math.round(performance.now() - t0) + ' ms');
  mu.close('ls3');
});
