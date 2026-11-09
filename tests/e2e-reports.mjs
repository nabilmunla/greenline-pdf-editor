// Crash and problem reports: written to <updates folder>\reports, once per kind of crash a day,
// queued on the PC while the folder can't be reached and sent later.
// xvfb-run -a node tests/e2e-reports.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';

const TMP = resolve('tests/tmp-reports');
rmSync(TMP, { recursive: true, force: true });
const INST = join(TMP, 'install'), SHARE = join(TMP, 'share');
for (const d of [INST, SHARE]) mkdirSync(d, { recursive: true });
copyFileSync('tests/data/long-spec.pdf', join(TMP, 'spec.pdf'));
writeFileSync(join(INST, 'install.json'), JSON.stringify({ scope: 'user', version: '0.4.0' }));
writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: SHARE }));
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-reports');
rmSync(PROFILE, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const RDIR = join(SHARE, 'reports');
const reports = () => (existsSync(RDIR) ? readdirSync(RDIR).filter((n) => n.endsWith('.json')).map((n) => ({ n, ...JSON.parse(readFileSync(join(RDIR, n), 'utf8')) })) : []);
const queue = () => (existsSync(join(PROFILE, 'reports-outbox')) ? readdirSync(join(PROFILE, 'reports-outbox')).filter((n) => n.endsWith('.json')) : []);
async function waitFor(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; }

async function launch(env = {}) {
  const app = await electron.launch({
    executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=reports'],
    env: { ...process.env, PDFED_INSTALL_DIR: INST, PDFED_UPDATE_FIRST: '600000', PDFED_REPORT_FIRST: '1000', ...env },
  });
  const win = await app.firstWindow();
  for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc).catch(() => false)); i++) await sleep(200);
  return { app, win };
}

// 1. an error in the window is reported by itself
let { app, win } = await launch();
await win.evaluate(() => { setTimeout(() => { throw new Error('test crash in the window'); }, 0); });
let r = await waitFor(() => reports().find((x) => x.message === 'test crash in the window'));
ok(!!r, 'a window error lands in the reports folder by itself');
ok(r && r.kind === 'crash' && r.where === 'window' && r.version && r.user && r.windows && /test crash/.test(r.log || '') && r.stack.includes('Error'), 'with version, user, Windows, stack and the log tail');
// 2. the same error again: not reported twice
await win.evaluate(() => { setTimeout(() => { throw new Error('test crash in the window'); }, 0); });
await sleep(4500);
ok(reports().filter((x) => x.message === 'test crash in the window').length === 1, 'the same error again the same day: one report only');
// 3. a crash in the app's main process
await app.evaluate(() => { setTimeout(() => { throw new Error('test crash in main'); }, 0); });
r = await waitFor(() => reports().find((x) => x.message === 'test crash in main'));
ok(!!r && r.where === 'main', 'a crash in the main process is reported (and the app keeps going)');
// 4. a drawing engine that crashes (not one stopped on purpose)
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), join(TMP, 'spec.pdf'));
await win.waitForFunction(() => window.__gcc.active()?.pages.length > 0);
const pids = await app.evaluate(({ app: a }) => a.getAppMetrics().filter((m) => m.type === 'Utility' && /render/i.test(m.name || m.serviceName || '')).map((m) => m.pid));
if (pids.length) {
  process.kill(pids[0], 'SIGSEGV');
  r = await waitFor(() => reports().find((x) => /^process Utility/.test(x.where)));
  ok(!!r, 'a crashed engine is reported: ' + (r ? r.where + ' / ' + r.message : 'none'));
  await sleep(2500);
  ok(await win.evaluate(() => window.__gcc.active()?.pages.length > 0), 'and the app carries on (engine restarted)');
} else ok(false, 'no engine process found');

// 5. Report a problem: words + the window picture
await win.locator('.rtab', { hasText: /^File$/ }).click();
await win.locator('.ribbon .rb', { hasText: 'Report a problem' }).click();
await win.locator('.modal textarea').waitFor();
ok(await win.locator('.modal .report-shot img').count() === 1, 'the dialog shows the picture of the window that goes with it');
await win.locator('.modal textarea').fill('The highlight jumped to the next line when I dragged its end.');
await win.locator('.modal button', { hasText: 'Send report' }).click();
await win.locator('.toast', { hasText: 'in the reports folder' }).waitFor({ timeout: 8000 }).catch(() => {});
r = reports().find((x) => x.kind === 'problem');
ok(!!r && /highlight jumped/.test(r.text) && r.openFiles === 1, 'the report is in the folder with the words');
ok(r && r.screenshot && existsSync(join(RDIR, r.screenshot)) && readFileSync(join(RDIR, r.screenshot)).subarray(1, 4).toString() === 'PNG', 'and the picture next to it (' + (r && r.screenshot) + ')');
ok(!readdirSync(RDIR).some((n) => n.endsWith('.tmp')), 'no half-written files left');
await app.close().catch(() => {});

// 6. away from the server: kept on the PC, sent later
writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: join(TMP, 'no-such-server') }));
({ app, win } = await launch());
await win.evaluate(() => window.gcc.reportCapture());
const st = await win.evaluate(() => window.gcc.reportProblem('Offline problem report', true, {}));
ok(st.state === 'failed' && st.waiting === 1, 'server away: the report waits on the PC (' + st.state + ', ' + st.waiting + ' waiting)');
await win.locator('.tb-btn[title="Settings"]').click();
ok(await win.locator('.modal .row', { hasText: 'Help' }).locator('.up-status', { hasText: '1 report waiting' }).count() === 1, 'Settings › Help says one report is waiting');
await win.keyboard.press('Escape');
await app.close().catch(() => {});
writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: SHARE }));
({ app, win } = await launch());
r = await waitFor(() => reports().find((x) => x.text === 'Offline problem report'));
ok(!!r && queue().length === 0, 'back on the network: sent at the next start, queue empty');
ok(r && r.screenshot && existsSync(join(RDIR, r.screenshot)), 'with its picture');
await app.close().catch(() => {});

// 7. a share that doesn't answer in time: nothing lost
({ app, win } = await launch({ PDFED_REPORT_TIMEOUT: '1' }));
const st2 = await win.evaluate(() => window.gcc.reportProblem('Slow share report', false, {}));
ok(st2.waiting === 1, 'the copy timed out: the report stays queued (' + st2.err + ')');
await app.close().catch(() => {});

// 8. a portable copy without a folder: reports stay on the PC
rmSync(join(INST, 'update.json'));
({ app, win } = await launch());
const st3 = await win.evaluate(() => window.gcc.reportProblem('No folder report', false, {}));
// (the public build has an address of its own - its GitHub page: "web" there, kept on this PC too)
const ownFeed = !!JSON.parse(readFileSync('package.json', 'utf8')).updateFeed;
ok(st3.state === (ownFeed ? 'web' : 'nofolder') && st3.waiting >= 1, 'no updates folder: kept on this PC (' + st3.state + ')');
await app.close().catch(() => {});

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
