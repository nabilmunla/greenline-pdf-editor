// Print panel: opens with Ctrl+P, preview follows the settings, "Save as PDF" makes the sheets,
// and the file it makes prints in a hidden window (checked with printToPDF - no printer here).
// xvfb-run -a node tests/e2e-print.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-print');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'ga.pdf');
copyFileSync(existsSync('tests/real/ga-l01.pdf') ? 'tests/real/ga-l01.pdf' : 'tests/data/heavy-a0.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-print'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=print', F] });
const win = await app.firstWindow();
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) { fails++; void win.screenshot({ path: join(TMP, `fail-${fails}.png`) }).catch(() => {}); } return c; };
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await win.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
await win.waitForFunction(() => window.__gcc?.active()?.pages.length > 0, null, { timeout: 60000 });
await sleep(1000);
await win.evaluate(() => window.__gcc.active().create(0, { type: 'FreeText', rect: [200, 200, 700, 300], contents: 'PRINT ME TOO', color: [1, 1, 0.8], bw: 2, font: { size: 40, color: [1, 0, 0] }, kind: 'textbox' }));
await sleep(500);

await win.keyboard.press('Control+p');
await win.waitForSelector('.printdlg', { timeout: 5000 }).catch(() => {});
ok(await win.locator('.printdlg').count() === 1, 'Ctrl+P opens the print panel');
await sleep(1500);
const painted = () => win.evaluate(() => { const c = document.querySelector('.pd-sheet'); if (!c || !c.width) return 0; const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 16) if (d[i] < 200) n++; return n; });
ok((await painted()) > 50, 'the preview shows the sheet with the drawing');
await win.screenshot({ path: join(TMP, 'panel.png') });
const info = () => win.locator('.pd-info').textContent();
const i1 = await info();
ok(/A4 landscape at \d+ %/.test(i1), 'preview says what goes on what: ' + i1);
await win.locator('.printdlg select.input').nth(2).selectOption('A3').catch(async () => {
  // (the paper select is the one with A3 in it)
  for (const s of await win.locator('.printdlg select').all()) if ((await s.innerHTML()).includes('>A3<')) { await s.selectOption('A3'); break; }
});
await sleep(800);
ok(/on A3 landscape/.test(await info()), 'A3 chosen: ' + (await info()));
await win.locator('.printdlg .seg button', { hasText: 'Actual size' }).click();
await sleep(600);
ok(/at 100 %/.test(await info()), 'actual size: ' + (await info()));
await win.locator('.printdlg .seg button', { hasText: 'Fit' }).first().click();
await win.locator('.printdlg .seg button', { hasText: 'Portrait' }).click();
await sleep(600);
ok(/on A3 at/.test(await info()) && !/landscape/.test(await info()), 'portrait: ' + (await info()));
await win.locator('.printdlg .seg button', { hasText: 'Auto' }).first().click();
// (the drawing exactly as it is for the checks below: its text and the markup's)
await win.locator('.printdlg .seg button', { hasText: 'As they are' }).click();

// Save as PDF: the sheets as a file
const out = join(TMP, 'printed.pdf');
await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, out);
await win.locator('.printdlg button', { hasText: 'Save as PDF' }).click();
for (let i = 0; i < 100 && !existsSync(out); i++) await sleep(100);
await sleep(500);
ok(existsSync(out), 'Save as PDF wrote the file');
if (existsSync(out)) {
  const d = mupdf.Document.openDocument(readFileSync(out), 'application/pdf');
  const b = d.loadPage(0).getBounds();
  ok(Math.abs(b[2] - 1190.55) < 1 && Math.abs(b[3] - 841.89) < 1, 'A3 landscape sheet: ' + b.map(Math.round));
  ok(d.loadPage(0).toStructuredText('').asText().includes('PRINT ME TOO'), 'markup printed');
  // the same file printed in a hidden window (as the Print button does) is not blank
  const pdf = await app.evaluate(async ({ BrowserWindow }, f) => {
    const w = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { plugins: true, sandbox: true } });
    await w.loadURL('file://' + f);
    await new Promise((r) => setTimeout(r, 1500));
    const b = await w.webContents.printToPDF({ landscape: true, pageSize: 'A3', margins: { marginType: 'none' } });
    w.destroy();
    return Array.from(b);
  }, out).catch((e) => { console.log('printToPDF', e.message); return null; });
  if (pdf) {
    const d2 = mupdf.Document.openDocument(new Uint8Array(pdf), 'application/pdf');
    ok(d2.countPages() === d.countPages() && d2.loadPage(0).toStructuredText('').asText().includes('PRINT ME TOO'), `hidden window prints the PDF itself (${d2.countPages()} pages, not the viewer / blank)`);
  } else ok(false, 'hidden window print');
}

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
