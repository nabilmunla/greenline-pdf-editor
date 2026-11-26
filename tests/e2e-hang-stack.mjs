// 14.7: a window that stops answering leaves "window not responding" in the log, then the call
// stack of what it was running - here a busy loop with a name of its own.
// xvfb-run -a node tests/e2e-hang-stack.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { readFileSync, rmSync, existsSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; return c; };
const prof = join(process.env.HOME, '.config', 'PDF Editor', 'profile-hangstack');
rmSync(prof, { recursive: true, force: true });
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=hangstack'] });
const win = await app.firstWindow();
await win.waitForFunction(() => !!window.__gcc, null, { timeout: 60000 });
await sleep(1500);
const logf = await app.evaluate(async ({ app: a }) => a.getPath('userData'));
// the log is in <data>/logs/app.log; the data folder may differ from userData - look in both
const cands = [join(prof, 'logs', 'app.log'), join(logf, 'logs', 'app.log')];
await win.evaluate(() => { setTimeout(function greenlineHangTestBusyLoop() { const t = Date.now(); while (Date.now() - t < 40000) { /* busy */ } }, 50); });
// (Chromium calls a window unresponsive when an input event waits too long: send it some clicks)
await sleep(1000);
// (Chromium's own "unresponsive" needs real input from the desktop, which this headless run can't
// give - the event is raised from the main process instead, while the loop really runs)
await sleep(1500);
await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('unresponsive'); });
let text = '';
for (let i = 0; i < 70; i++) {
  await sleep(1000);
  text = cands.filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n');
  if (/it was running:[\s\S]*greenlineHangTestBusyLoop/.test(text) || /no JavaScript running|no call stack/.test(text)) break;
}
ok(/window not responding/.test(text), 'the hang is logged');
ok(/it was running:[\s\S]*greenlineHangTestBusyLoop/.test(text), 'the log names the function that was running');
await sleep(2000);
// (the window is still stuck in its loop: a plain close waits on it for ever - the app is ended from main)
await Promise.race([app.evaluate(({ app: a }) => a.exit(0)).catch(() => {}), sleep(5000)]);
try { app.process().kill('SIGKILL'); } catch { /* gone */ }
rmSync(prof, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
