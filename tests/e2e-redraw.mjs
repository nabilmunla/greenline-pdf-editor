// Pages drawn again after the graphics memory was reset (0.9.7): Windows locked over lunch left
// pages already seen blank (their canvases and kept pictures wiped by a graphics reset; the app
// went on reusing them). Simulated: the page canvases wiped, then "unlock-screen" / a canvas
// "contextrestored" -> drawn again.   xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-redraw.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';

const TMP = resolve('tests/tmp-redraw');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'spec.pdf');
copyFileSync('tests/data/long-spec.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-redraw'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); } return null; };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=redraw', F] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
const E = (fn, a) => win.evaluate(fn, a);
/** inked (opaque, dark) pixels on page 0's canvases */
const ink = () => E(() => {
  let n = 0;
  for (const c of document.querySelectorAll('.pg[data-page="0"] canvas')) {
    if (!c.width || !c.height || c.width * c.height < 4) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 16) if (d[i + 3] > 200 && d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) n++;
  }
  return n;
});
/** what a graphics reset does: every canvas on the page wiped (the app doesn't know) */
const wipe = () => E(() => { for (const c of document.querySelectorAll('.pg canvas')) c.getContext('2d').clearRect(0, 0, c.width, c.height); });

try {
  await win.waitForFunction(() => window.__gcc?.active()?.pages.length > 0, null, { timeout: 60000 });
  await E(() => window.__gcc.viewer().setZoom(1.5));
  // (fully drawn first: tiles still arriving would redraw a wiped page by themselves)
  let prev = -1;
  const n0 = await until(async () => { const n = await ink(); const same = n > 800 && n === prev; prev = n; await sleep(700); return same ? n : null; }, 30000);
  ok(!!n0, `page drawn (${n0} inked samples)`);
  await wipe();
  await sleep(2500);
  ok((await ink()) < 50, 'wiped canvases stay blank on their own (the bug: nothing redraws them)');

  // Windows unlocked: main tells the window -> drawn again
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
  const n1 = await until(async () => { const n = await ink(); return n > n0 * 0.8 ? n : null; }, 12000);
  ok(!!n1, `after unlocking: drawn again (${n1})`);

  // woken from sleep, the same
  await sleep(1600);
  await wipe();
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  ok(!!(await until(async () => (await ink()) > n0 * 0.8, 12000)), 'after waking: drawn again');

  // a canvas lost and restored by Chromium itself
  await sleep(1600);
  await wipe();
  await E(() => document.querySelector('.pg canvas').dispatchEvent(new Event('contextrestored')));
  ok(!!(await until(async () => (await ink()) > n0 * 0.8, 12000)), 'a canvas restored: drawn again');

  // nothing lost on the way: other pages still draw, scrolling back still draws
  await E(() => window.__gcc.viewer().goTo?.(3));
  await sleep(1500);
  await E(() => window.__gcc.viewer().goTo?.(0));
  ok(!!(await until(async () => (await ink()) > n0 * 0.8, 12000)), 'scrolling away and back: drawn');
} catch (e) {
  ok(false, 'error: ' + (e?.message || e));
} finally {
  console.log(`\n${passes} passed, ${fails} failed`);
  await app.close().catch(() => {});
  process.exit(fails ? 1 : 0);
}
