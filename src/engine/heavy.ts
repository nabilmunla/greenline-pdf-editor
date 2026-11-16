/// <reference types="node" />
// Heavy pages - millions of separate little strokes (see strokes.ts) - as the editing engine
// handles them: a look at a sample of the page's content first (3.1: an estimate of its strokes,
// whatever its compressed size), then inflate / merge / deflate. Node only (zlib); used by the
// engine host, the tests and the benchmark alike.
import { StrokeMergeStream } from './strokestream';
import zlib from 'node:zlib';
import { MIN_STROKES } from './strokes';

/** compressed bytes of a page's content read for the estimate */
export const SAMPLE = 1 << 20;

/**
 * Content this big (compressed) is always counted in full, whatever its sample says - the old bar,
 * kept: a sheet can open with megabytes of hatching fills and only then hold its strokes (a landscape
 * sheet: the first MB says 0.26 million strokes, the page holds 15 million). The merge itself still
 * decides (it counts every stroke).
 */
export const SURE_RAW = 30e6;
/** most a sample is decoded to for the estimate (Phase 6 sweep) */
export const EST_MAX = 64 * 2 ** 20;
const rawSize = (parts: Uint8Array[]) => parts.reduce((t, p) => t + p.length, 0);
/** stroke operators ("S" between white space) in decoded content - native searches, no parsing */
export function countStrokes(b: Buffer, cap = Infinity): number {
  let n = 0;
  for (const pat of ['S\n', 'S ', 'S\r']) {
    const p = Buffer.from(pat);
    for (let i = b.indexOf(p); i >= 0 && n < cap; i = b.indexOf(p, i + 2)) { const c = b[i - 1]; if (c === 32 || c === 10 || c === 13) n++; }
  }
  return n;
}

/**
 * About how many strokes a page's content holds, from the first SAMPLE bytes of its biggest part
 * (the line work; small parts are our wrappers or a few settings): strokes per compressed byte in
 * the sample x all compressed bytes. A 27 MB sheet of 17 million strokes was missed by the old
 * bar of 30 MB compressed; ordinary dense sheets (a few hundred thousand strokes) cost one
 * sample's inflate (a few ms), not a whole page's (seconds).
 */
export function estimateStrokes(parts: Uint8Array[]): number {
  if (!parts.length) return 0;
  let big = parts[0], total = 0;
  for (const p of parts) { total += p.length; if (p.length > big.length) big = p; }
  const head = big.subarray(0, Math.min(big.length, SAMPLE));
  let dec: Buffer;
  // (a stream cut off in the middle: what can be decoded so far)
  // (decoded at most EST_MAX: 1 MB of very repetitive data decodes to ~1 GB - the batch engine took
  // it whole before deciding anything. Past it: too many to count here - the streamed merge decides)
  try { dec = zlib.inflateSync(head, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: EST_MAX }); } catch { return Infinity; }
  return (countStrokes(dec) * total) / Math.max(1, head.length);
}

/**
 * The merger the engines are given (mu.setContentMerger): the page's content parts
 * (Flate-compressed) -> merged content, compressed - or null when the page isn't one of those.
 * force: asked for on a page that took the drawing engine down (any page of many strokes).
 * PLAN 7.1: streamed - each part is inflated in pieces, merged as it comes (strokestream.ts) and
 * the output deflated in pieces alongside; only the compressed result is kept whole (the whole
 * decoded content, the merged copy and its deflate were held at once: 1.3-2.0 GB).
 */
export function makeMerger(log?: (line: string) => void, min = MIN_STROKES, sure = SURE_RAW) {
  return async (parts: Uint8Array[], force?: boolean): Promise<Uint8Array | null> => {
    const t0 = Date.now();
    if (!force && rawSize(parts) < sure && estimateStrokes(parts) < min * 0.8) return null;
    const bar = force ? 50_000 : min;
    const deflate = zlib.createDeflate({ level: 6, chunkSize: 1 << 20 });
    const out: Buffer[] = [];
    deflate.on('data', (c: Buffer) => out.push(c));
    const ended = new Promise<void>((res, rej) => { deflate.on('end', () => res()); deflate.on('error', rej); });
    let full = false;
    const m = new StrokeMergeStream((piece) => { if (!deflate.write(piece)) full = true; });
    const drain = async () => { if (full) { full = false; await new Promise((r) => deflate.once('drain', r)); } };
    try {
      // (a page's content parts are one content: joined with a line break between them)
      for (let k = 0; k < parts.length; k++) {
        if (k) m.push(NL);
        const inflate = zlib.createInflate({ chunkSize: 1 << 18 });
        inflate.end(parts[k]);
        for await (const chunk of inflate) { m.push(chunk as Buffer); await drain(); }
      }
      m.end();
      deflate.end();
      await ended;
    } catch (e) { deflate.destroy(); throw e; }
    // (the same decision as mergeStrokes: few strokes, or little merged - not worth a new copy)
    if (m.strokesIn < bar || m.strokesOut * 4 > m.strokesIn) return null;
    const z = Buffer.concat(out);
    log?.(`merged a heavy page: ${m.strokesIn} strokes -> ${m.strokesOut}, ${Math.round(m.bytesIn / 1e6)} -> ${Math.round(m.bytesOut / 1e6)} MB, ${Date.now() - t0} ms`);
    return new Uint8Array(z.buffer, z.byteOffset, z.byteLength);
  };
}
const NL = new Uint8Array([10]);
