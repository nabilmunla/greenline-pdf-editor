// Left panels: page thumbnails (select, drag to reorder), bookmarks, comments organizer, search.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PdfDoc } from './doc';
import type { SelItem, Hit } from './Viewer';
import type { AnnotData, OutNode } from '../engine/mu';
import { tiles, previewReqs, drawPreview } from './tiles';
import { renderers, mu, muBatchFile } from './engines';
import { fileArg, type FileRef } from '../engine/rpc';
import { Ico } from './icons';
import { css } from './tools';
import { gcc } from './api';
import { writeXlsx } from './xlsxwrite';
import { measureNumber, perimeterNumber, numStyle } from './measurexl';
import { prepare, dragIcon, dropPages } from './pagedrag';
import { pageRange } from './pagesel';

export type SideKind = 'pages' | 'bookmarks' | 'comments' | 'totals' | 'search';

interface Props {
  kind: SideKind;
  doc: PdfDoc;
  /** every file open in this window (tab order) */
  docs: PdfDoc[];
  rev: number;
  page: number;
  pageSel: number[];
  setPageSel(p: number[]): void;
  goTo(p: number, r?: number[]): void;
  sel: SelItem[];
  setSel(s: SelItem[]): void;
  A: Record<string, any>;
  hits: Hit[];
  setHits(h: Hit[]): void;
  hitIndex: number;
  setHitIndex(i: number): void;
  onClose(): void;
  toast(t: string, k?: 'ok' | 'err' | 'info' | 'busy', a?: { label: string; run(): void }): number;
}

/** a search snippet with the found words (between \u0001 and \u0002) in bold */
function snipView(t: string) {
  const a = t.indexOf('\u0001'), b = t.indexOf('\u0002');
  if (a < 0 || b < a) return t;
  return <>{t.slice(0, a)}<b className="hit">{t.slice(a + 1, b)}</b>{t.slice(b + 1)}</>;
}

/** the page view keeps at least this much room beside the panel */
const MIN_VIEW = 320;
export function SidePanel(p: Props) {
  const [want, setWidth] = useState(() => { const w = Number(localStorage.getItem('side-w') || 250); return Number.isFinite(w) ? Math.max(180, Math.min(760, w)) : 250; });
  /** how wide the panel may be in this window now: the page view keeps MIN_VIEW px (dragged to 760 px
   *  on a laptop window, the page went - 0 px, zoom 2 % - and came back so after a restart). The width
   *  asked for is kept: a bigger window shows it again. */
  const [room, setRoom] = useState(760);
  const box = useRef<HTMLDivElement>(null);
  const roomNow = () => {
    const v = document.querySelector('.viewer') as HTMLElement | null, me = box.current;
    return v && me ? Math.max(180, Math.min(760, me.offsetWidth + v.clientWidth - MIN_VIEW)) : 760;
  };
  useEffect(() => {
    const fit = () => setRoom(roomNow());
    fit();
    const v = document.querySelector('.viewer');
    const ro = new ResizeObserver(fit);
    if (v) ro.observe(v);
    window.addEventListener('resize', fit);
    return () => { ro.disconnect(); window.removeEventListener('resize', fit); };
  }, [p.doc.id]);
  const width = Math.min(want, room);
  const title = { pages: 'Pages', bookmarks: 'Bookmarks', comments: 'Comments', totals: 'Counts & totals', search: 'Search' }[p.kind];
  const startResize = (e: React.PointerEvent) => {
    const x0 = e.clientX, w0 = width, most = roomNow();
    const mv = (ev: PointerEvent) => setWidth(Math.max(180, Math.min(most, w0 + ev.clientX - x0)));
    // (the width is remembered by the effect below as it changes - writing it here wrote the
    // width from before the drag back over it)
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  useEffect(() => { try { localStorage.setItem('side-w', String(want)); } catch { /* ok */ } }, [want]);
  return (
    <div className="side" ref={box} style={{ width }}>
      <div className="side-head"><span>{title}</span><button className="x" onClick={p.onClose} title="Close panel"><Ico n="close" size={14} /></button></div>
      {/* (another file: thumbnails, their pictures, menu and drag start afresh - the same page
          count and sizes kept the last file's pictures and never asked for the new ones) */}
      {p.kind === 'pages' && <Thumbs key={p.doc.id} {...p} width={width} />}
      {p.kind === 'bookmarks' && <Bookmarks {...p} />}
      {p.kind === 'comments' && <Comments {...p} />}
      {p.kind === 'totals' && <Totals key={p.doc.id} {...p} />}
      {p.kind === 'search' && <Search {...p} />}
      <div className="side-grip" onPointerDown={startResize} />
    </div>
  );
}

// ---------------------------------------------------------------- thumbnails

/** where each open file's thumbnails were scrolled to */
const thumbScroll = new Map<string, { top: number; page: number }>();

function Thumbs(p: Props & { width: number }) {
  const { doc } = p;
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, h: 600 });
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; page: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const off = (e: Event) => { if (!(e.target as HTMLElement).closest?.('.cmenu')) setMenu(null); };
    // (a shortcut - Ctrl+Tab, Ctrl+W, Ctrl+P - closes it too: its pages are this file's)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' || ((e.ctrlKey || e.altKey) && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key))) setMenu(null); };
    const blur = () => setMenu(null);
    window.addEventListener('pointerdown', off, true);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', key); window.removeEventListener('blur', blur); };
  }, [menu]);
  /** right-click: the page joins (or becomes) the selection, then the menu acts on the selection */
  const ctx = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (!p.pageSel.includes(i)) p.setPageSel([i]);
    setMenu({ x: e.clientX, y: e.clientY, page: i });
  };
  const cols = Math.max(1, Math.floor((p.width - 16) / 150));
  const cw = Math.floor((p.width - 20) / cols) - 10;
  /** the picture inside a thumbnail box (box = picture + 4 px padding + 2 px border each side) */
  const iw = cw - 12;
  const rows = useMemo(() => {
    const out: { top: number; h: number }[] = [];
    let y = 8;
    for (let i = 0; i < doc.pages.length; i += cols) {
      let h = 0;
      for (let k = i; k < Math.min(doc.pages.length, i + cols); k++) h = Math.max(h, (iw * doc.pages[k].h) / doc.pages[k].w);
      out.push({ top: y, h: h + 26 });
      y += h + 34;
    }
    return out;
  }, [doc.pages, cols, cw, iw]);
  const total = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].h + 10 : 0;
  const pageRef = useRef(p.page);
  pageRef.current = p.page;
  useLayoutEffect(() => {
    const el = box.current!;
    // back to where this file's thumbnails were (switching tabs started them at the top again);
    // the first time: the page shown
    const saved = thumbScroll.get(doc.id);
    const r = rows[Math.floor(p.page / cols)];
    if (saved) el.scrollTop = saved.top;
    // another page shown since (a jump from Bookmarks or Search while the panel was shut or showed
    // something else): that page brought into view; the same page: the place as it was left
    if (r && (!saved || (saved.page !== p.page && (r.top < el.scrollTop || r.top + r.h > el.scrollTop + el.clientHeight)))) el.scrollTop = Math.max(0, r.top - 20);
    const f = () => { setScroll({ top: el.scrollTop, h: el.clientHeight }); thumbScroll.set(doc.id, { top: el.scrollTop, page: pageRef.current }); };
    f();
    el.addEventListener('scroll', f, { passive: true });
    const ro = new ResizeObserver(f);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', f); ro.disconnect(); };
  }, []);
  // keep the current page in view (not on the way in: the place it had is put back above)
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    const el = box.current;
    const t = thumbScroll.get(doc.id);
    if (t) t.page = p.page;
    const r = rows[Math.floor(p.page / cols)];
    if (!el || !r) return;
    if (r.top < el.scrollTop || r.top + r.h > el.scrollTop + el.clientHeight) el.scrollTop = r.top - 20;
  }, [p.page]);
  const vis: number[] = [];
  rows.forEach((r, ri) => { if (r.top + r.h > scroll.top - 200 && r.top < scroll.top + scroll.h + 200) for (let k = ri * cols; k < Math.min(doc.pages.length, ri * cols + cols); k++) vis.push(k); });
  // ask for previews (the viewer shares them)
  useEffect(() => {
    tiles.need('thumbs:' + doc.id, vis.flatMap((i) => previewReqs(doc.id, doc.crev[i], i, doc.pages[i].w, doc.pages[i].h, 5e6 + i * 1e4)));
  }, [vis.join(','), doc.crev.join(',')]);
  useEffect(() => () => tiles.forget('thumbs:' + doc.id), [doc.id]);

  /** the page Shift+click reaches from: the last one clicked without Shift */
  const anchor = useRef<number | null>(null);
  const click = (i: number, e: React.MouseEvent) => {
    if (dragged.current) { dragged.current = false; return; }
    if (e.ctrlKey) { p.setPageSel(p.pageSel.includes(i) ? p.pageSel.filter((x) => x !== i) : [...p.pageSel, i]); anchor.current = i; }
    else if (e.shiftKey && p.pageSel.length) {
      const a = anchor.current != null && anchor.current < doc.pages.length ? anchor.current : p.pageSel[p.pageSel.length - 1];
      p.setPageSel(pageRange(a, i));
    }
    else { p.setPageSel([i]); p.goTo(i); anchor.current = i; }
  };
  // reorder by dragging (pointer events: works with any mouse/pen, auto-scrolls the panel)
  /** out: past the panel's edge, waiting for the pages to be ready as a file (the button still down) */
  const drag = useRef<{ list: number[]; x: number; y: number; on: boolean; timer: number; v: number; file?: Promise<string>; out?: boolean } | null>(null);
  const dragged = useRef(false);
  /** where pages or files let go at this point go (0: before the first page, n: after the
   *  last) - worked out from the layout, so the gutters between thumbnails and the empty end of
   *  the last row count too (between pages 50 and 51 was "nothing" for a page, "after the last
   *  page" for a file) */
  const slotAt = (x: number, y: number): number | null => {
    const el = box.current;
    if (!el || !rows.length) return null;
    const b = el.getBoundingClientRect();
    if (x < b.left || x > b.right || y < b.top || y > b.bottom) return null;
    const cy = y - b.top + el.scrollTop, cx = x - b.left + el.scrollLeft;
    // (the 8 px between rows and 10 px between columns split half and half)
    const ri = rows.findIndex((r) => cy < r.top + r.h + 4);
    if (ri < 0) return doc.pages.length;
    const ci = Math.max(0, Math.min(cols - 1, Math.floor((cx - 5) / (cw + 10))));
    const i = ri * cols + ci;
    if (i >= doc.pages.length) return doc.pages.length;
    const after = cols > 1 ? cx > 10 + ci * (cw + 10) + cw / 2 : cy > rows[ri].top + rows[ri].h / 2;
    return after ? i + 1 : i;
  };
  /** a page drag is over: its auto-scroll stops */
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (d) { window.clearInterval(d.timer); setDropAt(null); }
    return d;
  };
  useEffect(() => {
    // the button let go outside the panel, or the window lost the mouse: the thumbnail holding
    // the pointer can have scrolled out of the panel (and gone), so nothing here heard it - the
    // auto-scroll then ran on and kept the panel pinned
    const lost = () => { const d = endDrag(); if (d?.out) tooSoon(); if (d?.file) void d.file.then((f) => gcc.dropTemp([f])).catch(() => {}); };
    window.addEventListener('pointerup', lost);
    window.addEventListener('pointercancel', lost);
    window.addEventListener('blur', lost);
    return () => { window.removeEventListener('pointerup', lost); window.removeEventListener('pointercancel', lost); window.removeEventListener('blur', lost); window.clearInterval(drag.current?.timer); };
  }, []);
  /** let go outside the panel before the pages were ready: Windows can't start a file drag with
   *  the button already up (it did nothing, and said nothing) */
  const tooSoon = () => p.toast('The pages were still being made ready when the button was let go – drag them out again (hold the button until the drag starts).', 'info');
  const pdown = (i: number, e: React.PointerEvent) => {
    if (e.button !== 0 || e.ctrlKey || e.shiftKey) return;
    const list = p.pageSel.includes(i) ? [...p.pageSel].sort((a, b) => a - b) : [i];
    drag.current = { list, x: e.clientX, y: e.clientY, on: false, timer: 0, v: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const pmove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.out) return;
    if (!d.on && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    if (!d.on) {
      d.on = true;
      if (!p.pageSel.includes(d.list[0])) p.setPageSel(d.list);
    }
    const b = box.current!.getBoundingClientRect();
    // heading for the panel's edge: get the pages ready as a file, in case they leave it
    // (not for every reorder: that would make a file of the pages each time)
    if (!d.file && (e.clientX > b.right - 40 || e.clientX < b.left + 40)) { d.file = prepare(doc, d.list); d.file.catch(() => {}); }
    // out of the panel: a Windows file drag (desktop, Explorer, Outlook, another tab here)
    if (e.clientX > b.right + 12 || e.clientX < b.left - 12) {
      window.clearInterval(d.timer);
      d.timer = 0;
      d.v = 0;
      setDropAt(null);
      // the pointer stays held here until the file is ready: the file drag starts only while the
      // button is still down (let go first: said, see tooSoon)
      d.out = true;
      const target = e.target as HTMLElement, pid = e.pointerId;
      const icon = dragIcon(box.current!.querySelector(`.thumb[data-page="${d.list[0]}"] canvas`), d.list.length);
      if (!d.file) d.file = prepare(doc, d.list);
      void d.file.then((f) => {
        if (drag.current !== d) return; // let go meanwhile (said; the file was dropped)
        drag.current = null;
        try { target.releasePointerCapture(pid); } catch { /* fine */ }
        return gcc.dragStart(f, icon);
      }).catch((er) => { if (drag.current === d) drag.current = null; p.toast(String((er as Error).message || er), 'err'); });
      return;
    }
    setDropAt(slotAt(e.clientX, e.clientY));
    // near the top/bottom edge: scroll the panel (the timer is only set again when that changes -
    // re-set on every move, a moving hand kept it from ever firing)
    const v = e.clientY < b.top + 40 ? -18 : e.clientY > b.bottom - 40 ? 18 : 0;
    if (v !== d.v) {
      window.clearInterval(d.timer);
      d.v = v;
      d.timer = v ? window.setInterval(() => { if (box.current) box.current.scrollTop += v; }, 30) : 0;
    }
  };
  const pup = async (e: React.PointerEvent) => {
    const at = slotAt(e.clientX, e.clientY);
    const d = endDrag();
    if (!d) return;
    // pages made ready for a drag out that didn't happen
    if (d.file) void d.file.then((f) => gcc.dropTemp([f])).catch(() => {});
    if (d.out) { tooSoon(); return; }
    if (!d.on) return;
    dragged.current = true;
    // (the click that follows the drag is not a page pick - and when there is none, the next real click must not be swallowed)
    window.setTimeout(() => { dragged.current = false; }, 0);
    if (at != null) await p.A.movePages(d.list, at);
  };
  // PDF files dropped in from Explorer: insert them there
  const over = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDropAt(slotAt(e.clientX, e.clientY));
  };
  const drop = async (e: React.DragEvent) => {
    e.preventDefault();
    // (dropped on the panel: inserted here - not left to the window, which opens it as a tab)
    e.stopPropagation();
    // where it was let go (the last dragover can be stale: coalesced, or the list scrolled under a still pointer)
    const at = slotAt(e.clientX, e.clientY) ?? dropAt;
    setDropAt(null);
    if (at == null) return;
    const all = Array.from(e.dataTransfer.files).map((f) => gcc.pathOf(f));
    const files = all.filter((x) => /\.pdf$/i.test(x));
    const pics = all.filter((x) => /\.(jpe?g|jfif|png|tiff?|bmp|gif)$/i.test(x));
    let pos = at;
    // pictures and scans dropped here: pages, in place (each at its own size)
    if (pics.length) {
      let made: string | null = null;
      try {
        const r = await muBatchFile<{ bytes: FileRef; pages: number; skipped: string[] }>('picturesToPdf', pics.map((f) => ({ bytes: fileArg(f), name: f.split(/[\\/]/).pop() || f })), { size: 'picture' });
        made = r.bytes.$file.path;
        const before = doc.pages.length;
        await doc.insertFrom(pos, made);
        pos += doc.pages.length - before;
        p.toast(`${r.pages} page${r.pages === 1 ? '' : 's'} made of ${pics.length === 1 ? 'the picture' : pics.length + ' pictures'}${r.skipped.length ? ` – not read: ${r.skipped.join(', ')}` : ''}.`, r.skipped.length ? 'info' : 'ok');
      } catch (er) { p.toast(String((er as Error).message || er), 'err'); }
      finally { if (made) void gcc.dropTemp([made]); }
    }
    const other = all.length - files.length - pics.length;
    if (other) p.toast(`${other} file${other === 1 ? '' : 's'} left out – only PDFs and pictures (JPG, PNG, TIFF, BMP, GIF) go in.`, 'info');
    for (const f of files) {
      try {
        const before = doc.pages.length;
        // pages dragged out of this or another tab
        if (await dropPages(doc, f, pos, (pg, to) => p.A.movePages(pg, to))) { if (doc.pages.length > before) pos += doc.pages.length - before; continue; }
        await doc.insertFrom(pos, f);
        pos += doc.pages.length - before;
      } catch (er) { p.toast(String((er as Error).message || er), 'err'); }
    }
  };
  return (
    <div className="thumbs" ref={box} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null); }}
      onDragOver={over} onDrop={(e) => void drop(e)}
      onPointerMove={pmove} onPointerUp={(e) => void pup(e)}>
      <div style={{ height: total, position: 'relative' }}>
        {vis.map((i) => {
          const ri = Math.floor(i / cols), ci = i % cols;
          const pg = doc.pages[i];
          const h = (iw * pg.h) / pg.w;
          return (
            <div key={i} data-page={i} className={'thumb' + (i === p.page ? ' cur' : '') + (p.pageSel.includes(i) ? ' sel' : '')}
              style={{ top: rows[ri].top, left: 10 + ci * (cw + 10), width: cw }}
              onPointerDown={(e) => pdown(i, e)}
              onClick={(e) => click(i, e)} onDoubleClick={() => p.goTo(i)} onContextMenu={(e) => ctx(i, e)}>
              <div className="tpic" style={{ width: iw, height: h }}>
                <ThumbCanvas doc={doc} page={i} w={iw} h={h} />
                <ViewBox doc={doc} page={i} w={iw} h={h} panTo={(x, y) => p.A.panTo(i, x, y)} />
              </div>
              <div className="tlabel">{pg.label}{pg.rot ? ` · ${pg.rot}°` : ''}</div>
              {dropAt === i && <div className={'dropline' + (cols > 1 ? ' v' : '')} />}
              {dropAt === i + 1 && (i % cols === cols - 1 || i === doc.pages.length - 1) && <div className={'dropline after' + (cols > 1 ? ' v' : '')} />}
            </div>
          );
        })}
      </div>
      {menu && <ThumbMenu {...menu} sel={p.pageSel.includes(menu.page) ? [...p.pageSel].sort((a, b) => a - b) : [menu.page]} pages={doc.pages.length} A={p.A} goTo={p.goTo} close={() => setMenu(null)} />}
    </div>
  );
}

function ThumbMenu(m: { x: number; y: number; page: number; sel: number[]; pages: number; A: Record<string, any>; goTo(p: number): void; close(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: m.x, top: m.y });
  // keep it on screen
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(4, Math.min(m.x, window.innerWidth - r.width - 6)), top: Math.max(4, Math.min(m.y, window.innerHeight - r.height - 6)) });
  }, [m.x, m.y]);
  const n = m.sel.length;
  const what = n > 1 ? `${n} pages` : 'page';
  /** AI on one page: that page is shown first (the panel works on the page in view) */
  const ai = (t: 'translate' | 'ask') => { if (n === 1) m.goTo(m.page); m.A.ai(t); };
  const item = (label: string, run: () => unknown, dis = false) => (
    <button disabled={dis} onClick={() => { m.close(); void run(); }}>{label}</button>
  );
  return (
    <div className="cmenu" ref={ref} style={pos} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {n === 1 && item(`Go to page ${m.page + 1}`, () => m.goTo(m.page))}
      {n === 1 && <div className="sep" />}
      {item(`Rotate ${what} right`, () => m.A.rotate(90))}
      {item(`Rotate ${what} left`, () => m.A.rotate(270))}
      {item(`Rotate ${what} 180°`, () => m.A.rotate(180))}
      <div className="sep" />
      {item(`Duplicate ${what}`, () => m.A.duplicate())}
      {item(`Extract ${what}…`, () => m.A.extract())}
      {item(`Save ${what} as pictures…`, () => m.A.toPictures())}
      {item(`Delete ${what}…`, () => m.A.deletePages(), n >= m.pages)}
      <div className="sep" />
      {item('Insert blank page before', () => m.A.insertBlank(m.page))}
      {item('Insert blank page after', () => m.A.insertBlank(m.page + 1))}
      {item('Insert pages from another file…', () => m.A.insertFile(m.page + 1))}
      {item(`Replace ${what}…`, () => m.A.replacePages())}
      <div className="sep" />
      {item(`Make ${what} searchable (OCR)…`, () => m.A.ocr(m.sel))}
      {item(`Translate ${what}…`, () => ai('translate'))}
      {item(`Ask AI about ${what}…`, () => ai('ask'))}
    </div>
  );
}

/**
 * Where the view is on this page, when zoomed in: a box over the thumbnail. Drag it to move
 * around the page (the rest of the thumbnail still selects / drags pages as usual).
 */
function ViewBox({ doc, page, w, h, panTo }: { doc: PdfDoc; page: number; w: number; h: number; panTo(x: number, y: number): void }) {
  const [r, setR] = useState<number[] | null>(() => doc.visRects.get(page) ?? null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  useEffect(() => doc.onView(() => {
    const n = doc.visRects.get(page) ?? null;
    setR((o) => (o && n && o.every((v, k) => Math.abs(v - n[k]) < 0.5) ? o : n));
  }), [doc, page]);
  const pg = doc.pages[page];
  if (!r || !pg) return null;
  // the whole page (or nearly) in view: no box
  if ((r[2] - r[0]) * (r[3] - r[1]) > pg.w * pg.h * 0.9) return null;
  const k = w / pg.w;
  // pointer position in page coordinates (the box sits in .vbox-area, which covers the picture)
  // a box covering most of the thumbnail is only shown: grabbing the thumbnail must still
  // drag the page (to reorder it), not pan the view
  const grab = (r[2] - r[0]) * (r[3] - r[1]) < pg.w * pg.h * 0.4;
  const at = (e: React.PointerEvent) => { const b = ((e.currentTarget as HTMLElement).parentElement as HTMLElement).getBoundingClientRect(); return [(e.clientX - b.left) / k, (e.clientY - b.top) / k]; };
  return (
    <div className="vbox-area">
      <div className="vbox" title={grab ? 'The part of the page in view – drag it to move around' : undefined}
        style={{ left: r[0] * k, top: r[1] * k, width: Math.max(4, (r[2] - r[0]) * k), height: Math.max(4, (r[3] - r[1]) * k), pointerEvents: grab ? 'auto' : 'none' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const [x, y] = at(e);
          drag.current = { dx: (r[0] + r[2]) / 2 - x, dy: (r[1] + r[3]) / 2 - y };
        }}
        onPointerMove={(e) => { if (!drag.current) return; const [x, y] = at(e); panTo(Math.max(0, Math.min(pg.w, x + drag.current.dx)), Math.max(0, Math.min(pg.h, y + drag.current.dy))); }}
        onPointerUp={() => { drag.current = null; }}
        onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} />
    </div>
  );
}

function ThumbCanvas({ doc, page, w, h }: { doc: PdfDoc; page: number; w: number; h: number }) {
  const c = useRef<HTMLCanvasElement>(null);
  const pg = doc.pages[page];
  const rev = doc.crev[page];
  const key = `${doc.id}|r${rev}`;
  useEffect(() => {
    const el = c.current;
    if (!el || !pg) return;
    const d = window.devicePixelRatio || 1;
    const W = Math.round(w * d), H = Math.round(h * d);
    // a changed page keeps its old picture until the new one is drawn over it
    if (el.width !== W || el.height !== H) {
      el.width = W; el.height = H;
      const g = el.getContext('2d')!;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, W, H);
    }
    const done = new Set<string>();
    if (drawPreview(el, doc.id, rev, page, pg.w, pg.h, done)) return;
    return tiles.onReady((k) => { if (k.startsWith(key + '|p|')) drawPreview(el, doc.id, rev, page, pg.w, pg.h, done); });
  }, [key, w, h]);
  return <canvas ref={c} className="tcanvas" style={{ width: w, height: h }} />;
}

// ---------------------------------------------------------------- bookmarks

/** a place in the bookmark tree: indexes from the top */
type BPath = number[];
const pkey = (p: BPath) => p.join('/');
const pOf = (k: string): BPath => (k ? k.split('/').map(Number) : []);
function nodeAt(l: OutNode[], p: BPath): OutNode | null {
  let cur: OutNode | null = null;
  let list = l;
  for (const i of p) { cur = list[i] ?? null; if (!cur) return null; list = cur.children; }
  return cur;
}
const listAt = (l: OutNode[], parent: BPath): OutNode[] => (parent.length ? nodeAt(l, parent)?.children ?? [] : l);
const removeAt = (l: OutNode[], p: BPath): OutNode => listAt(l, p.slice(0, -1)).splice(p[p.length - 1], 1)[0];
const insertAt = (l: OutNode[], p: BPath, n: OutNode) => { listAt(l, p.slice(0, -1)).splice(p[p.length - 1], 0, n); };
const inside = (p: BPath, anc: BPath) => p.length > anc.length && anc.every((v, i) => v === p[i]);
/** where place `p` is once the item at `gone` is taken out */
function afterRemoval(p: BPath, gone: BPath): BPath {
  const d = gone.length - 1;
  if (p.length > d && gone.slice(0, d).every((v, i) => v === p[i]) && p[d] > gone[d]) { const q = p.slice(); q[d]--; return q; }
  return p;
}
const countAll = (l: OutNode[]): number => l.reduce((n, m) => n + 1 + countAll(m.children), 0);

/**
 * The file's bookmarks, editable: add one for the page in view, rename (F2 / double-click), delete,
 * move (drag, or Alt+arrows), point it at the page in view. Each change is one undo step and is
 * saved into the PDF; colours, bold and the exact view of the others are kept.
 */
function Bookmarks(p: Props) {
  const doc = p.doc;
  const [marks, setMarks] = useState<OutNode[] | null>(null);
  const [sel, setSel] = useState('');
  const [editing, setEditing] = useState('');
  const [shown, setShown] = useState<Map<string, boolean>>(() => new Map());
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [drop, setDrop] = useState<{ key: string; where: 'before' | 'after' | 'in' } | null>(null);
  const dragFrom = useRef<string | null>(null);
  const working = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  /** the file the panel shows now (a late answer for the file shown before is dropped) */
  const shownId = useRef(doc.id);
  shownId.current = doc.id;
  const reload = () => (async () => { const id = doc.id; const m = await mu<OutNode[]>('outlineFull', id).catch(() => []); if (shownId.current === id) setMarks(m); })();
  // (per file: another tab shows its own bookmarks; page changes and undo read them again)
  useEffect(() => { setSel(''); setEditing(''); setShown(new Map()); setMarks(null); }, [doc.id]);
  useEffect(() => {
    let live = true;
    void (async () => { const m = await mu<OutNode[]>('outlineFull', doc.id).catch(() => []); if (live) setMarks(m); })();
    return () => { live = false; };
  }, [doc.id, doc.baseRev, doc.marksRev]);
  const isOpen = (k: string, m: OutNode, d: number) => shown.get(k) ?? (m.open || d === 0);
  const expand = (k: string) => setShown((s) => { const n = new Map(s); for (let q = pOf(k); q.length; q = q.slice(0, -1)) n.set(pkey(q), true); return n; });
  const apply = async (t: OutNode[], label: string, select?: BPath, edit = false) => {
    if (working.current) return;
    working.current = true;
    const id = doc.id;
    setMarks(t);
    try {
      const r = await doc.setOutline(t, label);
      // (another tab came to the front meanwhile: its own bookmarks are shown, not these)
      if (shownId.current !== id) return;
      setMarks(r);
      if (select) { setSel(pkey(select)); if (select.length > 1) expand(pkey(select.slice(0, -1))); }
      if (edit && select) setEditing(pkey(select));
    } catch (e) { p.toast(String((e as Error)?.message || e), 'err'); void reload(); }
    finally {
      working.current = false;
      // (the keys go on working in the list - after a rename or a menu the focus fell to the page,
      // and Delete deleted the markup chosen there)
      if (shownId.current === id && !edit) box.current?.focus({ preventScroll: true });
    }
  };
  const page = p.page;
  // (named after the page's own label - "A-101" - when it has one, else "Page 5")
  const fresh = (): OutNode => { const lb = doc.pages[page]?.label; return { title: lb && lb !== String(page + 1) ? lb : `Page ${page + 1}`, page, uri: null, open: false, children: [] }; };
  const A = {
    add: () => {
      if (!marks) return;
      const t = structuredClone(marks);
      const at = sel && nodeAt(t, pOf(sel)) ? [...pOf(sel).slice(0, -1), pOf(sel).slice(-1)[0] + 1] : [t.length];
      insertAt(t, at, fresh());
      void apply(t, 'Add bookmark', at, true);
    },
    addUnder: (k: string) => {
      const t = structuredClone(marks!);
      const n = nodeAt(t, pOf(k));
      if (!n) return;
      n.children.push(fresh());
      expand(k);
      void apply(t, 'Add bookmark', [...pOf(k), n.children.length - 1], true);
    },
    rename: (k: string, title: string) => {
      setEditing('');
      const t = structuredClone(marks!);
      const n = nodeAt(t, pOf(k));
      const v = title.replace(/\s+/g, ' ').trim();
      if (!n || !v || v === n.title) return;
      n.title = v;
      void apply(t, 'Rename bookmark', pOf(k));
    },
    remove: async (k: string) => {
      const t = structuredClone(marks!);
      const path = pOf(k);
      const n = nodeAt(t, path);
      if (!n) return;
      if (n.children.length) {
        const under = countAll(n.children);
        const r = await gcc.confirm({ message: `Delete “${n.title}” and the ${under} bookmark${under === 1 ? '' : 's'} under it?`, detail: 'You can undo this with Ctrl+Z.', buttons: ['Delete', 'Cancel'] });
        if (r !== 0) return;
      }
      removeAt(t, path);
      const sibs = listAt(t, path.slice(0, -1));
      const next = sibs.length ? [...path.slice(0, -1), Math.min(path[path.length - 1], sibs.length - 1)] : path.slice(0, -1);
      void apply(t, 'Delete bookmark', next.length ? next : undefined);
      if (!next.length) setSel('');
    },
    toPage: (k: string) => {
      const t = structuredClone(marks!);
      const n = nodeAt(t, pOf(k));
      if (!n) return;
      n.page = page; n.uri = null; n.repoint = true;
      void apply(t, `Bookmark to page ${page + 1}`, pOf(k));
    },
    /** to place `to` (counted before the move) */
    move: (k: string, to: BPath) => {
      const from = pOf(k);
      if (pkey(to) === k || inside(to, from)) return;
      const t = structuredClone(marks!);
      const n = removeAt(t, from);
      const at = afterRemoval(to, from);
      if (at.length > 1 && !nodeAt(t, at.slice(0, -1))) return;
      insertAt(t, at, n);
      void apply(t, 'Move bookmark', at);
    },
    up: (k: string) => { const q = pOf(k); if (q[q.length - 1] > 0) A.move(k, [...q.slice(0, -1), q[q.length - 1] - 1]); },
    down: (k: string) => { const q = pOf(k); if (q[q.length - 1] < listAt(marks!, q.slice(0, -1)).length - 1) A.move(k, [...q.slice(0, -1), q[q.length - 1] + 2]); },
    indent: (k: string) => {
      const q = pOf(k);
      const i = q[q.length - 1];
      if (i === 0) return;
      const prev = [...q.slice(0, -1), i - 1];
      expand(pkey(prev));
      A.move(k, [...prev, nodeAt(marks!, prev)!.children.length]);
    },
    outdent: (k: string) => { const q = pOf(k); if (q.length > 1) A.move(k, [...q.slice(0, -2), q[q.length - 2] + 1]); },
  };
  const keys = (e: React.KeyboardEvent) => {
    if (editing || !marks) return;
    const k = sel;
    const n = k ? nodeAt(marks, pOf(k)) : null;
    // (the panel's keys never reach the page, whether or not a bookmark is chosen)
    if (['Delete', 'F2', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) e.stopPropagation();
    let done = true;
    if (e.key === 'F2' && n) setEditing(k);
    else if (e.key === 'Delete' && n) void A.remove(k);
    else if (e.key === 'Enter' && n) { if (n.page >= 0) p.goTo(n.page); }
    else if (e.altKey && e.key === 'ArrowUp' && n) A.up(k);
    else if (e.altKey && e.key === 'ArrowDown' && n) A.down(k);
    else if (e.altKey && e.key === 'ArrowRight' && n) A.indent(k);
    else if (e.altKey && e.key === 'ArrowLeft' && n) A.outdent(k);
    else if (!e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      // the next / previous bookmark shown
      const flat: string[] = [];
      const walk = (l: OutNode[], base: BPath, d: number) => l.forEach((m, i) => { const q = [...base, i]; flat.push(pkey(q)); if (m.children.length && isOpen(pkey(q), m, d)) walk(m.children, q, d + 1); });
      walk(marks, [], 0);
      const j = flat.indexOf(k);
      const to = flat[Math.max(0, Math.min(flat.length - 1, j < 0 ? 0 : j + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (to) { setSel(to); box.current?.querySelector(`[data-k="${to}"]`)?.scrollIntoView({ block: 'nearest' }); }
    } else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  };
  // a right-click menu closes on a click elsewhere or Escape
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc, true); };
  }, [menu]);
  const dragOver = (e: React.DragEvent, k: string) => {
    if (!dragFrom.current) return;
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const where = y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'in';
    const ok = dragFrom.current !== k && !inside(pOf(k), pOf(dragFrom.current));
    // (only when it changes: a new object every dragover redrew the whole tree ~20 times a second)
    setDrop((d) => (ok ? (d && d.key === k && d.where === where ? d : { key: k, where }) : d ? null : d));
    e.dataTransfer.dropEffect = ok ? 'move' : 'none';
  };
  const dropOn = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const from = dragFrom.current, d = drop;
    dragFrom.current = null;
    setDrop(null);
    if (!from || !d || !marks) return;
    const q = pOf(d.key);
    if (d.where === 'in') { expand(d.key); A.move(from, [...q, nodeAt(marks, q)!.children.length]); }
    else A.move(from, d.where === 'before' ? q : [...q.slice(0, -1), q[q.length - 1] + 1]);
  };
  const node = (m: OutNode, q: BPath, d: number): React.ReactNode => {
    const k = pkey(q);
    const open = isOpen(k, m, d);
    const style: React.CSSProperties = { paddingLeft: 8 + d * 14 };
    const tstyle: React.CSSProperties = { ...(m.c ? { color: `rgb(${m.c.map((x) => Math.round(x * 255)).join(',')})` } : {}), ...(m.f && m.f & 2 ? { fontWeight: 700 } : {}), ...(m.f && m.f & 1 ? { fontStyle: 'italic' } : {}) };
    return (
      <div key={k}>
        <div className={'bm' + (sel === k ? ' sel' : '') + (drop?.key === k ? ' drop-' + drop.where : '')} style={style} data-k={k}
          draggable={editing !== k} onDragStart={(e) => { dragFrom.current = k; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', m.title); }}
          onDragEnd={() => { dragFrom.current = null; setDrop(null); }} onDragOver={(e) => dragOver(e, k)} onDrop={dropOn}
          onContextMenu={(e) => { e.preventDefault(); setSel(k); setMenu({ x: e.clientX, y: e.clientY, key: k }); }}>
          {m.children.length ? <button className="tw" onClick={() => setShown((s) => new Map(s).set(k, !open))}><Ico n={open ? 'chev' : 'chevr'} size={12} /></button> : <span className="tw" />}
          {editing === k
            ? <BmEdit title={m.title} done={(v) => { if (v === null) setEditing(''); else A.rename(k, v); window.setTimeout(() => box.current?.focus({ preventScroll: true }), 0); }} />
            : <button className="bmt" style={tstyle} onClick={() => { setSel(k); if (m.page >= 0) p.goTo(m.page); }} onDoubleClick={() => setEditing(k)} title={m.title + (m.page >= 0 ? ` – page ${m.page + 1}` : m.uri ? ` – ${m.uri}` : '')}>{m.title || '(no title)'}</button>}
          {m.page >= 0 && editing !== k && <span className="faint">{doc.pages[m.page]?.label || m.page + 1}</span>}
        </div>
        {open && m.children.map((c, i) => node(c, [...q, i], d + 1))}
      </div>
    );
  };
  const selNode = sel && marks ? nodeAt(marks, pOf(sel)) : null;
  return (
    <div className="side-body col">
      <div className="bm-tools">
        <button className="btn sm" onClick={A.add} disabled={!marks} title={`A bookmark for page ${page + 1} (the page in view), ${selNode ? 'after the one chosen' : 'at the end'}`}><Ico n="plus" size={13} /> Add</button>
        <button className="btn sm ghost" disabled={!selNode} onClick={() => setEditing(sel)} title="Rename (F2)">Rename</button>
        <button className="btn sm ghost" disabled={!selNode} onClick={() => void A.remove(sel)} title="Delete (Del)">Delete</button>
        <button className="btn sm ghost" disabled={!selNode} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 2, key: sel }); }} onPointerDown={(e) => e.stopPropagation()} title="More">⋯</button>
      </div>
      <div className="bm-list" ref={box} tabIndex={0} onKeyDown={keys}
        onDragOver={(e) => { if (dragFrom.current && marks?.length) { e.preventDefault(); if (e.target === e.currentTarget) setDrop((d) => (d ? null : d)); } }}
        onDrop={(e) => { if (dragFrom.current && marks && (!drop || e.target === e.currentTarget)) { e.preventDefault(); const from = dragFrom.current; dragFrom.current = null; setDrop(null); A.move(from, [marks.length]); } }}>
        {!marks ? <div className="faint pad">Reading…</div>
          : !marks.length ? <div className="faint pad">This file has no bookmarks. Go to a page and press Add to make one.</div>
          : marks.map((m, i) => node(m, [i], 0))}
      </div>
      {menu && selNode && (
        <div className="cmenu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 330) }} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          {([
            [`Go to page ${selNode.page + 1}`, () => p.goTo(selNode.page), selNode.page < 0, ''],
            ['Rename', () => setEditing(menu.key), false, 'F2'],
            [`Point it at page ${page + 1} (in view)`, () => A.toPage(menu.key), false, ''],
            ['sep'],
            ['Add a bookmark after it', () => A.add(), false, ''],
            ['Add a bookmark under it', () => A.addUnder(menu.key), false, ''],
            ['sep'],
            ['Move up', () => A.up(menu.key), pOf(menu.key).slice(-1)[0] === 0, 'Alt+↑'],
            ['Move down', () => A.down(menu.key), pOf(menu.key).slice(-1)[0] >= listAt(marks!, pOf(menu.key).slice(0, -1)).length - 1, 'Alt+↓'],
            ['Move in (under the one above)', () => A.indent(menu.key), pOf(menu.key).slice(-1)[0] === 0, 'Alt+→'],
            ['Move out', () => A.outdent(menu.key), pOf(menu.key).length < 2, 'Alt+←'],
            ['sep'],
            [selNode.children.length ? `Delete (and the ${countAll(selNode.children)} under it)` : 'Delete', () => void A.remove(menu.key), false, 'Del'],
          ] as [string, (() => void)?, boolean?, string?][]).map(([label, run, dis, key], i) => label === 'sep'
            ? <div key={i} className="sep" />
            : <button key={i} disabled={!!dis} onClick={() => { setMenu(null); run!(); window.setTimeout(() => { if (!document.querySelector('.bm-list input.bmedit')) box.current?.focus({ preventScroll: true }); }, 0); }}>{label}{key && <span className="k">{key}</span>}</button>)}
        </div>
      )}
    </div>
  );
}
/** typing a bookmark's name: Enter or a click elsewhere keeps it, Escape leaves it as it was */
function BmEdit({ title, done }: { title: string; done(v: string | null): void }) {
  const ended = useRef(false);
  const end = (v: string | null) => { if (ended.current) return; ended.current = true; done(v); };
  return <input className="input sm bmedit" autoFocus defaultValue={title} onFocus={(e) => e.currentTarget.select()} onBlur={(e) => end(e.currentTarget.value)}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') end(e.currentTarget.value); else if (e.key === 'Escape') end(null); }} />;
}

// ---------------------------------------------------------------- comments organizer

const TYPE_NAMES: Record<string, string> = {
  Text: 'Comment', FreeText: 'Text box', Square: 'Rectangle', Circle: 'Ellipse', Line: 'Line', PolyLine: 'Polyline', Polygon: 'Polygon',
  Ink: 'Pencil', Highlight: 'Highlight', Underline: 'Underline', StrikeOut: 'Strikeout', Squiggly: 'Squiggly', Stamp: 'Stamp', Redact: 'Redaction', Caret: 'Insert', FileAttachment: 'Attachment',
};
export function markupName(a: AnnotData): string {
  if (a.kind === 'callout' || a.intent === 'FreeTextCallout') return 'Callout';
  if (a.kind === 'typewriter') return 'Typewriter';
  if (a.kind === 'area-highlight') return 'Area highlight';
  if (a.kind === 'signature') return 'Signature';
  if (a.kind === 'image') return 'Image';
  if (a.kind?.startsWith('measure-')) return (a.subject || a.kind.slice(8)).replace(/^./, (c) => c.toUpperCase());
  if (a.cloudy && (a.type === 'Polygon' || a.type === 'Square')) return 'Cloud';
  if (a.type === 'Line' && a.le && a.le.some((x) => x !== 'None')) return 'Arrow';
  if (a.type === 'Stamp' && a.subject) return 'Stamp: ' + a.subject;
  return TYPE_NAMES[a.type] || a.type;
}
const category = (a: AnnotData) => a.kind?.startsWith('measure-') ? 'Measurements' : a.type === 'Stamp' ? 'Stamps & signatures' : a.type === 'Redact' ? 'Redaction marks' : ['Highlight', 'Underline', 'StrikeOut', 'Squiggly'].includes(a.type) ? 'Text markup' : ['Text', 'FreeText'].includes(a.type) ? 'Comments & text' : 'Drawings';

/** what the Comments list shows (form fields and pop-up notes are not markups) */
const listed = (a: AnnotData) => a.type !== 'Widget' && a.type !== 'Popup' && a.type !== 'Link';
/** the colour a markup is shown, grouped and exported with (a text box's colour is its text's
 *  when it has no box colour - grouped and exported as "No colour" while shown in colour) */
const shownColor = (a: AnnotData) => a.color || a.ic || a.font?.color || null;

/**
 * Every markup of the file, kept up to date: after a change only the pages whose markups changed
 * are read again (each change read every page of the file again - seconds on a long one).
 * null while being read.
 */
function useAllMarkups(p: Props, keep: (a: AnnotData) => boolean): AnnotData[] | null {
  const { doc } = p;
  const [all, setAll] = useState<AnnotData[] | null>(null);
  const perPage = useRef<{ doc: PdfDoc; revs: number[]; pages: AnnotData[][] } | null>(null);
  useEffect(() => {
    let live = true;
    const c = perPage.current?.doc === doc ? perPage.current : null;
    if (!c) setAll(null);
    const revs = doc.annRev.slice();
    const changed = c && c.revs.length === revs.length ? revs.flatMap((r, i) => (r !== c.revs[i] ? [i] : [])) : null;
    if (changed && !changed.length) return;
    const job: Promise<AnnotData[][]> = changed && changed.length <= 40
      ? Promise.all(changed.map((pg) => doc.annots(pg))).then((lists) => {
        const pages = c!.pages.slice();
        changed.forEach((pg, k) => { pages[pg] = lists[k].filter(keep); });
        return pages;
      })
      : doc.allAnnots().then((list) => {
        const pages: AnnotData[][] = revs.map(() => []);
        for (const a of list) if (keep(a)) (pages[a.page] ??= []).push(a);
        return pages;
      });
    void job.then((pages) => {
      if (!live) return;
      perPage.current = { doc, revs, pages };
      setAll(pages.flat());
    }).catch((e) => {
      if (!live) return;
      perPage.current = null;
      setAll([]);
      p.toast("The markups couldn't be read: " + String((e as Error)?.message || e), 'err');
    });
    return () => { live = false; };
  }, [p.rev, doc]);
  return all;
}

// ---------------------------------------------------------------- counts & totals (0.8.5)

type Sums = Map<string, { v: number; dec: number }>;
const addTo = (m: Sums, unit: string, v: number, dec: number) => { const x = m.get(unit); if (x) { x.v += v; x.dec = Math.max(x.dec, dec); } else m.set(unit, { v, dec }); };
const sumText = (m: Sums) => [...m].map(([u, x]) => `${x.v.toLocaleString('en-GB', { minimumFractionDigits: x.dec, maximumFractionDigits: x.dec })} ${u}`).join(' + ');
const KIND_NAME: Record<string, string> = { 'measure-length': 'Lengths', 'measure-polylength': 'Polylengths', 'measure-perimeter': 'Perimeters', 'measure-area': 'Areas', 'area-perimeter': 'Areas: perimeters', 'measure-angle': 'Angles' };
const KIND_ORDER = ['measure-length', 'measure-polylength', 'measure-perimeter', 'measure-area', 'area-perimeter', 'measure-angle'];

/**
 * Counts & totals: every count name with how many (per page too), and the measurements added up
 * by kind - in the app, without going to Excel. A name: select all its marks, count more of it,
 * or open its pages; a page: go there with its marks selected.
 */
function Totals(p: Props) {
  const { doc } = p;
  const all = useAllMarkups(p, (a) => !!a.kind?.startsWith('measure-'));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const pageName = (pg: number) => doc.pages[pg]?.label || String(pg + 1);
  const data = useMemo(() => {
    const counts = new Map<string, { items: AnnotData[]; color: number[] | null; pages: Map<number, AnnotData[]> }>();
    const kinds = new Map<string, { items: AnnotData[]; sums: Sums; pages: Map<number, { n: number; sums: Sums }> }>();
    for (const a of all || []) {
      if (a.irt != null) continue;
      if (a.kind === 'measure-count') {
        const g = a.group || 'Count';
        let c = counts.get(g);
        if (!c) counts.set(g, (c = { items: [], color: a.ic || a.color || null, pages: new Map() }));
        c.items.push(a);
        if (!c.pages.has(a.page)) c.pages.set(a.page, []);
        c.pages.get(a.page)!.push(a);
        continue;
      }
      const k = a.kind!;
      if (!KIND_NAME[k]) continue;
      let m = kinds.get(k);
      if (!m) kinds.set(k, (m = { items: [], sums: new Map(), pages: new Map() }));
      m.items.push(a);
      let pm = m.pages.get(a.page);
      if (!pm) m.pages.set(a.page, (pm = { n: 0, sums: new Map() }));
      pm.n++;
      if (k === 'measure-angle') continue; // (angles aren't added up)
      const n = measureNumber(a, (pg, x, y) => doc.scaleAt(pg, x, y));
      if (n) { addTo(m.sums, n.unit, n.v, n.dec); addTo(pm.sums, n.unit, n.v, n.dec); }
      // an area's perimeter: added up on a row of its own (skirting, edging...)
      if (k === 'measure-area') {
        const pn = perimeterNumber(a, (pg, x, y) => doc.scaleAt(pg, x, y));
        if (!pn) continue;
        let q = kinds.get('area-perimeter');
        if (!q) kinds.set('area-perimeter', (q = { items: [], sums: new Map(), pages: new Map() }));
        q.items.push(a);
        let qp = q.pages.get(a.page);
        if (!qp) q.pages.set(a.page, (qp = { n: 0, sums: new Map() }));
        qp.n++;
        addTo(q.sums, pn.unit, pn.v, pn.dec); addTo(qp.sums, pn.unit, pn.v, pn.dec);
      }
    }
    const cl = [...counts].sort((x, y) => x[0].localeCompare(y[0], undefined, { numeric: true }));
    const kl = [...kinds].sort((x, y) => KIND_ORDER.indexOf(x[0]) - KIND_ORDER.indexOf(y[0]));
    return { counts: cl, kinds: kl, nCount: cl.reduce((t, [, c]) => t + c.items.length, 0) };
    // (and the scales: a label typed by hand counts at the scale where it is - a scale change
    // changes no markup, and the old total stayed)
  }, [all, doc, doc.data, doc.pages]);
  const pick = (items: AnnotData[]) => {
    if (!items.length) return;
    const first = items.reduce((b, a) => (a.page < b.page || (a.page === b.page && a.rect[1] < b.rect[1]) ? a : b));
    // (to the first page with them, showing all of them there)
    const on = items.filter((a) => a.page === first.page);
    const box = on.reduce((r, a) => [Math.min(r[0], a.rect[0]), Math.min(r[1], a.rect[1]), Math.max(r[2], a.rect[2]), Math.max(r[3], a.rect[3])], [Infinity, Infinity, -Infinity, -Infinity]);
    p.setSel(items.map((a) => ({ page: a.page, id: a.id })));
    p.goTo(first.page, box);
  };
  const sorted = (m: Map<number, unknown>) => [...m.keys()].sort((a, b) => a - b);
  return (
    <div className="side-body col totals">
      <div className="tt-list">
        {!all && <div className="faint pad">Reading…</div>}
        {all && !data.counts.length && !data.kinds.length && <div className="faint pad">No counts or measurements in this file yet – Measure tab: Count, Length, Area…</div>}
        {data.counts.length > 0 && (
          <div className="tt-sec">
            <div className="tt-h"><span>Counts</span><span className="tt-sum">{data.nCount}</span></div>
            {data.counts.map(([g, c]) => (
              <div key={'c:' + g} className="tt-grp">
                <div className="tt-row">
                  <button className="tt-fold" onClick={() => toggle('c:' + g)} title={open['c:' + g] ? 'Fold' : 'Show the pages'}><span style={{ display: 'inline-flex', transform: open['c:' + g] ? 'rotate(90deg)' : 'none' }}><Ico n="chevr" size={12} /></span></button>
                  <span className="tt-sw" style={{ background: css(c.color || [0.86, 0.13, 0.13]) }} />
                  <button className="tt-name" onClick={() => pick(c.items)} title={`Select all ${c.items.length} marks of "${g}"`}>{g}</button>
                  <span className="tt-n">{c.items.length}</span>
                  <button className="btn xs" onClick={() => p.A.countWith(g)} title={`Count more "${g}" (the Count tool, counting this)`}>+ Count</button>
                </div>
                {open['c:' + g] && sorted(c.pages).map((pg) => (
                  <button key={pg} className="tt-pg" onClick={() => pick(c.pages.get(pg)!)} title="Go there, its marks selected">
                    <span>Page {pageName(pg)}</span><span className="tt-n">{c.pages.get(pg)!.length}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {data.kinds.length > 0 && (
          <div className="tt-sec">
            <div className="tt-h"><span>Measurements</span></div>
            {data.kinds.map(([k, m]) => (
              <div key={k} className="tt-grp">
                <div className="tt-row">
                  <button className="tt-fold" onClick={() => toggle(k)} title={open[k] ? 'Fold' : 'Show the pages'}><span style={{ display: 'inline-flex', transform: open[k] ? 'rotate(90deg)' : 'none' }}><Ico n="chevr" size={12} /></span></button>
                  <button className="tt-name" onClick={() => pick(m.items)} title={`Select all ${m.items.length}`}>{KIND_NAME[k]} <span className="faint">({m.items.length})</span></button>
                  <span className="tt-n wide">{k === 'measure-angle' ? '' : sumText(m.sums) || '–'}</span>
                </div>
                {open[k] && sorted(m.pages).map((pg) => {
                  const x = m.pages.get(pg)!;
                  return (
                    <button key={pg} className="tt-pg" onClick={() => pick(m.items.filter((a) => a.page === pg))} title="Go there, these selected">
                      <span>Page {pageName(pg)} <span className="faint">({x.n})</span></span><span className="tt-n wide">{k === 'measure-angle' ? '' : sumText(x.sums)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {data.kinds.some(([, m]) => m.sums.size > 1) && <div className="faint small pad">Different units are added up apart (pages without a scale measure on paper).</div>}
          </div>
        )}
      </div>
      <div className="tt-foot">
        <button className="btn sm" onClick={() => p.A.countByTag()} title="Count by tag: the tags written on the drawing (door marks D01, D02…) found and counted in one go"><Ico n="search" size={14} /> Count by tag…</button>
        <span className="grow" />
        <button className="btn sm" onClick={() => p.A.exportMeasurements()} disabled={!all || (!data.counts.length && !data.kinds.length)} title="Every measurement and count of this file to an Excel file"><Ico n="excel" size={14} /> To Excel</button>
      </div>
    </div>
  );
}

function Comments(p: Props) {
  const { doc } = p;
  // (null: being read - another file's list is not shown meanwhile)
  const [all, setAll] = useState<AnnotData[] | null>(null);
  const [group, setGroup] = useState<'page' | 'type' | 'author' | 'color' | 'status' | 'category'>(() => (localStorage.getItem('cm-group') as never) || 'page');
  const [q, setQ] = useState('');
  const [show, setShow] = useState('all');
  const [sort, setSort] = useState<'pos' | 'date'>('pos');
  // the markups of each page; after a change only the pages whose markups changed are read
  // again (each change read every page of the file again - seconds on a long one)
  const perPage = useRef<{ doc: PdfDoc; revs: number[]; pages: AnnotData[][] } | null>(null);
  useEffect(() => {
    let live = true;
    const c = perPage.current?.doc === doc ? perPage.current : null;
    // another file: its own list, not the last file's in the meantime (an Excel export then
    // wrote the other file's markups under this file's name)
    if (!c) setAll(null);
    const revs = doc.annRev.slice();
    const changed = c && c.revs.length === revs.length ? revs.flatMap((r, i) => (r !== c.revs[i] ? [i] : [])) : null;
    if (changed && !changed.length) return;
    const job: Promise<AnnotData[][]> = changed && changed.length <= 40
      ? Promise.all(changed.map((pg) => doc.annots(pg))).then((lists) => {
        const pages = c!.pages.slice();
        changed.forEach((pg, k) => { pages[pg] = lists[k].filter(listed); });
        return pages;
      })
      : doc.allAnnots().then((list) => {
        const pages: AnnotData[][] = revs.map(() => []);
        for (const a of list) if (listed(a)) (pages[a.page] ??= []).push(a);
        return pages;
      });
    void job.then((pages) => {
      if (!live) return;
      perPage.current = { doc, revs, pages };
      setAll(pages.flat());
    }).catch((e) => {
      if (!live) return;
      perPage.current = null;
      setAll([]);
      p.toast("The list of markups couldn't be read: " + String((e as Error)?.message || e), 'err');
    });
    return () => { live = false; };
  }, [p.rev, doc]);
  useEffect(() => { try { localStorage.setItem('cm-group', group); } catch { /* ok */ } }, [group]);
  const items = all || [];
  // every reply under a markup - replies to replies too (other programs thread them; only the
  // first level was counted, shown and exported)
  const replies = useMemo(() => {
    const direct = new Map<number, AnnotData[]>();
    for (const a of items) if (a.irt != null) { if (!direct.has(a.irt)) direct.set(a.irt, []); direct.get(a.irt)!.push(a); }
    const m = new Map<number, AnnotData[]>();
    for (const a of items) {
      if (a.irt != null || !direct.has(a.id)) continue;
      const out: AnnotData[] = [];
      const seen = new Set([a.id]);
      const walk = (id: number) => { for (const r of direct.get(id) || []) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); walk(r.id); } };
      walk(a.id);
      m.set(a.id, out.sort((x, y) => (x.created || 0) - (y.created || 0)));
    }
    return m;
  }, [items]);
  /** the page as the file names it (a drawing set's "A-3", "iii") - as the Pages panel shows it */
  const pageOf = (a: AnnotData) => doc.pages[a.page]?.label || String(a.page + 1);
  const list = items.filter((a) => a.irt == null)
    .filter((a) => show === 'all' || category(a) === show)
    .filter((a) => !q || (markupName(a) + ' ' + a.contents + ' ' + a.author + ' ' + (a.subject || '') + ' ' + (replies.get(a.id) || []).map((r) => r.contents).join(' ')).toLowerCase().includes(q.toLowerCase()));
  if (sort === 'date') list.sort((a, b) => (b.modified || 0) - (a.modified || 0));
  else list.sort((a, b) => a.page - b.page || a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
  const keyOf = (a: AnnotData) => group === 'page' ? 'Page ' + pageOf(a) : group === 'type' ? markupName(a).replace(/^Stamp: .*/, 'Stamp') : group === 'author' ? a.author || '(no author)' : group === 'status' ? a.state || 'No status' : group === 'category' ? category(a) : colorName(shownColor(a));
  const groups = new Map<string, AnnotData[]>();
  for (const a of list) { const k = keyOf(a); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(a); }
  const selIds = new Set(p.sel.map((s) => s.id));
  const exportXlsx = async () => {
    // (a measurement's number and unit in their own cells, as Measure > To Excel writes them)
    const rows = list.map((a) => { const n = measureNumber(a, (pg, x, y) => doc.scaleAt(pg, x, y)); return [pageOf(a) === String(a.page + 1) ? a.page + 1 : pageOf(a), markupName(a), a.contents || '', n ? { v: n.v, s: numStyle(n.dec) } : '', n ? n.unit : '', (replies.get(a.id) || []).map((r) => `${r.author}: ${r.contents}`).join('\n'), a.author, a.state || '', a.modified ? new Date(a.modified).toLocaleString('en-GB') : '', colorName(shownColor(a)), a.locked ? 'Locked' : '']; });
    const t = await gcc.saveDialog({ title: 'Save comments list', name: doc.name.replace(/\.pdf$/i, '') + ' comments.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
    if (!t) return;
    try { await gcc.write(t, writeXlsx([{ name: 'Comments', header: 1, widths: [7, 18, 50, 12, 12, 40, 16, 12, 18, 10, 8], rows: [['Page', 'Type', 'Comment', 'Value', 'Unit', 'Replies', 'Author', 'Status', 'Date', 'Colour', 'Lock'].map((v) => ({ v, s: 'h' as const })), ...rows] as never }]), { noBackup: true }); } catch (e) { p.toast(String((e as Error).message || e), 'err'); return; }
    p.toast('Saved ' + t.split(/[\\/]/).pop(), 'ok', { label: 'Open', run: () => void gcc.openExternal(t) });
  };
  const [making, setMaking0] = useState('');
  // (the text changes a few times a second at most: each change redraws the whole list)
  const lastTick = useRef(0);
  const setMaking = (t: string) => { const now = Date.now(); if (!t || now - lastTick.current > 250 || !/^Picture/.test(t)) { lastTick.current = now; setMaking0(t); } };
  const exporting = useRef(false);
  /** the list as shown (filter, order) as a PDF: a row per markup with a picture of it, its
   *  comment and replies - for a clarification log or to send round */
  const exportPdf = async () => {
    if (making || exporting.current) return;
    exporting.current = true;
    try { await exportPdf1(); } finally { exporting.current = false; }
  };
  const exportPdf1 = async () => {
    const base = doc.name.replace(/\.pdf$/i, '');
    const t = await gcc.saveDialog({ title: 'Save comments summary', name: base + ' comments.pdf', path: doc.path ? doc.path.replace(/[^\\/]*$/, base + ' comments.pdf') : undefined });
    if (!t) return;
    if (doc.path && t.toLowerCase() === doc.path.toLowerCase()) { p.toast('That is the PDF itself – choose another name.', 'err'); return; }
    const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const rows: string[] = [];
    try {
      for (const [k, a] of list.entries()) {
        setMaking(`Picture ${k + 1} of ${list.length}…`);
        let img = '';
        if (k < 400) {
          try {
            const pg = doc.pages[a.page];
            const w = a.rect[2] - a.rect[0], h = a.rect[3] - a.rect[1];
            const pad = Math.max(30, 0.25 * Math.max(w, h));
            const r: [number, number, number, number] = [Math.max(0, a.rect[0] - pad), Math.max(0, a.rect[1] - pad), Math.min(pg.w, a.rect[2] + pad), Math.min(pg.h, a.rect[3] + pad)];
            const sc = Math.min(3, 360 / Math.max(1, r[2] - r[0]), 280 / Math.max(1, r[3] - r[1]));
            const c: OffscreenCanvas = await p.A.areaPicture(doc, a.page, r, sc);
            const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
            img = await new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => res(''); fr.readAsDataURL(blob); });
          } catch { img = ''; }
        }
        const reps = (replies.get(a.id) || []).map((r) => `<div class="rep" dir="auto"><b>${esc(r.author || '')}</b>${r.modified ? ' <span class="d">' + esc(new Date(r.modified).toLocaleString('en-GB')) + '</span>' : ''}<br>${esc(r.contents || '')}</div>`).join('');
        rows.push(`<tr><td class="n">${k + 1}</td><td class="n">${esc(pageOf(a))}</td><td class="pic">${img ? `<img src="${img}">` : ''}</td><td>${esc(markupName(a))}</td><td dir="auto"><div class="c">${esc(a.contents || '')}</div>${reps}</td><td>${esc(a.author || '')}</td><td class="d">${a.modified ? esc(new Date(a.modified).toLocaleString('en-GB')) : ''}</td><td>${esc(a.state || '')}</td></tr>`);
      }
      setMaking('Making the PDF…');
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body { font: 9.5pt "Segoe UI", Arial, sans-serif; color: #222; margin: 0; }
h1 { font-size: 15pt; margin: 0 0 1.5mm; } .sub { color: #666; margin-bottom: 4mm; }
table { border-collapse: collapse; width: 100%; } thead { display: table-header-group; }
th, td { border: 1px solid #c8c8c8; padding: 4px 6px; vertical-align: top; text-align: left; }
th { background: #eef0f2; font-weight: 600; } tr { page-break-inside: avoid; }
td.n { text-align: right; white-space: nowrap; } td.pic { width: 50mm; } td.d, span.d { color: #666; font-size: 8.5pt; white-space: nowrap; }
img { max-width: 50mm; max-height: 38mm; border: 1px solid #ddd; display: block; }
.c { white-space: pre-wrap; } .rep { color: #444; margin-top: 4px; border-left: 2px solid #c8c8c8; padding-left: 6px; white-space: pre-wrap; }
</style></head><body><h1>${esc(doc.name)} – comments</h1><div class="sub">${list.length} markup${list.length === 1 ? '' : 's'}${list.length !== items.filter((a) => a.irt == null).length ? ' (as filtered in the list)' : ''} · ${esc(new Date().toLocaleString('en-GB'))}</div>
<table><thead><tr><th>No.</th><th>Page</th><th>Where</th><th>Type</th><th>Comment and replies</th><th>Author</th><th>Date</th><th>Status</th></tr></thead><tbody>${rows.join('')}</tbody></table></body></html>`;
      const f = await gcc.htmlToPdf(html, base + ' comments.pdf', { landscape: true });
      try { await gcc.commit(f, t, { noBackup: true }); } catch (e) { void gcc.dropTemp([f]); throw e; }
      p.toast('Saved ' + t.split(/[\\/]/).pop(), 'ok', { label: 'Open', run: () => void gcc.openExternal(t) });
    } catch (e) { p.toast(String((e as Error)?.message || e), 'err'); } finally { setMaking(''); }
  };
  return (
    <div className="side-body col">
      <div className="cm-tools">
        <input className="input sm" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="cm-row">
          <select className="input xs" value={group} onChange={(e) => setGroup(e.target.value as never)} title="Group by">
            <option value="page">By page</option><option value="category">By kind</option><option value="type">By type</option><option value="author">By author</option><option value="color">By colour</option><option value="status">By status</option>
          </select>
          <select className="input xs" value={show} onChange={(e) => setShow(e.target.value)} title="Show">
            <option value="all">All</option><option>Comments & text</option><option>Text markup</option><option>Drawings</option><option>Stamps & signatures</option><option>Measurements</option><option>Redaction marks</option>
          </select>
          <select className="input xs" value={sort} onChange={(e) => setSort(e.target.value as never)} title="Order"><option value="pos">Position</option><option value="date">Newest</option></select>
        </div>
      </div>
      <div className="cm-list">
        {list.length === 0 && <div className="faint pad">{!all ? 'Reading…' : all.length ? 'Nothing matches.' : 'No markups in this file yet.'}</div>}
        {[...groups].map(([g, items]) => (
          <div key={g} className="cm-group">
            <div className="cm-gh">{g}<span className="faint">{items.length}</span></div>
            {items.map((a) => (
              <button key={a.id} className={'cm-item' + (selIds.has(a.id) ? ' on' : '')} onClick={(e) => {
                p.setSel(e.ctrlKey ? (selIds.has(a.id) ? p.sel.filter((s) => s.id !== a.id) : [...p.sel, { page: a.page, id: a.id }]) : [{ page: a.page, id: a.id }]);
                p.goTo(a.page, a.rect);
              }}>
                <span className="cchip" style={{ background: css(shownColor(a) || [0.5, 0.5, 0.5]) }} />
                <span className="cm-main">
                  <span className="cm-top"><b>{markupName(a)}</b>{group !== 'page' && <span className="faint"> · p.{pageOf(a)}</span>}{a.locked && <Ico n="lock" size={12} />}{a.state && <span className={'badge st-' + a.state.toLowerCase()}>{a.state}</span>}</span>
                  {a.contents && <span className="cm-text" dir="auto">{a.contents}</span>}
                  <span className="faint">{a.author}{a.modified ? ' · ' + new Date(a.modified).toLocaleDateString('en-GB') : ''}{replies.get(a.id)?.length ? ` · ${replies.get(a.id)!.length} repl${replies.get(a.id)!.length > 1 ? 'ies' : 'y'}` : ''}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="cm-foot">
        <span className="faint">{making || `${list.length} of ${items.filter((a) => a.irt == null).length}`}</span>
        <button className="btn sm" onClick={() => void exportXlsx()} disabled={!list.length || !!making} title="The list as shown, as an Excel sheet (a clarification log)"><Ico n="excel" size={14} /> Excel</button>
        <button className="btn sm" onClick={() => void exportPdf()} disabled={!list.length || !!making} title="The list as shown, as a PDF with a picture of each markup"><Ico n="file" size={14} /> PDF</button>
      </div>
    </div>
  );
}

export function colorName(c: number[] | null | undefined): string {
  if (!c) return 'No colour';
  const [r, g, b] = c;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 0.12) return mx > 0.85 ? 'White' : mx < 0.2 ? 'Black' : 'Grey';
  const h = (mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4) * 60;
  const hh = (h + 360) % 360;
  return hh < 15 || hh >= 340 ? 'Red' : hh < 40 ? 'Orange' : hh < 70 ? 'Yellow' : hh < 165 ? 'Green' : hh < 200 ? 'Teal' : hh < 255 ? 'Blue' : hh < 300 ? 'Purple' : 'Pink';
}

// ---------------------------------------------------------------- search

type FoundHit = Hit & { start: number; count: number; snip?: string };
const HIT_CAP = 5000;

/**
 * Every hit in one file: pieces of 40 pages searched by all drawing engines at once; `piece` hears
 * of the hits in page order as soon as every piece before them is in. Stops at `cap` hits.
 */
async function searchDoc(doc: PdfDoc, q: string, mc: boolean, ww: boolean, cap: number, piece: (all: FoundHit[], donePages: number) => void, stopped: () => boolean): Promise<FoundHit[]> {
  await doc.drawReady();
  const all: FoundHit[] = [];
  const step = 40, n = doc.pages.length;
  const pieces: number[] = [];
  for (let i = 0; i < n; i += step) pieces.push(i);
  const got: (FoundHit[] | undefined)[] = new Array(pieces.length);
  let next = 0, shown = 0, found = 0, stop = false;
  const publish = () => {
    const before = shown;
    while (shown < pieces.length && got[shown] && all.length < cap) all.push(...got[shown++]!);
    // (pieces still under way when the cap was reached land too: the list stops at the cap)
    if (all.length > cap) all.length = cap;
    if (shown === before || stopped()) return;
    piece(all, Math.min(n, pieces[shown - 1] + step));
  };
  await Promise.all(renderers.map(async (eng) => {
    while (!stop && next < pieces.length) {
      if (stopped()) { stop = true; return; }
      const k = next++;
      got[k] = await eng.call<FoundHit[]>('find', [doc.id, q, pieces[k], pieces[k] + step, mc, ww]).catch(() => []);
      found += got[k]!.length;
      if (found > cap) stop = true;
      publish();
    }
  }));
  return all;
}

/** words around hits without one from the engine (the first 300) */
async function fillSnips(doc: PdfDoc, all: FoundHit[], stopped: () => boolean): Promise<Record<number, string>> {
  const sn: Record<number, string> = {};
  for (let k = 0; k < Math.min(all.length, 300); k++) {
    if (stopped()) return sn;
    if (all[k].snip != null) continue;
    const c = await doc.chars(all[k].page);
    const s = Math.max(0, all[k].start - 40), e = Math.min(c.text.length, all[k].start + all[k].count + 50);
    sn[k] = (s > 0 ? '…' : '') + c.text.slice(s, e).replace(/\s+/g, ' ') + (e < c.text.length ? '…' : '');
  }
  return sn;
}

/** results of a search in all open files - kept while tabs are switched (a hit in another file
 *  brings that file to the front) */
interface FileHits { id: string; name: string; hits: FoundHit[]; snips: Record<number, string>; rev: number; done: boolean; /** Stop came while this file was searched: not all of it was */ cut?: boolean }
const across = {
  key: '', files: [] as FileHits[], running: false, at: '', run: 0, stop: false,
  /** a hit picked in a file not in front yet: shown once that file is */
  pending: null as { id: string; i: number; tries: number } | null,
  cur: null as { id: string; i: number } | null,
  subs: new Set<() => void>(),
  emit() { for (const f of this.subs) f(); },
};

function Search(p: Props) {
  const { doc } = p;
  const [q, setQ] = useState(() => across.key.split('\u0000')[0] || '');
  const [mc, setMc] = useState(false);
  const [ww, setWw] = useState(false);
  const [scope, setScopeState] = useState<'file' | 'all'>(() => { try { return localStorage.getItem('search-scope') === 'all' ? 'all' : 'file'; } catch { return 'file'; } });
  const setScope = (v: 'file' | 'all') => { setScopeState(v); try { localStorage.setItem('search-scope', v); } catch { /* fine */ } };
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [snips, setSnips] = useState<Record<number, string>>({});
  const [, tick] = useState(0);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const run = useRef(0);
  /** what the current results are for (Enter after changing the words searches again) */
  const last = useRef('');
  const docs = p.docs.filter((d) => d.pages.length > 0);
  useEffect(() => { const f = () => tick((x) => x + 1); across.subs.add(f); return () => { across.subs.delete(f); }; }, []);

  // ---- this file
  const go = async () => {
    const id = ++run.current;
    last.current = q + '\u0000' + mc + ww;
    p.setHits([]);
    setSnips({});
    // (the box emptied while a search ran: that search stops, so the panel must not stay on "Searching…")
    if (!q.trim()) { setRunning(false); setDone(null); return; }
    setRunning(true);
    setDone(0);
    let first = true;
    const all = await searchDoc(doc, q, mc, ww, HIT_CAP, (list, pagesDone) => {
      p.setHits([...list]);
      if (list.length && first) { first = false; p.setHitIndex(0); }
      setDone(pagesDone);
    }, () => run.current !== id);
    if (run.current !== id) return;
    // (stopped at 5,000 hits: what came in after a gap is dropped, the list stays in page order)
    setRunning(false);
    const sn = await fillSnips(doc, all, () => run.current !== id);
    if (run.current === id) setSnips(sn);
  };

  // ---- all open files, one after another (tab order)
  const goAll = async () => {
    const id = ++across.run;
    across.stop = false;
    across.key = q + '\u0000' + mc + ww;
    across.files = [];
    across.cur = null;
    across.pending = null;
    if (!q.trim()) { across.running = false; across.emit(); return; }
    across.running = true;
    across.emit();
    let total = 0;
    const stopped = () => across.run !== id || across.stop;
    for (const [k, d] of docs.entries()) {
      if (stopped() || total >= HIT_CAP) break;
      const f: FileHits = { id: d.id, name: d.name, hits: [], snips: {}, rev: d.baseRev, done: false };
      across.files.push(f);
      across.at = `${d.name} (${k + 1} of ${docs.length})`;
      across.emit();
      const all = await searchDoc(d, q, mc, ww, HIT_CAP - total, (list, pagesDone) => { f.hits = [...list]; across.at = `${d.name} (${k + 1} of ${docs.length}) – page ${pagesDone} of ${d.pages.length}`; across.emit(); }, stopped);
      f.hits = all;
      f.done = true;
      if (stopped()) f.cut = true;
      total += all.length;
      across.emit();
    }
    if (across.run !== id) return;
    across.running = false;
    across.emit();
    for (const f of across.files) {
      const d = docs.find((x) => x.id === f.id);
      if (!d || across.run !== id) continue;
      // (a file closed meanwhile: no words around its hits - the other files still get theirs)
      f.snips = await fillSnips(d, f.hits, () => across.run !== id).catch(() => ({}));
      across.emit();
    }
  };
  // (one function per file for the rows: a new one each time redrew thousands of rows per piece found)
  const pickRef = useRef<(f: FileHits, i: number) => void>(() => {});
  const pickFns = useRef(new Map<string, (i: number) => void>());
  const pickFor = (id: string) => {
    let fn = pickFns.current.get(id);
    if (!fn) { fn = (i: number) => { const f = across.files.find((x) => x.id === id); if (f) pickRef.current(f, i); }; pickFns.current.set(id, fn); }
    return fn;
  };
  /** a hit in the list of all files: its file in front, the hit shown and selected there */
  const pickAcross = (f: FileHits, i: number) => {
    across.cur = { id: f.id, i };
    const d = p.docs.find((x) => x.id === f.id);
    if (!d) { p.toast(`${f.name} is no longer open.`, 'info'); return; }
    if (d.baseRev !== f.rev) p.toast(`${f.name} has changed since the search – Find again for fresh results.`, 'info');
    if (d.id === doc.id) { p.setHits(f.hits); p.setHitIndex(i); across.emit(); return; }
    across.pending = { id: f.id, i, tries: 0 };
    p.A.showDoc(f.id);
    across.emit();
  };
  pickRef.current = pickAcross;
  // the file asked for is in front: show the hit there. (The window clears the hits of a file
  // coming to the front after this has run - so again until they are the ones shown.)
  useEffect(() => {
    const w = across.pending;
    if (!w || w.id !== doc.id) return;
    const f = across.files.find((x) => x.id === w.id);
    if (!f || p.hits === f.hits || ++w.tries > 6) { across.pending = null; return; }
    p.setHits(f.hits);
    p.setHitIndex(w.i);
  }, [doc.id, p.hits]);
  // F3 / Enter walking the hits of the file in front: the row follows
  useEffect(() => {
    if (scope !== 'all' || !across.cur || across.cur.id !== doc.id) return;
    const f = across.files.find((x) => x.id === doc.id);
    if (f && p.hits === f.hits && across.cur.i !== p.hitIndex) { across.cur = { id: doc.id, i: p.hitIndex }; across.emit(); }
  }, [p.hitIndex]);

  useEffect(() => () => { run.current++; }, []);
  // the current hit's row stays in view (Enter / F3 walk the list)
  const listRef = useRef<HTMLDivElement>(null);
  // (not when more hits come in while searching: the list would jump back while being read)
  useEffect(() => { listRef.current?.querySelector('.cm-item.on')?.scrollIntoView({ block: 'nearest' }); }, [p.hitIndex, across.cur?.id, across.cur?.i]);
  // another tab: a search of this file still going is for the other file - stop it, start fresh (same words)
  useEffect(() => { run.current++; setRunning(false); setDone(null); setSnips({}); last.current = ''; }, [doc.id]);
  const key = q + '\u0000' + mc + ww;
  const enter = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    if (scope === 'all') {
      // the next hit in the list of all files (on into the next file)
      if (across.files.length && !across.running && across.key === key) {
        const flat: [FileHits, number][] = across.files.filter((f) => p.docs.some((d) => d.id === f.id)).flatMap((f) => f.hits.map((_, i) => [f, i] as [FileHits, number]));
        if (!flat.length) return;
        const j = flat.findIndex(([f, i]) => across.cur?.id === f.id && across.cur.i === i);
        // (none chosen yet: Enter = the first, Shift+Enter = the last)
        const [f, i] = flat[j < 0 ? (e.shiftKey ? flat.length - 1 : 0) : (j + (e.shiftKey ? flat.length - 1 : 1)) % flat.length];
        pickAcross(f, i);
      } else void goAll();
      return;
    }
    if (p.hits.length && !running && done !== null && last.current === key) p.setHitIndex((p.hitIndex + (e.shiftKey ? p.hits.length - 1 : 1)) % p.hits.length); else void go();
  };
  const totalAll = across.files.reduce((n, f) => n + f.hits.length, 0);
  const shownFiles = across.files.filter((f) => p.docs.some((d) => d.id === f.id));
  return (
    <div className="side-body col">
      <div className="cm-tools">
        <input className="input sm search-in" placeholder={scope === 'all' ? `Find in all ${docs.length} open files…` : 'Find in this file…'} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={enter} autoFocus />
        <div className="seg sm scope">
          <button className={scope === 'file' ? 'on' : ''} onClick={() => setScope('file')}>This file</button>
          <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')} title="Every file open in this window, one after another">All open files ({docs.length})</button>
        </div>
        <div className="cm-row">
          <label className="check sm"><input type="checkbox" checked={mc} onChange={(e) => setMc(e.target.checked)} /> Match case</label>
          <label className="check sm"><input type="checkbox" checked={ww} onChange={(e) => setWw(e.target.checked)} /> Whole words</label>
          {scope === 'all' && across.running
            ? <button className="btn sm" onClick={() => { across.stop = true; across.running = false; across.emit(); }}>Stop</button>
            : <button className="btn sm primary" onClick={() => void (scope === 'all' ? goAll() : go())}>Find</button>}
        </div>
        {scope === 'file'
          ? <div className="faint">{running ? `Searching… page ${done} of ${doc.pages.length}` : done !== null ? `${p.hits.length} found${p.hits.length >= HIT_CAP ? ' (first 5000)' : ''} · Enter / F3 = next` : 'Scanned pages without text: run OCR first.'}</div>
          : <div className="faint">{across.running ? `Searching ${across.at}…` : across.files.length ? `${totalAll} found in ${shownFiles.filter((f) => f.hits.length).length} of ${shownFiles.length} files${totalAll >= HIT_CAP ? ' (first 5000)' : ''}${across.stop ? ' – stopped' : ''} · Enter = next` : 'Searches every open file. Scanned pages without text: run OCR first.'}
            {shownFiles.filter((f) => f.hits.length).length > 1 && <> · <button className="link sm" onClick={() => setFolded(folded.size ? new Set() : new Set(shownFiles.map((f) => f.id)))}>{folded.size ? 'Open all' : 'Fold all'}</button></>}</div>}
      </div>
      {scope === 'file' ? (
        // every hit is listed (the search stops at about 5,000): only the first 2,000 were, while
        // Enter / F3 walked on to hits that had no row
        <div className="cm-list" ref={listRef}>
          {p.hits.map((h, i) => (
            <HitRow key={i} i={i} on={i === p.hitIndex} label={doc.pages[h.page]?.label || String(h.page + 1)} snip={snips[i] ?? (h as { snip?: string }).snip ?? '…'} pick={p.setHitIndex} />
          ))}
        </div>
      ) : (
        <div className="cm-list" ref={listRef}>
          {shownFiles.filter((f) => f.hits.length || !f.done).map((f) => {
            const d = p.docs.find((x) => x.id === f.id)!;
            const fold = folded.has(f.id);
            const nPages = new Set(f.hits.map((h) => h.page)).size;
            const fc = FILE_COLOURS[shownFiles.indexOf(f) % FILE_COLOURS.length];
            return (
              <div key={f.id} className="sf-group" style={{ '--fc': fc } as React.CSSProperties}>
                <button className={'sf-head' + (f.id === doc.id ? ' cur' : '')} onClick={() => setFolded((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })} title={`${d.path || f.name}\n${f.hits.length} ${f.hits.length === 1 ? 'hit' : 'hits'} on ${nPages} ${nPages === 1 ? 'page' : 'pages'} – click to ${fold ? 'show them' : 'fold'}`}>
                  <Ico n={fold ? 'chevr' : 'chev'} size={12} /><Ico n="file" size={13} />
                  <span className="sf-name">{f.name}</span>
                  <span className="sf-n">{f.hits.length}{f.done && !f.cut ? '' : '…'}</span>
                </button>
                {!fold && f.hits.map((h, i) => (
                  <HitRow key={i} i={i} on={across.cur?.id === f.id && across.cur.i === i} label={d.pages[h.page]?.label || String(h.page + 1)} same={i > 0 && f.hits[i - 1].page === h.page} snip={f.snips[i] ?? h.snip ?? '…'} pick={pickFor(f.id)} file={f.name} />
                ))}
              </div>
            );
          })}
          {shownFiles.some((f) => f.done && !f.cut && !f.hits.length) && (
            <div className="sf-none">Not found in: {shownFiles.filter((f) => f.done && !f.cut && !f.hits.length).map((f) => f.name).join(', ')}</div>
          )}
          {shownFiles.some((f) => f.cut) && <div className="sf-none">Stopped while searching {shownFiles.filter((f) => f.cut).map((f) => f.name).join(', ')} – not all of it was searched.</div>}
        </div>
      )}
    </div>
  );
}

/** one search hit (drawn again only when it changes: thousands of rows, one moves on) */
/** a colour per file in the list of all files' hits (its band down the left) */
const FILE_COLOURS = ['#2f6fb5', '#c0782a', '#3b8a4f', '#8a4fb0', '#b8434f', '#2a8f8f', '#7a6a2a', '#5a6470'];

/** one search hit (drawn again only when it changes: thousands of rows, one moves on): the page on
 *  the left (left out for more hits on the same page), the words around it on the right */
const HitRow = memo(function HitRow({ i, on, label, snip, pick, same, file }: { i: number; on: boolean; label: string; snip: string; pick(i: number): void; same?: boolean; file?: string }) {
  return (
    <button className={'cm-item hitrow' + (on ? ' on' : '') + (same ? ' same' : '')} onClick={() => pick(i)} title={(file ? file + ' – ' : '') + 'page ' + label}>
      <span className="hr-page">{same ? '' : label}</span>
      <span className="cm-text" dir="auto">{snipView(snip)}</span>
    </button>
  );
});
