// Table to Excel: a box drawn around a table (a table lost on a big drawing) - only that area goes
// to Excel, read like Export to Excel reads a page; the page may be shown turned.
//   xvfb-run -a node tests/e2e-area.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-area');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const flat = join(TMP, 'Steel tables.pdf');
copyFileSync('tests/data/steel-sections-3p.pdf', flat);
// the same sheet shown turned (/Rotate 90): the box is drawn on the page as shown
const turned = join(TMP, 'Steel turned.pdf');
{
  const d = mupdf.Document.openDocument(readFileSync(flat), 'application/pdf');
  d.findPage(0).put('Rotate', 90);
  writeFileSync(turned, d.saveToBuffer('').asUint8Array());
}
// the same sheet as a scan (a picture of the page, no text): read with OCR, just the box
const scan = join(TMP, 'Steel scan.pdf');
{
  const src = mupdf.Document.openDocument(readFileSync(flat), 'application/pdf');
  const pg = src.loadPage(0);
  const pix = pg.toPixmap(mupdf.Matrix.scale(200 / 72, 200 / 72), mupdf.ColorSpace.DeviceGray, false, false);
  const d = new mupdf.PDFDocument();
  const b = pg.getBounds();
  const img = d.addImage(new mupdf.Image(pix));
  d.insertPage(-1, d.addPage([0, 0, b[2] - b[0], b[3] - b[1]], 0, { XObject: { I: img } }, `q ${b[2] - b[0]} 0 0 ${b[3] - b[1]} 0 0 cm /I Do Q`));
  writeFileSync(scan, d.saveToBuffer('compress').asUint8Array());
}
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-area'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };
const readXlsx = (f) => JSON.parse(execFileSync('python3', ['-c', `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1])
print(json.dumps([[c.value for c in r] for r in wb.worksheets[0].iter_rows()]))`, f]).toString());

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=area', flat, turned, scan] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await app.evaluate(({ dialog, shell }) => {
  globalThis.__save = [];
  dialog.showSaveDialog = async () => { const f = globalThis.__save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
  shell.openPath = async () => '';
});
const E = (fn, a) => win.evaluate(fn, a);
const at = async (n, x, y) => {
  const box = await win.locator(`.pg[data-page="${n}"]`).boundingBox();
  const w = await E((n) => window.__gcc.active().pages[n].w, n);
  const k = box.width / w;
  return [box.x + x * k, box.y + y * k];
};
const drag = async (n, a, b) => {
  const p = await at(n, ...a), q = await at(n, ...b);
  await win.mouse.move(p[0], p[1]);
  await win.mouse.down();
  await win.mouse.move(q[0], q[1], { steps: 8 });
  await win.mouse.up();
};
const dlg = () => win.locator('.modal', { hasText: 'Table from page' });
const fitPage = async () => { await win.locator('.rtab', { hasText: 'Home' }).click(); await win.locator('.ribbon .rb', { hasText: /^Fit page$/ }).click(); await sleep(800); };
const saveArea = async (out) => {
  await until(() => dlg().count(), 60000, 'table dialog');
  await app.evaluate((_e, f) => { globalThis.__save.push(f); }, out);
  await dlg().locator('.btn.primary').click();
  await until(async () => existsSync(out) && !(await dlg().count()), 60000, "saved");
  await sleep(300);
  return readXlsx(out);
};
const row240 = (rows) => rows.find((r) => r[0] && /240 AA/.test(String(r[0])));
const WANT = [47.4, 224, 240, 6.5, 9, 21, 60.4, 206, 164, 'M 27', 104, 138, 1.359, 28.67];

try {
  await until(() => E(() => window.__gcc?.docs().length === 3), 30000, 'three files');
  await win.locator('.dtab', { hasText: 'Steel tables' }).click();
  await sleep(600);
  // 1. found from Export to Excel: the hint there starts the tool
  await win.locator('.rtab.file').click();
  await win.locator('.filepane button', { hasText: 'Export to Excel' }).click();
  await until(() => win.locator('.modal h2', { hasText: 'Export to Excel' }).count(), 5000, 'export dialog');
  await win.locator('.modal button.link', { hasText: 'Drag a box around it' }).click();
  await sleep(300);
  ok(!(await win.locator('.modal').count()), 'the hint in Export to Excel closes it…');
  ok(/Drag a box around a table/.test(await win.locator('.statusbar').textContent()), '…and the Table to Excel tool is on');
  ok(await win.locator('.toast', { hasText: 'only what is inside it goes to Excel' }).count() > 0, 'with a word on what to do');

  // 2. the box: only the table in it, numbers as numbers
  await fitPage();
  await drag(0, [40, 250], [590, 520]);
  ok(/Table from page 1/.test(await until(() => dlg().locator('h2').textContent(), 60000, 'dialog')), 'dialog: Table from page 1 (copied for pasting too)');
  const rows = await saveArea(join(TMP, 'flat.xlsx'));
  const r = row240(rows);
  ok(r && JSON.stringify(r.slice(1, 15)) === JSON.stringify(WANT), 'HE 240 AA row read as on the sheet: ' + JSON.stringify(r));
  ok(rows.length >= 14 && rows.length <= 18, `just the table: ${rows.length} rows`);
  ok(!JSON.stringify(rows).includes('HL 920'), 'nothing from outside the box (the HL 920-1100 table beside it)');
  ok(await win.locator('.toast', { hasText: /Saved flat\.xlsx/ }).count() > 0, 'toast: Saved flat.xlsx');

  // 3. the same sheet shown turned: the box drawn on it as shown
  await win.locator('.dtab', { hasText: 'Steel turned' }).click();
  await sleep(800);
  await fitPage();
  const w0 = await E(() => window.__gcc.active().pages[0].w);
  ok(w0 > 800, 'turned page shown landscape (' + Math.round(w0) + ' wide)');
  await win.locator('.rtab', { hasText: 'OCR' }).click();
  await win.locator('.ribbon .rb', { hasText: /^Table to Excel$/ }).click();
  await drag(0, [322, 40], [592, 590]);
  const rows2 = await saveArea(join(TMP, 'turned.xlsx'));
  const r2 = row240(rows2);
  ok(r2 && JSON.stringify(r2.slice(1, 15)) === JSON.stringify(WANT), 'turned page: same row: ' + JSON.stringify(r2));
  ok(!JSON.stringify(rows2).includes('HL 920'), 'turned page: nothing from outside the box');

  // 4. a scan: the box is read with OCR (just the box), then exported
  await win.locator('.dtab', { hasText: 'Steel scan' }).click();
  await sleep(800);
  await fitPage();
  await win.locator('.rtab', { hasText: 'OCR' }).click();
  await win.locator('.ribbon .rb', { hasText: /^Table to Excel$/ }).click();
  await drag(0, [40, 250], [590, 520]);
  const rows3 = await saveArea(join(TMP, 'scan.xlsx'));
  const nums = rows3.flat().filter((v) => typeof v === 'number').length;
  ok(nums >= 60, `scan: read with OCR, ${nums} numbers as numbers in ${rows3.length} rows`);
  // (a 200 dpi picture of small print: OCR loses some decimal commas - the whole figures come through)
  ok(rows3.some((r) => r.includes(206) && r.includes(164) && r.includes(138)), 'scan: the 240 rows\' detailing figures (206, 164, 138) as numbers');
  ok(await win.locator('.toast', { hasText: 'read with OCR' }).count() > 0, 'scan: the toast says it was read with OCR');
} catch (e) { ok(false, e.message); await win.screenshot({ path: join(TMP, 'fail.png') }).catch(() => {}); }
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
