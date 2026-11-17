// Both Excel exports (Comments list, Measure > To Excel) on three files: long-spec (1,500 pages),
// scan.pdf (no text) and a one-page file. Each sheet starts with Page (label or number) and
// PDF page (the physical page); no measurements -> the plain message and no file.
// xvfb-run -a node tests/e2e-excel-page.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-excel-page');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const one = join(TMP, 'one-page.pdf');
{
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, { Font: { F1: f } }, 'BT /F1 20 Tf 120 300 Td (ONE PAGE) Tj ET'));
  writeFileSync(one, d.saveToBuffer('').asUint8Array());
}
const FILES = [['long', copy('tests/data/long-spec.pdf', 'long-spec.pdf')], ['scan', copy('tests/data/scan.pdf', 'scan.pdf')], ['one', one]];
function copy(from, name) { const to = join(TMP, name); copyFileSync(from, to); return to; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 20000, what = '') => { const t = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };
const xlsxRows = (f) => JSON.parse(execFileSync('python3', ['-c', `import openpyxl, json, sys
ws = openpyxl.load_workbook(sys.argv[1]).worksheets[0]
print(json.dumps([[c.value for c in r] for r in ws.iter_rows()]))`, f]).toString());
// the Page cell: the label when the file has one, else the number (measurexl.ts pageCell)
const pageWant = (label, P) => (label && label.trim() && label !== String(P + 1) ? label : P + 1);

// one run per file: a fresh app (its own profile) on that file
async function run(name, file) {
  rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-excel-' + name), { recursive: true, force: true });
  const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=excel-' + name, file] });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log(name, 'PAGEERROR', e.message); fails++; });
  await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
  await app.evaluate(({ dialog }) => {
    globalThis.__save = [];
    dialog.showSaveDialog = async () => { const f = globalThis.__save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
  });
  const E = (fn, a) => win.evaluate(fn, a);
  const save = (f) => app.evaluate((_e, p) => { globalThis.__save.push(p); }, f);
  try {
    const n = await until(() => E(() => window.__gcc?.active()?.pages.length || 0), 90000, 'pages');
    const P = Math.min(n - 1, 1200);
    const lbl = await E((p) => window.__gcc.active().pages[p].label, P);
    // no measurements yet: the plain message, no file
    const none = join(TMP, name + '-none.xlsx');
    await win.locator('.rtab', { hasText: /^Measure$/ }).click();
    await win.locator('.ribbon .rb', { hasText: 'To Excel' }).click();
    await until(() => win.locator('.toast', { hasText: 'No measurements in this file yet.' }).count(), 10000, 'message');
    ok(!existsSync(none), name + ': no measurements -> the message and no file');
    // three markups on physical page P+1: a comment, a length, a count
    await E((p) => {
      const d = window.__gcc.active();
      const { w, h } = d.pages[p];
      return (async () => {
        await d.create(p, { type: 'Square', rect: [w * 0.2, h * 0.2, w * 0.4, h * 0.35], color: [1, 0, 0], contents: 'Check the beam depth', author: 'N. M.' });
        await d.create(p, { type: 'Line', line: [[w * 0.1, h * 0.8], [w * 0.5, h * 0.8]], kind: 'measure-length', contents: '2.50 m', color: [0, 0, 1], author: 'QS' });
        await d.create(p, { type: 'Circle', rect: [w * 0.6, h * 0.6, w * 0.62, h * 0.63], kind: 'measure-count', group: 'Doors', color: [0, 0, 1], author: 'QS' });
      })();
    }, P);
    // Comments list to Excel
    const cx = join(TMP, name + '-comments.xlsx');
    await win.locator('.rail-btn[title="Comments list"]').click();
    await until(() => win.locator('.cm-foot button', { hasText: 'Excel' }).count(), 10000, 'comments panel');
    await save(cx);
    await win.locator('.cm-foot button', { hasText: 'Excel' }).click();
    await until(() => existsSync(cx), 30000, 'comments xlsx');
    const crows = xlsxRows(cx);
    const cbody = crows.slice(1);
    ok(JSON.stringify(crows[0].slice(0, 2)) === '["Page","PDF page"]', name + ': comments header starts Page, PDF page');
    ok(cbody.length === 3 && cbody.every((r) => r[1] === P + 1), name + ': comments: every row PDF page = ' + (P + 1) + ' (' + cbody.map((r) => r[1]).join(',') + ')');
    ok(cbody.every((r) => r[0] === pageWant(lbl, P)), name + ': comments: Page = ' + JSON.stringify(pageWant(lbl, P)) + ' (' + cbody.map((r) => JSON.stringify(r[0])).join(',') + ')');
    // Measurements to Excel
    const mx = join(TMP, name + '-measure.xlsx');
    await win.locator('.rtab', { hasText: /^Measure$/ }).click();
    await save(mx);
    await win.locator('.ribbon .rb', { hasText: 'To Excel' }).click();
    await until(() => existsSync(mx), 30000, 'measure xlsx');
    const mrows = xlsxRows(mx);
    const mbody = mrows.slice(1);
    ok(JSON.stringify(mrows[0].slice(0, 2)) === '["Page","PDF page"]', name + ': measurements header starts Page, PDF page');
    ok(mbody.length === 2 && mbody.every((r) => r[1] === P + 1), name + ': measurements: every row PDF page = ' + (P + 1) + ' (' + mbody.map((r) => r[1]).join(',') + ')');
    ok(mbody.every((r) => r[0] === pageWant(lbl, P)), name + ': measurements: Page = ' + JSON.stringify(pageWant(lbl, P)));
    ok(mbody.some((r) => r[3] === 2.5 && r[4] === 'm'), name + ': measurements: the length kept as a number and unit');
  } catch (e) {
    ok(false, name + ': ' + e.message);
    await win.screenshot({ path: join(TMP, name + '-fail.png') }).catch(() => {});
  }
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
}

const killer = setTimeout(() => { console.log('FAIL overall time limit'); process.exit(1); }, 600000);
for (const [name, file] of FILES) await run(name, file);
clearTimeout(killer);
console.log(fails ? `${fails} failed, ${passes} passed` : `all passed (${passes})`);
process.exit(fails ? 1 : 0);
