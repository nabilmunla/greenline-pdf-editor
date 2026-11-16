// PLAN 2.5: closing a document empties its caches and listeners (AUDIT A7, viewer-tiles.md section 5).
// The stub setup is the one of tests/doc-tiles.test.ts (no Electron, engines stood in for).
// npx tsx --test tests/plan-2-5.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------- a window without Electron
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.gcc = {
  renderers: 2,
  log: () => {},
  settings: async () => ({}),
  info: async () => ({ user: 'tester' }),
  user: async () => 'tester',
  dropTemp: async () => true,
  stat: async () => ({ size: 100, mtime: 1, writable: true }),
  commit: async () => ({ size: 120, mtime: 2, inPlace: false }),
  recoveryClear: async () => {},
  recoveryPath: async () => '/rec/x.pdf',
  recoveryMeta: async () => {},
  enginesStart: async () => true,
  cacheGet: async () => null,
  cachePut: async () => {},
  docsClosed: () => {},
};

const { renderers, editor, batcher } = await import('../src/ui/engines');
const { PdfDoc } = await import('../src/ui/doc');
const { dragged } = await import('../src/ui/pagedrag');

type Fn = (...a: unknown[]) => unknown;
let mu: Record<string, Fn> = {};
let draw: Record<string, Fn> = {};
const page = (k: number) => ({ w: 595, h: 842, rot: 0, label: String(k + 1) });
const baseMu = (): Record<string, Fn> => ({
  open: () => ({ pages: [page(0), page(1), page(2)], needsPassword: false, repaired: false, hasForms: false, size: 100 }),
  getData: () => ({}),
  history: () => ({ undo: [], redo: [] }),
  pageInfos: () => [page(0), page(1), page(2)],
  drawSnapshot: () => ({ path: '/doc.pdf', size: 100, delta: '/work/d/changes.bin' }),
  annots: () => [],
  allAnnots: () => [],
  textBlocks: () => [],
  close: () => true,
});
const baseDraw = (): Record<string, Fn> => ({
  open: () => true,
  close: () => true,
  tile: () => ({ width: 512, height: 512, close() {} }),
  memory: () => 1,
  chars: () => ({ text: 'a', box: new Float32Array(4) }),
  links: () => [{ rect: [0, 0, 10, 10] }],
});
const stub = (c: object, impl: () => Record<string, Fn>) => {
  (c as unknown as { call: Fn }).call = async (method: unknown, args: unknown) => {
    const f = impl()[method as string];
    if (!f) throw new Error('not stubbed: ' + method);
    return f(...((args as unknown[]) || []));
  };
};
stub(editor, () => mu);
stub(batcher, () => mu);
renderers.forEach((r) => stub(r, () => draw));

/** the private fields the test looks at (the caches, listener sets and byte sources of a PdfDoc) */
const priv = (d: InstanceType<typeof PdfDoc>) => d as unknown as Record<string, unknown>;
const sizeOf = (x: unknown) => (x instanceof Map || x instanceof Set ? x.size : x == null ? 0 : -1);

async function opened(src: { path: string } | Uint8Array = { path: '/doc.pdf' }) {
  mu = baseMu();
  draw = baseDraw();
  const d = new PdfDoc(src instanceof Uint8Array ? 'doc.pdf' : src.path);
  assert.equal(await d.load(src), 'ok');
  return d;
}

/** fills every cache and listener set the tab holds */
async function fill(d: InstanceType<typeof PdfDoc>) {
  await d.annots(0);
  await d.allAnnots();
  await d.chars(0);
  await d.links(0);
  await d.blocks(0);
  d.on(() => {});
  d.onView(() => {});
  d.visRects.set(0, { x: 0, y: 0, w: 10, h: 10 } as never);
}

const EMPTY_AFTER_CLOSE = ['annotCache', 'charCache', 'blockCache', 'linkCache', 'listeners', 'viewListeners'];

test('PLAN 2.5: close() empties every per-document cache, listener set and visRects', async () => {
  const d = await opened();
  await fill(d);
  for (const k of EMPTY_AFTER_CLOSE) assert.ok(sizeOf(priv(d)[k]) > 0, `${k} filled before the close`);
  assert.ok(d.visRects.size > 0, 'visRects filled before the close');
  assert.ok(priv(d).allCache, 'allCache filled before the close');

  await d.close();

  for (const k of EMPTY_AFTER_CLOSE) assert.equal(sizeOf(priv(d)[k]), 0, `${k} empty after close`);
  assert.equal(d.visRects.size, 0, 'visRects empty after close');
  assert.equal(priv(d).allCache, null, 'allCache dropped after close');
});

test('PLAN 2.5: close() drops the byte arrays the tab was opened from', async () => {
  const d = await opened(new Uint8Array([37, 80, 68, 70]));
  assert.ok(priv(d).src instanceof Uint8Array, 'bytes kept while open');
  await d.close();
  assert.equal(priv(d).src, null, 'src dropped after close');
  assert.equal(priv(d).drawSrc, null, 'drawSrc dropped after close');
});

test('PLAN 2.5: close() forgets the dragged-page temp files of this document only', async () => {
  const d = await opened();
  const other = await opened();
  dragged.set('/tmp/mine.pdf', { doc: d.id, pages: [0], name: 'mine' });
  dragged.set('/tmp/theirs.pdf', { doc: other.id, pages: [1], name: 'theirs' });
  await d.close();
  assert.ok(!dragged.has('/tmp/mine.pdf'), 'the closed document\'s entry is gone');
  assert.ok(dragged.has('/tmp/theirs.pdf'), 'an open document\'s entry is kept');
  await other.close();
  dragged.clear();
});
