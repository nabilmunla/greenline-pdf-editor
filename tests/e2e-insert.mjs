// Insert pages from another open file (or from disk), and Replace pages (revised sheets): pages
// typed like in Print, placed where asked; replaced pages keep their bookmarks; one Ctrl+Z each.
//   xvfb-run -a node tests/e2e-insert.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-insert');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
/** sheets "<word> 1".. with bookmarks to sheets 2 and 3 */
function sheets(file, word, n, w = 595, h = 842) {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < n; i++) d.insertPage(-1, d.addPage([0, 0, w, h], 0, { Font: { F1: f } }, `BT /F1 40 Tf 100 400 Td (${word} ${i + 1}) Tj ET`));
  if (n >= 3) {
    const it = d.outlineIterator();
    it.insert({ title: 'Sheet 2', uri: '#page=2', open: false }); it.next();
    it.insert({ title: 'Sheet 3', uri: '#page=3', open: false });
  }
  writeFileSync(file, d.saveToBuffer('').asUint8Array());
}
const setA = join(TMP, 'Set A.pdf'), rev = join(TMP, 'Revised.pdf'), disk = join(TMP, 'On disk.pdf');
sheets(setA, 'OLD', 4);
sheets(rev, 'REV', 3, 842, 1191);
sheets(disk, 'DISK', 2);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-insert'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=insert', setA, rev] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await app.evaluate(({ dialog }) => { globalThis.__open = []; dialog.showOpenDialog = async () => { const f = globalThis.__open.shift(); return f ? { canceled: false, filePaths: [f] } : { canceled: true, filePaths: [] }; }; });
const E = (fn, a) => win.evaluate(fn, a);
const texts = () => E(async () => { const d = window.__gcc.active(); const out = []; for (let i = 0; i < d.pages.length; i++) out.push((await d.chars(i)).text.trim()); return out; });
const outline = () => E(async () => (await window.__gcc.engines.mu('outline', window.__gcc.active().id)).map((m) => [m.title, m.page]));
const dlg = () => win.locator('.modal', { hasText: /Insert pages|Replace pages/ });
const organize = async (label) => { await win.locator('.rtab', { hasText: 'Organize' }).click(); await win.locator('.ribbon .rb', { hasText: new RegExp('^' + label + '$') }).click(); await dlg().waitFor({ timeout: 5000 }); };
const field = (label) => dlg().locator('.row', { hasText: label }).locator('input.input').first();

try {
  await until(() => E(() => window.__gcc?.docs().length === 2 && window.__gcc.docs().every((d) => d.pages.length)), 30000, 'two files');
  ok(await E(() => window.__gcc.engines.mu('journalFast')) === true, 'the engine reads the undo journal the quick way (mupdf/pre.js loaded first)');
  await win.locator('.dtab', { hasText: 'Set A' }).click();
  await sleep(500);
  // 1. insert from the other open file: pages 3 and 1, after page 2
  await organize('From file');
  ok(await dlg().locator('label', { hasText: 'Revised.pdf' }).locator('input').isChecked(), 'the other open file is offered (and chosen) first – no file dialog');
  ok(/open, 3 pages/.test(await dlg().locator('label', { hasText: 'Revised.pdf' }).textContent()), 'shown with its page count');
  await field('Pages to take').fill('3, 1');
  await dlg().locator('select').selectOption('after');
  await dlg().locator('.row', { hasText: 'Where' }).locator('input.input').fill('2');
  ok(/2 pages of Revised\.pdf go in after page 2/.test(await dlg().locator('.hint').first().textContent()), 'says what will happen: ' + await dlg().locator('.hint').first().textContent());
  await dlg().locator('.btn.primary', { hasText: 'Insert 2 pages' }).click();
  await until(async () => (await texts()).length === 6, 15000, 'inserted');
  ok(JSON.stringify(await texts()) === JSON.stringify(['OLD 1', 'OLD 2', 'REV 3', 'REV 1', 'OLD 3', 'OLD 4']), 'in the order typed, after page 2: ' + JSON.stringify(await texts()));
  ok(await win.locator('.toast', { hasText: 'Inserted 2 pages of Revised.pdf after page 2' }).count() > 0, 'toast says so');
  await win.keyboard.press('Control+z');
  await until(async () => (await texts()).length === 4, 15000, 'undo');
  ok(true, 'Ctrl+Z: taken out again');

  // 2. a file on disk still works (Choose…)
  await app.evaluate((_e, f) => { globalThis.__open.push(f); }, disk);
  await organize('From file');
  await dlg().locator('button', { hasText: 'Choose…' }).click();
  await until(async () => /On disk\.pdf – 2 pages/.test(await dlg().textContent()), 10000, 'disk file');
  await dlg().locator('select').selectOption('end');
  await dlg().locator('.btn.primary').click();
  await until(async () => (await texts()).length === 6, 15000, 'inserted from disk');
  ok(JSON.stringify((await texts()).slice(4)) === JSON.stringify(['DISK 1', 'DISK 2']), 'from disk, at the end');
  await win.keyboard.press('Control+z');
  await until(async () => (await texts()).length === 4, 15000, 'undo 2');

  // 3. replace page 2 with revised sheet 1: the bookmark to sheet 2 still goes there
  await organize('Replace');
  ok(await dlg().locator('.seg button.on', { hasText: 'Replace' }).count() === 1, 'Replace opens in Replace mode');
  await field('Replace pages').fill('2');
  await dlg().locator('label', { hasText: 'Revised.pdf' }).locator('input').check();
  await field('Pages to take').fill('1');
  ok(/replaced by page 1 of Revised\.pdf, one for one/.test(await dlg().locator('.hint').first().textContent()), 'says: one for one, which page of which file, bookmarks kept');
  await dlg().locator('.btn.primary', { hasText: 'Replace 1 page' }).click();
  await until(async () => (await texts())[1] === 'REV 1', 15000, 'replaced');
  ok(JSON.stringify(await texts()) === JSON.stringify(['OLD 1', 'REV 1', 'OLD 3', 'OLD 4']), 'page 2 is the revised sheet, the rest as it was');
  ok(JSON.stringify(await outline()) === JSON.stringify([['Sheet 2', 1], ['Sheet 3', 2]]), 'bookmarks still point at sheets 2 and 3');
  ok(await E(() => Math.round(window.__gcc.active().pages[1].w)) === 842, 'the revised sheet keeps its own size (A3)');
  // 4. a run of 2 replaced by all 3 revised sheets: the extra goes in after
  await organize('Replace');
  await field('Replace pages').fill('2-3');
  await dlg().locator('label', { hasText: 'Revised.pdf' }).locator('input').check();
  // (nothing typed: as many as are replaced - the same numbers, 2-3)
  ok(/replaced by pages 2-3 of Revised\.pdf, one for one/.test(await dlg().locator('.hint').first().textContent()), 'nothing typed: the same page numbers, one for one: ' + await dlg().locator('.hint').first().textContent());
  await field('Pages to take').fill('1-3');
  ok(/extra one goes in after page 3/.test(await dlg().locator('.hint').first().textContent()), 'says where the extra page goes');
  await dlg().locator('.btn.primary').click();
  await until(async () => (await texts()).length === 5, 15000, 'replaced 2 by 3');
  ok(JSON.stringify(await texts()) === JSON.stringify(['OLD 1', 'REV 1', 'REV 2', 'REV 3', 'OLD 4']), 'pages 2-3 replaced by 3 pages');
  // 5. what can't be done is said, the button stays off
  await organize('Replace');
  await field('Replace pages').fill('1, 4');
  await dlg().locator('label', { hasText: 'Revised.pdf' }).locator('input').check();
  await field('Pages to take').fill('1');
  ok(await dlg().locator('.btn.primary').isDisabled() && /give as many of each/.test(await dlg().locator('.hint').first().textContent()), '2 scattered pages for 1: said, button off');
  await dlg().locator('button', { hasText: 'Cancel' }).click();
  // undo twice: back to the original
  await win.keyboard.press('Control+z');
  await until(async () => (await texts()).length === 4, 15000, 'undo replace 2');
  await win.keyboard.press('Control+z');
  await until(async () => (await texts())[1] === 'OLD 2', 15000, 'undo replace 1');
  ok(JSON.stringify(await texts()) === JSON.stringify(['OLD 1', 'OLD 2', 'OLD 3', 'OLD 4']), 'two Ctrl+Z: the original set');
  // 6. the other file was never touched
  await win.locator('.dtab', { hasText: 'Revised' }).click();
  await sleep(500);
  ok(JSON.stringify(await texts()) === JSON.stringify(['REV 1', 'REV 2', 'REV 3']) && !(await E(() => window.__gcc.active().dirty)), 'Revised.pdf left as it was');
  // 7. saved and reopened: the replaced file is a clean PDF
  await win.locator('.dtab', { hasText: 'Set A' }).click();
  await sleep(400);
  await organize('Replace');
  await field('Replace pages').fill('3');
  await dlg().locator('label', { hasText: 'Revised.pdf' }).locator('input').check();
  await field('Pages to take').fill('2');
  await dlg().locator('.btn.primary').click();
  await until(async () => (await texts())[2] === 'REV 2', 15000, 'replaced for save');
  await win.keyboard.press('Control+s');
  await until(() => E(() => !window.__gcc.active().dirty), 20000, 'saved');
  const d = mupdf.Document.openDocument(readFileSync(setA), 'application/pdf');
  ok(d.countPages() === 4 && d.loadPage(2).toStructuredText('').asText().trim() === 'REV 2', 'saved: page 3 is the revised sheet');
  ok(JSON.stringify(d.loadOutline().map((x) => [x.title, x.page])) === JSON.stringify([['Sheet 2', 1], ['Sheet 3', 2]]), 'saved: bookmarks intact');
} catch (e) { ok(false, e.message); await win.screenshot({ path: join(TMP, 'fail.png') }).catch(() => {}); }
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
