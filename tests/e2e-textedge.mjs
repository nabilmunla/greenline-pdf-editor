// Text markups can be changed after placing them: drag either end along the text to cover more
// or less (snaps to characters, follows lines), one undo step. xvfb-run -a node tests/e2e-textedge.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const TMP = resolve('tests/tmp-textedge');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'spec.pdf');
copyFileSync('tests/data/long-spec.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-textedge'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=textedge'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1500, 950); });
for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc)); i++) await sleep(200);
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
await win.waitForFunction(() => window.__gcc.active()?.pages.length > 0);
await sleep(1000);
const E = (fn, a) => win.evaluate(fn, a);
await E(() => window.__gcc.viewer().fit('width'));
await sleep(800);

// character boxes of a line "0.n The Contractor ..." on page 1
const line = (n) => E(async (n) => {
  const c = await window.__gcc.active().chars(0);
  const i = c.text.indexOf(`0.${n} The Contractor`);
  const j = c.text.indexOf('\n', i);
  const boxes = [];
  for (let k = i; k < (j < 0 ? i + 80 : j); k++) { const b = Array.from(c.box.slice(k * 4, k * 4 + 4)); if (!Number.isNaN(b[0]) && b[2] > b[0]) boxes.push({ k, b, ch: c.text[k] }); }
  return boxes;
}, n);
const at = async (x, y) => { const box = await win.locator('.pg[data-page="0"]').boundingBox(); const w = await E(() => window.__gcc.active().pages[0].w); const k = box.width / w; return [box.x + x * k, box.y + y * k]; };
const drag = async (a, b) => { const p = await at(...a), q = await at(...b); await win.mouse.move(p[0], p[1]); await win.mouse.down(); await win.mouse.move(q[0], q[1], { steps: 12 }); await win.mouse.up(); await sleep(700); };
const marks = () => E(async () => (await window.__gcc.active().allAnnots()).filter((a) => ['Highlight', 'Underline', 'StrikeOut', 'Squiggly'].includes(a.type)));
const mid = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

const L1 = await line(1), L2 = await line(2);
// highlight the first ~third of line 1
await win.locator('.rtab', { hasText: /^Comment$/ }).click();
await win.locator('.ribbon [data-tool="highlight"]').click();
const third = L1[Math.floor(L1.length / 3)];
await drag([L1[0].b[0] + 0.5, mid(L1[0].b)[1]], [third.b[2] - 0.5, mid(third.b)[1]]);
await win.keyboard.press('Escape');
let m = await marks();
ok(m.length === 1 && m[0].type === 'Highlight', `highlight placed: "${m[0]?.contents}"`);
const w0 = m[0].quads[0][2] - m[0].quads[0][0];

// select it: two end handles
await win.locator('.ribbon [data-tool="select"]').first().click().catch(() => {});
await win.keyboard.press('Escape');
const pClick = await at(...mid(L1[2].b));
await win.mouse.click(pClick[0], pClick[1]);
await sleep(500);
ok(await E(() => document.querySelectorAll('.tedge circle').length === 2), 'selected highlight shows a handle at each end');

// hovering the end handle: resize cursor
const endX = third.b[2], endY = mid(third.b)[1];
{ const p = await at(endX, endY); await win.mouse.move(p[0], p[1]); await sleep(200); }
ok(await E(() => document.querySelector('.viewer').dataset.cursor === 'col-resize'), 'cursor over an end handle: resize');

// drag the end to the end of the line: covers the whole line
const last = L1[L1.length - 1];
await drag([endX, endY], [last.b[2] + 3, mid(last.b)[1]]);
m = await marks();
const w1 = m[0].quads[0][2] - m[0].quads[0][0];
ok(m.length === 1 && w1 > w0 * 2 && Math.abs(m[0].quads[0][2] - last.b[2]) < 1.5, `end dragged to the end of the line: width ${w0.toFixed(0)} -> ${w1.toFixed(0)} pt`);
ok(/clause 1\.?$/.test((m[0].contents || '').trim()), `its text followed: "${m[0].contents}"`);
ok(await E(() => window.__gcc.active().undoName === 'Change highlight'), 'one undo step: ' + (await E(() => window.__gcc.active().undoName)));

// drag the start to the right: covers less
const startX = L1[0].b[0], startY = mid(L1[0].b)[1];
const word3 = L1.find((x) => x.ch === 'C'); // "Contractor"
await drag([startX, startY], [word3.b[0] + 0.3, mid(word3.b)[1]]);
m = await marks();
ok(Math.abs(m[0].quads[0][0] - word3.b[0]) < 1.5 && (m[0].contents || '').startsWith('Contractor'), `start dragged right: now starts at "${(m[0].contents || '').slice(0, 20)}"`);

// drag the end down onto the next line: two line pieces
const l2mid = L2[Math.floor(L2.length / 2)];
const curEnd = m[0].quads[m[0].quads.length - 1];
await drag([curEnd[2], (curEnd[1] + curEnd[5]) / 2], [l2mid.b[2] - 0.3, mid(l2mid.b)[1]]);
m = await marks();
ok(m[0].quads.length === 2, `end dragged onto the next line: ${m[0].quads.length} line pieces`);
// undo: back to one line
await win.keyboard.press('Control+z'); await sleep(700);
m = await marks();
ok(m[0].quads.length === 1 && (m[0].contents || '').startsWith('Contractor'), 'Ctrl+Z: back to one line');

// someone's own comment is kept when the ends move
await E(async (id) => { const d = window.__gcc.active(); await d.update([{ page: 0, id, patch: { contents: 'Check this clause' } }]); }, m[0].id);
await sleep(400);
await win.mouse.click(pClick[0] + 400, pClick[1] + 300); await sleep(200);
{ const q = m[0].quads[0]; const p = await at((q[0] + q[2]) / 2, (q[1] + q[5]) / 2); await win.mouse.click(p[0], p[1]); await sleep(400); }
{ const q = (await marks())[0].quads[0]; await drag([q[2], (q[1] + q[5]) / 2], [last.b[2] + 3, mid(last.b)[1]]); }
m = await marks();
ok(m[0].contents === 'Check this clause' && m[0].quads[0][2] > last.b[2] - 1.5, `own comment kept ("${m[0].contents}") while the end moved`);

// underline works the same way
await win.mouse.click(pClick[0] + 400, pClick[1] + 300); await sleep(200);
await win.locator('.ribbon [data-tool="underline"]').click();
const L4 = await line(4);
const q4 = L4[Math.floor(L4.length / 4)];
await drag([L4[0].b[0] + 0.5, mid(L4[0].b)[1]], [q4.b[2] - 0.5, mid(q4.b)[1]]);
await win.keyboard.press('Escape');
let u = (await marks()).find((a) => a.type === 'Underline');
const uw0 = u.quads[0][2] - u.quads[0][0];
{ const p = await at(...mid(L4[1].b)); await win.mouse.click(p[0], p[1]); await sleep(500); }
await drag([q4.b[2], mid(q4.b)[1]], [L4[L4.length - 1].b[2] + 3, mid(L4[L4.length - 1].b)[1]]);
u = (await marks()).find((a) => a.type === 'Underline');
ok(u.quads[0][2] - u.quads[0][0] > uw0 * 2, `underline end dragged: ${uw0.toFixed(0)} -> ${(u.quads[0][2] - u.quads[0][0]).toFixed(0)} pt`);

// area highlights are boxes: no text-end handles
await win.mouse.click(pClick[0] + 400, pClick[1] + 300); await sleep(200);
await win.locator('.ribbon [data-tool="highlight"]').click();
await drag([420, 120], [560, 160]);
await win.keyboard.press('Escape');
{ const p = await at(490, 140); await win.mouse.click(p[0], p[1]); await sleep(400); }
ok(await E(() => document.querySelectorAll('.tedge').length === 0), 'area highlight: no text-end handles (it resizes as a box)');

// saved: other readers draw the new extent
const out = join(TMP, 'edited.pdf');
await E((p) => window.__gcc.active().save(p), out);
await sleep(600);
const info = execFileSync('python3', ['-c', `
import pikepdf
p = pikepdf.open(${JSON.stringify(out)})
for a in p.pages[0].Annots:
    if str(a.Subtype) in ('/Highlight', '/Underline'):
        r = [float(x) for x in a.Rect]; q = [float(x) for x in a.QuadPoints]
        xs = q[0::2]; ys = q[1::2]
        print(str(a.Subtype), int(min(xs) >= r[0] - 0.5 and max(xs) <= r[2] + 0.5 and min(ys) >= r[1] - 0.5 and max(ys) <= r[3] + 0.5), '/AP' in a)
`]).toString().trim().split('\n');
ok(info.length >= 2 && info.every((l) => / 1 True$/.test(l)), `saved file: each markup's box holds its new extent, appearance included (${info.join(' | ')})`);
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
