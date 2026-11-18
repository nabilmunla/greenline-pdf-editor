// Drawing sets: which sheet number (and title) each page carries, and where the sheets refer to one
// another - for "Link the sheets" (links between sheets, a "Sheets" bookmark group). Pure: unit-tested.
//
// A page's number is read from its title block: the strip along the right / bottom edge where title
// blocks sit. Across the pages of one size, the number sits in the same spot on most pages and is
// different on each (a project number or a date repeats on every sheet; a scale or a revision code
// is no drawing number, nor is an amount or a quantity). Nothing rigid: a file that is not a drawing
// set - a specification, a scan, prose, a bill of quantities - has no spot like that, and nothing
// is found (the user, 16 Nov: "it should not break").
import { drawingNo, drawingNoBare, noZeros, sheetNo, cleanTitle, rightStrip, bottomStrip, sizeKey } from './sheetno';

const MM = 72 / 25.4;
/** the spot's grid: 10 mm cells measured from the sheet's bottom-right corner */
const CELL = 10 * MM;
/** candidates kept per page (title band first) - a page of a spec or a schedule holds thousands */
export const MAX_TOKENS = 400;
/** text lines of the title band kept per page (for titles) - in text order, where a title block's lines
 *  can come late: 60 cut the title off 441 of the user's 483 real sheets (PLAN 9.2; 85 lines on the
 *  median sheet there, 162 at the 90th percentile) */
const MAX_LINES = 400;

export type Box = [number, number, number, number];
/** a word that can be a drawing number */
export interface Tok {
  /** as written, without a revision code after it ("A-301", "PRJ-AB1-DWG-AR-10140") */
  raw: string;
  /** compared form: no revision code, no leading zeros, "-" between parts */
  key: string;
  box: Box;
  /** in the title band */
  band: boolean;
  /** up to three words before it on its line, upper case ("SEE", "REFER TO DWG") */
  pre: string;
}
/** a line of text in the title band (for the sheet's title) */
export interface BandLine { text: string; box: Box }
export interface PageToks {
  page: number;
  w: number;
  h: number;
  /** the page's label, when the file gives it one */
  label?: string;
  /** the page holds text at all */
  text: boolean;
  toks: Tok[];
  lines: BandLine[];
}

const WS = /[\s  -​　]/;
/** where title blocks sit: the right or the bottom strip (Rev Radar's band without its outer
 *  margins - a left margin holds a spec's clause numbers, a top one its running heads) */
const inStrip = (b: Box, w: number, h: number) => (b[0] + b[2]) / 2 > rightStrip(w) || (b[1] + b[3]) / 2 > bottomStrip(h);
const hasLetter = /\p{L}/u;
/** digits with a decimal point or comma, thousands separators allowed, a sign or brackets around */
const AMOUNT = /^[(+-]?\d[\d,]*[.,]\d+[.,;:)%]*$/;

/**
 * A page's text (one character per box, page space as shown: y down) reduced to what the sheet
 * index needs - its candidates and its title band lines. Never throws: odd boxes are skipped.
 */
export function tokensOf(page: number, chars: { text: string; box: ArrayLike<number> }, w: number, h: number, label?: string): PageToks {
  const out: PageToks = { page, w, h, label: label || undefined, text: false, toks: [], lines: [] };
  const text = chars?.text || '';
  const bx = chars?.box;
  if (!text || !bx || !(w > 0) || !(h > 0)) return out;
  const n = Math.min(text.length, Math.floor(bx.length / 4));
  type Word = { s: string; box: Box; line: number };
  const words: Word[] = [];
  let cur = '', wb: Box | null = null, line = 0, lastY = NaN, lastH = 0, lastX1 = NaN;
  const end = () => { if (cur && wb) words.push({ s: cur, box: wb, line }); cur = ''; wb = null; };
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c === '\n' || c === '\r') { end(); line++; continue; }
    const x0 = bx[i * 4], y0 = bx[i * 4 + 1], x1 = bx[i * 4 + 2], y1 = bx[i * 4 + 3];
    if (WS.test(c) || !(x1 > x0) || !(y1 > y0) || !Number.isFinite(x0 + y0 + x1 + y1)) { end(); continue; }
    const ch = y1 - y0;
    // (a new line by position: text order in a title block jumps between fields)
    if (Number.isFinite(lastY) && Math.abs((y0 + y1) / 2 - lastY) > 0.6 * Math.max(ch, lastH)) { end(); line++; }
    // (a gap of more than a character's height between letters: two words)
    else if (cur && x0 - lastX1 > 0.8 * ch) end();
    if (cur.length < 80) {
      cur += c;
      wb = wb ? [Math.min(wb[0], x0), Math.min(wb[1], y0), Math.max(wb[2], x1), Math.max(wb[3], y1)] : [x0, y0, x1, y1];
    }
    lastY = (y0 + y1) / 2; lastH = ch; lastX1 = x1;
  }
  end();
  out.text = words.length > 0;
  if (!words.length) return out;
  // lines (words in order) - for the words before a candidate and the band's lines
  const byLine = new Map<number, Word[]>();
  for (const wd of words) { let l = byLine.get(wd.line); if (!l) byLine.set(wd.line, (l = [])); l.push(wd); }
  const band: Tok[] = [], other: Tok[] = [];
  for (const l of byLine.values()) {
    for (let k = 0; k < l.length; k++) {
      const s = l[k].s.toUpperCase();
      // (a word must hold a digit to be a number; "SEE" / "PLAN" never are)
      if (!/\d/.test(s)) continue;
      let key = '';
      try { key = drawingNo(s); } catch { key = ''; }
      // (a number of digits alone - "100101" - is a sheet number in many sets: drawingNo wants a
      //  letter in a short code, so it is taken here; 3 digits at least)
      if (!key && /^\d{3,}$/.test(s.replace(/[.,;:)]+$/, ''))) key = s.replace(/[.,;:)]+$/, '');
      if (!key) continue;
      // (numbers and dots only - "3.6.3", "1.4", "2.01.5" - are clause, item or version numbers:
      //  a specification's margins are full of them, different on every page)
      if (/^\(?\d{1,3}(\.\d{1,3})+\.?\)?[.,;:]?$/.test(s)) continue;
      // (nor is any other number with a decimal point or comma - "0.5", "1234.56", "1,047.50": the
      //  quantities and amounts of a bill of quantities, different on every page; 34 of the 44 false
      //  sheets on the user's real sets, PLAN 9)
      if (AMOUNT.test(s)) continue;
      const raw = (() => { try { return sheetNo(l[k].s) || drawingNo(l[k].s, true) || key; } catch { return key; } })();
      const cmp = noZeros(drawingNoBare(key));
      if (!cmp) continue;
      const pre = l.slice(Math.max(0, k - 3), k).map((x) => x.s.toUpperCase()).join(' ');
      const t: Tok = { raw, key: cmp, box: l[k].box, band: inStrip(l[k].box, w, h), pre };
      (t.band ? band : other).push(t);
    }
    // the band's lines: their words joined (a line can cross the band's edge: its middle decides)
    const lb: Box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const wd of l) { lb[0] = Math.min(lb[0], wd.box[0]); lb[1] = Math.min(lb[1], wd.box[1]); lb[2] = Math.max(lb[2], wd.box[2]); lb[3] = Math.max(lb[3], wd.box[3]); }
    if (out.lines.length < MAX_LINES && inStrip(lb, w, h)) out.lines.push({ text: l.map((x) => x.s).join(' ').slice(0, 160), box: lb });
  }
  out.toks = band.slice(0, MAX_TOKENS).concat(other.slice(0, Math.max(0, MAX_TOKENS - band.length)));
  return out;
}

export interface Sheet {
  page: number; no: string; key: string; title: string;
  /** read at a spot whose numbers repeat (repeatedNos): its references need more proof (findRefs) */
  repeats?: boolean;
}
export interface SheetIndex {
  /** the numbered pages, in page order */
  sheets: Sheet[];
  /** compared key -> page (a number on two pages: the first) */
  byKey: Map<string, number>;
  /** pages with no text at all (a scan: OCR first) */
  noText: number;
}

const cellOf = (b: Box, w: number, h: number): [number, number] => [Math.floor((w - (b[0] + b[2]) / 2) / CELL), Math.floor((h - (b[1] + b[3]) / 2) / CELL)];
/** a cell as one number (cells are 10 mm: a page up to 80 m either way) */
const cellKey = (x: number, y: number) => (x + 4096) * 8192 + (y + 4096);
const near = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1;
const looksLikeNo = (s: string) => /\p{L}/u.test(s) && /\d/.test(s) && s.replace(/\s/g, '').length >= 4;

/**
 * Which page carries which sheet number. Per page size: the spot (a 10 mm cell, a cell either side
 * allowed for numbers of different lengths) where a title band candidate sits on at least 60 % of
 * the pages with text and differs on at least 90 % of them (plain numbers there: of one length -
 * plainNumbersOk; on drawing paper, failing that, a spot of drawing numbers some of which repeat -
 * repeatedNos); groups of fewer than 3 pages, or with no such
 * spot, have no numbers (the pages of a spec in a mixed set fall out here). Page labels that look
 * like drawing numbers count when there is no spot.
 */
export function sheetIndex(pages: PageToks[]): SheetIndex {
  const sheets: Sheet[] = [];
  const noText = pages.filter((p) => !p.text).length;
  const groups = new Map<string, PageToks[]>();
  // (a page with no text is not counted against a spot: 36 scans in a combined set, each with one A3
  // page, put set B's 40 A3 sheets under 60 % and it lost all its numbers - e2e-combine-big)
  for (const p of pages) { if (!p || !(p.w > 0) || !p.text) continue; const k = sizeKey({ w: p.w, h: p.h }); let g = groups.get(k); if (!g) groups.set(k, (g = [])); g.push(p); }
  const found = new Map<number, Sheet>();
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    // every cell any band candidate falls in, and each page's pick there (as pick() below) - made
    // from each page's candidates once: every candidate of every page was tried for every cell,
    // 2,000 pages took 10 s and more (sweep S4)
    const cells = new Map<number, [number, number]>();
    for (const p of g) for (const t of p.toks) if (t.band) { const c = cellOf(t.box, p.w, p.h); cells.set(cellKey(c[0], c[1]), c); }
    const picked = new Map<number, { vals: string[]; raws: string[]; tall: number }>();
    for (const p of g) {
      const bi = new Map<number, number>(), bd = new Map<number, number>();
      p.toks.forEach((t, i) => {
        if (!t.band) return;
        const tc = cellOf(t.box, p.w, p.h), hgt = (t.box[3] - t.box[1]) / 1000;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const k = cellKey(tc[0] + dx, tc[1] + dy);
          if (!cells.has(k)) continue;
          const d = Math.abs(dx) + Math.abs(dy) - hgt, was = bd.get(k);
          if (was === undefined || d < was) { bd.set(k, d); bi.set(k, i); }
        }
      });
      for (const [k, i] of bi) {
        let e = picked.get(k);
        if (!e) picked.set(k, (e = { vals: [], raws: [], tall: 0 }));
        const t = p.toks[i];
        e.vals.push(t.key); e.raws.push(t.raw); e.tall += t.box[3] - t.box[1];
      }
    }
    type Spot = { c: [number, number]; cover: number; tall: number; dist: number };
    const better = (a: Spot | null, b: Spot) => !a || b.cover > a.cover || (b.cover === a.cover && (b.tall > a.tall + 0.5 || (Math.abs(b.tall - a.tall) <= 0.5 && b.dist < a.dist)));
    // (a spot whose numbers repeat is taken only when no spot differs on every page: repeatedNos)
    let best: Spot | null = null, again: Spot | null = null;
    const big = Math.min(g[0].w, g[0].h) >= 270 * MM;
    for (const [k, c] of cells) {
      const e = picked.get(k);
      if (!e || e.vals.length < Math.max(3, Math.ceil(0.6 * g.length))) continue;
      if (!plainNumbersOk(e.raws)) continue;
      const cand = { c, cover: e.vals.length, tall: e.tall / e.vals.length, dist: c[0] + c[1] };
      if (new Set(e.vals).size >= 0.9 * e.vals.length) { if (better(best, cand)) best = cand; }
      else if (big && repeatedNos(e.vals, e.raws) && better(again, cand)) again = cand;
    }
    const repeats = !best && !!again;
    best = best || again;
    if (!best) continue;
    // (each page's titles made once: the title's spot and the page's title both need them)
    const heads = new Map<PageToks, Head[]>();
    const headsOf = (p: PageToks) => { let h = heads.get(p); if (!h) heads.set(p, (h = titleHeads(p))); return h; };
    const titleSpot = best ? titleCell(g, best.c, headsOf) : null;
    for (const p of g) {
      const t = pick(p, best.c);
      if (t) found.set(p.page, { page: p.page, no: t.raw, key: t.key, title: titleSpot ? titleOf(p, titleSpot, t, headsOf(p)) : '', ...(repeats ? { repeats } : {}) });
      else if (p.label && looksLikeNo(p.label)) found.set(p.page, labelSheet(p));
    }
  }
  // no spot anywhere: page labels that look like drawing numbers, when they differ (a set labelled
  // by another program); "1", "2", "iii" are not
  if (!found.size) {
    const lab = pages.filter((p) => p && p.label && looksLikeNo(p.label));
    if (lab.length >= 3 && new Set(lab.map((p) => p.label)).size >= 0.9 * lab.length) for (const p of lab) found.set(p.page, labelSheet(p));
  }
  const byKey = new Map<string, number>();
  for (const s of [...found.values()].sort((a, b) => a.page - b.page)) {
    sheets.push(s);
    if (!byKey.has(s.key)) byKey.set(s.key, s.page);
  }
  return { sheets, byKey, noText };
}

/**
 * A spot where most values are plain numbers (no letter: "100101", "9027") is a sheet-number spot
 * only when they are written to one length: digits-only drawing numbers are ("100101", "100102" -
 * "0007" as written), a column of quantities or amounts is not ("512", "1047", "23140"). On the
 * user's real sets (PLAN 9) the false spot's plain numbers had 2 to 8 digits, the commonest length
 * on 60 % of them; the real sheets there are numbered with letters, untouched by this.
 */
export function plainNumbersOk(raws: string[]): boolean {
  const lens = new Map<number, number>();
  let plain = 0;
  for (const r of raws) {
    if (hasLetter.test(r)) continue;
    plain++;
    const n = r.replace(/\D/g, '').length;
    lens.set(n, (lens.get(n) || 0) + 1);
  }
  if (plain < 0.5 * raws.length) return true;
  // (80 %: a page or two whose pick there is another word does not undo a real set)
  return Math.max(...lens.values()) >= 0.8 * plain;
}

/**
 * A set that holds some sheets more than once (a tender set compiled from packages: the user's A1 set
 * of 228 pages holds 112 numbers, up to 8 times each, the copies far apart - PLAN 9.3) has no spot
 * that differs on 90 % of its pages. Its spot is still taken when the numbers there are written like
 * drawing numbers (a letter and a digit, 90 % of them), differ on 40 % of the pages at least and no
 * number is on more than a tenth of them - a project number, a revision or a zone code repeats far
 * more - and only on drawing paper (A3 and up, decided by the caller): the one other spot like that
 * on the user's sets was on 70 A4 pages of photos and running text.
 */
export function repeatedNos(vals: string[], raws: string[]): boolean {
  const n = vals.length, count = new Map<string, number>();
  for (const v of vals) count.set(v, (count.get(v) || 0) + 1);
  return count.size >= 0.4 * n && Math.max(...count.values()) <= 0.1 * n && raws.filter((r) => hasLetter.test(r) && /\d/.test(r)).length >= 0.9 * n;
}

function labelSheet(p: PageToks): Sheet {
  const l = (p.label || '').trim();
  let key = '';
  try { key = noZeros(drawingNoBare(drawingNo(l))); } catch { key = ''; }
  return { page: p.page, no: l, key: key || l.toUpperCase(), title: '' };
}

/** the page's candidate at the spot (nearest the cell's middle; ties: the taller text) */
function pick(p: PageToks, c: [number, number]): Tok | null {
  let best: Tok | null = null, bd = Infinity;
  for (const t of p.toks) {
    if (!t.band) continue;
    const tc = cellOf(t.box, p.w, p.h);
    if (!near(tc, c)) continue;
    const d = Math.abs(tc[0] - c[0]) + Math.abs(tc[1] - c[1]) - (t.box[3] - t.box[1]) / 1000;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

const REVISH = /^(REV(ISION)?|ISSUE|STATUS|DATE|SCALE|DRAWN|CHECKED|APPROVED|PROJECT|CLIENT|CONSULTANT|CONTRACTOR|SIZE|PURPOSE|SUITABILITY)\b|^(DRAWING|DWG|DRG|SHEET|TITLE)\.?\s*(NO\b|NUMBER|TITLE|NAME|:|$)|^(NO|NUMBER)\b/i;
const DATEISH = /\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/;

/** where the title sits: the spot (10 mm cell of its first line's top-left) of the title nearest the
 *  number's spot whose text differs across pages and is words (letters), present on half the pages at
 *  least - a whole title (titleHeads), not its first line: "LEVEL 02" over "FLOOR PLAN" repeats from
 *  sheet to sheet, the title does not (PLAN 9.2) */
function titleCell(g: PageToks[], noCell: [number, number], headsOf: (p: PageToks) => Head[]): [number, number] | null {
  const spots = new Map<string, { c: [number, number]; texts: string[] }>();
  for (const p of g) {
    const seen = new Set<string>();
    for (const { l, text } of headsOf(p)) {
      const c: [number, number] = [Math.floor((p.w - l.box[0]) / CELL), Math.floor((p.h - l.box[1]) / CELL)];
      const k = c.join(',');
      if (seen.has(k)) continue;
      seen.add(k);
      let s = spots.get(k);
      if (!s) spots.set(k, (s = { c, texts: [] }));
      s.texts.push(text.toUpperCase());
    }
  }
  let best: { c: [number, number]; d: number } | null = null;
  for (const s of spots.values()) {
    if (s.texts.length < Math.max(2, Math.ceil(0.5 * g.length))) continue;
    if (new Set(s.texts).size < 0.7 * s.texts.length) continue;
    const d = Math.hypot(s.c[0] - noCell[0], s.c[1] - noCell[1]);
    if (!best || d < best.d) best = { c: s.c, d };
  }
  return best ? best.c : null;
}
function titleish(t: string) {
  const s = t.trim();
  // (letters of words without digits: a drawing number "PRJ-AB1-DWG-AR-10140" has letters, and its own
  //  line, different on every sheet and next to the number's spot, was taken for the title - PLAN 9.2)
  const words = s.split(/\s+/).filter((w) => !/\d/.test(w)).join('');
  return hasLetter.test(s) && words.replace(/[^\p{L}]/gu, '').length >= 3 && !REVISH.test(s) && !DATEISH.test(s);
}

/** lines a title may take (the user's real titles: 1 to 3) */
const TITLE_LINES = 3;
/**
 * The titles of a page as written: a title-like band line with none above it that it goes on from
 * (the head), and the lines under it that go on - same left edge (3 mm), a gap under 0.8 of a line,
 * text of the same size (within a fifth: the project name over the title is another field).
 */
type Head = { l: BandLine; text: string };
function titleHeads(p: PageToks): Head[] {
  const tl = p.lines.filter((l) => titleish(l.text)).sort((a, b) => a.box[1] - b.box[1]);
  // the first line (top down) that goes on from a: only the lines from a's top to 0.8 of a line under
  // it are looked at - they are in top-down order (every line was tried for every line: 400 band lines
  // a page, sweep 0.13)
  const under = (j: number) => {
    const a = tl[j], ah = a.box[3] - a.box[1];
    for (let k = j + 1; k < tl.length; k++) {
      const l = tl[k], lh = l.box[3] - l.box[1];
      if (l.box[1] - a.box[3] >= 0.8 * ah) return undefined;
      if (Math.abs(l.box[0] - a.box[0]) < 3 * MM && l.box[1] > a.box[1] && lh > 0.8 * ah && lh < 1.25 * ah) return l;
    }
    return undefined;
  };
  const below = new Map<BandLine, BandLine>();
  tl.forEach((l, j) => { const u = under(j); if (u) below.set(l, u); });
  const cont = new Set(below.values());
  const out: Head[] = [];
  for (const l of tl) {
    if (cont.has(l)) continue;
    const parts = [l.text];
    for (let cur = below.get(l); cur && parts.length < TITLE_LINES; cur = below.get(cur)) parts.push(cur.text);
    out.push({ l, text: parts.join(' ') });
  }
  return out;
}

/** the page's title: the title (its lines) at the title spot */
function titleOf(p: PageToks, c: [number, number], no: Tok, heads: Head[]): string {
  const at = (l: BandLine) => [Math.floor((p.w - l.box[0]) / CELL), Math.floor((p.h - l.box[1]) / CELL)] as [number, number];
  const h = heads.find((x) => { const lc = at(x.l); return lc[0] === c[0] && lc[1] === c[1]; }) || heads.find((x) => near(at(x.l), c));
  if (!h) return '';
  let t = h.text;
  // (never the number itself)
  t = t.replace(no.raw, '').trim();
  try { t = cleanTitle(t); } catch { /* as it is */ }
  return t.replace(/\s+/g, ' ').slice(0, 120);
}

export interface Ref { page: number; box: Box; target: number; text: string }

const KEYWORD = /\b(SEE|REFER|REF|DWG|DWGS|DRG|DRAWING|DRAWINGS|SHEET|SHT|DETAIL|DET|SECTION|SEC|ELEVATION|ELEV|PLAN)\.?\b/;

/**
 * The references between sheets: a candidate outside the title band whose compared form is a known
 * sheet's - or the end of exactly one sheet's number at a "-" ("AR-10140" for "PRJ-AB1-DWG-AR-10140")
 * - and not the page's own. Numbers of digits only need 5 digits or a word like SEE / DWG / DETAIL
 * before them (room numbers, levels and quantities are digits too); to a sheet read at a spot whose
 * numbers repeat, always that word. A number on more than one sheet is never linked: which of them
 * is meant cannot be told, and a wrong link is worse than none (PLAN 9.3b: the user's A1 set holds
 * 112 numbers several times). Only sheets of this file are ever linked.
 */
export function findRefs(pages: PageToks[], idx: SheetIndex): Ref[] {
  if (!idx.sheets.length) return [];
  const tails = new Map<string, number | -1>();
  for (const s of idx.sheets) {
    const parts = s.key.split('-');
    for (let k = 1; k < parts.length; k++) {
      const tail = parts.slice(k).join('-');
      if (!/\d/.test(tail) || tail.length < 3) continue;
      if (!/\p{L}/u.test(tail) && tail.replace(/\D/g, '').length < 5) continue;
      if (idx.byKey.has(tail)) continue;
      const had = tails.get(tail);
      tails.set(tail, had === undefined || had === s.page ? s.page : -1);
    }
  }
  const own = new Map(idx.sheets.map((s) => [s.page, s]));
  const count = new Map<string, number>();
  for (const s of idx.sheets) count.set(s.key, (count.get(s.key) || 0) + 1);
  const out: Ref[] = [];
  for (const p of pages) {
    if (!p) continue;
    for (const t of p.toks) {
      if (t.band) continue;
      let target = (count.get(t.key) ?? 0) > 1 ? undefined : idx.byKey.get(t.key);
      if (target === undefined && !count.has(t.key)) { const tl = tails.get(t.key); target = tl !== undefined && tl >= 0 ? tl : undefined; }
      if (target === undefined || target === p.page || own.get(p.page)?.key === t.key) continue;
      if (/^\d+$/.test(t.key) && (t.key.length < 5 || own.get(target)?.repeats) && !KEYWORD.test(t.pre)) continue;
      out.push({ page: p.page, box: t.box, target, text: t.raw });
    }
  }
  return out;
}

/** `work`, or less if `stopped()` says so meanwhile (asked 5 times a second): the scan's Cancel did
 *  not stop a heavy page merge under way (sweep S10) */
export async function unlessStopped(work: Promise<void>, stopped: () => boolean): Promise<void> {
  let t: ReturnType<typeof setInterval> | undefined;
  try { await Promise.race([work, new Promise<void>((r) => { t = setInterval(() => { if (stopped()) r(); }, 200); })]); }
  finally { clearInterval(t); }
}
