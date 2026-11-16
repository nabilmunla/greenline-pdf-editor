// The drawn page: a low-res preview underneath, sharp tiles of the visible part on top,
// and the markup layer (MuPDF) above that. Tiles are positioned in % of the page, so
// while zooming the old ones simply stretch until the new sharp ones arrive - no flashing.
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { tiles, TILE, levelFor, previewScale, previewReqs, drawPreview, canvasBytes, dropCanvas, oldLevelsToKeep, type TileReq } from './tiles';
import type { PdfDoc } from './doc';

export interface PageTilesProps {
  doc: PdfDoc;
  page: number;
  w: number; // page size in points
  h: number;
  z: number; // CSS px per point
  dpr: number;
  /** visible part of the page in points [x0, y0, x1, y1] */
  vis: [number, number, number, number];
  /** content revision of this page (tiles are keyed by it) */
  crev: number;
  annRev: number;
  hasAnnots: boolean;
  hasHighlights: boolean;
  hide: number[];
  /** distance of this page from the middle of the view (smaller = sooner) */
  prio: number;
  tag: string;
}

/** sharp tiles are asked for once the zoom level has not changed for this long */
const SETTLE_MS = 120;

/**
 * Re-render only when something drawn changes. The priority changes on every scroll frame: the
 * viewer hands it to the tile store itself (tiles.reprio) - re-rendering every visible page for
 * it (and building and asking for its tiles again) cost every frame. vis / hide come as new
 * arrays each render: compared by value.
 */
export function samePageTiles(a: PageTilesProps, b: PageTilesProps): boolean {
  for (const k of Object.keys(a) as (keyof PageTilesProps)[]) {
    if (k === 'prio') continue;
    if (k === 'vis') { if (a.vis.some((v, i) => v !== b.vis[i])) return false; continue; }
    if (k === 'hide') { if (a.hide.length !== b.hide.length || a.hide.some((v, i) => v !== b.hide[i])) return false; continue; }
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export const PageTiles = memo(function PageTiles(p: PageTilesProps) {
  const prevRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const annRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);
  const prevDrawn = useRef({ key: '', done: new Set<string>(), complete: false });
  const state = useRef(p);
  state.current = p;

  const S = levelFor(p.z * p.dpr);
  const hideSig = p.hide.length ? p.hide.join(',') : '';

  // which tiles are needed for the visible area at this level
  const grid = () => {
    const s = state.current;
    const L = levelFor(s.z * s.dpr);
    const W = Math.ceil(s.w * L), H = Math.ceil(s.h * L);
    const pad = TILE * 0.5;
    const x0 = Math.max(0, Math.floor((s.vis[0] * L - pad) / TILE)), x1 = Math.min(Math.ceil(W / TILE) - 1, Math.floor((s.vis[2] * L + pad) / TILE));
    const y0 = Math.max(0, Math.floor((s.vis[1] * L - pad) / TILE)), y1 = Math.min(Math.ceil(H / TILE) - 1, Math.floor((s.vis[3] * L + pad) / TILE));
    const out: { tx: number; ty: number; w: number; h: number }[] = [];
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push({ tx, ty, w: Math.min(TILE, W - tx * TILE), h: Math.min(TILE, H - ty * TILE) });
    return { L, W, H, list: out };
  };
  const bKey = (L: number, tx: number, ty: number) => `${state.current.doc.id}|r${state.current.crev}|b|${L.toFixed(4)}|${tx}|${ty}`;
  const aKey = (L: number, tx: number, ty: number) => `${state.current.doc.id}|a${state.current.annRev}|${state.current.page}|a|${L.toFixed(4)}|${tx}|${ty}|${state.current.hide.join(',')}`;
  const hKey = (L: number, tx: number, ty: number) => `${state.current.doc.id}|a${state.current.annRev}|${state.current.page}|h|${L.toFixed(4)}|${tx}|${ty}|${state.current.hide.join(',')}`;

  const paint = () => {
    const s = state.current;
    // preview (built from its own tiles as they arrive)
    const pv = prevRef.current;
    const pk = `${s.doc.id}|r${s.crev}`;
    const pr = prevDrawn.current;
    if (pv && (pr.key !== pk || !pr.complete)) {
      if (pr.key !== pk) {
        // new page content: keep showing the old picture until the first new tile is there
        const anyNew = previewReqs(s.doc.id, s.crev, s.page, s.w, s.h, 0).some((r) => tiles.has(r.key));
        if (anyNew) {
          const ps = previewScale(s.w, s.h);
          pv.width = Math.max(1, Math.round(s.w * ps)); pv.height = Math.max(1, Math.round(s.h * ps));
          const g = pv.getContext('2d')!;
          g.fillStyle = '#fff';
          g.fillRect(0, 0, pv.width, pv.height);
          prevDrawn.current = { key: pk, done: new Set(), complete: false };
        }
      }
      if (prevDrawn.current.key === pk) {
        prevDrawn.current.complete = drawPreview(pv, s.doc.id, s.crev, s.page, s.w, s.h, prevDrawn.current.done);
        pv.style.opacity = '1';
      }
    }
    const { L, W, H, list } = grid();
    // when zoomed out so far that the preview is as sharp as tiles would be, skip tiles
    const useTiles = L > previewScale(s.w, s.h) * 1.05;
    /** the area of a tile canvas in page fractions */
    const box = (c: HTMLElement) => { const l = parseFloat(c.style.left), t = parseFloat(c.style.top); return [l, t, l + parseFloat(c.style.width), t + parseFloat(c.style.height)]; };
    // markup layers are see-through: an old tile under a new one would still show its markups
    // (text that moved or changed showed twice) - so an old tile goes as soon as a new one covers it
    const layer = (el: HTMLDivElement | null, keyOf: (L: number, tx: number, ty: number) => string, on: boolean, clear = false) => {
      if (!el) return;
      const want = new Map<string, { tx: number; ty: number; w: number; h: number }>();
      if (on) for (const t of list) want.set(keyOf(L, t.tx, t.ty), t);
      let complete = true;
      const have = new Set<string>();
      for (const c of Array.from(el.children) as HTMLCanvasElement[]) have.add(c.dataset.k!);
      for (const [k, t] of want) {
        if (have.has(k)) continue;
        const bmp = tiles.get(k);
        if (bmp === undefined) { complete = false; continue; }
        // null = nothing on that tile (markup layer)
        const c = document.createElement('canvas');
        c.dataset.k = k;
        c.dataset.l = L.toFixed(4);
        c.dataset.p = t.tx + ',' + t.ty;
        c.width = t.w; c.height = t.h;
        if (bmp) c.getContext('2d')!.drawImage(bmp, 0, 0);
        c.style.left = ((t.tx * TILE) / W) * 100 + '%';
        c.style.top = ((t.ty * TILE) / H) * 100 + '%';
        c.style.width = (t.w / W) * 100 + '%';
        c.style.height = (t.h / H) * 100 + '%';
        el.appendChild(c);
        // a newer version of the same tile replaces the old one straight away
        const cb = clear ? box(c) : null;
        for (const o of Array.from(el.children) as HTMLCanvasElement[]) {
          if (o === c) continue;
          if (o.dataset.l === c.dataset.l && o.dataset.p === c.dataset.p) { dropCanvas(o); continue; }
          if (cb && !want.has(o.dataset.k!)) { const ob = box(o); if (ob[0] < cb[2] - 1e-6 && ob[2] > cb[0] + 1e-6 && ob[1] < cb[3] - 1e-6 && ob[3] > cb[1] + 1e-6) dropCanvas(o); }
        }
        have.add(k);
      }
      // (canvases of an old level stay while the new set is incomplete - no blank flashes - but only
      // those of the one old level nearest the new: a canvas per tile of every level passed on the way held
      // hundreds of MB; a removed canvas is emptied first, which frees its pixels at once)
      const mine = Array.from(el.children) as HTMLCanvasElement[];
      const keepOld = complete ? new Set<string>() : oldLevelsToKeep(mine.map((c) => c.dataset.l!), L.toFixed(4));
      for (const c of mine) {
        const k = c.dataset.k!;
        if (want.has(k)) continue;
        // old level / old version: keep while the new set is incomplete (no blank flashes)
        if (!complete && keepOld.has(c.dataset.l!)) continue;
        if (!complete && want.size && [...want.values()].some((t) => c.dataset.p === t.tx + ',' + t.ty) && c.dataset.l === L.toFixed(4)) continue;
        dropCanvas(c);
      }
    };
    layer(baseRef.current, bKey, useTiles);
    layer(hlRef.current, hKey, s.hasHighlights, true);
    layer(annRef.current, aKey, s.hasAnnots, true);
    // what this page holds in canvases (the preview and the tile canvases) counts against the tile memory budget
    const all: HTMLCanvasElement[] = pv ? [pv] : [];
    for (const el of [baseRef.current, hlRef.current, annRef.current]) if (el) all.push(...(Array.from(el.children) as HTMLCanvasElement[]));
    tiles.noteCanvasBytes(s.tag, canvasBytes(all));
  };

  // ask for what's needed. While the zoom level is changing (wheel, pinch, zoom buttons held)
  // only the preview is asked for: sharp tiles of levels passed on the way cost seconds each on
  // a dense sheet (a tile near the preview level covers most of the page) and the engines
  // can't drop a tile once started - so sharp tiles wait until the level has settled.
  const level = useRef({ S, t: 0 });
  const settle = useRef(0);
  const ask = () => {
    const s = state.current;
    // (the page's priority as the viewer last gave it to the tile store: props.prio is only the first)
    const prio = tiles.baseOf(s.tag) ?? s.prio;
    const reqs: TileReq[] = previewReqs(s.doc.id, s.crev, s.page, s.w, s.h, prio - 1e6).filter((r) => !tiles.has(r.key));
    const { L, list } = grid();
    const useTiles = L > previewScale(s.w, s.h) * 1.05;
    const wait = SETTLE_MS - (performance.now() - level.current.t);
    window.clearTimeout(settle.current);
    if (wait > 0 && useTiles && list.some((t) => !tiles.has(bKey(L, t.tx, t.ty)))) {
      tiles.need(s.tag, reqs, prio);
      settle.current = window.setTimeout(ask, wait + 5);
      return;
    }
    const cx = (s.vis[0] + s.vis[2]) / 2 * L, cy = (s.vis[1] + s.vis[3]) / 2 * L;
    for (const t of list) {
      const d = Math.hypot(t.tx * TILE + t.w / 2 - cx, t.ty * TILE + t.h / 2 - cy);
      if (useTiles) reqs.push({ key: bKey(L, t.tx, t.ty), layer: 'b', doc: s.doc.id, page: s.page, scale: L, x: t.tx * TILE, y: t.ty * TILE, w: t.w, h: t.h, prio: prio + d });
      if (s.hasAnnots) reqs.push({ key: aKey(L, t.tx, t.ty), layer: 'a', doc: s.doc.id, page: s.page, scale: L, x: t.tx * TILE, y: t.ty * TILE, w: t.w, h: t.h, hide: s.hide, prio: prio + d + 1 });
      if (s.hasHighlights) reqs.push({ key: hKey(L, t.tx, t.ty), layer: 'h', doc: s.doc.id, page: s.page, scale: L, x: t.tx * TILE, y: t.ty * TILE, w: t.w, h: t.h, hide: s.hide, prio: prio + d + 1 });
    }
    tiles.need(s.tag, reqs, prio);
  };
  // (asked and painted again only when the set of tiles in view changes: a page scrolled within
  // the same tile rows needs nothing new - that ran for every visible page on every scroll frame)
  const lastSig = useRef('');
  useEffect(() => {
    if (S !== level.current.S) level.current = { S, t: performance.now() };
    const g = grid();
    const t0 = g.list[0], t1 = g.list[g.list.length - 1];
    const sig = [g.L, g.list.length, t0?.tx, t0?.ty, t1?.tx, t1?.ty, p.crev, p.page, p.annRev, p.hasAnnots, p.hasHighlights, hideSig, p.doc.id].join('|');
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    ask();
    paint();
  }, [S, p.vis[0], p.vis[1], p.vis[2], p.vis[3], p.crev, p.page, p.annRev, p.hasAnnots, p.hasHighlights, hideSig, p.doc.id]);

  useEffect(() => () => { window.clearTimeout(settle.current); tiles.forget(p.tag); }, [p.tag]);
  // the page goes away: its canvases are emptied (their pixels are freed now, not when the garbage collector comes by)
  useEffect(() => {
    const layers = [baseRef.current, hlRef.current, annRef.current], pv = prevRef.current;
    return () => {
      for (const el of layers) if (el) for (const c of Array.from(el.children) as HTMLCanvasElement[]) dropCanvas(c);
      if (pv) { pv.width = 0; pv.height = 0; }
    };
  }, []);

  // everything drawn thrown away (tiles.reset: the graphics memory was reset): the canvases on
  // the page are drawn again - kept until their new picture is there (marked old: no white flash
  // where they still show), the preview too
  useEffect(() => tiles.onReset(() => {
    for (const el of [baseRef.current, hlRef.current, annRef.current]) if (el) for (const c of Array.from(el.children) as HTMLCanvasElement[]) c.dataset.k = 'old|' + c.dataset.k;
    prevDrawn.current = { key: '', done: new Set(), complete: false };
    lastSig.current = '';
    ask();
    paint();
  }), []);

  useEffect(() => tiles.onReady((k) => {
    const s = state.current;
    const parts = k.split('|');
    if (parts[0] !== s.doc.id) return;
    if (parts[1] === 'r' + s.crev || (parts[1][0] === 'a' && parts[2] === String(s.page))) requestAnimationFrame(paint);
  }), []);

  // new page content: the old picture stays until the new one is drawn (no white flash) -
  // unless the page changed shape (rotated, cropped, another page moved here): then it's wrong, clear it
  const dims = useRef(`${p.w}x${p.h}`);
  useLayoutEffect(() => {
    const d = `${p.w}x${p.h}`;
    if (d !== dims.current) {
      dims.current = d;
      for (const el of [baseRef.current, hlRef.current, annRef.current]) if (el) { for (const c of Array.from(el.children) as HTMLCanvasElement[]) dropCanvas(c); el.replaceChildren(); }
      const pv = prevRef.current;
      if (pv) { pv.width = 1; pv.height = 1; pv.style.opacity = '0'; }
      prevDrawn.current = { key: '', done: new Set(), complete: false };
    }
    paint();
  }, [p.crev, p.w, p.h]);

  // a page that ran a drawing engine out of memory twice: said so, not drawn again and again
  const pageKey = `${p.doc.id}|r${p.crev}`;
  const [heavy, setHeavy] = useState(() => tiles.isHeavy(pageKey));
  useEffect(() => { setHeavy(tiles.isHeavy(pageKey)); return tiles.onHeavy(() => setHeavy(tiles.isHeavy(pageKey))); }, [pageKey]);
  // (3.2) a heavy page whose line work is being merged before it is drawn
  const [preparing, setPreparing] = useState(() => tiles.gateBusy(p.doc.id, p.page));
  useEffect(() => { setPreparing(tiles.gateBusy(p.doc.id, p.page)); return tiles.onGate(() => setPreparing(tiles.gateBusy(p.doc.id, p.page))); }, [p.doc.id, p.page]);
  const [simplifying, setSimplifying] = useState<'' | 'busy' | string>('');
  const simplify = async () => {
    setSimplifying('busy');
    // (the page gets new content: drawn afresh under a new key - this note goes with the old one)
    try { await p.doc.simplify(p.page); setSimplifying(''); } catch (e) { setSimplifying(String((e as Error).message || e).replace(/^Error: /, '')); }
  };

  return (
    <>
      {preparing && !heavy && (
        <div className="pg-heavy" onPointerDown={(e) => e.stopPropagation()}
          style={{ left: ((p.vis[0] + p.vis[2]) / 2 / p.w) * 100 + '%', top: ((p.vis[1] + p.vis[3]) / 2 / p.h) * 100 + '%' }}>
          <b>Preparing this drawing…</b>
          <span>It is made of millions of separate line pieces: they are joined for drawing (your file is not changed). This takes a few seconds.</span>
        </div>
      )}
      {heavy && (
        <div className="pg-heavy" onPointerDown={(e) => e.stopPropagation()}
          style={{ left: ((p.vis[0] + p.vis[2]) / 2 / p.w) * 100 + '%', top: ((p.vis[1] + p.vis[3]) / 2 / p.h) * 100 + '%' }}>
          <b>This page is too heavy to draw</b>
          <span>It ran the drawing engine out of memory. Markups and measuring still work.</span>
          {simplifying === 'busy'
            ? <span>Simplifying its line work… this can take half a minute.</span>
            : <>
              {simplifying && <span className="err">{simplifying}</span>}
              <span className="hrow">
                <button className="btn sm primary" title="Join its millions of separate line pieces into fewer lines - the same drawing, light enough to draw (only how it is shown: your file is not changed)" onClick={() => void simplify()}>Simplify and draw</button>
                <button className="btn sm" onClick={() => tiles.tryHeavyAgain(pageKey)}>Try again</button>
              </span>
            </>}
        </div>
      )}
      <canvas ref={prevRef} className="pv" width={1} height={1} style={{ opacity: 0 }} />
      <div ref={baseRef} className="tl" />
      <div ref={hlRef} className="tl hl" />
      <div ref={annRef} className="tl an" />
    </>
  );
}, samePageTiles);
