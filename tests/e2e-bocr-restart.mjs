// Batch > Make files searchable while a drawing engine has a planned restart (agent audit, 0.9.7).
// PDFED_RECYCLE_AT=1 (the engines' own test hook) makes a drawing engine older than 30 s start
// afresh after its next call - the same restart a big scan run gets once an engine passes
// RECYCLE_AT (1.4-3 GB). The batch file is opened in the drawing engines directly (not a tab), so
// the restart hook never reopens it in the new engine.
// xvfb-run -a -s "-screen 0 1800x1100x24" node tests/e2e-bocr-restart.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';

const TMP = resolve('tests/tmp-e2e-bocr-restart');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const files = ['ocr-bench12'].map((n) => { const f = join(TMP, n + '.pdf'); copyFileSync(`tests/data/${n}.pdf`, f); return f; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-agbocr'), { recursive: true, force: true });
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=agbocr'], env: { ...process.env, PDFED_RECYCLE_AT: '1' } });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await app.evaluate(({ dialog }, fs) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: fs }); }, files);
await win.evaluate(() => localStorage.setItem('ocr-engines', '2'));
console.log('waiting 32 s (the engines must be older than 30 s for the planned restart)');
await sleep(32000);
await win.locator('.rtab', { hasText: 'Batch' }).click();
await win.locator('.ribbon .rb', { hasText: /searchable/i }).click();
await win.locator('.modal button', { hasText: 'Add files' }).click();
await win.locator('.modal select').first().selectOption('eng');
await win.locator('.modal button', { hasText: 'Start' }).click();
await win.waitForFunction(() => [...document.querySelectorAll('.modal .res')].filter((e) => /done|nothing|failed/.test(e.textContent)).length === 1, null, { timeout: 400000, polling: 300 });
const res = await win.evaluate(() => [...document.querySelectorAll('.modal .res')].map((e) => e.textContent));
console.log((res.some((r) => /failed/.test(r)) ? (globalThis.__failed = true, 'FAIL ') : 'PASS ') + 'batch OCR with one drawing-engine restart: ' + res.join(' | '));
const restarts = await win.evaluate(() => window.__gcc?.engines?.renderers.map((r) => r.name + ':' + r.restarts).join(', '));
console.log('restarts: ' + restarts);
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
rmSync(TMP, { recursive: true, force: true });
process.exit(globalThis.__failed ? 1 : 0);
