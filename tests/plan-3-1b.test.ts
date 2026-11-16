// PLAN 3.1/3.3: the display update reaches the drawing engines - the window passes the drawing
// copy's extra parts on (they were dropped by toArg, so heavy pages were drawn unmerged).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.gcc = { renderers: 2, log: () => {}, settings: async () => ({}), info: async () => ({ user: 't' }), user: async () => 't', dropTemp: async () => true, stat: async () => ({ size: 100, mtime: 1, writable: true }), recoveryClear: async () => {}, recoveryPath: async () => '/rec/x.pdf', recoveryMeta: async () => {}, enginesStart: async () => true, cacheGet: async () => null, cachePut: async () => {}, docsClosed: () => {} };

const { renderers, editor, batcher } = await import('../src/ui/engines');
const { PdfDoc } = await import('../src/ui/doc');
type Fn = (...a: unknown[]) => unknown;
const opens: unknown[] = [];
const page = { w: 595, h: 842, rot: 0, label: '1' };
const extra = [{ bytes: new Uint8Array([10]) }, { path: '/work/m/merged.bin', size: 1234 }, { bytes: new Uint8Array([1, 2, 3]) }];
const mu: Record<string, Fn> = {
  open: () => ({ pages: [page], needsPassword: false, repaired: false, hasForms: false, size: 100, heavy: 1 }),
  drawSnapshot: () => ({ path: '/doc.pdf', size: 100, delta: '/work/d/changes.bin', mtime: 1, extra }),
  getData: () => ({}), history: () => ({ undo: [], redo: [] }), close: () => true,
};
const stub = (c: unknown, impl: Record<string, Fn>) => { (c as { call: Fn }).call = async (m: unknown, a: unknown) => { const f = impl[m as string]; if (!f) throw new Error('not stubbed: ' + m); return f(...((a as unknown[]) || [])); }; };
stub(editor, mu); stub(batcher, mu);
renderers.forEach((r) => stub(r, { open: (_id: unknown, src: unknown) => { opens.push(src); return true; }, close: () => true }));

test('3.1: the drawing engines get the display update with the copy', async () => {
  const d = new PdfDoc('/doc.pdf');
  assert.equal(await d.load({ path: '/doc.pdf' }), 'ok');
  assert.ok(opens.length >= 1);
  const f = (opens[opens.length - 1] as { $file: { extra?: unknown[] } }).$file;
  assert.deepEqual(f.extra, extra, 'extra parts passed on');
  await d.close();
});
