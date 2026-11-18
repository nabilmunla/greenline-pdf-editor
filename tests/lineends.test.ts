// PLAN 8.1: the line-ends list: the ten MuPDF styles once each, in order; a style from a foreign
// file gets an option of its own (never a blank select).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINE_ENDS, endOptions } from '../src/ui/lineends';

test('the list holds the ten styles once each', () => {
  assert.deepEqual(LINE_ENDS.map((e) => e.name), ['None', 'ClosedArrow', 'OpenArrow', 'RClosedArrow', 'ROpenArrow', 'Circle', 'Square', 'Diamond', 'Butt', 'Slash']);
  assert.equal(new Set(LINE_ENDS.map((e) => e.name)).size, 10);
  assert.equal(new Set(LINE_ENDS.map((e) => e.label)).size, 10);
});

test('options: the ten for a known style, an extra one for a foreign name', () => {
  assert.equal(endOptions('Diamond').length, 10);
  const o = endOptions('CustomEnd');
  assert.equal(o.length, 11);
  assert.deepEqual(o[10], { value: 'CustomEnd', text: 'CustomEnd' });
});

test('the start select mirrors the arrows (they point away from the line at both ends)', () => {
  const at = (w: 'start' | 'end', n: string) => endOptions('None', w).find((o) => o.value === n)!.text;
  assert.equal(at('start', 'ClosedArrow'), '◄ Arrow');
  assert.equal(at('end', 'ClosedArrow'), '► Arrow');
  assert.equal(at('start', 'ROpenArrow'), '> Open arrow pointing in');
  assert.equal(at('start', 'Circle'), at('end', 'Circle'));
});
