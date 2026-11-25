// PLAN 13.2.2 (F47): the timer that writes the automatic recovery copy marked "nothing new to copy"
// before it tried, and a failed write only went to the log - no copy was tried again until the next
// change, and the work lived only in memory. F12: a tab restored from the Start screen wrote a copy
// of its own and then deleted the old one - even when the new one could not be written.
import '../src/engine/mupdf-pre.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
const metas: unknown[] = [];
const cleared: string[] = [];
g.gcc = { renderers: 2, log: () => {}, settings: async () => ({}), info: async () => ({ user: 't' }), user: async () => 't', dropTemp: async () => true, stat: async () => ({ size: 100, mtime: 1, writable: true }), recoveryClear: async (k: string) => { cleared.push(k); }, recoveryPath: async () => '/rec/x.pdf', recoveryMeta: async (_id: unknown, m: unknown) => { metas.push(m); }, enginesStart: async () => true, cacheGet: async () => null, cachePut: async () => {}, docsClosed: () => {} };

const { renderers, editor } = await import('../src/ui/engines');
const docMod = await import('../src/ui/doc');
const { PdfDoc } = docMod;
type Fn = (...a: unknown[]) => unknown;
const page = (k: number) => ({ w: 595, h: 842, rot: 0, label: String(k + 1) });
const stub = (c: unknown, impl: Record<string, Fn>) => { (c as { call: Fn }).call = async (m: unknown, a: unknown) => { const f = impl[m as string]; if (!f) throw new Error('not stubbed: ' + m); return f(...((a as unknown[]) || [])); }; };
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test('a failed automatic copy is tried again later, without a new change', async () => {
  let writes = 0;
  stub(editor, {
    open: () => ({ pages: [page(0)], needsPassword: false, repaired: false, hasForms: false, size: 100, look: true }),
    getData: () => ({}), history: () => ({ undo: [], redo: [] }), close: () => true, noteChange: () => true,
    heavyCandidates: () => ({ candidates: [], shown: [] }), sourceOf: () => ({ path: '/doc.pdf' }),
    writeRecovery: () => { writes++; if (writes === 1) throw new Error('disk full'); return { base: null }; },
  });
  renderers.forEach((r) => stub(r, { open: () => true, close: () => true }));
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    (d as unknown as { changed(): void }).changed();          // one change
    mock.timers.tick(45_000); await settle();                  // the copy is tried: fails
    assert.equal(writes, 1);
    assert.equal(metas.length, 0, 'no copy written');
    mock.timers.tick(45_000); await settle();                  // later, no new change: tried again
    assert.equal(writes, 2, 'tried again after the failure');
    assert.equal(metas.length, 1, 'the copy is written');
  } finally { mock.timers.reset(); }
});

test('F12: a restored tab drops the old copy only once its own copy is written', async () => {
  let fail = true;
  stub(editor, {
    open: () => ({ pages: [page(0)], needsPassword: false, repaired: false, hasForms: false, size: 100, look: true }),
    getData: () => ({}), history: () => ({ undo: [], redo: [] }), close: () => true, noteChange: () => true,
    heavyCandidates: () => ({ candidates: [], shown: [] }), sourceOf: () => ({ path: '/doc.pdf' }),
    writeRecovery: () => { if (fail) throw new Error('folder held'); return { base: null }; },
  });
  const replace = (docMod as unknown as { replaceRecovery?: (d: unknown, oldKey: string) => Promise<boolean> }).replaceRecovery;
  assert.equal(typeof replace, 'function', 'doc.ts has replaceRecovery');
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  d.dirty = true;
  cleared.length = 0;
  assert.equal(await replace!(d, 'old-key'), false);
  assert.ok(!cleared.includes('old-key'), 'the old copy is kept when the new one failed');
  fail = false;
  assert.equal(await replace!(d, 'old-key'), true);
  assert.ok(cleared.includes('old-key'), 'and dropped once the new one is written');
  // (the restore in App.tsx goes through it, not a write whose failure is only logged)
  const app = readFileSync(new URL('../src/ui/App.tsx', import.meta.url), 'utf8');
  assert.ok(/replaceRecovery\(d, r\.key\)/.test(app), 'App.tsx restores through replaceRecovery');
  assert.ok(!/recovery after restore/.test(app), 'the old write-then-clear is gone');
});

test('F26: a save already running is waited for, not skipped (Save in the close question closed nothing)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  stub(editor, {
    open: () => ({ pages: [page(0)], needsPassword: false, repaired: false, hasForms: false, size: 100, look: true }),
    getData: () => ({}), history: () => ({ undo: [], redo: [] }), close: () => true, noteChange: () => true,
    heavyCandidates: () => ({ candidates: [], shown: [] }), sourceOf: () => ({ path: '/doc.pdf' }),
    save: async () => { await gate; return { size: 100, mtime: 2 }; }, saveTo: async () => { await gate; return { size: 100, mtime: 2 }; },
  });
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  const running = () => (d as unknown as { saveRunning?: Promise<boolean> | null }).saveRunning;
  assert.equal(running() ?? null, null, 'nothing running yet');
  const p = d.save().catch(() => false);
  await settle();
  assert.ok(running() instanceof Promise, 'the running save can be waited for');
  release(); await p; await settle();
  assert.equal(running() ?? null, null, 'and is gone once done');
  const app = readFileSync(new URL('../src/ui/App.tsx', import.meta.url), 'utf8');
  const saveDoc = app.slice(app.indexOf('async function saveDoc('), app.indexOf("busy('Saving ' + d.name"));
  assert.ok(/saveRunning/.test(saveDoc), 'saveDoc waits for a save of the tab that is still running');
});

test('F12 (review): the old copy kept after a failed restore copy goes with the first good copy', async () => {
  let fail = true;
  stub(editor, {
    open: () => ({ pages: [page(0)], needsPassword: false, repaired: false, hasForms: false, size: 100, look: true }),
    getData: () => ({}), history: () => ({ undo: [], redo: [] }), close: () => true, noteChange: () => true,
    heavyCandidates: () => ({ candidates: [], shown: [] }), sourceOf: () => ({ path: '/doc.pdf' }),
    writeRecovery: () => { if (fail) throw new Error('folder held'); return { base: null }; },
  });
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  d.dirty = true;
  cleared.length = 0;
  assert.equal(await docMod.replaceRecovery(d, 'old-2'), false);
  fail = false;
  await d.writeRecoveryNow();
  assert.ok(cleared.includes('old-2'), 'dropped once a copy of its own is written (no second restore offer at the next start)');
});

test('F47 (review): a change made while a copy is being written gets a copy of its own later', async () => {
  let writes = 0;
  let release!: () => void;
  stub(editor, {
    open: () => ({ pages: [page(0)], needsPassword: false, repaired: false, hasForms: false, size: 100, look: true }),
    getData: () => ({}), history: () => ({ undo: [], redo: [] }), close: () => true, noteChange: () => true,
    heavyCandidates: () => ({ candidates: [], shown: [] }), sourceOf: () => ({ path: '/doc.pdf' }),
    writeRecovery: async () => { writes++; if (writes === 1) await new Promise<void>((r) => { release = r; }); return { base: null }; },
  });
  const d = new PdfDoc('/doc.pdf');
  await d.load({ path: '/doc.pdf' });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const ch = () => (d as unknown as { changed(): void }).changed();
    ch();
    mock.timers.tick(45_000); await settle();       // the first copy starts...
    ch();                                           // ...a change while it is written
    release(); await settle();
    mock.timers.tick(45_000); await settle();
    assert.equal(writes, 2, 'the change made during the write is copied too');
  } finally { mock.timers.reset(); }
});
