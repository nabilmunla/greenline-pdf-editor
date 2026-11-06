// Words -> text rows (everything on one baseline across the page), raised/lowered characters,
// underlines and strike-throughs drawn as lines, and ruled lines tidied up.
import type { Box, Ruling, Word } from './model';
import { median, minOf, maxOf } from './model';

export interface Row {
  words: Word[];
  x0: number; y0: number; x1: number; y1: number;
  base: number;
  size: number;
  rtl: boolean;
}

const band = (base: number, size: number): [number, number] => [base - 0.75 * size, base + 0.2 * size];

/** horizontal words into rows; superscripts and subscripts stay in their row */
export function buildRows(words: Word[]): Row[] {
  const ws = words.filter((w) => !w.turn).sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const rows: (Row & { ref: number; refBase: number })[] = [];
  let start = 0;
  for (const w of ws) {
    const [a0, a1] = band(w.base, w.size);
    let best: (typeof rows)[number] | null = null, bestR = 0;
    while (start < rows.length && rows[start].refBase < w.base - 4 * Math.max(rows[start].ref, w.size)) start++;
    for (let k = start; k < rows.length; k++) {
      const r = rows[k];
      const [b0, b1] = band(r.refBase, r.ref);
      const ov = Math.min(a1, b1) - Math.max(a0, b0);
      if (ov <= 0) continue;
      const ratio = ov / Math.min(a1 - a0, b1 - b0);
      // two words of the same row don't sit on top of each other
      if (ratio > bestR && !overlapsX(r.words, w)) { bestR = ratio; best = r; }
    }
    if (best && bestR >= 0.55) {
      best.words.push(w);
      if (w.size > best.ref * 1.15) { best.ref = w.size; best.refBase = w.base; }
    } else rows.push({ words: [w], x0: 0, y0: 0, x1: 0, y1: 0, base: w.base, size: w.size, rtl: false, ref: w.size, refBase: w.base });
  }
  const out: Row[] = [];
  for (const r of rows) {
    const size = median(r.words.map((w) => w.size));
    const full = r.words.filter((w) => w.size >= size * 0.85);
    const base = median(full.map((w) => w.base));
    const rtlChars = r.words.reduce((n, w) => n + (w.rtl ? w.text.length : 0), 0);
    const all = r.words.reduce((n, w) => n + w.text.length, 0);
    r.words.sort((a, b) => a.x0 - b.x0);
    const row: Row = { words: r.words, x0: Math.min(...r.words.map((w) => w.x0)), y0: Math.min(...r.words.map((w) => w.y0)), x1: Math.max(...r.words.map((w) => w.x1)), y1: Math.max(...r.words.map((w) => w.y1)), base, size, rtl: rtlChars > all / 2 };
    // raised / lowered characters against the row
    for (const w of r.words) for (const g of w.g) {
      // (OCR boxes say nothing reliable about raised letters)
      if (w.conf === undefined && g.size < size * 0.85) {
        if (base - g.base > size * 0.18) g.va = 1;
        else if (g.base - base > size * 0.08) g.va = -1;
      }
    }
    out.push(row);
  }
  return out.sort((a, b) => a.base - b.base);
}

function overlapsX(ws: Word[], w: Word): boolean {
  for (const o of ws) {
    const ov = Math.min(o.x1, w.x1) - Math.max(o.x0, w.x0);
    if (ov > Math.min(o.x1 - o.x0, w.x1 - w.x0) * 0.5) return true;
  }
  return false;
}

/** words of a row in reading order (right to left rows: right first, runs of left-to-right words kept in their order) */
export function readingOrder(r: { words: Word[]; rtl: boolean }): Word[] {
  if (!r.rtl) return r.words.slice().sort((a, b) => a.x0 - b.x0);
  const ws = r.words.slice().sort((a, b) => b.x1 - a.x1);
  const out: Word[] = [];
  for (let k = 0; k < ws.length;) {
    if (ws[k].rtl || !/[A-Za-z0-9]/.test(ws[k].text)) { out.push(ws[k++]); continue; }
    let e = k;
    while (e < ws.length && !ws[e].rtl && /[A-Za-z0-9]/.test(ws[e].text)) e++;
    out.push(...ws.slice(k, e).reverse());
    k = e;
  }
  // a full stop the page shows at the right end of a right-to-left line (in a left-to-right
  // paragraph) ends the sentence
  while (out.length > 1 && /^[.,:;!?،؛؟]+$/.test(out[0].text)) {
    // joined to the sentence's last word (no space before it)
    const p = out.shift()!, l = out[out.length - 1];
    out[out.length - 1] = { ...l, text: l.text + p.text, g: [...l.g, ...p.g], x0: Math.min(l.x0, p.x0), x1: Math.max(l.x1, p.x1) };
  }
  return out;
}

/** the text of words in reading order, one space between words */
export function textOf(ws: Word[], rtl = false): string {
  return readingOrder({ words: ws, rtl }).map((w) => w.text).join(' ');
}

// ---------------------------------------------------------------- ruled lines

/** join pieces of the same line, drop doubles */
export function tidyRulings(rs: Ruling[], tol: number, join = tol): Ruling[] {
  const out: Ruling[] = [];
  for (const o of ['h', 'v'] as const) {
    const list = rs.filter((r) => r.o === o && !r.used).sort((a, b) => a.c - b.c || a.a - b.a);
    // group by position (against the group's running mean: a median per line was slow on pages of
    // tens of thousands of segments)
    const groups: Ruling[][] = [];
    let sum = 0;
    for (const r of list) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(r.c - sum / g.length) <= tol) { g.push(r); sum += r.c; }
      else { groups.push([r]); sum = r.c; }
    }
    for (const g of groups) {
      g.sort((a, b) => a.a - b.a);
      const c = median(g.map((x) => x.c));
      let cur: Ruling | null = null, last = 0;
      for (const r of g) {
        const len = r.b - r.a;
        // a dashed line: short dashes with short gaps make one line (dashed table borders)
        if (cur && (r.a <= cur.b + join || (len <= 12 && last <= 12 && r.a <= cur.b + Math.max(join, 6)))) { cur.b = Math.max(cur.b, r.b); cur.w = Math.max(cur.w, r.w); }
        else { cur = { o, c, a: r.a, b: r.b, w: r.w, color: r.color }; out.push(cur); }
        last = len;
      }
    }
  }
  return out;
}

/** underlines and strike-throughs: short lines hugging a row's text, not touching any upright line */
export function markTextLines(rows: Row[], rulings: Ruling[], scan: boolean) {
  const vs = rulings.filter((r) => r.o === 'v');
  // a cell's top or bottom line runs from one upright line to the next; an underline doesn't
  const at = (h: Ruling, x: number) => vs.some((v) => v.a - 2 <= h.c && v.b + 2 >= h.c && Math.abs(v.c - x) < 2.5);
  const touchesV = (h: Ruling) => at(h, h.a) && at(h, h.b);
  for (const h of rulings) {
    if (h.o !== 'h' || h.used || h.w > (scan ? 3.5 : 1.8)) continue;
    const len = h.b - h.a;
    for (const r of rows) {
      const d = h.c - r.base;
      const under = d >= -0.06 * r.size && d <= 0.38 * r.size;
      const through = d <= -0.15 * r.size && d >= -0.5 * r.size;
      if (!under && !through) continue;
      // (on a scan, Arabic letters join along a stroke at the baseline: that's the writing, not a line)
      const ws = r.words.filter((w) => Math.min(w.x1, h.b) - Math.max(w.x0, h.a) > (w.x1 - w.x0) * 0.5 && !(scan && w.rtl));
      if (!ws.length) continue;
      const x0 = Math.min(...ws.map((w) => w.x0)), x1 = Math.max(...ws.map((w) => w.x1));
      const covered = ws.reduce((s, w) => s + Math.min(w.x1, h.b) - Math.max(w.x0, h.a), 0);
      if (covered < len * 0.55 || h.a < x0 - r.size * 1.2 || h.b > x1 + r.size * 1.2) continue;
      if (touchesV(h)) continue;
      for (const w of ws) for (const g of w.g) if ((g.x0 + g.x1) / 2 >= h.a - 1 && (g.x0 + g.x1) / 2 <= h.b + 1) { if (under) g.ul = true; else g.st = true; }
      h.used = true;
      break;
    }
  }
}

export const boxOf = (ws: { x0: number; y0: number; x1: number; y1: number }[]): Box => [minOf(ws, (w) => w.x0), minOf(ws, (w) => w.y0), maxOf(ws, (w) => w.x1), maxOf(ws, (w) => w.y1)];
