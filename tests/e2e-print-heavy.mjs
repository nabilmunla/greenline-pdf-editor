// Heavy scans go to the printer as pictures (0.8.5): Auto + black & white makes the 600 dpi colour
// scan sheets into 300 dpi grey pictures (progress shown), "As they are" sends the scan whole,
// Cancel while the pictures are made sends nothing, the choice is remembered. No printer here:
// the hand-over to Windows is stood in for and what would be printed is checked.
// xvfb-run -a node tests/e2e-print-heavy.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-print-heavy');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-printheavy'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const T0 = Date.now();
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m + `  [${((Date.now() - T0) / 1000).toFixed(1)} s]`); if (!c) { fails++; void win.screenshot({ path: join(TMP, `fail-${fails}.png`) }).catch(() => {}); } return c; };

// ---------------------------------------------------------------- heavy scans: sent as pictures (0.8.5)
// A "scan": 5 A4 landscape pages, each a 600 dpi colour picture, and one text page
{
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const pw = Math.round(842 / 72 * 600), ph = Math.round(595 / 72 * 600);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, pw, ph], false);
  pix.clear(235);
  const px = pix.getPixels();
  for (let y = 0; y < ph; y += 41) for (let x = 0; x < pw; x++) { const i = (y * pw + x) * 3; px[i] = px[i + 1] = px[i + 2] = 20; }
  const img = d.addImage(new mupdf.Image(pix.asJPEG(80)));
  for (let i = 0; i < 5; i++) d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, { XObject: { Im0: img } }, 'q 842 0 0 595 0 0 cm /Im0 Do Q'));
  d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, { Font: { F1: f } }, 'BT /F1 20 Tf 60 500 Td (TEXT PAGE STAYS SHARP) Tj ET'));
  writeFileSync(join(TMP, 'scan.pdf'), d.saveToBuffer('').asUint8Array());
}
console.log(`scan made [${((Date.now() - T0) / 1000).toFixed(1)} s]`);
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=printheavy', join(TMP, 'scan.pdf')] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await win.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 6, null, { timeout: 60000 }).catch(async (e) => { console.log('no doc', e.message, await win.evaluate(() => JSON.stringify(window.__gcc?.docs().map((d) => [d.name, d.pages.length])))); });
await sleep(800);
// no printer here: the hand-over is stood in for (what would go to the printer is kept)
await app.evaluate(({ ipcMain }) => {
  ipcMain.removeHandler('print:run');
  ipcMain.handle('print:run', async (_e, file, o) => { globalThis.__printed = { file, o, size: process.getBuiltinModule('node:fs').statSync(file).size }; return { ok: true, reason: '' }; });
  ipcMain.removeHandler('print:printers');
  ipcMain.handle('print:printers', async () => [{ name: 'KONICA', displayName: 'KONICA MINOLTA test', description: '', isDefault: true, status: 0 }]);
});
const openPrint = async () => { await win.keyboard.press('Control+p'); await win.waitForSelector('.printdlg', { timeout: 5000 }); await sleep(800); };
await openPrint();
await win.locator('.printdlg .seg button', { hasText: 'Black & white' }).click();
await win.locator('.printdlg .seg button', { hasText: /^Auto$/ }).last().click();
await win.locator('.printdlg .btn.primary').click();
// the progress shows the pictures being made
let sawPics = false;
for (let i = 0; i < 2400; i++) {
  const t = await win.evaluate(() => document.querySelector('.printdlg .prog')?.textContent || '');
  if (/into a picture/.test(t || '')) sawPics = true;
  if (!(await win.locator('.printdlg').count())) break;
  await sleep(50);
}
ok(sawPics, 'auto + black & white: the heavy sheets are made into pictures (progress shown)');
const toast1 = await win.locator('.toast').allTextContents();
ok(toast1.some((t) => /6 pages sent to KONICA MINOLTA test \(5 as pictures\)/.test(t)), 'toast says 5 of 6 went as pictures: ' + JSON.stringify(toast1));
const printed = await app.evaluate(() => globalThis.__printed);
{
  const d = mupdf.Document.openDocument(readFileSync(printed.file), 'application/pdf');
  const xo = (i) => { const r = d.findPage(i).get('Resources').get('XObject'); const l = []; if (r.isDictionary()) r.forEach((v) => { const x = v.resolve(); if (x.get('Subtype').asName() === 'Image') l.push(x.get('Width').asNumber()); }); return l; };
  ok(d.countPages() === 6, 'all 6 sheets in the print file');
  ok(xo(0).length === 1 && Math.abs(xo(0)[0] - 3508) <= 3, 'sheet 1: one 300 dpi picture of the A4 sheet: ' + xo(0));
  ok(d.loadPage(5).toStructuredText('').asText().includes('TEXT PAGE STAYS SHARP'), 'the text page went as it is');
  ok(printed.o.color === false, 'black & white asked of the printer');
  console.log(`    print file ${Math.round(printed.size / 1024)} KB`);
}
// as they are: the scan whole
await openPrint();
await win.locator('.printdlg .seg button', { hasText: 'As they are' }).click();
await win.locator('.printdlg .btn.primary').click();
for (let i = 0; i < 200 && (await win.locator('.printdlg').count()); i++) await sleep(50);
{
  const p2 = await app.evaluate(() => globalThis.__printed);
  const d = mupdf.Document.openDocument(readFileSync(p2.file), 'application/pdf');
  const r = d.findPage(0).get('Resources').get('XObject');
  let w = 0; r.forEach((v) => { w = Math.max(w, v.resolve().get('Width').asNumber?.() || 0); });
  ok(w > 7000, '"As they are": the scan goes at its own size: ' + w);
}
// pictures, then Cancel while they are being made: nothing printed, the panel stays usable
await openPrint();
await win.locator('.printdlg .seg button', { hasText: /^Pictures$/ }).click();
await app.evaluate(() => { globalThis.__printed = null; });
await win.locator('.printdlg .btn.primary').click();
for (let i = 0; i < 200; i++) { const t = await win.evaluate(() => document.querySelector('.printdlg .prog')?.textContent || ''); if (/into a picture/.test(t || '')) break; await sleep(25); }
await win.locator('.printdlg button', { hasText: 'Cancel' }).click();
for (let i = 0; i < 200 && (await win.evaluate(() => document.querySelectorAll('.printdlg .prog').length)); i++) await sleep(50);
ok(!(await app.evaluate(() => globalThis.__printed)), 'Cancel while the pictures are made: nothing sent');
ok(await win.locator('.printdlg').count() === 1 && await win.locator('.printdlg .btn.primary').isEnabled(), 'the panel is usable again');
ok(await win.locator('.printdlg .seg button.on', { hasText: /^Pictures$/ }).count() === 1, 'the choice is kept');
await win.locator('.printdlg button', { hasText: 'Cancel' }).click();
await sleep(300);
// the choice is remembered next time
await openPrint();
ok(await win.locator('.printdlg .seg button.on', { hasText: /^Pictures$/ }).count() === 1, '"Pictures" remembered by the panel');
await win.locator('.printdlg button', { hasText: 'Cancel' }).click();


await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
