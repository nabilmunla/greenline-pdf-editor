// The page viewer: continuous pages, smooth zoom at the pointer, every tool's drawing,
// selecting / moving / resizing / rotating markups, snapping, in-place text editors.
import { relabel, isAutoLabel, ptsOf } from './relabel';
import { countNumbers } from './tagcount';
import { FontPick, SizePick, BoldItalic, famCss } from './fontlist';
import { RichBox, type RichApi } from './RichBox';
import { dropKey, settle, cleanRuns, type TextRun, type RunStyle, type FullStyle } from '../engine/richtext';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { PdfDoc } from './doc';
import type { AnnotData, AnnotSpec, Pt, Rect } from '../engine/mu';
import { PageTiles } from './PageTiles';
import { tiles } from './tiles';
import { renderers, rendererFor } from './engines';
import { TOOLS, css, type ToolId, type Style, type Gesture, type MeasureHow } from './tools';
import { wrapText, TEXT_PAD, TYPE_PAD, AUTO_MIN } from '../engine/textwrap';
import { hitList, geomBox, rectOf, dist, inRect, inPoly, overlaps, ortho, perpFootOn, fmtLen, segDist, calloutPath, measureValue, yRatio, realDist, LEGACY_FMT, circlePts, circleOf, CIRCLE_N, isAxisRect, rectKeep, parseTypedLength, zoomToShow, placeOnPage, shiftOnPages, type MeasureFmt, selfCrosses } from './geom';
import { gcc } from './api';

const GAP = 14;
/** selection frame / handles sit this many screen pixels outside the markup */
const HPAD = 7;
const ROTATABLE = new Set(['FreeText', 'Stamp', 'Square', 'Circle']);
const NO_MOVE_TYPES = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Widget', 'Popup', 'Link']);
/** text markups stay on their text; an area highlight is a box like any other */
const NO_MOVE = { has: (t: string, a?: AnnotData) => NO_MOVE_TYPES.has(t) && a?.kind !== 'area-highlight' };
/** markups that sit on text (their ends can be dragged along the text) */
const TEXT_MARKUP = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);
const isTextMarkup = (a: AnnotData) => TEXT_MARKUP.has(a.type) && a.kind !== 'area-highlight' && !!a.quads?.length;
/** markups moved at once beyond which they move as outlines, not pictures (see startGhosts) */
const GHOSTS_MAX = 24;
/** a character that is part of a word (double-click selects the word) */
const WORD_CH = /[\p{L}\p{M}\p{N}_]/u;
/** the characters [first, last] a text markup covers: those whose middle is inside its quads */
function rangeOfMarkup(c: { text: string; box: Float32Array }, a: AnnotData): [number, number] | null {
  const polys = (a.quads || []).map((q) => [[q[0], q[1]], [q[2], q[3]], [q[6], q[7]], [q[4], q[5]]] as Pt[]);
  let lo = -1, hi = -1;
  for (let i = 0; i < c.text.length; i++) {
    const x0 = c.box[i * 4], y0 = c.box[i * 4 + 1], x1 = c.box[i * 4 + 2], y1 = c.box[i * 4 + 3];
    if (Number.isNaN(x0) || x1 <= x0) continue;
    const m: Pt = [(x0 + x1) / 2, (y0 + y1) / 2];
    if (polys.some((pp) => inPoly(m, pp))) { if (lo < 0) lo = i; hi = i; }
  }
  return lo < 0 ? null : [lo, hi];
}

export interface SelItem { page: number; id: number }
export interface Hit { page: number; rects: number[][] }
/** real: its size is the real one (a stamp from a scan) - not made bigger on big sheets */
export interface PlaceItem { spec: AnnotSpec; w: number; h: number; real?: boolean }

export interface ViewerApi {
  goTo(page: number, rect?: number[], keepZoom?: boolean): void;
  zoomBy(f: number): void;
  setZoom(z: number): void;
  fit(mode: 'width' | 'page'): void;
  zoom(): number;
  page(): number;
  copySelection(): boolean;
  editAnnot(page: number, id: number): void;
  /** markups: copy / cut the selection, paste (at a point, or offset), duplicate */
  copyMarkups(cut?: boolean): Promise<void>;
  pasteMarkups(at?: { page: number; p: Pt }): Promise<void>;
  duplicate(): Promise<void>;
  /** corners of an outline / line by corners (right-click menu): the corner under a point (-1:
   *  none), whether it can have corners added / deleted / be continued, and doing it */
  corners(page: number, id: number, at: Pt): { corner: number; editable: boolean; canDelete: boolean; open: boolean; canContinueFrom: boolean };
  deleteCorner(page: number, id: number, index: number): Promise<void>;
  addCorner(page: number, id: number, at: Pt): Promise<void>;
  continueLine(page: number, id: number, at?: Pt, from?: number): void;
}

/** copied markups - shared by every open file (paste into another tab works) */
export const markClip: { cur: { docId: string; items: SelItem[]; page: number; box: Rect; n: number; src: string; steps?: Record<string, number>; auto?: boolean[] } | null } = { cur: null };

export type ViewerEvent =
  | { type: 'page'; page: number }
  | { type: 'zoom'; z: number }
  | { type: 'status'; text: string }
  /** a message that must be seen (a toast) */
  | { type: 'note'; text: string }
  | { type: 'calibrate'; page: number; a: Pt; b: Pt }
  | { type: 'viewport'; page: number; rect: Rect }
  | { type: 'snapshot'; page: number; rect: Rect }
  | { type: 'unmark' }
  | { type: 'table'; page: number; rect: Rect }
  | { type: 'link'; page: number; rect: Rect }
  | { type: 'linkAt'; page: number; pt: Pt }
  | { type: 'crop'; page: number; rect: Rect }
  | { type: 'ocr-area'; page: number; rect: Rect }
  | { type: 'stamp-grab'; page: number; rect: Rect }
  | { type: 'comment'; page: number; id: number }
  | { type: 'menu'; x: number; y: number; page: number; at: Pt; text: string | null }
  | { type: 'error'; text: string }
  | { type: 'created'; a: AnnotData };

interface Props {
  doc: PdfDoc;
  rev: number;
  tool: ToolId;
  setTool(t: ToolId): void;
  style: Style;
  place: PlaceItem | null;
  countGroup: string;
  snapOn: boolean;
  /** Ortho (F8): as if Shift were held while drawing */
  orthoOn?: boolean;
  /** Crosshair (F6): lines across the view through the pointer */
  crossOn?: boolean;
  /** Magnifier (F7): a loupe beside the pointer, at this many times the zoom */
  loupeOn?: boolean;
  loupeZoom?: number;
  /** an area marked with the Snapshot tool: shown (dashed) until unmarked - right-click it to print, copy or save it */
  marked?: { page: number; rect: Rect } | null;
  wheelZoom: boolean;
  keepTool: boolean;
  sel: SelItem[];
  setSel(s: SelItem[]): void;
  hits: Hit[];
  hitIndex: number;
  onEvent(e: ViewerEvent): void;
  apiRef: MutableRefObject<ViewerApi | null>;
  readOnly?: boolean;
  /** how an area or perimeter is drawn: corners clicked, a rectangle (two corners), a circle
   *  (its centre, then its edge) */
  how?: MeasureHow;
}

type Draft =
  | { kind: 'rect'; page: number; a: Pt; b: Pt }
  | { kind: 'two'; page: number; a: Pt; b: Pt; clicked: boolean }
  /** cont: an existing line being continued (its id; its corners before - the draft's first `base` points;
   *  tail: drawn on from a corner in the middle - the corners after it, kept after the new ones) */
  | { kind: 'poly'; page: number; pts: Pt[]; cur: Pt; cont?: { id: number; base: number; tail?: Pt[] } }
  | { kind: 'ink'; page: number; strokes: Pt[][]; spec?: Partial<AnnotSpec> }
  | { kind: 'callout'; page: number; tip: Pt; cur: Pt; box?: Rect; sized?: boolean };

type Drag =
  | { mode: 'move'; page: number; start: Pt; cur: Pt; items: SelItem[]; moved: boolean; edit?: AnnotData }
  // keep: a stamp / picture keeps its proportions from a corner (free: Shift held)
  | { mode: 'resize'; page: number; id: number; handle: number; start: Pt; cur: Pt; box: Rect; angle: number; keep?: boolean; free?: boolean }
  // which: v = a corner (a rectangle measurement keeps its square corners unless free - Alt),
  // l = a line end, c = a callout tip, r = a circle measurement's size (its one handle)
  // start: where it was grabbed; moved: dragged at all (a click on a corner changes nothing); ins: a
  // corner being added (grabbed at an edge's middle dot); alt: Alt held when grabbed (Alt+click on a
  // corner deletes it)
  | { mode: 'vertex'; page: number; id: number; index: number; cur: Pt; which: 'v' | 'l' | 'c' | 'r'; free?: boolean; start?: Pt; moved?: boolean; ins?: boolean; alt?: boolean }
  | { mode: 'rotate'; page: number; id: number; centre: Pt; angle0: number; start: number; cur: number }
  | { mode: 'band'; page: number; a: Pt; b: Pt }
  | { mode: 'text'; page: number; a: number; b: number }
  /** an end of a text markup dragged along the text: chars [fixed .. cur] */
  | { mode: 'textedge'; page: number; id: number; fixed: number; cur: number }
  | { mode: 'pan'; x: number; y: number; sx: number; sy: number };

interface Editor { page: number; kind: 'free' | 'field' | 'line'; rect: Rect; value: string; id?: number; size: number; color: string; angle?: number; family?: string; bold?: boolean; italic?: boolean; runs?: TextRun[]; fontColor?: number[]; align?: number; bw?: number; fill?: string | null; isNew?: boolean; auto?: number; typewriter?: boolean; callout?: Pt; options?: string[]; multiline?: boolean; maxLen?: number; line?: { bbox: Rect; origin: Pt; dir: Pt; size: number; color: [number, number, number]; bold: boolean; italic: boolean; serif: boolean; mono: boolean } }

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const rot = (p: Pt, c: Pt, deg: number): Pt => {
  const t = (deg * Math.PI) / 180, co = Math.cos(t), si = Math.sin(t);
  const dx = p[0] - c[0], dy = p[1] - c[1];
  return [c[0] + dx * co - dy * si, c[1] + dx * si + dy * co];
};

/** a canvas for measuring text in the typing box */
let measureCanvas: CanvasRenderingContext2D | null = null;
const measurer = () => (measureCanvas ??= document.createElement('canvas').getContext('2d')!);
/** padding inside the typing box (pt): the text box's border + the same padding as in the file */
const edPad = (e: { bw?: number; typewriter?: boolean; size: number }) => {
  const P = e.typewriter ? TYPE_PAD : TEXT_PAD, bw = e.bw ?? 0;
  // (CSS puts the first baseline ~0.18 em lower than the PDF text: the top padding makes up for it)
  return { x: bw + P.x, top: Math.max(0, bw + P.top - 0.18 * e.size), bottom: bw + P.bottom };
};

export function Viewer(props: Props) {
  const { doc } = props;
  const P = useRef(props);
  P.current = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [z, setZ] = useState(doc.view.z || 0);
  const [vp, setVp] = useState({ top: 0, left: 0, w: 1200, h: 800 });
  /** vp has been read from the page at least once (before that it is a stand-in: top-left of
   *  page 1 - not a place to remember) */
  const vpLive = useRef(false);
  const [annots, setAnnots] = useState<Record<number, AnnotData[]>>({});
  /** the latest markups (for handlers that continue after an await) */
  const annotsNow = useRef(annots);
  annotsNow.current = annots;
  const [links, setLinks] = useState<Record<number, { rect: number[]; url?: string; page?: number }[]>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [textSel, setTextSel] = useState<{ page: number; a: number; b: number } | null>(null);
  const [selRects, setSelRects] = useState<number[][]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorNow = useRef<Editor | null>(null);
  editorNow.current = editor;
  const edRef = useRef<HTMLDivElement | null>(null);
  /** the rich typing box (styles for the selected text) and what its selection looks like */
  const richApi = useRef<RichApi | null>(null);
  const [edStyle, setEdStyle] = useState<Partial<FullStyle> | null>(null);
  const edStyleKey = useRef('');
  /** the text box being typed in: left out of the drawn markups (the typing box shows it, live) */
  const [editHide, setEditHide] = useState<{ page: number; id: number } | null>(null);
  /** the typing box's current box (page space) - a callout's line is drawn to it while typing */
  const [edBox, setEdBox] = useState<Rect | null>(null);
  /** the bar above the text box being typed in: kept inside the view across (a box near the
   *  right edge had the bar's size and colours off the window) */
  const edbarRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const b = edbarRef.current, el = scroller.current;
    if (!b || !el) return;
    b.style.transform = '';
    // never wider than the view: a view narrower than the bar (a laptop window with both side
    // panels open) had Right-align and Done under the right panel - it wraps onto a second row
    b.style.maxWidth = Math.max(160, el.clientWidth - 16) + 'px';
    const over = b.offsetLeft + b.offsetWidth - (el.scrollLeft + el.clientWidth - 8);
    const dx = over > 0 ? -Math.min(over, Math.max(0, b.offsetLeft - el.scrollLeft - 8)) : 0;
    // (wrapped while above the box: taller - moved up by as much, clear of the text)
    const dy = b.dataset.above === '1' ? -Math.max(0, b.offsetHeight - 38) : 0;
    if (dx || dy) b.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  /** the text box lost focus because of a click on the page (handled there, not by blur) */
  const blurByViewer = useRef(false);
  /** the mouse button is still held (pointer-down handlers that wait for something check it) */
  const btnDown = useRef(false);
  const countChain = useRef<Promise<void>>(Promise.resolve());
  /** count marks made since the Count tool was picked (Backspace takes back the last) */
  const countMade = useRef<{ page: number; id: number }[]>([]);
  /** the count tool's last mark: its number, and the file's change count right after it */
  const countMemo = useRef<{ doc: string; grp: string; n: number; changes: number } | null>(null);
  useEffect(() => {
    const up = () => { btnDown.current = false; };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', up);
    return () => { window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); window.removeEventListener('blur', up); };
  }, []);
  // the box grows while typing, like the saved one will
  // (only when the text or size changes: resizing it mid-drag would end a mouse selection)
  useLayoutEffect(() => {
    const t = edRef.current;
    if (!t || !editor || editor.kind !== 'free') { setEdBox(null); return; }
    const zz = zRef.current;
    if (editor.auto) {
      // fits the text: as wide as the longest line (up to its limit, then it wraps - the box's CSS
      // does that, with every style in it), as tall as the lines
      const padX = edPad(editor).x * zz;
      let min = editor.size * zz * AUTO_MIN + 2 * padX + 3;
      if (!editor.value && editor.isNew) {
        const g = measurer();
        g.font = `${editor.italic ? 'italic ' : ''}${editor.bold ? '700 ' : ''}${editor.size * zz}px ${famCss(editor.family)}`;
        min = Math.max(min, g.measureText('Type here').width + 2 * padX + 3);
      }
      t.style.minWidth = Math.ceil(min) + 'px';
      t.style.maxWidth = Math.max(min, editor.auto * zz) + 'px';
    }
    const r = editor.rect;
    const nb: Rect = [r[0], r[1], r[0] + t.offsetWidth / zz, r[1] + t.offsetHeight / zz];
    setEdBox((b) => (b && b.every((v, i) => Math.abs(v - nb[i]) < 0.05) ? b : nb));
  }, [editor?.value, editor?.runs, editor?.size, editor?.family, editor?.bold, editor?.italic, editor?.rect, editor?.auto, z]);
  const [snapMark, setSnapMark] = useState<{ page: number; p: Pt; k: string } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [ghosts, setGhosts] = useState<Record<number, { url: string; x: number; y: number; w: number; h: number; S: number }>>({});
  const [blocks, setBlocks] = useState<Record<number, { bbox: Rect; text: string; origin: Pt; dir: Pt; size: number; color: [number, number, number]; bold: boolean; italic: boolean; serif: boolean; mono: boolean }[]>>({});
  const [space, setSpace] = useState(false);
  /** the markup under the pointer (outlined, so it's clear what a click will pick) */
  const [hover, setHover] = useState<{ page: number; id: number } | null>(null);
  const dpr = window.devicePixelRatio || 1;
  const anchor = useRef<{ page: number; x: number; y: number; cx: number; cy: number } | null>(null);
  const snapRef = useRef<{ page: number; raw: Pt; p: Pt; k: string } | null>(null);
  const snapBusy = useRef(false);
  /** the newest spot asked for while a snap call was out: asked next (at most one call out) */
  const snapNext = useRef<{ page: number; p: Pt; r: number; from: Pt | null } | null>(null);
  /** where the pointer last asked for a snap (an engine answer for a spot it has left is dropped;
   *  `local`: a markup corner was found there - an engine answer doesn't replace it) */
  const snapAt = useRef<{ page: number; p: Pt; local: boolean } | null>(null);
  /** false once the pointer is up or the tool doesn't snap: late snap answers are ignored */
  const snapWanted = useRef(false);
  const lastClick = useRef({ t: 0, x: 0, y: 0 });
  /** a press on a link: followed when the button comes up without the mouse having moved (on
   *  the press, a drag over linked text jumped away instead of selecting it, and the hand
   *  tool's pan then scrolled back to where it was) */
  const pendingLink = useRef<{ page: number; p: Pt; x: number; y: number } | null>(null);
  const zRef = useRef(z);
  zRef.current = z;

  const pages = doc.pages;
  const maxW = useMemo(() => pages.reduce((m, p) => Math.max(m, p.w), 0), [pages]);
  const totalPts = useMemo(() => pages.reduce((s, p) => s + p.h, 0), [pages]);
  const zMax = Math.min(64, 30_000_000 / Math.max(1, totalPts));
  const tops = useMemo(() => {
    const t: number[] = [];
    let y = GAP;
    for (const p of pages) { t.push(y); y += p.h * z + GAP; }
    t.push(y);
    return t;
  }, [pages, z]);
  const contentW = Math.max(maxW * z + 2 * GAP, vp.w);
  const contentH = tops[tops.length - 1];
  const leftOf = (i: number) => (contentW - pages[i].w * z) / 2;

  // ---------------------------------------------------------------- fitting / zoom

  // the latest layout, for code that runs later than the render it was made in (resize
  // observer, callbacks): reading `tops` from an old render picked the wrong page to fit
  const lay = useRef({ pages, maxW, z, tops, zMax });
  lay.current = { pages, maxW, z, tops, zMax };

  const fitZoom = (mode: 'width' | 'page', page?: number) => {
    const el = scroller.current;
    const L = lay.current;
    if (!el || !L.pages.length) return 1;
    const pg = L.pages[page ?? curPage()] || L.pages[0];
    const zw = (el.clientWidth - 2 * GAP - 16) / pg.w;
    if (mode === 'width') return clamp(zw, 0.02, L.zMax);
    return clamp(Math.min(zw, (el.clientHeight - 2 * GAP) / pg.h), 0.02, L.zMax);
  };

  const curPage = () => {
    const el = scroller.current;
    const L = lay.current;
    if (!el || !L.pages.length) return 0;
    const mid = el.scrollTop + el.clientHeight * 0.4;
    let lo = 0, hi = L.pages.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (L.tops[m] <= mid) lo = m; else hi = m - 1; }
    return lo;
  };

  useLayoutEffect(() => {
    if (!z && pages.length) {
      const startPage = doc.view.restore && doc.view.anchor ? Math.min(doc.view.anchor.page, pages.length - 1) : 0;
      const nz = doc.view.fit === 'page' ? fitZoom('page', startPage) : fitZoom('width', startPage);
      if (!(doc.view.sy || doc.view.sx) && !doc.view.restore) fitPage.current = 0;
      setZ(nz);
    }
  }, [pages.length]);

  /** back to where this file was when it was last closed (same page, same spot, same zoom) */
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = doc.view.anchor;
    if (!el || !z || !doc.view.restore || !a || !pages.length) return;
    doc.view.restore = false;
    const pg = Math.min(a.page, pages.length - 1);
    el.scrollTop = Math.max(0, tops[pg] + a.y * z);
    el.scrollLeft = Math.max(0, leftOf(pg) + a.x * z);
    readVp();
    // the panels round the page settle a moment later (the right panel is made again for this
    // file): a narrower or wider view then cut the spot short across - put it back on resizes
    // in the first moments, until the person moves the view themselves
    restoreTo.current = { page: pg, x: a.x, y: a.y, t: performance.now() };
  }, [z]);
  /** the spot just restored (kept for a moment: see above) */
  const restoreTo = useRef<{ page: number; x: number; y: number; t: number } | null>(null);
  const reRestore = () => {
    const r = restoreTo.current, el = scroller.current, L = lay.current;
    if (!r || !el) return;
    if (performance.now() - r.t > 1500 || doc.view.fit !== 'none' || r.page >= L.pages.length) { restoreTo.current = null; return; }
    const cw = Math.max(L.maxW * L.z + 2 * GAP, el.clientWidth);
    const left = (cw - L.pages[r.page].w * L.z) / 2;
    el.scrollTop = Math.max(0, L.tops[r.page] + r.y * L.z);
    el.scrollLeft = Math.max(0, left + r.x * L.z);
    readVp();
  };

  /** after fitting: this page at the top, centred across (files mixing narrow and wide
   *  pages lay out as wide as the widest page; the page in view must not sit off to the side) */
  const fitPage = useRef<number | null>(null);
  /** after a refit on resize: only re-centre across */
  const fitAcross = useRef<number | null>(null);
  const centreX = (page: number) => {
    const el = scroller.current;
    const L = lay.current;
    if (!el || !L.pages[page]) return;
    const w = L.pages[page].w * L.z;
    const cw = Math.max(L.maxW * L.z + 2 * GAP, el.clientWidth);
    const left = (cw - w) / 2;
    el.scrollLeft = Math.max(0, left - Math.max(0, (el.clientWidth - w) / 2));
  };
  /** centre across once the next render has laid out (two frames: React + layout) */
  const centreSoon = (page: number) => requestAnimationFrame(() => requestAnimationFrame(() => { centreX(page); readVp(); }));
  useLayoutEffect(() => {
    const el = scroller.current;
    const pg = fitPage.current, ac = fitAcross.current;
    // (taken either way: a zoom at the pointer in the same moment wins, and a page number left
    // here would be used by some later zoom)
    fitPage.current = null;
    fitAcross.current = null;
    if (!el || anchor.current) return;
    if (pg != null) { el.scrollTop = Math.max(0, tops[Math.min(pg, pages.length - 1)] - GAP / 2); centreX(pg); readVp(); centreSoon(pg); }
    else if (ac != null) { centreX(Math.min(ac, pages.length - 1)); readVp(); centreSoon(ac); }
  }, [z]);

  // after a zoom: keep the point under the pointer still
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a || a.page >= pages.length) return;
    anchor.current = null;
    const X = leftOf(a.page) + a.x * z, Y = tops[a.page] + a.y * z;
    el.scrollLeft = X - a.cx;
    el.scrollTop = Y - a.cy;
    readVp();
  }, [z]);

  useEffect(() => {
    doc.view.z = z;
    props.onEvent({ type: 'zoom', z });
  }, [z]);

  const zoomAt = (nz: number, cx?: number, cy?: number) => {
    const el = scroller.current;
    if (!el) return;
    restoreTo.current = null;
    nz = clamp(nz, 0.02, zMax);
    if (Math.abs(nz - zRef.current) < 1e-6) return;
    const r = el.getBoundingClientRect();
    const ccx = cx ?? r.width / 2, ccy = cy ?? r.height / 2;
    const at = toPage(r.left + ccx, r.top + ccy);
    if (at) anchor.current = { page: at.page, x: at.p[0], y: at.p[1], cx: ccx, cy: ccy };
    doc.view.fit = 'none';
    setZ(nz);
  };

  // ---------------------------------------------------------------- scroll / visible pages

  const readVp = () => {
    const el = scroller.current;
    if (!el) return;
    vpLive.current = true;
    // (the magnifier / crosshair look at what is under the pointer now: the page moved under it)
    const ai = aidAt.current;
    if (ai && (P.current.crossOn || P.current.loupeOn)) { const at = toPage(ai.cx, ai.cy); if (at) { aidAt.current = { ...ai, page: at.page, p: at.p }; requestAnimationFrame(paintAids); } }
    setVp((v) => (v.top === el.scrollTop && v.left === el.scrollLeft && v.w === el.clientWidth && v.h === el.clientHeight ? v : { top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight }));
  };
  useEffect(() => {
    const el = scroller.current!;
    let raf = 0;
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; readVp(); }); };
    el.addEventListener('scroll', onScroll, { passive: true });
    // recent fit zooms: a layout that flips between two sizes (scrollbar on/off) must not
    // re-fit for ever - the second flip back within a moment is ignored
    const fits: { z: number; t: number }[] = [];
    // the person moves the view: a spot restored a moment ago is no longer to be kept
    const mine = () => { restoreTo.current = null; };
    el.addEventListener('wheel', mine, { passive: true });
    el.addEventListener('pointerdown', mine);
    el.addEventListener('keydown', mine);
    const ro = new ResizeObserver(() => {
      readVp();
      if (restoreTo.current) reRestore();
      if (doc.view.fit !== 'none' && zRef.current) {
        const pg = curPage();
        const nz = fitZoom(doc.view.fit as 'width' | 'page');
        if (Math.abs(nz - zRef.current) < 1e-6) return;
        const now = performance.now();
        while (fits.length && now - fits[0].t > 1000) fits.shift();
        if (fits.filter((f) => Math.abs(f.z - nz) < 1e-6).length >= 2) return;
        fits.push({ z: nz, t: now });
        // keep what is at the top of the view where it is (pages of different sizes shift otherwise)
        const L = lay.current;
        let top = 0, lo = 0, hi = L.pages.length - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (L.tops[m] <= el.scrollTop) lo = m; else hi = m - 1; }
        top = lo;
        const cw = Math.max(L.maxW * L.z + 2 * GAP, el.clientWidth);
        const left = (cw - L.pages[top].w * L.z) / 2;
        anchor.current = { page: top, x: (el.scrollLeft + el.clientWidth / 2 - left) / L.z, y: (el.scrollTop - L.tops[top]) / L.z, cx: el.clientWidth / 2, cy: 0 };
        fitAcross.current = pg;
        setZ(nz);
        centreSoon(pg);
      }
    });
    ro.observe(el);
    return () => { el.removeEventListener('scroll', onScroll); el.removeEventListener('wheel', mine); el.removeEventListener('pointerdown', mine); el.removeEventListener('keydown', mine); ro.disconnect(); };
  }, [doc]);
  /** another tab taken (this viewer goes): its tab comes back to the same page, spot and zoom -
   *  the spot kept up to date while the view moved (below). Not read from the page here: by
   *  the time this runs the panels round it have already changed for the other file, the page
   *  is wider or gone, and its scroll position reads clamped or 0 (that sent every tab back to
   *  the top of page 1 at its zoom - zoomed in, the left of page 1 with half of it off the screen) */
  useLayoutEffect(() => () => {
    const L = lay.current;
    if (!L.z || !L.pages.length || !vpLive.current || !doc.view.anchor) return;
    doc.view.z = L.z;
    doc.view.restore = true;
  }, [doc]);

  const visible = useMemo(() => {
    const out: number[] = [];
    if (!pages.length || !z) return out;
    const y0 = vp.top - vp.h * 0.5, y1 = vp.top + vp.h * 1.5;
    let lo = 0, hi = pages.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tops[m + 1] < y0) lo = m + 1; else hi = m; }
    for (let i = lo; i < pages.length && tops[i] < y1; i++) out.push(i);
    return out;
  }, [vp, tops, pages, z]);

  const pageNow = useMemo(() => curPage(), [vp, tops]);
  // what part of each page is on screen (the Pages panel shows it as a box)
  useEffect(() => {
    if (!z || !vp.w) return;
    const m = new Map<number, Rect>();
    for (const i of visible) {
      const L = leftOf(i), T = tops[i], pg = pages[i];
      const x0 = Math.max(0, (vp.left - L) / z), y0 = Math.max(0, (vp.top - T) / z);
      const x1 = Math.min(pg.w, (vp.left + vp.w - L) / z), y1 = Math.min(pg.h, (vp.top + vp.h - T) / z);
      if (x1 > x0 && y1 > y0) m.set(i, [x0, y0, x1, y1]);
    }
    doc.visRects = m;
    doc.viewChanged();
  }, [vp, tops, z, visible]);
  // where the view is, in page terms (remembered when the file is closed)
  useEffect(() => {
    const el = scroller.current;
    if (!el || !z || !pages.length || doc.view.restore || !vpLive.current) return;
    // (from the page itself: vp can still be the last render's while a restore has just moved it)
    const top = el.scrollTop, left = el.scrollLeft;
    let lo = 0, hi = pages.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tops[m] <= top) lo = m; else hi = m - 1; }
    doc.view.anchor = { page: lo, x: (left - leftOf(lo)) / z, y: (top - tops[lo]) / z };
  }, [vp, tops, z]);
  useEffect(() => { doc.view.page = pageNow; props.onEvent({ type: 'page', page: pageNow }); }, [pageNow]);

  // markups + links of visible pages
  useEffect(() => {
    let live = true;
    (async () => {
      const add: Record<number, AnnotData[]> = {};
      for (const i of visible) add[i] = await doc.annots(i);
      if (live) setAnnots(add);
    })().catch(() => {});
    return () => { live = false; };
  }, [visible.join(','), props.rev]);
  useEffect(() => {
    let live = true;
    (async () => {
      const add: typeof links = {};
      for (const i of visible) {
        add[i] = await doc.links(i);
      }
      if (live) setLinks(add);
    })();
    return () => { live = false; };
  }, [visible.join(','), doc.baseRev]);

  // text lines for the edit-text tool
  useEffect(() => {
    if (props.tool !== 'edit-text') { setBlocks({}); return; }
    let live = true;
    (async () => {
      const add: typeof blocks = {};
      for (const i of visible) add[i] = (await doc.blocks(i)).flatMap((b) => b.lines.map((l) => ({ bbox: l.bbox, text: l.text, origin: l.origin, dir: l.dir, size: l.size, color: l.color, bold: l.bold, italic: l.italic, serif: l.serif, mono: l.mono })));
      if (live) setBlocks(add);
    })();
    return () => { live = false; };
  }, [props.tool, visible.join(','), doc.baseRev]);

  // build the snap index ahead of time when a tool that snaps is picked
  useEffect(() => {
    if (TOOLS[props.tool].snaps && props.snapOn) renderers[0].call('prepareSnap', [doc.id, pageNow]).catch(() => {});
  }, [props.tool, pageNow, doc.baseRev, props.snapOn]);

  // ---------------------------------------------------------------- coordinates

  function toPage(clientX: number, clientY: number, force?: number): { page: number; p: Pt } | null {
    const el = scroller.current;
    if (!el || !pages.length) return null;
    const r = el.getBoundingClientRect();
    const X = clientX - r.left + el.scrollLeft, Y = clientY - r.top + el.scrollTop;
    let i = force ?? -1;
    if (i < 0) {
      let lo = 0, hi = pages.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tops[m] - GAP / 2 <= Y) lo = m; else hi = m - 1; }
      i = lo;
    }
    return { page: i, p: [(X - leftOf(i)) / z, (Y - tops[i]) / z] };
  }

  // ---------------------------------------------------------------- api for the app

  useEffect(() => {
    props.apiRef.current = {
      goTo(page, rect, keepZoom) {
        const el = scroller.current;
        if (!el || page < 0 || page >= pages.length) return;
        // (a jump of the app's own: the spot restored a moment ago is no longer to be kept)
        restoreTo.current = null;
        let zz = zRef.current;
        if (rect && !keepZoom) zz = zoomToShow(zz, rect, el.clientWidth, el.clientHeight, zMax);
        if (Math.abs(zz - zRef.current) > 1e-6) {
          const cx = rect ? (rect[0] + rect[2]) / 2 : pages[page].w / 2, cy = rect ? (rect[1] + rect[3]) / 2 : 0;
          anchor.current = { page, x: cx, y: cy, cx: el.clientWidth / 2, cy: rect ? el.clientHeight / 2 : GAP };
          doc.view.fit = 'none';
          setZ(zz);
          return;
        }
        if (rect) {
          el.scrollTop = tops[page] + ((rect[1] + rect[3]) / 2) * zz - el.clientHeight / 2;
          el.scrollLeft = leftOf(page) + ((rect[0] + rect[2]) / 2) * zz - el.clientWidth / 2;
        } else { el.scrollTop = tops[page] - GAP / 2; centreX(page); }
        readVp();
      },
      zoomBy(f) { zoomAt(zRef.current * f); },
      setZoom(nz) { zoomAt(nz); },
      fit(mode) {
        restoreTo.current = null;
        doc.view.fit = mode;
        const pg = curPage();
        const nz = fitZoom(mode);
        if (Math.abs(nz - zRef.current) < 1e-6) { const el = scroller.current; if (el) { el.scrollTop = tops[pg] - GAP / 2; centreX(pg); readVp(); } return; }
        fitPage.current = pg;
        setZ(nz);
      },
      zoom: () => zRef.current,
      page: () => curPage(),
      copySelection() {
        if (!textSel) return false;
        void copyText();
        return true;
      },
      editAnnot(page, id) {
        const a = (annots[page] || []).find((x) => x.id === id);
        if (a) { openFreeEditor(a); return; }
        // its page is scrolled out of view (only the pages in view are read here): read it, go there
        void doc.annots(page).then((l) => {
          const b = l.find((x) => x.id === id);
          if (!b) return;
          props.apiRef.current?.goTo(page, b.box || b.rect, true);
          openFreeEditor(b);
        }).catch(() => {});
      },
      copyMarkups: (cut) => copyMarkups(!!cut),
      pasteMarkups: (at) => pasteMarkups(at),
      duplicate: () => duplicate(),
      corners(page, id, at) {
        const a = (annotsNow.current[page] || []).find((x) => x.id === id);
        const editable = !!a && cornersEditable(a);
        const corner = cornerAt(page, id, at), n = a?.vertices?.length ?? 0;
        // (drawn on from a corner: any corner of an outline; one in the middle of a line - its ends
        // are "Continue this line"; not a rectangle or circle kept as one, nor an angle)
        const canContinueFrom = editable && corner >= 0 && a!.kind !== 'measure-angle' && !rectish(a!) && !circular(a!)
          && (a!.type === 'Polygon' || (a!.type === 'PolyLine' && corner > 0 && corner < n - 1));
        return { corner, editable, canDelete: editable && n > minCorners(a!), open: editable && a!.type === 'PolyLine', canContinueFrom };
      },
      deleteCorner: (page, id, index) => deleteCorner(page, id, index),
      addCorner: (page, id, at) => addCorner(page, id, at),
      continueLine: (page, id, at, from) => continueLine(page, id, at, from),
    };
  });

  // ---------------------------------------------------------------- text selection

  const charsCache = useRef<Record<string, { text: string; box: Float32Array }>>({});
  /** where the mouse last was over a page (the cursor set late, once the page's text is read) */
  const lastHover = useRef<Pt | null>(null);
  // another tool: the cursor of the last one (an I-beam) doesn't stay until the mouse moves
  useEffect(() => { const el = scroller.current; if (el) el.dataset.cursor = props.tool === 'select' ? 'auto' : props.tool === 'hand' ? 'grab' : props.tool === 'edit-text' ? 'text' : 'crosshair'; }, [props.tool]);
  const charsOf = async (page: number) => {
    const k = doc.baseRev + ':' + page;
    if (!charsCache.current[k]) {
      charsCache.current[k] = await doc.chars(page);
      // keep the last 40 pages (a 1,500-page spec read through would otherwise keep them all)
      const keys = Object.keys(charsCache.current);
      if (keys.length > 40) delete charsCache.current[keys[0]];
    }
    return charsCache.current[k];
  };
  const charAt = (c: { text: string; box: Float32Array }, p: Pt, pad: number): number => {
    let best = -1, bd = Infinity;
    for (let i = 0; i < c.text.length; i++) {
      const x0 = c.box[i * 4], y0 = c.box[i * 4 + 1], x1 = c.box[i * 4 + 2], y1 = c.box[i * 4 + 3];
      if (Number.isNaN(x0) || x1 <= x0) continue;
      if (p[0] >= x0 - pad && p[0] <= x1 + pad && p[1] >= y0 - pad && p[1] <= y1 + pad) {
        const d = Math.abs(p[0] - (x0 + x1) / 2) + Math.abs(p[1] - (y0 + y1) / 2) * 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  };
  /** nearest char on the page in reading order (for dragging past the end of a line) */
  const nearestChar = (c: { text: string; box: Float32Array }, p: Pt): number => {
    let best = -1, bd = Infinity;
    for (let i = 0; i < c.text.length; i++) {
      const x0 = c.box[i * 4], y0 = c.box[i * 4 + 1], x1 = c.box[i * 4 + 2], y1 = c.box[i * 4 + 3];
      if (Number.isNaN(x0)) continue;
      const dx = p[0] < x0 ? x0 - p[0] : p[0] > x1 ? p[0] - x1 : 0;
      const dy = p[1] < y0 ? y0 - p[1] : p[1] > y1 ? p[1] - y1 : 0;
      const d = dx + dy * 4;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  /** one rectangle per line piece */
  const rectsFor = (c: { text: string; box: Float32Array }, a: number, b: number): number[][] => {
    const out: number[][] = [];
    let cur: number[] | null = null;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      const x0 = c.box[i * 4], y0 = c.box[i * 4 + 1], x1 = c.box[i * 4 + 2], y1 = c.box[i * 4 + 3];
      if (Number.isNaN(x0) || x1 <= x0) continue;
      if (cur && Math.abs((cur[1] + cur[3]) / 2 - (y0 + y1) / 2) < (cur[3] - cur[1]) * 0.6 && x0 >= cur[0] - 2 && x0 - cur[2] < (y1 - y0) * 3) {
        cur[0] = Math.min(cur[0], x0); cur[1] = Math.min(cur[1], y0); cur[2] = Math.max(cur[2], x1); cur[3] = Math.max(cur[3], y1);
      } else { cur = [x0, y0, x1, y1]; out.push(cur); }
    }
    return out;
  };
  useEffect(() => {
    if (!textSel) { setSelRects([]); return; }
    void charsOf(textSel.page).then((c) => setSelRects(rectsFor(c, textSel.a, textSel.b)));
  }, [textSel]);
  // the page's text changed (pages deleted, moved, turned, OCR'd...): a text selection is by
  // character number on a page number - it stayed lit, and Ctrl+C copied text of another page
  useEffect(() => { setTextSel(null); }, [doc.baseRev]);

  // ---------------------------------------------------------------- ends of a text markup
  /** the one selected text markup and the characters it covers: its two ends get handles that
   *  are dragged along the text (to highlight more or less of it) */
  const [edge, setEdge] = useState<{ page: number; id: number; a: number; b: number } | null>(null);
  /** pointer moves while dragging over text: only the newest one's answer counts */
  const moveSeq = useRef(0);
  useEffect(() => {
    const s = props.sel;
    const a = s.length === 1 ? (annots[s[0].page] || []).find((x) => x.id === s[0].id) : undefined;
    if (!a || !isTextMarkup(a) || a.locked) { setEdge(null); return; }
    let gone = false;
    const page = s[0].page;
    void charsOf(page).then((c) => { if (gone) return; const r = rangeOfMarkup(c, a); setEdge(r ? { page, id: a.id, a: r[0], b: r[1] } : null); });
    return () => { gone = true; };
  }, [props.sel, annots]);
  /** the ends of chars [lo, hi]: start = left edge of the first char, end = right edge of the last */
  const edgeBars = (page: number, lo: number, hi: number) => {
    const c = charsCache.current[doc.baseRev + ':' + page];
    if (!c || lo < 0 || hi >= c.text.length) return null;
    const b = (i: number) => [c.box[i * 4], c.box[i * 4 + 1], c.box[i * 4 + 2], c.box[i * 4 + 3]];
    const s0 = b(lo), e0 = b(hi);
    if (Number.isNaN(s0[0]) || Number.isNaN(e0[0])) return null;
    return { s: { x: s0[0], y0: s0[1], y1: s0[3] }, e: { x: e0[2], y0: e0[1], y1: e0[3] } };
  };
  /** the end handle under the pointer: 's' (start, knob on top) or 'e' (end, knob below) */
  const edgeAt = (page: number, p: Pt): 's' | 'e' | null => {
    if (!edge || edge.page !== page) return null;
    const h = edgeBars(page, edge.a, edge.b);
    if (!h) return null;
    const t = 5 / zRef.current, r = 5.5 / zRef.current;
    const near = (x: number, y0: number, y1: number, ky: number) => (Math.abs(p[0] - x) < t && p[1] > y0 - t && p[1] < y1 + t) || dist(p, [x, ky]) < r + t;
    if (near(h.e.x, h.e.y0, h.e.y1, h.e.y1 + r * 1.6)) return 'e';
    if (near(h.s.x, h.s.y0, h.s.y1, h.s.y0 - r * 1.6)) return 's';
    return null;
  };
  const selectedText = async () => {
    if (!textSel) return '';
    const c = await charsOf(textSel.page);
    return c.text.slice(Math.min(textSel.a, textSel.b), Math.max(textSel.a, textSel.b) + 1).replace(/\r\n/g, '\n');
  };
  const copyText = async () => { const t = await selectedText(); if (t) await gcc.copyText(t); };

  // ---------------------------------------------------------------- snapping

  const snapR = () => 12 / zRef.current;
  /** snap to markup corners locally; line work via the drawing engine (async, latest wins) */
  const doSnap = (page: number, p: Pt, ev: { ctrlKey: boolean }) => {
    const pr = P.current;
    if (!pr.snapOn || ev.ctrlKey || (!TOOLS[pr.tool].snaps && drag?.mode !== 'vertex')) { snapWanted.current = false; snapNext.current = null; snapRef.current = null; setSnapMark(null); return; }
    snapWanted.current = true;
    const r = snapR();
    let best: { p: Pt; k: string } | null = null, bd = r;
    // the point the line being drawn comes from: a line near the pointer also offers the foot of the
    // perpendicular from it (⊥, when the pointer is near that foot) - markup edges here, the
    // drawing's lines in the engine (as in the Estimation app)
    const from: Pt | null = draft && draft.page === page ? (draft.kind === 'poly' ? draft.pts[draft.pts.length - 1] : draft.kind === 'two' ? draft.a : null) : null;
    let perp: Pt | null = null, pd = r;
    for (const a of annots[page] || []) {
      if (drag?.mode === 'move' && drag.items.some((s) => s.id === a.id)) continue;
      // a corner being dragged snaps to its own shape's other corners too - only to itself not (a
      // circle or a rectangle kept square moves as a whole: none of its own)
      let skip = -1;
      if (drag?.mode === 'vertex' && drag.id === a.id) {
        if (drag.which === 'r' || drag.which === 'c' || (drag.which === 'v' && !drag.ins && !drag.free && rectish(a))) continue;
        skip = drag.ins ? -1 : drag.index;
      }
      const pts: Pt[] = a.vertices || a.line || (a.type === 'Square' || a.type === 'Circle' || a.type === 'FreeText' ? [[a.rect[0], a.rect[1]], [a.rect[2], a.rect[1]], [a.rect[2], a.rect[3]], [a.rect[0], a.rect[3]]] : []);
      pts.forEach((q, i) => { if (i === skip) return; const d = dist(p, q); if (d < bd) { bd = d; best = { p: q, k: 'Markup corner' }; } });
      // (⊥ only onto edges that are drawn: not an ellipse's or a text box's box, nor a turned
      // rectangle's unturned one)
      if (from && pts.length > 1 && a.type !== 'Circle' && a.type !== 'FreeText' && !(a.type === 'Square' && a.angle)) {
        const closed = !!a.vertices && a.type !== 'PolyLine' || !a.vertices && !a.line;
        for (let i = 0; i < (closed ? pts.length : pts.length - 1); i++) {
          const f = perpFootOn(from, pts[i], pts[(i + 1) % pts.length]);
          if (!f || dist(f, from) < 1e-6 || segDist(p, pts[i], pts[(i + 1) % pts.length]) >= r) continue;
          const d = dist(f, p);
          if (d < pd) { pd = d; perp = f; }
        }
      }
    }
    // (a corner nearer than the foot wins)
    if (perp && !(best && bd <= pd)) best = { p: perp, k: 'Perpendicular' };
    if (draft && draft.kind === 'poly' && draft.pts.length > 2) { const d = dist(p, draft.pts[0]); if (d < bd) { bd = d; best = { p: draft.pts[0], k: 'Start point' }; } }
    snapAt.current = { page, p, local: !!best };
    if (best) { snapNext.current = null; snapRef.current = { page, raw: p, p: best.p, k: best.k }; setSnapMark({ page, p: best.p, k: best.k }); return; }
    askSnap({ page, p, r, from });
  };
  /** the drawing's line work, by the drawing engine - one call out at a time; a spot asked for
   *  meanwhile is asked next (the pointer resting where it stopped is always answered: the newest
   *  spot was dropped while the engine was busy, and the click landed unsnapped) */
  const askSnap = (q: { page: number; p: Pt; r: number; from: Pt | null }) => {
    if (snapBusy.current) { snapNext.current = q; return; }
    snapBusy.current = true;
    const { page, p, r, from } = q;
    const done = () => { snapBusy.current = false; const n = snapNext.current; snapNext.current = null; if (n && snapWanted.current) askSnap(n); };
    renderers[0].call<{ x: number; y: number; k: 'end' | 'mid' | 'on' | 'perp' } | null>('snap', [doc.id, page, p[0], p[1], r, from]).then((s) => {
      const at = snapAt.current;
      // the answer may arrive after the click / tool change: then it's no longer wanted; nor when
      // the pointer has moved on (a newer spot is asked next), or found a markup corner meanwhile
      if (snapWanted.current && at && !at.local && at.page === page && dist(at.p, p) <= r) {
        if (s) {
          const k = s.k === 'end' ? 'End point' : s.k === 'mid' ? 'Middle' : s.k === 'perp' ? 'Perpendicular' : 'On line';
          snapRef.current = { page, raw: p, p: [s.x, s.y], k };
          setSnapMark({ page, p: [s.x, s.y], k });
        } else { snapRef.current = null; setSnapMark(null); }
      }
      done();
    }).catch(done);
  };
  const snapped = (page: number, p: Pt): Pt => {
    const s = snapRef.current;
    if (s && s.page === page && dist(s.raw, p) < snapR() * 1.5) return s.p;
    return p;
  };

  // ---------------------------------------------------------------- drawing aids (Estimation 0.16)
  // Crosshair: two lines across the view through the pointer. Magnifier: a loupe beside the pointer
  // with what is under it at loupeZoom x the zoom - the page as on screen while the pointer moves,
  // drawn sharp by the engine once it rests; the shape being drawn and the exact point over it.
  const xhH = useRef<HTMLDivElement>(null), xhV = useRef<HTMLDivElement>(null), loupeRef = useRef<HTMLCanvasElement>(null);
  const aidAt = useRef<{ cx: number; cy: number; page: number; p: Pt } | null>(null);
  const loupeSharp = useRef<{ key: string; bmp: ImageBitmap } | null>(null);
  const loupeTimer = useRef(0);
  const LOUPE = 180;
  const paintAids = () => {
    const pr = P.current, at = aidAt.current, el = scroller.current;
    const vb = el?.getBoundingClientRect();
    const inside = !!at && !!vb && at.cx >= vb.left && at.cx <= vb.right && at.cy >= vb.top && at.cy <= vb.bottom;
    for (const [d, hz] of [[xhH.current, true], [xhV.current, false]] as const) {
      if (!d) continue;
      if (!pr.crossOn || !inside) { d.style.display = 'none'; continue; }
      d.style.display = 'block';
      if (hz) { d.style.left = vb!.left + 'px'; d.style.width = vb!.width + 'px'; d.style.top = Math.round(at!.cy) + 'px'; }
      else { d.style.top = vb!.top + 'px'; d.style.height = vb!.height + 'px'; d.style.left = Math.round(at!.cx) + 'px'; }
    }
    const cv = loupeRef.current;
    if (!cv) return;
    const pgEl = inside ? el!.querySelector(`.pg[data-page="${at!.page}"]`) : null;
    if (!pr.loupeOn || !inside || !pgEl) { cv.style.display = 'none'; return; }
    const R = LOUPE / 2, gap = 26, mag = Math.max(2, Math.min(10, pr.loupeZoom || 3));
    // beside the pointer (up and to the right; the other side near an edge of the view)
    let lx = at!.cx + gap, ly = at!.cy - gap - LOUPE;
    if (lx + LOUPE > vb!.right - 4) lx = at!.cx - gap - LOUPE;
    if (ly < vb!.top + 4) ly = at!.cy + gap;
    cv.style.display = 'block';
    cv.style.left = Math.round(lx) + 'px';
    cv.style.top = Math.round(ly) + 'px';
    const dpr = window.devicePixelRatio || 1, W = Math.round(LOUPE * dpr);
    if (cv.width !== W) { cv.width = W; cv.height = W; }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, LOUPE, LOUPE);
    const z0 = zRef.current, pb = pgEl.getBoundingClientRect();
    const cx = at!.p[0] * z0, cy = at!.p[1] * z0;
    const toL = (q: Pt): Pt => [(q[0] * z0 - cx) * mag + R, (q[1] * z0 - cy) * mag + R];
    const drawEls = (sel: string) => pgEl.querySelectorAll(sel).forEach((x) => {
      const h = x as HTMLElement;
      if (h.style.opacity === '0' || h.style.display === 'none') return;
      const r = h.getBoundingClientRect();
      const dx = (r.left - pb.left - cx) * mag + R, dy = (r.top - pb.top - cy) * mag + R;
      if (dx > LOUPE || dy > LOUPE || dx + r.width * mag < 0 || dy + r.height * mag < 0) return;
      try { ctx.drawImage(h as unknown as CanvasImageSource, dx, dy, r.width * mag, r.height * mag); } catch { /* not drawn yet */ }
    });
    const s = z0 * mag * dpr;
    const key = `${doc.id}|${at!.page}|${doc.crev[at!.page] ?? 0}|${Math.round(at!.p[0] * s)}|${Math.round(at!.p[1] * s)}|${s.toFixed(4)}`;
    const sharp = loupeSharp.current;
    if (sharp && sharp.key === key) ctx.drawImage(sharp.bmp, 0, 0, LOUPE, LOUPE);
    else { drawEls('canvas.pv'); drawEls('.tl:not(.hl):not(.an) > *'); }
    drawEls('.tl.hl > *');
    drawEls('.tl.an > *');
    // the shape being drawn
    if (draft && draft.kind === 'poly' && draft.page === at!.page) {
      const pts = [...draft.pts, at!.p, ...(draft.cont?.tail ?? [])].map(toL);
      ctx.strokeStyle = css(P.current.style.color);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
      ctx.stroke();
    } else if (draft && draft.kind === 'two' && draft.page === at!.page) {
      const a = toL(draft.a), b = toL(at!.p);
      ctx.strokeStyle = css(P.current.style.color);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    // the exact point: a fine cross with a gap in the middle (red), the snap kind under it
    ctx.strokeStyle = '#c92a2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, R + 0.5); ctx.lineTo(R - 5, R + 0.5); ctx.moveTo(R + 5, R + 0.5); ctx.lineTo(LOUPE, R + 0.5);
    ctx.moveTo(R + 0.5, 0); ctx.lineTo(R + 0.5, R - 5); ctx.moveTo(R + 0.5, R + 5); ctx.lineTo(R + 0.5, LOUPE);
    ctx.stroke();
    ctx.fillStyle = 'rgba(9, 48, 47, 0.85)';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.fillText('×' + mag, R + 30, LOUPE - 14);
    // sharp once the pointer rests
    window.clearTimeout(loupeTimer.current);
    // (not past the view's own zoom limit, nor on a page given up on as too heavy - it took a
    // drawing engine down twice: drawn again it loops; the magnified screen picture shows then)
    if (!(sharp && sharp.key === key) && z0 * mag <= lay.current.zMax && !tiles.isHeavy(`${doc.id}|r${doc.crev[at!.page]}`)) {
      const page = at!.page, p0 = at!.p;
      loupeTimer.current = window.setTimeout(() => {
        const x = Math.round(p0[0] * s - W / 2), y = Math.round(p0[1] * s - W / 2);
        rendererFor(doc.id, page).call<ImageBitmap>('tile', [doc.id, page, s, x, y, W, W]).then((bmp) => {
          if (aidAt.current && aidAt.current.p === p0) { loupeSharp.current?.bmp.close(); loupeSharp.current = { key, bmp }; paintAids(); } else bmp.close();
        }).catch(() => {});
      }, 140);
    }
  };
  useEffect(() => { paintAids(); }, [props.crossOn, props.loupeOn, props.loupeZoom]);
  // (the graphics memory was reset - tiles.reset: the magnifier's sharp picture may be wiped too)
  useEffect(() => tiles.onReset(() => { try { loupeSharp.current?.bmp.close(); } catch { /* gone */ } loupeSharp.current = null; }), []);

  // ---------------------------------------------------------------- measuring

  const scaleFor = (page: number, p: Pt) => doc.scaleAt(page, p[0], p[1]);
  /** a measurement's number; f: its own format (an existing one), else the tools' format */
  const measureText = (tool: ToolId, page: number, pts: Pt[], f?: MeasureFmt): string => measureValue(tool, pts, scaleFor(page, pts[0]), f ?? P.current.style.fmt);
  /**
   * Label text size for a new measurement: readable at the zoom it is drawn at (a detail measured
   * zoomed in gets small text on the sheet, not letters across half the screen), times the
   * file's own label size (Measure > Labels).
   */
  const LABEL_PX = 14; // a new number's height on screen at the zoom it is measured at
  /** a new length's line width: the tool's width as it shows at the zoom you measure at (the
   *  file's Number size is for the numbers and arrows - not the line) */
  const lengthWidth = () => Math.max(0.1, Math.round((P.current.style.width ?? 1) * (Math.max(2, Math.min(72, LABEL_PX / zRef.current)) / LABEL_PX) * 100) / 100);
  const labelSizeNow = () => {
    const k = Number(doc.data.labelK) || 1;
    return Math.round(Math.max(2, Math.min(72, (LABEL_PX / zRef.current) * k)) * 10) / 10;
  };

  // ---------------------------------------------------------------- creating markups

  const st = () => P.current.style;
  const common = (): Partial<AnnotSpec> => ({ color: st().color, opacity: st().opacity, bw: st().width, dash: st().dash });

  /** big sheets (A1/A0) get bigger text, labels and markers by default: A4 sizes vanish on them */
  const sheetK = (page: number) => { const pg = pages[page]; return pg ? Math.min(4, Math.max(1, Math.round((Math.max(pg.w, pg.h) / 842) * 2) / 2)) : 1; };
  async function create(page: number, spec: AnnotSpec, select = true) {
    const k = sheetK(page);
    if (k > 1) {
      spec = { ...spec };
      if (spec.font) spec.font = { ...spec.font, size: Math.round(spec.font.size * k) };

      if (spec.bw && spec.type !== 'Highlight') spec.bw = Math.round(spec.bw * Math.sqrt(k) * 10) / 10;
      if (spec.type === 'Text' && spec.rect) { const r = spec.rect; spec.rect = [r[0], r[1], r[0] + 20 * k, r[1] + 20 * k]; }
    }
    if (spec.kind?.startsWith('measure-') && spec.kind !== 'measure-count') {
      const size = labelSizeNow();
      spec = { ...spec, labelSize: size, fmt: P.current.style.fmt || {} };
      // a measured length is drawn for the zoom it is measured at, like its number and arrows: its
      // line width as it shows then (a thick sheet-sized line was as wide as a detail's number)
      if (spec.kind === 'measure-length') spec.bw = lengthWidth();
    }
    try {
      const a = await doc.create(page, spec);
      P.current.onEvent({ type: 'created', a });
      if (select && !P.current.keepTool) { P.current.setTool('select'); P.current.setSel([{ page, id: a.id }]); }
      return a;
    } catch (e) {
      P.current.onEvent({ type: 'error', text: String((e as Error).message || e) });
      return null;
    }
  }

  /**
   * A clicked (not dragged) text box starts small and fits its text while you type: as wide as
   * the longest line up to this limit (then it wraps), as tall as the lines.
   */
  const autoLimit = (page: number, x: number, kk: number, typewriter = false) => {
    const pg = pages[page];
    const room = pg ? pg.w - x - 4 * kk : 360 * kk;
    return Math.max(40 * kk, typewriter ? room : Math.min(360 * kk, room));
  };
  /** the first, small box of a text box that fits its text */
  const autoBox = (p: Pt, kk: number, size: number, bw: number): Rect => [p[0], p[1], p[0] + size * kk * 2 + 2 * bw + 6, p[1] + size * kk * 1.2 + 2 * bw + 5];

  /** the second point of a two-point draft: Shift = 0/45/90° - for a rectangle area, a square
   *  (kept on the page: near its edge the square stops there, as the point itself does) */
  const twoEnd = (a: Pt, q: Pt, shift: boolean, page: number, orth = false): Pt => {
    if (!shift && !orth) return q;
    const how = howOf(P.current.tool);
    if (how === 'circle') return q;
    if (how !== 'rect') return ortho(a, q);
    if (!shift) return q;
    const sx = Math.sign(q[0] - a[0] || 1), sy = Math.sign(q[1] - a[1] || 1);
    const pg = pages[page];
    let s = Math.max(Math.abs(q[0] - a[0]), Math.abs(q[1] - a[1]));
    if (pg) s = Math.max(0, Math.min(s, sx > 0 ? pg.w - a[0] : a[0], sy > 0 ? pg.h - a[1] : a[1]));
    return [a[0] + sx * s, a[1] + sy * s];
  };
  /** a rectangle area's corners, from the corner it was started at round to the opposite one */
  const rectCorners = (a: Pt, b: Pt): Pt[] => [a, [b[0], a[1]], b, [a[0], b[1]]];
  /** how the tool's shape is drawn (Area / Perimeter: corners, a rectangle or a circle) */
  // (continuing an outline from a corner is by points, whatever the tool's rectangle / circle
  // mode: the first click started a rectangle and the continuation was lost)
  const howOf = (tool: ToolId): MeasureHow => (draft && draft.kind === 'poly' && draft.cont ? 'points' : tool === 'm-rectarea' ? 'rect' : tool === 'm-area' || tool === 'm-perimeter' ? P.current.how || 'points' : 'points');
  /** the point is where a snap put it (what `snapped` returned) */
  const snappedNow = (page: number, p: Pt) => { const s = snapRef.current; return !!s && s.page === page && s.p[0] === p[0] && s.p[1] === p[1]; };
  /** straighten to 0 / 45 / 90°: Shift always; Ortho (F8) unless the point snapped to something -
   *  a snap wins, as in CAD (Ortho moved a snapped corner a snap radius off it, the mark still on it) */
  const straight = (e: { shiftKey: boolean }, page: number, p: Pt) => e.shiftKey || (!!P.current.orthoOn && !snappedNow(page, p));
  const gestureOf = (tool: ToolId): Gesture => (howOf(tool) === 'points' ? TOOLS[tool].gesture : 'two');
  /** the measurement kind a tool makes (the Rectangle area tool of 0.8.4 makes areas) */
  const kindOfTool = (tool: ToolId) => (tool === 'm-rectarea' ? 'm-area' : tool) as ToolId;
  /** a circle drawn from its centre `a` through `b`: its outline (starting at b - its handle) */
  const circleFrom = (a: Pt, b: Pt): Pt[] => circlePts(a, dist(a, b), CIRCLE_N, Math.atan2(b[1] - a[1], b[0] - a[0]));

  async function finishDraft(d: Draft) {
    const tool = P.current.tool;
    const s = st();
    setDraft(null);
    setTip(null);
    if (d.kind === 'rect') {
      const r = rectOf(d.a, d.b);
      const small = r[2] - r[0] < 3 / zRef.current && r[3] - r[1] < 3 / zRef.current;
      switch (tool) {
        case 'zoom': if (!small) { const el = scroller.current!; const nz = Math.min(el.clientWidth / (r[2] - r[0]), el.clientHeight / (r[3] - r[1])) * 0.92; anchor.current = { page: d.page, x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2, cx: el.clientWidth / 2, cy: el.clientHeight / 2 }; doc.view.fit = 'none'; setZ(clamp(nz, 0.02, zMax)); } else zoomAt(zRef.current * 2); return;
        case 'link':
          // a click: the link there (to change or delete it); a box: a new one
          P.current.onEvent(small ? { type: 'linkAt', page: d.page, pt: d.a } : { type: 'link', page: d.page, rect: r });
          return;
        case 'snapshot': case 'table': case 'crop': case 'ocr-area': case 'm-viewport': case 'stamp-grab':
          if (!small) P.current.onEvent({ type: tool === 'm-viewport' ? 'viewport' : tool, page: d.page, rect: r } as ViewerEvent);
          return;
        case 'rect': case 'ellipse':
          if (small) return;
          await create(d.page, { ...common(), type: tool === 'rect' ? 'Square' : 'Circle', rect: r, ic: s.fill, cloudy: s.cloudy });
          return;
        case 'area-highlight': case 'highlight':
          // (a sideways drag beside the text: a flat area that would be an invisible highlight)
          if (small || r[3] - r[1] < 2 || r[2] - r[0] < 2) return;
          await create(d.page, { type: 'Highlight', quads: [[r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]]], color: s.color, opacity: s.opacity, kind: 'area-highlight' }, false);
          return;
        case 'redact-area':
          if (small) return;
          await create(d.page, { type: 'Redact', rect: r, redactFill: st().redact ?? [0, 0, 0] }, false);
          return;
        case 'textbox': {
          const kk = sheetK(d.page);
          // clicked: a small box that fits the text as it is typed; dragged: that width, taller as needed
          const rr: Rect = small ? autoBox([r[0], r[1]], kk, s.fontSize, s.width) : r;
          const a = await create(d.page, { type: 'FreeText', rect: rr, contents: '', color: s.color, bw: s.width, opacity: s.opacity, dash: s.dash, font: { size: s.fontSize, color: s.fontColor, family: s.fontFamily, bold: s.bold, italic: s.italic }, kind: 'textbox', autoWidth: small ? autoLimit(d.page, r[0], kk) : null });
          if (a) openFreeEditor(a, true);
          return;
        }
        case 'stamp': case 'image': case 'signature': {
          const pl = P.current.place;
          if (!pl) { P.current.onEvent({ type: 'error', text: 'Pick a ' + tool + ' first.' }); return; }
          let rr: Rect;
          const sk = pl.real ? 1 : Math.sqrt(sheetK(d.page));
          if (small) rr = [r[0] - (pl.w * sk) / 2, r[1] - (pl.h * sk) / 2, r[0] + (pl.w * sk) / 2, r[1] + (pl.h * sk) / 2];
          else { const k = Math.min((r[2] - r[0]) / pl.w, (r[3] - r[1]) / pl.h); rr = [r[0], r[1], r[0] + pl.w * k, r[1] + pl.h * k]; }
          // on the page: centred on a click near its edge (signing in a corner) most of it hung
          // off the sheet - cut off on screen and in print, a sliver left to grab
          const pg = pages[d.page];
          if (pg) rr = placeOnPage(rr, pg.w, pg.h);
          await create(d.page, { ...pl.spec, rect: rr });
          return;
        }
      }
      return;
    }
    if (d.kind === 'two') {
      if (dist(d.a, d.b) < 2 / zRef.current) return;
      const how = howOf(tool);
      if (how === 'rect' || how === 'circle') {
        let pts: Pt[];
        if (how === 'rect') {
          // (a line, not a box: nothing to measure)
          if (Math.abs(d.b[0] - d.a[0]) < 2 / zRef.current || Math.abs(d.b[1] - d.a[1]) < 2 / zRef.current) return;
          pts = rectCorners(d.a, d.b);
        } else pts = circleFrom(d.a, d.b);
        // an ordinary Area / Perimeter measurement (Polygon) - edited, labelled, listed and
        // exported like one (a circle's number is the circle's: geom circleOf); the style
        // panel's Edge - straight or cloud - as the tool offers it
        const t = kindOfTool(tool);
        const area = t === 'm-area';
        await create(d.page, { ...common(), type: 'Polygon', vertices: pts, ic: area ? s.fill : null, cloudy: area ? s.cloudy : 0, contents: measureText(t, d.page, pts), autoLabel: true, kind: area ? 'measure-area' : 'measure-perimeter', subject: area ? 'Area' : 'Perimeter' }, false);
        return;
      }
      if (tool === 'm-calibrate') { P.current.onEvent({ type: 'calibrate', page: d.page, a: d.a, b: d.b }); return; }
      if (tool === 'm-length') {
        await create(d.page, { ...common(), type: 'Line', line: [d.a, d.b], le: s.le, caption: false, contents: measureText(tool, d.page, [d.a, d.b]), autoLabel: true, kind: 'measure-length', subject: 'Length' }, false);
        return;
      }
      await create(d.page, { ...common(), type: 'Line', line: [d.a, d.b], le: s.le, kind: tool });
      return;
    }
    if (d.kind === 'poly' && d.cont) {
      // a line continued: the same markup, longer (its arrow heads stay at its ends if drawn on from its start)
      const a = (annotsNow.current[d.page] || []).find((x) => x.id === d.cont!.id);
      if (!a || !a.vertices || d.pts.length <= d.cont.base) return;
      // (from a corner in the middle - or any corner of an outline: the new corners go in after it,
      // the rest stays - as in the Estimation app)
      if (d.cont.tail) { await setCorners(a, [...d.pts, ...d.cont.tail], 'Continue from corner'); return; }
      const rev = a.vertices.length > 0 && (a.vertices[0][0] !== d.pts[0][0] || a.vertices[0][1] !== d.pts[0][1]);
      const pts = rev ? d.pts.slice().reverse() : d.pts;
      await setCorners(a, pts, 'Continue line', rev && a.le ? { le: [a.le[1], a.le[0]] } : {});
      return;
    }
    if (d.kind === 'poly') {
      const pts = d.pts;
      const closed = tool === 'polygon' || tool === 'cloud' || tool === 'm-area' || tool === 'm-perimeter';
      if (pts.length < (closed ? 3 : 2)) return;
      if (tool.startsWith('m-')) {
        const kind = 'measure-' + tool.slice(2);
        const subj = { 'm-polylength': 'Polylength', 'm-area': 'Area', 'm-perimeter': 'Perimeter', 'm-angle': 'Angle' }[tool as string] || 'Measurement';
        await create(d.page, { ...common(), type: closed ? 'Polygon' : 'PolyLine', vertices: pts, ic: tool === 'm-area' ? s.fill : null, contents: measureText(tool, d.page, pts), autoLabel: true, kind, subject: subj }, false);
        if (tool === 'm-area' && selfCrosses(pts)) P.current.onEvent({ type: 'note', text: 'The sides of that area cross each other: its number is the difference of the parts, not their sum. Drag its corners so the sides don\'t cross (or draw it again, going round the edge).' });
        return;
      }
      await create(d.page, { ...common(), type: closed ? 'Polygon' : 'PolyLine', vertices: pts, ic: closed ? s.fill : undefined, cloudy: tool === 'cloud' ? Math.max(1, s.cloudy) : s.cloudy, le: closed ? undefined : s.le, kind: tool });
      return;
    }
    if (d.kind === 'ink') {
      const strokes = d.strokes.filter((x) => x.length > 0);
      if (!strokes.length) return;
      // (in the pencil's own colour and width: the stroke may be finished after another tool was picked)
      await create(d.page, { ...(d.spec ?? common()), type: 'Ink', ink: strokes.map(simplify), kind: 'pencil' }, false);
      return;
    }
    if (d.kind === 'callout' && d.box) {
      const b = d.box;
      // only the tip: the engine draws the line to the side of the box nearest to it
      // (the Style group's Opacity and Dashed count here too, as for the text box, the
      // typewriter, comments and counts - they were made at 100 %, solid, whatever was set)
      const kk = sheetK(d.page);
      const a = await create(d.page, { type: 'FreeText', rect: b, contents: '', color: s.color, bw: s.width, opacity: s.opacity, dash: s.dash, font: { size: s.fontSize, color: s.fontColor, family: s.fontFamily, bold: s.bold, italic: s.italic }, intent: 'FreeTextCallout', callout: [d.tip], kind: 'callout', autoWidth: d.sized ? null : autoLimit(d.page, b[0], kk) });
      if (a) openFreeEditor(a, true);
    }
  }

  /** fewer points for freehand strokes (Douglas-Peucker, ~0.4 screen px) */
  const simplify = (pts: Pt[]): Pt[] => {
    if (pts.length < 3) return pts;
    const eps = 0.4 / zRef.current;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack: [number, number][] = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      let md = 0, mi = -1;
      for (let i = a + 1; i < b; i++) { const dd = segDist(pts[i], pts[a], pts[b]); if (dd > md) { md = dd; mi = i; } }
      if (md > eps && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  };

  // ---------------------------------------------------------------- editors

  function openFreeEditor(a: AnnotData, isNew = false) {
    if (a.locked) return;
    const box = a.box || a.rect;
    // the markup stays selected while its text is edited: its frame can still be dragged / resized
    P.current.setSel([{ page: a.page, id: a.id }]);
    // (a text box's fill is its colour /C; its border is drawn in the text colour)
    window.setTimeout(() => { setEditHide({ page: a.page, id: a.id }); setEditor({ page: a.page, kind: 'free', rect: box, value: a.contents || '', id: a.id, size: a.font?.size || 11, color: css(a.font?.color || [0, 0, 0]), angle: a.angle, family: a.font?.family, bold: a.font?.bold, italic: a.font?.italic, runs: a.runs, fontColor: a.font?.color || [0, 0, 0], align: a.quadding ?? 0, bw: a.bw ?? 0, fill: a.color ? css(a.color) : null, isNew, auto: a.autoWidth ?? undefined, typewriter: a.kind === 'typewriter', callout: a.callout?.[0] }); }, 0);
  }
  /**
   * Finish typing. keep: the box stays even if nothing was typed (the person grabbed its frame
   * to move or resize it - before, an empty new box simply vanished then).
   */
  async function commitEditor(e: Editor, cancel = false, keep = false) {
    // once per box: a blur that comes after Escape / a click elsewhere / the tab going away
    // finds nothing open any more
    if (!editorNow.current) return;
    // (the text and its styles as they are in the box this moment - the last keys may not have
    // reached the state yet)
    if (e.kind === 'free') { const live = richApi.current?.model(); if (live) e = { ...e, value: live.text, runs: live.runs }; }
    editorNow.current = null;
    setEditor(null);
    try { await commitEditorNow(e, cancel, keep); }
    // shown in the page picture again once it is drawn with the new text
    finally { setEditHide((h) => (h && h.id === e.id ? null : h)); }
  }
  async function commitEditorNow(e: Editor, cancel: boolean, keep: boolean) {
    if (cancel) {
      // an empty new text box that was never typed in goes away
      if (e.kind === 'free' && e.id != null && !e.value.trim() && !keep) {
        try {
          const a = (await doc.annots(e.page)).find((x) => x.id === e.id);
          if (a && !a.contents) await doc.remove([{ page: e.page, id: e.id }]);
        } catch { /* gone already */ }
      }
      return;
    }
    try {
      if (e.kind === 'free' && e.id != null) {
        const a = (await doc.annots(e.page)).find((x) => x.id === e.id);
        if (!e.value.trim() && !keep) await doc.remove([{ page: e.page, id: e.id }]);
        else if (a) {
          // (styles only counted as changed when they really are: what is all one style is the box's own)
          const base = { family: a.font?.family || 'Helv', size: a.font?.size || 11, color: a.font?.color || [0, 0, 0], bold: !!a.font?.bold, italic: !!a.font?.italic };
          const st = settle(base, e.runs);
          const key = (r?: TextRun[]) => JSON.stringify(r ? cleanRuns(r) : null);
          const restyled = key(st.runs) !== key(a.runs) || JSON.stringify(st.base) !== JSON.stringify(base);
          if (e.value !== (a.contents || '') || restyled) await doc.update([{ page: e.page, id: e.id, patch: { contents: e.value, runs: e.runs ?? null } }], 'Edit text');
        }
      } else if (e.kind === 'field' && e.id != null) {
        // only a changed value: clicking into a field and out again made an undo step, marked
        // the file changed and redrew the field's own look (its font, size, colour)
        const a = (await doc.annots(e.page)).find((x) => x.id === e.id);
        if (a?.field && (a.field.value || '') === e.value) return;
        await doc.setField(e.page, e.id, e.value);
      } else if (e.kind === 'line' && e.line) {
        if (e.value === (blocks[e.page] || []).find((l) => l.bbox === e.line!.bbox)?.text) return;
        const l = e.line;
        // characters beyond Western European need a real font: Windows' own Arial / Times / Consolas
        let fontBytes: Uint8Array | undefined;
        if (/[^\u0000-\u00ff\u20ac\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u2122]/.test(e.value)) {
          const f = l.mono ? 'consola.ttf' : l.serif ? (l.bold ? 'timesbd.ttf' : 'times.ttf') : l.bold ? 'arialbd.ttf' : 'arial.ttf';
          fontBytes = (await gcc.systemFont(f)) || (await gcc.systemFont('arial.ttf')) || undefined;
        }
        await doc.replaceText(e.page, [l.bbox], e.value, l.origin, { size: l.size, color: l.color, bold: l.bold, italic: l.italic, family: l.mono ? 'mono' : l.serif ? 'serif' : 'sans' }, l.dir, fontBytes);
      }
    } catch (err) {
      P.current.onEvent({ type: 'error', text: String((err as Error).message || err) });
    }
  }

  // typing still going when the file's tab goes away (another tab, closing, saving): the text is
  // put in first - into this file
  const commitRef = useRef(commitEditor);
  commitRef.current = commitEditor;
  useEffect(() => {
    // (and pencil strokes not yet made into their markup: Ctrl+S straight after a stroke saved without it)
    const finish = async () => { const e = editorNow.current; if (e) await commitRef.current(e, false, true); await flushInkRef.current(); };
    doc.finishEditing = finish;
    // Undo clicked (title bar / ribbon) while typing. In a box just made: the box goes - its making
    // and its own steps since (style, size) are undone; what was typed with it. It was made empty
    // and its text came in a later step, so Undo took back only the text and left an empty,
    // invisible box in the file. In any other box: the text typed is put in first, then the Undo
    // takes it back (as Ctrl+Z after typing).
    const undoTyping = async (): Promise<boolean> => {
      // a shape being drawn: Undo takes back its last point (or brings back one just cancelled)
      if (pointKeys.current.undoPoint()) return true;
      const e = editorNow.current;
      if (!e) return false;
      if (e.kind !== 'free' || !e.isNew || e.id == null) { await commitRef.current(e, false, true); return false; }
      editorNow.current = null;
      setEditor(null);
      try {
        for (let i = 0; i < 20 && doc.canUndo; i++) {
          if (!(await doc.annots(e.page)).some((x) => x.id === e.id)) break;
          await doc.undo();
        }
      } finally { setEditHide((h) => (h && h.id === e.id ? null : h)); }
      return true;
    };
    doc.undoTyping = undoTyping;
    const redoTyping = async (): Promise<boolean> => pointKeys.current.redoPoint();
    doc.redoTyping = redoTyping;
    return () => {
      if (doc.redoTyping === redoTyping) doc.redoTyping = undefined;
      if (doc.finishEditing === finish) doc.finishEditing = undefined;
      if (doc.undoTyping === undoTyping) doc.undoTyping = undefined;
      void finish();
    };
  }, []);

  // ---------------------------------------------------------------- copy / paste markups

  const copyable = async (): Promise<SelItem[]> => {
    const sel = P.current.sel, out: SelItem[] = [];
    for (const s of sel) {
      // (a page out of view - a selection made in the Comments panel - is read: its markups were left out)
      const list = annotsNow.current[s.page] ?? (await doc.annots(s.page).catch(() => [] as AnnotData[]));
      const a = list.find((x) => x.id === s.id);
      if (a && a.type !== 'Widget' && a.irt == null) out.push(s);
    }
    return out;
  };
  /** a page's markups by id (looked up per selected markup: a search of the page's list each
   *  time was selection x markups on every pointer move of a big selection) */
  const byId = (page: number) => new Map((annotsNow.current[page] || []).map((a) => [a.id, a] as const));
  const boxOfItems = (items: SelItem[]): Rect => {
    const maps = new Map<number, Map<number, AnnotData>>();
    const bs: Rect[] = [];
    for (const s of items) {
      let m = maps.get(s.page);
      if (!m) maps.set(s.page, (m = byId(s.page)));
      const a = m.get(s.id);
      if (a) bs.push(a.box || geomBox(a));
    }
    return bs.length ? [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))] : [0, 0, 0, 0];
  };
  /** the box of the markups being moved, worked out once per drag (not on every pointer move) */
  const moveBox = useRef<{ items: SelItem[]; box: Rect } | null>(null);
  async function copyMarkups(cut: boolean) {
    const items = await copyable();
    if (!items.length) return;
    const box = boxOfItems(items);
    const auto = autoOf(items);
    if (!cut) {
      markClip.cur = { docId: doc.id, src: doc.id, items, page: items[0].page, box, n: 0, auto };
      P.current.onEvent({ type: 'status', text: `${items.length} markup${items.length > 1 ? 's' : ''} copied – Ctrl+V to paste (here or in another file).` });
    } else {
      // copies are kept aside first: pasting reads from them, the originals are deleted now
      // (the first paste on the same page puts them back where they were)
      let kept: { docId: string; items: SelItem[] };
      try { kept = await doc.clipStore(items); } catch (err) { P.current.onEvent({ type: 'error', text: String((err as Error).message || err) }); return; }
      // (kept a page at a time, in page order)
      const order = items.map((_, i) => i).sort((i, j) => items[i].page - items[j].page || i - j);
      markClip.cur = { docId: kept.docId, src: doc.id, items: kept.items, page: items[0].page, box, n: -1, auto: kept.items.length === items.length ? order.map((i) => auto[i]) : undefined };
      const n = await doc.remove(items).catch(() => 0);
      P.current.setSel([]);
      P.current.onEvent({ type: 'status', text: n < items.length ? 'Cut – locked markups stay where they are.' : `${items.length} markup${items.length > 1 ? 's' : ''} cut – Ctrl+V to paste.` });
    }
  }
  /** a measurement's label was its number where it is now (marked so, or - older ones - equal to it) */
  const labelWasAuto = (a: AnnotData) => { const q = ptsOf(a); return isAutoLabel(a, q.length ? doc.scaleAt(a.page, q[0][0], q[0][1]) : null); };
  /** for markups of this file about to be copied or moved: whose labels are their numbers */
  const autoOf = (items: SelItem[]): boolean[] => items.map((s) => { const a = byId(s.page).get(s.id); return !!a && labelWasAuto(a); });
  /** moved (drag, arrow keys): measurements show the number for where they now are (in or out of
   *  a viewport: they kept the old one) - one Undo step */
  async function moveAndRelabel(items: SelItem[], dx: number, dy: number) {
    const auto = autoOf(items);
    const moved = await doc.move(items, dx, dy);
    if (moved.length === items.length) await relabel(doc, moved, auto).catch(() => {});
  }
  async function pasteInto(from: string, items: SelItem[], page: number, dx: number, dy: number, auto?: boolean[]) {
    try {
      const out = await doc.paste(from, items, page, dx, dy);
      // measurements: the number for this page / file / scale; count marks: the next numbers
      await relabel(doc, out, out.length === items.length ? auto : undefined, true).catch(() => {});
      P.current.setSel(out.map((a) => ({ page, id: a.id })));
    } catch (err) {
      const m = String((err as Error).message || err);
      P.current.onEvent({ type: 'error', text: /no longer exists|not open|unknown/i.test(m) ? 'The copied markups are gone (deleted, or their file was closed).' : m });
    }
  }
  async function pasteMarkups(at?: { page: number; p: Pt }) {
    const c = markClip.cur;
    if (!c) { P.current.onEvent({ type: 'status', text: 'Nothing copied yet: select markups and press Ctrl+C.' }); return; }
    const page = at ? at.page : curPage();
    let dx = 0, dy = 0;
    if (at) { dx = at.p[0] - c.box[0]; dy = at.p[1] - c.box[1]; }
    else {
      // each Ctrl+V lands 12 pt further on, on any page of any file: the first one on another page
      // where they were, the first one back on their own page (cut) where they were, a copy
      // there 12 pt off. (Only their own page stepped: elsewhere every copy landed on the last.)
      const own = c.src === doc.id && page === c.page;
      const key = doc.id + '|' + page;
      const steps = (c.steps ??= {});
      const n = (steps[key] ?? (own ? c.n : -1)) + 1;
      steps[key] = n;
      if (own) c.n = n;
      dx = dy = 12 * n;
    }
    // all of it on the page
    const pg = pages[page];
    // (also from a bigger page - an A3 sheet's markups pasted on A4 landed off the page)
    if (pg) {
      const fit = (d: number, lo: number, hi: number) => (lo > hi ? lo : Math.max(lo, Math.min(hi, d)));
      dx = fit(dx, -c.box[0], pg.w - c.box[2]);
      dy = fit(dy, -c.box[1], pg.h - c.box[3]);
    }
    await pasteInto(c.docId, c.items, page, dx, dy, c.auto);
  }
  async function duplicate() {
    const items = await copyable();
    if (!items.length) return;
    const onPages = [...new Set(items.map((s) => s.page))];
    const auto = autoOf(items);
    if (onPages.length === 1) { await pasteInto(doc.id, items, items[0].page, 12, 12, auto); return; }
    // a selection over several pages (Comments panel, Ctrl+click): each copy on its own markup's
    // page, one undo step - all went onto the first page, at the other pages' positions
    try {
      const groups = onPages.map((pg) => ({ items: items.filter((s) => s.page === pg), targets: [{ page: pg, dx: 12, dy: 12 }] }));
      const out = await doc.copyToPages(groups);
      const was = groups.flatMap((g) => g.items.map((s) => auto[items.indexOf(s)]));
      await relabel(doc, out, out.length === was.length ? was : undefined, true).catch(() => {});
      P.current.setSel(out.map((a) => ({ page: a.page, id: a.id })));
    } catch (err) { P.current.onEvent({ type: 'error', text: String((err as Error).message || err) }); }
  }

  // ---------------------------------------------------------------- selection helpers

  // (the text box being typed in: its live size, so its frame and handles follow the typing)
  const live = (a: AnnotData): AnnotData => (edBox && editor?.kind === 'free' && editor.id === a.id && editor.page === a.page && !a.angle ? { ...a, rect: edBox } : a);
  const selected = (page: number): AnnotData[] => {
    const mine = P.current.sel.filter((s) => s.page === page);
    if (!mine.length) return [];
    const m = byId(page);
    return mine.map((s) => m.get(s.id)).filter((a): a is AnnotData => !!a).map(live);
  };
  /** on the frame / handles of the text box being typed in (not in its text) */
  const onFrame = (ed: Editor, p: Pt): boolean => {
    const a = (annotsNow.current[ed.page] || []).find((x) => x.id === ed.id);
    if (a?.callout?.length && dist(p, a.callout[0]) < 8 / zRef.current) return true;
    const b = edBox && ed.kind === 'free' ? edBox : ed.rect, k = (HPAD + 9) / zRef.current;
    const c: Pt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const q = ed.angle ? rot(p, c, -ed.angle) : p;
    if (ed.angle && a && ROTATABLE.has(a.type)) { const h = handlesOf(a); if (dist(p, rotHandle(h.corners)) < 9 / zRef.current) return true; }
    return q[0] >= b[0] - k && q[0] <= b[2] + k && q[1] >= b[1] - k - 26 / zRef.current && q[1] <= b[3] + k;
  };

  const handlesOf = (a: AnnotData, pad = true): { box: Rect; angle: number; corners: Pt[] } => {
    const box = a.box || geomBox(a);
    const angle = a.angle || 0;
    const c: Pt = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    const k = pad ? HPAD / zRef.current : 0;
    const corners = ([[box[0] - k, box[1] - k], [box[2] + k, box[1] - k], [box[2] + k, box[3] + k], [box[0] - k, box[3] + k]] as Pt[]).map((p) => rot(p, c, angle));
    return { box, angle, corners };
  };
  /** 8 resize handles: 0..3 corners (tl, tr, br, bl), 4..7 edges (t, r, b, l) */
  const handlePts = (corners: Pt[]): Pt[] => [
    ...corners,
    [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2],
    [(corners[1][0] + corners[2][0]) / 2, (corners[1][1] + corners[2][1]) / 2],
    [(corners[2][0] + corners[3][0]) / 2, (corners[2][1] + corners[3][1]) / 2],
    [(corners[3][0] + corners[0][0]) / 2, (corners[3][1] + corners[0][1]) / 2],
  ];
  const canResize = (a: AnnotData) => !a.locked && !NO_MOVE.has(a.type, a) && a.type !== 'Text' && !(a.vertices || a.line);
  const rotHandle = (corners: Pt[]): Pt => {
    const mid: Pt = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
    const c: Pt = [(corners[0][0] + corners[2][0]) / 2, (corners[0][1] + corners[2][1]) / 2];
    const l = dist(mid, c) || 1;
    const k = 22 / zRef.current;
    return [mid[0] + ((mid[0] - c[0]) / l) * k, mid[1] + ((mid[1] - c[1]) / l) * k];
  };

  /** start a drag preview: the selected markups are hidden from the markup layer and shown as pictures */
  const ghostGen = useRef(0);
  async function startGhosts(page: number, ids: number[]) {
    // a big selection moves as outlines, the markups staying drawn where they are until let go:
    // a picture each was one engine drawing + one picture encoding per markup, one after the
    // other (seconds for a few hundred), with the window busy meanwhile
    if (ids.length > GHOSTS_MAX) return;
    const gen = ghostGen.current;
    const S = Math.min(4, zRef.current * dpr);
    const out: typeof ghosts = {};
    for (const id of ids) {
      try {
        const r = await (await import('./engines')).editor.call<{ bmp: ImageBitmap; x: number; y: number; w: number; h: number } | null>('annotImage', [doc.id, page, id, S]);
        if (!r) continue;
        const c = document.createElement('canvas');
        c.width = r.w; c.height = r.h;
        c.getContext('2d')!.drawImage(r.bmp, 0, 0);
        r.bmp.close?.();
        out[id] = { url: c.toDataURL(), x: r.x, y: r.y, w: r.w, h: r.h, S };
      } catch { /* skip */ }
    }
    if (gen === ghostGen.current) setGhosts(out);
  }

  // ---------------------------------------------------------------- pointer handling

  const onPointerDown = async (e: React.PointerEvent) => {
    // in the text being typed: the text box handles it (caret, selecting text with the mouse)
    if ((e.target as HTMLElement).closest?.('.ed, .edbar, .edpop, .drawbar')) return;
    btnDown.current = true;
    pendingLink.current = null;
    if (editor) { blurByViewer.current = true; window.setTimeout(() => { blurByViewer.current = false; }, 300); }
    const el = scroller.current!;
    // clicking the page takes the keyboard back from a box elsewhere (the comment box in the
    // right panel kept it: Delete / Ctrl+C / arrows then went into that box)
    if (!editor && document.activeElement !== el && document.activeElement instanceof HTMLElement && !el.contains(document.activeElement)) { document.activeElement.blur(); el.focus({ preventScroll: true }); }
    const at = toPage(e.clientX, e.clientY);
    let forceSelect = false;
    let ownId = -1;
    if (editor) {
      // on the frame of the box being typed in: finish the text but keep the box, and go on
      // to move / resize it; anywhere else: just finish typing
      const ed = editor;
      const own = ed.kind === 'free' && ed.id != null && at && at.page === ed.page && onFrame(ed, at.p);
      // (not waited for: the drag must start now, or a quick flick of the mouse is missed)
      void commitEditor(ed, false, !!own);
      // a right-click or a pan (middle button, Space, hand tool) goes on to do that too - it only
      // finished the typing, and had to be done again
      const passOn = e.button === 2 || e.button === 1 || space || props.tool === 'hand';
      if (!own && !passOn) return;
      if (own) { forceSelect = true; ownId = ed.id!; }
    }
    // middle button / space / hand tool: pan
    if (e.button === 1 || space || props.tool === 'hand') {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      setDrag({ mode: 'pan', x: e.clientX, y: e.clientY, sx: el.scrollLeft, sy: el.scrollTop });
      // hand tool still follows links (on a click, not a pan that starts on one)
      if (props.tool === 'hand' && at && e.button === 0 && linkAt(at.page, at.p)) pendingLink.current = { page: at.page, p: at.p, x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button === 2) {
      if (draft && draft.kind === 'poly') { e.preventDefault(); void finishDraft(draft); return; }
      if (at) {
        const hit = hitList(annots[at.page] || [], at.p, 6 / z);
        if (hit && !props.sel.some((s) => s.id === hit.id)) props.setSel([{ page: at.page, id: hit.id }]);
        props.onEvent({ type: 'menu', x: e.clientX, y: e.clientY, page: at.page, at: at.p, text: textSel ? await selectedText() : null });
      }
      return;
    }
    // a click outside the area marked with the Snapshot tool unmarks it (as a selection goes);
    // a click inside keeps it
    const mk = P.current.marked;
    if (e.button === 0 && mk && !(at && at.page === mk.page && at.p[0] >= mk.rect[0] && at.p[0] <= mk.rect[2] && at.p[1] >= mk.rect[1] && at.p[1] <= mk.rect[3])) P.current.onEvent({ type: 'unmark' });
    if (e.button !== 0 || !at) return;
    const { page } = at;
    let p = at.p;
    if (p[0] < -20 / z || p[1] < -20 / z || p[0] > pages[page].w + 20 / z || p[1] > pages[page].h + 20 / z) { props.setSel([]); setTextSel(null); return; }
    const tool = forceSelect ? 'select' : props.tool;
    const g = gestureOf(tool);
    // (a point clicked: a length typed and not used is dropped - Enter afterwards finishes the
    // shape, it doesn't add a point 3 m along)
    if (typedNow.current) { setTyped(''); typedNow.current = ''; }
    const now = performance.now();
    const dbl = now - lastClick.current.t < 400 && Math.abs(e.clientX - lastClick.current.x) < 6 && Math.abs(e.clientY - lastClick.current.y) < 6;
    lastClick.current = { t: dbl ? 0 : now, x: e.clientX, y: e.clientY };
    el.setPointerCapture(e.pointerId);
    // Ctrl held: this click does not snap - also when the mouse has not moved since Ctrl went
    // down (the snap the pointer found before was used anyway)
    if (TOOLS[tool].snaps) { if (e.ctrlKey) { snapRef.current = null; setSnapMark(null); } else p = snapped(page, p); }

    if (tool === 'select') {
      // handles of the selection first
      for (const a of selected(page)) {
        // grab area = the handle square itself (+1 px), so grabbing the outline moves instead
        const t = 5.5 / z;
        if (a.locked) continue;
        if (edge && edge.id === a.id) {
          const w = edgeAt(page, p);
          if (w) { setTextSel(null); setDrag({ mode: 'textedge', page, id: a.id, fixed: w === 's' ? edge.b : edge.a, cur: w === 's' ? edge.a : edge.b }); return; }
        }
        if (a.line && !a.callout) { for (let i = 0; i < 2; i++) if (dist(p, a.line[i]) < t) { setDrag({ mode: 'vertex', page, id: a.id, index: i, cur: p, which: 'l', start: p }); void startGhosts(page, [a.id]); return; } }
        if (a.vertices && circular(a)) { if (dist(p, a.vertices[0]) < t) { setDrag({ mode: 'vertex', page, id: a.id, index: 0, cur: p, which: 'r' }); void startGhosts(page, [a.id]); return; } }
        else if (a.vertices) {
          for (let i = 0; i < a.vertices.length; i++) if (dist(p, a.vertices[i]) < t) { setDrag({ mode: 'vertex', page, id: a.id, index: i, cur: p, which: 'v', free: e.altKey, start: p, alt: e.altKey }); void startGhosts(page, [a.id]); return; }
          // an edge's middle dot: dragged, a new corner there
          const m = midDots(a).find((x) => dist(p, x.p) < t);
          if (m) { setDrag({ mode: 'vertex', page, id: a.id, index: m.at, cur: p, which: 'v', start: p, ins: true }); void startGhosts(page, [a.id]); return; }
        }
        if (a.callout?.length && dist(p, a.callout[0]) < t) { setDrag({ mode: 'vertex', page, id: a.id, index: 0, cur: p, which: 'c' }); void startGhosts(page, [a.id]); return; }
        if (canResize(a) && P.current.sel.length === 1) {
          const h = handlesOf(a);
          if (ROTATABLE.has(a.type) && !a.callout && dist(p, rotHandle(h.corners)) < t * 1.2) {
            const c: Pt = [(h.box[0] + h.box[2]) / 2, (h.box[1] + h.box[3]) / 2];
            const ang = (Math.atan2(p[1] - c[1], p[0] - c[0]) * 180) / Math.PI;
            setDrag({ mode: 'rotate', page, id: a.id, centre: c, angle0: h.angle, start: ang, cur: ang });
            void startGhosts(page, [a.id]);
            return;
          }
          const hp = handlePts(h.corners);
          for (let i = 0; i < 8; i++) if (dist(p, hp[i]) < t) { setDrag({ mode: 'resize', page, id: a.id, handle: i, start: p, cur: p, box: h.box, angle: h.angle, keep: a.type === 'Stamp' }); if (a.type === 'Stamp') P.current.onEvent({ type: 'status', text: a.designed ? 'A text stamp keeps its proportions.' : 'Keeps its proportions – hold Shift to stretch it.' }); void startGhosts(page, [a.id]); return; }
        }
      }
      // grabbed the frame of the box that was being typed in: move it
      if (ownId >= 0) { setDrag({ mode: 'move', page, start: p, cur: p, items: [{ page, id: ownId }], moved: false }); return; }
      // a link (with no markup over it): followed when the button comes up, if the mouse did not
      // move - a drag that starts on linked text selects it
      const hit = hitList(annotsNow.current[page] || [], p, 5 / z);
      if (!hit && linkAt(page, p)) pendingLink.current = { page, p, x: e.clientX, y: e.clientY };
      if (hit) {
        if (hit.type === 'Widget' && hit.field) { openField(hit); return; }
        if (dbl && (hit.type === 'Text' || hit.kind?.startsWith('measure') || hit.type === 'Stamp')) { props.onEvent({ type: 'comment', page, id: hit.id }); return; }
        let s = P.current.sel;
        if (e.shiftKey || e.ctrlKey) s = s.some((x) => x.id === hit.id) ? s.filter((x) => x.id !== hit.id) : [...s, { page, id: hit.id }];
        else if (!s.some((x) => x.id === hit.id)) s = [{ page, id: hit.id }];
        props.setSel(s);
        setTextSel(null);
        const items = s.filter((x) => x.page === page);
        const movable = items.filter((x) => { const a = (annotsNow.current[page] || []).find((y) => y.id === x.id); return a && !a.locked && !NO_MOVE.has(a.type, a); });
        // double-click on a text box: type in it - unless the mouse moves, then it is a move
        const edit = dbl && hit.type === 'FreeText' && !hit.locked ? hit : undefined;
        if (movable.length) setDrag({ mode: 'move', page, start: p, cur: p, items: movable, moved: false, edit });
        else if (edit) openFreeEditor(edit);
        return;
      }
      // text under the pointer: select text
      const c = await charsOf(page);
      const ci = charAt(c, p, 1.5);
      if (ci >= 0) {
        props.setSel([]);
        // (the page's text can take a moment on a dense sheet: a click already over by then
        // starts no selection drag - it would follow the mouse with no button held)
        if (!dbl && !btnDown.current) { setTextSel(null); return; }
        if (dbl) {
          // word (letters of any script, with their marks - \w stopped at é, Greek, Cyrillic, Arabic)
          let a = ci, b = ci;
          while (a > 0 && WORD_CH.test(c.text[a - 1])) a--;
          while (b < c.text.length - 1 && WORD_CH.test(c.text[b + 1])) b++;
          setTextSel({ page, a, b });
          return;
        }
        setTextSel({ page, a: ci, b: ci });
        setDrag({ mode: 'text', page, a: ci, b: ci });
        return;
      }
      setTextSel(null);
      if (!e.shiftKey) props.setSel([]);
      // (as above: a click over before the page's text came starts no band that follows the
      // mouse with no button held)
      if (!btnDown.current) return;
      setDrag({ mode: 'band', page, a: p, b: p });
      return;
    }

    /** the point in the coordinates of the page a shape was started on: its second click may land
     *  on another page (that page's point was used as it was - the line jumped by a page and hung
     *  off the sheet); kept at that page's edge, as the shape shows while the mouse moves there */
    const onDraftPage = (dp: number): Pt => {
      const o = dp === page ? null : toPage(e.clientX, e.clientY, dp);
      const pg = pages[dp];
      if (!o || !pg) return p;
      const q = TOOLS[tool].snaps && !e.ctrlKey ? snapped(dp, o.p) : o.p;
      return [clamp(q[0], 0, pg.w), clamp(q[1], 0, pg.h)];
    };
    switch (g) {
      case 'text': {
        const c = await charsOf(page);
        if (!btnDown.current) return; // (see above: the click was over before the text came)
        const ci = charAt(c, p, 1.5);
        if (ci >= 0) { setTextSel({ page, a: ci, b: ci }); setDrag({ mode: 'text', page, a: ci, b: ci }); }
        else if (tool === 'highlight' || tool === 'redact-text') setDraft({ kind: 'rect', page, a: p, b: p });
        return;
      }
      case 'rect': setDraft({ kind: 'rect', page, a: p, b: p }); return;
      case 'two':
        if (draft && draft.kind === 'two' && draft.clicked) { const q = onDraftPage(draft.page); const d = { ...draft, b: twoEnd(draft.a, q, e.shiftKey, draft.page, straight(e, draft.page, q)) }; void finishDraft(d); return; }
        setDraft({ kind: 'two', page, a: p, b: p, clicked: false });
        return;
      case 'poly': {
        if (draft && draft.kind === 'poly' && draft.page === page) {
          const last = draft.pts[draft.pts.length - 1];
          const q = straight(e, page, p) ? ortho(last, p) : p;
          // double-click or click on the start point: finish
          if (dbl || (draft.pts.length > 2 && dist(q, draft.pts[0]) < 6 / z)) { void finishDraft(draft); return; }
          const pts = [...draft.pts, q];
          if (tool === 'm-angle' && pts.length === 3) { void finishDraft({ ...draft, pts }); return; }
          setDraft({ ...draft, pts, cur: q });
          return;
        }
        setDraft({ kind: 'poly', page, pts: [p], cur: p });
        return;
      }
      case 'ink':
        // a stroke on another page: the strokes so far become their markup first
        if (draft && draft.kind === 'ink' && draft.page !== page) void finishDraft(draft);
        setDraft(draft && draft.kind === 'ink' && draft.page === page ? { ...draft, strokes: [...draft.strokes, [p]] } : { kind: 'ink', page, strokes: [[p]], spec: common() });
        return;
      case 'callout':
        if (draft && draft.kind === 'callout') { const q = onDraftPage(draft.page); const kk = sheetK(draft.page); setDraft({ ...draft, box: autoBox(q, kk, st().fontSize, st().width), cur: q, sized: false }); return; }
        setDraft({ kind: 'callout', page, tip: p, cur: p });
        return;
      case 'click': {
        if (tool === 'note') {
          const a = await create(page, { type: 'Text', rect: [p[0], p[1], p[0] + 20, p[1] + 20], icon: 'Comment', color: st().color, opacity: st().opacity, contents: '' });
          if (a) props.onEvent({ type: 'comment', page, id: a.id });
          return;
        }
        if (tool === 'typewriter') {
          const s = st();
          const kk = sheetK(page);
          const a = await create(page, { type: 'FreeText', rect: [p[0], p[1] - s.fontSize * kk * 0.2, p[0] + s.fontSize * kk * 2, p[1] + s.fontSize * kk * 1.1], contents: '', color: null, bw: 0, opacity: s.opacity, font: { size: s.fontSize, color: s.fontColor, family: s.fontFamily, bold: s.bold, italic: s.italic }, kind: 'typewriter', autoWidth: autoLimit(page, p[0], kk, true) });
          if (a) openFreeEditor(a, true);
          return;
        }
        if (tool === 'm-count') {
          // one after another: quick clicks each wait for the one before (or they all read the
          // same count and every mark said #1)
          const grp = props.countGroup || 'Count';
          const r = 5 * sheetK(page);
          const color = st().color, fill = st().fill || st().color, opacity = st().opacity, dash = st().dash;
          const job = countChain.current.then(async () => {
            // the number: counted from every markup in the file - unless nothing but this tool's
            // own last mark changed the file since (each mark made the next click read every
            // markup of a long file again: rapid counting crawled)
            const last = countMemo.current;
            // (after the highest number there, not the number of marks: with #2 deleted, the next was a second #3)
            const n = last && last.doc === doc.id && last.grp === grp && last.changes === doc.changeCount ? last.n + 1
              : (countNumbers(await doc.allAnnots()).get(grp) || 0) + 1;
            const made = await create(page, { type: 'Circle', rect: [p[0] - r, p[1] - r, p[0] + r, p[1] + r], color, ic: fill, bw: 1, opacity, dash, kind: 'measure-count', group: grp, contents: grp + ' #' + n, subject: 'Count' }, false);
            if (made) countMade.current.push({ page, id: made.id });
            countMemo.current = made ? { doc: doc.id, grp, n, changes: doc.changeCount } : null;
            P.current.onEvent({ type: 'status', text: `${grp} #${n}` });
          });
          countChain.current = job.catch(() => {});
          await job;
          return;
        }
        if (tool === 'edit-text') {
          const l = (blocks[page] || []).find((x) => inRect(p, x.bbox, 1));
          if (l) window.setTimeout(() => setEditor({ page, kind: 'line', rect: l.bbox, value: l.text, size: l.size, color: css(l.color), line: l }), 0);
          return;
        }
        return;
      }
    }
  };

  const linkAt = (page: number, p: Pt) => (links[page] || []).find((x) => inRect(p, x.rect as Rect));
  function followLink(page: number, p: Pt, e: { ctrlKey: boolean }) {
    const l = linkAt(page, p);
    if (!l) return false;
    if (l.page != null && l.page >= 0) { props.apiRef.current?.goTo(l.page); return true; }
    if (l.url) {
      // only web and e-mail links: a link in someone else's PDF must not start a program, open a
      // network share or a Windows handler (file:, \\server\..., ms-..., search-ms:...)
      if (!/^(https?:\/\/|mailto:)/i.test(l.url.trim())) { props.onEvent({ type: 'note', text: 'This link was not opened: it points to ' + l.url.slice(0, 120) + ' – only web and e-mail links are opened (a link in a PDF must not start a program or open a file).' }); return true; }
      // (always asked: a link's words can say one thing and go somewhere else - the real address
      // and its site are shown)
      const u = l.url.trim();
      const mail = /^mailto:/i.test(u);
      let site = '';
      try { site = mail ? u.slice(7).split('?')[0] : new URL(u).hostname; } catch { site = u; }
      void gcc.confirm({
        message: mail ? `Write an e-mail to ${site}?` : `Open this link? It goes to ${site}`,
        detail: `${u}\n\n${mail ? 'Your e-mail program opens with this address.' : 'It opens in your web browser.'} Links in a PDF can lead anywhere – go on only if you trust the file and this address.`,
        buttons: [mail ? 'Write e-mail' : 'Open link', 'Cancel'],
        type: 'warning',
      }).then((r) => { if (r === 0) void gcc.openLink(u); });
      return true;
    }
    void e;
    return false;
  }

  function openField(a: AnnotData) {
    const f = a.field!;
    if (f.readOnly) return;
    if (f.ftype === 'checkbox' || f.ftype === 'radiobutton') { void doc.setField(a.page, a.id, !f.checked).catch((er) => props.onEvent({ type: 'error', text: String(er.message || er) })); return; }
    if (f.ftype === 'button' || f.ftype === 'signature') return;
    window.setTimeout(() => setEditor({ page: a.page, kind: 'field', rect: a.rect, value: f.value || '', id: a.id, size: Math.max(8, Math.min(14, (a.rect[3] - a.rect[1]) * 0.65)), color: '#000', options: f.options, multiline: f.multiline, maxLen: f.maxLen }), 0);
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const el = scroller.current!;
    if (drag?.mode === 'pan') { el.scrollLeft = drag.sx - (e.clientX - drag.x); el.scrollTop = drag.sy - (e.clientY - drag.y); return; }
    const force = drag && 'page' in drag ? drag.page : draft ? draft.page : undefined;
    const at = toPage(e.clientX, e.clientY, force);
    if (!at) return;
    const { page } = at;
    let p = at.p;
    const tool = props.tool;
    if (TOOLS[tool].snaps || drag?.mode === 'vertex') { doSnap(page, p, e); p = snapped(page, p); } else if (snapMark) setSnapMark(null);
    {
      // (the loupe looks at the point a click would put down: snapped, and straightened while drawing;
      // kept with the aids off too - turned on, they open where the pointer is)
      const last = draft && draft.page === page ? (draft.kind === 'poly' ? draft.pts[draft.pts.length - 1] : null) : null;
      const two = draft && draft.kind === 'two' && draft.page === page ? draft : null;
      aidAt.current = { cx: e.clientX, cy: e.clientY, page, p: last && straight(e, page, p) ? ortho(last, p) : two ? twoEnd(two.a, p, e.shiftKey, page, straight(e, page, p)) : p };
      if (P.current.crossOn || P.current.loupeOn) requestAnimationFrame(paintAids);
    }
    // markups stay on the page: points dragged past its edge stop at the edge (a callout's tip
    // could be pulled thousands of points off the sheet, where nobody would find it again)
    if ((drag && (drag.mode === 'vertex' || drag.mode === 'resize')) || draft) {
      const pg = pages[page];
      if (pg) p = [Math.max(0, Math.min(pg.w, p[0])), Math.max(0, Math.min(pg.h, p[1]))];
    }
    const r = scroller.current!.getBoundingClientRect();
    const tipAt = (text: string) => {
      const x = e.clientX - r.left + 16, y = e.clientY - r.top + 18;
      lastTip.current = { x, y };
      // (a length being typed: that is what the tip says until Enter)
      const t = typedNow.current && draft ? typedTip(typedNow.current) : text;
      setTip(t ? { x, y, text: t } : null);
    };

    if (drag) {
      switch (drag.mode) {
        case 'move': {
          const dd = dist(drag.start, p) * z;
          if (!drag.moved && dd < 3) return;
          if (!drag.moved) void startGhosts(page, drag.items.map((s) => s.id));
          let q = e.shiftKey ? ortho(drag.start, p) : p;
          // the moved markups stay on the page
          const pg = pages[page];
          if (moveBox.current?.items !== drag.items) moveBox.current = { items: drag.items, box: boxOfItems(drag.items) };
          const B = moveBox.current.box;
          if (pg && B[2] > B[0]) {
            let dx = q[0] - drag.start[0], dy = q[1] - drag.start[1];
            dx = Math.max(Math.min(0, -B[0]), Math.min(Math.max(0, pg.w - B[2]), dx));
            dy = Math.max(Math.min(0, -B[1]), Math.min(Math.max(0, pg.h - B[3]), dy));
            q = [drag.start[0] + dx, drag.start[1] + dy];
          }
          setDrag({ ...drag, cur: q, moved: true });
          return;
        }
        case 'resize': setDrag({ ...drag, cur: p, free: e.shiftKey }); return;
        case 'vertex': {
          const a = (annots[page] || []).find((x) => x.id === drag.id);
          // Shift: the edge from the corner before goes straight (0 / 45 / 90°)
          const nb = !straight(e, page, p) || !a ? null : drag.which === 'l' && a.line ? a.line[1 - drag.index] : drag.which === 'v' && a.vertices ? (drag.ins ? a.vertices[drag.index - 1] : drag.index > 0 ? a.vertices[drag.index - 1] : a.type === 'Polygon' ? a.vertices[a.vertices.length - 1] : a.vertices[1]) : null;
          let q = nb ? ortho(nb, at.p) : p;
          const pg = pages[page];
          if (pg) q = [Math.max(0, Math.min(pg.w, q[0])), Math.max(0, Math.min(pg.h, q[1]))];
          const moved = drag.moved || !drag.start || dist(q, drag.start) * zRef.current > 2;
          setDrag({ ...drag, cur: q, free: e.altKey, moved });
          if (moved && a?.kind?.startsWith('measure-')) {
            const pts = vertexPts(a, drag.index, q, drag.which, e.altKey, drag.ins);
            tipAt(measureText(('m-' + a.kind.slice(8)) as ToolId, page, pts, a.fmt ?? LEGACY_FMT));
          }
          return;
        }
        case 'rotate': {
          let ang = (Math.atan2(p[1] - drag.centre[1], p[0] - drag.centre[0]) * 180) / Math.PI;
          if (e.shiftKey) ang = drag.start + Math.round((ang - drag.start + drag.angle0) / 15) * 15 - drag.angle0;
          setDrag({ ...drag, cur: ang });
          tipAt((((drag.angle0 + ang - drag.start) % 360 + 540) % 360 - 180).toFixed(0) + '°');
          return;
        }
        case 'band': setDrag({ ...drag, b: p }); return;
        case 'text':
        case 'textedge': {
          // the character under the pointer: straight from the page's text when it is loaded; an
          // answer for an older move that comes late is ignored (it put the end back to an old spot)
          const seq = ++moveSeq.current;
          const use = (c: { text: string; box: Float32Array }) => {
            if (seq !== moveSeq.current) return;
            const ci = nearestChar(c, p);
            if (ci < 0) return;
            if (drag.mode === 'text') { setTextSel({ page, a: drag.a, b: ci }); setDrag({ ...drag, b: ci }); }
            else if (ci !== drag.cur) setDrag({ ...drag, cur: ci });
          };
          const have = charsCache.current[doc.baseRev + ':' + page];
          if (have) use(have); else void charsOf(page).then(use);
          return;
        }
      }
    }
    if (draft) {
      switch (draft.kind) {
        case 'rect': {
          let b = p;
          if (e.shiftKey) { const s = Math.max(Math.abs(p[0] - draft.a[0]), Math.abs(p[1] - draft.a[1])); b = [draft.a[0] + Math.sign(p[0] - draft.a[0] || 1) * s, draft.a[1] + Math.sign(p[1] - draft.a[1] || 1) * s]; }
          setDraft({ ...draft, b });
          const rr = rectOf(draft.a, b);
          const sc = scaleFor(page, draft.a);
          if (tool === 'rect' || tool === 'ellipse' || tool === 'm-viewport' || tool === 'snapshot' || tool === 'table') tipAt(sc ? `${fmtLen(rr[2] - rr[0], sc, P.current.style.fmt)} × ${fmtLen((rr[3] - rr[1]) * yRatio(sc), sc, P.current.style.fmt)}` : '');
          return;
        }
        case 'two': {
          const b = twoEnd(draft.a, p, e.shiftKey, draft.page, straight(e, draft.page, p));
          setDraft({ ...draft, b, clicked: draft.clicked || (e.buttons === 0) });
          const how = howOf(tool);
          if (how === 'rect') {
            // (width × height = area - or the perimeter -, as the measurement will say)
            const sc = scaleFor(page, draft.a);
            const ar = measureText(kindOfTool(tool), page, rectCorners(draft.a, b));
            tipAt(sc ? `${fmtLen(Math.abs(b[0] - draft.a[0]), sc, P.current.style.fmt)} × ${fmtLen(Math.abs(b[1] - draft.a[1]) * yRatio(sc), sc, P.current.style.fmt)} = ${ar}` : ar);
          } else if (how === 'circle') {
            // (the radius - across, at the X scale - and what it measures)
            const sc = scaleFor(page, draft.a);
            const v = measureText(kindOfTool(tool), page, circleFrom(draft.a, b));
            tipAt(sc ? `r ${fmtLen(dist(draft.a, b), sc, P.current.style.fmt)} · ${v}` : v);
          } else if (tool.startsWith('m-')) tipAt(measureText(tool, page, [draft.a, b]) + (tool === 'm-length' || tool === 'm-calibrate' ? '  at ' + angleOf(draft.a, b) : ''));
          else { const sc = scaleFor(page, draft.a); if (sc) tipAt(fmtLen(realDist(draft.a, b, sc), sc, P.current.style.fmt)); }
          return;
        }
        case 'poly': {
          const last = draft.pts[draft.pts.length - 1];
          const cur = straight(e, page, p) ? ortho(last, p) : p;
          setDraft({ ...draft, cur });
          if (tool.startsWith('m-')) {
            // (continuing from a corner: the rest of the shape counts too)
            const pts = [...draft.pts, cur, ...(draft.cont?.tail ?? [])];
            const txt = measureText(tool, page, pts);
            tipAt(txt + (tool !== 'm-angle' ? '   (segment ' + fmtLen(realDist(last, cur, scaleFor(page, last)), scaleFor(page, last), P.current.style.fmt) + ' at ' + angleOf(last, cur) + ')' : ''));
          }
          return;
        }
        case 'ink':
          if (e.buttons & 1) { const s = draft.strokes.slice(); s[s.length - 1] = [...s[s.length - 1], p]; setDraft({ ...draft, strokes: s }); }
          return;
        case 'callout':
          setDraft({ ...draft, cur: p });
          // dragged out: a box of that size (it no longer fits itself to the text)
          if (draft.box && e.buttons & 1 && (draft.sized || dist(p, [draft.box[0], draft.box[1]]) * zRef.current > 8)) setDraft({ ...draft, cur: p, sized: true, box: rectOf([draft.box[0], draft.box[1]], [Math.max(p[0], draft.box[0] + 40), Math.max(p[1], draft.box[1] + 14)]) });
          return;
      }
    }
    // hover feedback: cursor
    const hovering = tool === 'select' ? hitList(annots[page] || [], p, 5 / z) : null;
    const hv = hovering && !editor && !props.sel.some((x) => x.id === hovering.id) ? { page, id: hovering.id } : null;
    if ((hv?.id ?? -1) !== (hover?.id ?? -1)) setHover(hv);
    const overLink = (tool === 'select' || tool === 'hand') && !hovering && (links[page] || []).some((x) => inRect(p, x.rect as Rect));
    el.dataset.cursor = space ? 'grab' : tool === 'hand' ? (overLink ? 'pointer' : 'grab') : overLink ? 'pointer' : hovering ? (hovering.type === 'Widget' ? 'text' : hovering.locked ? 'default' : NO_MOVE.has(hovering.type, hovering) ? 'pointer' : 'move') : tool === 'select' ? 'auto' : tool === 'edit-text' ? 'text' : 'crosshair';
    if (tool === 'select' && !space && edgeAt(page, p)) { el.dataset.cursor = 'col-resize'; return; }
    if (tool === 'select' && !hovering && !overLink) {
      // I-beam over text (cached chars only, no waiting)
      const c = charsCache.current[doc.baseRev + ':' + page];
      if (c && charAt(c, p, 1.5) >= 0) el.dataset.cursor = 'text';
      else if (!c) void charsOf(page);
    } else if (TOOLS[tool].gesture === 'text' && !space) {
      // highlight / underline...: an I-beam says "this marks the text"; off the text the
      // crosshair says "an area" (highlight, redaction) - the others do nothing there
      const c = charsCache.current[doc.baseRev + ':' + page];
      const cur = (cc: typeof c) => (cc && charAt(cc, p, 1.5) >= 0 ? 'text' : tool === 'highlight' || tool === 'redact-text' ? 'crosshair' : 'default');
      // (the page's text not read yet: the cursor is set again once it is, if the mouse is still there)
      if (!c) void charsOf(page).then((cc) => { if (P.current.tool === tool && lastHover.current === p) el.dataset.cursor = cur(cc); }).catch(() => {});
      el.dataset.cursor = cur(c);
    }
    lastHover.current = p;
    if (tip && !draft) setTip(null);
  };

  /** a direction as a drawing reads it: 0° across to the right, 90° straight up */
  const angleOf = (a: Pt, b: Pt) => { const d = (Math.atan2(a[1] - b[1], b[0] - a[0]) * 180) / Math.PI; return ((Math.round(d * 10) / 10 + 360) % 360).toFixed(1).replace(/\.0$/, '') + '°'; };
  const vertexPts = (a: AnnotData, index: number, p: Pt, which: 'v' | 'l' | 'c' | 'r', free = false, ins = false): Pt[] => {
    if (which === 'l' && a.line) { const l = a.line.slice() as Pt[]; l[index] = p; return l; }
    // a corner added at an edge's middle dot
    if (which === 'v' && ins && a.vertices) { const v = a.vertices.slice(); v.splice(index, 0, p); return v; }
    // a circle measurement: its size from its one handle (round its middle, the handle under the pointer)
    if (which === 'r' && a.vertices) { const ci = circleOf(a.vertices); return ci ? circlePts(ci.c, Math.max(1 / zRef.current, dist(ci.c, p)), a.vertices.length, Math.atan2(p[1] - ci.c[1], p[0] - ci.c[0])) : a.vertices; }
    // a rectangle measurement stays a rectangle (Alt: the corner alone)
    if (which === 'v' && a.vertices && !free && rectish(a)) return rectKeep(a.vertices, index, p);
    if (which === 'v' && a.vertices) { const v = a.vertices.slice(); v[index] = p; return v; }
    if (which === 'c' && a.callout) { const c = a.callout.slice(); c[index] = p; return c; }
    return [];
  };

  /** corners can be added (middle dots) and deleted: outlines and lines by corners - not a circle
   *  (its one handle), an angle (three points) or a pencil stroke */
  const cornersEditable = (a: AnnotData) => !!a.vertices && !a.locked && (a.type === 'Polygon' || a.type === 'PolyLine') && a.kind !== 'measure-angle' && !circular(a);
  /** the middle dot of each edge (at: where the new corner goes in the list) */
  const midDots = (a: AnnotData): { p: Pt; at: number }[] => {
    if (!cornersEditable(a)) return [];
    const v = a.vertices!, out: { p: Pt; at: number }[] = [];
    const n = a.type === 'Polygon' ? v.length : v.length - 1;
    for (let i = 0; i < n; i++) { const q = v[(i + 1) % v.length]; out.push({ p: [(v[i][0] + q[0]) / 2, (v[i][1] + q[1]) / 2], at: i + 1 }); }
    return out;
  };
  /** the fewest corners a shape keeps when one is deleted */
  const minCorners = (a: AnnotData) => (a.type === 'Polygon' ? 3 : 2);
  /** corners changed (dragged, added, deleted, a line continued): the number follows - a label
   *  typed by hand, a room's name, stays (it was replaced) - one Undo step */
  const setCorners = async (a: AnnotData, pts: Pt[], name: string, extra: Partial<AnnotSpec> = {}) => {
    const patch: Partial<AnnotSpec> = { vertices: pts, ...extra };
    if (a.kind?.startsWith('measure-') && a.kind !== 'measure-count' && (labelWasAuto(a) || !a.contents?.trim())) { patch.contents = measureText(('m-' + a.kind.slice(8)) as ToolId, a.page, pts, a.fmt ?? LEGACY_FMT); patch.autoLabel = true; }
    if (a.kind === 'measure-area' && selfCrosses(pts)) P.current.onEvent({ type: 'note', text: 'The sides of that area now cross each other: its number is the difference of the parts, not their sum.' });
    await doc.update([{ page: a.page, id: a.id, patch }], name);
  };
  const deleteCorner = async (page: number, id: number, index: number) => {
    const a = (annotsNow.current[page] || []).find((x) => x.id === id);
    if (!a || !cornersEditable(a) || !a.vertices![index]) return;
    if (a.vertices!.length <= minCorners(a)) { P.current.onEvent({ type: 'status', text: a.type === 'Polygon' ? 'An area keeps at least 3 corners.' : 'A line keeps at least 2 points.' }); return; }
    await setCorners(a, a.vertices!.filter((_, i) => i !== index), 'Delete corner');
  };
  /** a corner put in on the edge nearest to `at` (right-click > Add a corner here) */
  const addCorner = async (page: number, id: number, at: Pt) => {
    const a = (annotsNow.current[page] || []).find((x) => x.id === id);
    if (!a || !cornersEditable(a)) return;
    const v = a.vertices!, n = a.type === 'Polygon' ? v.length : v.length - 1;
    let best = -1, bd = Infinity, bp: Pt = at;
    for (let i = 0; i < n; i++) {
      const p0 = v[i], p1 = v[(i + 1) % v.length], dx = p1[0] - p0[0], dy = p1[1] - p0[1], L = dx * dx + dy * dy || 1;
      const tt = Math.max(0, Math.min(1, ((at[0] - p0[0]) * dx + (at[1] - p0[1]) * dy) / L));
      const q: Pt = [p0[0] + tt * dx, p0[1] + tt * dy], d = dist(q, at);
      if (d < bd) { bd = d; best = i; bp = q; }
    }
    if (best < 0) return;
    const nv = v.slice();
    nv.splice(best + 1, 0, bp);
    await setCorners(a, nv, 'Add corner');
  };
  /** the corner of a markup under a point (-1: none) */
  const cornerAt = (page: number, id: number, at: Pt): number => {
    const a = (annotsNow.current[page] || []).find((x) => x.id === id);
    if (!a || !cornersEditable(a)) return -1;
    const t = 8 / zRef.current;
    let bi = -1, bd = t;
    a.vertices!.forEach((q, i) => { const d = dist(q, at); if (d < bd) { bd = d; bi = i; } });
    return bi;
  };
  /** an open line (polylength, polyline) drawn on from its nearer end */
  const pendingDraft = useRef<Draft | null>(null);
  const continueLine = (page: number, id: number, at?: Pt, from?: number) => {
    const a = (annotsNow.current[page] || []).find((x) => x.id === id);
    // from a corner (any corner of an outline; one in the middle of a line): drawn on from it, the
    // corners after it kept (Estimation 0.17's "continue from a node")
    if (a && !a.locked && a.vertices && from != null && from >= 0 && from < a.vertices.length && a.kind !== 'measure-angle' && (a.type === 'Polygon' || (a.type === 'PolyLine' && from > 0 && from < a.vertices.length - 1))) {
      const v = a.vertices;
      const d: Draft = { kind: 'poly', page, pts: v.slice(0, from + 1), cur: v[from], cont: { id, base: from + 1, tail: v.slice(from + 1) } };
      const tool: ToolId = a.type === 'PolyLine'
        ? (a.kind === 'measure-polylength' ? 'm-polylength' : 'polyline')
        : (a.kind === 'measure-area' ? 'm-area' : a.kind === 'measure-perimeter' ? 'm-perimeter' : a.kind === 'cloud' ? 'cloud' : 'polygon');
      P.current.setSel([]);
      if (P.current.tool === tool) setDraft(d);
      else { pendingDraft.current = d; P.current.setTool(tool); }
      P.current.onEvent({ type: 'status', text: 'Click the new points after this corner - Enter or double-click to finish (the rest of the shape stays), Ctrl+Z takes back a point.' });
      return;
    }
    if (!a || a.locked || a.type !== 'PolyLine' || !a.vertices || a.vertices.length < 2 || a.kind === 'measure-angle') return;
    const v = a.vertices.slice();
    const rev = !!at && dist(at, v[0]) < dist(at, v[v.length - 1]);
    if (rev) v.reverse();
    const d: Draft = { kind: 'poly', page, pts: v, cur: v[v.length - 1], cont: { id, base: v.length } };
    const tool: ToolId = a.kind === 'measure-polylength' ? 'm-polylength' : 'polyline';
    P.current.setSel([]);
    if (P.current.tool === tool) setDraft(d);
    else { pendingDraft.current = d; P.current.setTool(tool); }
    P.current.onEvent({ type: 'status', text: 'Click the next points of the line - Enter or double-click to finish, Ctrl+Z takes back a point.' });
  };

  /** a rectangle measured as an area or perimeter (its corners keep square when dragged) */
  const rectish = (a: AnnotData) => (a.kind === 'measure-area' || a.kind === 'measure-perimeter') && a.type === 'Polygon' && isAxisRect(a.vertices);
  /** a circle measured as one (one handle: its size) */
  const circular = (a: AnnotData) => (a.kind === 'measure-area' || a.kind === 'measure-perimeter') && !!circleOf(a.vertices);

  const onPointerUp = async (e: React.PointerEvent) => {
    const el = scroller.current!;
    try { el.releasePointerCapture(e.pointerId); } catch { /* ok */ }
    const pl = pendingLink.current;
    pendingLink.current = null;
    if (pl && Math.abs(e.clientX - pl.x) < 4 && Math.abs(e.clientY - pl.y) < 4) {
      // a click on a link (the mouse did not move): followed - not the selecting / panning it began
      setDrag(null);
      setTextSel(null);
      followLink(pl.page, pl.p, e);
      return;
    }
    const d = drag;
    if (d) {
      // (the snap the drawing engine found after the pointer stopped: taken - it came after the last move)
      const late = snapRef.current;
      snapWanted.current = false;
      snapRef.current = null;
      setSnapMark(null);
      setDrag(null);
      setTip(null);
      try {
        switch (d.mode) {
          case 'move':
            if (d.moved) await moveAndRelabel(d.items, d.cur[0] - d.start[0], d.cur[1] - d.start[1]);
            else if (d.edit) openFreeEditor(d.edit);
            break;
          case 'resize': {
            if (d.keep) P.current.onEvent({ type: 'status', text: TOOLS[P.current.tool].hint });
            const nb = resizedBox(d);
            if (nb[2] - nb[0] > 2 && nb[3] - nb[1] > 2) {
              const a0 = byId(d.page).get(d.id);
              const auto = !!a0 && labelWasAuto(a0);
              const a = await doc.resize(d.page, d.id, nb);
              // measurements change value with their size (a label typed by hand stays; one step for both)
              if (auto && a.kind?.startsWith('measure-') && a.vertices) await doc.update([{ page: d.page, id: d.id, patch: { contents: measureText(('m-' + a.kind.slice(8)) as ToolId, d.page, a.vertices, a.fmt ?? LEGACY_FMT), autoLabel: true } }], 'Resize', undefined, true);
            }
            break;
          }
          case 'vertex': {
            const a = (annots[d.page] || []).find((x) => x.id === d.id);
            if (!a) break;
            // a click on a corner or a middle dot (no drag) changes nothing - Alt+click deletes the corner
            if (d.start && !d.moved) { if (d.alt && d.which === 'v' && !d.ins) await deleteCorner(d.page, d.id, d.index); break; }
            const cur = late && late.page === d.page && !e.shiftKey && dist(late.raw, d.cur) < snapR() * 1.5 ? late.p : d.cur;
            const pts = vertexPts(a, d.index, cur, d.which, d.free, d.ins);
            if (d.which === 'v' || d.which === 'r') { await setCorners(a, pts, d.ins ? 'Add corner' : 'Edit points'); break; }
            const patch: Partial<AnnotSpec> = d.which === 'l' ? { line: pts } : { callout: pts };
            // (its number follows the new shape - a label typed by hand, a room's name, stays: it was replaced)
            if (a.kind?.startsWith('measure-') && a.kind !== 'measure-count' && (labelWasAuto(a) || !a.contents?.trim())) { patch.contents = measureText(('m-' + a.kind.slice(8)) as ToolId, d.page, pts, a.fmt ?? LEGACY_FMT); patch.autoLabel = true; }
            await doc.update([{ page: d.page, id: d.id, patch }], 'Edit points');
            break;
          }
          case 'textedge': {
            const a = (annots[d.page] || []).find((x) => x.id === d.id);
            if (!a || !edge || edge.id !== d.id) break;
            moveSeq.current++;
            const c = await charsOf(d.page);
            // the end goes where the mouse was let go
            const rel = toPage(e.clientX, e.clientY, d.page);
            const cur = rel ? nearestChar(c, rel.p) : d.cur;
            const lo = Math.min(d.fixed, cur < 0 ? d.cur : cur), hi = Math.max(d.fixed, cur < 0 ? d.cur : cur);
            if (lo === edge.a && hi === edge.b) break;
            const rects = rectsFor(c, lo, hi);
            if (!rects.length) break;
            const patch: Partial<AnnotSpec> = { quads: rects.map((r) => [r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]]) };
            // its comment follows the text - unless someone wrote their own
            const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
            if (!a.contents || norm(a.contents) === norm(c.text.slice(edge.a, edge.b + 1))) patch.contents = c.text.slice(lo, hi + 1);
            await doc.update([{ page: d.page, id: d.id, patch }], 'Change ' + ({ Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'squiggly' } as Record<string, string>)[a.type]);
            break;
          }
          case 'rotate': {
            const ang = (((d.angle0 + d.cur - d.start) % 360) + 360) % 360;
            await doc.update([{ page: d.page, id: d.id, patch: { angle: Math.round(ang * 10) / 10 } }], 'Rotate');
            break;
          }
          case 'band': {
            const r = rectOf(d.a, d.b);
            if ((r[2] - r[0]) * z > 3 || (r[3] - r[1]) * z > 3) {
              const inside = (annots[d.page] || []).filter((a) => a.irt == null && a.type !== 'Widget' && overlaps(geomBox(a), r) && geomBox(a)[0] >= r[0] && geomBox(a)[2] <= r[2] && geomBox(a)[1] >= r[1] && geomBox(a)[3] <= r[3]);
              props.setSel([...(e.shiftKey ? props.sel : []), ...inside.map((a) => ({ page: d.page, id: a.id }))]);
            }
            break;
          }
          case 'text': {
            const tool = props.tool;
            if (tool !== 'select' && textSel) {
              // a plain click (the mouse never moved) marks nothing: it left a one-letter
              // highlight / underline / redaction mark where it landed
              const still = Math.abs(e.clientX - lastClick.current.x) < 3 && Math.abs(e.clientY - lastClick.current.y) < 3;
              if (still && textSel.a === textSel.b) { setTextSel(null); break; }
              const c = await charsOf(textSel.page);
              const rects = rectsFor(c, textSel.a, textSel.b);
              setTextSel(null);
              if (!rects.length) break;
              if (tool === 'redact-text') {
                const pgn = textSel.page;
                await doc.createMany(rects.map((r) => { const hh = r[3] - r[1]; return { page: pgn, spec: { type: 'Redact' as const, rect: [r[0], r[1] + hh * 0.18, r[2], r[3] - hh * 0.18] as Rect, redactFill: st().redact ?? [0, 0, 0] } }; }), 'Mark for redaction');
                P.current.onEvent({ type: 'status', text: 'Marked for redaction – press Apply redactions to remove it for good.' });
              } else {
                const type = tool === 'highlight' ? 'Highlight' : tool === 'underline' ? 'Underline' : tool === 'strike' ? 'StrikeOut' : 'Squiggly';
                const contents = c.text.slice(Math.min(textSel.a, textSel.b), Math.max(textSel.a, textSel.b) + 1);
                await create(textSel.page, { type, quads: rects.map((r) => [r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]]), color: st().color, opacity: st().opacity, contents, kind: tool }, false);
              }
            }
            break;
          }
        }
      } catch (err) {
        props.onEvent({ type: 'error', text: String((err as Error).message || err) });
      } finally {
        setGhosts({});
        ghostGen.current++;
        if ('page' in d) { const pg = d.page; void doc.annots(pg).then((l) => setAnnots((x) => ({ ...x, [pg]: l }))); }
      }
      return;
    }
    if (draft) {
      if (draft.kind === 'rect') { void finishDraft(draft); return; }
      if (draft.kind === 'two') {
        // (a rectangle area: a first click that slipped a few pixels - or along one side only - is
        // still a click; finished as a drag it made nothing, or a speck of an area)
        const thin = howOf(props.tool) === 'rect' && Math.min(Math.abs(draft.b[0] - draft.a[0]), Math.abs(draft.b[1] - draft.a[1])) * z <= 4;
        if (dist(draft.a, draft.b) * z > 4 && !thin) void finishDraft(draft);
        else setDraft({ ...draft, clicked: true });
        return;
      }
      if (draft.kind === 'ink') {
        // strokes made within a moment of each other become one markup
        const d0 = draft;
        // (not a stroke on another page, nor one still being drawn)
        window.setTimeout(() => setDraft((cur) => { if (cur && !btnDown.current && (cur === d0 || (cur.kind === 'ink' && cur.page === d0.page && cur.strokes.length === d0.strokes.length))) { void finishDraft(cur); return null; } return cur; }), 900);
        return;
      }
      if (draft.kind === 'callout' && draft.box) { void finishDraft(draft); return; }
      // Cloud: a box dragged from the first corner is a cloud round that box (the tool's hint
      // offers it; a drag did nothing - only corner clicks made a cloud)
      const box = draft.kind === 'poly' ? cloudBox(draft) : null;
      if (box && draft.kind === 'poly') { void finishDraft({ ...draft, pts: box }); return; }
    }
  };
  /** the four corners of a box being dragged out with the Cloud tool (button held since the first corner) */
  const cloudBox = (d: Draft): Pt[] | null => {
    if (d.kind !== 'poly' || P.current.tool !== 'cloud' || d.pts.length !== 1) return null;
    const a = d.pts[0], b = d.cur;
    if (Math.abs(b[0] - a[0]) * zRef.current < 8 || Math.abs(b[1] - a[1]) * zRef.current < 8) return null;
    return [a, [b[0], a[1]], b, [a[0], b[1]]];
  };

  function resizedBox(d: Extract<Drag, { mode: 'resize' }>): Rect {
    const b = d.box;
    const c: Pt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    // work in the markup's own (unrotated) frame
    const q = rot(d.cur, c, -d.angle);
    let [x0, y0, x1, y1] = b;
    const h = d.handle;
    const k = HPAD / zRef.current; // the handles sit HPAD px outside the box
    if (h === 0 || h === 3 || h === 7) x0 = Math.min(q[0] + k, x1 - 2);
    if (h === 1 || h === 2 || h === 5) x1 = Math.max(q[0] - k, x0 + 2);
    if (h === 0 || h === 1 || h === 4) y0 = Math.min(q[1] + k, y1 - 2);
    if (h === 2 || h === 3 || h === 6) y1 = Math.max(q[1] - k, y0 + 2);
    if (d.keep && !d.free) {
      // a stamp / picture keeps its proportions (a round seal stays round): from a corner the
      // corner across stays put; from a side that side's opposite stays put and the other way
      // grows about the middle. Never smaller than 8 pt. Shift stretches freely.
      const W = b[2] - b[0], H = b[3] - b[1];
      if (W > 0 && H > 0) {
        const s = Math.max(h <= 3 ? Math.max((x1 - x0) / W, (y1 - y0) / H) : h === 4 || h === 6 ? (y1 - y0) / H : (x1 - x0) / W, 8 / Math.min(W, H));
        const w = W * s, hh = H * s;
        if (h <= 3) {
          if (h === 0 || h === 3) x0 = x1 - w; else x1 = x0 + w;
          if (h === 0 || h === 1) y0 = y1 - hh; else y1 = y0 + hh;
        } else if (h === 4 || h === 6) {
          if (h === 4) y0 = y1 - hh; else y1 = y0 + hh;
          const cx = (b[0] + b[2]) / 2; x0 = cx - w / 2; x1 = cx + w / 2;
        } else {
          if (h === 7) x0 = x1 - w; else x1 = x0 + w;
          const cy = (b[1] + b[3]) / 2; y0 = cy - hh / 2; y1 = cy + hh / 2;
        }
      }
    }
    if (!d.angle) return [x0, y0, x1, y1];
    // the opposite side stays put on the page: rotate the new centre back
    const nc = rot([(x0 + x1) / 2, (y0 + y1) / 2], c, d.angle);
    const w = x1 - x0, hh = y1 - y0;
    return [nc[0] - w / 2, nc[1] - hh / 2, nc[0] + w / 2, nc[1] + hh / 2];
  }

  const onDoubleClick = () => {
    if (draft && draft.kind === 'poly') void finishDraft(draft);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || props.wheelZoom !== e.altKey) {
      const r = scroller.current!.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
      zoomAt(zRef.current * f, e.clientX - r.left, e.clientY - r.top);
    }
  };
  useEffect(() => {
    // React's wheel listener is passive; block the browser's own Ctrl+wheel zoom
    const el = scroller.current!;
    const h = (e: WheelEvent) => { if (e.ctrlKey || P.current.wheelZoom !== e.altKey) e.preventDefault(); };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);

  // ---------------------------------------------------------------- typed lengths (measuring)

  /** a length being typed for the next point (Length, Polylength, Area / Perimeter by corners) */
  const [typed, setTyped] = useState('');
  const typedNow = useRef('');
  typedNow.current = typed;
  const draftNow = useRef<Draft | null>(null);
  draftNow.current = draft;

  // ---------------------------------------------------------------- points of a shape being drawn
  // Ctrl+Z / Backspace / Delete take back the last point (again and again), Ctrl+Y puts it back;
  // Esc cancels the shape and Ctrl+Z within 15 s brings it back. The file's own Undo is left alone
  // while a shape is being drawn (it took back the markup made before).
  /** the drafts taken back, newest last (Ctrl+Y); valid while the draft is the one they left */
  const ptRedo = useRef<{ stack: Draft[]; after: Pt[] | null }>({ stack: [], after: null });
  /** a shape cancelled with Esc (Ctrl+Z brings it back for a while) */
  const cancelled = useRef<{ d: Draft; t: number; tool: ToolId; rev: number } | null>(null);
  /** markups changed since (a shape cancelled and something else done meanwhile: Ctrl+Z is the file's) */
  const docRev = () => doc.annRev.reduce((t, v) => t + (v || 0), 0) + doc.crev.reduce((t, v) => t + (v || 0), 0);
  // (a new shape started: the one cancelled before is gone for good)
  useEffect(() => { if (draft && cancelled.current && draft !== cancelled.current.d) cancelled.current = null; }, [draft]);
  const samePts = (a: Pt[] | null, b: Pt[] | null) => (!a && !b) || (!!a && !!b && a.length === b.length && a.every((q, i) => q[0] === b[i][0] && q[1] === b[i][1]));
  const ptsOfDraft = (d: Draft | null): Pt[] | null => (!d ? null : d.kind === 'poly' ? d.pts : d.kind === 'two' ? [d.a] : null);
  /** a draft with points to take back: a shape by corners, or a line waiting for its second click */
  const pointDraft = (d: Draft | null): d is Extract<Draft, { kind: 'poly' | 'two' }> => !!d && (d.kind === 'poly' || (d.kind === 'two' && d.clicked));
  const undoPoint = (): boolean => {
    const d = draftNow.current;
    if (pointDraft(d)) {
      const R = ptRedo.current;
      if (!samePts(R.after, ptsOfDraft(d))) R.stack = [];
      R.stack.push(d);
      setTyped('');
      // (a line being continued: its own corners stay - taking back the first new point ends it)
      if (d.kind === 'poly' && d.pts.length > (d.cont ? d.cont.base + 1 : 1)) {
        const nd = { ...d, pts: d.pts.slice(0, -1) };
        R.after = nd.pts;
        setDraft(nd);
        tellPoints(nd);
      } else {
        R.after = null;
        setDraft(null); setTip(null);
        P.current.onEvent({ type: 'status', text: 'Point taken back - the shape is gone. Ctrl+Y puts it back.' });
      }
      return true;
    }
    // Esc a moment ago: the shape comes back (in the same tool)
    const c = cancelled.current;
    if (!d && c && performance.now() - c.t < 15000 && c.tool === P.current.tool && c.rev === docRev()) {
      cancelled.current = null;
      setDraft(c.d);
      P.current.onEvent({ type: 'status', text: 'Shape brought back - carry on drawing.' });
      return true;
    }
    return false;
  };
  const redoPoint = (): boolean => {
    const R = ptRedo.current, d = draftNow.current;
    if (!R.stack.length || (d && !pointDraft(d)) || !samePts(R.after, ptsOfDraft(d))) return false;
    const nd = R.stack.pop()!;
    R.after = ptsOfDraft(nd);
    // (the pointer stays where it is)
    setDraft(d && d.kind === 'poly' && nd.kind === 'poly' ? { ...nd, cur: d.cur } : nd);
    if (nd.kind === 'poly') tellPoints(nd);
    return true;
  };
  /** Esc: the shape goes - kept a while for Ctrl+Z */
  const cancelDraft = () => {
    const d = draftNow.current;
    if (d && pointDraft(d) && (d.kind === 'two' || d.pts.length > (d.cont ? d.cont.base : 1))) {
      cancelled.current = { d, t: performance.now(), tool: P.current.tool, rev: docRev() };
      P.current.onEvent({ type: 'status', text: 'Shape cancelled - Ctrl+Z brings it back.' });
    }
    ptRedo.current = { stack: [], after: null };
    setDraft(null); setTip(null);
  };
  /** close the shape: an area finishes; a line goes back to its first point and finishes */
  const closeDraft = () => {
    const d = draftNow.current;
    if (!d || d.kind !== 'poly' || P.current.tool === 'm-angle') return;
    const closedTool = ['polygon', 'cloud', 'm-area', 'm-perimeter'].includes(P.current.tool);
    if (d.pts.length < (closedTool ? 3 : 2)) return;
    void finishDraft(closedTool || samePts([d.pts[0]], [d.pts[d.pts.length - 1]]) ? d : { ...d, pts: [...d.pts, d.pts[0]] });
  };
  /** the status line says what is drawn so far (and how to take a point back) */
  const tellPoints = (d: Extract<Draft, { kind: 'poly' }>) => {
    const t = P.current.tool;
    const n = d.pts.length - (d.cont ? d.cont.base : 0);
    P.current.onEvent({ type: 'status', text: `${n} point${n === 1 ? '' : 's'}${t.startsWith('m-') && d.pts.length > 1 ? ' - ' + measureText(t, d.page, [...d.pts, ...(d.cont?.tail ?? [])]) : ''}. Ctrl+Z takes back a point, Ctrl+Y puts it back.` });
  };
  const pointKeys = useRef({ undoPoint, redoPoint, cancelDraft, closeDraft });
  pointKeys.current = { undoPoint, redoPoint, cancelDraft, closeDraft };
  /** pencil strokes waiting to become their markup (strokes made within a moment are one markup):
   *  made now - before a save, a tool change, Escape */
  function flushInk(): Promise<void> {
    const d = draftNow.current;
    if (d?.kind !== 'ink' || !d.strokes.some((x) => x.length)) return Promise.resolve();
    draftNow.current = null;
    setDraft(null);
    return finishDraft(d);
  }
  const flushInkRef = useRef(flushInk);
  flushInkRef.current = flushInk;
  const lastTip = useRef({ x: 40, y: 40 });
  const takesLength = (t: ToolId, d: Draft | null) => !!d && ((d.kind === 'two' && t === 'm-length') || (d.kind === 'poly' && (t === 'm-polylength' || ((t === 'm-area' || t === 'm-perimeter') && howOf(t) === 'points'))));
  /** the draft's last point (where a typed length is measured from) */
  const lastOf = (d: Draft): Pt | null => (d.kind === 'two' ? d.a : d.kind === 'poly' ? d.pts[d.pts.length - 1] : null);
  /** what the tip says while a length is typed: how it reads, before Enter */
  const typedTip = (t: string): string => {
    const d = draftNow.current;
    const at = d ? lastOf(d) : null;
    const sc = d && at ? scaleFor(d.page, at) : null;
    if (!sc) return `${t}  – set the scale first to type lengths`;
    const v = parseTypedLength(t, sc.imperial);
    if (!v) return `${t} …`;
    const shown = sc.imperial ? `${(v.m / 0.3048).toFixed(3)} ft` : `${v.m.toFixed(3)} m (${(v.m * 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })} mm)`;
    const read = v.read === 'mm' ? ' – read as millimetres' : v.read ? ` – read as ${v.read === 'm' ? 'metres' : v.read}` : '';
    return `${t} → ${shown}${read} · Enter`;
  };
  // a new shape, another tool or way of drawing: nothing typed
  useEffect(() => { if (!draft) setTyped(''); }, [draft === null]);
  useEffect(() => { setTyped(''); }, [props.tool, props.how]);
  // another way of drawing (corners / rectangle / circle): the shape begun is dropped
  const howSeen = useRef(props.how);
  useEffect(() => { if (howSeen.current !== props.how) { howSeen.current = props.how; setDraft(null); setTip(null); } }, [props.how]);
  /** Enter on a typed length: the next point that far from the last one, towards the pointer */
  const applyTyped = async (t: string) => {
    const d = draftNow.current;
    if (!d || (d.kind !== 'two' && d.kind !== 'poly')) return;
    const last = lastOf(d)!;
    const toward = d.kind === 'two' ? d.b : d.cur;
    // (at the scale the whole measurement is worked out at - its first point's: laid out at the last
    // point's, a typed 2 m across a viewport's edge added 10 m to the total)
    const sc = scaleFor(d.page, d.kind === 'two' ? d.a : d.pts[0]);
    if (!sc) { P.current.onEvent({ type: 'status', text: 'Set the scale first (Measure > Scale or Calibrate) – then lengths can be typed.' }); return; }
    const v = parseTypedLength(t, sc.imperial);
    if (!v) { P.current.onEvent({ type: 'status', text: `"${t}" isn't a length – for example 4200, 4.2 or 4200mm.` }); return; }
    let ux = toward[0] - last[0], uy = toward[1] - last[1];
    const L = Math.hypot(ux, uy);
    if (L * zRef.current < 1) { ux = 1; uy = 0; } else { ux /= L; uy /= L; }
    // metres per point that way (a separate up-down scale counts in it)
    const per = sc.k * Math.hypot(ux, uy * yRatio(sc));
    const q: Pt = [last[0] + (ux * v.m) / per, last[1] + (uy * v.m) / per];
    const pg = pages[d.page];
    if (pg && (q[0] < -0.5 || q[1] < -0.5 || q[0] > pg.w + 0.5 || q[1] > pg.h + 0.5)) { P.current.onEvent({ type: 'status', text: 'That length runs off the page – point the other way, or type less.' }); return; }
    setTyped('');
    setTip(null);
    if (d.kind === 'two') { await finishDraft({ ...d, b: q, clicked: true }); return; }
    setDraft({ ...d, pts: [...d.pts, q], cur: q });
  };
  const applyNow = useRef(applyTyped);
  applyNow.current = applyTyped;
  useEffect(() => {
    // (capture: ahead of the tool keys - "m" after a number is metres, not the Length tool)
    const onKey = (e: KeyboardEvent) => {
      const d = draftNow.current;
      if (!takesLength(P.current.tool, d) || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.scrim')) return;
      const cur = typedNow.current;
      const k = e.key;
      let next: string | null = null;
      if (/^[0-9]$/.test(k) || k === '.' || k === ',') next = cur + k;
      else if (cur && /^[mcftin'"]$/i.test(k)) next = cur + k.toLowerCase();
      else if (cur && k === ' ') next = cur;
      else if (cur && k === 'Backspace') next = cur.slice(0, -1);
      else if (cur && k === 'Escape') next = '';
      else if (cur && k === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); void applyNow.current(cur); return; }
      if (next === null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setTyped(next);
      setTip(next ? { ...lastTip.current, text: typedTip(next) } : null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ---------------------------------------------------------------- keys

  useEffect(() => {
    const down = async (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.scrim')) return;
      const pr = P.current;
      // (Space on a button presses the button - only the page itself pans with it)
      if (e.key === ' ' && !e.repeat) { if (t && t.closest?.('button, a, [role="button"], [role="menuitem"], summary, label')) return; setSpace(true); e.preventDefault(); return; }
      if (e.key === 'Escape') {
        // (pencil strokes already drawn are kept - Escape within a moment of a stroke lost it)
        if (draft?.kind === 'ink' && !btnDown.current) { void flushInk(); setTip(null); return; }
        if (draft) { cancelDraft(); return; }
        if (textSel) { setTextSel(null); return; }
        // (the area marked with the Snapshot tool goes first)
        if (pr.marked) { pr.onEvent({ type: 'unmark' }); return; }
        if (pr.sel.length) { pr.setSel([]); return; }
        if (pr.tool !== 'select') pr.setTool('select');
        return;
      }
      if (e.key === 'Enter' && draft?.kind === 'poly') { e.preventDefault(); void finishDraft(draft); return; }
      if (e.key === 'Enter' && draft?.kind === 'ink') { void finishDraft(draft); return; }
      // Enter / F2 on a selected text box: type in it - not while it is being typed in (the text
      // stored before was put back over what was typed), and Enter on a focused button presses
      // that button (it opened the text box instead)
      const onButton = !!t?.closest?.('button, a, [role="button"], [role="menuitem"], summary, label');
      if ((e.key === 'Enter' || e.key === 'F2') && !draft && pr.sel.length === 1 && !editorNow.current && !(e.key === 'Enter' && onButton)) {
        const a = (annotsNow.current[pr.sel[0].page] || []).find((x) => x.id === pr.sel[0].id);
        if (a?.type === 'FreeText') { e.preventDefault(); openFreeEditor(a); return; }
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && pointDraft(draft)) { e.preventDefault(); undoPoint(); return; }
      // Count: Backspace takes back the last mark made (again and again)
      if (e.key === 'Backspace' && pr.tool === 'm-count' && !pr.sel.length && !draft && !pr.readOnly) {
        e.preventDefault();
        // after the marks still being made (quick clicks then Backspace took the mark before the
        // last one); marks already gone - undone, deleted - are passed over, asked of the engine
        // (the page's list here lags a mark made a moment ago)
        const job = countChain.current.then(async () => {
          const has = new Map<number, Set<number>>();
          const there = async (m: { page: number; id: number }) => {
            if (!has.has(m.page)) has.set(m.page, new Set((await doc.annots(m.page)).map((x) => x.id)));
            return has.get(m.page)!.has(m.id);
          };
          let last = countMade.current.pop();
          while (last && !(await there(last))) last = countMade.current.pop();
          if (last) { await doc.remove([last]).catch(() => 0); countMemo.current = null; pr.onEvent({ type: 'status', text: 'Last count mark taken back.' }); }
        });
        countChain.current = job.catch(() => {});
        await job.catch(() => {});
        return;
      }
      if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'c' && draft?.kind === 'poly') { e.preventDefault(); closeDraft(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && pr.sel.length && !pr.readOnly) {
        e.preventDefault();
        let n = 0;
        try { n = await doc.remove(pr.sel); } catch (err) { pr.setSel([]); pr.onEvent({ type: 'error', text: String((err as Error).message || err) }); return; }
        if (n < pr.sel.length) {
          // locked ones stay - and stay selected, so Unlock is one click away
          // (asked fresh from the engine: the page's list here may not show a lock made a moment ago)
          const all = await doc.allAnnots();
          pr.setSel(pr.sel.filter((x) => all.some((a) => a.page === x.page && a.id === x.id)));
          pr.onEvent({ type: 'status', text: 'Locked markups were not deleted – unlock them first.' });
        } else pr.setSel([]);
        return;
      }
      if (e.key.startsWith('Arrow') && pr.sel.length) {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) / zRef.current;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const items = pr.sel.filter((s) => { const a = (annots[s.page] || []).find((x) => x.id === s.id); return a && !a.locked && !NO_MOVE.has(a.type, a); });
        if (!items.length) return;
        // not off the page - each page's markups against that page (a selection can span pages)
        const boxes = [...new Set(items.map((s) => s.page))].filter((p) => pages[p]).map((p) => ({ box: boxOfItems(items.filter((s) => s.page === p)), w: pages[p].w, h: pages[p].h }));
        const [cx, cy] = shiftOnPages(boxes, dx, dy);
        if (cx || cy) await moveAndRelabel(items, cx, cy).catch((err) => pr.onEvent({ type: 'error', text: String((err as Error).message || err) }));
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'c' && textSel) { e.preventDefault(); void copyText(); return; }
      if (e.ctrlKey && !e.altKey && !pr.readOnly) {
        const k = e.key.toLowerCase();
        if (k === 'c' && pr.sel.length) { e.preventDefault(); await copyMarkups(false); return; }
        if (k === 'x' && pr.sel.length) { e.preventDefault(); await copyMarkups(true); return; }
        if (k === 'd' && pr.sel.length) { e.preventDefault(); await duplicate(); return; }
        if (k === 'v' && markClip.cur && !pr.readOnly) { e.preventDefault(); await pasteMarkups(); return; }
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'a' && pr.tool === 'select') {
        e.preventDefault();
        const pg = curPage();
        pr.setSel((annots[pg] || []).filter((a) => a.irt == null && a.type !== 'Widget').map((a) => ({ page: pg, id: a.id })));
        return;
      }
      if (e.key === 'F9') { e.preventDefault(); return; }
    };
    const up = (e: KeyboardEvent) => { if (e.key === ' ') setSpace(false); };
    // (the key let go in another window: no key-up comes - panning must not stay on)
    const blur = () => setSpace(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  });

  // tool changes drop half-made shapes
  // (pencil strokes drawn a moment before the tool changed become their markup - they were dropped)
  useEffect(() => {
    snapWanted.current = false; snapRef.current = null; void flushInk();
    // (a line being continued: its draft comes with the tool - right-click > Continue this line)
    setDraft(pendingDraft.current); pendingDraft.current = null;
    setTip(null); setSnapMark(null); if (props.tool !== 'select') setTextSel(null);
    countMade.current = [];
  }, [props.tool]);
  // search: go to the current hit
  useEffect(() => {
    const h = props.hits[props.hitIndex];
    if (h && h.rects[0]) props.apiRef.current?.goTo(h.page, h.rects[0], true);
  }, [props.hitIndex, props.hits]);
  // selection from outside (comments list): make sure it's on screen
  useEffect(() => { setTextSel((t) => (props.sel.length ? null : t)); }, [props.sel]);

  // ---------------------------------------------------------------- drawing the overlay

  const sw = 1 / z; // one screen pixel in points
  const dashArr = `${4 * sw} ${3 * sw}`;
  const accent = '#d6af67';

  const overlay = (page: number) => {
    const out: JSX.Element[] = [];
    const k = (s: string) => page + ':' + s;
    // the Link tool: every link on the page shown (to click and change)
    if (props.tool === 'link') (links[page] || []).forEach((l, i) => out.push(<rect key={k('lk' + i)} x={l.rect[0]} y={l.rect[1]} width={l.rect[2] - l.rect[0]} height={l.rect[3] - l.rect[1]} className="linkbox" style={{ strokeWidth: 1.5 * sw }}><title>{l.url || (l.page != null && l.page >= 0 ? 'Page ' + (l.page + 1) : '')}</title></rect>));
    // search hits
    props.hits.forEach((h, i) => {
      if (h.page !== page) return;
      h.rects.forEach((r, j) => out.push(<rect key={k('h' + i + '.' + j)} x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} className={i === props.hitIndex ? 'hit cur' : 'hit'} />));
    });
    // selected text
    if (textSel?.page === page) selRects.forEach((r, i) => out.push(<rect key={k('t' + i)} x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} className="tsel" />));
    // edit-text lines
    if (props.tool === 'edit-text') (blocks[page] || []).forEach((l, i) => out.push(<rect key={k('l' + i)} x={l.bbox[0] - 1} y={l.bbox[1] - 1} width={l.bbox[2] - l.bbox[0] + 2} height={l.bbox[3] - l.bbox[1] + 2} className="eline" strokeWidth={sw} />));
    // form fields: a light tint so people see where to type (not on signature fields - nothing
    // to type there - nor hidden ones, which tinted empty page)
    for (const a of annots[page] || []) if (a.type === 'Widget' && a.field && !a.field.readOnly && a.field.ftype !== 'button' && a.field.ftype !== 'signature' && !a.hidden) out.push(<rect key={k('f' + a.id)} x={a.rect[0]} y={a.rect[1]} width={a.rect[2] - a.rect[0]} height={a.rect[3] - a.rect[1]} className="field" />);
    // the markup under the pointer
    if (hover && hover.page === page && !drag) {
      const a = (annots[page] || []).find((x) => x.id === hover.id);
      if (a && a.type !== 'Widget') { const h = handlesOf(a); out.push(<polygon key={k('hv')} points={h.corners.map((q) => q.join(',')).join(' ')} className="hoverbox" strokeWidth={sw} />); }
    }
    // selection
    // the ends of the selected text markup (dragged along the text), and the new extent while dragging
    if (edge && edge.page === page) {
      const a = (annots[page] || []).find((x) => x.id === edge.id);
      const dg = drag?.mode === 'textedge' && drag.id === edge.id ? drag : null;
      const lo = dg ? Math.min(dg.fixed, dg.cur) : edge.a, hi = dg ? Math.max(dg.fixed, dg.cur) : edge.b;
      const c = charsCache.current[doc.baseRev + ':' + page];
      if (a && c) {
        if (dg) {
          const col = css(a.color || [1, 0.9, 0]);
          rectsFor(c, lo, hi).forEach((r, i) => {
            if (a.type === 'Highlight') out.push(<rect key={k('tp' + i)} x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} fill={col} fillOpacity={a.opacity ?? 1} style={{ mixBlendMode: 'multiply' }} />);
            else {
              const y = a.type === 'StrikeOut' ? (r[1] + r[3]) / 2 : r[3] - (r[3] - r[1]) * 0.08;
              out.push(<line key={k('tp' + i)} x1={r[0]} x2={r[2]} y1={y} y2={y} stroke={col} strokeWidth={Math.max(sw, (r[3] - r[1]) * 0.07)} strokeDasharray={a.type === 'Squiggly' ? `${2 * sw} ${1.5 * sw}` : undefined} />);
            }
          });
        }
        const h = edgeBars(page, lo, hi);
        if (h) {
          const r = 5.5 * sw;
          out.push(<g key={k('te')} className="tedge">
            <line x1={h.s.x} x2={h.s.x} y1={h.s.y0 - r * 0.8} y2={h.s.y1} strokeWidth={2.5 * sw} /><circle cx={h.s.x} cy={h.s.y0 - r * 1.6} r={r} strokeWidth={2 * sw} />
            <line x1={h.e.x} x2={h.e.x} y1={h.e.y0} y2={h.e.y1 + r * 0.8} strokeWidth={2.5 * sw} /><circle cx={h.e.x} cy={h.e.y1 + r * 1.6} r={r} strokeWidth={2 * sw} />
          </g>);
        }
      }
    }
    const movingIds = drag?.mode === 'move' && drag.moved ? new Set(drag.items.map((s) => s.id)) : null;
    for (const a of selected(page)) {
      if (drag?.mode === 'textedge' && drag.id === a.id) continue;
      const moving = !!movingIds?.has(a.id) && drag?.mode === 'move';
      const dx = moving ? drag.cur[0] - drag.start[0] : 0, dy = moving ? drag.cur[1] - drag.start[1] : 0;
      const h = handlesOf(a);
      let corners = h.corners.map((p) => [p[0] + dx, p[1] + dy] as Pt);
      if (drag?.mode === 'resize' && drag.id === a.id) {
        const nb = resizedBox(drag);
        const c: Pt = [(nb[0] + nb[2]) / 2, (nb[1] + nb[3]) / 2];
        corners = ([[nb[0], nb[1]], [nb[2], nb[1]], [nb[2], nb[3]], [nb[0], nb[3]]] as Pt[]).map((p) => rot(p, c, drag.angle));
      }
      if (drag?.mode === 'rotate' && drag.id === a.id) corners = corners.map((p) => rot(p, drag.centre, drag.cur - drag.start));
      // lines and polylines: their own outline is the selection (no box around them)
      const shaped = !a.locked && ((a.line && !a.callout) || a.vertices);
      if (!shaped) out.push(<polygon key={k('s' + a.id)} points={corners.map((p) => p.join(',')).join(' ')} className={a.locked ? 'selbox locked' : 'selbox'} strokeWidth={sw * 1.5} strokeDasharray={a.locked ? dashArr : undefined} />);
      else out.push(<polygon key={k('s' + a.id)} points={corners.map((p) => p.join(',')).join(' ')} className="selbox nobox" strokeWidth={0} />);
      if (a.locked) { out.push(<text key={k('lk' + a.id)} x={corners[1][0]} y={corners[1][1] - 4 * sw} fontSize={11 * sw} className="lockt" textAnchor="end">locked</text>); continue; }
      const H = (p: Pt, key: string, cls = 'hd') => <rect key={k(key)} x={p[0] - 4 * sw} y={p[1] - 4 * sw} width={8 * sw} height={8 * sw} className={cls} strokeWidth={sw} />;
      if (a.line && !a.callout) {
        const pts = drag?.mode === 'vertex' && drag.id === a.id ? vertexPts(a, drag.index, drag.cur, 'l') : a.line;
        out.push(<line key={k('ln' + a.id)} x1={pts[0][0] + dx} y1={pts[0][1] + dy} x2={pts[1][0] + dx} y2={pts[1][1] + dy} className="vline" strokeWidth={sw} />);
        pts.forEach((p, i) => out.push(H([p[0] + dx, p[1] + dy], 'lv' + a.id + i, 'hd v')));
      } else if (a.vertices) {
        const dragging = drag?.mode === 'vertex' && drag.id === a.id;
        const pts = dragging ? vertexPts(a, drag.index, drag.cur, drag.which, drag.free, drag.ins) : a.vertices;
        out.push(<polyline key={k('pl' + a.id)} points={[...pts, ...(a.type === 'Polygon' ? [pts[0]] : [])].map((p) => p[0] + dx + ',' + (p[1] + dy)).join(' ')} className="vline" strokeWidth={sw} />);
        // (a circle: one handle for its size - not a handle on each of its 128 corners)
        if (circular(a)) { const ci = circleOf(pts); if (ci) out.push(<line key={k('cr' + a.id)} x1={ci.c[0] + dx} y1={ci.c[1] + dy} x2={pts[0][0] + dx} y2={pts[0][1] + dy} className="vline" strokeWidth={sw} strokeDasharray={dashArr} />); out.push(H([pts[0][0] + dx, pts[0][1] + dy], 'vr' + a.id, 'hd v')); }
        else {
          pts.forEach((p, i) => out.push(H([p[0] + dx, p[1] + dy], 'vv' + a.id + i, 'hd v')));
          // a dot in the middle of each edge: drag it for a new corner (not while a corner moves)
          if (!dragging && !moving && props.sel.length === 1) midDots(a).forEach((m, i) => out.push(<circle key={k('md' + a.id + '-' + i)} cx={m.p[0] + dx} cy={m.p[1] + dy} r={3 * sw} className="hd mid" strokeWidth={sw} />));
        }
      } else if (canResize(a) && props.sel.length === 1 && !moving) {
        handlePts(corners).forEach((p, i) => out.push(H(p, 'h' + a.id + i)));
        if (ROTATABLE.has(a.type) && !a.callout?.length) {
          const rh = rotHandle(corners);
          const mid: Pt = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
          out.push(<line key={k('rl' + a.id)} x1={mid[0]} y1={mid[1]} x2={rh[0]} y2={rh[1]} className="vline" strokeWidth={sw} />);
          out.push(<circle key={k('rh' + a.id)} cx={rh[0]} cy={rh[1]} r={5 * sw} className="hd rot" strokeWidth={sw} />);
        }
      }
      if (a.callout?.length) {
        const tipDrag = drag?.mode === 'vertex' && drag.id === a.id && drag.which === 'c';
        const c0 = tipDrag ? drag.cur : a.callout[0];
        // while it changes: the box and its line as they will be (the tip stays where it points)
        const live = moving || tipDrag || (drag?.mode === 'resize' && drag.id === a.id);
        if (live) {
          const nb: Rect = drag?.mode === 'resize' && drag.id === a.id ? resizedBox(drag) : [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy];
          const path = calloutPath(nb, c0);
          out.push(<rect key={k('cb' + a.id)} x={nb[0]} y={nb[1]} width={nb[2] - nb[0]} height={nb[3] - nb[1]} className="cprev" strokeWidth={sw * 1.5} />);
          out.push(<polyline key={k('cl' + a.id)} points={path.map((q) => q.join(',')).join(' ')} className="cprev" strokeWidth={sw * 1.5} fill="none" />);
          out.push(<circle key={k('ct' + a.id)} cx={c0[0]} cy={c0[1]} r={3 * sw} className="cprev dot" />);
        }
        out.push(H(c0, 'co' + a.id, 'hd v'));
      }
    }
    // rubber band
    if (drag?.mode === 'band' && drag.page === page) { const r = rectOf(drag.a, drag.b); out.push(<rect key={k('band')} x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} className="band" strokeWidth={sw} />); }
    // drafts
    if (draft && draft.page === page) {
      const s = props.style;
      const stroke = css(s.color || [0.86, 0.13, 0.13]);
      // (a length is drawn as wide as it will come out: for the zoom you measure at)
      const w = props.tool === 'm-length' ? lengthWidth() : s.width;
      const sp = { stroke, strokeWidth: Math.max(sw, w), fill: s.fill ? css(s.fill, 0.35) : 'none', strokeDasharray: s.dash ? dashArr : undefined };
      if (draft.kind === 'rect') {
        const r = rectOf(draft.a, draft.b);
        const t = props.tool;
        if (t === 'ellipse') out.push(<ellipse key={k('d')} cx={(r[0] + r[2]) / 2} cy={(r[1] + r[3]) / 2} rx={(r[2] - r[0]) / 2} ry={(r[3] - r[1]) / 2} {...sp} />);
        else if (t === 'highlight' || t === 'area-highlight') out.push(<rect key={k('d')} x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} fill={css(s.color, 0.45)} />);
        else if (t === 'redact-area') out.push(<rect key={k('d')} x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} className="redraft" strokeWidth={sw * 1.5} />);
        else if (t === 'rect') out.push(<rect key={k('d')} x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} {...sp} />);
        else out.push(<rect key={k('d')} x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} className="band" strokeWidth={sw * 1.5} />);
      } else if (draft.kind === 'two' && howOf(props.tool) === 'rect') {
        const pts = rectCorners(draft.a, draft.b);
        out.push(<polygon key={k('d')} points={pts.map((q) => q.join(',')).join(' ')} {...sp} fill={s.fill && kindOfTool(props.tool) === 'm-area' ? css(s.fill, 0.3) : 'none'} />);
      } else if (draft.kind === 'two' && howOf(props.tool) === 'circle') {
        out.push(<circle key={k('d')} cx={draft.a[0]} cy={draft.a[1]} r={dist(draft.a, draft.b)} {...sp} fill={s.fill && kindOfTool(props.tool) === 'm-area' ? css(s.fill, 0.3) : 'none'} />);
        out.push(<line key={k('dr')} x1={draft.a[0]} y1={draft.a[1]} x2={draft.b[0]} y2={draft.b[1]} stroke={sp.stroke} strokeWidth={sw} strokeDasharray={dashArr} />);
        out.push(<circle key={k('dc')} cx={draft.a[0]} cy={draft.a[1]} r={2.5 * sw} className="dpt" />);
      } else if (draft.kind === 'two') {
        out.push(<line key={k('d')} x1={draft.a[0]} y1={draft.a[1]} x2={draft.b[0]} y2={draft.b[1]} {...sp} />);
      } else if (draft.kind === 'poly') {
        const closed = ['polygon', 'cloud', 'm-area', 'm-perimeter'].includes(props.tool);
        // (a cloud's box being dragged out shows as that box)
        const box = btnDown.current ? cloudBox(draft) : null;
        // (drawn on from a corner: the rest of the shape follows the pointer, as it will be kept)
        const tail = draft.cont?.tail;
        const pts = box ?? [...draft.pts, draft.cur, ...(tail ?? [])];
        out.push(<polyline key={k('d')} points={[...pts, ...(closed && pts.length > 2 ? [pts[0]] : [])].map((p) => p.join(',')).join(' ')} {...sp} fill={closed && s.fill ? css(s.fill, 0.3) : 'none'} />);
        draft.pts.forEach((p, i) => out.push(<circle key={k('dp' + i)} cx={p[0]} cy={p[1]} r={2.5 * sw} className="dpt" />));
      } else if (draft.kind === 'ink') {
        draft.strokes.forEach((st2, i) => out.push(<polyline key={k('di' + i)} points={st2.map((p) => p.join(',')).join(' ')} {...sp} fill="none" strokeLinecap="round" strokeLinejoin="round" />));
      } else if (draft.kind === 'callout') {
        const b = draft.box;
        out.push(<line key={k('dc')} x1={draft.tip[0]} y1={draft.tip[1]} x2={b ? b[0] : draft.cur[0]} y2={b ? (b[1] + b[3]) / 2 : draft.cur[1]} stroke={css(s.fontColor)} strokeWidth={sw * 1.5} />);
        if (b) out.push(<rect key={k('db')} x={b[0]} y={b[1]} width={b[2] - b[0]} height={b[3] - b[1]} fill={css(s.color, 0.6)} stroke={css(s.fontColor)} strokeWidth={sw} />);
      }
    }
    // a callout being typed in: its line follows the box as it grows (the markup itself is
    // left out of the page picture meanwhile)
    if (editor && editor.kind === 'free' && editor.page === page && editor.callout && edBox && editHide) {
      const path = calloutPath(edBox, editor.callout);
      const lw = Math.max(editor.bw || 1, 0.5);
      out.push(<polyline key={k('ecl')} points={path.map((q) => q.join(',')).join(' ')} fill="none" stroke={editor.color} strokeWidth={lw} strokeLinejoin="round" />);
      // closed arrow head at the tip
      const [t, q] = [path[0], path[1]];
      const L = Math.hypot(q[0] - t[0], q[1] - t[1]) || 1, ux = (q[0] - t[0]) / L, uy = (q[1] - t[1]) / L;
      const hl = 4 + lw * 3, hw = hl * 0.45;
      const b: Pt = [t[0] + ux * hl, t[1] + uy * hl];
      out.push(<polygon key={k('eca')} points={`${t[0]},${t[1]} ${b[0] - uy * hw},${b[1] + ux * hw} ${b[0] + uy * hw},${b[1] - ux * hw}`} fill={editor.color} stroke={editor.color} strokeWidth={lw} strokeLinejoin="round" />);
    }
    if (props.marked && props.marked.page === page) {
      const r = props.marked.rect;
      out.push(<rect key={k('mk')} className="marked" x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} strokeWidth={sw * 1.5} strokeDasharray={`${6 * sw} ${4 * sw}`} />);
    }
    if (snapMark && snapMark.page === page) {
      const p = snapMark.p, r = 6 * sw;
      out.push(snapMark.k === 'End point' || snapMark.k === 'Markup corner' || snapMark.k === 'Start point'
        ? <rect key={k('sn')} data-k={snapMark.k} x={p[0] - r} y={p[1] - r} width={2 * r} height={2 * r} className="snap" strokeWidth={sw * 1.5} />
        : snapMark.k === 'Perpendicular' ? <g key={k('sn')} data-k={snapMark.k}><line x1={p[0] - r} y1={p[1] + r} x2={p[0] + r} y2={p[1] + r} className="snap" strokeWidth={sw * 1.5} /><line x1={p[0]} y1={p[1] + r} x2={p[0]} y2={p[1] - r} className="snap" strokeWidth={sw * 1.5} /></g>
        : snapMark.k === 'Middle' ? <polygon key={k('sn')} data-k={snapMark.k} points={`${p[0]},${p[1] - r} ${p[0] + r},${p[1] + r} ${p[0] - r},${p[1] + r}`} className="snap" strokeWidth={sw * 1.5} />
          : <g key={k('sn')} data-k={snapMark.k}><line x1={p[0] - r} y1={p[1] - r} x2={p[0] + r} y2={p[1] + r} className="snap" strokeWidth={sw * 1.5} /><line x1={p[0] + r} y1={p[1] - r} x2={p[0] - r} y2={p[1] + r} className="snap" strokeWidth={sw * 1.5} /></g>);
    }
    void accent;
    return out;
  };

  const hideFor = (page: number): number[] => {
    if (editHide && editHide.page === page && !(drag && 'page' in drag && drag.page === page)) return [editHide.id];
    if (drag?.mode === 'textedge' && drag.page === page) return [drag.id];
    if (!Object.keys(ghosts).length || !drag || !('page' in drag) || drag.page !== page) return [];
    // a callout has no picture that follows the mouse (its tip stays where it points): it stays
    // drawn where it is, its new box and line shown as an outline - hidden, its text was gone
    // for the whole drag
    const isCallout = (id: number) => !!(annots[page] || []).find((x) => x.id === id)?.callout?.length;
    if (drag.mode === 'move') return drag.moved ? drag.items.map((s) => s.id).filter((id) => !isCallout(id)) : [];
    if (drag.mode === 'resize' || drag.mode === 'vertex' || drag.mode === 'rotate') return isCallout(drag.id) ? [] : [drag.id];
    return [];
  };

  const ghostEls = (page: number) => {
    if (!drag || !('page' in drag) || drag.page !== page) return null;
    const out: JSX.Element[] = [];
    for (const [ids, g] of Object.entries(ghosts)) {
      const id = Number(ids);
      let transform = '';
      const ga = (annots[page] || []).find((x) => x.id === id);
      if (ga?.callout?.length) continue;
      if (drag.mode === 'move' && drag.moved && drag.items.some((s) => s.id === id)) transform = `translate(${(drag.cur[0] - drag.start[0]) * z}px, ${(drag.cur[1] - drag.start[1]) * z}px)`;
      else if (drag.mode === 'rotate' && drag.id === id) { const c = drag.centre; transform = `rotate(${drag.cur - drag.start}deg)`; out.push(<img key={id} className="ghost" src={g.url} style={{ left: (g.x / g.S) * z, top: (g.y / g.S) * z, width: (g.w / g.S) * z, height: (g.h / g.S) * z, transform, transformOrigin: `${(c[0] - g.x / g.S) * z}px ${(c[1] - g.y / g.S) * z}px` }} />); continue; }
      else if (drag.mode === 'resize' && drag.id === id) {
        const nb = resizedBox(drag), ob = drag.box;
        const sx = (nb[2] - nb[0]) / (ob[2] - ob[0]), sy = (nb[3] - nb[1]) / (ob[3] - ob[1]);
        if (!drag.angle) { transform = `translate(${(nb[0] - ob[0]) * z}px, ${(nb[1] - ob[1]) * z}px) scale(${sx}, ${sy})`; out.push(<img key={id} className="ghost" src={g.url} style={{ left: (g.x / g.S) * z, top: (g.y / g.S) * z, width: (g.w / g.S) * z, height: (g.h / g.S) * z, transform, transformOrigin: `${(ob[0] - g.x / g.S) * z}px ${(ob[1] - g.y / g.S) * z}px` }} />); }
        else {
          // turned: stretched in its own (unturned) frame about its middle, then moved to the new
          // middle (no picture was made for it: the markup was hidden for the whole resize)
          const c: Pt = [(ob[0] + ob[2]) / 2, (ob[1] + ob[3]) / 2], nc: Pt = [(nb[0] + nb[2]) / 2, (nb[1] + nb[3]) / 2];
          transform = `translate(${(nc[0] - c[0]) * z}px, ${(nc[1] - c[1]) * z}px) rotate(${drag.angle}deg) scale(${sx}, ${sy}) rotate(${-drag.angle}deg)`;
          out.push(<img key={id} className="ghost" src={g.url} style={{ left: (g.x / g.S) * z, top: (g.y / g.S) * z, width: (g.w / g.S) * z, height: (g.h / g.S) * z, transform, transformOrigin: `${(c[0] - g.x / g.S) * z}px ${(c[1] - g.y / g.S) * z}px` }} />);
        }
        continue;
      } else if (drag.mode === 'vertex') continue;
      out.push(<img key={id} className="ghost" src={g.url} style={{ left: (g.x / g.S) * z, top: (g.y / g.S) * z, width: (g.w / g.S) * z, height: (g.h / g.S) * z, transform }} />);
    }
    return out;
  };

  /** the bar at the foot of the view while a shape is drawn by its points: what it measures so
   *  far, and the keys as buttons */
  const drawBar = () => {
    if (!draft || draft.kind !== 'poly' || props.readOnly) return null;
    const el = scroller.current;
    if (!el) return null;
    const tool = props.tool;
    const closedTool = ['polygon', 'cloud', 'm-area', 'm-perimeter'].includes(tool);
    const n = draft.pts.length - (draft.cont ? draft.cont.base : 0);
    const enough = draft.cont ? n > 0 : draft.pts.length >= (closedTool ? 3 : 2);
    const live = tool.startsWith('m-') && draft.pts.length >= 1 ? measureText(tool, draft.page, [...draft.pts, draft.cur, ...(draft.cont?.tail ?? [])]) : '';
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();
    return (
      <div className="drawbar" style={{ left: vp.left + vp.w / 2, top: vp.top + vp.h - (tool === 'm-area' || tool === 'm-perimeter' ? 100 : 52) }} onPointerDown={stop} onPointerUp={stop} onDoubleClick={stop} onMouseDown={(e) => e.preventDefault()}>
        <span className="db-v">{live || `${n} point${n === 1 ? '' : 's'}`}</span>
        <button title="Take back the last point (Ctrl+Z / Backspace) - Ctrl+Y puts it back" onClick={() => undoPoint()}>Undo point</button>
        {tool !== 'm-angle' && <button title="Close the shape (Shift+C)" disabled={draft.pts.length < (closedTool ? 3 : 2)} onClick={() => closeDraft()}>Close</button>}
        <button className="primary" title="Finish (Enter, double-click or right-click)" disabled={!enough} onClick={() => void finishDraft(draft)}>Finish</button>
        <button title="Cancel (Esc) - Ctrl+Z brings it back" onClick={() => cancelDraft()}>Cancel</button>
      </div>
    );
  };

  const editorEl = () => {
    if (!editor) return null;
    const pg = editor.page;
    if (pg >= pages.length) return null;
    const r = editor.rect;
    const style: React.CSSProperties = {
      left: leftOf(pg) + r[0] * z, top: tops[pg] + r[1] * z, width: Math.max(60, (r[2] - r[0]) * z), height: Math.max(editor.size * z * 1.5, (r[3] - r[1]) * z),
      fontSize: editor.size * z, color: editor.color, transform: editor.angle ? `rotate(${editor.angle}deg)` : undefined,
    };
    const set = (v: string) => setEditor({ ...editor, value: v });
    const keys = (e: React.KeyboardEvent) => {
      // the app's own shortcuts still work while typing (save / close / print / open / next tab):
      // saving and closing put the text in first
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && ['s', 'w', 'o', 'p', 'tab', 'f4'].includes(k)) return;
      e.stopPropagation();
      // Escape: done (what was typed is kept; a new box nobody typed in goes away)
      if (e.key === 'Escape') { e.preventDefault(); void commitEditor(editor, editor.kind !== 'free'); }
      if (e.key === 'Enter' && (editor.kind === 'line' || (editor.kind === 'field' && !editor.multiline)) && !e.shiftKey) { e.preventDefault(); void commitEditor(editor); }
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); void commitEditor(editor); }
    };
    if (editor.kind === 'field' && editor.options?.length)
      return <select autoFocus className="ed field" style={style} value={editor.value} onChange={(e) => void commitEditor({ ...editor, value: e.target.value })} onBlur={() => void commitEditor(editor)} onKeyDown={keys}>{editor.options.map((o) => <option key={o}>{o}</option>)}</select>;
    if (editor.kind === 'line') {
      const l = editor.line!;
      return <input autoFocus dir="auto" className="ed line" style={{ ...style, fontFamily: l.mono ? 'Consolas, monospace' : l.serif ? '"Times New Roman", serif' : 'Arial, Helvetica, sans-serif', fontWeight: l.bold ? 700 : 400, fontStyle: l.italic ? 'italic' : 'normal', width: Math.max((r[2] - r[0]) * z + 40, 120) }} value={editor.value} onChange={(e) => set(e.target.value)} onKeyDown={keys} onBlur={() => void commitEditor(editor)} />;
    }
    // (a field that takes so many characters (its /MaxLen): no more can be typed)
    if (editor.kind === 'field') return <textarea autoFocus className="ed field" style={{ ...style, fontFamily: 'Arial, Helvetica, sans-serif' }} value={editor.value} maxLength={editor.maxLen || undefined} onChange={(e) => set(e.target.value)} onKeyDown={keys} onBlur={() => { if (!blurByViewer.current) void commitEditor(editor); }} />;
    // a text box / callout / typewriter: typed in place, in its own font, size, colour and
    // alignment, with a small bar of text settings above it; the frame stays draggable
    const fam = famCss(editor.family);
    // the same padding / line spacing as the text in the file (mu.ts layoutFreeText), so the
    // text doesn't jump when typing ends; the box's own fill and border are drawn here too (the
    // markup itself is left out of the page picture while it is typed in)
    const pad = edPad(editor);
    const padX = pad.x * z, padTop = pad.top * z, padBottom = pad.bottom * z;
    const bw = editor.bw ?? 0;
    const fontColor = editor.fontColor || [0, 0, 0];
    const base = { family: editor.family || 'Helv', size: editor.size, color: fontColor, bold: !!editor.bold, italic: !!editor.italic };
    /** the whole box given a style (nothing selected; the side panel does the same): its own style
     *  changes in the file at once, and every part of its text takes it */
    const restyle = async (patch: { size?: number; color?: number[]; family?: string; bold?: boolean; italic?: boolean; align?: number }) => {
      const a = (annotsNow.current[editor.page] || []).find((x) => x.id === editor.id);
      if (!a) return;
      const font = { size: patch.size ?? a.font?.size ?? editor.size, color: patch.color ?? a.font?.color ?? [0, 0, 0], family: patch.family ?? a.font?.family ?? 'Helv', bold: patch.bold ?? a.font?.bold ?? false, italic: patch.italic ?? a.font?.italic ?? false };
      const live = richApi.current?.model();
      let runs = live ? live.runs : editor.runs;
      if (patch.bold !== undefined) runs = dropKey(runs, 'b');
      if (patch.italic !== undefined) runs = dropKey(runs, 'i');
      if (patch.size !== undefined) runs = dropKey(runs, 's');
      if (patch.family !== undefined) runs = dropKey(runs, 'f');
      if (patch.color !== undefined) runs = dropKey(runs, 'c');
      if (runs && !runs.some((x) => Object.keys(x).length > 1)) runs = undefined;
      setEditor((cur) => (cur ? { ...cur, ...(live ? { value: live.text } : {}), runs, size: font.size, color: css(font.color), fontColor: font.color, family: font.family, bold: font.bold, italic: font.italic, align: patch.align ?? cur.align } : cur));
      try {
        const r = await doc.update([{ page: editor.page, id: editor.id!, patch: patch.align != null ? { quadding: patch.align } : { font } }], 'Text style');
        if (r[0]) setAnnots((x) => ({ ...x, [editor.page]: (x[editor.page] || []).map((y) => (y.id === r[0].id ? r[0] : y)) }));
      } catch (err) { P.current.onEvent({ type: 'error', text: String((err as Error).message || err) }); }
    };
    /** a style for the selected text - or, with nothing selected, for the whole box */
    const shown = edStyle || {};
    const fmt = (patch: RunStyle, whole: () => void) => { if (!richApi.current?.format(patch)) whole(); };
    const setBold = (v: boolean) => fmt({ b: v }, () => void restyle({ bold: v }));
    const setItalic = (v: boolean) => fmt({ i: v }, () => void restyle({ italic: v }));
    // (underline has no whole-box setting in PDF: all of the text is underlined)
    const setUnder = (v: boolean) => fmt({ u: v || undefined }, () => richApi.current?.formatAll({ u: v || undefined }));
    const freeKeys = (e: React.KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (k === 'b' || k === 'i' || k === 'u')) {
        e.preventDefault(); e.stopPropagation();
        if (k === 'b') setBold(shown.bold !== true);
        else if (k === 'i') setItalic(shown.italic !== true);
        else setUnder(shown.underline !== true);
        return;
      }
      keys(e);
    };
    const colors: [number, number, number][] = [[0, 0, 0], [0.2, 0.2, 0.2], [0.85, 0.1, 0.1], [0.05, 0.3, 0.75], [0.0, 0.5, 0.25], [0.8, 0.45, 0.0], [0.035, 0.19, 0.184]];
    // above the box, clear of its top handles (those stay usable while typing). A turned box: above
    // what it covers turned (from its unturned frame the bar sat over the text of a box turned 90°)
    let bx = leftOf(pg) + r[0] * z, by0 = tops[pg] + r[1] * z, by1 = tops[pg] + r[3] * z;
    if (editor.angle) {
      const w = Math.max(60, (r[2] - r[0]) * z), h = Math.max(editor.size * z * 1.5, (r[3] - r[1]) * z);
      const a = (editor.angle * Math.PI) / 180, cx = bx + w / 2, cy = by0 + h / 2;
      const hx = Math.abs((w / 2) * Math.cos(a)) + Math.abs((h / 2) * Math.sin(a)), hy = Math.abs((w / 2) * Math.sin(a)) + Math.abs((h / 2) * Math.cos(a));
      bx = cx - hx; by0 = cy - hy; by1 = cy + hy;
    }
    const top = by0 - 52;
    const shownColor = css(shown.color || fontColor);
    return (
      <>
        <div className="edbar" ref={edbarRef} data-above={top < 4 ? undefined : '1'} style={{ left: bx, top: top < 4 ? by1 + 8 : top }} onMouseDown={(e) => e.preventDefault()}>
          {/* (custom drop-downs: a <select> here never opened - the bar stops mousedown so the
              text being typed keeps the keyboard) */}
          <FontPick value={shown.family ?? editor.family} mixed={!!edStyle && shown.family === undefined} onChange={(f) => fmt({ f }, () => void restyle({ family: f }))} />
          <BoldItalic bold={shown.bold === true} italic={shown.italic === true} underline={shown.underline === true}
            onChange={(p) => { if (p.bold !== undefined) setBold(p.bold); else if (p.italic !== undefined) setItalic(p.italic); else if (p.underline !== undefined) setUnder(p.underline); }} />
          <SizePick value={shown.size ?? editor.size} mixed={!!edStyle && shown.size === undefined} onChange={(n) => fmt({ s: n }, () => void restyle({ size: n }))} />
          <span className="sep" />
          {colors.map((c, i) => <button key={i} className={'sw' + (shown.color && css(c) === shownColor ? ' on' : '')} style={{ background: css(c) }} title="Text colour" onClick={() => fmt({ c }, () => void restyle({ color: c }))} />)}
          <span className="sep" />
          {(['left', 'centre', 'right'] as const).map((n, i) => <button key={n} className={'al' + ((editor.align ?? 0) === i ? ' on' : '')} title={'Align ' + n} onClick={() => void restyle({ align: i })}><span className={'al-' + i} /></button>)}
          <span className="sep" />
          <button className="done" title="Finish (Ctrl+Enter)" onClick={() => void commitEditor(editor, false, true)}>Done</button>
        </div>
        <RichBox key={editor.id ?? -1} apiRef={richApi} elRef={edRef} className={'ed rich ' + editor.kind}
          value={editor.value} runs={editor.runs} base={base} placeholder={editor.isNew ? 'Type here' : ''}
          style={{
            ...style,
            ...(editor.auto ? { width: 'max-content', height: undefined } : { height: undefined, minHeight: style.height }),
            // (left = where the text starts: Arabic starts on the right, like in the saved box -
            // each paragraph its own way, as in the file)
            fontFamily: fam, fontWeight: editor.bold ? 700 : 400, fontStyle: editor.italic ? 'italic' : 'normal', textAlign: (['start', 'center', 'right'] as const)[editor.align ?? 0], lineHeight: 1.2, padding: `${padTop}px ${padX}px ${padBottom}px`,
            background: editor.fill || 'transparent',
            boxShadow: `${bw > 0 ? `inset 0 0 0 ${Math.max(1, bw * z)}px ${editor.color}, ` : ''}0 0 0 1px var(--sel), 0 2px 12px rgba(0, 0, 0, 0.12)`,
            ['--phx' as string]: padX + 'px', ['--phy' as string]: padTop + 'px',
          }}
          onChange={(value, runs) => setEditor((cur) => (cur ? { ...cur, value, runs } : cur))}
          onSelStyle={(st) => { const k = JSON.stringify(st); if (k !== edStyleKey.current) { edStyleKey.current = k; setEdStyle(st); } }}
          onKeyDown={freeKeys}
          onBlur={() => { if (!blurByViewer.current) void commitEditor(editorNow.current || editor, false, true); }} />
      </>
    );
  };

  return (
    <div
      ref={scroller}
      className={'viewer' + (space || drag?.mode === 'pan' ? ' panning' : '')}
      tabIndex={0}
      onPointerDown={(e) => void onPointerDown(e)}
      onPointerMove={onPointerMove}
      onPointerLeave={() => { setHover(null); aidAt.current = null; paintAids(); }}
      onPointerUp={(e) => void onPointerUp(e)}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="vcontent" style={{ width: contentW, height: contentH }}>
        {visible.map((i) => {
          const pg = pages[i];
          const L = leftOf(i), T = tops[i];
          const W = pg.w * z, Hh = pg.h * z;
          const vis: [number, number, number, number] = [
            clamp((vp.left - L) / z, 0, pg.w), clamp((vp.top - T) / z, 0, pg.h),
            clamp((vp.left + vp.w - L) / z, 0, pg.w), clamp((vp.top + vp.h - T) / z, 0, pg.h),
          ];
          const onScreen = vis[2] > vis[0] && vis[3] > vis[1];
          const prio = onScreen ? Math.abs(T + Hh / 2 - (vp.top + vp.h / 2)) : 1e7 + Math.abs(T - vp.top);
          const list = annots[i];
          return (
            <div key={i} className="pg" style={{ left: L, top: T, width: W, height: Hh }} data-page={i}>
              <PageTiles
                doc={doc} page={i} w={pg.w} h={pg.h} z={z} dpr={dpr}
                vis={onScreen ? vis : [0, 0, 0, 0]}
                crev={doc.crev[i] ?? 0} annRev={doc.annRev[i] ?? 0}
                hasAnnots={!!list && list.some((a) => a.irt == null && a.type !== 'Popup' && a.type !== 'Highlight')}
                hasHighlights={!!list && list.some((a) => a.type === 'Highlight')}
                hide={hideFor(i)} prio={prio} tag={doc.id + ':' + i}
              />
              {ghostEls(i)}
              <svg className="ov" viewBox={`0 0 ${pg.w} ${pg.h}`} preserveAspectRatio="none">{overlay(i)}</svg>
            </div>
          );
        })}
        {editorEl()}
      </div>
      {tip && <div className="vtip" style={{ left: tip.x + (scroller.current?.scrollLeft ?? 0), top: tip.y + (scroller.current?.scrollTop ?? 0) }}>{tip.text}{snapMark && <span className="vtip-snap">{'  · ' + snapMark.k}</span>}</div>}
      {drawBar()}
      {snapMark && !tip && <div className="vtip snapk" style={{ left: leftOf(snapMark.page) + snapMark.p[0] * z + 12, top: tops[snapMark.page] + snapMark.p[1] * z + 12 }}>{snapMark.k}</div>}
      <div ref={xhH} className="xhair h" />
      <div ref={xhV} className="xhair v" />
      <canvas ref={loupeRef} className="loupe" />
    </div>
  );
}
