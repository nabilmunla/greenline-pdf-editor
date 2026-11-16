// PLAN 7.1: the stroke merge fed in pieces gives the same bytes as mergeStrokes (the oracle) -
// any piece size from 1 byte up, the same counts and the same merge-or-not decision - and the
// streaming merger (inflate -> merge -> deflate in pieces) holds far less memory at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { mergeStrokes } from '../src/engine/strokes';
import { StrokeMergeStream } from '../src/engine/strokestream';
import { makeMerger } from '../src/engine/heavy';

const enc = (s: string) => new TextEncoder().encode(s);
let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

/** the content through the stream in pieces of `size()` bytes */
function streamed(src: Uint8Array, size: () => number) {
  const parts: Uint8Array[] = [];
  const m = new StrokeMergeStream((p) => parts.push(p.slice()));
  for (let at = 0; at < src.length;) { const k = Math.max(1, Math.min(src.length - at, size())); m.push(src.subarray(at, at + k)); at += k; }
  m.end();
  return { out: Buffer.concat(parts), strokesIn: m.strokesIn, strokesOut: m.strokesOut };
}
function same(src: Uint8Array, min: number, label: string) {
  const want = mergeStrokes(src, min);
  const wantOut = want ? Buffer.from(want.out) : null;
  for (const [name, size] of [['1 byte', () => 1], ['2-7 bytes', () => 2 + Math.floor(rnd() * 6)], ['random up to 4 KB', () => 1 + Math.floor(rnd() * 4096)], ['64 KB', () => 65536], ['whole', () => src.length]] as const) {
    const got = streamed(src, size);
    const merged = !(got.strokesIn < min || got.strokesOut * 4 > got.strokesIn);
    assert.equal(merged, !!want, `${label}, ${name}: same decision`);
    if (want) {
      assert.equal(got.strokesIn, want.strokesIn, `${label}, ${name}: strokes in`);
      assert.equal(got.strokesOut, want.strokesOut, `${label}, ${name}: strokes out`);
      assert.ok(got.out.equals(wantOut!), `${label}, ${name}: same bytes (${got.out.length} vs ${wantOut!.length})`);
    }
  }
}

test('7.1: the unit cases of the stroke merge, at any piece size', () => {
  // (engine.test.ts's cases: strokes, a fill, a clip, text with ( ) and \\, an inline picture whose data looks like operators)
  let c = 'q 0.5 w 0 0 1 RG\n';
  for (let i = 0; i < 6000; i++) { const x = 20 + (i % 400) * 4.5, y = 20 + Math.floor(i / 400) * 6; c += `${x.toFixed(1)} ${y.toFixed(1)} m ${(x + 1).toFixed(1)} ${(y + 1).toFixed(1)} l S\n`; if (i === 3000) c += '1 0 0 RG\n'; }
  c += 'Q q 0 1 0 rg 10 10 50 50 re f Q q 100 100 50 50 re W n 0 g 90 90 80 80 re f Q\n';
  c += 'BT /F1 12 Tf 50 960 Td (a \\(tricky\\) S m l string) Tj ET\n';
  c += 'q 10 0 0 10 500 960 cm BI /W 2 /H 2 /CS /G /BPC 8 ID A S m EI Q\n';
  same(enc(c), 5000, 'mixed');
  let c2 = 'q 0 0 1 RG 1 w\n';
  for (let i = 0; i < 4000; i++) {
    const x = 20 + (i % 200) * 9, y = 20 + Math.floor(i / 200) * 40;
    c2 += `${x} ${y} m ${x + 4} ${y + 4} l S\n`;
    if (i === 500) c2 += `${x} ${y + 10} 30 20 re W S\n`;
    if (i === 900) c2 += `${x} ${y + 12} m ${x + 6} ${y + 18} l 1 0 0 RG S 0 0 1 RG\n`;
    if (i === 1300) c2 += `${x} ${y + 12} m ${x + 6} ${y + 18} l 4 w S 1 w\n`;
    if (i === 1700) c2 += `${x} ${y + 12} m ${x + 6} ${y + 18} l S ${x + 12} ${y + 12} l S\n`;
  }
  same(enc(c2 + 'Q\n'), 1000, 'interrupted paths');
  const stray = Array.from({ length: 40 }, (_, i) => `${i} 0 m ${i + 1} 1 l S`);
  stray.splice(20, 0, ')');
  same(enc(stray.join('\n') + '\n'), 10, 'stray )');
  same(enc('0 0 m 1 1 l S 2 2 m 3 3 l S'), 4_000_000, 'a normal page (left alone)');
});

test('7.1: a generated stream with every construct, cut anywhere', () => {
  const ops = [
    () => `${(rnd() * 999).toFixed(2)} ${(rnd() * 999).toFixed(2)} m ${(rnd() * 999).toFixed(2)} ${(rnd() * 999).toFixed(2)} l S`,
    () => `${(rnd() * 999).toFixed(1)} ${(rnd() * 999).toFixed(1)} 5 5 re S`,
    () => `0 0 m 1 1 l 2 2 3 3 4 4 c h S`,
    () => `${(rnd()).toFixed(3)} w`,
    () => `% a comment with ( and < and S m l\n`,
    () => `(string \\) with ( nesting ) and S)Tj`,
    () => `<48656C6C6F> Tj <</MCID 3>> BDC EMC`,
    () => `/GS1 gs [1 2] 0 d`,
    () => `q 1 0 0 1 5 5 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x00EIx S EI Q`,
    () => `10 10 m 20 20 l f`,
    () => `30 30 m 40 40 l S 50 50 l S`,
  ];
  const lines: string[] = [];
  for (let i = 0; i < 30000; i++) lines.push(rnd() < 0.85 ? ops[0]() : ops[Math.floor(rnd() * ops.length)]());
  const src = enc(lines.join(rnd() < 0.5 ? '\n' : '\r\n'));
  same(src, 1000, 'generated');
  // (cut right before / inside "EI", "<<", an escape, a comment's end, a name's end, a number's end)
  for (const cut of ['EI', '<<', '\\)', '%', '/GS1', '999', 'BI', 're', 'S\n']) {
    const at = Buffer.from(src).indexOf(cut, 5000);
    for (const d of [-1, 0, 1, 2]) {
      const k = at + d;
      const parts: Uint8Array[] = [];
      const m = new StrokeMergeStream((p) => parts.push(p.slice()));
      m.push(src.subarray(0, k)); m.push(src.subarray(k)); m.end();
      assert.ok(Buffer.concat(parts).equals(Buffer.from(mergeStrokes(src, 1000)!.out)), `cut at "${cut}" ${d}`);
    }
  }
});

test('7.1: the streaming merger gives the same content as the whole-content one (decoded, SHA-256) and the same decisions', async () => {
  const lines: string[] = [];
  for (let i = 0; i < 300_000; i++) { const x = (rnd() * 1180).toFixed(3), y = (rnd() * 830).toFixed(3); lines.push(`${x} ${y} m ${(+x + 0.8).toFixed(3)} ${(+y + 0.6).toFixed(3)} l S`); }
  const a = zlib.deflateSync(Buffer.from('q 1 0 0 RG 2 w 100 100 m 600 500 l')), b = zlib.deflateSync(Buffer.from('S 0 0 1 RG 0.1 w\n' + lines.join('\n') + '\nQ'));
  const parts = [new Uint8Array(a), new Uint8Array(b)];
  const decoded = Buffer.concat([zlib.inflateSync(a), Buffer.from('\n'), zlib.inflateSync(b)]);
  const want = mergeStrokes(decoded, 100_000)!;
  const got = await makeMerger(undefined, 100_000)(parts);
  assert.ok(got);
  const sha = (x: Uint8Array) => createHash('sha256').update(x).digest('hex');
  assert.equal(sha(zlib.inflateSync(got!)), sha(want.out));
  // (the same "not worth it": a page of few strokes, and a page whose strokes can't be merged)
  assert.equal(await makeMerger(undefined, 100_000, Infinity)([new Uint8Array(zlib.deflateSync(Buffer.from('0 0 m 1 1 l S')))], true), null);
});

test('Phase 6 sweep: a big inline picture fed in pieces is searched once for its end (not again at every piece), same bytes', () => {
  // 12 MB of picture data (no "EI" in it), between runs of strokes, fed 16 KB at a time
  const pic = new Uint8Array(12 * 2 ** 20);
  for (let k = 0; k < pic.length; k++) pic[k] = 0x30 + (k * 31 + (k >> 9)) % 20; // digits and a few letters, never 'E'
  let head = '0.3 w\n', tail = '';
  for (let k = 0; k < 3000; k++) { head += `${k % 500} ${k % 300} m ${(k % 500) + 1} ${k % 300} l S\n`; tail += `${k % 400} ${k % 200} m ${(k % 400) + 2} ${k % 200} l S\n`; }
  const src = new Uint8Array(Buffer.concat([Buffer.from(head + 'q BI /W 2048 /H 3072 /CS /G /BPC 8 ID '), Buffer.from(pic), Buffer.from(' EI Q\n' + tail)]));
  const t0 = performance.now();
  const got = streamed(src, () => 16384);
  const ms = performance.now() - t0;
  const want = mergeStrokes(src, 1);
  assert.ok(want, 'the oracle merges it');
  assert.ok(got.out.equals(Buffer.from(want!.out)), 'same bytes as mergeStrokes');
  // (searched again from the picture's start at each of the ~770 pieces: ~5 billion byte checks - 24 MB took 30.7 s, now 85 ms)
  assert.ok(ms < 1500, `fed in ${Math.round(ms)} ms`);
});

test('Phase 6 sweep: the stroke estimate decodes a sample to 64 MB at most (1 MB of repetitive data was ~1 GB)', async () => {
  const { estimateStrokes, EST_MAX } = await import('../src/engine/heavy');
  const bomb = zlib.deflateSync(Buffer.alloc(600 * 2 ** 20, 0x20)); // 600 MB of spaces -> ~0.6 MB
  const inflate = zlib.inflateSync;
  let biggest = 0;
  (zlib as unknown as { inflateSync: typeof zlib.inflateSync }).inflateSync = ((b: zlib.InputType, o?: zlib.ZlibOptions) => { const r = inflate(b, o); biggest = Math.max(biggest, r.length); return r; }) as typeof zlib.inflateSync;
  try {
    const n = estimateStrokes([new Uint8Array(bomb)]);
    assert.ok(n === Infinity || n >= 0, 'an answer');
    assert.ok(biggest <= EST_MAX, `decoded ${Math.round(biggest / 2 ** 20)} MB`);
  } finally { (zlib as unknown as { inflateSync: typeof zlib.inflateSync }).inflateSync = inflate; }
});
