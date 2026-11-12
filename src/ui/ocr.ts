// OCR: Tesseract (WebAssembly, fully offline) with English and Arabic.
// Pages are drawn by PDFium at ~300 dpi, turned grey and handed over as PGM (fast,
// no PNG encoding), and the words come back with their boxes in page points.
import { createWorker, type Worker as TWorker } from 'tesseract.js';
import { rendererFor } from './engines';
import { isEngineDown } from '../engine/rpc';
import { prep } from './ocrprep';

export type OcrLang = 'eng' | 'ara' | 'eng+ara';
/** a language this app has (a stored setting from elsewhere - "eng+deu" - is English + Arabic,
 *  as the dialogs show it; it used to be asked of a server and fail) */
export const ocrLangOf = (l: unknown): OcrLang => (l === 'eng' || l === 'ara' || l === 'eng+ara' ? l : 'eng+ara');

interface Pool { lang: OcrLang; workers: TWorker[]; free: TWorker[]; waiting: { res(w: TWorker): void; rej(e: Error): void }[]; ended?: boolean }
/** engines per language, made once (two jobs starting together share one set); a set for a
 *  language no longer asked for is let go as soon as nothing uses it - jobs still running in
 *  that language finish first */
const pools = new Map<OcrLang, Promise<Pool>>();
let wanted: OcrLang | null = null;
/** jobs using each language's engines right now (taken before the engines are even made): a set
 *  in use is never let go - between two pages of a job it is idle for a moment, and another job
 *  in another language used to end it then, failing the first job ("OCR was stopped.") */
const using = new Map<OcrLang, number>();

/** Tesseract engines working at once: about one per physical core (threads / 2), leaving room for
 *  the window and the page engines; each holds ~150 MB with English + Arabic */
const size = () => { try { const n = Number(localStorage.getItem('ocr-engines')); if (n >= 1 && n <= 8) return Math.round(n); } catch { /* default */ } return Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))); };

async function makePool(lang: OcrLang): Promise<Pool> {
  const base = new URL('./ocr/', location.href).href;
  const make = () => createWorker(lang.split('+'), 1, {
    workerPath: base + 'worker.min.js',
    corePath: base + 'core',
    langPath: base + 'lang',
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false,
  });
  // (one engine that can't start: the ones already started are ended too - each holds ~150 MB -
  // not left running unseen while the next try starts more)
  const made = await Promise.allSettled(Array.from({ length: size() }, make));
  const workers = made.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  try {
    const bad = made.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (bad) throw bad.reason;
    for (const w of workers) await w.setParameters({ preserve_interword_spaces: '1' } as never);
  } catch (e) {
    for (const w of workers) void w.terminate().catch(() => {});
    throw e;
  }
  return { lang, workers, free: workers.slice(), waiting: [] };
}
async function getPool(lang: OcrLang): Promise<Pool> {
  wanted = lang;
  let pp = pools.get(lang);
  if (!pp) {
    const made = makePool(lang);
    pools.set(lang, made);
    made.catch(() => { if (pools.get(lang) === made) pools.delete(lang); });
    pp = made;
  }
  const p = await pp;
  letGoOfOthers();
  return p;
}
/** the engines of a language for a job: given back with release() when the job is done */
async function hold(lang: OcrLang): Promise<Pool> {
  using.set(lang, (using.get(lang) || 0) + 1);
  try { return await getPool(lang); } catch (e) { release(lang); throw e; }
}
function release(lang: OcrLang) {
  const n = (using.get(lang) || 1) - 1;
  if (n > 0) using.set(lang, n); else using.delete(lang);
  if (!n && lang !== wanted) letGoOfOthers();
}
const idle = (p: Pool) => !using.get(p.lang) && p.free.length === p.workers.length && !p.waiting.length;
function endPool(p: Pool) {
  p.ended = true;
  for (const w of p.workers) void w.terminate().catch(() => {});
  for (const q of p.waiting.splice(0)) q.rej(new Error('OCR was stopped.'));
}
function letGoOfOthers() {
  for (const [l, pp] of pools) {
    if (l === wanted) continue;
    void pp.then((p) => { if (l !== wanted && idle(p) && pools.get(l) === pp) { pools.delete(l); endPool(p); } }).catch(() => {});
  }
}

async function take(p: Pool): Promise<TWorker> {
  if (p.ended) throw new Error('OCR was stopped.');
  const w = p.free.pop();
  if (w) return w;
  return new Promise((res, rej) => p.waiting.push({ res, rej }));
}
function give(p: Pool, w: TWorker) {
  if (p.ended) return;
  const n = p.waiting.shift();
  if (n) n.res(w);
  else { p.free.push(w); if (p.lang !== wanted && idle(p)) letGoOfOthers(); }
}

export interface OcrWord { text: string; box: [number, number, number, number]; conf: number }

// preparing the pictures happens in background workers (fallback: here, same code)

let preps: { w: Worker; busy: number }[] | null = null;
let prepSeq = 1;
const prepWait = new Map<number, { res(b: Uint8Array): void; rej(e: Error): void }>();
function prepWorkers() {
  if (preps) return preps;
  preps = [];
  try {
    for (let k = 0, n = Math.max(1, Math.min(4, Math.ceil(size() / 2))); k < n; k++) {
      const w = new Worker(new URL('./ocrprep.worker.ts', import.meta.url), { type: 'module' });
      const me = { w, busy: 0 };
      w.onmessage = (e: MessageEvent<{ id: number; pgm?: Uint8Array; error?: string }>) => {
        const q = prepWait.get(e.data.id);
        me.busy--;
        if (!q) return;
        prepWait.delete(e.data.id);
        if (e.data.pgm) q.res(e.data.pgm); else q.rej(new Error(e.data.error || 'OCR preparation failed'));
      };
      // a broken worker (it answers every page itself, so: one that could not start): everything
      // waiting fails once, the other workers are ended (not left in memory), later pages are
      // prepared in the window
      w.onerror = () => {
        const all = preps || [];
        preps = [];
        for (const x of all) x.w.terminate();
        for (const q of prepWait.values()) q.rej(new Error('OCR preparation stopped - try again'));
        prepWait.clear();
      };
      preps.push(me);
    }
  } catch { preps = []; }
  return preps;
}
async function prepPgm(bmp: ImageBitmap, W: number, H: number, quarter: number, denoise: number): Promise<Uint8Array> {
  const ws = prepWorkers();
  if (!ws.length) return prep(bmp, W, H, quarter, denoise);
  const me = ws.reduce((a, b) => (b.busy < a.busy ? b : a));
  const id = prepSeq++;
  me.busy++;
  return new Promise((res, rej) => { prepWait.set(id, { res, rej }); me.w.postMessage({ id, bmp, W, H, quarter, denoise }, [bmp]); });
}

/** render part of a page grey at `dpi`, de-speckled and contrast-stretched, as a PGM image (optionally turned by 90° steps) */
async function pagePgm(docId: string, page: number, pw: number, ph: number, rect: number[] | null, dpi: number, quarter = 0, denoise = 1) {
  const r = rect || [0, 0, pw, ph];
  let scale = dpi / 72;
  const maxSide = 7000;
  scale = Math.min(scale, maxSide / Math.max(r[2] - r[0], r[3] - r[1]));
  const W = Math.max(1, Math.round((r[2] - r[0]) * scale)), H = Math.max(1, Math.round((r[3] - r[1]) * scale));
  const tile = () => rendererFor(docId, page).call<ImageBitmap>('tile', [docId, page, scale, Math.round(r[0] * scale), Math.round(r[1] * scale), W, H]);
  // (the drawing engine went down or restarted while drawing it: once more, on the new engine -
  // the file is reopened there first)
  const bmp = await tile().catch(async (e: unknown) => { if (!isEngineDown(e)) throw e; await new Promise((res) => setTimeout(res, 1500)); return tile(); });
  const turned = quarter % 2 === 1;
  const OW = turned ? H : W, OH = turned ? W : H;
  const pgm = await prepPgm(bmp, W, H, quarter, denoise);
  return { pgm, scale, ox: r[0], oy: r[1], W, H, OW, OH, quarter };
}

interface Raw { words: { text: string; conf: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[]; angle: number; conf: number }

async function recognise(p: Pool, pgm: Uint8Array): Promise<Raw> {
  const w = await take(p);
  try {
    // rotateAuto: Tesseract straightens slightly crooked scans itself
    const r = await w.recognize(pgm as unknown as Blob, { rotateAuto: true }, { blocks: true, text: false });
    const words: Raw['words'] = [];
    for (const b of r.data.blocks || []) for (const para of b.paragraphs) for (const line of para.lines) for (const wd of line.words) {
      const t = wd.text.trim();
      if (t) words.push({ text: t, conf: wd.confidence, bbox: wd.bbox });
    }
    const conf = words.length ? words.reduce((s, x) => s + x.conf * x.text.length, 0) / words.reduce((s, x) => s + x.text.length, 0) : 0;
    return { words, angle: (r.data as unknown as { rotateRadians?: number }).rotateRadians || 0, conf };
  } finally {
    give(p, w);
  }
}

/** read a page (or an area of it): words with boxes in page points */
export async function ocrPage(docId: string, page: number, pw: number, ph: number, opts: { lang: OcrLang; dpi?: number; rect?: number[] | null } = { lang: 'eng+ara' }): Promise<OcrWord[]> {
  return (await ocrPageFull(docId, page, pw, ph, opts)).words;
}

/** the same, with the angle Tesseract straightened the page by (radians; 0 when it was turned sideways) */
export async function ocrPageFull(docId: string, page: number, pw: number, ph: number, opts: { lang: OcrLang; dpi?: number; rect?: number[] | null } = { lang: 'eng+ara' }): Promise<{ words: OcrWord[]; angle: number }> {
  const lang = ocrLangOf(opts.lang);
  const p = await hold(lang);
  try { return await readPage(p, docId, page, pw, ph, opts); } finally { release(lang); }
}
async function readPage(p: Pool, docId: string, page: number, pw: number, ph: number, opts: { dpi?: number; rect?: number[] | null }): Promise<{ words: OcrWord[]; angle: number }> {
  const dpi = opts.dpi ?? 300;
  let img = await pagePgm(docId, page, pw, ph, opts.rect ?? null, dpi);
  let res = await recognise(p, img.pgm);
  /** a poor read: probably a noisy photocopy - try once more with stronger cleaning, keep the better one */
  const cleaner = async (q: number) => {
    if (res.conf >= 78 || res.words.length <= 3) return;
    const img2 = await pagePgm(docId, page, pw, ph, opts.rect ?? null, dpi, q, 2);
    const res2 = await recognise(p, img2.pgm);
    if (res2.conf > res.conf + 3) { img = img2; res = res2; }
  };
  const doubtful = () => !opts.rect && (res.conf < 55 || res.words.length < 8);
  /** sideways or upside-down scan? try the other three turns (cheap 150 dpi probes, side by side) */
  const turn = async () => {
    const best = { q: 0, conf: res.conf, n: res.words.length };
    const probes = await Promise.all([1, 2, 3].map(async (q) => recognise(p, (await pagePgm(docId, page, pw, ph, null, Math.min(dpi, 150), q)).pgm)));
    probes.forEach((r, k) => {
      if (r.conf * Math.min(1, r.words.length / 20) > best.conf * Math.min(1, best.n / 20) + 8) Object.assign(best, { q: k + 1, conf: r.conf, n: r.words.length });
    });
    if (!best.q) return false;
    img = await pagePgm(docId, page, pw, ph, null, dpi, best.q);
    res = await recognise(p, img.pgm);
    await cleaner(best.q);
    return true;
  };
  // a doubtful first read: check the turn before spending a full-size second read on the wrong way up
  if (doubtful()) { if (!(await turn())) await cleaner(0); }
  else { await cleaner(0); if (doubtful()) await turn(); }
  // boxes back to page points: undo Tesseract's own straightening, then the 90° turn
  const cx = img.OW / 2, cy = img.OH / 2;
  const ca = Math.cos(-res.angle), sa = Math.sin(-res.angle);
  const unrot = (x: number, y: number): [number, number] => [cx + (x - cx) * ca - (y - cy) * sa, cy + (x - cx) * sa + (y - cy) * ca];
  const unturn = (x: number, y: number): [number, number] => {
    switch (img.quarter) {
      case 1: return [y, img.H - x];
      case 2: return [img.W - x, img.H - y];
      case 3: return [img.W - y, x];
      default: return [x, y];
    }
  };
  const words: OcrWord[] = [];
  for (const wd of res.words) {
    if (wd.conf < 20) continue;
    const pts = [[wd.bbox.x0, wd.bbox.y0], [wd.bbox.x1, wd.bbox.y0], [wd.bbox.x1, wd.bbox.y1], [wd.bbox.x0, wd.bbox.y1]].map(([x, y]) => unturn(...(res.angle ? unrot(x, y) : [x, y] as [number, number])));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    words.push({ text: wd.text, conf: wd.conf, box: [img.ox + Math.min(...xs) / img.scale, img.oy + Math.min(...ys) / img.scale, img.ox + Math.max(...xs) / img.scale, img.oy + Math.max(...ys) / img.scale] });
  }
  return { words, angle: img.quarter ? 0 : res.angle };
}

/**
 * Read many pages: as many at once as there are OCR engines (each page is read exactly as
 * ocrPage reads it). `done` gets each page as it finishes - in any order, one at a time.
 */
export async function ocrPages(docId: string, pages: { i: number; w: number; h: number }[], lang: OcrLang, done: (i: number, words: OcrWord[]) => Promise<void> | void, stopped: () => boolean) {
  return ocrPagesFull(docId, pages, lang, (i, r) => done(i, r.words), stopped);
}
export async function ocrPagesFull(docId: string, pages: { i: number; w: number; h: number }[], lang0: OcrLang, done: (i: number, r: { words: OcrWord[]; angle: number }) => Promise<void> | void, stopped: () => boolean) {
  const lang = ocrLangOf(lang0);
  // (the engines are this job's from the first page to the last)
  await hold(lang);
  try { await readPages(docId, pages, lang, done, stopped); } finally { release(lang); }
}
async function readPages(docId: string, pages: { i: number; w: number; h: number }[], lang: OcrLang, done: (i: number, r: { words: OcrWord[]; angle: number }) => Promise<void> | void, stopped: () => boolean) {
  let next = 0;
  let chain: Promise<void> = Promise.resolve();
  let failed: unknown = null;
  const lane = async () => {
    while (next < pages.length && !stopped() && !failed) {
      const pg = pages[next++];
      try {
        const w = await ocrPageFull(docId, pg.i, pg.w, pg.h, { lang });
        chain = chain.then(() => (failed || stopped() ? undefined : done(pg.i, w))).catch((e) => { failed = failed || e; });
      } catch (e) { failed = failed || e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size(), pages.length) }, lane));
  await chain;
  if (failed) throw failed;
}

/** average word confidence of the last results (shown to the user) */
export function meanConf(words: OcrWord[]) {
  if (!words.length) return 0;
  return words.reduce((s, w) => s + w.conf, 0) / words.length;
}

export async function stopOcr() {
  const all = [...pools.values()];
  pools.clear();
  wanted = null;
  for (const pp of all) { try { endPool(await pp); } catch { /* never made */ } }
}
