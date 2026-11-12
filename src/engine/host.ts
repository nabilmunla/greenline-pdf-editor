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
  // (tests only - e2e-4gb: PDFED_TEST_FILL=2.1 takes the engine's memory up to 2.1 GB first, so
  // all its work lands past it)
  const fill = Number(process.env.PDFED_TEST_FILL);
  if (fill > 0) pf.fillBelow(fill * 2 ** 30, fill * 2 ** 30);
  return {
    open(id: string, src: VFile | Uint8Array, password?: string) { return pf.openDoc(id, src, password); },
    close(id: string) { pf.closeDoc(id); return true; },
    tile(id: string, page: number, scale: number, x: number, y: number, w: number, h: number) { return img(pf.render(id, page, scale, x, y, w, h), w, h); },
    thumb(id: string, page: number, scale: number, w: number, h: number, annots: boolean) { return img(pf.render(id, page, scale, 0, 0, w, h, annots), w, h); },
    chars(id: string, page: number) { const c = pf.chars(id, page); return { text: c.text, box: c.box }; },
    rangeRects(id: string, page: number, start: number, count: number) { return pf.rangeRects(id, page, start, count); },
    find(id: string, needle: string, from: number, to: number, matchCase: boolean, whole: boolean) { return pf.find(id, needle, from, to, matchCase, whole); },
    links(id: string, page: number) { return pf.links(id, page); },
    snap(id: string, page: number, x: number, y: number, r: number, from?: number[] | null) { return pf.snap(id, page, x, y, r, from); },
    prepareSnap(id: string, page: number) { return pf.buildSnap(id, page).n; },
    charsIn(id: string, page: number, r: number[]) { return pf.charsIn(id, page, r); },
    heap() { return pf.heapBytes(); },
    /** pages read in so far (tests) */
    pageStats() { return { ...pf.pageStats, heap: pf.heapBytes() }; },
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
/** not straight after starting (a page that needs that much would loop): 30 s, twice that for each
 *  planned restart of this engine in the last 10 minutes (the app counts them: PDFED_RECYCLES) -
 *  a page bigger than the restart point, worked on, restarted the engine every 30 s */
const MIN_UP = 30 * 2 ** Math.min(4, Number(process.env.PDFED_RECYCLES) || 0);
export async function renderRecycle(): Promise<boolean> {
  const pf = await import('./pdfium');
  // never straight after starting (a page that needs that much would loop)
  try { return process.uptime() > MIN_UP && pf.heapBytes() > RECYCLE_AT; } catch { return false; }
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
let dropMerge: (job: string) => void = () => {};

export async function editHandlers(): Promise<Record<string, Handler>> {
  const mu = await import('./mu');
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
  needsRecycle = () => guard.mupdfErrors() >= guard.MUPDF_ERROR_LIMIT;
  mu.setGlyphlessFont(new Uint8Array(fs.readFileSync(path.join(resDir, 'glyphless.ttf'))));
  // pages of millions of separate little strokes: merged when opened (see strokes.ts)
  const { mergeStrokes, MIN_STROKES } = await import('./strokes');
  /** about how many stroke operators ("S" between white space) - native searches, no parsing */
  const roughStrokes = (b: Buffer): number => {
    let n = 0;
    for (const pat of ['S\n', 'S ', 'S\r']) {
      const p = Buffer.from(pat);
      for (let i = b.indexOf(p); i >= 0 && n < MIN_STROKES; i = b.indexOf(p, i + 2)) { const c = b[i - 1]; if (c === 32 || c === 10 || c === 13) n++; }
    }
    return n;
  };
  mu.setContentMerger((parts, force) => {
    const t0 = Date.now();
    // (a page's content parts are one content: joined with a line break between them)
    const decs = parts.map((raw) => zlib.inflateSync(raw));
    const dec = decs.length === 1 ? decs[0] : Buffer.concat(decs.flatMap((b, k) => (k ? [Buffer.from('\n'), b] : [b])));
    // (a quick count first: a big but ordinary sheet - a couple of million strokes - is not
    // read through stroke by stroke for nothing; that cost seconds on opening)
    if (!force && (dec.length < MIN_STROKES * 10 || roughStrokes(dec) < MIN_STROKES * 0.8)) return null;
    // (asked for on a page that took the drawing engine down: any page of many strokes)
    const r = mergeStrokes(new Uint8Array(dec.buffer, dec.byteOffset, dec.byteLength), force ? 50_000 : MIN_STROKES);
    if (!r) return null;
    const out = zlib.deflateSync(r.out, { level: 6 });
    console.error(`merged a heavy page: ${r.strokesIn} strokes -> ${r.strokesOut}, ${Math.round(dec.length / 1e6)} -> ${Math.round(r.out.length / 1e6)} MB, ${Date.now() - t0} ms`);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  });
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
    close(id: string) { mu.close(id); sources.delete(id); return true; },
    /**
     * The current state as a file for the drawing engines: the original + a small file of
     * changes when possible (the original must still be the file that was opened).
     */
    drawSnapshot(id: string, full = false): FileSrc {
      const s = baseOrNull(id);
      const canDelta = !full && !!s;
      const out = tempPath(canDelta ? 'changes.bin' : 'snapshot.pdf');
      const r = mu.snapshotTo(id, (v, from) => writeView(out, v, canDelta ? from : 0), !canDelta, (fill) => writePieces(out, fill));
      return canDelta && r.base > 0 ? { path: s!.src.path, size: r.base, delta: out, mtime: s!.stat.mtime } : { path: out };
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
      const r = mu.snapshotTo(id, (v, from) => writeView(tmp, v, base ? from : 0), !base, (fill) => writePieces(tmp, fill));
      fs.renameSync(tmp, file);
      return base && r.base > 0 ? { base: { path: base.path, size: r.base, mtime: base.mtime } } : { base: null };
    },
    /** how the source file looked when opened (save over it changes that) */
    sourceOf(id: string) { return sources.get(id)?.src ?? null; },
    // ---- export to Word / Excel (src/engine/convert)
    exportBegin(id: string, src: VFile | Uint8Array, password: string | undefined, opts: import('./convert/model').ExportOpts) {
      const d = mu.openIn(src);
      if (d.needsPassword() && !(password && d.authenticatePassword(password))) { d.destroy?.(); throw new Error('This PDF needs its password.'); }
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
      const spill = tempPath('merge-streams.bin');
      merges.set(job, { st: mu.mergeStart(), spill, fd: fs.openSync(spill, 'w'), size: 0, pages: 0 });
      return true;
    },
    mergeAdd(job: string, name: string, src: VFile | Uint8Array, pages?: number[]) {
      const m = merges.get(job);
      if (!m) throw new Error('The merge was stopped.');
      const n = mu.mergeAddFile(m.st, name, src, (raw) => {
        const off = m.size;
        for (let w = 0; w < raw.length;) w += fs.writeSync(m.fd, raw, w, Math.min(16 << 20, raw.length - w));
        m.size += raw.length;
        return off;
      }, pages);
      m.pages += n;
      return { pages: n, total: m.pages };
    },
    /** the merged file, written into a temp file: {$file} */
    mergeFinish(job: string, bookmarks: boolean) {
      const m = merges.get(job);
      if (!m) throw new Error('The merge was stopped.');
      const target = tempPath('merged.pdf');
      const fd = fs.openSync(target, 'w');
      try {
        fs.closeSync(m.fd);
        m.fd = -1;
        const rd = fs.openSync(m.spill, 'r');
        try {
          const buf = Buffer.alloc(16 << 20);
          const out = (b: Uint8Array) => { for (let w = 0; w < b.length;) w += fs.writeSync(fd, b, w, b.length - w); };
          mu.mergeWrite(m.st, bookmarks, (b) => out(typeof b === 'string' ? Buffer.from(b, 'latin1') : b), (off, len) => {
            for (let done = 0; done < len;) {
              const k = fs.readSync(rd, buf, 0, Math.min(buf.length, len - done), off + done);
              if (k <= 0) throw new Error('The merge\'s temp file was cut short.');
              out(buf.subarray(0, k));
              done += k;
            }
          });
        } finally { fs.closeSync(rd); }
      } catch (e) { try { fs.closeSync(fd); } catch { /* closed */ } removeTemp([target]); dropMerge(job); throw e; }
      fs.closeSync(fd);
      dropMerge(job);
      return { $file: { path: target, size: fs.statSync(target).size } };
    },
    mergeEnd(job: string) { dropMerge(job); return true; },
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

let chain: Promise<void> = Promise.resolve();
let exiting = false;
let recycle: (() => Promise<boolean>) | null = null;
let calls = 0;

function serve(port: PortMain) {
  ports.push(port);
  port.on('close', () => { const k = ports.indexOf(port); if (k >= 0) ports.splice(k, 1); });
  port.on('message', (e) => {
    const { id, method, args, out } = e.data as { id: number; method: string; args: unknown[]; out?: boolean | string };
    chain = chain.then(async () => {
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
        if (out) {
          const target = typeof out === 'string' ? out : tempPath('out.pdf');
          if (!withSink) throw new Error('this engine does not write files');
          let wrote = false;
          // (a big file comes in pieces: the first opens the file, the rest go after it)
          let fd = -1;
          try {
            value = withSink((v) => {
              if (fd < 0) { fs.mkdirSync(path.dirname(target), { recursive: true }); fd = fs.openSync(target, 'w'); }
              for (let w = 0; w < v.length;) w += fs.writeSync(fd, v, w, Math.min(16 << 20, v.length - w));
              wrote = true;
            }, () => h(...a));
          } finally { if (fd >= 0) fs.closeSync(fd); }
          if (wrote) {
            const file = { $file: { path: target, size: fs.statSync(target).size } };
            if (value instanceof Uint8Array) value = file;
            else if (value && typeof value === 'object' && (value as { bytes?: unknown }).bytes instanceof Uint8Array) value = { ...(value as object), bytes: file };
          }
        } else value = await h(...a);
        port.postMessage({ id, ok: true, value });
      } catch (err) {
        failed = true;
        fatal = isFatal(err);
        // (a port the window has closed meanwhile can't take the answer: nobody is waiting for it)
        try { port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err), fatal }); } catch { /* gone */ }
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
    }).catch((err) => {
      // (the chain must never stay rejected: every later call would be skipped and the engine
      // would never answer again - the app looked frozen, with nothing in the log)
      console.error('engine call ' + method + ' failed outside its handler: ' + (err instanceof Error ? err.message : String(err)));
    });
  });
  port.start();
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
