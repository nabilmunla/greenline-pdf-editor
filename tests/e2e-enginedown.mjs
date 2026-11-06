// A drawing engine going down while drawing (out of memory on a monster sheet): the app carries
// on; a page that takes the engines down twice is not drawn again and again (it looped every few
// seconds) but says "too heavy" with Try again; the waiting page parts are not each filed as a
// crash report. xvfb-run -a node tests/e2e-enginedown.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';

const TMP = resolve('tests/tmp-enginedown');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'sheet.pdf');
copyFileSync('tests/real/b1-floor-22mb.pdf', F);
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-enginedown');
rmSync(PROFILE, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(50); } };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=enginedown', '--gcc-renderers=2'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1500, 900); });
await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
await until(() => win.evaluate(() => window.__gcc.active()?.pages.length > 0), 60000, 'open');
const renderPids = () => app.evaluate(({ app: a }) => a.getAppMetrics().filter((m) => /render\d/.test(m.name || '')).map((m) => m.pid));
// twice: zoom in (sharp tiles of the dense sheet under way), then the drawing engines go down
for (let round = 1; round <= 2; round++) {
  // (a zoom not drawn yet, so sharp tiles of it are under way; on a busy PC they may start late)
  let busy = false;
  for (let k = 0; k < 6 && !busy; k++) {
    await win.evaluate((z) => window.__gcc.viewer().setZoom(z), 1.7 + round * 1.3 + k * 0.37);
    busy = !!(await until(() => win.evaluate(() => window.__gcc.tiles.stats().inflight > 0), 10000, 'tiles under way').catch(() => false));
  }
  const pids = await renderPids();
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(4000);
  console.log(`  round ${round}: ${pids.length} drawing engines stopped`);
}
const heavy = await until(() => win.locator('.pg-heavy').count(), 15000, 'too heavy note').catch(() => 0);
ok(heavy > 0, 'the page is marked too heavy after taking the engines down twice');
// not redrawn again and again: the engines stay up for a while
const before = await renderPids();
await sleep(5000);
const after = await renderPids();
ok(before.length > 0 && before.every((p) => after.includes(p)), 'no restart loop (same engines 5 s later)');
ok(await win.evaluate(() => window.__gcc.active().pages.length > 0), 'the file is still open');
// Try again: drawn again (this time nothing stops the engines)
if (heavy) {
  await win.locator('.pg-heavy button', { hasText: 'Try again' }).click();
  await until(() => win.locator('.pg-heavy').count().then((n) => n === 0), 5000, 'note gone');
  await until(() => win.evaluate(() => window.__gcc.tiles.stats().inflight === 0 && window.__gcc.tiles.stats().tiles > 0), 60000, 'drawn again');
  ok(true, 'Try again draws the page');
}
// Simplify and draw: the page's line work merged (one undo step), drawn, the note gone
{
  for (let round = 1; round <= 2; round++) {
    let busy = false;
    for (let k = 0; k < 6 && !busy; k++) {
      await win.evaluate((z) => window.__gcc.viewer().setZoom(z), 2.2 + round * 1.1 + k * 0.41);
      busy = !!(await until(() => win.evaluate(() => window.__gcc.tiles.stats().inflight > 0), 10000, 'tiles').catch(() => false));
    }
    for (const pid of await renderPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(4000);
  }
  if (await until(() => win.locator('.pg-heavy').count(), 15000, 'heavy again').catch(() => 0)) {
    await win.locator('.pg-heavy button', { hasText: 'Simplify' }).click();
    await until(() => win.locator('.pg-heavy').count().then((n) => n === 0), 90000, 'simplified');
    ok(await win.evaluate(() => window.__gcc.active().dirty), 'Simplify: the page changed (unsaved), the note gone');
    await until(() => win.evaluate(() => window.__gcc.tiles.stats().inflight === 0 && window.__gcc.tiles.stats().tiles > 0), 90000, 'drawn after simplify');
    ok(true, 'the simplified page is drawn');
    ok(await win.evaluate(() => window.__gcc.active().canUndo), 'Simplify can be undone');
  } else ok(false, 'marked too heavy again for the Simplify check');
}

// crash reports: none for the page parts that were waiting
const out = join(PROFILE, 'reports-outbox');
const reps = existsSync(out) ? readdirSync(out).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(out, n), 'utf8'))) : [];
const promiseReps = reps.filter((r) => r.where === 'window (promise)');
ok(promiseReps.length === 0, 'no "window (promise)" reports for the waiting page parts: ' + promiseReps.map((r) => r.message).join(' | '));
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
