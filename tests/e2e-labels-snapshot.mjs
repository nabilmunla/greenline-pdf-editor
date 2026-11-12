// Number size slider (Measure > Labels) and the marked snapshot area (0.9.9): nothing selected ->
// every measurement number in the file; measurements selected -> only those, from their own size
// (one undo); the Snapshot tool's area stays marked - right-click it: Print this area (the print
// dialog on "The marked area"), Esc unmarks it.
//   xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-labels-snapshot.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-labels-snapshot');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'sheet.pdf');
{
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 842, 595], 0, {}, '0 G 1 w 100 395 m 700 395 l S 500 100 m 800 400 l S'));
  writeFileSync(F, d.saveToBuffer('').asUint8Array());
}
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-labsnap'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; return c; };
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(100); } return null; };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=labsnap', F] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 1, null, { timeout: 60000 });
const E = (fn, a) => win.evaluate(fn, a);
await E(() => window.__gcc.viewer().setZoom(1));
await sleep(800);
const at = async (x, y) => { const box = await win.locator('.pg[data-page="0"]').boundingBox(); const k = box.width / 842; return [box.x + x * k, box.y + y * k]; };
const move = async (x, y) => { const p = await at(x, y); await win.mouse.move(p[0], p[1], { steps: 4 }); await sleep(200); };
const click = async (x, y) => { const p = await at(x, y); await win.mouse.click(p[0], p[1]); await sleep(150); };
const tab = (name) => win.locator('.rtab', { hasText: new RegExp('^' + name + '$') }).click();
const tool = async (id) => { await win.locator(`.ribbon [data-tool="${id}"]`).first().click(); await sleep(250); };
const lengths = () => E(async () => (await window.__gcc.active().annots(0)).filter((a) => a.kind === 'measure-length').sort((a, b) => a.id - b.id).map((a) => ({ id: a.id, size: a.labelSize })));
/** move the Number size slider to v and let go */
const slide = async (v) => {
  await E((val) => {
    const el = document.querySelector('.ribbon .lsz input[type=range]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(val));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  await sleep(100);
  await E(() => document.querySelector('.ribbon .lsz input[type=range]').dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
  await sleep(900);
};
const near = (a, b) => Math.abs(a - b) < 0.02 * Math.max(1, Math.abs(b));

try {
  await win.locator('.statusbar button', { hasText: 'Scale' }).click();
  await win.locator('.modal .chip', { hasText: /^1:100$/ }).first().click();
  await until(() => win.locator('.statusbar button', { hasText: '1:100' }).count());
  await tab('Measure');
  await tool('m-length');
  for (const [a, b] of [[[150, 300], [400, 300]], [[150, 450], [400, 450]]]) { await move(...a); await click(...a); await move(...b); await click(...b); await sleep(300); }
  await win.keyboard.press('Escape');
  const L0 = await until(async () => { const l = await lengths(); return l.length === 2 ? l : null; });
  ok(!!L0, 'two lengths measured: sizes ' + JSON.stringify(L0));

  // ----- nothing selected: all of them
  await tab('Home');
  await tool('select');
  await tab('Measure');
  await sleep(300);
  ok(/all/.test(await win.locator('.ribbon .lsz .rlab').textContent()), 'nothing selected: the slider says "all"');
  await slide(2);
  const L1 = await lengths();
  ok(L0 && L1.every((x, i) => near(x.size, L0[i].size * 2)), 'slider to 200%: every number twice as big ' + JSON.stringify(L1));
  ok((await win.locator('.ribbon .lsz .lsz-v').textContent()).trim() === '200%', 'the slider shows 200%');

  // ----- one selected: only that one, from its own size
  await click(275, 300);
  await sleep(400);
  const lab = await win.locator('.ribbon .lsz .rlab').textContent();
  ok(/1 selected/.test(lab), 'one length selected: the slider says so (' + lab + ')');
  ok((await win.locator('.ribbon .lsz .lsz-v').textContent()).trim() === '100%', 'and starts at 100% (as it is)');
  await slide(0.5);
  const L2 = await lengths();
  ok(near(L2[0].size, L1[0].size * 0.5) && near(L2[1].size, L1[1].size), 'slider to 50%: the selected one half as big, the other unchanged ' + JSON.stringify(L2));
  ok((await win.locator('.ribbon .lsz .lsz-v').textContent()).trim() === '100%', 'back to 100% for the next change');
  await slide(1.5);
  const L3 = await lengths();
  ok(near(L3[0].size, L2[0].size * 1.5), 'a second change at once scales from the new size ' + JSON.stringify(L3));
  await win.keyboard.press('Control+z');
  await sleep(700);
  const L4 = await lengths();
  ok(near(L4[0].size, L2[0].size) && near(L4[1].size, L1[1].size), 'Ctrl+Z takes back one change ' + JSON.stringify(L4));

  // ----- snapshot: the area stays marked; right-click -> Print this area
  await win.keyboard.press('Escape');
  await tab('Home');
  await tool('snapshot');
  const a = await at(120, 150), b = await at(450, 380);
  await win.mouse.move(a[0], a[1]); await win.mouse.down(); await win.mouse.move(b[0], b[1], { steps: 8 }); await win.mouse.up();
  ok(!!(await until(() => win.locator('.ov .marked').count())), 'the snapshot area stays marked');
  ok(!!(await until(() => win.locator('.toast', { hasText: 'right-click it to print' }).count())), 'the toast says how to print it');
  const m = await at(300, 250);
  await win.mouse.click(m[0], m[1], { button: 'right' });
  await sleep(400);
  const items = await win.locator('.cmenu button').allTextContents();
  ok(items.some((t) => /Print this area/.test(t)) && items.some((t) => /Save as picture/.test(t)) && items.some((t) => /Copy as picture/.test(t)), 'right-click inside: Print this area / Copy / Save as picture ' + JSON.stringify(items.slice(0, 5)));
  await win.locator('.cmenu button', { hasText: 'Print this area' }).click();
  await sleep(800);
  const on = await win.locator('.modal .seg button.on, .modal .seg .on, .modal [aria-pressed="true"]').allTextContents().catch(() => []);
  ok(on.some((t) => /marked area/.test(t)), 'the print dialog opens on "The marked area" ' + JSON.stringify(on));
  await win.keyboard.press('Escape');
  await sleep(400);
  const o = await at(700, 520);
  await win.mouse.click(o[0], o[1], { button: 'right' });
  await sleep(300);
  ok(!(await win.locator('.cmenu button', { hasText: 'Print this area' }).count()), 'right-click outside the area: not offered');
  await win.keyboard.press('Escape');
  await sleep(200);
  await win.keyboard.press('Escape');
  await sleep(300);
  ok(!(await win.locator('.ov .marked').count()), 'Esc unmarks it');
  // a click inside keeps it, a click outside unmarks it (as a selection)
  // (Esc once more: back to Select - clicking the Snapshot button while it's on turns it off)
  await win.keyboard.press('Escape');
  await sleep(200);
  await tool('snapshot');
  await win.mouse.move(a[0], a[1]); await win.mouse.down(); await win.mouse.move(b[0], b[1], { steps: 8 }); await win.mouse.up();
  ok(!!(await until(() => win.locator('.ov .marked').count())), 'marked again');
  await win.mouse.click(m[0], m[1]);
  await sleep(300);
  ok((await win.locator('.ov .marked').count()) === 1, 'a click inside the area keeps it');
  await win.mouse.click(o[0], o[1]);
  await sleep(300);
  ok(!(await win.locator('.ov .marked').count()), 'a click outside the area unmarks it');
} catch (e) {
  ok(false, 'error: ' + (e?.message || e));
} finally {
  console.log(`\n${passes} passed, ${fails} failed`);
  // (changes not saved: closing asks - nobody here to answer)
  const closed = await Promise.race([app.close().then(() => true, () => true), sleep(5000).then(() => false)]);
  if (!closed) app.process().kill('SIGKILL');
  process.exit(fails ? 1 : 0);
}
