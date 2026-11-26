// 14.2: search in chosen pages - "This file" can be limited to the page on screen or typed pages
// (as in Print); the limit goes back to All on another tab.
// xvfb-run -a node tests/e2e-search-pages.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-search-pages');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const mk = (name, pages) => {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let p = 0; p < pages; p++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, `BT /F1 14 Tf 72 700 Td (Page ${p + 1} steel beam schedule) Tj ET`));
  const file = join(TMP, name);
  writeFileSync(file, d.saveToBuffer('').asUint8Array());
  return file;
};
const A = mk('ten.pdf', 10), B = mk('other.pdf', 3);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-srchpg'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; return c; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=srchpg', A, B] });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
await win.waitForFunction(() => window.__gcc?.docs()?.length === 2 && window.__gcc.docs().every((d) => d.pages.length), null, { timeout: 60000 });
await sleep(1200);
const off = win.locator('.modal button', { hasText: 'Turn it off' });
if (await off.count()) { await off.first().click(); await sleep(300); }
// the 10-page file in front
await win.locator('.dtab', { hasText: 'ten.pdf' }).first().click().catch(() => {});
await win.waitForFunction(() => window.__gcc.active()?.pages.length === 10);
await win.locator('.rail-btn[title^="Search"]').click();
const panel = win.locator('.search-pages');
const status = () => win.locator('.cm-tools .faint').first().innerText();
const rows = () => win.locator('.cm-list .cm-item').count();
const find = async () => { await win.locator('.cm-tools button', { hasText: /^Find$/ }).click(); await sleep(1500); };
await win.locator('.search-in').fill('beam');
await find();
ok(await rows() === 10, `All: 10 hits (${await rows()})`);
await panel.locator('button', { hasText: 'Pages…' }).click();
await panel.locator('input').fill('3-5, 8');
await find();
const pagesOf = () => win.evaluate(() => [...document.querySelectorAll('.cm-list .cm-item')].map((e) => e.innerText.match(/\d+/)?.[0]));
ok(await rows() === 4, `"3-5, 8": 4 hits (${await rows()})`);
ok(JSON.stringify(await pagesOf()) === '["3","4","5","8"]', 'on pages 3, 4, 5 and 8: ' + JSON.stringify(await pagesOf()));
ok(/in pages 3-5, 8/.test(await status()), 'the status names the pages: ' + await status());
await panel.locator('button', { hasText: 'This page' }).click();
await find();
ok(await rows() === 1, `This page: 1 hit (${await rows()})`);
await panel.locator('button', { hasText: 'Pages…' }).click();
await panel.locator('input').fill('42');
await find();
ok(await rows() === 0 && /0 found/.test(await status()), 'pages that don\'t exist: nothing found, no error');
// another tab: back to All
await win.locator('.dtab', { hasText: 'other.pdf' }).first().click();
await win.waitForFunction(() => window.__gcc.active()?.pages.length === 3);
await sleep(400);
ok(await panel.locator('button.on').innerText() === 'All 3', 'another tab: the choice is back to All');
await find();
ok(await rows() === 3, `and searches all 3 pages (${await rows()})`);
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
