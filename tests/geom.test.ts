// Measurement numbers: units and decimals (defaults m 3, mm 0; changed per measurement).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtLen, fmtArea, measureValue, lenUnit, PT_M } from '../src/ui/geom';

const s100 = { k: PT_M * 100, label: '1:100' };
const mPt = (m: number) => m / s100.k; // points on paper for m metres at 1:100

test('defaults: metres with 3 decimals, millimetres (under 1 m) with none', () => {
  assert.equal(fmtLen(mPt(3.5), s100), '3.500 m');
  assert.equal(fmtLen(mPt(0.4567), s100), '457 mm');
  assert.equal(lenUnit(mPt(0.4567), s100), 'mm');
  assert.equal(fmtArea(mPt(2) * mPt(3), s100), '6.00 m²');
});

test('decimals and unit can be chosen', () => {
  assert.equal(fmtLen(mPt(3.5), s100, { dm: 1 }), '3.5 m');
  assert.equal(fmtLen(mPt(3.5), s100, { dm: 0 }), '4 m');
  assert.equal(fmtLen(mPt(3.5), s100, { unit: 'mm' }), '3500 mm');
  assert.equal(fmtLen(mPt(0.4567), s100, { unit: 'm' }), '0.457 m');
  assert.equal(fmtLen(mPt(0.4567), s100, { dmm: 1 }), '456.7 mm');
  assert.equal(fmtArea(mPt(2) * mPt(3), s100, { da: 3 }), '6.000 m²');
  assert.equal(fmtLen(mPt(3.5), s100, { dm: 99 }), '3.500 m', 'nonsense falls back to the default');
});

test('measureValue follows the format for every kind', () => {
  const p = (x: number, y: number): [number, number] => [mPt(x), mPt(y)];
  assert.equal(measureValue('measure-length', [p(0, 0), p(3, 4)], s100, { dm: 2 }), '5.00 m');
  assert.equal(measureValue('measure-polylength', [p(0, 0), p(1, 0), p(1, 1)], s100), '2.000 m');
  assert.equal(measureValue('measure-perimeter', [p(0, 0), p(1, 0), p(1, 1), p(0, 1)], s100, { unit: 'mm' }), '4000 mm');
  // (an area gives its perimeter too - 0.8.9)
  assert.equal(measureValue('measure-area', [p(0, 0), p(2, 0), p(2, 3), p(0, 3)], s100), '6.00 m² · P 10.000 m');
  assert.equal(fmtLen(72, null), '25.4 mm (paper)', 'no scale: paper size');
});

test('separate X and Y scales: lengths, areas and angles use each direction', async () => {
  const { scaleFor, yRatio, realDist, scaleText } = await import('../src/ui/geom');
  const x100 = { k: PT_M * 100, label: '1:100' };
  const s = scaleFor(x100, { k: PT_M * 20, label: '1:20' }, 'y'); // heights drawn 5x bigger
  assert.equal(yRatio(s), 0.2);
  assert.equal(scaleText(s), 'X 1:100 · Y 1:20');
  const across = mPt(3), up = mPt(3) * 5; // 3 m across, 3 m up (drawn 5x taller)
  assert.equal(measureValue('measure-length', [[0, 0], [across, 0]], s), '3.000 m');
  assert.equal(measureValue('measure-length', [[0, 0], [0, up]], s), '3.000 m');
  assert.equal(measureValue('measure-length', [[0, 0], [across, up * 4 / 3]], s), '5.000 m', '3-4-5 triangle');
  assert.equal(measureValue('measure-area', [[0, 0], [across, 0], [across, up], [0, up]], s), '9.00 m² · P 12.000 m');
  assert.equal(measureValue('measure-angle', [[across, 0], [0, 0], [0, up]], s), '90.0°');
  assert.equal(measureValue('measure-angle', [[across, 0], [0, 0], [across, up]], s), '45.0°', 'a real 45° (drawn steeper)');
  assert.ok(Math.abs(realDist([0, 0], [0, up], s) - across) < 1e-9);
  // X only: keeps Y; the same both ways again: one scale
  const s2 = scaleFor(s, { k: PT_M * 50, label: '1:50' }, 'x');
  assert.equal(scaleText(s2), 'X 1:50 · Y 1:20');
  assert.equal(scaleText(scaleFor(s2, { k: PT_M * 50, label: '1:50' }, 'y')), '1:50');
  assert.equal(scaleText(scaleFor(s2, { k: PT_M * 200, label: '1:200' }, 'both')), '1:200');
  // nothing set yet: Y only gives one scale both ways
  assert.equal(scaleText(scaleFor(null, { k: PT_M * 20, label: '1:20' }, 'y')), '1:20');
});

test('separate X / Y scales follow a page turned a quarter', async () => {
  const { orientScale } = await import('../src/ui/geom');
  const s = { k: PT_M * 100, label: '1:100', ky: PT_M * 20, labelY: '1:20', rot: 0 };
  const t = orientScale(s, 90)!;
  assert.equal(t.label, '1:20'); assert.equal(t.labelY, '1:100'); assert.ok(Math.abs(t.k - PT_M * 20) < 1e-12);
  assert.equal(orientScale(s, 180), s, 'half a turn: the same');
  assert.equal(orientScale(t, 90)!.label, '1:20', 'set while turned: stays');
  assert.equal(orientScale({ k: 1, label: '1:1' }, 90)!.label, '1:1', 'one scale both ways: nothing to swap');
});

test('just under a metre in auto: a metre, not "1000 mm"', () => {
  assert.equal(fmtLen(mPt(0.9997), s100), '1.000 m');
  assert.equal(fmtLen(mPt(0.9997), s100, { unit: 'mm' }), '1000 mm');
  assert.equal(fmtLen(mPt(0.9994), s100), '999 mm');
});
