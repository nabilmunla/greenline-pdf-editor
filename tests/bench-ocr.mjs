// OCR speed + accuracy through the real dialog: Make searchable on a 12-page scan set
// (clean, 3° crooked, faint photocopy, sideways - x3). Prints time and word accuracy per page.
// xvfb-run -a node tests/bench-ocr.mjs [eng|ara|eng+ara]
import { _electron as electron } from 'playwright';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const lang = process.argv[2] || 'eng+ara';
const truth = JSON.parse(readFileSync('tests/data/ocr-truth.json', 'utf8')).join(' ').split(/\s+/);
function wordAcc(got) {
  const a = truth.map((w) => w.toLowerCase().replace(/[^\w]/g, '')).filter(Boolean);
  const b = got.map((w) => w.toLowerCase().replace(/[^\w]/g, '')).filter(Boolean);
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return Math.max(0, 1 - dp[a.length][b.length] / a.length);
}
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=ocrbench', resolve('tests/data/ocr-bench12.pdf')] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
win.on('console', (m) => { if (m.type() === 'error' && !/Estimating resolution/.test(m.text())) console.log('CONSOLE', m.text()); });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
await win.waitForFunction(() => window.__gcc?.active()?.pages.length === 12, null, { timeout: 60000 });
if (process.env.ENGINES) await win.evaluate((n) => localStorage.setItem('ocr-engines', n), process.env.ENGINES);
else await win.evaluate(() => localStorage.removeItem('ocr-engines'));
console.log('cores seen by the window:', await win.evaluate(() => navigator.hardwareConcurrency));
await win.locator('.rtab', { hasText: 'OCR' }).click();
await win.locator('.ribbon .rb', { hasText: 'Make searchable' }).click();
await win.locator('.modal select').selectOption(lang);
// how smooth the window stays: longest gap between animation frames while OCR runs
await win.evaluate(() => { window.__gap = 0; let t = performance.now(); const f = () => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - t); t = n; if (!window.__stopGap) requestAnimationFrame(f); }; requestAnimationFrame(f); });
const t = Date.now();
await win.locator('.modal button', { hasText: 'Start' }).click();
const tick = setInterval(async () => { try { console.log('  ', Math.round((Date.now() - t) / 1000) + 's', await win.evaluate(() => document.querySelector('.modal .prog')?.textContent || '-')); } catch { /* closed */ } }, 15000);
await win.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 900000, polling: 200 });
clearInterval(tick);
const ms = Date.now() - t;
const gap = await win.evaluate(() => { window.__stopGap = true; return window.__gap; });
const texts = await win.evaluate(async () => { const d = window.__gcc.active(); const out = []; for (let i = 0; i < d.pages.length; i++) out.push((await d.chars(i)).text); return out; });
let sum = 0;
const accs = texts.map((x) => { const a = wordAcc(x.split(/\s+/)); sum += a; return (a * 100).toFixed(1); });
console.log(`lang ${lang}: ${ms} ms total, ${(ms / 12 / 1000).toFixed(2)} s/page; longest window freeze ${Math.round(gap)} ms`);
console.log('accuracy per page %:', accs.join(' '));
console.log('mean accuracy', ((sum / 12) * 100).toFixed(2) + '%');
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
process.exit(0);
