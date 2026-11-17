// 7.10 The user counter in the app (electron/count.cjs), run with a fake fetch, a fake clock and a
// settings file in a temp folder. Greenline only: the company build does nothing and makes no id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COUNT_BODY, COUNT_HINT, COUNT_KEEP, COUNT_OFF, COUNT_SWITCH, COUNT_TITLE } from '../src/ui/counttext';

const { create, countUrl } = createRequire(import.meta.url)('../electron/count.cjs');
const DAY = 86400000;
const URL_ = 'https://rx.example/count';

function rig(o: { brand?: string; url?: string; fetch?: (u: string, i: any) => Promise<any>; platform?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'count-'));
  const file = join(dir, 'settings.json');
  const clock = { t: Date.UTC(2026, 10, 20, 9, 30) };
  const calls: { url: string; init: any }[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const readSettings = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  const writeSettings = (s: unknown) => writeFileSync(file, JSON.stringify(s, null, 2));
  const fetch = o.fetch || (async () => ({ ok: true, status: 200 }));
  // (a new object = a new start of the app on the same settings file: what an update does)
  const make = () => create({
    brand: o.brand ?? 'greenline', version: '0.12.0', url: o.url ?? URL_, readSettings, writeSettings, platform: o.platform || 'win32',
    now: () => clock.t, fetch: async (u: string, i: any) => { calls.push({ url: u, init: i }); return fetch(u, i); },
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clearTimeout: (t: any) => { if (t) t.live = false; },
    timeoutMs: 40,
  });
  return { dir, file, clock, calls, timers, readSettings, make, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const body = (c: { init: any }) => JSON.parse(c.init.body);

test('company build: no request, no id, no pop-up - even answered and switched on', async () => {
  const r = rig({ brand: 'company' });
  const c = r.make();
  assert.equal(c.active, false);
  assert.deepEqual(c.state(), { active: false, asked: true, on: false });
  assert.equal(c.claim(), false);
  c.start();
  c.answer(true); c.set(true);
  assert.equal(await c.tick(), 'inactive');
  assert.equal(r.calls.length, 0);
  assert.equal(r.timers.length, 0, 'no timer either');
  assert.ok(!existsSync(r.file), 'no settings written, so no id');
  // (no brand at all - a source checkout - is the company build too; and no receiver = nothing to count to)
  assert.equal(rig({ brand: '' }).make().active, false);
  assert.equal(rig({ url: '' }).make().active, false);
  r.done();
});

test('Greenline before the answer: no request, no id; the pop-up is asked once per start', async () => {
  const r = rig();
  const c = r.make();
  assert.deepEqual(c.state(), { active: true, asked: false, on: true });
  assert.equal(await c.tick(), 'unasked');
  assert.equal(r.calls.length, 0);
  assert.equal(r.readSettings().installId, undefined, 'no id before the first ping');
  assert.equal(c.claim(), true);
  assert.equal(c.claim(), false, 'once per start');
  // an update from 0.11.0: settings with no counter keys at all - still unasked
  writeFileSync(r.file, JSON.stringify({ author: 'x', recent: [] }));
  assert.equal(await r.make().tick(), 'unasked');
  assert.equal(r.calls.length, 0);
  r.done();
});

test('"Turn it off": never a request, no id in settings', async () => {
  const r = rig();
  const c = r.make();
  c.start();
  c.answer(false);
  assert.deepEqual(c.state(), { active: true, asked: true, on: false });
  for (let i = 0; i < 3; i++) { assert.equal(await c.tick(), 'off'); r.clock.t += DAY; }
  assert.equal(r.calls.length, 0);
  const s = r.readSettings();
  assert.equal(s.userCount, false);
  assert.equal(s.countAsked, true);
  assert.ok(!('installId' in s));
  assert.equal(r.make().claim(), false, 'answered: not asked again');
  r.done();
});

test('on: one request a day with exactly id, v, os; the same id after a reload; none the second start that day', async () => {
  const r = rig();
  let c = r.make();
  c.answer(true);
  assert.equal(r.readSettings().installId, undefined, 'answering makes no id: the first ping does');
  assert.equal(await c.tick(), 'sent');
  assert.equal(r.calls.length, 1);
  const c1 = r.calls[0];
  assert.equal(c1.url, URL_);
  assert.equal(c1.init.method, 'POST');
  assert.equal(c1.init.headers['X-Report-Client'], 'pdf-editor');
  const b = body(c1);
  assert.deepEqual(Object.keys(b).sort(), ['id', 'os', 'v']);
  assert.match(b.id, /^[0-9a-f]{32}$/);
  assert.equal(b.v, '0.12.0');
  assert.equal(b.os, 'win');
  assert.equal(r.readSettings().installId, b.id);
  assert.equal(r.readSettings().countDay, '2026-11-20');
  // the same day, again and after a restart: nothing
  assert.equal(await c.tick(), 'today');
  r.clock.t += 5 * 3600000; // 14:30 the same UTC day
  c = r.make();
  assert.equal(await c.tick(), 'today');
  assert.equal(r.calls.length, 1);
  // next UTC day, after an update (a new start on the same settings): one more, the same id
  r.clock.t = Date.UTC(2026, 10, 21, 0, 5);
  c = r.make();
  assert.equal(await c.tick(), 'sent');
  assert.equal(r.calls.length, 2);
  assert.deepEqual(body(r.calls[1]), b);
  // (the day is UTC: 23:59 UTC and 00:01 UTC are two days)
  assert.equal(await c.tick(), 'today');
  r.clock.t = Date.UTC(2026, 10, 21, 23, 59, 59);
  assert.equal(await c.tick(), 'today');
  r.clock.t += 2000;
  assert.equal(await c.tick(), 'sent');
  assert.equal(r.calls.length, 3);
  r.done();
});

test('the OS name: win, linux, mac', async () => {
  for (const [p, os] of [['win32', 'win'], ['linux', 'linux'], ['darwin', 'mac'], ['freebsd', 'linux']]) {
    const r = rig({ platform: p });
    const c = r.make(); c.answer(true); await c.tick();
    assert.equal(body(r.calls[0]).os, os);
    r.done();
  }
});

test('timers: the first try 60 s after start, then every 6 h; a "keep" answer tries again soon', async () => {
  const r = rig();
  const c = r.make();
  c.start();
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0].ms, 60000);
  r.timers[0].fn(); // (unanswered: nothing is sent)
  await new Promise((x) => setImmediate(x));
  await new Promise((x) => setImmediate(x));
  assert.equal(r.calls.length, 0);
  const next = r.timers[r.timers.length - 1];
  assert.equal(next.ms, 6 * 3600000);
  c.answer(true);
  assert.equal(r.timers[r.timers.length - 1].ms, 60000);
  assert.equal(next.live, false, 'the 6 h timer was replaced');
  c.stop();
  assert.equal(r.timers[r.timers.length - 1].live, false);
  r.done();
});

test('switched off: no ping and the id is deleted; switched on again: a new id', async () => {
  const r = rig();
  const c = r.make();
  c.answer(true);
  await c.tick();
  const id1 = body(r.calls[0]).id;
  assert.equal(r.readSettings().installId, id1);
  c.set(false);
  let s = r.readSettings();
  assert.ok(!('installId' in s), 'id deleted');
  assert.equal(s.userCount, false);
  r.clock.t += 3 * DAY;
  assert.equal(await c.tick(), 'off');
  assert.equal(await r.make().tick(), 'off');
  assert.equal(r.calls.length, 1);
  c.set(true);
  assert.equal(await c.tick(), 'sent');
  const id2 = body(r.calls[1]).id;
  assert.match(id2, /^[0-9a-f]{32}$/);
  assert.notEqual(id2, id1);
  // switched off while a ping is on its way: nothing of it is written back
  r.clock.t += DAY;
  let release: () => void = () => {};
  const slow = rig({ fetch: () => new Promise((res) => { release = () => res({ ok: true }); }) });
  const sc = slow.make(); sc.answer(true);
  const p = sc.tick();
  await new Promise((x) => setImmediate(x));
  sc.set(false);
  release();
  assert.equal(await p, 'sent');
  assert.ok(!('installId' in slow.readSettings()) && !('countDay' in slow.readSettings()));
  slow.done(); r.done();
});

test('receiver down: silent (no error, no report, no queue); tried again at the next try, same id', async () => {
  let mode: 'refuse' | 'status' | 'hang' | 'ok' = 'refuse';
  const r = rig({ fetch: (_u, i) => (mode === 'refuse' ? Promise.reject(new Error('connect ECONNREFUSED')) : mode === 'status' ? Promise.resolve({ ok: false, status: 503 }) : mode === 'hang' ? new Promise(() => {}) : Promise.resolve({ ok: true, status: 200 })) });
  const c = r.make();
  c.answer(true);
  const before = JSON.stringify(r.readSettings());
  for (const m of ['refuse', 'status', 'hang'] as const) {
    mode = m;
    const t0 = Date.now();
    assert.equal(await c.tick(), 'failed', m);
    assert.ok(Date.now() - t0 < 2000, 'the 5 s limit (40 ms here) holds for ' + m);
    assert.equal(r.readSettings().countDay, undefined, 'a failure is not a ping');
  }
  assert.equal(r.calls.length, 3);
  // nothing but the id was written; no other files (no queue, no report)
  const s = r.readSettings();
  assert.deepEqual(Object.keys(s).sort(), ['countAsked', 'installId', 'userCount']);
  assert.ok(JSON.stringify(s).length > before.length);
  mode = 'ok';
  assert.equal(await c.tick(), 'sent');
  assert.deepEqual(new Set(r.calls.map((x) => body(x).id)).size, 1, 'one id through all the tries');
  // unreadable settings: nothing is sent
  const bad = rig();
  writeFileSync(bad.file, '{ not json');
  const bc = create({ brand: 'greenline', version: '0.12.0', url: URL_, readSettings: () => { throw new Error('locked'); }, writeSettings: () => { throw new Error('locked'); }, fetch: async () => { throw new Error('no'); } });
  assert.equal(await bc.tick(), 'unasked');
  bad.done(); r.done();
});

test('the receiver address comes from the report receiver\'s address', () => {
  assert.equal(countUrl('https://greenline-reports.x.workers.dev/report'), 'https://greenline-reports.x.workers.dev/count');
  assert.equal(countUrl('https://greenline-reports.x.workers.dev'), 'https://greenline-reports.x.workers.dev/count');
  assert.equal(countUrl('https://greenline-reports.x.workers.dev/'), 'https://greenline-reports.x.workers.dev/count');
  assert.equal(countUrl(''), '');
  assert.equal(countUrl('file:///etc/passwd'), '');
});

test('the built strings equal the shared text (claude/user-counter-popup.md)', () => {
  assert.equal(COUNT_TITLE, 'This app counts its users');
  assert.deepEqual(COUNT_BODY, [
    'This app counts how many people use it, to see how popular it is. Nothing more. It helps a lot.',
    'It takes no information about you, your computer or your files. Once a day it sends only a random number (not linked to you), the app version, and Windows or Linux.',
    'You can turn it off now, or later in Settings › Privacy.',
  ]);
  assert.equal(COUNT_KEEP, 'Keep it on');
  assert.equal(COUNT_OFF, 'Turn it off');
  assert.equal(COUNT_SWITCH, 'Count me as a user of this app');
  assert.equal(COUNT_HINT, 'Once a day, this app sends a random number, its version, and Windows or Linux, only to count users; nothing about you, your computer or your files is sent.');
});
