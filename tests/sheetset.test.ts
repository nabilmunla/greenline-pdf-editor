// The generated drawing sets (tests/gen/sheetset.mjs) are test data: same bytes every time, a truth that
// matches what MuPDF reads back from the file, set C made fast; the R set files open (or refuse) as meant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import * as mupdf from 'mupdf';
// @ts-ignore (plain .mjs helpers)
import { build, pageChars, pageWords } from './gen/sheetset.mjs';
// @ts-ignore
import { ensure, paths, truthOf, PASSWORD } from './rset.mjs';

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
const open = (b: Uint8Array) => mupdf.Document.openDocument(b.slice(), 'application/pdf');

test('generation is deterministic: the same bytes twice', () => {
  for (const n of ['A', 'B', 'mixed', 'onepage']) assert.equal(md5(build(n).bytes), md5(build(n).bytes), n);
});

test('the sets have the sizes and parts that were asked for', () => {
  const A = build('A').truth, B = build('B').truth, M = build('mixed').truth;
  assert.equal(A.pages.length, 40);
  assert.ok(A.pages.every((p: any) => p.size === 'A1' && p.w === 2384 && p.h === 1684));
  assert.equal(B.pages.length, 40);
  assert.ok(B.pages.every((p: any) => p.size === 'A3' && p.w === 1191));
  const sz = (t: any, s: string) => t.pages.filter((p: any) => p.size === s).length;
  assert.deepEqual([sz(M, 'A1'), sz(M, 'A4'), sz(M, 'A3')], [12, 30, 12]);
  assert.ok(M.pages.filter((p: any) => p.size === 'A4').every((p: any) => p.kind === 'spec' && p.no === null));
  // set A: one sheet with no title block, two sheets with one number, the cover's list, an existing link and bookmark
  assert.equal(A.pages.filter((p: any) => p.noTitleBlock).length, 1);
  const nos = A.pages.map((p: any) => p.no).filter(Boolean);
  assert.equal(nos.length - new Set(nos).size, 1);
  const dup = nos.find((n: string, i: number) => nos.indexOf(n) !== i);
  const dupRefs = A.refs.filter((r: any) => r.text === dup);
  assert.ok(dupRefs.length > 0 && dupRefs.every((r: any) => r.target === A.pages.findIndex((p: any) => p.no === dup)));
  const list = A.refs.filter((r: any) => r.kind === 'list');
  assert.equal(list.length, new Set(nos).size - 1);
  assert.ok(list.every((r: any) => r.page === 0 && r.text !== A.pages[0].no));
  assert.equal(A.existing.links.length, 1);
  assert.equal(A.existing.bookmarks.length, 1);
  for (const t of [A, B, M]) assert.ok(t.pages.every((p: any) => p.kind === 'spec' || p.noTitleBlock || p.no));
});

test('the truth is found in the text MuPDF reads back (numbers, titles, references, project data, noise)', () => {
  for (const n of ['A', 'B', 'mixed']) {
    const { bytes, truth } = build(n);
    const doc = open(bytes);
    assert.equal(doc.countPages(), truth.pages.length);
    for (const p of truth.pages) {
      const page = doc.loadPage(p.page);
      const { text, box } = pageChars(page);
      const flat = text.replace(/\s+/g, ' ');
      // (one char per box, the line breaks have NaN boxes)
      assert.equal(box.length, text.length * 4);
      if (p.kind === 'spec') { assert.match(flat, /SECTION \d\d \d\d \d\d - \d/); continue; }
      if (p.noTitleBlock) { assert.ok(!flat.includes('DRAWING NUMBER') && !flat.includes('NORTHGATE'), `${n} p${p.page} has no title block`); continue; }
      assert.ok(flat.includes(p.no), `${n} p${p.page} number ${p.no}`);
      assert.ok(p.noBox, 'number box');
      for (const w of String(p.title).split(' ')) assert.ok(flat.includes(w), `${n} p${p.page} title word ${w}`);
      assert.ok(flat.includes('PRJ-2603') && /\bC0\d\b/.test(flat) && /\b1:\d+\b/.test(flat) && /\d\d\.\d\d\.2026/.test(flat), `${n} p${p.page} project number, revision, scale, date`);
    }
    // each reference: the chars inside its box spell its text; the target page's number ends with it
    for (const r of truth.refs) {
      const { text, box } = pageChars(doc.loadPage(r.page));
      let got = '';
      for (let i = 0; i < text.length; i++) {
        const cx = (box[i * 4] + box[i * 4 + 2]) / 2, cy = (box[i * 4 + 1] + box[i * 4 + 3]) / 2;
        if (cx >= r.box[0] && cx <= r.box[2] && cy >= r.box[1] && cy <= r.box[3]) got += text[i];
      }
      assert.equal(got, r.text, `${n} p${r.page} ref box`);
      assert.ok(truth.pages[r.target].no.endsWith(r.text), `${n} ref ${r.text} -> p${r.target}`);
      assert.notEqual(r.target, r.page);
    }
    // noise that must not link is in the file: room numbers, a reference to a sheet that is not in the set
    const kinds = new Set(truth.decoys.map((d: any) => d.kind));
    for (const k of ['room', 'level', 'dimension', 'absent']) assert.ok(kinds.has(k), `${n} decoys ${k}`);
    const nos = new Set(truth.pages.map((p: any) => p.no).filter(Boolean));
    assert.ok(truth.decoys.filter((d: any) => d.kind === 'absent').every((d: any) => ![...nos].some((x: any) => d.text.endsWith(x as string))));
    // refs are of all three kinds
    assert.ok(['callout', 'bubble', 'refer'].every((k) => truth.refs.some((r: any) => r.kind === k)), n);
  }
});

test('set A: the existing link and bookmark are in the file, line work is a few hundred strokes', () => {
  const { bytes, truth } = build('A');
  const doc = open(bytes);
  const links = doc.loadPage(2).getLinks();
  assert.equal(links.length, 1);
  assert.equal(links[0].getURI(), '#page=' + (truth.existing.links[0].target + 1));
  const ol = doc.loadOutline() || [];
  assert.deepEqual(ol.map((o: any) => [o.title, o.page]), [['Architectural drawings', 1]]);
  assert.ok(truth.refs.some((r: any) => r.existing));
  const pdf = doc as mupdf.PDFDocument;
  const content = (pdf.loadPage(5) as mupdf.PDFPage).getObject().get('Contents').readStream().asString();
  // (a rectangle is four lines)
  assert.ok((content.match(/ l S/g) || []).length + 4 * (content.match(/ re S/g) || []).length >= 300);
});

test('set C: 320 A1 sheets with long numbers, made in under 20 s', () => {
  const t = Date.now();
  const { bytes, truth } = build('C');
  const ms = Date.now() - t;
  console.log(`set C: ${truth.pages.length} sheets, ${truth.refs.length} references, ${(bytes.length / 1e6).toFixed(1)} MB, ${ms} ms`);
  assert.ok(ms < 20000, `${ms} ms`);
  assert.equal(truth.pages.length, 320);
  assert.equal(open(bytes).countPages(), 320);
  const nos = truth.pages.map((p: any) => p.no);
  assert.equal(new Set(nos).size, 320);
  assert.ok(nos.every((n: string) => /^PRJ-AB1-DWG-(AR|ST|ME|EL)-\d{5}$/.test(n)));
  assert.ok(truth.refs.some((r: any) => r.text !== truth.pages[r.target].no), 'some references are the short form');
  const first = truth.pages[0];
  assert.ok(pageWords(open(bytes).loadPage(0)).some((w: any) => w.s === first.no));
});

test('the R set files: made when missing, and open (or refuse) as meant', () => {
  const R = ensure();
  for (const f of [R.longSpec, R.scan, R.mixed, R.onePage, R.password, R.cutShort, R.setA, R.setB]) assert.ok(statSync(f).size > 1000, f);
  assert.equal(open(readFileSync(R.longSpec)).countPages(), 1500);
  const scan = open(readFileSync(R.scan));
  assert.equal(pageChars(scan.loadPage(0)).text.trim(), '');
  assert.equal(open(readFileSync(R.mixed)).countPages(), 54);
  assert.equal(open(readFileSync(R.onePage)).countPages(), 1);
  assert.equal(truthOf(R.onePage).pages.length, 1);
  const pw = open(readFileSync(R.password));
  assert.equal(pw.needsPassword(), true);
  assert.equal(pw.authenticatePassword('wrong'), 0);
  assert.ok(pw.authenticatePassword(PASSWORD) > 0);
  assert.equal(pw.countPages(), 8);
  // cut short: the first 60 % of set A's bytes, byte for byte
  const a = readFileSync(R.setA), c = readFileSync(R.cutShort);
  assert.equal(c.length, Math.floor(a.length * 0.6));
  assert.ok(a.subarray(0, c.length).equals(c));
});
