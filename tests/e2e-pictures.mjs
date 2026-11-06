// Pages to pictures (PNG / JPG, one file or a folder of them, replace asked) and a new PDF from
// pictures (JPG, PNG, a 3-page TIFF, a broken one named; opened as a tab).
//   xvfb-run -a node tests/e2e-pictures.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-pictures');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'out'), { recursive: true });
mkdirSync(join(TMP, 'site photos'), { recursive: true });
const file = join(TMP, 'Sheets.pdf');
{
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < 3; i++) d.insertPage(-1, d.addPage([0, 0, 595.28, 841.89], 0, { Font: { F1: f } }, `0 0 0 RG 4 w 50 50 495 740 re S BT /F1 40 Tf 100 400 Td (SHEET ${i + 1}) Tj ET`));
  writeFileSync(file, d.saveToBuffer('').asUint8Array());
}
const P = join(TMP, 'site photos');
execFileSync('python3', ['-c', `
from PIL import Image, ImageDraw
d='${P}/'
a=Image.new('RGB',(1200,800),'white'); ImageDraw.Draw(a).rectangle([100,100,1100,700],outline='black',width=8); a.save(d+'01 photo.jpg',dpi=(150,150),quality=90)
b=Image.new('RGB',(600,900),'white'); ImageDraw.Draw(b).text((50,50),'PORTRAIT',fill='black'); b.save(d+'02 sketch.png',dpi=(72,72))
fr=[Image.new('L',(850,1100),255) for _ in range(3)]
for i,f in enumerate(fr): ImageDraw.Draw(f).text((100,100),'SCAN PAGE %d'%(i+1),fill=0)
fr[0].save(d+'03 scan.tif',save_all=True,append_images=fr[1:],dpi=(100,100),compression='tiff_deflate')
open(d+'04 broken.jpg','wb').write(b'not a jpeg')
`]);
const pics = ['01 photo.jpg', '02 sketch.png', '03 scan.tif', '04 broken.jpg'].map((n) => join(P, n));
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-pictures'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };
const pngSize = (f) => { const b = readFileSync(f); return b.slice(1, 4).toString() === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=pictures', file] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await app.evaluate(({ dialog, shell }) => {
  globalThis.__q = { save: [], open: [], box: [] };
  dialog.showSaveDialog = async () => { const f = globalThis.__q.save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
  dialog.showOpenDialog = async () => { const f = globalThis.__q.open.shift(); return f ? { canceled: false, filePaths: f } : { canceled: true, filePaths: [] }; };
  dialog.showMessageBox = async (_w, o) => { globalThis.__q.box.push((o || _w).message); return { response: 0, checkboxChecked: false }; };
  shell.openPath = async () => '';
  shell.showItemInFolder = () => {};
});
const q = (k, v) => app.evaluate((_e, [k, v]) => globalThis.__q[k].push(v), [k, v]);
const E = (fn, a) => win.evaluate(fn, a);
const dlg = (t) => win.locator('.modal', { hasText: t });
const fileBtn = async (label) => { await win.locator('.rtab.file').click(); await win.locator('.filepane button', { hasText: label }).click(); };

try {
  await until(() => E(() => window.__gcc?.active()?.pages.length === 3), 30000, 'file');
  // 1. two pages as PNG into a folder
  await fileBtn('Save as pictures');
  const d1 = dlg('Save pages as pictures');
  await d1.waitFor({ timeout: 5000 });
  await d1.locator('input.input').first().fill('1-2');
  await d1.locator('.seg button', { hasText: 'PNG' }).click();
  await d1.locator('select').selectOption('96');
  ok(/page 1 becomes 794 × 1,123 pixels/.test(await d1.locator('.hint').first().textContent()), 'says how big: ' + await d1.locator('.hint').first().textContent());
  await q('open', [join(TMP, 'out')]);
  await d1.locator('.btn.primary', { hasText: 'Save 2 pictures' }).click();
  const p1 = join(TMP, 'out', 'Sheets - p01.png'), p2 = join(TMP, 'out', 'Sheets - p02.png');
  await until(async () => existsSync(p1) && existsSync(p2) && !(await dlg('Save pages as pictures').count()), 30000, 'pictures saved');
  ok(JSON.stringify(pngSize(p1)) === JSON.stringify([794, 1123]), 'PNG, A4 at 96 dpi: ' + JSON.stringify(pngSize(p1)));
  ok(await win.locator('.toast', { hasText: 'Saved 2 pictures in out' }).count() > 0, 'toast: Saved 2 pictures in out');
  // 2. again into the same folder: asked before replacing
  const before = statSync(p1).mtimeMs;
  await fileBtn('Save as pictures');
  await dlg('Save pages as pictures').locator('input.input').first().fill('1-2');
  await q('open', [join(TMP, 'out')]);
  await dlg('Save pages as pictures').locator('.btn.primary').click();
  await until(async () => statSync(p1).mtimeMs !== before, 30000, 'replaced');
  ok((await app.evaluate(() => globalThis.__q.box)).some((m) => /2 of these pictures are in that folder already/.test(m)), 'asked before replacing the 2 pictures');
  // 3. one page as JPG: a Save dialog, the page shown with its markup
  await E(() => window.__gcc.viewer().goTo(2));
  await sleep(400);
  await win.locator('.rtab', { hasText: 'Organize' }).click();
  await win.locator('.ribbon .rb', { hasText: /^Pictures$/ }).click();
  const d3 = dlg('Save pages as pictures');
  await d3.waitFor({ timeout: 5000 });
  ok(await d3.locator('input.input').first().inputValue() === '3', 'starts with the page in view');
  await d3.locator('.seg button', { hasText: 'JPG' }).click();
  const jpg = join(TMP, 'out', 'sheet 3.jpg');
  await q('save', jpg);
  await d3.locator('.btn.primary', { hasText: 'Save 1 picture' }).click();
  await until(() => existsSync(jpg), 30000, 'jpg');
  const jb = readFileSync(jpg);
  ok(jb[0] === 0xff && jb[1] === 0xd8, 'a JPG file');

  // 4. a new PDF from pictures (a broken one is named, the rest made); A4 pages
  await q('open', pics);
  await fileBtn('New from pictures');
  const d4 = dlg('New PDF from pictures');
  await until(async () => (await d4.locator('.frow').count()) === 4, 10000, 'listed');
  ok(true, 'the 4 pictures listed');
  await d4.locator('.seg button', { hasText: 'A4' }).click();
  await d4.locator('.btn.primary', { hasText: 'Make PDF (4 pictures)' }).click();
  await until(async () => (await E(() => window.__gcc.active()?.name)) === 'site photos.pdf', 30000, 'new tab');
  const t = await E(() => { const d = window.__gcc.active(); return { n: d.pages.length, dirty: d.dirty, path: d.path, sizes: d.pages.map((p) => [Math.round(p.w), Math.round(p.h)]) }; });
  ok(t.n === 5, 'a page per picture, all 3 pages of the TIFF: ' + t.n + ' pages');
  ok(JSON.stringify(t.sizes) === JSON.stringify([[842, 595], [595, 842], [595, 842], [595, 842], [595, 842]]), 'A4, landscape for the landscape photo: ' + JSON.stringify(t.sizes));
  ok(t.dirty && !t.path, 'a new tab, not saved yet');
  ok(await win.locator('.toast', { hasText: 'not read: 04 broken.jpg' }).count() > 0, 'the broken picture is named');
  ok(await win.locator('.toast button', { hasText: 'Make searchable (OCR)' }).count() > 0, 'OCR offered');
  // … and still works after another tab was brought to the front (its tab change closed the dialog)
  await win.locator('.dtab').first().click();
  await until(async () => (await E(() => window.__gcc.active()?.name)) !== 'site photos.pdf', 5000, 'other tab');
  await win.locator('.toast button', { hasText: 'Make searchable (OCR)' }).click();
  await sleep(800);
  ok((await E(() => window.__gcc.active()?.name)) === 'site photos.pdf' && await win.locator('.modal', { hasText: /OCR|searchable/i }).count() > 0, 'OCR from the toast after a tab change: its tab in front, the OCR dialog stays open');
  await win.locator('.modal button', { hasText: 'Cancel' }).first().click().catch(() => {});
  await sleep(300);
  // 5. a picture sent to the app (opened / dropped): the dialog with it
  await app.evaluate(({ BrowserWindow }, x) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [x]), pics[0]);
  await until(() => dlg('New PDF from pictures').count(), 10000, 'dialog from open');
  ok(await dlg('New PDF from pictures').locator('.frow').count() === 1, 'a picture opened: offered as a new PDF');
  await dlg('New PDF from pictures').locator('button', { hasText: 'Cancel' }).click();
} catch (e) { ok(false, e.message); await win.screenshot({ path: join(TMP, 'fail.png') }).catch(() => {}); }
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
