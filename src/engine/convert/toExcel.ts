// Pages -> workbook. "joined": a bill that runs over many pages becomes one sheet (the header
// row once, page headers/footers and page numbers left out), a new sheet where the page
// header changes (the next bill). "pages": one sheet per page, as it is.
import type { FontInfo, ExportOpts, Word } from './model';
import { median, minOf, maxOf } from './model';
import type { PageLayout } from './analyze';
import { rowText, similar } from './analyze';
import type { Cell, Table } from './tables';
import type { Row } from './rows';
import { readingOrder } from './rows';
import { fixOcrNumber, linesText, lookOf, parseNumber, plainWord, usesDecimalComma } from './text';
import { writeWorkbook, type XCell, type XSheet, type XStyle } from './xlsx';

const PT_PER_CHAR = 5.6;

interface SheetState extends XSheet { bill: string; last: { t: Table; head: string; page: number } | null; frozen: boolean; tpl?: number[] | null; headText?: string }

/** the file being written writes decimals with a comma (see usesDecimalComma) */
let decimalComma = false;

export function toExcel(pages: PageLayout[], fonts: FontInfo[], o: ExportOpts): Uint8Array {
  const joined = o.sheets !== 'pages';
  const dropRunning = o.dropRunning !== false;
  // (European tables: 47,4 is forty-seven point four, and 1,359 is one point three five nine)
  decimalComma = usesDecimalComma(pages.flatMap((p) => p.pm.words.map((w) => w.text)));
  const sizes = pages.flatMap((p) => p.pm.words.map((w) => w.size));
  const body = Math.round((median(sizes) || 10) * 2) / 2;
  const fam = topFamily(pages, fonts);
  const defFont = { name: fam, size: Math.min(11, Math.max(8, body)) };
  const sheets: SheetState[] = [];
  let cur: SheetState | null = null;
  const fresh = (name: string, bill: string, pl: PageLayout): SheetState => {
    const s: SheetState = { name, rows: [], heights: [], widths: [], merges: [], bill, last: null, frozen: false, landscape: pl.pm.w > pl.pm.h, paper: paperOf(pl.pm.w, pl.pm.h) };
    sheets.push(s);
    return s;
  };
  // the page-header line that changes between bills (the project name doesn't)
  const constant = constantHeaders(pages);
  for (const pl of pages) {
    const pm = pl.pm;
    if (pm.kind === 'empty') continue;
    const billRows = [...pl.running.entries()].filter(([r, z]) => z === 'h' && !pl.pageNo.has(r)).map(([r]) => r).filter((r) => !constant.some((k) => similar(k, normKey(rowText(r))) > 0.85));
    let bill = billRows.map(rowText).join(' ').trim();
    // no running header: a "BILL No. 4 ..." line at the top of the page names the bill
    if (!bill) {
      const top = pl.flow.filter((r) => r.y0 < pm.h * 0.25).sort((a, b) => a.y0 - b.y0).map(rowText);
      const named = top.map((t) => /\bbill\s*(?:no\.?|number|nr\.?)?\s*[0-9]+[A-Z]?\b.*/i.exec(t)?.[0]).find(Boolean);
      if (named) bill = named.trim();
    }
    // one bill all through: its title is a line that repeats on every page
    if (!bill) {
      const head = [...pl.running.entries()].filter(([r, z]) => z === 'h' && !pl.pageNo.has(r)).map(([r]) => rowText(r));
      bill = head.find((t) => /\b(bill|section|schedule|summary|collection|boq|part)\b/i.test(t)) || '';
    }
    if (!joined) cur = fresh('Page ' + (pm.i + 1), '', pl);
    else if (!cur || (bill && cur.bill && !sameBill(bill, cur.bill, pm.ocr))) cur = fresh(bill ? sheetName(bill) : o.title || 'Sheet1', bill, pl);
    else if (bill && !cur.bill) { cur.bill = bill; if (!cur.rows.length || cur.name === (o.title || 'Sheet1')) cur.name = sheetName(bill); }
    const sh = cur;
    if (pm.kind === 'drawing' || (pm.kind === 'scan' && !pm.words.length)) {
      if (!joined) addRow(sh, [{ v: pm.kind === 'drawing' ? 'This page is a drawing: there is no table or text to take out.' : 'This page is a scan that was not read.', st: { font: { ...defFont, i: true, color: 0x666666 } } }]);
      continue;
    }
    // what goes on the sheet, top to bottom
    type El = { y: number; t?: Table; r?: Row };
    const els: El[] = [];
    for (const t of pl.tables) els.push({ y: t.box[1], t });
    for (const r of pl.flow) {
      const z = pl.running.get(r);
      if (z && (joined ? dropRunning : false)) continue;
      els.push({ y: r.y0, r });
    }
    els.sort((a, b) => a.y - b.y);
    const main = pl.tables.slice().sort((a, b) => b.cells.length - a.cells.length)[0];
    for (const el of els) {
      if (el.t) writeTable(sh, el.t, pl, fonts, defFont, joined);
      else if (el.r) writeText(sh, el.r, main && sh.tpl ? { ...main, xs: sh.tpl } : main, fonts, defFont, pm.ocr);
    }
  }
  if (!sheets.length) sheets.push({ name: 'Sheet1', rows: [[{ v: 'No text was found in this file.', st: { font: { ...defFont, i: true } } }]], heights: [], widths: [], merges: [], bill: '', last: null, frozen: false });
  for (const s of sheets) if (!s.widths.length) s.widths = [Math.max(12, Math.min(100, maxOf(s.rows, (r) => String(r[0]?.v ?? '').length * 0.9)))];
  return writeWorkbook(sheets, defFont);
}

function topFamily(pages: PageLayout[], fonts: FontInfo[]): string {
  const m = new Map<string, number>();
  for (const p of pages) for (const w of p.pm.words) { const f = fonts[w.g[0]?.f]?.family; if (f) m.set(f, (m.get(f) ?? 0) + w.text.length); }
  let best = 'Arial', n = 0;
  for (const [k, v] of m) if (v > n && !/symbol|wingdings/i.test(k)) { n = v; best = k; }
  return best;
}
const paperOf = (w: number, h: number) => { const a = Math.max(w, h), b = Math.min(w, h); if (Math.abs(a - 842) < 20 && Math.abs(b - 595) < 20) return 9; if (Math.abs(a - 1191) < 25 && Math.abs(b - 842) < 25) return 8; if (Math.abs(a - 792) < 15 && Math.abs(b - 612) < 15) return 1; if (Math.abs(a - 1008) < 15) return 5; return undefined; };
const normKey = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#؀-ۿ]+/g, '');
export const sheetName = (s: string) => s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
/** the same bill on the next page? On a scan the bill's number is where OCR slips ("NO.09" read as
 *  "NO.0S", "10.09"): there the title after it decides */
function sameBill(a: string, b: string, ocr: boolean): boolean {
  if (similar(normKey(a), normKey(b)) >= 0.8) return true;
  if (!ocr) return false;
  const title = (s: string) => normKey(s.replace(/^\s*bill\s*(?:no\.?|number|nr\.?)?\s*[\w.¢$§%]{1,6}\s*[-–:]?\s*/i, ''));
  const ta = title(a), tb = title(b);
  return ta.length >= 6 && tb.length >= 6 && similar(ta, tb) >= 0.8;
}

/** page-header lines found on (nearly) every page */
function constantHeaders(pages: PageLayout[]): string[] {
  const counts = new Map<string, number>();
  for (const p of pages) {
    const seen = new Set<string>();
    for (const [r, z] of p.running) if (z === 'h' && !p.pageNo.has(r)) seen.add(normKey(rowText(r)));
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const n = pages.filter((p) => p.pm.kind !== 'empty').length;
  // fuzzy (OCR): keys close to each other count together
  const keys = [...counts.keys()];
  const out: string[] = [];
  for (const k of keys) {
    const v = keys.reduce((s, q) => s + (similar(k, q) > 0.85 ? counts.get(q)! : 0), 0);
    if (v >= Math.max(2, n * 0.85)) out.push(k);
  }
  return out;
}

function addRow(sh: XSheet, cells: (XCell | null)[], height?: number) {
  sh.rows.push(cells);
  sh.heights.push(height);
}

function styleOf(ws: Word[], fonts: FontInfo[], def: { name: string; size: number }): XStyle {
  const lk = lookOf(ws, fonts);
  return { font: { name: lk.family || def.name, size: lk.size || def.size, b: lk.bold || undefined, i: lk.italic || undefined, u: lk.ul || undefined, s: lk.strike || undefined, color: lk.color || undefined } };
}

const headKey = (t: Table) => t.cells.filter((c) => t.rows[c.r]?.head).map((c) => c.words.map((w) => w.text).join(' ')).join('|').toLowerCase().replace(/[^a-z0-9|]/g, '');

/** same columns (within a little) - a table carrying on from the last page */
function sameColumns(a: Table, b: Table, tol: number): boolean {
  if (a.xs.length !== b.xs.length) return false;
  return a.xs.every((x, i) => Math.abs(x - b.xs[i]) <= tol);
}

/** each column of a table -> the sheet's column it lines up with (scans move a little from page to page) */
function mapColumns(tpl: number[], xs: number[]): { map: number[]; quality: number } {
  const n = xs.length - 1, m = tpl.length - 1;
  const map = new Array(n).fill(-1);
  let good = 0;
  for (let c = 0; c < n; c++) {
    let best = -1, br = 0;
    for (let j = 0; j < m; j++) {
      const ov = Math.min(xs[c + 1], tpl[j + 1]) - Math.max(xs[c], tpl[j]);
      const r = ov / Math.max(1, Math.min(xs[c + 1] - xs[c], tpl[j + 1] - tpl[j]));
      if (r > br) { br = r; best = j; }
    }
    if (br >= 0.5) { map[c] = best; good++; }
  }
  // the unplaced ones: the nearest column by centre
  for (let c = 0; c < n; c++) if (map[c] < 0) {
    const mid = (xs[c] + xs[c + 1]) / 2;
    let best = 0, bd = Infinity;
    for (let j = 0; j < m; j++) { const d = Math.abs((tpl[j] + tpl[j + 1]) / 2 - mid); if (d < bd) { bd = d; best = j; } }
    map[c] = best;
  }
  const hit = new Set(map).size;
  return { map, quality: Math.min(good / Math.max(1, n), hit / Math.max(1, m)) };
}

const letters = (s: string) => s.toLowerCase().replace(/[^a-z\u0600-\u06ff]+/g, '');
const rowLetters = (t: Table, r: number) => letters(t.cells.filter((c) => c.r === r).map((c) => c.words.map((w) => w.text).join(' ')).join(' '));

function writeTable(sh: SheetState, t: Table, pl: PageLayout, fonts: FontInfo[], def: { name: string; size: number }, joined: boolean) {
  const nc = t.xs.length - 1;
  const hk = headKey(t);
  const tol = pl.pm.ocr ? Math.max(8, pl.pm.w * 0.015) : 4;
  let colMap = Array.from({ length: nc }, (_, i) => i);
  let cont = false;
  if (joined && sh.last && sh.tpl && pl.pm.i - sh.last.page <= 2) {
    const same = sameColumns(sh.last.t, t, tol);
    const m = same ? { map: colMap, quality: 1 } : mapColumns(sh.tpl, t.xs);
    // (OCR mangles headings differently on every page: there the columns decide)
    const headOk = pl.pm.ocr || !hk || !sh.last.head || similar(hk, sh.last.head) > 0.75;
    if (m.quality >= (pl.pm.ocr ? 0.7 : 0.9) && headOk) { cont = true; colMap = m.map; }
  }
  if (!cont && sh.rows.length) addRow(sh, []);
  const ncols = cont ? sh.tpl!.length - 1 : nc;
  if (!cont) sh.tpl = t.xs.slice();
  // column widths: the first table on the sheet sets them (a wider one adds columns)
  const widths = t.xs.slice(1).map((x, i) => Math.max(3, (x - t.xs[i]) / PT_PER_CHAR));
  if (!sh.widths.length) sh.widths = widths;
  else if (!cont) for (let c = sh.widths.length; c < widths.length; c++) sh.widths.push(widths[c]);
  const first = sh.rows.length;
  const rowAt = new Map<number, number>();
  // carrying on: the repeated header, and "(CONT'D)" headings, are left out
  const headText = sh.headText || '';
  const skip = (r: number) => cont && (!!t.rows[r].head || (r < 3 && !!headText && similar(rowLetters(t, r), headText) > 0.6) || (t.rows[r].kind === 'heading' && /cont'?d|continued/i.test(t.cells.filter((c) => c.r === r).map((c) => c.words.map((w) => w.text).join(' ')).join(' '))));
  const startRows: number[] = [];
  for (let r = 0; r < t.rows.length; r++) {
    if (skip(r)) continue;
    rowAt.set(r, sh.rows.length);
    startRows.push(r);
    addRow(sh, new Array(ncols).fill(null));
  }
  const byStart = new Map<number, Cell[]>();
  for (const c of t.cells) { if (!byStart.has(c.r)) byStart.set(c.r, []); byStart.get(c.r)!.push(c); }
  const heights = new Map<number, number>();
  const numericCol = numericColumns(t);
  // columns printed with two decimals (most of their numbers read that way)
  const dec2 = Array.from({ length: nc }, (_, c) => {
    const vals = t.cells.filter((x) => x.c === c && !t.rows[x.r]?.head && x.words.length).map((x) => x.words.map((w) => w.text).join(''));
    const nums = vals.filter((v) => /^[\d,]+(\.\d+)?$/.test(v));
    return nums.length >= 3 && nums.filter((v) => /\.\d\d$/.test(v)).length >= nums.length * 0.6;
  });
  // a column of clause / item references (1.1, 1.2 ... 1.10, 2.1.3) stays text: 1.10 is not 1.1
  const refCol = Array.from({ length: nc }, (_, c) => {
    const vals = t.cells.filter((x) => x.c === c && !t.rows[x.r]?.head && x.words.length).map((x) => x.words.map((w) => w.text).join(''));
    const dotted = vals.filter((v) => /^\d{1,3}(\.\d{1,3}){1,4}[a-z]?\.?$/.test(v));
    if (vals.length < 2 || dotted.length < vals.length * 0.6 || vals.some((v) => v.includes(','))) return false;
    const decs = new Set(dotted.map((v) => (v.split('.')[1] || '').length));
    const head = t.cells.filter((x) => x.c === c && t.rows[x.r]?.head).map((x) => x.words.map((w) => w.text).join(' ')).join(' ');
    return dotted.some((v) => v.split('.').length > 2) || decs.size > 1 || /\b(ref|item|clause|s\.?\s?no|sr\.?|no\.?)\b/i.test(head);
  });
  const side = (w: number) => (w <= 0 ? 0 : w < 1.2 ? 1 : w < 2.4 ? 2 : 3);
  for (const r of startRows) {
    const at = rowAt.get(r)!;
    const head = !!t.rows[r].head;
    for (const c of byStart.get(r) || []) {
      const st = styleOf(c.words, fonts, def);
      if (!c.words.length) st.font = { name: def.name, size: t.size || def.size };
      const isKey = c.c === t.key, isDesc = c.c === t.desc;
      let text = linesText(c.lines, head ? '\n' : ' ');
      let v: string | number = text;
      if (!head && !isKey && !isDesc && !refCol[c.c] && text) {
        if (pl.pm.ocr && numericCol[c.c]) text = fixOcrNumber(text, dec2[c.c]);
        const n = parseNumber(text, decimalComma);
        if (n) { v = n.v; st.fmt = n.fmt; }
      }
      st.h = typeof v === 'number' ? 'right' : alignIn(c, t);
      st.v = vAlignIn(c, t);
      if (head || isDesc || c.lines.length > 1 || (typeof v === 'string' && v.length * PT_PER_CHAR > (t.xs[c.c + c.cs] - t.xs[c.c]) * 1.1)) st.wrap = true;
      if (head) { st.font.b = true; st.h = st.h === 'right' ? 'right' : 'center'; st.v = 'center'; }
      if (c.fill !== undefined && c.fill !== 0xffffff) st.fill = c.fill;
      st.bd = [side(c.bd[0]), side(c.bd[1]), side(c.bd[2]), side(c.bd[3])];
      const tc = colMap[c.c], tcEnd = Math.max(tc, colMap[c.c + c.cs - 1]);
      const prevCell = sh.rows[at][tc];
      // two columns of this page in one column of the sheet: their texts together
      if (prevCell && prevCell.v !== '' && v !== '') sh.rows[at][tc] = { v: String(prevCell.v) + ' ' + String(v), st: prevCell.st };
      else sh.rows[at][tc] = { v, st };
      // borders all round a merged cell: the covered cells carry the edges too
      if (c.rs > 1 || tcEnd > tc) {
        const lastR = Math.max(...[...rowAt.entries()].filter(([rr]) => rr >= r && rr < r + c.rs).map(([, a2]) => a2));
        if (lastR > at || tcEnd > tc) sh.merges.push([at, tc, lastR, tcEnd]);
        for (let rr = at; rr <= lastR; rr++) for (let cc = tc; cc <= tcEnd; cc++) {
          if (rr === at && cc === tc) continue;
          sh.rows[rr][cc] = { v: '', st: { font: st.font, fill: st.fill, bd: [rr === at ? st.bd[0] : 0, cc === tcEnd ? st.bd[1] : 0, rr === lastR ? st.bd[2] : 0, cc === tc ? st.bd[3] : 0] } };
        }
      }
      // height: as many lines as the cell had on the page
      if (c.rs === 1) {
        const lines = Math.max(1, c.lines.length);
        heights.set(at, Math.max(heights.get(at) ?? 0, lines * (st.font.size * 1.22) + 3));
      }
    }
    // empty cells inside the table keep the table's lines
    for (let c = 0; c < nc; c++) {
      const tc = colMap[c];
      if (sh.rows[at][tc]) continue;
      const vline = t.cells.find((x) => x.c + x.cs === c && x.r <= r && x.r + x.rs > r)?.bd[1] ?? 0;
      const own = t.cells.find((x) => x.c <= c && x.c + x.cs > c && x.r <= r && x.r + x.rs > r);
      sh.rows[at][tc] = { v: '', st: { font: { name: def.name, size: t.size || def.size }, bd: own ? [side(own.bd[0]), side(own.bd[1]), side(own.bd[2]), side(own.bd[3])] : [0, 0, 0, side(vline)] } };
    }
  }
  for (const [at, h] of heights) if (h > 15.5) sh.heights[at] = h;
  // the header row once at the top of the sheet: frozen, printed on every page
  const headRows = startRows.filter((r) => t.rows[r].head).map((r) => rowAt.get(r)!);
  if (!cont && headRows.length) sh.headText = startRows.filter((r) => t.rows[r].head).map((r) => rowLetters(t, r)).join('');
  if (!cont && headRows.length && !sh.frozen && first <= 6) {
    sh.freeze = Math.max(...headRows) + 1;
    sh.titles = [Math.min(...headRows) + 1, Math.max(...headRows) + 1];
    sh.frozen = true;
  }
  sh.last = { t: cont && sh.last ? sh.last.t : t, head: cont && sh.last ? sh.last.head : hk, page: pl.pm.i };
}

function numericColumns(t: Table): boolean[] {
  const nc = t.xs.length - 1;
  const n = new Array(nc).fill(0), f = new Array(nc).fill(0);
  for (const c of t.cells) {
    if (!c.words.length || t.rows[c.r]?.head) continue;
    f[c.c]++;
    if (/\d/.test(c.words.map((w) => w.text).join(''))) n[c.c]++;
  }
  return n.map((v, i) => f[i] > 0 && v >= f[i] * 0.6);
}

function alignIn(c: Cell, t: Table): 'left' | 'center' | 'right' {
  if (!c.words.length) return 'left';
  const x0 = t.xs[c.c], x1 = t.xs[c.c + c.cs];
  const l = minOf(c.words, (w) => w.x0) - x0, r = x1 - maxOf(c.words, (w) => w.x1);
  if (c.lines.length === 1 && l > 4 && r > 4 && Math.abs(l - r) < Math.max(4, (l + r) * 0.15)) return 'center';
  if (r < 6 && l > 10) return 'right';
  return 'left';
}
function vAlignIn(c: Cell, t: Table): 'top' | 'center' | 'bottom' {
  if (!c.words.length || c.rs > 1) return 'top';
  const row = t.rows[c.r];
  const y0 = minOf(c.words, (w) => w.y0), y1 = maxOf(c.words, (w) => w.y1);
  const top = y0 - row.y0, bot = row.y1 - y1;
  if (bot < top * 0.5 && top > 6) return 'bottom';
  if (Math.abs(top - bot) < 3 && top > 4) return 'center';
  return 'top';
}

function writeText(sh: XSheet, r: Row, main: Table | undefined, fonts: FontInfo[], def: { name: string; size: number }, ocr: boolean) {
  const ws = readingOrder(r);
  const cells: (XCell | null)[] = [];
  if (main && !r.rtl) {
    // split the line into its parts and put each under the column it starts in
    const nc = main.xs.length - 1;
    const parts: Word[][] = [];
    for (const w of ws) {
      const p = parts[parts.length - 1];
      const prev = p?.[p.length - 1];
      if (prev && w.x0 - prev.x1 < Math.max(r.size * 1.2, 6)) p.push(w);
      else parts.push([w]);
    }
    for (const p of parts) {
      let c = 0;
      while (c + 1 < nc && p[0].x0 >= main.xs[c + 1] - 2) c++;
      while (cells.length <= c) cells.push(null);
      const prev = cells[c];
      const text = p.map(plainWord).join(' ');
      const st = styleOf(p, fonts, def);
      const n = ocr ? null : parseNumber(text, decimalComma);
      if (prev && typeof prev.v === 'string') prev.v += ' ' + text;
      else cells[c] = n && c > 0 ? { v: n.v, st: { ...st, fmt: n.fmt, h: 'right' } } : { v: text, st };
    }
  } else {
    const text = ws.map(plainWord).join(' ');
    const st = styleOf(ws, fonts, def);
    if (r.rtl) st.h = 'right';
    cells.push({ v: text, st });
  }
  addRow(sh, cells, r.size > 13 ? r.size * 1.3 : undefined);
}
