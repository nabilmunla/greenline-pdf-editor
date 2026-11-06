// Measurements in Excel: the number as a number, its unit in its own cell (one "7.056 m" text
// cell couldn't be added up). Used by Measure > To Excel and the Comments list's Excel export.
import { splitMeasure, measureValue, perimeterOf, LEGACY_FMT, type MeasureFmt } from './geom';
import type { XStyle } from './xlsxwrite';

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
