// Updates of an installed copy, end to end in the real app (the Windows setup helper is replaced
// by a script that writes down how it was called). Also: a share that's unreachable or hangs,
// a damaged or stalled download, "Later", "When I close it", going back, the portable copy.
// xvfb-run -a node tests/e2e-update.mjs
import { _electron as electron } from 'playwright';
import crypto from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync, chmodSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { signLatest } = createRequire(import.meta.url)('../electron/updsig.cjs');
const KEY = readFileSync('keys/update-signing-key.pem', 'utf8');
/** latest.json as the publisher writes it: signed (only a signed one is trusted from 0.8.2) */
const signed = (payload) => JSON.stringify(signLatest(payload, KEY), null, 2);

const TMP = resolve('tests/tmp-update');
rmSync(TMP, { recursive: true, force: true });
const INST = join(TMP, 'install'), SHARE = join(TMP, 'share'), HANG = join(TMP, 'hang');
for (const d of [INST, SHARE, HANG, join(INST, 'resources', 'app.old')]) mkdirSync(d, { recursive: true });
copyFileSync('tests/data/long-spec.pdf', join(TMP, 'spec.pdf'));
const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-update');
const ARGS = join(TMP, 'helper-args.txt');
const HELPER = join(TMP, 'helper.sh');
writeFileSync(HELPER, `#!/bin/sh\necho "$@" >> '${ARGS}'\n`);
chmodSync(HELPER, 0o755);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pkg = crypto.randomBytes(300000);
const notes = ['Faster drawing of big sheets', 'New: installer and updates'];
const groups = { 'New features': ['Faster drawing of big sheets'], Fixes: ['Installer fixed', 'Updates fixed'] };
const publish = (over = {}) => writeFileSync(join(SHARE, 'latest.json'), signed({ version: '9.9.9', runtime: process.versions.electron || '', notes, groups, app: { file: 'app-v9.9.9.zip', sha256: sha(pkg), size: pkg.length }, ...over }));
writeFileSync(join(SHARE, 'app-v9.9.9.zip'), pkg);
writeFileSync(join(INST, 'install.json'), JSON.stringify({ scope: 'user', version: VERSION }));
writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: SHARE }));
writeFileSync(join(INST, 'resources', 'app.old', 'package.json'), JSON.stringify({ version: '0.3.9' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const ELECTRON = resolve('node_modules/electron/dist/electron');

async function launch({ env = {}, keepProfile = false, confirm = 0 } = {}) {
  if (!keepProfile) rmSync(PROFILE, { recursive: true, force: true });
  const app = await electron.launch({
    executablePath: ELECTRON, args: [resolve('.'), '--no-sandbox', '--profile=update'],
    env: { ...process.env, PDFED_INSTALL_DIR: INST, PDFED_UPDATE_HELPER: HELPER, PDFED_UPDATE_FIRST: '1200', PDFED_UPDATE_TIMEOUT: '3000', PDFED_UPDATE_STALL: '3000', ...env },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc).catch(() => false)); i++) await sleep(200);
  await app.evaluate(({ dialog }, r) => { dialog.showMessageBox = async () => ({ response: r }); }, confirm);
  return { app, win };
}
const state = (win) => win.evaluate(() => window.gcc.updateGet());
async function waitState(win, want, ms = 8000) {
  const t = Date.now();
  let s;
  while (Date.now() - t < ms) { s = await state(win); if ([].concat(want).includes(s.state)) return s; await sleep(150); }
  return s;
}
const quit = async (app) => { await app.evaluate(({ app: a }) => a.quit()).catch(() => {}); await sleep(1500); };
// (the check that the helper may run at all - "--worker <no job>" - is not a start of the update)
const helperCalls = () => (existsSync(ARGS) ? readFileSync(ARGS, 'utf8').trim().split('\n').filter((l) => l && !l.trim().startsWith('--worker ')) : []);
const probes = () => (existsSync(ARGS) ? readFileSync(ARGS, 'utf8').trim().split('\n').filter((l) => l.trim().startsWith('--worker ')).length : 0);

// 1. a new version is announced on its own, with what's new
publish();
let { app, win } = await launch();
let t0 = Date.now();
await win.locator('.upcard', { hasText: '9.9.9 is available' }).waitFor({ timeout: 10000 });
ok(true, `the card announces 9.9.9 by itself (${Date.now() - t0} ms after start)`);
ok(await win.locator('.upcard .whatsnew').count() === 0, 'what\'s new folded away (optional reading)');
await win.locator('.upcard .up-wn').click();
ok(await win.locator('.upcard .whatsnew li').count() === 3 && await win.locator('.upcard .wn-head', { hasText: 'Fixes' }).count() === 1, 'what\'s new opens, by group');
ok(!readdirSync(join(PROFILE)).includes('updates'), 'nothing downloaded before the person says so');

// 2. Later: the card goes; Settings still has it
await win.locator('.upcard button', { hasText: 'Later' }).click();
await sleep(300);
ok(await win.locator('.upcard').count() === 0, 'Later hides the card');
await win.locator('.tb-btn[title="Settings"]').click();
await win.locator('.modal .up-status', { hasText: '9.9.9 is available' }).waitFor({ timeout: 3000 });
ok(true, 'Settings › Updates shows 9.9.9 is available');
ok(await win.locator('.modal button', { hasText: 'Go back to 0.3.9' }).count() === 1, 'the previous version is offered for going back');

// 3. Update from Settings: copied, checked, ready
await win.locator('.modal button', { hasText: /^Update \(/ }).click();
let s = await waitState(win, ['ready', 'error'], 10000);
ok(s.state === 'ready', 'downloaded and checked: ' + s.state + ' ' + (s.err || ''));
const local = join(PROFILE, 'updates', 'app-v9.9.9.zip');
ok(existsSync(local) && sha(readFileSync(local)) === sha(pkg), 'the local copy is complete and matches the checksum');
await win.keyboard.press('Escape');
await sleep(300);
ok(await win.locator('.upcard', { hasText: '9.9.9 is ready' }).count() === 1, 'the card says it is ready to restart');

// 4. Restart now: the app closes and the helper is started with everything it needs
await win.locator('.upcard button', { hasText: 'Restart now' }).click();
await sleep(2500);
let calls = helperCalls();
ok(probes() >= 1, 'the helper was checked before anything closed');
ok(calls.length === 1 && calls[0].includes('--apply ' + local) && calls[0].includes('--sha256 ' + sha(pkg)) && calls[0].includes('--version 9.9.9') && calls[0].includes('--dir ' + INST) && /--wait \d+/.test(calls[0]) && calls[0].includes('--relaunch'), 'the helper is started after the app closed: ' + (calls[0] || '(not started)'));
await app.close().catch(() => {});
rmSync(ARGS, { force: true });

// 4b. the files that were open come back after the restart
({ app, win } = await launch({ env: { PDFED_UPDATE_FIRST: '600000' } }));
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), join(TMP, 'spec.pdf'));
await win.waitForFunction(() => window.__gcc.active()?.pages.length > 0);
await win.evaluate(() => window.gcc.updateCheck());
await waitState(win, ['available', 'ready'], 8000);
if ((await state(win)).state === 'available') { await win.evaluate(() => window.gcc.updateDownload()); await waitState(win, 'ready', 10000); }
await win.evaluate(() => window.gcc.updateRestart(true));
await sleep(2500);
ok(JSON.parse(readFileSync(join(PROFILE, 'settings.json'), 'utf8')).reopenAfterRestart?.[0] === join(TMP, 'spec.pdf'), 'the open file is remembered for after the restart');
await app.close().catch(() => {});
rmSync(ARGS, { force: true });
({ app, win } = await launch({ keepProfile: true, env: { PDFED_UPDATE_FIRST: '5000' } }));
await win.waitForFunction(() => window.__gcc.active()?.pages.length > 0, null, { timeout: 15000 }).catch(() => {});
ok(await win.evaluate(() => window.__gcc.active()?.name) === 'spec.pdf', 'and it is open again after the restart');
await sleep(500);
ok(!JSON.parse(readFileSync(join(PROFILE, 'settings.json'), 'utf8')).reopenAfterRestart, 'only that once');
// (the fake helper changed nothing: still this version after "Restart now" = stopped partway)
const un = await waitState(win, 'blocked', 10000);
ok(un.state === 'blocked' && un.err === 'unfinished' && await win.locator('.upcard', { hasText: "didn't finish" }).count() === 1, 'back on the old version: the card says the update didn\'t finish and names the setup');
ok(!JSON.parse(readFileSync(join(PROFILE, 'settings.json'), 'utf8')).updateTry, 'said once');
await sleep(4000); // (past the usual first check)
ok((await state(win)).state === 'blocked' && await win.locator('.upcard', { hasText: "didn't finish" }).count() === 1, 'the usual first check leaves the card as it is');
await app.close().catch(() => {});

// 4c. the update program blocked (antivirus): nothing closes, the card names the setup instead
for (const [what, helper] of [['missing / not allowed to start', join(TMP, 'no-such-helper')], ['stopped as it starts', join(TMP, 'killed-helper.sh')]]) {
  writeFileSync(join(TMP, 'killed-helper.sh'), '#!/bin/sh\nexit 1\n'); chmodSync(join(TMP, 'killed-helper.sh'), 0o755);
  ({ app, win } = await launch({ env: { PDFED_UPDATE_FIRST: '600000', PDFED_UPDATE_HELPER: helper } }));
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), join(TMP, 'spec.pdf'));
  await win.waitForFunction(() => window.__gcc.active()?.pages.length > 0);
  await win.evaluate(() => window.gcc.updateCheck());
  await waitState(win, ['available', 'ready'], 8000);
  if ((await state(win)).state === 'available') { await win.evaluate(() => window.gcc.updateDownload()); await waitState(win, 'ready', 10000); }
  const r = await win.evaluate(() => window.gcc.updateRestart(true));
  await sleep(1500);
  ok(r === false && (await win.evaluate(() => !!window.__gcc.active())) && await win.locator('.upcard', { hasText: "can't update itself" }).count() === 1, `helper ${what}: the app stays open and says to use the setup`);
  ok((await state(win)).state === 'blocked' && !(await state(win)).pendingAtExit, 'nothing left waiting for the close');
  if (what.startsWith('stopped')) {
    // later the program is allowed (IT's exception): "Try again" updates as usual
    rmSync(ARGS, { force: true });
    await app.evaluate((_e, h) => { process.env.PDFED_UPDATE_HELPER = h; }, HELPER);
    await win.locator('.upcard button', { hasText: 'Try again' }).click();
    await sleep(2500);
    const c = helperCalls();
    ok(c.length === 1 && c[0].includes('--apply ') && c[0].includes('--relaunch'), 'allowed again: Try again closes and updates: ' + (c[0] || '(not started)'));
  }
  await app.close().catch(() => {});
}
rmSync(ARGS, { force: true });

// 4d. a version with a new runtime (Electron): only its setup can install it - and the app never
// starts a downloaded setup itself (Sophos stopped 0.8.2's for "malicious behaviour": a program just
// copied into AppData, started by another program). The card says to run the setup by hand.
{
  const setupBytes = crypto.randomBytes(400000);
  writeFileSync(join(SHARE, 'PDF Editor Setup 9.9.9.exe'), setupBytes);
  publish({ runtime: '99.0.0', setup: { file: 'PDF Editor Setup 9.9.9.exe', sha256: sha(setupBytes), size: setupBytes.length } });
  rmSync(ARGS, { force: true });
  ({ app, win } = await launch({ env: { PDFED_UPDATE_FIRST: '600000' } }));
  await app.evaluate(({ shell }) => { globalThis.__shown = []; shell.showItemInFolder = (p) => { globalThis.__shown.push(p); }; });
  await win.evaluate(() => window.gcc.updateCheck());
  const s4 = await waitState(win, 'setup', 8000);
  ok(s4.state === 'setup' && s4.available === '9.9.9' && s4.kind === 'full', 'a new runtime: offered as "install with the setup" (' + s4.state + ')');
  ok(await win.locator('.upcard', { hasText: 'installs with its setup' }).count() === 1 && await win.locator('.upcard', { hasText: 'PDF Editor Setup 9.9.9.exe' }).count() === 1, 'the card names the setup to run');
  await win.evaluate(() => window.gcc.updateDownload());
  await sleep(1500);
  const work = join(PROFILE, 'updates');
  const got = existsSync(work) ? readdirSync(work) : [];
  ok((await state(win)).state === 'setup' && !got.some((f) => /\.exe/i.test(f)), 'nothing downloaded: ' + JSON.stringify(got));
  const r4 = await win.evaluate(() => window.gcc.updateRestart(true));
  await sleep(1500);
  ok(r4 === false && !existsSync(ARGS) && (await win.evaluate(() => 1).catch(() => 0)) === 1, 'nothing started - not even the harmless test start - and the app stays open');
  await win.locator('.upcard button', { hasText: 'Show the setup' }).click();
  await sleep(500);
  const shown = await app.evaluate(() => globalThis.__shown);
  ok(shown.length === 1 && shown[0].endsWith('PDF Editor Setup 9.9.9.exe'), 'Show the setup: the setup in the updates folder: ' + JSON.stringify(shown));
  // Settings says the same
  await win.locator('.tb-btn[title="Settings"]').click();
  const upLine = win.locator('.modal .up-status', { hasText: 'Version 9.9.9' });
  await upLine.waitFor({ timeout: 3000 });
  ok(/installs with "PDF Editor Setup 9\.9\.9\.exe"/.test(await upLine.textContent()) && await win.locator('.modal button', { hasText: 'Show the setup' }).count() === 1, 'Settings > Updates: run the setup by hand, Show the setup');
  await win.keyboard.press('Escape');
  // the share out of reach for a moment: the offer stays as it was
  renameSync(SHARE, SHARE + '-away');
  await win.evaluate(() => window.gcc.updateCheck());
  await sleep(2500);
  renameSync(SHARE + '-away', SHARE);
  ok((await state(win)).state === 'setup', 'a check that can\'t reach the share keeps "install with the setup": ' + (await state(win)).state);
  // Later: the card goes
  await win.locator('.upcard button', { hasText: 'Later' }).click().catch(() => {});
  await sleep(300);
  ok(await win.locator('.upcard').count() === 0, 'Later hides the card');
  // as published from 0.8.3 on: no setup named in latest.json - still "run the setup", by its usual name
  publish({ runtime: '99.0.0' });
  const s5 = await win.evaluate(() => window.gcc.updateCheck());
  ok(s5.state === 'setup' && /PDF Editor Setup 9\.9\.9\.exe$/.test(s5.setupPath || ''), 'no setup named in latest.json: the card still points at "PDF Editor Setup 9.9.9.exe": ' + s5.setupPath);
  // a newer version on this runtime replaces the offer: the usual update
  const pkg2 = crypto.randomBytes(200000);
  writeFileSync(join(SHARE, 'app-v9.9.10.zip'), pkg2);
  publish({ version: '9.9.10', app: { file: 'app-v9.9.10.zip', sha256: sha(pkg2), size: pkg2.length } });
  const s6 = await win.evaluate(() => window.gcc.updateCheck());
  ok(s6.state === 'available' && s6.available === '9.9.10' && s6.kind === 'app', 'a newer version on this runtime replaces it: the usual update (' + s6.state + ' ' + s6.available + ')');
  await app.close().catch(() => {});
  rmSync(join(SHARE, 'app-v9.9.10.zip'), { force: true });
  publish();
  rmSync(ARGS, { force: true });
}

// 5. "When I close it" with unsaved work: closing asks to save first, Cancel keeps the app open
({ app, win } = await launch({ confirm: 2 }));
await waitState(win, 'available', 8000);
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), join(TMP, 'spec.pdf'));
await win.waitForFunction(() => window.__gcc.active()?.pages.length > 0);
await win.evaluate(async () => { const d = window.__gcc.active(); await d.create(0, { type: 'Square', rect: [100, 100, 200, 200], color: [1, 0, 0], bw: 1 }); });
await sleep(400);
await win.locator('.upcard button', { hasText: /^Update/ }).click();
await waitState(win, 'ready', 10000);
await win.locator('.upcard button', { hasText: 'Restart now' }).click();
await sleep(1500);
ok(helperCalls().length === 0 && (await win.evaluate(() => !!window.__gcc.active())), 'Restart now + Cancel at "Save changes?": the app stays open, nothing started');
s = await state(win);
ok(!s.pendingAtExit, 'and no restart is left waiting');
await win.locator('.tb-btn[title="Settings"]').click();
await win.locator('.modal button', { hasText: 'Restart now' }).waitFor({ timeout: 3000 });
await win.keyboard.press('Escape');
await win.locator('.upcard button', { hasText: 'When I close it' }).click().catch(async () => { await win.evaluate(() => window.gcc.updateRestart(false)); });
await sleep(300);
s = await state(win);
ok(s.pendingAtExit, '"When I close it": waits for the app to close');
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }); // don't save
await win.evaluate(() => window.close());
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => {});
await sleep(3000);
calls = helperCalls();
ok(calls.length === 1 && calls[0].includes('--apply') && !calls[0].includes('--relaunch'), 'closing the app starts the update without reopening it: ' + (calls[0] || '(not started)'));
await app.close().catch(() => {});
rmSync(ARGS, { force: true });

// 6. a damaged package: refused, nothing kept
writeFileSync(join(SHARE, 'app-v9.9.9.zip'), crypto.randomBytes(300000));
({ app, win } = await launch());
await waitState(win, 'available', 8000);
await win.locator('.upcard button', { hasText: /^Update/ }).click();
s = await waitState(win, ['error', 'ready'], 10000);
ok(s.state === 'error' && /damaged/.test(s.err), 'a damaged download is refused: ' + s.err);
ok(!readdirSync(join(PROFILE, 'updates')).some((n) => n.startsWith('app-v9.9.9')), 'and nothing of it is kept');
ok(await win.locator('.upcard', { hasText: "Couldn't get 9.9.9" }).count() === 1, 'the card says so, with Try again');
await quit(app);
writeFileSync(join(SHARE, 'app-v9.9.9.zip'), pkg);

// 6b. latest.json copied before the package is complete (smaller than it says): not offered yet
{
  const raw = readFileSync(join(SHARE, 'latest.json'), 'utf8');
  const P = JSON.parse(JSON.parse(raw).signed);
  writeFileSync(join(SHARE, 'latest.json'), signed({ ...P, app: { ...P.app, size: P.app.size + 4096 } }));
  ({ app, win } = await launch());
  await sleep(4500);
  s = await state(win);
  ok(s.state !== 'available' && s.state !== 'downloading', 'a package still being copied is not offered (' + s.state + ')');
  await quit(app);
  // 6c. the updates folder written to by someone else: a latest.json not signed by the publisher,
  // or one whose checksums were changed after it was signed, is refused - nothing offered
  const evil = crypto.randomBytes(300000);
  writeFileSync(join(SHARE, 'evil-v9.9.9.zip'), evil);
  const forged = { ...P, app: { file: 'evil-v9.9.9.zip', sha256: sha(evil), size: evil.length } };
  for (const [what, text] of [
    ['not signed', JSON.stringify(forged)],
    ['changed after signing', JSON.stringify({ ...JSON.parse(raw), ...forged, signed: JSON.parse(raw).signed.replace(P.app.sha256, sha(evil)).replace('app-v9.9.9.zip', 'evil-v9.9.9.zip') })],
    ['signed with another key', JSON.stringify(signLatest(forged, crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })))],
  ]) {
    writeFileSync(join(SHARE, 'latest.json'), text);
    ({ app, win } = await launch());
    s = await waitState(win, ['error', 'available', 'none'], 8000);
    ok(s.state === 'error' && /signature|not signed/.test(s.err), `latest.json ${what}: refused - ${s.err}`);
    await quit(app);
  }
  rmSync(join(SHARE, 'evil-v9.9.9.zip'), { force: true });
  writeFileSync(join(SHARE, 'latest.json'), raw);
}

// 7. a share that stops in the middle of the copy (the package is a pipe nobody writes to)
rmSync(join(HANG, 'app-v9.9.9.zip'), { force: true });
execFileSync('mkfifo', [join(HANG, 'app-v9.9.9.zip')]);
writeFileSync(join(HANG, 'latest.json'), readFileSync(join(SHARE, 'latest.json')));
writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: HANG }));
({ app, win } = await launch());
await waitState(win, 'available', 8000);
await win.locator('.upcard button', { hasText: /^Update/ }).click();
t0 = Date.now();
s = await waitState(win, ['error', 'ready'], 15000);
ok(s.state === 'error' && /stopped responding/.test(s.err), `a stalled copy gives up by itself (${Date.now() - t0} ms): ${s.err}`);
ok(!readdirSync(join(PROFILE, 'updates')).some((n) => n.endsWith('.part')), 'the partial file is removed');
// Cancel while copying: back to "available", no error, card closed
await win.evaluate(() => { void window.gcc.updateDownload(); });
await sleep(600);
await win.locator('.upcard button', { hasText: 'Cancel' }).click();
s = await waitState(win, ['available', 'error'], 5000);
ok(s.state === 'available' && !s.show && !s.err, 'Cancel stops the copy quietly (' + s.state + ')');
await quit(app);

// 8. a share that hangs on reading latest.json: the app keeps working, the check gives up quietly
rmSync(join(HANG, 'latest.json'), { force: true });
execFileSync('mkfifo', [join(HANG, 'latest.json')]);
({ app, win } = await launch());
await sleep(1400);
t0 = Date.now();
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), join(TMP, 'spec.pdf'));
await win.waitForFunction(() => window.__gcc.active()?.pages.length > 0);
const openMs = Date.now() - t0;
s = await state(win);
ok(s.state === 'checking', 'while the check hangs: ' + s.state);
ok(openMs < 8000, `a PDF opens normally meanwhile (${openMs} ms)`);
s = await waitState(win, ['unreachable', 'error', 'none'], 8000);
ok(s.state === 'unreachable', 'after the time limit: "not reachable" (' + s.state + ')');
ok(await win.locator('.upcard').count() === 0, 'no card, no popup');
await quit(app);

// 9. no network at all (the folder doesn't exist), and nothing published yet
writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: join(TMP, 'no-such-server', 'share') }));
({ app, win } = await launch());
t0 = Date.now();
s = await waitState(win, ['unreachable', 'error'], 6000);
ok(s.state === 'unreachable' && await win.locator('.upcard').count() === 0, `a missing server: quietly "not reachable" (${Date.now() - t0} ms)`);
await win.locator('.tb-btn[title="Settings"]').click();
ok(await win.locator('.modal .up-status', { hasText: "can't be reached" }).count() === 1, 'Settings explains it');
const empty = join(TMP, 'empty-share');
mkdirSync(empty, { recursive: true });
await win.locator('.modal .row', { hasText: 'Updates' }).locator('input').fill(empty);
await win.locator('.modal button', { hasText: 'Check now' }).click();
s = await waitState(win, ['empty'], 5000);
ok(s.state === 'empty' && s.ownSource, 'a folder of my own choice, nothing published: "' + s.state + '"');
await win.locator('.modal .link', { hasText: "Use the installer's folder" }).click();
await sleep(300);
s = await state(win);
ok(!s.ownSource && s.source === join(TMP, 'no-such-server', 'share'), 'back to the installer\'s folder');
await win.keyboard.press('Escape');
await quit(app);

// 10. up to date
writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: SHARE }));
publish({ version: VERSION });
({ app, win } = await launch());
s = await waitState(win, ['none'], 6000);
ok(s.state === 'none' && await win.locator('.upcard').count() === 0, 'the same version published: nothing to offer');
await quit(app);

// 11. after an update: "Updated to …" with the notes, once
writeFileSync(join(PROFILE, 'settings.json'), JSON.stringify({ lastRunVersion: '0.0.1', updateNotes: { version: VERSION, notes: ['Something new'] } }));
({ app, win } = await launch({ keepProfile: true, env: { PDFED_UPDATE_FIRST: '600000' } }));
await win.locator('.upcard', { hasText: 'Updated to ' + VERSION }).waitFor({ timeout: 6000 }).catch(() => {});
await win.locator('.upcard .up-wn').click().catch(() => {});
ok(await win.locator('.upcard .whatsnew li').count() > 0, '"Updated to ' + VERSION + '" offers what\'s new');
await win.locator('.upcard button', { hasText: 'OK' }).click();
await quit(app);
({ app, win } = await launch({ keepProfile: true, env: { PDFED_UPDATE_FIRST: '600000' } }));
await sleep(2500);
ok(await win.locator('.upcard').count() === 0, 'only once');

// 12. going back: confirm, the app closes, the helper goes back
await win.locator('.tb-btn[title="Settings"]').click();
await win.locator('.modal button', { hasText: 'Go back to 0.3.9' }).click();
await sleep(2500);
calls = helperCalls();
ok(calls.length === 1 && calls[0].startsWith('--rollback --dir ' + INST) && calls[0].includes('--relaunch'), 'Go back starts the helper: ' + (calls[0] || '(not started)'));
await app.close().catch(() => {});
rmSync(ARGS, { force: true });

// 13. a copy that wasn't installed: never checks
rmSync(join(INST, 'install.json'));
({ app, win } = await launch());
await sleep(2500);
s = await state(win);
ok(s.state === 'portable' && !s.checked, 'a portable copy doesn\'t look for updates');
await win.locator('.tb-btn[title="Settings"]').click();
ok(await win.locator('.modal', { hasText: "wasn't installed with PDF Editor Setup" }).count() === 1, 'and Settings says why');
await win.keyboard.press('Escape');
await quit(app);

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
