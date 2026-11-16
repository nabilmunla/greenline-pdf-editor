// PLAN 2.3 (AUDIT A6): scrolling must not rebuild every visible page's tile wishes on every frame.
// - a page whose priority alone changed is not re-rendered (samePageTiles), its wishes are shifted
//   in place (tiles.reprio) and the queue is sorted once before the next tile starts;
// - the order in which tiles start follows the new priorities.
// npx tsx --test tests/plan-2-3.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.gcc = { renderers: 2, log: () => {}, enginesStart: async () => true, cacheGet: async () => null, cachePut: async () => {} };

const { renderers } = await import('../src/ui/engines');
const { tiles } = await import('../src/ui/tiles');
const { samePageTiles } = await import('../src/ui/PageTiles');

type Fn = (...a: unknown[]) => unknown;
/** tiles started, in order; each waits until released */
const started: string[] = [];
const waiting: (() => void)[] = [];
renderers.forEach((r) => {
  (r as unknown as { call: Fn }).call = async (method: unknown, args: unknown) => {
    if (method !== 'tile' && method !== 'viewTile') return true;
    const a = args as number[];
    started.push(`${a[1]}:${a[3]}`);
    await new Promise<void>((res) => waiting.push(res));
    return { width: 512, height: 512, close() {} };
  };
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const reqsFor = (page: number, base: number, n: number) => Array.from({ length: n }, (_, k) => ({
  key: `D|r-1|b|1.0000|${page}|${k}`, layer: 'b' as const, doc: 'D', page, scale: 1, x: k * 512, y: 0, w: 512, h: 512, prio: base + k,
}));

test('2.3: a page that only moved in the view is not re-rendered; anything drawn that changes is', () => {
  const doc = {} as never;
  const p = { doc, page: 3, w: 595, h: 842, z: 1, dpr: 1, vis: [0, 0, 595, 400] as [number, number, number, number], crev: -4, annRev: 0, hasAnnots: false, hasHighlights: false, hide: [] as number[], prio: 100, tag: 'D:3' };
  assert.ok(samePageTiles(p, { ...p, prio: 5 }), 'priority only: same');
  assert.ok(samePageTiles(p, { ...p, vis: [0, 0, 595, 400], hide: [] }), 'new arrays, same values: same');
  assert.ok(!samePageTiles(p, { ...p, vis: [0, 10, 595, 410] }), 'view moved on the page: re-render');
  assert.ok(!samePageTiles(p, { ...p, hide: [7] }), 'markup hidden: re-render');
  assert.ok(!samePageTiles(p, { ...p, z: 2 }), 'zoom: re-render');
});

test('2.3: reprio moves a page\'s waiting tiles ahead without asking again; next start follows it', async () => {
  // 2 drawing engines -> 4 base tiles in flight at most; everything else waits in the queue
  tiles.need('D:1', reqsFor(1, 0, 6), 0);
  tiles.need('D:2', reqsFor(2, 1000, 6), 1000);
  await tick();
  assert.deepEqual(started.slice(0, 4), ['1:0', '1:512', '1:1024', '1:1536'], 'page 1 (nearer) first');
  // the view scrolls: page 2 is now in the middle, page 1 far away
  let needs = 0;
  const need = tiles.need.bind(tiles);
  tiles.need = ((...a: Parameters<typeof need>) => { needs++; return need(...a); }) as typeof need;
  tiles.reprio('D:1', 5000);
  tiles.reprio('D:2', 0);
  assert.equal(tiles.baseOf('D:2'), 0);
  assert.equal(needs, 0, 'no page asked again');
  // one tile finishes -> the next one started is page 2's, not page 1's remaining ones
  waiting.shift()!();
  await tick(); await tick();
  assert.equal(started[4], '2:0', 'the moved page goes first');
  tiles.need = need;
  tiles.forget('D:1'); tiles.forget('D:2');
  for (const w of waiting.splice(0)) w();
  await tick();
});
