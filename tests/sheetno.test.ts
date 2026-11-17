// The sheet-number helpers ported from Rev Radar 0.4.5 (tests/pairing.test.ts, titleblock): invented numbers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawingNo, drawingNoBare, noZeros, sheetNo, cleanTitle, normName, rightStrip, bottomStrip, inTitleBand, sizeKey } from '../src/ui/sheetno';

test('drawing numbers from file names', () => {
  assert.equal(drawingNo('PRJ-AB1-DWG-AR-10140-GA L04.pdf'), 'PRJ-AB1-DWG-AR-10140');
  assert.equal(drawingNo('PRJ-AB1-DWG-AR-10140 - GA L04.pdf'), 'PRJ-AB1-DWG-AR-10140');
  assert.equal(drawingNo('PRJ-AR-GA-L01_Rev B.pdf'), 'PRJ-AR-GA-L01');
  assert.equal(drawingNo('PRJ-AR-GA-L01-RevB.pdf'), 'PRJ-AR-GA-L01');
  assert.equal(drawingNo('A101 (Rev 2).pdf'), 'A101');
  assert.equal(drawingNoBare('AR-L01-P02'), 'AR-L01');
  assert.equal(normName('Ground Floor Plan Rev C.pdf'), 'GROUND FLOOR PLAN');
  assert.equal(normName('Ground Floor Plan (1).pdf'), 'GROUND FLOOR PLAN');
});

test('counters in names are not drawing numbers', () => {
  assert.equal(drawingNo('Ground Floor Part 01.pdf'), '');
  assert.equal(drawingNo('AR 101 - Plan.pdf'), 'AR101');
  assert.equal(drawingNo('Plan A101.pdf'), 'A101');
});

test('an issue date in the name is not part of the number', () => {
  assert.equal(drawingNo('20261001_A-101.pdf'), 'A-101');
  assert.equal(drawingNo('2026-09-01 P111.1-AB7-DWG-AR-100104.pdf'), 'P111-1-AB7-DWG-AR-100104');
});

test('the number as written keeps - _ . (pairing compares without them)', () => {
  assert.equal(drawingNo('P111.1-AB7-DWG-AR-100101.pdf'), 'P111-1-AB7-DWG-AR-100101');
  assert.equal(drawingNo('P111.1-AB7-DWG-AR-100101.pdf', true), 'P111.1-AB7-DWG-AR-100101');
  assert.equal(drawingNo('PRJ_AR_GA_01001 - GA L04.pdf', true), 'PRJ_AR_GA_01001');
});

test('revision / status codes at the end of a number; level and zone codes stay', () => {
  assert.equal(drawingNoBare('A101-C02'), 'A101');
  assert.equal(drawingNoBare('PRJ-AR-GA-01005-S2-P03'), 'PRJ-AR-GA-01005');
  assert.equal(drawingNoBare('PRJ-AR-GA-L01'), 'PRJ-AR-GA-L01');
  assert.equal(drawingNoBare('PRJ-AR-GA-R1'), 'PRJ-AR-GA-R1');
  assert.equal(drawingNoBare('AR-B2'), 'AR-B2');
});

test('leading zeros dropped from the number', () => {
  assert.equal(noZeros('AR-0101'), 'AR-101');
  assert.equal(noZeros('GA-L01'), 'GA-L1');
  assert.equal(noZeros(''), '');
});

test('the sheet number as written, without a revision / status code', () => {
  assert.equal(sheetNo('PRJ-AR-GA-01005_C02.pdf'), 'PRJ-AR-GA-01005');
  assert.equal(sheetNo('P111.1-AB7-DWG-AR-100101.pdf'), 'P111.1-AB7-DWG-AR-100101');
  assert.equal(sheetNo('P111.1-AB7-DWG-AR-100101 Rev B.pdf'), 'P111.1-AB7-DWG-AR-100101');
  assert.equal(sheetNo('Ground Floor Part 01.pdf'), '');
});

test('a roof level code "R1" is not a revision: PRJ-AR-GA-R1 and -R2 are two sheets', () => {
  assert.notEqual(normName('PRJ-AR-GA-R1.pdf'), normName('PRJ-AR-GA-R2.pdf'));
  assert.equal(normName('A101_R2.pdf'), normName('A101_R3.pdf'));
});

test('titles in any script are kept; numbers and marks alone are not a title (RR-033)', () => {
  assert.equal(cleanTitle('الواجهة الشمالية'), 'الواجهة الشمالية');
  assert.equal(cleanTitle('Фасад северный'), 'Фасад северный');
  assert.equal(cleanTitle('Πρόσοψη βόρεια'), 'Πρόσοψη βόρεια');
  assert.equal(cleanTitle('北立面'), '北立面');
  assert.equal(cleanTitle('Ground Floor Plan'), 'Ground Floor Plan');
  assert.equal(cleanTitle('- 2026-07-13 -'), '');
  assert.equal(cleanTitle('(2)'), '');
  assert.equal(cleanTitle('Rev 03'), '');
});

test('title strips keep their paper size: at least 120 / 60 mm', () => {
  const mm = 72 / 25.4;
  // A0 landscape (points): the fifth / 15 % are wider than the minimum
  assert.ok(Math.abs(rightStrip(3370) - 0.8 * 3370) < 1e-9);
  assert.ok(Math.abs(bottomStrip(2384) - 0.85 * 2384) < 1e-9);
  // A4 landscape: the minimum wins
  assert.ok(Math.abs(rightStrip(842) - (842 - 120 * mm)) < 1e-9);
  assert.ok(Math.abs(bottomStrip(595) - (595 - 60 * mm)) < 1e-9);
});

test('the title band: right strip, bottom strip and the outer margin; the middle is drawing', () => {
  const w = 3370, h = 2384;
  assert.equal(inTitleBand([3000, 1000, 3100, 1100], w, h), true);
  assert.equal(inTitleBand([1000, 2200, 1100, 2300], w, h), true);
  assert.equal(inTitleBand([50, 1000, 60, 1100], w, h), true);
  assert.equal(inTitleBand([1000, 20, 1100, 30], w, h), true);
  assert.equal(inTitleBand([1000, 1000, 1100, 1100], w, h), false);
});

test('sheets group by size rounded to 10 points', () => {
  assert.equal(sizeKey({ w: 3370, h: 2384 }), '3370x2380');
  assert.equal(sizeKey({ w: 3373.2, h: 2383.9 }), '3370x2380');
  assert.equal(sizeKey({ w: 841.89, h: 595.28 }), '840x600');
});
