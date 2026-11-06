// Viewer helpers fixed after the 0.7.0 audit (tests/tmp-ds/result-V.md): going to a markup,
// placing a stamp on the page, nudging a selection over several pages, stamp sizes.
// npx tsx --test tests/viewer-fixes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoomToShow, placeOnPage, shiftOnPages } from '../src/ui/geom';
import { BUILTIN_STAMPS, fillFields, designSize } from '../src/ui/stamps';
import { stampSize, type StampDesign } from '../src/engine/mu';

test('BUG-89: going to a small comment does not zoom to 1000-2000 %', () => {
  // a 20 pt comment icon / a 40 x 12 highlight in a 1200 x 800 view at 100 %
  assert.equal(zoomToShow(1, [100, 100, 120, 120], 1200, 800, 64), 1, 'a fair size already: zoom kept');
  // zoomed far out (a whole A0 sheet): in, but to about 200 %, not 2000 %
  assert.equal(zoomToShow(0.25, [100, 100, 120, 120], 1200, 800, 64), 2);
  assert.equal(zoomToShow(0.25, [100, 100, 140, 112], 1200, 800, 64), 2);
  // zoomed right in: kept (it fits)
  assert.equal(zoomToShow(8, [100, 100, 120, 120], 1200, 800, 64), 8);
  // a big cloud that does not fit: out until it takes half the view (as before)
  assert.equal(zoomToShow(2.5, [0, 0, 1000, 600], 1200, 800, 64), 0.6);
  // a middling markup at a normal zoom: left alone
  assert.equal(zoomToShow(1, [0, 0, 300, 200], 1200, 800, 64), 1);
  // limits
  assert.equal(zoomToShow(0.01, [0, 0, 10, 10], 1200, 800, 1.5), 1.5);
});

test('BUG-24: a stamp clicked near the edge is placed on the page', () => {
  // 100 x 50 centred on a click 5 pt from the top-left corner
  assert.deepEqual(placeOnPage([-45, -20, 55, 30], 595, 842), [0, 0, 100, 50]);
  // bottom-right corner
  assert.deepEqual(placeOnPage([560, 820, 660, 870], 595, 842), [495, 792, 595, 842]);
  // inside: unchanged
  assert.deepEqual(placeOnPage([10, 10, 110, 60], 595, 842), [10, 10, 110, 60]);
  // bigger than the page: its top-left corner on the page
  assert.deepEqual(placeOnPage([-50, 100, 650, 200], 595, 842), [0, 100, 700, 200]);
});

test('BUG-25: nudging a selection over pages keeps every page\'s markups on that page', () => {
  const a4 = { w: 595, h: 842 }, small = { w: 300, h: 300 };
  // one page: as before
  assert.deepEqual(shiftOnPages([{ box: [10, 10, 100, 100], ...a4 }], 20, -5), [20, -5]);
  assert.deepEqual(shiftOnPages([{ box: [10, 10, 100, 100], ...a4 }], -50, 0), [-10, 0]);
  // a markup near the right edge of a smaller second page limits the move for all
  assert.deepEqual(shiftOnPages([{ box: [10, 10, 100, 100], ...a4 }, { box: [250, 250, 290, 290], ...small }], 20, 20), [10, 10]);
  // (a box across both pages' numbers checked against the first page let it go 20)
  // already past an edge: may come back, not go further out
  assert.deepEqual(shiftOnPages([{ box: [-10, 10, 50, 50], ...a4 }], -5, 0), [0, 0]);
  assert.deepEqual(shiftOnPages([{ box: [-10, 10, 50, 50], ...a4 }], 5, 0), [5, 0]);
});

test('BUG-141: a stamp\'s size is worked out as the engine does it', () => {
  const designs: StampDesign[] = BUILTIN_STAMPS.map((s) => fillFields(s.design!, 'Nabil Munla'));
  designs.push({ lines: [{ text: 'CHECKED & PASSED – “OK”', size: 18, bold: true }, { text: 'José Müller – 27/10/2026 · €1,000™', size: 8 }], color: [0, 0, 0], border: 'box' });
  designs.push({ lines: [{ text: 'iiiiiiiiii', size: 20 }, { text: 'WWWWW', size: 20, bold: true }], color: [0, 0, 0], border: 'double' });
  for (const d of designs) {
    const [w, h] = designSize(d), [W, H] = stampSize(d);
    assert.ok(Math.abs(w - W) < 0.01 && Math.abs(h - H) < 0.01, `${d.lines[0].text}: ${w.toFixed(2)} x ${h.toFixed(2)} here, ${W.toFixed(2)} x ${H.toFixed(2)} in the engine`);
  }
});
