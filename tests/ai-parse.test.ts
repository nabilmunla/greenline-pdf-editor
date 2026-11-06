// The answer parser must never hang on a half-written answer (it runs on every streamed piece).
import { test } from 'node:test';
import assert from 'node:assert/strict';
(globalThis as any).window = { gcc: {}, addEventListener() {} };

test('answer blocks: every prefix of a streamed answer parses; citations become page links', async () => {
  const { blocks, inline } = await import('../src/ui/ai');
  const full = '=== Page 1 ===\nيجب على المقاول تقديم جميع العمالة.\n\n| البند | الكمية |\n|---|---|\n| خرسانة | 120 |\n\n# Head\n- a [p. 3]\n1. b **bold** [pp. 4-6, 9]\n```\ncode\n```\n=== Page 2 ===\nend';
  for (let n = 0; n <= full.length; n++) blocks(full.slice(0, n));
  const b = blocks(full);
  assert.deepEqual(b.map((x) => x.k), ['page', 'p', 'table', 'h', 'ul', 'ol', 'code', 'page', 'p']);
  const cites = inline('see [p. 3] and [pp. 4-6, 9]').filter((x) => x.k === 'cite').map((x) => (x as { page: number }).page);
  assert.deepEqual(cites, [3, 4, 9]);
});
