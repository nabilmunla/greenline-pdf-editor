// Reading one PDF page for export: the characters (with their fonts, sizes, colours), the
// ruled lines and shaded boxes tables are drawn with, pictures, other vector shapes and links.
import * as mupdf from 'mupdf';
import type { Box, FontInfo, Glyph, PageModel, Pic, Ruling, Word } from './model';
import { median } from './model';
import { fixChar, fontInfo } from './fonts';

type M = [number, number, number, number, number, number];
const tx = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

/** the fonts met so far in one export (Word needs one list) */
export class FontTable {
  list: FontInfo[] = [];
  private byKey = new Map<string, number>();
  private byPtr = new Map<number, number>();
  index(f: mupdf.Font): number {
    const ptr = (f as unknown as { pointer: number }).pointer;
    const known = this.byPtr.get(ptr);
    if (known !== undefined) return known;
    let raw = 'Arial', flags = { bold: false, italic: false, serif: false, mono: false };
    try { raw = f.getName(); flags = { bold: f.isBold(), italic: f.isItalic(), serif: f.isSerif(), mono: f.isMono() }; } catch { /* keep the defaults */ }
    // MuPDF's serif flag is unreliable for embedded fonts: only trust it when the name says nothing
    const info = fontInfo(raw, { ...flags, serif: false });
    const key = info.family + '|' + info.bold + '|' + info.italic;
    let i = this.byKey.get(key);
    if (i === undefined) { i = this.list.length; this.list.push(info); this.byKey.set(key, i); }
    this.byPtr.set(ptr, i);
    return i;
  }
  /** a plain font (OCR text) */
  plain(family = 'Arial', bold = false): number {
    const key = family + '|' + bold + '|false';
    let i = this.byKey.get(key);
    if (i === undefined) { i = this.list.length; this.list.push({ family, bold, italic: false, serif: /times/i.test(family), mono: false }); this.byKey.set(key, i); }
    return i;
  }
  /** pointers are only valid within one page */
  newPage() { this.byPtr.clear(); }
}

const rgbOf = (cs: mupdf.ColorSpace | null, c: number[] | undefined): number => {
  if (!c || !c.length) return 0;
  let r = 0, g = 0, b = 0;
  const n = cs ? cs.getNumberOfComponents() : c.length;
  if (n === 1) r = g = b = c[0];
  else if (n === 3) { r = c[0]; g = c[1]; b = c[2]; }
  else if (n === 4) { const k = c[3]; r = (1 - c[0]) * (1 - k); g = (1 - c[1]) * (1 - k); b = (1 - c[2]) * (1 - k); }
  else r = g = b = c[0] ?? 0;
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (q(r) << 16) | (q(g) << 8) | q(b);
};
const isWhite = (c: number) => ((c >> 16) & 255) > 242 && ((c >> 8) & 255) > 242 && (c & 255) > 242;

/** limits: a drawing sheet has hundreds of thousands of strokes - after this many we stop looking */
const MAX_SEGS = 60_000;

/**
 * mupdf.js hands a device its pictures without taking a reference (unlike paths, text and colour
 * spaces), yet the wrapper drops one when it is garbage-collected: MuPDF's memory then gets freed
 * twice and the engine dies later at a random moment ("memory access out of bounds"). The
 * wrapper is told to leave the picture alone - MuPDF still owns it.
 */
/** wrappers MuPDF lent a device are let go at once: a path inside a display list lives in the list's
 *  own memory, and a wrapper collected after the list is gone would write into freed memory */
function done(...xs: ({ destroy?: () => void } | null | undefined)[]) {
  for (const x of xs) try { x?.destroy?.(); } catch { /* already gone */ }
}
function borrowed(image: mupdf.Image) {
  try { (mupdf.Image as unknown as { _finalizer?: FinalizationRegistry<number> })._finalizer?.unregister(image); } catch { /* older / newer mupdf.js */ }
}

export interface ReadOpts { pictures: boolean; dpi: number; /** only this box of the page matters (Table area to Excel): line work outside it is not read - nor counted towards MAX_SEGS (a table on a busy drawing lost its ruled lines to the drawing's strokes) */ region?: Box }

export function readPage(doc: mupdf.Document, i: number, fonts: FontTable, o: ReadOpts): PageModel {
  fonts.newPage();
  const page = doc.loadPage(i);
  const pb = page.getBounds();
  const ox = pb[0], oy = pb[1];
  const W = pb[2] - pb[0], H = pb[3] - pb[1];
  const pm: PageModel = { i, w: W, h: H, kind: 'text', words: [], rulings: [], fills: [], pics: [], shapes: [], links: [], ocr: false, bodySize: 10 };
  const dl = page.toDisplayList(false);
  try {
    // ---------------------------------------------------------------- vectors, pictures, text modes
    const hidden: Box[] = [], filled: Box[] = [], stroked: Box[] = [];
    let segs = 0;
    const base: M = [1, 0, 0, 1, -ox, -oy];
    const addRuling = (r: Ruling) => { if (r.b - r.a > 1.5 && r.c > -2 && r.c < (r.o === 'h' ? H : W) + 2) pm.rulings.push(r); };
    /** a line piece counts towards MAX_SEGS - when an area was asked for, only one in it (a
     *  drawing's one huge hatch path spanning the sheet must not use up the count) */
    const count = (q: [number, number]) => { if (!o.region || (q[0] >= o.region[0] - 2 && q[0] <= o.region[2] + 2 && q[1] >= o.region[1] - 2 && q[1] <= o.region[3] + 2)) segs++; };
    const subpaths = (path: mupdf.Path, ctm: M) => {
      const m = mul(ctm as M, base);
      const out: { pts: [number, number][]; curve: boolean; closed: boolean }[] = [];
      let cur: { pts: [number, number][]; curve: boolean; closed: boolean } | null = null;
      path.walk({
        moveTo(x: number, y: number) { const q = tx(m, x, y); cur = { pts: [q], curve: false, closed: false }; out.push(cur); count(q); },
        lineTo(x: number, y: number) { if (!cur) { cur = { pts: [], curve: false, closed: false }; out.push(cur); } const q = tx(m, x, y); cur.pts.push(q); count(q); },
        curveTo(_x1: number, _y1: number, _x2: number, _y2: number, x3: number, y3: number) { if (!cur) { cur = { pts: [], curve: false, closed: false }; out.push(cur); } cur.curve = true; const q = tx(m, x3, y3); cur.pts.push(q); count(q); },
        closePath() { if (cur) { cur.closed = true; if (cur.pts.length) cur.pts.push(cur.pts[0]); } },
      });
      return out;
    };
    const bboxOf = (pts: [number, number][]): Box => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      return [x0, y0, x1, y1];
    };
    /** an axis-aligned rectangle (4 corners, maybe closed) */
    const rectOf = (sp: { pts: [number, number][]; curve: boolean }): Box | null => {
      if (sp.curve) return null;
      let p = sp.pts;
      if (p.length === 5 && Math.abs(p[0][0] - p[4][0]) < 0.01 && Math.abs(p[0][1] - p[4][1]) < 0.01) p = p.slice(0, 4);
      if (p.length !== 4) return null;
      for (let k = 0; k < 4; k++) {
        const a = p[k], b = p[(k + 1) % 4];
        if (Math.abs(a[0] - b[0]) > 0.05 && Math.abs(a[1] - b[1]) > 0.05) return null;
      }
      return bboxOf(p);
    };
    const tooMany = () => segs > MAX_SEGS;
    const R = o.region;
    const anyStroke = R ? new mupdf.StrokeState({ lineCap: 'Butt', lineJoin: 'Miter', lineWidth: 1, miterLimit: 10, dashPhase: 0, dashes: [] } as never) : null;
    /** the path is (partly) in the region asked for - or no region was asked for */
    const inRegion = (path: mupdf.Path, ctm: number[]) => {
      if (!R) return true;
      try {
        const b = path.getBounds(anyStroke!, mul(ctm as M, base) as never);
        return b[2] >= R[0] - 2 && b[0] <= R[2] + 2 && b[3] >= R[1] - 2 && b[1] <= R[3] + 2;
      } catch { return true; }
    };
    const mDet = (m: M) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const picFrom = (box: Box, draw: (dev: mupdf.Device, m: M) => void) => {
      const bw = box[2] - box[0], bh = box[3] - box[1];
      if (bw < 2 || bh < 2) return;
      const area = bw * bh;
      const full = area > W * H * 0.6 && bw > W * 0.6;
      const pic: Pic = { box, full };
      pm.pics.push(pic);
      if (!o.pictures || full || bw < 6 || bh < 6) return;
      try {
        const s = o.dpi / 72;
        const tw = Math.max(1, Math.min(4000, Math.round(bw * s))), th = Math.max(1, Math.min(4000, Math.round(bh * s)));
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, tw, th], false);
        pix.clear(255);
        const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
        // page space -> picture pixels
        draw(dev, [tw / bw, 0, 0, th / bh, -box[0] * tw / bw, -box[1] * th / bh]);
        dev.close();
        const big = tw * th > 300_000;
        pic.data = (big ? pix.asJPEG(88) : pix.asPNG()).slice();
        pic.ext = big ? 'jpeg' : 'png';
        dev.destroy?.();
        pix.destroy?.();
      } catch { /* a picture MuPDF can't draw: left out */ }
    };
    const tbounds = (t: mupdf.Text, ctm: M): Box | null => {
      try { const b = t.getBounds(null as unknown as mupdf.StrokeState, ctm); return [b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy]; } catch { return null; }
    };
    const dev = new mupdf.Device({
      fillPath(path: mupdf.Path, _eo: boolean, ctm: number[], cs: mupdf.ColorSpace, color: number[], alpha: number) {
        try { fillPath(path, ctm, cs, color, alpha); } finally { done(path, cs); }
      },
      strokePath(path: mupdf.Path, stroke: mupdf.StrokeState, ctm: number[], cs: mupdf.ColorSpace, color: number[], alpha: number) {
        try { strokePath(path, stroke, ctm, cs, color, alpha); } finally { done(path, stroke, cs); }
      },
      fillImage(image: mupdf.Image, ctm: number[], alpha: number) {
        borrowed(image);
        if (alpha < 0.15) return;
        const m = mul(ctm as M, base);
        const box = bboxOf([tx(m, 0, 0), tx(m, 1, 0), tx(m, 0, 1), tx(m, 1, 1)]);
        picFrom(box, (d, pm2) => d.fillImage(image, mul(ctm as M, mul(base, pm2)), 1));
      },
      fillImageMask(image: mupdf.Image, ctm: number[], cs: mupdf.ColorSpace, color: number[], alpha: number) {
        borrowed(image);
        try {
          if (alpha < 0.15) return;
          const m = mul(ctm as M, base);
          const box = bboxOf([tx(m, 0, 0), tx(m, 1, 0), tx(m, 0, 1), tx(m, 1, 1)]);
          picFrom(box, (d, pm2) => d.fillImageMask(image, mul(ctm as M, mul(base, pm2)), cs, color as never, 1));
        } finally { done(cs); }
      },
      fillText(t: mupdf.Text, ctm: number[], cs: mupdf.ColorSpace) { try { const b = tbounds(t, ctm as M); if (b) filled.push(b); } finally { done(t, cs); } },
      strokeText(t: mupdf.Text, s: mupdf.StrokeState, ctm: number[], cs: mupdf.ColorSpace) { try { const b = tbounds(t, ctm as M); if (b) stroked.push(b); } finally { done(t, s, cs); } },
      ignoreText(t: mupdf.Text, ctm: number[]) { try { const b = tbounds(t, ctm as M); if (b) hidden.push(b); } finally { done(t); } },
      clipText(t: mupdf.Text, ctm: number[]) { try { const b = tbounds(t, ctm as M); if (b) hidden.push(b); } finally { done(t); } },
    } as never);
    function fillPath(path: mupdf.Path, ctm: number[], cs: mupdf.ColorSpace, color: number[], alpha: number) {
        if (tooMany() || alpha < 0.15 || !inRegion(path, ctm)) return;
        const col = rgbOf(cs, color);
        for (const sp of subpaths(path, ctm as M)) {
          if (sp.pts.length < 2) continue;
          const r = rectOf(sp);
          const bb = r || bboxOf(sp.pts);
          const bw = bb[2] - bb[0], bh = bb[3] - bb[1];
          if (r && !isWhite(col)) {
            if (bh <= 2.6 && bw > bh * 3) { addRuling({ o: 'h', c: (bb[1] + bb[3]) / 2, a: bb[0], b: bb[2], w: Math.max(0.1, bh), color: col }); continue; }
            if (bw <= 2.6 && bh > bw * 3) { addRuling({ o: 'v', c: (bb[0] + bb[2]) / 2, a: bb[1], b: bb[3], w: Math.max(0.1, bw), color: col }); continue; }
            if (bw * bh < W * H * 0.9) pm.fills.push({ box: bb, color: col });
            continue;
          }
          if (r) continue; // white boxes: page backgrounds and masks
          if (bw * bh > 0.5 && !isWhite(col)) pm.shapes.push(bb);
        }
    }
    function strokePath(path: mupdf.Path, stroke: mupdf.StrokeState, ctm: number[], cs: mupdf.ColorSpace, color: number[], alpha: number) {
        if (tooMany() || alpha < 0.15 || !inRegion(path, ctm)) return;
        const col = rgbOf(cs, color);
        if (isWhite(col)) return;
        let lw = 1;
        try { lw = Math.max(0.1, stroke.getLineWidth() * mDet(ctm as M)); } catch { /* 1 */ }
        for (const sp of subpaths(path, ctm as M)) {
          if (sp.curve) { pm.shapes.push(bboxOf(sp.pts)); continue; }
          let odd = false;
          for (let k = 1; k < sp.pts.length; k++) {
            const [x0, y0] = sp.pts[k - 1], [x1, y1] = sp.pts[k];
            const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
            if (dy <= Math.max(0.6, dx * 0.01) && dx > 0.5) addRuling({ o: 'h', c: (y0 + y1) / 2, a: Math.min(x0, x1), b: Math.max(x0, x1), w: lw, color: col });
            else if (dx <= Math.max(0.6, dy * 0.01) && dy > 0.5) addRuling({ o: 'v', c: (x0 + x1) / 2, a: Math.min(y0, y1), b: Math.max(y0, y1), w: lw, color: col });
            else if (dx > 0.5 || dy > 0.5) odd = true;
          }
          if (odd) pm.shapes.push(bboxOf(sp.pts));
        }
    }
    dl.run(dev, mupdf.Matrix.identity);
    dev.close();
    dev.destroy?.();
    const heavy = segs > MAX_SEGS;

    // ---------------------------------------------------------------- characters
    const st = dl.toStructuredText('');
    const inAny = (bs: Box[], x: number, y: number) => { for (const b of bs) if (x >= b[0] - 0.5 && x <= b[2] + 0.5 && y >= b[1] - 0.5 && y <= b[3] + 0.5) return true; return false; };
    let hiddenN = 0, visibleN = 0;
    let line: Glyph[] = [];
    let lineTurn = 0;
    const lines: { g: Glyph[]; turn: number; hidden: boolean }[] = [];
    let lastG: Glyph | null = null;
    let inWidget = false;
    const walker = {
      beginLine(_b: number[], _wm: number, dir: number[]) {
        line = [];
        lastG = null;
        const [dx, dy] = dir;
        lineTurn = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : dy > 0 ? 1 : 3;
      },
      onChar(c: string, origin: number[], font: mupdf.Font, size: number, quad: number[], color: number[], bidi: number) {
        const ch = fixChar(c);
        if (!ch) return;
        const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
        const f = fonts.index(font);
        const g: Glyph = {
          c: ch, x0: Math.min(...xs) - ox, y0: Math.min(...ys) - oy, x1: Math.max(...xs) - ox, y1: Math.max(...ys) - oy,
          base: origin[1] - oy, size, f, color: rgbOf(null, color as number[]), rtl: (bidi & 1) === 1,
        };
        if (fonts.list[f].bold) g.bold = true;
        if (lineTurn === 1 || lineTurn === 3) g.base = origin[0] - ox;
        // the same character printed twice on top of itself: fake bold
        const lg = lastG as Glyph | null;
        if (lg && lg.c === ch && ch !== ' ' && Math.abs(lg.x0 - g.x0) < 0.6 && Math.abs(lg.y0 - g.y0) < 0.6) { lg.bold = true; return; }
        line.push(g);
        lastG = g;
      },
      endLine() {
        if (!line.length) return;
        // hidden text (a scan's OCR layer)?
        const mid = line[Math.floor(line.length / 2)];
        const cx = (mid.x0 + mid.x1) / 2, cy = (mid.y0 + mid.y1) / 2;
        const isHidden = !inWidget && hidden.length > 0 && inAny(hidden, cx, cy) && !inAny(filled, cx, cy) && !inAny(stroked, cx, cy);
        if (!isHidden && stroked.length && inAny(stroked, cx, cy) && inAny(filled, cx, cy)) for (const g of line) g.bold = true;
        const n = line.filter((g) => g.c.trim()).length;
        if (isHidden) hiddenN += n; else visibleN += n;
        lines.push({ g: line, turn: lineTurn, hidden: isHidden });
      },
    };
    st.walk(walker as never);
    st.destroy?.();

    // ---------------------------------------------------------------- filled-in form fields
    // (their values are drawn by the fields, not the page: read from each field's own drawing)
    try {
      const widgets = ((page as mupdf.PDFPage).getWidgets?.() ?? []) as mupdf.PDFWidget[];
      inWidget = true;
      for (const w of widgets) {
        try {
          const r = w.getRect();
          const box: Box = [r[0] - ox, r[1] - oy, r[2] - ox, r[3] - oy];
          if (w.isCheckbox() || w.isRadioButton()) {
            // the widget's own state (/AS): a radio group's value is the chosen option, shared by
            // every option of the group - read from it, every option came out ticked
            let on = false;
            try { const as = w.getObject().get('AS'); on = as.isName() ? as.asName() !== 'Off' : (() => { const v = w.getValue(); return !!v && v !== 'Off'; })(); } catch { /* not ticked */ }
            if (!on) continue;
            const h = box[3] - box[1], size = Math.max(6, Math.min(12, h * 0.8));
            const g: Glyph = { c: '☑', x0: box[0], y0: box[3] - size, x1: box[0] + size, y1: box[3], base: box[3] - size * 0.15, size, f: fonts.plain('Segoe UI Symbol'), color: 0, rtl: false };
            lines.push({ g: [g], turn: 0, hidden: false });
            visibleN++;
            continue;
          }
          if (!String(w.getValue() ?? '').trim()) continue;
          const wdl = (w as unknown as mupdf.PDFAnnotation).toDisplayList();
          try { const wst = wdl.toStructuredText(''); try { wst.walk(walker as never); } finally { wst.destroy?.(); } } finally { wdl.destroy?.(); }
        } catch { /* a field MuPDF can't draw */ }
      }
    } catch { /* not a PDF page */ } finally { inWidget = false; }

    // ---------------------------------------------------------------- text that isn't seen
    // the same letter printed twice over itself in separate pieces of text (fake bold, a copy
    // of the line): once, bold
    {
      const seen = new Map<string, Glyph>();
      const key = (c: string, x: number, y: number) => c + '|' + x + '|' + y;
      for (const l of lines) {
        if (l.hidden) continue;
        const own = new Set<Glyph>();
        l.g = l.g.filter((g) => {
          if (!g.c.trim()) return true;
          const kx = Math.round(g.x0 * 2), ky = Math.round(g.y0 * 2);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const o = seen.get(key(g.c, kx + dx, ky + dy));
            if (o && !own.has(o) && Math.abs(o.x0 - g.x0) < 0.6 && Math.abs(o.y0 - g.y0) < 0.6 && Math.abs(o.size - g.size) < 0.5) { o.bold = true; visibleN--; return false; }
          }
          seen.set(key(g.c, kx, ky), g);
          own.add(g);
          return true;
        });
      }
      // white letters with nothing coloured under them (hidden notes, white-on-white keywords)
      const under = [...pm.fills.map((f) => f.box), ...pm.pics.map((p) => p.box), ...pm.shapes];
      for (const l of lines) {
        if (l.hidden) continue;
        l.g = l.g.filter((g) => {
          if (!isWhite(g.color) || !g.c.trim()) return true;
          const cx = (g.x0 + g.x1) / 2, cy = (g.y0 + g.y1) / 2;
          if (inAny(under, cx, cy)) return true;
          visibleN--;
          return false;
        });
      }
      for (let k = lines.length - 1; k >= 0; k--) if (!lines[k].g.length) lines.splice(k, 1);
    }

    // ---------------------------------------------------------------- a page printed sideways
    // (a landscape table on a portrait page): turned so its text reads across, like the page as
    // printed - otherwise every word is turned and left out
    const byTurn = [0, 0, 0, 0];
    for (const l of lines) if (!l.hidden) byTurn[l.turn] += l.g.length;
    const tot = byTurn.reduce((a, b) => a + b, 0);
    const turn = [1, 2, 3].find((t) => byTurn[t] >= Math.max(20, tot * 0.6)) ?? 0;
    let T: ((x: number, y: number) => [number, number]) | null = null;
    if (turn) {
      const W0 = W, H0 = H;
      T = turn === 1 ? (x, y) => [y, W0 - x] : turn === 3 ? (x, y) => [H0 - y, x] : (x, y) => [W0 - x, H0 - y];
      const tb = (b: Box): Box => { const [a, c] = T!(b[0], b[1]), [d, e] = T!(b[2], b[3]); return [Math.min(a, d), Math.min(c, e), Math.max(a, d), Math.max(c, e)]; };
      for (const l of lines) {
        for (const g of l.g) {
          const [x0, y0, x1, y1] = tb([g.x0, g.y0, g.x1, g.y1]);
          // (the baseline: across the text, so it moves with the turn)
          const base = l.turn === 1 || l.turn === 3 ? (turn === 1 ? W0 - g.base : turn === 3 ? g.base : g.base) : turn === 2 ? H0 - g.base : g.base;
          Object.assign(g, { x0, y0, x1, y1, base });
        }
        l.turn = (l.turn - turn + 4) % 4;
        // reading order inside the line stays MuPDF's
      }
      pm.rulings = pm.rulings.map((r) => {
        const [p, q] = r.o === 'h' ? [T!(r.a, r.c), T!(r.b, r.c)] : [T!(r.c, r.a), T!(r.c, r.b)];
        return Math.abs(p[0] - q[0]) < Math.abs(p[1] - q[1])
          ? { ...r, o: 'v' as const, c: (p[0] + q[0]) / 2, a: Math.min(p[1], q[1]), b: Math.max(p[1], q[1]) }
          : { ...r, o: 'h' as const, c: (p[1] + q[1]) / 2, a: Math.min(p[0], q[0]), b: Math.max(p[0], q[0]) };
      });
      for (const f of pm.fills) f.box = tb(f.box);
      // (pictures were drawn the old way up: their places are kept, not their pixels)
      for (const pc of pm.pics) { pc.box = tb(pc.box); delete pc.data; }
      pm.shapes = pm.shapes.map(tb);
      if (turn !== 2) { pm.w = H0; pm.h = W0; }
      pm.turned = { turn: turn as 1 | 2 | 3, w: W0, h: H0 };
    }

    // ---------------------------------------------------------------- page kind
    const fullPic = pm.pics.some((p) => p.full);
    // a scan with a line or two typed on it afterwards (a footer, a received stamp) is still a scan
    let visArea = 0;
    for (const l of lines) if (!l.hidden && l.g.length) { const b = boxOfG(l.g); visArea += (b[2] - b[0]) * (b[3] - b[1]); }
    if (fullPic && (visibleN < 25 || (visibleN < 400 && visArea < W * H * 0.06))) {
      pm.kind = 'scan';
      pm.ocr = true;
    } else if (heavy || (pm.shapes.length + pm.rulings.length > 4000 && visibleN < (pm.shapes.length + pm.rulings.length) / 4)) {
      pm.kind = 'drawing';
    } else if (!visibleN && !hiddenN && !pm.pics.length && !pm.rulings.length && !pm.shapes.length) pm.kind = 'empty';
    // a scan's text layer stands in for reading it again; on other pages hidden text is left out
    const keep = lines.filter((l) => (pm.kind === 'scan' ? l.hidden : !l.hidden));
    for (const l of keep) pm.words.push(...wordsOf(l.g, l.turn));
    if (pm.kind === 'scan') { pm.rulings = []; pm.fills = []; pm.shapes = []; }
    pm.bodySize = bodySizeOf(pm.words);

    // ---------------------------------------------------------------- links
    try {
      for (const ln of page.getLinks()) {
        try {
          if (!ln.isExternal()) continue;
          const b = ln.getBounds();
          const uri = safeUri(ln.getURI());
          let box: Box = [b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy];
          if (T) { const [a, c] = T(box[0], box[1]), [d, e] = T(box[2], box[3]); box = [Math.min(a, d), Math.min(c, e), Math.max(a, d), Math.max(c, e)]; }
          if (uri) pm.links.push({ box, uri });
        } catch { /* skip */ }
      }
    } catch { /* none */ }
  } finally {
    dl.destroy?.();
    page.destroy?.();
  }
  return pm;
}

/** a link Word can take: web, mail, ftp or file only (no scripts), characters a URL can't hold
 *  percent-encoded, not absurdly long */
export function safeUri(raw: string): string | null {
  let u = String(raw || '').trim();
  if (/^www\./i.test(u)) u = 'http://' + u;
  const m = /^(https?|mailto|ftp|file):/i.exec(u);
  if (!m) return null;
  if (m[1].toLowerCase() === 'file') u = u.replace(/\\/g, '/');
  u = u.replace(/%(?![0-9a-f]{2})/gi, '%25').replace(/[\s"<>{}|\\^`\u0000-\u001f\u007f]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase());
  return u.length > 2000 ? null : u;
}

function boxOfG(gs: Glyph[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of gs) { if (g.x0 < x0) x0 = g.x0; if (g.y0 < y0) y0 = g.y0; if (g.x1 > x1) x1 = g.x1; if (g.y1 > y1) y1 = g.y1; }
  return [x0, y0, x1, y1];
}

export function bodySizeOf(words: Word[]): number {
  const counts = new Map<number, number>();
  for (const w of words) { const k = Math.round(w.size * 2) / 2; counts.set(k, (counts.get(k) ?? 0) + w.text.length); }
  let best = 10, n = -1;
  for (const [k, v] of counts) if (v > n) { n = v; best = k; }
  return best;
}

const ALEF = new Set(['ا', 'أ', 'إ', 'آ']);

/** one MuPDF line's characters -> words (split at spaces and wide gaps) */
export function wordsOf(gs: Glyph[], turn: number): Word[] {
  // lam-alef ligatures come out as alef (zero width) + lam: logical order is lam, alef
  for (let k = 0; k + 1 < gs.length; k++) {
    const a = gs[k], b = gs[k + 1];
    if (ALEF.has(a.c) && b.c === 'ل' && a.x1 - a.x0 < 0.2) { gs[k] = b; gs[k + 1] = a; k++; }
  }
  const out: Word[] = [];
  let cur: Glyph[] = [];
  const flush = () => {
    if (!cur.length) return;
    const g = cur;
    cur = [];
    const text = g.map((x) => x.c).join('');
    if (!text.trim()) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of g) { if (q.x0 < x0) x0 = q.x0; if (q.y0 < y0) y0 = q.y0; if (q.x1 > x1) x1 = q.x1; if (q.y1 > y1) y1 = q.y1; }
    const sizes = g.map((q) => q.size);
    const size = median(sizes);
    const rtl = g.filter((q) => q.rtl).length > g.length / 2;
    // baseline of the word: its full-size characters'
    const full = g.filter((q) => q.size >= size * 0.9);
    const base = median(full.map((q) => q.base));
    out.push({ text, x0, y0, x1, y1, base, size, g, rtl, leader: /^[.·…_]{4,}$/.test(text) || undefined, turn: turn || undefined });
  };
  for (let k = 0; k < gs.length; k++) {
    const g = gs[k];
    if (/\s/.test(g.c)) { flush(); continue; }
    const p = cur[cur.length - 1];
    if (p && !turn) {
      // a gap wider than a space between letters of one "word": two words (measured from the
      // word so far - a ligature's zero-width part sits at its far end)
      const gap = g.rtl && p.rtl ? Math.min(...cur.map((q) => q.x0)) - g.x1 : g.x0 - Math.max(...cur.map((q) => q.x1));
      if (gap > Math.max(p.size, g.size) * 0.3 || gap < -Math.max(p.size, g.size) * 1.5 || Math.abs(g.base - p.base) > Math.max(p.size, g.size) * 0.9) flush();
      // a run of leader dots against a word
      else if ((g.c === '.') !== (p.c === '.') && cur.length >= 4 && cur.slice(-4).every((q) => q.c === '.')) flush();
    }
    cur.push(g);
  }
  flush();
  return out;
}
