// The public README's screenshots and zoom GIF frames (not a test), from the public build's tree:
//   python3 scripts/make-sample-plan.py sample.pdf && xvfb-run -a node tests/shots-readme.mjs sample.pdf <out dir>
// (frames -> GIF: see NOTES 0.9.4; the spec tab only where tests/data is there)
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';

const [SAMPLE, OUT] = process.argv.slice(2).map((p) => resolve(p));
const TMP = resolve('tests/tmp-shots');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });
const PLAN = join(TMP, 'GL-A-101 Typical Floor Plan.pdf');
const SPEC = join(TMP, 'Specification - Concrete Works.pdf');
copyFileSync(SAMPLE, PLAN);
const HAS_SPEC = existsSync('tests/data/long-spec.pdf');
if (HAS_SPEC) copyFileSync('tests/data/long-spec.pdf', SPEC);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-shots'), { recursive: true, force: true });
mkdirSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-shots'), { recursive: true });
writeFileSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-shots', 'settings.json'), JSON.stringify({ propsPanel: false, author: 'Greenline' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=shots', '--force-device-scale-factor=1.5'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1440, 900); });
await win.waitForFunction(() => !!window.__gcc && !!document.querySelector('.start-hero'), null, { timeout: 60000 });
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
const E = (fn, a) => win.evaluate(fn, a);
const settled = async () => { let calm = 0; for (let i = 0; i < 3000; i++) { const s = await E(() => window.__gcc.tiles.stats()); calm = s.queued === 0 && s.inflight === 0 ? calm + 1 : 0; if (calm >= 4) return; await sleep(25); } };
const shot = async (name) => { await settled(); await sleep(400); await win.screenshot({ path: join(OUT, name + '.png') }); console.log('shot', name); };
const open = async (f, n) => { await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), f); await win.waitForFunction((nm) => window.__gcc.active()?.name === nm && window.__gcc.active().pages.length > 0, n, { timeout: 60000 }); };

// the start page first
await shot('start');
if (HAS_SPEC) await open(SPEC, 'Specification - Concrete Works.pdf');
await open(PLAN, 'GL-A-101 Typical Floor Plan.pdf');
await sleep(500);

// page coordinates (pt, from the top left) of the plan's own metres (see make_sample.py)
const PT = 72 / 25.4, PH = 594 * PT;
const pm = (x, y, ox = 75, oy = 95, m = 10) => [(ox + x * m) * PT, PH - (oy + y * m) * PT];
const at = async (p) => {
  const box = await win.locator('.pg[data-page="0"]').boundingBox();
  const w = await E(() => window.__gcc.active().pages[0].w);
  const k = box.width / w;
  return [box.x + p[0] * k, box.y + p[1] * k];
};
const click = async (p, opt) => { const q = await at(p); await win.mouse.click(q[0], q[1], opt); await sleep(90); };
const tab = (name) => win.locator('.rtab', { hasText: new RegExp('^' + name + '$') }).click();
const tool = async (id) => { await win.locator(`.ribbon [data-tool="${id}"]`).first().click(); await sleep(250); };

// the main plan filling the view
const [x0, y0] = pm(-5, 21.5), [x1, y1] = pm(45, -5.5);
await E(() => window.__gcc.viewer().setZoom(0.78));
await sleep(300);
await E((r) => window.__gcc.viewer().goTo(0, r, true), [x0, y0, x1, y1]);
await sleep(600);
// scale 1:100
await win.locator('.statusbar button', { hasText: 'Scale' }).click();
await win.locator('.modal .chip', { hasText: /^1:100$/ }).first().click();
await sleep(500);
await tab('Measure');
if (await win.locator('.ribbon .rb', { hasText: 'Snap on' }).count()) await win.locator('.ribbon .rb', { hasText: 'Snap on' }).click();
// areas: the living rooms and bedrooms of three flats
await tool('m-area');
for (const fx of [0, 12, 30]) {
  for (const [a, b] of [[0.2, 3.1]]) {
    for (const p of [[fx + a, 0.2], [fx + b, 0.2], [fx + b, 4.7], [fx + a, 4.7]]) await click(pm(...p));
    await win.keyboard.press('Enter');
    await sleep(350);
  }
}
// the corridor's length
await tool('m-length');
await click(pm(0.3, 8.4)); await click(pm(41.7, 8.4));
await sleep(300);
// a count of the flat entrance doors
await tool('m-count');
for (const fx of [0, 6, 12, 24, 30, 36]) { await click(pm(fx + 4.35, 6.9)); await click(pm(fx + 4.35, 9.9)); }
await win.keyboard.press('Escape');
await sleep(200);
await win.locator('.viewer').focus(); await win.keyboard.press('v');
await win.locator('.ribbon .rb', { hasText: 'Totals' }).click();
await sleep(800);
await win.mouse.click(5, 450).catch(() => {});
await shot('measure');

// dark theme, same view
await win.locator('.tb-btn[title="Dark theme"]').click();
await sleep(600);
await shot('measure-dark');
await win.locator('.tb-btn[title="Light theme"]').click();
await sleep(400);
await win.locator('.side, aside, div').filter({ hasText: /^Counts & totals$/ }).first().locator('xpath=..').locator('button').first().click().catch((e) => console.log('totals close: ' + e.message.split('\n')[0]));
await sleep(300);

// markups on the enlarged unit plan (1:50 view, top left)
const pu = (x, y) => pm(x, y, 85, 395, 20);
{ const [a, b] = pu(-2.2, 8.8), [c, d] = pu(14.5, -2.6); await E(() => window.__gcc.viewer().setZoom(1.15)); await sleep(300); await E((r) => window.__gcc.viewer().goTo(0, r, true), [a, b, c, d]); }
await sleep(600);
const red = [0.85, 0.1, 0.1];
await E(async ([v, cal, box]) => {
  const d = window.__gcc.active();
  await d.create(0, { type: 'Polygon', vertices: v, color: [0.85, 0.1, 0.1], bw: 1.5, cloudy: 1, kind: 'cloud' });
  await d.create(0, { type: 'FreeText', rect: box, contents: 'Bathroom too small for an accessible unit - widen to 2.4 m?', color: [1, 1, 0.85], bw: 1, font: { size: 11, color: [0.8, 0, 0] }, intent: 'FreeTextCallout', callout: [cal], kind: 'callout' });
}, [[pu(0.1, 7.1), pu(2.1, 7.1), pu(2.1, 4.7), pu(0.1, 4.7)], pu(1.6, 4.9), [...pu(7.2, 6.4), ...pu(12.6, 5.6)].map((v, i) => v)]);
await E(async ([a, b]) => { await window.__gcc.active().create(0, { type: 'Line', kind: 'arrow', line: [a, b], color: [0.1, 0.35, 0.8], bw: 2, le: ['None', 'ClosedArrow'] }); }, [pu(7.5, 2.25), pu(5.4, 2.25)]);
await E(async (r) => { await window.__gcc.active().create(0, { type: 'FreeText', rect: r, contents: 'Wardrobe 600 deep -\nconfirm with ID', color: [0.92, 0.96, 1], bw: 1, font: { size: 11, color: [0.1, 0.3, 0.75] }, kind: 'textbox' }); }, [...pu(7.6, 2.6), ...pu(10.6, 1.9)]);
await tab('Comment').catch(() => {});
await sleep(400);
await shot('markup');

// a zoom from the whole sheet into the unit plan (frames for the GIF)
await E(() => window.__gcc.viewer().fit('page'));
await sleep(300);
await shot('sheet');
const fr = join(OUT, 'frames');
mkdirSync(fr, { recursive: true });
const vb = await win.locator('.viewer').first().boundingBox();
const [cx, cy] = pu(3, 3.6);
let n = 0;
const frame = async () => { await win.screenshot({ path: join(fr, String(n++).padStart(3, '0') + '.png') }); };
const view = async (z) => {
  await E((z) => window.__gcc.viewer().setZoom(z), z);
  await E(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await E((r) => window.__gcc.viewer().goTo(0, r, true), [cx - vb.width / (2 * z), cy - vb.height / (2 * z), cx + vb.width / (2 * z), cy + vb.height / (2 * z)]);
  await sleep(90);
};
const z0 = await E(() => window.__gcc.viewer().zoom());
await view(z0); await settled();
for (let i = 0; i < 6; i++) await frame();
const z1 = 1.25, steps = 16;
for (let i = 1; i <= steps; i++) { await view(z0 * Math.pow(z1 / z0, i / steps)); await frame(); }
await settled();
for (let i = 0; i < 10; i++) { await sleep(80); await frame(); }
console.log('frames', n);
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
rmSync(TMP, { recursive: true, force: true });
process.exit(0);
