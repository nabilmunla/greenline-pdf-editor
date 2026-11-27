/// <reference types="node" />
// An engine in its own background process (Electron utility process). If it runs out of
// memory on a monster scan only this process dies; the window stays, the app starts a new
// engine and reopens the files in it.
//
//   node host.mjs render <resources dir>   PDFium: page pictures, text positions, search
//   node host.mjs edit   <resources dir>   MuPDF: the document of record, saving, batch jobs
//
// Calls arrive on message ports (one per window): { id, method, args, out? }.
//  - an argument { $file: { path, size?, delta? } } becomes a file read on demand
//  - out: the finished file the call makes is written to a temp file (or the given path)
//    straight from engine memory, and comes back as { $file: { path, size } }
//  - pictures come back as { $img: 1, w, h, px }
import { CallQueue, VIEW_TILE, type QCall } from './callq';
import { offList } from './off';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { VFile, isFileSrc, tempPath, writeView, removeTemp, statOf, workDir, type FileSrc } from './files';

type Handler = (...a: any[]) => unknown;
interface PortMain { on(ev: 'message', f: (e: { data: any }) => void): void; on(ev: 'close', f: () => void): void; postMessage(m: unknown): void; start(): void }
const parentPort = (process as unknown as { parentPort: { on(ev: 'message', f: (e: { data: any; ports: PortMain[] }) => void): void; postMessage(m: unknown): void } }).parentPort;

const resDir = process.argv[2] || '.';

const img = (px: Uint8ClampedArray, w: number, h: number) => ({ $img: 1, w, h, px });

export async function renderHandlers(): Promise<Record<string, Handler>> {
  const pf = await import('./pdfium');
  const wasm = fs.readFileSync(path.join(resDir, 'pdfium.wasm'));
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  pf.setSlabRoom((bytes) => slabRoomFor(bytes, pf.heapBytes(), pf.memoryLimit(), os.freemem()));
  // (tests only - e2e-4gb: PDFED_TEST_FILL=2.1 takes the engine's memory up to 2.1 GB first, so
  // all its work lands past it)
  const fill = Number(process.env.PDFED_TEST_FILL);
  if (fill > 0) pf.fillBelow(fill * 2 ** 30, fill * 2 ** 30);
  // (PDFED_OFF=giveway: view tiles drawn in one call - the engines inherit the app's environment)
  pf.progressiveStats.on = !offList(process.env.PDFED_OFF, process.env.PDFED_ON).has('giveway');
  return {
    open(id: string, src: VFile | Uint8Array, password?: string) { return pf.openDoc(id, src, password); },
    close(id: string) { pf.closeDoc(id); return true; },
    tile(id: string, page: number, scale: number, x: number, y: number, w: number, h: number) { return img(pf.render(id, page, scale, x, y, w, h), w, h); },
    // (a tile of the view: dropped unrun once its scale is no longer wanted - see callq.ts)
    // (drawn in slices: short calls go in between, and it stops when no longer wanted - PLAN 7.5)
    async viewTile(id: string, page: number, scale: number, x: number, y: number, w: number, h: number) { return img(await pf.renderGivingWay(id, page, scale, x, y, w, h, giveWay), w, h); },
    thumb(id: string, page: number, scale: number, w: number, h: number, annots: boolean) { return img(pf.render(id, page, scale, 0, 0, w, h, annots), w, h); },
    chars(id: string, page: number, keep?: boolean) { const c = pf.chars(id, page, keep !== false); return { text: c.text, box: c.box }; },
    rangeRects(id: string, page: number, start: number, count: number) { return pf.rangeRects(id, page, start, count); },
    find(id: string, needle: string, from: number, to: number, matchCase: boolean, whole: boolean) { return pf.find(id, needle, from, to, matchCase, whole); },
    links(id: string, page: number) { return pf.links(id, page); },
    snap(id: string, page: number, x: number, y: number, r: number, from?: number[] | null) { return pf.snap(id, page, x, y, r, from); },
    prepareSnap(id: string, page: number) { return pf.buildSnap(id, page).n; },
    charsIn(id: string, page: number, r: number[]) { return pf.charsIn(id, page, r); },
    heap() { return pf.heapBytes(); },
    /** heap growth of the page's read-in (PLAN 7.3: a page that grew the engine by over 500 MB is pinned) */
    pageGrew(id: string, page: number) { return pf.pageGrew(id, page); },
    /** pages read in so far (tests) */
    pageStats() { return { ...pf.pageStats, progressive: { slices: pf.progressiveStats.slices, gaveWay: pf.progressiveStats.gaveWay }, heap: pf.heapBytes(), slabs: { ...pf.slabStats, held: pf.slabsHeld() } }; },
    /** plain text of pages [from, to) (AI assistant, translation) */
    texts(id: string, from: number, to: number) { const out: string[] = []; for (let i = from; i < to; i++) { try { out.push(pf.pageText(id, i)); } catch { out.push(''); } } return out; },
  };
}

/**
 * WebAssembly memory only ever grows. A drawing engine that has grown past this (a run of
 * monster scans) starts afresh: it finishes the call, exits, and the app starts a new one
 * and reopens the files in it - a fraction of a second, nothing lost.
 * The engine itself may grow to 4 GB (0.9.7; 2 GB before: a page whose pictures needed more
 * stopped the engine mid-drawing). Restarted earlier than that, by the PC's memory shared by the
 * window's drawing engines (2 to 4): 40% of the RAM between them, each at least 1.4 GB (as up
 * to 0.9.6) and at most 3 GB (1 GB left for the next page) - 16 GB with 4 engines: 1.6 GB each,
 * with 2: 3 GB. A single page that needs more still gets it (up to 4 GB): this is when to start
 * afresh, not a limit.
 */
const ENGINES = Number(process.env.PDFED_RENDERERS) || Math.max(2, Math.min(4, Math.floor((os.cpus().length || 4) / 3)));
const RECYCLE_AT = Number(process.env.PDFED_RECYCLE_AT) || Math.min(3 * 1024 ** 3, Math.max(1.4 * 1024 ** 3, (os.totalmem() * 0.4) / ENGINES));
/** the restart point for an engine whose memory can grow to `limit` bytes: never so close to it that
 *  a page read in at that point would stop the engine mid-call (a wasm that could not be lifted
 *  to 4 GB stops at 2 GB, below the 3 GB this may be set to) */
export const recycleAtFor = (limit: number, at = RECYCLE_AT) => Math.min(at, limit - 0.2 * 1024 ** 3);
/** not straight after starting (a page that needs that much would loop): 30 s, twice that for each
 *  planned restart of this engine in the last 10 minutes (the app counts them: PDFED_RECYCLES) -
 *  a page bigger than the restart point, worked on, restarted the engine every 30 s */
const MIN_UP = 30 * 2 ** Math.min(4, Number(process.env.PDFED_RECYCLES) || 0);
/** a protected file is copied decrypted for drawing its merged heavy pages up to this size (each
 *  drawing copy is then a whole one, made from a second copy in memory: an edit rewrites it) */
const PLAIN_MAX = 150e6;
/**
 * Room for a slab of `bytes` (PLAN 3.5): the engine's memory with it stays below the planned
 * restart point (a slab never brings a restart - or the 2/4 GB ceiling - closer), and the PC keeps
 * more than SLAB_FREE free.
 */
const SLAB_FREE = 1.5 * 1024 ** 3;
export const slabRoomFor = (bytes: number, heap: number, limit: number, free: number, at = RECYCLE_AT) => heap + bytes <= recycleAtFor(limit, at) && free - bytes > SLAB_FREE;
export async function renderRecycle(): Promise<boolean> {
  const pf = await import('./pdfium');
  // never straight after starting (a page that needs that much would loop)
  try { return process.uptime() > MIN_UP && pf.heapBytes() > recycleAtFor(pf.memoryLimit()); } catch { return false; }
}

/** where each open document reads from, and how that file looked when opened */
/** copied: the base is our own copy in the temp folder (the file was saved over); kept: that copy
 *  copied once more next to the recovery files (the temp folder is emptied at every start) */
interface Source { src: FileSrc; stat: { size: number; mtime: number } | null; copied?: boolean; kept?: { path: string; size: number; mtime: number } }
type Based = Source & { stat: { size: number; mtime: number } };
const sources = new Map<string, Source>();

/** a file written in pieces (a big one: never whole in memory) */
function writePieces(target: string, fill: (put: (b: string | Uint8Array) => void) => void) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, 'w');
  try {
    fill((b) => { const v = typeof b === 'string' ? Buffer.from(b, 'latin1') : b; for (let w = 0; w < v.length;) w += fs.writeSync(fd, v, w, Math.min(16 << 20, v.length - w)); });
  } finally { fs.closeSync(fd); }
}
/** merges under way (batch engine): the result so far, and the temp file its streams went to */
const merges = new Map<string, { st: import('./mu').MergeState; spill: string; fd: number; size: number; pages: number }>();
/** print jobs whose sheets are being made into pictures (printPicBegin) */
const pics = new Map<string, { st: import('./mu').PicState; spill: string; fd: number; size: number; src: VFile | null }>();
let dropPic: (job: string) => void = () => {};
/** jobs the window asked to stop ({ cancel: job } is taken at once, never queued - the engine is
 *  inside the job's call when it arrives). A long job reads this between its steps. */
const cancelled = new Set<string>();
export const isCancelled = (job: string) => cancelled.has(job);
let dropMerge: (job: string) => void = () => {};

/** MuPDF's memory in use, sent with every answer of a MuPDF engine (PLAN 10.5; null: not one) */
let heapNow: (() => number) | null = null;

export async function editHandlers(): Promise<Record<string, Handler>> {
  const mu = await import('./mu');
  heapNow = mu.heap;
  // (tests only - e2e-saveas-temp: PDFED_TEST_WHOLE_AT=1 gives the drawing engines a whole copy
  // after any change, as for a combined set over 600 MB)
  mu.setWholeAt(Number(process.env.PDFED_TEST_WHOLE_AT) || 0);
  const cv = await import('./convert/index');
  dropMerge = (job: string) => {
    const m = merges.get(job);
    if (!m) return;
    merges.delete(job);
    try { if (m.fd >= 0) fs.closeSync(m.fd); } catch { /* closed */ }
    removeTemp([m.spill]);
    mu.mergeDrop(m.st);
  };
  dropPic = (job: string) => {
    const m = pics.get(job);
    if (!m) return;
    pics.delete(job);
    try { if (m.fd >= 0) fs.closeSync(m.fd); } catch { /* closed */ }
    removeTemp([m.spill]);
    mu.picDrop(m.st);
    try { m.src?.close(); } catch { /* closed */ }
  };
  const guard = await import('./mupdf-guard');
  guard.guardMupdf(await import('mupdf'));
  // each one costs a little of MuPDF's stack: logged (app.log) so they can be found and avoided
  guard.traceMupdfErrors((m, e) => { const n = guard.mupdfErrors(); if (n <= 50 || n % 100 === 0) console.error(`mupdf error #${n} in ${m}: ${String((e as Error)?.message || e).slice(0, 120)}`); });
  // (errors whose stack was put back don't count: with the patched .wasm, none leak - mupdf-guard.ts)
  needsRecycle = () => guard.mupdfLeaks() >= guard.MUPDF_ERROR_LIMIT;
  mu.setGlyphlessFont(new Uint8Array(fs.readFileSync(path.join(resDir, 'glyphless.ttf'))));
  // pages of millions of separate little strokes: drawn from merged line work (see heavy.ts,
  // strokes.ts and mu.displayOverlay) - kept in a temp file the drawing engines read
  const heavy = await import('./heavy');
  mu.setContentMerger(heavy.makeMerger((line) => console.error(line)));
  mu.setDisplayStore((bytes) => { const p = tempPath('merged.bin'); writeView(p, bytes, 0); return { path: p, size: bytes.length }; });
  const { lastXref } = await import('./overlay');
  const tailOf = (p: string, size: number) => { const n = Math.min(4096, size); const b = new Uint8Array(n); const fd = fs.openSync(p, 'r'); try { fs.readSync(fd, b, 0, n, size - n); } finally { fs.closeSync(fd); } return b; };
  /** a merge's result (Combine, a big Extract) written to `target` from its spill file: {$file}.
   *  The target goes if the writing fails */
  const writeMerged = (st: import('./mu').MergeState, bookmarks: boolean, spill: string, target: string) => {
    const fd = fs.openSync(target, 'w');
    try {
      const rd = fs.openSync(spill, 'r');
      try {
        const buf = Buffer.alloc(16 << 20);
        const out = (b: Uint8Array) => { for (let w = 0; w < b.length;) w += fs.writeSync(fd, b, w, b.length - w); };
        mu.mergeWrite(st, bookmarks, (b) => out(typeof b === 'string' ? Buffer.from(b, 'latin1') : b), (off, len) => {
          for (let done = 0; done < len;) {
            const k = fs.readSync(rd, buf, 0, Math.min(buf.length, len - done), off + done);
            if (k <= 0) throw new Error('The merge\'s temp file was cut short.');
            out(buf.subarray(0, k));
            done += k;
          }
        });
      } finally { fs.closeSync(rd); }
    } catch (e) { try { fs.closeSync(fd); } catch { /* closed */ } removeTemp([target]); throw e; }
    fs.closeSync(fd);
    return { $file: { path: target, size: fs.statSync(target).size } };
  };
  const h: Record<string, Handler> = {};
  for (const [k, v] of Object.entries(mu)) if (typeof v === 'function') h[k] = v as Handler;
  Object.assign(h, {
    annotTile(id: string, page: number, scale: number, x: number, y: number, w: number, h2: number, hide: number[], pass?: 'hl' | 'rest' | 'all') {
      const px = mu.renderAnnots(id, page, scale, x, y, w, h2, hide, pass);
      return px ? img(px, w, h2) : null;
    },
    annotImage(id: string, page: number, aid: number, scale: number) {
      const r = mu.renderOne(id, page, aid, scale);
      return r ? { bmp: img(r.px, r.w, r.h), x: r.x, y: r.y, w: r.w, h: r.h } : null;
    },
    printSheet(id: string, opts: Parameters<typeof mu.printPreview>[1], index: number, px: number) {
      const r = mu.printPreview(id, opts, index, px);
      return r ? { bmp: img(r.px, r.w, r.h), W: r.W, H: r.H, x: r.x, y: r.y, s: r.s } : null;
    },
    pagePicture(src: VFile | Uint8Array, page: number, dpi: number, maxSide: number) {
      const t = mu.pagePicture(src, page, dpi, maxSide);
      return { bmp: img(t.px, t.w, t.h), w: t.w, h: t.h, s: t.s, pages: t.pages };
    },
    thumbOf(src: VFile | Uint8Array, page: number, width: number) {
      const t = mu.thumbOf(src, page, width);
      return { bmp: img(t.px, t.w, t.h), w: t.w, h: t.h, s: t.s };
    },
    close(id: string) {
      mu.close(id);
      // (the copy of the original that baseFor made is of no use once the document is closed)
      const s = sources.get(id);
      sources.delete(id);
      if (s?.copied) removeTemp([s.src.path]);
      return true;
    },
    /**
     * The current state as a file for the drawing engines: the original + a small file of
     * changes when possible (the original must still be the file that was opened).
     */
    drawSnapshot(id: string, full = false): FileSrc {
      const s = baseOrNull(id);
      // (a protected file with heavy pages drawn merged: a decrypted whole copy, up to PLAIN_MAX -
      // larger ones are drawn as they are; PLAN 4.3)
      const plain = mu.drawPlain(id) && (s?.stat.size ?? 0) <= PLAIN_MAX;
      const canDelta = !full && !!s && !plain;
      const out = tempPath(canDelta ? 'changes.bin' : 'snapshot.pdf');
      let r: { base: number };
      try { r = mu.snapshotTo(id, (v, from) => writeView(out, v, canDelta ? from : 0), !canDelta, (fill) => writePieces(out, fill), plain); } catch (e) {
        // (a throw leaves the temp folder made above with nothing in it: it goes)
        removeTemp([out]);
        throw e;
      }
      const delta = canDelta && r.base > 0;
      const src: FileSrc = delta ? { path: s!.src.path, size: r.base, delta: out, mtime: s!.stat.mtime } : { path: out };
      // heavy pages drawn from merged line work: one more update on top of the copy (display only)
      // (and the layers shown other than the file says: the same kind of update - PLAN 7.7)
      if (mu.displayFiles(id).length || mu.layerStateSet(id)) {
        try {
          const outSize = statOf(out)?.size ?? 0;
          const len = delta ? r.base + outSize : outSize;
          const prev = delta && !outSize ? lastXref(tailOf(s!.src.path, r.base)) : lastXref(tailOf(out, outSize));
          const extra = mu.displayOverlay(id, len, prev, plain);
          if (extra) src.extra = extra;
        } catch (e) {
          // (a throw here leaves the snapshot made above behind: it goes, as when making it failed)
          removeTemp([out]);
          throw e;
        }
      }
      return src;
    },
    /** recovery copy of unsaved work: written next to `file` as `file` (+ `.base.json` when it is only the changes) */
    writeRecovery(id: string, file: string, big: number) {
      const s = baseOrNull(id);
      const canDelta = !!s && !!s.stat && s.stat.size >= big;
      // the changes are written against a copy in the temp folder (the file was saved over): that
      // folder is emptied when the app starts - so the copy goes next to the recovery file (once)
      let base = canDelta ? { path: s!.src.path, mtime: s!.stat!.mtime } : null;
      // (a merged file or a new tab reads from a file in the temp folder too: same)
      const inTemp = path.resolve(s?.src.path || '').toLowerCase().startsWith((path.resolve(workDir()) + path.sep).toLowerCase());
      if (base && (s!.copied || inTemp)) {
        try {
          const keep = file.replace(/\.pdf$/i, '') + '.base.pdf';
          const k = s!.kept;
          const ks = k && k.path === keep ? statOf(keep) : null;
          if (!ks || ks.size !== k!.size || ks.mtime !== k!.mtime) {
            fs.copyFileSync(s!.src.path, keep);
            const st = statOf(keep)!;
            s!.kept = { path: keep, size: st.size, mtime: st.mtime };
          }
          base = { path: keep, mtime: s!.kept!.mtime };
        } catch { base = null; } // no room for it: a whole copy instead
      }
      const tmp = file + '.tmp';
      let r: { base: number };
      try {
        r = mu.snapshotTo(id, (v, from) => writeView(tmp, v, base ? from : 0), !base, (fill) => writePieces(tmp, fill));
        fs.renameSync(tmp, file);
      } catch (e) {
        // (a half-written copy is not left next to the file)
        try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
        throw e;
      }
      return base && r.base > 0 ? { base: { path: base.path, size: r.base, mtime: base.mtime } } : { base: null };
    },
    /** how the source file looked when opened (save over it changes that) */
    sourceOf(id: string) { return sources.get(id)?.src ?? null; },
    // ---- export to Word / Excel (src/engine/convert)
    exportBegin(id: string, src: VFile | Uint8Array, password: string | undefined, opts: import('./convert/model').ExportOpts) {
      const d = mu.openIn(src);
      if (d.needsPassword() && !(password && d.authenticatePassword(password))) { d.destroy?.(); throw new Error('This PDF needs its password.'); }
      if (opts.layers) { const pd = d.asPDF(); if (pd) mu.applyLayers(pd, new Map(Object.entries(opts.layers).map(([k, v]) => [Number(k), !!v]))); }
      return cv.exportBegin(id, d, opts, () => { if (!(src instanceof Uint8Array)) src.close(); });
    },
    exportRead: cv.exportRead,
    exportOcr: cv.exportOcr,
    exportPicture: cv.exportPicture,
    exportFinish(id: string) { return mu.emit(cv.exportFinish(id)); },
    exportEnd: cv.exportEnd,
    // ---- merge a big set a file at a time, straight to disk (see mu.mergeStart)
    mergeBegin(job: string) {
      dropMerge(job);
      cancelled.delete(job);
      const spill = tempPath('merge-streams.bin');
      merges.set(job, { st: mu.mergeStart(), spill, fd: fs.openSync(spill, 'w'), size: 0, pages: 0 });
      return true;
    },
    async mergeAdd(job: string, name: string, src: VFile | Uint8Array, pages?: number[], group?: string[]) {
      const m = merges.get(job);
      if (!m) throw new Error('The merge was stopped.');
      // (a stop that came while the engine was between two files)
      if (isCancelled(job)) { dropMerge(job); throw new Error('The merge was stopped.'); }
      // (in steps, with a moment between them: what a step let go of is freed then - see
      // mu.mergeFileSteps)
      const it = mu.mergeFileSteps(m.st, name, src, (raw) => {
        const off = m.size;
        for (let w = 0; w < raw.length;) w += fs.writeSync(m.fd, raw, w, Math.min(16 << 20, raw.length - w));
        m.size += raw.length;
        return off;
      }, pages, undefined, group);
      let r = it.next();
      while (!r.done) {
        await new Promise((res) => setImmediate(res));
        // (the window's Stop arrives here, between two steps: the generator is closed, the spill
        // file and the result so far are let go)
        if (isCancelled(job)) { it.return?.(0); dropMerge(job); throw new Error('The merge was stopped.'); }
        r = it.next();
      }
      const n = r.value;
      m.pages += n;
      return { pages: n, total: m.pages };
    },
    /** the merged file, written into a temp file: {$file} */
    mergeFinish(job: string, bookmarks: boolean) {
      const m = merges.get(job);
      if (!m) throw new Error('The merge was stopped.');
      try {
        fs.closeSync(m.fd);
        m.fd = -1;
        return writeMerged(m.st, bookmarks, m.spill, tempPath('merged.pdf'));
      } finally { dropMerge(job); }
    },
    /**
     * Extract pages of a big file (PLAN 10.3b), in steps like Combine's and straight to disk: the
     * new file in a temp file, {$file}. The window's { cancel: job } is read between the steps.
     */
    async extractBig(job: string, id: string, pages: number[]) {
      const spill = tempPath('extract-streams.bin');
      let fd = -1, size = 0;
      let st: import('./mu').MergeState | null = null;
      // (opened inside the try: a new document MuPDF has no memory for left the spill file and its
      // handle behind - sweep 0.13)
      try {
        fd = fs.openSync(spill, 'w');
        st = mu.mergeStart();
        const it = mu.extractSteps(st, id, pages, (raw) => {
          const off = size;
          for (let w = 0; w < raw.length;) w += fs.writeSync(fd, raw, w, Math.min(16 << 20, raw.length - w));
          size += raw.length;
          return off;
        });
        try {
          for (let r = it.next(); !r.done; r = it.next()) {
            // (a moment between the steps: what the garbage collector found let go of is freed then -
            // see mu.mergeFileSteps; most of it the steps let go of themselves, PLAN 10.3b)
            await new Promise((res) => setImmediate(res));
            if (isCancelled(job)) throw new Error('The extract was stopped.');
          }
        } finally { it.return?.(0); }
        fs.closeSync(fd);
        fd = -1;
        return writeMerged(st, false, spill, tempPath('extracted.pdf'));
      } finally {
        if (fd >= 0) try { fs.closeSync(fd); } catch { /* closed */ }
        removeTemp([spill]);
        if (st) mu.mergeDrop(st);
        cancelled.delete(job);
      }
    },
    mergeEnd(job: string) { dropMerge(job); return true; },
    /**
     * Print a big selection (PLAN 10.12): the print file made here, in the batch engine, from the
     * window's copy of the document (drawSnapshot - unsaved changes included) with the layers the
     * window shows, in steps like Extract's (the window's { cancel: job } is read between them),
     * written to a temp file - in pieces past the piece-wise limit. Answers as printFile does:
     * {$file}, or { bytes: {$file}, pictures }.
     */
    async printBig(job: string, src: VFile | Uint8Array, opts: import('./printlayout').PrintOpts, layers: Record<number, boolean> | null) {
      const t0 = Date.now();
      const target = tempPath('print.pdf');
      let fd = -1, size = 0;
      const put = (v: Uint8Array) => {
        if (fd < 0) fd = fs.openSync(target, 'w');
        for (let w = 0; w < v.length;) w += fs.writeSync(fd, v, w, Math.min(16 << 20, v.length - w));
        size += v.length;
      };
      const it = mu.printFrom(src, opts, layers);
      try {
        if (isCancelled(job)) throw new Error('The print was stopped.');
        // (the file is written by the last step: every step runs with the temp file as the sink)
        let r = mu.withSink(put, () => it.next());
        while (!r.done) {
          // (a moment between the steps: what a step let go of is freed then - see mu.mergeFileSteps)
          await new Promise((res) => setImmediate(res));
          if (isCancelled(job)) throw new Error('The print was stopped.');
          r = mu.withSink(put, () => it.next());
        }
        const v = r.value as Uint8Array | { bytes: Uint8Array; pictures: number[] };
        const rest = v instanceof Uint8Array ? v : v.bytes;
        if (rest.length) put(rest);
        if (fd >= 0) fs.closeSync(fd);
        fd = -1;
        const file = { $file: { path: target, size } };
        console.error(`print: ${opts.pages.length} sheets made in the batch engine (pid ${process.pid}) in ${Date.now() - t0} ms, ${Math.round(size / 2 ** 20)} MB`);
        return v instanceof Uint8Array ? file : { bytes: file, pictures: v.pictures };
      } catch (e) {
        it.return?.(new Uint8Array(0));
        if (fd >= 0) try { fs.closeSync(fd); } catch { /* closed */ }
        removeTemp([target]);
        throw e;
      } finally { cancelled.delete(job); }
    },
    // ---- print sheets made into pictures a sheet at a time, straight to disk (see mu.picStart)
    printPicBegin(job: string, src: VFile | Uint8Array) {
      dropPic(job);
      const spill = tempPath('print-pictures.bin');
      pics.set(job, { st: mu.picStart(src), spill, fd: fs.openSync(spill, 'w'), size: 0, src: src instanceof Uint8Array ? null : src });
      return true;
    },
    printPicSheet(job: string, k: number, gray: boolean) {
      const m = pics.get(job);
      if (!m) throw new Error('The print was stopped.');
      mu.picSheet(m.st, k, gray, (raw) => {
        const off = m.size;
        for (let w = 0; w < raw.length;) w += fs.writeSync(m.fd, raw, w, Math.min(16 << 20, raw.length - w));
        m.size += raw.length;
        return off;
      });
      return true;
    },
    /** the print file with its pictures, written into a temp file: {$file} */
    printPicFinish(job: string) {
      const m = pics.get(job);
      if (!m) throw new Error('The print was stopped.');
      const target = tempPath('print.pdf');
      const fd = fs.openSync(target, 'w');
      try {
        fs.closeSync(m.fd);
        m.fd = -1;
        const rd = fs.openSync(m.spill, 'r');
        try {
          const buf = Buffer.alloc(16 << 20);
          const out = (b: Uint8Array) => { for (let w = 0; w < b.length;) w += fs.writeSync(fd, b, w, b.length - w); };
          mu.picWrite(m.st, (b) => out(typeof b === 'string' ? Buffer.from(b, 'latin1') : b), (off, len) => {
            for (let done = 0; done < len;) {
              const k = fs.readSync(rd, buf, 0, Math.min(buf.length, len - done), off + done);
              if (k <= 0) throw new Error("The print's temp file was cut short.");
              out(buf.subarray(0, k));
              done += k;
            }
          });
        } finally { fs.closeSync(rd); }
      } catch (e) { try { fs.closeSync(fd); } catch { /* closed */ } removeTemp([target]); dropPic(job); throw e; }
      fs.closeSync(fd);
      dropPic(job);
      return { $file: { path: target, size: fs.statSync(target).size } };
    },
    printPicEnd(job: string) { dropPic(job); return true; },
  });
  // (tests only - e2e-editmem: PDFED_TEST_HEAP gives the engine a call that takes some of MuPDF's
  // memory and keeps it, so its heap passes the window's limits without a file that big)
  if (process.env.PDFED_TEST_HEAP) {
    const mupdf = await import('mupdf');
    const eaten: unknown[] = [];
    h.eatHeap = (mb: number) => { eaten.push(new mupdf.Buffer(new Uint8Array(mb << 20))); return mu.heap(); };
  }
  /**
   * The file the document's changes can be written against: the file it was opened from,
   * as long as that is unchanged. Saved over (or changed by someone): its old content -
   * which the document still reads through its open handle - is copied once to a temp
   * file, and changes are written against that from then on.
   */
  function baseFor(id: string): Based | null {
    const s = sources.get(id);
    if (!s || s.src.delta || !s.stat) return null;
    const st = statOf(s.src.path);
    if (st && st.size === s.stat.size && st.mtime === s.stat.mtime) return s as Based;
    const r = mu.readerOf(id);
    if (!r) return null;
    const copy = tempPath('base.pdf');
    try {
      const fd = fs.openSync(copy, 'w');
      try {
        const CH = 16 << 20;
        const buf = new Uint8Array(CH);
        for (let at = 0; at < r.size; at += CH) {
          const want = Math.min(CH, r.size - at);
          // (every piece in full: a short read - the file cut short by another program - gave a
          // short copy, and changes written against it landed at the wrong place)
          const n = r.read(buf, 0, want, at);
          if (n !== want) throw new Error('The file was changed by another program while open (it is shorter now).');
          for (let w = 0; w < n;) w += fs.writeSync(fd, buf, w, n - w);
        }
      } finally { fs.closeSync(fd); }
      const cs = statOf(copy);
      if (!cs || cs.size !== r.size) throw new Error('Could not keep a copy of the original file (is the disk full?).');
      const ns = { src: { path: copy }, stat: cs, copied: true };
      sources.set(id, ns);
      return ns;
    } catch (e) {
      // (a copy that failed - half written, disk full - is no use to anyone and can be big)
      removeTemp([copy]);
      throw e;
    }
  }

  /** baseFor, or null (a whole copy is written instead) when the base can't be had */
  function baseOrNull(id: string): Based | null {
    try { return baseFor(id); } catch (e) { console.error('base copy: ' + (e instanceof Error ? e.message : String(e))); return null; }
  }

  // remember sources of open documents
  const open = h.open;
  h.open = (id: string, src: VFile | Uint8Array, ...rest: unknown[]) => {
    const r = open(id, src, ...rest) as Record<string, unknown>;
    r.size = src instanceof Uint8Array ? src.length : src.size;
    const fsrc = (src as VFile & { $src?: FileSrc }).$src;
    // (how the file looked: from the handle the document reads through, taken when it was opened -
    // not by name after the whole open, by when another program may have saved over it)
    if (fsrc && !(r as { needsPassword?: boolean }).needsPassword) sources.set(id, { src: fsrc, stat: src instanceof VFile ? { ...src.opened } : statOf(fsrc.path) });
    else sources.delete(id);
    return r;
  };
  return h;
}

/** MuPDF's error count is near the point where it corrupts memory (see mupdf-guard.ts) */
let needsRecycle: () => boolean = () => false;
let recycleAsked = false;
const ports: PortMain[] = [];

const common: Record<string, Handler> = {
  rmTemp(paths: string[]) { removeTemp(paths); return true; },
  memory() { return process.memoryUsage().rss; },
  /** the app has saved what it needs: this engine ends after answering, a fresh one starts */
  exitNow() { exiting = true; setTimeout(() => process.exit(75), 20); return true; },
  // (tests only - e2e-hang: PDFED_TEST_HANG makes a call that never answers, a busy loop like a
  // damaged file that loops inside the engine)
  ...(process.env.PDFED_TEST_HANG ? { hang() { for (;;) { /* never ends */ } } } : {}),
};

type Sink = <T>(write: (v: Uint8Array) => void, run: () => T) => T;
let ready: Promise<Record<string, Handler>>;
let withSink: Sink | null = null;

// ---------------------------------------------------------------- calls

/** methods that keep the file open (the document reads from it later) */
const KEEPS = new Set(['open', 'batchOpen', 'exportBegin', 'printPicBegin']);

function inArgs(v: unknown, files: VFile[], depth = 0): unknown {
  if (!v || typeof v !== 'object' || depth > 4) return v;
  if (ArrayBuffer.isView(v)) return v;
  const f = (v as { $file?: unknown }).$file;
  if (f && isFileSrc(f)) {
    const vf = new VFile(f) as VFile & { $src?: FileSrc };
    vf.$src = f;
    files.push(vf);
    return vf;
  }
  if (Array.isArray(v)) return v.map((x) => inArgs(x, files, depth + 1));
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) o[k] = inArgs(x, files, depth + 1);
  return o;
}

function isFatal(e: unknown): boolean {
  if (e instanceof WebAssembly.RuntimeError) return true;
  const m = e instanceof Error ? e.message : String(e);
  return /^Aborted|memory access out of bounds|unreachable/i.test(m);
}

/**
 * Run a call whose finished file goes straight to disk (the `out` of a call): to a temp file, or
 * to the path given. The file is made as the first piece arrives; if the call throws after that,
 * the part written is removed (a big one left behind stayed until the next start).
 */
export function runToFile(sink: Sink | null, out: boolean | string, run: () => unknown): unknown {
  if (!sink) throw new Error('this engine does not write files');
  const target = typeof out === 'string' ? out : tempPath('out.pdf');
  let wrote = false;
  // (a big file comes in pieces: the first opens the file, the rest go after it)
  let fd = -1;
  let value: unknown;
  try {
    try {
      value = sink((v) => {
        if (fd < 0) { fs.mkdirSync(path.dirname(target), { recursive: true }); fd = fs.openSync(target, 'w'); }
        for (let w = 0; w < v.length;) w += fs.writeSync(fd, v, w, Math.min(16 << 20, v.length - w));
        wrote = true;
      }, run);
    } finally { if (fd >= 0) fs.closeSync(fd); }
    if (wrote) {
      const file = { $file: { path: target, size: fs.statSync(target).size } };
      if (value instanceof Uint8Array) value = file;
      else if (value && typeof value === 'object' && (value as { bytes?: unknown }).bytes instanceof Uint8Array) value = { ...(value as object), bytes: file };
    }
  } catch (e) {
    // (a path the caller gave is touched only if writing started; our own temp file always goes, with its folder)
    if (fd >= 0 || wrote) try { fs.rmSync(target, { force: true }); } catch { /* still open somewhere */ }
    if (typeof out !== 'string') removeTemp([target]);
    throw e;
  }
  return value;
}

let exiting = false;
let recycle: (() => Promise<boolean>) | null = null;
let calls = 0;

type Call = QCall & { port: PortMain; id: number; out?: boolean | string };
/** calls waiting, in the order they run (short calls ahead of tiles, stale view tiles dropped: PLAN 3.9) */
const queue = new CallQueue<Call>();
let arrived = 0;
let running = false;

function serve(port: PortMain) {
  ports.push(port);
  port.on('close', () => { const k = ports.indexOf(port); if (k >= 0) ports.splice(k, 1); });
  port.on('message', (e) => {
    const d = e.data as { id: number; method: string; args: unknown[]; out?: boolean | string; want?: { doc: string; scales: number[] | null; pages?: number[]; pairs?: [number, number][] }; cancel?: string };
    // (a job to stop: taken at once like `want` - the engine is inside that job's call)
    // (the most recent 64 kept: a Stop that comes after its job ended is never removed by the job -
    // sweep 0.13)
    if (d.cancel !== undefined) { cancelled.delete(d.cancel); cancelled.add(d.cancel); while (cancelled.size > 64) cancelled.delete(cancelled.values().next().value!); return; }
    // (the scales the window still wants for a document: taken at once, not queued)
    if (d.want) { queue.wantScales(d.want.doc, d.want.scales, d.want.pages, d.want.pairs); return; }
    queue.push({ port, id: d.id, method: d.method, args: d.args, out: d.out, seq: arrived++ });
    pump();
  });
  port.start();
}

function pump() {
  if (running || exiting) return;
  const { call, stale, jumped } = queue.next();
  for (const c of stale) { try { c.port.postMessage({ id: c.id, ok: false, error: 'stale tile', stale: true }); } catch { /* gone */ } }
  if (!call) return;
  running = true;
  if (jumped) { try { call.port.postMessage({ id: 0, running: call.id }); } catch { /* gone */ } }
  run(call).catch((err) => {
    // (the queue must never stop: every later call would wait for ever and the engine would never
    // answer again - the app looked frozen, with nothing in the log)
    console.error('engine call ' + call.method + ' failed outside its handler: ' + (err instanceof Error ? err.message : String(err)));
  }).finally(() => {
    running = false;
    // (the next call after the messages that came meanwhile: a short call or a change of view
    // arriving while a tile was drawn counts before the tiles queued)
    setImmediate(pump);
  });
}

/** the view tile being drawn (PLAN 7.5) */
let current: Call | null = null;
/**
 * A tile's pause: the messages that came meanwhile are taken in, the short calls waiting at the
 * front run now (in the order they came), and the answer says whether the tile is still wanted.
 */
async function giveWay(): Promise<boolean> {
  await new Promise((r) => setImmediate(r));
  for (let c = queue.takeShort(); c && !exiting; c = queue.takeShort()) {
    try { c.port.postMessage({ id: 0, running: c.id }); } catch { /* gone */ }
    await run(c);
  }
  return exiting || (!!current && queue.isStale(current));
}

async function run(call: Call) {
  const prev = current;
  if (call.method === VIEW_TILE) current = call;
  try { await runOne(call); } finally { current = prev; }
}

async function runOne({ port, id, method, args, out }: Call) {
  if (exiting) return; // the app starts a fresh engine and asks again
  const files: VFile[] = [];
  let fatal = false;
  let failed = false;
  try {
    const handlers = await ready;
    const h = handlers[method];
    if (!h) throw new Error('unknown call ' + method);
    const a = (args || []).map((x) => inArgs(x, files));
    let value: unknown;
    if (out) value = runToFile(withSink, out, () => h(...a));
    else value = await h(...a);
    port.postMessage({ id, ok: true, value, ...(heapNow ? { heap: heapNow() } : {}) });
  } catch (err) {
    failed = true;
    fatal = isFatal(err);
    // (a port the window has closed meanwhile can't take the answer: nobody is waiting for it)
    // (a tile that gave way - no longer wanted - is "stale": not drawn, nothing went wrong)
    const stale = !!(err as { stale?: boolean })?.stale;
    if (stale) { failed = false; queue.stale++; }
    try { port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err), fatal, ...(stale ? { stale: true } : {}), ...(heapNow && !fatal ? { heap: heapNow() } : {}) }); } catch { /* gone */ }
  } finally {
    if (failed || !KEEPS.has(method)) for (const f of files) f.close();
    else if (files.length > 1) for (const f of files.slice(1)) f.close();
  }
  calls++;
  // planned restart: tell the window (it writes fresh recovery copies, then calls exitNow)
  if (!recycleAsked && needsRecycle()) { recycleAsked = true; for (const p of ports) { try { p.postMessage({ id: 0, notice: 'recycle' }); } catch { /* a window that has gone */ } } }
  // (broken now: the calls queued behind this one are not run on it - a save run in those 50 ms
  // could write what a broken engine made over the person's file; they wait for the new engine,
  // which the window asks again)
  if (fatal) { exiting = true; parentPort.postMessage({ type: 'fatal' }); setTimeout(() => process.exit(70), 50); }
  else if (recycle && (await recycle())) { exiting = true; setTimeout(() => process.exit(75), 20); }
}

/** start serving: role = 'render' | 'edit' */
export function startHost(role: string, handlers: Promise<Record<string, Handler>>, sink?: Sink, recycleCheck?: () => Promise<boolean>) {
  withSink = sink ?? null;
  recycle = recycleCheck ?? null;
  ready = handlers.then((h) => ({ ...common, ...h }));
  parentPort.on('message', (e) => {
    if (e.data && e.data.type === 'port' && e.ports && e.ports[0]) serve(e.ports[0]);
  });
  ready.then(() => parentPort.postMessage({ type: 'ready', role, pid: process.pid }), (err) => {
    parentPort.postMessage({ type: 'failed', error: String((err && err.stack) || err) });
    setTimeout(() => process.exit(71), 50);
  });
}
