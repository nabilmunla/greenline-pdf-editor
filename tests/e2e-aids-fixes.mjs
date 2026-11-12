// Fresh-eyes repros for the 0.9.6 measuring aids (agent audit, 0.9.7).
// xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-aids-fixes.mjs
// Each check prints FAIL (the bug shows) or PASS. (From the 0.9.7 debugging run's repro scripts.)
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-e2e-aids-fixes');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'sheet.pdf');
{
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, {}, '0 G 1 w 100 395 m 700 395 l S 500 100 m 800 400 l S'));
  writeFileSync(F, d.saveToBuffer('').asUint8Array());
}
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-agaids'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (bug, m) => console.log((bug ? (globalThis.__failed = true, 'FAIL ') : 'PASS ') + m);

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=agaids', F] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 1, null, { timeout: 60000 });
const E = (fn, a) => win.evaluate(fn, a);
await E(() => window.__gcc.viewer().setZoom(1));
await sleep(800);
const annots = () => E(async () => (await window.__gcc.active().annots(0)).map((a) => ({ id: a.id, kind: a.kind, vertices: a.vertices, line: a.line })));
const at = async (x, y) => { const box = await win.locator('.pg[data-page="0"]').boundingBox(); const k = box.width / 842; return [box.x + x * k, box.y + y * k]; };
const move = async (x, y) => { const p = await at(x, y); await win.mouse.move(p[0], p[1], { steps: 4 }); await sleep(250); };
const click = async (x, y) => { const p = await at(x, y); await win.mouse.click(p[0], p[1]); await sleep(150); };
const tab = (name) => win.locator('.rtab', { hasText: new RegExp('^' + name + '$') }).click();
const tool = async (id) => { await win.locator(`.ribbon [data-tool="${id}"]`).first().click(); await sleep(250); };
const newest = async (kind) => { const l = await annots(); return l.filter((a) => a.kind === kind).sort((a, b) => b.id - a.id)[0]; };
const orthoText = () => win.locator('.statusbar button', { hasText: /Ortho (on|off)/ }).textContent();
const snapBtn = () => win.locator('.statusbar button', { hasText: /Snap (on|off)/ });
const snapKind = () => E(() => document.querySelector('.ov [data-k]')?.getAttribute('data-k') || '');

try {
  await win.locator('.statusbar button', { hasText: 'Scale' }).click();
  await win.locator('.modal .chip', { hasText: /^1:100$/ }).first().click();
  await sleep(600);
  await tab('Measure');

  // ------------------------------------------------ 1. Ortho on: Length (a two-point tool)
  await win.locator('.viewer').focus();
  await win.keyboard.press('F8');
  await sleep(300);
  console.log('status: ' + (await orthoText()));
  await snapBtn().click(); // snap off (a free point)
  await sleep(200);
  await tool('m-length');
  await click(150, 300);
  await click(330, 312); // 4 degrees off level
  await sleep(600);
  let m = await newest('measure-length');
  log(m && Math.abs(m.line[1][1] - 300) > 1, '1. Ortho on + Length tool: second point ' + JSON.stringify(m && m.line) + ' (level would be y=300)');
  await tab('Comment');
  await sleep(300);
  await tool('line');
  await click(150, 340);
  await click(330, 352);
  await sleep(600);
  m = await newest('line');
  log(m && Math.abs(m.line[1][1] - 340) > 1, '1b. Ortho on + Line tool: ' + JSON.stringify(m && m.line));
  await tab('Measure');

  // (Ortho over a snapped point: see snap-repro.mjs, check C)
  await snapBtn().click(); // snap on again
  await sleep(200);

  // ortho off again for the rest
  await win.locator('.viewer').focus();
  await win.keyboard.press('F8');
  await sleep(300);
  console.log('status: ' + (await orthoText()));

  // ------------------------------------------------ 3. Continue from a corner with Area in "rectangle" mode
  await tool('m-area');
  for (const q of [[120, 430], [220, 440], [230, 520], [110, 520]]) { await move(...q); await click(...q); await sleep(200); }
  await win.keyboard.press('Enter');
  await sleep(600);
  const ar0 = await newest('measure-area');
  const nAreas0 = (await annots()).filter((a) => a.kind === 'measure-area').length;
  console.log('area drawn: ' + JSON.stringify(ar0 && ar0.vertices));
  // (the bar at the foot of the view - Undo point / Close / Finish - takes clicks under it: the
  // area may come out with fewer corners here; what counts is that it gets none from the continuation)
  // Area drawn by rectangle from now on (R - as estimators do for rooms)
  await win.locator('.viewer').focus();
  await win.keyboard.press('r');
  await sleep(300);
  await win.keyboard.press('Escape');
  await win.keyboard.press('v');
  await sleep(200);
  await click(170, 475);
  const rc = await at(220, 440);
  await win.mouse.click(rc[0], rc[1], { button: 'right' });
  await sleep(300);
  const item = win.locator('.cmenu button', { hasText: 'Continue from this corner' }).first();
  const has = await item.count();
  if (has) {
    await item.click();
    await sleep(300);
    await click(260, 475);
    await move(300, 500);
    await click(300, 500);
    await win.keyboard.press('Enter');
    await sleep(700);
  }
  const all3 = await annots();
  const ar1 = all3.find((a) => a.id === ar0.id);
  const nAreas1 = all3.filter((a) => a.kind === 'measure-area').length;
  console.log('areas after: ' + JSON.stringify(all3.filter((a) => a.kind === 'measure-area').map((a) => a.vertices.map((v) => v.map(Math.round)))));
  log(has && ar1 && ar1.vertices.length === ar0.vertices.length && nAreas1 > nAreas0, `3. Area in rectangle mode, "Continue from this corner": the area kept ${ar1 && ar1.vertices.length} corners; areas ${nAreas0} -> ${nAreas1} (menu item: ${has})`);
  await win.keyboard.press('Escape');
  await win.locator('.viewer').focus();
  await win.keyboard.press('v');
  await sleep(200);

  // ------------------------------------------------ 4. F-keys after picking the magnifier zoom
  await tab('Measure');
  await win.locator('.ribbon button', { hasText: 'Magnifier' }).first().click();
  await sleep(300);
  const sel = win.locator('.ribbon select').filter({ has: win.locator('option[value="8"]') }).first();
  if (await sel.count()) {
    await sel.selectOption('6');
    await sleep(200);
    await move(300, 250);
    const before = await orthoText();
    await win.keyboard.press('F8');
    await sleep(300);
    const after = await orthoText();
    log(before === after, `4. after choosing the magnifier zoom, pointer over the page, F8: "${before}" -> "${after}"`);
    if (before !== after) await win.keyboard.press('F8');
  } else console.log('?     4. no zoom select found');
} catch (e) { console.log('EXCEPTION ' + (e && e.stack || e)); }
await win.screenshot({ path: join(TMP, 'end.png') }).catch(() => {});
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log('done');
process.exit(globalThis.__failed ? 1 : 0);
