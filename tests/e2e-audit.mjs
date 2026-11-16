// Phase 6 feature checks of the audit's window-side features, in the real app (no corpus files:
// a generated sheet of 5 million strokes and a 2.9 MB test file):
//  - a file with the look on (≥ 2 MB) and no heavy page draws its first view with no scroll (the
//    gate fix b5562d1 - before it, such a first screen stayed blank until something moved)
//  - a full save looks at the unseen pages first (5.4): the log line, every page looked at
//  - a heavy sheet: "Preparing…", merged in the batch engine, then drawn (3.1-3.3, 7.1)
//  - text answers during a long tile of it (3.9, 7.5)
//  - pins off by default (5.7), no engine lost
//   xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-audit.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TMP = resolve('tests/tmp-e2e-audit');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const BIG = join(TMP, 'ocr12.pdf'), HEAVY = join(TMP, 'sheet-5m.pdf'), SAVED = join(TMP, 'saved.pdf');
copyFileSync('tests/data/ocr-bench12.pdf', BIG);
execFileSync('python3', ['tests/bench/gen-synthetic.py', HEAVY, '5000000', '3']);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-audit'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; return c; };
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); } return null; };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=audit', BIG] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
const E = (fn, a) => win.evaluate(fn, a);
const inked = (pg = 0) => E((p) => {
  let n = 0;
  for (const c of document.querySelectorAll(`.pg[data-page="${p}"] canvas`)) {
    if (!c.width || !c.height) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 16) if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) n++;
  }
  return n;
}, pg);
const logFile = join(await app.evaluate(({ app: a }) => a.getPath('userData')), 'logs', 'app.log');
const logHas = (re) => existsSync(logFile) && re.test(readFileSync(logFile, 'utf8'));

try {
  // 1. the first view of a file with the look on, nothing touched
  await win.waitForFunction(() => window.__gcc?.active()?.pages.length > 0, null, { timeout: 90000 });
  const look = await E(() => window.__gcc.active().look);
  ok(look === true, `the 2.9 MB file has the look on (${statSync(BIG).size} bytes)`);
  ok(!!(await until(async () => (await E(() => window.__gcc.tiles.stats().tiles)) > 0 && (await inked(0)) > 200, 30000)), 'its first view draws with no scroll or zoom (gate fix)');

  // 2. a full save: the unseen pages are looked at first
  const pages = await E(() => window.__gcc.active().pages.length);
  const unseen = await E(() => { const d = window.__gcc.active(); return d.pages.length - d.looked.size; });
  const r = await E((p) => window.__gcc.active().save(p, { incremental: false }).then(() => 'ok', (e) => String(e)), SAVED);
  ok(r === 'ok' && existsSync(SAVED), 'saved in full');
  ok(!!(await until(async () => logHas(/pre-save look: \d+ pages, \d+ left for after the save, \d+ ms/), 5000)), `the pre-save look is in the log (${unseen} of ${pages} pages unseen before)`);
  ok(!!(await until(() => E(() => { const d = window.__gcc.active(); return d.looked.size === d.pages.length; }), 5000)), 'every page is looked at after it');

  // 3. a heavy sheet: prepared, merged, drawn
  await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), HEAVY);
  await until(() => E(() => window.__gcc.active()?.name === 'sheet-5m.pdf' && window.__gcc.active().pages.length > 0), 60000);
  const prepared = await until(() => E(() => window.__gcc.active().preparing.size > 0), 30000);
  ok(!!(await until(async () => logHas(/merged for display in \d+ ms/), 180000)), 'the heavy sheet is merged in the batch engine' + (prepared ? '' : ' (no "Preparing…" seen)'));
  ok(!!(await until(async () => (await inked(0)) > 2000, 120000)), 'and drawn from its merged line work');

  // 4. text while a long tile of it draws
  await E(() => { const v = window.__gcc.viewer(); v.setZoom(v.zoom() * 4); });
  await until(() => E(() => window.__gcc.tiles.stats().inflight > 0), 5000);
  const t0 = Date.now();
  await E(() => window.__gcc.active().chars(0).then(() => 0));
  const ms = Date.now() - t0;
  ok(ms < 1500, `text during its tiles answers in ${ms} ms`);
  await until(() => E(() => { const s = window.__gcc.tiles.stats(); return !s.queued && !s.inflight; }), 120000);

  // 5. pins off by default; nothing lost
  const id = await E(() => window.__gcc.active().id);
  ok((await E((i) => window.__gcc.pinCount(i), id)) === 0 && (await E((i) => window.__gcc.pinLog(i).length, id)) === 0, 'no page pinned (7.3 ships off)');
  const rs = await E(() => window.__gcc.engines.renderers.map((x) => x.restarts ?? 0));
  ok(rs.every((n) => n === 0), `no drawing engine restarted (${rs.join(', ')})`);
} catch (e) {
  ok(false, 'error: ' + (e?.message || e));
} finally {
  console.log(`\n${passes} passed, ${fails} failed`);
  const closed = await Promise.race([app.close().then(() => true, () => true), sleep(5000).then(() => false)]);
  if (!closed) app.process().kill('SIGKILL');
  rmSync(TMP, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
