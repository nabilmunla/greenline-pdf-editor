// 14.5: links get a faint blue mark (all of a page's links in one path), the link under the pointer
// a stronger one with an underline; Edit > Links > Show link marks turns them off. Screen only.
// xvfb-run -a node tests/e2e-link-marks.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-link-marks');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const d = new mupdf.PDFDocument();
const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
for (let p = 0; p < 3; p++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, 'BT /F1 12 Tf 72 760 Td (See A-301 and A-302) Tj ET'));
const p0 = d.loadPage(0);
p0.createLink([70, 70, 170, 90], '#page=2');
p0.createLink([200, 70, 300, 90], 'https://example.com/');
const p2 = d.loadPage(2);
for (let i = 0; i < 5000; i++) { const x = 20 + (i % 50) * 11, y = 100 + Math.floor(i / 50) * 7; p2.createLink([x, y, x + 9, y + 5], '#page=1'); }
const FILE = join(TMP, 'links.pdf');
writeFileSync(FILE, d.saveToBuffer('').asUint8Array());
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-lkmarks'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; return c; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=lkmarks', FILE] });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 3, null, { timeout: 60000 });
await sleep(1200);
const off = win.locator('.modal button', { hasText: 'Turn it off' });
if (await off.count()) { await off.first().click(); await sleep(300); }
await win.evaluate(() => window.__gcc.viewer().fit('page'));
await sleep(1500);
const marks = (pg) => win.locator(`.pg[data-page="${pg}"] .linkmark`).count();
ok(await marks(0) === 1, 'page 1: its two links in one mark (' + await marks(0) + ')');
const dPath = await win.locator('.pg[data-page="0"] .linkmark').getAttribute('d');
ok((dPath.match(/M/g) || []).length === 2, 'the mark outlines both links');
// hover the first link
const b = await win.locator('.pg[data-page="0"]').boundingBox();
const pw = await win.evaluate(() => window.__gcc.active().pages[0].w);
const kz = b.width / pw;
await win.mouse.move(b.x + 120 * kz, b.y + 80 * kz);
await sleep(400);
ok(await win.locator('.pg[data-page="0"] .linkhover').count() === 1 && await win.locator('.pg[data-page="0"] .linkunder').count() === 1, 'the link under the pointer: stronger mark and an underline');
await win.mouse.move(b.x + 400 * kz, b.y + 500 * kz);
await sleep(300);
ok(await win.locator('.linkhover').count() === 0, 'pointer away: back to the faint mark');
// the page with 5,000 links
await win.evaluate(() => window.__gcc.viewer().goTo?.(2));
await win.locator('.pg[data-page="2"]').scrollIntoViewIfNeeded();
await sleep(1500);
ok(await marks(2) === 1, '5,000 links on a page: still one mark element (' + await marks(2) + ')');
// off
await win.locator('.rtab', { hasText: /^Edit$/ }).click();
await win.locator('label.rchk', { hasText: 'Show link marks' }).locator('input').uncheck();
await sleep(500);
ok(await win.locator('.linkmark').count() === 0, 'Show link marks off: no marks anywhere');
await win.locator('label.rchk', { hasText: 'Show link marks' }).locator('input').check();
await sleep(500);
ok(await win.locator('.linkmark').count() >= 1, 'and on again');
ok(await win.evaluate(() => window.__gcc.active().changeCount) === 0, 'the file is not changed by the marks (nothing to save)');
await app.close().catch(() => {});
rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
