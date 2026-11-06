// Drawing markups as a person makes them: each tool creates the markup where it was drawn, it
// is selected afterwards, can be moved, resized / reshaped, deleted with the Delete key, and
// Ctrl+Z / Ctrl+Y bring it back / take it away again.  xvfb-run -a node tests/e2e-draw.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-draw');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const d = new mupdf.PDFDocument();
const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
let cs = '';
for (let i = 0; i < 6; i++) cs += `BT /F1 12 Tf 60 ${780 - i * 20} Td (Line ${i + 1} of the specification text for highlighting) Tj ET `;
d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, cs));
const FILE = join(TMP, 'draw.pdf');
writeFileSync(FILE, d.saveToBuffer('').asUint8Array());
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-draw'), { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, shotN = 0;
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=draw', FILE] });
const win = await app.firstWindow();
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) { fails++; void win.screenshot({ path: join(TMP, `fail-${++shotN}.png`) }).catch(() => {}); } return c; };
win.on('console', (m) => { if (m.text().startsWith('DBG')) console.log(m.text()); });
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await win.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 1, null, { timeout: 60000 });
await sleep(800);
await win.evaluate(() => window.__gcc.viewer().fit('page'));
await sleep(600);
const E = (fn, a) => win.evaluate(fn, a);
const annots = () => E(async () => (await window.__gcc.active().annots(0)).map((a) => ({ id: a.id, type: a.type, kind: a.kind, rect: a.rect, box: a.box, line: a.line, vertices: a.vertices, ink: a.ink, quads: a.quads, cloudy: a.cloudy, contents: a.contents })));
const at = async (x, y) => { const b = await win.locator('.pg[data-page="0"]').boundingBox(); const k = b.width / 595; return [b.x + x * k, b.y + y * k]; };
async function drag(a, b, steps = 10) { const p = await at(...a), q = await at(...b); await win.mouse.move(...p); await win.mouse.down(); await win.mouse.move(...q, { steps }); await win.mouse.up(); }
async function click(a) { await win.mouse.click(...(await at(...a))); }
const pickTool = async (label, tab = 'Comment') => { await win.locator('.rtab', { hasText: tab }).click(); await win.locator('.ribbon .rb', { hasText: new RegExp('^\\s*' + label + '\\s*$') }).first().click(); };
const near = (a, b, t = 3) => Math.abs(a - b) <= t;
const selCount = () => E(() => document.querySelectorAll('.selbox').length);
const box = (a) => { if (a.quads?.length) { const p = a.quads.flatMap((q) => [[q[0], q[1]], [q[6], q[7]]]); return [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))]; } if (a.ink) { const p = a.ink.flat(); return [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))]; } return a.box || a.rect; };
const newest = async (n0) => { for (let i = 0; i < 40; i++) { const l = await annots(); if (l.length > n0) { await sleep(250); return (await annots())[l.length - 1]; } await sleep(100); } return null; };
const deselect = async () => { await win.keyboard.press('Escape'); await win.keyboard.press('Escape'); await sleep(150); };

/** the common checks: selected after making it, moves, Delete, undo, redo */
async function common(name, a, grab) {
  await sleep(300);
  ok((await selCount()) === 1, `${name}: selected once made`);
  const b0 = box(a);
  await drag(grab, [grab[0] + 40, grab[1] + 30]);
  await sleep(500);
  const m = (await annots()).find((x) => x.id === a.id);
  const b1 = m && box(m);
  ok(m && near(b1[0] - b0[0], 40) && near(b1[1] - b0[1], 30), `${name}: moves with the mouse (${b0.map(Math.round)} -> ${b1?.map(Math.round)})`);
  await win.keyboard.press('Delete');
  await sleep(400);
  ok(!(await annots()).some((x) => x.id === a.id), `${name}: Delete removes it`);
  await win.keyboard.press('Control+z');
  await sleep(500);
  ok((await annots()).some((x) => x.id === a.id), `${name}: Ctrl+Z brings it back`);
  await win.keyboard.press('Control+y');
  await sleep(500);
  ok(!(await annots()).some((x) => x.id === a.id), `${name}: Ctrl+Y removes it again`);
  await deselect();
}

// ---------------------------------------------------------------- rectangle, ellipse, area highlight, cloud? (rect gesture)
for (const [label, type] of [['Rectangle', 'Square'], ['Ellipse', 'Circle'], ['Area highlight', 'Highlight']]) {
  const n0 = (await annots()).length;
  await pickTool(label);
  if (process.env.DBG) { await win.mouse.move(...(await at(100, 300))); await sleep(400); console.log('DBG', label, JSON.stringify(await annots()), await E(() => document.querySelector('.snapmark, .snap')?.outerHTML?.slice(0, 300))); }
  await drag([100, 300], [220, 380]);
  const a = await newest(n0);
  if (!ok(a && a.type === type, `${label}: made (${a?.type})`)) continue;
  const b = box(a);
  // (stays in the tool: Escape, then click it)
  if (label === 'Area highlight') { await win.keyboard.press('Escape'); await sleep(150); await click([160, 340]); await sleep(300); }
  ok(near(b[0], 100, 3) && near(b[1], 300, 3) && near(b[2], 220, 3) && near(b[3], 380, 3), `${label}: where it was drawn (${b.map(Math.round)})`);
  // resize by the bottom-right handle
  const k = (await win.locator('.pg[data-page="0"]').boundingBox()).width / 595;
  const hp = 7 / k; // the handles sit a few px outside the box
  await drag([b[2] + hp, b[3] + hp], [b[2] + 30 + hp, b[3] + 20 + hp]);
  await sleep(500);
  const r = (await annots()).find((x) => x.id === a.id);
  const rb = r && box(r);
  ok(r && near(rb[2], b[2] + 30) && near(rb[3], b[3] + 20) && near(rb[0], b[0]) && near(rb[1], b[1]), `${label}: resizes from the corner (${b.map(Math.round)} -> ${rb?.map(Math.round)})`);
  await common(label, r || a, [(rb[0] + rb[2]) / 2, rb[1] + 1]);
}

// ---------------------------------------------------------------- line, arrow (drag)
for (const label of ['Line', 'Arrow']) {
  const n0 = (await annots()).length;
  await pickTool(label);
  await drag([100, 450], [260, 520]);
  const a = await newest(n0);
  if (!ok(a && a.type === 'Line', `${label}: made`)) continue;
  ok(near(a.line[0][0], 100) && near(a.line[0][1], 450) && near(a.line[1][0], 260) && near(a.line[1][1], 520), `${label}: ends where drawn (${JSON.stringify(a.line.map((p) => p.map(Math.round)))})`);
  // drag its end
  await drag(a.line[1], [300, 500]);
  await sleep(500);
  const r = (await annots()).find((x) => x.id === a.id);
  ok(r && near(r.line[1][0], 300) && near(r.line[1][1], 500) && near(r.line[0][0], 100), `${label}: end can be dragged (${JSON.stringify(r?.line.map((p) => p.map(Math.round)))})`);
  await common(label, r, [200, 450 + (500 - 450) * (100 / 200)]);
}

// ---------------------------------------------------------------- polyline, polygon, cloud (clicks)
for (const [label, type] of [['Polyline', 'PolyLine'], ['Polygon', 'Polygon'], ['Cloud', 'Polygon']]) {
  const n0 = (await annots()).length;
  await pickTool(label);
  await click([100, 600]); await sleep(120);
  await click([200, 600]); await sleep(120);
  await click([200, 680]); await sleep(120);
  if (type === 'Polygon') await click([100, 600]);
  else { const p = await at(150, 700); await win.mouse.dblclick(...p); }
  await sleep(500);
  const a = await newest(n0);
  if (!ok(a && a.type === type, `${label}: made (${a?.type})`)) { await deselect(); continue; }
  const want = type === 'Polygon' ? 3 : 4;
  ok(a.vertices.length === want, `${label}: ${a.vertices.length} corners (wanted ${want}) ${JSON.stringify(a.vertices.map((p) => p.map(Math.round)))}`);
  ok(near(a.vertices[0][0], 100) && near(a.vertices[0][1], 600) && near(a.vertices[1][0], 200), `${label}: corners where clicked`);
  if (label === 'Cloud') ok(a.cloudy > 0, 'Cloud: cloudy border');
  // drag a corner
  await drag(a.vertices[1], [230, 590]);
  await sleep(500);
  const r = (await annots()).find((x) => x.id === a.id);
  ok(r && near(r.vertices[1][0], 230) && near(r.vertices[1][1], 590), `${label}: corner can be dragged`);
  await common(label, r, [150, 600]);
}

// ---------------------------------------------------------------- pencil
{
  const n0 = (await annots()).length;
  await pickTool('Pencil');
  const p = await at(320, 300);
  await win.mouse.move(...p); await win.mouse.down();
  for (let i = 1; i <= 20; i++) { const q = await at(320 + i * 5, 300 + Math.sin(i / 3) * 20); await win.mouse.move(...q); }
  await win.mouse.up();
  await sleep(1400);
  const a = await newest(n0);
  if (ok(a && a.type === 'Ink', `Pencil: made (${a?.type})`)) {
    const b = box(a);
    ok(near(b[0], 320, 4) && near(b[2], 420, 4), `Pencil: where drawn (${b.map(Math.round)})`);
    await win.keyboard.press('Escape');
    await click([370, 300 + Math.sin(10 / 3) * 20]);
    await common('Pencil', a, [370, 300 + Math.sin(10 / 3) * 20]);
  }
}

// ---------------------------------------------------------------- highlight / underline over text
for (const [label, type] of [['Highlight', 'Highlight'], ['Underline', 'Underline']]) {
  const n0 = (await annots()).length;
  await pickTool(label);
  // the text line "Line 2 ..." sits at y = 842 - 760 = 82 (baseline) in page space
  await drag([62, 78], [200, 78]);
  await sleep(500);
  const a = await newest(n0);
  if (!ok(a && a.type === type, `${label}: made over the text (${a?.type})`)) { await deselect(); continue; }
  ok(a.quads?.length >= 1 && near(a.quads[0][1], 70, 6), `${label}: on the right line (${a.quads?.[0]?.map(Math.round)})`);
  await deselect();
  await click([100, 76]);
  await sleep(300);
  ok((await selCount()) === 1, `${label}: click selects it`);
  await win.keyboard.press('Delete');
  await sleep(400);
  ok(!(await annots()).some((x) => x.id === a.id), `${label}: Delete removes it`);
  await deselect();
}

// ---------------------------------------------------------------- note
{
  const n0 = (await annots()).length;
  await pickTool('Comment');
  await click([480, 200]);
  await sleep(700);
  const a = await newest(n0);
  ok(a && a.type === 'Text', `Note: made (${a?.type})`);
  ok(a && near(a.rect[0], 480, 3) && near(a.rect[1], 200, 3), `Note: where clicked (${a?.rect.map(Math.round)})`);
  await deselect();
}

// ---------------------------------------------------------------- copy / paste / duplicate
{
  await E(() => window.__gcc.active().create(0, { type: 'Square', rect: [300, 600, 380, 660], color: [1, 0, 0], bw: 2 }));
  await sleep(500);
  await click([340, 600]);
  await sleep(300);
  const n0 = (await annots()).length;
  await win.keyboard.press('Control+c');
  await win.keyboard.press('Control+v');
  await sleep(700);
  let l = await annots();
  ok(l.length === n0 + 1 && near(box(l[l.length - 1])[0], 312) && near(box(l[l.length - 1])[1], 612), `Ctrl+C, Ctrl+V: a copy a little further (${box(l[l.length - 1]).map(Math.round)})`);
  ok((await selCount()) === 1, 'the copy is selected');
  await win.keyboard.press('Control+d');
  await sleep(700);
  l = await annots();
  ok(l.length === n0 + 2 && near(box(l[l.length - 1])[0], 324), 'Ctrl+D duplicates ' + JSON.stringify(l.map((a) => box(a).map(Math.round))) + ' sel ' + (await selCount()));
  // right-click elsewhere: paste here
  const p = await at(450, 500);
  await win.keyboard.press('Escape');
  await win.mouse.click(...p, { button: 'right' });
  await sleep(300);
  await win.locator('.cmenu button', { hasText: 'Paste markups here' }).click({ timeout: 3000 });
  await sleep(700);
  l = await annots();
  ok(l.length === n0 + 3 && near(box(l[l.length - 1])[0], 450) && near(box(l[l.length - 1])[1], 500), `paste at the right-clicked point (${box(l[l.length - 1]).map(Math.round)})`);
  await win.keyboard.press('Control+z');
  await sleep(500);
  ok((await annots()).length === n0 + 2, 'undo removes the paste');
}

await win.screenshot({ path: join(TMP, 'final.png') });
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
