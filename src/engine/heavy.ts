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
 * A part of a page's content as the merger is given it: its bytes as they are in the file, and
 * whether they are Flate-compressed (PLAN 10.10: what the app and MuPDF write during a session -
 * a page's content after a redaction or a text edit - has no filter: its bytes are the content
 * itself). A bare Uint8Array is a Flate-compressed part (as every part was before).
 */
export type ContentPart = Uint8Array | { bytes: Uint8Array; flate: boolean };
const partOf = (p: ContentPart) => (p instanceof Uint8Array ? { bytes: p, flate: true } : p);
const rawSize = (parts: ContentPart[]) => parts.reduce((t, p) => t + partOf(p).bytes.length, 0);

/**
 * About how many strokes a page's content holds, from the first SAMPLE bytes of its biggest part
 * (the line work; small parts are our wrappers or a few settings): strokes per byte in the sample
 * x all the parts' bytes. A 27 MB sheet of 17 million strokes was missed by the old bar of 30 MB
 * compressed; ordinary dense sheets (a few hundred thousand strokes) cost one sample's inflate (a
 * few ms), not a whole page's (seconds). An unfiltered part's sample is counted as it is.
 */
export function estimateStrokes(parts: ContentPart[]): number {
  if (!parts.length) return 0;
  const ps = parts.map(partOf);
  let big = ps[0], total = 0;
  for (const p of ps) { total += p.bytes.length; if (p.bytes.length > big.bytes.length) big = p; }
  const head = big.bytes.subarray(0, Math.min(big.bytes.length, SAMPLE));
  let dec: Buffer;
  if (!big.flate) dec = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  // (a stream cut off in the middle: what can be decoded so far)
  // (decoded at most EST_MAX: 1 MB of very repetitive data decodes to ~1 GB - the batch engine took
  // it whole before deciding anything. Past it: too many to count here - the streamed merge decides)
  else try { dec = zlib.inflateSync(head, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: EST_MAX }); } catch { return Infinity; }
  return (countStrokes(dec) * total) / Math.max(1, head.length);
}

/**
 * The merger the engines are given (mu.setContentMerger): the page's content parts
 * (Flate-compressed, or with no filter - fed straight to the scan) -> merged content, compressed -
 * or null when the page isn't one of those.
 * force: asked for on a page that took the drawing engine down (any page of many strokes).
 * PLAN 7.1: streamed - each part is inflated in pieces, merged as it comes (strokestream.ts) and
 * the output deflated in pieces alongside; only the compressed result is kept whole (the whole
 * decoded content, the merged copy and its deflate were held at once: 1.3-2.0 GB).
 */
export function makeMerger(log?: (line: string) => void, min = MIN_STROKES, sure = SURE_RAW) {
  return async (parts: ContentPart[], force?: boolean): Promise<Uint8Array | null> => {
    const t0 = Date.now();
    if (!force && rawSize(parts) < sure && estimateStrokes(parts) < min * 0.8) return null;
    const bar = force ? 50_000 : min;
    // (level 1: on the 5 M-stroke sheet the deflate was 3/4 of the merge's time at level 6 (5.4 s
    // -> 2.6 s at level 1); the merged copy is 1.24 times as big, and its first draw 3 % slower)
    const deflate = zlib.createDeflate({ level: 1, chunkSize: 1 << 20 });
    const out: Buffer[] = [];
    deflate.on('data', (c: Buffer) => out.push(c));
    const ended = new Promise<void>((res, rej) => { deflate.on('end', () => res()); deflate.on('error', rej); });
    // (a failed deflate is raised where the merger waits for it - the wait below - so this promise
    // is only read at the end: it must not count as unhandled meanwhile)
    ended.catch(() => { /* read below */ });
    let full = false;
    // the three times logged: inflate (waiting for the inflated input), scan (the merge itself),
    // deflate (the writes into it, the waits for its drain, and the wait for its end)
    let tInflate = 0, tBody = 0, tWrite = 0, tDrain = 0, tEnd = 0;
    const m = new StrokeMergeStream((piece) => {
      const a = performance.now();
      if (!deflate.write(piece)) full = true;
      tWrite += performance.now() - a;
    });
    const drain = async () => {
      if (!full) return;
      full = false;
      const a = performance.now();
      await new Promise<void>((res, rej) => {
        const ok = () => { deflate.off('error', bad); res(); };
        const bad = (e: Error) => { deflate.off('drain', ok); rej(e); };
        deflate.once('drain', ok);
        deflate.once('error', bad);
      });
      tDrain += performance.now() - a;
    };
    try {
      // (a page's content parts are one content: joined with a line break between them)
      for (let k = 0; k < parts.length; k++) {
        if (k) m.push(NL);
        const { bytes, flate } = partOf(parts[k]);
        if (!flate) {
          // (no filter: the bytes are the content - to the scan in pieces, as an inflate gives them)
          for (let at = 0; at < bytes.length; at += PIECE) {
            const got = performance.now();
            m.push(bytes.subarray(at, Math.min(bytes.length, at + PIECE)));
            await drain();
            tBody += performance.now() - got;
          }
          continue;
        }
        const inflate = zlib.createInflate({ chunkSize: 1 << 18 });
        inflate.end(bytes);
        let mark = performance.now();
        for await (const chunk of inflate) {
          const got = performance.now();
          tInflate += got - mark;
          m.push(chunk as Buffer);
          await drain();
          mark = performance.now();
          tBody += mark - got;
        }
      }
      m.end();
      deflate.end();
      const e0 = performance.now();
      await ended;
      tEnd = performance.now() - e0;
    } catch (e) { deflate.destroy(); throw e; }
    // (the same decision as mergeStrokes: few strokes, or little merged - not worth a new copy)
    if (m.strokesIn < bar || m.strokesOut * 4 > m.strokesIn) return null;
    const z = Buffer.concat(out);
    log?.(`merged a heavy page: ${m.strokesIn} strokes -> ${m.strokesOut}, ${Math.round(m.bytesIn / 1e6)} -> ${Math.round(m.bytesOut / 1e6)} MB, ${Date.now() - t0} ms (inflate ${Math.round(tInflate)}, scan ${Math.round(tBody - tWrite - tDrain)}, deflate ${Math.round(tWrite + tDrain + tEnd)} ms)`);
    return new Uint8Array(z.buffer, z.byteOffset, z.byteLength);
  };
}
const NL = new Uint8Array([10]);
/** an unfiltered part goes to the scan in pieces this big (an inflate's are 256 KB) */
const PIECE = 1 << 18;
