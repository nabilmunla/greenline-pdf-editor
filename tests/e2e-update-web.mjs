// Updates from the web (the public build's GitHub releases), end to end in the real app against a
// local web server: found, downloaded and checked; nothing published yet; no server; a damaged
// package; a version that needs its setup (the card opens the download page); the build's own
// address used when nothing else is set; Report a problem keeps the report here.
// xvfb-run -a node tests/e2e-update-web.mjs
import { _electron as electron } from 'playwright';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
const { signLatest } = createRequire(import.meta.url)('../electron/updsig.cjs');
const KEY = readFileSync('keys/update-signing-key.pem', 'utf8');
const signed = (payload) => JSON.stringify(signLatest(payload, KEY), null, 2);

const TMP = resolve('tests/tmp-update-web');
rmSync(TMP, { recursive: true, force: true });
const INST = join(TMP, 'install');
mkdirSync(join(INST, 'resources', 'app.old'), { recursive: true });
const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-updweb');
const HELPER = join(TMP, 'helper.sh');
writeFileSync(HELPER, '#!/bin/sh\nexit 0\n');
chmodSync(HELPER, 0o755);
writeFileSync(join(INST, 'install.json'), JSON.stringify({ scope: 'user', version: VERSION }));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pkg = crypto.randomBytes(400000);

// the web server: /feed/latest.json + /feed/<package>; what it answers is set per step
let files = {}; const hits = [];
const posts = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.method === 'POST' && req.url === '/report') {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => { posts.push(JSON.parse(body)); res.writeHead(200); res.end('Thanks'); });
    return;
  }
  const f = files[decodeURIComponent(req.url)];
  if (!f) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Length': f.length });
  res.end(f);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FEED = `http://127.0.0.1:${server.address().port}/feed`;
const publish = (over = {}, body = pkg) => {
  files = {
    '/feed/latest.json': Buffer.from(signed({ version: '9.9.9', runtime: process.versions.electron || '', notes: ['From the web'], app: { file: 'app-v9.9.9.zip', sha256: sha(pkg), size: pkg.length }, ...over })),
    '/feed/app-v9.9.9.zip': body,
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const ELECTRON = resolve('node_modules/electron/dist/electron');
async function launch(env = {}) {
  rmSync(PROFILE, { recursive: true, force: true });
  const app = await electron.launch({
    executablePath: ELECTRON, args: [resolve('.'), '--no-sandbox', '--profile=updweb'],
    env: { ...process.env, PDFED_INSTALL_DIR: INST, PDFED_UPDATE_HELPER: HELPER, PDFED_UPDATE_FIRST: '600000', PDFED_UPDATE_TIMEOUT: '4000', PDFED_UPDATE_STALL: '4000', PDFED_REPORT_FIRST: '600000', ...env },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc).catch(() => false)); i++) await sleep(200);
  return { app, win };
}
const state = (win) => win.evaluate(() => window.gcc.updateGet());
const check = (win) => win.evaluate(() => window.gcc.updateCheck());
async function waitState(win, want, ms = 8000) {
  const t = Date.now(); let s;
  while (Date.now() - t < ms) { s = await state(win); if ([].concat(want).includes(s.state)) return s; await sleep(150); }
  return s;
}

try {
  // 1. the installer named the web address: found, downloaded, checked
  writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: FEED }));
  publish();
  let { app, win } = await launch();
  let s = await check(win);
  ok(s.state === 'available' && s.available === '9.9.9' && s.web === true, 'a new version found on the web: ' + s.state + ' ' + (s.err || ''));
  await win.evaluate(() => window.gcc.updateDownload());
  s = await waitState(win, ['ready', 'error'], 10000);
  const local = join(PROFILE, 'updates', 'app-v9.9.9.zip');
  ok(s.state === 'ready' && existsSync(local) && sha(readFileSync(local)) === sha(pkg), 'downloaded and checked: ' + s.state + ' ' + (s.err || ''));
  ok(hits.includes('/feed/app-v9.9.9.zip'), 'the package came from the address next to latest.json');

  // 2. a package that isn't what latest.json signed: refused
  publish({}, crypto.randomBytes(400000));
  rmSync(local, { force: true });
  await win.evaluate(() => window.gcc.updateSource(null));
  s = await check(win);
  await win.evaluate(() => window.gcc.updateDownload());
  s = await waitState(win, ['ready', 'error'], 10000);
  ok(s.state === 'error' && /checksum/i.test(s.err || '') && !existsSync(local), 'a damaged download is refused: ' + (s.err || s.state));

  // 3. a package bigger than announced: stopped
  publish({}, Buffer.concat([pkg, Buffer.alloc(5000)]));
  await win.evaluate(() => window.gcc.updateSource(null));
  await check(win);
  await win.evaluate(() => window.gcc.updateDownload());
  s = await waitState(win, ['ready', 'error'], 10000);
  ok(s.state === 'error' && !existsSync(local), 'more bytes than latest.json says: stopped (' + (s.err || s.state) + ')');

  // 3b. a release of the other edition (same signing key): refused
  publish({ build: 'greenline' });
  await win.evaluate(() => window.gcc.updateSource(null));
  s = await check(win);
  ok(s.state === 'error' && /another edition/.test(s.err || ''), 'a release of the other edition is refused: ' + (s.err || s.state));
  publish({ build: 'company' });
  await win.evaluate(() => window.gcc.updateSource(null));
  s = await check(win);
  ok(s.state === 'available', 'its own edition is taken: ' + s.state);

  // 4. nothing published yet
  files = {};
  await win.evaluate(() => window.gcc.updateSource(null));
  s = await check(win);
  ok(s.state === 'empty', 'no latest.json there yet: "nothing published" - ' + s.state);

  // 5. a version with a new runtime: the card points at the download page, nothing downloaded
  publish({ runtime: '1.0.0-other' });
  await win.evaluate(() => window.gcc.updateSource(null));
  s = await check(win);
  ok(s.state === 'setup' && s.setupPath === FEED, 'a new runtime: installs with its setup, from the download page (' + s.state + ' ' + s.setupPath + ')');
  await win.locator('.upcard button', { hasText: 'Open the download page' }).waitFor({ timeout: 4000 }).then(() => ok(true, 'the card offers the download page'), () => ok(false, 'the card offers the download page'));

  // 6. Report a problem: kept on this PC, nothing sent (no GitHub address here: no issue page)
  const rep = await win.evaluate(() => window.gcc.reportProblem('The ruler is upside down', false, { openFiles: 0 }));
  ok(rep.state === 'web' && !rep.issue && rep.waiting === 1 && !hits.some((h) => /report/i.test(h)), 'a report stays on this PC: ' + JSON.stringify({ state: rep.state, waiting: rep.waiting }));
  await app.close().catch(() => {});

  // 6b. the public build's receiver: Report a problem goes anonymously; crash reports only once
  // turned on, and only those made from then on
  ({ app, win } = await launch({ PDFED_REPORT_ENDPOINT: FEED.replace('/feed', '/report') }));
  const me = os.userInfo().username, pcName = os.hostname();
  let rs = await win.evaluate(() => window.gcc.reportStatus());
  ok(rs.anon === true && rs.crashes === false, 'with a receiver: anonymous, crash reports off to begin with');
  rs = await win.evaluate((t) => window.gcc.reportProblem(t, false, { openFiles: 1 }), `Ruler wrong in C:\\Users\\${me}\\Desktop\\Tower.pdf - ${me} on ${pcName}`);
  const p1 = posts[posts.length - 1] || {};
  ok(rs.state === 'sent' && rs.anon && posts.length === 1 && p1.kind === 'problem', 'Report a problem: sent to the receiver (' + rs.state + ')');
  const blob = JSON.stringify(p1);
  ok(!blob.includes(me) && !blob.includes(pcName) && /Ruler wrong/.test(p1.text) && !('user' in p1) && !('pc' in p1) && /:00:00\.000Z$/.test(p1.time || ''), 'no user or PC name, the time to the hour, the words kept');
  await win.evaluate(() => window.gcc.reportCrash('window', 'TypeError: before consent', ''));
  await sleep(4500);
  await win.evaluate(() => window.gcc.reportFlush ? window.gcc.reportFlush() : null);
  ok(posts.length === 1, 'a crash before the box is ticked: not sent');
  rs = await win.evaluate(() => window.gcc.reportCrashSharing(true));
  ok(rs.crashes === true, 'crash reports turned on');
  await sleep(3000);
  ok(posts.length === 1, 'the crash from before is still not sent');
  await win.evaluate(() => window.gcc.reportCrash('window', 'TypeError: after consent at C:\\x\\y.pdf', ''));
  for (let i = 0; i < 40 && posts.length < 2; i++) await sleep(250);
  ok(posts.length === 2 && posts[1].kind === 'crash' && /after consent/.test(posts[1].message) && !posts[1].message.includes('y.pdf'), 'a crash after: sent, path taken out (' + (posts[1] && posts[1].message) + ')');
  const ex = await win.evaluate(() => window.gcc.reportPreview());
  ok(ex.includes('"kind": "crash"') && !ex.includes(me) && !ex.includes(pcName), 'Settings shows an example of what is sent');
  await win.locator('.tb-btn[title="Settings"]').click();
  await win.locator('.modal .anon-what summary').click();
  await win.locator('.modal .anon-what button', { hasText: 'Show an example' }).click();
  const shown = await win.locator('.modal .anon-example').waitFor({ timeout: 4000 }).then(() => true, () => false);
  const ticked = await win.locator('.modal label.check', { hasText: 'Send anonymous crash reports' }).locator('input').isChecked().catch(() => false);
  ok(shown && ticked, `Settings > Help: the switch (${ticked}), what is sent, the example (${shown})`);
  await app.close().catch(() => {});

  // 7. no server at all: quietly "not reachable", quickly
  server.close();
  ({ app, win } = await launch());
  const t0 = Date.now();
  s = await check(win);
  ok(s.state === 'unreachable' && Date.now() - t0 < 6000 && await win.locator('.upcard').count() === 0, `no server: quietly "not reachable" (${Date.now() - t0} ms)`);
  await app.close().catch(() => {});

  // 8. the build's own address: used when the installer named none; a folder the person chose wins
  rmSync(join(INST, 'update.json'), { force: true });
  ({ app, win } = await launch({ PDFED_UPDATE_FEED: 'https://github.com/someone/greenline-pdf-editor' }));
  s = await state(win);
  ok(s.source === 'https://github.com/someone/greenline-pdf-editor' && s.web && s.defaultSource === s.source, 'no updates folder from the installer: the build\'s own address (' + s.source + ')');
  s = await win.evaluate(() => window.gcc.updateSource('/some/folder'));
  ok(s.source === '/some/folder' && !s.web, 'a folder chosen in Settings comes first');
  s = await win.evaluate(() => window.gcc.updateSource(null));
  ok(s.source === 'https://github.com/someone/greenline-pdf-editor', 'and back to the build\'s own address');
  await app.close().catch(() => {});
  // "no updates" chosen in the setup (update.json with an empty source): the build's own address isn't used
  writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: '' }));
  ({ app, win } = await launch({ PDFED_UPDATE_FEED: 'https://github.com/someone/greenline-pdf-editor' }));
  s = await state(win);
  ok(s.source === '' && (await check(win)).state === 'off', '"no updates" chosen in the setup stays so (' + JSON.stringify(s.source) + ')');
  await app.close().catch(() => {});
  // the setup named a folder (0.9.2's setup took a copy of a release it was run next to): one click
  // in Settings goes back to the build's own address
  writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: '/some/release-copy' }));
  ({ app, win } = await launch({ PDFED_UPDATE_FEED: 'https://github.com/someone/greenline-pdf-editor' }));
  s = await state(win);
  ok(s.source === '/some/release-copy' && !s.ownSource, 'a folder from the setup is used (' + s.source + ')');
  await win.locator('.tb-btn[title="Settings"]').click();
  await win.locator('.modal .link', { hasText: 'Use the download page (default)' }).click();
  await sleep(300);
  s = await state(win);
  ok(s.source === 'https://github.com/someone/greenline-pdf-editor' && s.web && await win.locator('.modal .link', { hasText: 'Use the download page (default)' }).count() === 0, 'Settings: "Use the download page (default)" goes to the build\'s own address (' + s.source + ')');
  await win.keyboard.press('Escape');
  rmSync(join(INST, 'update.json'), { force: true });
  await app.close().catch(() => {});
  ({ app, win } = await launch({ PDFED_UPDATE_FEED: 'https://github.com/someone/greenline-pdf-editor' }));
  const rep2 = await win.evaluate(() => window.gcc.reportProblem('Crash when opening a sheet\nSecond line', false, { openFiles: 2 }));
  const body = rep2.issue ? decodeURIComponent(rep2.issue.split('body=')[1]) : '';
  ok(rep2.state === 'web' && rep2.issue.startsWith('https://github.com/someone/greenline-pdf-editor/issues/new?title=Crash%20when%20opening%20a%20sheet&body='), 'Report a problem: a new GitHub issue with the text');
  ok(body.includes('Second line') && body.includes('Version ' + VERSION) && !body.includes(os.userInfo().username) && !body.includes(os.hostname()), 'the issue has the version - not the user or PC name');
  await app.close().catch(() => {});
} catch (e) { console.log('FAIL exception ' + (e && e.stack || e)); fails++; }
server.close();
console.log(fails ? `${passes} passed, ${fails} failed` : `all passed (${passes})`);
process.exit(fails ? 1 : 0);
