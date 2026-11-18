// PLAN 10.5: the editing engine asks before it runs out of memory - and is never restarted unasked
// (its undo history would go). PDFED_TEST_HEAP gives the engine an `eatHeap` call (takes some of
// MuPDF's memory and keeps it); the window's limits (1.6 GB and 1.8 GB) are lowered by a test switch
// (localStorage pdfed-edit-heap-ask / -ask2) to just above where the engine is now.
//  - the limit passed: the question within 5 s, nothing restarted while it is open;
//  - Not now: the same engine process, Undo still works, a line stays in the status bar, not asked again;
//  - the second limit: asked again;
//  - Restart now: a new engine, the file open and marked changed, the markup there, Undo empty,
//    the file on disk untouched.
// xvfb-run -a node tests/e2e-editmem.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const TMP = resolve('tests/tmp-editmem');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'sheet.pdf');
copyFileSync('tests/data/steel-sections.pdf', F);
const fileId = () => createHash('sha256').update(readFileSync(F)).digest('hex') + statSync(F).mtimeMs;
const diskBefore = fileId();
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-editmem'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(100); } };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=editmem', '--gcc-renderers=2'], env: { ...process.env, PDFED_TEST_HEAP: '1' } });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1500, 900); });
await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
const E = (fn, a) => win.evaluate(fn, a);
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
await until(() => E(() => window.__gcc.active()?.pages.length > 0), 60000, 'open');
const question = () => E(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).filter((t) => /nearly out of memory/.test(t)));
const enginePid = () => app.evaluate(({ app: a }) => a.getAppMetrics().find((m) => /edit$/.test(m.name || ''))?.pid ?? 0);
const annotCount = () => E(async () => (await window.__gcc.active().annots(0)).length);
const eat = (mb) => E((n) => window.__gcc.engines.editor.call('eatHeap', [n]), mb);

const n0 = await annotCount();
await E(() => window.__gcc.active().create(0, { type: 'Square', rect: [50, 50, 150, 120], color: [1, 0, 0] }));
await until(() => E(() => window.__gcc.active().canUndo && window.__gcc.active().dirty), 10000, 'undo');
ok(true, 'a markup is added: changed, can be undone');
const h0 = await E(() => window.__gcc.engines.editor.call('heap'));
const MB = 2 ** 20;
await E(([a, b]) => { localStorage.setItem('pdfed-edit-heap-ask', String(a)); localStorage.setItem('pdfed-edit-heap-ask2', String(b)); localStorage.setItem('pdfed-hang-check-ms', '1000'); }, [h0 + 80 * MB, h0 + 260 * MB]);
const pid0 = await enginePid();
console.log(`  editing engine: ${Math.round(h0 / MB)} MB, pid ${pid0}; limits +80 MB and +260 MB`);

// ---- under the limit: no question
await sleep(7000);
ok((await question()).length === 0, 'under the limit: no question');

// ---- over the first limit: the question, nothing restarted
await eat(100);
const t0 = Date.now();
const q1 = await until(async () => (await question())[0], 15000, 'question');
ok(Date.now() - t0 < 8000, `the question comes within a few seconds (${Date.now() - t0} ms)`);
ok(/Restart it now\? Your changes are kept; undo starts again\./.test(q1), 'the question: ' + q1);
await sleep(4000);
ok((await E(() => window.__gcc.engines.editor.restarts)) === 0 && (await enginePid()) === pid0, 'nothing restarted while the question is open');

// ---- Not now: same engine, Undo still works, a line in the status bar, not asked again
await win.locator('.toast button', { hasText: 'Not now' }).click();
ok((await question()).length === 0, 'Not now: the question goes');
ok((await win.locator('.sb-btn', { hasText: 'Editing engine nearly out of memory' }).count()) === 1, 'a line stays in the status bar');
await E(() => window.__gcc.active().undo());
ok((await annotCount()) === n0, 'Undo still works');
await E(() => window.__gcc.active().redo());
ok((await annotCount()) === n0 + 1, 'Redo too');
await sleep(4000);
ok((await question()).length === 0 && (await enginePid()) === pid0, 'not asked again below the second limit; same engine process');

// ---- the second limit: asked again
await eat(200);
const q2 = await until(async () => (await question())[0], 15000, 'second question');
ok(!!q2, 'over the second limit: asked again');
await sleep(3000);
ok((await enginePid()) === pid0, 'still not restarted');

// ---- Restart now
await win.locator('.toast button', { hasText: 'Restart now' }).click();
await until(async () => (await E(() => window.__gcc.engines.editor.restarts)) === 1, 30000, 'restarted');
const pid1 = await until(async () => { const p = await enginePid(); return p && p !== pid0 ? p : 0; }, 20000, 'new process');
ok(pid1 !== pid0, `a new engine process (${pid0} -> ${pid1})`);
await until(() => E(async (n) => { const d = window.__gcc.active(); return d.pages.length > 0 && (await d.annots(0)).length === n; }, n0 + 1), 30000, 'file reopened with its markup');
ok(true, 'the file is open again with its markup');
ok(await E(() => window.__gcc.active().dirty), 'still marked changed');
await until(() => E(() => [...document.querySelectorAll('.toast')].some((t) => /refreshed/.test(t.textContent))), 10000, 'message');
ok(!(await E(() => window.__gcc.active().canUndo)), 'the undo history is gone');
ok(fileId() === diskBefore, 'the file on disk is untouched');
ok((await E(() => window.__gcc.engines.editor.call('heap'))) < h0 + 80 * MB, 'the new engine has its memory back');
await sleep(4000);
ok((await question()).length === 0, 'not asked again by the new engine');
ok((await win.locator('.sb-btn', { hasText: 'Editing engine nearly out of memory' }).count()) === 0, 'the status bar line is gone');
await E(() => window.__gcc.active().create(0, { type: 'Square', rect: [200, 200, 260, 240], color: [0, 0, 1] }));
ok((await annotCount()) === n0 + 2, 'a markup can be added again');

// ---- the batch engine gives its memory back: over its limit (lowered to just above where it is) after a
// call that leaves it holding nothing, it starts afresh by itself, and the next batch call works
{
  const b = () => E(() => window.__gcc.engines.batcher.call('heap'));
  const hb0 = await b();
  await E((a) => localStorage.setItem('pdfed-batch-heap', String(a)), hb0 + 80 * MB);
  const rb0 = await E(() => window.__gcc.engines.batcher.restarts);
  await E(() => window.__gcc.engines.batcher.call('eatHeap', [120]));
  ok((await b()) > hb0 + 100 * MB, `the batch engine holds more now (${Math.round(hb0 / MB)} -> ${Math.round((await b()) / MB)} MB)`);
  ok((await E(() => window.__gcc.engines.batcher.restarts)) === rb0, 'called directly (no batch job): not restarted');
  const n = await E((f) => window.__gcc.engines.muBatch('pageCountOf', { $file: { path: f } }), F);
  ok(n >= 1, 'a batch call works (' + n + ' pages)');
  await until(async () => (await E(() => window.__gcc.engines.batcher.restarts)) === rb0 + 1, 10000, 'batch engine restarted');
  ok(true, 'after the call it started afresh by itself');
  ok((await b()) < hb0 + 40 * MB, `its memory is back (${Math.round((await b()) / MB)} MB)`);
  ok((await E((f) => window.__gcc.engines.muBatch('pageCountOf', { $file: { path: f } }), F)) === n, 'the next batch call works');
}

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed (' + passes + ')');
process.exit(fails ? 1 : 0);
