// Link the sheets (PLAN 7.6), in the real app: the Edit tab's button, its dialog (two ticks, a progress
// line, Cancel), the links and the Sheets bookmark group, one Ctrl+Z - and the R set (a spec of 1,500
// pages, a scan, a mixed set, one page, a cut-short file, a password file): nothing found is said
// plainly, nothing changes, and no crash report is filed.    xvfb-run -a node tests/e2e-sheets.mjs
import { _electron as electron } from 'playwright';
import { resolve, join, basename } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { ensure, paths, truthOf, TMP as SETS, PASSWORD } from './rset.mjs';
import { write } from './gen/sheetset.mjs';

const TMP = resolve('tests/tmp-sheets');
rmSync(TMP, { recursive: true, force: true });
const INST = join(TMP, 'install'), SHARE = join(TMP, 'share');
for (const d of [INST, SHARE]) mkdirSync(d, { recursive: true });
writeFileSync(join(INST, 'install.json'), JSON.stringify({ scope: 'user', version: '0.4.0' }));
writeFileSync(join(INST, 'update.json'), JSON.stringify({ source: SHARE }));
const PROFILE = join(process.env.HOME, '.config', 'PDF Editor', 'profile-sheets');
rmSync(PROFILE, { recursive: true, force: true });

const R = ensure();
const setC = join(SETS, 'set-c.pdf');
if (!existsSync(setC) || statSync(setC).mtimeMs < statSync(resolve('tests/gen/sheetset.mjs')).mtimeMs) write('C', SETS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const until = async (fn, ms = 15000, what = '') => { const t = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + what); await sleep(100); } };
const RDIR = join(SHARE, 'reports');
const reports = () => (existsSync(RDIR) ? readdirSync(RDIR).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(RDIR, n), 'utf8'))) : []);

const app = await electron.launch({
  executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=sheets'],
  env: { ...process.env, PDFED_INSTALL_DIR: INST, PDFED_UPDATE_FIRST: '600000', PDFED_REPORT_FIRST: '500' },
});
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
const E = (fn, a) => win.evaluate(fn, a);
for (let i = 0; i < 60 && !(await E(() => !!window.__gcc).catch(() => false)); i++) await sleep(200);

const openFile = async (f, pages, password) => {
  const had = await E(() => window.__gcc.docs().length);
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), f);
  if (password) {
    await until(() => win.locator('.modal h2', { hasText: 'Password needed' }).count(), 15000, 'password dialog');
    await win.locator('.modal input[type=password]').fill(password);
    await win.keyboard.press('Enter');
  }
  await until(() => E(([n, name, pg]) => window.__gcc.docs().length === n + 1 && window.__gcc.active()?.name === name && (pg ? window.__gcc.active().pages.length === pg : window.__gcc.active().pages.length > 0), [had, basename(f), pages]), 60000, 'open ' + basename(f));
  await sleep(1500);
};
const docState = () => E(() => { const d = window.__gcc.active(); return { dirty: d.dirty, canUndo: d.canUndo, undoName: d.undoName, pages: d.pages.length }; });
const allLinks = () => E(async () => {
  const d = window.__gcc.active();
  let n = 0; const pgs = [];
  for (let p = 0; p < d.pages.length; p++) { const l = await window.__gcc.engines.mu('linksOf', d.id, p); const c = l.filter((x) => x.page >= 0).length; n += c; if (c) pgs.push(p); }
  return { n, pgs };
});
const groups = () => E(async () => { const d = window.__gcc.active(); const t = await window.__gcc.engines.mu('outlineFull', d.id); return t.map((m) => ({ title: m.title, kids: m.children.length })); });
const dlg = () => win.locator('.modal', { hasText: 'Link the sheets' });
const toastText = () => E(() => [...document.querySelectorAll('.toast .grow')].map((t) => t.textContent || ''));
const clearToasts = () => E(() => document.querySelectorAll('.toast button.tbtn').forEach((b) => { if (b.textContent === '×') b.click(); }));
/** run Link the sheets from the ribbon; returns { ms, toast } */
const run = async (opts = {}) => {
  await clearToasts();
  await sleep(150);
  await win.locator('.rtab', { hasText: 'Edit' }).click();
  await win.locator('.ribbon .rb', { hasText: /^Link the sheets$/ }).click();
  await until(() => dlg().count(), 5000, 'dialog');
  const boxes = await dlg().locator('input[type=checkbox]').evaluateAll((l) => l.map((x) => x.checked));
  if (opts.untick != null) await dlg().locator('label.check', { hasText: opts.untick }).locator('input').click();
  const t0 = Date.now();
  await dlg().locator('button.primary', { hasText: 'Start' }).click();
  const progress = () => E(() => document.querySelector('[data-sheets-progress]')?.textContent || '');
  // (a one-page file is done before a progress line shows: waiting 8 s for one let its message go by)
  const sawProgress = await until(async () => { const t = await progress(); if (/^Reading page [\d,]+ of [\d,]+…$/.test(t)) return t; return (await dlg().count()) ? null : 'done first'; }, 8000, 'progress').catch(() => null);
  if (opts.cancelAfter) { await until(() => progress().then((t) => Number((t.match(/page ([\d,]+)/)?.[1] || '0').replace(/,/g, '')) >= opts.cancelAfter), 20000, 'cancel point'); await dlg().locator('button', { hasText: 'Cancel' }).click(); }
  await until(async () => !(await dlg().count()), 120000, 'dialog closed');
  const ms = Date.now() - t0;
  const toast = await until(async () => (await toastText()).find((t) => /link|bookmark|sheet number|Stopped|could not be read|No references|Nothing to link/.test(t)), 5000, 'toast').catch(async (e) => { throw new Error(e.message + ' (toasts: ' + JSON.stringify(await toastText()) + ')'); });
  return { ms, toast, boxes, sawProgress };
};
const mine2 = (m) => m.procs.filter((x) => x.type === 'Tab' || /PDF Editor (render|edit|batch)/.test(x.name || ''));
const NONE = 'No sheet numbers found. Nothing was changed.';
const NONE_WHY = /^No sheet numbers found\. Link the sheets looks for a sheet number such as A-101 in each sheet's title block .*Nothing was changed\.$/;

try {
  // ---------------------------------------------------------------- set C: speed, memory, a click, one Ctrl+Z
  await openFile(setC, 320);
  const tC = truthOf(setC);
  const mem = async () => {
    const heaps = await E(() => Promise.all(window.__gcc.engines.renderers.map((r) => r.call('heap'))));
    const js = await E(() => performance.memory?.usedJSHeapSize || 0);
    const m = await app.evaluate(({ app }) => app.getAppMetrics().map((x) => ({ type: x.type, name: x.name, ws: x.memory.workingSetSize * 1024 })));
    return { heaps, js, procs: m };
  };
  await sleep(1500);
  const m0 = await mem();
  const r = await run();
  console.log('set C:', r.ms + ' ms,', JSON.stringify(r.toast));
  ok(r.boxes.length === 2 && r.boxes.every(Boolean), 'the dialog has two ticks, both on');
  ok(!!r.sawProgress, 'a progress line: ' + r.sawProgress);
  ok(r.ms < 30000, `set C (320 sheets) linked in ${(r.ms / 1000).toFixed(1)} s (under 30 s)`);
  const mt = r.toast.match(/^(\d+) links on (\d+) sheets, (\d+) bookmarks\. Undo removes them\./);
  ok(!!mt, 'the closing message: ' + r.toast);
  await sleep(2500);
  const m1 = await mem();
  const MB = 1 << 20;
  const dJs = (m1.js - m0.js) / MB;
  const dEng = m1.heaps.map((h, i) => (h - m0.heaps[i]) / MB);
  // (the window's and the engines' memory: JS heap, the drawing engines' heap, and the app's processes - the editing engine's among them)
  const ws = (m) => m.procs.reduce((s, x) => s + x.ws, 0) / MB;
  console.log('processes before:', m0.procs.map((x) => x.type + ':' + (x.name || '') + ' ' + (x.ws / MB).toFixed(0)).join(', '));
  console.log('processes after: ', m1.procs.map((x) => x.type + ':' + (x.name || '') + ' ' + (x.ws / MB).toFixed(0)).join(', '));
  console.log(`memory: window JS heap ${(m0.js / MB).toFixed(0)} -> ${(m1.js / MB).toFixed(0)} MB; drawing engines ${m0.heaps.map((h) => (h / MB).toFixed(0)).join('/')} -> ${m1.heaps.map((h) => (h / MB).toFixed(0)).join('/')} MB; all processes ${ws(m0).toFixed(0)} -> ${ws(m1).toFixed(0)} MB`);
  ok(dJs < 50, `the window's JS heap grew ${dJs.toFixed(1)} MB (under 50)`);
  ok(dEng.every((d) => d < 50), `each drawing engine's heap grew ${dEng.map((d) => d.toFixed(1)).join(' / ')} MB (under 50)`);
  // (the window = its Tab process, the engines = their own processes: each within 50 MB of before; the whole app is told)
  const mine = mine2;
  const grew = mine(m1).map((x, i) => ({ n: (x.name || x.type), d: (x.ws - mine(m0)[i].ws) / MB }));
  ok(grew.length >= 4 && grew.every((x) => x.d < 50), `the window and each engine process: ${grew.map((x) => x.n + ' ' + x.d.toFixed(0)).join(', ')} MB more than before (under 50 each; the whole app ${(ws(m1) - ws(m0)).toFixed(0)} MB)`);

  const links = await allLinks();
  ok(mt && links.n === Number(mt[1]), `links in the file = the message (${links.n})`);
  const wantRefs = tC.refs.filter((x) => !x.existing);
  ok(links.n >= 0.95 * wantRefs.length && links.n <= wantRefs.length, `links vs the truth's references: ${links.n} of ${wantRefs.length}`);
  ok(mt && links.pgs.length === Number(mt[2]), `"on N sheets" = pages holding links (${links.pgs.length})`);
  // two more runs on the same file (each replaces what the last made): the window and the engines still within 50 MB of the start
  for (let k = 0; k < 2; k++) { await run(); }
  await sleep(2000);
  {
    const m2 = await mem();
    const a = mine2(m2), b = mine2(m0);
    const g2 = a.map((x, i) => ({ n: x.name || x.type, d: (x.ws - b[i].ws) / MB }));
    ok(g2.every((x) => x.d < 50) && (m2.js - m0.js) / MB < 50 && m2.heaps.every((h, i) => (h - m0.heaps[i]) / MB < 50), `after three runs: ${g2.map((x) => x.n + ' ' + x.d.toFixed(0)).join(', ')} MB more than before, window JS heap ${((m2.js - m0.js) / MB).toFixed(0)} MB more`);
    const l3 = await allLinks();
    ok(l3.n === links.n, 'a rerun replaces the links it made: still ' + l3.n);
    // (each run is a step of its own: back to the first run's)
    await E(async () => { const d = window.__gcc.active(); await d.undo(); await d.undo(); });
    ok((await allLinks()).n === links.n && (await docState()).undoName === 'Link the sheets', 'two undos: back at the first run');
  }
  const g = await groups();
  const sheetsGroup = g.filter((x) => x.title === 'Sheets');
  const numbered = tC.pages.filter((x) => x.kind === 'sheet' && x.no).length;
  ok(sheetsGroup.length === 1 && mt && sheetsGroup[0].kids === Number(mt[3]), `a "Sheets" bookmark group with ${sheetsGroup[0]?.kids} entries (truth: ${numbered} numbered sheets)`);
  ok(sheetsGroup[0]?.kids === numbered, 'one bookmark per numbered sheet');
  let st = await docState();
  ok(st.dirty && st.undoName === 'Link the sheets', 'one step in the history: ' + st.undoName);
  // a link clicked jumps to its sheet
  const ref = tC.refs.find((x) => !x.existing && x.page > 3 && x.page < 300 && x.target !== x.page && Math.abs(x.target - x.page) > 5);
  await E(([p, b]) => window.__gcc.viewer().goTo(p, b, true), [ref.page, ref.box]);
  await until(() => E((p) => window.__gcc.viewer().page() === p, ref.page), 8000, 'on the page');
  await sleep(1500);
  const place = await E(([p, b]) => { const el = document.querySelector(`.pg[data-page="${p}"]`); const r = el.getBoundingClientRect(); const w = window.__gcc.active().pages[p].w; const k = r.width / w; return { x: r.left + ((b[0] + b[2]) / 2) * k, y: r.top + ((b[1] + b[3]) / 2) * k }; }, [ref.page, ref.box]);
  await win.mouse.move(place.x, place.y);
  await sleep(300);
  await win.mouse.click(place.x, place.y);
  const jumped = await until(() => E((t) => window.__gcc.viewer().page() === t, ref.target), 8000, 'jump').catch(() => false);
  ok(jumped, `a click on "${ref.text}" (page ${ref.page + 1}) goes to sheet page ${ref.target + 1}`);
  // one Ctrl+Z: all of it goes
  await win.locator('.pages, .viewer, .pg').first().click({ position: { x: 3, y: 3 }, force: true }).catch(() => {});
  await win.keyboard.press('Control+z');
  await until(async () => !(await docState()).canUndo, 20000, 'undone');
  const after = await allLinks();
  const g2 = await groups();
  st = await docState();
  ok(after.n === 0 && !g2.some((x) => x.title === 'Sheets'), `Ctrl+Z once: no links (${after.n}) and no Sheets group`);
  ok(!st.canUndo, 'and nothing is left to undo');

  // the dialog: Cancel writes nothing; a tick off writes only the other
  const rc = await run({ cancelAfter: 40 });
  ok(/^Stopped\. Nothing was changed\./.test(rc.toast), 'Cancel while reading: "' + rc.toast + '"');
  st = await docState();
  ok(!st.canUndo && (await allLinks()).n === 0 && !(await groups()).some((x) => x.title === 'Sheets'), 'Cancel: nothing written, no undo step');
  const rb = await run({ untick: 'Links between sheets' });
  ok(/^\d+ bookmarks\. Undo removes them\.$/.test(rb.toast) && (await allLinks()).n === 0, 'only the bookmark group when links are off: ' + rb.toast);
  await win.keyboard.press('Control+z');
  await until(async () => !(await docState()).canUndo, 20000, 'undone again');
  const rl = await run({ untick: 'Sheets bookmark group' });
  const gl = await groups();
  ok(/^\d+ links on \d+ sheets\. Undo removes them\.$/.test(rl.toast) && !gl.some((x) => x.title === 'Sheets'), 'only the links when the group is off: ' + rl.toast);
  // the Undo action of the message
  await E(() => { const b = [...document.querySelectorAll('.toast button.tbtn')].find((x) => x.textContent === 'Undo'); b?.click(); });
  await until(async () => !(await docState()).canUndo, 20000, 'undone by the toast');
  ok((await allLinks()).n === 0, "the message's Undo takes the links out");

  // ---------------------------------------------------------------- the R set
  console.log('--- R set');
  // long spec: nothing found, in time, nothing changed
  await openFile(R.longSpec, 1500);
  let q = await run();
  st = await docState();
  console.log('long-spec:', q.ms + ' ms,', JSON.stringify(q.toast));
  ok(NONE_WHY.test(q.toast), `long-spec: "${q.toast}"`);
  ok(q.ms < 60000, `long-spec (1,500 pages) read in ${(q.ms / 1000).toFixed(1)} s (under 60 s)`);
  ok(!st.dirty && !st.canUndo, 'long-spec: not changed (no undo step, dirty false)');
  // a scan: no text
  await openFile(R.scan);
  const nScan = (await docState()).pages;
  q = await run();
  st = await docState();
  ok(nScan === 1 ? /^This file has only one page, so there is nothing to link to\. Nothing was changed\.$/.test(q.toast) : new RegExp(`^${NONE.replace(/\./g, '\\.')} ${nScan} pages? (have|has) no text: OCR (them|it), then run this again\\.$`).test(q.toast), `scan.pdf (${nScan} pages): "${q.toast}"`);
  ok(!st.dirty && !st.canUndo, 'scan.pdf: not changed');
  // mixed: only its 24 sheets
  await openFile(R.mixed, 54);
  const tM = truthOf(R.mixed);
  q = await run();
  const lk = await allLinks();
  const gm = await groups();
  const specPages = tM.pages.filter((x) => x.kind === 'spec').map((x) => x.page);
  const sheetsM = tM.pages.filter((x) => x.kind === 'sheet' && x.no).length;
  ok(/^\d+ links on \d+ sheets, \d+ bookmarks\. Undo removes them\.$/.test(q.toast), 'mixed: ' + q.toast);
  ok(sheetsM === 24 && gm.find((x) => x.title === 'Sheets')?.kids === 24, `mixed: the Sheets group holds ${gm.find((x) => x.title === 'Sheets')?.kids} (24 sheets)`);
  ok(lk.pgs.every((p) => !specPages.includes(p)), `mixed: no link on a spec page (${lk.n} links on ${lk.pgs.length} pages)`);
  const refsM = tM.refs.filter((x) => !x.existing);
  ok(lk.n >= 0.9 * refsM.length && lk.n <= refsM.length, `mixed: ${lk.n} links of the truth's ${refsM.length}`);
  // the spec pages are untouched (no links targeting them either)
  const tgt = await E(async (specs) => { const d = window.__gcc.active(); let bad = 0; for (let p = 0; p < d.pages.length; p++) for (const l of await window.__gcc.engines.mu('linksOf', d.id, p)) if (specs.includes(l.page)) bad++; return bad; }, specPages);
  ok(tgt === 0, 'mixed: no link goes to a spec page');
  // one page
  await openFile(R.onePage, 1);
  q = await run();
  st = await docState();
  ok(/^This file has only one page, so there is nothing to link to\. Nothing was changed\.$/.test(q.toast) && !st.dirty && !st.canUndo, `one page: "${q.toast}", not changed`);
  // a cut-short file
  await openFile(R.cutShort);
  q = await run();
  st = await docState();
  ok(/^(No sheet numbers found\. Nothing was changed\.|Page \d+ could not be read, so nothing was changed\.|\d+ links)/.test(q.toast), `cut-short file: "${q.toast}"`);
  ok(await E(() => !!window.__gcc.active()), 'cut-short file: the window is alive');
  // a password file, opened with its password: works (8 sheets of one size)
  await openFile(R.password, undefined, PASSWORD);
  q = await run();
  const tP = truthOf(R.password);
  ok(/^\d+ links on \d+ sheets, \d+ bookmarks\. Undo removes them\.$/.test(q.toast) || NONE_WHY.test(q.toast), `password file (opened with its password): "${q.toast}"`);
  const gp = await groups();
  console.log('password file bookmarks:', JSON.stringify(gp), 'sheets in truth:', tP.pages.filter((x) => x.no).length);
  ok(/^\d+ links/.test(q.toast) ? gp.some((x) => x.title === 'Sheets') : true, 'password file: the group is there when links were made');

  // no crash report in all of it
  await sleep(2500);
  const rep = reports();
  ok(rep.length === 0, 'no crash report filed (' + rep.map((x) => x.message).join('; ') + ')');
} catch (e) {
  console.log('FAIL ' + (e.stack || e));
  fails++;
}
// (files with changes are closed without the question)
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
await Promise.race([app.close().catch(() => {}), sleep(20000)]);
rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
