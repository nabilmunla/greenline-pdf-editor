// PLAN 10.4: an engine that stops answering is said, and can be restarted.
// PDFED_TEST_HANG gives every engine a `hang` call that never answers (a busy loop, like a damaged
// file that loops inside the engine). The limits are shortened by the window's test switches
// (localStorage pdfed-hang-*-ms): short calls 3 s, the rest 6 s, a look every second.
//  - a drawing engine that hangs is restarted by itself and draws again;
//  - the batch engine that hangs is said, not restarted; "Keep waiting" leaves it, one notice only;
//  - the editing engine that hangs is said, not restarted; "Restart it" brings the file back from its
//    recovery copy (markup there, undo history gone) and a markup can be added again.
// xvfb-run -a node tests/e2e-hang.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';

const TMP = resolve('tests/tmp-hang');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'sheet.pdf');
copyFileSync('tests/data/steel-sections.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-hang'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(100); } };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=hang', '--gcc-renderers=2'], env: { ...process.env, PDFED_TEST_HANG: '1' } });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1500, 900); });
await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
await win.evaluate(() => { localStorage.setItem('pdfed-hang-short-ms', '3000'); localStorage.setItem('pdfed-hang-long-ms', '6000'); localStorage.setItem('pdfed-hang-check-ms', '1000'); });
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
await until(() => win.evaluate(() => window.__gcc.active()?.pages.length > 0), 60000, 'open');
const E = (fn, a) => win.evaluate(fn, a);
const stuckToasts = () => E(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).filter((t) => /has not answered/.test(t)));
const restarts = (which) => E((w) => (w === 'edit' ? window.__gcc.engines.editor : window.__gcc.engines.renderers[0]).restarts, which);
const pids = () => app.evaluate(({ app: a }) => Object.fromEntries(a.getAppMetrics().map((m) => [m.name || '', m.pid])));

// ---- a drawing engine: restarted quietly, draws again
{
  const r0 = await restarts('render');
  await E(() => { window.__gcc.engines.renderers[0].call('hang').catch(() => {}); });
  const t0 = Date.now();
  await until(async () => (await restarts('render')) > r0, 30000, 'drawing engine restarted');
  ok(true, `a drawing engine that hangs is restarted (${Math.round((Date.now() - t0) / 1000)} s)`);
  ok((await stuckToasts()).length === 0, 'no question asked for a drawing engine');
  const drew = await until(() => E(async () => {
    const d = window.__gcc.active();
    const r = await window.__gcc.engines.renderers[0].call('tile', [d.id, 0, 0.5, 0, 0, 80, 80]);
    return r && r.width > 0 ? true : !!r;
  }), 20000, 'drawn after restart').catch(() => false);
  ok(!!drew, 'the restarted drawing engine draws the page (file reopened in it)');
  // (no endless loop: a second hang is restarted too, a third within ten minutes is left alone)
  const r1 = await restarts('render');
  await E(() => { window.__gcc.engines.renderers[0].call('hang').catch(() => {}); });
  await until(async () => (await restarts('render')) > r1, 30000, 'drawing engine restarted again');
  const r2 = await restarts('render');
  await until(() => E(async () => !!(await window.__gcc.engines.renderers[0].call('tile', [window.__gcc.active().id, 0, 0.5, 0, 0, 80, 80]))), 20000, 'drawn after the 2nd restart').catch(() => false);
  await E(() => { window.__gcc.engines.renderers[0].call('hang').catch(() => {}); });
  await new Promise((res) => setTimeout(res, 12000));
  ok((await restarts('render')) === r2, 'a third hang within ten minutes: not restarted again (no restart loop)');
  // (the hung engine is ended here, so the rest of the test draws with a working one)
  const r3 = await restarts('render');
  await E(() => window.gcc.killEngine('render0'));
  await until(async () => (await restarts('render')) > r3, 30000, 'hung engine ended by hand');
}

// ---- the batch engine: said, not restarted; Keep waiting leaves it alone, and is not asked again
{
  const r0 = await E(() => window.__gcc.engines.batcher.restarts);
  await E(() => { window.__gcc.engines.batcher.call('hang').catch(() => {}); });
  const t = await until(async () => (await stuckToasts())[0], 30000, 'batch notice');
  ok(/batch engine has not answered for \d+ seconds/.test(t), 'the batch engine is said not to answer: ' + t);
  await sleep(4000);
  ok((await E(() => window.__gcc.engines.batcher.restarts)) === r0, 'the batch engine is not restarted unasked');
  await win.locator('.toast button', { hasText: 'Keep waiting' }).click();
  await sleep(4000);
  ok((await stuckToasts()).length === 0, 'Keep waiting: the notice goes and does not come back');
  ok((await E(() => window.__gcc.engines.batcher.restarts)) === r0, 'Keep waiting: not restarted');
  await E(() => window.gcc.killEngine('batch'));
  await until(async () => (await E(() => window.__gcc.engines.batcher.restarts)) > r0, 20000, 'batch restarted (cleaning up)');
}

// ---- the editing engine: said, never restarted unasked; Restart it brings the file back from its recovery copy
{
  const n0 = await E(async () => (await window.__gcc.active().annots(0)).length);
  await E(() => window.__gcc.active().create(0, { type: 'Square', rect: [50, 50, 150, 120], color: [1, 0, 0] }));
  await E(() => window.__gcc.active().writeRecoveryNow());
  ok(await E(() => window.__gcc.active().canUndo), 'a markup is added and can be undone');
  const r0 = await restarts('edit');
  const p0 = (await pids())['PDF Editor editing engine'] ?? null;
  await E(() => { window.__gcc.engines.editor.call('hang').catch(() => {}); });
  const t = await until(async () => (await stuckToasts())[0], 30000, 'editing notice');
  ok(/editing engine has not answered for \d+ seconds/.test(t) && /undo history will be lost/.test(t), 'the editing engine is said not to answer, with what a restart costs: ' + t);
  await sleep(5000);
  ok((await restarts('edit')) === r0, 'the editing engine is not restarted unasked');
  ok((await stuckToasts()).length === 1, 'one notice only');
  await win.locator('.toast button', { hasText: 'Restart it' }).click();
  await until(async () => (await restarts('edit')) > r0, 30000, 'editing engine restarted');
  ok(true, 'Restart it: a new editing engine');
  await until(() => E(async (n) => { const d = window.__gcc.active(); return d.pages.length > 0 && (await d.annots(0)).length === n; }, n0 + 1), 30000, 'file reopened with its markup');
  ok(true, 'the file is open again from its recovery copy, the markup is there');
  ok(await E(() => window.__gcc.active().dirty), 'the file is still marked changed');
  await until(async () => (await E(() => [...document.querySelectorAll('.toast')].some((t) => /was restarted/.test(t.textContent)))), 10000, 'restart message');
  ok(true, 'the restart says what was lost');
  ok(!(await E(() => window.__gcc.active().canUndo)), 'the undo history is gone');
  await E(() => window.__gcc.active().create(0, { type: 'Square', rect: [200, 200, 260, 240], color: [0, 0, 1] }));
  ok((await E(async () => (await window.__gcc.active().annots(0)).length)) === n0 + 2 && (await E(() => window.__gcc.active().canUndo)), 'a markup can be added again, and undone');
  void p0;
}

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed (' + passes + ')');
process.exit(fails ? 1 : 0);
