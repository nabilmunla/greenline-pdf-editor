// PLAN 10.3b (ENGINE-STUDY-2 R2): Extract pages in steps, to disk, as Combine does - on 10.19 (each
// wrapper one MuPDF reference), so what a step copied and wrote out is freed. Generated sets only
// (tests/gen/linkset.mjs: sheets of links, one shared action and one shared destination used by
// every sheet). The Insert part of 10.3 is 10.3a (plan-10-3.test.ts).
// The host runs here in this process with a fake port, as the window's would be (as cancel.test).
import '../src/engine/mupdf-pre.mjs';
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
/** this file run again by the second test, in a process of its own, to extract with 10.19 switched
 *  off (MuPDF's memory only grows: in this process its figure would be the first test's) */
const OFF_RUN = process.env.EXTRACT_BIG_OFF;
const test = (OFF_RUN ? () => {} : nodeTest) as typeof nodeTest;
// (before anything reads the work folder, which is under the temp folder)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-big-'));
process.env.TMPDIR = scratch; process.env.TEMP = scratch; process.env.TMP = scratch;
process.argv[2] = 'assets'; // (where host.ts looks for glyphless.ttf)

type Fn = (e: { data: any; ports?: any[] }) => void;
const parent: { fns: Fn[]; sent: any[] } = { fns: [], sent: [] };
(process as any).parentPort = { on(_ev: string, f: Fn) { parent.fns.push(f); }, postMessage(m: unknown) { parent.sent.push(m); } };

const mupdf = await import('mupdf');
const mu = await import('../src/engine/mu');
const { refsFixed, setRefsFixForTests } = await import('../src/engine/mupdf-refs');
const { startHost, editHandlers } = await import('../src/engine/host');
const { workDir, VFile } = await import('../src/engine/files');
// @ts-expect-error (a plain .mjs generator)
const { makeLinkSet } = await import('./gen/linkset.mjs');

const waiting = new Map<number, (m: any) => void>();
const listeners: Fn[] = [];
const port = {
  on(ev: string, f: Fn) { if (ev === 'message') listeners.push(f); },
  postMessage(m: any) { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } },
  start() {},
};
const post = (data: unknown) => { for (const f of listeners) f({ data }); };
let seq = 1;
const call = (method: string, args: unknown[], out?: boolean) => new Promise<any>((res) => { const id = seq++; waiting.set(id, res); post({ id, method, args, out }); });

startHost('edit', editHandlers(), mu.withSink);
for (let i = 0; i < 400 && !parent.sent.some((m) => m.type === 'ready'); i++) await new Promise((r) => setTimeout(r, 25));
assert.ok(parent.sent.some((m) => m.type === 'ready'), 'the host came up');
for (const f of parent.fns) f({ data: { type: 'port' }, ports: [port] });

const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
const leftOver = () => walk(workDir()).filter((p) => /extract-streams\.bin$|extracted\.pdf$/.test(p));
/** MuPDF's "cannot find object" lines while `f` runs (MuPDF writes them to stderr; the host logs its errors there too) */
async function findErrors<T>(f: () => Promise<T>): Promise<{ value: T; lines: number }> {
  let lines = 0;
  const w = process.stderr.write.bind(process.stderr), e = console.error;
  (process.stderr as any).write = (s: unknown, ...a: unknown[]) => { if (/cannot find object/.test(String(s))) lines++; return (w as any)(s, ...a); };
  console.error = (...a: unknown[]) => { if (/cannot find object/.test(a.join(' '))) lines++; e(...a); };
  try { return { value: await f(), lines }; } finally { (process.stderr as any).write = w; console.error = e; }
}
/** the window's Extract, as it was before 10.3b when there is no extractBig (the test then measures that) */
async function extractBig(job: string, id: string, pages: number[]) {
  const r = await call('extractBig', [job, id, pages]);
  if (!r.ok && /unknown call/.test(r.error)) return call('extract', [id, pages], true);
  return r;
}
/** a file's links: per page, each one's target (a page number, or the web address) */
function linksOf(file: string) {
  const d = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf').asPDF()!;
  const pageNo = new Map<number, number>();
  for (let i = 0; i < d.countPages(); i++) pageNo.set(d.findPage(i).asIndirect(), i);
  const target = (a: mupdf.PDFObject): string => {
    const dest = a.get('Dest');
    const act = a.get('A');
    const arr = !dest.isNull() ? dest : act.get('S').asName() === 'GoTo' ? act.get('D') : null;
    if (arr) return 'page ' + pageNo.get(arr.get(0).asIndirect());
    return act.get('URI').asString();
  };
  const pages: string[][] = [];
  let n = 0;
  for (let i = 0; i < d.countPages(); i++) {
    const an = d.findPage(i).get('Annots');
    const l: string[] = [];
    if (an.isArray()) for (let j = 0; j < an.length; j++) { l.push(target(an.get(j).resolve())); n++; }
    pages.push(l);
  }
  d.destroy?.();
  return { pages, n };
}
const MB = 2 ** 20;
/** the links of the 300-sheet extract (the first test), per sheet */
let links300: string[][] = [];

if (OFF_RUN) {
  // (the second test's run: the set extracted with MuPDF.js's references as they came)
  setRefsFixForTests(false);
  const o = await call('open', ['set', { $file: { path: OFF_RUN } }]);
  const before = mu.heap();
  const { value: r, lines } = await findErrors(() => extractBig('off', 'set', [...Array(300).keys()]));
  const got = r.ok ? linksOf(r.value.$file.path) : null;
  fs.writeFileSync(OFF_RUN + '.off.json', JSON.stringify({ open: o.ok, ok: r.ok, error: r.error, fixed: refsFixed(), before, peak: mu.heap(), lines, n: got?.n, pages: got?.pages }));
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

test('10.3b: a 300-sheet set with 300,000 links extracted whole - every link there, MuPDF under 600 MB, no read of an emptied object', async () => {
  // (first in this file: MuPDF's memory only grows, so its size after the call is the call's peak)
  const set = path.join(scratch, 'links-300.pdf');
  const made = makeLinkSet(set, 300, 1000);
  assert.equal(made.links, 300000);
  const o = await call('open', ['set', { $file: { path: set } }]);
  assert.equal(o.ok, true, o.error);
  const before = mu.heap();
  const t0 = Date.now();
  const { value: r, lines } = await findErrors(() => extractBig('x1', 'set', [...Array(300).keys()]));
  const ms = Date.now() - t0;
  assert.equal(r.ok, true, r.error);
  const peak = mu.heap();
  console.log(`   extract of 300 sheets / 300,000 links: ${ms} ms, MuPDF ${Math.round(before / MB)} -> ${Math.round(peak / MB)} MB, ${Math.round(r.value.$file.size / MB)} MB file`);
  // (0.12.1's extract, all at once in memory: 1,219 MB; in steps without 10.19: 1,380 MB)
  assert.ok(peak <= 600 * MB, `MuPDF's memory stayed under 600 MB (${Math.round(peak / MB)} MB)`);
  assert.equal(refsFixed(), true, 'MuPDF.js\'s references are fixed (10.19)');
  assert.equal(lines, 0, 'no "cannot find object" read of a link\'s emptied copy');
  const got = linksOf(r.value.$file.path);
  assert.equal(got.n, 300000, 'every link is there');
  assert.equal(got.pages.filter((l) => l[0] === 'page 0').length, 300, 'the shared action: on every sheet, to sheet 1');
  assert.equal(got.pages.filter((l) => l[1] === 'page 299').length, 300, 'the shared destination: on every sheet, to the last');
  assert.deepEqual(got.pages[5].slice(2, 4), ['page 6', 'https://example.com/sheet/6/3']);
  links300 = got.pages;
  fs.rmSync(r.value.$file.path, { force: true });
  assert.deepEqual(leftOver(), [], 'no spill file left');
  await call('close', ['set']);
});

test('10.3b: the same with MuPDF.js\'s references as they came (10.19 switched off) - the same links, only more memory', () => {
  const set = path.join(scratch, 'links-300.pdf');
  execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...process.env, EXTRACT_BIG_OFF: set }, stdio: 'ignore' });
  assert.ok(fs.existsSync(set + '.off.json'), 'the run without 10.19 answered');
  const off = JSON.parse(fs.readFileSync(set + '.off.json', 'utf8'));
  assert.equal(off.ok, true, off.error);
  assert.equal(off.fixed, false, 'it ran without 10.19');
  console.log(`   the same without 10.19: MuPDF ${Math.round(off.before / MB)} -> ${Math.round(off.peak / MB)} MB (only recorded)`);
  assert.equal(off.lines, 0);
  assert.equal(off.n, 300000, 'every link is there');
  assert.ok(links300.length === 300 && JSON.stringify(off.pages) === JSON.stringify(links300), 'each where it was with the fix');
});

/** a small file with markups, a reply, a filled-in field, links, a hidden layer, labels, bookmarks, a title */
function richPdf(): Uint8Array {
  const d = new mupdf.PDFDocument();
  const ocg = d.addObject({ Type: d.newName('OCG'), Name: d.newString('Clouds') });
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Properties: { oc1: ocg } }, '/OC /oc1 BDC 0 0 0 rg 100 100 200 200 re f EMC'));
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  d.getTrailer().get('Root').put('OCProperties', { OCGs: [ocg], D: { OFF: [ocg], Order: [ocg] } });
  const p1 = d.findPage(0);
  const tf = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Widget'), FT: d.newName('Tx'), T: d.newString('Checked by'), V: d.newString('A. N. Other'), Rect: [100, 600, 300, 620], P: p1, F: 4, DA: d.newString('/Helv 12 Tf 0 g') });
  const shared = d.addObject({ S: d.newName('GoTo'), D: [d.findPage(1), d.newName('Fit')] });
  const l1 = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Link'), Rect: [10, 10, 50, 30], Dest: [d.findPage(1), d.newName('Fit')] });
  const l2 = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Link'), Rect: [60, 10, 90, 30], A: shared });
  const l3 = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Link'), Rect: [10, 10, 50, 30], A: shared });
  p1.put('Annots', [tf, l1, l2]);
  d.findPage(2).put('Annots', [l3]);
  d.getTrailer().get('Root').put('AcroForm', d.addObject({ Fields: [tf], DA: d.newString('/Helv 0 Tf 0 g') }));
  d.setPageLabels(0, 'D', 'S-', 201);
  const it = d.outlineIterator();
  it.insert({ title: 'Sheet 2', uri: '#page=2', open: false } as never); it.next();
  it.insert({ title: 'Sheet 1', uri: '#page=1', open: false } as never);
  d.setMetaData('info:Title', 'Generated sheets');
  mu.open('rich0', d.saveToBuffer('').asUint8Array().slice(), undefined, 'Tester');
  const sq = mu.createAnnot('rich0', 0, { type: 'Square', rect: [100, 100, 200, 160], color: [1, 0, 0], contents: 'check this' });
  mu.createAnnot('rich0', 0, { type: 'Text', irt: sq.id, contents: 'agreed' });
  mu.createAnnot('rich0', 1, { type: 'Text', rect: [50, 50, 70, 70], contents: 'note on sheet 2' });
  const b = mu.save('rich0');
  mu.close('rich0');
  return b;
}
function describe(b: Uint8Array) {
  const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!;
  const pages = [...Array(d.countPages()).keys()].map((i) => {
    const p = d.loadPage(i) as mupdf.PDFPage;
    return {
      label: p.getLabel(),
      annots: p.getAnnotations().map((a) => a.getType() + (a.getObject().get('IRT').isNull() ? '' : '>' + (p.getAnnotations().find((x) => x.getObject().asIndirect() === a.getObject().get('IRT').asIndirect())?.getType() ?? '?')) + ':' + a.getContents()),
      fields: p.getWidgets().map((w) => w.getName() + '=' + w.getValue()),
      links: p.getLinks().map((l) => l.getURI()),
    };
  });
  const fields = d.getTrailer().get('Root', 'AcroForm', 'Fields');
  const off = d.getTrailer().get('Root', 'OCProperties', 'D', 'OFF');
  const conv = (items: any[] | undefined): any[] => (items || []).map((x) => [x.title, x.page, ...(x.down ? [conv(x.down)] : [])]);
  return { pages, fields: fields.isArray() ? fields.length : 0, off: off.isArray() ? off.length : 0, outline: conv(d.loadOutline() as any), title: d.getMetaData('info:Title') };
}

test('10.3b: the stepped extract makes the file extract makes - markups, replies, fields, links, layers, labels, bookmarks, title', async () => {
  const rich = path.join(scratch, 'rich.pdf');
  fs.writeFileSync(rich, richPdf());
  assert.equal((await call('open', ['rich', { $file: { path: rich } }])).ok, true);
  for (const pages of [[0], [1, 0], [0, 1, 2], [2, 0, 0]]) {
    const r = await call('extractBig', ['x-' + pages.join(), 'rich', pages]);
    assert.equal(r.ok, true, r.error);
    const ref = describe(mu.extract('rich', pages));
    assert.deepEqual(describe(new Uint8Array(fs.readFileSync(r.value.$file.path))), ref, 'pages ' + pages.join(', '));
    fs.rmSync(r.value.$file.path, { force: true });
  }
  assert.deepEqual(describe(mu.extract('rich', [1, 0])).pages[1].links, ['#page=1&view=Fit', '#page=1&view=Fit'], 'links to a page taken follow it');
  assert.deepEqual(describe(mu.extract('rich', [0])).pages[0].links, [], 'links to a page left behind are dropped');
  await call('close', ['rich']);
});

test('10.3b: links to a shared action or destination are kept or dropped by their target, decided from the source', async () => {
  // (40 sheets: written out 8 at a time, so the shared action's copy is emptied after the first step -
  // 10.3a's link test, here through Extract)
  const set = path.join(scratch, 'links-40.pdf');
  makeLinkSet(set, 40, 30);
  assert.equal((await call('open', ['s40', { $file: { path: set } }])).ok, true);
  // sheet 1 left behind: the shared action (to sheet 1) goes everywhere, and sheet 40's links to the next sheet
  const { value: r, lines } = await findErrors(() => call('extractBig', ['x40', 's40', [...Array(39).keys()].map((i) => i + 1)]));
  assert.equal(r.ok, true, r.error);
  assert.equal(lines, 0, 'no read of an emptied copy');
  const got = linksOf(r.value.$file.path);
  assert.equal(got.n, 39 * 30 - 39 - 3, 'every link but those to sheet 1');
  assert.ok(got.pages.every((l) => !l.includes('page undefined')), 'no link to a page that is not there');
  assert.ok(got.pages.every((l) => l[0] === 'page 38'), 'the shared destination (the last sheet) on every sheet');
  assert.deepEqual(got.pages[0].slice(1, 3), ['page 1', 'https://example.com/sheet/2/3'], 'sheet 2: its link to sheet 3 follows it');
  fs.rmSync(r.value.$file.path, { force: true });
  // all of it: every link, sheet 1's included
  const all = await findErrors(() => call('extractBig', ['x40b', 's40', [...Array(40).keys()]]));
  assert.equal(all.lines, 0);
  assert.equal(linksOf(all.value.value.$file.path).n, 40 * 30);
  fs.rmSync(all.value.value.$file.path, { force: true });
  await call('close', ['s40']);
});

test('10.3b: Cancel reaches a running extract between its steps; nothing is left in the temp folder', async () => {
  const set = path.join(scratch, 'links-80.pdf');
  makeLinkSet(set, 80, 30);
  assert.equal((await call('open', ['s80', { $file: { path: set } }])).ok, true);
  const gm = (mupdf as any).PDFGraftMap.prototype;
  const orig = gm.graftPage;
  let grafted = 0;
  gm.graftPage = function (this: unknown, ...a: unknown[]) {
    const r = orig.apply(this, a);
    if (++grafted === 1) setImmediate(() => post({ cancel: 'x80' }));
    return r;
  };
  let r: any;
  try { r = await call('extractBig', ['x80', 's80', [...Array(80).keys()]]); } finally { gm.graftPage = orig; }
  assert.equal(r.ok, false);
  assert.match(r.error, /stopped/);
  assert.ok(grafted < 80, `stopped before the last page (${grafted} of 80)`);
  assert.deepEqual(leftOver(), [], 'the spill file and the result so far are gone');
  // the next one runs
  const r2 = await call('extractBig', ['x80', 's80', [0, 1]]);
  assert.equal(r2.ok, true, r2.error);
  fs.rmSync(r2.value.$file.path, { force: true });
  await call('close', ['s80']);
});

test.after(() => { fs.rmSync(scratch, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50); });
