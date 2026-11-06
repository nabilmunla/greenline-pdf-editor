// Probe: engine calls while a dense sheet opens (until the picture is complete), with start/end times.
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { rmSync } from 'node:fs';
const F = resolve(process.argv[2]);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-probe'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=probe', ...(process.env.RENDERERS ? ['--renderers=' + process.env.RENDERERS] : [])] });
const win = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await win.waitForFunction(() => !!window.__gcc, null, { timeout: 60000 });
const E = (fn, a) => win.evaluate(fn, a);
await sleep(800); await E(() => window.__gccSlow.splice(0));
const t0 = await E(() => performance.now());
await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), F);
let t = Date.now();
while (Date.now() - t < 120000) { const s = await E(() => window.__gcc.tiles.stats()).catch(() => null); if (s && s.tiles > 0 && !s.queued && !s.inflight) break; await sleep(50); }
console.log('picture complete', Date.now() - t, 'ms');
const s = await E(() => window.__gccSlow.splice(0));
for (const c of s) console.log(`${String(Math.round(c.at - t0)).padStart(6)} +${String(c.ms).padStart(6)}  ${c.engine}.${c.method}`);
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
process.exit(0);
