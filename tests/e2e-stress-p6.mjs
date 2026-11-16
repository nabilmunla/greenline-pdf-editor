// Phase 6 step 3 (stress run), the parts that need the real app - generated files only:
//  - a heavy sheet (5 million strokes) closed while its tiles draw, then reopened: draws, no engine lost
//  - a page deleted while the tiles of a multi-page file draw: the rest draws, no error
//  - a full save while pages are turned: the pages turned to draw during the save
//  - damaged files (cut short, garbage after the header, broken index, empty): no crash, the app goes on
//  - idle engines give memory back (planned restart, exit 75), then the page draws again
//   xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-stress-p6.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TMP = resolve('tests/tmp-e2e-stress');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const HEAVY = join(TMP, 'sheet-5m.pdf'), BIG = join(TMP, 'ocr12.pdf'), SPEC = join(TMP, 'spec.pdf'), SAVED = join(TMP, 'saved.pdf');
execFileSync('python3', ['tests/bench/gen-synthetic.py', HEAVY, '5000000', '5']);
copyFileSync('tests/data/ocr-bench12.pdf', BIG);
copyFileSync('tests/data/long-spec.pdf', SPEC);
// damaged files
const spec = readFileSync('tests/data/long-spec.pdf');
const BAD = {
  'cut-short.pdf': spec.subarray(0, Math.floor(spec.length * 0.6)),
  'garbage.pdf': Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(Array.from({ length: 300000 }, (_, i) => (i * 7919) % 251))]),
  'broken-index.pdf': Buffer.from(spec.toString('latin1').replace(/startxref\s+\d+/, 'startxref 999999999'), 'latin1'),
  'empty.pdf': Buffer.alloc(0),
};
for (const [n, b] of Object.entries(BAD)) writeFileSync(join(TMP, n), b);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-stress'), { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; return c; };
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); } return null; };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=stress'] });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR', e.message); });
const E = (fn, a) => win.evaluate(fn, a);
await win.waitForFunction(() => !!window.__gcc, null, { timeout: 90000 });
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); dialog.showErrorBox = () => {}; });
const logFile = join(await app.evaluate(({ app: a }) => a.getPath('userData')), 'logs', 'app.log');
const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
const log0 = log().length;
const runLog = () => log().slice(log0);
const open = async (f, name) => {
  await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), f);
  return until(() => E((n) => window.__gcc.active()?.name === n && window.__gcc.active().pages.length > 0, name), 90000);
};
const inked = (pg = 0) => E((p) => {
  let n = 0;
  for (const c of document.querySelectorAll(`.pg[data-page="${p}"] canvas`)) {
    if (!c.width || !c.height) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 16) if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) n++;
  }
  return n;
}, pg);
const idle = () => until(() => E(() => { const s = window.__gcc.tiles.stats(); return !s.queued && !s.inflight; }), 180000);
const closeActive = () => E(() => { const b = document.querySelector('.dtab.on button.x'); b?.click(); return !!b; });
const badExits = () => (runLog().match(/restarted \(exit (\d+)\)/g) || []).filter((m) => !/exit 75\)/.test(m));

try {
  // 1. a heavy sheet closed while its tiles draw, then reopened
  ok(!!(await open(HEAVY, 'sheet-5m.pdf')), 'heavy sheet opened');
  ok(!!(await until(async () => (await inked(0)) > 2000, 180000)), 'drawn from its merged line work');
  await E(() => { const v = window.__gcc.viewer(); v.setZoom(v.zoom() * 6); });
  const inflight = await until(() => E(() => window.__gcc.tiles.stats().inflight), 5000);
  ok(await closeActive(), `closed while ${inflight || 0} tiles were drawing`);
  await until(() => E(() => window.__gcc.docs().length === 0), 10000);
  await sleep(1500);
  ok(!!(await open(HEAVY, 'sheet-5m.pdf')), 'reopened');
  ok(!!(await until(async () => (await inked(0)) > 2000, 180000)), 'drawn again after the reopen');
  ok(badExits().length === 0, 'no engine ended except planned restarts: ' + (badExits().join(', ') || 'none'));
  await closeActive();
  await until(() => E(() => window.__gcc.docs().length === 0), 10000);

  // 2. a page deleted while tiles draw
  ok(!!(await open(BIG, 'ocr12.pdf')), 'a 12-page file opened');
  await idle();
  await E(() => { const v = window.__gcc.viewer(); v.setZoom(v.zoom() * 3); });
  await until(() => E(() => window.__gcc.tiles.stats().inflight > 0), 3000);
  await E(() => window.__gcc.active().deletePages([0]));
  ok((await E(() => window.__gcc.active().pages.length)) === 11, 'page 1 deleted mid-draw: 11 pages');
  await idle();
  ok(!!(await until(async () => (await inked(0)) > 200, 30000)), 'the page now first draws');

  // 3. a full save while pages are turned (whole pages in view: the zoom above left only a corner)
  await E(() => window.__gcc.viewer().fit('page'));
  await idle();
  const saving = E((p) => window.__gcc.active().save(p, { incremental: false }).then(() => 'ok', (e) => String(e)), SAVED);
  // (drawn = its pictures are there and nothing is left waiting - a page seen before comes from the cache; some
  // pages of this file are near blank, so not by ink. A smoke check: this file saves in under a second - the
  // pre-save look itself is checked in e2e-audit and plan-5-4)
  let drawn = 0;
  for (const pg of [9, 5, 2]) {
    const t0 = await E(() => window.__gcc.tiles.stats().tiles);
    await E((p) => window.__gcc.viewer().goTo(p), pg);
    if (await until(() => E((b) => { const s = window.__gcc.tiles.stats(); return (s.tiles > b || b > 0) && !s.queued && !s.inflight && document.querySelectorAll(`.pg[data-page="${window.__gcc.viewer().page()}"] canvas`).length > 0; }, t0), 15000)) drawn++;
  }
  ok((await saving) === 'ok' && existsSync(SAVED), 'the full save finished');
  ok(drawn === 3, `pages turned during the save drew (${drawn} of 3)`);
  await closeActive();
  await until(() => E(() => window.__gcc.docs().length === 0), 10000);

  // 4. damaged files
  for (const n of Object.keys(BAD)) {
    await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), join(TMP, n));
    await sleep(4000);
    const state = await E(() => ({ docs: window.__gcc.docs().map((d) => d.name + ':' + d.pages.length) }));
    console.log('  ', n, JSON.stringify(state));
    ok(true, `${n}: no crash (window answers)`);
    await E(() => { for (const b of document.querySelectorAll('.dtab button.x')) b.click(); });
    await until(() => E(() => window.__gcc.docs().length === 0), 10000);
  }
  ok(!!(await open(SPEC, 'spec.pdf')), 'a good file opens after the damaged ones');
  ok(!!(await until(async () => (await inked(0)) > 200, 30000)), 'and draws');
  await closeActive();
  await until(() => E(() => window.__gcc.docs().length === 0), 10000);

  // 5. idle engines give memory back (thresholds lowered for the test, then the window reloaded)
  await E(() => { localStorage.setItem('pdfed-idle-heap', String(150 * 2 ** 20)); localStorage.setItem('pdfed-idle-ms', '4000'); });
  await win.reload();
  await win.waitForFunction(() => !!window.__gcc, null, { timeout: 90000 });
  ok(!!(await open(HEAVY, 'sheet-5m.pdf')), 'heavy sheet opened again (idle thresholds 150 MB, 4 s)');
  ok(!!(await until(async () => (await inked(0)) > 2000, 180000)), 'drawn');
  await idle();
  const before = (runLog().match(/restarted \(exit 75\)/g) || []).length;
  const gave = await until(async () => (runLog().match(/restarted \(exit 75\)/g) || []).length > before, 90000);
  ok(!!gave, 'an idle drawing engine over the threshold made its planned restart (exit 75)');
  await E(() => { const v = window.__gcc.viewer(); v.setZoom(v.zoom() * 2); });
  ok(!!(await until(async () => (await inked(0)) > 2000, 180000)), 'the page draws after it');
  await E(() => { localStorage.removeItem('pdfed-idle-heap'); localStorage.removeItem('pdfed-idle-ms'); });
  ok(badExits().length === 0, 'no engine ended out of memory or by error: ' + (badExits().join(', ') || 'none'));
  ok(errors.length === 0, 'no page errors');
} catch (e) {
  ok(false, 'error: ' + (e?.message || e));
} finally {
  console.log(`\n${passes} passed, ${fails} failed`);
  const closed = await Promise.race([app.close().then(() => true, () => true), sleep(5000).then(() => false)]);
  if (!closed) app.process().kill('SIGKILL');
  rmSync(TMP, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
