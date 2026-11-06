// Switching tabs keeps each file's place (page, spot, zoom) - it used to go back to the top of
// page 1 at the zoom it had (zoomed in: the left part of page 1, half of it off the screen).
//   xvfb-run -a node tests/e2e-tabview.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
const TMP = resolve('tests/tmp-tabview');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const A = join(TMP, 'spec.pdf'), B = join(TMP, 'sheet.pdf');
copyFileSync('tests/data/long-spec.pdf', A);
copyFileSync('tests/data/heavy-a0.pdf', B);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-tabview'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=tabview'] });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc)); i++) await sleep(200);
const open = async (f) => {
  const n0 = await win.evaluate(() => window.__gcc.docs().length);
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), f);
  for (let i = 0; i < 100 && !(await win.evaluate((n) => window.__gcc.docs().length > n && window.__gcc.active()?.pages.length > 0, n0)); i++) await sleep(100);
  await sleep(900);
};
const state = () => win.evaluate(() => {
  const v = window.__gcc.viewer(); const el = document.querySelector('.viewer');
  return { page: v.page(), z: +v.zoom().toFixed(3), top: Math.round(el.scrollTop), left: Math.round(el.scrollLeft), a: window.__gcc.active().view.anchor };
});
const nextTab = async () => { await win.locator('.viewer').click({ position: { x: 5, y: 5 } }).catch(() => {}); await win.keyboard.press('Control+Tab'); await sleep(900); };
try {
  await open(A);
  // zoomed in on a spot of page 37
  await win.evaluate(() => window.__gcc.viewer().setZoom(2.4));
  await sleep(500);
  await win.evaluate(() => window.__gcc.viewer().goTo(36, [300, 400, 380, 460]));
  await sleep(900);
  const a1 = await state();
  await open(B);
  await win.evaluate(() => window.__gcc.viewer().setZoom(1.3));
  await sleep(400);
  await win.evaluate(() => window.__gcc.viewer().goTo(0, [1500, 900, 1700, 1000]));
  await sleep(900);
  const b1 = await state();
  // back to A
  await nextTab();
  const a2 = await state();
  ok(a2.page === a1.page, `file 1 back on its page (${a1.page + 1} -> ${a2.page + 1})`);
  ok(Math.abs(a2.z - a1.z) < 0.005, `file 1 same zoom (${a1.z} -> ${a2.z})`);
  ok(Math.abs(a2.top - a1.top) <= 2 && Math.abs(a2.left - a1.left) <= 2, `file 1 same spot (${a1.top},${a1.left} -> ${a2.top},${a2.left})`);
  // and to B
  await nextTab();
  const b2 = await state();
  ok(Math.abs(b2.z - b1.z) < 0.005, `file 2 same zoom (${b1.z} -> ${b2.z})`);
  ok(Math.abs(b2.top - b1.top) <= 2 && Math.abs(b2.left - b1.left) <= 2, `file 2 same spot (${b1.top},${b1.left} -> ${b2.top},${b2.left})`);
  // several switches in a row, scrolling in between
  await win.evaluate(() => { document.querySelector('.viewer').scrollTop += 700; });
  await sleep(400);
  const b3 = await state();
  for (let k = 0; k < 4; k++) await nextTab();
  const b4 = await state();
  ok(Math.abs(b4.top - b3.top) <= 2 && Math.abs(b4.left - b3.left) <= 2, `after 4 more switches still the same spot (${b3.top},${b3.left} -> ${b4.top},${b4.left})`);
  // fit width: page in view kept, still fitted
  await nextTab();
  await win.evaluate(() => window.__gcc.viewer().fit('width'));
  await sleep(500);
  await win.evaluate(() => window.__gcc.viewer().goTo(80));
  await sleep(700);
  const a5 = await state();
  await nextTab(); await nextTab();
  const a6 = await state();
  ok(a6.page === a5.page && Math.abs(a6.z - a5.z) < 0.005, `fit width: page ${a5.page + 1} kept (${a6.page + 1}), zoom ${a5.z} (${a6.z})`);
  const fit = await win.evaluate(() => window.__gcc.active().view.fit);
  ok(fit === 'width', 'still fit width: ' + fit);
} catch (e) { console.log('FAIL ' + (e && e.stack || e)); fails++; }
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
