// Tables: from ruled lines (full grids, column lines only - the usual bill of quantities -,
// row lines only) and from text that lines up in columns. Rows of a bill where only the
// columns are ruled are found from the text: item numbers, spacing, where the quantities sit.
import type { Box, PageModel, Ruling, Word } from './model';
import { median, quantile, minOf, maxOf, pushAll } from './model';
import { boxOf, tidyRulings, type Row } from './rows';

export interface Cell {
  r: number; c: number; rs: number; cs: number;
  words: Word[];
  /** the cell's text lines (rows of words) top to bottom */
  lines: Word[][];
  fill?: number;
  /** border widths: top, right, bottom, left (0 = none) */
  bd: [number, number, number, number];
}
export interface TRow { y0: number; y1: number; head?: boolean; kind?: 'heading' | 'total' }
export interface Table {
  box: Box;
  xs: number[];
  rows: TRow[];
  cells: Cell[];
  ruled: 'grid' | 'cols' | 'rows' | 'none';
  size: number;
  page: number;
  /** column roles */
  key?: number;
  desc?: number;
  /** continues the previous page's table (set when pages are joined) */
  cont?: boolean;
}

interface Opts { scan: boolean; word: boolean }
/** the same table laid out again on other columns (see detectTables) */
const rebuilds = new WeakMap<Table, (xs: number[]) => Table | null>();

const NUM = /^[(\-−–]?(?:[A-Z]{2,3}\s?)?[\d,]*\.?\d+%?\)?$/;
const isNumberish = (s: string) => NUM.test(s.replace(/\s/g, '')) && /\d/.test(s);
const VALUEISH = /^(-|–|—|nil|n\/a|incl\.?|included|rate only|ro|excl\.?|by others|p\.?s\.?|pc sum|prov\.? sum|provisional sum|lump sum|ls|l\.s\.|item|sum|m|m2|m²|m3|m³|mm|nr|no|nos|kg|t|ton|tonne|lm|l\.m\.|rm|sqm|sq\.m|cum|cu\.m|each|ea|set|pair|day|days|week|weeks|month|months|hr|hrs|ltr|l|%|pcs|unit|units|lot|job)$/i;
const REF = /^(?:[A-Z]{1,3}|[A-Z]{0,2}\d{1,3}(?:\.\d{1,3}){0,4}[a-z]?|\(?[a-z]\)|\(?[ivx]{1,5}\)|\d{1,3}[a-z]|[A-Z]\d{1,3}(?:\.\d{1,3})*)\.?$/;

export function detectTables(pm: PageModel, rows: Row[], o: Opts): { tables: Table[]; used: Set<Word> } {
  const tol = o.scan ? 4 : 2.2;
  const rs = tidyRulings(pm.rulings, o.scan ? 3 : 1.2, o.scan ? 10 : 1.2).filter((r) => r.b - r.a >= 3);
  const tables: Table[] = [];
  const used = new Set<Word>();
  const words = rows.flatMap((r) => r.words);

  // ---------------------------------------------------------------- groups of connected lines
  let groups = components(rs, tol);
  // a frame around the whole page (or most of it) holds the content, it isn't a table: take it off
  const peeled: Ruling[][] = [];
  for (const g of groups) {
    const b = boxOfR(g);
    if ((b[2] - b[0]) * (b[3] - b[1]) > pm.w * pm.h * 0.35) {
      const rest = peel(g, b);
      if (rest) { peeled.push(...components(rest, tol)); continue; }
    }
    peeled.push(g);
  }
  groups = peeled;
  // lone upright lines that run side by side: the columns of a bill (no lines across)
  const singles = groups.filter((g) => g.length === 1);
  groups = groups.filter((g) => g.length > 1);
  groups.push(...looseColumns(singles.filter((g) => g[0].o === 'v').map((g) => g[0])));
  groups.push(...looseRows(singles.filter((g) => g[0].o === 'h').map((g) => g[0])));

  // bigger groups first; a group over a table already found (a fold in the paper, a stamp's frame) is not another table
  groups.sort((a, b) => area(boxOfR(b)) - area(boxOfR(a)));
  for (const g of groups) {
    const gb = boxOfR(g);
    if (tables.some((t) => overlap(t.box, gb) > Math.min(area(t.box), area(gb)) * 0.35)) continue;
    const free = rows.map((r) => ({ ...r, words: r.words.filter((w) => !used.has(w)) })).filter((r) => r.words.length);
    // column lines broken into pieces on a copy (faint toner) don't join the rest: long upright
    // pieces inside the table are offered as columns too (taken if no text runs across them)
    const gh = gb[3] - gb[1];
    const extra = rs.filter((r) => r.o === 'v' && !g.includes(r) && r.c > gb[0] + tol * 2 && r.c < gb[2] - tol * 2 && r.a > gb[1] - tol && r.b < gb[3] + tol && r.b - r.a >= Math.max(60, gh * 0.15));
    const t = fromLines(g, free, pm, tol, o, extra);
    if (t) { tables.push(t); for (const c of t.cells) for (const w of c.words) used.add(w); }
  }
  tables.sort((a, b) => a.box[1] - b.box[1]);
  // a heading block ruled as a table of its own right above the body: the body's columns split
  // finer (values side by side under one heading) - the heading is laid out on the body's
  // columns too (else the sheet joins the two on the heading's columns: several values a cell)
  for (let k = 0; k + 1 < tables.length; k++) {
    const A = tables[k], B = tables[k + 1];
    const again = rebuilds.get(A);
    const gap = B.box[1] - A.box[3], t2 = tol * 2;
    if (!again || gap > 30 || gap < -4 || Math.abs(A.box[0] - B.box[0]) > t2 || Math.abs(A.box[2] - B.box[2]) > t2) continue;
    if (B.xs.length <= A.xs.length || !A.xs.every((x) => B.xs.some((y) => Math.abs(x - y) <= t2))) continue;
    const t = again(B.xs);
    if (t) tables[k] = t;
  }
  const HEAD_WORDS = ['item', 'itemno', 'no', 'ref', 'sno', 'srno', 'description', 'itemdescription', 'qty', 'quantity', 'unit', 'uom', 'rate', 'amount', 'total', 'price', 'unitprice', 'remarks', 'dirhams', 'aed', 'dhs', 'code', 'type', 'location', 'size', 'finish', 'date', 'value', 'labour', 'material', 'materials', 'supply', 'install', 'mark', 'qtyunit', 'totalamount', 'amountaed', 'rateaed', 'workdescription'];
function headWord(s: string): boolean {
  const parts = s.toLowerCase().split(/[\s\n/]+/).map((p) => p.replace(/[^a-z]/g, '')).filter((p) => p.length >= 2);
  return parts.some((p) => HEAD_WORDS.some((h) => h === p || (p.length >= 4 && h.length >= 4 && similarWord(p, h))));
}
/** one letter wrong in a word of four or more (OCR: "QIY", "UNlT", "AMOUNI") */
function similarWord(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, err = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++err > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return err + (a.length - i) + (b.length - j) <= 1;
}

// ---------------------------------------------------------------- tables without lines
  for (const t of unruled(rows, used, pm, o)) { tables.push(t); for (const c of t.cells) for (const w of c.words) used.add(w); }
  // words in a table's area that the table didn't take (outside its columns): leave for the text flow
  void words;
  // text turned on its side inside a table (column headings printed upwards to fit: "S 235",
  // "EN 10025:1993") is not in the text rows: put in the cell it sits in, one line per column of it
  const turned = pm.words.filter((w) => w.turn && !used.has(w));
  for (const t of tables) {
    const inT = turned.filter((w) => { const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2; return cx > t.box[0] && cx < t.box[2] && cy > t.box[1] && cy < t.box[3]; });
    if (!inT.length) continue;
    // one column of turned text (words above each other, close) is one piece of text
    const groups: Word[][] = [];
    for (const w of inT.slice().sort((p, q) => p.x0 - q.x0 || p.y0 - q.y0)) {
      const wide = w.x1 - w.x0;
      const g = groups.find((k) => Math.abs((k[0].x0 + k[0].x1) / 2 - (w.x0 + w.x1) / 2) < Math.max(2, wide * 0.6) && k.some((x) => Math.max(x.y0, w.y0) - Math.min(x.y1, w.y1) < wide * 2));
      if (g) g.push(w); else groups.push([w]);
    }
    for (const col of groups) {
      // read along its turn (upwards: bottom first), and put in the cell its middle is in
      col.sort((p, q) => (p.turn === 3 ? q.y1 - p.y1 : p.y0 - q.y0));
      const one: Word = { ...col[0], text: col.map((w) => w.text).join(' '), g: col.flatMap((w) => w.g), x0: minOf(col, (w) => w.x0), y0: minOf(col, (w) => w.y0), x1: maxOf(col, (w) => w.x1), y1: maxOf(col, (w) => w.y1) };
      const cx = (one.x0 + one.x1) / 2, cy = (one.y0 + one.y1) / 2;
      const r = t.rows.findIndex((row) => cy >= row.y0 && cy < row.y1);
      let c = 0;
      while (c + 2 < t.xs.length && cx >= t.xs[c + 1]) c++;
      const cell = r < 0 ? undefined : t.cells.find((x) => r >= x.r && r < x.r + x.rs && c >= x.c && c < x.c + x.cs);
      if (!cell) continue;
      cell.words.push(one);
      cell.lines.push([one]);
      for (const w of col) used.add(w);
    }
  }
  return { tables, used };
}

// ---------------------------------------------------------------- line groups

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

function components(rs: Ruling[], tol: number): Ruling[][] {
  const parent = rs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const hs: number[] = [], vs: number[] = [];
  rs.forEach((r, i) => (r.o === 'h' ? hs : vs).push(i));
  // (upright lines sorted by position: each line across only looks at those within its span)
  vs.sort((a, b) => rs[a].c - rs[b].c);
  const vc = vs.map((i) => rs[i].c);
  for (const hi of hs) {
    const h = rs[hi];
    let lo = 0, up = vc.length;
    while (lo < up) { const mid = (lo + up) >> 1; if (vc[mid] < h.a - tol) lo = mid + 1; else up = mid; }
    for (let k = lo; k < vs.length && vc[k] <= h.b + tol; k++) {
      const v = rs[vs[k]];
      if (h.c >= v.a - tol && h.c <= v.b + tol) parent[find(hi)] = find(vs[k]);
    }
  }
  const m = new Map<number, Ruling[]>();
  rs.forEach((r, i) => { const k = find(i); if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); });
  return [...m.values()];
}
const boxOfR = (g: Ruling[]): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of g) {
    if (r.o === 'h') { x0 = Math.min(x0, r.a); x1 = Math.max(x1, r.b); y0 = Math.min(y0, r.c); y1 = Math.max(y1, r.c); }
    else { y0 = Math.min(y0, r.a); y1 = Math.max(y1, r.b); x0 = Math.min(x0, r.c); x1 = Math.max(x1, r.c); }
  }
  return [x0, y0, x1, y1];
};
/** the four outermost lines when they frame the whole group */
function peel(g: Ruling[], b: Box): Ruling[] | null {
  const w = b[2] - b[0], h = b[3] - b[1];
  const hs = g.filter((r) => r.o === 'h' && r.b - r.a > w * 0.95);
  const vs = g.filter((r) => r.o === 'v' && r.b - r.a > h * 0.95);
  const top = hs.find((r) => Math.abs(r.c - b[1]) < 3), bot = hs.find((r) => Math.abs(r.c - b[3]) < 3);
  const lef = vs.find((r) => Math.abs(r.c - b[0]) < 3), rig = vs.find((r) => Math.abs(r.c - b[2]) < 3);
  if (!top || !bot || !lef || !rig) return null;
  const rest = g.filter((r) => r !== top && r !== bot && r !== lef && r !== rig);
  // the frame alone, or the frame of a real table (lines inside reach it on most rows): keep as it is
  const inner = rest.filter((r) => (r.o === 'h' ? r.b - r.a > w * 0.9 : r.b - r.a > h * 0.9));
  if (inner.length >= Math.max(2, rest.length * 0.6)) return null;
  return rest;
}
function looseColumns(vs: Ruling[]): Ruling[][] {
  const long = vs.filter((v) => v.b - v.a >= 30).sort((a, b) => a.c - b.c);
  const out: Ruling[][] = [];
  const taken = new Set<Ruling>();
  for (const v of long) {
    if (taken.has(v)) continue;
    const g = [v];
    for (const u of long) {
      if (u === v || taken.has(u)) continue;
      const ov = Math.min(u.b, v.b) - Math.max(u.a, v.a);
      if (ov > Math.min(u.b - u.a, v.b - v.a) * 0.6 && u.c - g[g.length - 1].c < 400 && u.c > g[g.length - 1].c) g.push(u);
    }
    if (g.length >= 3) { out.push(g); for (const u of g) taken.add(u); }
  }
  return out;
}
function looseRows(hs: Ruling[]): Ruling[][] {
  const list = hs.filter((h) => h.b - h.a >= 60).sort((a, b) => a.c - b.c);
  const out: Ruling[][] = [];
  const taken = new Set<Ruling>();
  for (const h of list) {
    if (taken.has(h)) continue;
    const g = [h];
    for (const u of list) {
      if (u === h || taken.has(u) || u.c <= g[g.length - 1].c) continue;
      if (Math.abs(u.a - h.a) < 6 && Math.abs(u.b - h.b) < 6 && u.c - g[g.length - 1].c < 120) g.push(u);
    }
    if (g.length >= 3) { out.push(g); for (const u of g) taken.add(u); }
  }
  return out;
}

const cluster = (vals: number[], tol: number): number[] => {
  const s = vals.slice().sort((a, b) => a - b);
  const out: number[][] = [];
  for (const v of s) {
    const g = out[out.length - 1];
    if (g && v - g[g.length - 1] <= tol) g.push(v);
    else out.push([v]);
  }
  return out.map((g) => median(g));
};

/** how much of [a, b] the lines at position c (within tol) cover */
function coverage(lines: Ruling[], c: number, a: number, b: number, tol: number): number {
  if (b <= a) return 0;
  const segs = lines.filter((r) => Math.abs(r.c - c) <= tol).map((r) => [Math.max(a, r.a), Math.min(b, r.b)]).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
  let tot = 0, end = a;
  for (const [x, y] of segs) { if (y <= end) continue; tot += y - Math.max(x, end); end = y; }
  return tot / (b - a);
}

// ---------------------------------------------------------------- a table from a group of lines

function fromLines(g: Ruling[], rows: Row[], pm: PageModel, tol: number, o: Opts, extra: Ruling[] = []): Table | null {
  const hs = g.filter((r) => r.o === 'h'), vs = g.filter((r) => r.o === 'v');
  const b = boxOfR(g);
  let xs = cluster(vs.map((v) => v.c), tol);
  let ys = cluster(hs.map((h) => h.c), tol);
  // the outer edges where only one direction is ruled
  if (!xs.length || xs[0] > b[0] + 3) xs.unshift(b[0]);
  if (xs[xs.length - 1] < b[2] - 3) xs.push(b[2]);
  if (!ys.length || ys[0] > b[1] + 3) ys.unshift(b[1]);
  if (ys[ys.length - 1] < b[3] - 3) ys.push(b[3]);
  if (ys[0] < b[1] - 1) ys[0] = b[1];
  const ruled: Table['ruled'] = vs.length >= 2 && hs.length >= 2 ? 'grid' : vs.length >= 2 ? 'cols' : 'rows';
  const box: Box = [xs[0], ys[0], xs[xs.length - 1], ys[ys.length - 1]];
  if (box[2] - box[0] < 20 || box[3] - box[1] < 8) return null;
  // text rows inside (words whose centre is inside)
  const m = o.scan ? 7 : 1.5;
  const inBox = (w: Word) => { const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2; return cx > box[0] - m && cx < box[2] + m && cy > box[1] - 1 && cy < box[3] + 1; };
  const trows = rows.map((r) => ({ ...r, words: r.words.filter(inBox) })).filter((r) => r.words.length);
  if (!trows.length) return null;
  if (extra.length && ruled !== 'rows') {
    const crosses = (x: number) => trows.some((r) => r.words.some((w) => w.x0 < x - 1.5 && w.x1 > x + 1.5));
    // pieces of the columns already there make those lines whole (no cells joined where they are)
    for (const v of extra) if (xs.some((c) => Math.abs(c - v.c) <= tol)) vs.push(v);
    const add = cluster(extra.map((v) => v.c), tol).filter((x) => !xs.some((c) => Math.abs(c - x) <= tol * 2) && !crosses(x));
    if (add.length) {
      for (const x of add) vs.push(...extra.filter((v) => Math.abs(v.c - x) <= tol));
      xs = [...xs, ...add].sort((a, b) => a - b);
    }
  }
  if (ruled === 'rows') {
    // columns from how the text lines up
    const cols = gutters(trows, box[0], box[2], o);
    if (!cols || cols.length < 3) return null;
    xs = cols;
  } else if (trows.length >= 4) {
    // a table ruled only around groups of columns ("Dimensions: h b tw tf r" under one heading,
    // the designation and its weight in one box): a ruled column whose rows hold several parts
    // apart is split where the parts line up - each value in its own cell, not five in one
    const more: number[] = [];
    for (let c = 0; c + 1 < xs.length; c++) {
      const a = xs[c], b = xs[c + 1];
      if (b - a < 24) continue;
      const inCol = trows.map((r) => ({ ...r, words: r.words.filter((w) => { const cx = (w.x0 + w.x1) / 2; return cx > a && cx < b; }) })).filter((r) => r.words.length);
      if (inCol.length < 4) continue;
      // the rows with more than one part (headings and wrapped text left out: they run across)
      const multi = inCol.filter((r) => r.words.length >= 2);
      if (multi.length < Math.max(3, inCol.length * 0.5)) continue;
      const g = gutters(multi, a, b, o);
      if (!g) continue;
      const cuts = g.slice(1, -1).filter((x) => x - a > 3 && b - x > 3);
      if (!cuts.length) continue;
      // only values (numbers, short codes) after the first part: a description column whose rows
      // repeat the same words ("Supply and install") lines up too, and must stay one column
      const parts = [a, ...cuts, b];
      let valueParts = true;
      for (let k = 1; k + 1 < parts.length && valueParts; k++) {
        const texts = multi.map((r) => r.words.filter((w) => { const cx = (w.x0 + w.x1) / 2; return cx > parts[k] && cx < parts[k + 1]; }).map((w) => w.text).join(' ').trim()).filter(Boolean);
        valueParts = texts.length >= multi.length * 0.5 && texts.filter((t) => isNumberish(t) || t.length <= 4).length >= texts.length * 0.6;
      }
      if (valueParts) more.push(...cuts);
    }
    if (more.length) xs = [...xs, ...more].sort((p, q) => p - q);
  }
  if (xs.length < 2) return null;
  if (o.scan) {
    // a stamp printed over the table: column lines run through its words
    const inner = xs.slice(1, -1);
    for (const r of trows) r.words = r.words.filter((w) => !inner.some((x) => x - w.x0 > (w.x1 - w.x0) * 0.25 && w.x1 - x > (w.x1 - w.x0) * 0.25 && vs.some((v) => Math.abs(v.c - x) < tol && v.a <= w.y1 && v.b >= w.y0)));
    for (let k = trows.length - 1; k >= 0; k--) if (!trows[k].words.length || trows[k].words.every((w) => !/[A-Za-z0-9\u0600-\u06ff]/.test(w.text) && w.text !== '-')) trows.splice(k, 1);
    if (!trows.length) return null;
  }
  // one box with prose in it is a frame, not a table
  if (xs.length === 2 && ys.length === 2) return null;
  const t = build(xs, ys, trows, hs, vs, pm, tol, ruled, o);
  if (!t) return null;
  const filled = t.cells.filter((c) => c.words.length).length;
  if (filled < 2) return null;
  rebuilds.set(t, (nx) => (ruled === 'rows' ? null : build(nx, ys, trows, hs, vs, pm, tol, ruled, o, true)));
  return t;
}

// ---------------------------------------------------------------- shared: rows, cells, merges

interface TR { words: Word[]; base: number; size: number; y0: number; y1: number; x0: number; x1: number }

function build(xs: number[], ys: number[], trows: TR[], hs: Ruling[], vs: Ruling[], pm: PageModel, tol: number, ruled: Table['ruled'], o: Opts, phrases = false): Table | null {
  const nc = xs.length - 1;
  const colOf = (w: Word) => {
    const cx = (w.x0 + w.x1) / 2;
    for (let c = 0; c < nc; c++) if (cx < xs[c + 1]) return c;
    return nc - 1;
  };
  // column roles from all the table's text
  const stats = colStats(trows, colOf, nc);
  // bands between ruled rows -> logical rows
  const rowsOut: { y0: number; y1: number; band: number; lines: TR[] }[] = [];
  for (let k = 0; k + 1 < ys.length; k++) {
    const y0 = ys[k], y1 = ys[k + 1];
    const lines = trows.filter((r) => r.base - r.size * 0.3 > y0 && r.base - r.size * 0.3 < y1).sort((a, b) => a.base - b.base);
    if (!lines.length) { if (y1 - y0 > 4 && ruled !== 'cols') rowsOut.push({ y0, y1, band: k, lines: [] }); continue; }
    const groups = lines.length > 1 ? groupRows(lines, colOf, stats, o) : [[0]];
    groups.forEach((gi, n) => {
      const ls = gi.map((i) => lines[i]);
      const top = n === 0 ? y0 : (rowsOut[rowsOut.length - 1].y1);
      let bot = y1;
      if (n + 1 < groups.length) {
        const next = lines[groups[n + 1][0]];
        const last = ls[ls.length - 1];
        bot = (last.y1 + next.y0) / 2;
      }
      rowsOut.push({ y0: top, y1: bot, band: k, lines: ls });
    });
  }
  if (!rowsOut.length) return null;
  // cells
  const nr = rowsOut.length;
  const grid: { words: Word[]; lines: Word[][] }[][] = rowsOut.map((r) => Array.from({ length: nc }, () => ({ words: [] as Word[], lines: [] as Word[][] })));
  /** the column each word went to */
  const placed = new Map<Word, number>();
  rowsOut.forEach((r, ri) => {
    for (const ln of r.lines) {
      const per: Word[][] = Array.from({ length: nc }, () => []);
      if (phrases) {
        // (a heading laid out on finer columns than its own: words that read on - "axe fort y-y"
        // - stay together, in the column of their middle, not one word to each column)
        const ws = ln.words.slice().sort((a, b) => a.x0 - b.x0);
        let ph: Word[] = [];
        const flush = () => { if (!ph.length) return; const mid = (ph[0].x0 + ph[ph.length - 1].x1) / 2; let c = 0; while (c + 1 < nc && mid >= xs[c + 1]) c++; pushAll(per[c], ph); ph = []; };
        for (const w of ws) { if (ph.length && w.x0 - ph[ph.length - 1].x1 > Math.max(ln.size * 0.9, 3.5)) flush(); ph.push(w); }
        flush();
      } else for (const w of ln.words) per[colOf(w)].push(w);
      per.forEach((ws, c) => { if (ws.length) { pushAll(grid[ri][c].words, ws); grid[ri][c].lines.push(ws); for (const w of ws) placed.set(w, c); } });
    }
  });
  // merges: a missing line between two cells joins them (only where the table is ruled that way)
  const parent = new Map<number, number>();
  const id = (r: number, c: number) => r * nc + c;
  const find = (i: number): number => { const p = parent.get(i) ?? i; if (p === i) return i; const q = find(p); parent.set(i, q); return q; };
  const union = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent.set(y, x); };
  const vAt = (x: number, a: number, b: number) => coverage(vs, x, a, b, tol);
  const hAt = (y: number, a: number, b: number) => coverage(hs, y, a, b, tol);
  if (ruled === 'grid') {
    for (let r = 0; r < nr; r++) {
      const { y0, y1 } = rowsOut[r];
      for (let c = 0; c + 1 < nc; c++) if (vAt(xs[c + 1], y0 + 1, y1 - 1) < 0.5 && !(grid[r][c].words.length && grid[r][c + 1].words.length)) union(id(r, c), id(r, c + 1));
    }
    for (let r = 0; r + 1 < nr; r++) {
      if (rowsOut[r].band === rowsOut[r + 1].band) continue; // split from text: separate rows
      const y = rowsOut[r].y1;
      for (let c = 0; c < nc; c++) if (hAt(y, xs[c] + 1, xs[c + 1] - 1) < 0.5 && !(grid[r][c].words.length && grid[r + 1][c].words.length)) union(id(r, c), id(r + 1, c));
    }
  }
  // merged groups must be rectangles
  const groups = new Map<number, number[]>();
  for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) { const k = find(id(r, c)); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(id(r, c)); }
  const cells: Table['cells'] = [];
  const fillOf = (bx: Box) => {
    const a = (bx[2] - bx[0]) * (bx[3] - bx[1]);
    for (const f of pm.fills) {
      const ov = Math.max(0, Math.min(f.box[2], bx[2]) - Math.max(f.box[0], bx[0])) * Math.max(0, Math.min(f.box[3], bx[3]) - Math.max(f.box[1], bx[1]));
      if (a > 0 && ov > a * 0.6 && (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]) < a * 30) return f.color;
    }
    return undefined;
  };
  const bw = (lines: Ruling[], c: number, a: number, b: number) => { const l = lines.filter((x) => Math.abs(x.c - c) <= tol && Math.min(x.b, b) - Math.max(x.a, a) > (b - a) * 0.5); return l.length ? Math.max(...l.map((x) => x.w)) : 0; };
  for (const ids of groups.values()) {
    const rsI = ids.map((i) => Math.floor(i / nc)), csI = ids.map((i) => i % nc);
    const id1 = (x: number) => x, r0 = minOf(rsI, id1), r1 = maxOf(rsI, id1), c0 = minOf(csI, id1), c1 = maxOf(csI, id1);
    const rect = (r1 - r0 + 1) * (c1 - c0 + 1) === ids.length;
    const parts = rect ? [[r0, c0, r1, c1]] : ids.map((i) => [Math.floor(i / nc), i % nc, Math.floor(i / nc), i % nc]);
    for (const [a0, b0, a1, b1] of parts) {
      const ws: Word[] = [], lines: Word[][] = [];
      for (let r = a0; r <= a1; r++) for (let c = b0; c <= b1; c++) pushAll(ws, grid[r][c].words);
      // lines of a merged cell: its rows' words regrouped
      for (let r = a0; r <= a1; r++) for (const ln of rowsOut[r].lines) { const l = ln.words.filter((w) => { const c = placed.get(w) ?? colOf(w); return c >= b0 && c <= b1; }); if (l.length) lines.push(l); }
      const bx: Box = [xs[b0], rowsOut[a0].y0, xs[b1 + 1], rowsOut[a1].y1];
      cells.push({
        r: a0, c: b0, rs: a1 - a0 + 1, cs: b1 - b0 + 1, words: ws, lines, fill: fillOf(bx),
        bd: [bw(hs, bx[1], bx[0], bx[2]), bw(vs, bx[2], bx[1], bx[3]), bw(hs, bx[3], bx[0], bx[2]), bw(vs, bx[0], bx[1], bx[3])],
      });
    }
  }
  cells.sort((a, b) => a.r - b.r || a.c - b.c);
  const trs: TRow[] = rowsOut.map((r) => ({ y0: r.y0, y1: r.y1 }));
  const t: Table = { box: [xs[0], rowsOut[0].y0, xs[nc], rowsOut[nr - 1].y1], xs, rows: trs, cells, ruled, size: median(trows.map((r) => r.size)), page: pm.i, key: stats.key, desc: stats.desc };
  markRows(t, hs, tol);
  return t;
}

// ---------------------------------------------------------------- column roles + rows of a bill

interface ColStats { key?: number; desc?: number; value: boolean[]; numeric: number[]; filled: number[] }

function colStats(trows: TR[], colOf: (w: Word) => number, nc: number): ColStats {
  const filled = new Array(nc).fill(0), numeric = new Array(nc).fill(0), refs = new Array(nc).fill(0), chars = new Array(nc).fill(0), unitish = new Array(nc).fill(0);
  for (const r of trows) {
    const per: string[] = new Array(nc).fill('');
    for (const w of r.words) { const c = colOf(w); per[c] = per[c] ? per[c] + ' ' + w.text : w.text; }
    per.forEach((s, c) => {
      if (!s) return;
      filled[c]++;
      chars[c] += s.length;
      if (isNumberish(s)) numeric[c]++;
      if (VALUEISH.test(s.trim())) unitish[c]++;
      if (REF.test(s.trim()) && s.length <= 10) refs[c]++;
    });
  }
  let desc: number | undefined;
  let best = 0;
  for (let c = 0; c < nc; c++) if (chars[c] > best) { best = chars[c]; desc = c; }
  let key: number | undefined;
  for (let c = 0; c < Math.min(2, nc); c++) {
    if (c === desc) continue;
    if (filled[c] >= 2 && refs[c] >= filled[c] * 0.6 && chars[c] / filled[c] <= 9) { key = c; break; }
  }
  const value = new Array(nc).fill(false).map((_, c) => c !== desc && c !== key && filled[c] > 0 && (numeric[c] + unitish[c]) >= filled[c] * 0.5);
  return { key, desc, value, numeric: numeric.map((n, c) => (filled[c] ? n / filled[c] : 0)), filled };
}

/** text rows of one ruled band -> logical rows (indices into lines) */
function groupRows(lines: TR[], colOf: (w: Word) => number, st: ColStats, o: Opts): number[][] {
  const n = lines.length;
  const has = lines.map((l) => {
    const cols = new Set(l.words.map(colOf));
    return {
      key: st.key !== undefined && cols.has(st.key) && l.words.some((w) => colOf(w) === st.key && REF.test(w.text)),
      vals: [...cols].filter((c) => st.value[c]).length,
      desc: st.desc !== undefined && cols.has(st.desc),
      only: cols.size === 1 && st.desc !== undefined && cols.has(st.desc),
      bold: l.words.length > 0 && l.words.every((w) => w.g.every((g) => g.bold || g.ul || g.c === ' ') ) ,
      caps: l.words.map((w) => w.text).join(' ').replace(/[^A-Za-z]/g, '').length > 3 && l.words.map((w) => w.text).join(' ') === l.words.map((w) => w.text).join(' ').toUpperCase(),
    };
  });
  const gaps: number[] = [];
  for (let k = 1; k < n; k++) gaps.push(lines[k].base - lines[k - 1].base);
  const size = median(lines.map((l) => l.size));
  const tight = gaps.filter((g) => g < size * 2.2);
  const pitch = tight.length ? quantile(tight, 0.3) : size * 1.2;
  const wide = (k: number) => gaps[k - 1] > pitch * 1.42 + (o.scan ? 1.5 : 0.6);
  const styleBreak = (k: number) => {
    const h = has[k], p = has[k - 1];
    return (h.only && p.only && (h.bold !== p.bold || h.caps !== p.caps) && !p.vals) || (p.vals && h.only && (h.bold || h.caps) && !p.only) || (p.only && (p.bold || p.caps) && !h.only);
  };
  // the item number: on an item's first line (the usual) or its last (bottom-aligned printouts)?
  let kFirst = 0, kLast = 0;
  {
    let b0 = 0;
    for (let k = 1; k <= n; k++) {
      if (k < n && !wide(k) && !styleBreak(k)) continue;
      const blk: number[] = [];
      for (let q = b0; q < k; q++) if (!(has[q].only && (has[q].bold || has[q].caps))) blk.push(q);
      if (blk.length >= 2) {
        const f = has[blk[0]].key, l = has[blk[blk.length - 1]].key;
        if (f && !l) kFirst++;
        else if (!f && l) kLast++;
      }
      b0 = k;
    }
  }
  const keyEnds = kLast > kFirst;
  const start = new Array(n).fill(false);
  start[0] = true;
  for (let k = 1; k < n; k++) {
    if (keyEnds ? has[k - 1].key : has[k].key) start[k] = true;
    else if (wide(k)) start[k] = true;
    else if (styleBreak(k)) start[k] = true;
  }
  // where do the values of an item sit: on its last line or its first?
  let last = 0, first = 0;
  const grp = (): number[][] => { const g: number[][] = []; for (let k = 0; k < n; k++) { if (start[k] || !g.length) g.push([k]); else g[g.length - 1].push(k); } return g; };
  for (const g of grp()) {
    if (g.length < 2) continue;
    const vi = g.filter((k) => has[k].vals);
    if (vi.length !== 1) continue;
    if (vi[0] === g[g.length - 1]) last++;
    else if (vi[0] === g[0]) first++;
  }
  if (!last && !first) {
    // nothing to go by inside items: the band's own ends
    if (has[n - 1].vals && !has[0].vals) last = 1;
    else if (has[0].vals && !has[n - 1].vals) first = 1;
    else last = 1;
  }
  const valuesLast = last >= first;
  // two sets of quantities in one row: two items
  for (let k = 1; k < n; k++) {
    if (start[k]) continue;
    if (valuesLast && has[k - 1].vals && has[k].desc) start[k] = true;
    else if (!valuesLast && has[k].vals && has[k].desc) start[k] = true;
  }
  return grp();
}

/** header rows, headings and total rows */
function markRows(t: Table, hs: Ruling[], tol: number) {
  const byRow = new Map<number, Cell[]>();
  for (const c of t.cells) { if (!byRow.has(c.r)) byRow.set(c.r, []); byRow.get(c.r)!.push(c); }
  const text = (c: Cell) => c.words.map((w) => w.text).join(' ');
  // header: the top rows above a ruled line, with no numbers, before the first row with numbers
  let headEnd = -1;
  for (let r = 0; r < Math.min(4, t.rows.length); r++) {
    const cs = (byRow.get(r) || []).filter((c) => c.words.length);
    if (!cs.length) continue;
    const nums = cs.filter((c) => isNumberish(text(c)) && !/^\d{1,2}$/.test(text(c))).length;
    const allBoldOrCaps = cs.every((c) => c.words.every((w) => w.g.every((g) => g.bold || !/[a-z]/.test(g.c))));
    // the words column headings use (read loosely: OCR)
    const named = cs.filter((c) => headWord(text(c))).length;
    if (nums || (!allBoldOrCaps && named < 2)) break;
    // a heading row of a bill (one cell, in the description column) is not the header
    if (cs.length === 1 && t.cells.length > 4 && t.xs.length > 3) break;
    headEnd = r;
    const y = t.rows[r].y1;
    if (hs.some((h) => Math.abs(h.c - y) <= tol && h.b - h.a > (t.box[2] - t.box[0]) * 0.6)) break;
  }
  for (let r = 0; r <= headEnd; r++) t.rows[r].head = true;
  for (let r = headEnd + 1; r < t.rows.length; r++) {
    const cs = (byRow.get(r) || []).filter((c) => c.words.length);
    if (!cs.length) continue;
    const s = cs.map(text).join(' ');
    if (/\b(total|sub-?total|carried|brought|collection|summary|grand)\b/i.test(s) && cs.length <= 3) t.rows[r].kind = 'total';
    else if (cs.length === 1 && t.desc !== undefined && cs[0].c === t.desc && cs[0].words.every((w) => w.g.every((g) => g.bold || g.ul || !/[a-z]/.test(g.c)))) t.rows[r].kind = 'heading';
  }
}

const HEAD_WORDS = ['item', 'itemno', 'no', 'ref', 'sno', 'srno', 'description', 'itemdescription', 'qty', 'quantity', 'unit', 'uom', 'rate', 'amount', 'total', 'price', 'unitprice', 'remarks', 'dirhams', 'aed', 'dhs', 'code', 'type', 'location', 'size', 'finish', 'date', 'value', 'labour', 'material', 'materials', 'supply', 'install', 'mark', 'qtyunit', 'totalamount', 'amountaed', 'rateaed', 'workdescription'];
function headWord(s: string): boolean {
  const parts = s.toLowerCase().split(/[\s\n/]+/).map((p) => p.replace(/[^a-z]/g, '')).filter((p) => p.length >= 2);
  return parts.some((p) => HEAD_WORDS.some((h) => h === p || (p.length >= 4 && h.length >= 4 && similarWord(p, h))));
}
/** one letter wrong in a word of four or more (OCR: "QIY", "UNlT", "AMOUNI") */
function similarWord(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, err = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++err > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return err + (a.length - i) + (b.length - j) <= 1;
}

// ---------------------------------------------------------------- tables without lines

/** column edges from vertical white gaps in a set of text rows (null: no columns) */
function gutters(trows: TR[], x0: number, x1: number, o: Opts): number[] | null {
  const lo = Math.floor(x0), hi = Math.ceil(x1);
  const nb = hi - lo + 1;
  if (nb < 20) return null;
  const cov = new Int32Array(nb);
  for (const r of trows) {
    const mark = new Uint8Array(nb);
    for (const w of r.words) for (let x = Math.max(0, Math.floor(w.x0) - lo); x <= Math.min(nb - 1, Math.ceil(w.x1) - lo); x++) mark[x] = 1;
    for (let x = 0; x < nb; x++) cov[x] += mark[x];
  }
  const n = trows.length;
  const allow = n >= 8 ? Math.floor(n * 0.08) : 0;
  const size = median(trows.map((r) => r.size));
  // with enough rows a narrow white strip is already telling (right-aligned numbers in
  // neighbouring columns can come within a few points of each other)
  const minGap = n >= 6 ? Math.max(o.scan ? 4 : 2.4, size * 0.28) : Math.max(o.scan ? 7 : 5, size * 0.75);
  // rows that hold more than one part (the others are wrapped text)
  const multi = trows.filter((r) => { const ws = r.words.slice().sort((a, b) => a.x0 - b.x0); return ws.some((w, k) => k > 0 && w.x0 - ws[k - 1].x1 > Math.max(r.size * 1.25, 7)); }).length;
  const need = Math.max(2, Math.min(n * 0.3, multi * 0.4));
  const edges = [x0];
  let k = 0;
  // ignore the margins: start at the first covered bin
  while (k < nb && cov[k] <= allow) k++;
  let end = nb - 1;
  while (end > k && cov[end] <= allow) end--;
  for (; k <= end; k++) {
    if (cov[k] > allow) continue;
    let e = k;
    while (e <= end && cov[e] <= allow) e++;
    if (e - k >= minGap) {
      // text on both sides in enough rows
      const L = lo + k, R = lo + e;
      let left = 0, right = 0;
      for (const r of trows) { if (r.words.some((w) => w.x1 <= L + 0.5)) left++; if (r.words.some((w) => w.x0 >= R - 0.5)) right++; }
      if (left >= need && right >= need) edges.push(lo + (k + e) / 2);
    }
    k = e;
  }
  edges.push(x1);
  return edges.length >= 3 ? edges : null;
}

function unruled(rows: Row[], used: Set<Word>, pm: PageModel, o: Opts): Table[] {
  const free = rows.map((r) => ({ ...r, words: r.words.filter((w) => !used.has(w)) })).filter((r) => r.words.length);
  const out: Table[] = [];
  const chunks = (r: TR) => {
    const ws = r.words.slice().sort((a, b) => a.x0 - b.x0);
    let n = 1;
    for (let k = 1; k < ws.length; k++) if (ws[k].x0 - ws[k - 1].x1 > Math.max(r.size * 1.25, 7)) n++;
    return n;
  };
  // blocks of rows without big gaps
  let k = 0;
  while (k < free.length) {
    let e = k + 1;
    while (e < free.length && free[e].base - free[e - 1].base < free[e - 1].size * 2.8) e++;
    const block = free.slice(k, e);
    k = e;
    // runs with several multi-part rows (single-part rows in between: wrapped text)
    let s = 0;
    while (s < block.length) {
      while (s < block.length && chunks(block[s]) < 2) s++;
      if (s >= block.length) break;
      let t = s, lastMulti = s, singles = 0;
      while (t < block.length) {
        if (chunks(block[t]) >= 2) { lastMulti = t; singles = 0; } else if (++singles > 8) break;
        t++;
      }
      const run = block.slice(s, lastMulti + 1);
      s = lastMulti + 1;
      const multi = run.filter((r) => chunks(r) >= 2).length;
      if (multi < 3) continue;
      const x0 = Math.min(...run.map((r) => r.x0)), x1 = Math.max(...run.map((r) => r.x1));
      const xs = gutters(run, x0 - 1, x1 + 1, o);
      if (!xs) continue;
      const t2 = build(xs, [run[0].y0 - 1, run[run.length - 1].y1 + 1], run, [], [], pm, 2, 'none', o);
      if (!t2 || !acceptUnruled(t2, o)) continue;
      out.push(t2);
    }
  }
  return out;
}

function acceptUnruled(t: Table, o: Opts): boolean {
  const nc = t.xs.length - 1;
  const width = t.box[2] - t.box[0];
  const rowsWithTwo = new Map<number, number>();
  for (const c of t.cells) if (c.words.length) rowsWithTwo.set(c.r, (rowsWithTwo.get(c.r) ?? 0) + 1);
  const multiRows = [...rowsWithTwo.values()].filter((v) => v >= 2).length;
  if (multiRows < 3) return false;
  // per column: how much is numbers, how long the text is
  const colText: string[][] = Array.from({ length: nc }, () => []);
  for (const c of t.cells) if (c.words.length) colText[c.c].push(c.words.map((w) => w.text).join(' '));
  const numericCols = colText.filter((ts) => ts.length >= 2 && ts.filter((s) => isNumberish(s) || VALUEISH.test(s)).length >= ts.length * 0.6).length;
  const proseCols = colText.filter((ts, c) => ts.length >= 2 && (t.xs[c + 1] - t.xs[c]) > width * 0.33 && median(ts.map((s) => s.length)) > 30).length;
  // two columns of running text side by side: a page in columns, not a table
  if (proseCols >= 2 && !numericCols) return false;
  // numbered paragraphs ("4.1   The Contractor shall ...") are a list, not a table
  if (o.word && nc === 2 && colText[0].length >= 2 && colText[0].filter((s) => REF.test(s.trim()) || /^[\d.:,]{1,9}$/.test(s.trim())).length >= colText[0].length * 0.7 && median(colText[1].map((s) => s.length)) > 30) return false;
  if (nc === 2 && !numericCols) return o.word ? false : multiRows >= 4;
  if (!numericCols && o.word && proseCols) return false;
  return true;
}

export { boxOf };
