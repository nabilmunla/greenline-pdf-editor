// A page's text in reading order (columns, tables and pictures in between) and its lines
// joined into paragraphs: alignment, indents, numbered and bulleted items, headings.
import type { Box, FontInfo, Pic, Word } from './model';
import { median, quantile } from './model';
import type { PageLayout } from './analyze';
import type { Table } from './tables';
import { readingOrder, type Row } from './rows';

export interface Seg { words: Word[]; x0: number; x1: number }
export interface PLine {
  words: Word[];
  segs: Seg[];
  x0: number; x1: number; y0: number; y1: number;
  base: number; size: number; rtl: boolean;
  /** "1.1", "a)", "•" at the start, with where the text after it begins */
  marker?: { text: string; x0: number; tx: number };
  /** a run of dots: text, then the page number at the right */
  leader?: boolean;
}
export interface Para {
  kind: 'p';
  lines: PLine[];
  align: 'left' | 'center' | 'right' | 'both';
  /** indents (points, from the column's left edge) */
  left: number; first: number; right: number;
  /** tab stops: [position, kind] */
  tabs: [number, 'left' | 'center' | 'right' | 'dotright'][];
  before: number;
  /** baseline pitch (0: single) */
  pitch: number;
  size: number;
  rtl: boolean;
  heading?: number;
  y0: number; y1: number;
}
export type Block = Para | { kind: 'table'; t: Table; y0: number; y1: number } | { kind: 'pic'; pic: Pic; y0: number; y1: number; x0: number; x1: number; before: number };

export interface PageFlow { blocks: Block[]; L: number; R: number; top: number; bottom: number }

const BULLET = /^[•●▪■◦○◆❖➢✓►▶➤→·*\-–—]$/;
const NUMBER = /^(?:\(?\d{1,3}(?:\.\d{1,3}){0,5}[.)]?|\(?[a-zA-Z][.)]|\([a-zA-Z]{1,2}\)|\(?[ivxlcIVXLC]{1,6}[.)]|\([ivxlc]{1,6}\)|[A-Z]{1,2}\.\d{1,3}(?:\.\d{1,3})*\.?|(?:Clause|Section|Article)\s?\d+(?:\.\d+)*)$/;

/** figure regions: clusters of vector shapes (logos, charts) */
export function figures(pl: PageLayout): Box[] {
  const sh = pl.pm.shapes.filter((b) => (b[2] - b[0]) * (b[3] - b[1]) > 4 || b[2] - b[0] > 12 || b[3] - b[1] > 12);
  const boxes: Box[] = [];
  for (const b of sh) {
    let m: Box = [b[0], b[1], b[2], b[3]];
    let again = true;
    while (again) {
      again = false;
      for (let k = boxes.length - 1; k >= 0; k--) {
        const o = boxes[k];
        if (o[0] - 6 <= m[2] && m[0] - 6 <= o[2] && o[1] - 6 <= m[3] && m[1] - 6 <= o[3]) {
          m = [Math.min(m[0], o[0]), Math.min(m[1], o[1]), Math.max(m[2], o[2]), Math.max(m[3], o[3])];
          boxes.splice(k, 1);
          again = true;
        }
      }
    }
    boxes.push(m);
  }
  // big enough to matter, not a page-sized background, not inside a table
  return boxes.filter((b) => {
    const w = b[2] - b[0], h = b[3] - b[1];
    if (w * h < 300 || w < 10 || h < 10) return false;
    if (w > pl.pm.w * 0.9 && h > pl.pm.h * 0.9) return false;
    return !pl.tables.some((t) => b[0] >= t.box[0] - 2 && b[2] <= t.box[2] + 2 && b[1] >= t.box[1] - 2 && b[3] <= t.box[3] + 2);
  });
}

function lineOf(r: Row): PLine {
  const ws = readingOrder(r);
  const segs: Seg[] = [];
  const geo = r.words.slice().sort((a, b) => a.x0 - b.x0);
  for (const w of geo) {
    const s = segs[segs.length - 1];
    if (s && w.x0 - s.x1 < Math.max(r.size * 2, 12) && !w.leader && !s.words[s.words.length - 1].leader) { s.words.push(w); s.x1 = Math.max(s.x1, w.x1); }
    else segs.push({ words: [w], x0: w.x0, x1: w.x1 });
  }
  const ln: PLine = { words: ws, segs, x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, base: r.base, size: r.size, rtl: r.rtl, leader: r.words.some((w) => w.leader) || undefined };
  if (!r.rtl && geo.length >= 2) {
    const f = geo[0], nx = geo[1];
    const gap = nx.x0 - f.x1;
    // OCR reads a bullet as "e", "o", "»", "*"; a clause number's dots as colons
    if (f.conf !== undefined && /^[eo°»«·*]$/.test(f.text) && gap > r.size * 0.4) f.text = '•';
    if (f.conf !== undefined && /^\d{1,2}[.:]\d{1,2}([.:]\d{1,2})*[.:]?$/.test(f.text)) f.text = f.text.replace(/:/g, '.');
    const isB = BULLET.test(f.text), isN = NUMBER.test(f.text);
    if ((isB && gap > r.size * 0.15) || (isN && (gap > r.size * 0.6 || (/[.)]$/.test(f.text) && gap > r.size * 0.18)))) ln.marker = { text: f.text, x0: f.x0, tx: nx.x0 };
  }
  return ln;
}

/** a page's blocks in reading order */
export function pageFlow(pl: PageLayout, figs: { box: Box; pic: Pic }[]): PageFlow {
  const pm = pl.pm;
  const inFig = (w: Word) => figs.some((f) => (w.x0 + w.x1) / 2 >= f.box[0] && (w.x0 + w.x1) / 2 <= f.box[2] && (w.y0 + w.y1) / 2 >= f.box[1] && (w.y0 + w.y1) / 2 <= f.box[3]);
  let rows = pl.flow.filter((r) => !pl.running.has(r)).map((r) => ({ ...r, words: r.words.filter((w) => !inFig(w)) })).filter((r) => r.words.length);
  const pics = [...pm.pics.filter((p) => !p.full && p.data), ...figs.map((f) => f.pic)];
  const xs0 = [...rows.map((r) => r.x0), ...pl.tables.map((t) => t.box[0]), ...pics.map((p) => p.box[0])];
  const xs1 = [...rows.map((r) => r.x1), ...pl.tables.map((t) => t.box[2]), ...pics.map((p) => p.box[2])];
  const ys0 = [...rows.map((r) => r.y0), ...pl.tables.map((t) => t.box[1]), ...pics.map((p) => p.box[1])];
  const ys1 = [...rows.map((r) => r.y1), ...pl.tables.map((t) => t.box[3]), ...pics.map((p) => p.box[3])];
  const L = xs0.length ? Math.max(0, quantile(xs0, 0.03)) : 72, R = xs1.length ? Math.min(pm.w, quantile(xs1, 0.97)) : pm.w - 72;
  const top = ys0.length ? Math.min(...ys0) : 72, bottom = ys1.length ? Math.max(...ys1) : pm.h - 72;
  // columns: a white strip down the middle that most rows don't cross
  type El = { y0: number; y1: number; x0: number; x1: number; r?: Row; t?: Table; p?: Pic };
  const gutter = findGutter(rows, L, R);
  if (gutter !== null) rows = splitAt(rows, gutter);
  const els: El[] = [
    ...rows.map((r) => ({ y0: r.y0, y1: r.y1, x0: r.x0, x1: r.x1, r })),
    ...pl.tables.map((t) => ({ y0: t.box[1], y1: t.box[3], x0: t.box[0], x1: t.box[2], t })),
    ...pics.map((p) => ({ y0: p.box[1], y1: p.box[3], x0: p.box[0], x1: p.box[2], p })),
  ].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const ordered: El[] = [];
  if (gutter === null) ordered.push(...els);
  else {
    let left: El[] = [], right: El[] = [];
    const flush = () => { ordered.push(...left, ...right); left = []; right = []; };
    for (const e of els) {
      if (e.x1 <= gutter + 1) left.push(e);
      else if (e.x0 >= gutter - 1) right.push(e);
      else { flush(); ordered.push(e); }
    }
    flush();
  }
  // lines -> paragraphs (within a column: a column change starts a paragraph)
  const blocks: Block[] = [];
  let run: PLine[] = [];
  let runL = L, runR = R;
  let prevBottom = top;
  /** the last paragraph's last baseline and line height (spacing measured baseline to baseline) */
  let prevBase: number | null = null, prevH = 0;
  const flushRun = () => {
    if (!run.length) return;
    for (const p of paragraphs(run, runL, runR)) {
      const h = p.pitch || p.size * 1.17;
      p.before = prevBase !== null ? Math.max(0, p.lines[0].base - prevBase - prevH * 0.22 - h * 0.78) : Math.max(0, p.y0 - prevBottom - p.size * 0.1);
      blocks.push(p);
      prevBottom = p.y1;
      prevBase = p.lines[p.lines.length - 1].base;
      prevH = h;
    }
    run = [];
  };
  for (const e of ordered) {
    const colL = gutter === null || e.x0 < gutter - 1 ? L : gutter;
    const colR = gutter === null || e.x1 > gutter + 1 ? R : gutter;
    if (e.r) {
      if (run.length && (colL !== runL || e.y0 < run[run.length - 1].y0)) flushRun();
      runL = colL; runR = colR;
      run.push(lineOf(e.r));
      continue;
    }
    flushRun();
    prevBase = null;
    if (e.t) { blocks.push({ kind: 'table', t: e.t, y0: e.y0, y1: e.y1 }); prevBottom = e.y1; }
    else if (e.p) {
      // pictures side by side are written one after the other
      blocks.push({ kind: 'pic', pic: e.p, y0: e.y0, y1: e.y1, x0: e.x0, x1: e.x1, before: Math.max(0, e.y0 - prevBottom) });
      prevBottom = Math.max(prevBottom, e.y1);
    }
  }
  flushRun();
  return { blocks, L, R, top, bottom };
}

function findGutter(rows: Row[], L: number, R: number): number | null {
  const W = R - L;
  if (W < 200 || rows.length < 8) return null;
  let best: number | null = null, bestScore = 0;
  for (let x = L + W * 0.3; x <= L + W * 0.7; x += 2) {
    let cross = 0, lft = 0, rgt = 0;
    for (const r of rows) {
      if (r.words.some((w) => w.x0 < x + 4 && w.x1 > x - 4)) cross++;
      if (r.words.some((w) => w.x1 <= x - 4)) lft++;
      if (r.words.some((w) => w.x0 >= x + 4)) rgt++;
    }
    if (cross > rows.length * 0.15 || lft < rows.length * 0.3 || rgt < rows.length * 0.3) continue;
    const score = Math.min(lft, rgt) - cross * 3;
    if (score > bestScore) { bestScore = score; best = x; }
  }
  if (best === null) return null;
  // both sides must hold running text (lines that fill their column), not a column of labels
  const g = best;
  const part = (r: Row, left: boolean) => { const ws = r.words.filter((w) => (left ? w.x1 <= g : w.x0 >= g)); return ws.length ? Math.max(...ws.map((w) => w.x1)) - Math.min(...ws.map((w) => w.x0)) : null; };
  const lw = rows.map((r) => part(r, true)).filter((v): v is number => v !== null), rw = rows.map((r) => part(r, false)).filter((v): v is number => v !== null);
  if (median(lw) < (g - L) * 0.6 || median(rw) < (R - g) * 0.6) return null;
  return best;
}

/** a row with words on both sides of the column gap -> two rows */
function splitAt(rows: Row[], x: number): Row[] {
  const out: Row[] = [];
  for (const r of rows) {
    const a = r.words.filter((w) => w.x1 <= x), b = r.words.filter((w) => w.x0 >= x);
    if (!a.length || !b.length || a.length + b.length !== r.words.length) { out.push(r); continue; }
    for (const ws of [a, b]) out.push({ ...r, words: ws, x0: Math.min(...ws.map((w) => w.x0)), x1: Math.max(...ws.map((w) => w.x1)), y0: Math.min(...ws.map((w) => w.y0)), y1: Math.max(...ws.map((w) => w.y1)) });
  }
  return out;
}

/** consecutive lines of one column -> paragraphs */
export function paragraphs(lines: PLine[], L: number, R: number): Para[] {
  const out: Para[] = [];
  const W = R - L;
  let cur: PLine[] = [];
  const close = () => { if (cur.length) out.push(makePara(cur, L, R)); cur = []; };
  const sentenceEnd = (l: PLine) => /[.:;!?)"'’”]$/.test(l.words[l.words.length - 1]?.text ?? '');
  const bold = (l: PLine) => l.words.every((w) => w.g.every((g) => g.bold || !g.c.trim()));
  const centered = (l: PLine) => l.x0 > L + 12 && Math.abs((l.x0 + l.x1) / 2 - (L + R) / 2) < Math.max(6, W * 0.03);
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (!cur.length) { cur.push(l); continue; }
    const p = cur[cur.length - 1];
    const firstOfPara = cur[0];
    const gap = l.base - p.base;
    const pitch = cur.length >= 2 ? cur[cur.length - 1].base - cur[cur.length - 2].base : Math.max(p.size, l.size) * 1.25;
    let brk = false;
    if (gap > Math.max(pitch * 1.35, Math.max(p.size, l.size) * 1.55)) brk = true;
    else if (Math.abs(l.size - p.size) > 0.9) brk = true;
    else if (l.marker || p.leader || l.leader || l.segs.length > 1 || p.segs.length > 1 && !p.marker) brk = true;
    else if (bold(l) !== bold(p)) brk = true;
    else if (l.rtl !== p.rtl) brk = true;
    else if (centered(p) && centered(l)) brk = false;
    else if (p.x1 < R - W * 0.15 && (sentenceEnd(p) || /^[A-Z0-9“"(]/.test(l.words[0]?.text ?? ''))) brk = true;
    else {
      // indents: the text of a numbered item carries on under its text (or under the number)
      const textX = firstOfPara.marker ? firstOfPara.marker.tx : firstOfPara.x0;
      const contX = cur.length >= 2 ? cur[1].x0 : null;
      if (contX !== null && Math.abs(l.x0 - contX) > 3) brk = true;
      else if (contX === null && l.x0 > p.x0 + 8 && Math.abs(l.x0 - textX) > 3) brk = true;
      else if (contX === null && l.x0 < p.x0 - 8 && !firstOfPara.marker && p.x0 - L > W * 0.25) brk = true;
    }
    if (brk) close();
    cur.push(l);
  }
  close();
  return out;
}

function makePara(lines: PLine[], L: number, R: number): Para {
  const W = R - L;
  const f = lines[0];
  const size = median(lines.flatMap((l) => l.words.map((w) => w.size)));
  const rtl = f.rtl;
  const gaps: number[] = [];
  for (let k = 1; k < lines.length; k++) gaps.push(lines[k].base - lines[k - 1].base);
  const pitch = gaps.length ? median(gaps) : 0;
  const tabs: Para['tabs'] = [];
  let left = 0, first = 0, right = 0;
  let align: Para['align'] = 'left';
  const x0s = lines.map((l) => l.x0), x1s = lines.map((l) => l.x1);
  // right-to-left text set from the left margin, ragged at the right: a left-to-right paragraph
  if (rtl && lines.every((l) => l.x0 - L < 6) && lines.some((l) => R - l.x1 > 20) && lines.length <= 2 && lines[0].x1 < R - 20) {
    left = Math.max(0, f.x0 - L);
    return { kind: 'p', lines, align: 'left', left, first: 0, right: 0, tabs, before: 0, pitch, size, rtl: false, y0: Math.min(...lines.map((l) => l.y0)), y1: Math.max(...lines.map((l) => l.y1)) };
  }
  if (rtl) {
    align = 'right';
    right = Math.max(0, R - Math.max(...x1s));
    if (lines.length === 1 && Math.abs((f.x0 + f.x1) / 2 - (L + R) / 2) < 6 && f.x0 > L + 20) { align = 'center'; right = 0; }
  } else if (f.leader) {
    left = Math.max(0, f.x0 - L);
    tabs.push([Math.min(W, f.x1 - L), 'dotright']);
  } else if (f.marker) {
    const contX = lines.length > 1 ? median(lines.slice(1).map((l) => l.x0)) : f.marker.tx;
    left = Math.max(0, contX - L);
    first = f.marker.x0 - L - left;
    tabs.push([Math.max(0, f.marker.tx - L), 'left']);
    if (justified(lines, R)) align = 'both';
  } else if (f.segs.length > 1) {
    // a line in parts ("Ref: ...            Date: ..."): tab stops where the parts start / end
    left = Math.max(0, f.segs[0].x0 - L);
    for (const s of f.segs.slice(1)) {
      if (Math.abs(s.x1 - R) < 6) tabs.push([W, 'right']);
      else if (Math.abs((s.x0 + s.x1) / 2 - (L + R) / 2) < 8) tabs.push([W / 2, 'center']);
      else tabs.push([Math.max(0, s.x0 - L), 'left']);
    }
  } else {
    const mid = (L + R) / 2;
    const allCentered = lines.every((l) => Math.abs((l.x0 + l.x1) / 2 - mid) < Math.max(5, W * 0.025)) && Math.min(...x0s) > L + 15;
    const allRight = lines.every((l) => Math.abs(l.x1 - R) < 5) && Math.min(...x0s) > L + 30;
    const just = lines.length >= 2 && lines.slice(0, -1).every((l) => Math.abs(l.x1 - R) < 5) && lines.slice(1, -1).every((l) => Math.abs(l.x0 - lines[1].x0) < 3);
    if (allCentered) align = 'center';
    else if (allRight) align = 'right';
    else {
      if (just && justified(lines, R)) align = 'both';
      const contX = lines.length > 1 ? median(lines.slice(1).map((l) => l.x0)) : f.x0;
      left = Math.max(0, contX - L);
      first = f.x0 - L - left;
      right = lines.length > 1 && !just ? 0 : 0;
    }
  }
  return { kind: 'p', lines, align, left, first, right, tabs, before: 0, pitch, size, rtl, y0: Math.min(...lines.map((l) => l.y0)), y1: Math.max(...lines.map((l) => l.y1)) };
}

/** every line but the last ends at the right edge: tight for two lines (could be chance) */
function justified(lines: PLine[], R: number): boolean {
  if (lines.length < 2) return false;
  const tol = lines.length === 2 ? 1.2 : 3;
  return lines.slice(0, -1).every((l) => Math.abs(l.x1 - R) < tol) && lines[lines.length - 1].x1 < R - 3;
}

/** headings: short, larger or bold lines that lead into ordinary text */
export function markHeadings(all: Para[][], fonts: FontInfo[]) {
  const sizes: number[] = [];
  for (const ps of all) for (const p of ps) for (const l of p.lines) for (const w of l.words) for (let k = 0; k < w.text.length; k++) sizes.push(Math.round(w.size * 2) / 2);
  const counts = new Map<number, number>();
  for (const s of sizes) counts.set(s, (counts.get(s) ?? 0) + 1);
  let body = 10, n = 0;
  for (const [s, c] of counts) if (c > n) { n = c; body = s; }
  const isBold = (p: Para) => p.lines.every((l) => l.words.every((w) => w.g.every((g) => g.bold || fonts[g.f]?.bold || !g.c.trim())));
  const text = (p: Para) => p.lines.map((l) => l.words.map((w) => w.text).join(' ')).join(' ');
  const cands: { p: Para; size: number; bold: boolean; depth: number }[] = [];
  for (const ps of all) ps.forEach((p, i) => {
    const t = text(p);
    if (p.lines.length > 3 || t.length > 160 || t.length < 2 || /[.,;]$/.test(t) || p.align === 'both') return;
    if (!/[A-Za-z؀-ۿ]/.test(t)) return;
    const bold = isBold(p);
    const big = p.size >= body * 1.17;
    const caps = t === t.toUpperCase() && /[A-Z]{3}/.test(t);
    const next = ps[i + 1];
    const leads = !next || next.size < p.size - 0.5 || !isBold(next) || next.lines.length > p.lines.length;
    // headings set in colour (a blue heading over black text), or short capitals
    const glyphs = p.lines.flatMap((l) => l.words.flatMap((w) => w.g)).filter((g) => g.c.trim());
    const coloured = glyphs.length > 0 && glyphs.filter((g) => g.color && g.color !== 0 && ((g.color >> 16) & 255) + ((g.color >> 8) & 255) + (g.color & 255) < 600).length >= glyphs.length * 0.7;
    const shortCaps = caps && p.lines.length === 1 && t.split(/\s+/).length <= 8 && p.size >= body * 0.95;
    if (!(big || (bold && (caps || p.size >= body) && leads) || (coloured && p.lines.length <= 2 && leads) || (shortCaps && leads))) return;
    const m = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s/.exec(t);
    cands.push({ p, size: p.size, bold, depth: m ? m[1].split('.').length : 0 });
  });
  let big = [...new Set(cands.filter((c) => c.size >= body * 1.17).map((c) => Math.round(c.size)))].sort((a, b) => b - a);
  // a title (the biggest size, once or twice) sits at level 1 with the first real headings
  if (big.length >= 2 && cands.filter((c) => Math.round(c.size) === big[0]).length <= 2) big = big.slice(1);
  for (const c of cands) {
    let lv = c.size >= body * 1.17 ? Math.max(1, big.indexOf(Math.round(c.size)) + 1) : Math.min(3, big.length + 1);
    if (c.depth) lv = Math.max(lv, c.depth);
    c.p.heading = Math.max(1, Math.min(3, lv || 1));
  }
}
