// Geometry: hit testing markups, measuring, units.
import type { AnnotData, Rect, Pt } from '../engine/mu';
import type { Scale } from './doc';

export const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function inPoly(p: Pt, v: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    const [xi, yi] = v[i], [xj, yj] = v[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

export const inRect = (p: Pt, r: Rect, pad = 0) => p[0] >= r[0] - pad && p[0] <= r[2] + pad && p[1] >= r[1] - pad && p[1] <= r[3] + pad;
export const rectOf = (a: Pt, b: Pt): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
export const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
export const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** the outline box of a markup's geometry (not its wider drawn bounds) */
export function geomBox(a: AnnotData): Rect {
  const pts = geomPoints(a);
  if (!pts.length) return a.rect;
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}
export function geomPoints(a: AnnotData): Pt[] {
  if (a.vertices?.length) return a.vertices;
  if (a.line?.length) return a.line;
  if (a.ink?.length) return a.ink.flat();
  if (a.quads?.length) return a.quads.flatMap((q) => [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]] as Pt[]);
  return [];
}

/** how well point p hits markup a (smaller = better), or null */
export function hitAnnot(a: AnnotData, p: Pt, tol: number): number | null {
  if (a.irt != null || a.type === 'Popup' || a.type === 'Link') return null;
  const t = a.type;
  if (t === 'Line' && a.line) { const d = segDist(p, a.line[0], a.line[1]); return d <= tol ? d : null; }
  if (t === 'PolyLine' && a.vertices) {
    let best = Infinity;
    for (let i = 0; i + 1 < a.vertices.length; i++) best = Math.min(best, segDist(p, a.vertices[i], a.vertices[i + 1]));
    return best <= tol ? best : null;
  }
  if (t === 'Ink' && a.ink) {
    let best = Infinity;
    for (const s of a.ink) for (let i = 0; i + 1 < s.length; i++) best = Math.min(best, segDist(p, s[i], s[i + 1]));
    if (a.ink.some((s) => s.length === 1)) for (const s of a.ink) if (s.length === 1) best = Math.min(best, dist(p, s[0]));
    return best <= tol + (a.bw || 1) ? best : null;
  }
  if (t === 'Polygon' && a.vertices) {
    let edge = Infinity;
    for (let i = 0; i < a.vertices.length; i++) edge = Math.min(edge, segDist(p, a.vertices[i], a.vertices[(i + 1) % a.vertices.length]));
    if (edge <= tol) return edge;
    if (inPoly(p, a.vertices)) return tol + Math.sqrt(area(geomBox(a))) * 0.01;
    return null;
  }
  if ((t === 'Highlight' || t === 'Underline' || t === 'StrikeOut' || t === 'Squiggly') && a.quads) {
    for (const q of a.quads) {
      const r: Rect = [Math.min(q[0], q[4]), Math.min(q[1], q[3]), Math.max(q[2], q[6]), Math.max(q[5], q[7])];
      if (inRect(p, r, tol * 0.3)) return tol * 0.5;
    }
    return null;
  }
  if (t === 'FreeText' && a.callout?.length) {
    for (let i = 0; i + 1 < a.callout.length; i++) if (segDist(p, a.callout[i], a.callout[i + 1]) <= tol) return tol * 0.5;
  }
  const r = a.rect;
  if (!inRect(p, r, tol * 0.5)) return null;
  // unfilled squares/circles: the outline is the target; inside counts but weaker
  if ((t === 'Square' || t === 'Circle') && !a.ic) {
    const e = Math.min(Math.abs(p[0] - r[0]), Math.abs(p[0] - r[2]), Math.abs(p[1] - r[1]), Math.abs(p[1] - r[3]));
    return e <= tol ? e : tol + Math.sqrt(area(r)) * 0.02;
  }
  return tol * 0.2 + Math.sqrt(area(r)) * 0.001;
}

export function hitList(list: AnnotData[], p: Pt, tol: number): AnnotData | null {
  let best: AnnotData | null = null, bd = Infinity;
  for (let i = list.length - 1; i >= 0; i--) {
    const d = hitAnnot(list[i], p, tol);
    if (d != null && d < bd) { bd = d; best = list[i]; }
  }
  return best;
}

// ---------------------------------------------------------------- measuring

export function pathLength(v: Pt[], closed = false): number {
  let s = 0;
  for (let i = 0; i + 1 < v.length; i++) s += dist(v[i], v[i + 1]);
  if (closed && v.length > 2) s += dist(v[v.length - 1], v[0]);
  return s;
}
export function polyArea(v: Pt[]): number {
  let a = 0;
  for (let i = 0; i < v.length; i++) { const [x0, y0] = v[i], [x1, y1] = v[(i + 1) % v.length]; a += x0 * y1 - x1 * y0; }
  return Math.abs(a) / 2;
}
export function angleAt(a: Pt, b: Pt, c: Pt): number {
  const u = Math.atan2(a[1] - b[1], a[0] - b[0]), w = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = Math.abs(u - w) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * How a measurement shows its number: the unit (auto = metres, millimetres under 1 m) and the
 * decimals per unit. Defaults: 3 for m, 0 for mm, 2 for m², 2 for inches.
 */
export interface MeasureFmt { unit?: 'auto' | 'm' | 'mm'; dm?: number; dmm?: number; da?: number; din?: number; /** made before 0.6.0: inches as then (2 decimals under 10", 1 above) unless din is set */ legacy?: boolean }
export const FMT_DEFAULTS = { dm: 3, dmm: 0, da: 2, din: 2 };
/** measurements made before 0.6.0 (no format stored): their numbers had 2 decimals in metres -
 *  an edit keeps that rather than switching to the new default */
export const LEGACY_FMT: MeasureFmt = { dm: 2, legacy: true };
const dec = (v: number | undefined, d: number) => (typeof v === 'number' && v >= 0 && v <= 6 ? Math.round(v) : d);
/** which unit a length shows in (for "Decimals" to know what it changes) */
export function lenUnit(pts: number, s: Scale | null, f?: MeasureFmt): 'm' | 'mm' | 'in' | 'paper' {
  if (!s) return 'paper';
  if (s.imperial) return 'in';
  const u = f?.unit || 'auto';
  return u === 'mm' ? 'mm' : u === 'm' ? 'm' : pts * s.k < 1 ? 'mm' : 'm';
}
export function fmtLen(pts: number, s: Scale | null, f?: MeasureFmt): string {
  if (!s) return (pts / 72 * 25.4).toFixed(1) + ' mm (paper)';
  const m = pts * s.k;
  if (s.imperial) {
    const inches = m / 0.0254;
    if (f?.legacy && f.din === undefined) { const ft0 = Math.floor(inches / 12), in0 = inches - ft0 * 12; return `${ft0}' ${in0.toFixed(in0 < 10 ? 2 : 1)}"`; }
    let ft = Math.floor(inches / 12);
    const d = dec(f?.din, FMT_DEFAULTS.din);
    let inch = Number((inches - ft * 12).toFixed(d));
    if (inch >= 12) { ft++; inch -= 12; }
    return `${ft}' ${inch.toFixed(d)}"`;
  }
  if (lenUnit(pts, s, f) === 'mm') {
    const mm = (m * 1000).toFixed(dec(f?.dmm, FMT_DEFAULTS.dmm));
    // (0.9996 m in auto: "1000 mm" is a metre - shown as one)
    if (!(f?.unit === 'mm') && Number(mm) >= 1000) return m.toFixed(dec(f?.dm, FMT_DEFAULTS.dm)) + ' m';
    return mm + ' mm';
  }
  return m.toFixed(dec(f?.dm, FMT_DEFAULTS.dm)) + ' m';
}
export function fmtArea(pts2: number, s: Scale | null, f?: MeasureFmt): string {
  if (!s) return (pts2 * (25.4 / 72) ** 2 / 100).toFixed(1) + ' cm² (paper)';
  const m2 = pts2 * s.k * s.k;
  const d = dec(f?.da, FMT_DEFAULTS.da);
  // (1 / 0.09290304 exactly: 10.7639 made 100 ft × 100 ft 9,999.99 sq ft)
  if (s.imperial) return (m2 / 0.09290304).toFixed(d) + ' sq ft';
  return m2.toFixed(d) + ' m²';
}
/** a scale as it applies to a page turned `rot` now (separate X / Y swap on a quarter turn) */
export function orientScale(s: Scale | null, rot: number): Scale | null {
  if (!s || !s.ky || s.rot == null) return s;
  if (((((rot - s.rot) % 180) + 180) % 180) !== 90) return s;
  return { ...s, k: s.ky, label: s.labelY ?? s.label, ky: s.k, labelY: s.label, rot };
}
/**
 * A point of a page (as shown now: turned `pg.rot`, `pg.w` × `pg.h`) is in a viewport's box. The box
 * was drawn on the page as it was turned then (its scale's `rot`): the point is turned back to that
 * first - after a page turn the detail was measured at the page scale, and the box's old place at
 * the detail's (0.8.5 blind review, B3-06).
 */
export function inViewport(v: { rect: number[]; scale?: { rot?: number } | null }, x: number, y: number, pg?: { w: number; h: number; rot: number } | null): boolean {
  let px = x, py = y;
  const vr = v.scale?.rot;
  if (pg && vr != null && Number.isFinite(pg.rot)) {
    let steps = ((Math.round((pg.rot - vr) / 90) % 4) + 4) % 4; // clockwise quarter turns since
    let W = pg.w, H = pg.h;
    while (steps-- > 0) { [px, py] = [py, W - px]; [W, H] = [H, W]; } // a quarter turn back
  }
  return px >= v.rect[0] && px <= v.rect[2] && py >= v.rect[1] && py <= v.rect[3];
}
/** a separate vertical scale: how much more (or less) a point counts up/down than across */
export const yRatio = (s: Scale | null | undefined): number => (s && s.ky && s.k > 0 && Math.abs(s.ky / s.k - 1) > 1e-9 ? s.ky / s.k : 1);
/** points with Y stretched to the X scale (lengths, areas and angles then come out real) */
export const stretchY = (pts: Pt[], s: Scale | null | undefined): Pt[] => { const r = yRatio(s); return r === 1 ? pts : pts.map((p) => [p[0], p[1] * r] as Pt); };
/** a distance in X-scale points (for fmtLen) */
export const realDist = (a: Pt, b: Pt, s: Scale | null | undefined) => Math.hypot(b[0] - a[0], (b[1] - a[1]) * yRatio(s));
/** "1:100", or "X 1:100 · Y 1:20" with a separate vertical scale */
export const scaleText = (s: Scale) => (yRatio(s) !== 1 ? `X ${s.label} · Y ${s.labelY || '1:' + Math.round((s.ky as number) / PT_M)}` : s.label);
/** a scale picked (or calibrated) for both directions, or just across (X) / up and down (Y) */
export function scaleFor(cur: Scale | null, pick: Scale, dir: 'both' | 'x' | 'y'): Scale {
  let out: Scale;
  if (dir === 'both' || !cur) out = dir === 'y' && !cur ? { ...pick, ky: pick.k, labelY: pick.label } : { k: pick.k, label: pick.label, imperial: pick.imperial };
  else if (dir === 'x') out = { k: pick.k, label: pick.label, imperial: pick.imperial, ky: cur.ky ?? cur.k, labelY: cur.labelY ?? cur.label };
  else out = { k: cur.k, label: cur.label, imperial: cur.imperial, ky: pick.k, labelY: pick.label };
  // (the same both ways after all: one scale)
  if (out.ky && Math.abs(out.ky / out.k - 1) < 1e-9) { delete out.ky; delete out.labelY; }
  return out;
}

// ---------------------------------------------------------------- circles and rectangles (0.8.5)

/** corners of a circle measured with the Circle way of drawing: its outline as a polygon (what
 *  other PDF programs show), the number worked out from the circle itself (circleOf) */
export const CIRCLE_N = 128;
export function circlePts(c: Pt, r: number, n = CIRCLE_N, a0 = 0): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) { const t = a0 + (i * 2 * Math.PI) / n; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
  return out;
}
/**
 * The circle a measured outline is: 48 corners or more, all the same distance from their middle
 * (within 0.2 %) - no outline clicked by hand is that. Its number is then the circle's (pi r²,
 * 2 pi r), not the polygon's, which is a little smaller.
 */
export function circleOf(v: Pt[] | null | undefined): { c: Pt; r: number } | null {
  if (!v || v.length < 48) return null;
  let cx = 0, cy = 0;
  for (const p of v) { cx += p[0]; cy += p[1]; }
  cx /= v.length; cy /= v.length;
  let r = 0;
  for (const p of v) r += Math.hypot(p[0] - cx, p[1] - cy);
  r /= v.length;
  if (!(r > 0)) return null;
  for (const p of v) if (Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - r) > r * 2e-3) return null;
  return { c: [cx, cy], r };
}
/** an ellipse's perimeter (Ramanujan) - a circle under separate X / Y scales */
export function ellipsePerimeter(a: number, b: number): number {
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}
/** four corners, each side straight across or straight up (a rectangle measured as one) */
export function isAxisRect(v: Pt[] | null | undefined): boolean {
  if (!v || v.length !== 4) return false;
  const span = Math.max(...v.map((p) => p[0])) - Math.min(...v.map((p) => p[0])) + Math.max(...v.map((p) => p[1])) - Math.min(...v.map((p) => p[1]));
  const tol = Math.max(1e-6, span * 1e-6);
  for (let i = 0; i < 4; i++) {
    const a = v[i], b = v[(i + 1) % 4];
    if (Math.abs(a[0] - b[0]) > tol && Math.abs(a[1] - b[1]) > tol) return false;
  }
  return true;
}
/** a rectangle's corner moved to p, the rectangle kept: the two corners beside it follow (one
 *  across, one up and down), the corner opposite stays */
export function rectKeep(v: Pt[], i: number, p: Pt): Pt[] {
  const out = v.map((q) => [q[0], q[1]] as Pt);
  const o = v[i];
  out[i] = [p[0], p[1]];
  for (const j of [(i + 1) % 4, (i + 3) % 4]) {
    // the one beside it on the same up-down line takes the new x, the one on the same
    // across line the new y
    if (Math.abs(v[j][0] - o[0]) <= Math.abs(v[j][1] - o[1])) out[j][0] = p[0];
    else out[j][1] = p[1];
  }
  return out;
}

/**
 * A length typed while measuring (the next point goes that far towards the pointer): "4.2" or
 * "4,2" = metres, a whole number of 100 or more = millimetres ("4200"), or with a unit: "4200mm",
 * "420cm", "4.2m". Imperial scales: feet ("12.5", "12'6\"", "150\""). `read`: how it was read
 * when that isn't plain (a comma for the decimal point, millimetres without a unit) - shown
 * before Enter, so "4212.5" meaning millimetres is caught as the 4.2 km it would be.
 */
export function parseTypedLength(t: string, imperial = false): { m: number; read: string } | null {
  const s = t.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (imperial) {
    let m = /^(\d+(?:[.,]\d+)?)'(?:(\d+(?:[.,]\d+)?)"?)?$/.exec(s);
    if (m) { const ft = Number(m[1].replace(',', '.')) + Number((m[2] || '0').replace(',', '.')) / 12; return { m: ft * 0.3048, read: '' }; }
    m = /^(\d+(?:[.,]\d+)?)("|in)$/.exec(s);
    if (m) return { m: Number(m[1].replace(',', '.')) * 0.0254, read: '' };
    m = /^(\d+(?:[.,]\d+)?)(ft)?$/.exec(s);
    if (m) return { m: Number(m[1].replace(',', '.')) * 0.3048, read: m[1].includes(',') ? 'feet' : '' };
    return null;
  }
  const m = /^(\d*(?:[.,]\d+)?|\d+[.,]?)(mm|cm|m)?$/.exec(s);
  if (!m || !m[1] || m[1] === '.' || m[1] === ',') return null;
  const comma = m[1].includes(',');
  const v = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0) return null;
  if (m[2] === 'mm') return { m: v / 1000, read: comma ? 'mm' : '' };
  if (m[2] === 'cm') return { m: v / 100, read: comma ? 'cm' : '' };
  if (m[2] === 'm') return { m: v, read: comma ? 'm' : '' };
  // no unit: a whole number of 100 or more is millimetres (how drawings are dimensioned)
  if (/^\d+$/.test(m[1]) && v >= 100) return { m: v / 1000, read: 'mm' };
  return { m: v, read: comma ? 'm' : '' };
}

/** the number a measurement shows, from its points (kind: measure-length, -area, ...) */
/** an area's label gives its perimeter too ("27.88 m² · P 21.200 m" - 0.8.9: one Area tool) */
export const PERIM_SEP = ' · P ';
export function measureValue(kind: string, pts: Pt[], s: Scale | null, f?: MeasureFmt): string {
  const k = kind.replace(/^(measure-|m-)/, '');
  // a circle (drawn as one): the circle's own number - an ellipse with separate X / Y scales
  if (k === 'area' || k === 'perimeter') {
    const ci = circleOf(pts);
    if (ci) {
      const ry = yRatio(s);
      const per = fmtLen(ellipsePerimeter(ci.r, ci.r * ry), s, f);
      return k === 'area' ? fmtArea(Math.PI * ci.r * ci.r * ry, s, f) + PERIM_SEP + per : per;
    }
  }
  pts = stretchY(pts, s);
  if (k === 'length' || k === 'calibrate') return pts.length >= 2 ? fmtLen(dist(pts[0], pts[pts.length - 1]), s, f) : '';
  if (k === 'polylength') return fmtLen(pathLength(pts), s, f);
  if (k === 'area') return fmtArea(polyArea(pts), s, f) + (pts.length >= 2 ? PERIM_SEP + fmtLen(pathLength(pts, true), s, f) : '');
  if (k === 'perimeter') return fmtLen(pathLength(pts, true), s, f);
  if (k === 'angle') return pts.length >= 3 ? angleAt(pts[0], pts[1], pts[2]).toFixed(1) + '°' : '';
  return '';
}

/**
 * A measurement's number and its unit apart (for Excel: numbers as numbers, the unit in its own
 * cell). "7.056 m" -> 7.056 "m" (3 decimals); "45.20 m²"; "450 mm"; "30.0°"; "12.3 mm (paper)";
 * 12' 3.50" -> 12.2917 "ft" (feet and inches as decimal feet). Anything else (a label typed by
 * hand) -> null.
 */
export function splitMeasure(text: string): { v: number; unit: string; dec: number } | null {
  // (an area's label: its area - the perimeter after it is perimeterOf's)
  let t = String(text ?? '').replace(/\u00a0/g, ' ');
  const i = t.indexOf(PERIM_SEP);
  if (i >= 0) t = t.slice(0, i);
  t = t.trim();
  let m = /^(-?\d+(?:\.(\d+))?) ?(m²|m|mm|sq ft|cm² \(paper\)|mm \(paper\))$/.exec(t);
  if (m) return { v: Number(m[1]), unit: m[3], dec: m[2]?.length ?? 0 };
  m = /^(-?\d+(?:\.(\d+))?) ?°$/.exec(t);
  if (m) return { v: Number(m[1]), unit: '°', dec: m[2]?.length ?? 0 };
  m = /^(\d+)' (\d+(?:\.\d+)?)"$/.exec(t);
  if (m) return { v: Math.round((Number(m[1]) + Number(m[2]) / 12) * 1e4) / 1e4, unit: 'ft', dec: 4 };
  return null;
}

/** the perimeter in an area's label ("27.88 m² · P 21.200 m" -> 21.2 m); null: none in it */
export function perimeterOf(text: string): { v: number; unit: string; dec: number } | null {
  const t = String(text ?? '').replace(/\u00a0/g, ' ');
  const i = t.indexOf(PERIM_SEP);
  return i < 0 ? null : splitMeasure(t.slice(i + PERIM_SEP.length));
}

/** the foot of the perpendicular from `from` onto the segment a-b; null when it falls outside it */
export function perpFootOn(from: Pt, a: Pt, b: Pt): Pt | null {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return null;
  const t = ((from[0] - a[0]) * dx + (from[1] - a[1]) * dy) / l2;
  if (t < -1e-9 || t > 1 + 1e-9) return null;
  return [a[0] + t * dx, a[1] + t * dy];
}

/** constrain to 0/45/90° from a */
export function ortho(a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const l = Math.hypot(dx, dy);
  return [a[0] + Math.cos(ang) * l, a[1] + Math.sin(ang) * l];
}

/** standard drawing scales (paper at true size): metres per point */
export const PT_M = 0.0254 / 72;
export const STANDARD_SCALES: { label: string; k: number; imperial?: boolean }[] = [
  ...[1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 300, 400, 500, 750, 1000, 1250, 2000, 2500, 5000].map((n) => ({ label: '1:' + n, k: PT_M * n })),
  ...[
    ['1/16" = 1\'-0"', 192], ['3/32" = 1\'-0"', 128], ['1/8" = 1\'-0"', 96], ['3/16" = 1\'-0"', 64], ['1/4" = 1\'-0"', 48],
    ['3/8" = 1\'-0"', 32], ['1/2" = 1\'-0"', 24], ['3/4" = 1\'-0"', 16], ['1" = 1\'-0"', 12], ['1 1/2" = 1\'-0"', 8], ['3" = 1\'-0"', 4],
    ['1" = 10\'', 120], ['1" = 20\'', 240], ['1" = 50\'', 600], ['1" = 100\'', 1200],
  ].map(([l, n]) => ({ label: l as string, k: PT_M * (n as number), imperial: true })),
];

/** "1:100", "1 : 50" etc. in sheet text */
export function scalesInText(t: string): string[] {
  const out = new Set<string>();
  for (const m of t.matchAll(/\b1\s*:\s*(\d{1,4})\b/g)) out.add('1:' + m[1]);
  return [...out];
}

/** a callout's line from its tip to the side of the box nearest to it (same as the engine's) */
export function calloutPath(b: Rect, tip: Pt): Pt[] {
  const [x0, y0, x1, y1] = b;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let att: Pt, knee: Pt;
  if (tip[0] < x0 - 4) { att = [x0, cy]; knee = [x0 - 18, cy]; }
  else if (tip[0] > x1 + 4) { att = [x1, cy]; knee = [x1 + 18, cy]; }
  else if (tip[1] < y0) { att = [cx, y0]; knee = [cx, y0 - 18]; }
  else { att = [cx, y1]; knee = [cx, y1 + 18]; }
  if (Math.hypot(tip[0] - att[0], tip[1] - att[1]) < 24) return [tip, att];
  return [tip, knee, att];
}

/** room kept round a small markup the view goes to (pt, about a hand's width of the sheet) */
export const SHOW_ROOM = 200;
/**
 * The zoom for going to a markup with box `r` in a view of vw x vh pixels: the current one while
 * the markup is a fair size on screen; zoomed out if it does not fit, in if it is too small to
 * see - to where it (or, if smaller, SHOW_ROOM round it) takes about half the view. (Without the
 * room a comment's 20 pt icon was zoomed to fill half the window: 1000-2000 %.)
 */
export function zoomToShow(cur: number, r: number[], vw: number, vh: number, zMax: number): number {
  const w = r[2] - r[0], h = r[3] - r[1];
  const lim = (z: number) => Math.max(0.05, Math.min(zMax, z));
  const fit = Math.min((vw * 0.5) / Math.max(1e-3, w), (vh * 0.5) / Math.max(1e-3, h));
  if (cur > fit * 3) return lim(fit);
  const need = Math.min((vw * 0.5) / Math.max(SHOW_ROOM, w), (vh * 0.5) / Math.max(SHOW_ROOM, h));
  if (cur < need * 0.4) return lim(need);
  return cur;
}

/** box `r` moved (not resized) onto a page of w x h, as far as it fits (one bigger than the
 *  page keeps its top-left corner on it) */
export function placeOnPage(r: Rect, w: number, h: number): Rect {
  const sh = (a: number, b: number, size: number) => (a < 0 ? -a : b > size ? Math.max(-a, size - b) : 0);
  const dx = sh(r[0], r[2], w), dy = sh(r[1], r[3], h);
  return [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
}

/**
 * How far (dx, dy) markups can move and stay on their pages, given each page's own box of them
 * and size (a selection over several pages: one box across pages, checked against the first
 * page only, pushed markups on other pages off the sheet). A box already past an edge may move
 * back, not further out.
 */
export function shiftOnPages(boxes: { box: Rect; w: number; h: number }[], dx: number, dy: number): [number, number] {
  let lx = -Infinity, hx = Infinity, ly = -Infinity, hy = Infinity;
  for (const { box: B, w, h } of boxes) {
    if (B[2] > B[0]) { lx = Math.max(lx, Math.min(0, -B[0])); hx = Math.min(hx, Math.max(0, w - B[2])); }
    if (B[3] > B[1]) { ly = Math.max(ly, Math.min(0, -B[1])); hy = Math.min(hy, Math.max(0, h - B[3])); }
  }
  return [Math.max(lx, Math.min(hx, dx)), Math.max(ly, Math.min(hy, dy))];
}

/**
 * A closed shape whose sides cross (corners clicked in a bow-tie order, or one dragged across a
 * side): its area comes out as the difference of its parts - 0 for a symmetric bow tie - and
 * nothing said so (0.8.5 blind review, B3-11).
 */
export function selfCrosses(pts: Pt[]): boolean {
  const n = pts.length;
  if (n < 4) return false;
  const cross = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const hit = (p1: Pt, p2: Pt, q1: Pt, q2: Pt) => {
    const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2), d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
    return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
  };
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // (sides that meet at a corner)
      if (hit(a, b, pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}
