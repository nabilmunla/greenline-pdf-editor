// Search all open files: hits grouped by file, a hit in another file brings it to the front at the
// hit; Enter walks on into the next file; Stop; a long file; results kept while switching tabs.
//   xvfb-run -a node tests/e2e-searchall.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-searchall');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
function make(file, pages) {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (const t of pages) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, `BT /F1 18 Tf 60 700 Td (${t}) Tj ET`));
  writeFileSync(file, d.saveToBuffer('').asUint8Array());
}
const A = join(TMP, 'Addendum 1.pdf'), B = join(TMP, 'Addendum 2.pdf'), C = join(TMP, 'Letter.pdf'), L = join(TMP, 'Big spec.pdf');
make(A, ['Scope of works', 'Waterproofing membrane to podium', 'nothing here', 'Revised waterproofing details', 'end']);
make(B, ['WATERPROOFING to basement walls', 'Doors and windows', 'waterproofing warranty 10 years']);
make(C, ['Dear Sir, please find attached.']);
copyFileSync('tests/data/long-spec.pdf', L);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-searchall'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=searchall', A, B, C, L] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
const E = (fn, a) => win.evaluate(fn, a);
const active = () => E(() => window.__gcc.active()?.name);
const status = () => win.locator('.cm-tools .faint').textContent();
const heads = async () => (await win.locator('.sf-head').allTextContents()).map((t) => t.trim());
const box = () => win.locator('.search-in');

try {
  await until(() => E(() => window.__gcc?.docs().length === 4 && window.__gcc.docs().every((d) => d.pages.length)), 40000, 'four files');
  await win.locator('.dtab', { hasText: 'Addendum 1' }).click();
  await sleep(400);
  await win.locator('.rail-btn[title^="Search"]').click();
  await win.locator('.seg.scope button', { hasText: 'All open files' }).click();
  ok(/All open files \(4\)/.test(await win.locator('.seg.scope button.on').textContent()), 'scope: All open files (4)');
  await box().fill('waterproofing');
  await box().press('Enter');
  await until(async () => /found in/.test(await status()), 60000, 'search done');
  ok(/4 found in 2 of 4 files/.test(await status()), 'status: ' + await status());
  ok(JSON.stringify(await heads()) === JSON.stringify(['Addendum 1.pdf2', 'Addendum 2.pdf2']), 'grouped by file, tab order, with counts: ' + JSON.stringify(await heads()));
  ok((await win.locator('.sf-none').textContent()) === 'Not found in: Letter.pdf, Big spec.pdf', 'files without hits: one line at the end');
  ok(JSON.stringify(await win.locator('.sf-group').first().locator('.hr-page').allTextContents()) === JSON.stringify(['2', '4']), 'page numbers in their own column');
  const bands = await win.locator('.sf-group').evaluateAll((els) => els.map((e) => getComputedStyle(e).borderLeftColor));
  ok(bands.length === 2 && bands[0] !== bands[1], 'each file its own colour band: ' + bands.join(' / '));
  // fold all / open all
  await win.locator('.cm-tools button.link', { hasText: 'Fold all' }).click();
  ok(await win.locator('.sf-group .cm-item').count() === 0, 'Fold all: only the files listed');
  await win.locator('.cm-tools button.link', { hasText: 'Open all' }).click();
  ok(await win.locator('.sf-group .cm-item').count() === 4, 'Open all: the hits back');
  // a hit in another file: it comes to the front at that page, the hit marked
  await win.locator('.sf-group', { hasText: 'Addendum 2.pdf' }).locator('.cm-item').nth(1).click();
  await until(async () => (await active()) === 'Addendum 2.pdf', 10000, 'switched');
  await until(() => E(() => window.__gcc.viewer().page() === 2), 10000, 'at page 3');
  ok(true, 'picked a hit in Addendum 2: that tab in front, at page 3');
  await until(() => win.locator('.pg[data-page="2"] rect.hit.cur').count(), 5000, 'hit marked');
  ok(true, 'the hit is marked on the page');
  ok(await win.locator('.sf-group', { hasText: 'Addendum 2.pdf' }).locator('.cm-item.on').count() === 1, 'its row is the chosen one');
  ok(await win.locator('.sf-head.cur', { hasText: 'Addendum 2.pdf' }).count() === 1, 'the file in front is marked in the list');
  // Enter walks on: past the last hit of Addendum 2 -> the first of Addendum 1 (round)
  await box().press('Enter');
  await until(async () => (await active()) === 'Addendum 1.pdf', 10000, 'next file');
  await until(() => E(() => window.__gcc.viewer().page() === 1), 10000, 'page 2 of Addendum 1');
  ok(true, 'Enter after the last hit of one file: on to the next file (round to the first)');
  await box().press('Enter');
  await until(() => E(() => window.__gcc.viewer().page() === 3), 10000, 'next hit in same file');
  ok(await active() === 'Addendum 1.pdf', 'Enter again: the next hit in the same file (page 4)');
  // Match case
  await win.locator('.cm-tools label', { hasText: 'Match case' }).locator('input').check();
  await box().fill('WATERPROOFING');
  await box().press('Enter');
  await until(async () => /found in/.test(await status()) && !/Searching/.test(await status()), 30000, 'case search');
  ok(/1 found in 1 of 4 files/.test(await status()), 'Match case: ' + await status());
  await win.locator('.cm-tools label', { hasText: 'Match case' }).locator('input').uncheck();
  // switching tabs keeps the results
  await win.locator('.dtab', { hasText: 'Letter' }).click();
  await sleep(500);
  ok(/1 found in 1 of 4 files/.test(await status()), 'results kept when another tab is chosen');
  // a long file: Stop
  await box().fill('SPECIFICATION FOR CONCRETE');
  await box().press('Enter');
  await until(async () => /Big spec\.pdf \(4 of 4\) – page/.test(await status()), 60000, 'into the big file');
  ok(true, 'progress names the file and the page: ' + (await status()).trim());
  await win.locator('.cm-tools button', { hasText: 'Stop' }).click();
  await until(async () => /stopped/.test(await status()), 10000, 'stopped');
  ok(true, 'Stop: ' + (await status()).trim());
  // this file only: as before
  await win.locator('.seg.scope button', { hasText: 'This file' }).click();
  await win.locator('.dtab', { hasText: 'Addendum 2' }).click();
  await sleep(400);
  await box().fill('waterproofing');
  await box().press('Enter');
  await until(async () => /2 found/.test(await status()), 20000, 'this file');
  ok(true, 'This file: 2 found in Addendum 2');
} catch (e) { ok(false, e.message); await win.screenshot({ path: join(TMP, 'fail.png') }).catch(() => {}); }
await win.screenshot({ path: join(TMP, 'end.png') }).catch(() => {});
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
