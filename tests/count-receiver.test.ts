// 7.9 The user counter's receiver (reports-receiver/worker.js: POST /count, GET /counts), run with a
// fake KV (expirationTtl, metadata, list with prefix / cursor / metadata), a fake cache and a clock
// that moves by days. Counts the KV writes: the free plan allows 1,000 a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import worker from '../reports-receiver/worker.js';

const DAY = 86400000;
function fakeKv(clock: { t: number }, pageMax = 1000) {
  const m = new Map<string, { v: string; meta?: any; exp: number }>();
  const stats = { puts: [] as { k: string; day: number }[], lists: 0, gets: 0 };
  const alive = (k: string) => { const e = m.get(k); return e && e.exp > clock.t ? e : undefined; };
  return {
    m, stats,
    async put(k: string, v: string, o: { expirationTtl?: number; metadata?: any } = {}) {
      stats.puts.push({ k, day: Math.floor(clock.t / DAY) });
      m.set(k, { v, meta: o.metadata === undefined ? undefined : JSON.parse(JSON.stringify(o.metadata)), exp: o.expirationTtl ? clock.t + o.expirationTtl * 1000 : Infinity });
    },
    async get(k: string) { stats.gets++; return alive(k)?.v ?? null; },
    async getWithMetadata(k: string) { stats.gets++; const e = alive(k); return { value: e ? e.v : null, metadata: e?.meta ?? null }; },
    async delete(k: string) { m.delete(k); },
    async list({ prefix = '', limit = 1000, cursor }: { prefix?: string; limit?: number; cursor?: string }) {
      stats.lists++;
      const names = [...m.keys()].filter((k) => k.startsWith(prefix) && alive(k)).sort();
      const from = cursor ? Number(cursor) : 0, n = prefix === 'c:' ? Math.min(limit, pageMax) : limit;   // (small pages for the install keys only: the n: rows are far fewer than 1,000)
      const page = names.slice(from, from + n);
      const done = from + n >= names.length;
      return { keys: page.map((name) => ({ name, metadata: m.get(name)!.meta })), list_complete: done, cursor: done ? undefined : String(from + n) };
    },
  };
}

const cacheStore = new Map<string, string>();
(globalThis as any).caches = { default: {
  match: async (r: Request) => (cacheStore.has(r.url) ? new Response(cacheStore.get(r.url)) : undefined),
  put: async (r: Request, res: Response) => { cacheStore.set(r.url, await res.text()); },
} };

function setup(pageMax = 1000) {
  const clock = { t: Date.UTC(2026, 10, 20, 9, 30) };
  const kv = fakeKv(clock, pageMax);
  const env = { REPORTS: kv, ADMIN_KEY: 'pa55-word', CLOCK: () => clock.t };
  let ipn = 0;
  // (each call from its own address unless told: the per-address brake is a different test)
  const call = (path: string, init: RequestInit = {}, o: { ip?: string; client?: string | null } = {}) => worker.fetch(new Request('https://rx.example' + path, { ...init, headers: { 'cf-connecting-ip': o.ip ?? '203.0.113.' + (++ipn % 250 + 1) + '-' + ipn, ...(o.client === null ? {} : { 'x-report-client': o.client ?? 'pdf-editor' }), ...(init.headers || {}) } }), env, {});
  const id = () => randomBytes(16).toString('hex');
  const ping = (i: string, v = '0.12.0', os = 'win', o = {}) => call('/count', { method: 'POST', body: JSON.stringify({ id: i, v, os }) }, o);
  const auth = { Authorization: 'Basic ' + btoa('x:pa55-word') };
  const read = async () => (await call('/counts?format=json', { headers: auth })).json() as Promise<any>;
  return { clock, kv, env, call, id, ping, auth, read };
}
const days = (n: number) => n * DAY;

test('two ids on one day count 2 (day, week, month); the same id twice is one write', async () => {
  const s = setup();
  const a = s.id(), b = s.id();
  assert.equal((await s.ping(a)).status, 200);
  assert.equal((await s.ping(b, '0.12.0', 'linux')).status, 200);
  const before = s.kv.stats.puts.filter((p) => p.k.startsWith('c:')).length;
  assert.equal(before, 2);
  assert.equal((await s.ping(a)).status, 200);
  assert.equal((await s.ping(a)).status, 200);
  assert.equal(s.kv.stats.puts.filter((p) => p.k.startsWith('c:')).length, 2, 'the same id again the same day: no write');
  const j = await s.read();
  const pe = j.today.apps['pdf-editor'];
  assert.deepEqual([pe.day, pe.week, pe.month], [2, 2, 2]);
  assert.deepEqual(pe.byOs, { win: 1, linux: 1 });
  assert.deepEqual(pe.byVersion, { '0.12.0': 2 });
  // stored as designed: key from the hash, empty value, metadata in day numbers, 30 days
  const k = 'c:' + createHash('sha256').update(a).digest('hex').slice(0, 24);
  const e = s.kv.m.get(k)!;
  assert.equal(e.v, '');
  assert.deepEqual(e.meta, { last: Math.floor(s.clock.t / DAY), prev: null, v: '0.12.0', os: 'win' });
  assert.equal(e.exp, s.clock.t + 30 * DAY);
});

test('next day one id returns: yesterday\'s row {day 2}, today 1, week 2, written once', async () => {
  const s = setup();
  const a = s.id(), b = s.id();
  await s.ping(a); await s.ping(b, '0.11.0', 'mac');
  s.clock.t += days(1);
  await s.ping(a, '0.12.0', 'win');
  const yRow = 'n:' + new Date(s.clock.t - DAY).toISOString().slice(0, 10);
  const row = JSON.parse(s.kv.m.get(yRow)!.v);
  assert.deepEqual(row, { apps: { 'pdf-editor': { day: 2, week: 2, month: 2, byVersion: { '0.12.0': 1, '0.11.0': 1 }, byOs: { win: 1, mac: 1 } }, 'rev-radar': { day: 0, week: 0, month: 0, byVersion: {}, byOs: {} } } });
  assert.equal(s.kv.m.get(yRow)!.exp, s.clock.t + 400 * DAY);
  const j = await s.read();
  assert.deepEqual([j.today.total.day, j.today.total.week, j.today.total.month], [1, 2, 2]);
  assert.equal(j.days[0].date, yRow.slice(2));
  assert.equal(j.days[0].total.day, 2);
  // the other install returns too, and reads: still one write of yesterday's row
  await s.ping(b, '0.12.0', 'mac');
  await s.read(); await s.read();
  assert.equal(s.kv.stats.puts.filter((p) => p.k === yRow).length, 1);
  assert.deepEqual(JSON.parse(s.kv.m.get(yRow)!.v).apps['pdf-editor'].day, 2, 'not rewritten with later numbers');
});

test('a read on a new day closes yesterday too (nobody pinged yet); weeks and months move on', async () => {
  const s = setup();
  const a = s.id(), b = s.id();
  await s.ping(a);
  s.clock.t += days(3);
  await s.ping(b);                    // day 3: a seen 3 days ago
  s.clock.t += days(10);              // day 13
  const j = await s.read();           // closes day 12 (nobody pinged): day 0, week 0, month 2
  assert.deepEqual([j.today.total.day, j.today.total.week, j.today.total.month], [0, 0, 2]);
  const y = j.days.find((r: any) => r.date === new Date(s.clock.t - DAY).toISOString().slice(0, 10));
  assert.deepEqual([y.total.day, y.total.week, y.total.month], [0, 0, 2]);
});

test('a key 31 days old is gone; 29 days still counts', async () => {
  const s = setup();
  const a = s.id();
  await s.ping(a);
  s.clock.t += days(29);
  assert.equal((await s.read()).today.total.month, 1);
  s.clock.t += days(2);               // 31 days
  assert.equal((await s.read()).today.total.month, 0);
  assert.equal([...s.kv.m.keys()].filter((k) => k.startsWith('c:') && s.kv.m.get(k)!.exp > s.clock.t).length, 0);
  // it comes back as a new install (no earlier day)
  await s.ping(a);
  const j = await s.read();
  assert.deepEqual([j.today.total.day, j.today.total.month], [1, 1]);
});

test('wrong header or body: 400, nothing stored', async () => {
  const s = setup();
  const good = { id: s.id(), v: '0.12.0', os: 'win' };
  const post = (b: unknown, o: { client?: string | null } = {}) => s.call('/count', { method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b) }, o);
  assert.equal((await post(good, { client: null })).status, 400, 'no header');
  assert.equal((await post(good, { client: 'browser' })).status, 400, 'other header');
  assert.equal((await post(good, { client: 'rev-radar-x' })).status, 400, 'a near miss');
  assert.equal((await post(good, { client: 'PDF-Editor' })).status, 400, 'exact, not case-folded');
  for (const bad of ['hello', '', '[]', 'null', { ...good, id: 'abc' }, { ...good, id: good.id.toUpperCase() }, { ...good, id: good.id + '0' }, { ...good, id: [good.id] }, { ...good, v: '0.12' }, { ...good, v: 'x.y.z' }, { ...good, v: ['0.12.0'] },
    { ...good, os: 'windows' }, { ...good, os: 'ios' }, { id: good.id, v: good.v }, { ...good, extra: 1 }, { ...good, os: undefined }, { ...good, pad: 'x'.repeat(300) }]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad)?.slice(0, 60));
  }
  assert.equal((await s.call('/count')).status, 405);
  assert.equal(s.kv.m.size, 0, 'nothing stored');
  assert.equal(s.kv.stats.puts.length, 0);
  assert.equal((await post(good)).status, 200);
});

test('/counts needs the password', async () => {
  const s = setup();
  assert.equal((await s.call('/counts')).status, 401);
  assert.equal((await s.call('/counts?format=json', { headers: { Authorization: 'Basic ' + btoa('x:wrong') } })).status, 401);
  assert.equal(s.kv.stats.puts.length, 0, 'a refused read writes nothing');
  const page = await (await s.call('/counts', { headers: s.auth })).text();
  assert.ok(page.includes('User counts') && page.includes('(so far)'));
  const list = await (await s.call('/', { headers: s.auth })).text();
  assert.ok(list.includes('href="/counts"'), 'linked from the reports list');
});

test('the per-address brake: 60 pings an hour from one address, then 429; no address is stored', async () => {
  const s = setup();
  cacheStore.clear();
  const ip = '198.51.100.77';
  let last = 200;
  for (let i = 0; i < 61; i++) last = (await s.ping(s.id(), '0.12.0', 'win', { ip })).status;
  assert.equal(last, 429);
  assert.equal([...s.kv.m.keys()].filter((k) => k.startsWith('c:')).length, 60);
  assert.equal((await s.ping(s.id(), '0.12.0', 'win', { ip: '198.51.100.78' })).status, 200, 'another address');
  s.clock.t += 3600000;
  assert.equal((await s.ping(s.id(), '0.12.0', 'win', { ip })).status, 200, 'the next hour');
  assert.ok(![...cacheStore.keys()].some((k) => k.includes('198.51.100')), 'the cache holds a hash, not the address');
});

test('no stored key, value or metadata holds an id or an IP address', async () => {
  const s = setup();
  cacheStore.clear();
  const ids = [s.id(), s.id(), s.id()], ips = ['198.51.100.5', '203.0.113.9', '2001:db8::1'];
  for (let d = 0; d < 3; d++) {
    for (const [n, i] of ids.entries()) await s.ping(i, n ? '0.12.0' : '0.11.0', 'linux', { ip: ips[n] });
    await Promise.all(ids.map((i, n) => s.ping(i, '0.12.0', 'mac', { ip: ips[n] })));
    s.clock.t += DAY;
  }
  await s.read();
  const blob = JSON.stringify([...s.kv.m.entries()]) + JSON.stringify([...cacheStore.entries()]);
  for (const x of [...ids, ...ips, ...ids.map((i) => i.slice(0, 12))]) assert.ok(!blob.includes(x), 'found ' + x);
  assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(blob.replace(/\d+\.\d+\.\d+/g, '')), 'no dotted address');
  for (const [k, e] of s.kv.m) if (k.startsWith('c:')) { assert.equal(e.v, ''); assert.match(k, /^c:[0-9a-f]{24}$/); }
});

test('KV write budget: one write per install per day plus at most one n: row a day; lists page by cursor', async () => {
  const s = setup(7);                 // pages of 7 keys: the listing must follow the cursor
  const N = 30, DAYS = 5;
  const ids = Array.from({ length: N }, () => s.id());
  for (let d = 0; d < DAYS; d++) {
    for (const i of ids) { await s.ping(i); await s.ping(i); await s.ping(i); }   // three starts a day
    await s.read();
    s.clock.t += DAY;
  }
  const perDay = new Map<number, { c: number; n: number; other: number }>();
  for (const p of s.kv.stats.puts) {
    const r = perDay.get(p.day) || { c: 0, n: 0, other: 0 };
    if (p.k.startsWith('c:')) r.c++; else if (p.k.startsWith('n:')) r.n++; else r.other++;
    perDay.set(p.day, r);
  }
  assert.equal(perDay.size, DAYS);
  for (const [, r] of perDay) assert.deepEqual(r, { c: N, n: 1, other: 0 });
  assert.ok(Math.max(...[...perDay.values()].map((r) => r.c + r.n)) <= N + 1);
  // (a day's writes stay far under 1,000 until ~990 installs; the count itself reads the keys' metadata)
  const wrote = s.kv.stats.puts.length;
  assert.equal(wrote, DAYS * (N + 1), 'the whole run');
  const j = await s.read();       // the new day's first read closes the last day: one write, once
  await s.read();
  assert.equal(s.kv.stats.puts.length, wrote + 1);
  assert.equal(j.today.total.month, N, 'all 30 found across several pages');
  const dayBefore = j.days[0];
  assert.deepEqual([dayBefore.total.day, dayBefore.total.week, dayBefore.total.month], [N, N, N]);
});

// ------------------------------------------------------------------ 7.18: two apps, kept apart
const PE = 'pdf-editor', RR = 'rev-radar';
const hashOf = (i: string) => createHash('sha256').update(i).digest('hex').slice(0, 24);
const rr = { client: RR };

test('both apps are counted apart: same install number in both = two installs; keys, rows, JSON', async () => {
  const s = setup();
  const a = s.id(), b = s.id(), c = s.id();
  assert.equal((await s.ping(a, '0.12.0', 'win')).status, 200);
  assert.equal((await s.ping(a, '1.0.0', 'mac', rr)).status, 200, 'the same number in the other app is another install');
  assert.equal((await s.ping(b, '1.0.0', 'win', rr)).status, 200);
  assert.equal((await s.ping(c, '1.0.1', 'linux', rr)).status, 200);
  assert.ok(s.kv.m.has('c:' + hashOf(a)), 'the PDF Editor: c:<hash>');
  assert.ok(s.kv.m.has('c:rev-radar:' + hashOf(a)), 'Rev Radar: c:rev-radar:<hash>');
  const j = await s.read();
  const p = j.today.apps[PE], r = j.today.apps[RR];
  assert.deepEqual([p.day, p.week, p.month, p.byOs, p.byVersion], [1, 1, 1, { win: 1 }, { '0.12.0': 1 }]);
  assert.deepEqual([r.day, r.week, r.month, r.byOs, r.byVersion], [3, 3, 3, { mac: 1, win: 1, linux: 1 }, { '1.0.0': 2, '1.0.1': 1 }]);
  assert.deepEqual(j.today.total, { day: 4, week: 4, month: 4 });
  // each app dedupes on its own: again the same day = no write; the other app's first ping still writes
  const w = s.kv.stats.puts.length;
  await s.ping(a, '0.12.0', 'win'); await s.ping(a, '1.0.0', 'mac', rr);
  assert.equal(s.kv.stats.puts.length, w);
  // the page shows each app and the total
  const page = await (await s.call('/counts', { headers: s.auth })).text();
  assert.ok(page.includes('<h2>PDF Editor</h2>') && page.includes('<h2>Rev Radar</h2>') && page.includes('Both apps together'));
  // metadata of a Rev Radar key is the same shape
  assert.deepEqual(s.kv.m.get('c:rev-radar:' + hashOf(b))!.meta, { last: Math.floor(s.clock.t / DAY), prev: null, v: '1.0.0', os: 'win' });
});

test('a third client is refused: 400 on /count and /report, nothing stored', async () => {
  const s = setup();
  for (const client of ['third-app', 'rev-radar2', 'pdf-editor,rev-radar', '', 'Rev Radar']) {
    assert.equal((await s.ping(s.id(), '1.0.0', 'win', { client })).status, 400, client);
    assert.equal((await s.call('/report', { method: 'POST', body: JSON.stringify({ kind: 'crash', version: '1.0.0' }) }, { client })).status, 400, client + ' report');
  }
  assert.equal((await s.ping(s.id(), '1.0.0', 'win', { client: null })).status, 400, 'no header');
  assert.equal(s.kv.m.size, 0);
  assert.equal(s.kv.stats.puts.length, 0);
});

test('old app-less c: keys and old flat n: rows are the PDF Editor\'s', async () => {
  const s = setup();
  const today = Math.floor(s.clock.t / DAY);
  // as the first version of the receiver wrote them
  const old = (name: string, last: number, v: string, os: string) => s.kv.m.set(name, { v: '', meta: { last, prev: null, v, os }, exp: Infinity });
  old('c:' + 'a'.repeat(24), today - 1, '0.12.0', 'win');
  old('c:' + 'b'.repeat(24), today - 5, '0.12.0', 'mac');
  s.kv.m.set('n:' + new Date((today - 1) * DAY).toISOString().slice(0, 10), { v: JSON.stringify({ day: 1, week: 2, month: 2, byVersion: { '0.12.0': 1 }, byOs: { win: 1 } }), meta: { day: 1, week: 2, month: 2 }, exp: Infinity });
  await s.ping(s.id(), '1.0.0', 'win', rr);
  const j = await s.read();
  assert.deepEqual([j.today.apps[PE].week, j.today.apps[PE].month], [2, 2], 'both old keys are the PDF Editor\'s');
  assert.deepEqual([j.today.apps[RR].day, j.today.apps[RR].month], [1, 1]);
  const row = j.days[0];
  assert.deepEqual([row.apps[PE].day, row.apps[PE].week, row.apps[PE].month, row.apps[PE].byOs], [1, 2, 2, { win: 1 }], 'the old flat row reads as the PDF Editor\'s');
  assert.deepEqual([row.apps[RR].day, row.total.day], [0, 1]);
  assert.equal(s.kv.stats.puts.filter((p) => p.k.startsWith('n:')).length, 0, 'the old row is not rewritten');
});

test('the n: row holds both apps, one write a day for everything; the key\'s metadata carries the numbers', async () => {
  const s = setup();
  const a = s.id(), b = s.id();
  await s.ping(a, '0.12.0', 'win'); await s.ping(b, '1.0.0', 'mac', rr);
  s.clock.t += DAY;
  await s.ping(b, '1.0.0', 'mac', rr);       // Rev Radar's first ping of the day closes yesterday
  await s.ping(a, '0.12.0', 'win');          // the PDF Editor's finds it done
  await s.read();
  const name = 'n:' + new Date(s.clock.t - DAY).toISOString().slice(0, 10);
  const rowsToday = s.kv.stats.puts.filter((p) => p.k.startsWith('n:') && p.day === Math.floor(s.clock.t / DAY));
  assert.equal(rowsToday.length, 1, 'one row on the new day, not one per app');
  const e = s.kv.m.get(name)!;
  assert.deepEqual(JSON.parse(e.v).apps[PE], { day: 1, week: 1, month: 1, byVersion: { '0.12.0': 1 }, byOs: { win: 1 } });
  assert.deepEqual(JSON.parse(e.v).apps[RR], { day: 1, week: 1, month: 1, byVersion: { '1.0.0': 1 }, byOs: { mac: 1 } });
  assert.deepEqual(e.meta, { a: { [PE]: [1, 1, 1], [RR]: [1, 1, 1] } });
  assert.ok(JSON.stringify(e.meta).length < 1000, 'metadata limit is 1 KB');
});

test('write budget with both apps: one write per install per day per app, one n: row a day; /counts under 50 store calls', async () => {
  const s = setup(7);
  const N = 20, DAYS = 40;
  const ids = Array.from({ length: N }, () => s.id());
  let readCalls = 0;
  for (let d = 0; d < DAYS; d++) {
    for (const i of ids) { await s.ping(i); await s.ping(i, '1.0.0', 'win', rr); await s.ping(i, '1.0.0', 'win', rr); await s.ping(i); }
    const before = s.kv.stats.gets + s.kv.stats.lists + s.kv.stats.puts.length;
    await s.read();
    readCalls = Math.max(readCalls, s.kv.stats.gets + s.kv.stats.lists + s.kv.stats.puts.length - before);
    s.clock.t += DAY;
  }
  const perDay = new Map<number, { c: number; n: number }>();
  for (const p of s.kv.stats.puts) {
    const r = perDay.get(p.day) || { c: 0, n: 0 };
    if (p.k.startsWith('c:')) r.c++; else if (p.k.startsWith('n:')) r.n++; else assert.fail('other write ' + p.k);
    perDay.set(p.day, r);
  }
  assert.equal(perDay.size, DAYS);
  for (const [, r] of perDay) assert.deepEqual(r, { c: 2 * N, n: 1 });
  // a /counts read that has to close a day and read 25 detail rows, with 40 installs spread over 7-key list pages: the whole count's store calls
  // (lists of c: pages + 1 read of yesterday's row + 1 write + 1 list of n: + up to 25 row reads) with both apps
  s.clock.t += DAY;
  const g0 = s.kv.stats.gets, l0 = s.kv.stats.lists, p0 = s.kv.stats.puts.length;
  const j = await s.read();
  const calls = (s.kv.stats.gets - g0) + (s.kv.stats.lists - l0) + (s.kv.stats.puts.length - p0);
  assert.equal(j.days.length, DAYS + 1);
  assert.equal(s.kv.stats.puts.length - p0, 1, 'one write: the n: row');
  assert.ok(calls <= 50, 'store calls in one /counts: ' + calls);
  assert.ok(readCalls <= 50, 'store calls in one /counts: ' + readCalls);
  // with the real page size (1,000 keys a page) a read costs the same with two apps as with one: the
  // keys are listed together and one n: value holds both apps (here: 1 list of c: + 1 read + 1 write + 1 list of n: + 2 row reads)
  const calls2 = async (both: boolean) => {
    const x = setup();
    for (let i = 0; i < 30; i++) { const id = x.id(); await x.ping(id); if (both) await x.ping(id, '1.0.0', 'win', rr); }
    x.clock.t += DAY;
    const q0 = x.kv.stats.gets + x.kv.stats.lists + x.kv.stats.puts.length;
    await x.read();
    return x.kv.stats.gets + x.kv.stats.lists + x.kv.stats.puts.length - q0;
  };
  assert.equal(await calls2(true), await calls2(false), 'both apps: no more calls than one');
});

// ------------------------------------------------------------------ 7.18: the reports list, per app
test('reports: an App column, a filter by app, old reports (no app) are the PDF Editor\'s', async () => {
  const s = setup();
  const send = (client: string, body: object) => s.call('/report', { method: 'POST', body: JSON.stringify({ version: '1.0.0', ...body }) }, { client });
  assert.equal((await send(PE, { kind: 'crash', app: 'PDF Editor', message: 'pdf boom' })).status, 200);
  assert.equal((await send(RR, { kind: 'problem', app: 'Rev Radar', text: 'radar misses a line' })).status, 200);
  // an old report: stored before the second app existed, no app in it or in its metadata
  s.kv.m.set('r:9999999999-oldoldoldold', { v: JSON.stringify({ kind: 'crash', version: '0.9.2', message: 'old boom' }), meta: { kind: 'crash', version: '0.9.2', time: '2026-01-01T00:00:00.000Z', title: 'old boom', shot: false }, exp: Infinity });
  const page = async (q = '') => (await s.call('/' + q, { headers: s.auth })).text();
  const all = await page();
  assert.ok(all.includes('<th>App</th>'));
  const rowOf = (h: string, t: string) => new RegExp('<tr>[^]*?</tr>', 'g').exec(h.slice(h.indexOf(t) - 200)) && h.slice(h.lastIndexOf('<tr>', h.indexOf(t)), h.indexOf('</tr>', h.indexOf(t)));
  assert.ok(rowOf(all, 'pdf boom')!.includes('<td>PDF Editor</td>'));
  assert.ok(rowOf(all, 'radar misses')!.includes('<td>Rev Radar</td>'));
  assert.ok(rowOf(all, 'old boom')!.includes('<td>PDF Editor</td>'), 'old = PDF Editor');
  assert.ok(all.includes('href="/?app=rev-radar"') && all.includes('href="/?app=pdf-editor"'));
  const onlyRr = await page('?app=rev-radar');
  assert.ok(onlyRr.includes('radar misses') && !onlyRr.includes('pdf boom') && !onlyRr.includes('old boom'));
  const onlyPe = await page('?app=pdf-editor');
  assert.ok(onlyPe.includes('pdf boom') && onlyPe.includes('old boom') && !onlyPe.includes('radar misses'), 'the filter keeps old reports with the PDF Editor');
  assert.ok((await page('?app=nonsense')).includes('radar misses'), 'an unknown app: no filter');
  // the report's own page names the app; the stored report keeps the app field it came with
  const id = /href="\/r\/([\w-]+)">radar misses/.exec(all)![1];
  const one = await (await s.call('/r/' + id, { headers: s.auth })).text();
  assert.ok(one.includes('<th>app</th><td>Rev Radar</td>'));
  assert.equal(JSON.parse(s.kv.m.get('r:' + id)!.v).app, 'Rev Radar');
  assert.ok((await (await s.call('/r/9999999999-oldoldoldold', { headers: s.auth })).text()).includes('<th>app</th><td>PDF Editor</td>'));
});

test('reports page, one app: its reports shown even when the newest 200 are all the other app\'s (sweep S16)', async () => {
  const s = setup();
  const meta = (app: string, i: number) => ({ kind: 'crash', version: '1.0.0', time: '2026-11-17T08:00:00Z', title: 'x' + i, shot: false, app });
  for (let i = 0; i < 450; i++) s.kv.m.set('r:a' + String(i).padStart(4, '0'), { v: '{}', meta: meta(PE, i), exp: Infinity });
  for (let i = 0; i < 3; i++) s.kv.m.set('r:b' + i, { v: '{}', meta: meta(RR, i), exp: Infinity });
  const page = await (await s.call('/?app=rev-radar', { headers: s.auth })).text();
  assert.equal(page.split('<td>Rev Radar</td>').length - 1, 3, 'the three Rev Radar reports');
  assert.ok(!page.includes('<td>PDF Editor</td>'));
  assert.ok(!page.includes('Older'), 'nothing older for it');
});
