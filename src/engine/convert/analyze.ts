// A page's layout (rows, tables, the text around them) and, across pages, the lines that
// repeat at the top and bottom of every page (running headers, footers, page numbers).
import type { PageModel, Word } from './model';
import { buildRows, markTextLines, readingOrder, tidyRulings, type Row } from './rows';
import { detectTables, type Table } from './tables';

export interface PageLayout {
  pm: PageModel;
  rows: Row[];
  /** rows (or parts of rows) outside tables */
  flow: Row[];
  tables: Table[];
  /** flow rows that repeat on other pages: 'h' header, 'f' footer */
  running: Map<Row, 'h' | 'f'>;
  /** page-number rows (part of the running ones) */
  pageNo: Set<Row>;
}

export function analyzePage(pm: PageModel, word: boolean): PageLayout {
  const scan = pm.ocr;
  const rows = buildRows(pm.words);
  pm.rulings = tidyRulings(pm.rulings, scan ? 3 : 1, scan ? 10 : 1);
  markTextLines(rows, pm.rulings, scan);
  const { tables, used } = pm.kind === 'drawing' ? { tables: [], used: new Set<Word>() } : detectTables(pm, rows, { scan, word });
  const flow: Row[] = [];
  for (const r of rows) {
    const ws = r.words.filter((w) => !used.has(w));
    if (!ws.length) continue;
    if (ws.length === r.words.length) { flow.push(r); continue; }
    flow.push({ ...r, words: ws, x0: Math.min(...ws.map((w) => w.x0)), x1: Math.max(...ws.map((w) => w.x1)), y0: Math.min(...ws.map((w) => w.y0)), y1: Math.max(...ws.map((w) => w.y1)) });
  }
  return { pm, rows, flow, tables, running: new Map(), pageNo: new Set() };
}

/**
 * Scans: the same words stamped on page after page at a different spot each time (a company's
 * rubber stamp, "TENDER DOCUMENTS", a received date) are left out. Text at the same spot on
 * every page (column headings, page headers), lines starting on a column's edge, words that
 * repeat many times on a page (descriptions in a bill) and totals are not stamps.
 * Matched by pairs of neighbouring words, so one misread word doesn't hide the stamp.
 */
export function dropStampText(pms: PageModel[]) {
  const scans = pms.filter((p) => p.ocr && p.words.length);
  if (scans.length < 3) return;
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9\u0621-\u064a]+/g, '');
  const letters = (k: string) => k.replace(/[^a-z\u0621-\u064a]/g, '').length;
  const NOT_STAMP = /total|carried|brought|collection|contd|continued|ditto|provisional|sum|page|bill|item|description|qty|unit|rate|amount/;
  type Tok = { w: Word; k: string };
  type Seg = { p: PageModel; ws: Word[]; toks: Tok[]; y: number; x: number; free?: boolean };
  const keyed = new Map<string, { seg: Seg; toks: Tok[] }[]>();
  const segs: Seg[] = [];
  for (const pm of scans) {
    const page: Seg[] = [];
    for (const r of buildRows(pm.words)) {
      const ws = r.words.slice().sort((a, b) => a.x0 - b.x0);
      let cur: Word[] = [];
      const flush = () => {
        if (cur.length) page.push({ p: pm, ws: cur, toks: cur.map((w) => ({ w, k: norm(w.text) })).filter((t) => t.k.length >= 3), y: r.base, x: cur[0].x0 });
        cur = [];
      };
      // (gaps against the smaller of the two words: a big stamp on a line of small text)
      for (const w of ws) { const l = cur[cur.length - 1]; if (l && w.x0 - l.x1 > Math.min(r.size, l.y1 - l.y0, w.y1 - w.y0) * 2) flush(); cur.push(w); }
      flush();
    }
    for (const sg of page) {
      segs.push(sg);
      // a line starting where three others start, down a good part of the page: a column of
      // text, not a stamp (a stamp's own lines start together too, within its few centimetres)
      const col = page.filter((o) => o !== sg && Math.abs(o.x - sg.x) <= 4);
      if (col.length >= 3 && Math.max(sg.y, ...col.map((o) => o.y)) - Math.min(sg.y, ...col.map((o) => o.y)) > 120) continue;
      sg.free = true;
      const add = (k: string, toks: Tok[]) => { if (NOT_STAMP.test(k)) return; let l = keyed.get(k); if (!l) keyed.set(k, (l = [])); l.push({ seg: sg, toks }); };
      for (let i = 0; i + 1 < sg.toks.length; i++) {
        const a = sg.toks[i], b = sg.toks[i + 1];
        if (letters(a.k) >= 3 || letters(b.k) >= 3) add(a.k + b.k, [a, b]);
      }
      // one word on its own ("TENDERDOCUMENTS" read as one, "RECEIVED")
      if (sg.toks.length === 1 && letters(sg.toks[0].k) >= 5) add(sg.toks[0].k, sg.toks);
    }
  }
  const need = Math.max(3, Math.ceil(scans.length * 0.4));
  const stamped = new Set<Word>();
  const found: string[] = [];
  for (const [key, occ] of keyed) {
    const perPage = new Map<PageModel, number>();
    for (const o of occ) perPage.set(o.seg.p, (perPage.get(o.seg.p) ?? 0) + 1);
    if (perPage.size < need) continue;
    // a stamp is there once or twice a page; a phrase of the text repeats down the page
    if ([...perPage.values()].filter((n) => n <= 2).length < perPage.size * 0.8) continue;
    // at the same spot on other pages (allowing for the paper's shift in the copier): part of
    // the page (a column heading, a heading line); a stamp lands somewhere else every time
    // (a stamp put on by hand can land close to where it was on a page or two - not on most)
    const fixed = occ.filter((o) => new Set(occ.filter((q) => q.seg.p !== o.seg.p && Math.abs(q.seg.x - o.seg.x) <= 8 && Math.abs(q.seg.y - o.seg.y) <= 10).map((q) => q.seg.p)).size >= (perPage.size - 1) * 0.5).length;
    if (fixed >= occ.length * 0.6) continue;
    for (const o of occ) for (const t of o.toks) stamped.add(t.w);
    found.push(key);
  }
  if (!stamped.size) return;
  // the stamp's words run together into one ("GENERALCONSTRUCTIONCO.LLC")
  const keys = found.filter((k) => k.length >= 10);
  for (const sg of segs) for (const t of sg.toks) if (!stamped.has(t.w) && t.k.length >= 12 && keys.some((k) => t.k.includes(k))) stamped.add(t.w);
  // a word of the stamp read on its own line ("TENDER" without "DOCUMENTS") next to the rest of it
  const parts = new Set<string>();
  for (const k of found) for (const o of keyed.get(k)!) for (const t of o.toks) if (letters(t.k) >= 4) parts.add(t.k);
  const onPage = new Map<PageModel, Word[]>();
  for (const sg of segs) for (const w of sg.ws) if (stamped.has(w)) { let l = onPage.get(sg.p); if (!l) onPage.set(sg.p, (l = [])); l.push(w); }
  const near = (w: Word, p: PageModel) => (onPage.get(p) ?? []).some((x) => Math.abs((x.y0 + x.y1) / 2 - (w.y0 + w.y1) / 2) < 60 && Math.min(x.x1, w.x1) - Math.max(x.x0, w.x0) > -100);
  for (const sg of segs) if (sg.free) for (const t of sg.toks) if (!stamped.has(t.w) && parts.has(t.k) && near(t.w, sg.p)) stamped.add(t.w);
  const drop = new Set<Word>();
  for (const sg of segs) {
    const hit = sg.ws.filter((w) => stamped.has(w));
    if (!hit.length) continue;
    // mostly stamp: the rest of it is the stamp misread ("G", "L.L.G", the logo)
    if (sg.toks.filter((t) => stamped.has(t.w)).length >= sg.toks.length * 0.5) for (const w of sg.ws) drop.add(w);
    else for (const w of hit) drop.add(w);
  }
  for (const pm of scans) pm.words = pm.words.filter((w) => !drop.has(w));
}

const PAGE_NO = /^(?:-\s*)?(?:page|p\.?|pg\.?|صفحة)?\s*\.?\s*\d{1,4}\s*(?:(?:of|\/|من)\s*\d{1,4})?(?:\s*-)?$/i;
const keyOf = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#؀-ۿ]+/g, '');
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i + 1 < s.length; i++) { const b = s.slice(i, i + 2); m.set(b, (m.get(b) ?? 0) + 1); }
  return m;
}
export function similar(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}
export const rowText = (r: Row) => readingOrder(r).map((w) => w.text).join(' ');

/** mark the rows that repeat near the top / bottom of the pages */
export function markRunning(pages: PageLayout[]) {
  interface Cand { p: number; r: Row; key: string; y: number; zone: 'h' | 'f' }
  const cands: Cand[] = [];
  for (const [p, pl] of pages.entries()) {
    const h = pl.pm.h;
    for (const r of pl.flow) {
      // (a scan: a tighter band - its text is read with mistakes, so lines are matched more loosely)
      const band = pl.pm.ocr ? 0.12 : 0.15;
      const zone = r.y1 < h * band ? 'h' : r.y0 > h * (1 - band) ? 'f' : null;
      if (!zone) continue;
      const t = rowText(r).trim();
      if (!t) continue;
      if (PAGE_NO.test(t) || (t.length < 90 && /\b(?:page|pg\.?)\s*\d+\s*(?:of|\/)\s*\d+\b/i.test(t))) { pl.running.set(r, zone); pl.pageNo.add(r); continue; }
      cands.push({ p, r, key: keyOf(t), y: zone === 'h' ? r.y0 : h - r.y1, zone });
    }
  }
  // clusters of the same line at about the same place
  const clusters: Cand[][] = [];
  for (const c of cands) {
    if (!c.key) continue;
    const tolY = pages[c.p].pm.ocr ? 12 : 7;
    let home: Cand[] | null = null;
    for (const g of clusters) {
      const f = g[0];
      if (f.zone !== c.zone || Math.abs(f.y - c.y) > tolY || g.some((x) => x.p === c.p)) continue;
      if (similar(f.key, c.key) >= (pages[c.p].pm.ocr ? 0.8 : 0.9)) { home = g; break; }
    }
    if (home) home.push(c); else clusters.push([c]);
  }
  const n = pages.length;
  // one page: nothing repeats - a small line alone at the very top / bottom is the page header / footer
  if (n === 1) {
    const pl = pages[0];
    const body = pl.pm.bodySize || 10;
    const fl = pl.flow.slice().sort((a, b) => a.y0 - b.y0);
    const first = fl[0], next = fl[1], last = fl[fl.length - 1], prev = fl[fl.length - 2];
    if (first && next && first.y1 < pl.pm.h * 0.1 && first.size <= body * 0.95 && next.y0 - first.y1 > 18 && !pl.running.has(first)) pl.running.set(first, 'h');
    if (last && prev && last.y0 > pl.pm.h * 0.9 && last.size <= body * 0.95 && last.y0 - prev.y1 > 18 && !pl.running.has(last)) pl.running.set(last, 'f');
  }
  for (const g of clusters) {
    if (g.length < 2) continue;
    // (in a long file a line on two pages only is running when they're neighbours: a two-page bill)
    if (n > 6 && g.length < 3 && !(g.length === 2 && Math.abs(g[0].p - g[1].p) === 1)) continue;
    for (const c of g) {
      pages[c.p].running.set(c.r, c.zone);
      if (/\d/.test(rowText(c.r)) && /#/.test(c.key) && g.some((x) => keyOf(rowText(x.r)) !== c.key || rowText(x.r) !== rowText(c.r))) pages[c.p].pageNo.add(c.r);
    }
  }
}
