// Layers panel (PLAN 7.8), in the real app: the panel (a tick per layer, nested ones indented, a locked
// one with a lock), a click hides the layer on screen (pixel probe of the drawn page) in one redraw for
// clicks close together, with no undo step and the file not marked changed; Print preview, "Save as
// PDF" and "Save as pictures" (a PNG) follow what the screen shows; closing a tab with layers
// toggled asks nothing; "Save the layer state" is one undo step, undone and redone, and a reopened file
// has it; the R set (a 1,500-page spec, a scan, a mixed set): "This file has no layers.", no console
// error, no crash report.    xvfb-run -a node tests/e2e-layers.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as mupdf from 'mupdf';
import { layered } from './gen/layers.mjs';
import { ensure } from './rset.mjs';

const TMP = resolve('tests/tmp-layers');
rmSync(TMP, { recursive: true, force: true });
const INST = join(TMP, 'install'), SHARE = join(TMP, 'share'), OUT = join(TMP, 'out');
for (const d of [INST, SHARE, OUT]) mkdirSync(d, { recursive: true });
writeFileSync(join(INST, 'install.json'), JSON.stringify({ scope: 'user', version: '0.4.0' }));
writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: SHARE }));
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-layers');
rmSync(PROFILE, { recursive: true, force: true });
const F = join(TMP, 'plan.pdf'), G = join(TMP, 'other.pdf');
writeFileSync(F, layered());
copyFileSync(F, G);
const R = ensure();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(100); } };
const RDIR = join(SHARE, 'reports');
const reports = () => (existsSync(RDIR) ? readdirSync(RDIR).filter((n) => n.endsWith('.json')) : []);

const app = await electron.launch({
  executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=layers'],
  env: { ...process.env, PDFED_INSTALL_DIR: INST, PDFED_UPDATE_FIRST: '600000', PDFED_REPORT_FIRST: '500' },
});
const win = await app.firstWindow();
const consoleErrors = [];
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await app.evaluate(({ dialog, shell }) => {
  globalThis.__q = { save: [], open: [], box: [] };
  dialog.showSaveDialog = async () => { const f = globalThis.__q.save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
  dialog.showOpenDialog = async () => { const f = globalThis.__q.open.shift(); return f ? { canceled: false, filePaths: f } : { canceled: true, filePaths: [] }; };
  dialog.showMessageBox = async (_w, o) => { globalThis.__q.box.push((o || _w).message); return { response: 1, checkboxChecked: false }; };
  shell.openPath = async () => '';
  shell.showItemInFolder = () => {};
});
const q = (k, v) => app.evaluate((_e, [k, v]) => globalThis.__q[k].push(v), [k, v]);
const asked = () => app.evaluate(() => globalThis.__q.box.splice(0));
const E = (fn, a) => win.evaluate(fn, a);
for (let i = 0; i < 60 && !(await E(() => !!window.__gcc).catch(() => false)); i++) await sleep(200);

const openFile = async (f, pages) => {
  const had = await E(() => window.__gcc.docs().length);
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), f);
  await until(() => E(([n, pg]) => window.__gcc.docs().length === n + 1 && (pg ? window.__gcc.active().pages.length === pg : window.__gcc.active().pages.length > 0), [had, pages]), 90000, 'open ' + f);
  await sleep(1200);
};
/** pixels of each colour on the drawn page 0 (all its canvases), classified; the squares are black, red, blue, green */
const CLS = `(d) => { const n = { black: 0, red: 0, blue: 0, green: 0 }; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 200) continue; const r = d[i], g = d[i + 1], b = d[i + 2]; if (r < 70 && g < 70 && b < 70) n.black++; else if (r > 170 && g < 80 && b < 80) n.red++; else if (b > 170 && r < 80 && g < 80) n.blue++; else if (g > 170 && r < 80 && b < 80) n.green++; } return n; }`;
const screen = () => E((cls) => {
  const f = eval(cls);
  const t = { black: 0, red: 0, blue: 0, green: 0 };
  for (const c of document.querySelectorAll('.pg[data-page="0"] canvas')) {
    if (!c.width || !c.height || c.width * c.height < 4) continue;
    const n = f(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
    for (const k in t) t[k] += n[k];
  }
  return t;
}, CLS);
const has = (n) => ({ black: n.black > 100, red: n.red > 100, blue: n.blue > 100, green: n.green > 100 });
const shows = (n) => Object.entries(has(n)).filter(([, v]) => v).map(([k]) => k).join('+') || 'nothing';
const settle = async (want, ms = 20000) => { let last = null; await until(async () => { last = await screen(); return shows(last) === want; }, ms, 'screen shows ' + want).catch(() => {}); return shows(last || await screen()); };
const state = () => E(() => { const d = window.__gcc.active(); return { dirty: d.dirty, canUndo: d.canUndo, undoName: d.undoName, canRedo: d.canRedo }; });
const row = (name) => win.locator('.ly-row', { hasText: name });
const hist = () => E(async () => (await window.__gcc.engines.mu('history', window.__gcc.active().id)).undo);
/** colours in a PNG / a PDF page drawn by MuPDF */
const classify = (pix) => { const d = pix.getPixels(); const n = { black: 0, red: 0, blue: 0, green: 0 }; const ch = pix.getNumberOfComponents() + (pix.getAlpha() ? 1 : 0); for (let i = 0; i < d.length; i += ch) { const r = d[i], g = d[i + 1], b = d[i + 2]; if (r < 70 && g < 70 && b < 70) n.black++; else if (r > 170 && g < 80 && b < 80) n.red++; else if (b > 170 && r < 80 && g < 80) n.blue++; else if (g > 170 && r < 80 && b < 80) n.green++; } return n; };
const pdfShows = (f) => { const d = mupdf.Document.openDocument(readFileSync(f), 'application/pdf'); const p = d.loadPage(0); const pix = p.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, true); return shows(classify(pix)); };
const pngShows = (f) => shows(classify(new mupdf.Image(readFileSync(f)).toPixmap()));

try {
  await openFile(F, 1);
  await win.locator('.rail-btn[title="Layers"]').click();
  await win.locator('.side .side-head', { hasText: 'Layers' }).waitFor({ timeout: 5000 });
  await until(() => row('Walls').count(), 10000, 'layers listed');

  // 1. the list: file's order, nested one indented, locked one with a lock and no tick
  const names = await win.locator('.ly-row .ly-name').allTextContents();
  ok(JSON.stringify(names) === '["Walls","Grid","Furniture","Notes"]', 'layers in the file\'s own order: ' + names.join(', '));
  const pad = await win.locator('.ly-row').evaluateAll((l) => l.map((x) => parseInt(x.style.paddingLeft)));
  ok(pad[1] > pad[0] && pad[2] === pad[0], 'Grid is indented under Walls: ' + pad.join(','));
  ok(await row('Notes').locator('.ly-lock').count() === 1 && await row('Notes').locator('input').count() === 0, 'the locked layer shows a lock and has no tick');
  const ticks = await win.locator('.ly-row input').evaluateAll((l) => l.map((x) => x.checked));
  ok(JSON.stringify(ticks) === '[true,true,false]', 'ticks as the file says (Furniture off): ' + ticks.join(','));
  const saveBtn = win.locator('.layers button', { hasText: 'Save the layer state' });
  ok(await saveBtn.isDisabled(), '"Save the layer state" is greyed while nothing differs from the file');
  ok(await settle('black+blue+green') === 'black+blue+green', 'on screen: the file\'s own state (no red)');
  // the locked row can't be clicked
  await row('Notes').click({ force: true });
  await sleep(600);
  ok(await saveBtn.isDisabled() && shows(await screen()) === 'black+blue+green', 'a click on the locked layer changes nothing');

  // 2. clicks close together: applied together (one new drawing copy), display only
  await E(() => { const d = window.__gcc.active(); d.__calls = 0; const f = d.setLayers.bind(d); d.setLayers = (m) => { d.__calls++; return f(m); }; });
  const before = await state();
  await row('Walls').locator('input').click();
  await row('Furniture').locator('input').click();
  const seen = await settle('red+blue+green');
  ok(seen === 'red+blue+green', 'Walls hidden and Furniture shown on the page itself: ' + seen);
  ok(await E(() => window.__gcc.active().__calls) === 1, 'the two clicks went as one: ' + await E(() => window.__gcc.active().__calls) + ' redraw(s)');
  const after = await state();
  ok(!after.dirty && !after.canUndo && JSON.stringify((await hist())) === '[]', 'no undo step, the file is not marked changed (dirty ' + after.dirty + ', undo ' + JSON.stringify(await hist()) + ')');
  ok(await saveBtn.isEnabled(), '"Save the layer state" is on now');
  const marked = await win.locator('.dtab .dirty').count();
  ok(marked === 0, 'no unsaved dot on the tab');

  // 3. Print preview follows the screen
  await win.keyboard.press('Control+p');
  await win.waitForSelector('.printdlg', { timeout: 5000 });
  const preview = () => E((cls) => { const c = document.querySelector('.pd-sheet'); if (!c || !c.width) return null; return eval(cls)(c.getContext('2d').getImageData(0, 0, c.width, c.height).data); }, CLS);
  let pv = null;
  await until(async () => { pv = await preview(); return pv && shows(pv) === 'red+blue+green'; }, 15000, 'preview').catch(() => {});
  ok(pv && shows(pv) === 'red+blue+green', 'Print preview shows the layers as the screen does: ' + (pv && shows(pv)));
  // Save as PDF: the sheet written follows too (made in the editing engine; its pictures in the batch engine from this file)
  const printed = join(OUT, 'printed.pdf');
  await q('save', printed);
  await win.locator('.printdlg button', { hasText: 'Save as PDF' }).click();
  await until(() => existsSync(printed), 30000, 'printed file');
  await sleep(800);
  ok(pdfShows(printed) === 'red+blue+green', 'Save as PDF (as it would print): ' + pdfShows(printed));
  await win.locator('.printdlg').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  ok(!(await state()).dirty, 'printing did not mark the file changed');

  // 4. Save as pictures (batch engine) follows
  await win.locator('.rtab.file').click();
  await win.locator('.filepane button', { hasText: 'Save as pictures' }).click();
  const d1 = win.locator('.modal', { hasText: 'Save pages as pictures' });
  await d1.waitFor({ timeout: 5000 });
  await d1.locator('.seg button', { hasText: 'PNG' }).click();
  const png = join(OUT, 'page.png');
  await q('save', png);
  await d1.locator('.btn.primary', { hasText: /^Save 1 picture/ }).click();
  await until(() => existsSync(png), 30000, 'png');
  await sleep(500);
  ok(pngShows(png) === 'red+blue+green', 'Save as pictures (PNG of the page): ' + pngShows(png));

  // 5. Word export reads and draws as the screen does too: a word on a hidden layer is not exported
  await win.locator('.rtab.file').click();
  await win.locator('.filepane button', { hasText: 'Export to Word' }).click();
  await win.locator('.modal h2', { hasText: 'Export to Word' }).waitFor({ timeout: 5000 });
  await win.locator('.modal label.check', { hasText: 'Open the file' }).locator('input').uncheck().catch(() => {});
  const docx = join(OUT, 'plan.docx');
  await q('save', docx);
  await win.locator('.modal .btn.primary', { hasText: 'Export' }).click();
  await until(() => existsSync(docx), 60000, 'docx');
  await sleep(800);
  const words = execFileSync('python3', ['-c', 'import zipfile,sys,re; x=zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode(); print(re.sub("<[^>]+>"," ",x))', docx]).toString();
  ok(/FURNWORD/.test(words) && /GRIDWORD/.test(words) && !/WALLSWORD/.test(words), 'Word export: the hidden layer\'s word is left out, the shown one\'s is in');
  await win.locator('.modal').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await until(async () => !(await win.locator('.toast.busy').count()), 10000).catch(() => {});

  // 6. Save the layer state: one undo step; undo and redo; saved to disk and reopened
  await saveBtn.click();
  await until(async () => (await state()).undoName === 'Save the layer state', 10000, 'saved step');
  const s1 = await state();
  ok(s1.dirty && JSON.stringify(await hist()) === '["Save the layer state"]', 'one undo step "Save the layer state", the file now counts as changed');
  ok(await saveBtn.isDisabled(), 'and nothing differs from the file any more');
  ok(await settle('red+blue+green') === 'red+blue+green', 'the screen is the same after saving');
  const L1 = await E(async () => (await window.__gcc.active().layers()).map((l) => [l.name, l.on]));
  ok(JSON.stringify(L1) === '[["Walls",false],["Grid",true],["Furniture",true],["Notes",true]]', 'the file says it now: ' + JSON.stringify(L1));
  await E(() => window.__gcc.active().undo());
  ok(await settle('black+blue+green') === 'black+blue+green', 'undo: the file\'s old state on screen');
  await E(() => window.__gcc.active().redo());
  ok(await settle('red+blue+green') === 'red+blue+green', 'redo: hidden again');
  await E(() => window.__gcc.active().save());
  await sleep(500);
  ok(!(await state()).dirty, 'saved to disk');
  await win.keyboard.press('Control+w');
  await until(() => E(() => window.__gcc.docs().length === 0), 10000, 'closed');
  ok((await asked()).length === 0, 'a saved file closes with no question');
  await openFile(F, 1);
  const L2 = await E(async () => (await window.__gcc.active().layers()).map((l) => [l.name, l.on, l.shown]));
  ok(JSON.stringify(L2) === '[["Walls",false,false],["Grid",true,true],["Furniture",true,true],["Notes",true,true]]', 'reopened: the saved state: ' + JSON.stringify(L2));
  ok(await settle('red+blue+green') === 'red+blue+green', 'reopened: Walls hidden on screen');
  ok(!(await state()).canUndo, 'reopened: no history (the state is the file\'s)');
  const bytes = readFileSync(F);
  const fresh = mupdf.Document.openDocument(bytes, 'application/pdf');
  const px = classify(fresh.loadPage(0).toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, true));
  ok(shows(px) === 'red+blue+green', 'a fresh MuPDF open of the saved file agrees: ' + shows(px));

  // 7. state per tab, forgotten on close; closing asks nothing
  await openFile(G, 1);
  await sleep(600);
  await row('Walls').locator('input').waitFor({ timeout: 10000 });
  await row('Walls').locator('input').click();
  await settle('blue+green').then((s) => ok(s === 'blue+green', 'second tab: Walls hidden there (' + s + ')'));
  await win.locator('.dtab', { hasText: 'plan.pdf' }).click();
  ok(await settle('red+blue+green') === 'red+blue+green', 'the first tab is as it was (the state is per tab)');
  await win.locator('.dtab', { hasText: 'other.pdf' }).click();
  await sleep(500);
  ok(shows(await screen()) === 'blue+green' && (await win.locator('.ly-row input').evaluateAll((l) => l.map((x) => x.checked))).join() === 'false,true,false', 'the second tab\'s state comes back with it');
  await asked();
  await win.keyboard.press('Control+w');
  await until(() => E(() => window.__gcc.docs().length === 1), 10000, 'tab closed');
  await sleep(500);
  ok((await asked()).length === 0, 'closing a tab with layers toggled and not saved asks no "save changes?"');
  // the same file opened again: as the file says
  await openFile(G, 1);
  const L3 = await E(async () => (await window.__gcc.active().layers()).map((l) => l.shown));
  ok(L3.join() === 'true,true,false,true', 'opened again: the state was forgotten: ' + L3.join());

  // 8. Find a tool
  await win.locator('.rtab', { hasText: 'Home' }).click();
  ok(await win.locator('.ribbon .rb', { hasText: /^Layers$/ }).count() === 1, 'a "Layers" button on the Home tab');

  // 9. the R set: no layers -> the plain sentence, no error, no change
  const errs0 = consoleErrors.length;
  for (const [name, f, pages] of [['mixed set', R.mixed], ['scan', R.scan], ['1,500-page spec', R.longSpec, 1500]]) {
    const t0 = Date.now();
    await openFile(f, pages);
    await until(() => win.locator('.ly-list', { hasText: 'This file has no layers.' }).count(), 15000, name + ' panel text');
    const dt = Date.now() - t0;
    const st = await state();
    ok(await win.locator('.layers button', { hasText: 'Save the layer state' }).isDisabled(), `${name}: "This file has no layers.", the button greyed (${dt} ms with opening)`);
    ok(!st.dirty && !st.canUndo, `${name}: nothing changed`);
  }
  ok(consoleErrors.length === errs0, 'no console error on the R set' + (consoleErrors.length > errs0 ? ': ' + consoleErrors.slice(errs0).join(' | ') : ''));
  await sleep(1500);
  ok(reports().length === 0, 'no crash report filed (' + reports().length + ')');
} catch (e) {
  console.log('FAIL ' + e.message);
  fails++;
  await win.screenshot({ path: join(TMP, 'fail.png') }).catch(() => {});
}
// (the window's close would ask about the open tabs: the mocked answer keeps it open - leave at once)
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
if (!fails) rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
