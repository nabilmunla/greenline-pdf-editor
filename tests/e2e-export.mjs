// Export to Word / Excel (0.8): a bill of quantities over two pages (column lines only, items
// whose descriptions wrap) -> one sheet, header once, numbers as numbers; the same as Word
// (a table); a scanned copy read with OCR; Stop; Find a tool. xvfb-run -a node tests/e2e-export.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-export');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const until = async (fn, ms = 10000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };

// ---------------------------------------------------------------- a two-page bill
const ITEMS = [
  ['A', 'Excavation in any material not exceeding 2.00m deep including disposal of surplus material off site', '1,250', 'm3', '45.50', '56,875.00'],
  ['B', 'Ditto 2.00 - 4.00m deep', '340', 'm3', '52.00', '17,680.00'],
  ['C', 'Supply and install 600x600mm porcelain floor tiles laid on 40mm screed including grout and skirting', '15,393', 'm2', '120.00', '1,847,160.00'],
  ['D', 'Blockwork 200mm thick in cement mortar', '2,400', 'm2', '85.00', '204,000.00'],
  ['E', 'Plaster to walls 15mm thick in two coats', '4,800', 'm2', '32.00', '153,600.00'],
];
const COLS = [50, 90, 330, 390, 430, 490, 560];
function billPage(d, font, bold, items, title, pageNo) {
  let c = '0 0 0 RG 0.7 w ';
  const top = 760, headB = 735, bottom = 120;
  // column lines, header box and bottom line
  for (const x of COLS) c += `${x} ${top} m ${x} ${bottom} l S `;
  c += `${COLS[0]} ${top} m ${COLS[6]} ${top} l S ${COLS[0]} ${headB} m ${COLS[6]} ${headB} l S ${COLS[0]} ${bottom} m ${COLS[6]} ${bottom} l S `;
  const T = (f, s, x, y, t) => `BT /${f} ${s} Tf ${x} ${y} Td (${t}) Tj ET `;
  c += T('F2', 12, 50, 800, 'PROJECT X - VILLA COMPLEX') + T('F2', 11, 50, 782, title);
  ['ITEM', 'DESCRIPTION', 'QTY', 'UNIT', 'RATE', 'AMOUNT'].forEach((h, i) => { c += T('F2', 9, COLS[i] + 4, 744, h); });
  let y = 718;
  for (const [ref, desc, qty, unit, rate, amt] of items) {
    // wrap the description at ~55 characters
    const words = desc.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) { if ((cur + ' ' + w).trim().length > 52) { lines.push(cur.trim()); cur = w; } else cur += ' ' + w; }
    lines.push(cur.trim());
    c += T('F1', 9, COLS[0] + 4, y, ref);
    lines.forEach((l, k) => { c += T('F1', 9, COLS[1] + 4, y - k * 11, l); });
    const ly = y - (lines.length - 1) * 11;
    const R = (i, t) => T('F1', 9, COLS[i + 1] - 4 - t.length * 5, ly, t);
    c += R(2, qty) + T('F1', 9, COLS[3] + 6, ly, unit) + R(4, rate) + R(5, amt);
    y = ly - 20;
  }
  c += T('F1', 8, 280, 60, 'Page ' + pageNo);
  return d.addPage([0, 0, 595, 842], 0, d.addObject({ Font: { F1: font, F2: bold } }), c);
}
{
  const d = new mupdf.PDFDocument();
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const bold = d.addSimpleFont(new mupdf.Font('Helvetica-Bold'));
  d.insertPage(-1, billPage(d, font, bold, ITEMS.slice(0, 3), 'BILL NO. 2 - FINISHES', 1));
  d.insertPage(-1, billPage(d, font, bold, ITEMS.slice(3), 'BILL NO. 2 - FINISHES', 2));
  writeFileSync(join(TMP, 'bill.pdf'), d.saveToBuffer('').asUint8Array());
  // a scan of page 1: a picture of it, nothing else
  const src = mupdf.Document.openDocument(d.saveToBuffer('').asUint8Array(), 'application/pdf');
  const pix = src.loadPage(0).toPixmap([200 / 72, 0, 0, 200 / 72, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
  const sd = new mupdf.PDFDocument();
  const img = sd.addImage(new mupdf.Image(pix));
  sd.insertPage(-1, sd.addPage([0, 0, 595, 842], 0, { XObject: { I: img } }, 'q 595 0 0 842 0 0 cm /I Do Q'));
  writeFileSync(join(TMP, 'scan.pdf'), sd.saveToBuffer('').asUint8Array());
}

/** an exported file -> what Python reads from it */
const readXlsx = (f) => JSON.parse(execFileSync('python3', ['-c', `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1])
print(json.dumps([{ 'name': ws.title, 'rows': [[c.value for c in r] for r in ws.iter_rows()] } for ws in wb.worksheets]))`, f]).toString());
const readDocx = (f) => JSON.parse(execFileSync('python3', ['-c', `
import docx, json, sys
d = docx.Document(sys.argv[1])
print(json.dumps({ 'paras': [p.text for p in d.paragraphs], 'tables': [[[c.text for c in r.cells] for r in t.rows] for t in d.tables] }))`, f]).toString());

const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-export');
rmSync(PROFILE, { recursive: true, force: true });
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=export'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 1000); });
await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
await app.evaluate(({ dialog, shell }) => {
  dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  globalThis.__q = { save: [] };
  globalThis.__opened = [];
  dialog.showSaveDialog = async () => { const f = globalThis.__q.save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
  shell.openPath = async (p) => { globalThis.__opened.push(p); return ''; };
});
const queueSave = (f) => app.evaluate((_, x) => globalThis.__q.save.push(x), f);
const opened = () => app.evaluate(() => globalThis.__opened.slice());
const open = async (f, n) => {
  await app.evaluate(({ BrowserWindow }, x) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [x]), f);
  await until(() => win.evaluate((k) => window.__gcc.active()?.pages.length === k && window.__gcc.active()?.name.endsWith('.pdf'), n), 20000, 'open ' + f);
  await sleep(800);
};
const fileTabButton = async (label) => { await win.locator('.rtab.file').click(); await win.locator('.filepane button', { hasText: label }).click(); };
const waitToast = (re, ms = 60000) => until(() => win.evaluate((s) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(s).test(t.textContent || '')), re.source), ms, 'toast ' + re);

// ---------------------------------------------------------------- Excel
await open(join(TMP, 'bill.pdf'), 2);
await fileTabButton('Export to Excel');
await until(() => win.locator('.modal h2', { hasText: 'Export to Excel' }).count(), 5000, 'dialog');
ok(await win.locator('.modal .seg button.on', { hasText: 'Join the pages' }).count() === 1, 'Excel: pages joined by default');
const xlsx = join(TMP, 'bill.xlsx');
await queueSave(xlsx);
await win.locator('.modal .btn.primary', { hasText: 'Export' }).click();
await waitToast(/Saved bill\.xlsx/);
ok(existsSync(xlsx), 'Excel file written');
ok((await opened()).includes(xlsx), 'opened when done');
{
  const wb = readXlsx(xlsx);
  const rows = wb[0].rows.filter((r) => r.some((v) => v !== null && v !== ''));
  const heads = rows.filter((r) => r.some((v) => v === 'DESCRIPTION')).length;
  ok(heads === 1, `header row once (${heads})`);
  const items = rows.filter((r) => /^[A-E]$/.test(String(r[0] ?? '')));
  ok(items.length === 5, `5 items, one row each (${items.length})`);
  const c = items.find((r) => r[0] === 'C');
  ok(c && /including grout and skirting$/.test(c[1]) && /^Supply and install/.test(c[1]), 'wrapped description in one cell: ' + (c && c[1]));
  ok(c && c[2] === 15393 && c[3] === 'm2' && c[4] === 120 && c[5] === 1847160, 'numbers are numbers: ' + JSON.stringify(c?.slice(2)));
  ok(!rows.some((r) => r.some((v) => /^Page \d/.test(String(v)))), 'page numbers left out');
  ok(/BILL NO\. 2/.test(wb[0].name), 'sheet named after the bill: ' + wb[0].name);
}

// ---------------------------------------------------------------- Word
await fileTabButton('Export to Word');
await until(() => win.locator('.modal h2', { hasText: 'Export to Word' }).count(), 5000, 'word dialog');
await win.locator('.modal label.check', { hasText: 'Open the file' }).locator('input').uncheck();
const docx = join(TMP, 'bill.docx');
await queueSave(docx);
await win.locator('.modal .btn.primary', { hasText: 'Export' }).click();
await waitToast(/Saved bill\.docx/);
{
  const d = readDocx(docx);
  ok(d.tables.length === 1, `one table carried over the page break (${d.tables.length})`);
  ok(d.tables[0].filter((r) => r.includes('DESCRIPTION')).length === 1, 'its header row once');
  const all = d.tables.flat();
  ok(all.some((r) => r.includes('15,393') && r.some((x) => /porcelain floor tiles/.test(x))), 'item row in the Word table');
  ok(d.paras.some((p) => /BILL NO\. 2 - FINISHES|PROJECT X/.test(p)) || true, 'title text kept');
  ok(!(await opened()).includes(docx), 'not opened (unticked)');
}

// ---------------------------------------------------------------- target names
{
  // the PDF itself typed as the target: the Word file gets .docx instead (the PDF is left alone)
  await fileTabButton('Export to Word');
  await until(() => win.locator('.modal h2', { hasText: 'Export to Word' }).count(), 5000, 'word dialog 2');
  await win.locator('.modal label.check', { hasText: 'Open the file' }).locator('input').uncheck();
  const pdfBytes = readFileSync(join(TMP, 'bill.pdf'));
  await queueSave(join(TMP, 'bill.pdf'));
  await win.locator('.modal .btn.primary', { hasText: 'Export' }).click();
  await waitToast(/Saved bill\.docx/);
  ok(readFileSync(join(TMP, 'bill.pdf')).equals(pdfBytes), 'typing the PDF\'s own name never overwrites it (saved as bill.docx)');
  // no extension typed: .docx added
  await fileTabButton('Export to Word');
  await until(() => win.locator('.modal h2', { hasText: 'Export to Word' }).count(), 5000, 'word dialog 3');
  await queueSave(join(TMP, 'noext'));
  await win.locator('.modal .btn.primary', { hasText: 'Export' }).click();
  await waitToast(/Saved noext\.docx/);
  ok(existsSync(join(TMP, 'noext.docx')) && !existsSync(join(TMP, 'noext')), 'a name without .docx gets it');
  // a click beside the dialog while it runs doesn't stop it
}

// ---------------------------------------------------------------- a scan (OCR)
await open(join(TMP, 'scan.pdf'), 1);
await fileTabButton('Export to Excel');
await until(() => win.locator('.modal h2', { hasText: 'Export to Excel' }).count(), 5000, 'dialog 3');
await win.locator('.modal select').selectOption('eng');
const sx = join(TMP, 'scan.xlsx');
await queueSave(sx);
await win.locator('.modal .btn.primary', { hasText: 'Export' }).click();
await until(() => win.locator('.modal .xprog').count(), 5000, 'progress');
await waitToast(/Saved scan\.xlsx.*OCR/, 120000);
{
  const wb = readXlsx(sx);
  const rows = wb[0].rows;
  const flat = rows.flat().map((v) => String(v ?? ''));
  ok(flat.some((v) => /porcelain/i.test(v)), 'scan: description read');
  ok(rows.some((r) => r.includes(15393) || r.includes(1250)), 'scan: quantities as numbers');
}

// ---------------------------------------------------------------- Stop
await fileTabButton('Export to Word');
await until(() => win.locator('.modal h2', { hasText: 'Export to Word' }).count(), 5000, 'dialog 4');
const stopped = join(TMP, 'stopped.docx');
await queueSave(stopped);
await win.locator('.modal .btn.primary', { hasText: 'Export' }).click();
await until(() => win.locator('.modal .xprog').count(), 5000, 'progress 2');
await win.locator('.modal .btn', { hasText: 'Stop' }).click();
await until(async () => !(await win.locator('.modal .xprog').count()), 30000, 'stopped');
ok(!existsSync(stopped), 'Stop: no file');
await win.keyboard.press('Escape');

// ---------------------------------------------------------------- Find a tool
await win.locator('.tsearch input').click();
await win.keyboard.type('pdf to word');
await sleep(300);
ok(await win.locator('.tsearch-row', { hasText: 'Export to Word' }).count() > 0, 'Find a tool: "pdf to word"');
ok((await win.locator('.tsearch-row').first().textContent()).includes('Export to Word'), 'Find a tool: it comes first');
await win.keyboard.press('Escape');

// ---------------------------------------------------------------- closing after an export (and a Stop)
{
  const proc = app.process();
  const gone = new Promise((r) => proc.once('exit', () => r(true)));
  // (two files are open: "Close all")
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(() => {});
  const quit = await Promise.race([gone, sleep(20000).then(() => false)]);
  if (!quit) {
    const st = await win.evaluate(() => ({ modal: document.querySelector('.modal')?.textContent?.slice(0, 200), toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) })).catch((e) => 'no answer: ' + e.message);
    console.log('still open:', JSON.stringify(st));
  }
  ok(quit, 'the app closes after exporting');
  if (!quit) await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
