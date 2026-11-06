// The open document, tile store and engine start-up, with the engines and the main process
// stood in for (no Electron): the fixes after the 0.7.0 audit (tests/tmp-ds/result-V.md).
// npx tsx --test tests/doc-tiles.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------- a window without Electron
const g = globalThis as Record<string, unknown>;
const logs: string[] = [];
const dropped: string[] = [];
let stat: { size: number; mtime: number; writable: boolean } | null = { size: 100, mtime: 1, writable: true };
let commitInPlace = false;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.gcc = {
  renderers: 2,
  log: (s: string) => { logs.push(s); },
  settings: async () => ({}),
  info: async () => ({ user: 'tester' }),
  dropTemp: async (p: string[]) => { dropped.push(...p); return true; },
  stat: async () => stat,
  commit: async () => ({ size: 120, mtime: 2, inPlace: commitInPlace }),
  recoveryClear: async () => {},
  recoveryPath: async () => '/rec/x.pdf',
  recoveryMeta: async () => {},
  enginesStart: async () => true,
  cacheGet: async () => null,
  cachePut: async () => {},
  docsClosed: () => {},
};

const { renderers, editor, batcher, startEngines } = await import('../src/ui/engines');
const { PdfDoc } = await import('../src/ui/doc');
const { tiles } = await import('../src/ui/tiles');
const { EngineClient, engineDown } = await import('../src/engine/rpc');

type Fn = (...a: unknown[]) => unknown;
const calls: string[] = [];
/** what the editing engine answers (per test) */
let mu: Record<string, Fn> = {};
/** what the drawing engines answer */
let draw: Record<string, Fn> = {};
const page = (k: number) => ({ w: 595, h: 842, rot: 0, label: String(k + 1) });
const baseMu = (): Record<string, Fn> => ({
  open: () => ({ pages: [page(0), page(1), page(2)], needsPassword: false, repaired: false, hasForms: false, size: 100 }),
  getData: () => ({}),
  history: () => ({ undo: ['Rotate'], redo: [] }),
  noteChange: () => true,
  drawSnapshot: () => ({ path: '/doc.pdf', size: 100, delta: '/work/d' + calls.length + '/changes.bin' }),
  pageInfos: () => [page(0), page(1), page(2)],
  rotatePages: () => [page(0), { ...page(1), w: 842, h: 595, rot: 90 }, page(2)],
  addTextLayer: () => 5,
  createAnnot: () => ({ id: 7, page: 0 }),
  annotTile: () => fakeBmp(),
  close: () => true,
});
const fakeBmp = () => ({ width: 512, height: 512, close() {} });
const stub = (c: InstanceType<typeof EngineClient>, name: string, impl: () => Record<string, Fn>) => {
  (c as unknown as { call: Fn }).call = async (method: unknown, args: unknown) => {
    calls.push(name + ':' + method);
    const f = impl()[method as string];
    if (!f) throw new Error('not stubbed: ' + method);
    return f(...((args as unknown[]) || []));
  };
};
stub(editor, 'edit', () => mu);
stub(batcher, 'batch', () => mu);
renderers.forEach((r, i) => stub(r, 'draw' + i, () => draw));
const baseDraw = (): Record<string, Fn> => ({ open: () => true, close: () => true, tile: () => fakeBmp(), memory: () => 1 });

async function opened() {
  mu = baseMu();
  draw = baseDraw();
  const d = new PdfDoc('/doc.pdf');
  assert.equal(await d.load({ path: '/doc.pdf' }), 'ok');
  calls.length = 0;
  return d;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- content changes

test('BUG-183 / BUG-152: invisible OCR text - no page list read, markups kept, pictures under way kept', async () => {
  const d = await opened();
  const ann = d.annRev.slice(), crev = d.crev.slice(), base = d.baseRev;
  let bumps = 0;
  const bump = tiles.bump.bind(tiles);
  tiles.bump = (id: string) => { bumps++; bump(id); };
  try {
    await d.addTextLayer(1, [{ text: 'word', box: [0, 0, 10, 10] }]);
    assert.ok(!calls.includes('edit:pageInfos'), 'the page list is not read again');
    assert.deepEqual(d.annRev, ann, 'markup pictures kept');
    assert.deepEqual(d.crev, crev, 'page pictures kept');
    assert.equal(d.baseRev, base + 1, 'text read again');
    assert.ok(d.dirty);
    await d.drawReady();
    assert.ok(calls.includes('edit:drawSnapshot') && calls.includes('draw0:open'), 'the engines got the text');
    assert.equal(bumps, 0, 'nothing under way was thrown away');
  } finally { tiles.bump = bump; await d.close(); }
});

test('BUG-139: a redraw that fails after a page change leaves the document changed, then draws it again', async () => {
  const d = await opened();
  const crev = d.crev.slice();
  let fail = 1;
  draw.open = () => { if (fail-- > 0) throw engineDown(new Error('Drawing engine 1 restarted')); return true; };
  await d.rotate([1], 90); // an engine going down: not an error of the rotation (it is in)
  assert.ok(d.dirty, 'changed - closing asks, a recovery copy is written');
  assert.equal(d.pages[1].rot, 90);
  assert.notEqual(d.crev[1], crev[1], 'page 2 gets new pictures');
  await d.drawReady();
  await tick();
  assert.ok(d.crev.every((r, i) => r !== crev[i]), 'drawn again: every page afresh');
  // any other failure is still said - with the document changed all the same
  draw.open = () => { throw new Error('disk full'); };
  d.dirty = false;
  await assert.rejects(d.rotate([0], 90), /disk full/);
  assert.ok(d.dirty);
  draw.open = () => true;
  await d.drawReady();
  await d.close();
});

test('BUG-154: a tab closed while its drawing copy is made does not open again in the engines', async () => {
  const d = await opened();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  mu.drawSnapshot = async () => { await gate; return { path: '/doc.pdf', size: 100, delta: '/work/late/changes.bin' }; };
  await d.addTextLayer(0, []);
  const job = d.drawReady();
  await tick();
  await d.close();
  const opensBefore = calls.filter((c) => c.endsWith(':open')).length;
  release();
  await job;
  assert.equal(calls.filter((c) => c.endsWith(':open')).length, opensBefore, 'not opened in the drawing engines after closing');
  assert.ok(dropped.includes('/work/late/changes.bin'), 'its copy is deleted');
  assert.ok(!dropped.includes('/doc.pdf'), 'never the file itself');
});

test('BUG-116: "nothing more to undo" turns Undo off', async () => {
  const d = await opened();
  assert.ok(d.canUndo);
  mu.undo = () => ({ ok: false, kind: 'a', name: '', pages: null });
  mu.history = () => ({ undo: [], redo: [] });
  let emitted = 0;
  d.on(() => emitted++);
  await d.undo();
  assert.equal(d.canUndo, false);
  assert.ok(emitted > 0);
  await d.close();
});

// ---------------------------------------------------------------- tiles

test('BUG-153 / BUG-83: closing a document drops its queued tiles and refuses late ones', async () => {
  const d = await opened();
  const waiting: (() => void)[] = [];
  draw.tile = () => new Promise((r) => waiting.push(() => r(fakeBmp())));
  const reqs = Array.from({ length: 12 }, (_, k) => ({ key: `${d.id}|r-1|b|1.0000|${k}|0`, layer: 'b' as const, doc: d.id, page: 0, scale: 1, x: k * 512, y: 0, w: 512, h: 512, prio: k }));
  tiles.need('t1', reqs);
  assert.ok(tiles.stats().queued > 0 && tiles.stats().inflight > 0);
  await d.close();
  tiles.forget('t1');
  assert.equal(tiles.stats().queued, 0, 'nothing more drawn for it');
  for (const w of waiting) w();
  await tick(); await tick();
  assert.ok(reqs.every((r) => !tiles.has(r.key)), 'pictures that come late are not kept');
});

test('BUG-73: a page\'s old markup pictures go when it gets new ones (other pages keep theirs)', async () => {
  const d = await opened();
  const key = (p: number) => `${d.id}|a${d.annRev[p]}|${p}|a|1.0000|0|0|`;
  const k0 = key(0), k1 = key(1);
  tiles.need('t2', [0, 1].map((p) => ({ key: key(p), layer: 'a' as const, doc: d.id, page: p, scale: 1, x: 0, y: 0, w: 512, h: 512, prio: p })));
  await tick(); await tick();
  assert.ok(tiles.has(k0) && tiles.has(k1));
  await d.create(0, { type: 'Square', rect: [0, 0, 10, 10] } as never);
  assert.ok(!tiles.has(k0), 'page 1: old markup picture dropped');
  assert.ok(tiles.has(k1), 'page 2 (also revision 0) kept');
  tiles.forget('t2');
  await d.close();
});

// ---------------------------------------------------------------- saving

test('BUG-221: Ctrl+S on a file renamed / moved away asks where to save', async () => {
  const d = await opened();
  stat = null;
  try {
    assert.equal(await d.save(), false);
    assert.ok(!calls.includes('edit:save'), 'nothing written at the old name');
  } finally { stat = { size: 100, mtime: 1, writable: true }; }
  await d.close();
});

test('BUG-255: a save cut short by the editing engine going down says so (not "Document is not open")', async () => {
  const d = await opened();
  mu.save = () => { throw engineDown(new Error('Editing engine restarted')); };
  await assert.rejects(d.save(), /Saving was cut short/);
  assert.equal(calls.filter((c) => c === 'edit:save').length, 1, 'not tried again on the engine still starting');
  await d.close();
});

test('BUG-14: an in-place save that drops changes made while it ran says so', async () => {
  const d = await opened();
  commitInPlace = true;
  try {
    mu.save = async () => { await d.create(0, { type: 'Square', rect: [0, 0, 10, 10] } as never); return { $file: { path: '/x.part' } }; };
    await assert.rejects(d.save(), /were not kept/);
    // a save with nothing changed meanwhile: fine
    mu.save = () => ({ $file: { path: '/x.part' } });
    assert.equal(await d.save(), true);
  } finally { commitInPlace = false; }
  await d.close();
});

test('Remove password: changes made while it saves are said lost, as for the in-place save (review 0.8.1)', async () => {
  const d = await opened();
  mu.save = async () => { await d.create(0, { type: 'Square', rect: [0, 0, 10, 10] } as never); return { $file: { path: '/x.part' } }; };
  await assert.rejects(d.save('/doc.pdf', { decrypt: true }), /were not kept/);
  assert.equal(d.password, undefined, 'the password is off all the same');
  await d.close();
});

test('the editing engine reopening a file from its recovery copy counts as a change (the count tool counts again)', async () => {
  const d = await opened();
  const seen = d.changeCount;
  d.lastRecovery = { file: '/rec/x.pdf', base: null };
  await d.reopenAfterCrash();
  assert.notEqual(d.changeCount, seen);
  await d.close();
});

test('BUG-254: work brought back after the editing engine restarted stays unsaved even if drawing it fails', async () => {
  const d = await opened();
  d.lastRecovery = { file: '/rec/x.pdf', base: null };
  d.dirty = false;
  draw.open = () => { throw new Error('Cannot enlarge memory'); };
  let emitted = 0;
  d.on(() => emitted++);
  await d.reopenAfterCrash();
  assert.ok(d.dirty, 'unsaved');
  assert.ok(emitted > 0, 'the tab is told');
  draw.open = () => true;
  await d.close();
});

test('BUG-82: the text-line cache keeps the last 40 pages', async () => {
  const d = await opened();
  mu.textBlocks = () => [];
  for (let p = 0; p < 60; p++) await d.blocks(p);
  const n = calls.filter((c) => c === 'edit:textBlocks').length;
  await d.blocks(59);
  await d.blocks(0);
  assert.equal(calls.filter((c) => c === 'edit:textBlocks').length, n + 1, 'page 60 kept, page 1 read again');
  await d.close();
});

// ---------------------------------------------------------------- engines

test('BUG-67: the call that broke an engine is blamed, not the one queued behind it', () => {
  const c = new EngineClient('Drawing engine 9');
  const port = { postMessage() {}, start() {}, close() {}, onmessage: null as null | ((e: { data: unknown }) => void) };
  c.attach(port as unknown as MessagePort, false);
  const errs: { culprit?: boolean }[] = [];
  void c.call('tile').catch((e) => errs.push(e));
  void c.call('tile').catch((e) => errs.push(e));
  port.onmessage!({ data: { id: 1, ok: false, error: 'Aborted(OOM)', fatal: true } });
  // the engine exits; the restarted one is attached and the call still waiting fails
  c.attach({ ...port } as unknown as MessagePort, true, 70);
  return tick().then(() => {
    assert.equal(errs.length, 2);
    assert.equal(errs[0].culprit, true, 'the call that aborted');
    assert.ok(!errs[1].culprit, 'only waited behind it');
    // an engine killed without a word (no fatal answer): the oldest call waiting is blamed, as before
    const errs2: { culprit?: boolean }[] = [];
    void c.call('tile').catch((e) => errs2.push(e));
    c.attach({ ...port } as unknown as MessagePort, true, 1);
    return tick().then(() => assert.equal(errs2[0]?.culprit, true));
  });
});

test('BUG-13: a failed start is not kept; an engine that fails to load once is asked again', async () => {
  let fails = 99;
  const memory = () => { if (fails-- > 0) throw new Error('EBUSY: the engine file is held'); return 1; };
  draw = { ...baseDraw(), memory };
  mu = { ...baseMu(), memory: () => 1 };
  // never loads: given up after a few tries (~7 s), said plainly
  await assert.rejects(startEngines(), /PDF engines could not start/);
  // started again (from Explorer, a new try): not the old failure - and one failure is retried
  fails = 1;
  logs.length = 0;
  await startEngines(); // waits ~2.5 s for the engine to come back
  assert.ok(logs.some((l) => /failed to start \(try 1\)/.test(l)));
});
