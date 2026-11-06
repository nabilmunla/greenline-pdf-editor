// UI shell helpers (src/ui/pagesel.ts): page selection after page changes, Shift+click ranges,
// version order, settings cleaned before drawing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followPages, pageRange, newerVersion, cleanSettings } from '../src/ui/pagesel';

test('page selection follows its pages (inserted, deleted, moved, undone) and stays for in-place changes', () => {
  const before = [11, 12, 13, 14, 15];
  // a blank page inserted before page 4 (index 3): page 4 is now index 4
  assert.deepEqual(followPages([3], before, [11, 12, 13, 99, 14, 15]), [4]);
  // pages 1-2 deleted: page 4 is index 1; a selected page that was deleted drops out
  assert.deepEqual(followPages([1, 3], before, [13, 14, 15]), [1]);
  // reordered (page 5 moved to the front)
  assert.deepEqual(followPages([0, 4], before, [15, 11, 12, 13, 14]), [1, 0]);
  // rotated in place: those pages get new revisions at the same places - selection unchanged
  assert.deepEqual(followPages([1, 2], before, [11, 50, 51, 14, 15]), [1, 2]);
  // everything redrawn (flatten all, same page count): unchanged
  assert.deepEqual(followPages([0, 4], before, [60, 61, 62, 63, 64]), [0, 4]);
  // everything new and a different count (an undo with no change record): nothing can be told - cleared
  assert.deepEqual(followPages([0, 4], before, [70, 71, 72]), []);
  // duplicated (the original keeps its place)
  assert.deepEqual(followPages([1], before, [11, 12, 12, 13, 14, 15]), [1]);
  // nothing selected stays nothing
  const none: number[] = [];
  assert.equal(followPages(none, before, [1]), none);
});

test('shift+click range keeps its anchor', () => {
  // click 3, shift+click 7, shift+click 1: 1-3 (was 1-7: the anchor became the far end)
  assert.deepEqual(pageRange(2, 6), [2, 3, 4, 5, 6]);
  assert.deepEqual(pageRange(2, 0), [0, 1, 2]);
  assert.deepEqual(pageRange(4, 4), [4]);
});

test('version order', () => {
  assert.equal(newerVersion('0.8.0', '0.7.0'), true);
  assert.equal(newerVersion('0.7.0', '0.8.0'), false);
  assert.equal(newerVersion('0.10.0', '0.9.2'), true);
  assert.equal(newerVersion('1.0.0', '1.0.0'), false);
  assert.equal(newerVersion('1.0.1', '1.0'), true);
});

test('settings with damaged entries are made safe to draw', () => {
  const s = cleanSettings({ recent: ['C:\\a.pdf', null, 5, { x: 1 }, '', 'D:\\b.pdf'], chest: [null, 'x', { id: '1', name: 'Cloud 1', tool: 'cloud', style: {} }, { id: '2', name: 'Old', tool: 'gone-tool', style: { color: [1, 0, 0] } }, { id: '3', tool: 'rect' }, { id: '4', name: 'No style', tool: 'rect' }], author: 'N' } as { recent?: unknown; chest?: unknown; author: string });
  assert.deepEqual(s.recent, ['C:\\a.pdf', 'D:\\b.pdf']);
  // (an unknown tool is kept - refused when used; broken entries go)
  assert.deepEqual((s.chest as { id: string }[]).map((c) => c.id), ['1', '2']);
  assert.equal(s.author, 'N');
  assert.deepEqual(cleanSettings({ recent: 'C:\\a.pdf' }).recent, []);
  assert.deepEqual(cleanSettings({}), {});
});
