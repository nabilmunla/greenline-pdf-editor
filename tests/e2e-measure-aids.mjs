// Drawing aids brought over from the Estimation app (0.9.6): the perpendicular snap (⊥) onto the
// drawing's lines and onto markup edges - from the point the line comes from, when the pointer is
// near the foot; a corner nearer than the foot wins; Ortho (F8) keeps lines at 0 / 45 / 90° without
// Shift. xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-measure-aids.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-measure-aids');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'sheet.pdf');
{
  // (PDF space, y up: a level line at y 395 = 200 from the top; a slanted one from (500,100) to (800,400))
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, {}, '0 G 1 w 100 395 m 700 395 l S 500 100 m 800 400 l S'));
  writeFileSync(F, d.saveToBuffer('').asUint8Array());
}
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-maids'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else { fails++; void win.screenshot({ path: join(TMP, `fail-${fails}.png`) }).catch(() => {}); } return c; };
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(80); } return null; };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=maids', F] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 1, null, { timeout: 60000 });
const E = (fn, a) => win.evaluate(fn, a);
await E(() => window.__gcc.viewer().setZoom(1.4));
await sleep(800);
const annots = () => E(async () => (await window.__gcc.active().annots(0)).map((a) => ({ id: a.id, kind: a.kind, vertices: a.vertices, line: a.line })));
const at = async (x, y) => { const box = await win.locator('.pg[data-page="0"]').boundingBox(); const k = box.width / 842; return [box.x + x * k, box.y + y * k]; };
const move = async (x, y) => { const p = await at(x, y); await win.mouse.move(p[0], p[1], { steps: 4 }); await sleep(250); };
const click = async (x, y) => { const p = await at(x, y); await win.mouse.click(p[0], p[1]); await sleep(120); };
const tab = (name) => win.locator('.rtab', { hasText: new RegExp('^' + name + '$') }).click();
const tool = async (id) => { await win.locator(`.ribbon [data-tool="${id}"]`).first().click(); await sleep(250); };
const near = (p, q, tol = 0.6) => !!p && Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
const tipText = async () => { await sleep(150); const k = await E(() => document.querySelector('.ov [data-k]')?.getAttribute('data-k') || ''); const t = await win.locator('.vtip').first().textContent({ timeout: 800 }).catch(() => ''); return k + ' | ' + t; };
const newest = async (kind) => { const l = await annots(); return l.filter((a) => a.kind === kind).sort((a, b) => b.id - a.id)[0]; };

try {
  await win.locator('.statusbar button', { hasText: 'Scale' }).click();
  await win.locator('.modal .chip', { hasText: /^1:100$/ }).first().click();
  await until(() => win.locator('.statusbar button', { hasText: '1:100' }).count());
  ok(/Snap on/.test(await win.locator('.statusbar button', { hasText: /Snap (on|off)/ }).textContent()), 'snapping is on');
  await tab('Measure');
  // (the line work is read in the engine once the tool is picked)
  await tool('m-polylength');
  await sleep(1200);

  // ---------------------------------------------------------------- ⊥ onto a line of the drawing
  await click(260, 80);
  await move(263, 197); // near the line (y 200) and near the foot from (260, 80): (260, 200)
  const t1 = await tipText();
  ok(/Perpendicular/.test(t1), 'near the foot on a line: "Perpendicular" (' + t1 + ')');
  await click(263, 197);
  await win.keyboard.press('Enter');
  await sleep(500);
  let m = await newest('measure-polylength');
  ok(m && near(m.vertices[1], [260, 200]), 'the point lands on the foot of the perpendicular: ' + JSON.stringify(m && m.vertices));
  // near the line but far from the foot: an ordinary point on the line
  await click(380, 80);
  await move(300, 198);
  const t2 = await tipText();
  ok(!/Perpendicular/.test(t2), 'on the line far from the foot: not ⊥ (' + t2 + ')');
  await win.keyboard.press('Escape');
  await sleep(200);
  // onto a slanted line: from (500, 300) the foot on (500,495)-(800,195) [top-left space] is (597.5, 397.5)
  await click(500, 300);
  await move(599, 396);
  ok(/Perpendicular/.test(await tipText()), 'onto a slanted line too');
  await click(599, 396);
  await win.keyboard.press('Enter');
  await sleep(500);
  m = await newest('measure-polylength');
  ok(m && near(m.vertices[1], [597.5, 397.5], 1), 'on the slanted line\'s foot: ' + JSON.stringify(m && m.vertices));

  // ---------------------------------------------------------------- ⊥ onto a markup's edge
  await E(() => window.__gcc.active().create(0, { type: 'Square', rect: [400, 420, 480, 560], color: [1, 0, 0], kind: 'rect' }));
  await sleep(400);
  if (!(await win.locator('.ribbon [data-tool="m-polylength"].on, .ribbon [data-tool="m-polylength"][aria-pressed="true"]').count())) await tool('m-polylength');
  await click(330, 500);
  await move(401, 503); // near the left edge (x 400); foot from (330, 500) is (400, 500)
  ok(/Perpendicular/.test(await tipText()), 'near a markup edge\'s foot: "Perpendicular"');
  await click(401, 503);
  await win.keyboard.press('Enter');
  await sleep(500);
  m = await newest('measure-polylength');
  ok(m && near(m.vertices[1], [400, 500]), 'on the markup edge\'s foot: ' + JSON.stringify(m && m.vertices));
  // a corner nearer than the foot wins
  await click(330, 424);
  await move(401, 421); // the corner (400, 420) is nearer than the foot (400, 424)? 1.4 vs 3.2
  ok(/corner/i.test(await tipText()), 'a corner nearer than the foot wins: ' + await tipText());
  await win.keyboard.press('Escape');
  await sleep(200);

  // ---------------------------------------------------------------- Ortho (F8)
  await win.locator('.viewer').focus();
  await win.keyboard.press('F8');
  await sleep(300);
  ok(/Ortho on/.test(await win.locator('.statusbar button', { hasText: /Ortho (on|off)/ }).textContent()), 'F8: Ortho on (status bar)');
  await win.locator('.statusbar button', { hasText: /Snap (on|off)/ }).click(); // (off: a free point)
  await sleep(200);
  await click(150, 300);
  await click(330, 312); // 4° off level: straightened
  await win.keyboard.press('Enter');
  await sleep(500);
  m = await newest('measure-polylength');
  ok(m && Math.abs(m.vertices[1][1] - 300) < 0.6, 'Ortho: the line goes level without Shift: ' + JSON.stringify(m && m.vertices));
  await win.keyboard.press('F8');
  await sleep(300);
  ok(/Ortho off/.test(await win.locator('.statusbar button', { hasText: /Ortho (on|off)/ }).textContent()), 'F8 again: off');
  await click(150, 340);
  await click(330, 352);
  await win.keyboard.press('Enter');
  await sleep(500);
  m = await newest('measure-polylength');
  ok(m && Math.abs(m.vertices[1][1] - 352) < 0.6, 'Ortho off: the line goes where clicked: ' + JSON.stringify(m && m.vertices));
  ok(await E(() => window.gcc.settings().then((s) => s.ortho === false)), 'Ortho is a setting (kept)');

  // ---------------------------------------------------------------- Crosshair (F6), Magnifier (F7)
  await win.locator('.statusbar button', { hasText: /Snap (on|off)/ }).click(); // (back on)
  await win.locator('.viewer').focus();
  await win.keyboard.press('F6');
  await move(300, 200);
  await move(302, 201);
  const xh = await E(() => { const h = document.querySelector('.xhair.h'), v = document.querySelector('.xhair.v'); return { h: h && getComputedStyle(h).display, v: v && getComputedStyle(v).display, top: h && h.getBoundingClientRect().top, left: v && v.getBoundingClientRect().left }; });
  const ptr = await at(302, 201);
  ok(xh.h === 'block' && xh.v === 'block' && Math.abs(xh.top - ptr[1]) < 2 && Math.abs(xh.left - ptr[0]) < 2, 'F6: crosshair lines through the pointer ' + JSON.stringify(xh) + ' ' + ptr);
  await win.keyboard.press('F6');
  await move(303, 201);
  ok(await E(() => getComputedStyle(document.querySelector('.xhair.h')).display === 'none'), 'F6 again: gone');
  await win.keyboard.press('F7');
  await move(300, 200);
  await move(301, 200); // (on the level line at y 200)
  await sleep(900); // (drawn sharp once the pointer rests)
  const lp = await E(() => {
    const c = document.querySelector('.loupe');
    if (!c || getComputedStyle(c).display === 'none') return null;
    const ctx = c.getContext('2d'), d = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0, rows = new Set();
    for (let i = 0; i < d.length; i += 4) if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) { dark++; rows.add(Math.floor(i / 4 / c.width)); }
    const r = c.getBoundingClientRect();
    return { dark, rows: rows.size, w: c.width, x: r.left, y: r.top };
  });
  ok(lp && lp.dark > 50, 'F7: the magnifier shows the line work under the pointer ' + JSON.stringify(lp));
  ok(lp && lp.rows < lp.w / 6, 'a thin line magnified (not a smear): rows ' + (lp && lp.rows));
  await win.keyboard.press('F7');
  await move(302, 200);
  ok(await E(() => getComputedStyle(document.querySelector('.loupe')).display === 'none'), 'F7 again: gone');

  // ---------------------------------------------------------------- continue from a corner
  // (zoomed out: at 140% the third corner fell under the Area tool's bars at the bottom middle of
  // the view - the click went to them, depending on where the page sat)
  await E(() => window.__gcc.viewer().setZoom(1));
  await sleep(800);
  await tool('m-area');
  for (const q of [[120, 430], [220, 440], [230, 520], [110, 520]]) { await move(...q); await click(...q); await sleep(200); } // (not a rectangle: those keep square)
  await win.keyboard.press('Enter');
  await sleep(600);
  let ar = await newest('measure-area');
  ok(ar && ar.vertices.length === 4, 'an area of 4 corners ' + JSON.stringify(ar && ar.vertices));
  await win.keyboard.press('Escape');
  await win.locator('.viewer').focus(); await win.keyboard.press('v'); await sleep(200);
  await click(170, 475); // (select it)
  const rc = await at(220, 440);
  await win.mouse.click(rc[0], rc[1], { button: 'right' });
  await sleep(300);
  const item = win.locator('.cmenu button', { hasText: 'Continue from this corner' }).first();
  ok(await item.count() === 1, 'right-click a corner: "Continue from this corner" (' + (await win.locator('.cmenu button').allTextContents()).join(' / ') + ')');
  await item.click();
  await sleep(300);
  await click(260, 475);
  await win.keyboard.press('Enter');
  await sleep(700);
  ar = (await annots()).find((a) => a.id === ar.id);
  ok(ar && ar.vertices.length === 5 && near(ar.vertices[2], [260, 475]) && near(ar.vertices[1], [220, 440]) && near(ar.vertices[3], [230, 520]), 'the new corner goes in after it, the rest stays: ' + JSON.stringify(ar && ar.vertices));
} catch (e) { console.log('FAIL exception ' + (e && e.stack || e)); fails++; }
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
rmSync(TMP, { recursive: true, force: true });
console.log(`checks passed: ${passes}`);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
