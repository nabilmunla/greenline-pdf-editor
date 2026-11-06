// Tabs (0.8): many files - the tabs shrink to fit and the list button has them all; drag a tab
// along the strip to reorder; drag it out of the window: its own window; drag it onto the first
// window's tabs: back there (the empty window closes). Unsaved changes go along. One window
// doesn't offer another's unsaved work back as "left over". xvfb-run -a node tests/e2e-windows.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-windows');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };

// 22 small files with names of different lengths
const files = [];
for (let k = 0; k < 22; k++) {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let p = 0; p < 3; p++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, d.addObject({ Font: { F1: f } }), `BT /F1 24 Tf 72 700 Td (File ${k} page ${p + 1}) Tj ET`));
  const name = join(TMP, (k % 3 === 0 ? 'Tender drawings register - rev ' : 'Spec ') + String(k).padStart(2, '0') + '.pdf');
  writeFileSync(name, d.saveToBuffer('').asUint8Array());
  files.push(name);
}

rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-windows'), { recursive: true, force: true });
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=windows'] });
const w1 = await app.firstWindow();
await app.evaluate(({ BrowserWindow, dialog }) => {
  const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1280, 720); b.setPosition(0, 0);
  dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
});
await until(() => w1.evaluate(() => !!window.__gcc), 20000, 'app');
const names = (w) => w.evaluate(() => window.__gcc.docs().map((d) => d.name));

// ---------------------------------------------------------------- many tabs
await app.evaluate(({ BrowserWindow }, list) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', list), files.slice(0, 10));
await until(async () => (await names(w1)).length === 10, 30000, '10 files');
await sleep(600);
const tabInfo = (w) => w.evaluate(() => {
  const sc = document.querySelector('.dtabs-scroll').getBoundingClientRect();
  return [...document.querySelectorAll('.dtab')].map((t) => { const b = t.getBoundingClientRect(); return { w: Math.round(b.width), seen: b.left >= sc.left - 1 && b.right <= sc.right + 1 }; });
});
let ti = await tabInfo(w1);
ok(ti.every((t) => t.seen), `10 tabs: all in view at 1280 px (widths ${ti.map((t) => t.w).join(',')})`);
ok(ti.some((t) => t.w < 200), 'tabs shrank to fit');
await app.evaluate(({ BrowserWindow }, list) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', list), files.slice(10));
await until(async () => (await names(w1)).length === 22, 40000, '22 files');
await sleep(800);
ti = await tabInfo(w1);
ok(ti.some((t) => !t.seen), '22 tabs: some scrolled out of view');
ok(await w1.locator('.dtab-list .n').textContent() === '22', 'the list button shows how many are open');
const active = () => w1.evaluate(() => window.__gcc.active()?.name);
ok((await tabInfo(w1))[21].seen, 'the file just opened is in view');
await w1.locator('.dtab-list').click();
ok(await w1.locator('.tablist button').count() === 22, 'the list has every open file');
await w1.locator('.tablist button').nth(2).click();
ok((await active()) === (await names(w1))[2], 'picking one in the list shows it');
ok(!(await w1.locator('.tablist').count()), 'the list closes');
await sleep(700);
ok((await tabInfo(w1))[2].seen, 'its tab is scrolled into view');
await w1.screenshot({ path: join(TMP, 'many-tabs.png') });
// close down to 4 files for the rest
await w1.evaluate(async () => { const ds = window.__gcc.docs().slice(4); for (const d of ds) document.querySelector(`.dtab[data-id="${d.id}"] .x`)?.click(); });
await until(async () => (await names(w1)).length === 4, 20000, 'closed down to 4');
await sleep(500);

// ---------------------------------------------------------------- reorder by dragging
{
  const before = await names(w1);
  const a = await w1.locator('.dtab').nth(0).boundingBox();
  const c = await w1.locator('.dtab').nth(2).boundingBox();
  await w1.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await w1.mouse.down();
  await w1.mouse.move(c.x + c.width * 0.8, c.y + c.height / 2, { steps: 12 });
  await w1.mouse.up();
  await sleep(300);
  const after = await names(w1);
  ok(after[2] === before[0] && after[0] === before[1], `dragged along the strip: ${before.slice(0, 3)} -> ${after.slice(0, 3)}`);
  ok(app.windows().length === 1, 'no new window for a drag along the strip');
}

// ---------------------------------------------------------------- drag out: a window of its own
const wins = () => app.windows().filter((w) => !w.url().startsWith('devtools'));
{
  const first = (await names(w1))[0];
  const t = await w1.locator('.dtab').nth(0).boundingBox();
  await w1.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await w1.mouse.down();
  await w1.mouse.move(t.x + 200, t.y + 260, { steps: 15 });
  ok(await w1.locator('.tab-ghost').count() === 1, 'out of the strip: the file follows the pointer');
  await w1.screenshot({ path: join(TMP, 'drag-out.png') });
  await w1.mouse.up();
  await until(async () => wins().length === 2, 20000, 'second window');
  const w2 = wins().find((w) => w !== w1);
  await until(() => w2.evaluate(() => window.__gcc?.docs().length === 1), 20000, 'file in the new window');
  ok((await names(w2))[0] === first, 'the new window has the file: ' + (await names(w2))[0]);
  ok(await until(async () => !(await names(w1)).includes(first), 10000, 'left window 1').catch(() => false), 'and it left the first window');

  // ---------------------------------------------------------------- unsaved work goes along
  await w1.evaluate(async () => {
    const d = window.__gcc.active();
    await d.create(0, { type: 'Square', rect: [100, 100, 200, 200], color: [1, 0, 0] });
  });
  await sleep(300);
  const dirtyName = await w1.evaluate(() => window.__gcc.active().name);
  ok(await w1.evaluate(() => window.__gcc.active().dirty), 'a file changed in the first window');
  await w1.evaluate(() => window.__gcc.active().writeRecoveryNow());
  // a new window's start doesn't list the first window's unsaved work as left over
  const rec2 = await w2.evaluate(() => window.gcc.recoveryList());
  const key1 = await w1.evaluate(() => window.__gcc.active().id);
  ok(!rec2.some((r) => r.key === key1), 'the other window\'s unsaved work is not offered as left over');
  // move the changed file to window 2: dropped onto its tab strip (screen point)
  const strip2 = await w2.evaluate(() => { const r = document.querySelector('.dtabs').getBoundingClientRect(); return { x: r.left + 200, y: r.top + 10 }; });
  const b2 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((b) => ({ id: b.id, cb: b.getContentBounds() })));
  // window 2 is the one created second
  const second = b2.sort((a, b) => a.id - b.id)[1];
  const target = { x: second.cb.x + strip2.x, y: second.cb.y + strip2.y };
  // bring window 2 to the front (as the user would see it) and drop there
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), second.id);
  await sleep(300);
  const dirtyId = await w1.evaluate(() => window.__gcc.active().id);
  await w1.evaluate(([id, x, y]) => window.__gcc.moveTo(id, x, y), [dirtyId, target.x, target.y]);
  await until(async () => (await names(w2)).length === 2, 20000, 'joined window 2');
  const moved = await w2.evaluate((n) => { const d = window.__gcc.docs().find((x) => x.name === n); return d ? { dirty: d.dirty, path: d.path } : null; }, dirtyName);
  console.log('  moved', dirtyName, JSON.stringify(moved), JSON.stringify(await names(w2)));
  ok(moved && moved.dirty && moved.path && moved.path.endsWith(dirtyName), 'the changed file arrived with its changes (still unsaved, same file to save to)');
  const n2 = await w2.evaluate(async (n) => { const d = window.__gcc.docs().find((x) => x.name === n); return (await d.annots(0)).filter((a) => a.type === 'Square').length; }, dirtyName);
  ok(n2 === 1, 'its new markup is there');
  ok(!(await names(w1)).includes(dirtyName), 'and left window 1 without a save question');

  // ---------------------------------------------------------------- back onto window 1: window 2 closes
  const strip1 = await w1.evaluate(() => { const r = document.querySelector('.dtabs').getBoundingClientRect(); return { x: r.left + 150, y: r.top + 12 }; });
  const first1 = b2.sort((a, b) => a.id - b.id)[0];
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), first1.id);
  await sleep(200);
  for (const id of await w2.evaluate(() => window.__gcc.docs().map((d) => d.id))) {
    await w2.evaluate(([i, x, y]) => window.__gcc.moveTo(i, x, y), [id, first1.cb.x + strip1.x, first1.cb.y + strip1.y]).catch(() => {});
    await sleep(300);
  }
  await until(async () => wins().length === 1, 20000, 'window 2 closed');
  ok((await names(w1)).includes(first) && (await names(w1)).includes(dirtyName), 'both files back in window 1: ' + (await names(w1)).join(', '));
  ok(await w1.evaluate((n) => window.__gcc.docs().find((x) => x.name === n).dirty, dirtyName), 'still unsaved');
}

// ---------------------------------------------------------------- the tab menu
{
  await w1.locator('.dtab').nth(1).click({ button: 'right' });
  ok(await w1.locator('.cmenu button', { hasText: 'Move to a new window' }).count() === 1, 'tab menu: Move to a new window');
  await w1.locator('.cmenu button', { hasText: 'Move to a new window' }).click();
  await until(async () => wins().length === 2, 20000, 'window from the menu');
  ok(true, 'Move to a new window opens one');
}

// a file opened with its password, changed, moved to a window of its own: opens there with its changes
{
  const pwFile = join(TMP, 'locked.pdf');
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let p = 0; p < 2; p++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, d.addObject({ Font: { F1: f } }), `BT /F1 24 Tf 72 700 Td (Locked page ${p + 1}) Tj ET`));
  writeFileSync(pwFile, d.saveToBuffer('encrypt=aes-256,user-password=secret,owner-password=owner1').asUint8Array());
  await app.evaluate(({ BrowserWindow }, list) => BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)[0].webContents.send('app:open', list), [pwFile]);
  await until(() => w1.locator('.modal h2', { hasText: 'Password needed' }).count(), 15000, 'password dialog');
  await w1.locator('.modal input[type=password]').fill('secret');
  await w1.keyboard.press('Enter');
  await until(() => w1.evaluate(() => window.__gcc.active()?.name === 'locked.pdf' && window.__gcc.active().pages.length === 2), 15000, 'locked open');
  await w1.evaluate(() => window.__gcc.active().create(0, { type: 'Square', rect: [100, 100, 200, 200], color: [1, 0, 0] }));
  const id = await w1.evaluate(() => window.__gcc.active().id);
  const before = wins().length;
  await w1.evaluate(([i]) => window.__gcc.moveTo(i, 20000, 20000), [id]);
  await until(async () => wins().length === before + 1, 20000, 'window for the locked file');
  const w3 = wins().find((w) => w !== w1 && !w.isClosed() && w.url()) && wins()[wins().length - 1];
  await until(() => w3.evaluate(() => window.__gcc?.docs().some((x) => x.name === 'locked.pdf')), 20000, 'locked file in its window');
  const st = await w3.evaluate(async () => { const x = window.__gcc.docs().find((k) => k.name === 'locked.pdf'); return { pages: x.pages.length, dirty: x.dirty, squares: (await x.annots(0)).filter((a) => a.type === 'Square').length }; });
  ok(st.pages === 2 && st.dirty && st.squares === 1, 'a password file with changes moves with them: ' + JSON.stringify(st));
  await app.evaluate(({ BrowserWindow }) => { const all = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id); globalThis.__last = all[all.length - 1].id; });
  // (closed without saving for the rest)
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.fromId(globalThis.__last).close());
  await until(async () => wins().length === before, 20000, 'locked window closed');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
}

// closing: one window closes, the app keeps the other; the last one quits
{
  const w2 = wins().find((w) => w !== w1);
  await until(() => w2.evaluate(() => window.__gcc?.docs().length === 1), 20000, 'file in the menu\'s window');
  console.log('  window 2:', JSON.stringify(await w2.evaluate(() => window.__gcc.docs().map((d) => [d.name, d.dirty]))));
  await app.evaluate(({ BrowserWindow }) => { const all = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id); all[all.length - 1].close(); });
  await sleep(3000);
  console.log('  after close:', wins().length, JSON.stringify(await w2.evaluate(() => [window.__gcc.docs().map((d) => [d.name, d.dirty]), [...document.querySelectorAll('.toast')].map((t) => t.textContent)]).catch((e) => String(e))));
  await until(async () => wins().length === 1, 20000, 'second window closed');
  ok(!w2.isClosed() ? false : true, 'the second window closed on its own');
  ok(!!(await w1.evaluate(() => window.__gcc.docs().length)), 'the first carries on');
}

const proc = app.process();
const gone = new Promise((r) => proc.once('exit', () => r(true)));
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(() => {});
const quit = await Promise.race([gone, sleep(20000).then(() => false)]);
ok(quit, 'closing the last window quits');
if (!quit) await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
