// Measure > To Excel: the "By sheet" table - items down, sheets across, totals at the right and
// bottom, numbers as numbers; turned past SHEET_COLS_MAX sheets. Built from generated marks and
// read back from the written .xlsx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { bySheetTable, SHEET_COLS_MAX, type SheetMark } from '../src/ui/measurexl';
import { writeXlsx } from '../src/ui/xlsxwrite';

type Cell = { v: string | number; t: 'n' | 's'; s?: number };
/** the first sheet of a written workbook as { 'B3': cell } plus its name */
function read(bytes: Uint8Array) {
  const z = unzipSync(bytes);
  const wb = strFromU8(z['xl/workbook.xml']);
  const name = /<sheet name="([^"]*)"/.exec(wb)![1];
  const xml = strFromU8(z['xl/worksheets/sheet1.xml']);
  const cells: Record<string, Cell> = {};
  for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"(?: s="(\d+)")?( t="inlineStr")?>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([^<]*)<\/t><\/is>)<\/c>/g)) {
    cells[m[1]] = m[3] ? { v: m[5], t: 's' } : { v: Number(m[4]), t: 'n', s: m[2] ? Number(m[2]) : undefined };
  }
  return { name, cells, xml, sheets: (wb.match(/<sheet /g) || []).length };
}
const num = (v: number, dec = 2) => ({ v, unit: 'm', dec });
const count = (page: number, group: string, label?: string): SheetMark => ({ page, label, kind: 'measure-count', group, num: null, perimeter: null });
const length = (page: number, v: number, label?: string): SheetMark => ({ page, label, kind: 'measure-length', num: num(v), perimeter: null });

test('several items on several labelled pages: rows, columns and totals', () => {
  const marks: SheetMark[] = [
    count(0, 'Socket', 'A-101'), count(0, 'Socket', 'A-101'), count(2, 'Socket', 'A-103'), count(2, 'Switch', 'A-103'),
    length(0, 2.5, 'A-101'), length(2, 4.25, 'A-103'), length(2, 1, 'A-103'),
    { page: 2, label: 'A-103', kind: 'measure-area', num: { v: 12.5, unit: 'm²', dec: 2 }, perimeter: num(14.2, 2) },
  ];
  const r = read(writeXlsx([bySheetTable(marks)]));
  assert.equal(r.name, 'By sheet');
  assert.equal(r.sheets, 1);
  // header: Item, Unit, A-101, A-103, Total; second header row: the PDF pages (1 and 3)
  assert.deepEqual([r.cells.A1.v, r.cells.B1.v, r.cells.C1.v, r.cells.D1.v, r.cells.E1.v], ['Item', 'Unit', 'A-101', 'A-103', 'Total']);
  assert.deepEqual([r.cells.A2.v, r.cells.C2.v, r.cells.D2.v], ['PDF page', 1, 3]);
  assert.equal(r.cells.C2.t, 'n');
  // counts first by name: Socket 2 + 1, Switch 0 + 1 (a sheet without it is empty, not 0)
  assert.deepEqual([r.cells.A3.v, r.cells.B3.v, r.cells.C3.v, r.cells.D3.v, r.cells.E3.v], ['Socket', 'No.', 2, 1, 3]);
  assert.equal(r.cells.C3.t, 'n');
  assert.deepEqual([r.cells.A4.v, r.cells.C4, r.cells.D4.v, r.cells.E4.v], ['Switch', undefined, 1, 1]);
  // then the kinds, each with its unit, in the panel's order
  assert.deepEqual([r.cells.A5.v, r.cells.B5.v, r.cells.C5.v, r.cells.D5.v, r.cells.E5.v], ['Lengths', 'm', 2.5, 5.25, 7.75]);
  assert.deepEqual([r.cells.A6.v, r.cells.B6.v, r.cells.D6.v, r.cells.E6.v], ['Areas', 'm²', 12.5, 12.5]);
  assert.deepEqual([r.cells.A7.v, r.cells.B7.v, r.cells.D7.v, r.cells.E7.v], ['Areas: perimeters', 'm', 14.2, 14.2]);
  // the bottom row adds the counts only (a length can't be added to a count)
  assert.deepEqual([r.cells.A8.v, r.cells.C8.v, r.cells.D8.v, r.cells.E8.v], ['Total counts', 2, 2, 4]);
  assert.equal(r.cells.A9, undefined);
  assert.match(r.xml, /<pane ySplit="2"/);
  assert.doesNotMatch(r.xml, /autoFilter/);
});

test('no labels, one page: the page number heads the column, one header row', () => {
  const r = read(writeXlsx([bySheetTable([count(6, 'Door'), count(6, 'Door'), length(6, 3)])]));
  assert.deepEqual([r.cells.C1.v, r.cells.D1.v], [7, 'Total']);
  assert.equal(r.cells.C1.t, 'n');
  assert.deepEqual([r.cells.A2.v, r.cells.C2.v, r.cells.D2.v], ['Door', 2, 2]);
  assert.deepEqual([r.cells.A3.v, r.cells.C3.v, r.cells.D3.v], ['Lengths', 3, 3]);
  assert.deepEqual([r.cells.A4.v, r.cells.C4.v, r.cells.D4.v], ['Total counts', 2, 2]);
  assert.match(r.xml, /<pane ySplit="1"/);
});

test('a label equal to the number counts as none; a count-less file has no bottom row', () => {
  const r = read(writeXlsx([bySheetTable([length(1, 1.5, '2'), length(3, 2, '4')])]));
  assert.deepEqual([r.cells.C1.v, r.cells.D1.v], [2, 4]);
  assert.deepEqual([r.cells.A2.v, r.cells.C2.v, r.cells.D2.v, r.cells.E2.v], ['Lengths', 1.5, 2, 3.5]);
  assert.equal(r.cells.A3, undefined);
});

test('two units of one kind are two rows; angles are counted, not added', () => {
  const marks: SheetMark[] = [
    length(0, 2), { page: 0, kind: 'measure-length', num: { v: 10, unit: 'ft', dec: 1 }, perimeter: null },
    { page: 0, kind: 'measure-angle', num: { v: 90, unit: '°', dec: 0 }, perimeter: null },
    { page: 0, kind: 'measure-angle', num: { v: 45, unit: '°', dec: 0 }, perimeter: null },
  ];
  const r = read(writeXlsx([bySheetTable(marks)]));
  assert.deepEqual([r.cells.A2.v, r.cells.B2.v, r.cells.C2.v], ['Lengths', 'ft', 10]);
  assert.deepEqual([r.cells.A3.v, r.cells.B3.v, r.cells.C3.v], ['Lengths', 'm', 2]);
  assert.deepEqual([r.cells.A4.v, r.cells.B4.v, r.cells.C4.v], ['Angles', 'No.', 2]);
});

test('sums are clean numbers (no float noise) in the row\'s decimals', () => {
  const r = read(writeXlsx([bySheetTable([length(0, 0.1), length(0, 0.2), length(0, 0.3)])]));
  assert.equal(r.cells.C2.v, 0.6);
  assert.equal(r.cells.C2.s, 3, 'two decimals: the n2 style');
});

test('thousands of pages: turned, a row per sheet with marks, totals right', () => {
  const marks: SheetMark[] = [];
  const N = 3000;
  for (let p = 0; p < N; p++) { marks.push(count(p, 'Socket', 'S-' + p), length(p, 1.5, 'S-' + p)); if (p % 3 === 0) marks.push(count(p, 'Switch', 'S-' + p)); }
  // pages without marks aren't rows
  const r = read(writeXlsx([bySheetTable(marks)]));
  assert.equal(r.cells.A1.v, 'Sheet');
  assert.equal(r.cells.B1.v, 'PDF page');
  assert.deepEqual([r.cells.C1.v, r.cells.D1.v, r.cells.E1.v, r.cells.F1.v], ['Socket', 'Switch', 'Lengths', 'Total counts']);
  assert.deepEqual([r.cells.C2.v, r.cells.E2.v, r.cells.F2.v], ['No.', 'm', 'No.']);
  assert.deepEqual([r.cells.A3.v, r.cells.B3.v, r.cells.C3.v, r.cells.D3.v, r.cells.E3.v, r.cells.F3.v], ['S-0', 1, 1, 1, 1.5, 2]);
  assert.deepEqual([r.cells.A4.v, r.cells.B4.v, r.cells.C4.v, r.cells.D4, r.cells.F4.v], ['S-1', 2, 1, undefined, 1]);
  const last = N + 2;
  assert.equal(r.cells['A' + last].v, 'S-' + (N - 1));
  const tot = last + 1;
  assert.deepEqual([r.cells['A' + tot].v, r.cells['C' + tot].v, r.cells['D' + tot].v, r.cells['E' + tot].v, r.cells['F' + tot].v], ['Total', N, 1000, 4500, N + 1000]);
  assert.equal(r.cells['C' + tot].t, 'n');
});

test('the switch point: SHEET_COLS_MAX sheets across, one more turns it', () => {
  const marks = (n: number) => Array.from({ length: n }, (_, p) => count(p, 'Door'));
  assert.equal(read(writeXlsx([bySheetTable(marks(SHEET_COLS_MAX))])).cells.A1.v, 'Item');
  assert.equal(read(writeXlsx([bySheetTable(marks(SHEET_COLS_MAX + 1))])).cells.A1.v, 'Sheet');
});

test('nothing to table: a header only, no crash', () => {
  const r = read(writeXlsx([bySheetTable([])]));
  assert.deepEqual([r.cells.A1.v, r.cells.B1.v, r.cells.C1.v], ['Item', 'Unit', 'Total']);
});
