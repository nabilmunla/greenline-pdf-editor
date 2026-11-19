// PLAN 10.10 (H1): a heavy sheet touched in this session is still merged for display, in the real app.
//  0. (14.7) a page whose content is one stream of 107,375,183 bytes with no filter - a length
//     MuPDF.js refused to load whole ("compression bomb detected": its limit, 200 × the length,
//     wraps in 32 bits): it draws (PDFium has no such limit), a markup is added, Save works.
//  1. page numbers added to every page while the heavy sheet (the last page) has not been looked at
//     yet; scroll to it: it is merged for display (the batch engine, from the file as opened - its
//     line work is still there) and its number shows. Before 10.10 it was drawn stroke by stroke:
//     the number made its content three parts with no filter, and every part had to be Flate.
//  2. a redaction applied on it: MuPDF writes its content as a new object with no filter - merged
//     in the editing engine (the batch engine reads the file as opened, where that object is not).
//  2b. (14.1) Undo twice and Redo twice across that redaction: merged again each time, never a
//     missing merged copy; one more redaction: still one merged copy on disk.
//  3. (10.10b) the sheet inserted into a light file, from the file and from a tab: merged too.
//  4. (14.4) two more redactions on the sheet (the third and fourth applied in the session): each
//     page content a redaction writes is 175 MB unpacked, and the drawing copy built whole carried
//     them all - 0985986: "realloc (827430261 bytes) failed". Now written in pieces; then Save.
//     (14.8) The save in pieces packs that content (unpacked: 174 MB on disk); the file reopened
//     in the app is merged for display from the file, takes a markup and saves again.
//     Last: 10.3 refuses inserts once the editing engine has passed 1.7 GB, and this may take it there.
// The file: 30 light pages, then a generated sheet of 5 million strokes (tests/bench/gen-synthetic.py
// - merged for display, 4 million and up). Invented content only.
//   xvfb-run -a -s "-screen 0 2000x1200x24" node tests/e2e-heavy.mjs
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, openSync, writeSync, closeSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
// (MuPDF.js here as in the app: a stream over 100 MiB read whole at any length - PLAN 14.7)
import '../src/engine/mupdf-pre.mjs';
import * as mupdf from 'mupdf';

const TMP = resolve('tests/tmp-e2e-heavy');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const SRC = join(TMP, 'sheet-5m.pdf'), F = join(TMP, 'set-31.pdf'), LONG = join(TMP, 'long-stream.pdf');
const LIGHT = 30, HEAVY = LIGHT; // (0-based: the sheet is page 31)
execFileSync('python3', ['tests/bench/gen-synthetic.py', SRC, '5000000', '7']);
{
  const d = mupdf.Document.openDocument(readFileSync(SRC), 'application/pdf').asPDF();
  for (let k = LIGHT - 1; k >= 0; k--) d.insertPage(0, d.addPage([0, 0, 595, 842], 0, {}, `0 0 1 RG 3 w 60 60 ${200 + k * 5} 300 re S`));
  writeFileSync(F, d.saveToBuffer('').asUint8Array());
}
/** (14.7) one page: its content a word, a black box, then comment lines - one stream of `len` bytes, no filter */
function longStream(file, len) {
  const fd = openSync(file, 'w');
  let pos = 0;
  const offs = [];
  const put = (b) => { const v = typeof b === 'string' ? Buffer.from(b, 'latin1') : b; for (let w = 0; w < v.length;) w += writeSync(fd, v, w, v.length - w); pos += v.length; };
  put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  offs[1] = pos; put('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n');
  offs[2] = pos; put('2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n');
  offs[3] = pos; put('3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>\nendobj\n');
  offs[4] = pos; put(`4 0 obj\n<</Length ${len}>>\nstream\n`);
  const head = 'BT /F1 24 Tf 100 700 Td (LONGSTREAM) Tj ET 0 0 0 rg 100 100 300 200 re f\n';
  put(head);
  const line = Buffer.from('%' + 'x'.repeat(65534) + '\n', 'latin1');
  let left = len - head.length;
  while (left > line.length + 2) { put(line); left -= line.length; }
  put('%' + 'x'.repeat(left - 2) + '\n');
  put('\nendstream\nendobj\n');
  offs[5] = pos; put('5 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n');
  const x = pos;
  put('xref\n0 6\n0000000000 65535 f \n' + offs.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  put(`trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`);
  closeSync(fd);
}
longStream(LONG, 107_375_183);
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

  // 0. (PLAN 14.7) the long stream: drawn, a markup, Save - no "compression bomb" in the log; the tab closed after
  {
    const from = logText().length;
    await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), LONG);
    await until(() => E(() => window.__gcc.active()?.name === 'long-stream.pdf' && window.__gcc.active().pages.length === 1), 90000);
    const id = await E(() => window.__gcc.active().id);
    await until(idle, 60000);
    const s0 = await until(async () => { const v = await screen(0); return v.black > 2000 ? v : null; }, 60000) || await screen(0);
    ok(s0.black > 2000, `the long stream's page draws (black ${s0.black})`);
    await E(() => window.__gcc.active().create(0, { type: 'Square', rect: [300, 300, 450, 400], color: [1, 0, 0] }));
    const t = Date.now();
    const saved = await E(() => window.__gcc.active().save().then((x) => x, (e) => String(e)));
    ok(saved === true, `a markup added, Save: ${saved} (${Date.now() - t} ms, ${(statSync(LONG).size / 1e6).toFixed(1)} MB)`);
    await sleep(1000);
    const bad = /[^\n]*compression bomb[^\n]*/i.exec(logText().slice(from))?.[0];
    ok(!bad, 'no "compression bomb" in the log' + (bad ? ': ' + bad : ''));
    {
      const d = mupdf.Document.openDocument(readFileSync(LONG), 'application/pdf').asPDF();
      const pg = d.loadPage(0), text = pg.toStructuredText().asText(), marks = pg.getAnnotations().length;
      ok(d.countPages() === 1 && text.includes('LONGSTREAM') && marks === 1, `the saved file opens: ${d.countPages()} page, ${text.includes('LONGSTREAM') ? 'its text' : 'no text'}, ${marks} markup(s)`);
      d.destroy?.();
    }
    await win.locator(`.dtab[data-id="${id}"]`).click({ button: 'middle' });
    await until(() => E((x) => !window.__gcc.docs().some((d) => d.id === x), id), 20000);
    rmSync(LONG, { force: true });
  }

  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
  await until(() => E((n) => window.__gcc.active()?.pages.length === n, LIGHT + 1), 90000);
  ok(await E(() => window.__gcc.active().look), 'the set is looked at page by page (big enough)');
  const setId = await E(() => window.__gcc.active().id);
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

  // 2b. (PLAN 14.1) Undo and Redo across the redaction: the sheet is merged again by the path it
  //     has (0.13.0: the engine kept the entry of a merged copy the window had deleted - undo()
  //     rejected with "ENOENT ... merged.bin"); the merged copies on disk are one per sheet
  const merged = () => E(async () => {
    const d = window.__gcc.active();
    const named = (d.drawSrc?.extra ?? []).map((x) => x.path).filter((t) => t && t.endsWith('merged.bin'));
    return { temps: [...d.temps].filter((t) => t.endsWith('merged.bin')), named, engine: await window.__gcc.engines.mu('displayFiles', d.id) };
  });
  const onDisk = async (what) => {
    const m = await merged();
    const missing = m.temps.filter((t) => !existsSync(t));
    ok(!missing.length, `${what}: every merged.bin in the document's temp files is on disk (${m.temps.length}${missing.length ? '; missing ' + missing.join(', ') : ''})`);
    const live = m.temps.filter((t) => existsSync(t));
    ok(m.named.length === 1 && live.includes(m.named[0]) && m.engine.length === 1 && m.engine[0] === m.named[0], `${what}: one merged.bin for the sheet - named by the drawing copy, held by the engine, on disk (named ${m.named.length}, held ${m.engine.length})`);
    return live.length;
  };
  const across = async (dir, fromEngine, expect, what) => {
    const from = logText().length;
    const t = Date.now();
    const res = [];
    for (let k = 0; k < 2; k++) res.push(await E((x) => window.__gcc.active()[x]().then(() => 'ok', (e) => String(e)), dir));
    ok(res.every((x) => x === 'ok'), `${what}: ${dir}() resolves (${res.join(' | ')})`);
    const ln = await until(async () => /heavy page 31 merged for display in \d+ ms[^\n]*/.exec(logText().slice(from))?.[0], 180000);
    ok(!!ln && fromEngine.test(ln), `${what}: merged for display again (${ln || 'no such line in the log'}; ${Date.now() - t} ms after the first ${dir})`);
    await until(async () => (await looked(HEAVY)) && (await idle()), 120000);
    const bad = /[^\n]*(ENOENT|drawing part)[^\n]*/i.exec(logText().slice(from))?.[0];
    ok(!bad, `${what}: no ENOENT, no "drawing part" in the log` + (bad ? ': ' + bad : ''));
    const near = (v) => Math.abs(v.black - expect) <= expect * 0.05;
    const s = await until(async () => { const v = await screen(HEAVY); return near(v) ? v : null; }, 60000) || await screen(HEAVY);
    ok(near(s) && s.red > 500, `${what}: black pixels ${s.black} against ${expect} (within 5 %), number shown (red ${s.red})`);
    await onDisk(what);
  };
  await across('undo', /in \d+ ms$/, s1.black, 'two Undos: the black box gone');
  await across('redo', /editing engine/, s2.black, 'two Redos: the black box back');
  // (one more here: the third and fourth applied in the session are step 4 - PLAN 14.4)
  for (const [k, rect] of [[300, 120, 600, 260]].entries()) {
    const from = logText().length;
    await E((a) => window.__gcc.active().create(a.p, { type: 'Redact', rect: a.rect }), { p: HEAVY, rect });
    const rr = await E(() => window.__gcc.active().applyRedactions({ black: true }).then((x) => x, (e) => String(e)));
    const ln = await until(async () => /heavy page 31 merged for display in \d+ ms[^\n]*/.exec(logText().slice(from))?.[0], 180000);
    ok(rr === 1 && !!ln, `redaction ${k + 2} applied and merged for display (${ln || 'no such line in the log'})`);
    await until(async () => (await looked(HEAVY)) && (await idle()), 120000);
  }
  await sleep(1000);
  const live = await onDisk('one more redaction');
  ok(live === 1, `one more redaction: still one merged.bin of the document on disk (${live})`);

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

  // 4. (PLAN 14.4) back on the set: two more redactions on the sheet, applied one after another -
  //    what a redaction wrote anew (the page's content, unpacked) counts as put in, so the drawing
  //    copy is written in pieces once it is that big (0985986: the copy built whole failed,
  //    "realloc (827430261 bytes) failed"); 10.5's question, if it comes, answered Not now; then Save
  await win.locator(`.dtab[data-id="${setId}"]`).click();
  await until(() => E((id) => window.__gcc.active()?.id === id, setId), 20000);
  let asked = 0;
  const notNow = async () => { const b = win.locator('.toast button', { hasText: 'Not now' }); if (await b.count().catch(() => 0)) { await b.first().click().catch(() => {}); asked++; } };
  for (const [k, rect] of [[700, 120, 1000, 260], [300, 720, 600, 820]].entries()) {
    const from = logText().length;
    await notNow();
    await E((a) => window.__gcc.active().create(a.p, { type: 'Redact', rect: a.rect }), { p: HEAVY, rect });
    const t = Date.now();
    const rr = await E(() => window.__gcc.active().applyRedactions({ black: true }).then((x) => x, (e) => String(e)));
    const tApply = Date.now() - t;
    const ln = await until(async () => { await notNow(); return /heavy page 31 merged for display in \d+ ms[^\n]*/.exec(logText().slice(from))?.[0]; }, 180000);
    ok(rr === 1 && !!ln && /editing engine/.test(ln), `redaction ${k + 3} in the session applied (${rr}, ${tApply} ms) and merged for display (${ln || 'no such line in the log'})`);
    await until(async () => { await notNow(); return (await looked(HEAVY)) && (await idle()); }, 120000);
    const bad = /[^\n]*(realloc|ENOENT|drawing part)[^\n]*/i.exec(logText().slice(from))?.[0];
    ok(!bad, `redaction ${k + 3}: no "realloc", ENOENT or "drawing part" in the log` + (bad ? ': ' + bad : ''));
    console.log('   drawing copy: ' + await E(() => { const x = window.__gcc.active().drawSrc, b = (p) => (p || '').split(/[\\/]/).pop(); return x ? b(x.path) + (x.delta ? ' + ' + b(x.delta) : '') : 'none'; }));
  }
  await sleep(1000);
  await notNow();
  const live4 = await onDisk('two more redactions');
  ok(live4 === 1, `two more redactions: one merged.bin of the document on disk (${live4})`);
  const heap = () => E(() => window.__gcc.engines.editor.heap ?? 0);
  const heap4 = await heap();
  console.log(`   10.5's question: ${asked ? 'asked, answered Not now (' + asked + ')' : 'not asked'}; editing engine ${Math.round(heap4 / 1e6)} MB`);
  const from5 = logText().length;
  const t5 = Date.now();
  const saved = await E(() => window.__gcc.active().save().then((x) => x, (e) => String(e)));
  const tSave = Date.now() - t5, size5 = statSync(F).size, heap5 = await heap();
  // (PLAN 14.8: the sheet's content packed - the 14.4 build alone saved 174 MB; the whole save of 0985986 took 11.4 s)
  ok(saved === true && size5 < 60e6 && tSave < 5000, `Save: ${saved} (${tSave} ms, ${(size5 / 1e6).toFixed(1)} MB; under 5 s and 60 MB)`);
  ok(heap5 <= Math.max(heap4, 1512e6), `the editing engine's memory after Save: ${Math.round(heap5 / 1e6)} MB (before it ${Math.round(heap4 / 1e6)} MB; the 14.4 build alone 1,512 MB)`);
  const bad5 = /[^\n]*(compression bomb|realloc)[^\n]*/i.exec(logText().slice(from5))?.[0];
  ok(!bad5, 'no "compression bomb" or "realloc" in the log' + (bad5 ? ': ' + bad5 : ''));
  {
    const d = mupdf.Document.openDocument(readFileSync(F), 'application/pdf').asPDF();
    const c = d.findPage(HEAVY).get('Contents');
    let boxes = 0;
    for (const s of c.isArray() ? [...Array(c.length).keys()].map((k) => c.get(k)) : [c]) {
      const v = s.readStream().asUint8Array();
      boxes += (Buffer.from(v.subarray(Math.max(0, v.length - (256 << 10)))).toString('latin1').match(/0 0 0 rg\s+[-\d.]+ [-\d.]+ m\s+(?:[-\d.]+ [-\d.]+ l\s+){3}h\s+f/g) || []).length;
    }
    ok(d.countPages() === LIGHT + 1 && boxes === 4, `the saved file opens: ${d.countPages()} pages, ${boxes} black boxes on the sheet (4 applied)`);
    const big = (c.isArray() ? [...Array(c.length).keys()].map((k) => c.get(k)) : [c]).sort((a, b) => b.get('Length').asNumber() - a.get('Length').asNumber())[0];
    ok(String(big.get('Filter')) === '/FlateDecode', `the sheet's content is packed (${big.get('Filter')}, ${(big.get('Length').asNumber() / 1e6).toFixed(1)} MB)`);
    d.destroy?.();
  }
  // reopened in the app: merged for display from the file, a markup, Save again
  await win.locator(`.dtab[data-id="${setId}"]`).click({ button: 'middle' });
  await until(() => E((x) => !window.__gcc.docs().some((d) => d.id === x), setId), 20000);
  const from6 = logText().length;
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.send('app:open', [f]), F);
  await until(() => E((n) => window.__gcc.active()?.name === 'set-31.pdf' && window.__gcc.active().pages.length === n, LIGHT + 1), 90000);
  await until(idle, 30000);
  await E((p) => window.__gcc.viewer().goTo(p), HEAVY);
  const ln6 = await until(async () => { await notNow(); return /heavy page 31 merged for display in \d+ ms[^\n]*/.exec(logText().slice(from6))?.[0]; }, 180000);
  ok(!!ln6 && !/editing engine/.test(ln6), `reopened: the sheet is merged for display from the file (${ln6 || 'no such line in the log'})`);
  await until(async () => { await notNow(); return (await looked(HEAVY)) && (await idle()); }, 120000);
  await E((p) => window.__gcc.active().create(p, { type: 'Square', rect: [300, 300, 600, 500], color: [1, 0, 0] }), HEAVY);
  const t6 = Date.now();
  const saved6 = await E(() => window.__gcc.active().save().then((x) => x, (e) => String(e)));
  ok(saved6 === true, `reopened, a markup added, Save again: ${saved6} (${Date.now() - t6} ms, ${(statSync(F).size / 1e6).toFixed(1)} MB)`);
  const bad6 = /[^\n]*(compression bomb|realloc)[^\n]*/i.exec(logText().slice(from6))?.[0];
  ok(!bad6, 'reopened: no "compression bomb" or "realloc" in the log' + (bad6 ? ': ' + bad6 : ''));
} catch (e) {
  ok(false, 'error: ' + (e?.message || e));
} finally {
  console.log(`\n${passes} passed, ${fails} failed`);
  const closed = await Promise.race([app.close().then(() => true, () => true), sleep(15000).then(() => false)]);
  if (!closed) { try { app.process().kill('SIGKILL'); } catch { /* gone */ } }
  rmSync(TMP, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
