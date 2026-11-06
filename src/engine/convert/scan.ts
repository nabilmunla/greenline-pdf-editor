// Scanned pages: the words come from OCR (in the window); here the page picture is drawn
// straightened, the table lines are found in it, words in coloured ink (rubber stamps, blue
// pen) can be left out, and bold words are told apart by how much ink they hold.
import * as mupdf from 'mupdf';
import type { ExportOpts, Glyph, PageModel, Ruling, Word } from './model';
import { clamp, median } from './model';
import type { FontTable } from './extract';

export interface OcrIn { words: { text: string; box: number[]; conf: number }[]; angle: number }

const DPI = 200;

export function ocrPage(doc: mupdf.Document, pm: PageModel, o: OcrIn, fonts: FontTable, opts: ExportOpts): PageModel {
  const s = DPI / 72;
  const W = pm.w, H = pm.h;
  const a = o.angle || 0;
  const cx = W / 2, cy = H / 2;
  const ca = Math.cos(a), sa = Math.sin(a);
  /** original page point -> straightened page point */
  const fwd = (x: number, y: number): [number, number] => [cx + (x - cx) * ca - (y - cy) * sa, cy + (x - cx) * sa + (y - cy) * ca];
  // ---------------------------------------------------------------- the picture, straightened
  const pw = Math.round(W * s), ph = Math.round(H * s);
  let rgb: Uint8ClampedArray | null = null;
  try {
    const page = doc.loadPage(pm.i);
    const b = page.getBounds();
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, pw, ph], false);
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    // page -> origin at the page corner -> turn about the centre -> pixels
    let m = mupdf.Matrix.translate(-b[0] - cx, -b[1] - cy);
    m = mupdf.Matrix.concat(m, mupdf.Matrix.rotate((a * 180) / Math.PI));
    m = mupdf.Matrix.concat(m, mupdf.Matrix.translate(cx, cy));
    m = mupdf.Matrix.concat(m, mupdf.Matrix.scale(s, s));
    page.run(dev, m);
    dev.close();
    const n = pix.getNumberOfComponents(), src = pix.getPixels();
    rgb = new Uint8ClampedArray(pw * ph * 3);
    for (let i = 0, j = 0; i < pw * ph; i++, j += n) { rgb[i * 3] = src[j]; rgb[i * 3 + 1] = src[j + 1]; rgb[i * 3 + 2] = src[j + 2]; }
    dev.destroy?.();
    pix.destroy?.();
    page.destroy?.();
  } catch { rgb = null; }
  const ink = new Uint8Array(pw * ph); // 1 dark neutral, 2 coloured ink
  if (rgb) {
    for (let i = 0; i < pw * ph; i++) {
      const r = rgb[i * 3], g = rgb[i * 3 + 1], bl = rgb[i * 3 + 2];
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      const lum = (r * 77 + g * 150 + bl * 29) >> 8;
      if (lum < 165) ink[i] = mx - mn > 55 && mx > 70 ? 2 : 1;
    }
  }
  const rulings = rgb ? findLines(ink, pw, ph, s) : [];
  // ---------------------------------------------------------------- words
  const words: Word[] = [];
  const dens: number[] = [];
  const colourOf = new Map<Word, number>();
  const plain = fonts.plain('Arial', false), bold = fonts.plain('Arial', true);
  // the page's language: Arabic "words" read out of noise on an English page are dropped
  // (counted on the words read with confidence: noise read as Arabic is plentiful but unsure)
  const sure = o.words.filter((w) => w.conf >= 80 && w.text.trim().length > 1);
  const latin = sure.filter((w) => /[A-Za-z]/.test(w.text)).length, arabic = sure.filter((w) => /[\u0600-\u06ff]/.test(w.text)).length;
  const english = latin > (latin + arabic) * 0.85;
  for (const w of o.words) {
    // table lines read as letters: "|", "[", "]" at the ends of words or on their own
    // (Tesseract wraps Arabic in invisible direction marks: left out, they only get in the way of searching)
    const t = w.text.replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim().replace(/^[|[\]{}]+|[|[\]{}]+$/g, '');
    if (!t || w.conf < 20) continue;
    if (/^[|[\]{}!:;'"`~_=.,«»]+$/.test(t)) continue;
    // specks and line ends read as a letter: one character, read with little confidence
    if (t.length === 1 && w.conf < 75 && !/^[-–—A-Z]$/.test(t)) continue;
    if (english && /[\u0600-\u06ff]/.test(t) && (w.conf < 88 || t.replace(/[^\u0600-\u06ff]/g, '').length <= 3)) continue;
    const [x0o, y0o, x1o, y1o] = w.box;
    // a letter or digit less than 2.5 pt tall (under 1 mm) is a speck or a line read as text
    // (dashes are short: "-" in an amount column means nil)
    if (y1o - y0o < 2.5 && /[\p{L}\p{N}]/u.test(t)) continue;
    const [mx, my] = fwd((x0o + x1o) / 2, (y0o + y1o) / 2);
    const bw = x1o - x0o, bh = y1o - y0o;
    const k = Math.abs(sa);
    const ww = Math.max(bw * 0.6, bw - bh * k), hh = Math.max(bh * 0.6, bh - bw * k);
    const box = [mx - ww / 2, my - hh / 2, mx + ww / 2, my + hh / 2];
    // ink inside: coloured (stamp / pen) or how heavy
    let n = 0, col = 0, cr = 0, cg = 0, cb = 0;
    if (rgb) {
      const X0 = clamp(Math.floor(box[0] * s), 0, pw - 1), X1 = clamp(Math.ceil(box[2] * s), 0, pw - 1);
      const Y0 = clamp(Math.floor(box[1] * s), 0, ph - 1), Y1 = clamp(Math.ceil(box[3] * s), 0, ph - 1);
      for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) { const i = y * pw + x, v = ink[i]; if (v) { n++; if (v === 2) { col++; cr += rgb[i * 3]; cg += rgb[i * 3 + 1]; cb += rgb[i * 3 + 2]; } } }
      // stroke width: the typical length of ink runs across the letters' middle band
      const runs: number[] = [];
      const ya = Math.round(Y0 + (Y1 - Y0) * 0.3), yb = Math.round(Y0 + (Y1 - Y0) * 0.75);
      for (let y = ya; y <= yb; y += 2) {
        let r = 0;
        for (let x = X0; x <= X1 + 1; x++) { if (x <= X1 && ink[y * pw + x]) r++; else if (r) { runs.push(r); r = 0; } }
      }
      // (mean of the ordinary runs: a median of a few small whole numbers is too coarse)
      const m = median(runs);
      const ok = runs.filter((r) => r <= m * 2.5);
      dens.push(ok.length >= 4 ? ok.reduce((a, b) => a + b, 0) / ok.length : 0);
    }
    const asc = /[A-Z0-9bdfhiklt'"()\/\[\]{}|!?%&#@$]/.test(t), desc = /[gjpqy,;()[\]{}|]/.test(t);
    const rtlW = /[֐-ࣿ]/.test(t);
    // (Arabic: most words reach above and below the line - a word's box is about its size tall)
    const sizeH = clamp(hh / (rtlW ? 0.95 : asc && desc ? 0.92 : asc ? 0.72 : desc ? 0.72 : 0.52), 5, 40);
    // from the width: the size at which Arial takes the same room (the text then wraps in Word
    // as it does on the page)
    const em = arialEm(t);
    const size = t.length >= 3 && em > 0.8 && /^[\x20-\x7e]+$/.test(t) ? clamp((ww * 1.04) / em, sizeH * 0.75, sizeH * 1.25) : sizeH;
    const base = box[3] - (desc ? sizeH * 0.21 : 0);
    const rtl = /[֐-ࣿ]/.test(t);
    const wd: Word = { text: t, x0: box[0], y0: box[1], x1: box[2], y1: box[3], base, size, g: [], rtl, conf: w.conf };
    // coloured ink: its colour (a blue heading stays blue) - stamps are sorted out below
    if (n > 6 && col > n * 0.5) colourOf.set(wd, ((Math.round(cr / col) & 255) << 16) | ((Math.round(cg / col) & 255) << 8) | (Math.round(cb / col) & 255));
    // stroke width against the size (bold letters have thicker strokes for their size)
    (wd as Word & { dens?: number }).dens = rgb && dens.length ? dens[dens.length - 1] / (sizeH * s) : 0;
    words.push(wd);
  }
  // coloured words that stand alone away from the text margin: a stamp or a pen - left out
  if (opts.dropStamps !== false && colourOf.size) {
    // where lines start (the margin, indents)
    const lefts = new Map<number, number>();
    const sorted = words.filter((w) => !colourOf.has(w)).sort((a, b) => a.base - b.base);
    for (let i = 0; i < sorted.length;) {
      let j = i + 1;
      while (j < sorted.length && Math.abs(sorted[j].base - sorted[i].base) < sorted[i].size * 0.4) j++;
      const k = Math.round(Math.min(...sorted.slice(i, j).map((w) => w.x0)) / 4);
      lefts.set(k, (lefts.get(k) ?? 0) + 1);
      i = j;
    }
    const margins = [...lefts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k * 4);
    /** the slope of a word's coloured ink (printed text is level once the page is straight; a
     *  stamp is pressed on by hand, at a slant) - degrees, null if too short to tell */
    const slant = (w: Word): number | null => {
      if (!rgb || w.text.length < 6 || w.x1 - w.x0 < w.size * 3) return null;
      const X0 = Math.round(w.x0 * s), X1 = Math.round(w.x1 * s), Y0 = Math.max(0, Math.round(w.y0 * s)), Y1 = Math.min(ph - 1, Math.round(w.y1 * s));
      const third = Math.max(2, Math.floor((X1 - X0) / 3));
      const bottoms = (a: number, b: number) => {
        const ys: number[] = [];
        for (let x = a; x < b; x++) for (let y = Y1; y >= Y0; y--) if (ink[y * pw + x] === 2) { ys.push(y); break; }
        return ys.length >= 3 ? median(ys) : null;
      };
      const l = bottoms(X0, X0 + third), r = bottoms(X1 - third, X1);
      if (l === null || r === null) return null;
      return (Math.atan2(r - l, X1 - X0 - third) * 180) / Math.PI;
    };
    const drop = new Set<Word>();
    for (const w of colourOf.keys()) {
      const line = words.filter((x) => Math.abs(x.base - w.base) < w.size * 0.5);
      const black = line.some((x) => !colourOf.has(x));
      const x0 = Math.min(...line.map((x) => x.x0));
      const atMargin = margins.some((m) => Math.abs(x0 - m) < 8);
      const c = colourOf.get(w)!;
      const lum = (((c >> 16) & 255) * 77 + ((c >> 8) & 255) * 150 + (c & 255) * 29) / 256;
      const a = slant(w);
      // a stamp: slanted, very light ink, or on its own away from the text
      if ((a !== null && Math.abs(a) > 2.5) || lum >= 140 || (!black && !atMargin)) drop.add(w);
    }
    // short words of a stamp go with it
    for (const w of colourOf.keys()) if (!drop.has(w) && [...drop].some((d) => Math.abs(d.base - w.base) < d.size * 1.5 && Math.min(Math.abs(d.x0 - w.x1), Math.abs(w.x0 - d.x1)) < d.size * 2 && w.x1 - w.x0 < w.size * 2.5)) drop.add(w);
    if (drop.size) for (let k = words.length - 1; k >= 0; k--) if (drop.has(words[k])) { words.splice(k, 1); }
  }
  // bold: clearly thicker strokes than most words
  const ref = median(words.filter((w) => w.text.length >= 3 && ((w as Word & { dens?: number }).dens ?? 0) > 0).map((w) => (w as Word & { dens?: number }).dens ?? 0));
  const boldOf = new Map<Word, boolean>();
  for (const w of words) { const d = (w as Word & { dens?: number }).dens ?? 0; boldOf.set(w, ref > 0 && w.text.length >= 2 && d > ref * 1.3); }
  // a line is usually all bold or all plain: go with most of its letters (stray words flip)
  const byLine = [...words].sort((a, b) => a.base - b.base);
  for (let i = 0; i < byLine.length;) {
    let j = i + 1;
    while (j < byLine.length && Math.abs(byLine[j].base - byLine[i].base) < byLine[i].size * 0.4) j++;
    const line = byLine.slice(i, j);
    const tot = line.reduce((n, w) => n + w.text.length, 0), b = line.reduce((n, w) => n + (boldOf.get(w) ? w.text.length : 0), 0);
    if (line.length >= 2 && b >= tot * 0.6) for (const w of line) boldOf.set(w, true);
    else if (line.length >= 3 && b <= tot * 0.25) for (const w of line) boldOf.set(w, false);
    i = j;
  }
  // Arabic words' heights vary with their letters (tall alef, deep descenders): a line of them gets
  // one size, the middle of their estimates
  for (let i = 0; i < byLine.length;) {
    let j = i + 1;
    while (j < byLine.length && Math.abs(byLine[j].base - byLine[i].base) < byLine[i].size * 0.4) j++;
    const ar = byLine.slice(i, j).filter((w) => w.rtl);
    if (ar.length) { const m = Math.round(median(ar.map((w) => w.size)) * 2) / 2; for (const w of ar) w.size = m; }
    i = j;
  }
  for (const w of words) {
    const isBold = !!boldOf.get(w);
    // letters spread over the word's width (style per letter: underlines)
    const chars = [...w.text];
    const cw = (w.x1 - w.x0) / Math.max(1, chars.length);
    const colour = colourOf.get(w) ?? 0;
    w.g = chars.map((c, i): Glyph => ({ c, x0: w.x0 + i * cw, y0: w.y0, x1: w.x0 + (i + 1) * cw, y1: w.y1, base: w.base, size: w.size, f: isBold ? bold : plain, color: colour, rtl: w.rtl, bold: isBold || undefined }));
    // right to left: the letters stay in reading order (as a typed PDF gives them), placed from the right
    if (w.rtl) w.g.forEach((g, i) => { g.x1 = w.x1 - i * cw; g.x0 = g.x1 - cw; });
    delete (w as Word & { dens?: number }).dens;
  }
  void dens;
  // Word: ink that isn't text or a ruled line (a logo, a figure, a signature) as a picture
  const pics = pm.pics.slice();
  if (opts.format === 'docx' && rgb) {
    for (const p of pictureRegions(ink, pw, ph, s, words, rulings, opts.dropStamps !== false)) {
      const crop = cropPng(rgb, pw, ph, p, s);
      if (crop) pics.push({ box: p, data: crop, ext: 'png' });
    }
  }
  const out: PageModel = { ...pm, kind: words.length ? 'text' : 'scan', words, rulings, fills: [], pics, shapes: [], ocr: true, bodySize: median(words.map((w) => w.size)) || 10 };
  return out;
}

/** areas of ink with no words or ruled lines in them, big enough to be a picture (page points) */
function pictureRegions(ink: Uint8Array, W: number, H: number, s: number, words: Word[], rulings: Ruling[], dropColour: boolean): [number, number, number, number][] {
  const C = 8; // cell size in pixels
  const cw = Math.ceil(W / C), ch = Math.ceil(H / C);
  const cnt = new Uint16Array(cw * ch), col = new Uint16Array(cw * ch);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = ink[y * W + x]; if (v) { const k = ((y / C) | 0) * cw + ((x / C) | 0); cnt[k]++; if (v === 2) col[k]++; } }
  const on = new Uint8Array(cw * ch);
  for (let k = 0; k < on.length; k++) if (cnt[k] > C * C * 0.04) on[k] = 1;
  const clear = (x0: number, y0: number, x1: number, y1: number) => {
    const X0 = Math.max(0, Math.floor((x0 * s) / C)), X1 = Math.min(cw - 1, Math.floor((x1 * s) / C)), Y0 = Math.max(0, Math.floor((y0 * s) / C)), Y1 = Math.min(ch - 1, Math.floor((y1 * s) / C));
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) on[y * cw + x] = 0;
  };
  for (const w of words) clear(w.x0 - 2, w.y0 - 2, w.x1 + 2, w.y1 + 2);
  for (const r of rulings) { const t = r.w / 2 + 2; if (r.o === 'h') clear(r.a - 2, r.c - t, r.b + 2, r.c + t); else clear(r.c - t, r.a - 2, r.c + t, r.b + 2); }
  const seen = new Uint8Array(cw * ch);
  const out: [number, number, number, number][] = [];
  const stack: number[] = [];
  for (let k0 = 0; k0 < on.length; k0++) {
    if (!on[k0] || seen[k0]) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0, colour = 0, inkN = 0;
    stack.push(k0); seen[k0] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % cw, y = (k / cw) | 0;
      n++; inkN += cnt[k]; colour += col[k];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      // neighbours within 2 cells (a logo's separate strokes hold together)
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue;
        const kk = yy * cw + xx;
        if (on[kk] && !seen[kk]) { seen[kk] = 1; stack.push(kk); }
      }
    }
    const bw = ((x1 - x0 + 1) * C) / s, bh = ((y1 - y0 + 1) * C) / s;
    if (bw * bh < 900 || bw < 20 || bh < 14 || n < 12) continue;
    // coloured ink: a stamp or a pen - except at the top of the page, where it is the letterhead's logo
    if (dropColour && colour > inkN * 0.5 && y0 * C > H * 0.15) continue;
    if (bw > (W / s) * 0.9 && bh > (H / s) * 0.9) continue;
    out.push([(x0 * C) / s, (y0 * C) / s, ((x1 + 1) * C) / s, ((y1 + 1) * C) / s]);
  }
  return out;
}

function cropPng(rgb: Uint8ClampedArray, W: number, H: number, b: [number, number, number, number], s: number): Uint8Array | null {
  const X0 = Math.max(0, Math.floor(b[0] * s)), Y0 = Math.max(0, Math.floor(b[1] * s)), X1 = Math.min(W, Math.ceil(b[2] * s)), Y1 = Math.min(H, Math.ceil(b[3] * s));
  const w = X1 - X0, h = Y1 - Y0;
  if (w < 4 || h < 4) return null;
  try {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
    const px = pix.getPixels(), st = pix.getStride();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = ((Y0 + y) * W + X0 + x) * 3, o = y * st + x * 3; px[o] = rgb[i]; px[o + 1] = rgb[i + 1]; px[o + 2] = rgb[i + 2]; }
    const png = pix.asPNG().slice();
    pix.destroy?.();
    return png;
  } catch { return null; }
}

// Arial / Helvetica advance widths (1/1000 em), space to tilde
const AW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
/** a word's width in Arial, in ems */
export function arialEm(t: string): number {
  let w = 0;
  for (const ch of t) { const c = ch.charCodeAt(0); w += c >= 32 && c <= 126 ? AW[c - 32] : 556; }
  return w / 1000;
}

/** straight dark lines in the picture (table rules, underlines), in page points */
function findLines(ink: Uint8Array, W: number, H: number, s: number): Ruling[] {
  const out: Ruling[] = [];
  const dark = (x: number, y: number) => ink[y * W + x] === 1;
  const gap = 2;
  for (const o of ['h', 'v'] as const) {
    const A = o === 'h' ? H : W; // lines along the other axis
    const B = o === 'h' ? W : H;
    const minLen = Math.round((o === 'h' ? 14 : 28) * s);
    type Seg = { a: number; b: number; c0: number; c1: number; last: number };
    let active: Seg[] = [];
    const done: Seg[] = [];
    for (let c = 0; c < A; c++) {
      const runs: [number, number][] = [];
      let start = -1, miss = 0;
      for (let t = 0; t < B; t++) {
        const d = o === 'h' ? dark(t, c) : dark(c, t);
        if (d) { if (start < 0) start = t; miss = 0; }
        else if (start >= 0 && ++miss > gap) { const e = t - miss; if (e - start >= minLen) runs.push([start, e]); start = -1; miss = 0; }
      }
      if (start >= 0 && B - 1 - miss - start >= minLen) runs.push([start, B - 1 - miss]);
      const next: Seg[] = [];
      for (const [a, b] of runs) {
        const hit = active.find((sg) => Math.min(sg.b, b) - Math.max(sg.a, a) > Math.min(sg.b - sg.a, b - a) * 0.5);
        if (hit) { hit.a = Math.min(hit.a, a); hit.b = Math.max(hit.b, b); hit.c1 = c; hit.last = c; if (!next.includes(hit)) next.push(hit); }
        else next.push({ a, b, c0: c, c1: c, last: c });
      }
      for (const sg of active) if (!next.includes(sg)) done.push(sg);
      active = next;
    }
    done.push(...active);
    for (const sg of done) {
      const thick = sg.c1 - sg.c0 + 1;
      if (thick > 7) continue; // a black block, not a line
      // thin: little ink just beside it along its length (text rows are ink above and below)
      let side = 0, tot = 0;
      for (const cc of [sg.c0 - 3, sg.c1 + 3]) {
        if (cc < 0 || cc >= A) continue;
        for (let t = sg.a; t <= sg.b; t += 2) { tot++; if (o === 'h' ? dark(t, cc) : dark(cc, t)) side++; }
      }
      if (tot && side > tot * 0.45) continue;
      out.push({ o, c: (sg.c0 + sg.c1 + 1) / 2 / s, a: sg.a / s, b: sg.b / s, w: Math.max(0.3, thick / s), color: 0 });
    }
  }
  return out;
}
