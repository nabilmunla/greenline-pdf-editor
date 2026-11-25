// PLAN 13.2.13: the version the app says it is, README.txt and the release notes agree (README.txt
// said 0.12.1 two releases on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const ver: string = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;

test('README.txt: its title and the setup file it names are this version (history notes like "from 0.8.2 on" stay)', () => {
  const t = readFileSync(new URL('README.txt', root), 'utf8');
  const stale = t.split('\n').filter((l) => /version \d|Setup \d/.test(l) && !l.includes(ver));
  assert.deepEqual(stale, []);
  assert.ok(t.split('\n')[0].includes(ver), 'the title line');
});

test('the release notes start with this version', () => {
  const notes = JSON.parse(readFileSync(new URL('release-notes.json', root), 'utf8'));
  assert.equal(Object.keys(notes)[0], ver);
});
