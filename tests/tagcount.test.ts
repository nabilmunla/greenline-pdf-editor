// Count by tag (0.8.5): words from a page's characters, which words match, each mark once.
// npx tsx --test tests/tagcount.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordsOf, matchTag, findTags, perTagByDefault } from '../src/ui/tagcount';

/** characters laid out left to right on one line (a space = no box) */
function line(text: string, x = 0, y = 100, w = 6, h = 10) {
  const box = new Float32Array(text.length * 4);
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' || text[i] === '\n') box.set([NaN, NaN, NaN, NaN], i * 4);
    else box.set([x + i * w, y, x + i * w + w, y + h], i * 4);
  }
  return { text, box };
}

test('words: split at spaces, brackets and commas round them left out', () => {
  const w = wordsOf(line('DOOR (D01), D-A0101-A FD.3; d02'));
  assert.deepEqual(w.map((x) => x.text), ['DOOR', 'D01', 'D-A0101-A', 'FD.3', 'd02']);
  assert.deepEqual(w[1].box, [30, 100, 66, 110], 'box of the word as drawn (brackets included)');
});

test('matching: starting with means a number or a separator after it', () => {
  for (const [w, ok] of [['D01', true], ['D-A0101-A', true], ['D.3', true], ['DOOR', false], ['D', true], ['d02', true], ['XD01', false]] as const) assert.equal(matchTag(w, 'D', 'start'), ok, w);
  assert.equal(matchTag('FD01', 'FD', 'start'), true);
  assert.equal(matchTag('D-01', 'D-', 'start'), true);
  assert.equal(matchTag('D1X', 'D1', 'start'), true, 'a tag ending in a number takes anything after it');
  assert.equal(matchTag('D01', 'd01', 'exact'), true);
  assert.equal(matchTag('D011', 'D01', 'exact'), false);
  assert.equal(matchTag('XD01Y', 'D01', 'contain'), true);
  assert.equal(matchTag('anything', ' ', 'start'), false, 'nothing typed finds nothing');
});

test('found marks: in page order, the same text drawn twice on itself once', () => {
  const p0 = [...wordsOf(line('D02 text D01', 0, 300)), ...wordsOf(line('D01', 0, 100)), ...wordsOf(line('D01', 0.4, 100.3))];
  const p1 = wordsOf(line('DOOR D03 D01'));
  const hits = findTags([{ page: 0, words: p0 }, { page: 1, words: p1 }], 'D', 'start');
  assert.deepEqual(hits.map((h) => `${h.page}:${h.text}`), ['0:D01', '0:D02', '0:D01', '1:D03', '1:D01']);
  // one name each when they repeat; not for door numbers found once each
  assert.equal(perTagByDefault(hits), false, '3 names for 5 marks: not repeating enough');
  const many = Array.from({ length: 12 }, (_, i) => ({ page: 0, text: i % 2 ? 'D1' : 'D2', box: [0, i * 20, 10, i * 20 + 10] as [number, number, number, number] }));
  assert.equal(perTagByDefault(many), true);
  assert.equal(perTagByDefault(many.map((h, i) => ({ ...h, text: 'D' + i }))), false);
});
