// 7.15 Settings > Updates: the "Restore default" button for the update location, in the real app.
//  - company build, the setup named a share folder: cleared field -> button -> click -> the folder is
//    back in the field and in settings (the setting dropped), a check runs; no button when already default
//  - company build, a folder of my own: the button goes back to the setup's folder
//  - R: no setup update.json at all (a hand-copied install): the company build has nothing to restore -
//    no button, a one-line hint; with the build's own address it restores that
//  - Greenline (brand "greenline" in package.json, a copy of electron/ like e2e-count): restores the
//    GitHub link (a local web server here), also from a share folder an old setup left - and then no
//    share path is left in settings or in update.json
// xvfb-run -a node tests/e2e-update-restore.mjs
import { _electron as electron } from 'playwright';
import http from 'node:http';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync, symlinkSync, readdirSync } from 'node:fs';

const TMP = resolve('tests/tmp-update-restore');
rmSync(TMP, { recursive: true, force: true });
const INST = join(TMP, 'install'), SHARE = join(TMP, 'share'), OTHER = join(TMP, 'other'), GL = join(TMP, 'greenline');
for (const d of [INST, SHARE, OTHER, GL]) mkdirSync(d, { recursive: true });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync(join(GL, 'package.json'), JSON.stringify({ ...pkg, brand: 'greenline', displayName: 'Greenline PDF Editor' }, null, 2));
cpSync('electron', join(GL, 'electron'), { recursive: true });
for (const n of readdirSync('.')) if (!['package.json', 'electron', 'tests', '.git'].includes(n) && !existsSync(join(GL, n))) symlinkSync(resolve(n), join(GL, n));
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-updrestore');
const settings = () => { try { return JSON.parse(readFileSync(join(PROFILE, 'settings.json'), 'utf8')); } catch (_) { return {}; } };
const updateJson = () => { try { return JSON.parse(readFileSync(join(INST, 'update.json'), 'utf8')); } catch (_) { return null; } };

// the web feed: nothing published (a check ends "nothing published"); every request is written down
const hits = [];
const server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(404); res.end('not found'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FEED = `http://127.0.0.1:${server.address().port}/feed`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const ELECTRON = resolve('node_modules/electron/dist/electron');
async function launch({ greenline = false, env = {} } = {}) {
  rmSync(PROFILE, { recursive: true, force: true });
  const app = await electron.launch({
    executablePath: ELECTRON, args: [greenline ? GL : resolve('.'), '--no-sandbox', '--profile=updrestore'],
    env: { ...process.env, PDFED_INSTALL_DIR: INST, PDFED_UPDATE_FIRST: '600000', PDFED_UPDATE_TIMEOUT: '3000', PDFED_REPORT_FIRST: '600000', PDFED_UPDATE_FEED: '', ...env },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc).catch(() => false)); i++) await sleep(200);
  await win.locator('.tb-btn[title="Settings"]').click();
  await win.locator('.modal .row', { hasText: 'Updates' }).locator('input').waitFor();
  return { app, win };
}
const state = (win) => win.evaluate(() => window.gcc.updateGet());
const field = (win) => win.locator('.modal .row', { hasText: 'Updates' }).locator('input');
const restoreBtn = (win) => win.locator('.modal button', { hasText: 'Restore default' });
const hint = (win) => win.locator('.modal .hint', { hasText: 'Ask whoever installed the app for the updates folder' });
async function typeValue(win, v) { await field(win).fill(v); await field(win).press('Tab'); await sleep(400); }
async function waitChecked(win, ms = 6000) {
  const t = Date.now(); let s;
  while (Date.now() - t < ms) { s = await state(win); if (s.checked && ['empty', 'none', 'unreachable', 'available'].includes(s.state)) return s; await sleep(150); }
  return s;
}
const setup = (src) => { if (src === null) rmSync(join(INST, 'update.json'), { force: true }); else writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: src })); };
writeFileSync(join(INST, 'install.json'), JSON.stringify({ scope: 'user', version: pkg.version }));

try {
  // 1. company build, the setup named a share folder
  setup(SHARE);
  let { app, win } = await launch();
  ok(await field(win).inputValue() === SHARE && await restoreBtn(win).count() === 0, 'company: the default is in the field - no "Restore default"');
  ok(await win.locator('.modal .link', { hasText: "Use the installer's folder" }).count() === 0, 'the two old text links are gone');
  let s = await state(win);
  ok(s.defaultFor === SHARE, 'status: defaultFor is the setup\'s folder (' + s.defaultFor + ')');
  await typeValue(win, '');
  ok(await restoreBtn(win).count() === 1 && settings().updateSource === '', 'field emptied by accident: the button shows (settings hold an empty source)');
  s = await state(win);
  ok(s.source === '' && !s.checked, 'nothing is checked while it is empty');
  await restoreBtn(win).click();
  s = await waitChecked(win);
  ok(await field(win).inputValue() === SHARE && s.source === SHARE, 'click: the folder is back in the field and in the app (' + s.source + ')');
  ok(!('updateSource' in settings()), 'and in settings: the own setting is dropped, the setup\'s folder applies');
  ok(s.checked > 0 && s.state === 'empty', 'a check ran at once (' + s.state + ')');
  ok(await restoreBtn(win).count() === 0, 'the button is gone again');
  // a folder of my own: the button goes back
  await typeValue(win, OTHER);
  ok(await restoreBtn(win).count() === 1 && settings().updateSource === OTHER, 'a folder of my own: the button shows');
  await restoreBtn(win).click();
  s = await waitChecked(win);
  ok(s.source === SHARE && await field(win).inputValue() === SHARE && !('updateSource' in settings()), 'it goes back to the setup\'s folder');
  // typed but not yet left (no blur): the button already shows, and a click restores
  await field(win).fill('');
  ok(await restoreBtn(win).count() === 1, 'while typing the button already shows');
  await restoreBtn(win).click();
  s = await waitChecked(win);
  ok(s.source === SHARE && await field(win).inputValue() === SHARE, 'a click right after typing restores it too');
  await app.close().catch(() => {});

  // 2. R: no setup update.json at all (a hand-copied install), company build with nothing of its own
  setup(null);
  ({ app, win } = await launch());
  s = await state(win);
  ok(s.defaultFor === '' && s.source === '' && s.installed, 'R company: no update.json - nothing to restore (' + JSON.stringify(s.defaultFor) + ')');
  ok(await restoreBtn(win).count() === 0 && await hint(win).count() === 1, 'R company: no button, a one-line hint says where to set it');
  await typeValue(win, OTHER);
  ok(await restoreBtn(win).count() === 0 && await hint(win).count() === 0, 'R company: a folder chosen by hand - no button, no hint');
  await typeValue(win, '');
  ok(await restoreBtn(win).count() === 0 && await hint(win).count() === 1, 'R company: emptied again - still no button (nothing to restore), the hint is back');
  await app.close().catch(() => {});
  // the same, with the build's own address (a company build given one)
  ({ app, win } = await launch({ env: { PDFED_UPDATE_FEED: FEED } }));
  s = await state(win);
  ok(s.defaultFor === FEED && s.source === FEED && await restoreBtn(win).count() === 0, 'R company with an own address: it is the default, no button');
  await typeValue(win, '');
  ok(await restoreBtn(win).count() === 1 && await hint(win).count() === 0, 'emptied: the button shows');
  hits.length = 0;
  await restoreBtn(win).click();
  s = await waitChecked(win);
  ok(s.source === FEED && await field(win).inputValue() === FEED && !('updateSource' in settings()) && hits.includes('/feed/latest.json'), 'restored to the address, and the web feed was asked');
  await app.close().catch(() => {});
  // the setup said "no updates" (update.json with an empty source): that is its default - no button
  setup('');
  ({ app, win } = await launch());
  s = await state(win);
  ok(s.defaultFor === '' && s.defaultSet === true && await restoreBtn(win).count() === 0, '"no updates" chosen in the setup is the default - no button');
  // (sweep S11) a folder typed over it: the button shows and puts "no updates" back
  await typeValue(win, OTHER);
  ok(await restoreBtn(win).count() === 1 && await hint(win).count() === 0, '"no updates" setup, a folder typed: the button shows');
  await restoreBtn(win).click();
  await win.waitForTimeout(800);
  s = await state(win);
  ok(s.source === '' && await field(win).inputValue() === '' && !('updateSource' in settings()) && await restoreBtn(win).count() === 0, 'restored to "no updates" (nothing kept in the settings)');
  await app.close().catch(() => {});

  // 3. Greenline, no update.json (hand-copied): the GitHub link is still restored
  setup(null);
  ({ app, win } = await launch({ greenline: true, env: { PDFED_UPDATE_FEED: FEED } }));
  s = await state(win);
  ok(s.defaultFor === FEED && s.source === FEED && s.web, 'Greenline: the link is the default and the location');
  ok(await restoreBtn(win).count() === 0 && await hint(win).count() === 0, 'Greenline: already the default - no button, no hint');
  await typeValue(win, '');
  ok(await restoreBtn(win).count() === 1 && settings().updateSource === '', 'Greenline: emptied field - the button shows');
  hits.length = 0;
  await restoreBtn(win).click();
  s = await waitChecked(win);
  ok(await field(win).inputValue() === FEED && s.source === FEED && !('updateSource' in settings()) && s.checked > 0, 'Greenline: the link is back in the field and in settings; checked (' + s.state + ')');
  ok(hits.includes('/feed/latest.json'), 'Greenline: the check asked the link');
  await typeValue(win, SHARE);
  ok(await restoreBtn(win).count() === 1, 'Greenline: a folder typed in - the button shows');
  await restoreBtn(win).click();
  s = await waitChecked(win);
  ok(s.source === FEED && await field(win).inputValue() === FEED && !JSON.stringify(settings()).includes(SHARE), 'Greenline: back on the link, the folder is not kept in settings');
  await app.close().catch(() => {});

  // 4. Greenline, an old setup left a share folder in update.json: Restore default leaves no share path
  setup(SHARE);
  ({ app, win } = await launch({ greenline: true, env: { PDFED_UPDATE_FEED: FEED } }));
  s = await state(win);
  ok(s.source === SHARE && s.defaultFor === FEED && await restoreBtn(win).count() === 1, 'Greenline with a share from the setup: the field shows it, the button is there');
  await restoreBtn(win).click();
  s = await waitChecked(win);
  ok(s.source === FEED && s.web && await field(win).inputValue() === FEED, 'click: the link is the location');
  ok(!JSON.stringify(settings()).includes(SHARE) && !JSON.stringify(updateJson()).includes(SHARE) && updateJson().source === FEED, 'no share path left behind: not in settings, not in the setup\'s update.json');
  ok(await restoreBtn(win).count() === 0, 'the button is gone');
  await app.close().catch(() => {});
  // and from update.json alone (a fresh profile)
  ({ app, win } = await launch({ greenline: true, env: { PDFED_UPDATE_FEED: FEED } }));
  ok((await state(win)).source === FEED, 'a fresh profile: the link is still the location (update.json)');
  await app.close().catch(() => {});
} catch (e) { console.log('FAIL exception ' + (e && e.stack || e)); fails++; }
server.close();
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
