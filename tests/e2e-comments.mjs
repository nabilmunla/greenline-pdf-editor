// Comments list to a PDF summary (a picture of each markup, comment, replies, author, date, status)
// and to Excel - the list as filtered.   xvfb-run -a node tests/e2e-comments.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-comments');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const file = join(TMP, 'Drawing.pdf');
{
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < 2; i++) d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, { Font: { F1: f } }, `0 0 0 RG 2 w 100 100 600 400 re S BT /F1 20 Tf 120 300 Td (DETAIL ${i + 1}) Tj ET`));
  writeFileSync(file, d.saveToBuffer('').asUint8Array());
}
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-comments'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=comments', file] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await app.evaluate(({ dialog, shell }) => {
  globalThis.__save = [];
  dialog.showSaveDialog = async () => { const f = globalThis.__save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
  shell.openPath = async () => '';
});
const E = (fn, a) => win.evaluate(fn, a);

try {
  await until(() => E(() => window.__gcc?.active()?.pages.length === 2), 30000, 'file');
  await E(async () => {
    const d = window.__gcc.active();
    const a = await d.create(0, { type: 'Square', rect: [150, 150, 300, 250], color: [1, 0, 0], contents: 'Clarify the beam depth here', author: 'N. M.' });
    await d.create(0, { type: 'Text', irt: a.id, contents: 'Consultant: 600 mm, see S-201', author: 'Consultant' });
    await d.create(1, { type: 'Circle', rect: [400, 200, 500, 300], color: [0, 0, 1], contents: 'تأكيد المواصفات', author: 'QS' });
    await d.create(1, { type: 'FreeText', rect: [120, 420, 360, 460], contents: 'Door schedule missing', author: 'N. M.' });
  });
  await win.locator('.rail-btn[title="Comments list"]').click();
  await until(() => win.locator('.cm-foot button', { hasText: 'PDF' }).count(), 5000, 'panel');
  const out = join(TMP, 'Drawing comments.pdf');
  await app.evaluate((_e, f) => { globalThis.__save.push(f); }, out);
  await win.locator('.cm-foot button', { hasText: 'PDF' }).click();
  await until(() => existsSync(out), 60000, 'summary');
  await sleep(300);
  const d = mupdf.Document.openDocument(readFileSync(out), 'application/pdf');
  const b = d.loadPage(0).getBounds();
  ok(b[2] > b[3], 'landscape A4 (' + b.map(Math.round).join(',') + ')');
  const text = [...Array(d.countPages()).keys()].map((i) => d.loadPage(i).toStructuredText().asText()).join('\n');
  ok(/Drawing\.pdf – comments/.test(text) && /3 markups/.test(text), 'title and count (replies under their markup, not counted)');
  ok(/Clarify the beam depth here/.test(text) && /Consultant: 600 mm, see S-201/.test(text) && /Door schedule missing/.test(text), 'comments and the reply in it');
  ok(/تأكيد المواصفات|تأكيد/.test(text) || /المواصفات/.test(text), 'Arabic comment kept');
  let pics = 0;
  for (let i = 0; i < d.countPages(); i++) d.loadPage(i).toStructuredText('preserve-images').walk({ onImageBlock() { pics++; } });
  ok(pics === 3, 'a picture of each markup: ' + pics);
  ok(await win.locator('.toast', { hasText: 'Saved Drawing comments.pdf' }).count() > 0, 'toast: saved');
  // filtered: only what the list shows
  await win.locator('.cm-tools input.input').first().fill('door');
  const out2 = join(TMP, 'filtered.pdf');
  await app.evaluate((_e, f) => { globalThis.__save.push(f); }, out2);
  await win.locator('.cm-foot button', { hasText: 'PDF' }).click();
  await until(() => existsSync(out2), 60000, 'filtered summary');
  await sleep(300);
  const t2 = mupdf.Document.openDocument(readFileSync(out2), 'application/pdf').loadPage(0).toStructuredText().asText();
  ok(/1 markup \(as filtered in the list\)/.test(t2) && !/beam depth/.test(t2), 'as filtered: 1 markup');
  // Excel still there
  const x = join(TMP, 'log.xlsx');
  await app.evaluate((_e, f) => { globalThis.__save.push(f); }, x);
  await win.locator('.cm-foot button', { hasText: 'Excel' }).click();
  await until(() => existsSync(x), 20000, 'xlsx');
  const rows = JSON.parse(execFileSync('python3', ['-c', `import openpyxl,json,sys; ws=openpyxl.load_workbook(sys.argv[1]).worksheets[0]; print(json.dumps([[c.value for c in r] for r in ws.iter_rows()]))`, x]).toString());
  ok(rows.length === 2 && rows[1][2] === 'Door schedule missing', 'Excel: the filtered list');
} catch (e) { ok(false, e.message); await win.screenshot({ path: join(TMP, 'fail.png') }).catch(() => {}); }
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
