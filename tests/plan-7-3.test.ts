// PLAN 7.3, reduced by PLAN 5.5: a merged or simplified page is pinned to drawing engine 1 when the
// PC has under 2 GB free; on by default (PDFED_OFF=pin switches it off); no probe - any other page
// goes where rendererFor sends it. Four stubbed drawing engines; free memory and the switch are set per test.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MB = 2 ** 20, GB = 2 ** 30;
let free = 2 * GB;
let offValue: unknown = { off: '', on: '' };
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.gcc = { renderers: 4, log: () => {}, freemem: async () => free, off: async () => offValue, settings: async () => ({}), info: async () => ({ user: 't' }), user: async () => 't', dropTemp: async () => true, stat: async () => ({ size: 100, mtime: 1, writable: true }), recoveryClear: async () => {}, recoveryPath: async () => '/rec/x.pdf', recoveryMeta: async () => {}, enginesStart: async () => true, cacheGet: async () => null, cachePut: async () => {}, docsClosed: () => {} };

const { renderers, editor, batcher, rendererFor, forgetFree, forgetOff, pinCount, pinHeavyPage, LOW_FREE } = await import('../src/ui/engines');
const { PdfDoc } = await import('../src/ui/doc');
const { tiles } = await import('../src/ui/tiles');
type Fn = (...a: unknown[]) => unknown;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };
const page = (k: number) => ({ w: 595, h: 842, rot: 0, label: String(k + 1) });
const stub = (c: unknown, impl: Record<string, Fn>) => { (c as { call: Fn }).call = async (m: unknown, a: unknown) => { const f = impl[m as string]; if (!f) throw new Error('not stubbed: ' + m); return f(...((a as unknown[]) || [])); }; };

/** calls to the drawing engines: "<engine number> <method> p<page>" */
const calls: string[] = [];
/** heap growth each page's read-in is reported with (the engine side still answers; nothing asks) */
let grew: Record<number, number> = {};
// page 0 is a heavy (merged) page; 1 and 2 are not
function setup() {
  calls.length = 0;
  const edit: Record<string, Fn> = {
    open: () => ({ pages: [page(0), page(1), page(2)], needsPassword: false, repaired: false, hasForms: false, size: 100, look: true }),
    getData: () => ({}), history: () => ({ undo: [], redo: [] }), close: () => true,
    heavyCandidates: (_id: unknown, pages: unknown) => ({ candidates: (pages as number[]).includes(0) ? [{ page: 0, key: '9', streams: [9], size: 5e6 }] : [], shown: [] }),
    sourceOf: () => ({ path: '/doc.pdf' }),
    attachDisplay: () => true,
    drawSnapshot: () => ({ path: '/doc.pdf', size: 100, delta: '/w/d', mtime: 1 }),
    simplifyPage: () => true,
  };
  stub(editor, edit);
  stub(batcher, { mergeForDisplay: async () => ({ path: '/w/m.bin', size: 10 }) });
  renderers.forEach((r, i) => stub(r, {
    open: () => true, close: () => true,
    viewTile: (...a: unknown[]) => { calls.push(`${i} tile p${a[1]}`); return { width: 64, height: 64, close() {} }; },
    chars: (...a: unknown[]) => { calls.push(`${i} chars p${a[1]}`); return { text: 'x' }; },
    pageGrew: (_id: unknown, p: unknown) => { calls.push(`${i} pageGrew p${p}`); return grew[p as number] ?? 0; },
  }));
}
async function open(id?: string) {
  const d = new PdfDoc('/doc.pdf');
  if (id) d.id = id;
  assert.equal(await d.load({ path: '/doc.pdf' }), 'ok');
  return d;
}
let rev = 0;
/** n tiles of a page asked for together (the page's first read-in decides), then everything settles */
async function draw(d: InstanceType<typeof PdfDoc>, p: number, n = 3) {
  await d.ensurePage(p);
  const reqs = Array.from({ length: n }, (_, k) => ({ key: `${d.id}|r${d.crev[p]}|b|1.0000|${k}|${p}|${rev++}`, layer: 'b' as const, doc: d.id, page: p, scale: 1, x: k * 64, y: 0, w: 64, h: 64, prio: k }));
  tiles.need('t73', reqs);
  for (let i = 0; i < 200; i++) { await tick(); const t = tiles.stats(); if (!t.queued && !t.inflight) break; }
  await settle(10);
  tiles.forget('t73');
}
const tileEngines = (p: number) => calls.filter((c) => c.endsWith(` tile p${p}`)).map((c) => c.split(' ')[0]);

/** the state of the PC: free memory and the switch (nothing set = the default) */
const pc = (gb: number, off: unknown = { off: '', on: 'pin' }) => { free = gb * GB; offValue = off; forgetOff(); forgetFree(); grew = {}; setup(); };

test('5.5 (a): pin on (PDFED_ON=pin), 1 GB free: a merged page is pinned to engine 1; an unmerged one spreads', async () => {
  pc(1);
  const d = await open();
  await draw(d, 0); await draw(d, 1); await draw(d, 1);
  assert.deepEqual(tileEngines(0), ['0', '0', '0'], calls.join(' / '));
  assert.equal(rendererFor(d.id, 0), renderers[0]);
  assert.equal(pinCount(d.id), 1);
  assert.equal(tileEngines(1).length, 6);
  assert.ok(tileEngines(1).every((e) => e !== '0'), 'unmerged page spreads from its first tile: ' + calls.join(' / '));
  assert.notEqual(rendererFor(d.id, 1), renderers[0]);
  await d.close();
});

test('5.5 (b): 3 GB free with pin on: a merged page spreads (2 GB itself is not "under")', async () => {
  pc(3);
  let d = await open();
  await draw(d, 0);
  assert.ok(tileEngines(0).length === 3 && tileEngines(0).every((e) => e !== '0'), calls.join(' / '));
  assert.notEqual(rendererFor(d.id, 0), renderers[0]);
  assert.equal(pinCount(d.id), 0);
  await d.close();
  pc(2);
  assert.equal(LOW_FREE, 2 * GB);
  d = await open();
  await draw(d, 0);
  assert.equal(pinCount(d.id), 0, 'exactly 2 GB: not pinned');
  await d.close();
  pc(1.99);
  d = await open();
  await draw(d, 0, 1);
  assert.equal(pinCount(d.id), 1, '1.99 GB: pinned');
  await d.close();
});

test('5.5 (c): 1 GB free: an unmerged page goes where rendererFor sends it - no judging, no pageGrew, however much it would grow', async () => {
  // with nothing set (pin off by default since run 2) and with pin switched on by name
  for (const sw of [{ off: '', on: '' }, { off: '', on: 'pin' }]) {
    pc(1, sw);
    grew = { 1: 900 * MB, 2: 900 * MB };
    const d = await open();
    await d.ensurePage(1);
    const where = String(renderers.indexOf(rendererFor(d.id, 1)));
    await draw(d, 1, 1);
    assert.deepEqual(tileEngines(1), [where], calls.join(' / '));
    assert.notEqual(where, '0', 'rendererFor sends it to a partner engine');
    await draw(d, 2); await draw(d, 1);
    assert.ok(!calls.some((c) => c.includes('pageGrew')), calls.join(' / '));
    assert.ok(tileEngines(2).every((e) => e !== '0'), calls.join(' / '));
    assert.equal(pinCount(d.id), 0);
    await d.close();
  }
});

test('5.5 (d): PDFED_OFF=pin: nothing is pinned at 1 GB, merged page or not', async () => {
  pc(1, { off: 'pin', on: '' });
  const d = await open();
  await draw(d, 0); await draw(d, 1);
  assert.ok(tileEngines(0).length === 3 && tileEngines(0).every((e) => e !== '0'), calls.join(' / '));
  assert.notEqual(rendererFor(d.id, 0), renderers[0]);
  assert.equal(pinCount(d.id), 0);
  assert.ok(!calls.some((c) => c.includes('pageGrew')));
  await d.close();
});

test('5.5 (e): a simplified page is pinned under 2 GB, not at 3 GB', async () => {
  pc(1);
  let d = await open();
  await d.simplify(2);
  assert.equal(pinCount(d.id), 1);
  assert.equal(rendererFor(d.id, 2), renderers[0]);
  await draw(d, 2);
  assert.deepEqual(tileEngines(2), ['0', '0', '0'], calls.join(' / '));
  await d.close();
  pc(3);
  d = await open();
  await d.simplify(2);
  assert.equal(pinCount(d.id), 0);
  assert.notEqual(rendererFor(d.id, 2), renderers[0]);
  await d.close();
});

test('7.3 (4): pins stay until the file is closed; closing clears them (a new file with the same id is not pinned)', async () => {
  pc(1);
  const d = await open();
  await settle();
  await draw(d, 0, 1);
  assert.equal(rendererFor(d.id, 0), renderers[0], 'pinned');
  free = 8 * GB; forgetFree();
  await draw(d, 0, 1);
  assert.equal(rendererFor(d.id, 0), renderers[0], 'still pinned with memory back');
  const id = d.id;
  await d.close();
  pc(8);
  const d2 = await open(id);
  assert.notEqual(rendererFor(d2.id, 0), renderers[0], 'not pinned any more');
  await draw(d2, 0);
  assert.ok(tileEngines(0).every((e) => e !== '0'), calls.join(' / '));
  await d2.close();
});

test('7.3: free memory is asked of the main process at most every 2 s (not once per page)', async () => {
  let asked = 0;
  const g2 = globalThis as unknown as { gcc: { freemem: () => Promise<number> } };
  const was = g2.gcc.freemem;
  g2.gcc.freemem = async () => { asked++; return 8 * 2 ** 30; };
  pc(8);
  try {
    for (let p = 100; p < 140; p++) await pinHeavyPage('many', p);
    assert.equal(asked, 1);
  } finally { g2.gcc.freemem = was; forgetFree(); }
});

test('Phase 5 run 2: nothing set, 1 GB free: a merged page spreads (pin ships switched off)', async () => {
  pc(1, { off: '', on: '' });
  const d = await open();
  await draw(d, 0);
  assert.ok(tileEngines(0).length === 3 && tileEngines(0).every((e) => e !== '0'), calls.join(' / '));
  assert.equal(pinCount(d.id), 0);
  await d.close();
});
