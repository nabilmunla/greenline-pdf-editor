// Interop: make every kind of markup in the real app (text markups by dragging over text, the
// rest the way the tools make them), save, and write the file for other PDF readers to draw.
// xvfb-run -a -s "-screen 0 2000x1200x24" node tests/interop.mjs  -> tests/out/interop/markups.pdf
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
const OUT = resolve('tests/out/interop');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const F = join(OUT, 'source.pdf');
copyFileSync('tests/data/long-spec.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-interop'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=interop'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1500, 950); });
for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc)); i++) await sleep(200);
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
await win.waitForFunction(() => window.__gcc.active()?.pages.length > 0);
await sleep(1000);
const E = (fn, a) => win.evaluate(fn, a);
await E(() => window.__gcc.viewer().fit('width'));
await sleep(800);

// text lines on page 1: box of the n-th line ("0.n The Contractor ...")
const lineBox = (n) => E(async (n) => {
  const c = await window.__gcc.active().chars(0);
  const key = `0.${n} The Contractor`;
  const i = c.text.indexOf(key);
  const j = c.text.indexOf('\n', i);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let k = i; k < (j < 0 ? i + 60 : j); k++) { const b = c.box.slice(k * 4, k * 4 + 4); if (Number.isNaN(b[0])) continue; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
  return [x0, y0, x1, y1];
}, n);
async function at(x, y) {
  const box = await win.locator('.pg[data-page="0"]').boundingBox();
  const w = await E(() => window.__gcc.active().pages[0].w);
  const k = box.width / w;
  return [box.x + x * k, box.y + y * k];
}
async function dragText(tool, n) {
  await win.locator('.rtab', { hasText: /^Comment$/ }).click();
  await win.locator(`.ribbon [data-tool="${tool}"]`).click();
  const b = await lineBox(n);
  const p = await at(b[0] + 1, (b[1] + b[3]) / 2), q = await at(b[0] + (b[2] - b[0]) * 0.6, (b[1] + b[3]) / 2);
  await win.mouse.move(p[0], p[1]); await win.mouse.down(); await win.mouse.move(q[0], q[1], { steps: 10 }); await win.mouse.up();
  await sleep(600);
}
await dragText('highlight', 1);
await dragText('underline', 3);
await dragText('strike', 5);
await dragText('squiggly', 7);
// area highlight: drag on an empty spot with the highlighter
await win.locator('.ribbon [data-tool="highlight"]').click();
{ const p = await at(420, 120), q = await at(560, 160); await win.mouse.move(p[0], p[1]); await win.mouse.down(); await win.mouse.move(q[0], q[1], { steps: 8 }); await win.mouse.up(); await sleep(600); }
await win.keyboard.press('Escape');

// the rest, as the tools make them
await E(async () => {
  const d = window.__gcc.active();
  const red = [0.85, 0.1, 0.1], blue = [0.1, 0.3, 0.9];
  await d.create(0, { type: 'Square', rect: [60, 420, 180, 480], color: red, bw: 1.5, kind: 'rect' });
  await d.create(0, { type: 'Circle', rect: [200, 420, 300, 480], color: blue, ic: [0.8, 0.9, 1], bw: 1.5, kind: 'ellipse' });
  await d.create(0, { type: 'Line', line: [[320, 430], [440, 470]], color: red, bw: 2, kind: 'line' });
  await d.create(0, { type: 'Line', line: [[460, 470], [560, 430]], color: red, bw: 2, le: ['None', 'ClosedArrow'], kind: 'arrow' });
  await d.create(0, { type: 'PolyLine', vertices: [[60, 520], [100, 560], [140, 520], [180, 560]], color: blue, bw: 1.5, kind: 'polyline' });
  await d.create(0, { type: 'Polygon', vertices: [[200, 520], [260, 510], [290, 560], [220, 575]], color: blue, bw: 1.5, kind: 'polygon' });
  await d.create(0, { type: 'Polygon', vertices: [[320, 515], [420, 515], [420, 575], [320, 575]], color: red, bw: 1.5, cloudy: 1, kind: 'cloud' });
  await d.create(0, { type: 'Ink', ink: [[[450, 520], [470, 540], [490, 515], [510, 560], [540, 530]]], color: [0.1, 0.5, 0.2], bw: 2, kind: 'pencil' });
  await d.create(0, { type: 'FreeText', rect: [60, 600, 220, 640], contents: 'Text box: check slab', color: [1, 1, 0.8], bw: 1, font: { size: 11, color: [0, 0, 0] }, kind: 'textbox' });
  await d.create(0, { type: 'FreeText', rect: [300, 600, 470, 630], contents: 'Callout: see detail 4', color: [1, 1, 1], bw: 1, font: { size: 11, color: [0.8, 0, 0] }, intent: 'FreeTextCallout', callout: [[250, 680]], kind: 'callout' });
  await d.create(0, { type: 'FreeText', rect: [60, 700, 260, 716], contents: 'Typewriter text', color: null, bw: 0, font: { size: 11, color: [0, 0, 0.6] }, kind: 'typewriter' });
  await d.create(0, { type: 'Text', rect: [520, 600, 540, 620], color: [1, 0.85, 0.2], contents: 'Sticky note comment', kind: 'note' });
  await d.create(0, { type: 'Redact', rect: [300, 700, 420, 716], redactFill: [0, 0, 0], kind: 'redact-area' });
});
await sleep(800);
// measurements need a scale; stamp from the built-in list
await E(async () => {
  const d = window.__gcc.active();
  try { await d.setScale?.([0], { ratio: 100, unit: 'm' }); } catch { /* not this API */ }
});
const before = await E(async () => (await window.__gcc.active().allAnnots()).map((a) => `${a.type}/${a.kind || ''}`));
console.log('made:', before.join(', '));
const out = join(OUT, 'markups.pdf');
await E((p) => window.__gcc.active().save(p), out);
await sleep(800);
await win.screenshot({ path: join(OUT, 'in-app.png') });
console.log('saved', out);
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
process.exit(0);
