// PLAN 5.4 (Q6): a save the editing engine writes in full looks at the unseen pages first - one
// heavyCandidates call ahead of the save in the engine's queue. Light pages are drawn while the
// save runs; heavy ones wait for it as before (never drawn unmerged, no merge beside a save).
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
let offValue: unknown = { off: '', on: '' };
g.gcc = {
  renderers: 2, log: () => {}, off: async () => offValue, settings: async () => ({}), info: async () => ({ user: 't' }), user: async () => 't',
  dropTemp: async () => true, stat: async () => ({ size: 100, mtime: 1, writable: true }), commit: async () => ({ size: 100, mtime: 2, inPlace: false }),
  recoveryClear: async () => {}, recoveryPath: async () => '/rec/x.pdf', recoveryMeta: async () => {}, enginesStart: async () => true,
  cacheGet: async () => null, cachePut: async () => {}, docsClosed: () => {},
};

const { renderers, editor, batcher } = await import('../src/ui/engines');
const { PdfDoc } = await import('../src/ui/doc');
const { tiles } = await import('../src/ui/tiles');
type Fn = (...a: unknown[]) => unknown;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };
const page = (k: number) => ({ w: 595, h: 842, rot: 0, label: String(k + 1) });
const gate = (d: { id: string }) => (tiles as unknown as { gates: Map<string, { ready(p: number): boolean }> }).gates.get(d.id)!;
const held = () => { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); return { p, release }; };

/**
 * The editing engine runs one call at a time, in the order sent (as the real one does): a look
 * sent after the save waits for it. `heavy(p)`: what heavyCandidates finds for page p.
 */
function harness(n: number, heavy: (p: number) => boolean, size = 100) {
  const calls: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const holds = { save: null as null | Promise<void>, look: null as null | Promise<void> };
  const edit: Record<string, Fn> = {
    open: () => ({ pages: Array.from({ length: n }, (_, k) => page(k)), needsPassword: false, repaired: false, hasForms: false, size, look: true }),
    getData: () => ({}), history: () => ({ undo: [], redo: [] }), close: () => true, noteChange: () => true,
    heavyCandidates: async (_id: unknown, pages: unknown) => {
      const ps = pages as number[];
      calls.push('look ' + (ps.length > 3 ? ps.length + ' pages' : ps.join(',')));
      if (holds.look) await holds.look;
      return { candidates: ps.filter(heavy).map((p) => ({ page: p, key: '9', streams: [9], size: 5e6 })), shown: [] };
    },
    save: async () => { calls.push('save'); if (holds.save) await holds.save; calls.push('saved'); return { $file: { path: '/out/.part' } }; },
    sourceOf: () => ({ path: '/doc.pdf' }),
    attachDisplay: (_id: unknown, p: unknown) => { calls.push('attach p' + p); return true; },
    drawSnapshot: () => { calls.push('snapshot'); return { path: '/doc.pdf', size: 100, delta: '/w/d', mtime: 1 }; },
  };
  (editor as unknown as { call: Fn }).call = (m: unknown, a: unknown) => {
    const f = edit[m as string];
    if (!f) return Promise.reject(new Error('not stubbed: ' + m));
    const r = chain.then(() => f(...((a as unknown[]) || [])));
    chain = r.catch(() => {});
    return r;
  };
  (batcher as unknown as { call: Fn }).call = async (m: unknown) => { calls.push(String(m)); return { path: '/w/m.bin', size: 10 }; };
  renderers.forEach((r) => { (r as unknown as { call: Fn }).call = async () => true; });
  return { calls, holds };
}

test('5.4 (a): during a full save an unseen light page is looked at and let through; its tile is not held', async () => {
  const h = harness(300, () => false);
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  const s = held(); h.holds.save = s.p;
  const saving = d.save('/elsewhere.pdf');
  await settle();
  assert.ok(h.calls.includes('save') && !h.calls.includes('saved'), 'the save is running: ' + h.calls.join(' / '));
  assert.equal(gate(d).ready(250), true, 'page 251 looked at before the save ended');
  const r = await Promise.race([d.ensurePage(250).then(() => 'looked'), new Promise((res) => setTimeout(() => res('waiting'), 50))]);
  assert.equal(r, 'looked');
  assert.ok(h.calls.indexOf('look 300 pages') < h.calls.indexOf('save'), 'one look of every page, ahead of the save: ' + h.calls.join(' / '));
  s.release();
  assert.equal(await saving, true);
  await d.close();
});

test('5.4 (b): a heavy page found by the pre-save look waits for the save, is not merged beside it, then goes the ordinary way', async () => {
  const h = harness(5, (p) => p === 0);
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  const s = held(); h.holds.save = s.p;
  const saving = d.save('/elsewhere.pdf');
  await settle();
  assert.equal(gate(d).ready(1), true, 'light page let through');
  assert.equal(gate(d).ready(0), false, 'the heavy page is not looked at yet');
  assert.equal(d.preparing.size, 0, 'no "Preparing…" beside the save');
  assert.ok(!h.calls.includes('mergeForDisplay'), 'no merge beside the save: ' + h.calls.join(' / '));
  s.release();
  await saving;
  await d.ensurePage(0);
  await settle();
  assert.ok(h.calls.indexOf('mergeForDisplay') > h.calls.indexOf('saved'), 'merged after the save: ' + h.calls.join(' / '));
  assert.ok(h.calls.includes('attach p0') && h.calls.lastIndexOf('snapshot') > h.calls.indexOf('attach p0'), 'then drawn merged');
  await d.close();
});

test('5.4 (c): pages changed between the pre-save look and its answer are looked at again', async () => {
  const h = harness(10, () => false);
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  const l = held(); h.holds.look = l.p;
  const saving = d.save('/elsewhere.pdf');
  await settle();
  // (the page list changed meanwhile: what is at those numbers may be another page now)
  d.lookAgain();
  l.release();
  await saving;
  await settle();
  assert.equal(gate(d).ready(5), false, 'the answer was for the old page list: not taken');
  h.calls.length = 0;
  await d.ensurePage(5);
  assert.ok(h.calls.includes('look 5'), 'looked at again: ' + h.calls.join(' / '));
  await d.close();
});

test('5.4 (d): an incremental save of an ordinary file, and PDFED_OFF=prelook: no extra call', async () => {
  let h = harness(10, () => false);
  let d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  await d.save();
  assert.deepEqual(h.calls.filter((c) => c.startsWith('look')), [], 'incremental: ' + h.calls.join(' / '));
  await d.close();

  offValue = { off: 'prelook', on: '' };
  h = harness(10, () => false);
  d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  await settle();
  await d.save('/elsewhere.pdf');
  assert.deepEqual(h.calls.filter((c) => c.startsWith('look')), [], 'switched off: ' + h.calls.join(' / '));
  await d.close();
  offValue = { off: '', on: '' };
});

test('5.4 (e): a file the editing engine always writes in full (over 350 MB) looks first on an ordinary save too', async () => {
  const h = harness(10, () => false, 400e6);
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  await d.save();
  assert.ok(h.calls.indexOf('look 10 pages') >= 0 && h.calls.indexOf('look 10 pages') < h.calls.indexOf('save'), h.calls.join(' / '));
  await d.close();
});
