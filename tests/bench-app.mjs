// Performance benchmark of the real app (before/after the optimisation pass).
// xvfb-run -a node tests/bench-app.mjs   -> prints one line per measurement + JSON at the end
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';

const TMP = resolve('tests/tmp-bench');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const BOOK = resolve('tests/huge/book1-317mb.pdf');
const SPEC = join(TMP, 'spec.pdf');
copyFileSync('tests/data/long-spec.pdf', SPEC);
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-bench'), { recursive: true, force: true });

const R = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=bench'] });
const t0 = Date.now();
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
await win.waitForFunction(() => !!window.__gcc, null, { timeout: 60000 });
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
const E = (fn, a) => win.evaluate(fn, a);
const until = async (fn, ms = 120000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return Date.now() - t; await sleep(25); } throw new Error('timeout'); };
const open = async (f) => { await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [p]), f); };
const tilesReady = () => E(() => { const s = window.__gcc.tiles.stats(); return s; });
const mark = (k, v, unit = 'ms') => { R[k] = v; console.log(k.padEnd(44), typeof v === 'number' ? Math.round(v) + ' ' + unit : v); };

mark('start: window to engines ready', await until(() => E(() => !!window.__gcc && document.querySelector('.app') !== null)) + (Date.now() - t0));

// --- the 317 MB scan book
if (existsSync(BOOK)) {
  let t = Date.now();
  await open(BOOK);
  await until(() => E(() => window.__gcc.active()?.pages.length > 0));
  mark('book: open (pages known)', Date.now() - t);
  await until(() => E(() => document.querySelectorAll('.pg canvas, .pg img').length > 0 && window.__gcc.tiles.stats().tiles > 0));
  mark('book: first picture', Date.now() - t);
  const n = await E(() => window.__gcc.active().pages.length);
  R.bookPages = n;
  t = Date.now();
  await E(() => window.__gcc.active().rotate([5], 90));
  mark('book: rotate one page', Date.now() - t);
  t = Date.now();
  await E(() => window.__gcc.active().undo());
  mark('book: undo the rotation', Date.now() - t);
  t = Date.now();
  await E(() => window.__gcc.active().create(3, { type: 'Square', rect: [50, 50, 200, 150], color: [1, 0, 0] }));
  mark('book: add a markup', Date.now() - t);
  t = Date.now();
  for (let i = 0; i < 10; i++) await E((k) => window.__gcc.active().create(3, { type: 'Circle', rect: [50 + k * 10, 200, 90 + k * 10, 240], color: [0, 0, 1] }), i);
  mark('book: 10 more markups (each)', (Date.now() - t) / 10);
  t = Date.now();
  await E(() => window.__gcc.active().addTextLayer(7, [{ text: 'hello', box: [50, 50, 120, 62] }]));
  mark('book: OCR text layer on one page', Date.now() - t);
  t = Date.now();
  await E(async () => { const d = window.__gcc.active(); for (let i = 10; i < 30; i++) await d.addTextLayer(i, [{ text: 'word' + i, box: [50, 50, 120, 62] }]); });
  mark('book: OCR text layers, 20 pages (each)', (Date.now() - t) / 20);
  t = Date.now();
  const out = join(TMP, 'book-saved.pdf');
  await E((p) => window.__gcc.active().save(p), out);
  mark('book: save as (317 MB)', Date.now() - t);
  t = Date.now();
  await E(() => window.__gcc.active().create(4, { type: 'Square', rect: [50, 50, 200, 150], color: [0, 1, 0] }));
  await E(() => window.__gcc.active().save());
  mark('book: save again after one markup', Date.now() - t);
  // jump around
  t = Date.now();
  for (const p of [100, 200, 50, 300, 10]) { await E((k) => window.__gcc.viewer().goTo(Math.min(k, window.__gcc.active().pages.length - 1)), p); await sleep(150); }
  mark('book: 5 jumps', Date.now() - t);
  const rss = await app.evaluate(({ app: a }) => a.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024);
  mark('book: all processes memory', rss, 'MB');
}

// --- the 1,500-page spec: read straight through
let t = Date.now();
await open(SPEC);
await until(() => E(() => window.__gcc.active()?.name === 'spec.pdf' && window.__gcc.active().pages.length === 1500));
mark('spec: open 1,500 pages', Date.now() - t);
t = Date.now();
await E(async () => { const v = window.__gcc.viewer(); for (let i = 0; i < 1500; i += 10) { v.goTo(i); await new Promise((r) => setTimeout(r, 15)); } });
await sleep(1500);
mark('spec: scroll through all pages', Date.now() - t);
const st = await tilesReady();
mark('spec: tile memory after reading through', st.bytes / 1e6, 'MB');
mark('spec: of which page previews', st.previews / 1e6, 'MB');
const heap = await E(() => (performance.memory ? performance.memory.usedJSHeapSize / 1e6 : -1));
mark('spec: window JS heap', heap, 'MB');
t = Date.now();
await E(() => window.__gcc.active().rotate([700], 90));
mark('spec: rotate one page of 1,500', Date.now() - t);
t = Date.now();
await E(() => window.__gcc.active().create(700, { type: 'Square', rect: [50, 50, 200, 150], color: [1, 0, 0] }));
mark('spec: add a markup', Date.now() - t);
t = Date.now();
await E(() => window.__gcc.active().allAnnots());
mark('spec: list all markups (comments panel)', Date.now() - t);
t = Date.now();
await E(async () => { const d = window.__gcc.active(); const { renderers } = window.__gccEngines || {}; void renderers; return d.chars(800); });
mark('spec: text of a page', Date.now() - t);

const rss = await app.evaluate(({ app: a }) => a.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024);
mark('end: all processes memory', rss, 'MB');
const per = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => `${m.type}${m.serviceName ? ':' + m.serviceName : m.name ? ':' + m.name : ''} ${Math.round(m.memory.workingSetSize / 1024)}MB`));
console.log('processes:', per.join(' | '));
console.log('JSON ' + JSON.stringify(R));
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
process.exit(0);
