// 14.2: search in chosen pages - the engine's find takes a run of pages (from, to), so a choice
// like "3-5, 8" goes as runs of consecutive pages, at most 40 each (as the whole-file search did).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piecesOf } from '../src/ui/dlgutil';

test('consecutive pages make one run; gaps start a new one', () => {
  assert.deepEqual(piecesOf([2, 3, 4, 7]), [[2, 5], [7, 8]]);
});
test('a long run is cut at 40 pages', () => {
  assert.deepEqual(piecesOf([...Array(100).keys()]), [[0, 40], [40, 80], [80, 100]]);
  assert.deepEqual(piecesOf([...Array(10).keys()], 4), [[0, 4], [4, 8], [8, 10]]);
});
test('unsorted or repeated pages are put in order once', () => {
  assert.deepEqual(piecesOf([8, 2, 3, 2]), [[2, 4], [8, 9]]);
});
test('nothing chosen: no runs', () => {
  assert.deepEqual(piecesOf([]), []);
});
