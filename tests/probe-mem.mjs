// Probe: memory per process with several dense sheets open in tabs (each drawn completely).
import { _electron as electron } from 'playwright';
import { resolve, join, basename } from 'node:path';
import { rmSync, copyFileSync, mkdirSync } from 'node:fs';
const files = process.argv.slice(2);
mkdirSync('tests/tmp-probe', { recursive: true });
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-probe'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=probe', ...(process.env.RENDERERS ? ['--renderers=' + process.env.RENDERERS] : [])] });
const win = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await win.waitForFunction(() => !!window.__gcc, null, { timeout: 60000 });
const E = (fn, a) => win.evaluate(fn, a);
const idle = async () => { const t = Date.now(); while (Date.now() - t < 180000) { const s = await E(() => window.__gcc.tiles.stats()).catch(() => null); if (s && s.tiles > 0 && !s.queued && !s.inflight) { await sleep(200); const s2 = await E(() => window.__gcc.tiles.stats()); if (!s2.queued && !s2.inflight) return Date.now() - t; } await sleep(50); } return -1; };
const mem = async () => (await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => [m.type + (m.serviceName ? ':' + m.serviceName.replace('PDF Editor ', '') : ''), Math.round(m.memory.workingSetSize / 1024)]))).filter((x) => x[1] > 150).map((x) => x.join(' ') + 'MB').join(' | ');
for (const f of files) {
  const F = resolve('tests/tmp-probe/' + basename(f)); copyFileSync(f, F);
  const t = Date.now();
  await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), F);
  await sleep(400); await idle();
  // zoom in a bit and back, like a look around
  await E(() => window.__gcc.viewer().setZoom(window.__gcc.viewer().zoom() * 3)); await sleep(300); await idle();
  await E(() => window.__gcc.viewer().fit('page')); await sleep(300); await idle();
  console.log(basename(f), 'open+drawn', Date.now() - t, 'ms ::', await mem());
}
// switch back to the first tab
const t = Date.now();
await win.locator('.dtab, .doctab, .tab').first().click().catch(() => {});
await sleep(300); await idle();
console.log('back to first tab', Date.now() - t, 'ms ::', await mem());
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
process.exit(0);
