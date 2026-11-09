// What people feel: start, opening big files, switching tabs, scrolling and zooming - the time to a
// picture, the time until everything is sharp, and how smooth the frames are while it happens.
//   xvfb-run -a node tests/bench-feel.mjs [app folder] [runs]
// (the app folder defaults to this one: run it against an older copy to compare)
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';

const APP = resolve(process.argv[2] || '.');
const RUNS = Number(process.argv[3] || 1);
const DATA = resolve('tests/data');
const TMP = resolve('tests/tmp-feel');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const F = { sheet: 'heavy-a0.pdf', scan: 'scan.pdf', spec: 'long-spec.pdf' };
  for (const k in F) { copyFileSync(join(DATA, F[k]), join(TMP, F[k])); F[k] = join(TMP, F[k]); }
  rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-feel'), { recursive: true, force: true });
  // (FEEL_CACHE=<n>: a preview cache that has filled up over months - n files in it)
  if (process.env.FEEL_CACHE) {
    const cd = join(process.env.HOME, '.config', 'PDF Editor', 'profile-feel', 'cache', 'previews');
    mkdirSync(cd, { recursive: true });
    const blob = Buffer.alloc(20000, 7);
    for (let i = 0; i < Number(process.env.FEEL_CACHE); i++) writeFileSync(join(cd, 'old-' + i + '.webp'), blob);
  }
  const R = {};
  const t0 = Date.now();
  const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [APP, '--no-sandbox', '--profile=feel'] });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
  const E = (fn, a) => win.evaluate(fn, a);
  const until = async (fn, ms = 120000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return Date.now() - t; await sleep(10); } throw new Error('timeout'); };
  await until(() => E(() => !!window.__gcc && !!document.querySelector('.start-hero')));
  R.start = Date.now() - t0;
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  // frame times and main-thread long tasks
  await E(() => {
    const F = (window.__feel = { on: false, t: [], long: 0 });
    const loop = (t) => { if (F.on) F.t.push(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    try { new PerformanceObserver((l) => { if (F.on) for (const e of l.getEntries()) F.long += e.duration; }).observe({ type: 'longtask', buffered: false }); } catch (_) { /* n/a */ }
  });
  const rec = () => E(() => { window.__feel.t = []; window.__feel.long = 0; window.__feel.on = true; });
  const frames = async () => {
    const f = await E(() => { const F = window.__feel; F.on = false; const d = []; for (let i = 1; i < F.t.length; i++) d.push(F.t[i] - F.t[i - 1]); return { d, long: F.long }; });
    const d = f.d.sort((a, b) => a - b);
    return { frames: d.length, p95: Math.round(d[Math.floor(d.length * 0.95)] || 0), max: Math.round(d[d.length - 1] || 0), janky: d.filter((x) => x > 50).length, longTasks: Math.round(f.long) };
  };
  const settled = async () => {
    let calm = 0;
    return until(async () => { const s = await E(() => window.__gcc.tiles.stats()); calm = s.queued === 0 && s.inflight === 0 ? calm + 1 : 0; return calm >= 3; });
  };
  const open = async (f) => app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), f);
  const picture = () => until(() => E(() => document.querySelectorAll('.pg canvas, .pg img').length > 0 && window.__gcc.tiles.stats().tiles > 0));
  const openTimed = async (key, f, name) => {
    const n0 = await E(() => window.__gcc.tiles.stats().tiles);
    const t = Date.now();
    await open(f);
    await until(() => E((nm) => window.__gcc.active()?.name === nm && window.__gcc.active().pages.length > 0, name));
    R[key + ':pages'] = Date.now() - t;
    await until(() => E((n) => window.__gcc.tiles.stats().tiles > n, n0));
    R[key + ':picture'] = Date.now() - t;
    await settled();
    R[key + ':sharp'] = Date.now() - t;
  };
  const box = async () => { const b = await win.locator('.viewer').first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

  await rec();
  await openTimed('sheet', F.sheet, 'heavy-a0.pdf');
  R['sheet:openFrames'] = await frames();
  await openTimed('scan', F.scan, 'scan.pdf');
  await openTimed('spec', F.spec, 'long-spec.pdf');

  // scroll the 1,500-page spec with the wheel (60 notches, 16 ms apart)
  let c = await box();
  await win.mouse.move(c.x, c.y);
  await rec();
  let t = Date.now();
  for (let i = 0; i < 60; i++) { await win.mouse.wheel(0, 120); await sleep(16); }
  R['spec:scroll'] = await frames();
  const ts = Date.now();
  await E(() => { window.__drawn = 0; window.__offd = window.__gcc.tiles.onReady(() => window.__drawn++); });
  R['spec:at stop'] = await E(() => { const s = window.__gcc.tiles.stats(); return { queued: s.queued, inflight: s.inflight }; });
  await settled();
  R['spec:scroll sharp'] = Date.now() - t;
  R['spec:stop to sharp'] = Date.now() - ts;
  R['spec:drawn after stop'] = await E(() => { window.__offd(); return window.__drawn; });

  // back to the drawing's tab
  t = Date.now();
  await win.locator('.dtab', { hasText: 'heavy-a0' }).first().click();
  await until(() => E(() => window.__gcc.active()?.name === 'heavy-a0.pdf'));
  await picture();
  R['tab:picture'] = Date.now() - t;
  await settled();
  R['tab:sharp'] = Date.now() - t;

  // zoom into the drawing with Ctrl+wheel (14 notches, 30 ms apart), then pan around at that zoom
  c = await box();
  await win.mouse.move(c.x, c.y);
  await rec();
  t = Date.now();
  await win.keyboard.down('Control');
  for (let i = 0; i < 14; i++) { await win.mouse.wheel(0, -120); await sleep(30); }
  await win.keyboard.up('Control');
  R['sheet:zoom'] = await frames();
  await settled();
  R['sheet:zoom sharp'] = Date.now() - t;
  await rec();
  t = Date.now();
  for (let i = 0; i < 30; i++) { await win.mouse.wheel(i % 10 < 5 ? 0 : 120, 120); await sleep(16); }
  R['sheet:pan'] = await frames();
  await settled();
  R['sheet:pan sharp'] = Date.now() - t;
  // and out again
  await rec();
  t = Date.now();
  await win.keyboard.down('Control');
  for (let i = 0; i < 14; i++) { await win.mouse.wheel(0, 120); await sleep(30); }
  await win.keyboard.up('Control');
  R['sheet:zoom out'] = await frames();
  await settled();
  R['sheet:zoom out sharp'] = Date.now() - t;

  R.memoryMB = Math.round(await app.evaluate(({ app: a }) => a.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024));
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  return R;
}

const all = [];
for (let i = 0; i < RUNS; i++) all.push(await once());
// (the median of the runs, number by number)
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const out = {};
for (const k of Object.keys(all[0])) {
  const v = all[0][k];
  out[k] = typeof v === 'number' ? med(all.map((r) => r[k])) : Object.fromEntries(Object.keys(v).map((q) => [q, med(all.map((r) => r[k][q]))]));
}
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(24), typeof v === 'number' ? v : JSON.stringify(v));
console.log('JSON ' + JSON.stringify(out));
rmSync(TMP, { recursive: true, force: true });
process.exit(0);
