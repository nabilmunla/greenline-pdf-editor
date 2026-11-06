// Measuring / drawing polish from the Estimation app's take-off (0.8.9): while drawing by points,
// Ctrl+Z / Backspace / Delete take back a point (the file's undo left alone), Ctrl+Y puts it back,
// Esc cancels and Ctrl+Z brings the shape back, Shift+C closes, the drawing bar; corners dragged
// snap (to other markups and the shape's own other corners), Shift squares the edge, a click on a
// corner changes nothing, middle dots add a corner, Alt+click / right-click delete one, right-click
// adds one, Continue this line; Count: Backspace; the Calibrate window moves and the page shows.
// xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-measure-polish.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-measure-polish');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'sheet.pdf');
{
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, {}, '0.8 g 20 20 802 555 re S'));
  writeFileSync(F, d.saveToBuffer('').asUint8Array());
}
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-mpolish'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else { fails++; void win.screenshot({ path: join(TMP, `fail-${fails}.png`) }).catch(() => {}); } return c; };
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(80); } return null; };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=mpolish', F] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 1, null, { timeout: 60000 });
const E = (fn, a) => win.evaluate(fn, a);
await E(() => window.__gcc.viewer().setZoom(1.4));
await sleep(800);
const annots = () => E(async () => (await window.__gcc.active().annots(0)).map((a) => ({ id: a.id, type: a.type, kind: a.kind, vertices: a.vertices, line: a.line, contents: a.contents, group: a.group })));
const at = async (x, y) => { const box = await win.locator('.pg[data-page="0"]').boundingBox(); const k = box.width / 842; return [box.x + x * k, box.y + y * k]; };
const click = async (x, y, opt) => { const p = await at(x, y); await win.mouse.click(p[0], p[1], opt); await sleep(60); };
const drag = async (a, b, mods = []) => { const p = await at(...a), q = await at(...b); for (const m of mods) await win.keyboard.down(m); await win.mouse.move(...p); await win.mouse.down(); await win.mouse.move(...q, { steps: 12 }); await sleep(250); await win.mouse.up(); for (const m of mods) await win.keyboard.up(m); await sleep(400); };
const tab = (name) => win.locator('.rtab', { hasText: new RegExp('^' + name + '$') }).click();
const tool = async (id) => { if (id === 'select') { await win.locator('.viewer').focus(); await win.keyboard.press('v'); await sleep(250); return; } await win.locator(`.ribbon [data-tool="${id}"]`).first().click(); await sleep(250); };
const dpts = () => E(() => document.querySelectorAll('.ov .dpt').length);
const undoName = () => E(async () => { const d = window.__gcc.active(); await d.refreshHistory(); return d.undoName; });
const near = (p, q, tol = 0.6) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
const snapSet = async (on) => { const b = win.locator('.statusbar button', { hasText: /Snap (on|off)/ }); if (((await b.textContent()) || '').includes(on ? 'off' : 'on')) await b.click(); await sleep(150); };

try {
  // scale 1:100 so measurements have numbers
  await win.locator('.statusbar button', { hasText: 'Scale' }).click();
  await win.locator('.modal .chip', { hasText: /^1:100$/ }).first().click();
  await until(() => win.locator('.statusbar button', { hasText: '1:100' }).count());
  await snapSet(false);
  // something made before: the file's own Undo must not take it while a shape is drawn
  await E(() => window.__gcc.active().create(0, { type: 'Square', rect: [600, 400, 700, 450], color: [1, 0, 0], kind: 'rect' }));
  await sleep(300);
  const before = (await annots()).length;

  // ---------------------------------------------------------------- points while drawing
  await tab('Measure');
  await tool('m-polylength');
  await click(100, 100); await click(200, 100); await click(200, 200); await click(300, 200);
  ok(await dpts() === 4, '4 points placed: ' + await dpts());
  ok(await win.locator('.drawbar').count() === 1, 'the drawing bar shows while drawing');
  ok(/m/.test(await win.locator('.drawbar .db-v').textContent()), 'the bar shows the length so far: ' + await win.locator('.drawbar .db-v').textContent());
  await win.keyboard.press('Control+z');
  await sleep(150);
  ok(await dpts() === 3, 'Ctrl+Z takes back the last point (3 left): ' + await dpts());
  ok((await annots()).length === before, 'and leaves the markup made before alone (the file\'s Undo not used)');
  await win.keyboard.press('Control+z');
  await sleep(150);
  ok(await dpts() === 2, 'Ctrl+Z again: 2 left');
  await win.keyboard.press('Control+y');
  await sleep(150);
  ok(await dpts() === 3, 'Ctrl+Y puts a point back');
  await win.keyboard.press('Control+y');
  await sleep(150);
  ok(await dpts() === 4, 'Ctrl+Y again: all 4');
  await win.keyboard.press('Backspace');
  await win.keyboard.press('Delete');
  await sleep(150);
  ok(await dpts() === 2, 'Backspace and Delete take back points too');
  await win.keyboard.press('Escape');
  await sleep(150);
  ok(await dpts() === 0 && await win.locator('.drawbar').count() === 0, 'Esc cancels the shape');
  await win.keyboard.press('Control+z');
  await sleep(150);
  ok(await dpts() === 2, 'Ctrl+Z right after Esc brings it back: ' + await dpts());
  ok((await annots()).length === before, 'still nothing taken from the file');
  await win.locator('.drawbar button', { hasText: 'Undo point' }).click();
  await sleep(150);
  ok(await dpts() === 1, 'the bar\'s Undo point');
  await click(250, 100); await click(250, 160);
  await win.locator('.drawbar button', { hasText: 'Finish' }).click();
  await sleep(600);
  let list = await annots();
  const pl = list.find((a) => a.kind === 'measure-polylength');
  ok(pl && pl.vertices.length === 3 && near(pl.vertices[0], [100, 100]) && near(pl.vertices[2], [250, 160]), 'Finish on the bar makes it: ' + JSON.stringify(pl && pl.vertices));
  ok(await win.locator('.drawbar').count() === 0, 'bar gone when finished');
  // Shift+C closes a line back to its start
  await click(100, 300); await click(200, 300); await click(200, 380);
  await win.keyboard.press('Shift+C');
  await sleep(600);
  list = await annots();
  const closed = list.find((a) => a.kind === 'measure-polylength' && a.vertices && near(a.vertices[0], [100, 300]));
  ok(closed && closed.vertices.length === 4 && near(closed.vertices[3], [100, 300]), 'Shift+C: the line goes back to its first point and finishes');
  // Ctrl+Z with no shape being drawn: the file's Undo, as always
  const n1 = (await annots()).length;
  await win.keyboard.press('Control+z');
  await sleep(500);
  ok((await annots()).length === n1 - 1, 'Ctrl+Z after finishing: the file\'s Undo takes the last markup');
  await win.keyboard.press('Control+y');
  await sleep(500);

  // Esc, then something else done: Ctrl+Z is the file's again (the cancelled shape stays gone)
  await click(100, 450); await click(200, 450);
  await win.keyboard.press('Escape');
  await E(() => window.__gcc.active().create(0, { type: 'Square', rect: [600, 480, 650, 520], color: [0, 1, 0], kind: 'rect' }));
  await sleep(300);
  const n2 = (await annots()).length;
  await win.keyboard.press('Control+z');
  await sleep(500);
  ok(await dpts() === 0 && (await annots()).length === n2 - 1, 'Esc, then a markup made: Ctrl+Z undoes that markup, the cancelled shape stays gone');

  // area: Ctrl+Z on corners, then Enter
  await tool('m-area');
  await click(400, 100); await click(500, 100); await click(500, 180); await click(470, 250);
  { const db = await win.locator('.drawbar').boundingBox(), hb = await win.locator('.howbar').boundingBox().catch(() => null); ok(!hb || db.y + db.height <= hb.y || db.y >= hb.y + hb.height, 'the drawing bar sits clear of the Area tool\'s strip'); }
  await win.keyboard.press('Control+z');
  await click(400, 180);
  await win.keyboard.press('Enter');
  await sleep(600);
  list = await annots();
  const ar = list.find((a) => a.kind === 'measure-area');
  ok(ar && ar.vertices.length === 4 && near(ar.vertices[3], [400, 180]), 'area: a corner taken back with Ctrl+Z, drawn on, finished: ' + JSON.stringify(ar && ar.vertices));

  // ---------------------------------------------------------------- corners after placing
  await snapSet(true);
  await tool('select');
  // another markup's corner to snap to
  await E(() => window.__gcc.active().create(0, { type: 'Line', line: [[560, 60], [640, 60]], color: [0, 0, 1], kind: 'line' }));
  await sleep(400);
  await click(450, 100); // the area's top edge: selects it
  await sleep(300);
  let u0 = await undoName();
  // a click on a corner, no drag: nothing changes
  await click(500, 100);
  await sleep(300);
  ok(await undoName() === u0, 'a click on a corner changes nothing (no undo step): ' + await undoName());
  await drag([500, 100], [557, 63]);
  list = await annots();
  let a2 = list.find((a) => a.id === ar.id);
  ok(a2 && near(a2.vertices[1], [560, 60], 0.05), 'a dragged corner snaps to another markup\'s end: ' + JSON.stringify(a2 && a2.vertices[1]));
  // its own other corner: the polyline's last point onto its first
  await click(250, 130);
  await sleep(300);
  await drag([250, 160], [103, 103]);
  list = await annots();
  const pl2 = list.find((a) => a.id === pl.id);
  ok(pl2 && near(pl2.vertices[2], [100, 100], 0.05), 'a dragged corner snaps to its own shape\'s other corner: ' + JSON.stringify(pl2 && pl2.vertices[2]));
  // Shift: the edge straight
  await snapSet(false);
  await click(150, 300);
  await sleep(300);
  await drag([200, 300], [260, 307], ['Shift']);
  list = await annots();
  const c2 = list.find((a) => a.id === closed.id);
  ok(c2 && Math.abs(c2.vertices[1][1] - 300) < 0.3, 'Shift while dragging a corner: the edge stays straight: ' + JSON.stringify(c2 && c2.vertices[1]));
  ok(await undoName() === 'Edit points', 'one undo step "Edit points"');

  // add a corner: drag an edge's middle dot
  await click(450, 140);
  await sleep(300);
  a2 = (await annots()).find((a) => a.id === ar.id);
  ok(await E(() => document.querySelectorAll('.ov .hd.mid').length) === a2.vertices.length, 'a middle dot on every edge of the selected area: ' + await E(() => document.querySelectorAll('.ov .hd.mid').length));
  const m0 = [(a2.vertices[2][0] + a2.vertices[3][0]) / 2, (a2.vertices[2][1] + a2.vertices[3][1]) / 2];
  await drag(m0, [m0[0], m0[1] + 40]);
  a2 = (await annots()).find((a) => a.id === ar.id);
  ok(a2 && a2.vertices.length === 5 && near(a2.vertices[3], [m0[0], m0[1] + 40], 1), 'dragging a middle dot adds a corner there: ' + JSON.stringify(a2 && a2.vertices));
  ok(await undoName() === 'Add corner', 'undo step "Add corner"');
  const lab5 = a2.contents;
  // delete a corner: Alt+click
  { const p = await at(...a2.vertices[3]); await win.keyboard.down('Alt'); await win.mouse.click(p[0], p[1]); await win.keyboard.up('Alt'); await sleep(500); }
  a2 = (await annots()).find((a) => a.id === ar.id);
  ok(a2 && a2.vertices.length === 4, 'Alt+click on a corner deletes it: ' + (a2 && a2.vertices.length));
  ok(a2 && a2.contents !== lab5, 'the area\'s number follows: ' + lab5 + ' -> ' + (a2 && a2.contents));
  // right-click: Add a corner here (on an edge), Delete this corner (on a corner)
  { const p = await at((a2.vertices[0][0] + a2.vertices[1][0]) / 2, a2.vertices[0][1]); await win.mouse.click(p[0], p[1], { button: 'right' }); }
  await sleep(300);
  ok(await win.locator('.cmenu button', { hasText: 'Add a corner here' }).count() === 1, 'right-click on an edge: "Add a corner here"');
  await win.locator('.cmenu button', { hasText: 'Add a corner here' }).click();
  await sleep(500);
  a2 = (await annots()).find((a) => a.id === ar.id);
  ok(a2 && a2.vertices.length === 5, 'a corner added from the menu');
  { const p = await at(...a2.vertices[1]); await win.mouse.click(p[0], p[1], { button: 'right' }); }
  await sleep(300);
  ok(await win.locator('.cmenu button', { hasText: 'Delete this corner' }).count() === 1, 'right-click on a corner: "Delete this corner"');
  await win.locator('.cmenu button', { hasText: 'Delete this corner' }).click();
  await sleep(500);
  a2 = (await annots()).find((a) => a.id === ar.id);
  ok(a2 && a2.vertices.length === 4, 'deleted from the menu');

  // continue a line from its end
  const plNow = (await annots()).find((a) => a.id === pl.id);
  { const p = await at((plNow.vertices[0][0] + plNow.vertices[1][0]) / 2, plNow.vertices[0][1]); await win.mouse.click(p[0], p[1], { button: 'right' }); }
  await sleep(300);
  ok(await win.locator('.cmenu button', { hasText: 'Continue this line' }).count() === 1, 'right-click on a line: "Continue this line"');
  // (from the end nearer the right-click - this line's ends meet: its end)
  await win.locator('.cmenu button', { hasText: 'Continue this line' }).click();
  await sleep(400);
  ok(await dpts() === plNow.vertices.length, 'the line\'s points come into the drawing');
  // (clear of the left panel's edge)
  await click(160, 150);
  await win.keyboard.press('Enter');
  await sleep(600);
  const pl3 = (await annots()).find((a) => a.id === pl.id);
  ok(pl3 && pl3.vertices.length === plNow.vertices.length + 1 && near(pl3.vertices[pl3.vertices.length - 1], [160, 150]) && near(pl3.vertices[0], plNow.vertices[0]), 'continued: the same markup, one point more at its end: ' + JSON.stringify(pl3 && pl3.vertices));
  ok(pl3 && pl3.contents !== plNow.contents, 'and its length follows: ' + plNow.contents + ' -> ' + (pl3 && pl3.contents));
  // continued from its start: right-click near the start
  await tool('select');
  const st = await E(() => window.__gcc.active().create(0, { type: 'PolyLine', vertices: [[400, 300], [500, 300]], color: [0, 0, 1], kind: 'polyline' }));
  await sleep(400);
  await click(450, 300);
  { const p = await at(415, 300); await win.mouse.click(p[0], p[1], { button: 'right' }); }
  await sleep(300);
  await win.locator('.cmenu button', { hasText: 'Continue this line' }).click();
  await sleep(400);
  await click(400, 360);
  await win.keyboard.press('Enter');
  await sleep(600);
  const st2 = (await annots()).find((a) => a.id === st.id);
  ok(st2 && st2.vertices.length === 3 && near(st2.vertices[0], [400, 360]) && near(st2.vertices[2], [500, 300]), 'continued from its start: the new point goes in front: ' + JSON.stringify(st2 && st2.vertices));
  ok(await undoName() === 'Continue line', 'undo step "Continue line"');

  // ---------------------------------------------------------------- one Area tool: area and perimeter
  ok(await win.locator('.ribbon [data-tool="m-perimeter"]').count() === 0, 'no separate Perimeter button: Area gives both');
  const arNow = (await annots()).find((a) => a.id === ar.id);
  ok(/m² · P [\d.]+ m$/.test(arNow.contents), 'an area\'s label gives its perimeter: ' + arNow.contents);
  await tab('Measure');
  await win.locator('.ribbon .rb', { hasText: 'Totals' }).click();
  await sleep(600);
  const tt = await E(() => document.querySelector('.totals')?.textContent || '');
  ok(/Areas: perimeters/.test(tt), 'Totals: the areas\' perimeters added up too');

  // ---------------------------------------------------------------- count: Backspace
  await tool('m-count');
  await click(700, 300); await click(720, 300); await click(740, 300);
  let counts = [];
  // (a slow machine - the end of a long battery - takes its time over each mark)
  for (let i = 0; i < 20 && counts.length < 3; i++) { await sleep(250); counts = (await annots()).filter((a) => a.kind === 'measure-count'); }
  ok(counts.length === 3, '3 counted');
  await win.keyboard.press('Backspace');
  await sleep(500);
  counts = (await annots()).filter((a) => a.kind === 'measure-count');
  ok(counts.length === 2 && !counts.some((c) => /#3$/.test(c.contents)), 'Backspace takes back the last count: ' + counts.map((c) => c.contents).join(', '));
  await click(760, 300);
  await sleep(400);
  counts = (await annots()).filter((a) => a.kind === 'measure-count');
  ok(counts.some((c) => /#3$/.test(c.contents)), 'the next one is #3 again');
  // one taken back with Ctrl+Z (the file's undo): Backspace then takes the one before it
  await win.keyboard.press('Control+z');
  await sleep(500);
  await win.keyboard.press('Backspace');
  await sleep(500);
  counts = (await annots()).filter((a) => a.kind === 'measure-count');
  ok(counts.length === 1 && /#1$/.test(counts[0].contents), 'after a Ctrl+Z, Backspace takes the mark before: ' + counts.map((c) => c.contents).join(', '));
  // quick clicks and Backspace at once: the last mark goes, not the one before it
  await click(700, 340); await click(720, 340); await win.keyboard.press('Backspace');
  for (let i = 0; i < 20; i++) { await sleep(250); counts = (await annots()).filter((a) => a.kind === 'measure-count'); if (counts.length === 2) break; }
  await sleep(500);
  counts = (await annots()).filter((a) => a.kind === 'measure-count');
  const nums = counts.map((c) => c.contents).sort().join(', ');
  ok(nums === 'Count 1 #1, Count 1 #2', 'Backspace right after quick clicks takes the newest mark: ' + nums);

  // ---------------------------------------------------------------- Calibrate: the window moves
  await tool('m-calibrate');
  await click(100, 500); await click(300, 500);
  await until(() => win.locator('.modal', { hasText: 'Calibrate' }).count());
  ok(await win.locator('.scrim.see').count() === 1, 'Calibrate: the page shows through behind it');
  const b0 = await win.locator('.modal').boundingBox();
  const h = await win.locator('.modal h2').boundingBox();
  await win.mouse.move(h.x + 30, h.y + h.height / 2); await win.mouse.down(); await win.mouse.move(h.x + 30 + 250, h.y + h.height / 2 + 180, { steps: 8 }); await win.mouse.up();
  await sleep(200);
  const b1 = await win.locator('.modal').boundingBox();
  ok(Math.abs(b1.x - b0.x - 250) < 3 && Math.abs(b1.y - b0.y - 180) < 3, `the window moves by its title (${Math.round(b1.x - b0.x)}, ${Math.round(b1.y - b0.y)})`);
  // a click beside it doesn't throw it away
  await win.mouse.click(30, 300);
  await sleep(200);
  ok(await win.locator('.modal', { hasText: 'Calibrate' }).count() === 1, 'a click beside it keeps it open');
  await win.locator('.modal input').first().fill('10');
  await win.keyboard.press('Enter');
  await sleep(500);
  ok(await win.locator('.modal', { hasText: 'Calibrate' }).count() === 0, 'set: closes');
  // other dialogs move too
  await win.locator('.statusbar button', { hasText: 'Scale' }).click();
  await until(() => win.locator('.modal').count());
  const s0 = await win.locator('.modal').boundingBox(), sh = await win.locator('.modal h2').boundingBox();
  await win.mouse.move(sh.x + 20, sh.y + 8); await win.mouse.down(); await win.mouse.move(sh.x + 20 - 120, sh.y + 8 + 60, { steps: 5 }); await win.mouse.up();
  const s1 = await win.locator('.modal').boundingBox();
  ok(Math.abs(s1.x - s0.x + 120) < 3, 'other dialogs move by their title too');
  await win.keyboard.press('Escape');
} catch (e) {
  console.log('FAIL exception', e);
  fails++;
}
console.log(`\n${passes} passed, ${fails} failed`);
await Promise.race([app.close(), sleep(4000)]);
try { app.process().kill(); } catch { /* gone */ }
process.exit(fails ? 1 : 0);
