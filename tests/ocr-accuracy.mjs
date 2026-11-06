// OCR accuracy on known text: clean, 3° crooked, sideways, faint noisy photocopy.
// Word accuracy = share of the true words found in the right order (edit distance on words).
import { _electron as electron } from 'playwright';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const truth = JSON.parse(readFileSync('tests/data/ocr-truth.json', 'utf8')).join(' ').split(/\s+/);
const files = ['ocr-clean', 'ocr-skew3', 'ocr-sideways', 'ocr-faint'];
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=ocrtest', ...files.map((f) => resolve('tests/data/' + f + '.pdf'))] });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await win.waitForFunction(() => window.__gcc && window.__gcc.docs().length === 4, null, { timeout: 60000 });

function wordAcc(got) {
  const a = truth.map((w) => w.toLowerCase().replace(/[^\w]/g, '')).filter(Boolean);
  const b = got.map((w) => w.toLowerCase().replace(/[^\w]/g, '')).filter(Boolean);
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return Math.max(0, 1 - dp[a.length][b.length] / a.length);
}

let worst = 1;
for (let k = 0; k < files.length; k++) {
  await win.locator('.dtab').nth(k).click();
  await win.waitForTimeout(300);
  const t = Date.now();
  const r = await win.evaluate(async () => {
    const d = window.__gcc.active();
    const words = await window.__gcc.ocr('eng');
    // keep Tesseract's reading order (it reads turned pages in their own direction)
    const g = words.find((w) => /GENERAL/i.test(w.text));
    return { name: d.name, words: words.map((w) => w.text), first: g ? g.box : null, w: d.pages[0].w, h: d.pages[0].h, conf: words.reduce((s, w) => s + w.conf, 0) / Math.max(1, words.length) };
  });
  const acc = wordAcc(r.words);
  worst = Math.min(worst, acc);
  // where "GENERAL" should be on the page (as the page shows)
  console.log(`${r.name.padEnd(18)} words ${(acc * 100).toFixed(1)}%  conf ${r.conf.toFixed(0)}  ${Date.now() - t} ms  'GENERAL' at ${r.first ? r.first.map(Math.round).join(',') : '—'} (page ${Math.round(r.w)}x${Math.round(r.h)})`);
}
await app.close();
console.log('worst', (worst * 100).toFixed(1) + '%');
