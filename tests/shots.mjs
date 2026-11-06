// Screenshots of every screen for a look-over (light and dark): start screen, ribbon tabs, panels,
// selections, menus, dialogs, Find a tool. xvfb-run -a -s "-screen 0 2000x1200x24" node tests/shots.mjs [light|dark]
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
const THEME = process.argv[2] || 'light';
const OUT = resolve('tests/out/shots-' + THEME);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const TMP = resolve('tests/tmp-shots');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const SPEC = join(TMP, 'spec.pdf'), SHEET = join(TMP, 'sheet.pdf');
copyFileSync('tests/data/long-spec.pdf', SPEC);
copyFileSync('tests/real/b1-floor-22mb.pdf', SHEET);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-shots'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=shots'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1500, 900); });
for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc)); i++) await sleep(200);
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
const E = (fn, a) => win.evaluate(fn, a);
let n = 0;
const shot = async (name, clip) => { await sleep(350); await win.screenshot({ path: join(OUT, String(++n).padStart(2, '0') + '-' + name + '.png'), ...(clip ? { clip } : {}) }); };
const idle = async () => { const t = Date.now(); while (Date.now() - t < 60000) { const s = await E(() => window.__gcc.tiles.stats()).catch(() => null); if (s && !s.queued && !s.inflight) return; await sleep(100); } };
const tab = (t) => win.locator('.rtab', { hasText: new RegExp('^' + t + '$') }).click();
const esc = async () => { await win.keyboard.press('Escape'); await sleep(250); if (await win.locator('.modal').count()) { await win.locator('.modal .actions .btn').first().click().catch(() => {}); await sleep(200); } };
if (THEME === 'dark') { await win.locator('.tb-btn[title="Dark theme"]').click(); await sleep(300); }

await shot('start');
await win.keyboard.press('Alt+q'); await win.keyboard.type('page num'); await shot('find-tool-nofile', { x: 0, y: 0, width: 1500, height: 420 }); await esc();
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), SPEC);
await win.waitForFunction(() => window.__gcc.active()?.pages.length > 0); await sleep(600); await idle();
await shot('spec-open');
for (const t of ['File', 'Home', 'Comment', 'Measure', 'Edit', 'Organize', 'Protect', 'OCR', 'AI', 'Batch']) { await tab(t); await shot('ribbon-' + t, { x: 0, y: 0, width: 1500, height: 175 }); }
await tab('Home');
// markups
await E(async () => { const d = window.__gcc.active(); await d.create(0, { type: 'Square', rect: [80, 200, 260, 300], color: [0.85, 0.1, 0.1], bw: 1.5 }); await d.create(0, { type: 'FreeText', rect: [300, 200, 470, 240], color: [1, 1, 0.8], contents: 'Check with the engineer', fontSize: 11 }); await d.create(0, { type: 'Text', rect: [500, 200, 520, 220], color: [1, 0.85, 0.2], contents: 'Price this item' }); });
await sleep(600); await idle();
const box = await win.locator('.pg[data-page="0"]').boundingBox();
const k = box.width / (await E(() => window.__gcc.active().pages[0].w));
await win.mouse.click(box.x + 170 * k, box.y + 200.5 * k); await sleep(400);
await shot('rect-selected');
await win.mouse.click(box.x + 170 * k, box.y + 250 * k, { button: 'right' }); await sleep(300);
await shot('context-menu');
await win.keyboard.press('Escape'); await sleep(200);
await win.mouse.click(box.x + 380 * k, box.y + 220 * k); await sleep(400);
await shot('textbox-selected');
await win.keyboard.press('Escape');
// panels
for (const [i, nm] of [[1, 'bookmarks'], [2, 'comments'], [3, 'search']]) { await win.locator('.rail-btn').nth(i).click(); await sleep(400); if (nm === 'search') { await win.locator('.side input').first().fill('clause 7'); await win.keyboard.press('Enter'); await sleep(2500); } await shot('panel-' + nm); }
await win.locator('.rail-btn').nth(0).click(); await sleep(300);
// find a tool
await win.keyboard.press('Alt+q'); await win.keyboard.type('measure'); await shot('find-tool', { x: 0, y: 0, width: 1500, height: 480 }); await esc();
// dialogs
const dialogs = [
  ['print', async () => win.keyboard.press('Control+p')],
  ['stamps', async () => { await tab('Comment'); await win.locator('.ribbon .rb', { hasText: /^\s*Stamp\s*$/ }).first().click(); }],
  ['page-marks', async () => { await tab('Edit'); await win.locator('.ribbon .rb', { hasText: 'Numbers' }).first().click(); }],
  ['protect', async () => { await tab('Protect'); await win.locator('.ribbon .rb', { hasText: /^\s*Protect\s*$/ }).first().click(); }],
  ['scale', async () => { await tab('Measure'); await win.locator('.ribbon .rb', { hasText: /^\s*Scale\s*$/ }).first().click(); }],
  ['properties', async () => { await tab('Protect'); await win.locator('.ribbon .rb', { hasText: 'Properties' }).first().click(); }],
  ['settings', async () => { await win.locator('.tb-btn[title="Settings"]').click(); }],
  ['merge', async () => { await tab('Organize'); await win.locator('.ribbon .rb', { hasText: 'Merge files' }).first().click(); }],
  ['compress', async () => { await tab('Batch'); await win.locator('.ribbon .rb', { hasText: 'Reduce size' }).first().click(); }],
  ['ocr', async () => { await tab('OCR'); await win.locator('.ribbon .rb', { hasText: 'Make searchable' }).first().click(); }],
  ['ai', async () => { await tab('AI'); await win.locator('.ribbon .rb', { hasText: 'Ask about this file' }).first().click(); }],
];
for (const [nm, open] of dialogs) {
  try { await open(); await sleep(800); await shot('dialog-' + nm); } catch (e) { console.log('could not open', nm, e.message.split('\n')[0]); }
  await esc(); await sleep(200);
  if (nm === 'ai') { await win.locator('.ai-panel .x, .aipanel .x, button[title="Close"]').first().click().catch(() => {}); }
}
// drawing
await tab('Home');
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), SHEET);
await win.waitForFunction(() => window.__gcc.active()?.name === 'sheet.pdf'); await sleep(800); await idle();
await shot('sheet-open');
await tab('Measure'); await sleep(200);
await win.locator('.ribbon [data-tool="m-length"]').click(); await sleep(300);
await shot('measure-tool');
await win.keyboard.press('Escape');
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log('shots in', OUT, n);
process.exit(0);
