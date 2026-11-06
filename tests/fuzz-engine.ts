// Engine fuzzing: random sequences of real operations (markups of every kind incl. Arabic and PC
// fonts, moves, resizes, restyles, copies, deletes, page rotate/insert/delete/reorder/crop,
// text edits, redaction, flatten, undo/redo), with checks after every step:
//   - nothing throws (except errors the interface also shows as messages)
//   - undo then redo gives the same markups back
//   - every few steps: save -> opens again in MuPDF and PDFium with the same pages and markups
//   - at the end: undo all the way -> the original document (pages, no markups)
// 0.8.2: pages from another open file (insert, replace - long ones in several journal steps),
// bookmarks, links; undo/redo must give back the pages, bookmarks and links too.
// npx tsx tests/fuzz-engine.ts [seeds] [steps]
// (before MuPDF.js, as in the engine: the quick journal reads)
import '../src/engine/mupdf-pre.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import * as pf from '../src/engine/pdfium';
import { guardMupdf, mupdfErrors } from '../src/engine/mupdf-guard';

guardMupdf(mupdf);
mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));
const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
const SEEDS = Number(process.argv[2] || 6), STEPS = Number(process.argv[3] || 160);
mkdirSync('/tmp/claude-0/fuzz', { recursive: true });

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

function samples(): Record<string, Uint8Array> {
  const spec = new Uint8Array(readFileSync('tests/data/long-spec.pdf'));
  // a small mixed document: portrait, landscape, rotated 90 and 270, a cropped page
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const mk = (box: number[], rot: number, text: string) => { const p = d.addPage(box as mupdf.Rect, rot, { Font: { F1: f } }, `BT /F1 14 Tf 60 100 Td (${text}) Tj ET 0 0 1 RG 40 40 m 300 300 l S`); d.insertPage(-1, p); };
  mk([0, 0, 595, 842], 0, 'Portrait page A4');
  mk([0, 0, 842, 595], 0, 'Landscape page');
  mk([0, 0, 842, 595], 90, 'Rotated 90 drawing');
  mk([0, 0, 1191, 842], 270, 'Rotated 270 A3');
  const mixed = d.saveToBuffer('compress').asUint8Array().slice();
  // a 230-page set (inserted whole: more than 100 pages = several journal steps), with bookmarks
  const m = new mupdf.PDFDocument();
  const fm = m.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < 230; i++) m.insertPage(-1, m.addPage(i % 7 ? [0, 0, 595, 842] : [0, 0, 842, 595], i % 11 ? 0 : 90, { Font: { F1: fm } }, `BT /F1 20 Tf 60 100 Td (SET PAGE ${i + 1}) Tj ET`));
  const it = m.outlineIterator();
  it.insert({ title: 'Set start', uri: '#page=1', open: false } as never); it.next();
  it.insert({ title: 'Set page 120', uri: '#page=120', open: false } as never);
  m.findPage(3).put('Annots', [m.addObject({ Type: m.newName('Annot'), Subtype: m.newName('Link'), Rect: [10, 10, 60, 40], Dest: [m.findPage(150), m.newName('Fit')] })]);
  const many = m.saveToBuffer('compress').asUint8Array().slice();
  return { spec, mixed, many };
}

const AR = ['ملاحظة: يرجى مراجعة البند 4.2', 'الخرسانة المسلحة C40', 'تم'];
const LAT = ['Check slab level', 'See detail 4 / rev B', 'Price this item – €', ''];
const FAMS = ['Helv', 'TiRo', 'Cour', ...mu.fontFamilies().slice(0, 4)];
let fails = 0;
const failMsgs: string[] = [];
const fail = (seed: number, step: number, what: string) => { fails++; const m = `seed ${seed} step ${step}: ${what}`; failMsgs.push(m); console.log('FAIL ' + m); };
/** what a markup looks like, for comparing (rounded) */
const sig = (list: mu.AnnotData[]) => JSON.stringify(list.map((a) => [a.page, a.type, a.rect.map((v) => Math.round(v)), a.contents || '', a.font?.family || '', a.angle || 0]).sort());

// FUZZ_FROM=n: seeds n .. n+SEEDS-1
const FROM = Number(process.env.FUZZ_FROM || 1);
for (let seed = FROM; seed < FROM + SEEDS; seed++) {
  const R = rng(seed * 7919);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(R() * xs.length)];
  const num = (a: number, b: number) => a + R() * (b - a);
  const docs = samples();
  const name = seed % 2 ? 'spec' : 'mixed';
  const id = 'fz' + seed;
  const orig = docs[name];
  const info0 = mu.open(id, orig, undefined, 'Fuzz');
  const pages0 = info0.pages.length;
  const marks0 = JSON.stringify(mu.outlineFull(id).map((m) => [m.title, m.page]));
  // other files open beside it: pages are taken from them
  const srcSmall = id + 's', srcMany = id + 'm';
  mu.open(srcSmall, docs.mixed.slice(), undefined, 'Fuzz');
  mu.open(srcMany, docs.many, undefined, 'Fuzz');
  const srcOf = () => (R() < 0.3 ? srcMany : srcSmall);
  const pagesOf = (src: string) => { const n = mu.countPages(src); if (R() < 0.35) return undefined; const k = 1 + Math.floor(R() * Math.min(4, n)); return Array.from({ length: k }, () => Math.floor(R() * n)); };
  /** pages (size, turn), bookmarks and links of the first pages: undo/redo must give these back too */
  const state = () => JSON.stringify([mu.freshPageInfos(id).map((p) => [Math.round(p.w), Math.round(p.h), p.rot]), mu.outlineFull(id).map((m) => [m.title, m.page, m.children.length]), [0, 1].filter((i) => i < pageCount()).map((i) => mu.linksOf(id, i).map((l) => [l.uri, l.page]))]);
  const log: string[] = [];
  let step = 0;
  const pageCount = () => mu.countPages(id);
  const anyAnnot = () => { const all = mu.allAnnots(id).filter((a) => a.type !== 'Widget' && a.type !== 'Popup'); return all.length ? pick(all) : null; };
  const rectOn = (pg: number): mu.Rect => { const inf = mu.pageInfos(id)[pg]; const w = inf.w, h = inf.h; const x = num(10, w - 120), y = num(10, h - 80); return [x, y, x + num(30, 110), y + num(15, 70)]; };
  const ops: [string, number, () => void][] = [
    ['textbox', 6, () => { const pg = Math.floor(R() * pageCount()); const ar = R() < 0.4; mu.createAnnot(id, pg, { type: 'FreeText', rect: rectOn(pg), contents: ar ? pick(AR) : pick(LAT), color: R() < 0.5 ? [1, 1, 0.85] : null, bw: R() < 0.5 ? 1 : 0, font: { size: pick([8, 11, 14, 20]), color: [0, 0, 0], family: pick(FAMS), bold: R() < 0.3, italic: R() < 0.3 }, autoWidth: R() < 0.4 ? 250 : null, kind: R() < 0.2 ? 'typewriter' : 'textbox' } as mu.AnnotSpec); }],
    ['callout', 2, () => { const pg = Math.floor(R() * pageCount()); const r = rectOn(pg); mu.createAnnot(id, pg, { type: 'FreeText', rect: r, contents: pick([...AR, ...LAT]), color: [1, 1, 1], bw: 1, font: { size: 11, color: [0.8, 0, 0] }, intent: 'FreeTextCallout', callout: [[r[0] - 30, r[3] + 40]], kind: 'callout' } as mu.AnnotSpec); }],
    ['shape', 5, () => { const pg = Math.floor(R() * pageCount()); mu.createAnnot(id, pg, { type: pick(['Square', 'Circle']), rect: rectOn(pg), color: [0.8, 0.1, 0.1], bw: pick([0.5, 1.5, 3]), cloudy: R() < 0.3 ? 1 : 0 } as mu.AnnotSpec); }],
    ['line', 3, () => { const pg = Math.floor(R() * pageCount()); const r = rectOn(pg); mu.createAnnot(id, pg, { type: 'Line', line: [[r[0], r[1]], [r[2], r[3]]], color: [0, 0, 1], bw: 2, le: R() < 0.5 ? ['None', 'ClosedArrow'] : ['None', 'None'] } as mu.AnnotSpec); }],
    ['poly', 2, () => { const pg = Math.floor(R() * pageCount()); const r = rectOn(pg); mu.createAnnot(id, pg, { type: pick(['PolyLine', 'Polygon']), vertices: [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [(r[0] + r[2]) / 2, r[3] + 10]], color: [0, 0.5, 0], bw: 1.5 } as mu.AnnotSpec); }],
    ['ink', 2, () => { const pg = Math.floor(R() * pageCount()); const r = rectOn(pg); mu.createAnnot(id, pg, { type: 'Ink', ink: [[[r[0], r[1]], [r[0] + 10, r[1] + 20], [r[2], r[3]]]], color: [0, 0, 0], bw: 2 } as mu.AnnotSpec); }],
    ['note', 2, () => { const pg = Math.floor(R() * pageCount()); const r = rectOn(pg); mu.createAnnot(id, pg, { type: 'Text', rect: [r[0], r[1], r[0] + 20, r[1] + 20], contents: pick([...AR, ...LAT]), color: [1, 0.85, 0.2] } as mu.AnnotSpec); }],
    ['highlight', 3, () => { const pg = Math.floor(R() * pageCount()); const r = rectOn(pg); mu.createAnnot(id, pg, { type: pick(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']), quads: [[r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]]], color: [1, 0.9, 0], contents: 'hl' } as mu.AnnotSpec); }],
    ['move', 5, () => { const a = anyAnnot(); if (a) mu.moveAnnots(id, [{ page: a.page, id: a.id }], num(-40, 40), num(-40, 40)); }],
    ['resize', 3, () => { const a = anyAnnot(); if (a && ['Square', 'Circle', 'FreeText', 'Text'].includes(a.type)) { const r = a.rect; mu.resizeAnnot(id, a.page, a.id, [r[0], r[1], r[2] + num(-10, 50), r[3] + num(-5, 40)]); } }],
    ['restyle', 4, () => { const a = anyAnnot(); if (!a) return; const patch: Partial<mu.AnnotSpec> = a.type === 'FreeText' ? (R() < 0.5 ? { font: { size: pick([9, 12, 16]), color: [0, 0, 0.7], family: pick(FAMS), bold: R() < 0.5 } } : { contents: pick([...AR, ...LAT]) }) : { color: [R(), R(), R()], opacity: pick([1, 0.6]) }; mu.updateAnnots(id, [{ page: a.page, id: a.id, patch }]); }],
    ['turn', 2, () => { const a = anyAnnot(); if (a && ['Square', 'Circle', 'FreeText'].includes(a.type)) mu.updateAnnots(id, [{ page: a.page, id: a.id, patch: { angle: pick([15, 45, 90, -30]) } as Partial<mu.AnnotSpec> }]); }],
    ['copy', 2, () => { const a = anyAnnot(); if (a) mu.copyAnnots(id, [{ page: a.page, id: a.id }], id, Math.floor(R() * pageCount()), num(-20, 20), num(-20, 20)); }],
    ['delete', 3, () => { const a = anyAnnot(); if (a) mu.deleteAnnots(id, [{ page: a.page, id: a.id }]); }],
    ['rotate-page', 2, () => { mu.rotatePages(id, [Math.floor(R() * pageCount())], pick([90, -90, 180])); }],
    ['insert-page', 1, () => { mu.insertBlank(id, Math.floor(R() * (pageCount() + 1)), pick([595, 842]), pick([842, 595]), 1); }],
    ['delete-page', 1, () => { if (pageCount() > 1) mu.deletePages(id, [Math.floor(R() * pageCount())]); }],
    ['reorder', 1, () => { const n = pageCount(); if (n < 2 || n > 200) return; const order = [...Array(n).keys()]; const i = Math.floor(R() * n), j = Math.floor(R() * n); [order[i], order[j]] = [order[j], order[i]]; mu.arrangePages(id, order); }],
    ['crop', 1, () => { const pg = Math.floor(R() * pageCount()); const inf = mu.pageInfos(id)[pg]; mu.cropPages(id, [pg], [10, 10, inf.w - 10, inf.h - 10]); }],
    ['edit-text', 2, () => { const pg = Math.floor(R() * Math.min(3, pageCount())); const blocks = mu.textBlocks(id, pg); const lines = blocks.flatMap((b) => b.lines); if (!lines.length) return; const l = pick(lines); mu.replaceText(id, pg, [l.bbox], pick([...AR, 'Edited text 123', 'Ω unicode – ok']), l.origin, { size: l.size, color: [0, 0, 0] }, l.dir); }],
    ['redact-mark', 1, () => { const pg = Math.floor(R() * pageCount()); mu.createAnnot(id, pg, { type: 'Redact', rect: rectOn(pg) } as mu.AnnotSpec); }],
    ['redact-apply', 1, () => { if (mu.allAnnots(id).some((a) => a.type === 'Redact')) mu.applyRedactions(id, {}); }],
    ['flatten', 1, () => { const a = anyAnnot(); if (a && a.type !== 'Redact') mu.flatten(id, [{ page: a.page, id: a.id }]); }],
    ['insert-open', 2, () => { const src = srcOf(); mu.insertFromOpen(id, Math.floor(R() * (pageCount() + 1)), src, pagesOf(src)); }],
    ['replace', 2, () => { const src = srcOf(); const n = pageCount(); const t0 = Math.floor(R() * n); const run = Math.min(n - t0, 1 + Math.floor(R() * 2)); const targets = Array.from({ length: run }, (_, k) => t0 + k); const ns = mu.countPages(src); const list = R() < 0.15 && src === srcMany ? undefined : Array.from({ length: R() < 0.5 ? run : 1 + Math.floor(R() * 3) }, () => Math.floor(R() * ns)); if (list && list.length !== run && run === 1 && list.length < 1) return; if (!list && n - run + ns > 2000) return; mu.replacePages(id, targets, { open: src }, list); }],
    ['bookmarks', 2, () => { const items = mu.outlineFull(id); const n = pageCount(); const r = R(); if (r < 0.5 || !items.length) items.push({ title: 'Fuzz ' + step, page: Math.floor(R() * n), uri: null, open: false, children: [] }); else if (r < 0.7) items.splice(Math.floor(R() * items.length), 1); else if (r < 0.85) { const a = items.splice(Math.floor(R() * items.length), 1)[0]; items.splice(Math.floor(R() * (items.length + 1)), 0, a); } else { const a = pick(items); a.page = Math.floor(R() * n); a.repoint = true; a.title += ' *'; } mu.setOutline(id, items, 'Edit bookmarks'); }],
    ['link', 2, () => { const pg = Math.floor(R() * Math.min(2, pageCount())); const ls = mu.linksOf(id, pg); if (ls.length && R() < 0.4) { const l = pick(ls); mu.setLink(id, pg, l.k, R() < 0.5 ? null : { uri: 'https://example.com/' + step }); return; } const r = rectOn(pg); mu.addLink(id, pg, r, R() < 0.5 ? { page: Math.floor(R() * pageCount()) } : { uri: pick(['https://example.com/a', 'mailto:x@y.com']) }); }],
    ['undo', 6, () => { mu.undo(id); }],
    ['redo', 3, () => { mu.redo(id); }],
  ];
  const total = ops.reduce((s, o) => s + o[1], 0);
  const choose = () => { let x = R() * total; for (const o of ops) { x -= o[1]; if (x <= 0) return o; } return ops[0]; };
  const errs0 = mupdfErrors();
  for (step = 1; step <= STEPS; step++) {
    // (a turn of the event loop now and then: MuPDF.js frees its wrappers' memory in finalizers,
    // which never ran in a loop that never waited - the harness ran out of heap, not the engine,
    // which waits between every call)
    if (step % 4 === 0) await new Promise((r) => setImmediate(r));
    const [opName, , run] = choose();
    log.push(opName);
    if (process.env.FUZZ_TRACE) console.log(`  [${seed}:${step}] ${opName}`);
    const before = sig(mu.allAnnots(id));
    const st0 = opName === 'undo' || opName === 'redo' ? '' : state();
    if (process.env.FUZZ_TRACE) console.log('    (run)');
    try { run(); } catch (e) {
      const msg = String((e as Error).message || e);
      // messages the interface shows on purpose (nothing to undo, etc.)
      if (!/nothing to (undo|redo)|no page|locked/i.test(msg)) fail(seed, step, `${opName} threw: ${msg.slice(0, 200)}`);
      continue;
    }
    if (opName === 'undo' || opName === 'redo') continue;
    // undo + redo must give back exactly this state
    const after = sig(mu.allAnnots(id));
    const st1 = state();
    if (process.env.FUZZ_TRACE) console.log('    (undo/redo check)');
    if (st1 !== st0) {
      try {
        const h = mu.history(id).undo.length;
        mu.undo(id);
        if (state() !== st0) fail(seed, step, `${opName}: undo didn't restore pages / bookmarks / links`);
        if (sig(mu.allAnnots(id)) !== before) fail(seed, step, `${opName}: undo didn't restore the markups (page op)`);
        mu.redo(id);
        if (state() !== st1) fail(seed, step, `${opName}: redo didn't give the same pages / bookmarks / links`);
        if (mu.history(id).undo.length !== h) fail(seed, step, `${opName}: history length changed by undo + redo`);
      } catch (e) { fail(seed, step, `${opName}: undo/redo threw ${String((e as Error).message).slice(0, 160)}`); }
    } else if (after !== before) {
      try {
        mu.undo(id);
        const u = sig(mu.allAnnots(id));
        mu.redo(id);
        const r = sig(mu.allAnnots(id));
        if (u !== before) fail(seed, step, `${opName}: undo didn't restore the markups`);
        if (r !== after) fail(seed, step, `${opName}: redo didn't give the same markups`);
      } catch (e) { fail(seed, step, `${opName}: undo/redo threw ${String((e as Error).message).slice(0, 160)}`); }
    }
    if (step % 15 === 0 || step === STEPS) {
      try {
        const bytes = mu.save(id);
        const d = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF()!;
        if (d.countPages() !== pageCount()) fail(seed, step, `saved file has ${d.countPages()} pages, engine ${pageCount()}`);
        let n = 0;
        for (let i = 0; i < d.countPages(); i++) n += (d.loadPage(i) as mupdf.PDFPage).getAnnotations().filter((a) => !['Widget', 'Popup'].includes(a.getType())).length;
        const m = mu.allAnnots(id).filter((a) => !['Widget', 'Popup'].includes(a.type)).length;
        if (n !== m) fail(seed, step, `saved file has ${n} markups, engine ${m}`);
        pf.openDoc('chk', bytes);
        for (let i = 0; i < Math.min(3, d.countPages()); i++) pf.render('chk', i, 0.3, 0, 0, 120, 120, true);
        pf.closeDoc('chk');
        writeFileSync(`/tmp/claude-0/fuzz/seed${seed}.pdf`, bytes);
      } catch (e) { fail(seed, step, `save/reopen failed: ${String((e as Error).message).slice(0, 200)}`); }
    }
  }
  // undo everything: back to the original
  let guard = 0;
  try { while (guard++ < 2000) { const h = mu.history(id) as { canUndo?: boolean; undo?: string[] } & Record<string, unknown>; if (!(h.canUndo ?? (Array.isArray(h.undo) ? h.undo.length : 0))) break; mu.undo(id); } } catch (e) { fail(seed, STEPS, 'undo-all threw ' + String((e as Error).message).slice(0, 120)); }
  const left = mu.allAnnots(id).filter((a) => !['Widget', 'Popup'].includes(a.type));
  if (left.length) fail(seed, STEPS, `after undoing everything ${left.length} markups remain`);
  if (pageCount() !== pages0) fail(seed, STEPS, `after undoing everything ${pageCount()} pages, was ${pages0}`);
  if (JSON.stringify(mu.outlineFull(id).map((m) => [m.title, m.page])) !== marks0) fail(seed, STEPS, 'after undoing everything the bookmarks differ');
  const errs = mupdfErrors() - errs0;
  console.log(`seed ${seed} (${name}): ${STEPS} steps, MuPDF errors ${errs}, ops ${[...new Set(log)].length} kinds, JS heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB`);
  mu.close(id); mu.close(srcSmall); mu.close(srcMany);
}
console.log(fails ? `${fails} FAILED\n` + failMsgs.slice(0, 40).join('\n') : 'all passed');
process.exit(fails ? 1 : 0);
