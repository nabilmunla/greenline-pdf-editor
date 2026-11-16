// The stroke merge of strokes.ts, fed in pieces (PLAN 7.1). The whole decoded content of a heavy
// sheet (392-564 MB) was held at once, with the merged copy beside it and a deflate of that: the
// batch engine peaked at 1.3-2.0 GB. Here the content goes through a window that keeps only what
// is not written yet - an unfinished token, string, comment or inline picture, the current path
// and the strokes waiting to be merged - and the output goes out in pieces as it is made.
// The output is byte for byte that of mergeStrokes (the oracle; tests feed both at random piece
// sizes from 1 byte up).
import { BATCH } from './strokes';

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
/** output handed on in pieces of about this size */
const OUT_PIECE = 1 << 20;

export class StrokeMergeStream {
  private src = new Uint8Array(1 << 16);
  private n = 0;
  private i = 0;
  private segStart = 0;
  /** an inline picture whose end was not in the window yet: where its BI is, and how far its data
   *  was searched for EI (the next piece goes on from there - a 30 MB picture was searched again
   *  from its start at every 256 KB piece; Phase 6 sweep) */
  private biAt = -1;
  private biTo = 0;
  private path: number[] = [];
  private pathOk = false;
  private pending: number[] = [];
  private pendingN = 0;
  private stage = new Uint8Array(OUT_PIECE);
  private size = 0;
  strokesIn = 0;
  strokesOut = 0;
  /** bytes taken in / handed on */
  bytesIn = 0;
  bytesOut = 0;
  constructor(private sink: (piece: Uint8Array) => void) {}

  /** more content; output may be handed to the sink meanwhile */
  push(chunk: Uint8Array) {
    this.bytesIn += chunk.length;
    if (this.n + chunk.length > this.src.length) {
      const b = new Uint8Array(Math.max(this.src.length * 2, this.n + chunk.length));
      b.set(this.src.subarray(0, this.n));
      this.src = b;
    }
    this.src.set(chunk, this.n);
    this.n += chunk.length;
    this.scan(false);
    this.compact();
  }

  /** the content is complete: everything left is written, the last piece handed on */
  end() {
    this.scan(true);
    this.flushPending();
    this.flushPath();
    this.emit(this.segStart, this.n);
    this.segStart = this.n;
    this.flushStage();
  }

  private emit(a: number, b: number) {
    while (b > a) {
      const k = Math.min(b - a, OUT_PIECE - this.size);
      this.stage.set(this.src.subarray(a, a + k), this.size);
      this.size += k; a += k;
      if (this.size === OUT_PIECE) this.flushStage();
    }
  }
  private emitS() { this.emit3(10, 0x53, 10); }
  private emit3(x: number, y: number, z: number) {
    if (this.size + 3 > OUT_PIECE) this.flushStage();
    this.stage[this.size++] = x; this.stage[this.size++] = y; this.stage[this.size++] = z;
  }
  private flushStage() {
    if (!this.size) return;
    const piece = this.stage.subarray(0, this.size);
    this.bytesOut += this.size;
    this.sink(piece);
    // (the sink may keep the piece: a new one is filled next)
    this.stage = new Uint8Array(OUT_PIECE);
    this.size = 0;
  }
  private flushPending() {
    if (!this.pendingN) return;
    const p = this.pending;
    for (let k = 0; k < p.length; k += 2) this.emit(p[k], p[k + 1]);
    this.emitS();
    this.strokesOut++;
    this.pending = [];
    this.pendingN = 0;
  }
  private flushPath() { const p = this.path; for (let k = 0; k < p.length; k += 2) this.emit(p[k], p[k + 1]); this.path = []; }

  /** drop what is written and not needed any more (indices move down) */
  private compact() {
    let keep = Math.min(this.segStart, this.i);
    if (this.path.length) keep = Math.min(keep, this.path[0]);
    if (this.pending.length) keep = Math.min(keep, this.pending[0]);
    if (keep < 1 << 16) return;
    this.src.copyWithin(0, keep, this.n);
    this.n -= keep; this.i -= keep; this.segStart -= keep;
    if (this.biAt >= 0) { this.biAt -= keep; this.biTo -= keep; }
    for (let k = 0; k < this.path.length; k++) this.path[k] -= keep;
    for (let k = 0; k < this.pending.length; k++) this.pending[k] -= keep;
  }

  /**
   * strokes.ts mergeStrokes' loop, resumable: when the window ends inside something that may go on
   * in the next piece (not `final`), the scan stops at its start and goes on from there next time.
   */
  private scan(final: boolean) {
    const src = this.src, n = this.n;
    let i = this.i;
    while (i < n) {
      const c = src[i];
      if (WS[c]) { i++; continue; }
      if (c === 0x25) { // % comment
        const a = i;
        while (i < n && src[i] !== 10 && src[i] !== 13) i++;
        if (i >= n && !final) { i = a; break; }
        continue;
      }
      if (c === 0x28) { // (string) with nesting and escapes
        const a = i;
        let depth = 1; i++;
        while (i < n && depth) { const d = src[i]; if (d === 0x5c) i += 2; else { if (d === 0x28) depth++; else if (d === 0x29) depth--; i++; } }
        if ((depth || i > n) && !final) { i = a; break; }
        continue;
      }
      if (c === 0x3c) { // <hex> or <<
        if (i + 1 >= n && !final) break;
        // (past the end there is nothing - the window may hold old bytes there)
        if (i + 1 < n && src[i + 1] === 0x3c) { i += 2; continue; }
        const a = i;
        while (i < n && src[i] !== 0x3e) i++;
        if (i >= n && !final) { i = a; break; }
        i++;
        continue;
      }
      if (c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x29) { i++; continue; }
      if (c === 0x2f) { // /Name
        const a = i;
        i++; while (i < n && !WS[src[i]] && !DELIM[src[i]]) i++;
        if (i >= n && !final) { i = a; break; }
        continue;
      }
      const a = i;
      while (i < n && !WS[src[i]] && !DELIM[src[i]]) i++;
      if (i >= n && !final) { i = a; break; }
      if (i === a) { i++; continue; }
      const ch = src[a];
      if ((ch >= 0x30 && ch <= 0x39) || ch === 0x2d || ch === 0x2b || ch === 0x2e) continue;
      const len = i - a, c1 = len > 1 ? src[a + 1] : 0;
      const isBI = len === 2 && ch === 0x42 && c1 === 0x49;
      const isPath = (len === 1 && (ch === 0x6d || ch === 0x6c || ch === 0x63 || ch === 0x76 || ch === 0x79 || ch === 0x68)) || (len === 2 && ch === 0x72 && c1 === 0x65);
      const isS = len === 1 && ch === 0x53;
      if (isBI) {
        // (its end is found first: the strokes and path are only written once it is complete)
        let j = this.biAt === a ? Math.max(i, this.biTo) : i;
        while (j < n && !(WS[src[j - 1]] && src[j] === 0x45 && j + 1 < n && src[j + 1] === 0x49 && (j + 2 >= n || WS[src[j + 2]]))) j++;
        // (searched up to the window end: from 2 bytes back next time - an "EI" cut by the window)
        if (!final && j + 2 >= n) { this.biAt = a; this.biTo = Math.max(i, n - 3); i = a; break; }
        this.biAt = -1;
        this.flushPending(); this.flushPath();
        i = Math.min(n, j + 2);
        this.emit(this.segStart, i);
        this.segStart = i;
        continue;
      }
      if (isPath) {
        if (!this.path.length) this.pathOk = (len === 1 && ch === 0x6d) || (len === 2 && ch === 0x72);
        this.path.push(this.segStart, i); this.segStart = i; continue;
      }
      if (isS) {
        this.strokesIn++;
        if (this.path.length && this.pathOk) {
          for (const x of this.path) this.pending.push(x);
          this.pendingN++; this.path = [];
          this.segStart = i;
          if (this.pendingN >= BATCH) this.flushPending();
        } else {
          this.flushPending(); this.flushPath();
          this.emit(this.segStart, i);
          this.segStart = i;
        }
        continue;
      }
      this.flushPending();
      this.flushPath();
      this.emit(this.segStart, i);
      this.segStart = i;
    }
    this.i = i;
  }
}
