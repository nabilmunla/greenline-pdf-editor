// A measurement's number is written into its label once, when it is drawn; Totals and To Excel
// read it back from there. Whatever moves a measurement to where another scale applies (a paste or
// Duplicate onto another page or file, a move into or out of a viewport) has to work the number
// out again - it kept the old one, and the scale-change update then took it for a label typed by
// hand and never touched it again (0.8.5 blind review, B3-01 / 03).
import type { PdfDoc, AnnotData, Scale } from './doc';
import { measureValue, splitMeasure, LEGACY_FMT, PERIM_SEP } from './geom';
import { countNumbers } from './tagcount';

export const ptsOf = (a: AnnotData) => (a.vertices || a.line || []) as [number, number][];
/** a measurement whose number comes from its shape (not a count mark) */
export const isMeasured = (a: AnnotData) => !!a.kind?.startsWith('measure-') && a.kind !== 'measure-count';

/**
 * Two labels are the same number to the last decimal shown. A shape's corners are kept in the
 * file as 32-bit numbers: worked out again from them, the last digit could differ from the label
 * written while drawing (from the pointer's exact place) - and such a label counted as typed by
 * hand (B3-02: 7 of 30 areas kept their old scale's number after a scale change).
 */
export function sameMeasure(label: string, value: string): boolean {
  // an area with its perimeter: both parts the same (a label from before 0.8.9 has the area only:
  // that part decides)
  if (label.includes(PERIM_SEP) || value.includes(PERIM_SEP)) {
    const [l1, l2] = label.split(PERIM_SEP), [v1, v2] = value.split(PERIM_SEP);
    return sameMeasure(l1, v1) && (l2 === undefined || v2 === undefined || sameMeasure(l2, v2));
  }
  const l = label.trim(), v = value.trim();
  if (l === v) return true;
  const a = splitMeasure(l), b = splitMeasure(v);
  if (!a || !b || a.unit !== b.unit) return false;
  const tol = a.unit === 'ft' ? 0.011 / 12 : 1.01 * 10 ** -Math.min(a.dec, b.dec);
  return Math.abs(a.v - b.v) <= tol + 1e-9;
}

/** the label is the app's number for the shape: marked so (0.8.5 on), or - older markups - the
 *  number the shape gives at the scale `at` (where it was, before a change) */
export function isAutoLabel(a: AnnotData, at: Scale | null): boolean {
  const t = a.contents?.trim();
  if (!t || !isMeasured(a)) return false;
  if (a.autoLabel) return true;
  const pts = ptsOf(a);
  return pts.length > 0 && sameMeasure(t, measureValue(a.kind!, pts, at, a.fmt ?? LEGACY_FMT));
}

/**
 * Measurements just pasted, duplicated or moved: the number for where each now is (page, file,
 * viewport, scale), as part of the same Undo step. `wasAuto[i]` (lined up with `list`): an older
 * markup's label was its number where it came from. Count marks pasted get the next numbers of
 * their group (a pasted "#1" was a second #1).
 */
export async function relabel(doc: PdfDoc, list: AnnotData[], wasAuto?: boolean[], counts = false): Promise<void> {
  const items: { page: number; id: number; patch: { contents: string; autoLabel?: boolean } }[] = [];
  list.forEach((a, i) => {
    if (!isMeasured(a) || a.locked || !a.contents?.trim()) return;
    if (!a.autoLabel && !wasAuto?.[i]) return;
    const pts = ptsOf(a);
    if (!pts.length) return;
    const now = measureValue(a.kind!, pts, doc.scaleAt(a.page, pts[0][0], pts[0][1]), a.fmt ?? LEGACY_FMT);
    if (now && now !== a.contents.trim()) items.push({ page: a.page, id: a.id, patch: { contents: now, autoLabel: true } });
  });
  if (counts && list.some((a) => a.kind === 'measure-count')) {
    const mine = new Set(list.map((a) => a.page + ':' + a.id));
    const hi = countNumbers((await doc.allAnnots()).filter((a) => !mine.has(a.page + ':' + a.id)));
    for (const a of list) {
      if (a.kind !== 'measure-count' || a.locked) continue;
      const m = /^(.*#\s*)(\d+)\s*$/.exec(a.contents || '');
      if (!m) continue;
      const g = a.group || 'Count';
      const n = (hi.get(g) || 0) + 1;
      hi.set(g, n);
      if (Number(m[2]) !== n) items.push({ page: a.page, id: a.id, patch: { contents: m[1] + n } });
    }
  }
  if (items.length) await doc.update(items, 'Measurements', undefined, true);
}
