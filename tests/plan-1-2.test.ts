// PLAN 1.2 (AUDIT B2): shaping a run must not leave a HarfBuzz buffer behind. harfbuzzjs 1.6.4 has
// no Buffer.destroy() (it frees a buffer only when the JS object is garbage collected, and a
// finalizer never runs inside a busy loop), so shape.ts now reuses one buffer. The test reads the
// HarfBuzz wasm heap itself: WebAssembly.instantiate is wrapped before harfbuzzjs loads, to catch
// the instance that exports hb_buffer_create. (The mupdf wasm is ignored.)
import { test } from 'node:test';
import assert from 'node:assert/strict';

let hbMem: WebAssembly.Memory | null = null;
const grab = (r: unknown) => {
  const ex = ((r as { instance?: WebAssembly.Instance }).instance ?? (r as WebAssembly.Instance)).exports as Record<string, unknown> | undefined;
  if (ex && 'hb_buffer_create' in ex && ex.memory instanceof WebAssembly.Memory) hbMem = ex.memory;
  return r;
};
const origInst = WebAssembly.instantiate.bind(WebAssembly) as (...a: unknown[]) => Promise<unknown>;
(WebAssembly as unknown as { instantiate: unknown }).instantiate = async (...a: unknown[]) => grab(await origInst(...a));

test('1.2: 10,000 shaped runs grow the HarfBuzz wasm heap by under 5 MB', async () => {
  const { layoutText } = await import('../src/engine/shape');
  const { fontStack } = await import('../src/engine/fonts');
  assert.ok(hbMem, 'found the HarfBuzz wasm memory');
  const stack = fontStack('DejaVu Sans', false, false);
  assert.ok(stack.length, 'a font for shaping');
  // one paragraph of 20 short words wrapped narrow: each candidate prefix is shaped again
  const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
  layoutText(text, 6, stack);                     // warm up (font tables, first allocations)
  const before = hbMem!.buffer.byteLength;
  // (every layout shapes many prefixes, so this is far more than 10,000 runs)
  for (let i = 0; i < 10_000; i++) layoutText(text, 6, stack);
  const grown = hbMem!.buffer.byteLength - before;
  console.log(`HarfBuzz wasm heap: ${(before / 1048576).toFixed(1)} MB -> ${((before + grown) / 1048576).toFixed(1)} MB (+${(grown / 1048576).toFixed(2)} MB) after 10,000 layouts`);
  assert.ok(grown < 5 * 1048576, `heap grew ${grown} bytes`);
});
