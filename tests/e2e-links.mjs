// Links: a click on a web link always asks first (the real address and site shown); only web /
// e-mail links open. The Link tool makes links (web, e-mail, page of this file), changes and
// deletes them; Ctrl+Z; saved.   xvfb-run -a node tests/e2e-links.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-links');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const file = join(TMP, 'Tender.pdf');
{
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < 3; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, `BT /F1 20 Tf 100 700 Td (PAGE ${i + 1}  portal) Tj ET`));
  const p = d.loadPage(0);
  p.createLink([100, 100, 300, 130], 'https://example.com/tender');
  p.createLink([100, 500, 300, 530], 'file:///C:/Windows/System32/calc.exe');
  writeFileSync(file, d.saveToBuffer('').asUint8Array());
}
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-links'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=links', file] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await app.evaluate(({ dialog, shell }) => {
  globalThis.__q = { boxes: [], answer: [], opened: [] };
  dialog.showMessageBox = async (_w, o) => { const x = o || _w; globalThis.__q.boxes.push({ message: x.message, detail: x.detail, buttons: x.buttons }); return { response: globalThis.__q.answer.shift() ?? 1, checkboxChecked: false }; };
  shell.openExternal = async (u) => { globalThis.__q.opened.push(u); };
  globalThis.__shown = [];
  shell.showItemInFolder = (p) => { globalThis.__shown.push(p); };
});
const Q = () => app.evaluate(() => globalThis.__q);
const E = (fn, a) => win.evaluate(fn, a);
const links0 = () => E(async () => (await window.__gcc.engines.mu('linksOf', window.__gcc.active().id, 0)).map((l) => [l.uri?.startsWith('#') ? 'page' : l.uri, l.page]));
const at = async (n, x, y) => {
  const box = await win.locator(`.pg[data-page="${n}"]`).boundingBox();
  const w = await E((n) => window.__gcc.active().pages[n].w, n);
  const k = box.width / w;
  return [box.x + x * k, box.y + y * k];
};
const click = async (n, x, y) => { const p = await at(n, x, y); await win.mouse.click(p[0], p[1]); };
const drag = async (n, a, b) => { const p = await at(n, ...a), q = await at(n, ...b); await win.mouse.move(p[0], p[1]); await win.mouse.down(); await win.mouse.move(q[0], q[1], { steps: 6 }); await win.mouse.up(); };
const dlg = () => win.locator('.modal', { hasText: /New link|Change link/ });
const idle = () => until(async () => !(await win.locator('.scrim').count()), 15000, 'not busy');
const fitPage = async () => { await win.locator('.rtab', { hasText: 'Home' }).click(); await win.locator('.ribbon .rb', { hasText: /^Fit page$/ }).click(); await sleep(700); };
const linkTool = async () => { await win.locator('.rtab', { hasText: 'Edit' }).click(); await win.locator('.ribbon .rb', { hasText: /^Link$/ }).click(); };
const selectTool = async () => { await win.locator('.rtab', { hasText: 'Home' }).click(); await win.locator('.ribbon .rb', { hasText: /^Select$/ }).click(); };

try {
  await until(() => E(() => window.__gcc?.active()?.pages.length === 3), 30000, 'file');
  await fitPage();
  await sleep(800);
  // 1. a web link asks first, with the real address and site; Cancel opens nothing
  await click(0, 200, 115);
  await until(async () => (await Q()).boxes.length === 1, 5000, 'asked');
  const b = (await Q()).boxes[0];
  ok(/It goes to example\.com/.test(b.message) && b.detail.includes('https://example.com/tender') && /Links in a PDF can lead anywhere/.test(b.detail), 'asked first: "' + b.message + '"');
  ok((await Q()).opened.length === 0, 'Cancel: nothing opened');
  // … and Open opens it
  await app.evaluate(() => globalThis.__q.answer.push(0));
  await click(0, 200, 115);
  await until(async () => (await Q()).opened.length === 1, 5000, 'opened');
  ok((await Q()).opened[0] === 'https://example.com/tender', 'Open: the browser gets the address');
  // 2. a link to a program is never opened (not even asked)
  await click(0, 200, 515);
  await sleep(500);
  ok((await Q()).boxes.length === 2 && (await Q()).opened.length === 1, 'a file:/// link: not opened, not offered');
  ok(await win.locator('.toast', { hasText: 'This link was not opened' }).count() > 0, 'and it says why: ' + JSON.stringify(await E(async () => (await window.__gcc.active().links(0)).map((l) => [l.url, l.page]))) + ' toasts: ' + (await win.locator('.toast').allTextContents()).join(' | '));

  // 3. the Link tool shows the links, makes a link to page 3
  await linkTool();
  await until(() => win.locator('.pg[data-page="0"] .linkbox').count(), 5000, 'boxes');
  ok(await win.locator('.pg[data-page="0"] .linkbox').count() === 2, 'the Link tool shows the page\'s links (the one to a program too)');
  await drag(0, [100, 300], [300, 330]);
  await dlg().waitFor({ timeout: 5000 });
  await dlg().locator('.seg button', { hasText: 'Page in this file' }).click();
  await dlg().locator('input.input').fill('3');
  ok(/Goes to page 3/.test(await dlg().locator('.hint').textContent()), 'says where it goes');
  await dlg().locator('.btn.primary', { hasText: 'Make link' }).click();
  await until(async () => (await links0()).length === 3, 10000, 'made');
  await idle();
  ok(JSON.stringify((await links0())[2]) === JSON.stringify(['page', 2]), 'a link to page 3 made');
  // 4. what can't be a link target is refused; an e-mail address becomes mailto
  await drag(0, [100, 600], [300, 630]);
  await dlg().waitFor({ timeout: 5000 });
  await dlg().locator('input.input').fill('file:///C:/x.exe');
  ok(await dlg().locator('.btn.primary').isDisabled() && /not to programs or files/.test(await dlg().locator('.hint').textContent()), 'file:/// refused');
  await dlg().locator('input.input').fill('tenders@company.com');
  ok(/Goes to mailto:tenders@company\.com/.test(await dlg().locator('.hint').textContent()), 'an e-mail address: mailto');
  await dlg().locator('input.input').fill('www.company.com/docs');
  ok(/Goes to https:\/\/www\.company\.com\/docs/.test(await dlg().locator('.hint').textContent()), 'www.…: https:// added');
  await dlg().locator('.btn.primary').click();
  await until(async () => (await links0()).length === 4, 10000, 'made 2');
  await idle();
  // 5. click a link with the tool: change it, then delete it; Ctrl+Z
  await click(0, 200, 115);
  await dlg().waitFor({ timeout: 5000 });
  ok(/Change link/.test(await dlg().locator('h2').textContent()) && (await dlg().locator('input.input').inputValue()) === 'https://example.com/tender', 'a click on a link with the tool: Change link, its address shown');
  await dlg().locator('input.input').fill('https://portal.example.org/t/123');
  await dlg().locator('.btn.primary', { hasText: 'Save' }).click();
  await until(async () => (await links0())[0][0] === 'https://portal.example.org/t/123', 10000, 'changed');
  await idle();
  ok(true, 'changed');
  await click(0, 200, 615);
  await dlg().waitFor({ timeout: 5000 });
  await dlg().locator('button', { hasText: 'Delete link' }).click();
  await until(async () => (await links0()).length === 3, 10000, 'deleted');
  ok(!(await links0()).some((l) => /company\.com/.test(l[0] || '')), 'deleted');
  await until(async () => !(await win.locator('.scrim').count()), 10000, 'not busy');
  await win.keyboard.press('Control+z');
  await until(async () => (await links0()).length === 4, 10000, 'undo');
  ok(true, 'Ctrl+Z: back');
  await win.keyboard.press('Control+y');
  await until(async () => (await links0()).length === 3, 10000, 'redo');
  await idle();
  // 6. the new page link works with the Select tool (no question for a page of the file)
  await selectTool();
  const asked = (await Q()).boxes.length;
  await click(0, 200, 315);
  await until(() => E(() => window.__gcc.viewer().page() === 2), 5000, 'went to page 3');
  ok((await Q()).boxes.length === asked, 'a link to a page of the file: followed, nothing asked');
  // 7. saved
  await win.keyboard.press('Control+s');
  await until(() => E(() => !window.__gcc.active().dirty), 20000, 'saved');
  const d = mupdf.Document.openDocument(readFileSync(file), 'application/pdf');
  const got = d.loadPage(0).getLinks().map((l) => l.getURI().replace(/^#page=3.*/, '#page=3').replace(/^file:.*/, 'file'));
  ok(JSON.stringify(got) === JSON.stringify(['https://portal.example.org/t/123', 'file', '#page=3']), 'saved: ' + JSON.stringify(got));
  // 8. a place on a network share is shown only when the person chose it - or opened it before
  // (Recent files): a share path the window made up would make Windows sign in to that server
  const share = '//fileserver/tenders/Bid 12/Drawings.pdf';
  await E((r) => window.gcc.setSettings({ recent: [r] }), share);
  const shownRecent = await E((r) => window.gcc.showInFolder(r), share);
  const shownOther = await E(() => window.gcc.showInFolder('//attacker/x/y.pdf'));
  const shown = await app.evaluate(() => globalThis.__shown);
  ok(shownRecent === true && shownOther === false && shown.length === 1 && shown[0] === share, 'share: a file from Recent files is shown, a made-up share place is not: ' + JSON.stringify(shown));
} catch (e) { ok(false, e.message); await win.screenshot({ path: join(TMP, 'fail.png') }).catch(() => {}); }
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : 'all passed');
process.exit(fails ? 1 : 0);
