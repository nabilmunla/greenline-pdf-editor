// PLAN 10.10 (H1): a heavy sheet touched in this session is still merged for display, in the real app.
//  1. page numbers added to every page while the heavy sheet (the last page) has not been looked at
//     yet; scroll to it: it is merged for display (the batch engine, from the file as opened - its
//     line work is still there) and its number shows. Before 10.10 it was drawn stroke by stroke:
//     the number made its content three parts with no filter, and every part had to be Flate.
//  2. a redaction applied on it: MuPDF writes its content as a new object with no filter - merged
//     in the editing engine (the batch engine reads the file as opened, where that object is not).
//  3. (10.10b) the sheet inserted into a light file, from the file and from a tab: merged too.
// The file: 30 light pages, then a generated sheet of 5 million strokes (tests/bench/gen-synthetic.py
// - merged for display, 4 million and up). Invented content only.
//   xvfb-run -a -s "-screen 0 2000x1200x24" node tests/e2e-heavy.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-e2e-heavy');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const SRC = join(TMP, 'sheet-5m.pdf'), F = join(TMP, 'set-31.pdf');
const LIGHT = 30, HEAVY = LIGHT; // (0-based: the sheet is page 31)
execFileSync('python3', ['tests/bench/gen-synthetic.py', SRC, '5000000', '7']);
{
  const d = mupdf.Document.openDocument(readFileSync(SRC), 'application/pdf').asPDF();
  for (let k = LIGHT - 1; k >= 0; k--) d.insertPage(0, d.addPage([0, 0, 595, 842], 0, {}, `0 0 1 RG 3 w 60 60 ${200 + k * 5} 300 re S`));
  writeFileSync(F, d.saveToBuffer('').asUint8Array());
}
rmSync(join(process.env.HOME, '.config', 'PDF Editor', 'profile-heavy1010'), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else fails++; return c; };
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); } return null; };

const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('.'), '--no-sandbox', '--profile=heavy1010'] });
const win = await app.firstWindow();
win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
const E = (fn, a) => win.evaluate(fn, a);
const logFile = join(await app.evaluate(({ app: a }) => a.getPath('userData')), 'logs', 'app.log');
const logText = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
/** red and black pixels drawn for page p */
const screen = (p) => E((pg) => {
  const n = { red: 0, black: 0 };
  for (const c of document.querySelectorAll(`.pg[data-page="${pg}"] canvas`)) {
    if (!c.width || !c.height) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 200) continue; if (d[i] > 170 && d[i + 1] < 80 && d[i + 2] < 80) n.red++; else if (d[i] < 70 && d[i + 1] < 70 && d[i + 2] < 70) n.black++; }
  }
  return n;
}, p);
const idle = () => E(() => { const s = window.__gcc.tiles.stats(); const d = window.__gcc.active(); return !s.queued && !s.inflight && !d.preparing.size; });
const looked = (p) => E((pg) => window.__gcc.active().looked.has(pg), p);

try {
  await until(() => E(() => !!window.__gcc));
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
  await until(() => E((n) => window.__gcc.active()?.pages.length === n, LIGHT + 1), 90000);
  ok(await E(() => window.__gcc.active().look), 'the set is looked at page by page (big enough)');
  await until(idle, 30000);
  ok(!(await looked(HEAVY)), 'the heavy sheet has not been looked at yet');

  // 1. page numbers on every page, the heavy sheet still unvisited
  const marks = [{ kind: 'text', text: '{page}', size: 260, bold: true, color: [1, 0, 0], pos: 'bc', my: 80 }];
  const n = await E((m) => window.__gcc.active().markPages(m, { file: 'set-31.pdf', date: '17 Nov' }), marks);
  ok(n === LIGHT + 1, `numbered ${n} pages`);
  ok(!(await looked(HEAVY)), 'still not looked at');
  const before = logText().length;
  const t0 = Date.now();
  await E((p) => window.__gcc.viewer().goTo(p), HEAVY);
  const line = await until(async () => /heavy page 31 merged for display in \d+ ms[^\n]*/.exec(logText().slice(before))?.[0], 180000);
  const tMerged = Date.now() - t0;
  ok(!!line, `scrolled to: the numbered sheet is merged for display (${line || 'no such line in the log'}; ${tMerged} ms after the scroll)`);
  ok(!!line && !/editing engine/.test(line), 'from the file as opened, in the batch engine (its line work is in the file)');
  const merge = /merged a heavy page: [^\n]*/.exec(logText().slice(before))?.[0];
  if (merge) console.log('   ' + merge);
  await until(async () => (await looked(HEAVY)) && (await idle()), 120000);
  const s1 = await until(async () => { const s = await screen(HEAVY); return s.red > 500 && s.black > 2000 ? s : null; }, 120000) || await screen(HEAVY);
  ok(s1.red > 500 && s1.black > 2000, `its number shows over the line work (red ${s1.red}, black ${s1.black}; ${Date.now() - t0} ms after the scroll)`);

  // 2. a redaction on it: its content becomes a new object with no filter - merged in the editing engine
  const before2 = logText().length;
  await E((p) => window.__gcc.active().create(p, { type: 'Redact', rect: [300, 300, 900, 700] }), HEAVY);
  const t1 = Date.now();
  const r = await E(() => window.__gcc.active().applyRedactions({ black: true }).then((x) => x, (e) => String(e)));
  const tRedact = Date.now() - t1;
  ok(r === 1, `redaction applied (${tRedact} ms)`);
  const line2 = await until(async () => /heavy page 31 merged for display in \d+ ms[^\n]*/.exec(logText().slice(before2))?.[0], 180000);
  ok(!!line2 && /editing engine/.test(line2), `the redacted sheet is merged for display again, in the editing engine (${line2 || 'no such line in the log'}; ${Date.now() - t1} ms after the redaction began)`);
  const err = /heavy page 31: [^\n]*/.exec(logText().slice(before2))?.[0];
  ok(!err, 'no merge error in the log' + (err ? ': ' + err : ''));
  await until(async () => (await looked(HEAVY)) && (await idle()), 120000);
  const s2 = await screen(HEAVY);
  ok(s2.red > 500 && s2.black > 2000, `drawn: the number and the line work (red ${s2.red}, black ${s2.black})`);
  const rs = await E(() => window.__gcc.engines.renderers.map((x) => x.restarts ?? 0));
  ok(rs.every((k) => k === 0), `no drawing engine restarted (${rs.join(', ')})`);

  // 3. (PLAN 10.10b) the sheet inserted into a light file - from the file, and from the sheet open in
  //    a tab: merged for display (in the editing engine: its objects are new there) and drawn, as in
  //    a heavy file opened directly. Before, a file opened under 2 MB was never looked at - the
  //    sheet was drawn stroke by stroke.
  const lights = ['light-a.pdf', 'light-b.pdf'].map((n) => join(TMP, n));
  for (const f of lights) {
    const d = new mupdf.PDFDocument();
    for (let k = 0; k < 3; k++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, `0 0 1 RG 3 w 60 60 ${200 + k * 20} 300 re S`));
    writeFileSync(f, d.saveToBuffer('').asUint8Array());
  }
  const openTab = async (f, n) => {
    await app.evaluate(({ BrowserWindow }, x) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [x]), f);
    await until(() => E((a) => window.__gcc.active()?.name === a.name && window.__gcc.active().pages.length === a.n, { name: f.split('/').pop(), n }), 90000);
    return E(() => window.__gcc.active().id);
  };
  const srcId = await openTab(SRC, 1);
  ok(await E(() => window.__gcc.active().look), 'the sheet open in a tab of its own is looked at (big enough)');
  for (const [k, how] of [[0, 'from the file'], [1, 'from the sheet open in a tab']]) {
    await openTab(lights[k], 3);
    ok(!(await E(() => window.__gcc.active().look)), `light file ${k + 1}: not looked at (opened under 2 MB)`);
    const from = logText().length;
    const t = Date.now();
    await E((a) => {
      const d = window.__gcc.active();
      return a.how ? d.insertFromOpen(1, window.__gcc.docs().find((x) => x.id === a.srcId)) : d.insertFrom(1, a.SRC);
    }, { how: k, srcId, SRC });
    ok(await E(() => window.__gcc.active().look), `inserted ${how}: the file is looked at from now on`);
    await E(() => window.__gcc.viewer().goTo(1));
    const m = await until(async () => /heavy page 2 merged for display in \d+ ms[^\n]*/.exec(logText().slice(from))?.[0], 180000);
    ok(!!m, `inserted ${how}: merged for display (${m || 'no such line in the log'}; ${Date.now() - t} ms after the insert began)`);
    const e3 = /heavy page 2: [^\n]*/.exec(logText().slice(from))?.[0];
    ok(!e3, 'no merge error in the log' + (e3 ? ': ' + e3 : ''));
    await until(async () => (await looked(1)) && (await idle()), 120000);
    const s3 = await until(async () => { const s = await screen(1); return s.black > 2000 ? s : null; }, 120000) || await screen(1);
    ok(s3.black > 2000, `drawn from the merged line work (black ${s3.black}; ${Date.now() - t} ms after the insert began)`);
  }
  const rs3 = await E(() => window.__gcc.engines.renderers.map((x) => x.restarts ?? 0));
  ok(rs3.every((k) => k === 0), `no drawing engine restarted (${rs3.join(', ')})`);
} catch (e) {
  ok(false, 'error: ' + (e?.message || e));
} finally {
  console.log(`\n${passes} passed, ${fails} failed`);
  const closed = await Promise.race([app.close().then(() => true, () => true), sleep(15000).then(() => false)]);
  if (!closed) { try { app.process().kill('SIGKILL'); } catch { /* gone */ } }
  rmSync(TMP, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
