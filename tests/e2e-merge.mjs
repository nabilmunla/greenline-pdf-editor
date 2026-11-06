// Merging a big set (tender volumes): 6 files, 2,544 pages, 1.26 GB - a file at a time, written to
// disk as it goes, progress in the dialog, Stop. (0.8.1 built it all in the engine's memory: past
// ~1 GB it ran out and nothing came out.)   xvfb-run -a node tests/e2e-merge.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const TMP = resolve('tests/tmp-merge');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
// (links, not copies: 1.3 GB; the names give the order)
const set = [['1 Book A.pdf', 'tests/huge/book1-317mb.pdf'], ['2 BOQ.pdf', 'tests/huge/boq-114mb.pdf'], ['3 Book B.pdf', 'tests/huge/book1-317mb.pdf'], ['4 Spec.pdf', 'tests/data/long-spec.pdf'], ['5 Plumbing.pdf', 'tests/huge/plumbing-133mb.pdf'], ['6 Book C.pdf', 'tests/huge/book1-317mb.pdf']];
if (!set.every(([, f]) => existsSync(f))) { console.log('SKIP: tests/huge files not here'); process.exit(0); }
for (const [n, f] of set) symlinkSync(resolve(f), join(TMP, n));
const names = set.map(([n]) => n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };
const ELECTRON = resolve('node_modules/electron/dist/electron');
const combine = (files) => Promise.all(files.map((f) => new Promise((res) => { const c = spawn(ELECTRON, [resolve('.'), '--no-sandbox', '--profile=merge', '--combine', join(TMP, f)], { stdio: 'ignore' }); c.on('exit', res); })));

rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-merge'), { recursive: true, force: true });
const app = await electron.launch({ executablePath: ELECTRON, args: [resolve('.'), '--no-sandbox', '--profile=merge'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
const dlg = () => win.locator('.modal', { hasText: 'Merge files' });

try {
  // 1. Stop part way: nothing made, the dialog and its list stay
  await combine(names);
  await until(() => dlg().count(), 20000, 'merge dialog');
  await until(async () => /2544 pages/.test(await dlg().locator('.btn.primary').textContent()), 30000, 'page counts');
  await dlg().locator('.btn.primary').click();
  const first = await until(() => dlg().locator('.mprog').textContent(), 5000, 'progress shown');
  ok(/File 1 of 6/.test(first), 'progress in the dialog: ' + first.trim());
  ok(await dlg().locator('.btn.primary').isDisabled(), 'Merge button off while merging (says ' + (await dlg().locator('.btn.primary').textContent()).trim() + ')');
  await until(async () => /File [23] of 6/.test(await dlg().locator('.mprog').textContent()), 60000, 'second file');
  await dlg().locator('button', { hasText: 'Stop' }).click();
  await until(async () => !(await dlg().locator('.mprog').count()), 60000, 'stopped');
  ok(await win.locator('.toast', { hasText: 'Merge stopped' }).count() > 0, 'Stop: "Merge stopped – no file was made."');
  ok(await win.evaluate(() => window.__gcc.docs().length) === 0 && await dlg().count() === 1, 'no tab made, the dialog and its list still there');

  // 2. the whole set: one new tab, every page, memory kept low
  const t0 = Date.now();
  await dlg().locator('.btn.primary').click();
  let seen = '';
  await until(async () => {
    const t = await dlg().locator('.mprog').textContent().catch(() => '');
    if (t) seen = t;
    return win.evaluate(() => window.__gcc.active()?.pages.length === 2544);
  }, 600000, 'merged tab');
  ok(true, `merged 6 files (1.26 GB) into a new tab: 2,544 pages in ${((Date.now() - t0) / 1000).toFixed(0)} s (last progress: ${seen.trim()})`);
  ok(!(await win.locator('.toast.err').count()), 'no error');
  const name = await win.evaluate(() => window.__gcc.active()?.name);
  ok(name === 'Merged.pdf', 'tab: ' + name);
  // a page from the last file draws
  await win.evaluate(() => window.__gcc.viewer().goTo(2543));
  await until(() => win.evaluate(() => { const d = window.__gcc.active(); return window.__gcc.tiles.has(`${d.id}|r${d.crev[2543]}|p|0|0`); }), 60000, 'last page drawn');
  ok(true, 'the last page (from the 6th file) draws');
  // 3. saved: Save as (it has no file yet)
  const out = join(TMP, 'Merged out.pdf');
  await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, out);
  const t1 = Date.now();
  await win.keyboard.press('Control+s');
  await until(async () => existsSync(out) && win.evaluate(() => !window.__gcc.active()?.dirty && /Merged out/.test(window.__gcc.active()?.name || '')), 600000, 'saved');
  const { statSync } = await import('node:fs');
  ok(statSync(out).size > 1.2e9, `saved: ${(statSync(out).size / 1e9).toFixed(2)} GB in ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  ok(!(await win.locator('.toast.err').count()), 'no error saving: ' + ((await win.locator('.toast.err').first().textContent().catch(() => '')) || ''));
  const { execFileSync } = await import('node:child_process');
  let chk = '';
  try { chk = execFileSync('qpdf', ['--check', out], { encoding: 'utf8', maxBuffer: 1 << 26 }); } catch (e) { chk = String(e.stdout || e.message); }
  ok(/No syntax or stream encoding errors/.test(chk), 'the saved file checks clean (qpdf): ' + chk.split('\n').filter(Boolean).pop());
} catch (e) { ok(false, e.message); await win.screenshot({ path: join(TMP, 'fail.png') }).catch(() => {}); }
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
