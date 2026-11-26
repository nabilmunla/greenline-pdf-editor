// 14.6: Link the sheets found no sheet numbers - the message says why in plain words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nothingFoundText } from '../src/ui/sheets.ts';

test('one page: nothing to link to', () => {
  assert.match(nothingFoundText({ pages: 1, withText: 1 }), /only one page/i);
  assert.match(nothingFoundText({ pages: 1, withText: 1 }), /Nothing was changed\./);
});

test('several pages with text: says what it looks for', () => {
  const s = nothingFoundText({ pages: 9, withText: 9 });
  assert.match(s, /No sheet numbers found/);
  assert.match(s, /title block/);
  assert.match(s, /A-101/);
  assert.match(s, /Nothing was changed\./);
});

test('no page has text: the scan is the reason (the OCR line follows it)', () => {
  const s = nothingFoundText({ pages: 12, withText: 0 });
  assert.equal(s, 'No sheet numbers found. Nothing was changed.');
});
