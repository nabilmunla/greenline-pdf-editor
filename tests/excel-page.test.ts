// Excel exports (7.1): both sheets start with Page (the label, else the number) and PDF page
// (always the physical page, a number).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentRow, measureRow, COMMENT_HEAD, MEASURE_HEAD, COMMENT_WIDTHS, MEASURE_WIDTHS } from '../src/ui/measurexl';

const comment = { type: 'Square', contents: 'Check the beam', replies: '', author: 'N. M.', state: '', date: '', colour: 'Red', locked: false };
const measure = { type: 'length', contents: '', group: '', author: 'N. M.', date: '' };

test('a markup on physical page 3 with a label: the label, then 3', () => {
  const r = commentRow({ ...comment, page: 2, label: 'A-101', num: null });
  assert.equal(r[0], 'A-101');
  assert.equal(r[1], 3);
  assert.equal(r[2], 'Square');
});

test('no labels: the number, then the number again', () => {
  assert.equal(commentRow({ ...comment, page: 2, num: null })[0], 3);
  assert.equal(commentRow({ ...comment, page: 2, label: '3', num: null })[0], 3, 'a label equal to the number counts as none');
  assert.equal(commentRow({ ...comment, page: 2, label: '3', num: null })[1], 3);
});

test('an empty label is the number', () => {
  assert.equal(commentRow({ ...comment, page: 2, label: '', num: null })[0], 3);
  assert.equal(commentRow({ ...comment, page: 2, label: '   ', num: null })[0], 3);
});

test('the measurements row: label, physical page, value and unit cells in place', () => {
  const r = measureRow({ ...measure, page: 2, label: 'A-101', num: { v: 2.5, unit: 'm', dec: 2 }, perimeter: null });
  assert.deepEqual(r.slice(0, 2), ['A-101', 3]);
  assert.deepEqual(r[3], { v: 2.5, s: 'n2' });
  assert.equal(r[4], 'm');
  assert.equal(r[5], '');
  assert.equal(measureRow({ ...measure, page: 0, num: null, perimeter: null })[0], 1);
});

test('both headers hold PDF page at index 1; widths match the columns', () => {
  assert.equal(COMMENT_HEAD[0], 'Page');
  assert.equal(COMMENT_HEAD[1], 'PDF page');
  assert.equal(MEASURE_HEAD[0], 'Page');
  assert.equal(MEASURE_HEAD[1], 'PDF page');
  assert.equal(COMMENT_WIDTHS.length, COMMENT_HEAD.length);
  assert.equal(MEASURE_WIDTHS.length, MEASURE_HEAD.length);
  assert.equal(commentRow({ ...comment, page: 0, num: null }).length, COMMENT_HEAD.length);
  assert.equal(measureRow({ ...measure, page: 0, num: null, perimeter: null }).length, MEASURE_HEAD.length);
});
