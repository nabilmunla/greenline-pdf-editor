// Snap with a busy drawing engine, and Ortho over a snapped point (agent audit, 0.9.7).
// xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-snap-busy.mjs
// The drawing engine does one call at a time: while it draws tiles, a 'snap' call waits behind
// them. Simulated here by holding each 'snap' answer back 300 ms (renderers[0].call wrapped).
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-e2e-snap-busy');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'sheet.pdf');
{
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, {}, '0 G 1 w 100 395 m 700 395 l S 500 100 m 800 400 l S'));
  writeFileSync(F, d.saveToBuffer('').asUint8Array());
}
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-agsnap'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (bug, m) => console.log((bug ? (globalThis.__failed = true, 'FAIL ') : 'PASS ') + m);

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=agsnap', F] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 1, null, { timeout: 60000 });
const E = (fn, a) => win.evaluate(fn, a);
await E(() => window.__gcc.viewer().setZoom(1.4));
await sleep(800);
const annots = () => E(async () => (await window.__gcc.active().annots(0)).map((a) => ({ id: a.id, kind: a.kind, vertices: a.vertices, line: a.line })));
const at = async (x, y) => { const box = await win.locator('.pg[data-page="0"]').boundingBox(); const k = box.width / 842; return [box.x + x * k, box.y + y * k]; };
const click = async (x, y) => { const p = await at(x, y); await win.mouse.click(p[0], p[1]); await sleep(150); };
const tab = (name) => win.locator('.rtab', { hasText: new RegExp('^' + name + '$') }).click();
const tool = async (id) => { await win.locator(`.ribbon [data-tool="${id}"]`).first().click(); await sleep(250); };
const newest = async (kind) => { const l = await annots(); return l.filter((a) => a.kind === kind).sort((a, b) => b.id - a.id)[0]; };
const snapKind = () => E(() => document.querySelector('.ov [data-k]')?.getAttribute('data-k') || '');
// a slow sweep: one pointer event every 40 ms, like a hand moving the mouse
const sweep = async (from, to, n = 10) => { for (let i = 1; i <= n; i++) { const p = await at(from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n); await win.mouse.move(p[0], p[1]); await sleep(40); } };

try {
  await win.locator('.statusbar button', { hasText: 'Scale' }).click();
  await win.locator('.modal .chip', { hasText: /^1:100$/ }).first().click();
  await sleep(600);
  await tab('Measure');
  await tool('m-polylength');
  await sleep(1200);

  // --------------------------------------------- A. idle engine: the end point snaps (control)
  await click(600, 120);
  await sweep([600, 120], [699, 201]);
  await sleep(800);
  const kA = await snapKind();
  log(!/End/i.test(kA), `A. engine idle: resting near the end point (700,200): snap mark "${kA}"`);
  await win.keyboard.press('Escape');
  await sleep(300);

  // --------------------------------------------- B. busy engine (each snap answer 300 ms late)
  await E(() => {
    const r0 = window.__gcc.engines.renderers[0];
    const orig = r0.call.bind(r0);
    r0.call = (m, a, o) => (m === 'snap' ? orig(m, a, o).then((v) => new Promise((res) => setTimeout(() => res(v), 300))) : orig(m, a, o));
  });
  await click(600, 120);
  await sweep([600, 120], [699, 201]);
  await sleep(1500); // resting on the end point
  const kB = await snapKind();
  log(!/End/i.test(kB), `B. engine busy: resting near the end point for 1.5 s: snap mark "${kB}" (the last position's snap was never asked)`);
  await click(699, 201);
  await win.keyboard.press('Enter');
  await sleep(700);
  let m = await newest('measure-polylength');
  const vB = m && m.vertices[1];
  log(vB && Math.hypot(vB[0] - 700, vB[1] - 200) > 0.3, `B. the clicked point: ${JSON.stringify(vB)} (end point is (700,200))`);

  // --------------------------------------------- C. Ortho on + a snapped end point
  await E(() => { const r0 = window.__gcc.engines.renderers[0]; delete r0.call; });
  await win.locator('.viewer').focus();
  await win.keyboard.press('F8');
  await sleep(300);
  console.log('tool now: ' + await E(() => [...document.querySelectorAll('.ribbon [data-tool]')].filter((b) => b.classList.contains('on') || b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.tool).join(',')));
  await click(600, 120);
  await sweep([600, 120], [699, 201]);
  await sleep(800);
  const kC = await snapKind();
  await click(699, 201);
  await win.keyboard.press('Enter');
  await sleep(700);
  m = await newest('measure-polylength');
  const vC = m && m.vertices[1];
  log(/End/i.test(kC) && vC && Math.hypot(vC[0] - 700, vC[1] - 200) > 2, `C. Ortho on: snap mark "${kC}" at (700,200), the point went to ${JSON.stringify(vC)}`);
} catch (e) { console.log('EXCEPTION ' + (e && e.stack || e)); }
await win.screenshot({ path: join(TMP, 'end.png') }).catch(() => {});
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log('done');
process.exit(globalThis.__failed ? 1 : 0);
