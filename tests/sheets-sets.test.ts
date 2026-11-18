// The sheet reader (src/ui/sheets.ts) against the generated drawing sets (tests/gen/sheetset.mjs):
// A (40 A1, title block right), B (40 A3, bottom) and the mixed set (12 A1 + 30 spec pages + 12 A3).
// Scores: sheet numbers, titles, true references found, false references.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
// @ts-ignore (plain .mjs helpers)
import { ensure, paths, truthOf } from './rset.mjs';
// @ts-ignore
import { pageChars } from './gen/sheetset.mjs';
import { tokensOf, sheetIndex, findRefs, type PageToks, type Ref } from '../src/ui/sheets';

ensure();
const norm = (s: string) => (s || '').toUpperCase().replace(/\s+/g, ' ').trim();
type TRef = { page: number; text: string; box: number[]; target: number; kind: string };
type TPage = { page: number; no: string | null; title: string | null; kind: string };

function overlap(a: number[], b: number[]) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const i = w * h, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return i / u;
}

function score(pdf: string) {
  const truth = truthOf(pdf) as { pages: TPage[]; refs: TRef[] };
  const doc = mupdf.Document.openDocument(readFileSync(pdf), 'application/pdf');
  const pages: PageToks[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const p = doc.loadPage(i);
    const b = p.getBounds();
    pages.push(tokensOf(i, pageChars(p), b[2] - b[0], b[3] - b[1]));
  }
  const idx = sheetIndex(pages);
  const refs: Ref[] = findRefs(pages, idx);
  const byPage = new Map(idx.sheets.map((s) => [s.page, s]));
  const withNo = truth.pages.filter((p) => p.no);
  const noRight = withNo.filter((p) => byPage.get(p.page)?.no.toUpperCase() === p.no!.toUpperCase());
  const noMiss = withNo.filter((p) => !noRight.includes(p)).map((p) => `p${p.page} ${p.no} -> ${byPage.get(p.page)?.no ?? 'none'}`);
  const extra = idx.sheets.filter((s) => !truth.pages[s.page]?.no).map((s) => `p${s.page} ${s.no} (${truth.pages[s.page]?.kind})`);
  const withTitle = truth.pages.filter((p) => p.title);
  const tiRight = withTitle.filter((p) => norm(byPage.get(p.page)?.title || '') === norm(p.title!));
  const tiMiss = withTitle.filter((p) => !tiRight.includes(p)).map((p) => `p${p.page} "${p.title}" -> "${byPage.get(p.page)?.title ?? ''}"`);
  // references: a truth ref is found by a reader ref on its page, to its target, over its box - except
  // a reference to a number two sheets carry: never linked (PLAN 9.3b), a reader ref there is wrong
  const nos = truth.pages.map((p) => p.no).filter(Boolean);
  const twice = new Set(nos.filter((n, i) => nos.indexOf(n) !== i));
  const ambiguous = truth.refs.filter((t) => twice.has(truth.pages[t.target]?.no));
  const used = new Set<number>();
  const found: TRef[] = [], missed: TRef[] = [];
  for (const t of truth.refs.filter((x) => !ambiguous.includes(x))) {
    const k = refs.findIndex((r, j) => !used.has(j) && r.page === t.page && r.target === t.target && overlap(r.box, t.box) > 0.3);
    if (k >= 0) { used.add(k); found.push(t); } else missed.push(t);
  }
  const wrong = refs.filter((_, j) => !used.has(j));
  const truthRefs = truth.refs.length - ambiguous.length;
  return { truth, withNo, noRight, noMiss, extra, withTitle, tiRight, tiMiss, found, missed, wrong, ambiguous, truthRefs };
}

// (the mixed set's spec pages carry clause numbers in the bottom strip of an A4 page, different on every
// page: the reader once took them for a sheet-number spot - 7.4's fix, the left margin and number-and-dot
// clause numbers no longer count)

const sets: [string, string][] = [['A', paths.setA], ['B', paths.setB], ['mixed', paths.mixed]];
for (const [name, pdf] of sets) {
  const s = score(pdf);
  const pct = (a: number, b: number) => (b ? a / b : 1);
  console.log(`set ${name}: numbers ${s.noRight.length}/${s.withNo.length}, titles ${s.tiRight.length}/${s.withTitle.length}, true refs ${s.found.length}/${s.truthRefs} (+${s.ambiguous.length} to a number on two sheets), false refs ${s.wrong.length}, extra numbers ${s.extra.length}`);
  if (s.noMiss.length) console.log('  numbers missed: ' + s.noMiss.join('; '));
  if (s.extra.length) console.log('  numbers on non-sheet pages: ' + s.extra.join('; '));
  if (s.tiMiss.length) console.log('  titles missed: ' + s.tiMiss.join('; '));
  if (s.missed.length) console.log('  refs missed: ' + s.missed.map((t) => `p${t.page} ${t.text}->${t.target} (${t.kind})`).join('; '));
  if (s.wrong.length) console.log('  false refs: ' + s.wrong.map((r) => `p${r.page} ${r.text}->${r.target}`).join('; '));
  test(`reader on set ${name}: every sheet number`, () => { assert.equal(s.noRight.length, s.withNo.length, s.noMiss.join('; ')); });
  test(`reader on set ${name}: no number on a page that is not a sheet`, () => { assert.deepEqual(s.extra, []); });
  test(`reader on set ${name}: titles at least 90 %`, () => { assert.ok(pct(s.tiRight.length, s.withTitle.length) >= 0.9, s.tiMiss.join('; ')); });
  test(`reader on set ${name}: true references at least 95 %`, () => { assert.ok(pct(s.found.length, s.truthRefs) >= 0.95, s.missed.map((t) => `p${t.page} ${t.text}`).join('; ')); });
  test(`reader on set ${name}: no false reference`, () => { assert.deepEqual(s.wrong.map((r) => `p${r.page} ${r.text}->${r.target}`), []); });
  if (s.ambiguous.length) test(`reader on set ${name}: no link to a number two sheets carry`, () => { assert.deepEqual(s.wrong.filter((r) => s.ambiguous.some((t) => t.page === r.page && overlap(r.box, t.box) > 0.3)).map((r) => `p${r.page} ${r.text}`), []); });
}
