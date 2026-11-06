// Measurement numbers for Excel (0.8.4): the number apart from its unit, as the drawing shows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMeasure, measureValue, fmtLen, fmtArea, PT_M } from '../src/ui/geom';

test('a measurement label splits into a number and its unit, with the decimals it shows', () => {
  assert.deepEqual(splitMeasure('7.056 m'), { v: 7.056, unit: 'm', dec: 3 });
  assert.deepEqual(splitMeasure('450 mm'), { v: 450, unit: 'mm', dec: 0 });
  assert.deepEqual(splitMeasure('45.20 m²'), { v: 45.2, unit: 'm²', dec: 2 });
  assert.deepEqual(splitMeasure('123.45 sq ft'), { v: 123.45, unit: 'sq ft', dec: 2 });
  assert.deepEqual(splitMeasure('30.0°'), { v: 30, unit: '°', dec: 1 });
  assert.deepEqual(splitMeasure('12.3 mm (paper)'), { v: 12.3, unit: 'mm (paper)', dec: 1 });
  assert.deepEqual(splitMeasure('1.2 cm² (paper)'), { v: 1.2, unit: 'cm² (paper)', dec: 1 });
  assert.deepEqual(splitMeasure(`12' 3.00"`), { v: 12.25, unit: 'ft', dec: 4 });
  assert.deepEqual(splitMeasure(' 7.056 m '), { v: 7.056, unit: 'm', dec: 3 });
  for (const typed of ['Kitchen', '7.056 m approx', 'about 3 m', '', '1,234.5 m']) assert.equal(splitMeasure(typed), null, typed);
});

test('every number the app writes splits back to the same number', () => {
  const s = { k: 100 * PT_M, label: '1:100' };
  const imp = { k: 48 * PT_M, label: '1/4" = 1\'', imperial: true };
  for (const pts of [1, 37.5, 200, 1234.567]) {
    for (const f of [{}, { dm: 0 }, { dm: 4 }, { unit: 'mm' as const }, { unit: 'mm' as const, dmm: 2 }]) {
      const t = fmtLen(pts, s, f);
      const n = splitMeasure(t);
      assert.ok(n, t);
      assert.equal(n!.v.toFixed(n!.dec), t.split(' ')[0], t);
    }
    assert.ok(splitMeasure(fmtLen(pts, imp, {})), fmtLen(pts, imp, {}));
    assert.ok(splitMeasure(fmtLen(pts, null)), fmtLen(pts, null));
    for (const f of [{}, { da: 0 }, { da: 4 }]) { const t = fmtArea(pts * pts, s, f); const n = splitMeasure(t); assert.ok(n, t); assert.equal(n!.v.toFixed(n!.dec), t.split(' ')[0]); }
    assert.ok(splitMeasure(fmtArea(pts * pts, imp, {})));
    assert.ok(splitMeasure(fmtArea(pts * pts, null)));
  }
  // a rectangle area (four corners) measures width x height
  const r = measureValue('measure-area', [[100, 100], [300, 100], [300, 250], [100, 250]], s, {});
  assert.equal(r, fmtArea(200 * 150, s, {}) + ' · P ' + fmtLen(700, s, {}));
  assert.equal(splitMeasure(measureValue('measure-angle', [[0, 0], [10, 0], [10, 10]], s, {}))!.unit, '°');
});

test('Excel number of a measurement: lengths under a metre in metres (a column adds up), fixed mm stays mm, a typed label gives the measured number, counts are 1', async () => {
  const { measureNumber } = await import('../src/ui/measurexl');
  const s = { k: 100 * PT_M, label: '1:100' };
  const at = () => s;
  assert.deepEqual(measureNumber({ page: 0, kind: 'measure-length', contents: '450 mm' }, at), { v: 0.45, unit: 'm', dec: 3 });
  assert.deepEqual(measureNumber({ page: 0, kind: 'measure-length', contents: '450.5 mm', fmt: { unit: 'auto' } }, at), { v: 0.4505, unit: 'm', dec: 4 });
  assert.deepEqual(measureNumber({ page: 0, kind: 'measure-length', contents: '450 mm', fmt: { unit: 'mm' } }, at), { v: 450, unit: 'mm', dec: 0 });
  assert.deepEqual(measureNumber({ page: 0, kind: 'measure-length', contents: '7.056 m' }, at), { v: 7.056, unit: 'm', dec: 3 });
  // typed by hand: the number from its points (200 pt at 1:100 = 7.056 m)
  assert.deepEqual(measureNumber({ page: 0, kind: 'measure-length', contents: 'Wall W1', line: [[100, 400], [300, 400]], fmt: { dm: 3 } }, at), { v: 7.056, unit: 'm', dec: 3 });
  // ... also when it comes out in mm (20 pt = 706 mm): metres
  assert.deepEqual(measureNumber({ page: 0, kind: 'measure-length', contents: 'Sill', line: [[100, 400], [120, 400]], fmt: {} }, at), { v: 0.706, unit: 'm', dec: 3 });
  assert.deepEqual(measureNumber({ page: 0, kind: 'measure-count', contents: 'Doors #3' }, at), { v: 1, unit: 'No.', dec: 0 });
  assert.equal(measureNumber({ page: 0, kind: 'measure-length', contents: 'typed, no points' }, at), null);
  assert.equal(measureNumber({ page: 0, kind: undefined, contents: '7.056 m' }, at), null, 'not a measurement');
  assert.deepEqual(measureNumber({ page: 0, kind: 'measure-area', contents: '45.20 m²' }, at), { v: 45.2, unit: 'm²', dec: 2 });
});

// ---------------------------------------------------------------- 0.8.5: circles, rectangles, typed lengths
import { circlePts, circleOf, isAxisRect, rectKeep, parseTypedLength, ellipsePerimeter, polyArea, pathLength } from '../src/ui/geom';

test('a circle drawn as one measures as the circle (not its polygon), under separate X / Y scales too', () => {
  const s = { k: 100 * PT_M, label: '1:100' };
  // radius 5 m at 1:100 = 50 mm on paper
  const r = 0.05 / 0.0254 * 72;
  const v = circlePts([300, 400], r);
  assert.ok(circleOf(v), 'recognised as a circle');
  assert.equal(measureValue('measure-area', v, s, { da: 3, dm: 4 }), (Math.PI * 25).toFixed(3) + ' m² · P ' + (Math.PI * 10).toFixed(4) + ' m');
  assert.equal(measureValue('measure-perimeter', v, s, { dm: 4 }), (Math.PI * 10).toFixed(4) + ' m');
  // the polygon itself would be a little short of it
  assert.ok(polyArea(v) * s.k * s.k < Math.PI * 25 - 0.01);
  // separate up-down scale (1:50 across, ... 1:100 up-down): an ellipse
  const xy = { k: 50 * PT_M, ky: 100 * PT_M, label: '1:50', labelY: '1:100' };
  const a = r * 50 * PT_M, b = r * 100 * PT_M;
  assert.equal(measureValue('measure-area', v, xy, { da: 3, dm: 3 }), (Math.PI * a * b).toFixed(3) + ' m² · P ' + ellipsePerimeter(a, b).toFixed(3) + ' m');
  assert.equal(measureValue('measure-perimeter', v, xy, { dm: 3 }), ellipsePerimeter(a, b).toFixed(3) + ' m');
  // Ramanujan against a fine polygon of the same ellipse
  const fine = circlePts([0, 0], 1, 200000).map((p) => [p[0] * 3, p[1] * 1] as [number, number]);
  assert.ok(Math.abs(pathLength(fine, true) - ellipsePerimeter(3, 1)) < 1e-6);
  // a hand-drawn outline of many corners is not taken for a circle; one corner moved neither
  const wobbly = circlePts([0, 0], 100, 64).map((p, i) => [p[0] * (1 + (i % 2) * 0.01), p[1]] as [number, number]);
  assert.equal(circleOf(wobbly), null);
  const moved = v.slice(); moved[10] = [moved[10][0] + 5, moved[10][1]];
  assert.equal(circleOf(moved), null);
  assert.equal(circleOf(circlePts([0, 0], 100, 12)), null, 'a 12-gon is a polygon');
  // stored corners come back rounded (the file keeps a few decimals): still the circle
  const rounded = v.map((p) => [Number(p[0].toFixed(2)), Number(p[1].toFixed(2))] as [number, number]);
  assert.ok(circleOf(rounded));
  assert.equal(measureValue('measure-area', rounded, s, { da: 2 }).split(' · P ')[0], (Math.PI * 25).toFixed(2) + ' m²');
});

test('a rectangle keeps its corners square when one corner is dragged', () => {
  const v: [number, number][] = [[10, 10], [110, 10], [110, 60], [10, 60]];
  assert.ok(isAxisRect(v));
  assert.ok(!isAxisRect([[10, 10], [110, 12], [110, 60], [10, 60]]));
  assert.ok(!isAxisRect([[10, 10], [110, 10], [110, 60]]));
  const r = rectKeep(v, 2, [150, 90]);
  assert.deepEqual(r, [[10, 10], [150, 10], [150, 90], [10, 90]]);
  assert.ok(isAxisRect(r));
  // any corner, any order of corners (drawn the other way round)
  const w: [number, number][] = [[10, 10], [10, 60], [110, 60], [110, 10]];
  assert.deepEqual(rectKeep(w, 0, [0, 0]), [[0, 0], [0, 60], [110, 60], [110, 0]]);
  assert.deepEqual(rectKeep(w, 1, [-5, 80]), [[-5, 10], [-5, 80], [110, 80], [110, 10]]);
});

test('typed lengths: metres, millimetres, units, a comma for the decimal point', () => {
  assert.deepEqual(parseTypedLength('4.2'), { m: 4.2, read: '' });
  assert.deepEqual(parseTypedLength('4200'), { m: 4.2, read: 'mm' });
  assert.deepEqual(parseTypedLength('99'), { m: 99, read: '' });
  assert.deepEqual(parseTypedLength('4200mm'), { m: 4.2, read: '' });
  assert.deepEqual(parseTypedLength('420cm'), { m: 4.2, read: '' });
  assert.deepEqual(parseTypedLength('4.2m'), { m: 4.2, read: '' });
  assert.deepEqual(parseTypedLength('6,5'), { m: 6.5, read: 'm' });
  assert.deepEqual(parseTypedLength('.5'), { m: 0.5, read: '' });
  assert.deepEqual(parseTypedLength(' 3 m '), { m: 3, read: '' });
  assert.equal(parseTypedLength('4212.5')!.m, 4212.5);
  for (const bad of ['', '.', 'abc', '4.2.1', '-3', '0', 'm', '4,2,1']) assert.equal(parseTypedLength(bad), null, bad);
  const ft = parseTypedLength("12'6\"", true)!;
  assert.ok(Math.abs(ft.m - 12.5 * 0.3048) < 1e-12);
  assert.ok(Math.abs(parseTypedLength('150"', true)!.m - 150 * 0.0254) < 1e-12);
  assert.ok(Math.abs(parseTypedLength('12.5', true)!.m - 12.5 * 0.3048) < 1e-12);
});

import { perimeterOf } from '../src/ui/geom';
import { sameMeasure } from '../src/ui/relabel';
import { perimeterNumber } from '../src/ui/measurexl';

test('one Area tool (0.8.9): its label gives the perimeter too - read back apart, old labels still the number', () => {
  const s = { k: 100 * PT_M, label: '1:100' };
  const pt = (m: number) => m / (100 * PT_M); // metres on site -> points on the 1:100 sheet
  const sq = [[0, 0], [pt(2), 0], [pt(2), pt(3)], [0, pt(3)]] as [number, number][];
  const lab = measureValue('measure-area', sq, s, {});
  assert.equal(lab, '6.00 m² · P 10.000 m');
  // Totals / Excel: the area as the number, the perimeter apart
  assert.deepEqual(splitMeasure(lab), { v: 6, unit: 'm²', dec: 2 });
  assert.deepEqual(perimeterOf(lab), { v: 10, unit: 'm', dec: 3 });
  assert.equal(perimeterOf('6.00 m²'), null);
  const at = () => s;
  assert.deepEqual(perimeterNumber({ page: 0, kind: 'measure-area', contents: lab, vertices: sq }, at), { v: 10, unit: 'm', dec: 3 });
  // a label from before (area only) or typed by hand: the perimeter measured from its corners
  const kp = perimeterNumber({ page: 0, kind: 'measure-area', contents: 'Kitchen', vertices: sq }, at);
  assert.ok(kp && kp.v === 10 && kp.unit === 'm', JSON.stringify(kp));
  assert.equal(perimeterNumber({ page: 0, kind: 'measure-length', contents: '4.000 m', line: [[0, 0], [1, 1]] }, at), null);
  // an area label from before 0.8.9 is still taken for the app's number (relabelled on a scale change)
  assert.ok(sameMeasure('6.00 m²', lab));
  assert.ok(sameMeasure(lab, lab));
  assert.ok(!sameMeasure('6.00 m² · P 11.000 m', lab));
  assert.ok(!sameMeasure('7.00 m²', lab));
});
