// The ribbon's Style group changes the selected markups (0.6.1): a rectangle's colour and line,
// an arrow's ends, several at once, with the side panel closed; the tool's own style stays as it
// was; one undo step each. xvfb-run -a node tests/e2e-style.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';

const TMP = resolve('tests/tmp-style');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const F = join(TMP, 'a.pdf');
copyFileSync('tests/data/long-spec.pdf', F);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-style'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const until = async (fn, ms = 10000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(120); } };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=style'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1600, 950); });
await until(() => win.evaluate(() => !!window.__gcc), 20000, 'app');
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
await until(() => win.evaluate(() => window.__gcc.active()?.pages.length > 0), 20000, 'open');
await sleep(800);
const E = (fn, a) => win.evaluate(fn, a);
const annots = () => E(async () => window.__gcc.active().annots(0));
const grp = win.locator('.ribbon .stylegrp');
const box = await win.locator('.pg[data-page="0"]').boundingBox();
const drag = async (x0, y0, x1, y1) => { await win.mouse.move(box.x + x0, box.y + y0); await win.mouse.down(); await win.mouse.move(box.x + x1, box.y + y1, { steps: 6 }); await win.mouse.up(); await sleep(700); };

await win.locator('.rtab', { hasText: 'Comment' }).click();
// 1. a rectangle: drawn, selected - the group names it and shows its own values
await win.locator('.ribbon [data-tool="rect"]').first().click();
const toolWidth = await grp.locator('select').first().inputValue();
await drag(100, 150, 300, 260);
let rect = await until(async () => (await annots()).find((a) => a.type === 'Square'), 5000, 'rect');
ok(await grp.locator('.rlabel', { hasText: 'Selected – Rectangle' }).count() === 1, 'the Style group now edits the selected rectangle');

// 2. its line width and colour from the ribbon
await grp.locator('select').first().selectOption('4');
await until(async () => (await annots()).find((a) => a.id === rect.id && a.bw === 4), 5000, 'width 4');
ok(true, 'Width 4 pt: the rectangle changed');
await grp.locator('.cbtn').first().click();
await grp.locator('.cpop .sw').nth(4).click();
const changed = await until(async () => { const a = (await annots()).find((x) => x.id === rect.id); return a && a.color && a.color.join() !== rect.color.join() ? a : null; }, 5000, 'colour');
ok(!!changed, 'Colour from the ribbon: the rectangle changed (' + changed.color.map((v) => v.toFixed(2)).join(' ') + ')');
await grp.locator('input[type=checkbox]').first().click();
await until(async () => (await annots()).find((a) => a.id === rect.id && a.dash), 5000, 'dashed');
ok(true, 'Dashed from the ribbon');
// one undo step each
await win.keyboard.press('Control+z');
await until(async () => (await annots()).find((a) => a.id === rect.id && !a.dash), 5000, 'undo');
ok((await annots()).find((a) => a.id === rect.id).bw === 4, 'Undo takes back only the last change');

// 3. the tool's own style is untouched
await win.keyboard.press('Escape');
await sleep(300);
await win.locator('.ribbon [data-tool="rect"]').first().click();
await sleep(200);
ok(await grp.locator('select').first().inputValue() === toolWidth && await grp.locator('.rlabel', { hasText: 'Style – Rectangle' }).count() === 1, 'the rectangle tool keeps its own style (' + toolWidth + ' pt) for the next one');

// 4. an arrow with the side panel closed: its ends from the ribbon
const panelX = win.locator('.props .side-head .x');
if (await panelX.count()) await panelX.first().click();
await sleep(200);
ok(await win.locator('.props').count() === 0, 'side panel closed');
await win.locator('.ribbon [data-tool="arrow"]').first().click();
await drag(120, 400, 380, 420);
const arrow = await until(async () => (await annots()).find((a) => a.type === 'Line'), 5000, 'arrow');
ok(await grp.locator('.rlabel', { hasText: /^Selected – / }).count() === 1, 'the arrow selected: the group edits it');
const ends = grp.locator('select').filter({ has: win.locator('option[value="Slash|Slash"]') });
await ends.selectOption('ClosedArrow|ClosedArrow');
await until(async () => (await annots()).find((a) => a.id === arrow.id && a.le?.[0] === 'ClosedArrow' && a.le?.[1] === 'ClosedArrow'), 5000, 'ends');
ok(true, 'Ends from the ribbon: arrow heads at both ends');

// 5. several at once
await win.keyboard.press('Escape');
await sleep(200);
// (the rectangle's edge - inside an unfilled one is the page; its corner may have snapped)
const pickRect = async () => {
  for (const [x, y] of [[102, 205], [100, 205], [104, 205], [200, 152], [298, 205]]) {
    await win.mouse.click(box.x + x, box.y + y);
    await sleep(300);
    if (/Rectangle/.test(await grp.locator('.rlabel').textContent())) return [x, y];
  }
  return null;
};
ok(!!(await pickRect()), 'the rectangle picked');
await win.keyboard.down('Shift');
await win.mouse.click(box.x + 250, box.y + 410);
await win.keyboard.up('Shift');
await sleep(500);
ok(await grp.locator('.rlabel', { hasText: '2 markups' }).count() === 1, 'two selected: "2 markups"');
await grp.locator('select').first().selectOption('2');
await until(async () => { const l = await annots(); return l.find((a) => a.id === rect.id).bw === 2 && l.find((a) => a.id === arrow.id).bw === 2; }, 5000, 'both');
ok(true, 'Width for both at once');

// 6. a locked one: nothing changes, the group says so by being unavailable
await E(async (r) => { const d = window.__gcc.active(); await d.update([{ page: 0, id: r, patch: { locked: true } }], 'Lock'); }, rect.id);
await win.keyboard.press('Escape');
await sleep(200);
await pickRect();
ok(await grp.evaluate((el) => el.disabled), 'locked: the group is unavailable');

// 7. nothing selected with the select tool: nothing to change
await win.keyboard.press('Escape');
await sleep(300);
await win.mouse.click(box.x + 600, box.y + 700); // (an empty spot)
await sleep(400);
const lab = await grp.locator('.rlabel').textContent();
ok(lab === 'Style' && await grp.evaluate((el) => el.disabled), 'no selection: the group rests (' + lab + ')');

// 8. two text boxes, different fonts: a text colour from the ribbon changes only the colour
const box2 = await win.locator('.pg[data-page="0"]').boundingBox(); // (the page is wider with the side panel closed)
const k = box2.width / (await E(() => window.__gcc.active().pages[0].w));
const [t1, t2] = await E(async () => {
  const d = window.__gcc.active();
  const a = await d.create(0, { type: 'FreeText', rect: [480, 120, 600, 150], contents: 'Small', font: { size: 11, color: [0, 0, 0] }, bw: 1, color: null, kind: 'textbox' });
  const b = await d.create(0, { type: 'FreeText', rect: [480, 170, 640, 210], contents: 'Big bold', font: { size: 18, color: [0, 0, 0], bold: true }, bw: 1, color: null, kind: 'textbox' });
  return [a.id, b.id];
});
await sleep(600);
await win.keyboard.press('Escape');
await win.mouse.click(box2.x + 540 * k, box2.y + 135 * k);
await sleep(300);
await win.keyboard.down('Shift');
await win.mouse.click(box2.x + 560 * k, box2.y + 190 * k);
await win.keyboard.up('Shift');
await sleep(500);
ok(/2 markups/.test(await grp.locator('.rlabel').textContent()), 'two text boxes selected');
await grp.locator('.cbtn').nth(1).click(); // (Box, then Text)
await grp.locator('.cpop .sw').nth(4).click();
const tx = await until(async () => { const l = await annots(); const a = l.find((x) => x.id === t1), b = l.find((x) => x.id === t2); return a.font.color.join() !== '0,0,0' && b.font.color.join() !== '0,0,0' ? [a, b] : null; }, 5000, 'text colour');
ok(tx[0].font.size === 11 && tx[1].font.size === 18 && tx[1].font.bold && !tx[0].font.bold, `each keeps its own size and bold: ${JSON.stringify(tx[0].font)} / ${JSON.stringify(tx[1].font)}`);

await app.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
