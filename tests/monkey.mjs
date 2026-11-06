// Monkey test: random clicks on ribbon buttons and tools, random drags on the page, random keys
// and tab switches for a while. Native dialogs answer "cancel"; opening folders / printing /
// the internet are stubbed. Checked: no uncaught page errors, the app still answers, the file
// still saves and opens again.  xvfb-run -a -s "-screen 0 1800x1100x24" node tests/monkey.mjs [seconds] [seed]
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SECONDS = Number(process.argv[2] || 120), SEED = Number(process.argv[3] || 1);
const TMP = resolve('tests/tmp-monkey');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
copyFileSync('tests/data/long-spec.pdf', join(TMP, 'spec.pdf'));
copyFileSync('tests/real/b1-floor-22mb.pdf', join(TMP, 'sheet.pdf'));
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-monkey'), { recursive: true, force: true });
let s = SEED * 2654435761 >>> 0 || 1;
const R = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const pick = (xs) => xs[Math.floor(R() * xs.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=monkey'], env: { ...process.env, PDFED_AI_ANTHROPIC: 'http://127.0.0.1:9', PDFED_AI_OPENAI: 'http://127.0.0.1:9' } });
const win = await app.firstWindow();
win.on('pageerror', (e) => { errors.push('PAGEERROR ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')); });
win.on('console', (m) => { if (m.type() === 'error' && !/favicon|net::ERR|Failed to load resource|Estimating resolution|Detected \d+ diacritics|Warning: Invalid resolution/.test(m.text())) errors.push('console: ' + m.text().slice(0, 300)); });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc).catch(() => false)); i++) await sleep(200);
const SAVE_TO = join(TMP, 'saved.pdf');
await app.evaluate(({ dialog, shell, BrowserWindow }, saveTo) => {
  dialog.showMessageBox = async (_w, o) => ({ response: ((o || _w)?.buttons?.length || 1) - 1, checkboxChecked: false });
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });
  shell.openPath = async () => '';
  shell.openExternal = async () => {};
  shell.showItemInFolder = () => {};
  for (const w of BrowserWindow.getAllWindows()) w.webContents.print = (_o, cb) => cb && cb(false, 'stubbed');
}, SAVE_TO);
for (const f of ['spec.pdf', 'sheet.pdf']) await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), join(TMP, f));
await win.waitForFunction(() => window.__gcc.docs().length === 2, null, { timeout: 60000 });
await sleep(1500);

const t0 = Date.now();
let actions = 0;
const counts = {};
const skip = /print|backups|report a problem|ask about|translate|send|key|ai|update|check now|restart|go back|licen|batch|merge files|combine|open…|open\.\.\.|^open$/i;
while (Date.now() - t0 < SECONDS * 1000) {
  const kind = pick(['tool', 'tool', 'cmd', 'drag', 'drag', 'click', 'key', 'key', 'tab', 'rtab', 'esc', 'wheel']);
  counts[kind] = (counts[kind] || 0) + 1;
  actions++;
  try {
    // every tab closed by the monkey: open a file again and go on
    if (!(await win.evaluate(() => window.__gcc.docs().length))) {
      await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), join(TMP, pick(['spec.pdf', 'sheet.pdf'])));
      await win.waitForFunction(() => window.__gcc.docs().length > 0, null, { timeout: 30000 }).catch(() => {});
      await sleep(800);
      counts.reopen = (counts.reopen || 0) + 1;
    }
    const pageBox = (await win.locator('.pg').count()) ? await win.locator('.pg').first().boundingBox({ timeout: 2000 }).catch(() => null) : null;
    if (kind === 'rtab') await win.locator('.rtab').nth(Math.floor(R() * 10)).click({ timeout: 1500 });
    else if (kind === 'tool' || kind === 'cmd') {
      const sel = kind === 'tool' ? '.ribbon [data-tool]:not([disabled])' : '.ribbon [data-cmd]:not([disabled])';
      const n = await win.locator(sel).count();
      if (n) {
        const el = win.locator(sel).nth(Math.floor(R() * n));
        const label = ((await el.getAttribute('data-cmd')) || (await el.textContent()) || '').trim();
        if (!skip.test(label)) await el.click({ timeout: 1500 });
      }
    } else if (kind === 'drag' && pageBox) {
      const x = pageBox.x + R() * Math.min(pageBox.width, 900), y = pageBox.y + R() * Math.min(pageBox.height, 700);
      await win.mouse.move(x, y); await win.mouse.down();
      await win.mouse.move(x + (R() - 0.3) * 200, y + (R() - 0.3) * 150, { steps: 6 });
      await win.mouse.up();
      if (await win.locator('.ed.rich, textarea.ed, input.ed').count()) { await win.keyboard.insertText(pick(['Check', 'ملاحظة', 'Rev B 4.2', ''])); await win.keyboard.press(pick(['Escape', 'Control+Enter'])); }
    } else if (kind === 'click' && pageBox) {
      await win.mouse.click(pageBox.x + R() * Math.min(pageBox.width, 900), pageBox.y + R() * Math.min(pageBox.height, 700), { clickCount: pick([1, 1, 2]) });
    } else if (kind === 'key') {
      await win.keyboard.press(pick(['Delete', 'Control+z', 'Control+y', 'ArrowLeft', 'ArrowDown', 'Shift+ArrowRight', 'Control+d', 'Control+c', 'Control+v', 'F2', 'PageDown', 'Home', 'End', 'Control+0', 'Control+2', 'Control+=', 'Control+-', 'Control+a', 'F9', 'Tab', 'Enter']));
    } else if (kind === 'tab') {
      const n = await win.locator('.doctab, .tab').count();
      if (n) await win.locator('.doctab, .tab').nth(Math.floor(R() * n)).click({ timeout: 1500 }).catch(() => {});
    } else if (kind === 'esc') {
      await win.keyboard.press('Escape');
      if (await win.locator('.modal').count()) await win.locator('.modal .actions .btn').first().click({ timeout: 1000 }).catch(() => {});
    } else if (kind === 'wheel' && pageBox) {
      await win.mouse.move(pageBox.x + 200, pageBox.y + 200); await win.mouse.wheel(0, (R() - 0.5) * 1500);
    }
    // a dialog left open: close it most of the time
    if (await win.locator('.modal').count() && R() < 0.7) await win.keyboard.press('Escape');
  } catch { /* an element that went away: fine */ }
  await sleep(40 + R() * 120);
  if (process.env.MONKEY_TRACE) console.log(actions, kind, Date.now() - t0);
}
// still alive and consistent?
await win.keyboard.press('Escape').catch(() => {});
await win.keyboard.press('Escape').catch(() => {});
let alive = false, saved = false, reopened = false;
try {
  alive = await Promise.race([win.evaluate(async () => { const d = window.__gcc.active(); if (!d) return true; await d.allAnnots(); return true; }), sleep(15000).then(() => false)]);
  const out = join(TMP, 'final.pdf');
  const info = await win.evaluate(() => ({ docs: window.__gcc.docs().map((d) => d.name + (d.dirty ? '*' : '')), active: window.__gcc.active()?.name || null, modal: document.querySelector('.modal .mhead, .modal h2')?.textContent || null, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.slice(0, 80)) }));
  console.log('state at the end:', JSON.stringify(info));
  if (!info.active) { saved = true; reopened = true; console.log('(all tabs were closed by the monkey - nothing to save)'); throw null; }
  const r = await Promise.race([win.evaluate((p) => window.__gcc.active().save(p).then((x) => String(x), (e) => 'error: ' + e), out), sleep(60000).then(() => 'save timed out')]);
  console.log('save:', r);
  await sleep(800);
  saved = existsSync(out) && statSync(out).size > 1000;
  if (saved) { execFileSync('python3', ['-c', `import pikepdf; pikepdf.open(${JSON.stringify(out)}).pages[0]`]); reopened = true; }
} catch (e) { if (e) errors.push('final check: ' + String(e.message || e).slice(0, 200)); }
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(`monkey seed ${SEED}: ${actions} actions in ${SECONDS}s ${JSON.stringify(counts)}`);
console.log(`alive ${alive}, saved ${saved}, reopened ${reopened}`);
for (const e of errors.slice(0, 15)) console.log(e);
console.log(errors.length || !alive || !saved || !reopened ? `${errors.length} errors - FAILED` : 'all passed');
process.exit(errors.length || !alive || !saved || !reopened ? 1 : 0);
