// Huge files: 317 MB scanned book (300 pages), 133 MB single drawing sheet.
// Opens, pages through, edits, saves twice, OCR, and engines killed on purpose.
// xvfb-run -a node tests/e2e-huge.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as mupdf from 'mupdf';
import fs from 'node:fs';

const TMP = resolve('tests/tmp-huge');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const BOOK = join(TMP, 'book.pdf');
copyFileSync('tests/huge/book1-317mb.pdf', BOOK);
chmodSync(BOOK, 0o644);
const ROT5 = (() => { const d = mupdf.Document.openDocument(fs.readFileSync(BOOK), 'application/pdf').asPDF(); const r = d.loadPage(5).getObject().getInheritable('Rotate').asNumber?.() ?? 0; d.destroy(); return r; })();
const SHEET = resolve('tests/huge/plumbing-133mb.pdf');
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-huge'), { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let app, win;
const E = (fn, arg) => win.evaluate(fn, arg);
const until = async (fn, ms = 60000, what = 'condition') => {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(100); }
  throw new Error('timed out waiting for ' + what);
};
async function step(name, fn) {
  const t = Date.now();
  try { const info = await fn(); results.push({ name, ok: true }); console.log(`PASS ${name} (${Date.now() - t} ms)${info ? ' – ' + info : ''}`); }
  catch (e) { results.push({ name, ok: false }); console.log(`FAIL ${name}: ${e.message}`); await win.screenshot({ path: join(TMP, 'fail-' + name.replace(/\W+/g, '_').slice(0, 50) + '.png') }).catch(() => {}); }
}
/** memory of every process of the app, MB */
async function memory() {
  const m = await app.evaluate(({ app: a }) => a.getAppMetrics().map((p) => ({ type: p.type, name: p.name || p.serviceName || '', pid: p.pid, mb: Math.round(p.memory.workingSetSize / 1024) })));
  const total = m.reduce((s, p) => s + p.mb, 0);
  const biggest = m.slice().sort((a, b) => b.mb - a.mb).slice(0, 4).map((p) => `${p.name || p.type} ${p.mb}`).join(', ');
  return { total, biggest, list: m };
}
const previewReady = (page) => E((p) => { const d = window.__gcc.active(); return window.__gcc.tiles.has(`${d.id}|r${d.crev[p]}|p|0|0`); }, page);
const goTo = (p) => E((x) => window.__gcc.viewer().goTo(x), p);
const workFiles = () => { const d = join(tmpdir(), 'PDF Editor', 'work'); try { return readdirSync(d).flatMap((x) => readdirSync(join(d, x)).map((f) => ({ f, size: statSync(join(d, x, f)).size }))); } catch { return []; } };
function check(file) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf').asPDF();
  const r = { repaired: doc.wasRepaired(), pages: doc.countPages(), ann10: doc.loadPage(10).getAnnotations().length, ann20: doc.loadPage(20).getAnnotations().length, rot5: doc.loadPage(5).getObject().getInheritable('Rotate').asNumber?.() ?? 0 };
  doc.destroy();
  return r;
}

app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=huge'] });
win = await app.firstWindow();
win.on('pageerror', (e) => console.log('  PAGEERROR', e.message));
await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
await app.evaluate(({ dialog }) => {
  globalThis.__q = { save: [], box: [] };
  dialog.showSaveDialog = async () => { const f = globalThis.__q.save.shift(); return f ? { canceled: false, filePath: f } : { canceled: true }; };
  dialog.showMessageBox = async () => ({ response: globalThis.__q.box.length ? globalThis.__q.box.shift() : 0 });
});
await until(() => E(() => !!window.__gcc), 20000, 'app');
console.log('idle memory', (await memory()).total, 'MB');

await step('open 317 MB scanned book (300 pages)', async () => {
  const t = Date.now();
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), BOOK);
  await until(() => E(() => window.__gcc.active()?.pages.length === 300), 60000, 'opened');
  const tOpen = Date.now() - t;
  await until(() => previewReady(0), 60000, 'first page picture');
  const m = await memory();
  return `open ${tOpen} ms, first picture ${Date.now() - t} ms, memory ${m.total} MB (${m.biggest})`;
});

await step('jump around the book: pages 50, 150, 299', async () => {
  const times = [];
  for (const p of [50, 150, 299, 2]) { const t = Date.now(); await goTo(p); await until(() => previewReady(p), 30000, 'page ' + p); times.push(`p${p + 1} ${Date.now() - t} ms`); }
  return times.join(', ') + `; memory ${(await memory()).total} MB`;
});

await step('markup + rotate a page in the 317 MB file (only the change is written)', async () => {
  await E(async () => { const d = window.__gcc.active(); await d.create(10, { type: 'Square', rect: [100, 100, 300, 300] }); });
  const before = await E(() => window.__gcc.active().crev[5]);
  const t = Date.now();
  await E(async () => { await window.__gcc.active().rotate([5], 90); });
  const tr = Date.now() - t;
  await goTo(5);
  await until(async () => (await E(() => window.__gcc.active().crev[5])) !== before && previewReady(5), 30000, 'rotated page drawn');
  const w = workFiles();
  const delta = w.filter((x) => x.f === 'changes.bin').map((x) => x.size);
  const full = w.filter((x) => x.f === 'snapshot.pdf').map((x) => x.size);
  if (full.some((s) => s > 50e6)) throw new Error('a whole copy was written: ' + full);
  return `rotate ${tr} ms; drawing engines got ${delta.length ? 'a ' + Math.round(delta[0] / 1024) + ' KB change file' : 'no delta?'}`;
});

await step('save as (317 MB) and the saved file is clean', async () => {
  const out = join(TMP, 'book-saved.pdf');
  await app.evaluate((_e, f) => { globalThis.__q.save.push(f); }, out);
  const t = Date.now();
  await win.keyboard.press('Control+Shift+s');
  await until(() => E(() => !window.__gcc.active().dirty && window.__gcc.active().name === 'book-saved.pdf'), 180000, 'saved');
  const ts = Date.now() - t;
  const c = check(out);
  if (c.repaired || c.pages !== 300 || c.ann10 < 1 || c.rot5 !== (ROT5 + 90) % 360) throw new Error(JSON.stringify(c));
  return `${ts} ms, ${Math.round(statSync(out).size / 1e6)} MB, ${JSON.stringify(c)}; memory ${(await memory()).total} MB`;
});

await step('another markup + Ctrl+S over the same file (twice) stays clean', async () => {
  const out = join(TMP, 'book-saved.pdf');
  for (let k = 0; k < 2; k++) {
    await E(async (k) => { const d = window.__gcc.active(); await d.create(20, { type: 'Circle', rect: [100 + k * 220, 400, 300 + k * 220, 600] }); }, k);
    await win.keyboard.press('Control+s');
    await until(() => E(() => !window.__gcc.active().dirty), 180000, 'saved');
  }
  const c = check(out);
  if (c.repaired || c.ann20 !== 2 || c.rot5 !== (ROT5 + 90) % 360) throw new Error(JSON.stringify(c));
  return JSON.stringify(c);
});

await step('OCR a page of the scanned book', async () => {
  const t = Date.now();
  const words = await E(() => window.__gcc.ocr('eng'));
  if (!words.length) throw new Error('no words');
  return `${words.length} words in ${Date.now() - t} ms`;
});

await step('drawing engine killed: restarts, pages still draw', async () => {
  const m = await memory();
  const r = m.list.find((p) => /render0/.test(p.name));
  if (!r) throw new Error('no drawing engine found: ' + m.list.map((p) => p.name).join(','));
  process.kill(r.pid, 'SIGKILL');
  await sleep(800);
  for (const p of [120, 121, 200]) { await goTo(p); await until(() => previewReady(p), 30000, 'page ' + p + ' after restart'); }
  const m2 = await memory();
  if (!m2.list.find((p) => /render0/.test(p.name) && p.pid !== r.pid)) throw new Error('not restarted');
  return 'restarted, pages 121/122/201 drawn';
});

await step('editing engine killed: file comes back, markups intact, window alive', async () => {
  const m = await memory();
  const r = m.list.find((p) => / edit$/.test(p.name));
  if (!r) throw new Error('no editing engine found');
  process.kill(r.pid, 'SIGKILL');
  await sleep(1500);
  const n = await until(() => E(async () => { const d = window.__gcc.active(); const a = await d.allAnnots(); return a.length || null; }), 60000, 'markups back');
  await goTo(30);
  await until(() => previewReady(30), 30000, 'drawing after restart');
  await E(async () => { const d = window.__gcc.active(); await d.create(30, { type: 'Square', rect: [100, 100, 200, 200] }); });
  return `${n} markups back; editing works again`;
});

await step('open 133 MB single drawing sheet', async () => {
  const t = Date.now();
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), SHEET);
  await until(() => E(() => window.__gcc.active()?.name === 'plumbing-133mb.pdf'), 60000, 'opened');
  await until(() => previewReady(0), 120000, 'picture');
  const t1 = Date.now() - t;
  await E(() => window.__gcc.viewer().setZoom(2));
  await sleep(4000);
  const m = await memory();
  return `first picture ${t1} ms; memory ${m.total} MB (${m.biggest})`;
});

const m = await memory();
console.log('final memory', m.total, 'MB:', m.list.map((p) => `${p.name || p.type}=${p.mb}`).join(' '));
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
