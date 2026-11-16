// Reference for the snap-index tests (PLAN 2.1, 2.2): buildSnap as it was before those tasks
// (copied from src/engine/pdfium.ts at commit 1.9, only the surroundings changed), and generators for
// pages with a lot of line work. The new buildSnap must give an identical index.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import * as pf from '../src/engine/pdfium';
import type { SnapIndex } from '../src/engine/pdfium';

const E = () => pf.engineForTests().pdfium as any;
const malloc = (n: number) => E().wasmExports.malloc(n) >>> 0;
const free = (p: number) => E().wasmExports.free(p);
const { engineForTests, snapPageForTests: pageForTests } = pf;

/** the old buildSnap, without its cache: reads the segments one call at a time, counts while indexing */
export function oldBuildSnap(id: string, pg: number, snapMax: number): SnapIndex {
  const q = engineForTests() as any;
  const p = pageForTests(id, pg);
  const { w, h } = p;
  let seg = new Float32Array(1 << 18);
  let kd = new Uint8Array(1 << 16);
  let n = 0;
  /** path pieces seen so far (counted while indexing, not in a pass of its own: that cost seconds) */
  let total = 0, tooMany = false;
  const push = (x0: number, y0: number, x1: number, y1: number, kind = 7) => {
    if (Math.abs(x1 - x0) + Math.abs(y1 - y0) < 0.6) return;
    if (n * 4 + 4 > seg.length) { const g = new Float32Array(seg.length * 2); g.set(seg); seg = g; }
    if (n + 1 > kd.length) { const g = new Uint8Array(kd.length * 2); g.set(kd); kd = g; }
    seg[n * 4] = x0; seg[n * 4 + 1] = y0; seg[n * 4 + 2] = x1; seg[n * 4 + 3] = y1;
    kd[n] = kind;
    n++;
  };
  /**
   * A curve (from x0, y0 through the control points c = [x1 y1 x2 y2 x3 y3]) as a few chords on
   * the curve itself. PDFium hands a curve over as its three points: joined up, they made the
   * control polygon - snap marks floated off arcs and rounded corners, up to 14 % of the radius.
   * Only the curve's own two ends are line ends; the chords have no middles of their own.
   */
  const curve = (x0: number, y0: number, c: number[]) => {
    const len = Math.hypot(c[0] - x0, c[1] - y0) + Math.hypot(c[2] - c[0], c[3] - c[1]) + Math.hypot(c[4] - c[2], c[5] - c[3]);
    const k = Math.max(2, Math.min(16, Math.ceil(len / 8)));
    let ax = x0, ay = y0;
    for (let i = 1; i <= k; i++) {
      const t = i / k, u = 1 - t;
      const bx = u * u * u * x0 + 3 * u * u * t * c[0] + 3 * u * t * t * c[2] + t * t * t * c[4];
      const by = u * u * u * y0 + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5];
      push(ax, ay, bx, by, (i === 1 ? 1 : 0) | (i === k ? 2 : 0));
      ax = bx; ay = by;
    }
  };
  const mat = malloc(24), xy = malloc(8);
  const F = () => new Float32Array((engineForTests().pdfium as any).HEAPU8.buffer);
  const mulM = (A: number[], B: number[]) => [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ];
  const visit = (obj: number, T: number[], depth: number) => {
    const type = q.FPDFPageObj_GetType(obj);
    if (type !== 2 && type !== 5) return;
    let Mx = [1, 0, 0, 1, 0, 0];
    if (q.FPDFPageObj_GetMatrix(obj, mat)) { const f = F(); const i = mat >>> 2; Mx = [f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5]]; }
    const A = mulM(T, Mx);
    if (type === 5) {
      if (depth > 6) return;
      const c = q.FPDFFormObj_CountObjects(obj);
      for (let k = 0; k < c; k++) visit(q.FPDFFormObj_GetObject(obj, k), A, depth + 1);
      return;
    }
    const cnt = q.FPDFPath_CountSegments(obj);
    // (a page of tens of millions of line pieces: given up as soon as that's clear)
    if ((total += cnt) > snapMax) { n = 0; tooMany = true; return; }
    let sx = 0, sy = 0, px = 0, py = 0, has = false;
    /** the points of a curve being read (a curve comes as three points of type "bezier") */
    const bz: number[] = [];
    for (let k = 0; k < cnt; k++) {
      const sg = q.FPDFPath_GetPathSegment(obj, k);
      if (!q.FPDFPathSegment_GetPoint(sg, xy, xy + 4)) continue;
      const f = F();
      const ux = f[xy >>> 2], uy = f[(xy >>> 2) + 1];
      const X = A[0] * ux + A[2] * uy + A[4], Y = A[1] * ux + A[3] * uy + A[5];
      const t = q.FPDFPathSegment_GetType(sg);
      if (t === 2 || !has) { sx = X; sy = Y; has = true; bz.length = 0; }
      else if (t === 1) {
        bz.push(X, Y);
        // (the curve's start stays where it was until its last point is in)
        if (bz.length < 6) continue;
        curve(px, py, bz);
        bz.length = 0;
      } else push(px, py, X, Y);
      px = X; py = Y;
      if (q.FPDFPathSegment_GetClose(sg) && (px !== sx || py !== sy)) { push(px, py, sx, sy); px = sx; py = sy; }
    }
  };
  const count = q.FPDFPage_CountObjects(p.ptr);
  // a page of tens of millions of line pieces (a traced scan): no snapping there - reading them
  // all would take a minute and hundreds of MB
  for (let i = 0; i < count && !tooMany; i++) visit(q.FPDFPage_GetObject(p.ptr, i), p.aff, 0);
  if (tooMany) n = 0;
  free(mat); free(xy);
  const cols = 128, rows = Math.max(16, Math.round((128 * h) / w));
  const cw = w / cols, ch = h / rows;
  const counts = new Int32Array(cols * rows + 1);
  const cellsOf = (i: number, f: (c: number) => void) => {
    const x0 = Math.min(seg[i * 4], seg[i * 4 + 2]), x1 = Math.max(seg[i * 4], seg[i * 4 + 2]);
    const y0 = Math.min(seg[i * 4 + 1], seg[i * 4 + 3]), y1 = Math.max(seg[i * 4 + 1], seg[i * 4 + 3]);
    const c0 = Math.max(0, Math.floor(x0 / cw)), c1 = Math.min(cols - 1, Math.floor(x1 / cw));
    const r0 = Math.max(0, Math.floor(y0 / ch)), r1 = Math.min(rows - 1, Math.floor(y1 / ch));
    if (c1 < c0 || r1 < r0) return;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) f(r * cols + c);
  };
  for (let i = 0; i < n; i++) cellsOf(i, (c) => counts[c + 1]++);
  for (let c = 0; c < cols * rows; c++) counts[c + 1] += counts[c];
  const ids = new Int32Array(counts[cols * rows]);
  const fill = counts.slice();
  for (let i = 0; i < n; i++) cellsOf(i, (c) => (ids[fill[c]++] = i));
  return { seg: seg.slice(0, n * 4), kind: kd.slice(0, n), n, cols, rows, cw, ch, start: counts, ids, w, h };
}

/** a PDF written by hand: objects as strings, xref computed */
export function rawPdf(objs: string[]): Uint8Array {
  const parts: string[] = ['%PDF-1.7\n'];
  let len = parts[0].length;
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(len); const t = `${i + 1} 0 obj\n${o}\nendobj\n`; parts.push(t); len += t.length; });
  const x = len;
  parts.push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  parts.push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`);
  const s = parts.join('');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}
/** one page (600 x 800) with the given content stream; `more` are extra objects (5 0 R onwards), `res` its /Resources */
export const onePage = (content: string, more: string[] = [], res = '') => rawPdf([
  '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R${res ? ' /Resources ' + res : ''} >>`,
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ...more,
]);
/** a form XObject with the given content and matrix; `res` lets it draw another form */
export const form = (content: string, matrix = '1 0 0 1 0 0', res = '') =>
  `<< /Type /XObject /Subtype /Form /BBox [-1000 -1000 2000 2000] /Matrix [${matrix}]${res ? ' /Resources ' + res : ''} /Length ${content.length} >>\nstream\n${content}\nendstream`;
/** a page of `n` line pieces: paths of `per` pieces each, scattered (a small seeded generator, always the same page) */
export function manyLines(n: number, per = 10): string {
  let s = 1;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out: string[] = [];
  for (let i = 0; i < n; i += per) {
    let x = r() * 560, y = r() * 760;
    let t = `${x.toFixed(2)} ${y.toFixed(2)} m `;
    for (let k = 0; k < per; k++) { x = Math.min(595, Math.max(1, x + (r() - 0.5) * 30)); y = Math.min(795, Math.max(1, y + (r() - 0.5) * 30)); t += `${x.toFixed(2)} ${y.toFixed(2)} l `; }
    out.push(t + 'S');
  }
  return out.join('\n');
}

/** two indexes are the same, array by array (bit for bit) */
export function sameIndex(a: pf.SnapIndex, b: pf.SnapIndex, what: string) {
  assert.equal(a.n, b.n, `${what}: n`);
  assert.deepEqual([a.cols, a.rows, a.cw, a.ch, a.w, a.h], [b.cols, b.rows, b.cw, b.ch, b.w, b.h], `${what}: grid`);
  const same = (x: ArrayBufferView, y: ArrayBufferView) => Buffer.compare(Buffer.from(x.buffer, x.byteOffset, x.byteLength), Buffer.from(y.buffer, y.byteOffset, y.byteLength)) === 0;
  assert.ok(same(a.seg, b.seg), `${what}: seg array`);
  assert.ok(same(a.kind, b.kind), `${what}: kinds`);
  assert.ok(same(a.start, b.start), `${what}: cell starts`);
  assert.ok(same(a.ids, b.ids), `${what}: cell ids`);
}
