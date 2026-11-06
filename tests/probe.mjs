// Probe: what the app waits for on a few heavy actions (window.__gccSlow = engine calls > 150 ms).
// xvfb-run -a node tests/probe.mjs <file.pdf>
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
const F = resolve(process.argv[2] || 'tests/huge/book1-317mb.pdf');
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-probe'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=probe'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
win.on('console', (m) => { if (/PROBE|slow/i.test(m.text())) console.log('console:', m.text()); });
await win.waitForFunction(() => !!window.__gcc, null, { timeout: 60000 });
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
const E = (fn, a) => win.evaluate(fn, a);
const until = async (fn, ms = 180000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return Date.now() - t; await sleep(25); } throw new Error('timeout'); };
const slow = async (label) => { const s = await E(() => { const x = window.__gccSlow.splice(0); return x; }); console.log(`-- ${label}:`, s.map((c) => `${c.engine}.${c.method} ${c.ms}ms`).join(', ') || '(nothing slow)'); };
await sleep(500); await E(() => window.__gccSlow.splice(0));
let t = Date.now();
await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), F);
await until(() => E(() => window.__gcc.active()?.pages.length > 0));
console.log('open', Date.now() - t, 'ms'); await slow('open');
await sleep(3000); await slow('after open (3 s)');
t = Date.now(); await E(() => window.__gcc.active().rotate([5], 90)); console.log('rotate', Date.now() - t, 'ms'); await slow('rotate');
await sleep(3000); await slow('after rotate (3 s)');
t = Date.now(); await E(() => window.__gcc.active().undo()); console.log('undo', Date.now() - t, 'ms'); await slow('undo');
await sleep(3000); await slow('after undo (3 s)');
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
process.exit(0);
