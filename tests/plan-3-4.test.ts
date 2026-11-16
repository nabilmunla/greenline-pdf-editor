// PLAN 3.4 (D3): page sizes come from the page dictionaries, not by loading every page - and they
// equal what loading the page gives (freshPageInfos, the oracle) on every kind of page.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';

/** a PDF written by hand: objects as strings, xref computed (as tests/fuzz-evil.ts) */
function raw(objs: string[], trailerExtra = ''): Uint8Array {
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array([...out].map((c) => c.charCodeAt(0) & 255));
}
/** catalog (1), pages (2) with `pagesExtra`, then one page per entry of `pages` (its own dictionary entries) */
function doc(pagesExtra: string, pages: string[], catalogExtra = '', extra: string[] = []): Uint8Array {
  const kids = pages.map((_, k) => `${k + 3} 0 R`).join(' ');
  return raw([
    `<< /Type /Catalog /Pages 2 0 R ${catalogExtra}>>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} ${pagesExtra}>>`,
    ...pages.map((p) => `<< /Type /Page /Parent 2 0 R ${p} >>`),
    ...extra,
  ]);
}

const cases: [string, Uint8Array][] = [
  ['MediaBox inherited from the page tree', doc('/MediaBox [0 0 612 792]', ['', '/Rotate 90'])],
  ['CropBox inside, Rotate 90', doc('', ['/MediaBox [0 0 2384 1684] /CropBox [10 20 2000 1500] /Rotate 90'])],
  ['CropBox partly outside, Rotate inherited -90', doc('/Rotate -90', ['/MediaBox [0 0 842 595] /CropBox [-50 -40 700 900]'])],
  ['reversed MediaBox', doc('', ['/MediaBox [612 792 0 0]'])],
  ['decimal A4, Rotate 180, 270', doc('', ['/MediaBox [0 0 841.89 595.28] /Rotate 180', '/MediaBox [0.5 0.25 595.276 841.89] /Rotate 270', '/MediaBox [-12.3 7.7 1190.55 842.12] /CropBox [0 0 1000.4 800.6]'])],
  ['UserUnit (loaded instead)', doc('', ['/MediaBox [0 0 100 100] /UserUnit 75', '/MediaBox [0 0 300 200]'])],
  ['CropBox outside the MediaBox (loaded instead)', doc('', ['/MediaBox [0 0 300 300] /CropBox [400 400 500 500]'])],
  ['MediaBox an indirect object', doc('', ['/MediaBox 4 0 R'], '', ['[0 0 1000 707]'])],
  ['no MediaBox at all (loaded instead)', doc('', ['', '/MediaBox [0 0 200 300]'])],
  ['Rotate 450', doc('', ['/MediaBox [0 0 500 300] /Rotate 450'])],
  ['page labels', doc('/MediaBox [0 0 612 792]', ['', '', ''], '/PageLabels << /Nums [0 << /S /r >> 2 << /S /D >>] >>')],
  ['page labels: every style, prefixes, starts, a tree of kids, pages before the first range', doc('/MediaBox [0 0 612 792]', ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''], '/PageLabels << /Kids [4 0 R 5 0 R] >>', ['<< /Nums [2 << /S /R /St 1987 >> 5 << /S /a /St 25 >> 9 << /P (A-) /S /D /St 7 >> ] >>', '<< /Nums [12 << /P (Cover) >> 13 << /S /A /St 52 >> 15 << /S /r /St 3999 >> 17 << /S /D /St 0 >> 19 << /P (x) /S /A >> ] >>'])],

];
for (const dir of ['tests/data', 'tests/real']) {
  for (const f of readdirSync(dir)) if (f.endsWith('.pdf')) cases.push([f, new Uint8Array(readFileSync(`${dir}/${f}`))]);
}

test('3.4: page sizes from the dictionaries equal the loaded pages\' bounds', () => {
  for (const [name, bytes] of cases) {
    const r = mu.open('p34', bytes);
    if (r.needsPassword) { mu.close('p34'); continue; }
    assert.deepEqual(mu.pageInfos('p34'), mu.freshPageInfos('p34'), name);
    mu.close('p34');
  }
});

test('3.4: opening a 300-page file loads no page', () => {
  const d = new mupdf.PDFDocument();
  for (let i = 0; i < 300; i++) d.insertPage(-1, d.addPage([0, 0, 595 + (i % 3), 842], (i % 4) * 90, {}, '0 0 m 10 10 l S'));
  const bytes = d.saveToBuffer('').asUint8Array().slice();
  const proto = (mupdf as unknown as { PDFDocument: { prototype: { loadPage: (i: number) => unknown } } }).PDFDocument.prototype;
  const orig = proto.loadPage;
  let loads = 0;
  proto.loadPage = function (this: unknown, i: number) { loads++; return orig.call(this, i); };
  try {
    const r = mu.open('p34b', bytes);
    assert.equal(r.pages.length, 300);
    assert.equal(r.pages[1].w, 842, 'turned page: width and height swapped');
  } finally { proto.loadPage = orig; }
  assert.equal(loads, 0, 'pages loaded while opening');
  mu.close('p34b');
});

test('3.4: a labelled file loads no page either (labels read from the /PageLabels tree)', () => {
  const bytes = doc('/MediaBox [0 0 612 792]', Array(30).fill(''), '/PageLabels << /Nums [0 << /S /r >> 4 << /S /D >> 20 << /P (App-) /S /A >>] >>');
  const proto = (mupdf as unknown as { PDFDocument: { prototype: { loadPage: (i: number) => unknown } } }).PDFDocument.prototype;
  const orig = proto.loadPage;
  let loads = 0;
  proto.loadPage = function (this: unknown, i: number) { loads++; return orig.call(this, i); };
  let labels: string[];
  try { labels = mu.open('p34c', bytes).pages.map((p) => p.label); } finally { proto.loadPage = orig; }
  assert.equal(loads, 0, 'pages loaded while opening');
  assert.deepEqual([labels[0], labels[3], labels[4], labels[19], labels[20], labels[29]], ['i', 'iv', '1', '16', 'App-A', 'App-J']);
  mu.close('p34c');
});
