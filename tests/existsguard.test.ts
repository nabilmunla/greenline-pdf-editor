// DeepSeek 0.13.2 #6: "is there a file here?" from the window does not reach a network share the
// person didn't choose (Windows would send their sign-in to that server); a refusal reads as "there"
// to the replace check, so nothing is overwritten without asking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { existsFor } = require('../electron/existsguard.cjs');

test('a share path not chosen is refused without being touched; chosen ones and local paths are looked at', () => {
  const touched: string[] = [];
  const exists = (p: string) => { touched.push(p); return true; };
  const chosen = (p: string) => p.toLowerCase().startsWith('\\\\srv\\tenders\\');
  for (const p of ['\\\\attacker\\x', '//attacker/x', '\\\\?\\UNC\\attacker\\x']) {
    assert.throws(() => existsFor(p, chosen, exists), /not a place you chose/);
  }
  assert.equal(touched.length, 0, 'nothing sent to the made-up server');
  assert.equal(existsFor('\\\\srv\\tenders\\a.pdf', chosen, exists), true);
  assert.equal(existsFor('C:\\out\\a.pdf', chosen, exists), true);
  assert.equal(existsFor(42 as unknown as string, chosen, exists), false, 'not a path: nothing looked at');
  assert.equal(touched.length, 2);
});
