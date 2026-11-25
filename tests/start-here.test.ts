// PLAN 13.2.7 (F39): the testers' START HERE.txt (publish.py, from installer/ALPHA-TEST.txt) said
// everything stays on the PC and reports stay on it - true of the company copy, false of the
// Greenline build, which checks GitHub for updates, sends the anonymous count and sends the
// reports the person chooses to send. Each edition gets its own lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const note = (brand: string) => execFileSync('python3', ['-c', `import sys; sys.path.insert(0, 'scripts'); from start_here import start_here; print(start_here(open('installer/ALPHA-TEST.txt', encoding='utf-8').read(), '${brand}', '9.9.9'))`], { cwd: ROOT, encoding: 'utf8' });

test('Greenline: no "everything stays on your PC"; says what goes online and how to stop it', () => {
  const t = note('greenline');
  assert.ok(!/Everything stays on your PC|reports stay on your PC|no shared reports folder/i.test(t), t);
  assert.match(t, /update/i);
  assert.match(t, /count/i);
  assert.match(t, /Report a problem/);
  assert.match(t, /PDF files are not sent anywhere, except the pages you ask the AI assistant/);
  assert.match(t, /recent log/);
  assert.ok(!/<<|>>|\{\{/.test(t), 'no markers left');
  assert.match(t, /source-v9\.9\.9\.zip/);
});

test('company copy: as before', () => {
  const t = note('');
  assert.match(t, /Everything stays on your PC/);
  assert.match(t, /reports stay on your PC/);
  assert.ok(!/<<|>>|\{\{/.test(t), 'no markers left');
});
