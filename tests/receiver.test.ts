// The public build's report receiver (reports-receiver/worker.js), run against a stand-in for
// Cloudflare's KV store and cache
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../reports-receiver/worker.js';

function kv() {
  const m = new Map<string, { v: unknown; meta?: unknown }>();
  return {
    m,
    async put(k: string, v: unknown, o: { metadata?: unknown } = {}) { m.set(k, { v, meta: o.metadata }); },
    async get(k: string, type?: string) { const e = m.get(k); if (!e) return null; return type === 'arrayBuffer' ? (e.v as Uint8Array).buffer : e.v; },
    async delete(k: string) { m.delete(k); },
    async list({ prefix }: { prefix: string }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: m.get(name)!.meta })), list_complete: true }; },
  };
}
const store = new Map<string, Response>();
(globalThis as any).caches = { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } } };
const env = { REPORTS: kv(), ADMIN_KEY: 'pa55-word' };
const call = (path: string, init: RequestInit = {}, ip = '1.2.3.4', client = 'pdf-editor') => worker.fetch(new Request('https://rx.example' + path, { ...init, headers: { 'cf-connecting-ip': ip, ...(client ? { 'x-report-client': client } : {}), ...(init.headers || {}) } }), env, {});
const auth = { Authorization: 'Basic ' + btoa('x:pa55-word') };
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64');

test('a report is stored privately; the list and the report need the password', async () => {
  let r = await call('/report', { method: 'POST', body: JSON.stringify({ kind: 'problem', version: '0.9.2', text: 'Ruler upside down <script>x</script>\nmore', screenshot: png }) });
  assert.equal(r.status, 200);
  r = await call('/report', { method: 'POST', body: JSON.stringify({ kind: 'crash', version: '0.9.2', message: 'TypeError: boom', log: 'l1\nl2' }) });
  assert.equal(r.status, 200);
  assert.equal((await call('/')).status, 401, 'no password: refused');
  assert.equal((await call('/', { headers: { Authorization: 'Basic ' + btoa('x:wrong') } })).status, 401);
  const list = await (await call('/', { headers: auth })).text();
  assert.ok(list.includes('TypeError: boom') && list.includes('Ruler upside down &lt;script&gt;') && !list.includes('<script>x'), 'listed, escaped');
  // (newest hour first; within the hour the order is not kept - no exact time is stored)
  const id = /href="\/r\/([\w-]+)">Ruler/.exec(list)![1];
  const one = await (await call('/r/' + id, { headers: auth })).text();
  assert.ok(one.includes('more') && one.includes('<img src="data:image/png;base64,' + png + '">'), 'the picture inline');
  assert.equal((await call('/r/' + id + '/delete', { method: 'POST', headers: auth })).status, 303);
  assert.ok(![...env.REPORTS.m.keys()].some((k) => k.endsWith(id)), 'deleted with its picture');
});

test('a JPEG picture is kept too; the time is kept to the hour only', async () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]).toString('base64');
  assert.equal((await call('/report', { method: 'POST', body: JSON.stringify({ kind: 'problem', version: '0.9.2', text: 'jpeg one', screenshot: jpg }) }, '6.6.6.6')).status, 200);
  const list = await (await call('/', { headers: auth })).text();
  const id = /href="\/r\/([\w-]+)">jpeg one/.exec(list)![1];
  const one = await (await call('/r/' + id, { headers: auth })).text();
  assert.ok(one.includes('data:image/jpeg;base64,'));
  assert.match(one, /received<\/th><td>\d{4}-\d\d-\d\dT\d\d:00:00\.000Z/);
});

test('not a report, too big, too many, a picture that is not a PNG: refused', async () => {
  assert.equal((await call('/report', { method: 'POST', body: 'hello' })).status, 400);
  assert.equal((await call('/report', { method: 'POST', body: JSON.stringify({ kind: 'spam', version: '1.0.0' }) })).status, 400);
  assert.equal((await call('/report', { method: 'POST', body: JSON.stringify({ kind: 'crash', version: 'x' }) })).status, 400);
  assert.equal((await call('/report', { method: 'POST', body: 'x'.repeat(1_300_000) }, '9.9.9.9')).status, 413);
  assert.equal((await call('/report', { method: 'POST', body: JSON.stringify({ kind: 'crash', version: '1.0.0' }) }, '8.8.8.8', '')).status, 400, 'without the app\'s header (a web page posting): refused');
  assert.equal((await call('/report')).status, 405);
  const before = env.REPORTS.m.size;
  await call('/report', { method: 'POST', body: JSON.stringify({ kind: 'problem', version: '1.0.0', text: 'gif', screenshot: Buffer.from('GIF89a....').toString('base64') }) }, '5.5.5.5');
  assert.equal(env.REPORTS.m.size, before + 1, 'stored without the picture');
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await call('/report', { method: 'POST', body: JSON.stringify({ kind: 'crash', version: '1.0.0' }) }, '7.7.7.7')).status;
  assert.equal(last, 429, 'more than 20 an hour from one address: refused');
});
