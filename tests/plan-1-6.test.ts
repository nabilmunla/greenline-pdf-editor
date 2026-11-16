// PLAN 1.6 (AUDIT B6): the client's bookkeeping when a message cannot be posted, and when a new
// port is attached without a restart (calls posted to the old port can never be answered).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineClient } from '../src/engine/rpc';

interface FakePort { posted: { id: number }[]; closed: boolean; onmessage: ((e: { data: unknown }) => void) | null; throwOnPost: boolean; postMessage(m: { id: number }): void; close(): void; start(): void }
function fakePort(throwOnPost = false): FakePort {
  return {
    posted: [], closed: false, onmessage: null, throwOnPost,
    postMessage(m) { if (this.throwOnPost) throw new Error('could not be cloned'); this.posted.push(m); },
    close() { this.closed = true; },
    start() {},
  };
}
const asPort = (p: FakePort) => p as unknown as MessagePort;
const pending = (c: EngineClient) => (c as unknown as { pending: Map<number, unknown> }).pending;

test('1.6: postMessage throws in call(): busy back to 0, nothing pending, the call rejects', async () => {
  const c = new EngineClient('t');
  c.attach(asPort(fakePort(true)), false);
  await assert.rejects(c.call('tile', [1]), /could not be cloned/);
  assert.equal(c.busy, 0);
  assert.equal(pending(c).size, 0);
  // and the client still works on a port that does take messages
  const good = fakePort();
  c.attach(asPort(good), false);
  const p = c.call<string>('tile', [2]);
  assert.equal(c.busy, 1);
  good.onmessage!({ data: { id: good.posted[0].id, ok: true, value: 'x' } });
  assert.equal(await p, 'x');
  assert.equal(c.busy, 0);
});

test('1.6: attach(port, false) rejects calls posted to the previous port', async () => {
  const c = new EngineClient('t');
  // a call made before any port exists waits to be posted
  const early = c.call<string>('early');
  const first = fakePort();
  c.attach(asPort(first), false);
  assert.equal(first.posted.length, 1, 'the queued call went to the first port');
  const inFlight = c.call<string>('inflight');
  assert.equal(c.busy, 2);
  const second = fakePort();
  c.attach(asPort(second), false);
  await assert.rejects(inFlight, /connection was replaced/);
  await assert.rejects(early, /connection was replaced/);
  assert.equal(c.busy, 0);
  assert.equal(pending(c).size, 0);
  assert.equal(first.closed, true);
  // calls after that go to the new port and are answered
  const p = c.call<string>('after');
  second.onmessage!({ data: { id: second.posted[0].id, ok: true, value: 'ok' } });
  assert.equal(await p, 'ok');
  assert.equal(c.busy, 0);
});

test('1.6: a call queued while there is no port is not rejected by the first attach', async () => {
  const c = new EngineClient('t');
  const early = c.call<string>('early');
  const port = fakePort();
  c.attach(asPort(port), false);
  port.onmessage!({ data: { id: port.posted[0].id, ok: true, value: 'fine' } });
  assert.equal(await early, 'fine');
  assert.equal(c.busy, 0);
});
