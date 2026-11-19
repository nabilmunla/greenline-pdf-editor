// Combining many large files (PLAN 7.14; the user, 16 Nov: "I should be able to combine a large number of
// files to use these features"). 40 generated files, 2.5-3 GB in all - scans of ~75 MB (three made, the rest
// copies under other names), line-work sheets, the generated drawing sets A and B - given to the app the way
// Explorer's "Combine with PDF Editor" does (one --combine start per file).
//  1. all 40 (2.7 GB) merged into a new tab - over 2 GB, which the editing engine opens since 0.12 (its .wasm
//     patched at start, PLAN 7.17; up to 4 GB): pages of the first / middle / last file drawn, Link the sheets on
//     the result, saved, every page there, qpdf clean (every object and stream read, all but the JPEGs
//     decoded: `qpdf --check` also decodes the 1,980 scanned pages' JPEGs - 33 s per scan file, about 20
//     minutes in all, past run-suites' 20-minute cap).
//     The batch engine (which did the merge) gives its memory back afterwards (PLAN 10.5): 10 s after the
//     merge it is under 400 MB, its peak during the merge is recorded, and the next batch job works.
//  2. a merge cancelled half-way: "Merge stopped", no temp file left, the open files as they were.
//  3. closed, the tab not saved again ("Don't save" - it was saved and checked in 1.): the window and every
//     process of the app gone within a minute (how long it took is printed), no temp file of its engines and
//     no recovery copy left.
// Memory over all of it: every process together under the 0.11.0 release check's 4.2 GB, no engine stopped.
// Generated files only.
//   xvfb-run -a -s "-screen 0 1600x1000x24" node tests/e2e-combine-big.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as mupdf from 'mupdf';
import { ensure, paths } from './rset.mjs';

const GEN = resolve('tests/tmp-bigset');
const TMP = resolve('tests/tmp-combine-big');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(GEN, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; return c; };
const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(250); } return null; };
const GB = 1024 ** 3;

// ---- the files (made once, kept in tests/tmp-bigset)
await ensure();
const scans = [1, 2, 3].map((k) => join(GEN, `scan-${k}.pdf`));
for (const [k, f] of scans.entries()) if (!existsSync(f)) { console.log('making', f); execFileSync('python3', ['tests/make-mega-scan.py', f, '55', String(20 + k)], { stdio: 'inherit' }); }
const files = [];
const add = (src, name) => { const to = join(TMP, name); copyFileSync(src, to); files.push(to); };
add(paths.setA, '00 Set A.pdf');
for (let i = 0; i < 36; i++) add(scans[i % 3], `${String(i + 1).padStart(2, '0')} IR scan ${i + 1}.pdf`);
add('tests/data/heavy-a0.pdf', '37 Line work 1.pdf');
add('tests/data/heavy-a0.pdf', '38 Line work 2.pdf');
add(paths.setB, '39 Set B.pdf');
const total = files.reduce((n, f) => n + statSync(f).size, 0);
const pagesOf = (f) => { const d = mupdf.Document.openDocument(readFileSync(f), 'application/pdf'); const n = d.countPages(); d.destroy?.(); return n; };
const counts = files.map(pagesOf);
const expect = counts.reduce((a, b) => a + b, 0);
console.log(`${files.length} files, ${(total / GB).toFixed(2)} GB, ${expect} pages`);
ok(files.length === 40 && total > 2.4 * GB, `40 files, ${(total / GB).toFixed(2)} GB`);

// ---- the app, and the files given to it as Explorer does
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-combbig');
rmSync(PROFILE, { recursive: true, force: true });
const ELECTRON = resolve('node_modules/electron/dist/electron');
const app = await electron.launch({ executablePath: ELECTRON, args: [resolve('.'), '--no-sandbox', '--profile=combbig'] });
const win = await app.firstWindow();
await until(() => win.evaluate(() => !!window.__gcc), 30000);
await app.evaluate(({ dialog }) => {
  globalThis.__q = { save: [] };
  dialog.showSaveDialog = async () => { const f = globalThis.__q.save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
  dialog.showMessageBox = async () => ({ response: 0 });
});
const E = (fn, a) => win.evaluate(fn, a);
let peak = 0, exits = 0;
const watch = setInterval(async () => {
  try {
    const m = await app.evaluate(({ app: a }) => a.getAppMetrics().reduce((n, x) => n + (x.memory?.workingSetSize || 0), 0) * 1024);
    peak = Math.max(peak, m);
  } catch { /* closing */ }
}, 1000);
// (the batch engine's memory during the merge: the figure each of its answers carries - PLAN 10.5; none on older code)
let batchPeak = 0;
const batchWatch = setInterval(async () => { try { batchPeak = Math.max(batchPeak, await E(() => window.__gcc.engines.batcher.heap || 0)); } catch { /* closing */ } }, 1000);
app.process().stdout?.on('data', (b) => { if (/exited 70|restarted \(exit 70\)/.test(String(b))) exits++; });
const combine = (list) => Promise.all(list.map((f) => new Promise((res) => { const c = spawn(ELECTRON, [resolve('.'), '--no-sandbox', '--profile=combbig', '--combine', f], { stdio: 'ignore' }); c.on('exit', res); c.on('error', res); })));

// ---- 1. all 40 (2.7 GB): opened in a new tab
let t0 = Date.now();
await combine(files);
ok(!!(await until(() => win.locator('.modal', { hasText: 'Merge files' }).count(), 60000)), 'one Merge dialog for the 40 files');
ok((await E(() => document.querySelectorAll('.modal .frow .fn').length)) === 40, 'all 40 listed');
await win.locator('.modal .btn.primary:not([disabled])').click({ timeout: 120000 });
const merged = await until(() => E((n) => window.__gcc.active()?.pages.length === n, expect), 30 * 60000);
ok(!!merged, `40 files (${(total / GB).toFixed(2)} GB) merged and opened in a new tab: ${expect} pages, ${Math.round((Date.now() - t0) / 1000)} s`);
const counts2 = counts, expect2 = expect;
// ---- the batch engine did the merge: 10 s later it has given its memory back, and still works
clearInterval(batchWatch);
await sleep(10000);
const batchRss = await E(() => window.__gcc.engines.batcher.call('memory'));
console.log(`  batch engine: peak MuPDF memory ${Math.round(batchPeak / 2 ** 20)} MB during the merge, ${Math.round(batchRss / 2 ** 20)} MB (process) 10 s after it`);
ok(batchRss < 400 * 2 ** 20, `the batch engine is under 400 MB 10 s after the Combine (${Math.round(batchRss / 2 ** 20)} MB)`);
ok((await E((f) => window.__gcc.engines.muBatch('pageCountOf', { $file: { path: f } }), files[1])) > 0, 'the next batch job works');
// ---- pages of the first, a middle and the last file drawn
const firstOf = (k) => counts2.slice(0, k).reduce((a, b) => a + b, 0);
for (const [what, pg] of [['first file', 0], ['a scan in the middle', firstOf(14) + 7], ['the last file', expect2 - 1]]) {
  // (the fit first, the jump a moment later: in the same moment the fit's zoom took the view back - a viewer
  // bug found here, fixed in Viewer.goTo and checked in e2e-view)
  await E(() => window.__gcc.viewer().fit('page'));
  await sleep(600);
  await E((p) => window.__gcc.viewer().goTo(p), pg);
  // (the page at the top of the view - not viewer.page(): Fit page fitted the first file's big sheet,
  // and at that zoom an A4 scan is a quarter of the view, so the page "now" is the one below it)
  const drawn = await until(() => E((p) => {
    const s = window.__gcc.tiles.stats(), e = document.querySelector(`.pg[data-page="${p}"]`), sc = e?.closest('[class*=scroll], .viewer, main');
    if (!e || !sc) return false;
    const top = e.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    return top >= -2 && top < sc.clientHeight / 3 && !s.queued && !s.inflight && e.querySelectorAll('canvas').length > 0;
  }, pg), 90000);
  if (!ok(!!drawn, `page ${pg + 1} (${what}) drawn`)) console.log('  ', JSON.stringify(await E((p) => ({ now: window.__gcc.viewer().page(), stats: window.__gcc.tiles.stats(), canv: document.querySelectorAll(`.pg[data-page="${p}"] canvas`).length, pg: !!document.querySelector(`.pg[data-page="${p}"]`), txt: document.querySelector(`.pg[data-page="${p}"]`)?.textContent?.slice(0, 100),
    // (where the view is: its scroll, the zoom and the pages around it, as laid out)
    zoom: window.__gcc.viewer().zoom(), fit: window.__gcc.active().view?.fit, scroll: (() => { const sc = document.querySelector(`.pg[data-page="${p}"]`)?.closest('[class*=scroll], .viewer, main'); return sc ? [sc.scrollTop, sc.clientHeight] : null; })(),
    around: [p - 1, p, p + 1, p + 2].map((k) => { const e = document.querySelector(`.pg[data-page="${k}"]`); const d = window.__gcc.active().pages[k]; return e ? [k, Math.round(e.getBoundingClientRect().top), Math.round(e.getBoundingClientRect().height), d && Math.round(d.w), d && Math.round(d.h)] : [k, null]; }) }), pg)));
}

// ---- saved: every page, a clean file
const OUT = join(TMP, 'combined.pdf');
const saved = await E((p) => window.__gcc.active().save(p).then(() => 'ok', (e) => String(e)), OUT);
ok(saved === 'ok' && existsSync(OUT), 'saved: ' + saved);
if (existsSync(OUT)) {
  const n2 = Number(execFileSync('qpdf', ['--show-npages', OUT], { encoding: 'utf8' }).trim());
  ok(n2 === expect2, `the saved file has every page (${n2} of ${expect2})`);
  // (written out by qpdf - to nowhere - with every stream it can unpack unpacked: a warning, exit 3, for
  // any object, length or packed stream it can't read; the JPEGs are copied, not decoded - see the top)
  const tq = Date.now();
  let check = '';
  try { execFileSync('qpdf', ['--stream-data=uncompress', '--decode-level=generalized', OUT, '/dev/null'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { check = `exit ${e.status}: ` + String(e.stderr || e).slice(0, 400); }
  ok(!check, `qpdf: clean - every object and stream read (${Math.round((Date.now() - tq) / 1000)} s)` + (check ? ' - ' + check : ''));
}

// ---- Link the sheets on the result: sets A and B are in it
await win.locator('.rtab', { hasText: /^Edit$|^Page$|^Pages$|^Insert$|^Review$/ }).first().click().catch(() => {});
const btn = win.locator('.ribbon .rb', { hasText: 'Link the sheets' }).first();
if (await btn.count()) {
  await btn.click();
  await win.locator('.modal').waitFor({ timeout: 10000 });
  await win.locator('.modal .btn.primary').click();
  const t1 = Date.now();
  const msg = await until(() => E(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).find((t) => /links? on|No sheet numbers|could not be read|nothing was changed/.test(t || ''))), 10 * 60000);
  if (!ok(!!msg && /links? on/.test(msg), `Link the sheets on the combined file (${Math.round((Date.now() - t1) / 1000)} s): ${msg}`)) console.log('   toasts:', JSON.stringify(await E(() => [...document.querySelectorAll('.toast, .modal')].map((t) => t.textContent?.slice(0, 200)))));
  const marks = await E(() => window.__gcc.engines.mu('outlineFull', window.__gcc.active().id).then((o) => (o.find((x) => x.title === 'Sheets')?.children || []).length));
  if (!ok(marks >= 79, `the Sheets group lists the sets' sheets (${marks})`)) {
    const g = await E(() => window.__gccSheets);
    console.log('   read', g?.read, 'with text', g?.withText, 'sizes', JSON.stringify(g?.sizes), 'marks', g && `${g.marks.length}: ${g.marks.slice(0, 3)} … ${g.marks.slice(-3)}`);
  }
} else ok(false, 'the Link the sheets button is there (PLAN 7.6)');

// ---- memory over the whole run
clearInterval(watch);
ok(peak < 4.2 * GB, `all processes at most ${(peak / GB).toFixed(2)} GB (0.11.0 release check: 4.14 GB)`);
ok(exits === 0, `no engine stopped (${exits})`);

// ---- a second merge, cancelled half-way: no temp file left, the open files as they were
const before = await E(() => window.__gcc.docs().map((d) => d.pages.length).join(','));
const WORK = join(tmpdir(), 'PDF Editor', 'work');
const temps = () => { try { return readdirSync(WORK).filter((n) => /merge/i.test(n)).length; } catch { return 0; } };
const tempBefore = temps();
await combine(files.slice(1, 25));
await until(() => win.locator('.modal', { hasText: 'Merge files' }).count(), 60000);
await win.locator('.modal .btn.primary:not([disabled])').click({ timeout: 120000 });
await sleep(4000);
const stop = win.locator('.modal button', { hasText: /^(Stop|Cancel)$/ }).first();
if (await stop.count()) await stop.click();
ok(!!(await until(() => E(() => [...document.querySelectorAll('.toast')].some((t) => /Merge stopped/.test(t.textContent || ''))), 60000)), 'Stop: "Merge stopped - no file was made."');
// (after a Stop the dialog stays, with its list: closed here)
await win.locator('.modal button', { hasText: /^Cancel$/ }).first().click({ timeout: 10000 }).catch(() => {});
await until(() => E(() => !document.querySelector('.modal')), 10000);
await sleep(3000);
ok((await E(() => window.__gcc.docs().map((d) => d.pages.length).join(','))) === before, 'cancelled: no new tab, the open file as it was');
ok(temps() <= tempBefore, `no temp file left (${temps()} / ${tempBefore})`);

// ---- 3. closed: "Don't save" for the tab (with every answer "Save" - as above - the close saved the 2.9 GB tab
// again: on the test machine its disk filled - the copies, the merge's temp file, the saved file, the drawing
// copy after Link the sheets and the save's own working copy - the save failed, so the close was called off,
// as it must be, and Playwright's close() waited for ever: the "hang at close")
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (a, b) => ({ response: /^Save changes/.test((b || a)?.message || '') ? 1 : 0 }); });
const pids = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => m.pid));
// (a process ended but not yet reaped by its parent is gone too)
const alive = () => pids.filter((p) => { try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${p}/stat`, 'utf8')); } catch { return false; } });
const tc = Date.now();
let closed = false;
void app.close().then(() => { closed = true; }, () => { closed = true; });
const gone = await until(async () => closed && !alive().length, 60000);
ok(!!gone, `closed: the window and all ${pids.length} processes gone in ${((Date.now() - tc) / 1000).toFixed(1)} s`);
if (!gone) { console.log('   still running:', JSON.stringify(alive())); for (const p of alive()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } }
// (what the tab had in the temp folder - the merge's 2.9 GB file, the drawing copy after Link the sheets - and
// its recovery copy went with it: nothing of these processes is left waiting for the next start to clear it)
const leftOver = (() => { try { return readdirSync(WORK).filter((n) => pids.includes(Number(n.split('-')[0]))); } catch { return []; } })();
ok(!leftOver.length, `closed: no temp file of its engines left (${leftOver.join(', ') || 'none'})`);
const recs = (() => { try { return readdirSync(join(PROFILE, 'recovery')); } catch { return []; } })();
ok(!recs.length, `closed: no recovery copy left (${recs.join(', ') || 'none'})`);
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
