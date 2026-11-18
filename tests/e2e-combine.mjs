// Explorer > "Combine with PDF Editor": Windows starts the app once per selected file with
// --combine; the running copy collects them into one Merge dialog (name order), merges into a
// new tab. Also when the app was not running (the first start is the one that stays).
// xvfb-run -a node tests/e2e-combine.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, writeFileSync, utimesSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

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
// PLAN 10.1 (B1): Stop during the first of two big generated files reaches the engine at once - the
// toast comes within 3 s (it waited for the whole file), no tab and no file are made, and the
// temp folder holds no merge-streams.bin
{
  // a generated file whose merge is slow: 150 pages of 600 links each (90,000 links, a few MB; the
  // links are what takes the time - about 8 s here). Two copies under other names.
  const makeLinkSet = (pages, links) => {
    const parts = ['%PDF-1.7\n']; const offs = []; let len = parts[0].length;
    const put = (n, body) => { offs[n] = len; const t = `${n} 0 obj\n${body}\nendobj\n`; parts.push(t); len += t.length; };
    put(1, '<< /Type /Catalog /Pages 2 0 R >>');
    put(2, `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`);
    put(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    for (let i = 0; i < pages; i++) {
      const an = Array.from({ length: links }, (_, j) => { const x = 10 + (j % 50) * 10, y = 10 + Math.floor(j / 50) * 10; return `<< /Type /Annot /Subtype /Link /Rect [${x} ${y} ${x + 8} ${y + 8}] /Border [0 0 0] /A << /S /URI /URI (https://example.com/${i}/${j}) >> >>`; }).join(' ');
      put(4 + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R /Annots [${an}] >>`);
      const c = `BT /F1 18 Tf 72 700 Td (PAGE ${i}) Tj ET`;
      put(5 + i * 2, `<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
    }
    const n = 4 + pages * 2, xr = len;
    let x = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (let k = 1; k < n; k++) x += String(offs[k]).padStart(10, '0') + ' 00000 n \n';
    return Buffer.from(parts.join('') + x + `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF\n`, 'latin1');
  };
  const CT = resolve('tests/tmp-combine-cancel');
  rmSync(CT, { recursive: true, force: true });
  mkdirSync(CT, { recursive: true });
  const two = ['Big 1.pdf', 'Big 2.pdf'];
  const gen = makeLinkSet(150, 600);
  for (const n of two) writeFileSync(join(CT, n), gen);
  const work = join(tmpdir(), 'PDF Editor', 'work');
  const spills = () => { const out = []; const walk = (d) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name === 'merge-streams.bin') out.push(f); } }; walk(work); return out; };
  rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-combcancel'), { recursive: true, force: true });
  const app = await electron.launch({ executablePath: ELECTRON, args: [resolve('.'), '--no-sandbox', '--profile=combcancel'] });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
  await Promise.all(two.map((f) => new Promise((res) => { const c = spawn(ELECTRON, [resolve('.'), '--no-sandbox', '--profile=combcancel', '--combine', join(CT, f)], { stdio: 'ignore' }); c.on('exit', res); })));
  await until(() => win.locator('.modal', { hasText: 'Merge files' }).count(), 20000, 'merge dialog');
  await win.locator('.modal .btn.primary:not([disabled])').click({ timeout: 20000 });
  // (inside the first file: its progress is up and the spill file has begun)
  await until(() => win.locator('.modal .mprog').count(), 10000, 'progress');
  await until(async () => spills().length > 0, 10000, 'spill file');
  ok(spills().length === 1, 'merging the first file: the engine has a merge-streams.bin');
  const t0 = Date.now();
  await win.locator('.modal .btn', { hasText: 'Stop' }).click();
  const toast = await until(async () => (await win.locator('.toast').allTextContents()).some((t) => /Merge stopped/.test(t)), 3000, 'stopped toast').catch(() => null);
  const ms = Date.now() - t0;
  ok(!!toast, `Stop: the "Merge stopped" toast came within 3 s (${ms} ms)`);
  ok(await win.evaluate(() => window.__gcc.docs().length) === 0, 'no tab made');
  await sleep(500);
  ok(spills().length === 0, 'the temp folder holds no merge-streams.bin');
  ok(!(await win.locator('.toast', { hasText: /error|failed|wrong/i }).count()), 'no error shown');
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  rmSync(CT, { recursive: true, force: true });
}

console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
