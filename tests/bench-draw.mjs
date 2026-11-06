// Drawing benchmark: open the real sheets, time to a complete picture, zoom in (Ctrl+wheel) and
// pan like a person, time until sharp, frame times while zooming/panning, memory.
// xvfb-run -a -s "-screen 0 2000x1200x24" node tests/bench-draw.mjs [file ...]
import { _electron as electron } from 'playwright';
import { resolve, join, basename } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';

const TMP = resolve('tests/tmp-benchdraw');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const FILES = (process.argv.slice(2).length ? process.argv.slice(2) : ['tests/real/area-gf-18mb.pdf', 'tests/real/b1-floor-22mb.pdf', 'tests/real/doc-sheet-50mb.pdf', 'tests/huge/plumbing-133mb.pdf']).filter(existsSync);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-benchdraw'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=benchdraw'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await win.waitForFunction(() => !!window.__gcc, null, { timeout: 60000 });
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
const E = (fn, a) => win.evaluate(fn, a);
const until = async (fn, ms = 180000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return Date.now() - t; await sleep(20); } return -1; };
const idle = () => until(async () => { const s = await E(() => window.__gcc.tiles.stats()); if (s.queued || s.inflight) return false; await sleep(120); const s2 = await E(() => window.__gcc.tiles.stats()); return !s2.queued && !s2.inflight; });
const R = {};
const mark = (k, v, unit = 'ms') => { R[k] = Math.round(v); console.log(k.padEnd(46), Math.round(v), unit); };
// frame times while something happens
const frames = async (label, act) => {
  await E(() => { window.__fr = []; let last = performance.now(); const f = (t) => { window.__fr.push(t - last); last = t; if (window.__frOn) requestAnimationFrame(f); }; window.__frOn = true; requestAnimationFrame(f); });
  await act();
  const fr = await E(() => { window.__frOn = false; return window.__fr.slice(1); });
  fr.sort((a, b) => a - b);
  const p = (q) => fr[Math.min(fr.length - 1, Math.floor(fr.length * q))] || 0;
  mark(label + ' frame p50', p(0.5)); mark(label + ' frame p95', p(0.95)); mark(label + ' frame worst', fr[fr.length - 1] || 0);
};
for (const f of FILES) {
  const name = basename(f).replace(/\.pdf$/, '');
  const F = join(TMP, basename(f));
  copyFileSync(f, F);
  let t = Date.now();
  await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), F);
  await until(() => E((n) => window.__gcc.active()?.name === n && window.__gcc.active().pages.length > 0, basename(F)));
  mark(name + ': open', Date.now() - t);
  await until(() => E(() => window.__gcc.tiles.stats().tiles > 0));
  mark(name + ': first tile', Date.now() - t);
  await idle(); mark(name + ': whole sheet drawn', Date.now() - t);
  const box = await win.locator('.viewer').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await win.mouse.move(cx, cy);
  t = Date.now();
  await frames(name + ': ctrl+wheel zoom x8', async () => { await win.keyboard.down('Control'); for (let i = 0; i < 26; i++) { await win.mouse.wheel(0, -100); await sleep(16); } await win.keyboard.up('Control'); });
  await idle(); mark(name + ': zoomed in, sharp', Date.now() - t);
  t = Date.now();
  await frames(name + ': pan (drag)', async () => { await win.keyboard.down('Space'); await win.mouse.down(); for (let i = 0; i < 30; i++) { await win.mouse.move(cx - i * 25, cy - i * 12); await sleep(16); } await win.mouse.up(); await win.keyboard.up('Space'); });
  await idle(); mark(name + ': after pan, sharp', Date.now() - t);
  t = Date.now();
  await E(() => window.__gcc.viewer().fit('page'));
  await idle(); mark(name + ': back to fit page, sharp', Date.now() - t);
  const st = await E(() => window.__gcc.tiles.stats());
  mark(name + ': tile memory', st.bytes / 1e6, 'MB');
  await E(() => window.__gcc.active().close?.());
  await win.keyboard.press('Control+w').catch(() => {});
  await sleep(500);
}
const rss = await app.evaluate(({ app: a }) => a.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024);
mark('end: all processes memory', rss, 'MB');
console.log('JSON ' + JSON.stringify(R));
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
process.exit(0);
