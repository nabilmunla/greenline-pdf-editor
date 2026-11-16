// PLAN 4.2: a view tile an engine answered "stale" (dropped unrun: its scale was not wanted when its
// turn came) that the window wants again since (zoom A -> B -> A while it was queued there) is asked
// again - it was neither in flight nor queued: a hole until the next scroll. And after a drawing
// engine restart the wanted scales are posted again (the new engine knows none).
// npx tsx --test tests/plan-4-2.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.gcc = { renderers: 1, log: () => {}, enginesStart: async () => true, cacheGet: async () => null, cachePut: async () => {} };

const { renderers } = await import('../src/ui/engines');
const { tiles } = await import('../src/ui/tiles');

type Fn = (...a: unknown[]) => unknown;
/** view tiles started (doc|scale), each waiting for the test to answer it */
const started: { doc: string; scale: number; ok(): void; stale(): void }[] = [];
const wants: string[] = [];
renderers.forEach((r) => {
  (r as unknown as { call: Fn }).call = (method: unknown, args: unknown) => {
    if (method !== 'viewTile') return Promise.resolve(true);
    const a = args as [string, number, number];
    return new Promise((res, rej) => started.push({
      doc: a[0], scale: a[2],
      ok: () => res({ width: 512, height: 512, close() {} }),
      stale: () => rej(Object.assign(new Error('stale tile'), { stale: true })),
    }));
  };
  (r as unknown as { want: Fn }).want = (doc: unknown, scales: unknown) => { wants.push(`${doc}:${scales === null ? 'null' : (scales as number[]).join(',')}`); };
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const req = (doc: string, scale: number) => ({ key: `${doc}|r-1|b|${scale.toFixed(4)}|0|0`, layer: 'b' as const, doc, page: 0, scale, x: 0, y: 0, w: 512, h: 512, prio: 0 });

test('4.2: a stale answer after zoom A -> B -> A, the tile wanted again: started again, lands in the cache', async () => {
  const doc = 'Z1';
  tiles.need('t', [req(doc, 1)]);
  await tick();
  assert.equal(started.length, 1, 'A started');
  // zoom to B (A queued in the engine meanwhile), then back to A: A is in flight, so need() does not queue it
  tiles.need('t', [req(doc, 2)]);
  tiles.need('t', [req(doc, 1)]);
  assert.equal(tiles.stats().queued, 0, 'in flight: not queued');
  const before = tiles.stats().stale;
  started[0].stale();   // the engine dropped it for the zoom B in between
  await tick(); await tick();
  assert.equal(tiles.stats().stale, before + 1, 'counted');
  // (B was started meanwhile - it is the second; A again is the third)
  assert.deepEqual(started.map((s) => s.scale), [1, 2, 1], 'started again');
  started[2].ok();
  started[1].ok();
  await tick();
  assert.ok(tiles.has(req(doc, 1).key), 'landed in the cache');
  tiles.forget('t'); tiles.closeDoc(doc);
});

test('4.2: a stale answer for a key nobody wants is not asked again', async () => {
  const doc = 'Z2', n = started.length;
  tiles.need('t', [req(doc, 1)]);
  await tick();
  assert.equal(started.length, n + 1);
  tiles.need('t', [req(doc, 2)]);   // the view left scale 1 for good
  await tick();
  assert.equal(started.length, n + 2, 'scale 2 started');
  started[n].stale();
  await tick(); await tick();
  assert.equal(started.length, n + 2, 'scale 1 not started again');
  assert.equal(tiles.stats().queued, 0);
  assert.ok(!tiles.has(req(doc, 1).key));
  started[n + 1].ok();
  await tick();
  tiles.forget('t'); tiles.closeDoc(doc);
});

test('4.2: after a drawing engine restart the wanted scales are posted again', async () => {
  const doc = 'Z3';
  tiles.need('t', [req(doc, 1), req(doc, 1.5)]);
  await tick();
  const sig = `${doc}:1,1.5`;
  assert.equal(wants.filter((w) => w === sig).length, 1, 'posted once');
  tiles.need('t', [req(doc, 1), req(doc, 1.5)]);
  assert.equal(wants.filter((w) => w === sig).length, 1, 'unchanged scales are not posted again by need()');
  tiles.retry();   // what the restart hook (doc.ts onEngineRestart) calls
  assert.equal(wants.filter((w) => w === sig).length, 2, 'posted again after the restart');
  for (const s of started.splice(0)) s.ok();
  await tick();
  tiles.forget('t'); tiles.closeDoc(doc);
});
