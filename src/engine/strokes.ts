// Page content with millions of separate little strokes (traced scans, some CAD exports: one
// "m l l S" per 2-pixel segment) is merged into fewer, longer strokes. Drawn identically: the
// subpaths of one path are stroked independently (no joins between them, the dash pattern starts
// again for each), and only runs of strokes with nothing in between are merged - same colour,
// width, everything. Fills are never merged (overlapping subpaths would change the winding).
// Why: the drawing engine keeps one object per stroke - 13 million of them ran it out of memory
// (a 46 MB landscape sheet that only one other reader could open).

/** how many strokes go into one merged stroke: few enough that a tile skips the ones far away */
const BATCH = 1500;
/** pages with fewer strokes are left alone: up to a few million the drawing engines cope, and
 *  merged strokes spread over a sheet make zoomed-in tiles slower (they can't be skipped) */
export const MIN_STROKES = 4_000_000;

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

export interface MergeResult { out: Uint8Array; strokesIn: number; strokesOut: number }

/**
 * Merge runs of strokes in a decoded content stream. `out` is the new content in pieces (to be
 * compressed). Returns null when there is little to gain (not worth a rewrite).
 */
export function mergeStrokes(src: Uint8Array, minStrokes = MIN_STROKES): MergeResult | null {
  const n = src.length;
  // (copied into one growing buffer: a view object per piece ran out of memory at 30 million)
  let out = new Uint8Array(n + (1 << 20));
  let size = 0;
  const room = (k: number) => { if (size + k > out.length) { const b = new Uint8Array(Math.max(out.length * 1.25, size + k + (1 << 20)) | 0); b.set(out.subarray(0, size)); out = b; } };
  const emit = (a: number, b: number) => { if (b > a) { room(b - a); out.set(src.subarray(a, b), size); size += b - a; } };
  const emitS = () => { room(3); out[size++] = 10; out[size++] = 0x53; out[size++] = 10; };
  // the current path: [start, end) ranges of its construction instructions (operands + operator)
  let path: number[] = [];
  /** the path starts a new point (m or re): one that goes on from the last point can't be joined */
  let pathOk = false;
  // strokes waiting to be merged (their path ranges)
  let pending: number[] = [];
  let pendingN = 0;
  let strokesIn = 0, strokesOut = 0;
  const flushPending = () => {
    if (!pendingN) return;
    for (let k = 0; k < pending.length; k += 2) emit(pending[k], pending[k + 1]);
    emitS();
    strokesOut++;
    pending = [];
    pendingN = 0;
  };
  const flushPath = () => { for (let k = 0; k < path.length; k += 2) emit(path[k], path[k + 1]); path = []; };
  let i = 0;
  let segStart = 0; // where the operands of the next operator begin
  while (i < n) {
    const c = src[i];
    if (WS[c]) { i++; continue; }
    if (c === 0x25) { while (i < n && src[i] !== 10 && src[i] !== 13) i++; continue; } // % comment
    if (c === 0x28) { // (string) with nesting and escapes
      let depth = 1; i++;
      while (i < n && depth) { const d = src[i]; if (d === 0x5c) i += 2; else { if (d === 0x28) depth++; else if (d === 0x29) depth--; i++; } }
      continue;
    }
    if (c === 0x3c) { // <hex> or <<
      if (src[i + 1] === 0x3c) { i += 2; continue; }
      while (i < n && src[i] !== 0x3e) i++;
      i++;
      continue;
    }
    // (a stray ")" outside any string - malformed, but it happens - is passed over too: it stopped
    // the scan on the same byte for ever and froze the editing engine)
    if (c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x29) { i++; continue; }
    if (c === 0x2f) { i++; while (i < n && !WS[src[i]] && !DELIM[src[i]]) i++; continue; } // /Name
    // a number or an operator
    const a = i;
    while (i < n && !WS[src[i]] && !DELIM[src[i]]) i++;
    // (never stand still: any other byte the scan stops on is skipped)
    if (i === a) { i++; continue; }
    const ch = src[a];
    if ((ch >= 0x30 && ch <= 0x39) || ch === 0x2d || ch === 0x2b || ch === 0x2e) continue; // number
    // (operators told apart by their bytes: tens of millions of them on such a page)
    const len = i - a, c1 = len > 1 ? src[a + 1] : 0;
    const isBI = len === 2 && ch === 0x42 && c1 === 0x49;
    const isPath = (len === 1 && (ch === 0x6d || ch === 0x6c || ch === 0x63 || ch === 0x76 || ch === 0x79 || ch === 0x68)) || (len === 2 && ch === 0x72 && c1 === 0x65);
    const isS = len === 1 && ch === 0x53;
    if (isBI) {
      // inline picture: its data runs up to "EI" between white space - copied as it is
      flushPending(); flushPath();
      let j = i;
      while (j < n && !(WS[src[j - 1]] && src[j] === 0x45 && src[j + 1] === 0x49 && (j + 2 >= n || WS[src[j + 2]]))) j++;
      i = Math.min(n, j + 2);
      emit(segStart, i);
      segStart = i;
      continue;
    }
    if (isPath) {
      if (!path.length) pathOk = (len === 1 && ch === 0x6d) || (len === 2 && ch === 0x72);
      path.push(segStart, i); segStart = i; continue;
    }
    if (isS) {
      strokesIn++;
      if (path.length && pathOk) {
        for (const x of path) pending.push(x); pendingN++; path = [];
        segStart = i;
        if (pendingN >= BATCH) flushPending();
      } else {
        // a stroke whose path was interrupted (a clip, a colour or width set inside it) or that
        // goes on from the last point: written exactly as it was, after the strokes so far
        flushPending(); flushPath();
        emit(segStart, i);
        segStart = i;
      }
      continue;
    }
    // anything else: the strokes so far are written, then the path (for a fill / clip), then it
    flushPending();
    flushPath();
    emit(segStart, i);
    segStart = i;
  }
  flushPending();
  flushPath();
  emit(segStart, n);
  if (strokesIn < minStrokes || strokesOut * 4 > strokesIn) return null;
  return { out: out.subarray(0, size), strokesIn, strokesOut };
}
