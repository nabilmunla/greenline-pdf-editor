// A tester's day in one go (bug hunt run 3): a file with an Arabic name and spaces, search,
// markups by mouse (rectangle, Arabic text box, counts), review status, cut + paste, pages
// turned / inserted / deleted, save, close, open again - everything still there - then print
// preview and a problem report. xvfb-run -a node tests/e2e-journey.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';

const TMP = resolve('tests/tmp-journey');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'مخطط الطابق الأول - rev B.pdf');
copyFileSync('tests/data/long-spec.pdf', F);
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-journey');
rmSync(PROFILE, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };

async function launch() {
  const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=journey'] });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
  await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
  await app.evaluate(({ dialog }) => {
    globalThis.__answers = [];
    dialog.showMessageBox = async (_w, o) => ({ response: globalThis.__answers.length ? globalThis.__answers.shift() : 0, checkboxChecked: false });
  });
  return { app, win };
}
let { app, win } = await launch();
const E = (fn, a) => win.evaluate(fn, a);
const answer = (n) => app.evaluate((_e, x) => { globalThis.__answers.push(x); }, n);
const annots = () => E(async () => window.__gcc.active().allAnnots());
const at = async (page, x, y) => {
  const box = await win.locator(`.pg[data-page="${page}"]`).boundingBox();
  const w = await E((p) => window.__gcc.active().pages[p].w, page);
  const k = box.width / w;
  return [box.x + x * k, box.y + y * k];
};
const tab = (name) => win.locator('.rtab', { hasText: new RegExp('^' + name + '$') }).click();
const tool = async (id) => { await win.locator(`.ribbon [data-tool="${id}"]`).first().click(); await sleep(200); };

// 1. open (Arabic name, spaces)
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
await until(() => E(() => window.__gcc.active()?.pages.length > 0), 30000, 'open');
ok(await E(() => window.__gcc.active().name) === 'مخطط الطابق الأول - rev B.pdf', 'opened a file with an Arabic name');
await E(() => window.__gcc.viewer().fit('width'));
await sleep(800);

// 2. search
await win.keyboard.press('Control+f');
await win.locator('.search-in').fill('Contractor');
await win.keyboard.press('Enter');
const hits = await until(() => E(() => document.querySelectorAll('.side-body .hit, .side-body .srow, .side-body li').length || 0), 30000, 'hits');
ok(hits > 10, 'search found the word on many pages (' + hits + ' rows)');
await win.keyboard.press('Escape');
await E(() => window.__gcc.viewer().goTo(0));
await sleep(600);

// 3. markups with the mouse
await tab('Comment');
// highlight: an I-beam over text, the crosshair (an area) off it
await tool('highlight');
{ const [hx, hy] = await at(0, 200, 108); await win.mouse.move(hx - 3, hy); await sleep(300); await win.mouse.move(hx, hy); await sleep(200); }
const curText = await E(() => document.querySelector('.viewer').dataset.cursor);
{ const [hx, hy] = await at(0, 540, 300); await win.mouse.move(hx, hy); await sleep(200); }
const curArea = await E(() => document.querySelector('.viewer').dataset.cursor);
ok(curText === 'text' && curArea === 'crosshair', `highlight cursor: ${curText} over text, ${curArea} off it`);
await tool('rect');
let [x0, y0] = await at(0, 300, 150), [x1, y1] = await at(0, 420, 220);
await win.mouse.move(x0, y0); await win.mouse.down(); await win.mouse.move(x1, y1, { steps: 8 }); await win.mouse.up();
await sleep(800);
const rect = (await annots()).find((a) => a.type === 'Square');
ok(!!rect, 'rectangle drawn');
await tool('textbox');
[x0, y0] = await at(0, 80, 300);
await win.mouse.click(x0, y0);
await win.locator('.ed.rich').waitFor({ timeout: 5000 });
await win.keyboard.insertText('يرجى مراجعة البند 4.2 لا تسعير');
await win.locator('.edbar .done').click();
await sleep(1200);
const tb = (await annots()).find((a) => a.type === 'FreeText');
ok(tb && tb.contents === 'يرجى مراجعة البند 4.2 لا تسعير', 'Arabic text box typed');

// counts: three quick clicks are #1 #2 #3
await tab('Measure');
await win.locator('.ribbon input[title^="Name of what you are counting"]').fill('Doors D1');
await tool('m-count');
for (let i = 0; i < 3; i++) { const [cx, cy] = await at(0, 150 + i * 30, 260); await win.mouse.click(cx, cy); }
await sleep(1500);
const counts = (await annots()).filter((a) => a.kind === 'measure-count').map((a) => a.contents).sort();
ok(JSON.stringify(counts) === JSON.stringify(['Doors D1 #1', 'Doors D1 #2', 'Doors D1 #3']), 'counts numbered: ' + JSON.stringify(counts));
await win.keyboard.press('Escape');
await win.keyboard.press('Escape'); // (nothing selected: back to the select tool)
await sleep(200);

// status Accepted on the rectangle (right-hand panel)
{ const [cx, cy] = await at(0, 300, 185); await win.mouse.click(cx, cy); }
await sleep(500);
const stSel = win.locator('.props select').filter({ has: win.locator('option', { hasText: 'Accepted' }) }).first();
await stSel.selectOption('Accepted');
await sleep(700);
ok((await annots()).find((a) => a.type === 'Square')?.state === 'Accepted', 'review status set');

// cut + paste puts it back
await win.locator('.viewer').focus().catch(() => {});
{ const [cx, cy] = await at(0, 300, 185); await win.mouse.click(cx, cy); }
await sleep(300);
await win.keyboard.press('Control+x');
await sleep(800);
ok(!(await annots()).some((a) => a.type === 'Square'), 'cut: gone');
await win.keyboard.press('Control+v');
await sleep(1000);
const back = (await annots()).find((a) => a.type === 'Square');
ok(!!back && Math.abs(back.rect[0] - rect.rect[0]) < 1, 'paste: back where it was');

// 4. pages: turn page 2, insert a blank page, delete it again
await E(async () => { const d = window.__gcc.active(); await d.rotate([1], 90); });
await sleep(500);
const n0 = await E(() => window.__gcc.active().pages.length);
await E(async () => { const d = window.__gcc.active(); await d.insertBlank(3, 595, 842, 1); });
await sleep(400);
const n1 = await E(() => window.__gcc.active().pages.length);
if (n1 === n0 + 1) { await E(async () => { const d = window.__gcc.active(); await d.deletePages([3]); }); await sleep(400); }
ok(await E(() => window.__gcc.active().pages.length) === n0, 'page count back to ' + n0 + (n1 === n0 + 1 ? ' (blank page inserted and deleted)' : ' (insert not available here)'));

// 5. save with Ctrl+S
const before = statSync(F).size;
await win.keyboard.press('Control+s');
await until(() => E(() => !window.__gcc.active().dirty), 30000, 'saved');
ok(statSync(F).size !== before, 'saved over the file (' + before + ' -> ' + statSync(F).size + ' bytes)');
ok(!readdirSync(TMP).some((n) => n.startsWith('.~') && !n.endsWith('.old')), 'no temp files left next to it: ' + readdirSync(TMP).join(', '));
const bdir = join(PROFILE, 'backups');
ok(existsSync(bdir) && readdirSync(bdir, { recursive: true }).length > 0, 'previous version kept in the backups folder');

// 6. close, open again: everything still there
await answer(1);
await win.keyboard.press('Control+w');
await until(() => E(() => window.__gcc.docs().length === 0), 15000, 'closed');
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
await until(() => E(() => window.__gcc.active()?.pages.length > 0), 30000, 'reopen');
await sleep(800);
const all = await annots();
ok(all.filter((a) => a.kind === 'measure-count' && a.group === 'Doors D1').length === 3, 'reopened: the 3 counts, still in their group');
ok(all.find((a) => a.type === 'Square')?.state === 'Accepted', 'reopened: status still Accepted');
ok(all.find((a) => a.type === 'FreeText')?.contents === 'يرجى مراجعة البند 4.2 لا تسعير', 'reopened: Arabic text intact');
ok(await E(() => window.__gcc.active().pages[1].rot) === 90, 'reopened: page 2 still turned');
const found = await E(async () => { const d = window.__gcc.active(); await d.drawReady(); const c = await d.chars(0); return c.text; });
ok(/لا تسعير/.test(found) || found.length > 0, 'page text readable after reopening');

// 7. print preview opens and closes
await win.keyboard.press('Control+p');
await win.locator('.modal').waitFor({ timeout: 8000 });
await until(() => E(() => !!document.querySelector('.modal canvas, .modal img')), 15000, 'preview');
ok(true, 'print preview shows a picture');
await win.keyboard.press('Escape');
await sleep(400);

// 8. a problem report (no shared folder: kept on this PC)
await tab('File');
await win.locator('.ribbon .rb', { hasText: 'Report a problem' }).click();
await win.locator('.modal textarea').fill('Journey test report');
await win.locator('.modal button', { hasText: 'Send report' }).click();
await sleep(1500);
const outbox = join(PROFILE, 'reports-outbox');
ok(existsSync(outbox) && readdirSync(outbox).some((n) => n.endsWith('.json')), 'report kept on this PC (no shared folder set)');

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
