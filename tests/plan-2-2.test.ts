// PLAN 2.2 (AUDIT A5): the snap index is built with the engine's own exports (not the wrapped
// calls), one view over the memory, no array per object or per curve - and comes out identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as pf from '../src/engine/pdfium';
import { oldBuildSnap, onePage, form, manyLines, sameIndex } from './snap-ref';

const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
const MAX = 4e6;

/** a page with curves, closed paths, rectangles, transforms and forms (some nested), and a few thousand plain lines */
function mixedPage(): Uint8Array {
  const forms = Array.from({ length: 4 }, (_, i) => form(`${50 + i * 10} 100 m ${60 + i * 10} 150 l S ${100 + i} 100 m ${100 + i} 140 ${150 + i} 160 ${150 + i} 120 c S 20 20 40 30 re S` + (i < 3 ? ' q 1 0 0 1 3 4 cm /F Do Q' : ''), '1 0 0.2 1 5 7', `<< /XObject << /F ${6 + i} 0 R >> >>`));
  const content = [
    '100 100 m 200 100 l 200 200 l h S', '300 300 150 80 re S',
    '50 600 m 80 650 120 650 150 600 c 180 550 220 550 250 600 c S',
    'q 0.5 0 0 0.5 20 30 cm 400 400 m 450 450 l 470 420 l h S Q',
    'q 0 1 -1 0 500 0 cm 1.2 0 0 0.8 5 5 cm /F Do Q',
    '10 700 m 20 710 l 30 700 l 40 710 l S 100 700 m 100.2 700.1 l S',   // (a piece shorter than 0.6 pt is left out)
    manyLines(8000, 7),
  ].join('\n');
  return onePage(content, forms, '<< /XObject << /F 5 0 R >> >>');
}

test('2.2: the index is identical to the old function on heavy-a0.pdf and on a mixed generated page (kinds, cells, ids)', () => {
  pf.openDoc('h', new Uint8Array(readFileSync('tests/data/heavy-a0.pdf')));
  pf.snapPageForTests('h', 0);
  sameIndex(pf.buildSnap('h', 0), oldBuildSnap('h', 0, MAX), 'heavy-a0');
  pf.closeDoc('h');
  pf.openDoc('m', mixedPage());
  pf.snapPageForTests('m', 0);
  const old = oldBuildSnap('m', 0, MAX);
  const now = pf.buildSnap('m', 0);
  sameIndex(now, old, 'mixed');
  assert.ok(now.n > 8000);
  // (the kinds are not all the same: ends, middles, curve chords)
  assert.ok(new Set(now.kind).size >= 4, 'kinds seen: ' + [...new Set(now.kind)]);
  pf.closeDoc('m');
});

test('2.2: the engine memory growing in the middle of the build (a new view is needed) changes nothing', () => {
  const e = pf.engineForTests();
  const pdf = mixedPage();
  pf.openDoc('gr', pdf);
  pf.snapPageForTests('gr', 0);
  const old = oldBuildSnap('gr', 0, MAX);
  const orig = e.pdfium as unknown as { HEAPU8: Uint8Array; wasmExports: Record<string, (...a: number[]) => number> };
  const before = orig.HEAPU8.buffer;
  let calls = 0, grown = 0;
  const ex = orig.wasmExports;
  // (the segment calls counted: at the 3,000th the memory is grown by asking for a block bigger than what is free, then let go)
  const getType = ex.FPDFPathSegment_GetType;
  // (the export table is read-only: an object that inherits from it, with the one call replaced)
  const wrapped = Object.create(ex, {
    FPDFPathSegment_GetType: {
      value: (...a: number[]) => {
        if (++calls === 3000) { const big = ex.malloc(1.5 * 2 ** 30) >>> 0; if (big) { grown++; ex.free(big); } }
        return getType(...a);
      },
    },
  });
  e.pdfium = Object.create(orig, { wasmExports: { value: wrapped } });
  try {
    const now = pf.buildSnap('gr', 0);
    assert.equal(grown, 1, 'the memory was grown during the build');
    assert.notEqual(orig.HEAPU8.buffer, before, 'and the heap has a new buffer');
    sameIndex(now, old, 'memory grown during the build');
  } finally { e.pdfium = orig as never; pf.closeDoc('gr'); }
});

test('2.2: a page of 400,000 pieces is built in well under half the time of the old function', () => {
  const pdf = onePage(manyLines(400_000, 10));
  pf.openDoc('b', pdf);
  pf.snapPageForTests('b', 0);   // (read in: the index is what is timed)
  const old = oldBuildSnap('b', 0, MAX);   // (once, to warm up)
  const med = (xs: number[]) => xs.sort((x, y) => x - y)[xs.length >> 1];
  const tOld = med([0, 1, 2].map(() => { const a = performance.now(); oldBuildSnap('b', 0, MAX); return performance.now() - a; }));
  const build = med([0, 1, 2].map(() => { pf.closeDoc('b'); pf.openDoc('b', pdf); pf.snapPageForTests('b', 0); const a = performance.now(); pf.buildSnap('b', 0); return performance.now() - a; }));
  console.log(`# 400k pieces: old ${tOld.toFixed(0)} ms, new ${build.toFixed(0)} ms`);
  sameIndex(pf.buildSnap('b', 0), old, '400k');
  assert.ok(build < tOld * 0.5, `new ${build.toFixed(0)} ms vs old ${tOld.toFixed(0)} ms`);
  pf.closeDoc('b');
});
