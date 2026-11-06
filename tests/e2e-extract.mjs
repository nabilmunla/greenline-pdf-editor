// Extract pages (typed like Print, saved now or opened as a tab, taken out of the file or not) and
// the Pages panel keeping each file's place when switching tabs.   xvfb-run -a node tests/e2e-extract.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-extract');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const files = ['Spec A.pdf', 'Spec B.pdf'].map((n) => { const f = join(TMP, n); copyFileSync('tests/data/long-spec.pdf', f); return f; });
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-extract'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=extract', ...files] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await app.evaluate(({ dialog }) => { globalThis.__save = []; dialog.showSaveDialog = async () => { const f = globalThis.__save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; }; });
const E = (fn, a) => win.evaluate(fn, a);
const active = () => E(() => { const d = window.__gcc.active(); return d && { name: d.name, pages: d.pages.length, dirty: d.dirty, path: d.path }; });
const dlg = () => win.locator('.modal', { hasText: 'Extract pages' });
const openExtract = async () => {
  await win.locator('.rtab', { hasText: 'Organize' }).click();
  await win.locator('.ribbon .rb', { hasText: /^Extract$/ }).click();
  await dlg().waitFor({ timeout: 5000 });
};

try {
  await until(() => E(() => window.__gcc?.docs().length === 2), 30000, 'two files');
  await sleep(800);
  // 1. the Pages panel keeps each file's place
  if (!(await win.locator('.thumbs').count())) await win.locator('.rail-btn').first().click();
  await until(() => win.locator('.thumbs').count(), 5000, 'thumbnails');
  await E(() => { document.querySelector('.thumbs').scrollTop = 30000; });
  await sleep(400);
  const placeA = await E(() => document.querySelector('.thumbs').scrollTop);
  await win.locator('.dtab', { hasText: 'Spec A' }).click();
  await sleep(600);
  await E(() => { document.querySelector('.thumbs').scrollTop = 9000; });
  await sleep(400);
  await win.locator('.dtab', { hasText: 'Spec B' }).click();
  await sleep(700);
  const backB = await E(() => document.querySelector('.thumbs').scrollTop);
  ok(Math.abs(backB - placeA) < 40, `back to Spec B: thumbnails where they were (${placeA} -> ${backB})`);
  await win.locator('.dtab', { hasText: 'Spec A' }).click();
  await sleep(700);
  const backA = await E(() => document.querySelector('.thumbs').scrollTop);
  ok(Math.abs(backA - 9000) < 40, `back to Spec A: thumbnails where they were (9000 -> ${backA})`);

  // 2. typed pages, opened as a tab, taken out of the original
  await openExtract();
  const inp = dlg().locator('input.input').first();
  await inp.fill('1-3,5,8-10');
  ok(/7 pages: 1-3, 5, 8-10/.test(await dlg().locator('.hint').first().textContent()), 'the pages typed are read like in Print: ' + (await dlg().locator('.hint').first().textContent()));
  ok(/Extract 7 pages/.test(await dlg().locator('.btn.primary').textContent()), 'button says how many');
  await inp.fill('2000-2010');
  ok(await dlg().locator('.btn.primary').isDisabled() && /None of those pages/.test(await dlg().locator('.hint').first().textContent()), 'pages that are not in the file: said, and nothing to extract');
  await inp.fill('1-3,5,8-10');
  await dlg().locator('label', { hasText: 'Open it as a new tab' }).locator('input').check();
  await dlg().locator('label', { hasText: 'Remove these pages' }).locator('input').check();
  await dlg().locator('.btn.primary').click();
  await until(async () => (await active())?.pages === 7, 20000, 'new tab with 7 pages');
  const t = await active();
  ok(/Spec A \(pages 1-3,5,8-10\)\.pdf/.test(t.name) && !t.path, 'opened as a new tab, not saved yet: ' + t.name);
  const orig = await E(() => window.__gcc.docs().find((d) => d.name === 'Spec A.pdf').pages.length);
  ok(orig === 1493, 'the 7 pages taken out of the original (1500 -> ' + orig + ')');
  // undo in the original puts them back
  await win.locator('.dtab', { hasText: /^Spec A\.pdf/ }).click();
  await sleep(500);
  await win.keyboard.press('Control+z');
  await until(() => E(() => window.__gcc.active().pages.length === 1500), 15000, 'undo');
  ok(true, 'Ctrl+Z in the original: all 1500 pages back');

  // 3. saved straight away, the original left as it is
  const out = join(TMP, 'extracted.pdf');
  await app.evaluate((_e, f) => { globalThis.__save.push(f); }, out);
  await openExtract();
  await dlg().locator('input.input').first().fill('10, 2, 7');
  await dlg().locator('label', { hasText: 'Save it as a new file now' }).locator('input').check();
  await dlg().locator('label', { hasText: 'Remove these pages' }).locator('input').uncheck();
  await dlg().locator('.btn.primary').click();
  await until(() => existsSync(out), 20000, 'saved');
  await sleep(300);
  const d = mupdf.Document.openDocument(readFileSync(out), 'application/pdf');
  ok(d.countPages() === 3, 'saved file has 3 pages');
  const firstText = d.loadPage(0).toStructuredText().asText();
  const p10 = mupdf.Document.openDocument(readFileSync(files[0]), 'application/pdf').loadPage(9).toStructuredText().asText();
  ok(firstText.trim().slice(0, 60) === p10.trim().slice(0, 60), 'in the order typed: the first page is page 10');
  ok(await E(() => window.__gcc.docs().find((x) => x.name === 'Spec A.pdf').pages.length) === 1500, 'original untouched this time');
  ok(!(await dlg().count()), 'dialog closed');
} catch (e) { ok(false, e.message); await win.screenshot({ path: join(TMP, 'fail.png') }).catch(() => {}); }
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
