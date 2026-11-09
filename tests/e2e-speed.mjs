// The things that made the app slower the longer it was used: the settings file (stamps and
// signatures make it MBs) read from disk at every call, and the preview cache looked through whole
// after every 60 pictures. xvfb-run -a node tests/e2e-speed.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const TMP = resolve('tests/tmp-speed');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
copyFileSync('tests/data/heavy-a0.pdf', join(TMP, 'sheet.pdf'));
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-speed');
rmSync(PROFILE, { recursive: true, force: true });
const CACHE = join(PROFILE, 'cache', 'previews');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// a settings file that has grown: 6 MB of stamp pictures
mkdirSync(PROFILE, { recursive: true });
const stamps = [];
for (let i = 0; i < 10; i++) stamps.push({ id: 's' + i, name: 'Stamp ' + i, image: 'data:image/png;base64,' + randomBytes(450000).toString('base64'), w: 100, h: 60 });
writeFileSync(join(PROFILE, 'settings.json'), JSON.stringify({ stamps, author: 'Tester' }, null, 2));
// a preview cache that has filled up: 400 files of 10 kB (4 MB) against a 2 MB limit, old ones first
mkdirSync(CACHE, { recursive: true });
const blob = Buffer.alloc(10000, 1);
const now = Date.now() / 1000;
for (let i = 0; i < 400; i++) { const f = join(CACHE, 'old-' + i + '.webp'); writeFileSync(f, blob); utimesSync(f, now - 86400 * 30 + i * 60, now - 86400 * 30 + i * 60); }

const app = await electron.launch({
  executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=speed'],
  env: { ...process.env, PDFED_CACHE_MAX: '2000000', PDFED_CACHE_LIST_MS: '1500', PDFED_UPDATE_FIRST: '600000', PDFED_REPORT_FIRST: '600000' },
});
try {
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  await win.waitForFunction(() => !!window.__gcc && !!document.querySelector('.start-hero'), null, { timeout: 60000 });

  // settings: read from memory while the file is unchanged, read again once it changes
  const t = await win.evaluate(async () => { const a = performance.now(); for (let i = 0; i < 20; i++) await window.gcc.info(); return (performance.now() - a) / 20; });
  ok(t < 8, `the settings aren't read from disk at every call (${t.toFixed(1)} ms a call with 6 MB of settings)`);
  let s = await win.evaluate(() => window.gcc.settings());
  ok(s.stamps.length === 10 && s.author === 'Tester', 'the settings as they are on disk');
  const j = JSON.parse(readFileSync(join(PROFILE, 'settings.json'), 'utf8'));
  j.author = 'Changed outside';
  writeFileSync(join(PROFILE, 'settings.json'), JSON.stringify(j, null, 2));
  s = await win.evaluate(() => window.gcc.settings());
  ok(s.author === 'Changed outside' && s.stamps.length === 10, 'a settings file changed by something else is read again');
  // what a caller changes in what it got doesn't change the settings kept
  await win.evaluate(() => window.gcc.setSettings({ snap: false }));
  s = await win.evaluate(() => window.gcc.settings());
  const disk = JSON.parse(readFileSync(join(PROFILE, 'settings.json'), 'utf8'));
  ok(s.snap === false && disk.snap === false && disk.author === 'Changed outside' && disk.stamps.length === 10, 'a change is written, with everything else kept');
  const m0 = statSync(join(PROFILE, 'settings.json')).mtimeMs;
  await sleep(50);
  await win.evaluate(() => window.gcc.setSettings({ snap: false }));
  ok(statSync(join(PROFILE, 'settings.json')).mtimeMs === m0, 'a setting set to what it already was isn\'t written again');

  // the preview cache: listed in the background, trimmed to 90% of its limit, oldest first
  const sizeOf = () => readdirSync(CACHE).reduce((a, f) => a + statSync(join(CACHE, f)).size, 0);
  let tt = Date.now();
  while (Date.now() - tt < 15000 && sizeOf() > 2000000) await sleep(200);
  const left = readdirSync(CACHE);
  ok(sizeOf() <= 1800000 && sizeOf() > 1000000, `a full cache is trimmed to 90% of its limit (${(sizeOf() / 1e6).toFixed(2)} MB left)`);
  ok(!left.includes('old-0.webp') && left.includes('old-399.webp'), 'the pictures used longest ago go first');
  // a file opened now: its previews go in, the cache stays under the limit
  await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), join(TMP, 'sheet.pdf'));
  await win.waitForFunction(() => window.__gcc.active()?.pages.length > 0, null, { timeout: 60000 });
  tt = Date.now();
  while (Date.now() - tt < 20000 && !readdirSync(CACHE).some((f) => !f.startsWith('old-'))) await sleep(200);
  await sleep(1500);
  const mine = readdirSync(CACHE).filter((f) => !f.startsWith('old-'));
  ok(mine.length > 0 && sizeOf() <= 2000000, `the new file's previews are kept (${mine.length}), the cache stays under its limit (${(sizeOf() / 1e6).toFixed(2)} MB)`);
} catch (e) { console.log('FAIL exception ' + (e && e.stack || e)); fails++; }
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
