// Mega stress test (0.9.9), after the Cloudflare reports (0.9.2 / 0.9.4: drawing engines stopped on 200+
// MB scans and a 502-page 619 MB file; "comments not showing"). Two generated scanned books
// (tests/make-mega-scan.py): 500 pages / ~700 MB and 150 pages / ~210 MB, both open at once.
// Pages through every page, zooms in, marks up, kills a drawing engine (markups must still show),
// OCR, save as - watching every engine's memory, restarts and crashes the whole way.
//   python3 tests/make-mega-scan.py tests/huge/mega-scan-500p.pdf 500 7
//   python3 tests/make-mega-scan.py tests/huge/ir-scan-150p.pdf 150 11
//   xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-mega.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, statSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-mega');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const BOOK = join(TMP, 'mega-scan-500p.pdf'), IR = join(TMP, 'ir-scan-150p.pdf');
copyFileSync('tests/huge/mega-scan-500p.pdf', BOOK);
copyFileSync('tests/huge/ir-scan-150p.pdf', IR);
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-mega');
rmSync(PROFILE, { recursive: true, force: true });
const GB = 1024 ** 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; return c; };
const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(120); } return null; };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=mega', BOOK] });
const win = await app.firstWindow();
const pageErrors = [];
win.on('pageerror', (e) => { pageErrors.push(e.message); console.log('PAGEERROR', e.message); });
await app.evaluate(({ dialog }) => {
  globalThis.__q = { save: [] };
  dialog.showSaveDialog = async () => { const f = globalThis.__q.save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
  dialog.showMessageBox = async () => ({ response: 0 });
});
const E = (fn, a) => win.evaluate(fn, a);
const heaps = () => E(() => Promise.all(window.__gcc.engines.renderers.map((r) => r.call('heap').catch(() => 0))));
let maxHeap = 0;
const track = async () => { const h = await heaps().catch(() => []); for (const x of h) maxHeap = Math.max(maxHeap, x); return h; };
async function memory() {
  const m = await app.evaluate(({ app: a }) => a.getAppMetrics().map((p) => ({ name: p.name || p.serviceName || p.type, mb: Math.round(p.memory.workingSetSize / 1024) })));
  return { total: m.reduce((s, p) => s + p.mb, 0), top: m.sort((a, b) => b.mb - a.mb).slice(0, 4).map((p) => `${p.name} ${p.mb}`).join(', ') };
}
const previewReady = (page) => E((p) => { const d = window.__gcc.active(); return window.__gcc.tiles.has(`${d.id}|r${d.crev[p]}|p|0|0`); }, page);
const goTo = (p) => E((x) => window.__gcc.viewer().goTo(x), p);
/** engine exits from the app's log: planned restarts (75), out of memory (70), other */
const exits = () => {
  const f = join(PROFILE, 'logs', 'app.log');
  const t = existsSync(f) ? readFileSync(f, 'utf8') : '';
  const all = [...t.matchAll(/engine (\S+) exited (-?\d+)/g)].map((m) => ({ name: m[1], code: Number(m[2]) }));
  return { planned: all.filter((x) => x.code === 75).length, oom: all.filter((x) => x.code === 70).length, other: all.filter((x) => x.code !== 75 && x.code !== 70).length, heavy: (t.match(/too heavy|heavy page/gi) || []).length };
};
const inkedAnnots = (pg) => E((p) => document.querySelectorAll(`.pg[data-page="${p}"] .tl.an canvas`).length, pg);

try {
  // ----- open
  let t = Date.now();
  await win.waitForFunction(() => window.__gcc?.active()?.pages.length > 0, null, { timeout: 120000 });
  ok(!!(await until(() => previewReady(0), 60000)), `the 500-page book opens (${Math.round(statSync(BOOK).size / 1e6)} MB) - first page in ${Date.now() - t} ms; memory ${(await memory()).total} MB`);
  ok((await E(() => window.__gcc.active().pages.length)) === 500, '500 pages');

  // ----- every page
  t = Date.now();
  let slow = 0, missed = [];
  for (let p = 0; p < 500; p++) {
    await goTo(p);
    const t0 = Date.now();
    if (!(await until(() => previewReady(p), 45000))) missed.push(p);
    if (Date.now() - t0 > 5000) slow++;
    if (p % 50 === 49) { const h = await track(); const m = await memory(); console.log(`  page ${p + 1}: heaps ${h.map((x) => (x / GB).toFixed(2)).join('/')} GB, app ${m.total} MB (${m.top}); exits ${JSON.stringify(exits())}`); }
  }
  ok(!missed.length, `paged through all 500 in ${Math.round((Date.now() - t) / 1000)} s (${slow} pages over 5 s)${missed.length ? '; not drawn: ' + missed.slice(0, 10).join(',') : ''}`);

  // ----- zoomed in on pages across the book (sharp tiles of big scans: where the memory goes)
  for (const p of [3, 77, 149, 224, 248, 301, 399, 449, 474, 499]) {
    await goTo(p);
    await E(() => window.__gcc.viewer().setZoom(3));
    await sleep(1800);
    await track();
  }
  await E(() => window.__gcc.viewer().fit?.('page'));
  ok(true, `zoomed to 300% on 10 pages: max engine heap so far ${(maxHeap / GB).toFixed(2)} GB; exits ${JSON.stringify(exits())}`);

  // ----- the second file, both open
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), IR);
  ok(!!(await until(async () => (await E(() => window.__gcc.docs().length)) === 2, 120000)), 'the 150-page IR file opens in a second tab');
  t = Date.now();
  missed = [];
  for (let p = 0; p < 150; p++) { await goTo(p); if (!(await until(() => previewReady(p), 45000))) missed.push(p); if (p % 50 === 49) await track(); }
  ok(!missed.length, `paged through its 150 pages with the book open: ${Math.round((Date.now() - t) / 1000)} s${missed.length ? '; not drawn: ' + missed.slice(0, 10).join(',') : ''}`);

  // ----- markups, then a drawing engine killed: they must still show ("comments not showing")
  for (const p of [10, 20, 30]) await E(async (pg) => { const d = window.__gcc.active(); await d.create(pg, { type: 'Square', rect: [100, 100, 300, 260] }); await d.create(pg, { type: 'Text', rect: [320, 100, 340, 120], contents: 'checked ' + pg }); }, p);
  await goTo(20);
  await until(async () => (await inkedAnnots(20)) > 0, 20000);
  const a0 = await E(async () => (await window.__gcc.active().annots(20)).length);
  const killed = await app.evaluate(({ app: a }) => { const r = a.getAppMetrics().find((p) => /render0|Drawing engine 1/.test(p.name || p.serviceName || '')); if (r) process.kill(r.pid, 'SIGKILL'); return !!r; });
  await sleep(2500);
  for (const p of [19, 20, 21]) { await goTo(p); await until(() => previewReady(p), 45000); }
  const a1 = await E(async () => (await window.__gcc.active().annots(20)).length);
  ok(killed && a1 === a0 && a0 >= 2, `drawing engine killed: page 21's ${a0} markups still there (${a1})`);
  ok(!!(await until(async () => (await inkedAnnots(20)) > 0, 20000)), 'and drawn on the page');

  // ----- OCR a scanned page
  t = Date.now();
  await goTo(0);
  const words = await E(() => window.__gcc.ocr('eng')).catch((e) => { console.log('  ocr', e.message); return []; });
  ok(words.length > 20, `OCR of a scanned page: ${words.length} words in ${Date.now() - t} ms`);

  // ----- save as, and the file checks out
  const out = join(TMP, 'ir-saved.pdf');
  await app.evaluate((_e, f) => { globalThis.__q.save.push(f); }, out);
  t = Date.now();
  await win.keyboard.press('Control+Shift+s');
  const saved = await until(() => E(() => !window.__gcc.active().dirty && window.__gcc.active().name === 'ir-saved.pdf'), 300000);
  if (ok(!!saved, `save as: ${Math.round((Date.now() - t) / 1000)} s`)) {
    const d = mupdf.Document.openDocument(readFileSync(out), 'application/pdf').asPDF();
    const r = { repaired: d.wasRepaired(), pages: d.countPages(), ann: d.loadPage(20).getAnnotations().length };
    d.destroy();
    ok(!r.repaired && r.pages === 150 && r.ann >= 2, 'the saved file: ' + JSON.stringify(r));
  }

  // ----- the whole run
  ok(existsSync(join(PROFILE, 'logs', 'app.log')), 'the app log is there (engine exits read from it)');
  const x = exits();
  const m = await memory();
  console.log(`  engine exits: ${JSON.stringify(x)}; max drawing engine heap ${(maxHeap / GB).toFixed(2)} GB; app memory now ${m.total} MB (${m.top})`);
  ok(x.oom === 0, `no drawing engine ran out of memory (exit 70: ${x.oom})`);
  ok(x.other <= 1, `no unplanned engine stops besides the one killed on purpose (${x.other})`);
  ok(!pageErrors.length, `no errors in the window (${pageErrors.length})`);
} catch (e) {
  ok(false, 'error: ' + (e?.stack || e));
} finally {
  console.log(`\n${passes} passed, ${fails} failed`);
  const closed = await Promise.race([app.close().then(() => true, () => true), sleep(5000).then(() => false)]);
  if (!closed) app.process().kill('SIGKILL');
  process.exit(fails ? 1 : 0);
}
