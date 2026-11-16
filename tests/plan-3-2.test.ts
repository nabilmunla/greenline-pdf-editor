// PLAN 3.2: heavy pages are looked at (and merged, in the batch engine) just before the drawing
// engines read them - not while the file opens. The page's pictures wait meanwhile.
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
const { tiles } = await import('../src/ui/tiles');
type Fn = (...a: unknown[]) => unknown;
const tick = () => new Promise((r) => setTimeout(r, 0));

test('3.2: opening a file with a heavy page merges nothing (the merger is not even asked)', () => {
  let asked = 0;
  mu.setContentMerger(() => { asked++; return null; });
  mu.setDisplayStore(() => ({ path: '/x', size: 1 }));
  mu.setHeavyRaw(1000);
  try {
    const d = new mupdf.PDFDocument();
    const big = Array.from({ length: 20_000 }, (_, i) => `${i % 900} ${(i * 7) % 700} m ${i % 900 + 1} ${(i * 7) % 700 + 1} l S`).join('\n');
    d.insertPage(-1, d.addPage([0, 0, 1000, 800], 0, {}, big));
    const bytes = d.saveToBuffer('compress').asUint8Array().slice();
    const r = mu.open('p32', bytes);
    assert.equal(asked, 0, 'nothing merged on opening');
    assert.equal(r.look, true, 'its pages are looked at later');
    mu.close('p32');
  } finally { mu.setContentMerger(null); mu.setDisplayStore(null); mu.setHeavyRaw(2e6); }
});

test('3.2: a heavy page\'s pictures wait until it is merged and the drawing engines have the new copy', async () => {
  const calls: string[] = [];
  const page = (k: number) => ({ w: 595, h: 842, rot: 0, label: String(k + 1) });
  let release: () => void = () => {};
  const merged = new Promise<void>((r) => { release = r; });
  const edit: Record<string, Fn> = {
    open: () => ({ pages: [page(0), page(1)], needsPassword: false, repaired: false, hasForms: false, size: 100, look: true }),
    getData: () => ({}), history: () => ({ undo: [], redo: [] }), close: () => true,
    heavyCandidates: (_id: unknown, pages: unknown) => { calls.push('look ' + (pages as number[]).join(',')); return { candidates: (pages as number[]).includes(0) ? [{ page: 0, key: '9', streams: [9] }] : [], shown: [] }; },
    sourceOf: () => ({ path: '/doc.pdf' }),
    attachDisplay: () => { calls.push('attach'); return true; },
    drawSnapshot: () => { calls.push('snapshot'); return { path: '/doc.pdf', size: 100, delta: '/w/d', mtime: 1, extra: [{ bytes: new Uint8Array([1]) }] }; },
  };
  const batch: Record<string, Fn> = { mergeForDisplay: async () => { calls.push('merge'); await merged; return { path: '/w/m.bin', size: 10 }; } };
  const stub = (c: unknown, impl: Record<string, Fn>) => { (c as { call: Fn }).call = async (m: unknown, a: unknown) => { const f = impl[m as string]; if (!f) throw new Error('not stubbed: ' + m); return f(...((a as unknown[]) || [])); }; };
  stub(editor, edit); stub(batcher, batch);
  renderers.forEach((r) => stub(r, { open: () => { calls.push('engine open'); return true; }, close: () => true, viewTile: (...a: unknown[]) => { calls.push('tile p' + (a[1] as number)); return { width: 64, height: 64, close() {} }; } }));
  const d = new PdfDoc('/doc.pdf');
  assert.equal(await d.load({ path: '/doc.pdf' }), 'ok');
  calls.length = 0;
  const req = (p: number) => ({ key: `${d.id}|r${d.crev[p]}|b|1.0000|0|0`, layer: 'b' as const, doc: d.id, page: p, scale: 1, x: 0, y: 0, w: 64, h: 64, prio: p });
  tiles.need('t32', [req(0), req(1)]);
  await tick(); await tick(); await tick();
  assert.ok(calls.includes('tile p1'), 'the light page is drawn at once');
  assert.ok(!calls.includes('tile p0'), 'the heavy page waits');
  assert.ok(tiles.gateBusy(d.id, 0), 'shown as being prepared');
  release();
  for (let i = 0; i < 10 && !calls.includes('tile p0'); i++) await tick();
  const at = (s: string) => calls.indexOf(s);
  assert.ok(at('merge') < at('attach') && at('attach') < at('snapshot') && at('snapshot') < at('tile p0'), 'merged, attached, new copy, then drawn: ' + calls.join(' / '));
  assert.ok(!tiles.gateBusy(d.id, 0));
  tiles.forget('t32');
  await d.close();
});
