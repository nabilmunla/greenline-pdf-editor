// 14.4: the REAL right-click menu (other tests run with --no-menu-popup): it pops up in the boxes of
// a dialog (the Header / Footer boxes of Numbers & headers, where a user had none), selected text in
// a dialog gets Copy, and the page keeps the viewer's own menus.
// xvfb-run -a node tests/e2e-menu-popup.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-menu-popup');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const d = new mupdf.PDFDocument();
for (let p = 0; p < 2; p++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
const FILE = join(TMP, 'blank.pdf');
writeFileSync(FILE, d.saveToBuffer('').asUint8Array());
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-menupop'), { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; return c; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=menupop', '--test-hooks', FILE] });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 2, null, { timeout: 60000 });
await sleep(1000);
const off = win.locator('.modal button', { hasText: 'Turn it off' });
if (await off.count()) { await off.first().click(); await sleep(300); }
const state = () => app.evaluate(() => { const w = [...globalThis.__pdfedWins.values()][0]; return { shown: w.menuShown || 0, labels: w.lastMenu || null }; });
const reset = () => app.evaluate(() => { for (const w of globalThis.__pdfedWins.values()) { w.lastMenu = null; w.menuShown = 0; } });
const closeMenu = async () => { await app.evaluate(() => { for (const w of globalThis.__pdfedWins.values()) { try { w.openMenu?.closePopup(w.win); } catch (_) { /* gone */ } } }); await sleep(300); };

await win.locator('.rtab', { hasText: /^Edit$/ }).first().click();
await win.locator('button', { hasText: 'Numbers & headers' }).first().click();
const left = win.locator('.modal input[placeholder="Left"]').first();
await left.waitFor({ timeout: 10000 });
await left.fill('Tender issue');
for (const [i, name] of [[0, 'Header Left'], [3, 'Footer Left']]) {
  await reset();
  await win.locator('.modal input[placeholder="Left"], .modal input[placeholder="Centre"], .modal input[placeholder="Right"]').nth(i).click({ button: 'right' });
  await sleep(800);
  const s = await state();
  ok(s.shown >= 1 && JSON.stringify(s.labels) === JSON.stringify(['Cut', 'Copy', 'Paste', 'Select all']), `${name} box: the menu pops up with Cut / Copy / Paste / Select all (${JSON.stringify(s)})`);
  await closeMenu();
}
// every other box of the dialog too
const boxes = win.locator('.modal input:visible, .modal textarea:visible');
const n = await boxes.count();
let bad = [];
for (let i = 0; i < n; i++) {
  await reset();
  const b = boxes.nth(i);
  const type = await b.getAttribute('type');
  if (type && !['text', 'number', 'search', null].includes(type)) continue;
  await b.click({ button: 'right' }).catch(() => {});
  await sleep(400);
  const s = await state();
  if (!(s.shown >= 1 && s.labels && s.labels.includes('Paste'))) bad.push(i);
  await closeMenu();
}
ok(n > 6 && bad.length === 0, `all ${n} boxes of the dialog get the menu` + (bad.length ? ` (not: ${bad.join(', ')})` : ''));
// selected text that can't be typed in: Copy alone
await reset();
// (the app's own text is not selectable by design; replies, the AI answers, translations and table
// previews are - a reply-style block stands in for them)
await win.evaluate(() => { const b = document.createElement('div'); b.className = 'reply'; b.id = 'sel-test'; b.textContent = 'Sheet A-101 general arrangement'; b.style.cssText = 'position:fixed;left:20px;top:20px;z-index:99999;width:300px'; document.body.appendChild(b); const r = document.createRange(); r.selectNodeContents(b); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
await win.locator('#sel-test').click({ button: 'right' });
await sleep(800);
let s = await state();
ok(JSON.stringify(s.labels) === '["Copy"]' && s.shown >= 1, `selected text in the dialog: Copy (${JSON.stringify(s)})`);
await closeMenu();
await win.keyboard.press('Escape'); await sleep(400);
// the page: the viewer's own menus, not this one
await reset();
const pg = await win.locator('.pg[data-page="0"]').boundingBox();
await win.mouse.click(pg.x + 200, pg.y + 200, { button: 'right' });
await sleep(800);
s = await state();
ok(s.labels === null, 'the page itself: no text-box menu (the viewer keeps its own)');
await app.close().catch(() => {});
rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
