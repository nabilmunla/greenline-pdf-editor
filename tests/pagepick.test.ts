// The shared page picker's rule (Print, Search, Rotate): which pages a choice means.
// npx tsx --test tests/pagepick.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPages } from '../src/ui/dlgutil';

const base = { which: 'all' as const, range: '', subset: 'all' as const, n: 10, current: 4, selected: [] as number[] };

test('all: every page; current: the page on screen', () => {
  assert.deepEqual(pickPages(base), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(pickPages({ ...base, which: 'current' }), [4]);
});

test('current ignores odd / even (as the Print panel always did); view and area are the current page', () => {
  assert.deepEqual(pickPages({ ...base, which: 'current', subset: 'even' }), [4]);
  assert.deepEqual(pickPages({ ...base, which: 'view', subset: 'odd' }), [4]);
  assert.deepEqual(pickPages({ ...base, which: 'area', subset: 'odd' }), [4]);
});

test('selected: the Pages panel picks, in page order', () => {
  assert.deepEqual(pickPages({ ...base, which: 'selected', selected: [7, 2, 5] }), [2, 5, 7]);
  assert.deepEqual(pickPages({ ...base, which: 'selected', selected: [7, 2, 5], subset: 'odd' }), [2]);
});

test('range: "3-7, 12" keeps what exists, "8-" runs to the end', () => {
  assert.deepEqual(pickPages({ ...base, which: 'range', range: '3-7, 12' }), [2, 3, 4, 5, 6]);
  assert.deepEqual(pickPages({ ...base, which: 'range', range: '8-' }), [7, 8, 9]);
  assert.deepEqual(pickPages({ ...base, which: 'range', range: '99' }), []);
  assert.deepEqual(pickPages({ ...base, which: 'range', range: '' }), []);
});

test('range: "11-" on 10 pages reads as "10-11" (parseRanges swaps a backwards range, as it always did: Print is unchanged)', () => {
  assert.deepEqual(pickPages({ ...base, which: 'range', range: '11-' }), [9]);
  assert.deepEqual(pickPages({ ...base, which: 'range', range: '11-', n: 0 }), []);
});

test('odd / even count page numbers (page 1 is odd)', () => {
  assert.deepEqual(pickPages({ ...base, subset: 'odd' }), [0, 2, 4, 6, 8]);
  assert.deepEqual(pickPages({ ...base, subset: 'even' }), [1, 3, 5, 7, 9]);
  assert.deepEqual(pickPages({ ...base, which: 'range', range: '3-7', subset: 'even' }), [3, 5]);
});

test('no pages at all: nothing, never an error', () => {
  for (const which of ['all', 'range', 'selected'] as const) assert.deepEqual(pickPages({ ...base, which, range: '1-3', n: 0 }), []);
});
