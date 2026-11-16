// PLAN 3.9 (D6): an engine runs short calls (text, snap, links) ahead of the tiles queued, and
// drops view tiles of a scale the window no longer wants before drawing them; the window is told
// which call went ahead (so a crash then blames that call, not the oldest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallQueue, VIEW_TILE, type QCall } from '../src/engine/callq';
import { EngineClient } from '../src/engine/rpc';

let seq = 0;
const vt = (doc: string, scale: number, page = 0): QCall => ({ method: VIEW_TILE, args: [doc, page, scale, 0, 0, 512, 512], seq: seq++ });
const call = (method: string, ...args: unknown[]): QCall => ({ method, args, seq: seq++ });
const drain = (q: CallQueue<QCall>) => { const out: string[] = []; for (;;) { const n = q.next(); for (const s of n.stale) out.push('stale ' + s.args[2]); if (!n.call) return out; out.push(n.call.method + (n.call.method === VIEW_TILE || n.call.method === 'tile' ? ' ' + n.call.args[2] : '') + (n.jumped ? ' (ahead)' : '')); } };

test('3.9: a short call goes ahead of the tiles queued, never ahead of anything else', () => {
  const q = new CallQueue<QCall>();
  for (const c of [vt('a', 1), vt('a', 1), vt('a', 1), call('chars', 'a', 0)]) q.push(c);
  assert.deepEqual(drain(q), ['chars (ahead)', 'viewTile 1', 'viewTile 1', 'viewTile 1']);
  // an open (or a close, an edit) keeps its place: the short call waits for it, not for the tiles after it
  for (const c of [vt('a', 1), call('open', 'b'), vt('b', 1), call('snap', 'b', 0), call('links', 'b', 0)]) q.push(c);
  assert.deepEqual(drain(q), ['viewTile 1', 'open', 'snap (ahead)', 'links (ahead)', 'viewTile 1']);
});

test('3.9: after a zoom change, view tiles of the old scale are answered stale without being drawn', () => {
  const q = new CallQueue<QCall>();
  for (const c of [vt('a', 1), vt('a', 1), vt('b', 1), call('tile', 'a', 0, 1), vt('a', 2)]) q.push(c);
  q.wantScales('a', [2, 0.5]);
  // (thumbnails and export pictures - plain 'tile' - are never dropped; another document is untouched)
  assert.deepEqual(drain(q), ['stale 1', 'stale 1', 'viewTile 1', 'tile 1', 'viewTile 2']);
  assert.equal(q.stale, 2);
  q.wantScales('a', null);
  q.push(vt('a', 1));
  assert.deepEqual(drain(q), ['viewTile 1']);
});

function client() {
  const c = new EngineClient('Drawing engine 9');
  const posted: unknown[] = [];
  const port = { postMessage(m: unknown) { posted.push(m); }, start() {}, close() {}, onmessage: null as null | ((e: { data: unknown }) => void) };
  c.attach(port as unknown as MessagePort, false);
  return { c, port, posted };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('3.9: the client sends the scales wanted, and takes "stale" as not drawn (not failed)', async () => {
  const { c, port, posted } = client();
  c.want('a', [1.5]);
  assert.deepEqual(posted[0], { want: { doc: 'a', scales: [1.5] } });
  const p = c.call(VIEW_TILE, ['a', 0, 1, 0, 0, 512, 512]);
  port.onmessage!({ data: { id: 1, ok: false, error: 'stale tile', stale: true } });
  await assert.rejects(p, (e: { stale?: boolean; engineDown?: boolean }) => e.stale === true && !e.engineDown);
  assert.equal(c.busy, 0);
});

test('3.9: an engine going down while a call that went ahead runs blames that call', async () => {
  const { c, port } = client();
  const errs = new Map<number, { culprit?: boolean }>();
  for (let i = 1; i <= 3; i++) void c.call(i < 3 ? VIEW_TILE : 'chars').catch((e) => errs.set(i, e));
  port.onmessage!({ data: { id: 0, running: 3 } });
  c.attach({ ...port } as unknown as MessagePort, true, 70);
  await tick();
  assert.equal(errs.get(3)?.culprit, true, 'the short call that was running');
  assert.ok(!errs.get(1)?.culprit && !errs.get(2)?.culprit, 'the tiles only waited');
  // (once it has answered, the oldest call is blamed again)
  const e2: { culprit?: boolean }[] = [];
  void c.call(VIEW_TILE).catch((e) => e2.push(e));
  void c.call('chars').catch((e) => e2.push(e));
  port.onmessage!({ data: { id: 0, running: 5 } });
  port.onmessage!({ data: { id: 5, ok: true, value: { text: '' } } });
  c.attach({ ...port } as unknown as MessagePort, true, 70);
  await tick();
  assert.equal(e2[0]?.culprit, true);
});
