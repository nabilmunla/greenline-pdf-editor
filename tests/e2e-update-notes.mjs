// Update notes for every skipped version (0.9.7): the prompt lists the notes of every version
// after the installed one (latest.json "history"), and "Updated to" lists every version since the
// one the copy was (0.9.4 straight to 0.9.6 showed only 0.9.6's: 0.9.5's fixes never appeared).
// xvfb-run -a node tests/e2e-update-notes.mjs
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

const TMP = resolve('tests/tmp-update-notes');
rmSync(TMP, { recursive: true, force: true });
const INST = join(TMP, 'install'), SHARE = join(TMP, 'share'), HANG = join(TMP, 'hang');
for (const d of [INST, SHARE, HANG, join(INST, 'resources', 'app.old')]) mkdirSync(d, { recursive: true });
copyFileSync('tests/data/long-spec.pdf', join(TMP, 'spec.pdf'));
const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-update-notes');
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
    executablePath: ELECTRON, args: [resolve('.'), '--no-sandbox', '--profile=update-notes'],
    env: { ...process.env, PDFED_INSTALL_DIR: INST, PDFED_UPDATE_HELPER: HELPER, PDFED_UPDATE_FIRST: '1200', PDFED_UPDATE_TIMEOUT: '3000', PDFED_UPDATE_STALL: '3000', ...env },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc).catch(() => false)); i++) await sleep(200);
  await app.evaluate(({ dialog }, r) => { dialog.showMessageBox = async () => ({ response: r }); }, confirm);
  return { app, win };
}
const texts = async (win) => { await win.locator('.upcard .up-wn').click().catch(() => {}); await sleep(300); return win.locator('.upcard .whatsnew li').allTextContents(); };

// 1. the prompt: every version after this copy's, up to the one announced (latest.json "history")
publish({
  history: {
    '9.9.9': { 'New features': ['Newest feature'], 'Coming next': ['Next big thing'] },
    '9.9.8': { 'General polishing': ['Skipped version fix'], 'Coming next': ['Old plan'] },
    [VERSION]: { 'New features': ['This copy already has it'] },
    '0.0.1': { 'New features': ['Ancient'] },
  },
});
let { app, win } = await launch();
await win.locator('.upcard', { hasText: '9.9.9 is available' }).waitFor({ timeout: 10000 });
let t = await texts(win);
ok(t.includes('Newest feature') && t.includes('Skipped version fix'), 'the card lists the skipped version\'s notes too: ' + JSON.stringify(t));
ok(!t.includes('This copy already has it') && !t.includes('Ancient'), 'not this copy\'s own, nor older ones');
ok(t.includes('Next big thing') && !t.includes('Old plan'), '"Coming next" from the newest only');
await app.close().catch(() => {});

// 2. without "history" (published by 0.9.6 or before): its own notes, as before
publish();
({ app, win } = await launch());
await win.locator('.upcard', { hasText: '9.9.9 is available' }).waitFor({ timeout: 10000 });
t = await texts(win);
ok(t.length === 3 && t.includes('Installer fixed'), 'no history: the announced version\'s notes ' + JSON.stringify(t));
await app.close().catch(() => {});

// 3. after an update from an old copy: "Updated to" lists every version since the one it was
// (this app's own release notes: 0.9.4 -> now has 0.9.5's fixes)
mkdirSync(PROFILE, { recursive: true });
writeFileSync(join(PROFILE, 'settings.json'), JSON.stringify({ lastRunVersion: '0.9.4', updateNotes: { version: VERSION, notes: ['Something new'] } }));
({ app, win } = await launch({ keepProfile: true, env: { PDFED_UPDATE_FIRST: '600000' } }));
await win.locator('.upcard', { hasText: 'Updated to ' + VERSION }).waitFor({ timeout: 8000 }).catch(() => {});
t = await texts(win);
const rn = JSON.parse(readFileSync('release-notes.json', 'utf8'));
const first = (v) => Object.entries(rn[v]).find(([k]) => !k.startsWith('Public: ') && !/^coming next/i.test(k))[1][0];
ok(['0.9.5', '0.9.6', VERSION].every((v) => t.includes(first(v))), 'Updated from 0.9.4: 0.9.5, 0.9.6 and ' + VERSION + ' all listed (' + t.length + ' lines)');
ok(!t.includes(first('0.9.4')), 'not 0.9.4\'s own');
await app.close().catch(() => {});

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
