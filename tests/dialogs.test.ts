// The dialogs' own rules, checked without a window: where batch results go (never over an
// original by accident), page lists, typed numbers, PDF dates, sheets of paper; the table read
// from an area (columns, Excel cells, what is pasted); the Excel writer's sheet names; and
// "Reduce size" of a file that needs a password.
// npx tsx --test tests/dialogs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import { unzipSync, strFromU8 } from 'fflate';
import * as mu from '../src/engine/mu';
import { parseRanges, planOutputs, uniqueNames, typedNumber, pdfDate, paperSheets, samePath } from '../src/ui/dlgutil';
import { wordsToTable, cellValue, excelCell, toTsv, toHtml } from '../src/ui/table';
import { writeXlsx } from '../src/ui/xlsxwrite';

test('batch output: an empty addition to the names never writes over the originals', () => {
  const files = ['C:\\Jobs\\A.pdf', 'C:\\Jobs\\B.pdf'];
  for (const s of ['', '   ']) {
    const pl = planOutputs(files, 'suffix', s, '');
    assert.ok(pl.problem, `"${s}" refused`);
    assert.equal(pl.out.size, 0, 'nothing planned');
  }
  assert.ok(planOutputs(files, 'suffix', ' a/b', '').problem, 'no folder signs in a name');
  const ok = planOutputs(files, 'suffix', ' (small)', '');
  assert.equal(ok.problem, null);
  assert.equal(ok.out.get(files[0]), 'C:\\Jobs\\A (small).pdf');
  // only "Replace the originals" targets the originals
  const rep = planOutputs(files, 'replace', '', '');
  assert.equal(rep.out.get(files[1]), files[1]);
});

test('batch output into a folder: the originals\' own folder is refused, same names are numbered', () => {
  const files = ['C:\\Site\\Block A\\Report.pdf', 'C:\\Site\\Block B\\Report.pdf', 'C:\\Site\\Block B\\report.PDF'];
  const pl = planOutputs(files, 'folder', '', 'C:\\Out');
  assert.equal(pl.problem, null);
  const outs = [...pl.out.values()];
  assert.equal(outs.length, 3);
  assert.equal(new Set(outs.map((x) => x.toLowerCase())).size, 3, `all different: ${outs.join(' | ')}`);
  assert.equal(pl.out.get(files[0]), 'C:\\Out\\Report.pdf');
  assert.equal(pl.out.get(files[1]), 'C:\\Out\\Report (2).pdf');
  // the folder of some originals: those are left out (else each result replaced its original)
  const own = planOutputs(files, 'folder', '', 'C:\\Site\\Block B\\');
  assert.ok(own.skip.has(files[1]) && own.skip.has(files[2]));
  assert.ok(!own.skip.has(files[0]));
  // ...and Block A's result is not written over Block B's own Report.pdf (in the list)
  assert.ok(!samePath(own.out.get(files[0])!, files[1]), own.out.get(files[0]));
  assert.ok(planOutputs(files, 'folder', '', '').problem, 'no folder chosen');
});

test('batch output: a name that is another file of the list, or a file open in a tab, is not written over', () => {
  const files = ['D:/x/A.pdf', 'D:/x/A (small).pdf'];
  const pl = planOutputs(files, 'suffix', ' (small)', '');
  assert.equal(pl.out.get(files[0]), 'D:/x/A (small) (2).pdf');
  // replace + open in a tab: left out (the tab's next save would put the old file back)
  const open = planOutputs(['D:/x/A.pdf', 'D:/x/B.pdf'], 'replace', '', '', ['d:\\x\\a.pdf']);
  assert.ok(open.skip.get('D:/x/A.pdf')?.includes('open'));
  assert.equal(open.out.get('D:/x/B.pdf'), 'D:/x/B.pdf');
  const openOut = planOutputs(['D:/x/A.pdf'], 'suffix', ' (flat)', '', ['D:/x/A (flat).pdf']);
  assert.ok(openOut.skip.has('D:/x/A.pdf'));
});

test('split part names are made different', () => {
  assert.deepEqual(uniqueNames(['Doc - Notes', 'Doc - Appendix', 'Doc - notes', 'Doc - Notes']), ['Doc - Notes', 'Doc - Appendix', 'Doc - notes (2)', 'Doc - Notes (3)']);
});

test('page lists: each page once, in the order typed; nothing for a list with none of the pages', () => {
  assert.deepEqual(parseRanges('1-3, 2-4', 10), [0, 1, 2, 3]);
  assert.deepEqual(parseRanges('3,2,1', 10), [2, 1, 0]);
  assert.deepEqual(parseRanges('5-', 7), [4, 5, 6]);
  assert.deepEqual(parseRanges('99', 20), []);
  assert.deepEqual(parseRanges('1–5', 20), [], 'a long dash is not a range');
});

test('typed numbers: decimal comma, no Infinity', () => {
  assert.equal(typedNumber('2,5'), 2.5);
  assert.equal(typedNumber('6.5'), 6.5);
  assert.equal(typedNumber('1,250'), 1250);
  assert.equal(typedNumber('1,234.5'), 1234.5);
  assert.equal(typedNumber(' 100 '), 100);
  for (const bad of ['Infinity', '1e999', '', 'abc', '0', '-5', '1:100', '2,5,']) assert.equal(typedNumber(bad), null, bad);
  assert.equal(typedNumber('2000000', 0, 1e6), null, 'over the top');
});

test('PDF dates are shown as dates', () => {
  assert.equal(pdfDate("D:20230615093000+04'00'"), '15 Jun 2023, 09:30');
  assert.equal(pdfDate('D:2023'), '1 Jan 2023');
  assert.equal(pdfDate('yesterday'), 'yesterday');
});

test('sheets of paper: two-sided halves them', () => {
  assert.equal(paperSheets(10, 2, true, false), 20);
  assert.equal(paperSheets(10, 2, true, true), 10);
  assert.equal(paperSheets(5, 2, true, true), 6, 'each collated copy starts on a new sheet');
  assert.equal(paperSheets(5, 2, false, true), 5);
});

test('table: a title or a merged header does not glue the columns together', () => {
  const w = (text: string, x0: number, y0: number, x1: number, y1: number) => ({ text, box: [x0, y0, x1, y1] });
  // the audit's case
  assert.deepEqual(wordsToTable([w('TITLE', 0, 0, 500, 10), w('A', 0, 20, 40, 30), w('1', 60, 20, 80, 30), w('B', 100, 20, 140, 30)]), [['TITLE', '', ''], ['A', '1', 'B']]);
  // a BoQ: title line, a header "Quantities" over Qty / Unit, rows
  const rows = wordsToTable([
    w('BILL', 0, 0, 30, 10), w('No.', 34, 0, 50, 10), w('2', 54, 0, 60, 10), w('-', 64, 0, 68, 10), w('SUBSTRUCTURE', 72, 0, 300, 10),
    w('Item', 0, 20, 30, 30), w('Description', 60, 20, 140, 30), w('Quantities', 200, 20, 300, 30),
    w('Qty', 200, 40, 230, 50), w('Unit', 260, 40, 300, 50),
    w('1.1', 0, 60, 20, 70), w('Concrete', 60, 60, 120, 70), w('grade', 124, 60, 160, 70), w('120', 200, 60, 225, 70), w('m3', 260, 60, 280, 70),
    w('1.2', 0, 80, 20, 90), w('Rebar', 60, 80, 100, 90), w('14.5', 200, 80, 230, 90), w('t', 260, 80, 268, 90),
  ]);
  assert.equal(rows[0].length, 4, JSON.stringify(rows));
  assert.deepEqual(rows[3], ['1.1', 'Concrete grade', '120', 'm3']);
  assert.deepEqual(rows[4], ['1.2', 'Rebar', '14.5', 't']);
  assert.equal(rows[1][2], 'Quantities', 'the merged header in the first column it covers');
  // a clean table comes out exactly as before
  assert.deepEqual(wordsToTable([w('a', 0, 0, 20, 10), w('b', 50, 0, 70, 10), w('c', 0, 20, 20, 30), w('d', 50, 20, 70, 30)]), [['a', 'b'], ['c', 'd']]);
});

test('Excel cells: numbers become numbers, codes stay as read', () => {
  for (const code of ['007', '01', '1234567890123456789', '1,2,3', '00', '12,34']) assert.equal(cellValue(code), code, code);
  assert.equal(cellValue('1,234.50'), 1234.5);
  assert.equal(cellValue('-5'), -5);
  assert.equal(cellValue('0.5'), 0.5);
  assert.equal(cellValue('0'), 0);
  assert.equal(cellValue('123456789012345'), 123456789012345, '15 digits are kept exactly');
  assert.deepEqual(excelCell('12.50'), { v: 12.5, s: 'n2' });
  assert.deepEqual(excelCell('1.10'), { v: 1.1, s: 'n2' });
  assert.deepEqual(excelCell('1,250'), { v: 1250, s: 'n0' });
  assert.equal(excelCell('42'), 42);
});

test('copied table: cells that Excel would run as formulas are pasted as text', () => {
  const t = [['=HYPERLINK("http://x","y")', '-5', '+971 50 123 4567', '@SUM(A1)', '-', 'plain', '+12.5']];
  assert.equal(toTsv(t), `'=HYPERLINK("http://x","y")\t-5\t'+971 50 123 4567\t'@SUM(A1)\t'-\tplain\t+12.5`);
  const h = toHtml(t);
  assert.equal((h.match(/mso-number-format/g) || []).length, 4, h);
  assert.ok(h.includes('<td>-5</td>') && h.includes('<td>plain</td>'));
  assert.ok(!toTsv([['a\rb']]).includes('\r\n\r'), 'a stray CR does not start a row');
});

test('Excel writer: sheet names different from each other, quotes in names', () => {
  const x = writeXlsx([
    { name: 'Bill 1', rows: [['a'], ['b']], header: 1 },
    { name: 'bill 1', rows: [['c']] },
    { name: "Owner's", rows: [['h'], ['1']], header: 1 },
    { name: 'History', rows: [['z']] },
  ]);
  const wb = strFromU8(unzipSync(x)['xl/workbook.xml']);
  const names = [...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['Bill 1', 'bill 1 (2)', "Owner's", 'History (2)']);
  assert.ok(wb.includes("'Owner''s'!$A$1"), wb);
});

test('"Reduce size" of a file opened with its password: works with it, stays protected', () => {
  const d = new mupdf.PDFDocument();
  const raw = new Uint8Array(1600 * 1200 * 3);
  let sd = 7;
  for (let i = 0; i < raw.length; i++) { sd = (sd * 1103515245 + 12345) & 0x7fffffff; raw[i] = ((i / 3) % 1600) / 8 + ((sd >> 24) % 40); }
  const img = d.addStream(raw, { Type: 'XObject', Subtype: 'Image', Width: 1600, Height: 1200, BitsPerComponent: 8, ColorSpace: 'DeviceRGB' });
  d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, { XObject: { Im0: img } }, 'q 842 0 0 595 0 0 cm /Im0 Do Q'));
  const enc = d.saveToBuffer('compress,encrypt=aes-256,user-password=abc,owner-password=own').asUint8Array().slice();
  assert.throws(() => mu.compress(enc, { dpi: 96, quality: 55 }), /password/);
  const { bytes } = mu.compress(enc, { dpi: 96, quality: 55 }, 'abc');
  assert.ok(bytes && bytes.length < enc.length / 2, `smaller: ${enc.length} -> ${bytes?.length}`);
  const back = mupdf.Document.openDocument(bytes!, 'application/pdf');
  assert.equal(back.needsPassword(), true, 'still needs its password');
  assert.ok(back.authenticatePassword('abc'));
});
