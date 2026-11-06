// Engine fuzz: long random sequences of edits, undo/redo and saves on a document read from a
// file (as the app does), checking after every step that:
//  - undo gives back exactly the state before the step, redo the state after it
//  - every saved file opens (MuPDF and PDFium) with the right pages and markups
//  - saving over the file it reads from, then reopening the result, keeps working
//  - text on a deleted page / under a redaction is gone from the saved file
// FUZZ_SEEDS=1,2,3 FUZZ_STEPS=400 npx tsx --test tests/fuzz.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import * as pf from '../src/engine/pdfium';
import { VFile } from '../src/engine/files';
import { guardMupdf, mupdfErrors, traceMupdfErrors } from '../src/engine/mupdf-guard';
guardMupdf(mupdf);
const vf = (p: string) => Object.assign(new VFile({ path: p }), { path: p });
/** every engine call, so a failure can be replayed (tests/tmp-fuzz/fuzz-trace.json) */
const trace: unknown[] = [];
const M = new Proxy(mu, { get(t, k: string) {
  const v = (t as Record<string, unknown>)[k];
  if (typeof v !== 'function') return v;
  return (...a: unknown[]) => { trace.push([k, a.map((x) => (x instanceof VFile ? { $vfile: (x as unknown as { path: string }).path } : x))]); return (v as (...b: unknown[]) => unknown)(...a); };
} }) as typeof mu;
const failing = new Map<string, number>();
traceMupdfErrors((m, e) => { const k = m + ': ' + String((e as Error)?.message || e).slice(0, 60); failing.set(k, (failing.get(k) ?? 0) + 1); });

mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));
const TMP = resolve('tests/tmp-fuzz');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** a few pages of different sizes and rotations, each with a unique word */
function makeDoc(): Uint8Array {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const sizes: [number, number, number][] = [[595, 842, 0], [842, 595, 0], [595, 842, 90], [1191, 842, 0], [595, 842, 0], [842, 1191, 270]];
  sizes.forEach(([w, h, r], i) => {
    const p = d.addPage([0, 0, w, h], r, { Font: { F1: f } }, `BT /F1 18 Tf 72 ${h - 100} Td (PAGE${i}UNIQUE contract clause ${i}) Tj ET 0 0 1 RG 2 w 72 72 m ${w - 72} ${h - 72} l S`);
    d.insertPage(-1, p);
  });
  return d.saveToBuffer('compress').asUint8Array().slice();
}

type State = { n: number; ids: string };
function state(id: string): State {
  const n = mu.countPages(id);
  // the page list the engine keeps up to date must match the file
  const cached = mu.pageInfos(id), fresh = mu.freshPageInfos(id);
  assert.deepEqual(cached.map((p) => [Math.round(p.w), Math.round(p.h), p.rot, p.label]), fresh.map((p) => [Math.round(p.w), Math.round(p.h), p.rot, p.label]), 'cached page list out of date');
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(mu.annots(id, i).filter((a) => a.type !== 'Widget').map((a) => a.id).sort((x, y) => x - y).join(','));
  return { n, ids: ids.join('|') };
}

/** a saved file opens in both engines with the expected pages and markups */
function checkSaved(bytes: Uint8Array, want: State, label: string) {
  const d = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF()!;
  assert.ok(!d.wasRepaired(), label + ': saved file needed repair');
  assert.equal(d.countPages(), want.n, label + ': page count');
  const counts = want.ids.split('|').map((s) => (s ? s.split(',').length : 0));
  for (let i = 0; i < want.n; i++) {
    const got = d.loadPage(i).getAnnotations().filter((a) => a.getType() !== 'Popup' && a.getType() !== 'Link').length;
    assert.equal(got, counts[i], `${label}: markups on page ${i + 1}`);
  }
  d.destroy?.();
  pf.openDoc('chk', bytes);
  try {
    for (let i = 0; i < Math.min(want.n, 3); i++) pf.render('chk', i, 0.1, 0, 0, 40, 40);
  } finally { pf.closeDoc('chk'); }
}

test('engine fuzz: edits, undo/redo, saves, save-over and reopen', async () => {
  const { startPdfium } = pf;
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  const seeds = (process.env.FUZZ_SEEDS || '1,2,3').split(',').map(Number);
  const STEPS = Number(process.env.FUZZ_STEPS || 250);
  const SKIP = new Set((process.env.FUZZ_SKIP || '').split(',').filter(Boolean));
  for (const seed of seeds) {
    const R = rng(seed);
    const pick = <T,>(a: T[]) => a[Math.floor(R() * a.length)];
    const file = join(TMP, `s${seed}.pdf`);
    writeFileSync(file, makeDoc());
    let id = 's' + seed;
    let currentFile = file;
    M.open(id, vf(file), undefined, 'Fuzz');
    const undo: State[] = [];
    let redo: State[] = [];
    let gen = 0;
    const log: string[] = [];
    const anyAnnot = () => {
      const n = M.countPages(id);
      for (let t = 0; t < 8; t++) {
        const p = Math.floor(R() * n);
        const list = M.annots(id, p).filter((a) => a.irt == null && a.type !== 'Widget');
        if (list.length) return { page: p, a: pick(list) };
      }
      return null;
    };
    for (let step = 0; step < STEPS; step++) {
      // like the engine host: every call is its own task, so finished objects get freed
      await new Promise((r) => setImmediate(r));
      if (step % 25 === 0) { (globalThis as { gc?: () => void }).gc?.(); await new Promise((r) => setTimeout(r, 0)); if (process.env.FUZZ_MEM) console.log('  step', step, 'memory MB', Math.round(process.memoryUsage().arrayBuffers / 1e6), Math.round(process.memoryUsage().rss / 1e6)); }
      const n = M.countPages(id);
      const page = Math.floor(R() * n);
      const pi = M.pageInfos(id)[page];
      const rx = () => 20 + R() * (pi.w - 140), ry = () => 20 + R() * (pi.h - 140);
      const before = state(id);
      const r = R();
      let op = '';
      let changed = true;
      try {
        if (r < 0.2) {
          op = 'create';
          const x = rx(), y = ry();
          const kinds: M.AnnotSpec[] = [
            { type: 'Square', rect: [x, y, x + 80, y + 50], color: [1, 0, 0], bw: 2, cloudy: R() < 0.3 ? 1 : 0 },
            { type: 'Circle', rect: [x, y, x + 40, y + 40], color: [0, 0, 1], ic: [1, 1, 0], angle: R() < 0.5 ? 30 : 0 },
            { type: 'Line', line: [[x, y], [x + 90, y + 30]], le: ['None', 'ClosedArrow'], color: [0, 0.5, 0] },
            { type: 'Polygon', vertices: [[x, y], [x + 60, y], [x + 60, y + 60]], color: [1, 0, 1], kind: 'measure-area', contents: '12.5 m²' },
            { type: 'PolyLine', vertices: [[x, y], [x + 50, y + 10], [x + 90, y + 40]], kind: 'measure-polylength', contents: '7.20 m' },
            { type: 'Ink', ink: [[[x, y], [x + 10, y + 20], [x + 40, y + 5]]], color: [0, 0, 0] },
            { type: 'FreeText', rect: [x, y, x + 120, y + 30], contents: 'Note ' + step, font: { size: 11, color: [0, 0, 0] }, angle: R() < 0.3 ? 90 : 0 },
            { type: 'Highlight', quads: [[x, y, x + 100, y, x, y + 12, x + 100, y + 12]], color: [1, 1, 0] },
            { type: 'Stamp', rect: [x, y, x + 120, y + 40], design: { lines: [{ text: 'APPROVED', size: 16, bold: true }, { text: 'Fuzz', size: 8 }], color: [0, 0.4, 0], border: 'rounded' }, kind: 'stamp' },
            { type: 'Text', rect: [x, y, x + 20, y + 20], icon: 'Comment', contents: 'sticky' },
            { type: 'Redact', rect: [x, y, x + 60, y + 20] },
          ];
          { const allowed = process.env.FUZZ_KINDS ? process.env.FUZZ_KINDS.split(',').map(Number).map((i) => kinds[i]) : kinds; const k = pick(allowed); if (process.env.FUZZ_TRACE) console.log('step', step, 'create', k.type, k.kind || '', 'page', page); M.createAnnot(id, page, k); }
        } else if (r < 0.28) {
          const t = anyAnnot(); if (!t) { changed = false; } else if (SKIP.has('move')) { changed = false; } else { op = 'move'; M.moveAnnots(id, [{ page: t.page, id: t.a.id }], R() * 30 - 15, R() * 30 - 15); }
        } else if (r < 0.33) {
          const t = anyAnnot(); if (!t || t.a.locked) { changed = false; } else if (SKIP.has('resize')) { changed = false; } else { op = 'resize'; const b = t.a.box || t.a.rect; M.resizeAnnot(id, t.page, t.a.id, [b[0], b[1], b[2] + 20, b[3] + 10]); }
        } else if (r < 0.38) {
          const t = anyAnnot(); if (!t) { changed = false; } else if (SKIP.has('update')) { changed = false; } else { op = 'update'; M.updateAnnots(id, [{ page: t.page, id: t.a.id, patch: { color: [R(), R(), R()], contents: 'changed ' + step, locked: R() < 0.2 } }]); }
        } else if (r < 0.45) {
          const t = anyAnnot(); if (!t) { changed = false; } else if (SKIP.has('delete')) { changed = false; } else { op = 'delete'; changed = M.deleteAnnots(id, [{ page: t.page, id: t.a.id }]) > 0; }
        } else if (r < 0.5) {
          op = 'rotate'; if (SKIP.has('rotate')) changed = false; else M.rotatePages(id, [page], pick([90, 180, 270]));
        } else if (r < 0.54 && n > 1) {
          op = 'deletePage'; if (SKIP.has('deletePage')) changed = false; else M.deletePages(id, [page]);
        } else if (r < 0.58 && n < 14) {
          op = 'duplicate'; if (SKIP.has('duplicate')) changed = false; else { const order = [...Array(n).keys()]; order.splice(page, 0, page); M.arrangePages(id, order, 'dup'); }
        } else if (r < 0.61 && n > 1) {
          op = 'move pages'; if (SKIP.has('move pages')) changed = false; else { const order = [...Array(n).keys()]; const [m] = order.splice(page, 1); order.splice(Math.floor(R() * n), 0, m); M.arrangePages(id, order, 'mv'); }
        } else if (r < 0.64 && n < 14) {
          op = 'insertBlank'; if (SKIP.has('insertBlank')) changed = false; else M.insertBlank(id, Math.floor(R() * (n + 1)), 595, 842);
        } else if (r < 0.67) {
          op = 'flatten'; if (SKIP.has('flatten')) changed = false; else { const t = anyAnnot(); if (!t) changed = false; else M.flatten(id, [{ page: t.page, id: t.a.id }]); }
        } else if (r < 0.7) {
          op = 'ocr layer'; if (SKIP.has('ocr layer')) changed = false; else M.addTextLayer(id, page, [{ text: 'ocrword' + step, box: [rx(), 100, rx() + 60, 112] }, { text: 'مرحبا', box: [100, 200, 160, 214] }]);
        } else if (r < 0.72) {
          op = 'marks'; if (SKIP.has('marks')) changed = false; else M.markPages(id, [{ kind: 'text', text: 'Page {page} of {pages}', pos: 'bc', size: 9 }], { file: 'x.pdf', date: '2026-10-23', pageFrom: page, pageTo: page + 1 });
        } else if (r < 0.74) {
          op = 'redact'; if (SKIP.has('redact')) changed = false; else { const any = M.allAnnots(id).some((a) => a.type === 'Redact'); if (!any) changed = false; else M.applyRedactions(id, { black: true }); }
        } else if (r < 0.76) {
          op = 'edit text';
          if (SKIP.has('edit text')) changed = false; else {
          const lines = M.textBlocks(id, page).flatMap((b) => b.lines).filter((l) => /UNIQUE/.test(l.text));
          if (!lines.length) changed = false;
          else { const l = lines[0]; M.replaceText(id, page, [l.bbox], 'EDITED' + step, l.origin, { size: l.size, color: l.color }, l.dir); }
          }
        } else if (r < 0.775) {
          // copy / paste (here, or into another open file)
          const t = anyAnnot();
          if (!t || SKIP.has('copy')) changed = false;
          else if (R() < 0.3) { changed = false; op = 'copy out'; M.open('side', makeDoc()); const c = M.copyAnnots(id, [{ page: t.page, id: t.a.id }], 'side', Math.floor(R() * 3), 10, 10); assert.equal(c.length, 1); M.close('side'); }
          else { op = 'copy'; const c = M.copyAnnots(id, [{ page: t.page, id: t.a.id }], id, page, R() * 40, R() * 40); changed = c.length > 0; }
        } else if (r < 0.785) {
          // text box text: long, lines, tabs, Arabic (MuPDF's fallback), empty
          const list = M.allAnnots(id).filter((a) => a.type === 'FreeText' && !a.locked);
          if (!list.length || SKIP.has('text')) changed = false;
          else { op = 'text'; const a = pick(list); M.updateAnnots(id, [{ page: a.page, id: a.id, patch: { contents: pick(['', 'x', 'A much longer sentence that has to wrap over several lines of the text box '.repeat(3), 'one\ntwo\n\nfour', 'tab\there', 'مرحبا بالعالم', 'Ø12 @ 200 – “quoted” €5'] ), quadding: Math.floor(R() * 3), font: { size: pick([6, 9, 11, 18, 36]), color: [0, 0, 0], family: pick(['Helv', 'TiRo', 'Cour'] as const) } } }]); }
        } else if (r < 0.79) {
          // the file for the printer: opens, one sheet per page, everything burnt in
          changed = false; op = 'print';
          if (!SKIP.has('print')) {
            const pages = [...Array(n).keys()].filter(() => R() < 0.6);
            if (pages.length) {
              const out = M.printFile(id, { pages, region: R() < 0.2 ? [10, 10, 200, 150] : null, paper: R() < 0.2 ? null : { w: 595, h: 842 }, orient: pick(['auto', 'portrait', 'landscape'] as const), scale: pick(['fit', 'actual', 'shrink', 'custom'] as const), pct: 70, margin: 14, markups: R() < 0.7 });
              const d = mupdf.Document.openDocument(out, 'application/pdf').asPDF()!;
              assert.equal(d.countPages(), pages.length, 'print sheets');
              for (let i = 0; i < d.countPages(); i++) assert.equal((d.loadPage(i) as mupdf.PDFPage).getAnnotations().length, 0, 'print: markups burnt in');
              M.printPreview(id, { pages, paper: { w: 595, h: 842 }, orient: 'auto', scale: 'fit', margin: 14, markups: true }, 0, 300);
            }
          }
        } else if (r < 0.795) {
          op = 'setData'; if (SKIP.has('setData')) changed = false; else M.setData(id, { scales: { '*': { k: R(), label: '1:' + step } } });
        } else if (r < 0.92) {
          changed = false;
          if (undo.length && R() < 0.6 && !SKIP.has('undo')) {
            op = 'undo';
            const u = M.undo(id);
            assert.ok(u.ok, 'undo refused with history left');
            const want = undo.pop()!;
            redo.push(before);
            assert.deepEqual(state(id), want, `seed ${seed} step ${step}: undo of "${log[log.length - 1]}" did not restore the state`);
          } else if (redo.length && !SKIP.has('undo')) {
            op = 'redo';
            const u = M.redo(id);
            assert.ok(u.ok, 'redo refused');
            const want = redo.pop()!;
            undo.push(before);
            assert.deepEqual(state(id), want, `seed ${seed} step ${step}: redo did not give the state back`);
          }
        } else {
          changed = false;
          op = 'save'; if (SKIP.has('save')) { op = ''; } else {
          if (R() < 0.35) {
            // what the drawing engines get after a page change: the file + only the changes
            let snap: Uint8Array | null = null, base = 0;
            M.snapshotTo(id, (v, from) => { base = from; snap = v.slice(); });
            const src = readFileSync(currentFile);
            const whole = base > 0 ? Buffer.concat([src.subarray(0, base), Buffer.from(snap!.subarray(base))]) : Buffer.from(snap!);
            checkSaved(new Uint8Array(whole), before, `seed ${seed} step ${step} snapshot`);
          }
          const inc = R() < 0.6;
          const out = M.save(id, { incremental: inc });
          checkSaved(out, before, `seed ${seed} step ${step} save(${inc ? 'inc' : 'full'})`);
          if (R() < 0.4) {
            // save over the file it reads from, then reopen the saved file (history starts again)
            const next = join(TMP, `s${seed}-${++gen}.pdf`);
            currentFile = next;
            writeFileSync(next, out);
            M.close(id);
            id = `s${seed}g${gen}`;
            M.open(id, vf(next), undefined, 'Fuzz');
            assert.deepEqual(state(id).n, before.n, 'reopened page count');
            undo.length = 0; redo = [];
            op = 'save+reopen';
          }
          }
        }
      } catch (e) {
        // (into this test's own folder - tests/tmp may not exist, and the trace was lost with an ENOENT)
        try { writeFileSync(join(TMP, 'fuzz-trace.json'), JSON.stringify(trace)); console.log('replay trace:', join(TMP, 'fuzz-trace.json')); } catch (we) { console.log('trace not written:', (we as Error).message); }
        console.log('MuPDF errors so far:', mupdfErrors(), [...failing].sort((a, b) => b[1] - a[1]).slice(0, 12));
        throw new Error(`seed ${seed} step ${step} op ${op || "?"} failed: ${(e as Error).message}\nlast ops: ${log.slice(-40).join(", ")}`);
      }
      if (changed && op) { undo.push(before); redo = []; }
      if (op) log.push(op);
    }
    // the end: a full save leaves nothing deleted behind
    const final = state(id);
    const out = M.save(id, {});
    checkSaved(out, final, `seed ${seed} final`);
    const txt = new TextDecoder('latin1').decode(out);
    void txt;
    M.close(id);
    console.log('MuPDF errors so far:', mupdfErrors(), [...failing].sort((a, b) => b[1] - a[1]).slice(0, 12));
    console.log(`seed ${seed}: ${STEPS} steps ok (${log.filter((x) => x === 'undo').length} undos, ${log.filter((x) => x.startsWith('save')).length} saves, ${gen} reopens) – ${final.n} pages`);
  }
});

test('nothing deleted survives a save: deleted page text and redacted text are gone', () => {
  const file = join(TMP, 'gone.pdf');
  writeFileSync(file, makeDoc());
  mu.open('g', new VFile({ path: file }));
  mu.deletePages('g', [2]);
  const l = mu.textBlocks('g', 0).flatMap((b) => b.lines).find((x) => /PAGE0UNIQUE/.test(x.text))!;
  mu.createAnnot('g', 0, { type: 'Redact', rect: l.bbox });
  mu.applyRedactions('g', { black: true });
  // the big-file path saves "original + changes" - it must not be used after removals
  for (const inc of [true, false]) {
    const out = mu.save('g', { incremental: inc });
    const d = mupdf.Document.openDocument(out, 'application/pdf');
    let all = '';
    for (let i = 0; i < d.countPages(); i++) all += d.loadPage(i).toStructuredText('').asText();
    assert.ok(!/PAGE2UNIQUE/.test(all) && !/PAGE0UNIQUE/.test(all), 'text still readable');
    // and not hidden in the file either (streams decompressed by a clean re-save)
    const raw = mupdf.Document.openDocument(out, 'application/pdf').asPDF()!.saveToBuffer('decompress').asUint8Array();
    const s = new TextDecoder('latin1').decode(raw);
    assert.ok(!s.includes('PAGE2UNIQUE'), 'deleted page text still in the file');
    assert.ok(!s.includes('PAGE0UNIQUE'), 'redacted text still in the file');
  }
  mu.close('g');
});

test('page marks on "1, 3" mark pages 1 and 3 only; Bates numbers count the marked pages', () => {
  mu.open('m', makeDoc());
  mu.markPages('m', [{ kind: 'text', text: 'BATES{bates}', pos: 'br', size: 9 }], { file: 'x', date: 'd', batesPrefix: 'DOC', batesStart: 7, batesDigits: 3, pages: [0, 2] });
  const out = mu.save('m', {});
  const d = mupdf.Document.openDocument(out, 'application/pdf');
  const t = [0, 1, 2].map((i) => d.loadPage(i).toStructuredText('').asText());
  assert.ok(t[0].includes('BATESDOC007'), t[0]);
  assert.ok(!t[1].includes('BATES'), 'page 2 marked');
  assert.ok(t[2].includes('BATESDOC008'), t[2]);
  mu.close('m');
});

test('page labels (i, ii, 1, 2, A-1) survive deleting, moving, inserting pages - and undo', () => {
  const src = new mupdf.PDFDocument();
  for (let i = 0; i < 6; i++) src.insertPage(-1, src.addPage([0, 0, 595, 842], 0, {}, ''));
  const nums = src.newArray();
  const range = (at: number, s: string, p?: string) => { nums.push(at); const d = src.newDictionary(); d.put('S', src.newName(s)); if (p) d.put('P', src.newString(p)); nums.push(d); };
  range(0, 'r'); range(2, 'D'); range(5, 'D', 'A-');
  const pl = src.newDictionary(); pl.put('Nums', nums); src.getTrailer().get('Root').put('PageLabels', pl);
  mu.open('lab', src.saveToBuffer('').asUint8Array().slice());
  const L = () => { const c = mu.pageInfos('lab').map((p) => p.label).join(','); assert.equal(c, mu.freshPageInfos('lab').map((p) => p.label).join(','), 'cache = file'); return c; };
  assert.equal(L(), 'i,ii,1,2,3,A-1');
  mu.deletePages('lab', [3]); assert.equal(L(), 'i,ii,1,3,A-1', 'labels stay with their pages');
  mu.undo('lab'); assert.equal(L(), 'i,ii,1,2,3,A-1', 'undo brings the labels back (MuPDF lost them for good)');
  mu.arrangePages('lab', [5, 0, 1, 2, 3, 4]); assert.equal(L(), 'A-1,i,ii,1,2,3');
  mu.undo('lab'); mu.insertBlank('lab', 2, 595, 842); mu.undo('lab'); assert.equal(L(), 'i,ii,1,2,3,A-1');
  const d = mupdf.Document.openDocument(mu.save('lab'), 'application/pdf');
  assert.equal([...Array(d.countPages()).keys()].map((i) => d.loadPage(i).getLabel()).join(','), 'i,ii,1,2,3,A-1');
  mu.close('lab');
  // a file without labels gets none (MuPDF made up "1, 1, 2, 3" on insert)
  const n = new mupdf.PDFDocument();
  for (let i = 0; i < 3; i++) n.insertPage(-1, n.addPage([0, 0, 595, 842], 0, {}, ''));
  mu.open('nol', n.saveToBuffer('').asUint8Array().slice());
  mu.insertBlank('nol', 0, 595, 842);
  assert.equal(mu.freshPageInfos('nol').map((p) => p.label).join(','), '1,2,3,4');
  mu.close('nol');
});
