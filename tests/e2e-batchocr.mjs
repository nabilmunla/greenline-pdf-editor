// Batch > Make files searchable: two scan files, several pages each, read side by side.
// xvfb-run -a node tests/e2e-batchocr.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';

const TMP = resolve('tests/tmp-bocr');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const files = ['ocr-bench12', 'scan'].map((n) => { const f = join(TMP, n + '.pdf'); copyFileSync(`tests/data/${n}.pdf`, f); return f; });
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=bocr'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await app.evaluate(({ dialog }, fs) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: fs }); }, files);
await win.evaluate(() => localStorage.setItem('ocr-engines', '2'));
await win.locator('.rtab', { hasText: 'Batch' }).click();
await win.locator('.ribbon .rb', { hasText: /searchable/i }).click();
await win.locator('.modal button', { hasText: 'Add files' }).click();
await win.locator('.modal select').first().selectOption('eng');
const t = Date.now();
await win.locator('.modal button', { hasText: 'Start' }).click();
await win.waitForFunction(() => [...document.querySelectorAll('.modal .res')].filter((e) => /done|nothing|failed/.test(e.textContent)).length === 2, null, { timeout: 600000, polling: 300 });
const res = await win.evaluate(() => [...document.querySelectorAll('.modal .res')].map((e) => e.textContent));
ok(res.every((r) => /done/.test(r)), `both files done in ${Date.now() - t} ms: ${res.join(' | ')}`);
const outs = files.map((f) => f.replace(/\.pdf$/, ' (searchable).pdf'));
ok(outs.every(existsSync), 'searchable copies written next to the originals');
// open one and check its text
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), outs[0]);
await win.waitForFunction(() => window.__gcc.active()?.pages.length === 12, null, { timeout: 30000 });
const txt = await win.evaluate(async () => { const d = window.__gcc.active(); let n = 0; for (let i = 0; i < 12; i++) if (/Retention/i.test((await d.chars(i)).text)) n++; return n; });
ok(txt >= 9, `text found on ${txt} of 12 pages`);
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
