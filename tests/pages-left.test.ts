// A view tile of a page the person has
// scrolled or paged away from (same zoom) was still drawn - only a zoom change made tiles stale
// (PLAN 3.9) - so the new page's tiles waited behind the old page's, tile after tile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as pf from '../src/engine/pdfium';
import { CallQueue, VIEW_TILE, type QCall } from '../src/engine/callq';
import { EngineClient } from '../src/engine/rpc';

let seq = 0;
const vt = (doc: string, page: number, scale = 1): QCall => ({ method: VIEW_TILE, args: [doc, page, scale, 0, 0, 512, 512], seq: seq++ });
const drain = (q: CallQueue<QCall>) => { const out: string[] = []; for (;;) { const n = q.next(); for (const s of n.stale) out.push('stale p' + s.args[1]); if (!n.call) return out; out.push(n.call.method + ' p' + n.call.args[1]); } };

test('a view tile of a page left (same zoom) is answered stale, not drawn; the pages in view are', () => {
  const q = new CallQueue<QCall>();
  for (const c of [vt('a', 0), vt('a', 0), vt('a', 1), vt('b', 0), { method: 'tile', args: ['a', 0, 1], seq: seq++ }, vt('a', 5)]) q.push(c);
  q.wantScales('a', [1], [5, 6]);
  // (thumbnails - plain 'tile' - and another document are untouched)
  assert.deepEqual(drain(q), ['stale p0', 'stale p0', 'stale p1', 'viewTile p0', 'tile p0', 'viewTile p5']);
  // (no pages given: any page at a wanted scale, as before)
  q.wantScales('a', [1]);
  q.push(vt('a', 0));
  assert.deepEqual(drain(q), ['viewTile p0']);
});

test('a page left whose small preview is still showing (Pages panel) keeps only the preview: its sharp tiles stop', () => {
  // (review: pages and scales were pooled, so a thumbnail of the page left kept its view tiles wanted)
  const q = new CallQueue<QCall>();
  for (const c of [vt('a', 0, 1), vt('a', 0, 0.2), vt('a', 5, 1)]) q.push(c);
  q.wantScales('a', [0.2, 1], [0, 5], [[0, 0.2], [5, 0.2], [5, 1]]);
  assert.deepEqual(drain(q), ['stale p0', 'viewTile p0', 'viewTile p5']);
});

test('the window tells the engines the pages in view along with the scales', () => {
  const c = new EngineClient('Drawing engine 9');
  const posted: unknown[] = [];
  c.attach({ postMessage(m: unknown) { posted.push(m); }, start() {}, close() {}, onmessage: null } as unknown as MessagePort, false);
  c.want('a', [1.5], [2, 3], [[2, 1.5], [3, 1.5]]);
  assert.deepEqual(posted[0], { want: { doc: 'a', scales: [1.5], pages: [2, 3], pairs: [[2, 1.5], [3, 1.5]] } });
});

test('a slow tile of the page left stops at once; the new page is not kept waiting behind it', async () => {
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  // (two pages of 60,000 long strokes: slow to draw at any size)
  let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const d = new mupdf.PDFDocument();
  for (let p = 0; p < 2; p++) { let c = '0.2 w\n'; for (let i = 0; i < 60000; i++) c += `${(rnd() * 600).toFixed(1)} ${(rnd() * 600).toFixed(1)} m ${(rnd() * 600).toFixed(1)} ${(rnd() * 600).toFixed(1)} l S\n`; d.insertPage(-1, d.addPage([0, 0, 600, 600], 0, {}, c)); }
  pf.openDoc('s', d.saveToBuffer('compress').asUint8Array().slice());
  pf.render('s', 0, 0.1, 0, 0, 8, 8); pf.render('s', 1, 0.1, 0, 0, 8, 8);
  pf.progressiveStats.sliceMs = 10;
  try {
    let t = performance.now();
    pf.render('s', 0, 4, 0, 0, 1024, 1024);
    const full = performance.now() - t;
    // the engine's loop: page 0's tile is running when the person pages down (same zoom)
    const q = new CallQueue<QCall>();
    const running = vt('s', 0, 4);
    q.wantScales('s', [4], [0]);
    let paged = false;
    t = performance.now();
    const old = pf.renderGivingWay('s', 0, 4, 0, 0, 1024, 1024, async () => {
      if (!paged && performance.now() - t > full * 0.25) { paged = true; q.wantScales('s', [4], [1]); }
      await new Promise((r) => setImmediate(r));
      return q.isStale(running);
    });
    await assert.rejects(old, (e: { stale?: boolean }) => e.stale === true);
    const stopped = performance.now() - t;
    assert.ok(stopped < full * 0.6, `the old page's tile stopped after ${stopped.toFixed(0)} ms (a full draw takes ${full.toFixed(0)} ms)`);
  } finally { pf.progressiveStats.sliceMs = 50; pf.closeDoc('s'); }
});
