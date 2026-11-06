// Bookmarks you can edit: add for the page in view, rename (F2 / double-click), delete, move by
// keys and by dragging, point at the page in view; each one Ctrl+Z; saved into the PDF with the
// others' colour / bold kept.   xvfb-run -a node tests/e2e-bookmarks.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-bookmarks');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const file = join(TMP, 'Drawings.pdf');
{
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < 6; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, `BT /F1 40 Tf 100 400 Td (SHEET ${i + 1}) Tj ET`));
  const it = d.outlineIterator();
  it.insert({ title: 'Architecture', uri: '#page=1', open: true });
  it.prev(); it.down();
  it.insert({ title: 'A-101', uri: '#page=2', open: false });
  it.insert({ title: 'A-102', uri: '#page=3', open: false });
  it.up(); it.next();
  it.insert({ title: 'Structure', uri: '#page=4', open: false });
  const s = d.getTrailer().get('Root').get('Outlines').get('First').get('Next');
  s.put('C', [1, 0, 0]); s.put('F', 2);
  writeFileSync(file, d.saveToBuffer('').asUint8Array());
}
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-bookmarks'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=bookmarks', file] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
const E = (fn, a) => win.evaluate(fn, a);
/** what the engine holds: [title, page, children?] */
const tree = () => E(async () => { const conv = (l) => l.map((m) => (m.children.length ? [m.title, m.page, conv(m.children)] : [m.title, m.page])); return conv(await window.__gcc.engines.mu('outlineFull', window.__gcc.active().id)); });
const shown = () => win.locator('.bm-list .bmt').allTextContents();
const row = (title) => win.locator('.bm-list .bm', { has: win.locator('.bmt', { hasText: new RegExp('^' + title.replace(/[()]/g, '\\$&') + '$') }) });
const J = (x) => JSON.stringify(x);

try {
  await until(() => E(() => window.__gcc?.active()?.pages.length === 6), 30000, 'file');
  await win.locator('.rail-btn[title="Bookmarks"]').click();
  await until(async () => (await shown()).length === 4, 10000, 'bookmarks shown');
  ok(J(await shown()) === J(['Architecture', 'A-101', 'A-102', 'Structure']), 'read: ' + J(await shown()));
  ok(await row('Structure').locator('.bmt').evaluate((e) => getComputedStyle(e).color === 'rgb(255, 0, 0)' && Number(getComputedStyle(e).fontWeight) >= 700), 'its colour and bold shown');

  // 1. add for the page in view (page 5), after the one chosen
  await E(() => window.__gcc.viewer().goTo(4));
  await sleep(600);
  await row('Structure').locator('.bmt').click();
  await E(() => window.__gcc.viewer().goTo(4));
  await sleep(500);
  await win.locator('.bm-tools button', { hasText: 'Add' }).click();
  const ed = win.locator('.bm-list input.bmedit');
  await ed.waitFor({ timeout: 5000 });
  { const v = await ed.inputValue(); ok(v === 'Page 5', 'a new one for page 5, its name ready to type over: ' + v); }
  await ed.fill('S-201 Foundations');
  await ed.press('Enter');
  await until(async () => J(await tree()) === J([['Architecture', 0, [['A-101', 1], ['A-102', 2]]], ['Structure', 3], ['S-201 Foundations', 4]]), 10000, 'added + named');
  ok(true, 'added after Structure and named (two steps)');
  ok(await E(() => window.__gcc.active().dirty), 'the file counts as changed');

  // 2. rename by double-click; Escape leaves it
  await row('A-102').locator('.bmt').dblclick();
  await ed.fill('nothing');
  await ed.press('Escape');
  await sleep(300);
  ok((await shown()).includes('A-102'), 'Escape: name left as it was');
  await row('A-102').locator('.bmt').click();
  await win.locator('.bm-list').press('F2');
  await ed.fill('A-102 First floor (rev C)');
  await ed.press('Enter');
  await until(async () => (await shown()).includes('A-102 First floor (rev C)'), 5000, 'renamed');
  ok(true, 'F2: renamed');

  // 3. move by keys: Alt+Up, Alt+Left (out of Architecture), Alt+Right (back in)
  await win.locator('.bm-list').press('Alt+ArrowUp');
  await until(async () => J((await tree())[0][2].map((x) => x[0])) === J(['A-102 First floor (rev C)', 'A-101']), 5000, 'moved up');
  ok(true, 'Alt+Up: moved above A-101');
  await win.locator('.bm-list').press('Alt+ArrowLeft');
  await until(async () => J((await tree()).map((x) => x[0])) === J(['Architecture', 'A-102 First floor (rev C)', 'Structure', 'S-201 Foundations']), 5000, 'moved out');
  ok(true, 'Alt+Left: out to the top level, after Architecture');
  await win.locator('.bm-list').press('Alt+ArrowRight');
  await until(async () => J((await tree())[0][2].map((x) => x[0])) === J(['A-101', 'A-102 First floor (rev C)']), 5000, 'moved in');
  ok(true, 'Alt+Right: back under Architecture, last');

  // 4. drag S-201 onto Structure (into it)
  const src = row('S-201 Foundations'), dst = row('Structure');
  const b = await dst.boundingBox();
  await src.dragTo(dst, { targetPosition: { x: 40, y: b.height / 2 } });
  await until(async () => J((await tree())[1]) === J(['Structure', 3, [['S-201 Foundations', 4]]]), 5000, 'dragged in');
  ok(true, 'dragged onto Structure: now under it');

  // 5. point a bookmark at the page in view; delete one with children (asks)
  await E(() => window.__gcc.viewer().goTo(5));
  await sleep(500);
  await row('A-101').locator('.bmt').click({ button: 'right' });
  await win.locator('.cmenu button', { hasText: 'Point it at page 6' }).click();
  await until(async () => J((await tree())[0][2][0]) === J(['A-101', 5]), 5000, 'repointed');
  ok(true, 'A-101 now goes to page 6');
  await row('Structure').locator('.bmt').click();
  await win.locator('.bm-list').press('Delete');
  await until(async () => (await tree()).length === 1, 5000, 'deleted');
  ok(J(await tree()) === J([['Architecture', 0, [['A-101', 5], ['A-102 First floor (rev C)', 2]]]]), 'Structure and the one under it deleted (after asking)');

  // 6. undo, step by step: the delete, the repoint
  await win.locator('.viewer').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await win.keyboard.press('Control+z');
  await until(async () => (await tree()).length === 2, 5000, 'undo delete');
  // (the panel reads them a moment after the engine has them back: waited for, as a person sees it)
  ok(!!(await until(async () => (await shown()).includes('Structure'), 3000, 'panel').catch(() => false)), 'Ctrl+Z: the deleted ones are back, in the panel too');
  await win.keyboard.press('Control+z');
  await until(async () => J((await tree())[0][2][0]) === J(['A-101', 1]), 5000, 'undo repoint');
  ok(true, 'Ctrl+Z again: A-101 back to page 2');
  await win.keyboard.press('Control+y');
  await until(async () => J((await tree())[0][2][0]) === J(['A-101', 5]), 5000, 'redo');

  // 7. clicking a bookmark goes to its page
  await row('A-102 First floor (rev C)').locator('.bmt').click();
  await until(() => E(() => window.__gcc.viewer().page() === 2), 5000, 'goes to page 3');
  ok(true, 'a click goes to its page');

  // 8. saved: the PDF has them, Structure still red and bold
  await win.keyboard.press('Control+s');
  await until(() => E(() => !window.__gcc.active().dirty), 20000, 'saved');
  const d = mupdf.Document.openDocument(readFileSync(file), 'application/pdf');
  const conv = (l) => l.map((x) => [x.title, x.page, ...(x.down ? [conv(x.down)] : [])]);
  ok(J(conv(d.loadOutline())) === J([['Architecture', 0, [['A-101', 5], ['A-102 First floor (rev C)', 2]]], ['Structure', 3, [['S-201 Foundations', 4]]]]), 'saved in the PDF: ' + J(conv(d.loadOutline())));
  const s2 = d.getTrailer().get('Root').get('Outlines').get('First').get('Next');
  ok(J([s2.get('C').get(0).asNumber(), s2.get('F').asNumber()]) === J([1, 2]), 'Structure still red and bold in the file');
} catch (e) { ok(false, e.message); await win.screenshot({ path: join(TMP, 'fail.png') }).catch(() => {}); }
await win.screenshot({ path: join(TMP, 'end.png') }).catch(() => {});
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
