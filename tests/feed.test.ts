// Updates from the web (feed.cjs): GitHub releases or any web address - the addresses asked for
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const feed = require('../electron/feed.cjs');

test('a GitHub repository: the newest release, each package from its own version', () => {
  const r = 'https://github.com/someone/greenline-pdf-editor';
  for (const v of [r, r + '/', r + '.git']) assert.deepEqual(feed.github(v), { owner: 'someone', repo: 'greenline-pdf-editor' });
  assert.equal(feed.latestUrl(r), r + '/releases/latest/download/latest.json');
  assert.equal(feed.fileUrl(r, '1.2.3', 'app-v1.2.3.zip'), r + '/releases/download/v1.2.3/app-v1.2.3.zip');
  assert.equal(feed.fileUrl(r, '1.2.3', 'PDF Editor Setup 1.2.3.exe'), r + '/releases/download/v1.2.3/PDF%20Editor%20Setup%201.2.3.exe');
  // (a file name can't reach outside the release)
  assert.equal(feed.fileUrl(r, '1.2.3', '../../x/evil.zip'), r + '/releases/download/v1.2.3/evil.zip');
  assert.equal(feed.releasePage(r, '1.2.3'), r + '/releases/tag/v1.2.3');
  assert.equal(feed.releasePage(r, ''), r + '/releases/latest');
});

test('any other web address: files side by side; folders are not the web', () => {
  const w = 'http://127.0.0.1:8080/feed';
  assert.ok(feed.isWeb(w) && feed.isWeb('HTTPS://x.y/') && !feed.isWeb('\\\\server\\share\\PDF Editor') && !feed.isWeb('C:\\updates') && !feed.isWeb(''));
  assert.equal(feed.github(w), null);
  assert.equal(feed.github('https://github.com/someone'), null);
  assert.equal(feed.latestUrl(w + '/'), w + '/latest.json');
  assert.equal(feed.fileUrl(w, '1.0.0', 'app-v1.0.0.zip'), w + '/app-v1.0.0.zip');
  assert.equal(feed.releasePage(w, '1.0.0'), w);
  assert.equal(feed.issueUrl(w, 't', 'b'), '', 'no issues page outside GitHub');
});

test('a problem report as a new GitHub issue: text filled in, cut to a length browsers take', () => {
  const r = 'https://github.com/someone/repo';
  const u = feed.issueUrl(r, 'Crash on open', 'It crashed & burned\nVersion 1.0');
  assert.ok(u.startsWith(r + '/issues/new?title=Crash%20on%20open&body='));
  assert.equal(decodeURIComponent(u.split('body=')[1]), 'It crashed & burned\nVersion 1.0');
  const long = feed.issueUrl(r, 'x', 'ي'.repeat(20000));
  assert.ok(long.length <= 7000 && decodeURIComponent(long.split('body=')[1]).endsWith('…'), 'long text (Arabic: 6 bytes each in the address) cut, marked');
});
