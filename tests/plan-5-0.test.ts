// PLAN 5.0: PDFED_OFF=giveway,pin - the switches for the 7.5 and 7.3 rules, and the counters the
// window bench reads (pageStats.progressive, pinCount).
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';

const MB = 2 ** 20, GB = 2 ** 30;
// (where the drawing engine's host looks for pdfium.wasm)
process.argv[2] = 'node_modules/@embedpdf/pdfium/dist';
const { renderHandlers } = await import('../src/engine/host');
const { offList } = await import('../src/engine/off');

/** a page of 60,000 long strokes across it (slow to draw at any size) */
function linePdf(): Uint8Array {
  let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let c = '0.2 w\n';
  for (let i = 0; i < 60000; i++) c += `${(rnd() * 600).toFixed(1)} ${(rnd() * 600).toFixed(1)} m ${(rnd() * 600).toFixed(1)} ${(rnd() * 600).toFixed(1)} l S\n`;
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 600, 600], 0, {}, c));
  return d.saveToBuffer('compress').asUint8Array().slice();
}
type Handlers = Awaited<ReturnType<typeof renderHandlers>>;
type Stats = { progressive: { slices: number; gaveWay: number } };
const slicesOf = (h: Handlers) => (h.pageStats() as unknown as Stats).progressive.slices;
const tile = (h: Handlers) => (h.viewTile('a', 0, 2, 256, 256, 512, 512) as Promise<{ px: Uint8ClampedArray }>);

test('5.0: the PDFED_OFF list: commas, spaces, case; nothing off by default (5.5: pin is on), PDFED_ON still removes a switch', () => {
  assert.deepEqual([...offList('giveway, PIN ,,')].sort(), ['giveway', 'pin']);
  assert.deepEqual([...offList(undefined)], ['pin'], 'Phase 5 run 2: 7.3 ships switched off (PLAN rule after run 2)');
  assert.equal(offList(undefined, 'Pin ').size, 0);
  assert.deepEqual([...offList('pin')], ['pin'], 'PDFED_OFF=pin switches it off');
  assert.deepEqual([...offList('giveway', 'pin')], ['giveway']);
});

test('5.0: PDFED_OFF=giveway: a line-work tile takes 0 slices and gives the same pixels', async () => {
  const was = process.env.PDFED_OFF;
  const pf = await import('../src/engine/pdfium');
  try {
    delete process.env.PDFED_OFF;
    const h = await renderHandlers();
    pf.progressiveStats.sliceMs = 2; // (so a tile of this size is certainly cut)
    await h.open('a', linePdf());
    h.tile('a', 0, 0.1, 0, 0, 8, 8); // (read in)
    const before = slicesOf(h);
    const plain = (await tile(h)).px;
    assert.ok(slicesOf(h) - before >= 2, 'on: the tile was drawn in slices: ' + (slicesOf(h) - before));

    process.env.PDFED_OFF = 'giveway';
    const h2 = await renderHandlers(); // (read once, at start)
    pf.progressiveStats.sliceMs = 2;
    const before2 = slicesOf(h2);
    const off = (await tile(h2)).px;
    assert.equal(slicesOf(h2) - before2, 0, 'off: one call, no slices');
    assert.ok(Buffer.from(off).equals(Buffer.from(plain)), 'same pixels');
    assert.equal((h2.pageStats() as unknown as Stats).progressive.gaveWay, (h.pageStats() as unknown as Stats).progressive.gaveWay);

    // (a start without the switch draws in slices again)
    delete process.env.PDFED_OFF;
    const h3 = await renderHandlers();
    pf.progressiveStats.sliceMs = 2;
    const before3 = slicesOf(h3);
    await tile(h3);
    assert.ok(slicesOf(h3) - before3 >= 2);
    h3.close('a');
  } finally {
    if (was === undefined) delete process.env.PDFED_OFF; else process.env.PDFED_OFF = was;
    pf.progressiveStats.sliceMs = 50; pf.progressiveStats.on = true;
  }
});

// ---- PDFED_OFF=pin (the window: four stubbed drawing engines, as in plan-7-3)
let free = 2 * GB;
let offValue: unknown = { off: '', on: 'pin' };
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.gcc = { renderers: 4, log: () => {}, freemem: async () => free, off: async () => offValue, settings: async () => ({}), info: async () => ({ user: 't' }), user: async () => 't', dropTemp: async () => true, stat: async () => ({ size: 100, mtime: 1, writable: true }), recoveryClear: async () => {}, recoveryPath: async () => '/rec/x.pdf', recoveryMeta: async () => {}, enginesStart: async () => true, cacheGet: async () => null, cachePut: async () => {}, docsClosed: () => {} };

const { renderers, editor, batcher, rendererFor, forgetFree, forgetOff, pinCount } = await import('../src/ui/engines');
const { PdfDoc } = await import('../src/ui/doc');
const { tiles } = await import('../src/ui/tiles');
type Fn = (...a: unknown[]) => unknown;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };
const page = (k: number) => ({ w: 595, h: 842, rot: 0, label: String(k + 1) });
const stub = (c: unknown, impl: Record<string, Fn>) => { (c as { call: Fn }).call = async (m: unknown, a: unknown) => { const f = impl[m as string]; if (!f) throw new Error('not stubbed: ' + m); return f(...((a as unknown[]) || [])); }; };
const calls: string[] = [];
function setup() {
  calls.length = 0;
  stub(editor, {
    open: () => ({ pages: [page(0), page(1)], needsPassword: false, repaired: false, hasForms: false, size: 100, look: true }),
    getData: () => ({}), history: () => ({ undo: [], redo: [] }), close: () => true,
    heavyCandidates: (_id: unknown, pages: unknown) => ({ candidates: (pages as number[]).includes(0) ? [{ page: 0, key: '9', streams: [9], size: 5e6 }] : [], shown: [] }),
    sourceOf: () => ({ path: '/doc.pdf' }),
    attachDisplay: () => true,
    drawSnapshot: () => ({ path: '/doc.pdf', size: 100, delta: '/w/d', mtime: 1 }),
  });
  stub(batcher, { mergeForDisplay: async () => ({ path: '/w/m.bin', size: 10 }) });
  renderers.forEach((r, i) => stub(r, {
    open: () => true, close: () => true,
    viewTile: (...a: unknown[]) => { calls.push(`${i} tile p${a[1]}`); return { width: 64, height: 64, close() {} }; },
    chars: () => ({ text: 'x' }),
    pageGrew: (_id: unknown, p: unknown) => { calls.push(`${i} pageGrew p${p}`); return p === 0 ? 900 * MB : 0; },
  }));
}
async function open() {
  const d = new PdfDoc('/doc.pdf');
  assert.equal(await d.load({ path: '/doc.pdf' }), 'ok');
  return d;
}
let rev = 0;
async function draw(d: InstanceType<typeof PdfDoc>, p: number, n = 3) {
  await d.ensurePage(p);
  const reqs = Array.from({ length: n }, (_, k) => ({ key: `${d.id}|r${d.crev[p]}|b|1.0000|${k}|${p}|${rev++}`, layer: 'b' as const, doc: d.id, page: p, scale: 1, x: k * 64, y: 0, w: 64, h: 64, prio: k }));
  tiles.need('t50', reqs);
  for (let i = 0; i < 200; i++) { await tick(); const t = tiles.stats(); if (!t.queued && !t.inflight) break; }
  await settle(10);
  tiles.forget('t50');
}
const tileEngines = (p: number) => calls.filter((c) => c.endsWith(` tile p${p}`)).map((c) => c.split(' ')[0]);

test('5.0: with pin off a merged page spreads under 2 GB free; with it on (control, and the default since 5.5) the page is pinned and counted', async () => {
  free = 1 * GB;
  // control: the rule fires (PDFED_ON=pin)
  offValue = { off: '', on: 'pin' }; forgetOff(); forgetFree(); setup();
  let d = await open();
  await draw(d, 0);
  assert.deepEqual(tileEngines(0), ['0', '0', '0'], calls.join(' / '));
  assert.equal(pinCount(d.id), 1);
  await d.close();
  assert.equal(pinCount(d.id), 0, 'closed: no pins');

  // off: the same page and memory
  offValue = { off: 'giveway,pin', on: '' }; forgetOff(); forgetFree(); setup();
  d = await open();
  await draw(d, 0);
  assert.equal(tileEngines(0).length, 3);
  assert.ok(tileEngines(0).every((e) => e !== '0'), 'spreads: ' + calls.join(' / '));
  assert.notEqual(rendererFor(d.id, 0), renderers[0]);
  assert.equal(pinCount(d.id), 0);
  assert.ok(!calls.some((c) => c.includes('pageGrew')), 'the rule does not even look: ' + calls.join(' / '));
  await d.close();

  // the default (pin off since run 2): nothing set - the merged page spreads, and nothing asks pageGrew
  offValue = { off: '', on: '' }; forgetOff(); forgetFree(); setup();
  d = await open();
  await draw(d, 0);
  assert.ok(tileEngines(0).length === 3 && tileEngines(0).every((e) => e !== '0'), 'spreads by default: ' + calls.join(' / '));
  assert.equal(pinCount(d.id), 0);
  assert.ok(!calls.some((c) => c.includes('pageGrew')));
  await d.close();
  offValue = { off: '', on: 'pin' }; forgetOff();
});
