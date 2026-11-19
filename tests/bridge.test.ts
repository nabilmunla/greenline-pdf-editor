// PLAN 11.1: a Greenline copy that was a company copy moves itself to the web (electron/updater.cjs adopt /
// moveToFeed, electron/reports.cjs dropQueue). updater.cjs runs in plain node with the real update-worker in a child
// process; the "share" is a temp folder, the "feed" a local web server. Needs the dev signing key (keys/, never in
// a checkout without it: skipped there). The built app: tests/e2e-bridge.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Module, { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { haveKey, rig, ROOT, share, signed } from './bridge-rig';

const skip = !haveKey && 'no signing key in this checkout';
const DAY = 86400000;
const t = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);

// a web "feed" (GitHub's release, as a local server): /feed/latest.json says greenline
let server: http.Server, FEED = '';
let feedBody = '';
test('start the fake feed', { skip }, async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/feed/latest.json') { res.writeHead(200); res.end(feedBody); } else { res.writeHead(404); res.end('no'); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  FEED = `http://127.0.0.1:${(server.address() as { port: number }).port}/feed`;
  feedBody = signed({ version: '9.9.9', build: 'greenline', runtime: process.versions.electron, notes: ['From the web'], app: { file: 'app-v9.9.9.zip', sha256: 'a'.repeat(64), size: 5000 } });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f: () => boolean, ms = 6000) => { for (let i = 0; i < ms / 50 && !f(); i++) await sleep(50); return f(); };
const BASE = { recent: ['C:\\x\\a.pdf'], theme: 'dark', updateSource: '', lastRunVersion: '0.12.1' };

t('trigger A: a copy whose Go back copy is the company\'s moves at start, with no network', async () => {
  const SH = join(tmpdir(), 'bridge-share-a');
  const r = rig({ appOld: { version: '0.12.1' }, updateJson: { source: SH }, feedUrl: FEED, settings: { ...BASE, updateSource: SH } });
  const u = r.make();
  assert.equal(u.adopt(), true);
  const s = r.settings();
  assert.equal(s.updateSource, undefined, 'no share path in settings');
  assert.deepEqual(r.updateJsonNow(), { source: FEED });
  assert.equal(s.moved.shown, false);
  assert.equal(s.moved.from, '0.12.1');
  assert.ok(Math.abs(s.moved.at - Date.now()) < 5000);
  assert.equal(s.cameFrom.source, SH);
  assert.ok(Math.abs(s.cameFrom.until - (s.moved.at + 30 * DAY)) < 1000, '30 days');
  assert.equal(r.dropped, 1, 'queued reports dropped');
  // nothing else of the settings is touched
  assert.deepEqual(s.recent, BASE.recent); assert.equal(s.theme, 'dark'); assert.equal(s.lastRunVersion, '0.12.1');
  assert.equal(u.snapshot().source, FEED);
  assert.equal(u.snapshot().web, true);
  assert.equal(u.snapshot().ownSource, false, 'the feed is the default, not an own choice (no "Restore default")');
  assert.equal(u.snapshot().defaultFor, FEED);
  r.done();
});

t('trigger A with only update.json (no updateSource in settings) moves too', async () => {
  const SH = join(tmpdir(), 'bridge-share-a2');
  const r = rig({ updateJson: { source: SH }, feedUrl: FEED, settings: { recent: [] } });
  assert.equal(r.make().adopt(), true);
  assert.deepEqual(r.updateJsonNow(), { source: FEED });
  assert.equal(r.settings().cameFrom.source, SH);
  r.done();
});

t('trigger B: the folder\'s signed latest.json says "company" - the move, then the check answers from the feed', async () => {
  const SH = share(mkdtempSync(join(tmpdir(), 'bridge-share-b-')), { build: 'company' });
  const r = rig({ appOld: null, updateJson: { source: SH }, feedUrl: FEED, settings: { ...BASE, updateSource: SH } });
  const u = r.make();
  assert.ok(!(u.adopt && u.adopt()), 'no Go back copy: nothing at start'); // (0.12.1 has no adopt at all)
  const snap = await u.check(true);
  assert.equal(snap.state, 'available', 'answered by the web: ' + snap.state + ' ' + (snap.err || ''));
  assert.equal(snap.available, '9.9.9');
  assert.equal(snap.source, FEED);
  const s = r.settings();
  assert.equal(s.updateSource, undefined);
  assert.deepEqual(r.updateJsonNow(), { source: FEED });
  assert.equal(s.cameFrom.source, SH);
  assert.equal(s.moved.shown, false);
  assert.equal(r.dropped, 1);
  rmSync(SH, { recursive: true, force: true });
  r.done();
});

t('left alone: a folder that says "greenline", a branded Go back copy, the company build, no folder', async () => {
  // a Greenline copy on a folder whose release is Greenline's: the ordinary update, no move
  const SH = share(mkdtempSync(join(tmpdir(), 'bridge-share-g-')), { build: 'greenline' });
  let r = rig({ appOld: { version: '0.12.0', brand: 'greenline' }, updateJson: { source: SH }, feedUrl: FEED, settings: { ...BASE, updateSource: SH } });
  let u = r.make();
  assert.equal(u.adopt(), false);
  const snap = await u.check(true);
  assert.equal(snap.state, 'available');
  assert.equal(snap.source, SH);
  assert.equal(r.settings().moved, undefined); assert.equal(r.settings().updateSource, SH);
  assert.deepEqual(r.updateJsonNow(), { source: SH });
  assert.equal(r.dropped, 0);
  assert.equal(u.snapshot().previous, '0.12.0', 'a branded Go back copy goes back as always');
  r.done();
  // the company build, an unbranded Go back copy: today's behaviour (the old tests of the updater), here on a Greenline release
  r = rig({ appOld: { version: '0.12.0' }, updateJson: { source: SH }, feedUrl: FEED, build: 'company', settings: { recent: [] } });
  u = r.make();
  assert.equal(u.adopt(), false);
  const co = await u.check(true);
  assert.ok(co.state === 'error' && /another edition/.test(co.err), 'today: the other edition\'s release is refused (' + co.state + ')');
  assert.equal(u.snapshot().previous, '0.12.0');
  assert.equal(r.settings().moved, undefined);
  r.done();
  // "no updates" chosen (an empty source) is respected; a source already on the web has nothing to move
  r = rig({ updateJson: { source: '' }, feedUrl: FEED, settings: {} });
  assert.equal(r.make().adopt(), false); assert.deepEqual(r.updateJsonNow(), { source: '' });
  r.done();
  r = rig({ updateJson: { source: FEED }, feedUrl: FEED, settings: {} });
  assert.equal(r.make().adopt(), false); assert.equal(r.settings().moved, undefined);
  r.done();
  // a Greenline copy with no web address of its own (a source checkout) never moves
  r = rig({ updateJson: { source: SH }, feedUrl: '', settings: {} });
  assert.equal(r.make().adopt(), false); assert.deepEqual(r.updateJsonNow(), { source: SH });
  r.done();
  rmSync(SH, { recursive: true, force: true });
});

t('update.json not writable (an install for everyone): updateSource = the feed is the only trace, cleaned once update.json is web', async () => {
  const SH = join(tmpdir(), 'bridge-share-w');
  const r = rig({ updateJson: { source: SH }, feedUrl: FEED, settings: { ...BASE, updateSource: SH } });
  const denied = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  let u = r.make({ writeFile: denied });
  assert.equal(u.adopt(), true);
  assert.deepEqual(r.updateJsonNow(), { source: SH }, 'update.json untouched');
  assert.equal(r.settings().updateSource, FEED);
  assert.equal(r.settings().cameFrom.source, SH);
  assert.equal(u.snapshot().source, FEED);
  // the next start: update.json still names the folder - the setting stays
  u = r.make();
  assert.equal(u.adopt(), false);
  assert.equal(r.settings().updateSource, FEED);
  // the Greenline setup (11.2) wrote the feed into update.json: the setting goes
  writeFileSync(r.updateJson, JSON.stringify({ source: FEED }));
  u = r.make();
  assert.equal(u.adopt(), false);
  assert.equal(r.settings().updateSource, undefined);
  assert.equal(u.snapshot().source, FEED);
  assert.ok(r.settings().moved && r.settings().cameFrom, 'the record of the move stays');
  // or update.json gone
  r.setSettings({ ...r.settings(), updateSource: FEED });
  rmSync(r.updateJson);
  r.make().adopt();
  assert.equal(r.settings().updateSource, undefined);
  r.done();
});

t('a second start moves nothing and shows nothing; the notice is claimed once per start and seen once', async () => {
  const SH = join(tmpdir(), 'bridge-share-s');
  const r = rig({ updateJson: { source: SH }, feedUrl: FEED, settings: { ...BASE, updateSource: SH } });
  let u = r.make();
  assert.equal(u.adopt(), true);
  const moved = r.settings().moved;
  assert.equal(u.movedClaim(), true);
  assert.equal(u.movedClaim(), false, 'once per start (a second window)');
  // (closed without OK in some way - the next start asks again until it was seen)
  u = r.make();
  assert.equal(u.adopt(), false, 'the Go back copy is still the company\'s: not moved again');
  assert.deepEqual(r.settings().moved, moved);
  assert.equal(r.dropped, 1, 'the reports of the new terms are not dropped');
  assert.equal(u.movedClaim(), true);
  u.movedDone();
  u = r.make();
  assert.equal(u.adopt(), false);
  assert.equal(u.movedClaim(), false);
  assert.equal(r.settings().moved.shown, true);
  assert.equal(r.settings().moved.at, moved.at);
  r.done();
});

t('Go back: the setting names the folder again; offered only while cameFrom lives; dropped by a later version or after 30 days', async () => {
  const SH = join(tmpdir(), 'bridge-share-r');
  const helper = join(mkdtempSync(join(tmpdir(), 'bridge-helper-')), 'helper.sh');
  writeFileSync(helper, '#!/bin/sh\nexit 0\n'); chmodSync(helper, 0o755);
  process.env.PDFED_UPDATE_HELPER = helper;
  const clock = { t: Date.now() };
  const r = rig({ updateJson: { source: SH }, feedUrl: FEED, settings: { ...BASE, updateSource: SH } });
  let u = r.make({ now: () => clock.t });
  assert.equal(u.adopt(), true);
  assert.equal(u.snapshot().previous, '0.12.1', 'Go back is offered');
  assert.equal(u.chooseRollback(true), true);
  assert.equal(u.chooseRollback(), true);
  assert.equal(u.applyAtQuit(), true);
  const s = r.settings();
  assert.equal(s.updateSource, SH, 'the setting wins over update.json: the old version reads the folder');
  assert.equal(s.skipUpdate, '0.13.0', 'and is not offered again at once');
  assert.deepEqual(r.updateJsonNow(), { source: FEED }, 'update.json is left on the feed');
  // a copy of any other kind is not offered a way back to a company copy once cameFrom ran out
  clock.t += 31 * DAY;
  u = r.make({ now: () => clock.t });
  assert.equal(u.snapshot().previous, '', 'after 30 days: hidden');
  assert.equal(u.chooseRollback(true), false);
  u.adopt();
  assert.equal(r.settings().cameFrom, undefined, 'and removed by the app');
  assert.ok(r.settings().moved);
  // a later version drops it at its first start
  const r2 = rig({ updateJson: { source: SH }, feedUrl: FEED, settings: { ...BASE, updateSource: SH } });
  assert.equal(r2.make().adopt(), true);
  assert.ok(r2.settings().cameFrom);
  r2.make({ version: '0.13.1' }).adopt();
  assert.equal(r2.settings().cameFrom, undefined);
  assert.equal(r2.make({ version: '0.13.1' }).snapshot().previous, '');
  r.done(); r2.done();
  delete process.env.PDFED_UPDATE_HELPER;
});

t('PLAN 15.1: a second move (after Go back) is not announced again; a first one never seen still is', async () => {
  const SH = share(mkdtempSync(join(tmpdir(), 'bridge-share-m2-')), { build: 'company' });
  const r = rig({ updateJson: { source: SH }, feedUrl: FEED, settings: { ...BASE, updateSource: SH } });
  let u = r.make();
  assert.equal(u.adopt(), true);
  assert.equal(u.movedClaim(), true);
  u.movedDone();
  assert.equal(r.settings().moved.shown, true);
  // Go back leaves the settings naming the share (update.json stays on the feed)
  r.setSettings({ ...r.settings(), updateSource: SH });
  // the copy the share hands out checks the share's signed company release: moved again
  u = r.make();
  assert.equal(u.adopt(), false, 'adopt() does not move twice');
  const before = Date.now();
  await u.check(true);
  const s = r.settings();
  assert.equal(s.updateSource, undefined, 'moved again');
  assert.equal(s.moved.shown, true, 'the second move is silent');
  assert.ok(s.cameFrom.until > before + 30 * DAY - 5000 && s.cameFrom.until < Date.now() + 30 * DAY + 5000, 'cameFrom 30 days from this move');
  assert.equal(r.dropped, 2, 'queued reports dropped again');
  assert.equal(u.movedClaim(), false, 'not claimed at this start');
  assert.equal(r.make().movedClaim(), false, 'nor at the next');
  // guard, the other direction: a first move by trigger B, never seen
  const r2 = rig({ appOld: null, updateJson: { source: SH }, feedUrl: FEED, settings: { ...BASE, updateSource: SH } });
  const u2 = r2.make();
  await u2.check(true);
  assert.equal(r2.settings().moved.shown, false);
  assert.equal(r2.make().movedClaim(), true, 'claimed at the next start');
  rmSync(SH, { recursive: true, force: true });
  r.done(); r2.done();
});

t('PLAN 15.1: previousOld - the Go back copy is the company\'s unbranded one and still offered', async () => {
  const SH = join(tmpdir(), 'bridge-share-po');
  const alive = { ...BASE, updateSource: SH, cameFrom: { source: SH, until: Date.now() + 10 * DAY, version: '0.13.0' } };
  let r = rig({ appOld: { version: '0.12.1' }, updateJson: { source: FEED }, feedUrl: FEED, settings: alive });
  assert.equal(r.make().snapshot().previousOld, true, 'unbranded, cameFrom alive');
  r.done();
  r = rig({ appOld: { version: '0.13.0', brand: 'greenline' }, updateJson: { source: FEED }, feedUrl: FEED, settings: alive });
  assert.equal(r.make().snapshot().previousOld, false, 'branded');
  assert.equal(r.make().snapshot().previous, '0.13.0');
  r.done();
  r = rig({ appOld: { version: '0.12.1' }, updateJson: { source: FEED }, feedUrl: FEED, settings: { ...alive, cameFrom: { source: SH, until: Date.now() - DAY, version: '0.13.0' } } });
  assert.equal(r.make().snapshot().previousOld, false, 'cameFrom run out');
  r.done();
});

t('reports: dropQueue empties the queue and nothing else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-rep-'));
  const outbox = join(dir, 'reports-outbox');
  mkdirSync(outbox);
  for (const n of ['a.json', 'a.png', 'b.json', 'b.jpg']) writeFileSync(join(outbox, n), 'x');
  writeFileSync(join(dir, 'settings.json'), '{}');
  const M = Module as any, orig = M._load;
  M._load = function (name: string, ...rest: unknown[]) { return name === 'electron' ? { app: { getPath: () => dir }, utilityProcess: {} } : orig.call(this, name, ...rest); };
  let reports: any;
  try { reports = createRequire(join(ROOT, 'electron', 'x.cjs'))('./reports.cjs').create({ version: '0.13.0', readSettings: () => ({}), writeSettings() {}, log() {}, logFile: () => '', source: () => '', appName: 'PDF Editor', send() {}, endpoint: 'https://rx.example/report' }); } finally { M._load = orig; }
  reports.dropQueue();
  assert.deepEqual(readdirSync(outbox), []);
  assert.ok(existsSync(join(dir, 'settings.json')));
  rmSync(dir, { recursive: true, force: true });
});

test('stop the fake feed', { skip }, () => { server.close(); });
