// A merged file (a new tab: its source is a temp file) saved elsewhere with Save as: the editing engine
// keeps reading that temp source until the tab closes. It used to be deleted with the next drawing copy,
// so a heavy page looked at after the save and an engine restarted afterwards found their file gone
// ("ENOENT ... merged.pdf", Link the sheets then said the file could not be read) - 0.12, found with
// 40 files combined (e2e-combine-big). (Over 600 MB a change gives the drawing engines a whole copy, not
// "the temp source + changes": PDFED_TEST_WHOLE_AT=1 does that for this small set.)
// xvfb-run -a node tests/e2e-saveas-temp.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const TMP = resolve('tests/tmp-saveas-temp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
for (const n of ['A.pdf', 'B.pdf']) copyFileSync('tests/data/long-spec.pdf', join(TMP, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; return c; };
const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(200); } return null; };
const ELECTRON = resolve('node_modules/electron/dist/electron');
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-saveastemp');
rmSync(PROFILE, { recursive: true, force: true });

const app = await electron.launch({ executablePath: ELECTRON, args: [resolve('.'), '--no-sandbox', '--profile=saveastemp'], env: { ...process.env, PDFED_TEST_WHOLE_AT: '1' } });
const win = await app.firstWindow();
await until(() => win.evaluate(() => !!window.__gcc));
await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); dialog.showMessageBox = async () => ({ response: 0 }); }, join(TMP, 'saved.pdf'));
const E = (fn, a) => win.evaluate(fn, a);
await Promise.all(['A.pdf', 'B.pdf'].map((n) => new Promise((r) => { const c = spawn(ELECTRON, [resolve('.'), '--no-sandbox', '--profile=saveastemp', '--combine', join(TMP, n)], { stdio: 'ignore' }); c.on('exit', r); })));
await until(() => win.locator('.modal', { hasText: 'Merge files' }).count());
await win.locator('.modal .btn.primary:not([disabled])').click({ timeout: 60000 });
ok(!!(await until(() => E(() => window.__gcc.active()?.pages.length === 3000), 120000)), 'merged into a new tab (3,000 pages)');
const engineSrc = await E(() => window.__gcc.engines.mu('sourceOf', window.__gcc.active().id).then((s) => s?.path || ''));
ok(/merged/i.test(engineSrc) && existsSync(engineSrc), 'the editing engine reads a temp file: ' + engineSrc);
// Save as (the temp source is not the file any more), then a change: a new drawing copy
ok((await E((p) => window.__gcc.active().save(p).then(() => 'ok', (e) => String(e)), join(TMP, 'saved.pdf'))) === 'ok', 'saved as saved.pdf');
await E(() => window.__gcc.active().rotate([0], 90));
await sleep(2500);
ok(existsSync(engineSrc), 'after a change, the temp file the editing engine reads is still there');
// a drawing engine restarted: the file opened again in it
const pids = await app.evaluate(({ app: a }) => a.getAppMetrics().filter((m) => m.type === 'Utility' && /render/i.test(m.name || m.serviceName || '')).map((m) => m.pid));
if (pids.length) process.kill(pids[0], 'SIGKILL');
await sleep(4000);
await E(() => { window.__gcc.viewer().goTo(2999); });
await sleep(2500);
const log = readFileSync(join(PROFILE, 'logs', 'app.log'), 'utf8');
ok(!/ENOENT[^\n]*merged/.test(log), 'no "file gone" in the log after the save, the change and the engine restart');
ok(await E(() => window.__gcc.active()?.pages.length === 3000), 'the tab still has every page');
// closed: the temp file goes then
const cut = (p, ms) => Promise.race([p, sleep(ms)]);
await cut(E(() => window.__gcc.active().close?.()).catch(() => {}), 10000);
await sleep(1500);
await cut(app.close().catch(() => {}), 15000);
try { app.process().kill('SIGKILL'); } catch { /* gone */ }
rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
