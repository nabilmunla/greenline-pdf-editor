// PLAN 1.7 (AUDIT B7): a wasm whose memory section is not the one the 4 GB lift expects is logged,
// the engine reports the limit it is left with, and the planned restart is set below that limit.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as pf from '../src/engine/pdfium';
import { recycleAtFor } from '../src/engine/host';

const GB = 1024 ** 3;
/** a wasm with nothing in it but a memory section: `mem` are the bytes of the section's content */
const tiny = (...mem: number[]) => new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, mem.length, ...mem]).buffer;
/** run `f`, collecting what it logs with console.error */
function logged<T>(f: () => T): { value: T; lines: string[] } {
  const orig = console.error; const lines: string[] = [];
  console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try { return { value: f(), lines }; } finally { console.error = orig; }
}

test('1.7: a wasm with the expected memory section (max 32768 pages) is lifted, silently, to 4 GB', () => {
  const w = tiny(1, 1, 1, 0x80, 0x80, 0x02);
  const r = logged(() => pf.liftMemoryMax(w));
  assert.deepEqual(r.lines, []);
  assert.notEqual(r.value, w);
  assert.deepEqual([...new Uint8Array(r.value).subarray(13, 16)], [0xff, 0xff, 0x03]);
  assert.equal(pf.memoryLimit(), pf.MEMORY_MAX);
  // the real file too
  const real = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  const r2 = logged(() => pf.liftMemoryMax(real.buffer.slice(real.byteOffset, real.byteOffset + real.byteLength)));
  assert.deepEqual(r2.lines, []);
  assert.equal(pf.memoryLimit(), pf.MEMORY_MAX);
});

test('1.7: a wasm whose memory maximum differs is left as it is, logged, and the limit is what it says', () => {
  const w = tiny(1, 1, 1, 0x80, 0x80, 0x01); // 16384 pages = 1 GB
  const r = logged(() => pf.liftMemoryMax(w));
  assert.equal(r.value, w, 'returned unchanged');
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /left as it is/);
  assert.equal(pf.memoryLimit(), 1 * GB);
});

test('1.7: a memory section of another shape (no maximum; two memories; no section; not a wasm) is logged, limit 2 GB', () => {
  const cases: [string, ArrayBuffer][] = [
    ['no maximum', tiny(1, 0, 1)],
    ['two memories', tiny(2, 1, 1, 0x80, 0x80, 0x02, 1, 1, 0x80, 0x80, 0x02)],
    ['no section', new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).buffer],
    ['not a wasm', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer],
  ];
  for (const [name, w] of cases) {
    const r = logged(() => pf.liftMemoryMax(w));
    assert.equal(r.value, w, name);
    assert.equal(r.lines.length, 1, name);
    assert.equal(pf.memoryLimit(), 2 * GB, name);
  }
});

test('1.7: a wasm that already allows 4 GB is left alone without a log', () => {
  const w = tiny(1, 1, 1, 0xff, 0xff, 0x03);
  const r = logged(() => pf.liftMemoryMax(w));
  assert.equal(r.value, w);
  assert.deepEqual(r.lines, []);
  assert.equal(pf.memoryLimit(), pf.MEMORY_MAX);
});

test('1.7: the planned restart point is capped below a 2 GB limit, and not touched at 4 GB', () => {
  assert.equal(recycleAtFor(2 * GB, 3 * GB), 1.8 * GB);
  assert.equal(recycleAtFor(2 * GB, 1.4 * GB), 1.4 * GB);
  assert.equal(recycleAtFor(pf.MEMORY_MAX, 3 * GB), 3 * GB);
});
