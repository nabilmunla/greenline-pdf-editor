// "Continue from this corner" on an Area: what the tip / status line says while drawing vs the
// area the markup gets (agent audit, 0.9.7).
// xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-cont-tip.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-e2e-cont-tip');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'sheet.pdf');
{ const d = new mupdf.PDFDocument(); d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, {}, '')); writeFileSync(F, d.saveToBuffer('').asUint8Array()); }
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-agcont'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=agcont', F] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 1, null, { timeout: 60000 });
const E = (fn, a) => win.evaluate(fn, a);
await E(() => window.__gcc.viewer().setZoom(1.4));
await sleep(800);
const annots = () => E(async () => (await window.__gcc.active().annots(0)).map((a) => ({ id: a.id, kind: a.kind, vertices: a.vertices, contents: a.contents })));
const at = async (x, y) => { const box = await win.locator('.pg[data-page="0"]').boundingBox(); const k = box.width / 842; return [box.x + x * k, box.y + y * k]; };
const move = async (x, y) => { const p = await at(x, y); await win.mouse.move(p[0], p[1], { steps: 4 }); await sleep(250); };
const click = async (x, y) => { const p = await at(x, y); await win.mouse.click(p[0], p[1]); await sleep(150); };
try {
  await win.locator('.statusbar button', { hasText: 'Scale' }).click();
  await win.locator('.modal .chip', { hasText: /^1:100$/ }).first().click();
  await sleep(600);
  await win.locator('.statusbar button', { hasText: /Snap (on|off)/ }).click(); // snap off: exact points
  await win.locator('.rtab', { hasText: /^Measure$/ }).click();
  await win.locator('.ribbon [data-tool="m-area"]').first().click();
  await sleep(300);
  for (const q of [[120, 430], [220, 440], [230, 520], [110, 520]]) { await move(...q); await click(...q); await sleep(150); }
  await win.keyboard.press('Enter');
  await sleep(600);
  const a0 = (await annots()).find((a) => a.kind === 'measure-area');
  console.log('area drawn: ' + a0.contents);
  await win.locator('.viewer').focus(); await win.keyboard.press('v'); await sleep(200);
  await click(170, 475);
  const rc = await at(220, 440);
  await win.mouse.click(rc[0], rc[1], { button: 'right' });
  await sleep(300);
  await win.locator('.cmenu button', { hasText: 'Continue from this corner' }).first().click();
  await sleep(300);
  await move(260, 475);
  const tip = await win.locator('.vtip').first().textContent({ timeout: 800 }).catch(() => '');
  await click(260, 475);
  await sleep(300);
  const status = await win.locator('.statusbar').first().textContent();
  await win.keyboard.press('Enter');
  await sleep(700);
  const a1 = (await annots()).find((a) => a.id === a0.id);
  console.log(`tip while drawing: "${tip}"`);
  console.log(`status after the click: "${status.slice(0, 120)}"`);
  console.log(`the area's number once finished: "${a1.contents}" (${a1.vertices.length} corners)`);
  const num = (s) => Number((/([\d.,]+)\s*m²/.exec(s || '') || [])[1]?.replace(/,/g, ''));
  console.log((num(tip) && Math.abs(num(tip) - num(a1.contents)) > 0.01 ? (globalThis.__failed = true, 'FAIL ') : 'PASS ') + 'tip says ' + num(tip) + ' m², the area becomes ' + num(a1.contents) + ' m²');
} catch (e) { console.log('EXCEPTION ' + (e && e.stack || e)); }
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
rmSync(TMP, { recursive: true, force: true });
process.exit(globalThis.__failed ? 1 : 0);
