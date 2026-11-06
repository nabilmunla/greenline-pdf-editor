// Measurement numbers (0.6): decimals set before measuring (tool panel) and after (selected
// markups), unit, number size per markup and for the whole file, and the automatic size that
// follows the zoom you measure at. xvfb-run -a node tests/e2e-measure.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TMP = resolve('tests/tmp-measure');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'sheet.pdf');
copyFileSync('tests/data/long-spec.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-measure'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=measure'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
const E = (fn, a) => win.evaluate(fn, a);
const annots = () => E(async () => window.__gcc.active().allAnnots());
const at = async (page, x, y) => {
  const box = await win.locator(`.pg[data-page="${page}"]`).boundingBox();
  const w = await E((p) => window.__gcc.active().pages[p].w, page);
  const k = box.width / w;
  return [box.x + x * k, box.y + y * k];
};
const tab = (name) => win.locator('.rtab', { hasText: new RegExp('^' + name + '$') }).click();
const lengths = async () => (await annots()).filter((a) => a.kind === 'measure-length');
async function measure(page, a, b) {
  const p1 = await at(page, ...a), p2 = await at(page, ...b);
  await win.mouse.click(p1[0], p1[1]);
  await sleep(120);
  await win.mouse.move(p2[0], p2[1], { steps: 5 });
  await win.mouse.click(p2[0], p2[1]);
}

await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
await until(() => E(() => window.__gcc.active()?.pages.length > 0), 30000, 'open');
await E(() => window.__gcc.viewer().setZoom(1));
await sleep(800);
// scale 1:100
await win.locator('.statusbar button', { hasText: 'Scale' }).click();
await win.locator('.modal .chip', { hasText: /^1:100$/ }).first().click();
await until(() => win.locator('.statusbar button', { hasText: '1:100' }).count(), 5000, 'scale');
await tab('Measure');
// snapping off: exact points
if (await win.locator('.ribbon .rb', { hasText: 'Snap on' }).count()) await win.locator('.ribbon .rb', { hasText: 'Snap on' }).click();
await win.locator('.ribbon [data-tool="m-length"]').first().click();
await sleep(300);

// 1. default: 3 decimals in metres
await measure(0, [100, 400], [300, 400]); // 200 pt at 1:100 = 7.056 m
let L = await until(async () => { const l = await lengths(); return l.length === 1 ? l : null; }, 8000, 'first length');
ok(/^7\.056 m$/.test(L[0].contents), 'default 3 decimals: ' + L[0].contents);
const size100 = L[0].labelSize;

// 2. while measuring: the tool panel's decimals
await win.keyboard.press('Escape'); // (deselect - the tool's own settings show)
await win.locator('.ribbon [data-tool="m-length"]').first().click();
await sleep(300);
const toolM = win.locator('.props select[title="Decimals in metres"]');
ok(await toolM.count() === 1, 'decimals offered in the tool panel');
await toolM.selectOption('1');
await sleep(200);
await measure(0, [100, 450], [300, 450]);
L = await until(async () => { const l = await lengths(); return l.length === 2 ? l : null; }, 8000, 'second length');
const second = L.find((a) => Math.abs(a.line[0][1] - 450) < 2);
ok(second.contents === '7.1 m', 'measured with 1 decimal: ' + second.contents);

// 3. after measuring: the selected markup's decimals and unit
await win.keyboard.press('Escape');
await win.keyboard.press('Escape');
await sleep(200);
{ const [cx, cy] = await at(0, 200, 450); await win.mouse.click(cx, cy); }
await until(() => win.locator('.props select[title="Decimals in metres"]').count(), 5000, 'props decimals');
await win.locator('.props select[title="Decimals in metres"]').selectOption('2');
let s2 = await until(async () => (await lengths()).find((a) => a.id === second.id && a.contents === '7.06 m'), 8000, 'after: 2 decimals');
ok(!!s2, 'changed after measuring: 7.06 m');
await win.locator('.props select').filter({ has: win.locator('option[value="mm"]') }).first().selectOption('mm');
s2 = await until(async () => (await lengths()).find((a) => a.id === second.id && /mm$/.test(a.contents)), 8000, 'mm');
ok(s2.contents === '7056 mm', 'unit mm, no decimals: ' + s2.contents);
// a label typed by hand is left alone
await E(async (id) => { const d = window.__gcc.active(); const a = (await d.allAnnots()).find((x) => x.id === id); await d.update([{ page: a.page, id, patch: { contents: 'Wall W1' } }]); }, second.id);
await win.locator('.props select[title="Decimals in millimetres"]').selectOption('1');
await sleep(800);
ok((await lengths()).find((a) => a.id === second.id).contents === 'Wall W1', 'a typed label is not overwritten');

// 4. number size: this markup, then the whole file
await win.locator('.props select').filter({ has: win.locator('option', { hasText: '24 pt' }) }).first().selectOption('24');
await until(async () => (await lengths()).find((a) => a.id === second.id && a.labelSize === 24), 8000, 'label 24');
ok(true, 'number size of one markup: 24 pt');
await win.keyboard.press('Escape');
const before = await lengths();
await win.locator('.ribbon select[title^="Size of the measurement numbers"]').selectOption('2');
await until(async () => (await lengths()).every((a) => Math.abs(a.labelSize - Math.min(72, before.find((b) => b.id === a.id).labelSize * 2)) < 0.11), 10000, 'file x2');
ok(true, 'whole file: every number twice as big');
ok(await E(() => window.__gcc.active().data.labelK) === 2, 'file setting kept (labelK 2)');

// 5. automatic size follows the zoom you measure at (and the file setting)
await win.locator('.ribbon [data-tool="m-length"]').first().click();
await E(() => window.__gcc.viewer().setZoom(4));
await sleep(500);
await E(() => window.__gcc.viewer().goTo(0, [80, 480, 240, 560]));
await sleep(800);
await measure(0, [100, 500], [140, 500]);
L = await until(async () => { const l = await lengths(); return l.length === 3 ? l : null; }, 8000, 'zoomed length');
const z4 = L.find((a) => Math.abs(a.line[0][1] - 500) < 2);
ok(z4.labelSize < size100 * 2 * 0.5, `zoomed in 4x: smaller number on the sheet (${z4.labelSize} pt vs ${size100 * 2} pt at 100%)`);
ok(Math.abs(z4.labelSize - Math.round((14 / 4) * 2 * 10) / 10) < 0.6, 'size = 14 pt / zoom x file setting: ' + z4.labelSize);
ok(Math.abs(z4.bw - 0.25) < 0.02, `its line drawn for that zoom (not the file's number size): ${z4.bw} pt = the tool's 1 pt / 4`);
await E(() => window.__gcc.viewer().setZoom(4));
await sleep(1200);
const shot = join(TMP, 'zoomed-length.png');
const pb = await at(0, 100, 500);
await win.screenshot({ path: shot, clip: { x: Math.max(0, pb[0] - 40), y: Math.max(0, pb[1] - 120), width: 760, height: 240 } });
console.log('(look: ' + shot + ')');

// 6. saved and opened again: formats and the file setting are still there
await win.keyboard.press('Escape');
await win.keyboard.press('Control+s');
await until(() => E(() => !window.__gcc.active().dirty), 30000, 'saved');
await win.keyboard.press('Control+w');
await until(() => E(() => window.__gcc.docs().length === 0), 15000, 'closed');
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
await until(() => E(() => window.__gcc.active()?.pages.length > 0), 30000, 'reopen');
await sleep(800);
const back = await lengths();
ok(back.find((a) => a.id === second.id || a.contents === 'Wall W1')?.fmt?.unit === 'mm', 'reopened: the unit choice is kept');
ok(await E(() => window.__gcc.active().data.labelK) === 2, 'reopened: number size of the file kept');

// 7. separate X and Y scales: across 1:100, up-down 1:20 (a long section)
await win.locator('.statusbar button', { hasText: 'Scale' }).click();
await win.locator('.modal .seg button', { hasText: 'Across (X)' }).click();
await win.locator('.modal .chip', { hasText: /^1:100$/ }).first().click();
await until(() => win.locator('.modal .seg button.on', { hasText: 'Up-down (Y)' }).count(), 5000, 'Y next');
await win.locator('.modal .chip', { hasText: /^1:20$/ }).first().click();
await until(() => win.locator('.statusbar button', { hasText: 'X 1:100 · Y 1:20' }).count(), 5000, 'X/Y shown');
ok(true, 'status bar: X 1:100 · Y 1:20');
await win.locator('.ribbon [data-tool="m-length"]').first().click();
await E(() => window.__gcc.viewer().setZoom(1));
await sleep(500);
await E(() => window.__gcc.viewer().goTo(0));
await sleep(500);
const n0 = (await lengths()).length;
await measure(0, [500, 200], [500, 300]); // 100 pt up-down at 1:20 = 0.706 m
await measure(0, [100, 650], [200, 650]); // 100 pt across at 1:100 = 3.528 m
const xy = await until(async () => { const l = await lengths(); return l.length === n0 + 2 ? l : null; }, 8000, 'x/y lengths');
const vert = xy.find((a) => Math.abs(a.line[0][0] - 500) < 2 && Math.abs(a.line[1][0] - 500) < 2);
const horiz = xy.find((a) => Math.abs(a.line[0][1] - 650) < 2);
ok(vert?.contents === '706 mm', 'up-down uses Y 1:20: ' + vert?.contents);
ok(horiz?.contents === '3.5 m', 'across uses X 1:100 (tool set to 1 decimal earlier): ' + horiz?.contents);

// 8. Rectangle area (0.8.4): drag from corner to corner, or click the two corners; Shift = a square.
// Still X 1:100 · Y 1:20 here: width at X, height at Y.
const areas = async () => (await annots()).filter((a) => a.kind === 'measure-area');
const PT = 0.0254 / 72;
// (0.8.5: the Area tool drawing rectangles - R while it is the tool)
await win.locator('.ribbon [data-tool="m-area"]').first().click();
await sleep(200);
await win.keyboard.press('r');
await sleep(200);
ok(await win.locator('.howbar button.on', { hasText: 'Rectangle' }).count() === 1, 'R: the Area tool draws rectangles (the strip says so)');
await E(() => window.__gcc.viewer().setZoom(1));
await sleep(400);
await E(() => window.__gcc.viewer().goTo(0));
await sleep(600);
ok(/Drag from one corner/.test(await win.locator('.statusbar').textContent()), 'the tool says what to do');
{
  const p1 = await at(0, 100, 560), p2 = await at(0, 300, 640);
  await win.mouse.move(p1[0], p1[1]);
  await win.mouse.down();
  await win.mouse.move(p2[0], p2[1], { steps: 8 });
  ok(/× .* = .*m²/.test(await win.locator('.vtip').textContent().catch(() => '')), 'while dragging: width × height = area: ' + await win.locator('.vtip').textContent().catch(() => '(no tip)'));
  await win.mouse.up();
}
let A = await until(async () => { const l = await areas(); return l.length === 1 ? l : null; }, 8000, 'dragged area');
const want1 = ((200 * 100 * PT) * (80 * 20 * PT)).toFixed(2) + ' m²';
// (an area's label gives its perimeter too - 0.8.9)
const areaPart = (t) => String(t || '').split(' · P ')[0];
ok(areaPart(A[0].contents) === want1 && / · P [\d.]+ m$/.test(A[0].contents) && A[0].vertices?.length === 4 && A[0].type === 'Polygon', `dragged: an Area measurement (4 corners) of ${A[0].contents} (want ${want1})`);
// clicked: the two corners (snapping off)
await measure(0, [350, 560], [450, 610]);
A = await until(async () => { const l = await areas(); return l.length === 2 ? l : null; }, 8000, 'clicked area');
const a2 = A.find((a) => Math.abs(a.vertices[0][0] - 350) < 2);
const want2 = ((100 * 100 * PT) * (50 * 20 * PT)).toFixed(2) + ' m²';
ok(areaPart(a2?.contents) === want2, `clicked corners: ${a2?.contents} (want ${want2})`);
// Shift: a square on the paper
{
  const p1 = await at(0, 100, 440), p2 = await at(0, 160, 480);
  await win.mouse.move(p1[0], p1[1]);
  await win.mouse.down();
  await win.keyboard.down('Shift');
  await win.mouse.move(p2[0], p2[1], { steps: 6 });
  await win.mouse.up();
  await win.keyboard.up('Shift');
}
A = await until(async () => { const l = await areas(); return l.length === 3 ? l : null; }, 8000, 'square');
const sq = A.find((a) => Math.abs(a.vertices[0][1] - 440) < 2);
const w = Math.abs(sq.vertices[1][0] - sq.vertices[0][0]), h = Math.abs(sq.vertices[2][1] - sq.vertices[1][1]);
ok(Math.abs(w - h) < 0.5 && w > 55, `Shift: square on the sheet (${w.toFixed(1)} x ${h.toFixed(1)} pt)`);
// undo takes one away
await win.keyboard.press('Control+z');
await until(async () => (await areas()).length === 2, 8000, 'undo');
ok(true, 'Ctrl+Z: one undo step');
// a first click that slips a few pixels is still a click: the second click finishes it
{
  const p1 = await at(0, 350, 450), p1b = [p1[0] + 3, p1[1] + 1], p2 = await at(0, 420, 500);
  await win.mouse.move(p1[0], p1[1]);
  await win.mouse.down();
  await win.mouse.move(p1b[0], p1b[1], { steps: 2 });
  await win.mouse.up();
  await sleep(150);
  await win.mouse.move(p2[0], p2[1], { steps: 4 });
  await win.mouse.click(p2[0], p2[1]);
}
A = await until(async () => { const l = await areas(); return l.length === 3 ? l : null; }, 8000, 'slipped click');
const slip = A.find((a) => Math.abs(a.vertices[0][0] - 350) < 4 && Math.abs(a.vertices[0][1] - 450) < 4);
ok(slip && Math.abs(slip.vertices[2][0] - 420) < 2 && Math.abs(slip.vertices[2][1] - 500) < 2, 'a slipped first click: still a two-click rectangle (no speck made): ' + JSON.stringify(slip?.vertices));
// Shift near the page's edge: the square stops at the edge
{
  const W = await E(() => window.__gcc.active().pages[0].w);
  const p1 = await at(0, W - 30, 300), p2 = await at(0, W + 40, 380);
  await win.mouse.move(p1[0], p1[1]);
  await win.mouse.down();
  await win.keyboard.down('Shift');
  await win.mouse.move(p2[0], p2[1], { steps: 6 });
  await win.mouse.up();
  await win.keyboard.up('Shift');
  A = await until(async () => { const l = await areas(); return l.length === 4 ? l : null; }, 8000, 'edge square');
  const e = A.find((a) => Math.abs(a.vertices[0][1] - 300) < 2);
  ok(e && Math.max(...e.vertices.map((v) => v[0])) <= W + 0.5, 'Shift by the edge: the square stays on the page: ' + JSON.stringify(e?.vertices.map((v) => v.map(Math.round))));
  await win.keyboard.press('Control+z');
  await until(async () => (await areas()).length === 3, 8000, 'undo edge');
}

// 9. To Excel: the number as a number, the unit in its own cell, the label beside them
const XL = join(TMP, 'measurements.xlsx');
await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, XL);
await win.locator('.ribbon .rb', { hasText: 'To Excel' }).click();
await until(async () => existsSync(XL), 15000, 'xlsx');
await sleep(400);
const rows = JSON.parse(execFileSync('python3', ['-c', `
import openpyxl, json, sys
ws = openpyxl.load_workbook(sys.argv[1]).worksheets[0]
print(json.dumps([[c.value for c in r] + [c.number_format for c in r] for r in ws.iter_rows()]))`, XL]).toString());
const head = rows[0].slice(0, 10);
ok(JSON.stringify(head) === JSON.stringify(['Page', 'Type', 'Value', 'Unit', 'Perimeter', 'Unit', 'Label on the drawing', 'Count group', 'Author', 'Date']), 'columns: ' + JSON.stringify(head));
const F0 = 10; // (each row: its 10 values, then their number formats)
const body = rows.slice(1);
const ar = body.filter((r) => r[3] === 'm²');
ok(ar.length === 3 && ar.every((r) => typeof r[2] === 'number') && ar.some((r) => r[2] === Number(want1.split(' ')[0]) && areaPart(r[6]) === want1), 'areas: numbers in Value, "m²" in Unit, the label beside: ' + JSON.stringify(ar.map((r) => r.slice(2, 7))));
ok(ar.every((r) => typeof r[4] === 'number' && r[4] > 0 && r[5] === 'm'), 'areas: their perimeter in its own columns: ' + JSON.stringify(ar.map((r) => r.slice(4, 6))));
ok(ar.every((r) => r[F0 + 2] === '#,##0.00'), 'shown with the decimals the drawing shows (2): ' + ar.map((r) => r[F0 + 2]).join(', '));
const ln = body.filter((r) => r[3] === 'm' || r[3] === 'mm');
ok(ln.length >= 4 && ln.every((r) => typeof r[2] === 'number'), 'lengths: numbers, unit apart (' + ln.map((r) => r[2] + ' ' + r[3]).join(', ') + ')');
const sill = body.find((r) => r[6] === '706 mm');
ok(sill && sill[2] === 0.706 && sill[3] === 'm' && sill[F0 + 2] === '#,##0.000', 'a length shown in mm only because it is under a metre: in metres (0.706 m), so the lengths add up: ' + JSON.stringify(sill?.slice(2, 7)));
const typed = body.find((r) => r[6] === 'Wall W1');
ok(typed && typeof typed[2] === 'number' && (typed[3] === 'm' || typed[3] === 'mm'), 'a label typed by hand ("Wall W1"): the measured number and unit still there: ' + JSON.stringify(typed?.slice(2, 5)));
ok(!body.some((r) => typeof r[2] === 'string' && /\d/.test(r[2])), 'no number left as text in Value');
// the Comments list's Excel: measurements get their number and unit too
const XL2 = join(TMP, 'comments.xlsx');
await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, XL2);
await win.locator('.rail-btn[title="Comments list"]').click();
await until(() => win.locator('.cm-foot button', { hasText: 'Excel' }).count(), 5000, 'comments panel');
await win.locator('.cm-foot button', { hasText: 'Excel' }).click();
await until(async () => existsSync(XL2), 15000, 'comments xlsx');
await sleep(400);
const crows = JSON.parse(execFileSync('python3', ['-c', `
import openpyxl, json, sys
ws = openpyxl.load_workbook(sys.argv[1]).worksheets[0]
print(json.dumps([[c.value for c in r] for r in ws.iter_rows()]))`, XL2]).toString());
ok(JSON.stringify(crows[0].slice(0, 5)) === JSON.stringify(['Page', 'Type', 'Comment', 'Value', 'Unit']), 'comments list Excel: Value and Unit after the comment: ' + JSON.stringify(crows[0]));
const cm = crows.slice(1).filter((r) => r[4]);
ok(cm.length >= 8 && cm.every((r) => typeof r[3] === 'number'), 'comments list Excel: every measurement with a number and unit: ' + cm.map((r) => r[3] + ' ' + r[4]).join(', '));

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
