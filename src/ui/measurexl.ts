// Measurements in Excel: the number as a number, its unit in its own cell (one "7.056 m" text
// cell couldn't be added up). Used by Measure > To Excel and the Comments list's Excel export.
import { splitMeasure, measureValue, perimeterOf, LEGACY_FMT, type MeasureFmt } from './geom';
import type { XCell, XSheet, XStyle } from './xlsxwrite';

/** what a measurement needs here (an AnnotData) */
interface MeasureLike { page: number; kind?: string; contents?: string; vertices?: number[][]; line?: number[][]; fmt?: MeasureFmt }
type ScaleAt = Parameters<typeof measureValue>[2];

/**
 * The number and unit of a measurement: the number on the drawing; a label typed by hand
 * ("Kitchen") -> the number measured from its points at the page's scale. Lengths shown in mm
 * only because they are under a metre (the unit left on automatic) go in metres, so a column of
 * lengths is all one unit and adds up (450 mm beside 7.056 m summed to 457.056). Counts: 1 "No.".
 */
export function measureNumber(a: MeasureLike, scaleAt: (page: number, x: number, y: number) => ScaleAt): { v: number; unit: string; dec: number } | null {
  if (!a.kind?.startsWith('measure-')) return null;
  if (a.kind === 'measure-count') return { v: 1, unit: 'No.', dec: 0 };
  let n = splitMeasure(a.contents || '');
  if (!n) {
    const pts = (a.vertices || a.line || []) as [number, number][];
    if (!pts.length) return null;
    n = splitMeasure(measureValue(a.kind, pts, scaleAt(a.page, pts[0][0], pts[0][1]), a.fmt ?? LEGACY_FMT));
  }
  if (n && n.unit === 'mm' && (a.fmt?.unit ?? 'auto') !== 'mm') {
    const dec = n.dec + 3;
    n = { v: Number((n.v / 1000).toFixed(dec)), unit: 'm', dec };
  }
  return n;
}

/** an area's perimeter (its label's, or measured from its corners when the label was typed by
 *  hand / is from before 0.8.9); null for anything else */
export function perimeterNumber(a: MeasureLike, scaleAt: (page: number, x: number, y: number) => ScaleAt): { v: number; unit: string; dec: number } | null {
  if (a.kind !== 'measure-area') return null;
  let n = perimeterOf(a.contents || '');
  if (!n) {
    const pts = (a.vertices || a.line || []) as [number, number][];
    if (!pts.length) return null;
    n = splitMeasure(measureValue('perimeter', pts, scaleAt(a.page, pts[0][0], pts[0][1]), a.fmt ?? LEGACY_FMT));
  }
  if (n && n.unit === 'mm' && (a.fmt?.unit ?? 'auto') !== 'mm') {
    const dec = n.dec + 3;
    n = { v: Number((n.v / 1000).toFixed(dec)), unit: 'm', dec };
  }
  return n;
}

/** the cell style showing that many decimals (Excel keeps the whole number) */
export const numStyle = (dec: number): XStyle => (['n0', 'n1', 'n2', 'n3', 'n4'] as const)[Math.max(0, Math.min(4, dec))];

// ---------------------------------------------------------------- the two lists (7.1)
// Both sheets start with Page (the page label when the file has one, else the number) and PDF
// page (always the physical 1-based page, a number).

/** the Page cell: the file's label for the page, or the number when there is none (the app gives
 *  an unlabelled page its number as its label, so a label equal to the number counts as none) */
export function pageCell(label: string | undefined, page: number): string | number {
  return label && label.trim() && label !== String(page + 1) ? label : page + 1;
}

const numCell = (n: { v: number; dec: number } | null | undefined): XCell => (n ? { v: n.v, s: numStyle(n.dec) } : '');

export const COMMENT_HEAD = ['Page', 'PDF page', 'Type', 'Comment', 'Value', 'Unit', 'Replies', 'Author', 'Status', 'Date', 'Colour', 'Lock'];
export const COMMENT_WIDTHS = [7, 9, 18, 50, 12, 12, 40, 16, 12, 18, 10, 8];
export const MEASURE_HEAD = ['Page', 'PDF page', 'Type', 'Value', 'Unit', 'Perimeter', 'Unit', 'Label on the drawing', 'Count group', 'Author', 'Date'];
export const MEASURE_WIDTHS = [7, 9, 14, 12, 8, 12, 8, 30, 16, 16, 18];

/** a header row: bold cells */
export const headRow = (head: string[]): XCell[] => head.map((v) => ({ v, s: 'h' as const }));

/** what one row of the Comments list is made of (the caller reads the markup and its replies) */
export interface CommentIn {
  page: number; label?: string; type: string; contents?: string;
  num: { v: number; unit: string; dec: number } | null;
  replies: string; author?: string; state?: string; date: string; colour: string; locked: boolean;
}
/** one row of the Comments list's Excel sheet, in COMMENT_HEAD's order */
export function commentRow(c: CommentIn): XCell[] {
  return [pageCell(c.label, c.page), c.page + 1, c.type, c.contents || '', numCell(c.num), c.num ? c.num.unit : '', c.replies, c.author ?? '', c.state || '', c.date, c.colour, c.locked ? 'Locked' : ''];
}

/** what one row of the measurements sheet is made of */
export interface MeasureIn {
  page: number; label?: string; type: string;
  num: { v: number; unit: string; dec: number } | null;
  perimeter: { v: number; unit: string; dec: number } | null;
  contents?: string; group?: string; author?: string; date: string;
}
/** one row of the measurements sheet, in MEASURE_HEAD's order */
export function measureRow(m: MeasureIn): XCell[] {
  return [pageCell(m.label, m.page), m.page + 1, m.type, numCell(m.num), m.num ? m.num.unit : '', numCell(m.perimeter), m.perimeter ? m.perimeter.unit : '', m.contents || '', m.group || '', m.author ?? '', m.date];
}

// ---------------------------------------------------------------- the table by sheet (7.7 / PLAN item 7)
export const KIND_NAME: Record<string, string> = { 'measure-length': 'Lengths', 'measure-polylength': 'Polylengths', 'measure-perimeter': 'Perimeters', 'measure-area': 'Areas', 'area-perimeter': 'Areas: perimeters', 'measure-angle': 'Angles' };
export const KIND_ORDER = ['measure-length', 'measure-polylength', 'measure-perimeter', 'measure-area', 'area-perimeter', 'measure-angle'];

/** a mark as the by-sheet table needs it (page is 0-based) */
export interface SheetMark {
  page: number; label?: string; kind: string; group?: string;
  num: { v: number; unit: string; dec: number } | null;
  perimeter: { v: number; unit: string; dec: number } | null;
}

/**
 * Most sheets (pages with marks) written as columns. Excel takes 16,384 columns but a table wider
 * than a couple of hundred can't be read or printed; past this the table is turned: sheets down
 * the side, items across (items are few; a file can have thousands of sheets).
 */
export const SHEET_COLS_MAX = 200;

interface Item { name: string; unit: string; dec: number; count: boolean; order: number; by: Map<number, number>; total: number }
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const hcell = (v: string | number): XCell => ({ v, s: 'h' });

/**
 * One sheet of the workbook: every count name and every kind of measurement (with its unit) as a
 * row, the sheets that have marks as columns - the page label, else the PDF page number - with a
 * total at the right and (counts only: lengths and areas can't be added to each other) at the
 * bottom. Numbers are numbers. Past SHEET_COLS_MAX sheets the table is turned.
 */
export function bySheetTable(marks: SheetMark[]): XSheet {
  const items = new Map<string, Item>();
  const pagesSeen = new Map<number, string | number>();
  const add = (key: string, name: string, count: boolean, order: number, unit: string, dec: number, page: number, v: number, label?: string) => {
    let it = items.get(key);
    if (!it) items.set(key, (it = { name, unit, dec: 0, count, order, by: new Map(), total: 0 }));
    it.dec = Math.max(it.dec, dec);
    it.by.set(page, (it.by.get(page) || 0) + v);
    it.total += v;
    if (!pagesSeen.has(page)) pagesSeen.set(page, pageCell(label, page));
  };
  for (const m of marks) {
    if (m.kind === 'measure-count') { const g = m.group || 'Count'; add('c\u0000' + g, g, true, -1, 'No.', 0, m.page, 1, m.label); continue; }
    if (!KIND_NAME[m.kind]) continue;
    if (m.kind === 'measure-angle') { add('k' + m.kind, KIND_NAME[m.kind], false, KIND_ORDER.indexOf(m.kind), 'No.', 0, m.page, 1, m.label); continue; }
    if (m.num) add('k' + m.kind + '\u0000' + m.num.unit, KIND_NAME[m.kind], false, KIND_ORDER.indexOf(m.kind), m.num.unit, m.num.dec, m.page, m.num.v, m.label);
    if (m.kind === 'measure-area' && m.perimeter) add('karea-perimeter\u0000' + m.perimeter.unit, KIND_NAME['area-perimeter'], false, KIND_ORDER.indexOf('area-perimeter'), m.perimeter.unit, m.perimeter.dec, m.page, m.perimeter.v, m.label);
  }
  const list = [...items.values()].sort((a, b) => (a.count !== b.count ? (a.count ? -1 : 1) : a.count ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.order - b.order || a.unit.localeCompare(b.unit)));
  const pages = [...pagesSeen.keys()].sort((a, b) => a - b);
  const num = (x: number, dec: number): XCell => ({ v: r6(x), s: numStyle(dec) });
  const anyLabel = pages.some((pg) => typeof pagesSeen.get(pg) === 'string');
  const anyCount = list.some((it) => it.count);
  const name = 'By sheet';

  if (pages.length <= SHEET_COLS_MAX) {
    const head1: XCell[] = [hcell('Item'), hcell('Unit'), ...pages.map((pg) => hcell(pagesSeen.get(pg)!)), hcell('Total')];
    const rows: XCell[][] = [head1];
    if (anyLabel) rows.push([hcell('PDF page'), hcell(''), ...pages.map((pg) => hcell(pg + 1)), hcell('')]);
    for (const it of list) rows.push([it.name, it.unit, ...pages.map((pg) => (it.by.has(pg) ? num(it.by.get(pg)!, it.dec) : '')), num(it.total, it.dec)]);
    if (anyCount) {
      const cs = list.filter((it) => it.count);
      rows.push([{ v: 'Total counts', s: 'b' }, 'No.', ...pages.map((pg) => (cs.some((it) => it.by.has(pg)) ? { v: cs.reduce((t, it) => t + (it.by.get(pg) || 0), 0), s: 'b' as const } : '')), { v: cs.reduce((t, it) => t + it.total, 0), s: 'b' }]);
    }
    return { name, rows, header: anyLabel ? 2 : 1, noFilter: true, widths: [26, 8, ...pages.map(() => 9), 11] };
  }

  // turned: a row per sheet, a column per item
  const rows: XCell[][] = [[hcell('Sheet'), hcell('PDF page'), ...list.map((it) => hcell(it.name)), hcell('Total counts')], [hcell('Unit'), hcell(''), ...list.map((it) => hcell(it.unit)), hcell('No.')]];
  for (const pg of pages) {
    const cs = list.filter((it) => it.count);
    rows.push([pagesSeen.get(pg)!, pg + 1, ...list.map((it) => (it.by.has(pg) ? num(it.by.get(pg)!, it.dec) : '')), cs.some((it) => it.by.has(pg)) ? num(cs.reduce((t, it) => t + (it.by.get(pg) || 0), 0), 0) : '']);
  }
  rows.push([{ v: 'Total', s: 'b' }, '', ...list.map((it) => ({ v: r6(it.total), s: numStyle(it.dec) })), anyCount ? { v: list.filter((it) => it.count).reduce((t, it) => t + it.total, 0), s: 'b' as const } : '']);
  return { name, rows, header: 2, noFilter: true, widths: [14, 9, ...list.map(() => 13), 13] };
}
