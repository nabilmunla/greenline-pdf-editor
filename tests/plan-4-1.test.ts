// PLAN 4.1: the heavy-page look survives a save that reopens the file and a change of the page
// list; a page's look resolves on its own (text on a light page doesn't wait for another's merge).
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';

const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.gcc = { renderers: 2, log: () => {}, settings: async () => ({}), info: async () => ({ user: 't' }), user: async () => 't', dropTemp: async () => true, stat: async () => ({ size: 100, mtime: 1, writable: true }), recoveryClear: async () => {}, recoveryPath: async () => '/rec/x.pdf', recoveryMeta: async () => {}, enginesStart: async () => true, cacheGet: async () => null, cachePut: async () => {}, docsClosed: () => {} };

const mu = await import('../src/engine/mu');
const { renderers, editor, batcher } = await import('../src/ui/engines');
const { PdfDoc } = await import('../src/ui/doc');
type Fn = (...a: unknown[]) => unknown;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 15) => { for (let i = 0; i < n; i++) await tick(); };
const page = (k: number) => ({ w: 595, h: 842, rot: 0, label: String(k + 1) });
const stub = (c: unknown, impl: Record<string, Fn>) => { (c as { call: Fn }).call = async (m: unknown, a: unknown) => { const f = impl[m as string]; if (!f) throw new Error('not stubbed: ' + m); return f(...((a as unknown[]) || [])); }; };

/** a document of two pages; `heavy(p)` says what heavyCandidates answers for page p right now */
function harness(heavy: (p: number) => { key: string; size: number } | null) {
  const calls: string[] = [];
  let mergeGate: Promise<void> = Promise.resolve();
  let n = 0;
  const edit: Record<string, Fn> = {
    open: () => { calls.push('open'); return { pages: [page(0), page(1)], needsPassword: false, repaired: false, hasForms: false, size: 100, look: true }; },
    getData: () => ({}), history: () => ({ undo: [], redo: [] }), close: () => true, noteChange: () => true,
    heavyCandidates: (_id: unknown, pages: unknown) => {
      const ps = pages as number[];
      calls.push('look ' + ps.join(','));
      return { candidates: ps.flatMap((p) => { const h = heavy(p); return h ? [{ page: p, key: h.key, streams: [+h.key], size: h.size }] : []; }), shown: [] };
    },
    sourceOf: () => ({ path: '/doc.pdf' }),
    attachDisplay: (_id: unknown, p: unknown, key: unknown, _s: unknown, f: unknown) => { calls.push(`attach p${p} ${key} ${(f as { path: string }).path}`); return true; },
    drawSnapshot: () => { calls.push('snapshot'); return { path: '/doc.pdf', size: 100, delta: '/w/d', mtime: 1 }; },
    movePages: () => { calls.push('move'); return [page(0), page(1)]; },
  };
  const batch: Record<string, Fn> = { mergeForDisplay: async () => { const k = n++; calls.push('merge ' + k); await mergeGate; return { path: `/w/m${k}.bin`, size: 10 }; } };
  stub(editor, edit); stub(batcher, batch);
  renderers.forEach((r) => stub(r, { open: () => true, close: () => true, chars: () => ({ text: 'x' }) }));
  return { calls, hold() { let release!: () => void; mergeGate = new Promise((r) => { release = r; }); return () => release(); } };
}

test('4.1: a heavy page is merged again after a save that reopens the file (no merge of the old numbering attached)', async () => {
  let size = 5e6;
  const h = harness((p) => (p === 0 ? { key: '9', size } : null));
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  await d.ensurePage(0);
  await settle();
  assert.ok(h.calls.includes('attach p0 9 /w/m0.bin'), h.calls.join(' / '));
  h.calls.length = 0;
  // the full save opened the file again: same object number for another content, other size
  size = 7e6;
  await (d as unknown as { reopenFrom(s: unknown): Promise<void> }).reopenFrom({ path: '/doc.pdf' });
  await d.ensurePage(0);
  await settle();
  assert.ok(h.calls.includes('look 0'), 'looked at again: ' + h.calls.join(' / '));
  assert.ok(h.calls.includes('merge 1'), 'merged again from the new copy');
  assert.ok(!h.calls.some((c) => c.includes('/w/m0.bin')), 'the old merge is never attached');
  assert.ok(h.calls.indexOf('attach p0 9 /w/m1.bin') < h.calls.lastIndexOf('snapshot'), 'attached, then a new drawing copy');
  await d.close();
});

test('4.1: same object numbers, same size after a reopen: still merged again (the map is emptied)', async () => {
  const h = harness((p) => (p === 0 ? { key: '9', size: 5e6 } : null));
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  await d.ensurePage(0);
  await settle();
  await (d as unknown as { reopenFrom(s: unknown): Promise<void> }).reopenFrom({ path: '/doc.pdf' });
  h.calls.length = 0;
  await d.ensurePage(0);
  await settle();
  assert.deepEqual(h.calls.filter((c) => c.startsWith('merge') || c.startsWith('attach')), ['merge 1', 'attach p0 9 /w/m1.bin']);
  await d.close();
});

test('4.1: an unlooked heavy page moved to a looked page number is looked at before it is drawn', async () => {
  let order = [0, 1];
  // (page 1 of the file is the heavy one; after the move it is page 0)
  const h = harness((p) => (order[p] === 1 ? { key: '12', size: 5e6 } : null));
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  await d.ensurePage(0);
  await settle();
  assert.ok(!h.calls.some((c) => c.startsWith('merge')), 'page 1 (light) needs nothing');
  order = [1, 0];
  await d.content('movePages', { order: [1, 0] }, [1, 0]);
  h.calls.length = 0;
  await d.ensurePage(0);
  await settle();
  assert.ok(h.calls.includes('look 0'), 'page 0 looked at again: ' + h.calls.join(' / '));
  assert.ok(h.calls.includes('attach p0 12 /w/m0.bin'), 'and merged: ' + h.calls.join(' / '));
  await d.close();
});

test('4.1: text on a light page does not wait for another page\'s merge', async () => {
  const h = harness((p) => (p === 0 ? { key: '9', size: 5e6 } : null));
  const release = h.hold();
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  const heavy = d.ensurePage(0);
  let heavyDone = false;
  void heavy.then(() => { heavyDone = true; });
  await settle();
  assert.ok(h.calls.includes('merge 0'), 'page 0 is merging');
  // page 1 asked while page 0 merges: answered at once
  const t = await Promise.race([d.chars(1).then(() => 'chars'), new Promise((r) => setTimeout(() => r('timeout'), 300))]);
  assert.equal(t, 'chars');
  assert.equal(heavyDone, false, 'page 0 still waits');
  release();
  await heavy;
  await settle();
  assert.ok(h.calls.includes('attach p0 9 /w/m0.bin'));
  await d.close();
});

test('4.1: closing the file releases whoever waits for a page', async () => {
  const h = harness((p) => (p === 0 ? { key: '9', size: 5e6 } : null));
  h.hold();
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  const w = d.ensurePage(0);
  await settle();
  await d.close();
  const t = await Promise.race([w.then(() => 'released'), new Promise((r) => setTimeout(() => r('hung'), 300))]);
  assert.equal(t, 'released');
});

test('4.1 (engine): a page already drawn from a merged content is not "shown" again (no extra drawing copy)', () => {
  mu.setContentMerger(() => null);
  mu.setDisplayStore(() => ({ path: '/x', size: 1 }));
  mu.setHeavyRaw(1000);
  try {
    const d = new mupdf.PDFDocument();
    const big = Array.from({ length: 20_000 }, (_, i) => `${i % 900} ${(i * 7) % 700} m ${i % 900 + 1} ${(i * 7) % 700 + 1} l S`).join('\n');
    const content = d.addStream(big, {});
    for (let k = 0; k < 2; k++) { const pg = d.addPage([0, 0, 1000, 800], 0, {}, ''); pg.put('Contents', content); d.insertPage(-1, pg); }
    mu.open('p41', d.saveToBuffer('compress').asUint8Array().slice());
    const c = mu.heavyCandidates('p41', [0]).candidates[0];
    assert.ok(c && c.size > 1000);
    assert.equal(mu.attachDisplay('p41', 0, c.key, c.streams, { path: '/x', size: 1 }), true);
    assert.deepEqual(mu.heavyCandidates('p41', [0, 1]), { candidates: [], shown: [1] }, 'page 2 joins: a new copy');
    assert.deepEqual(mu.heavyCandidates('p41', [0, 1]), { candidates: [], shown: [] }, 'asked again (pages moved): nothing to do');
    mu.close('p41');
  } finally { mu.setContentMerger(null); mu.setDisplayStore(null); mu.setHeavyRaw(2e6); }
});

test('4.1: a page whose merge was overtaken by a page move is looked at again, not marked done', async () => {
  let order = [0, 1];
  const h = harness((p) => (order[p] === 0 ? { key: '9', size: 5e6 } : null));
  const release = h.hold();
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  const w = d.ensurePage(0);
  await settle();
  assert.ok(h.calls.includes('merge 0'));
  // the pages swap while page 0 (the heavy one) merges: page 0 is now the light one
  order = [1, 0];
  await d.content('movePages', { order: [1, 0] }, [1, 0]);
  h.calls.length = 0;
  release();
  await w;
  await settle();
  assert.ok(h.calls.includes('look 0'), 'page 0 looked at again: ' + h.calls.join(' / '));
  // and the heavy one, now page 1, is looked at when it's needed (the merge made is reused)
  h.calls.length = 0;
  await d.ensurePage(1);
  await settle();
  assert.ok(h.calls.includes('look 1') && !h.calls.some((c) => c.startsWith('merge')), h.calls.join(' / '));
  await d.close();
});

test('4.1: a page asked for again and again while it merges is looked at once (no loop)', async () => {
  const h = harness((p) => (p === 0 ? { key: '9', size: 5e6 } : null));
  const release = h.hold();
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  const ws = [d.ensurePage(0)];
  await settle();
  for (let i = 0; i < 20; i++) { ws.push(d.ensurePage(0)); await tick(); }
  release();
  await Promise.all(ws);
  await settle();
  assert.equal(h.calls.filter((c) => c === 'look 0').length, 1);
  assert.equal(h.calls.filter((c) => c === 'snapshot').length, 1, 'one new drawing copy');
  await d.close();
});

test('Phase 5: a light page held at the gate is let go when its look ends (the first screen of a file was blank until a scroll)', async () => {
  harness(() => null);
  const { tiles } = await import('../src/ui/tiles');
  const t = tiles as unknown as { gateChanged(): void; gates: Map<string, { ready(p: number): boolean }> };
  const orig = t.gateChanged;
  let told = 0;
  t.gateChanged = function (this: unknown) { told++; return orig.call(this); };
  try {
    const d = new PdfDoc('/doc.pdf');
    await d.load({ path: '/doc.pdf' });
    const gate = t.gates.get(d.id)!;
    // (what the tile queue asks before starting a tile of page 0: not looked at yet - held)
    assert.equal(gate.ready(0), false);
    await settle();
    assert.equal(gate.ready(0), true, 'looked at: no heavy page');
    assert.ok(told > 0, 'the tile queue was told the page is ready (nothing else would start its tiles)');
    await d.close();
  } finally { t.gateChanged = orig; }
});

test('Phase 6 sweep: a page whose content changes while its merge runs is looked at again (not drawn unmerged)', async () => {
  let key = '9';
  const h = harness((p) => (p === 0 ? { key, size: 5e6 } : null));
  // (the editing engine as it is: a merge of content that is no longer the page's is refused; and an in-place edit)
  const inner = (editor as unknown as { call: Fn }).call;
  (editor as unknown as { call: Fn }).call = async (m: unknown, a: unknown) => {
    if (m === 'touch') { h.calls.push('touch'); return true; }
    if (m === 'pageInfos') return [page(0), page(1)];
    if (m === 'attachDisplay') { const k = (a as unknown[])[2]; if (k !== key) { h.calls.push('attach refused ' + k); return false; } }
    return inner(m, a);
  };
  const release = h.hold();
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  const w = d.ensurePage(0);
  await settle();
  assert.ok(h.calls.includes('merge 0'), h.calls.join(' / '));
  // page 1's content edited in place while its merge runs: new content, new key
  key = '10';
  await d.content('touch', { pages: [0] });
  release();
  await w;
  await settle(30);
  assert.ok(h.calls.includes('attach refused 9'), 'the old merge refused: ' + h.calls.join(' / '));
  assert.equal(h.calls.filter((c) => c === 'look 0').length, 2, 'looked at again: ' + h.calls.join(' / '));
  assert.ok(h.calls.includes('attach p0 10 /w/m1.bin'), 'the new content merged and attached: ' + h.calls.join(' / '));
  await d.close();
});

test('Phase 6 sweep: the tile gate asked again and again while a page merges adds no waiters', async () => {
  const h = harness((p) => (p === 0 ? { key: '9', size: 5e6 } : null));
  const release = h.hold();
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  const { tiles } = await import('../src/ui/tiles');
  const gate = (tiles as unknown as { gates: Map<string, { ready(p: number): boolean }> }).gates.get(d.id)!;
  for (let i = 0; i < 200; i++) { assert.equal(gate.ready(0), false); if (i % 20 === 0) await tick(); }
  await settle();
  const waiters = (d as unknown as { lookWaiters: Map<number, unknown[]> }).lookWaiters.get(0)?.length ?? 0;
  assert.ok(waiters <= 1, `${waiters} waiters for page 1`);
  assert.equal(h.calls.filter((c) => c === 'look 0').length, 1, 'looked at once');
  release();
  await settle(30);
  assert.equal(gate.ready(0), true, 'merged: let through');
  await d.close();
});
