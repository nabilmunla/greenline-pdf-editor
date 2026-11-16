// PLAN 2.1 (AUDIT A5): the snap index gives up at once on a page over the limit (the pieces are
// counted object by object first, no point is read), and builds the same index as before otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as pf from '../src/engine/pdfium';
import { oldBuildSnap, onePage, form, manyLines, sameIndex } from './snap-ref';

const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
const MAX = 4e6;

/** the old and the new function on one page: the same index (old one first: the new keeps its result in the file's cache) */
function compare(id: string, pg: number, what: string, max = MAX) {
  pf.snapPageForTests(id, pg);                 // (read in: only the index is compared)
  const old = oldBuildSnap(id, pg, max);
  const now = pf.buildSnap(id, pg);
  sameIndex(now, old, what);
  return { old, now };
}

test('2.1: a normal page gives the same index as before (heavy-a0.pdf, and a page with curves, closed paths, rectangles and nested forms)', () => {
  const bytes = new Uint8Array(readFileSync('tests/data/heavy-a0.pdf'));
  pf.openDoc('h', bytes);
  const r = compare('h', 0, 'heavy-a0 p1');
  assert.ok(r.now.n > 1000, `heavy-a0 has line work: n = ${r.now.n}`);
  pf.closeDoc('h');

  // curves, closed paths (h), rectangles, a form with a matrix, a form in a form in a form ...
  // (form k is object 5 + k and draws form k + 1; the engine enters 7 levels, the rest is left as it is)
  const forms = Array.from({ length: 10 }, (_, i) => form(`${50 + i * 10} 100 m ${60 + i * 10} 150 l S ${100 + i} 100 m ${100 + i} 140 ${150 + i} 160 ${150 + i} 120 c S` + (i < 9 ? ` q 1 0 0 1 3 4 cm /F Do Q` : ''), '1 0 0.2 1 5 7', `<< /XObject << /F ${6 + i} 0 R >> >>`));
  const content = [
    '100 100 m 200 100 l 200 200 l h S',               // a closed triangle
    '300 300 150 80 re S',                              // a rectangle
    '50 600 m 80 650 120 650 150 600 c 180 550 220 550 250 600 c S',  // curves
    '0.5 0 0 0.5 20 30 cm 400 400 m 450 450 l S',       // a transform, then a line
    'q 1 0 0 1 30 40 cm /F Do Q',
    manyLines(5000, 7),
  ].join('\n');
  const pdf = onePage(content, forms, '<< /XObject << /F 5 0 R >> >>');
  pf.openDoc('g', pdf);
  const r2 = compare('g', 0, 'generated');
  assert.ok(r2.now.n > 5000, `n = ${r2.now.n}`);
  pf.closeDoc('g');
  // the forms do add pieces (7 levels of a line and a curve of a few chords each)
  pf.openDoc('g0', onePage(content.replace('q 1 0 0 1 30 40 cm /F Do Q', ''), forms, '<< /XObject << /F 5 0 R >> >>'));
  const none = pf.buildSnap('g0', 0);
  assert.ok(r2.now.n - none.n >= 7 * 3, `forms add ${r2.now.n - none.n} pieces`);
  pf.closeDoc('g0');
});

test('2.1: a page over the limit is given up at once (and the old way, reading pieces until the count ran over, takes longer)', () => {
  const was = MAX;
  pf.setSnapMax(200_000);
  try {
    const pdf = onePage(manyLines(600_000, 10));
    pf.openDoc('big', pdf);
    pf.snapPageForTests('big', 0);   // (the page is read in already when a snapping tool is picked: its cost is not the index's)
    const t0 = performance.now();
    const o = oldBuildSnap('big', 0, 200_000);
    const tOld = performance.now() - t0;
    const t1 = performance.now();
    const ix = pf.buildSnap('big', 0);
    const tNew = performance.now() - t1;
    console.log(`# 600k pieces, limit 200k: old ${tOld.toFixed(0)} ms, new ${tNew.toFixed(1)} ms`);
    assert.equal(ix.n, 0, 'gave up: no pieces');
    assert.equal(o.n, 0);
    sameIndex(ix, o, 'given up');
    assert.ok(tNew < 150, `giving up took ${tNew.toFixed(0)} ms (limit 150)`);
    pf.closeDoc('big');
  } finally { pf.setSnapMax(was); }
});

test('2.1: the limit counts pieces inside forms too, and exactly: at the limit an index is built, one over gives up', () => {
  // 30 forms of 1,000 pieces each (a form is used 30 times: its pieces are counted each time, as they are read each time)
  const f = form(manyLines(1000, 10));
  const content = Array.from({ length: 30 }, (_, i) => `q 1 0 0 1 ${i * 5} 0 cm /F Do Q`).join('\n');
  const pdf = onePage(content, [f], '<< /XObject << /F 5 0 R >> >>');
  pf.openDoc('fm', pdf);
  const total = oldBuildSnap('fm', 0, 1e9).n;   // (pieces that count: those longer than 0.6 pt)
  assert.ok(total > 20000, 'pieces in forms: ' + total);
  // the count is of path pieces (a few more than the indexed pieces: a path's close and tiny pieces)
  const counted = 30 * 1000 + 30 * 100;         // 30 uses x (1000 'l' + 100 'm')
  try {
    pf.setSnapMax(counted); const a = pf.buildSnap('fm', 0);
    assert.equal(a.n, total, 'at the limit: built');
    sameIndex(a, oldBuildSnap('fm', 0, counted), 'at the limit');
    pf.closeDoc('fm'); pf.openDoc('fm', pdf);
    pf.setSnapMax(counted - 1); const b = pf.buildSnap('fm', 0);
    assert.equal(b.n, 0, 'one over: given up');
    sameIndex(b, oldBuildSnap('fm', 0, counted - 1), 'one over');
  } finally { pf.setSnapMax(MAX); pf.closeDoc('fm'); }
});

test('Phase 6 sweep: long slanting pieces over the whole sheet past the grid limit: given up (not an index that wraps or takes gigabytes), and kept so', () => {
  // 3,000 diagonals corner to corner: each in every cell of its box (~21,000 cells) - 64 M entries
  let c = '0.2 w\n';
  for (let i = 0; i < 3000; i++) c += `${i % 20} ${(i * 7) % 20} m ${596 - (i % 20)} ${796 - ((i * 3) % 20)} l S\n`;
  pf.setSnapCellsMax(16e6);
  pf.openDoc('diag', onePage(c));
  pf.snapPageForTests('diag', 0);
  const t0 = performance.now();
  const ix = pf.buildSnap('diag', 0);
  const ms = performance.now() - t0;
  assert.equal(ix.n, 0, 'too dense to snap: given up');
  assert.ok(ix.ids.length === 0, 'no grid of millions of entries');
  assert.equal(pf.buildSnap('diag', 0), ix, 'kept: not built again at the next snap');
  console.log(`# 3,000 sheet-long diagonals: given up in ${ms.toFixed(0)} ms`);
  pf.closeDoc('diag');
  // a page under the limit still gets its index
  pf.openDoc('diag2', onePage(c.split('\n').slice(0, 200).join('\n')));
  assert.ok(pf.buildSnap('diag2', 0).n >= 199, 'a few long lines: indexed');
  pf.closeDoc('diag2');
});
