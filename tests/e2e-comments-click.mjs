// Comments list: picking one highlight after another must not freeze the window (25 Nov 2026: the
// second pick started an endless redraw - the text-markup handles were worked out again on every
// render). A made-up file: text lines with three highlights on page 1, more pages after it.
// xvfb-run -a -s "-screen 0 2600x1500x24" node tests/e2e-comments-click.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-comments-click');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const d = new mupdf.PDFDocument();
const f = d.addSimpleFont(new mupdf.Font('Courier'));
for (let p = 0; p < 12; p++) {
  let s = '0 g BT /F1 11 Tf ';
  for (let l = 0; l < 30; l++) s += `1 0 0 1 72 ${780 - l * 22} Tm (${p + 1}.${l} CLAUSE TITLE OF THE TENDER DOCUMENT LINE ${l}) Tj `;
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, s + 'ET'));
}
for (const [pg, lines] of [[0, [2, 5, 9]], [3, [1]], [7, [4, 6]]]) {
  const page = d.loadPage(pg);
  for (const l of lines) {
    const y = 842 - (780 - l * 22); // top-down
    const a = page.createAnnotation('Highlight');
    a.setQuadPoints([[72, y - 11, 360, y - 11, 72, y + 3, 360, y + 3]]);
    a.setColor([0.77, 0.98, 0.45]); a.setAuthor('Tester'); a.update();
  }
}
const FILE = join(TMP, 'clauses.pdf');
writeFileSync(FILE, d.saveToBuffer('').asUint8Array());
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-cmclick'), { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; return c; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=cmclick', FILE] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await win.setViewportSize({ width: 2560, height: 1360 }).catch(() => {});
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 12, null, { timeout: 60000 });
await sleep(1200);
// (the Greenline build asks about the user count at first start: answer it so nothing is sent)
const off = win.locator('.modal button', { hasText: 'Turn it off' });
if (await off.count()) { await off.first().click(); await sleep(300); }
await win.evaluate(() => window.__gcc.viewer().fit('width'));
await sleep(600);
await win.locator('[title^="Comments"]').first().click();
await win.waitForSelector('.cm-item', { timeout: 15000 });
const n = await win.locator('.cm-item').count();
ok(n === 6, `the Comments list shows the 6 highlights (${n})`);
const ping = async () => { const t = Date.now(); await Promise.race([win.evaluate(() => 1), sleep(8000).then(() => { throw new Error('no answer'); })]); return Date.now() - t; };
let hung = -1;
for (let k = 0; k < n && hung < 0; k++) {
  for (const i of [k, (k + 1) % n]) {
    await win.locator('.cm-item').nth(i).click({ timeout: 5000 }).catch(() => {});
    try { await ping(); } catch { hung = i; break; }
    await sleep(300);
  }
}
ok(hung < 0, hung < 0 ? 'every pick in the list answers at once (no freeze)' : `the window froze after picking item ${hung}`);
if (hung < 0) {
  const sel = await win.evaluate(() => document.querySelectorAll('.cm-item.on').length);
  ok(sel === 1, 'the last pick is the one selected');
}
await app.close().catch(() => {});
rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
