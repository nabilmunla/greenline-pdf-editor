// Export to Word / Excel (src/engine/convert): tables from ruled and unruled pages, rows of
// a bill, numbers, running headers, scans (OCR words + lines found in the picture), Word
// structure. The scored corpus lives in tests/export (Python + LibreOffice, see its README).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { ExportJob } from '../src/engine/convert/index';
import { FontTable, readPage, wordsOf } from '../src/engine/convert/extract';
import { analyzePage, markRunning } from '../src/engine/convert/analyze';
import { parseNumber, fixOcrNumber } from '../src/engine/convert/text';
import { readingOrder } from '../src/engine/convert/rows';
import type { Glyph } from '../src/engine/convert/model';

const T = (f: string, s: number, x: number, y: number, t: string) => `BT /${f} ${s} Tf ${x} ${y} Td (${t}) Tj ET `;
function pdf(pages: ((d: mupdf.PDFDocument, f: { F1: unknown; F2: unknown }) => string)[], w = 595, h = 842): mupdf.Document {
  const d = new mupdf.PDFDocument();
  const F1 = d.addSimpleFont(new mupdf.Font('Helvetica')), F2 = d.addSimpleFont(new mupdf.Font('Helvetica-Bold'));
  for (const p of pages) d.insertPage(-1, d.addPage([0, 0, w, h], 0, d.addObject({ Font: { F1, F2 } }), p(d, { F1, F2 })));
  const bytes = d.saveToBuffer('').asUint8Array().slice();
  return mupdf.Document.openDocument(bytes, 'application/pdf');
}
const COLS = [50, 90, 330, 390, 430, 490, 560];
/** a bill page: column lines only, header box, items whose descriptions wrap (values on the last line) */
function bill(items: string[][], title: string, pageNo: number) {
  return () => {
    let c = '0 0 0 RG 0.7 w ';
    for (const x of COLS) c += `${x} 760 m ${x} 120 l S `;
    c += `50 760 m 560 760 l S 50 735 m 560 735 l S 50 120 m 560 120 l S `;
    c += T('F2', 12, 50, 800, 'PROJECT X - VILLA COMPLEX') + T('F2', 11, 50, 782, title);
    ['ITEM', 'DESCRIPTION', 'QTY', 'UNIT', 'RATE', 'AMOUNT'].forEach((hd, i) => { c += T('F2', 9, COLS[i] + 4, 744, hd); });
    let y = 718;
    for (const [ref, desc, qty, unit, rate, amt] of items) {
      const lines: string[] = [];
      let cur = '';
      for (const wd of desc.split(' ')) { if ((cur + ' ' + wd).trim().length > 52) { lines.push(cur.trim()); cur = wd; } else cur += ' ' + wd; }
      lines.push(cur.trim());
      c += T('F1', 9, COLS[0] + 4, y, ref);
      lines.forEach((l, k) => { c += T('F1', 9, COLS[1] + 4, y - k * 11, l); });
      const ly = y - (lines.length - 1) * 11;
      const R = (i: number, t: string) => T('F1', 9, COLS[i + 1] - 4 - t.length * 5, ly, t);
      c += R(2, qty) + T('F1', 9, COLS[3] + 6, ly, unit) + R(4, rate) + R(5, amt);
      y = ly - 20;
    }
    return c + T('F1', 8, 280, 60, 'Page ' + pageNo);
  };
}
const ITEMS = [
  ['A', 'Excavation in any material not exceeding 2.00m deep including disposal of surplus material off site', '1,250', 'm3', '45.50', '56,875.00'],
  ['B', 'Ditto 2.00 - 4.00m deep', '340', 'm3', '52.00', '17,680.00'],
  ['C', 'Supply and install 600x600mm porcelain floor tiles laid on 40mm screed including grout and skirting', '15,393', 'm2', '120.00', '1,847,160.00'],
  ['D', 'Blockwork 200mm thick in cement mortar', '2,400', 'm2', '85.00', '204,000.00'],
];

/** cell texts of a sheet: row -> [col -> value] from the .xlsx */
function sheetValues(xlsx: Uint8Array, n = 1): (string | number)[][] {
  const z = unzipSync(xlsx);
  const sst = [...strFromU8(z['xl/sharedStrings.xml']).matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<'));
  const xml = strFromU8(z[`xl/worksheets/sheet${n}.xml`]);
  const rows: (string | number)[][] = [];
  for (const r of xml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const out: (string | number)[] = [];
    for (const c of r[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = c[1].charCodeAt(0) - 65;
      const v = /<v>([^<]*)<\/v>/.exec(c[3] || '')?.[1];
      if (v === undefined) continue;
      out[col] = /t="s"/.test(c[2]) ? sst[Number(v)] : Number(v);
    }
    rows[Number(r[1]) - 1] = out;
  }
  return rows;
}

test('a bill over two pages -> one sheet, header once, one row per item, numbers', () => {
  const doc = pdf([bill(ITEMS.slice(0, 2), 'BILL NO. 2 - FINISHES', 1), bill(ITEMS.slice(2), 'BILL NO. 2 - FINISHES', 2)]);
  const j = new ExportJob(doc, { format: 'xlsx' });
  for (let i = 0; i < j.count(); i++) j.read(i);
  const xlsx = j.finish();
  assert.ok(strFromU8(unzipSync(xlsx)['xl/workbook.xml']).includes('BILL NO. 2'), 'sheet named after the bill');
  const flat = sheetValues(xlsx).filter(Boolean);
  assert.equal(flat.filter((r) => r.includes('DESCRIPTION')).length, 1, 'header row once');
  const items = flat.filter((r) => /^[A-D]$/.test(String(r[0])));
  assert.equal(items.length, 4);
  const c = items.find((r) => r[0] === 'C')!;
  assert.match(String(c[1]), /^Supply and install .* grout and skirting$/);
  assert.deepEqual(c.slice(2, 6), [15393, 'm2', 120, 1847160]);
  assert.ok(!flat.some((r) => r.some((v) => /^Page \d/.test(String(v)))), 'page numbers left out');
});

test('steel section tables: columns ruled only in groups, decimal commas, powers of ten, headings on their side', () => {
  const read = (f: string) => {
    const j = new ExportJob(mupdf.Document.openDocument(readFileSync(f), 'application/pdf'), { format: 'xlsx' });
    for (let i = 0; i < j.count(); i++) j.read(i);
    return sheetValues(j.finish()).filter(Boolean);
  };
  // one page: designation and weight in one ruled box, three classes under each heading
  const a = read('tests/data/steel-sections.pdf');
  const r = a.find((x) => x[0] === 'HE 240 AA')!;
  assert.ok(r, 'a row per section, the designation alone in its cell');
  assert.deepEqual(r.slice(1, 6), [47.4, 5835, 521, 570.6, 9.83], 'each value in its own cell, 47,4 read as 47.4');
  assert.deepEqual(r.slice(14, 20), [3, 4, '-', 3, 4, '-'], 'the six class columns apart');
  const flatA = a.flat().map(String);
  assert.ok(flatA.includes('x 10⁴') && !flatA.includes('x 104'), 'x 10 with a raised 4 is x 10⁴');
  assert.ok(flatA.includes('S 235') && flatA.includes('EN 10025:1993'), 'headings printed upwards are there');
  // three pages: five dimensions under one heading, 1,359 m²/m in a decimal-comma file is 1.359
  const b = read('tests/data/steel-sections-3p.pdf');
  const s = b.find((x) => x[0] === 'HE 240 AA•')!;
  assert.deepEqual(s.slice(1, 15), [47.4, 224, 240, 6.5, 9, 21, 60.4, 206, 164, 'M 27', 104, 138, 1.359, 28.67]);
});

test('rows of a bill: item numbers on the last line (bottom-aligned printouts)', () => {
  const doc = pdf([() => {
    let c = '0 0 0 RG 0.7 w ';
    for (const x of COLS) c += `${x} 760 m ${x} 500 l S `;
    c += '50 760 m 560 760 l S 50 740 m 560 740 l S 50 500 m 560 500 l S ';
    ['ITEM', 'DESCRIPTION', 'QTY', 'UNIT'].forEach((hd, i) => { c += T('F2', 9, COLS[i] + 4, 748, hd); });
    // the item letter and quantities sit on each item's LAST line
    c += T('F1', 9, 94, 725, 'Excavation in any material not exceeding 2m deep') + T('F1', 9, 94, 714, 'including disposal off site');
    c += T('F1', 9, 54, 714, 'A') + T('F1', 9, 360, 714, '1,250') + T('F1', 9, 396, 714, 'm3');
    c += T('F1', 9, 94, 700, 'Plaster to walls 15mm thick in two coats to') + T('F1', 9, 94, 689, 'blockwork, finished smooth');
    c += T('F1', 9, 54, 689, 'B') + T('F1', 9, 360, 689, '4,800') + T('F1', 9, 396, 689, 'm2');
    return c;
  }]);
  const pl = analyzePage(readPage(doc, 0, new FontTable(), { pictures: false, dpi: 72 }), false);
  const t = pl.tables[0];
  assert.ok(t, 'table found');
  const body = t.rows.filter((r) => !r.head).length;
  assert.equal(body, 2, 'two items, each with its two lines');
  const a = t.cells.find((c) => c.words.some((w) => w.text === 'Excavation'))!;
  assert.ok(a.words.some((w) => w.text === 'disposal'), 'wrapped line in the same cell');
});

test('a table without any lines (columns from the white space)', () => {
  const doc = pdf([() => {
    let c = '';
    const rows = [['Item', 'Description', 'Qty', 'Unit', 'Rate', 'Amount'], ['5.01', 'Timber flush door 900x2100mm', '300', 'nr', '1,638.81', '491,643.00'], ['5.02', 'Fire rated door 1800x2400mm', '8', 'No', '9,143.65', '73,149.20'], ['5.03', 'Steel door to services rooms', '18', 'nr', '3,647.00', '65,646.00'], ['5.04', 'Ironmongery set IR-03', '314', 'nr', '714.73', '224,425.22']];
    const xs = [40, 80, 330, 380, 420, 480];
    rows.forEach((r, k) => r.forEach((v, i) => { c += T('F1', 9, xs[i], 700 - k * 18, v); }));
    return c;
  }]);
  const pl = analyzePage(readPage(doc, 0, new FontTable(), { pictures: false, dpi: 72 }), false);
  const t = pl.tables[0];
  assert.ok(t, 'table found');
  assert.equal(t.xs.length - 1, 6, 'six columns');
  assert.equal(t.rows.length, 5);
  assert.ok(t.rows[0].head, 'header row');
});

test('numbers as printed: thousands, decimals, brackets, percent, codes stay text', () => {
  assert.deepEqual(parseNumber('1,234.50'), { v: 1234.5, fmt: '#,##0.00' });
  assert.deepEqual(parseNumber('(1,234.00)'), { v: -1234, fmt: '#,##0.00;(#,##0.00)' });
  assert.equal(parseNumber('12.5%')!.v, 0.125);
  assert.equal(parseNumber('AED 1,200.00')!.v, 1200);
  assert.equal(parseNumber('007'), null);
  assert.equal(parseNumber('15/03/2024'), null);
  assert.equal(parseNumber('m2'), null);
  // OCR: letters for digits, a lost decimal point in a two-decimal column
  assert.equal(fixOcrNumber('1,2O0.50'), '1,200.50');
  assert.equal(fixOcrNumber('2,13400', true), '2,134.00');
  assert.equal(fixOcrNumber('44100', true), '441.00');
  assert.equal(fixOcrNumber('44100', false), '44100');
});

test('running headers, footers and page numbers', () => {
  const doc = pdf([1, 2, 3].map((n) => () => T('F1', 9, 50, 810, 'Residential Tower - Specification') + T('F1', 11, 50, 700, `Body text of page ${n} that changes.`) + T('F1', 8, 280, 30, `Page ${n} of 3`)));
  const fonts = new FontTable();
  const pls = [0, 1, 2].map((i) => analyzePage(readPage(doc, i, fonts, { pictures: false, dpi: 72 }), true));
  markRunning(pls);
  for (const pl of pls) {
    const kinds = [...pl.running.values()].sort();
    assert.deepEqual(kinds, ['f', 'h']);
    assert.equal(pl.pageNo.size, 1);
  }
});

test('Arabic: lam-alef ligature order, full stop at the end of the sentence', () => {
  const g = (c: string, x0: number, x1: number): Glyph => ({ c, x0, x1, y0: 0, y1: 10, base: 8, size: 10, f: 0, color: 0, rtl: true });
  // as MuPDF gives it: alef (no width, at the ligature's right end) before lam
  const ws = wordsOf([g('ا', 30, 30), g('ل', 24, 30), g('ز', 18, 24)], 0);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].text, 'لاز');
  const row = { rtl: true, words: [
    { text: '.', x0: 100, x1: 102, y0: 0, y1: 10, base: 8, size: 10, g: [], rtl: false },
    { text: 'يجب', x0: 80, x1: 98, y0: 0, y1: 10, base: 8, size: 10, g: [], rtl: true },
    { text: 'الأعمال', x0: 40, x1: 78, y0: 0, y1: 10, base: 8, size: 10, g: [], rtl: true },
  ] };
  assert.deepEqual(readingOrder(row).map((w) => w.text), ['يجب', 'الأعمال.']);
});

test('a scan: words from OCR, table lines found in the picture, a stamp left out', () => {
  // the "scan": a picture of a ruled table with a blue stamp over it
  const src = pdf([() => {
    let c = '0 0 0 RG 1.2 w ';
    for (const x of [50, 150, 400, 500]) c += `${x} 700 m ${x} 500 l S `;
    for (const y of [700, 670, 500]) c += `50 ${y} m 500 ${y} l S `;
    c += T('F2', 10, 60, 680, 'REF') + T('F2', 10, 160, 680, 'DESCRIPTION') + T('F2', 10, 410, 680, 'QTY');
    c += T('F1', 10, 60, 650, 'A') + T('F1', 10, 160, 650, 'Concrete grade C40') + T('F1', 10, 420, 650, '120');
    c += T('F1', 10, 60, 620, 'B') + T('F1', 10, 160, 620, 'Reinforcement bars') + T('F1', 10, 420, 620, '45');
    c += 'q 0.15 0.3 0.85 rg 0.15 0.3 0.85 RG 2 w 200 540 160 40 re S ' + T('F2', 16, 215, 553, 'RECEIVED') + 'Q ';
    return c;
  }]);
  const pix = src.loadPage(0).toPixmap([200 / 72, 0, 0, 200 / 72, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
  const d = new mupdf.PDFDocument();
  const im = d.addImage(new mupdf.Image(pix));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { XObject: { I: im } }, 'q 595 0 0 842 0 0 cm /I Do Q'));
  const scan = mupdf.Document.openDocument(d.saveToBuffer('').asUint8Array().slice(), 'application/pdf');
  const j = new ExportJob(scan, { format: 'xlsx', dropStamps: true });
  assert.equal(j.read(0).kind, 'scan');
  // what OCR would say (page points, top-left origin)
  const top = (y: number) => 842 - y;
  const w = (text: string, x: number, y: number, wd: number) => ({ text, conf: 92, box: [x, top(y) - 9, x + wd, top(y) + 2] });
  j.addOcr(0, { angle: 0, words: [
    w('REF', 60, 680, 20), w('DESCRIPTION', 160, 680, 70), w('QTY', 410, 680, 22),
    w('A', 60, 650, 7), w('Concrete', 160, 650, 42), w('grade', 205, 650, 28), w('C40', 236, 650, 20), w('120', 420, 650, 17),
    w('B', 60, 620, 7), w('Reinforcement', 160, 620, 66), w('bars', 229, 620, 20), w('45', 420, 620, 11),
    { text: 'RECEIVED', conf: 90, box: [215, top(553) - 12, 300, top(553) + 2] },
  ] });
  const pm = j.pages[0];
  assert.ok(!pm.words.some((x) => x.text === 'RECEIVED'), 'stamp words left out');
  assert.ok(pm.rulings.filter((r) => r.o === 'v').length >= 4, 'upright table lines found in the picture');
  const pl = analyzePage(pm, false);
  assert.equal(pl.tables.length, 1);
  const rows = sheetValues(j.finish());
  const b = rows.filter(Boolean).find((r) => r[0] === 'B')!;
  assert.deepEqual(b, ['B', 'Reinforcement bars', 45]);
});

test('Word: headings, a table, page breaks, header/footer, right-to-left', () => {
  const doc = pdf([1, 2].map((n) => (dd) => {
    let c = T('F1', 9, 50, 810, 'Tender Addendum No. 2') + T('F1', 8, 280, 30, `Page ${n} of 2`);
    c += T('F2', 16, 50, 760, n === 1 ? 'GENERAL NOTES' : 'MORE NOTES');
    for (let k = 0; k < 6; k++) c += T('F1', 10, 50, 730 - k * 13, `This is line ${k + 1} of the paragraph on page ${n}, it runs on.`);
    c += '0 0 0 RG 0.5 w 50 600 m 400 600 l S 50 580 m 400 580 l S 50 560 m 400 560 l S 50 600 m 50 560 l S 200 600 m 200 560 l S 400 600 m 400 560 l S ';
    c += T('F1', 10, 55, 586, 'Type') + T('F1', 10, 205, 586, 'Size') + T('F1', 10, 55, 566, 'PT-01') + T('F1', 10, 205, 566, '600 x 600');
    void dd;
    return c;
  }));
  const j = new ExportJob(doc, { format: 'docx', title: 'notes' });
  for (let i = 0; i < j.count(); i++) j.read(i);
  const z = unzipSync(j.finish());
  const xml = strFromU8(z['word/document.xml']);
  assert.ok(xml.includes('w:pStyle w:val="Heading1"'), 'heading style');
  assert.equal((xml.match(/<w:tbl>/g) || []).length, 2, 'two tables');
  assert.ok(xml.includes('<w:pageBreakBefore/>'), 'page 2 starts a new page');
  assert.ok(Object.keys(z).some((k) => /word\/header\d\.xml/.test(k)) && Object.keys(z).some((k) => /word\/footer\d\.xml/.test(k)), 'header and footer parts');
  const footer = strFromU8(z[Object.keys(z).find((k) => /word\/footer\d\.xml/.test(k))!]);
  assert.ok(footer.includes('PAGE') && footer.includes('NUMPAGES'), 'page number fields');
  // well-formed enough: every opened paragraph and table closed
  assert.equal((xml.match(/<w:p>/g) || []).length + (xml.match(/<w:p /g) || []).length, (xml.match(/<\/w:p>/g) || []).length);
  assert.equal((xml.match(/<w:tbl>/g) || []).length, (xml.match(/<\/w:tbl>/g) || []).length);
});

test('scans: a rubber stamp at a different spot on each page is left out; headings and repeated lines stay', async () => {
  const { dropStampText } = await import('../src/engine/convert/analyze');
  const W = (text: string, x: number, y: number, h = 7) => ({ text, x0: x, y0: y - h, x1: x + text.length * h * 0.55, y1: y, base: y, size: h * 1.3, g: [], rtl: false });
  const pages = [0, 1, 2, 3, 4].map((p) => {
    const words = [W('Dirhams', 440, 150 + (p % 2)), W('Dirhams', 500, 150 + (p % 2))];
    for (let k = 0; k < 10; k++) words.push(W('Hardware', 103, 200 + k * 20), W('set', 140, 200 + k * 20), W('-', 153, 200 + k * 20), W('0' + k, 158, 200 + k * 20), W(String(1 + k * 7), 360 + (k % 3) * 4, 200 + k * 20));
    // the stamp: a date over "TENDER DOCUMENTS", somewhere else every time
    const sx = 180 + p * 37, sy = 520 + p * 45;
    words.push(W('15', sx + 10, sy, 9), W('MAR', sx + 30, sy, 9), W('2024', sx + 60, sy, 9), W('TENDER', sx, sy + 25, 16), W('DOCUMENTS', sx + 70, sy + 25, 16));
    return { i: p, w: 595, h: 842, kind: 'scan', words, rulings: [], fills: [], pics: [], shapes: [], links: [], ocr: true, bodySize: 9 } as never as import('../src/engine/convert/model').PageModel;
  });
  dropStampText(pages);
  for (const pm of pages) {
    const t = pm.words.map((w) => w.text);
    assert.ok(!t.some((x) => /TENDER|DOCUMENTS|MAR/.test(x)), 'stamp gone: ' + t.join(' '));
    assert.equal(t.filter((x) => x === 'Dirhams').length, 2, 'column headings at the same spot stay');
    assert.equal(t.filter((x) => x === 'Hardware').length, 10, 'the bill\'s own repeated lines stay');
    assert.ok(t.includes('1') && t.includes('64'), 'quantities stay');
  }
});

test('reading pages leaves MuPDF\'s memory intact after garbage collection (lines + text)', async () => {
  const v8 = await import('node:v8');
  const vm = await import('node:vm');
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  // (36 pages of bills drawn with ReportLab: their lines are packed paths inside MuPDF's display list)
  const { readFileSync } = await import('node:fs');
  const doc = mupdf.Document.openDocument(readFileSync('tests/fixtures/export-gc.pdf'), 'application/pdf');
  for (let k = 0; k < 2; k++) {
    const job = new ExportJob(doc, { format: k % 2 ? 'docx' : 'xlsx' });
    for (let i = 0; i < job.count(); i++) job.read(i);
    job.finish();
    gc();
    await new Promise((r) => setTimeout(r, 20));
  }
  for (let k = 0; k < 3; k++) { gc(); await new Promise((r) => setTimeout(r, 100)); }
  // MuPDF still works (a double free shows up here or in the finalizers above)
  const p = doc.loadPage(0);
  assert.ok(p.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true).getWidth() > 500);
});
