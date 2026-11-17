// 0.12 deep ritual, step 2: the sweep's findings that were real (docs/SWEEP-0.12.md), one test each.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStrokes } from '../src/engine/strokes';
import { StrokeMergeStream } from '../src/engine/strokestream';
import { sheetIndex, unlessStopped, type PageToks } from '../src/ui/sheets';
import { readFileSync } from 'node:fs';
import * as pf from '../src/engine/pdfium';

const enc = (s: string) => new TextEncoder().encode(s);
function streamed(src: Uint8Array, size: number) {
  const parts: Uint8Array[] = [];
  const m = new StrokeMergeStream((p) => parts.push(p.slice()));
  for (let at = 0; at < src.length; at += size) m.push(src.subarray(at, Math.min(src.length, at + size)));
  m.end();
  return Buffer.concat(parts);
}

test('S1: a token with no end in the window is not read from its start again with every piece', () => {
  // (a string never closed, then 48 MB: it was read again from its "(" with every 256 KB piece -
  // about 4.6 GB of reading; now each byte once)
  const head = enc('0 0 m 10 10 l S 1 1 m 2 2 l S (never closed ');
  const big = new Uint8Array(head.length + 48 * 2 ** 20);
  big.set(head);
  big.fill(0x61, head.length);
  for (let k = head.length + 1000; k < big.length; k += 4099) big[k] = 0x28; // nested "(" too
  const t0 = performance.now();
  const out = streamed(big, 256 * 1024);
  const ms = performance.now() - t0;
  assert.ok(out.equals(streamed(big, big.length)), 'the same bytes as the whole content at once');
  assert.ok(ms < 2500, `48 MB in 256 KB pieces: ${Math.round(ms)} ms`);
  // a comment, a hex string, a name and a word that long: the same
  for (const [open, fill] of [['%', 0x61], ['<', 0x41], ['/', 0x61], ['', 0x61]] as const) {
    const h = enc('0 0 m 1 1 l S ' + open);
    const b = new Uint8Array(h.length + 24 * 2 ** 20);
    b.set(h); b.fill(fill, h.length);
    const t = performance.now();
    const o = streamed(b, 256 * 1024);
    const ms2 = performance.now() - t;
    assert.ok(o.equals(streamed(b, b.length)), `"${open || 'word'}": the same bytes`);
    assert.ok(ms2 < 1500, `"${open || 'word'}" 24 MB: ${Math.round(ms2)} ms`);
  }
});

test('S1: tokens cut by the window anywhere: the same bytes as the whole content at once', () => {
  const lines: string[] = [];
  for (let k = 0; k < 400; k++) {
    lines.push(`${k} 0 m ${k} 10 l S`);
    if (k % 7 === 0) lines.push(`BT (a (nested\\) one\\\\ ${'x'.repeat(k * 13)} (deep (er)) end) Tj ET`);
    if (k % 11 === 0) lines.push(`% a comment ${'c'.repeat(k * 9)}`);
    if (k % 13 === 0) lines.push(`<${'0A'.repeat(k * 5)}> pop /Name${'n'.repeat(k * 3)} word${'w'.repeat(k * 4)}`);
  }
  const src = enc(lines.join('\n'));
  const whole = streamed(src, src.length);
  const want = mergeStrokes(src, 1);
  if (want) assert.ok(whole.equals(Buffer.from(want.out)), 'as strokes.ts merges it');
  for (const size of [1, 3, 17, 251, 4093, 65536]) assert.ok(streamed(src, size).equals(whole), `pieces of ${size} bytes`);
});

test('S4: the sheet number spot of 2,000 pages with 150 candidates each is found in seconds, not minutes', () => {
  // (every candidate of every page was tried for every cell: 9.4 s here; each page's candidates are
  // now placed in their cells once)
  const W = 3370, H = 2384;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pages: PageToks[] = [];
  for (let p = 0; p < 2000; p++) {
    const toks = [];
    for (let t = 0; t < 150; t++) { const x = W - rnd() * 500, y = H - rnd() * H; toks.push({ raw: `A-${p}-${t}`, key: `A-${p}-${t}`, box: [x, y, x + 40, y + 8] as [number, number, number, number], band: true, before: '' }); }
    // the number: always in the same corner cell
    toks.push({ raw: `A-${1000 + p}`, key: `A-${1000 + p}`, box: [W - 60, 20, W - 20, 32] as [number, number, number, number], band: true, before: '' });
    pages.push({ page: p, w: W, h: H, text: true, toks, lines: [] } as unknown as PageToks);
  }
  const t0 = performance.now();
  const r = sheetIndex(pages);
  const ms = performance.now() - t0;
  assert.equal(r.sheets.length, 2000);
  assert.equal(r.byKey.get('A-1500'), 500);
  assert.ok(ms < 3000, `${Math.round(ms)} ms`);
});

test('S5: Link the sheets reads a page the drawing engine does not hold, and lets it go', async () => {
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  pf.openDoc('s5', new Uint8Array(readFileSync('tests/data/long-spec.pdf')));
  const kept = pf.chars('s5', 3);
  const n0 = pf.pageStats.loads;
  for (let k = 0; k < 2; k++) assert.equal(pf.chars('s5', 7, false).text, pf.chars('s5', 7, false).text);
  assert.equal(pf.pageStats.loads - n0, 4, 'loaded for each read, not kept');
  assert.ok(pf.chars('s5', 7, false).text.length > 0);
  // a page it holds: read from there, nothing loaded
  const n1 = pf.pageStats.loads;
  assert.equal(pf.chars('s5', 3, false), kept);
  assert.equal(pf.pageStats.loads, n1);
  pf.closeDoc('s5');
});

test('S10: Cancel in Link the sheets does not wait for a heavy page merge to end', async () => {
  let stop = false;
  setTimeout(() => { stop = true; }, 300);
  const t0 = performance.now();
  await unlessStopped(new Promise<void>(() => {}), () => stop); // (a merge that takes "minutes")
  assert.ok(performance.now() - t0 < 1000, `stopped after ${Math.round(performance.now() - t0)} ms`);
  // done first: no timer left behind (the test runner would wait for it)
  await unlessStopped(Promise.resolve(), () => false);
});

test('a set with scans of the same size among it: the scans (no text) do not hide its numbers', () => {
  // (e2e-combine-big: 40 A3 sheets and 36 A3 scans in one file - 53 % had a number, under the 60 %
  // a spot needs, and the set lost all its sheets)
  const W = 1191, H = 842, pages: PageToks[] = [];
  for (let p = 0; p < 76; p++) {
    const sheet = p < 40;
    const toks = sheet ? [{ raw: `A-${101 + p}`, key: `A-${101 + p}`, box: [W - 80, 30, W - 30, 42] as [number, number, number, number], band: true, before: '' }] : [];
    pages.push({ page: p, w: W, h: H, text: sheet, toks, lines: [] } as unknown as PageToks);
  }
  const r = sheetIndex(pages);
  assert.equal(r.sheets.length, 40);
  assert.equal(r.noText, 36);
});
