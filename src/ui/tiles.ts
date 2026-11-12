// Tile cache + scheduler. The viewer says what it needs every time the view moves;
// anything no longer needed is dropped before it is drawn, so fast scrolling through
// a 2,000-page spec or zooming around an A0 sheet never queues up stale work.
import { rendererFor, renderers, editor } from './engines';
import { gcc } from './api';
import type { EngineClient } from '../engine/rpc';

/** documents whose previews may be cached on disk: id -> file fingerprint (path + size + date) */
export const previewCache = new Map<string, string>();

export const TILE = 512;

export interface TileReq {
  key: string;
  layer: 'b' | 'a' | 'h' | 'p';
  doc: string;
  page: number;
  scale: number;
  x: number;
  y: number;
  w: number;
  h: number;
  hide?: number[];
  prio: number;
  /** disk cache key (unchanged files only) */
  cache?: string;
}

type Entry = { bmp: ImageBitmap | null; size: number };

class TileStore {
  private cache = new Map<string, Entry>();
  private bytes = 0;
  /** pictures kept for quick scrolling back: ~1 GB on a normal office PC, less on small ones */
  private budget = Math.min(1_100_000_000, ((navigator as unknown as { deviceMemory?: number }).deviceMemory || 8) * 130_000_000);
  private queue: TileReq[] = [];
  private inflight = new Set<string>();
  private inflightA = 0;
  private listeners = new Set<(key: string) => void>();
  private failed = new Map<string, number>();
  /** pages (doc|r<rev>) whose drawing was under way when a drawing engine ran out of memory */
  private crashed = new Map<string, number>();
  private crashAt = new Map<string, number>();
  /** pages given up on: they took an engine down twice - not asked for again (that looped:
   *  restart, draw, out of memory, restart... every few seconds) until "Try again" */
  private heavy = new Set<string>();
  private heavyListeners = new Set<() => void>();
  isHeavy(pageKey: string) { return this.heavy.has(pageKey); }
  onHeavy(f: () => void): () => void { this.heavyListeners.add(f); return () => { this.heavyListeners.delete(f); }; }
  tryHeavyAgain(pageKey: string) {
    this.heavy.delete(pageKey);
    this.crashed.delete(pageKey);
    for (const k of [...this.failed.keys()]) if (k.startsWith(pageKey + '|')) this.failed.delete(k);
    for (const f of this.heavyListeners) f();
    this.retry();
  }

  /**
   * Everything drawn is thrown away and asked for again. Windows locked or asleep (or a graphics
   * driver reset) can reset the graphics card's memory: the page pictures kept there - and the
   * page's own canvases - came back blank, and the app went on reusing them (pages already seen
   * stayed white after lunch; pages not seen yet drew fine). Thumbnails and small edge tiles
   * survived: Chromium keeps small canvases out of the graphics card.
   */
  private resetListeners = new Set<() => void>();
  onReset(f: () => void): () => void { this.resetListeners.add(f); return () => { this.resetListeners.delete(f); }; }
  private resetAt = 0;
  reset() {
    // (several signals come together - unlock, resume, a canvas restored: once)
    const now = performance.now();
    if (now - this.resetAt < 1500) return;
    this.resetAt = now;
    for (const e of this.cache.values()) { try { e.bmp?.close(); } catch { /* gone */ } }
    this.cache.clear();
    this.bytes = 0;
    this.failed.clear();
    for (const f of this.resetListeners) f();
    this.retry();
  }

  get(key: string): ImageBitmap | null | undefined {
    const e = this.cache.get(key);
    if (!e) return undefined;
    // refresh LRU position
    this.cache.delete(key);
    this.cache.set(key, e);
    return e.bmp;
  }
  has(key: string) { return this.cache.has(key); }
  onReady(f: (key: string) => void): () => void { this.listeners.add(f); return () => { this.listeners.delete(f); }; }

  /** replace the wish list of one viewer (by tag) */
  private wishes = new Map<string, TileReq[]>();
  need(tag: string, reqs: TileReq[]) {
    this.wishes.set(tag, reqs);
    const all: TileReq[] = [];
    const seen = new Set<string>();
    for (const list of this.wishes.values()) for (const r of list) {
      if (seen.has(r.key) || this.cache.has(r.key) || this.inflight.has(r.key)) continue;
      if ((this.failed.get(r.key) ?? 0) > 2) continue;
      if (this.heavy.size && (r.layer === 'b' || r.layer === 'p') && this.heavy.has(pageOf(r.key))) continue;
      seen.add(r.key);
      all.push(r);
    }
    all.sort((a, b) => a.prio - b.prio);
    this.queue = all;
    this.pump();
  }
  forget(tag: string) { this.wishes.delete(tag); }
  private wantedKeys() { const s = new Set<string>(); for (const l of this.wishes.values()) for (const r of l) s.add(r.key); return s; }
  /** bytes of pictures kept (tests) */
  stats() { let previews = 0, n = 0; for (const [k, e] of this.cache) { n++; if (k.includes('|p|')) previews += e.size; } return { bytes: this.bytes, previews, tiles: n, budget: this.budget, queued: this.queue.length, inflight: this.inflight.size }; }
  /** an engine came back after a restart: try again what failed (not the pages given up on) */
  retry() {
    this.failed.clear();
    const any = this.wishes.entries().next();
    if (!any.done) this.need(any.value[0], any.value[1]);
  }

  /** a document's drawing engines are being reloaded: anything drawn before that is thrown away
   *  (one number per document; a closed document's stays so its late pictures are still refused) */
  private gens = new Map<string, number>();
  bump(doc: string) {
    this.gens.set(doc, (this.gens.get(doc) ?? 0) + 1);
    this.queue = this.queue.filter((r) => r.doc !== doc);
  }

  /** drop the pictures of these content revisions of a document (one pass over the cache) */
  dropRevs(doc: string, revs: Set<number>) {
    if (!revs.size) return;
    const pre = doc + '|r';
    for (const [k, e] of this.cache) {
      if (!k.startsWith(pre)) continue;
      const r = Number(k.slice(pre.length, k.indexOf('|', pre.length)));
      if (revs.has(r)) { e.bmp?.close(); this.bytes -= e.size; this.cache.delete(k); }
    }
  }
  /** drop a document's markup-layer pictures of these pages' old markup revisions
   *  ("<rev>|<page>" - every page starts at revision 0, so the page is part of it): a page with
   *  a new markup revision never asks for its old ones again, they only took room from live
   *  pictures until the memory limit pushed them out */
  dropAnn(doc: string, revPages: Set<string>) {
    if (!revPages.size) return;
    const pre = doc + '|a';
    for (const [k, e] of this.cache) {
      if (!k.startsWith(pre)) continue;
      const j = k.indexOf('|', k.indexOf('|', pre.length) + 1);
      if (revPages.has(k.slice(pre.length, j))) { e.bmp?.close(); this.bytes -= e.size; this.cache.delete(k); }
    }
  }
  /** drop cached tiles whose key starts with prefix (document closed / changed) */
  drop(prefix: string) {
    for (const [k, e] of this.cache) if (k.startsWith(prefix)) { e.bmp?.close(); this.bytes -= e.size; this.cache.delete(k); }
  }
  /** a document was closed: what was still to be drawn for it is dropped, pictures still on
   *  their way are thrown away when they come (they went back into the cache before), and
   *  nothing is kept about it (tiles that failed, pages that were too heavy, its disk-cache name) */
  closeDoc(doc: string) {
    this.bump(doc);
    const pre = doc + '|';
    this.drop(pre);
    for (const m of [this.failed, this.crashed, this.crashAt]) for (const k of [...m.keys()]) if (k.startsWith(pre)) m.delete(k);
    for (const k of [...this.heavy]) if (k.startsWith(pre)) this.heavy.delete(k);
    previewCache.delete(doc);
  }

  private pump() {
    const maxB = 2 * renderers.length;
    let i = 0;
    while (i < this.queue.length) {
      const r = this.queue[i];
      const isA = r.layer === 'a' || r.layer === 'h';
      const baseBusy = this.inflight.size - this.inflightA;
      if (isA ? this.inflightA >= 2 : baseBusy >= maxB) { i++; continue; }
      this.queue.splice(i, 1);
      this.start(r);
    }
  }

  private start(r: TileReq) {
    const gen = this.gens.get(r.doc) ?? 0;
    this.inflight.add(r.key);
    if (r.layer === 'a' || r.layer === 'h') this.inflightA++;
    let eng: EngineClient | null = null;
    const draw = () => (r.layer === 'a'
      ? editor.call<ImageBitmap | null>('annotTile', [r.doc, r.page, r.scale, r.x, r.y, r.w, r.h, r.hide ?? [], 'rest'])
      : r.layer === 'h'
      ? editor.call<ImageBitmap | null>('annotTile', [r.doc, r.page, r.scale, r.x, r.y, r.w, r.h, r.hide ?? [], 'hl'])
      : (eng = rendererFor(r.doc, r.page)).call<ImageBitmap>('tile', [r.doc, r.page, r.scale, r.x, r.y, r.w, r.h]));
    const p: Promise<ImageBitmap | null> = r.cache
      ? gcc.cacheGet(r.cache).then(async (b) => {
        if (b) { try { return await createImageBitmap(new Blob([b as unknown as BlobPart], { type: 'image/webp' })); } catch { /* re-draw */ } }
        const bmp = await draw();
        if (bmp) void toWebp(bmp).then((w) => w && gcc.cachePut(r.cache!, w));
        return bmp;
      })
      : draw();
    p.then((bmp) => {
      if ((this.gens.get(r.doc) ?? 0) !== gen) { bmp?.close(); return; }
      this.put(r.key, bmp, r.w * r.h * 4);
      for (const f of this.listeners) f(r.key);
    }).catch((e) => {
      this.failed.set(r.key, (this.failed.get(r.key) ?? 0) + 1);
      // the drawing engine died while drawing this page (out of memory)
      // (only the tile the engine was drawing when it went down counts - the others only waited
      // behind it; once per crash event)
      if ((r.layer === 'b' || r.layer === 'p') && eng && (e as { culprit?: boolean })?.culprit) {
        const pk = pageOf(r.key);
        // (engines going down together - out of memory at once, or all restarted - are one
        // event: counted once per page within a couple of seconds)
        const now = performance.now(), last = this.crashAt.get(pk) ?? -1e9;
        if (now - last > 2500) {
          this.crashAt.set(pk, now);
          if (this.crashAt.size > 500) this.crashAt.clear();
          // (twice in a couple of minutes: a crash long ago - many files open then - doesn't add up)
          const n = (now - last > 120000 ? 0 : this.crashed.get(pk) ?? 0) + 1;
          this.crashed.set(pk, n);
          if (n >= 2 && !this.heavy.has(pk)) { this.heavy.add(pk); for (const f of this.heavyListeners) f(); }
        }
      }
      console.warn('tile', r.key, e);
    }).finally(() => {
      this.inflight.delete(r.key);
      if (r.layer === 'a' || r.layer === 'h') this.inflightA--;
      this.pump();
    });
  }

  private put(key: string, bmp: ImageBitmap | null, size: number) {
    const old = this.cache.get(key);
    if (old) { old.bmp?.close(); this.bytes -= old.size; }
    this.cache.set(key, { bmp, size: bmp ? size : 0 });
    this.bytes += bmp ? size : 0;
    if (this.bytes > this.budget) {
      // sharp tiles go first (oldest first); page previews only if that is not enough -
      // scrolling through a 2,000-page book must not keep 2,000 previews (GBs) in memory
      for (const previews of [false, true]) {
        const wanted = previews ? this.wantedKeys() : null;
        for (const [k, e] of this.cache) {
          if (this.bytes <= this.budget * 0.8) break;
          if (k.includes('|p|') !== previews) continue;
          if (wanted?.has(k)) continue;
          e.bmp?.close();
          this.bytes -= e.size;
          this.cache.delete(k);
        }
        if (this.bytes <= this.budget * 0.8) break;
      }
    }
  }
}

/** the page part of a tile key ("doc|r<rev>") */
export const pageOf = (key: string) => { const i = key.indexOf('|'); const j = key.indexOf('|', i + 1); return j < 0 ? key : key.slice(0, j); };

export const tiles = new TileStore();

async function toWebp(bmp: ImageBitmap): Promise<Uint8Array | null> {
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    return new Uint8Array(await (await c.convertToBlob({ type: 'image/webp', quality: 0.92 })).arrayBuffer());
  } catch { return null; }
}

/** device-pixel scales come in steps of 2^(1/4) so small zoom changes reuse tiles */
export function levelFor(z: number): number {
  return Math.pow(2, Math.ceil(Math.log2(Math.max(0.01, z)) * 4 - 1e-6) / 4);
}

/** preview scale: long side about 1024 px (sharp enough while tiles arrive, cheap to keep) */
export function previewScale(w: number, h: number): number {
  return Math.min(1.5, 1024 / Math.max(w, h));
}

/**
 * The preview of a page is made of 512 px tiles too: a dense A0 sheet takes seconds to
 * draw whole, but each tile is quick and they are drawn in parallel, centre first.
 */
export function previewReqs(docId: string, rev: number, page: number, w: number, h: number, prio: number): TileReq[] {
  const s = previewScale(w, h);
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const out: TileReq[] = [];
  const cols = Math.ceil(W / TILE), rows = Math.ceil(H / TILE);
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    const tw = Math.min(TILE, W - tx * TILE), th = Math.min(TILE, H - ty * TILE);
    const d = Math.hypot(tx * TILE + tw / 2 - W / 2, ty * TILE + th / 2 - H / 2);
    // pages as they are in the file (negative revision) can come from / go to the disk cache
    const fp = rev < 0 ? previewCache.get(docId) : undefined;
    out.push({ key: `${docId}|r${rev}|p|${tx}|${ty}`, layer: 'p', doc: docId, page, scale: s, x: tx * TILE, y: ty * TILE, w: tw, h: th, prio: prio + d, cache: fp ? `${fp}-${-rev - 1}-${tx}-${ty}` : undefined });
  }
  return out;
}

/** draw whatever preview tiles are ready into a canvas of any size; true when complete */
export function drawPreview(c: HTMLCanvasElement, docId: string, rev: number, page: number, w: number, h: number, done: Set<string>): boolean {
  const s = previewScale(w, h);
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const k = c.width / W;
  const g = c.getContext('2d')!;
  let all = true;
  const cols = Math.ceil(W / TILE), rows = Math.ceil(H / TILE);
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    const key = `${docId}|r${rev}|p|${tx}|${ty}`;
    if (done.has(key)) continue;
    const b = tiles.get(key);
    if (!b) { all = false; continue; }
    g.imageSmoothingQuality = 'high';
    g.drawImage(b, tx * TILE * k, ty * TILE * k, b.width * k, b.height * k);
    done.add(key);
  }
  return all;
}
