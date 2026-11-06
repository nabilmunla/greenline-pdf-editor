// Measuring the 0.8.5 way (from the Estimation app's take-off): Area / Perimeter drawn as corners,
// a rectangle or a circle (P / R / O, the strip at the foot of the page), a circle measured as
// the circle with one handle for its size, rectangles that keep their square corners when a
// corner is dragged (Alt: free), lengths typed while measuring, and the Counts & totals panel.
// xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-measure085.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';

const TMP = resolve('tests/tmp-measure085');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'sheet.pdf');
copyFileSync('tests/data/long-spec.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-measure085'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else { fails++; void win.screenshot({ path: join(TMP, `fail-${fails}.png`) }).catch(() => {}); } return c; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=measure085'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
const E = (fn, a) => win.evaluate(fn, a);
const annots = () => E(async () => window.__gcc.active().allAnnots());
const at = async (page, x, y) => {
  const box = await win.locator(`.pg[data-page="${page}"]`).boundingBox();
  const w = await E((p) => window.__gcc.active().pages[p].w, page);
  const k = box.width / w;
  return [box.x + x * k, box.y + y * k];
};
const click = async (page, x, y, opt) => { const p = await at(page, x, y); await win.mouse.click(p[0], p[1], opt); };
const tab = (name) => win.locator('.rtab', { hasText: new RegExp('^' + name + '$') }).click();
const tool = async (id) => {
  if (id === 'select') { await win.locator('.viewer').focus(); await win.keyboard.press('v'); await sleep(250); return; }
  await win.locator(`.ribbon [data-tool="${id}"]`).first().click(); await sleep(250);
};
const scaleK = () => E(() => window.__gcc.active().scaleAt(0, 100, 100));
const fixed = (v, d) => v.toFixed(d);

await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
await until(() => E(() => window.__gcc.active()?.pages.length > 0), 30000, 'open');
await E(() => window.__gcc.viewer().setZoom(1));
await sleep(800);
// scale 1:100 on this page
await win.locator('.statusbar button', { hasText: 'Scale' }).click();
await win.locator('.modal .chip', { hasText: /^1:100$/ }).first().click();
await until(() => win.locator('.statusbar button', { hasText: '1:100' }).count(), 5000, 'scale');
const sc = await scaleK();
const K = sc.k;
await tab('Measure');
if (await win.locator('.ribbon .rb', { hasText: 'Snap on' }).count()) await win.locator('.ribbon .rb', { hasText: 'Snap on' }).click();
ok(await win.locator('.ribbon [data-tool="m-rectarea"]').count() === 0, 'no separate Rectangle area button: the Area tool draws rectangles');

// ---------------------------------------------------------------- the strip and its keys
await tool('m-area');
ok(await win.locator('.howbar').count() === 1, 'Area: the "Draw as" strip shows');
ok(await win.locator('.howbar button.on', { hasText: 'Corners' }).count() === 1, 'corners to start with');
await win.keyboard.press('o');
await sleep(200);
ok(await win.locator('.howbar button.on', { hasText: 'Circle' }).count() === 1, 'O: circle');
ok(await E(() => document.querySelector('.ribbon [data-tool="m-area"]')?.classList.contains('on')), 'still the Area tool (O did not pick another tool)');
ok(/middle/.test(await win.locator('.statusbar').textContent()), 'the status line says how: ' + (await win.locator('.statusbar').textContent()).slice(0, 80));

// ---------------------------------------------------------------- a circle area
const areas = async () => (await annots()).filter((a) => a.kind === 'measure-area');
{
  const c = await at(0, 300, 300), e = await at(0, 350, 300);
  await win.mouse.click(c[0], c[1]);
  await win.mouse.move(e[0], e[1], { steps: 6 });
  const tip = await win.locator('.vtip').textContent().catch(() => '');
  ok(/^r .* · .*m²/.test(tip), 'while drawing: radius and area: ' + tip);
  await win.mouse.click(e[0], e[1]);
}
let A = await until(async () => { const l = await areas(); return l.length === 1 ? l : null; }, 8000, 'circle');
const r1 = 50 * K, want1 = fixed(Math.PI * r1 * r1, 2) + ' m²';
// (an area's label gives its perimeter too - 0.8.9)
const areaPart = (t) => String(t || '').split(' · P ')[0], perimPart = (t) => String(t || '').split(' · P ')[1] || '';
ok(areaPart(A[0].contents) === want1 && perimPart(A[0].contents) === fixed(2 * Math.PI * r1, 3) + ' m', `circle area = pi r² (r ${r1.toFixed(3)} m), perimeter 2 pi r = pi r² (r ${r1.toFixed(3)} m): ${A[0].contents} (want ${want1})`);
ok(A[0].vertices.length === 128 && A[0].type === 'Polygon', 'drawn as a 128-corner outline (other programs show the circle)');
// its one handle: the size
await tool('select');
await click(0, 300, 330);
await sleep(300);
ok(await win.locator('.hd.v').count() === 1, 'selected: one handle (not 128): ' + await win.locator('.hd.v').count());
{
  const h = await win.locator('.hd.v').first().boundingBox();
  const to = await at(0, 370, 300);
  await win.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await win.mouse.down();
  await win.mouse.move(to[0], to[1], { steps: 8 });
  await win.mouse.up();
}
A = await until(async () => { const l = await areas(); return l[0] && areaPart(l[0].contents) !== want1 ? l : null; }, 8000, 'circle resized');
const r2 = 70 * K, want2 = fixed(Math.PI * r2 * r2, 2) + ' m²';
ok(Math.abs(Number(A[0].contents.split(' ')[0]) - Math.PI * r2 * r2) < 0.05, `the handle made it bigger: ${A[0].contents} (about ${want2})`);
ok(A[0].vertices.length === 128, 'still a circle of 128 corners');
await win.keyboard.press('Control+z');
A = await until(async () => { const l = await areas(); return areaPart(l[0]?.contents) === want1 ? l : null; }, 8000, 'undo resize');
ok(true, 'Ctrl+Z: back to the first size');
await win.keyboard.press('Escape');

// ---------------------------------------------------------------- one Area tool: the perimeter with it (0.8.9 - no Perimeter tool)
await tool('m-area');
ok(await win.locator('.ribbon [data-tool="m-perimeter"]').count() === 0, 'no separate Perimeter tool');
ok(await win.locator('.howbar button.on', { hasText: 'Circle' }).count() === 1, 'the way of drawing is remembered');
await win.locator('.howbar button', { hasText: 'Rectangle' }).click();
await sleep(200);
{
  const p1 = await at(0, 100, 560), p2 = await at(0, 200, 620);
  await win.mouse.move(p1[0], p1[1]);
  await win.mouse.down();
  await win.mouse.move(p2[0], p2[1], { steps: 8 });
  await win.mouse.up();
}
const per = await until(async () => { const l = await areas(); return l.length === 2 ? l.find((a) => a.vertices.length === 4) : null; }, 8000, 'rectangle');
const wantP = fixed(2 * (100 + 60) * K, 3) + ' m';
ok(perimPart(per.contents) === wantP && per.vertices.length === 4, `rectangle: its perimeter in the label: ${per.contents} (want ${wantP})`);
// a circle: the circumference
await win.keyboard.press('o');
await sleep(150);
{ const c = await at(0, 450, 300), e = await at(0, 450, 340); await win.mouse.click(c[0], c[1]); await win.mouse.move(e[0], e[1], { steps: 4 }); await win.mouse.click(e[0], e[1]); }
const circ = await until(async () => { const l = await areas(); return l.length === 3 ? l.find((a) => a.vertices.length === 128 && a.id !== A[0].id) : null; }, 8000, 'circumference');
ok(perimPart(circ?.contents) === fixed(2 * Math.PI * 40 * K, 3) + ' m', 'circle: perimeter = 2 pi r: ' + circ?.contents);
// (taken back: the rest of this test counts its own areas)
await win.keyboard.press('Control+z');
await win.keyboard.press('Control+z');
await until(async () => (await areas()).length === 1, 8000, 'taken back');
await tool('select');

// ---------------------------------------------------------------- a rectangle keeps its corners square
await tool('m-area');
await win.keyboard.press('r');
await sleep(150);
{
  const p1 = await at(0, 100, 420), p2 = await at(0, 200, 480);
  await win.mouse.move(p1[0], p1[1]); await win.mouse.down(); await win.mouse.move(p2[0], p2[1], { steps: 6 }); await win.mouse.up();
}
let rect = await until(async () => { const l = await areas(); return l.length === 2 ? l.find((a) => a.vertices.length === 4) : null; }, 8000, 'rect area');
await tool('select');
await click(0, 150, 450);
await sleep(300);
ok(await win.locator('.hd.v').count() === 4, 'rectangle selected: its 4 corners');
const dragCorner = async (from, to, alt) => {
  const p = await at(0, ...from), q = await at(0, ...to);
  await win.mouse.move(p[0], p[1]);
  if (alt) await win.keyboard.down('Alt');
  await win.mouse.down();
  await win.mouse.move(q[0], q[1], { steps: 8 });
  await win.mouse.up();
  if (alt) await win.keyboard.up('Alt');
  await sleep(400);
};
await dragCorner([200, 480], [240, 500]);
rect = await until(async () => { const l = await areas(); const x = l.find((a) => a.id === rect.id); return x && Math.abs(x.vertices[2][0] - 240) < 1.5 ? x : null; }, 8000, 'corner dragged');
const isRect = (v) => v.every((p, i) => { const q = v[(i + 1) % 4]; return Math.abs(p[0] - q[0]) < 0.5 || Math.abs(p[1] - q[1]) < 0.5; });
ok(isRect(rect.vertices), 'dragged corner: still a rectangle ' + JSON.stringify(rect.vertices.map((v) => v.map(Math.round))));
ok(areaPart(rect.contents) === fixed(140 * 80 * K * K, 2) + ' m²', `its area follows: ${rect.contents}`);
await dragCorner([240, 500], [260, 530], true);
rect = await until(async () => { const l = await areas(); const x = l.find((a) => a.id === rect.id); return x && Math.abs(x.vertices[2][0] - 260) < 1.5 ? x : null; }, 8000, 'alt corner');
ok(!isRect(rect.vertices), 'Alt: the corner alone (any shape)');
await win.keyboard.press('Escape');

// ---------------------------------------------------------------- typed lengths
const lengths = async () => (await annots()).filter((a) => a.kind === 'measure-length');
await tool('m-length');
{
  await click(0, 100, 700);
  const to = await at(0, 250, 700);
  await win.mouse.move(to[0], to[1], { steps: 5 });
  await win.keyboard.type('4200');
  await sleep(150);
  const tip = await win.locator('.vtip').textContent().catch(() => '');
  ok(/4200 → 4\.200 m \(4,200 mm\).*millimetres/.test(tip), 'typing 4200: read as 4.200 m (4,200 mm), said before Enter: ' + tip);
  await win.keyboard.press('Enter');
}
let L = await until(async () => { const l = await lengths(); return l.length === 1 ? l[0] : null; }, 8000, 'typed length');
ok(Math.abs((L.line[1][0] - L.line[0][0]) * K - 4.2) < 1e-6 && Math.abs(L.line[1][1] - 700) < 0.01, 'the length is exactly 4.2 m, towards the pointer: ' + JSON.stringify(L.line.map((v) => v.map((x) => +x.toFixed(2)))));
ok(L.contents === '4.200 m', 'its number: ' + L.contents);
// "m" after a number is metres, not the Length tool; Backspace takes back a character
await click(0, 330, 600);
{ const to = await at(0, 330, 680); await win.mouse.move(to[0], to[1], { steps: 4 }); }
await win.keyboard.type('2.55');
await win.keyboard.press('Backspace');
await win.keyboard.type('m');
await win.keyboard.press('Enter');
L = await until(async () => { const l = await lengths(); return l.length === 2 ? l.find((a) => Math.abs(a.line[0][1] - 600) < 1) : null; }, 8000, 'typed down').catch(async (e) => { console.log('lengths now', JSON.stringify((await lengths()).map((a) => [a.line, a.contents])), 'tip', await win.locator('.vtip').textContent().catch(() => '-'), 'status', await win.locator('.statusbar').textContent()); throw e; });
ok(L && Math.abs((L.line[1][1] - L.line[0][1]) * K - 2.5) < 1e-6, '"2.5m" downwards: ' + L?.contents);
// polylength: two typed legs, then Enter finishes
await tool('m-polylength');
await click(0, 400, 560);
{ const to = await at(0, 480, 560); await win.mouse.move(to[0], to[1], { steps: 4 }); }
await win.keyboard.type('3000');
await win.keyboard.press('Enter');
{ const to = await at(0, 400 + 3 / K, 620); await win.mouse.move(to[0], to[1], { steps: 4 }); }
await win.keyboard.type('1.5');
await win.keyboard.press('Enter');
await sleep(150);
await win.keyboard.press('Enter');
const PL = await until(async () => { const l = (await annots()).filter((a) => a.kind === 'measure-polylength'); return l.length === 1 ? l[0] : null; }, 8000, 'polylength');
ok(PL.vertices.length === 3 && PL.contents === '4.500 m', 'polylength of two typed legs: ' + PL.contents + ' ' + JSON.stringify(PL.vertices.map((v) => v.map((x) => +x.toFixed(1)))));
// Escape clears what is typed first, then the shape
await tool('m-length');
await click(0, 450, 650);
await win.keyboard.type('12');
await win.keyboard.press('Escape');
await sleep(100);
ok(await E(() => !!document.querySelector('.vtip')) === false || !/12 →/.test(await win.locator('.vtip').textContent().catch(() => '')), 'Escape: the typed length goes');
await win.keyboard.press('Escape');
await win.keyboard.press('Escape');

// ---------------------------------------------------------------- counts & totals
await tool('m-count');
const name = win.locator('.ribbon input[title^="Name of what you are counting"]');
await name.fill('Doors D1');
for (const [x, y] of [[100, 120], [140, 120], [180, 120]]) { await click(0, x, y); await sleep(250); }
await E(() => window.__gcc.viewer().goTo(1));
await sleep(700);
for (const [x, y] of [[100, 200], [160, 200]]) { await click(1, x, y); await sleep(250); }
await name.fill('Windows');
await click(1, 300, 300);
await sleep(400);
await win.locator('.ribbon .rb', { hasText: 'Totals' }).click();
await until(() => win.locator('.totals .tt-name', { hasText: 'Doors D1' }).count(), 8000, 'totals panel');
const rowN = async (label) => win.locator('.totals .tt-row', { has: win.locator('.tt-name', { hasText: label }) }).locator('.tt-n').first().textContent();
ok(await rowN('Doors D1') === '5' && await rowN('Windows') === '1', `counts by name: Doors D1 ${await rowN('Doors D1')}, Windows ${await rowN('Windows')}`);
await win.locator('.totals .tt-row', { has: win.locator('.tt-name', { hasText: 'Doors D1' }) }).locator('.tt-fold').click();
const pgs = await win.locator('.totals .tt-pg').allTextContents();
ok(pgs.length === 2 && /Page 1.*3/.test(pgs[0]) && /Page 2.*2/.test(pgs[1]), 'per page: ' + JSON.stringify(pgs));
// a page: there, its marks selected
await win.locator('.totals .tt-pg').first().click();
await sleep(600);
const sel = await E(() => window.__gcc.viewer() && document.querySelectorAll('.selbox').length);
ok(sel === 3, 'Page 1 of Doors D1: its 3 marks selected: ' + sel);
// the areas added up
const areaRow = (await win.locator('.totals .tt-row', { has: win.locator('.tt-name', { hasText: /^Areas \(/ }) }).locator('.tt-n').textContent()) || '';
const areaSum = (await areas()).reduce((t, a) => t + Number(a.contents.split(' ')[0]), 0);
ok(areaRow === areaSum.toFixed(2) + ' m²', `areas added up: ${areaRow} (labels add to ${areaSum.toFixed(2)})`);
const perRow = (await win.locator('.totals .tt-row', { has: win.locator('.tt-name', { hasText: 'Areas: perimeters' }) }).locator('.tt-n').textContent()) || '';
ok(/m$/.test(perRow), 'the areas\' perimeters added up: ' + perRow);
// + Count: counting that name again
await win.locator('.totals .tt-row', { has: win.locator('.tt-name', { hasText: 'Doors D1' }) }).locator('button', { hasText: '+ Count' }).click();
await sleep(300);
ok(await name.inputValue() === 'Doors D1' && await E(() => document.querySelector('.ribbon [data-tool="m-count"]')?.classList.contains('on')), '+ Count: the Count tool, counting Doors D1');
await E(() => window.__gcc.viewer().setZoom(1));
await sleep(300);
await E(() => window.__gcc.viewer().goTo(1));
await sleep(700);
await click(1, 220, 200);
await until(async () => (await rowN('Doors D1')) === '6', 8000, 'live total');
ok(true, 'the panel follows: Doors D1 6');
await win.keyboard.press('Control+z');
await until(async () => (await rowN('Doors D1')) === '5', 8000, 'live total after undo');
ok(true, 'and back to 5 after Ctrl+Z');
await win.screenshot({ path: join(TMP, 'totals.png') });

// ---------------------------------------------------------------- Find a tool: "rectangle area"
await win.keyboard.press('Escape');
await win.keyboard.press('Alt+q');
await win.keyboard.type('rectangle area');
await sleep(300);
const found = await win.locator('.tsearch-row').first().textContent();
ok(/Area/.test(found), 'Find a tool: "rectangle area" finds the Area tool: ' + found);

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : `all passed (${passes})`);
process.exit(fails ? 1 : 0);
