// Print panel: opens with Ctrl+P, preview follows the settings, "Save as PDF" makes the sheets,
// and the file it makes prints in a hidden window (checked with printToPDF - no printer here).
// A big print (PLAN 10.12; the limit lowered by the test switch): all of a generated 300-page set
// with markups, one added and one layer turned off in the window, is made by the batch engine -
// its pid in the log - with the markups and without that layer; the editing engine's memory stays
// as it was and no copy of the file is left in the temp folder.
// xvfb-run -a node tests/e2e-print.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync, readdirSync, openSync, writeSync, closeSync, statSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
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

// ---- a big print (PLAN 10.12)
/** `pages` A3 sheets, each with some line work and a picture of its own (~400 KB, already
 *  compressed: a copy of the pages is as big as the file), two layers (words LAYERONEWORD,
 *  LAYERTWOWORD), a markup set to print on each (MARKUPWORD, with its appearance). Written as
 *  text, without MuPDF. Invented content. */
function printSet(file, pages) {
  const fd = openSync(file, 'w');
  let pos = 0;
  const offs = [];
  const put = (t) => { const b = Buffer.from(t, 'latin1'); writeSync(fd, b); pos += b.length; };
  const obj = (n, body) => { offs[n] = pos; put(`${n} 0 obj\n${body}\nendobj\n`); };
  const stream = (n, dict, data) => { offs[n] = pos; put(`${n} 0 obj\n<<${dict} /Length ${data.length}>>\nstream\n`); const b = typeof data === 'string' ? Buffer.from(data, 'latin1') : data; writeSync(fd, b); pos += b.length; put('\nendstream\nendobj\n'); };
  let lines = '0.2 w 0 0 0 RG\n';
  for (let i = 0; i < 400; i++) { const x = 40 + (i * 37) % 1100, y = 40 + (i * 53) % 760; lines += `${x} ${y} m ${x + 30} ${y + 7} l S\n`; }
  const PW = 512, PH = 256, pic = deflateSync(randomBytes(PW * PH * 3), { level: 1 });
  // 1 catalog, 2 pages, 3 font, 4 layer one, 5 layer two, 6 markup appearance; per page: page, content, markup, picture
  const per = 4, pageNo = (i) => 7 + i * per;
  try {
    put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [4 0 R 5 0 R] /D << /Order [4 0 R 5 0 R] >> >> >>');
    obj(2, `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${pageNo(i)} 0 R`).join(' ')}] >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    obj(4, '<< /Type /OCG /Name (Layer one) >>');
    obj(5, '<< /Type /OCG /Name (Layer two) >>');
    stream(6, ' /Type /XObject /Subtype /Form /BBox [0 0 300 40] /Resources << /Font << /F1 3 0 R >> >>', '1 0 0 rg BT /F1 20 Tf 5 12 Td (MARKUPWORD) Tj ET');
    for (let i = 0; i < pages; i++) {
      const p = pageNo(i);
      obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1191 842] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 ${p + 3} 0 R >> /Properties << /L1 4 0 R /L2 5 0 R >> >> /Contents ${p + 1} 0 R /Annots [${p + 2} 0 R] >>`);
      stream(p + 1, '', `q 512 0 0 256 600 60 cm /Im0 Do Q BT /F1 30 Tf 80 780 Td (SHEET ${i + 1}) Tj ET /OC /L1 BDC BT /F1 24 Tf 80 720 Td (LAYERONEWORD) Tj ET EMC /OC /L2 BDC BT /F1 24 Tf 80 680 Td (LAYERTWOWORD) Tj ET EMC\n` + lines);
      stream(p + 3, ` /Type /XObject /Subtype /Image /Width ${PW} /Height ${PH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, pic);
      obj(p + 2, `<< /Type /Annot /Subtype /Square /Rect [700 700 1000 740] /F 4 /C [1 0 0] /Contents (note ${i + 1}) /AP << /N 6 0 R >> >>`);
    }
    const n = 7 + pages * per, xref = pos;
    put(`xref\n0 ${n}\n0000000000 65535 f \n`);
    for (let k = 1; k < n; k++) put(String(offs[k]).padStart(10, '0') + ' 00000 n \n');
    put(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  } finally { closeSync(fd); }
  return pos;
}
const BIG = join(TMP, 'big-set.pdf');
const bigSize = printSet(BIG, 300);
console.log(`generated ${BIG}: 300 sheets, ${(bigSize / 1e6).toFixed(0)} MB`);
const E = (fn, a) => win.evaluate(fn, a);
const until = async (fn, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(250); } return null; };
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), BIG);
ok(!!(await until(() => E(() => window.__gcc.active()?.pages.length === 300 && window.__gcc.active().name === 'big-set.pdf'), 120000)), 'the 300-page set is open');
await sleep(2000);
// one markup added in the window (not saved), one layer turned off in the window
await E(() => window.__gcc.active().create(150, { type: 'FreeText', rect: [200, 300, 800, 380], contents: 'ADDED IN THE WINDOW', color: [1, 1, 0.8], bw: 2, font: { size: 30, color: [0, 0, 1] }, kind: 'textbox' }));
const two = await E(() => window.__gcc.active().layers().then((l) => l.find((x) => x.name === 'Layer two')?.num));
ok(two > 0 && (await E((n) => window.__gcc.active().setLayers({ [n]: false }), two)), 'layer two turned off in the window');
await sleep(2000);
// the limit lowered: a print of more than 20 MB of the file goes to the batch engine
await E(() => localStorage.setItem('pdfed-print-big', String(20e6)));
const WORK = join(tmpdir(), 'PDF Editor', 'work');
const copies = () => { try { return readdirSync(WORK).flatMap((d) => { try { return readdirSync(join(WORK, d)).filter((f) => /^(changes\.bin|snapshot\.pdf)$/.test(f)).map((f) => join(d, f)); } catch { return []; } }); } catch { return []; } };
const copiesBefore = copies();
// (the editing engine's memory now: every answer carries it)
const heapNow = () => E(() => window.__gcc.engines.mu('layerStateSet', window.__gcc.active().id).then(() => window.__gcc.engines.editor.heap));
const heap0 = await heapNow();
const logFile = join(await app.evaluate(({ app: a }) => a.getPath('userData')), 'logs', 'app.log');
const logBefore = existsSync(logFile) ? statSync(logFile).size : 0;
await win.keyboard.press('Control+p');
await win.waitForSelector('.printdlg', { timeout: 10000 }).catch(() => {});
await sleep(1500);
await win.locator('.printdlg .seg button', { hasText: 'As they are' }).click();
const bigOut = join(TMP, 'big-printed.pdf');
await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, bigOut);
const t0 = Date.now();
await win.locator('.printdlg button', { hasText: 'Save as PDF' }).click();
const made = await until(async () => existsSync(bigOut) && (await E(() => !document.querySelector('.printdlg'))), 300000);
ok(!!made, `all 300 sheets saved as PDF (${Math.round((Date.now() - t0) / 1000)} s)`);
await sleep(1000);
const heap1 = await heapNow();
console.log(`  editing engine: ${Math.round(heap0 / 2 ** 20)} MB before, ${Math.round(heap1 / 2 ** 20)} MB after`);
ok(heap0 > 0 && heap1 - heap0 <= 20 * 2 ** 20, `the editing engine's memory within 20 MB of before (${Math.round((heap1 - heap0) / 2 ** 20)} MB more)`);
const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(logBefore) : '';
const line = /\[batch\] print: 300 sheets made in the batch engine \(pid (\d+)\)[^\n]*/.exec(log);
const kind = line ? await app.evaluate((_e, pid) => globalThis.__pdfedEngines?.[pid], Number(line[1])) : null;
ok(!!line && kind === 'batch engine', `the print file was made by the batch engine: ${line ? line[0] : 'no line in the log'} (${kind})`);
const left = copies().filter((c) => !copiesBefore.includes(c));
ok(left.length === 0, `no copy of the file left in the temp folder (${left.join(', ') || 'none'})`);
if (existsSync(bigOut)) {
  const d = mupdf.Document.openDocument(readFileSync(bigOut), 'application/pdf');
  ok(d.countPages() === 300, 'every sheet in it: ' + d.countPages());
  const t = (i) => d.loadPage(i).toStructuredText('').asText();
  const probe = [0, 150, 299].map(t);
  ok(probe.every((x) => x.includes('MARKUPWORD')), 'the markups printed');
  ok(probe[1].includes('ADDED IN THE WINDOW'), 'the markup added in the window (not saved) printed');
  ok(probe.every((x) => x.includes('LAYERONEWORD') && !x.includes('LAYERTWOWORD')), 'layer one printed, layer two (off in the window) not');
  ok(probe[2].includes('SHEET 300'), 'the last sheet is the last page');
}
// ---- Cancel during a big print (PLAN 10.23 (1)): the dialog comes back, one "stopped" note, nothing
// left behind, and the next print of the same pages goes through
const allFiles = () => { const out = []; const walk = (d) => { try { for (const f of readdirSync(d, { withFileTypes: true })) { const q = join(d, f.name); if (f.isDirectory()) walk(q); else out.push(q); } } catch { /* no work folder */ } }; walk(WORK); return out; };
const filesBeforeCancel = allFiles();
await E(() => {
  window.__stoppedNotes = 0;
  // (each time the note comes up on the screen counts once)
  let up = false;
  new MutationObserver(() => { const has = document.body.innerText.includes('Saving the PDF was stopped.'); if (has && !up) window.__stoppedNotes++; up = has; }).observe(document.body, { childList: true, subtree: true, characterData: true });
});
await win.keyboard.press('Control+p');
await win.waitForSelector('.printdlg', { timeout: 10000 }).catch(() => {});
await sleep(1500);
await win.locator('.printdlg .seg button', { hasText: 'As they are' }).click();
const cancelOut = join(TMP, 'cancelled-printed.pdf');
await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, cancelOut);
await win.locator('.printdlg button', { hasText: 'Save as PDF' }).click();
// (the big print takes about a second: Cancel is pressed from inside the page the moment the note shows)
const cancelAt = await E(async () => {
  const t = Date.now();
  while (Date.now() - t < 60000) {
    if (/Making 300 sheets for a big print/.test(document.querySelector('.printdlg')?.textContent || '')) {
      const b = [...document.querySelectorAll('.printdlg .btn')].find((x) => x.textContent.trim() === 'Cancel');
      if (b && !b.disabled) { b.click(); return Date.now(); }
    }
    if (!document.querySelector('.printdlg')) return null;
    await new Promise((r) => setTimeout(r, 2));
  }
  return null;
});
ok(!!cancelAt, 'Cancel pressed while "Making 300 sheets for a big print" shows');
const usableAt = await E(async () => {
  const t = Date.now();
  while (Date.now() - t < 5000) {
    const b = [...document.querySelectorAll('.printdlg .btn')].find((x) => x.textContent.includes('Save as PDF'));
    if (b && !b.disabled) return Date.now();
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
});
ok(!!usableAt && usableAt - cancelAt <= 3000, `the dialog is usable again within 3 s (${usableAt && cancelAt ? usableAt - cancelAt : 'never'} ms)`);
await sleep(1500);
ok(!existsSync(cancelOut), 'no file was saved by the cancelled print');
const notes = await E(() => window.__stoppedNotes);
ok(notes === 1, `"Saving the PDF was stopped." shown once (${notes} times)`);
const left0 = allFiles().filter((f) => !filesBeforeCancel.includes(f));
ok(left0.length === 0, `no print file or piece left in the work folder (${left0.map((f) => f.split(/[\\/]/).slice(-2).join('/')).join(', ') || 'none'})`);
// the next print of the same pages goes through
const again = join(TMP, 'after-cancel-printed.pdf');
await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, again);
await win.locator('.printdlg button', { hasText: 'Save as PDF' }).click();
const madeAgain = await until(async () => existsSync(again) && (await E(() => !document.querySelector('.printdlg'))), 300000);
ok(!!madeAgain, 'the next print of the same pages is made');
if (existsSync(again)) ok(mupdf.Document.openDocument(readFileSync(again), 'application/pdf').countPages() === 300, 'and it has all 300 sheets');

await E(() => localStorage.removeItem('pdfed-print-big'));

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
