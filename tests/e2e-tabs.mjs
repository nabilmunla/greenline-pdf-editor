// Closing with several files open; tab menu; the view box on thumbnails. xvfb-run -a node tests/e2e-tabs.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
const TMP = resolve('tests/tmp-tabs');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const files = ['a', 'b', 'c', 'd'].map((n) => { const f = join(TMP, n + '.pdf'); copyFileSync('tests/data/long-spec.pdf', f); return f; });
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-tabs'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=tabs', ...files] });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await app.evaluate(({ dialog }) => {
  globalThis.__box = []; globalThis.__asked = [];
  dialog.showMessageBox = async (_w, o) => { globalThis.__asked.push(o.message + ' | ' + o.buttons.join('/')); return { response: globalThis.__box.length ? globalThis.__box.shift() : 0 }; };
});
const answer = (n) => app.evaluate((_e, x) => { globalThis.__box.push(x); }, n);
const asked = () => app.evaluate(() => globalThis.__asked.splice(0));
// (the window may still be starting: no __gcc yet = no files yet)
const names = () => win.evaluate(() => (window.__gcc ? window.__gcc.docs().map((d) => d.name) : []));
for (let i = 0; i < 100 && (await names()).length < 4; i++) await sleep(150);
await sleep(1000);
ok((await names()).length === 4, 'four files open: ' + (await names()).join(','));

// the box on the thumbnail when zoomed in, and dragging it moves the view
if (!(await win.locator('.thumbs').count())) await win.locator('.rail-btn').first().click();
await sleep(400);
await win.evaluate(() => { window.__gcc.viewer().goTo(0); window.__gcc.viewer().setZoom(4); });
await sleep(800);
console.log('  vis', await win.evaluate(() => JSON.stringify([...window.__gcc.active().visRects], null, 0)), await win.evaluate(() => [document.querySelectorAll('.vbox').length, document.querySelectorAll('.tpic').length, window.__gcc.active().viewListeners.size, document.querySelector('.thumb[data-page="0"]')?.outerHTML.slice(0, 300)]), await win.evaluate(() => window.__gcc.viewer().zoom()));
const box = await win.locator('.thumb[data-page="0"] .vbox').boundingBox({ timeout: 3000 }).catch(() => null);
ok(!!box, 'view box shown on the thumbnail when zoomed in');
if (box) {
  const before = await win.evaluate(() => [document.querySelector('.viewer').scrollLeft, document.querySelector('.viewer').scrollTop]);
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 60, { steps: 6 });
  await win.mouse.up();
  await sleep(400);
  const after = await win.evaluate(() => [document.querySelector('.viewer').scrollLeft, document.querySelector('.viewer').scrollTop]);
  ok(after[0] > before[0] + 50 && after[1] > before[1] + 50, `dragging the box pans the view ${before} -> ${after}`);
  const box2 = await win.locator('.thumb[data-page="0"] .vbox').boundingBox();
  await win.screenshot({ path: join(TMP, 'viewbox.png'), clip: { x: 0, y: 100, width: 900, height: 600 } });
  ok(Math.abs(box2.x - box.x - 30) < 8 && Math.abs(box2.y - box.y - 60) < 8, 'box follows the pointer');
}
await win.evaluate(() => window.__gcc.viewer().fit('page'));
await sleep(500);
ok(!(await win.locator('.thumb[data-page="0"] .vbox').count()), 'no box when the whole page is in view');

// right-click on page thumbnails: a menu that acts on the selected pages
{
  const rot = () => win.evaluate(() => window.__gcc.active().pages.slice(0, 3).map((p) => p.rot || 0).join(','));
  const n0 = await win.evaluate(() => window.__gcc.active().pages.length);
  await win.locator('.thumb[data-page="0"]').click();
  await win.locator('.thumb[data-page="1"]').click({ modifiers: ['Control'] });
  await win.locator('.thumb[data-page="1"]').click({ button: 'right' });
  ok(await win.locator('.cmenu button', { hasText: 'Rotate 2 pages right' }).count() === 1, 'right-click a selected thumbnail: menu for the 2 selected pages');
  await win.locator('.cmenu button', { hasText: 'Rotate 2 pages right' }).click();
  await sleep(1200);
  ok((await rot()) === '90,90,0', 'rotated the two selected pages: ' + (await rot()));
  // right-click on an unselected page: it becomes the selection
  await win.locator('.thumb[data-page="2"]').click({ button: 'right' });
  ok(await win.locator('.cmenu button', { hasText: 'Go to page 3' }).count() === 1, 'right-click an unselected thumbnail: menu for that page');
  await win.keyboard.press('Escape');
  await sleep(200);
  ok(!(await win.locator('.cmenu').count()), 'Escape closes the menu');
  await win.locator('.thumb[data-page="2"]').click({ button: 'right' });
  await win.locator('.cmenu button', { hasText: 'Insert blank page after' }).click();
  await sleep(1200);
  const n1 = await win.evaluate(() => window.__gcc.active().pages.length);
  ok(n1 === n0 + 1, `blank page inserted after page 3 (${n0} -> ${n1})`);
  await win.locator('.thumb[data-page="0"]').click({ button: 'right' });
  await win.mouse.click(1200, 500);
  await sleep(200);
  ok(!(await win.locator('.cmenu').count()), 'clicking elsewhere closes the menu');
  for (let k = 0; k < 2; k++) { await win.keyboard.press('Control+z'); await sleep(800); }
  // (this file was changed above: don't save it when its tab is closed below)
  await answer(1);
}

// tab menu: close tabs to the right of b
await win.locator('.dtab', { hasText: 'b.pdf' }).click({ button: 'right' });
await win.locator('.cmenu button', { hasText: 'Close tabs to the right' }).click();
await sleep(800);
ok(JSON.stringify(await names()) === '["a.pdf","b.pdf"]', 'close tabs to the right: ' + (await names()).join(','));
await asked();

// two unsaved files, window close button: asked which, then about unsaved ones together
await win.evaluate(async () => { for (const d of window.__gcc.docs()) await d.create(0, { type: 'Square', rect: [10, 10, 50, 50] }); });
await sleep(300);
await answer(1); // "Close only this file" (the active one)
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
await sleep(300);
await answer(1); // that one: Don't save
await sleep(1200);
let a = await asked();
ok(/2 files are open/.test(a[0]) && (await names()).length === 1, 'window close with 2 files -> "close only this one" kept the other: ' + a.join(' || '));
// open two more, then "Close all" from the tab menu with 2 unsaved: one question for all
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', f), [files[2], files[3]]);
for (let i = 0; i < 100 && (await names()).length < 3; i++) await sleep(150);
await sleep(800);
await win.evaluate(async () => { for (const d of window.__gcc.docs()) if (!d.dirty) await d.create(0, { type: 'Square', rect: [10, 10, 50, 50] }); });
await sleep(300);
await answer(1); // Don't save (all)
await win.locator('.dtab').first().click({ button: 'right' });
await win.locator('.cmenu button', { hasText: 'Close all' }).click();
await sleep(1500);
a = await asked();
ok(a.length === 1 && /3 files have unsaved changes/.test(a[0]) && (await names()).length === 0, 'close all: one question for the unsaved files: ' + a.join(' || '));
await app.evaluate(({ app: x }) => x.exit(0)).catch(() => {});
process.exit(fails ? 1 : 0);
