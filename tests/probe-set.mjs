// Probe: a multi-sheet drawing set - go through every sheet and back; time per sheet, engine restarts, memory.
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { rmSync, copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('tests/tmp-probe', { recursive: true });
const F = resolve('tests/tmp-probe/set.pdf'); copyFileSync(process.argv[2] || 'tests/fixtures/drawing-set-6.pdf', F); // (node tests/mk-drawing-set.mjs makes it)
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-probe'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=probe'] });
const win = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await win.waitForFunction(() => !!window.__gcc, null, { timeout: 60000 });
const E = (fn, a) => win.evaluate(fn, a);
const idle = async () => { const t = Date.now(); while (Date.now() - t < 240000) { const s = await E(() => window.__gcc.tiles.stats()).catch(() => null); if (s && s.tiles > 0 && !s.queued && !s.inflight) { await sleep(200); const s2 = await E(() => window.__gcc.tiles.stats()); if (!s2.queued && !s2.inflight) return Date.now() - t; } await sleep(50); } return -1; };
const restarts = () => E(() => window.__gcc.engines.renderers.map((r) => r.restarts).join(','));
const mem = async () => (await app.evaluate(({ app: a }) => a.getAppMetrics().filter((m) => m.type === 'Utility' && m.memory.workingSetSize > 200000).map((m) => Math.round(m.memory.workingSetSize / 1024)))).join('/') + ' MB';
await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), F);
await win.waitForFunction(() => window.__gcc.active()?.pages.length > 0, null, { timeout: 60000 });
await E(() => window.__gcc.viewer().fit('page'));
let T = Date.now();
await sleep(300); await idle();
console.log('sheet 1 drawn', Date.now() - T, 'ms; restarts', await restarts(), '; engines', await mem());
const n = await E(() => window.__gcc.active().pages.length);
for (const i of [...Array(n).keys()].slice(1).concat([0, 3])) {
  T = Date.now();
  await E((k) => window.__gcc.viewer().goTo(k), i);
  await sleep(300); await idle();
  if (process.env.ZOOM) { await E(() => window.__gcc.viewer().setZoom(window.__gcc.viewer().zoom() * 5)); await sleep(300); await idle(); await E(() => window.__gcc.viewer().fit('page')); await sleep(300); await idle(); }
  console.log(`sheet ${i + 1} drawn`, Date.now() - T, 'ms; restarts', await restarts(), '; engines', await mem());
}
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
process.exit(0);
