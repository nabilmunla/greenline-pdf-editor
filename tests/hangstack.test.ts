// 14.7: when the window stops answering, the log gets the call stack of what it was running -
// trimmed, and with the user's own names and paths taken out like the rest of the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stackForLog, MAX_FRAMES, MAX_CHARS } = require('../electron/hangstack.cjs');

test('kept to the frames that matter, never huge', () => {
  const raw = 'Error\n' + Array.from({ length: 200 }, (_, i) => `    at fn${i} (app://gcc/assets/index-abc.js:${i}:1)`).join('\n');
  const s = stackForLog(raw, {});
  assert.ok(s.split('\n').length <= MAX_FRAMES + 1, 'frames: ' + s.split('\n').length);
  assert.ok(s.length <= MAX_CHARS);
  assert.match(s, /fn0 /);
  assert.match(s, /more frames/);
});

test("the person's user name, PC name and paths are taken out", () => {
  const raw = 'Error\n    at open (C:\\Users\\jsmith\\Documents\\Tender X\\plan.pdf:1:1)\n    at go (app://gcc/assets/index.js:9:9) [JSMITH-PC]';
  const s = stackForLog(raw, { user: 'jsmith', pc: 'JSMITH-PC' });
  assert.doesNotMatch(s, /jsmith|Tender X|plan\.pdf|JSMITH-PC/i);
  assert.match(s, /at go \(app:\/\/gcc\/assets\/index\.js:9:9\)/);
});

test('nothing to say: empty, or not text', () => {
  assert.equal(stackForLog('', {}), '');
  assert.equal(stackForLog(undefined, {}), '');
});
