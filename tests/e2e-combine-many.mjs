// Explorer > "Combine with PDF Editor" with MANY big files: Windows runs the command once per file
// (a command-line verb, MultiSelectModel=Player: up to 100 files), all at once.
//   N=60 [FRESH=1] [MODE=collector] xvfb-run -a node tests/e2e-combine-many.mjs
// MODE=exe (default): the 0.8.5 / setup entry - the app itself per file (--combine <file>)
// MODE=collector: PDF Editor Combine.exe per file (built here for Linux); it starts the app once
//   (--combine-spool). FRESH: its start is recorded by a stand-in and the test starts the app
//   itself the same way (Playwright has to own that process); exactly one start is expected.
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
const N = Number(process.env.N || 60);
const FRESH = process.env.FRESH === '1';
const MODE = process.env.MODE || 'exe';
const TMP = resolve('tests/tmp-combine-many');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const names = Array.from({ length: N }, (_, i) => `P04-24-ARC-DWG-${String(1001 + i)} Rev C.pdf`);
for (const n of names) copyFileSync('tests/data/heavy-a0.pdf', join(TMP, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ELECTRON = resolve('node_modules/electron/dist/electron');
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-combmany'), { recursive: true, force: true });
const COMB = join(TMP, 'combine-linux');
const STAND = join(TMP, 'app-stand-in.sh');
const LAUNCHES = join(TMP, 'launches.txt');
if (MODE === 'collector') {
  execFileSync('go', ['build', '-o', COMB, './combine'], { cwd: 'installer', env: { ...process.env, GOPROXY: 'off', GOFLAGS: '-mod=mod', GOTOOLCHAIN: 'local', GOSUMDB: 'off' } });
  // what the collector starts: the app (running: a second start, which hands over and ends), or
  // - FRESH - a stand-in that notes the start and stays up as the app would
  writeFileSync(STAND, FRESH ? `#!/bin/sh\necho "$@" >> '${LAUNCHES}'\nexec sleep 90\n` : `#!/bin/sh\necho "$@" >> '${LAUNCHES}'\nexec '${ELECTRON}' '${resolve('.')}' --no-sandbox "$@"\n`);
  chmodSync(STAND, 0o755);
}
const t0 = Date.now();
const first = MODE === 'collector' ? ['--combine-spool'] : ['--combine', join(TMP, names[0])];
if (FRESH && MODE === 'collector') {
  // all the collectors first (as Explorer does), then the app as the first of them started it
  await Promise.all(names.map((f) => new Promise((res) => { const c = spawn(COMB, ['--app=' + STAND, '--profile=combmany', join(TMP, f)], { stdio: 'ignore' }); c.on('exit', res); })));
}
const app = await electron.launch({ executablePath: ELECTRON, args: [resolve('.'), '--no-sandbox', '--profile=combmany', ...(FRESH ? first : [])], timeout: 180000 });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
if (!FRESH) for (let i = 0; i < 200 && !(await win.evaluate(() => !!window.__gcc).catch(() => false)); i++) await sleep(200);
const t1 = Date.now();
let exited = 0, codes = {};
const rest = FRESH ? (MODE === 'collector' ? [] : names.slice(1)) : names;
const procs = rest.map((f) => { const c = MODE === 'collector' ? spawn(COMB, ['--app=' + STAND, '--profile=combmany', join(TMP, f)], { stdio: 'ignore' }) : spawn(ELECTRON, [resolve('.'), '--no-sandbox', '--profile=combmany', '--combine', join(TMP, f)], { stdio: 'ignore' }); c.on('exit', (code) => { exited++; codes[code] = (codes[code] || 0) + 1; }); return c; });
let shown = -1, last = '';
for (let i = 0; i < 600; i++) {
  const st = await win.evaluate(() => ({ modal: [...document.querySelectorAll('.modal .mhead, .modal h2, .modal .title')].map((e) => e.textContent).join('|'), n: document.querySelectorAll('.modal .frow .fn').length })).catch((e) => ({ modal: 'ERR ' + e.message.slice(0, 60), n: -1 }));
  const line = `${st.modal} files=${st.n} exited=${exited}`;
  if (line !== last) { console.log(((Date.now() - t1) / 1000).toFixed(1) + 's', line); last = line; }
  if (st.n > 0 && shown < 0) shown = Date.now() - t1;
  if (st.n === N && exited >= procs.length) break;
  await sleep(500);
}
const starts = existsSync(LAUNCHES) ? readFileSync(LAUNCHES, 'utf8').trim().split('\n').length : 0;
const listedN = await win.evaluate(() => document.querySelectorAll('.modal .frow .fn').length).catch(() => -1);
const tabs = await win.evaluate(() => window.__gcc.docs().length).catch(() => -1);
console.log(`${listedN === N && tabs === 0 && (MODE !== 'collector' || !FRESH || starts === 1) ? 'PASS' : 'FAIL'} mode=${MODE}: all ${N} in one Merge dialog, no tabs (${tabs})${MODE === 'collector' ? `, app starts by the collectors: ${starts}` : ''}`);
console.log(`N=${N} fresh=${FRESH}: dialog after ${shown < 0 ? 'NEVER' : (shown / 1000).toFixed(1) + ' s'}; listed ${await win.evaluate(() => document.querySelectorAll('.modal .frow .fn').length).catch(() => -1)}; secondaries exited ${exited}/${procs.length} ${JSON.stringify(codes)}; app start ${((t1 - t0) / 1000).toFixed(1)} s`);
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
for (const p of procs) try { p.kill(); } catch {}
