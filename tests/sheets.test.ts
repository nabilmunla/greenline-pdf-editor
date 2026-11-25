// Sheet numbers, titles and references in drawing sets (PLAN 7.4) - invented numbers only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensOf, sheetIndex, findRefs, plainNumbersOk, repeatedNos, dupLine, type PageToks } from '../src/ui/sheets.ts';

type W = { s: string; x: number; y: number; h?: number };
/** a page's text the way the drawing engine gives it: one box per character, lines by '\n' */
function chars(lines: W[][]) {
  let text = '';
  const box: number[] = [];
  const put = (c: string, b: number[]) => { text += c; box.push(...b); };
  lines.forEach((l, li) => {
    if (li) put('\n', [NaN, NaN, NaN, NaN]);
    l.forEach((w, wi) => {
      const h = w.h ?? 8;
      if (wi) put(' ', [NaN, NaN, NaN, NaN]);
      [...w.s].forEach((c, k) => put(c, [w.x + k * 0.6 * h, w.y, w.x + (k + 1) * 0.6 * h, w.y + h]));
    });
  });
  return { text, box: new Float32Array(box) };
}
const MM = 72 / 25.4;
const A1 = { w: 841 * MM, h: 594 * MM };
const A4 = { w: 210 * MM, h: 297 * MM };

/** a sheet with a title block in the right strip */
function sheet(page: number, no: string | null, title: string, body: W[][] = [], size = A1, label?: string): PageToks {
  const { w, h } = size;
  const tb = (dx: number, dy: number, s: string, hh = 8): W[] => [{ s, x: w - dx * MM, y: h - dy * MM, h: hh }];
  const lines: W[][] = [
    ...body,
    tb(150, 120, 'PROJECT PRJ-2603 PALM TOWER'),
    tb(150, 100, title.split('|')[0], 10),
    ...(title.includes('|') ? [tb(150, 100 - 5, title.split('|')[1], 10)] : []),
    tb(150, 70, 'DATE 16.11.2026'),
    tb(100, 70, 'SCALE 1:100'),
    tb(150, 55, 'REV C02'),
    tb(60, 55, 'STATUS IFC'),
  ];
  if (no) lines.push([{ s: 'DWG NO', x: w - 150 * MM, y: h - 40 * MM, h: 6 }, { s: no, x: w - 120 * MM, y: h - 40 * MM, h: 12 }]);
  return tokensOf(page, chars(lines), w, h, label);
}

function setA(n = 40, opts: { dup?: number; none?: number } = {}) {
  const pages: PageToks[] = [];
  for (let i = 0; i < n; i++) {
    const no = i === opts.none ? null : i === opts.dup ? 'A-101' : `A-${101 + i}`;
    const body: W[][] = [];
    if (i === 0) body.push([{ s: 'SEE', x: 300, y: 300 }, { s: 'A-103', x: 330, y: 300 }]);
    if (i === 1) body.push([{ s: '5', x: 400, y: 400 }, { s: '/', x: 410, y: 400 }, { s: 'A-105', x: 420, y: 400 }]);
    if (i === 2) body.push([{ s: 'REFER', x: 400, y: 500 }, { s: 'TO', x: 440, y: 500 }, { s: 'A-999', x: 460, y: 500 }]); // not in the set
    body.push([{ s: 'ROOM', x: 800, y: 800 }, { s: '101', x: 840, y: 800 }]);
    body.push([{ s: 'LEVEL', x: 900, y: 900 }, { s: '02', x: 940, y: 900 }]);
    pages.push(sheet(i, no, i % 3 ? `FLOOR PLAN LEVEL ${i}` : `SECTION ${String.fromCharCode(65 + (i % 26))}-${i}|DETAILS`, body));
  }
  return pages;
}

/** a page of a specification: clause numbers, dates, prose */
function prose(page: number, size = A4): PageToks {
  const lines: W[][] = [];
  for (let k = 0; k < 40; k++) lines.push([{ s: `${3 + (page % 5)}.${k % 9}.${k}`, x: 20 * MM, y: (30 + k * 6) * MM, h: 9 }, { s: 'The Contractor shall provide all labour 2026 and materials', x: 40 * MM, y: (30 + k * 6) * MM, h: 9 }]);
  lines.push([{ s: `SECTION 08 71 00 - ${page + 1}`, x: 90 * MM, y: 285 * MM, h: 8 }]);
  lines.push([{ s: 'Issued 16.11.2026', x: 160 * MM, y: 285 * MM, h: 8 }]);
  return tokensOf(page, chars(lines), size.w, size.h);
}

test('a drawing set: every sheet number, most titles', () => {
  const idx = sheetIndex(setA());
  assert.equal(idx.sheets.length, 40);
  for (let i = 0; i < 40; i++) assert.equal(idx.sheets[i].no, `A-${101 + i}`, 'page ' + i);
  const titled = idx.sheets.filter((s, i) => s.title === (i % 3 ? `FLOOR PLAN LEVEL ${i}` : `SECTION ${String.fromCharCode(65 + (i % 26))}-${i} DETAILS`)).length;
  assert.ok(titled >= 36, `titles right: ${titled} of 40 (${idx.sheets.slice(0, 4).map((s) => s.title).join(' | ')})`);
  // the project number, the date, the scale and the revision code are not sheet numbers
  assert.ok(!idx.sheets.some((s) => /2603|C02|1-100|2026/.test(s.key)));
});

test('references: only sheets of the set, not rooms, levels or the project number', () => {
  const pages = setA();
  const idx = sheetIndex(pages);
  const refs = findRefs(pages, idx);
  const r = refs.map((x) => `${x.page}->${x.target}:${x.text}`).sort();
  assert.deepEqual(r, ['0->2:A-103', '1->4:A-105']);
});

test('a number on two pages is never linked (PLAN 9.3b); a sheet with no title block has no number', () => {
  const pages = setA(40, { dup: 7, none: 9 });
  pages[5] = sheet(5, 'A-106', 'FLOOR PLAN LEVEL 5', [[{ s: 'SEE', x: 300, y: 300 }, { s: 'A-101', x: 330, y: 300 }]]);
  const idx = sheetIndex(pages);
  assert.equal(idx.sheets.find((s) => s.page === 9), undefined);
  assert.equal(idx.byKey.get('A-101'), 0);
  assert.equal(idx.sheets.length, 39);
  assert.deepEqual(findRefs(pages, idx).map((r) => `${r.page}->${r.target}:${r.text}`).sort(), ['0->2:A-103', '1->4:A-105']);
});

test('long full numbers and their short form in callouts', () => {
  const pages: PageToks[] = [];
  for (let i = 0; i < 12; i++) {
    const body: W[][] = i === 3 ? [[{ s: 'SEE', x: 300, y: 300 }, { s: 'DWG', x: 330, y: 300 }, { s: 'AR-10145', x: 360, y: 300 }], [{ s: 'DETAIL', x: 300, y: 340 }, { s: '10146', x: 350, y: 340 }]] : [];
    pages.push(sheet(i, `PRJ-AB1-DWG-AR-${10140 + i}`, `PLAN ${i}`, body));
  }
  const idx = sheetIndex(pages);
  assert.equal(idx.sheets.length, 12);
  assert.equal(idx.sheets[0].no, 'PRJ-AB1-DWG-AR-10140');
  const refs = findRefs(pages, idx).map((x) => `${x.page}->${x.target}`).sort();
  assert.deepEqual(refs, ['3->5', '3->6']);
});

test('a specification finds nothing (rule R)', () => {
  const pages = Array.from({ length: 50 }, (_, i) => prose(i));
  const idx = sheetIndex(pages);
  assert.equal(idx.sheets.length, 0);
  assert.deepEqual(findRefs(pages, idx), []);
});

test('a mixed set: the drawings only', () => {
  const pages: PageToks[] = [];
  for (let i = 0; i < 12; i++) pages.push(sheet(i, `S-${201 + i}`, `STRUCTURE ${i}`));
  for (let i = 0; i < 30; i++) pages.push(prose(12 + i));
  const idx = sheetIndex(pages);
  assert.deepEqual(idx.sheets.map((s) => s.page), Array.from({ length: 12 }, (_, i) => i));
});

test('nothing to read: no pages, one page, pages with no text', () => {
  assert.equal(sheetIndex([]).sheets.length, 0);
  assert.equal(sheetIndex([sheet(0, 'A-101', 'PLAN')]).sheets.length, 0);
  const empty = Array.from({ length: 5 }, (_, i) => tokensOf(i, { text: '', box: new Float32Array(0) }, A1.w, A1.h));
  const idx = sheetIndex(empty);
  assert.equal(idx.sheets.length, 0);
  assert.equal(idx.noText, 5);
  assert.equal(tokensOf(0, null as never, 0, 0).text, false);
});

test('page labels that look like drawing numbers count when the title blocks say nothing', () => {
  const pages = Array.from({ length: 6 }, (_, i) => tokensOf(i, chars([[{ s: 'plain drawing', x: 100, y: 100 }]]), A1.w, A1.h, `M-${301 + i}`));
  assert.deepEqual(sheetIndex(pages).sheets.map((s) => s.no), ['M-301', 'M-302', 'M-303', 'M-304', 'M-305', 'M-306']);
  const roman = Array.from({ length: 6 }, (_, i) => tokensOf(i, chars([[{ s: 'x', x: 1, y: 1 }]]), A1.w, A1.h, ['i', 'ii', 'iii', '1', '2', '3'][i]));
  assert.equal(sheetIndex(roman).sheets.length, 0);
});

test('random text never throws', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const alpha = 'AB-_.0123456789 /\n\rSEE';
  for (let k = 0; k < 200; k++) {
    let text = '';
    const box: number[] = [];
    const n = Math.floor(rnd() * 300);
    for (let i = 0; i < n; i++) { text += alpha[Math.floor(rnd() * alpha.length)]; const x = rnd() * 2000, y = rnd() * 1500; box.push(x, y, rnd() < 0.05 ? NaN : x + rnd() * 10, y + rnd() * 10); }
    const pages = [0, 1, 2, 3].map((p) => tokensOf(p, { text, box: new Float32Array(box) }, rnd() < 0.1 ? 0 : 2000, 1500));
    const idx = sheetIndex(pages);
    findRefs(pages, idx);
  }
});

test('speed and size: 320 sheets of 400 words', () => {
  const t0 = performance.now();
  const pages: PageToks[] = [];
  for (let i = 0; i < 320; i++) {
    const body: W[][] = Array.from({ length: 40 }, (_, k) => Array.from({ length: 10 }, (_, j) => ({ s: j % 3 ? 'WALL' : `W${k}${j}`, x: 100 + j * 60, y: 100 + k * 30 })));
    pages.push(sheet(i, `E-${1001 + i}`, `POWER LAYOUT ${i}`, body));
  }
  const idx = sheetIndex(pages);
  findRefs(pages, idx);
  assert.equal(idx.sheets.length, 320);
  assert.ok(pages.every((p) => p.toks.length <= 400));
  assert.ok(performance.now() - t0 < 4000, 'took ' + Math.round(performance.now() - t0) + ' ms');
});

test('title blocks along the bottom (A3 sets)', () => {
  const A3 = { w: 420 * MM, h: 297 * MM };
  const pages: PageToks[] = [];
  for (let i = 0; i < 20; i++) {
    const y = A3.h - 15 * MM;
    pages.push(tokensOf(i, chars([
      [{ s: 'CLIENT PRJ-2603', x: 20 * MM, y, h: 7 }],
      [{ s: `ELEVATION ${i + 1}`, x: 150 * MM, y: A3.h - 22 * MM, h: 9 }],
      [{ s: `ID-${String(i + 1).padStart(3, '0')}`, x: 300 * MM, y, h: 11 }],
      [{ s: 'REV P01', x: 360 * MM, y, h: 7 }],
      ...(i === 4 ? [[{ s: 'SEE', x: 100, y: 200 }, { s: 'ID-12', x: 130, y: 200 }]] : []),
    ]), A3.w, A3.h));
  }
  const idx = sheetIndex(pages);
  assert.equal(idx.sheets.length, 20);
  assert.equal(idx.sheets[0].no, 'ID-001');
  assert.equal(idx.sheets[3].title, 'ELEVATION 4');
  // "ID-12" written without the zero is sheet ID-012
  assert.deepEqual(findRefs(pages, idx).map((r) => `${r.page}->${r.target}`), ['4->11']);
});

// PLAN 9: on the user's real sets (12 files, 1,684 pages) 44 false sheets came from one spot on 71 A4
// pages of a bill of quantities - the page total at the foot of the amount column: 34 decimals, 8
// whole numbers, 2 others; the plain numbers 2 to 8 digits long, never one length. Generated pages of
// that pattern.

/** a pseudo-random amount with 3 to 8 digits before the point (the measured spread of lengths) */
const amount = (i: number, dec: boolean) => {
  const digits = 3 + ((i * 7 + 3) % 6);
  const v = String(Math.floor(10 ** (digits - 1) * (1 + ((i * 7919) % 8999) / 1000)));
  const whole = v.slice(0, digits).replace(/\B(?=(\d{3})+$)/g, i % 2 ? ',' : '');
  return dec ? `${whole}.${String((i * 37) % 100).padStart(2, '0')}` : whole.replace(/,/g, '');
};
/** a page of a bill of quantities (A4): item, description, quantity, unit, rate, amount; the page
 *  total at the foot of the amount column, in the bottom strip */
function boq(page: number, dec = true): PageToks {
  const lines: W[][] = [];
  for (let k = 0; k < 28; k++) {
    const y = (25 + k * 8) * MM;
    lines.push([
      { s: String.fromCharCode(65 + (k % 8)), x: 12 * MM, y, h: 8 },
      { s: 'Supply and install reinforced concrete to the', x: 22 * MM, y, h: 8 },
      { s: String(10 + ((page + k) % 80)), x: 108 * MM, y, h: 8 },
      { s: 'm3', x: 122 * MM, y, h: 8 },
      { s: dec ? `${450 + k}.00` : String(450 + k), x: 140 * MM, y, h: 8 },
      { s: amount(page * 31 + k, dec), x: 170 * MM, y, h: 8 },
    ]);
  }
  lines.push([{ s: 'Carried to collection', x: 60 * MM, y: 262 * MM, h: 9 }, { s: amount(page, dec), x: 120 * MM, y: 262 * MM, h: 9 }]);
  return tokensOf(page, chars(lines), A4.w, A4.h);
}

test('a bill of quantities finds no sheets: amounts with a decimal point are no sheet numbers', () => {
  const pages = Array.from({ length: 40 }, (_, i) => boq(i));
  // the collection page: the page totals again, at the left (outside the title band)
  pages.push(tokensOf(40, chars(Array.from({ length: 20 }, (_, i) => [{ s: `Page ${i + 1}`, x: 20 * MM, y: (30 + i * 9) * MM, h: 8 }, { s: amount(i, true), x: 45 * MM, y: (30 + i * 9) * MM, h: 8 }])), A4.w, A4.h));
  const idx = sheetIndex(pages);
  assert.deepEqual(idx.sheets.map((s) => s.no), []);
  assert.deepEqual(findRefs(pages, idx), []);
});

test('a schedule of whole quantities finds no sheets: plain numbers of many lengths are no sheet numbers', () => {
  const pages = Array.from({ length: 40 }, (_, i) => boq(i, false));
  assert.deepEqual(sheetIndex(pages).sheets.map((s) => s.no), []);
});

test('a set with a bill of quantities: the drawings only, links only between them', () => {
  const A3 = { w: 420 * MM, h: 297 * MM };
  const pages: PageToks[] = [];
  for (let i = 0; i < 20; i++) {
    const y = A3.h - 15 * MM;
    pages.push(tokensOf(i, chars([
      [{ s: 'CLIENT PRJ-2603', x: 20 * MM, y, h: 7 }],
      [{ s: `PRJ-AB1-DWG-AR-${10140 + i}`, x: 330 * MM, y, h: 11 }],
      ...(i === 4 ? [[{ s: 'SEE', x: 100, y: 200 }, { s: 'AR-10145', x: 130, y: 200 }]] : []),
    ]), A3.w, A3.h));
  }
  for (let i = 0; i < 40; i++) pages.push(boq(20 + i));
  pages.push(tokensOf(60, chars(Array.from({ length: 20 }, (_, i) => [{ s: 'Page', x: 20 * MM, y: (30 + i * 9) * MM, h: 8 }, { s: amount(20 + i, true), x: 45 * MM, y: (30 + i * 9) * MM, h: 8 }])), A4.w, A4.h));
  const idx = sheetIndex(pages);
  assert.deepEqual(idx.sheets.map((s) => s.page), Array.from({ length: 20 }, (_, i) => i));
  assert.deepEqual(findRefs(pages, idx).map((r) => `${r.page}->${r.target}`), ['4->5']);
});

test('drawing numbers of digits only are still sheet numbers (one length, as written)', () => {
  for (const no of [(i: number) => String(100101 + i), (i: number) => String(i + 1).padStart(4, '0')]) {
    const pages = Array.from({ length: 24 }, (_, i) => sheet(i, no(i), `PLAN ${i}`));
    assert.deepEqual(sheetIndex(pages).sheets.map((s) => s.no), pages.map((_, i) => no(i)));
  }
  assert.equal(plainNumbersOk(['100101', '100102', '100103', '100104', '7']), true);
  assert.equal(plainNumbersOk(['0001', '0002', '0003']), true);
  assert.equal(plainNumbersOk(['512', '1047', '23140', '9027', '880000', '1500']), false);
  assert.equal(plainNumbersOk(['A-101', 'A-102', 'A-103', '512', '23140']), true);
});

// PLAN 9.2: titles on the user's real sets (483 sheets, A3 and A2): none was found. Measured there: the
// title band holds 85 lines on the median sheet (162 at the 90th percentile) and the title's lines come
// late in the text, past the 60 kept; the title sits 30 mm above the number and takes 1 to 3 lines, its
// first line shared by many sheets; the number stands alone on its line, next to its spot. Generated
// A3 sheets of that pattern.
const A3L = { w: 420 * MM, h: 297 * MM };
const LEVELS = ['LEVEL 01', 'LEVEL 02', 'TYPICAL FLOOR'];
const TWORDS = ['FLOOR PLAN', 'REFLECTED CEILING', 'WALL SETTING OUT', 'FINISHES LAYOUT', 'DOOR SCHEDULE', 'SECTIONS', 'ELEVATIONS', 'TOILET DETAILS'];
const realTitle = (i: number) => `${LEVELS[i % 3]} ${TWORDS[i % 8]} ZONE ${String.fromCharCode(65 + Math.floor(i / 8))}`;
function a3(i: number, o: { legend?: number; alone?: boolean; notes?: boolean } = {}): PageToks {
  const { w, h } = A3L;
  const at = (dx: number, dy: number, s: string, hh = 8): W => ({ s, x: w - dx * MM, y: h - dy * MM, h: hh });
  const lines: W[][] = [];
  // a legend down the right strip, the same on every sheet, first in the text
  for (let k = 0; k < (o.legend ?? 0); k++) lines.push([at(110, 280 - k * 2.6, `LEGEND ITEM ${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + Math.floor(k / 26))} FINISH TYPE`, 6)]);
  // sheet notes, different on each sheet, far from the title block
  if (o.notes) lines.push([at(110, 200, `NOTES FOR ${TWORDS[(i * 3) % 8]} ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(66 + (i % 25))} ONLY`, 7)]);
  lines.push([at(110, 70, 'PROJECT PRJ-2603 PALM TOWER', 8)]);
  lines.push([at(110, 62, 'DRAWING TITLE', 6)]);
  // the title: three lines, the first shared by a third of the sheets
  const t = realTitle(i).split(/ (?=REFLECTED|FLOOR PLAN|WALL|FINISHES|DOOR|SECTIONS|ELEVATIONS|TOILET|ZONE)/);
  t.forEach((s, k) => lines.push([at(45, 55 - k * 3.5, s, 8)]));
  lines.push([at(110, 30, 'SCALE 1:100'), at(80, 30, 'DATE 16.11.2026')]);
  const no = `PRJ-AB1-DWG-AR-${10140 + i}`;
  lines.push(o.alone ? [at(38, 25, no, 10)] : [at(70, 25, 'DWG NO', 6), at(38, 25, no, 10)]);
  return tokensOf(i, chars(lines), w, h);
}

test('a title after more than 60 lines of the title band is found', () => {
  const pages = Array.from({ length: 24 }, (_, i) => a3(i, { legend: 80 }));
  const idx = sheetIndex(pages);
  assert.equal(idx.sheets.length, 24);
  assert.deepEqual(idx.sheets.map((s) => s.title), pages.map((_, i) => realTitle(i)));
});

test('a title of several lines whose first line repeats is found whole', () => {
  const pages = Array.from({ length: 24 }, (_, i) => a3(i));
  assert.deepEqual(sheetIndex(pages).sheets.map((s) => s.title), pages.map((_, i) => realTitle(i)));
});

test('the number on its own line is no title; notes that differ per sheet are no title either', () => {
  const pages = Array.from({ length: 24 }, (_, i) => a3(i, { alone: true, notes: true, legend: 70 }));
  const idx = sheetIndex(pages);
  assert.deepEqual(idx.sheets.map((s) => s.no), pages.map((_, i) => `PRJ-AB1-DWG-AR-${10140 + i}`));
  assert.deepEqual(idx.sheets.map((s) => s.title), pages.map((_, i) => realTitle(i)));
});

// PLAN 9.3: the user's A1 set (228 pages) holds 112 sheet numbers, up to 8 times each, the copies far
// apart (a tender set compiled from packages): no spot differed on 90 % of its pages and it got no
// sheets. Generated sets of that pattern, and the spots that must still find nothing.
/** 60 sheets: 40 numbers, the first 20 again at the end; page 3 refers to a repeated sheet, a sheet
 *  there once, the end of a number bare and with DETAIL before it */
const compiledNo = (i: number) => `PRJ-AB1-DWG-AR-${10101 + (i < 40 ? i : i - 40)}`;
const compiled = (size = A1) => Array.from({ length: 60 }, (_, i) => sheet(i, compiledNo(i), `PLAN ${i}`, i === 3 ? [
  [{ s: 'SEE', x: 300, y: 300 }, { s: 'PRJ-AB1-DWG-AR-10110', x: 330, y: 300 }],
  [{ s: 'SEE', x: 300, y: 340 }, { s: 'PRJ-AB1-DWG-AR-10130', x: 330, y: 340 }],
  [{ s: 'TYPE', x: 300, y: 380 }, { s: '10131', x: 350, y: 380 }],
  [{ s: 'DETAIL', x: 300, y: 420 }, { s: '10132', x: 350, y: 420 }],
] : [], size));

test('a set holding some sheets twice: every page numbered; no link to a repeated number, bare digits need a word before them', () => {
  const pages = compiled();
  const idx = sheetIndex(pages);
  assert.deepEqual(idx.sheets.map((s) => s.no), pages.map((_, i) => compiledNo(i)));
  assert.deepEqual(findRefs(pages, idx).map((r) => `${r.page}->${r.target}:${r.text}`), ['3->29:PRJ-AB1-DWG-AR-10130', '3->31:10132']);
});

test('repeating numbers are not taken on A4 paper, nor codes that repeat more', () => {
  assert.equal(sheetIndex(compiled(A4)).sheets.length, 0);
  // a zone code (8 values on 60 pages) and plain numbers that repeat are no sheet numbers
  const zone = Array.from({ length: 60 }, (_, i) => sheet(i, `ZONE-${i % 8}A`, `PLAN ${i}`));
  assert.equal(sheetIndex(zone).sheets.length, 0);
  assert.equal(repeatedNos(['A-1', 'A-2', 'A-1', 'A-2', 'A-3'], ['A-1', 'A-2', 'A-1', 'A-2', 'A-3']), false);
  const ten = Array.from({ length: 20 }, (_, i) => `A-${i % 10}`);
  assert.equal(repeatedNos(ten.map((x) => x.replace('A-', 'A')), ten), true);
  assert.equal(repeatedNos(ten, ten.map((x) => x.replace('A-', ''))), false);
});

// 13.2.9: a key plan keeps its callouts in the right fifth and the bottom 15 %, beside a title block
// that is far smaller than those strips. Only the title block is off limits.
test('callouts in the right and bottom strips outside the title block are linked; title block text is not', () => {
  const { w, h } = A1;
  const pages: PageToks[] = [];
  for (let i = 0; i < 12; i++) {
    const body: W[][] = i !== 3 ? [] : [
      [{ s: 'SEE', x: w - 110 * MM, y: h - 300 * MM }, { s: 'A-105', x: w - 90 * MM, y: h - 300 * MM }], // right strip, above the block
      [{ s: 'DETAIL', x: 200 * MM, y: h - 30 * MM }, { s: 'A-106', x: 230 * MM, y: h - 30 * MM }], // bottom strip, left of the block
      [{ s: 'RELATED', x: w - 150 * MM, y: h - 85 * MM }, { s: 'DWG', x: w - 125 * MM, y: h - 85 * MM }, { s: 'A-107', x: w - 110 * MM, y: h - 85 * MM }], // inside the block
    ];
    pages.push(sheet(i, `A-${101 + i}`, `PLAN ${i}`, body));
  }
  const idx = sheetIndex(pages);
  assert.equal(idx.sheets.length, 12);
  assert.deepEqual(findRefs(pages, idx).map((r) => `${r.page}->${r.target}:${r.text}`).sort(), ['3->4:A-105', '3->5:A-106']);
});

// 13.2.10: five pages, two with one number: 4 distinct numbers of 5 fell under the 90 % rule and no
// sheet was found, so no link either.
test('a small set with one number twice: every number is linked, the duplicate to its first copy, one notice', () => {
  const nos = ['A-101', 'A-102', 'A-103', 'A-104', 'A-102'];
  const refs: Record<number, [string, string]> = { 0: ['A-102', 'A-103'], 2: ['A-104', 'A-101'] };
  const pages = nos.map((no, i) => sheet(i, no, `PLAN ${i}`, (refs[i] || []).map((r, k) => [{ s: 'SEE', x: 300, y: 300 + k * 40 }, { s: r, x: 330, y: 300 + k * 40 }])));
  const idx = sheetIndex(pages);
  assert.deepEqual(idx.sheets.map((s) => s.no), nos);
  assert.deepEqual(idx.dups, ['A-102']);
  assert.deepEqual(findRefs(pages, idx).map((r) => `${r.page}->${r.target}:${r.text}`).sort(), ['0->1:A-102', '0->2:A-103', '2->0:A-101', '2->3:A-104']);
  assert.equal(dupLine(idx.dups), 'Sheet number A-102 is on more than one page: links to it go to the first.');
  assert.equal(dupLine(['A-102', 'B-7']), 'Sheet numbers A-102, B-7 are on more than one page: links to them go to the first.');
  assert.equal(dupLine([]), '');
  // a set with no duplicate has none to report
  assert.deepEqual(sheetIndex(pages.map((_, i) => sheet(i, `A-${101 + i}`, `PLAN ${i}`))).dups, []);
});
