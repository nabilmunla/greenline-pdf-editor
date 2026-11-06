// Explorer > "Combine with PDF Editor": Windows starts the app once per selected file with
// --combine; the running copy collects them into one Merge dialog (name order), merges into a
// new tab. Also when the app was not running (the first start is the one that stays).
// xvfb-run -a node tests/e2e-combine.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, writeFileSync, utimesSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const TMP = resolve('tests/tmp-combine');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const names = ['Sheet 10.pdf', 'Sheet 2.pdf', 'Sheet 1.pdf', 'Plan A.pdf'];
for (const n of names) copyFileSync('tests/data/long-spec.pdf', join(TMP, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };
const ELECTRON = resolve('node_modules/electron/dist/electron');
const others = (files) => Promise.all(files.map((f) => new Promise((res) => { const c = spawn(ELECTRON, [resolve('.'), '--no-sandbox', '--profile=combine', '--combine', join(TMP, f)], { stdio: 'ignore' }); c.on('exit', res); })));

const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-combine');
for (const fresh of [false, true]) {
  rmSync(PROFILE, { recursive: true, force: true });
  if (fresh) {
    // left from an earlier selection whose start never came up: a lock naming a process that has
    // ended, and an entry 10 minutes old - the lock is taken over, the old file not mixed in
    mkdirSync(join(PROFILE, 'combine'), { recursive: true });
    writeFileSync(join(PROFILE, 'combine', 'launch.lock'), '999999 1');
    copyFileSync('tests/data/long-spec.pdf', join(TMP, 'Old one.pdf'));
    const old = join(PROFILE, 'combine', '1-1-0.path');
    writeFileSync(old, join(TMP, 'Old one.pdf'));
    utimesSync(old, new Date(Date.now() - 600000), new Date(Date.now() - 600000));
    // and one 30 s old: young enough, but from before a pause - an earlier selection, not mixed in
    const earlier = join(PROFILE, 'combine', '2-1-0.path');
    writeFileSync(earlier, join(TMP, 'Old one.pdf'));
    utimesSync(earlier, new Date(Date.now() - 30000), new Date(Date.now() - 30000));
  }
  const args = [resolve('.'), '--no-sandbox', '--profile=combine', ...(fresh ? ['--combine', join(TMP, names[0])] : [])];
  const app = await electron.launch({ executablePath: ELECTRON, args });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  if (!fresh) await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
  // the other files: each its own start, all at once (as Explorer does)
  await others(fresh ? names.slice(1) : names);
  await until(() => win.locator('.modal', { hasText: 'Merge files' }).count(), 20000, 'merge dialog');
  await sleep(1500);
  const listed = await win.evaluate(() => [...document.querySelectorAll('.modal .frow .fn')].map((e) => e.getAttribute('title').split(/[\\/]/).pop()));
  const order = names.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  ok(JSON.stringify(listed) === JSON.stringify(order), `${fresh ? 'not running' : 'running'}: one Merge dialog with all ${names.length} files in name order: ${listed.join(', ')}`);
  ok(await win.evaluate(() => window.__gcc.docs().length) === 0, 'nothing opened as separate tabs');
  ok(!existsSync(join(PROFILE, 'combine', 'launch.lock')) && readdirSync(join(PROFILE, 'combine')).length === 0, 'the spool is empty afterwards, no launch.lock left');
  await win.locator('.modal .btn.primary').click();
  await until(() => win.evaluate(() => window.__gcc.active()?.pages.length === 6000), 60000, 'merged');
  ok(true, 'merged into a new tab: 4 x 1500 pages');
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await sleep(800);
}
// another dialog open (Settings): the files wait for it; a second batch joins the open Merge dialog
{
  rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-combine'), { recursive: true, force: true });
  const app = await electron.launch({ executablePath: ELECTRON, args: [resolve('.'), '--no-sandbox', '--profile=combine'] });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
  await win.locator('.tb-btn[title="Settings"]').click();
  await win.locator('.modal', { hasText: 'Settings' }).waitFor({ timeout: 5000 });
  await others(names.slice(0, 2));
  await sleep(2500);
  ok(await win.locator('.modal', { hasText: 'Settings' }).count() === 1 && await win.locator('.modal', { hasText: 'Merge files' }).count() === 0, 'Settings left open: the files wait');
  ok((await win.locator('.toast').allTextContents()).some((t) => /Combine: 2 files from Explorer/.test(t)), 'and a note says so');
  await win.keyboard.press('Escape');
  await until(() => win.locator('.modal', { hasText: 'Merge files' }).count(), 8000, 'merge after settings');
  ok(true, 'Settings closed: the Merge dialog opens with them');
  await others(names.slice(2));
  await sleep(2500);
  const listed = await win.evaluate(() => [...document.querySelectorAll('.modal .frow .fn')].map((e) => e.getAttribute('title').split(/[\\/]/).pop()));
  ok(JSON.stringify(listed) === JSON.stringify(['Plan A.pdf', 'Sheet 1.pdf', 'Sheet 2.pdf', 'Sheet 10.pdf']), 'a second batch joins the open Merge dialog, the list still in name order: ' + listed.join(', '));
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
}
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
