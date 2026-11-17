// The four crash reports left on the company share (16 Nov 2026), checked against the app:
//  - 0.8.4 "invalid page number: 2" / 0.8.1 "Document is not open": the window asked an engine about a
//    page the file does not have (any more) -> it no longer asks, the answer is "nothing there";
//  - 0.8.1 "Could not read page 4" / 0.8.9 "UNKNOWN: unknown error, read": engine answers that nothing
//    caught (the pointer over a page, the Edit text tool) -> caught; a file Windows can't read any
//    more is said in a message, not filed as a crash;
//  - every engine error names its engine and call, so a report says where it came from;
//  - (PLAN 7.11) the wide probe at the end: every engine read of the open file rejects while the window is
//    used - pointer, panels, a second tab - and nothing is left unhandled.
// xvfb-run -a node tests/e2e-share-reports.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';

const TMP = resolve('tests/tmp-share-reports');
rmSync(TMP, { recursive: true, force: true });
const INST = join(TMP, 'install'), SHARE = join(TMP, 'share');
for (const d of [INST, SHARE]) mkdirSync(d, { recursive: true });
copyFileSync('tests/data/ocr-clean.pdf', join(TMP, 'one-page.pdf'));
writeFileSync(join(INST, 'install.json'), JSON.stringify({ scope: 'user', version: '0.4.0' }));
writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: SHARE }));
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-share-reports');
rmSync(PROFILE, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const RDIR = join(SHARE, 'reports');
const reports = () => (existsSync(RDIR) ? readdirSync(RDIR).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(RDIR, n), 'utf8'))) : []);
const reported = (re) => reports().filter((x) => re.test(x.message || ''));

const app = await electron.launch({
  executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=share-reports'],
  env: { ...process.env, PDFED_INSTALL_DIR: INST, PDFED_UPDATE_FIRST: '600000', PDFED_REPORT_FIRST: '500' },
});
const win = await app.firstWindow();
for (let i = 0; i < 60 && !(await win.evaluate(() => !!window.__gcc).catch(() => false)); i++) await sleep(200);
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), join(TMP, 'one-page.pdf'));
await win.waitForFunction(() => window.__gcc.active()?.pages.length === 1, null, { timeout: 30000 });
await sleep(1500);

// 1. a page the file does not have: nothing there, no engine asked, nothing thrown
const r1 = await win.evaluate(async () => {
  const d = window.__gcc.active();
  const r = await Promise.allSettled([d.annots(1), d.chars(1), d.blocks(1), d.links(1), d.rangeRects(1, 0, 1), d.annots(-1)]);
  return r.map((x) => x.status === 'fulfilled' ? (Array.isArray(x.value) ? x.value.length : x.value.text.length) : 'rejected: ' + x.reason?.message);
});
ok(r1.every((x) => x === 0), 'page 2 of a one-page file (markups, text, lines, links, ranges) and page 0: empty, not an engine error (' + r1.join(', ') + ')');

// 2. an engine error names its engine and call
const r2 = await win.evaluate(async () => {
  const d = window.__gcc.active();
  return window.__gcc.engines.renderers[0].call('chars', [d.id, 7]).then(() => null, (e) => ({ method: e.method, engine: e.engine, stack: String(e.stack) }));
});
ok(!!r2 && r2.method === 'chars' && /at engine .+: chars/.test(r2.stack), 'an engine error says which call it answered: ' + (r2 && r2.stack.split('\n').slice(0, 2).join(' / ')));

// 3. engine answers nothing caught: the pointer over a page (its text read for the I-beam) and the
//    Edit text tool (its lines read) - a failure there is not a crash any more
await win.evaluate(() => {
  const d = window.__gcc.active();
  d.chars = () => Promise.reject(new Error('share-test: could not read the text'));
  d.blocks = () => Promise.reject(new Error('share-test: could not read the lines'));
});
const box = await win.locator('.pg[data-page="0"]').boundingBox();
for (let i = 0; i < 6; i++) { await win.mouse.move(box.x + box.width * (0.3 + i * 0.08), box.y + box.height * 0.3); await sleep(150); }
await win.locator('.rtab', { hasText: 'Edit' }).click();
await win.locator('.ribbon .rb', { hasText: 'Edit text' }).click();
await sleep(3500);
ok(reported(/share-test/).length === 0, 'text under the pointer and Edit text\'s lines that fail to read: no crash report (' + reported(/share-test/).map((x) => x.message).join('; ') + ')');
ok(await win.evaluate(() => window.__gcc.active()?.pages.length === 1), 'the file is still open and the window alive');

// 4. Windows can't read the file any more: a message, not a crash report
await win.evaluate(() => { void Promise.reject(Object.assign(new Error('UNKNOWN: unknown error, read'), { fileRead: true })); });
const said = await win.locator('.toast', { hasText: 'could not be read from the disk' }).waitFor({ timeout: 5000 }).then(() => true, () => false);
await sleep(2500);
ok(said, 'a file Windows could no longer read: the person is told what happened');
ok(reported(/unknown error, read/).length === 0, 'and it is not filed as a crash');

// 5. the wide probe (PLAN 7.11): every engine read of the open file rejects, then the pointer moves over
//    the pages, the Comments list, Bookmarks and the properties panel open and close, and a second tab
//    opens and closes. Nothing may be left unhandled in the window, and no crash report may be filed.
//    (The window's own unhandledrejection handler in main.tsx is the one that files crash reports; this
//    hook sees the same events before it, so a rejection nobody caught is counted here.)
await win.evaluate(() => {
  window.__probeRej = [];
  window.addEventListener('unhandledrejection', (e) => window.__probeRej.push(String(e.reason?.message || e.reason)));
  const d = window.__gcc.active();
  for (const m of ['chars', 'blocks', 'annots', 'links', 'rangeRects', 'setData']) d[m] = () => Promise.reject(new Error('share-probe: ' + m + ' failed'));
});
const rejecting = await win.evaluate(async () => {
  const d = window.__gcc.active();
  const calls = [() => d.chars(0), () => d.blocks(0), () => d.annots(0), () => d.links(0), () => d.rangeRects(0, 0, 1), () => d.setData({})];
  const r = await Promise.allSettled(calls.map((f) => Promise.resolve().then(f)));
  return r.filter((x) => x.status === 'rejected' && /share-probe/.test(x.reason?.message || '')).length;
});
ok(rejecting === 6, 'probe 1: the six engine reads of the open file (chars, blocks, annots, links, rangeRects, setData) all reject (' + rejecting + ' of 6)');
const pb = await win.locator('.pg[data-page="0"]').boundingBox();
for (let i = 0; i < 8; i++) { await win.mouse.move(pb.x + pb.width * (0.2 + i * 0.09), pb.y + pb.height * (0.2 + (i % 3) * 0.25)); await sleep(120); }
await win.locator('.rail-btn[title="Comments list"]').click(); await sleep(800);
await win.locator('.rail-btn[title="Bookmarks"]').click(); await sleep(800);
await win.locator('.rail-btn[title="Bookmarks"]').click(); await sleep(300);
await win.keyboard.press('F4'); await sleep(400);
await win.keyboard.press('F4'); await sleep(400);
copyFileSync('tests/data/ocr-clean.pdf', join(TMP, 'second.pdf'));
await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), join(TMP, 'second.pdf'));
await win.waitForFunction(() => window.__gcc.docs().length === 2, null, { timeout: 30000 });
await sleep(1000);
await win.keyboard.press('Control+w');
await win.waitForFunction(() => window.__gcc.docs().length === 1, null, { timeout: 15000 });
await sleep(3000);
ok(reported(/share-probe/).length === 0, 'probe 2: pointer over the pages, Comments list, Bookmarks, the properties panel and a second tab opened and closed: no crash report (' + reported(/share-probe/).map((x) => x.message).join('; ') + ')');
const unhandled = await win.evaluate(() => window.__probeRej.slice());
ok(unhandled.length === 0, 'probe 3: no unhandledrejection in the window during the probe (' + unhandled.slice(0, 3).join('; ') + ')');

await app.close().catch(() => {});
rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
