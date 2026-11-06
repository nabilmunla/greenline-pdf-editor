// A closed file reopens where it was left (page, spot, zoom). xvfb-run -a node tests/e2e-view.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
const TMP = resolve('tests/tmp-view');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'spec.pdf');
copyFileSync(process.env.VIEW_FILE || 'tests/data/long-spec.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-view'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
async function run(fn) {
  const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=view'] });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
  for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc)); i++) await sleep(200);
  try { await fn(app, win); } finally { await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {}); }
}
const open = async (app, win) => {
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
  for (let i = 0; i < 100 && !(await win.evaluate(() => window.__gcc.active()?.pages.length > 0)); i++) await sleep(100);
  await sleep(800);
};
const state = (win) => win.evaluate(() => { const v = window.__gcc.viewer(); const d = window.__gcc.active(); return { page: v.page(), z: +v.zoom().toFixed(3), fit: d.view.fit, a: d.view.anchor }; });
let before;
await run(async (app, win) => {
  await open(app, win);
  await win.evaluate(() => { window.__gcc.viewer().setZoom(2.2); });
  await sleep(500);
  await win.evaluate((pg) => window.__gcc.viewer().goTo(pg, [100, 300, 200, 400]), +(process.env.P1 || 36));
  await sleep(800);
  before = await state(win);
  await win.keyboard.press('Control+w');
  await sleep(800);
});
await run(async (app, win) => {
  await open(app, win);
  const after = await state(win);
  ok(after.page === before.page, `same page (${before.page + 1} -> ${after.page + 1})`);
  ok(Math.abs(after.z - before.z) < 0.01, `same zoom (${before.z} -> ${after.z})`);
  ok(Math.abs(after.a.y - before.a.y) < 2 && Math.abs(after.a.x - before.a.x) < 2, `same spot (${JSON.stringify(before.a)} -> ${JSON.stringify(after.a)})`);
  // fit-width files reopen fitted, at the page they were on
  await win.evaluate(() => window.__gcc.viewer().fit('width'));
  await sleep(500);
  await win.evaluate((pg) => window.__gcc.viewer().goTo(pg), +(process.env.P2 || 120));
  await sleep(600);
  before = await state(win);
  await win.keyboard.press('Control+w');
  await sleep(800);
});
await run(async (app, win) => {
  await open(app, win);
  const after = await state(win);
  ok(after.fit === 'width' && after.page === before.page, `fit width kept, page ${before.page + 1} -> ${after.page + 1}`);
});
process.exit(fails ? 1 : 0);
