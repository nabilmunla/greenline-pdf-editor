// Sheet numbers, titles and references in drawing sets (PLAN 7.4) - invented numbers only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensOf, sheetIndex, findRefs, type PageToks } from '../src/ui/sheets.ts';

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

test('a number on two pages links to the first; a sheet with no title block has no number', () => {
  const pages = setA(40, { dup: 7, none: 9 });
  const idx = sheetIndex(pages);
  assert.equal(idx.sheets.find((s) => s.page === 9), undefined);
  assert.equal(idx.byKey.get('A-101'), 0);
  assert.equal(idx.sheets.length, 39);
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
