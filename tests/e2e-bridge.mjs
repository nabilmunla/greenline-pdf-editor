// PLAN 11.1 The bridge, in the built app: a Greenline copy (brand "greenline" in a copy of package.json, as in
// e2e-count) whose install folder is a company copy's - update.json names a "share" folder with a company
// release, resources/app.old has an unbranded package.json (the helper's copy of 0.12.1), the settings carry the
// share too - moves itself to the web feed (a local web server):
//  - within 10 s Settings shows the feed as the location and as the default (no "Restore default")
//  - update.json = the feed, no updateSource in settings, the other settings kept, reports queued for the share dropped
//  - the notice (words: src/ui/movedtext.ts) once, with the Go back line; the counter's pop-up comes after it
//  - the next check is answered by the web server (old code: "for another edition", still on the folder)
//  - a second start: no notice, nothing moved
//  - Go back: the settings hold the folder again
//  - trigger B: no Go back copy, the share's signed company release alone moves the copy at the first check
// xvfb-run -a node tests/e2e-bridge.mjs     (needs keys/update-signing-key.pem, as the update suites)
import { _electron as electron } from 'playwright';
import http from 'node:http';
import crypto from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync, symlinkSync, readdirSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
const { signLatest } = createRequire(import.meta.url)('../electron/updsig.cjs');
const KEY = readFileSync('keys/update-signing-key.pem', 'utf8');
const signed = (p) => JSON.stringify(signLatest(p, KEY), null, 2);

const TMP = resolve('tests/tmp-bridge');
rmSync(TMP, { recursive: true, force: true });
const INST = join(TMP, 'install'), SHARE = join(TMP, 'share'), GL = join(TMP, 'greenline');
for (const d of [INST, SHARE, GL, join(INST, 'resources', 'app.old')]) mkdirSync(d, { recursive: true });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync(join(GL, 'package.json'), JSON.stringify({ ...pkg, brand: 'greenline', displayName: 'Greenline PDF Editor' }, null, 2));
cpSync('electron', join(GL, 'electron'), { recursive: true });
for (const n of readdirSync('.')) if (!['package.json', 'electron', 'tests', '.git'].includes(n) && !existsSync(join(GL, n))) symlinkSync(resolve(n), join(GL, n));
const OLD = '0.12.0'; // (the app here is still 0.12.1 until the version is raised: the Go back copy must differ)
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-bridge');
const settings = () => { try { return JSON.parse(readFileSync(join(PROFILE, 'settings.json'), 'utf8')); } catch (_) { return {}; } };
const updateJson = () => { try { return JSON.parse(readFileSync(join(INST, 'update.json'), 'utf8')); } catch (_) { return null; } };
// the words of the notice, from the one place that holds them
const words = readFileSync('src/ui/movedtext.ts', 'utf8');
const WORD = (n) => new RegExp(`export const ${n} = '((?:[^'\\\\]|\\\\.)*)'`).exec(words)[1].replace(/\\'/g, "'");
const MOVED_TITLE = WORD('MOVED_TITLE'), MOVED_BODY = WORD('MOVED_BODY');
const COUNT_TITLE = /COUNT_TITLE = '([^']*)'/.exec(readFileSync('src/ui/counttext.ts', 'utf8'))[1];

// the company share: a company release (what the last release on the share is) - and the feed: Greenline's
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const zip = crypto.randomBytes(100000);
const release = (build) => ({ version: '9.9.9', build, runtime: process.versions.electron || '', notes: ['x'], app: { file: 'app-v9.9.9.zip', sha256: sha(zip), size: zip.length } });
writeFileSync(join(SHARE, 'app-v9.9.9.zip'), zip);
writeFileSync(join(SHARE, 'latest.json'), signed(release('company')));
const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.method + ' ' + req.url);
  if (req.url === '/feed/latest.json') { res.writeHead(200); res.end(signed(release('greenline'))); } else if (req.url === '/count') { res.writeHead(200); res.end('ok'); } else { res.writeHead(404); res.end('no'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FEED = `http://127.0.0.1:${server.address().port}/feed`;
const COUNT = `http://127.0.0.1:${server.address().port}/count`;

const ARGS = join(TMP, 'helper-args.txt');
const HELPER = join(TMP, 'helper.sh');
writeFileSync(HELPER, `#!/bin/sh\necho "$@" >> '${ARGS}'\n`);
chmodSync(HELPER, 0o755);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const ELECTRON = resolve('node_modules/electron/dist/electron');

/** a company copy's install folder and profile, as 0.12.1 left them */
function company({ appOld = true } = {}) {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  writeFileSync(join(INST, 'install.json'), JSON.stringify({ scope: 'user', version: pkg.version }));
  writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: SHARE }));
  rmSync(join(INST, 'resources', 'app.old', 'package.json'), { force: true });
  if (appOld) writeFileSync(join(INST, 'resources', 'app.old', 'package.json'), JSON.stringify({ version: OLD }));
  writeFileSync(join(PROFILE, 'settings.json'), JSON.stringify({ updateSource: SHARE, theme: 'dark', recent: ['/some/file.pdf'], lastRunVersion: pkg.version }));
  // a report written for the share, not yet copied there
  mkdirSync(join(PROFILE, 'reports-outbox'), { recursive: true });
  writeFileSync(join(PROFILE, 'reports-outbox', '20261117-101010_me_problem_0.12.1_abc.json'), JSON.stringify({ kind: 'problem', text: 'x' }));
}
async function launch(env = {}) {
  const app = await electron.launch({
    executablePath: ELECTRON, args: [GL, '--no-sandbox', '--profile=bridge'],
    env: { ...process.env, PDFED_INSTALL_DIR: INST, PDFED_UPDATE_HELPER: HELPER, PDFED_UPDATE_FEED: FEED, PDFED_COUNT_URL: COUNT, PDFED_COUNT_FIRST: '600000', PDFED_UPDATE_FIRST: '600000', PDFED_UPDATE_TIMEOUT: '4000', PDFED_REPORT_FIRST: '600000', ...env },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc).catch(() => false)); i++) await sleep(200);
  return { app, win };
}
const state = (win) => win.evaluate(() => window.gcc.updateGet());
const dlg = (win, title) => win.locator(`.modal[aria-label="${title}"]`);
const quit = async (app) => { await app.evaluate(({ app: a }) => a.quit()).catch(() => {}); await sleep(1500); };

try {
  // 1. trigger A: the helper's copy for Go back is the company's
  company();
  let t0 = Date.now();
  let { app, win } = await launch();
  await dlg(win, MOVED_TITLE).waitFor({ timeout: 10000 }).catch(() => {});
  ok(Date.now() - t0 < 10000 && await dlg(win, MOVED_TITLE).count() === 1, `the notice appears at the first start (${Date.now() - t0} ms)`);
  ok((await dlg(win, MOVED_TITLE).innerText()).includes(MOVED_BODY), 'with the shared words');
  ok(/Go back to 0\.12\.0/.test(await dlg(win, MOVED_TITLE).innerText()), 'and the Go back line, where the card offers it');
  ok(await dlg(win, COUNT_TITLE).count() === 0, 'the counter\'s pop-up is not under it');
  let s = await state(win);
  ok(s.source === FEED && s.web && s.defaultFor === FEED && !s.ownSource, 'the feed is the location and the default: ' + s.source);
  let st = settings();
  ok(st.updateSource === undefined && st.theme === 'dark' && st.recent?.[0] === '/some/file.pdf', 'no updateSource left in settings; the others kept');
  ok(JSON.stringify(updateJson()) === JSON.stringify({ source: FEED }), 'update.json names the feed');
  ok(st.cameFrom?.source === SHARE && st.cameFrom.until > Date.now() + 29 * 86400000 && st.moved && st.moved.shown === false, 'Go back kept for 30 days; the move recorded');
  ok(readdirSync(join(PROFILE, 'reports-outbox')).length === 0, 'the report queued for the share is dropped');
  await win.locator('.modal button', { hasText: 'OK' }).click();
  await dlg(win, COUNT_TITLE).waitFor({ timeout: 5000 }).catch(() => {});
  ok(await dlg(win, MOVED_TITLE).count() === 0 && await dlg(win, COUNT_TITLE).count() === 1, 'the counter\'s pop-up follows it');
  await win.locator('.modal button', { hasText: 'Turn it off' }).click();
  ok(settings().moved?.shown === true, 'the notice is marked seen');
  // Settings: the location, no "Restore default"
  await win.locator('.tb-btn[title="Settings"]').click();
  await win.locator('.modal .row', { hasText: 'Updates' }).locator('input').waitFor();
  ok((await win.locator('.modal .row', { hasText: 'Updates' }).locator('input').inputValue()) === FEED, 'Settings shows the feed as the location');
  ok(await win.locator('.modal button', { hasText: 'Restore default' }).count() === 0, 'and no "Restore default" button');
  await win.locator('.modal button', { hasText: 'Go back to 0.12.0' }).waitFor({ timeout: 4000 }).catch(() => {});
  ok(await win.locator('.modal button', { hasText: 'Go back to 0.12.0' }).count() === 1, 'Go back to 0.12.0 is offered');
  await win.keyboard.press('Escape');
  // the next check is answered by the web server
  // (a check already running - the moved copy's own, 1.5 s after start - answers "checking": wait for it)
  s = await win.evaluate(() => window.gcc.updateCheck());
  for (let i = 0; i < 100 && s.state === 'checking'; i++) { await new Promise((r) => setTimeout(r, 200)); s = await win.evaluate(() => window.gcc.updateGet()); }
  ok(s.state === 'available' && s.available === '9.9.9' && hits.includes('GET /feed/latest.json'), 'the next check is answered by the web: ' + s.state + ' ' + (s.err || ''));
  await quit(app);

  // 2. a second start: nothing moved, no notice
  hits.length = 0;
  ({ app, win } = await launch());
  await sleep(3500);
  ok(await win.locator('.modal').count() === 0, 'second start: no notice');
  s = await state(win);
  ok(s.source === FEED && settings().moved.shown === true && JSON.stringify(updateJson()) === JSON.stringify({ source: FEED }), 'nothing moved again');

  // 3. Go back: the helper goes back and the settings hold the folder again
  rmSync(ARGS, { force: true });
  const r = await win.evaluate(() => window.gcc.updateRollback());
  await sleep(3000);
  const calls = existsSync(ARGS) ? readFileSync(ARGS, 'utf8').trim().split('\n').filter((l) => l && !l.trim().startsWith('--worker ')) : [];
  ok(r === true && calls.length === 1 && calls[0].startsWith('--rollback --dir ' + INST), 'Go back starts the helper: ' + (calls[0] || r));
  st = settings();
  ok(st.updateSource === SHARE, 'the settings hold the folder again: ' + st.updateSource);
  ok(JSON.stringify(updateJson()) === JSON.stringify({ source: FEED }), 'update.json stays on the feed');
  await app.close().catch(() => {});

  // 4. trigger B: no Go back copy - the share's signed company release moves the copy at the first check
  company({ appOld: false });
  hits.length = 0;
  ({ app, win } = await launch());
  await sleep(2500);
  s = await state(win);
  ok(s.source === SHARE && !settings().moved, 'no Go back copy: nothing moved at start');
  s = await win.evaluate(() => window.gcc.updateCheck());
  ok(s.source === FEED && s.state === 'available' && !/another edition/.test(s.err || ''), 'the first check moves it and is answered by the web: ' + s.state + ' ' + (s.err || ''));
  st = settings();
  ok(st.updateSource === undefined && st.moved && JSON.stringify(updateJson()) === JSON.stringify({ source: FEED }) && st.cameFrom?.source === SHARE, 'moved: settings and update.json');
  await dlg(win, MOVED_TITLE).waitFor({ timeout: 3000 }).catch(() => {});
  await app.close().catch(() => {});
} catch (e) { console.log('FAIL exception ' + (e && e.stack || e)); fails++; }
server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
