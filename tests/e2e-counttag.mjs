// Count by tag (0.8.5): door tags written on a drawing found in its text and counted in one go -
// one name per tag or one name for all, marks already counted left out, one undo step, the
// numbers going on from what a name has. xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-counttag.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-counttag');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
// a "plan": door tags round the sheet (D01 x3, D02 x2, D03 x1 on page 1; D01 x2, FD-01 on page 2),
// words that aren't door tags (DOOR, DRAWING), and D01 drawn twice on itself (fake bold)
{
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const T = (x, y, t) => `BT /F1 10 Tf ${x} ${y} Td (${t}) Tj ET\n`;
  const p1 = T(100, 700, 'D01') + T(300, 700, 'D02') + T(500, 700, 'D01') + T(100, 500, 'DOOR SCHEDULE') + T(300, 500, 'D03') + T(500, 500, 'D02') + T(100, 300, 'D01') + T(100.3, 300.2, 'D01') + T(300, 300, 'DRAWING');
  const p2 = T(100, 700, 'D01') + T(300, 700, 'FD-01') + T(500, 700, 'D01');
  d.insertPage(-1, d.addPage([0, 0, 842, 842], 0, { Font: { F1: f } }, p1));
  d.insertPage(-1, d.addPage([0, 0, 842, 842], 0, { Font: { F1: f } }, p2));
  writeFileSync(join(TMP, 'plan.pdf'), d.saveToBuffer('').asUint8Array());
}
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-counttag'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else { fails++; void win.screenshot({ path: join(TMP, `fail-${fails}.png`) }).catch(() => {}); } return c; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + what); await sleep(150); } };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=counttag', join(TMP, 'plan.pdf')] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await until(() => win.evaluate(() => window.__gcc?.active()?.pages.length === 2), 30000, 'open');
await sleep(800);
const E = (fn, a) => win.evaluate(fn, a);
const counts = async () => (await E(async () => window.__gcc.active().allAnnots())).filter((a) => a.kind === 'measure-count');
await win.locator('.rtab', { hasText: /^Measure$/ }).click();
const openDlg = async () => { await win.locator('.ribbon .rb', { hasText: 'By tag' }).click(); await win.waitForSelector('.counttag', { timeout: 5000 }); };

// this page, starting with "D"
await openDlg();
await win.locator('.counttag input.input').first().fill('D');
await win.locator('.counttag button', { hasText: /^Find$/ }).click();
await until(() => win.locator('.counttag .ct-sum').count(), 8000, 'found');
const sum = await win.locator('.counttag .ct-sum').textContent();
ok(/^6 found/.test(sum), 'page 1: 6 door tags (DOOR, DRAWING not; the bold D01 once): ' + sum);
const names = await win.locator('.counttag .ct-item').allTextContents();
ok(names.length === 3 && /D01\s*3/.test(names[0]) && /D02\s*2/.test(names[1]) && /D03\s*1/.test(names[2]), 'by tag: ' + JSON.stringify(names));
ok(await win.locator('.counttag label', { hasText: 'A count name for each tag' }).locator('input').isChecked(), '3 names for 6 marks (two of each on average): a name for each tag by default');
// one name per tag, D03 left out
await win.locator('.counttag label', { hasText: 'A count name for each tag' }).locator('input').check();
await win.locator('.counttag .ct-item', { hasText: 'D03' }).locator('input').uncheck();
ok(/Count 5/.test(await win.locator('.counttag .btn.primary').textContent()), 'Count 5 (D03 unticked)');
await win.locator('.counttag .btn.primary').click();
let c = await until(async () => { const l = await counts(); return l.length === 5 ? l : null; }, 8000, 'counted');
const g = (n) => c.filter((a) => a.group === n);
ok(g('D01').length === 3 && g('D02').length === 2 && !g('D03').length, 'counted under D01 (3) and D02 (2)');
ok(g('D01').map((a) => a.contents).sort().join() === 'D01 #1,D01 #2,D01 #3', 'numbered within each name');
// each mark on its tag
const onTag = c.every((a) => { const cx = (a.rect[0] + a.rect[2]) / 2, cy = (a.rect[1] + a.rect[3]) / 2; return [[100, 142], [300, 142], [500, 142], [300, 342], [500, 342], [100, 542]].some(([x, y]) => Math.abs(cx - x - 9) < 12 && Math.abs(cy - y + 4) < 10); });
ok(onTag, 'each mark on its tag: ' + JSON.stringify(c.map((a) => [Math.round((a.rect[0] + a.rect[2]) / 2), Math.round((a.rect[1] + a.rect[3]) / 2)])));
ok(/Counted 5 marks under 2 names/.test((await win.locator('.toast').allTextContents()).join(' ')), 'the toast says what was counted');
// one undo step
await win.locator('.viewer').focus();
await win.keyboard.press('Control+z');
await until(async () => (await counts()).length === 0, 8000, 'undo');
ok(true, 'Ctrl+Z takes them all back');
await win.keyboard.press('Control+y');
await until(async () => (await counts()).length === 5, 8000, 'redo');
// all pages: what is counted already is left out; one name; numbers go on
await openDlg();
await win.locator('.counttag input.input').first().fill('D01');
await win.locator('.counttag .seg button', { hasText: 'Exactly' }).click();
await win.locator('.counttag .seg button', { hasText: /^All 2 pages$/ }).click();
await win.locator('.counttag button', { hasText: /^Find$/ }).click();
await until(() => win.locator('.counttag .ct-sum').count(), 8000, 'found all');
const sum2 = await win.locator('.counttag .ct-sum').textContent();
ok(/^2 found, 3 counted already \(left out\)/.test(sum2), 'all pages, exactly D01: the 3 on page 1 counted already, the 2 on page 2 found: ' + sum2);
ok(await win.locator('.counttag .ct-row input.input').last().inputValue() === 'D01', 'counted as "D01"');
await win.locator('.counttag .btn.primary').click();
c = await until(async () => { const l = await counts(); return l.length === 7 ? l : null; }, 8000, 'counted page 2');
ok(g('D01').length === 5 && g('D01').filter((a) => a.page === 1).map((a) => a.contents).sort().join() === 'D01 #4,D01 #5', 'page 2: D01 #4 and #5 (numbers go on)');
ok(await win.locator('.ribbon input[title^="Name of what you are counting"]').inputValue() === 'D01', 'the Count tool now counts D01');
// FD- (a tag ending in a separator), containing
await openDlg();
await win.locator('.counttag input.input').first().fill('FD-');
await win.locator('.counttag .seg button', { hasText: 'Starting with' }).click();
await win.locator('.counttag .seg button', { hasText: /^All 2 pages$/ }).click();
await win.locator('.counttag button', { hasText: /^Find$/ }).click();
await until(() => win.locator('.counttag .ct-sum').count(), 8000, 'fd');
ok(/^1 found/.test(await win.locator('.counttag .ct-sum').textContent()), 'FD- finds FD-01');
await win.locator('.counttag button', { hasText: 'Cancel' }).click();
// nothing found: says so
await openDlg();
await win.locator('.counttag input.input').first().fill('W9');
await win.locator('.counttag button', { hasText: /^Find$/ }).click();
await until(() => win.locator('.counttag .ct-res').count(), 8000, 'none');
ok(/No "W9" found/.test(await win.locator('.counttag .ct-res').textContent()), 'nothing found: said, with the OCR hint');
ok(await win.locator('.counttag .btn.primary').isDisabled(), 'Count is off');
await win.keyboard.press('Escape');
await sleep(200);
ok(await win.locator('.counttag').count() === 0, 'Escape closes it');
// the Totals panel lists them
await win.locator('.ribbon .rb', { hasText: 'Totals' }).click();
await until(() => win.locator('.totals .tt-name', { hasText: 'D01' }).count(), 8000, 'totals');
const n01 = await win.locator('.totals .tt-row', { has: win.locator('.tt-name', { hasText: 'D01' }) }).locator('.tt-n').first().textContent();
ok(n01 === '5', 'Totals: D01 5');
await win.screenshot({ path: join(TMP, 'done.png') });

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} failed, ${passes} passed` : `all passed (${passes})`);
process.exit(fails ? 1 : 0);
