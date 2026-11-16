// PLAN 2.4 (AUDIT A7): memory the tile budget did not count.
// - the first eviction pass never evicts a tile that is still wanted;
// - the canvases a page holds on screen (tile canvases + preview) count in the budget;
// - removed canvases are emptied (size 0) first; of the old zoom levels only the nearest stays while the new one is incomplete.
// No DOM here: the tiles.ts parts are run as they are, the canvas handling of PageTiles through the small helpers it uses
// (and a check that PageTiles really uses them). npx tsx --test tests/plan-2-4.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.gcc = { renderers: 2, log: () => {}, enginesStart: async () => true, cacheGet: async () => null, cachePut: async () => {} };

const { tiles, canvasBytes, dropCanvas, oldLevelsToKeep } = await import('../src/ui/tiles');

type Priv = { budget: number; put(key: string, bmp: unknown, size: number): void; cache: Map<string, unknown> };
const T = tiles as unknown as Priv;
const bmp = () => ({ closed: false, close() { this.closed = true; } });
const req = (key: string) => ({ key, layer: 'b' as const, doc: 'D', page: 0, scale: 1, x: 0, y: 0, w: 512, h: 512, prio: 0 });
/** a fresh store state: nothing cached, no wishes, the budget given */
function fresh(budget: number) {
  for (const k of [...T.cache.keys()]) tiles.drop(k);
  for (const tag of ['T', 'U']) { tiles.forget(tag); tiles.noteCanvasBytes(tag, 0); }
  T.budget = budget;
}

test('2.4: the first eviction pass never evicts a tile that is still wanted', () => {
  fresh(1000);
  // two wanted tiles, the oldest in the cache (the order the old code evicts in)
  T.put('D|r1|b|1.0000|0|0', bmp(), 400);
  T.put('D|r1|b|1.0000|1|0', bmp(), 400);
  tiles.need('T', [req('D|r1|b|1.0000|0|0'), req('D|r1|b|1.0000|1|0')]);   // (both cached: nothing is queued)
  T.put('D|r1|b|0.5000|0|0', bmp(), 400);                                    // 1,200 > 1,000: eviction runs
  assert.ok(tiles.has('D|r1|b|1.0000|0|0') && tiles.has('D|r1|b|1.0000|1|0'), 'the wanted tiles are still there');
  assert.ok(!tiles.has('D|r1|b|0.5000|0|0'), 'the one nobody asks for went');
  assert.equal(tiles.stats().bytes, 800);
});

test('2.4: canvases on screen count in the budget: pictures not needed go sooner, wanted ones stay', () => {
  fresh(1000);
  T.put('D|r1|b|1.0000|0|0', bmp(), 300);   // not wanted
  T.put('D|r1|b|1.0000|1|0', bmp(), 300);   // not wanted
  T.put('D|r1|b|1.0000|2|0', bmp(), 300);   // wanted
  tiles.need('T', [req('D|r1|b|1.0000|2|0')]);
  assert.equal(tiles.stats().bytes, 900);
  assert.equal(tiles.stats().canvases, 0);
  tiles.noteCanvasBytes('T', 500);          // 900 + 500 > 1,000
  assert.equal(tiles.stats().canvases, 500);
  assert.ok(tiles.stats().bytes + tiles.stats().canvases <= 800, 'down to 80 % with the canvases counted: ' + JSON.stringify(tiles.stats()));
  assert.ok(tiles.has('D|r1|b|1.0000|2|0'), 'the wanted one is kept');
  assert.ok(!tiles.has('D|r1|b|1.0000|0|0'), 'the oldest unwanted one went');
  // the number is per page: set again it replaces, and a page that goes takes its canvases out of the count
  tiles.noteCanvasBytes('T', 200); tiles.noteCanvasBytes('U', 100);
  assert.equal(tiles.stats().canvases, 300);
  tiles.forget('T');
  assert.equal(tiles.stats().canvases, 100);
  tiles.noteCanvasBytes('U', 0);
  assert.equal(tiles.stats().canvases, 0);
});

test('2.4: canvases alone over the budget never take a wanted tile', () => {
  fresh(1000);
  T.put('D|r1|b|1.0000|0|0', bmp(), 200);
  tiles.need('T', [req('D|r1|b|1.0000|0|0')]);
  tiles.noteCanvasBytes('T', 5000);
  assert.ok(tiles.has('D|r1|b|1.0000|0|0'));
  tiles.noteCanvasBytes('T', 0);
});

test('2.4: a removed canvas is emptied (size 0) before it is taken off the page', () => {
  const seen: string[] = [];
  const c = { width: 512, height: 512, remove() { seen.push(`${this.width}x${this.height}`); } };
  dropCanvas(c);
  assert.deepEqual(seen, ['0x0'], 'size was 0 when it was removed');
  assert.equal(canvasBytes([{ width: 512, height: 512 }, { width: 100, height: 10 }, { width: 0, height: 0 }]), 512 * 512 * 4 + 4000);
});

test('2.4: of the old zoom levels, only the one nearest the new level stays', () => {
  const have = ['1.0000', '1.0000', '1.1892', '1.4142', '2.0000', '2.0000'];
  assert.deepEqual([...oldLevelsToKeep(have, '2.0000')], ['1.4142'], 'the current level is not "old"; the nearest old one stays');
  assert.deepEqual([...oldLevelsToKeep(have, '1.0000')], ['1.1892']);
  assert.deepEqual([...oldLevelsToKeep(have, '1.0000', 2)].sort(), ['1.1892', '1.4142']);
  assert.deepEqual([...oldLevelsToKeep(['2.0000'], '2.0000')], [], 'nothing old: nothing kept');
  // zoomed out: the nearer of a bigger and a smaller level
  assert.deepEqual([...oldLevelsToKeep(['2.8284', '0.5000'], '2.0000')], ['2.8284']);
});

test('2.4: PageTiles uses them (no bare canvas.remove(), the budget is told what the page holds)', () => {
  const src = readFileSync('src/ui/PageTiles.tsx', 'utf8');
  assert.doesNotMatch(src, /\b[co]\.remove\(\)/, 'canvases are taken off through dropCanvas');
  assert.match(src, /dropCanvas\(c\)/);
  assert.match(src, /oldLevelsToKeep\(/);
  assert.match(src, /tiles\.noteCanvasBytes\(s\.tag, canvasBytes\(all\)\)/);
});
