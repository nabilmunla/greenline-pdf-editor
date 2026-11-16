// Tile cache + scheduler. The viewer says what it needs every time the view moves;
// anything no longer needed is dropped before it is drawn, so fast scrolling through
// a 2,000-page spec or zooming around an A0 sheet never queues up stale work.
import { rendererFor, renderers, editor } from './engines';
import { VIEW_TILE } from '../engine/callq';
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

  /**
   * Pages that are not drawn yet: a document's pages are looked at first (a heavy one gets merged
   * line work - PLAN 3.2). ready(page) false = its pictures wait in the queue (and the look is
   * under way); gateChanged() once pages became ready.
   */
  private gates = new Map<string, { ready(page: number): boolean; busy(page: number): boolean }>();
  private gateListeners = new Set<() => void>();
  setGate(doc: string, g: { ready(page: number): boolean; busy(page: number): boolean } | null) { if (g) this.gates.set(doc, g); else this.gates.delete(doc); }
  gateBusy(doc: string, page: number) { return !!this.gates.get(doc)?.busy(page); }
  onGate(f: () => void): () => void { this.gateListeners.add(f); return () => { this.gateListeners.delete(f); }; }
  gateChanged() { for (const f of this.gateListeners) f(); this.pump(); }
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
  /** each tag's priority base (the page's distance from the middle of the view) when it asked:
   *  scrolling only moves the base (reprio) - the page's wishes are not built and asked again */
  private base = new Map<string, number>();
  /** priorities moved since the queue was last sorted (sorted again before the next start) */
  private dirty = false;
  need(tag: string, reqs: TileReq[], base?: number) {
    this.wishes.set(tag, reqs);
    if (base !== undefined) this.base.set(tag, base);
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
    this.dirty = false;
    this.sendScales();
    this.pump();
  }
  /** the scales of view tiles each document's wishes still hold, as last told to the drawing
   *  engines: tiles queued there at other scales are dropped unrun (PLAN 3.9) */
  private sentScales = new Map<string, string>();
  private sendScales() {
    const by = new Map<string, Set<number>>();
    for (const l of this.wishes.values()) for (const r of l) {
      if (r.layer !== 'b' && r.layer !== 'p') continue;
      let s = by.get(r.doc);
      if (!s) by.set(r.doc, (s = new Set()));
      s.add(r.scale);
    }
    for (const [doc, s] of by) {
      const scales = [...s].sort((a, b) => a - b), sig = scales.join(',');
      if (this.sentScales.get(doc) === sig) continue;
      this.sentScales.set(doc, sig);
      for (const e of renderers) e.want(doc, scales);
    }
  }
  forget(tag: string) { this.wishes.delete(tag); this.base.delete(tag); this.canvases.delete(tag); this.recount(); }
  /**
   * The canvases of the page elements (the preview and a tile canvas per tile on screen, each a copy
   * of a picture above - ImageBitmaps are drawn into canvases, so what is on screen is held twice)
   * are real memory too: counted with the pictures against the budget, so the pictures not needed
   * go sooner when much is on screen. One number per page (tag), set each time the page is painted.
   */
  private canvases = new Map<string, number>();
  private canvasTotal = 0;
  private recount() { let t = 0; for (const b of this.canvases.values()) t += b; this.canvasTotal = t; }
  noteCanvasBytes(tag: string, bytes: number) {
    const old = this.canvases.get(tag) ?? 0;
    if (bytes > 0) this.canvases.set(tag, bytes); else this.canvases.delete(tag);
    this.canvasTotal += Math.max(0, bytes) - old;
    if (bytes > old) this.trim();
  }
  /** the priority base a tag asked with last (undefined: never asked) */
  baseOf(tag: string) { return this.base.get(tag); }
  /**
   * The page moved in the view: its wishes (and their places in the queue - the same objects)
   * shift by the change of its base. O(its wishes); the queue is sorted once, before the next
   * tile starts - not rebuilt from every page's wishes on every scroll frame (it was).
   */
  reprio(tag: string, base: number) {
    const old = this.base.get(tag);
    this.base.set(tag, base);
    if (old === undefined || old === base) return;
    const list = this.wishes.get(tag);
    if (!list) return;
    const d = base - old;
    for (const r of list) r.prio += d;
    this.dirty = true;
  }
  private wantedKeys() { const s = new Set<string>(); for (const l of this.wishes.values()) for (const r of l) s.add(r.key); return s; }
  /** bytes of pictures kept (tests) */
  stats() { let previews = 0, n = 0; for (const [k, e] of this.cache) { n++; if (k.includes('|p|')) previews += e.size; } return { bytes: this.bytes, canvases: this.canvasTotal, previews, tiles: n, budget: this.budget, queued: this.queue.length, inflight: this.inflight.size, unwanted: this.unwanted, stale: this.stale }; }
  /** view tiles drawn that no wish held any more when they came / dropped unrun by the engine (PLAN 3.9) */
  private unwanted = 0;
  private stale = 0;
  /** an engine came back after a restart: try again what failed (not the pages given up on) */
  retry() {
    this.failed.clear();
    // (a restarted drawing engine knows no wanted scales: post them again)
    this.sentScales.clear();
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
    this.gates.delete(doc);
    if (this.sentScales.delete(doc)) for (const e of renderers) e.want(doc, null);
  }

  private pump() {
    if (this.dirty) { this.queue.sort((a, b) => a.prio - b.prio); this.dirty = false; }
    const maxB = 2 * renderers.length;
    let i = 0;
    while (i < this.queue.length) {
      const r = this.queue[i];
      const isA = r.layer === 'a' || r.layer === 'h';
      const baseBusy = this.inflight.size - this.inflightA;
      if (isA ? this.inflightA >= 2 : baseBusy >= maxB) { i++; continue; }
      // (a page still being looked at: its pictures wait - the look is asked for by ready())
      if (!isA && this.gates.size && this.gates.get(r.doc)?.ready(r.page) === false) { i++; continue; }
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
      : (eng = rendererFor(r.doc, r.page)).call<ImageBitmap>(VIEW_TILE, [r.doc, r.page, r.scale, r.x, r.y, r.w, r.h]));
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
      if (eng && !this.wantedKeys().has(r.key)) this.unwanted++;
      this.put(r.key, bmp, r.w * r.h * 4);
      for (const f of this.listeners) f(r.key);
    }).catch((e) => {
      // (not drawn: the view had moved on to another scale - nothing failed)
      if ((e as { stale?: boolean })?.stale) { this.stale++; this.askAgain(r, gen); return; }
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

  /**
   * An engine dropped this view tile unrun ("stale": its scale was not wanted when its turn came).
   * If the window wants it again since (zoom A -> B -> A while it was queued there) it is neither
   * in flight nor queued - need() skips what is in flight - so it goes back in the queue here
   * (sorted before the next start), or it stays a hole until the next scroll. Called before the
   * in-flight mark is cleared; the pump comes right after.
   */
  private askAgain(r: TileReq, gen: number) {
    if ((this.gens.get(r.doc) ?? 0) !== gen || this.cache.has(r.key)) return;
    if ((this.failed.get(r.key) ?? 0) > 2) return;
    if (this.heavy.size && (r.layer === 'b' || r.layer === 'p') && this.heavy.has(pageOf(r.key))) return;
    if (this.queue.some((q) => q.key === r.key)) return;
    // (the wish itself: its priority follows the scrolling, the finished request's may not)
    for (const l of this.wishes.values()) for (const w of l) {
      if (w.key !== r.key) continue;
      this.queue.push(w);
      this.dirty = true;
      return;
    }
  }

  private put(key: string, bmp: ImageBitmap | null, size: number) {
    const old = this.cache.get(key);
    if (old) { old.bmp?.close(); this.bytes -= old.size; }
    this.cache.set(key, { bmp, size: bmp ? size : 0 });
    this.bytes += bmp ? size : 0;
    this.trim();
  }

  /**
   * Over the budget (pictures and the canvases on screen together): pictures go until 80 % is
   * left - sharp tiles first (oldest first), page previews only if that is not enough (scrolling
   * through a 2,000-page book must not keep 2,000 previews, GBs, in memory). A picture the
   * viewers still ask for (the wanted set) is never one of them, in either round: they are what
   * is on screen, and dropping one only had it drawn again at once.
   */
  private trim() {
    const used = () => this.bytes + this.canvasTotal;
    if (used() <= this.budget) return;
    const wanted = this.wantedKeys();
    for (const previews of [false, true]) {
      for (const [k, e] of this.cache) {
        if (used() <= this.budget * 0.8) break;
        if (k.includes('|p|') !== previews) continue;
        if (wanted.has(k)) continue;
        e.bmp?.close();
        this.bytes -= e.size;
        this.cache.delete(k);
      }
      if (used() <= this.budget * 0.8) break;
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

/** the bytes the canvases hold (4 per pixel) */
export function canvasBytes(cs: Iterable<{ width: number; height: number }>): number {
  let t = 0;
  for (const c of cs) t += c.width * c.height * 4;
  return t;
}

/** a canvas taken off the page: its size is set to zero first, which frees its pixels at once (a removed canvas keeps them until the garbage collector comes to it) */
export function dropCanvas(c: { width: number; height: number; remove(): void }) {
  c.width = 0; c.height = 0;
  c.remove();
}

/**
 * Canvases of old zoom levels (levels are "scale.toFixed(4)") stay on a page while the new level is
 * not complete, so that nothing flashes white: only the `keep` levels nearest to the new one stay
 * (each zoom step passed on the way used to leave a whole set of canvases behind).
 */
export function oldLevelsToKeep(levels: Iterable<string>, cur: string, keep = 1): Set<string> {
  const c = Number(cur);
  const old = [...new Set(levels)].filter((l) => l !== cur);
  old.sort((a, b) => Math.abs(Math.log2(Number(a) / c)) - Math.abs(Math.log2(Number(b) / c)));
  return new Set(old.slice(0, keep));
}
