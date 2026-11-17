// Measurements in Excel: the number as a number, its unit in its own cell (one "7.056 m" text
// cell couldn't be added up). Used by Measure > To Excel and the Comments list's Excel export.
import { splitMeasure, measureValue, perimeterOf, LEGACY_FMT, type MeasureFmt } from './geom';
import type { XCell, XStyle } from './xlsxwrite';

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
