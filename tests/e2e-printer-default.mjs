// The printer offered in the Print dialog (0.8.6): Windows' default printer at every start; one
// chosen while the app runs is offered again until the app closes - not kept for the next start
// (0.8.5 kept it in the settings: every start offered the printer used last). A printer saved by
// 0.8.5 is ignored. No printer here: the printers and the hand-over to Windows are stood in for.
// xvfb-run -a node tests/e2e-printer-default.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-printer-default');
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-printerdef');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; return c; };
{
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < 2; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, `BT /F1 20 Tf 60 700 Td (PAGE ${i + 1}) Tj ET`));
  writeFileSync(join(TMP, 'a.pdf'), d.saveToBuffer('').asUint8Array());
}
async function start() {
  const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=printerdef', join(TMP, 'a.pdf')] });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 2, null, { timeout: 60000 });
  await sleep(500);
  await app.evaluate(({ ipcMain, BrowserWindow }, main) => {
    ipcMain.removeHandler('print:run');
    ipcMain.handle('print:run', async (_e, file, o) => { globalThis.__printed = o; return { ok: true, reason: '' }; });
    // the printers as Electron 44 lists them (no "default" mark) and Windows' default printer as
    // the registry gives it - the app's own handler marks it
    for (const w of BrowserWindow.getAllWindows()) w.webContents.getPrintersAsync = async () => [
      { name: 'Fax', displayName: 'Fax', description: '', options: {} },
      { name: 'PLOTTER', displayName: 'Plotter A0', description: '', options: {} },
      { name: 'OFFICE', displayName: 'Office printer', description: '', options: {} },
    ];
    process.getBuiltinModule('node:module').createRequire(main)('./winprint.cjs').defaultPrinter = async () => 'office';
  }, resolve('electron/main.cjs'));
  return { app, win };
}
const offered = async (win) => {
  await win.keyboard.press('Control+p');
  await win.waitForSelector('.printdlg', { timeout: 5000 });
  await win.waitForFunction(() => { const s = document.querySelector('.printdlg select'); return s && !s.disabled && s.value; }, null, { timeout: 5000 });
  return win.evaluate(() => document.querySelector('.printdlg select').value);
};
const closeDlg = async (win) => { await win.locator('.printdlg .btn', { hasText: 'Cancel' }).click(); await win.waitForSelector('.printdlg', { state: 'detached', timeout: 5000 }); };

let { app, win } = await start();
ok(await offered(win) === 'OFFICE', 'first start: Windows\' default printer offered');
await win.locator('.printdlg select').first().selectOption('PLOTTER');
await win.locator('.printdlg .btn.primary').click();
await win.waitForSelector('.printdlg', { state: 'detached', timeout: 30000 });
ok((await app.evaluate(() => globalThis.__printed))?.deviceName === 'PLOTTER', 'printed on the plotter chosen');
ok(await offered(win) === 'PLOTTER', 'same run: the printer chosen last is offered again');
await closeDlg(win);
await sleep(500);
const saved = JSON.parse(readFileSync(join(PROFILE, 'settings.json'), 'utf8'));
ok(saved.print && !('printer' in saved.print), 'the printer is not kept in the settings: ' + JSON.stringify(saved.print));
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
await sleep(1000);

// as 0.8.5 left it: a printer kept in the settings
saved.print.printer = 'PLOTTER';
writeFileSync(join(PROFILE, 'settings.json'), JSON.stringify(saved));
({ app, win } = await start());
ok(await offered(win) === 'OFFICE', 'next start: Windows\' default printer again (a printer saved by 0.8.5 is ignored)');
await closeDlg(win);
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
