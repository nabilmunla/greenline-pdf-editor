// PLAN 10.4: which call an engine is running and for how long (rpc.ts `stuck`), and the limit each
// kind of call gets (`hangLimit`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineClient, hangLimit } from '../src/engine/rpc';

const fakePort = () => ({ posted: [] as any[], onmessage: null as any, postMessage(m: any) { this.posted.push(m); }, start() {}, close() {} }) as any;

test('hangLimit: 20 s for short calls and tiles, 120 s for the rest, none for the long jobs', () => {
  for (const m of ['chars', 'snap', 'links', 'tile', 'viewTile']) assert.equal(hangLimit(m), 20_000, m);
  for (const m of ['open', 'createAnnot', 'extract', 'getData']) assert.equal(hangLimit(m), 120_000, m);
  for (const m of ['mergeAdd', 'mergeFinish', 'save', 'compress', 'ocrPage', 'ocrState', 'exportRead', 'printPicSheet', 'extractBig', 'linkSheets', 'drawSnapshot', 'writeRecovery', 'memory']) assert.equal(hangLimit(m), Infinity, m);
  assert.equal(hangLimit('open', 3000, 6000), 6000);
});

test('stuck: nothing pending, or no engine yet, is not stuck', () => {
  const c = new EngineClient('Editing engine');
  assert.equal(c.stuck(), null);
  void c.call('open').catch(() => {});
  assert.equal(c.stuck(), null, 'no port: the call is only waiting to be posted');
});

test('stuck: the oldest call, timed from when the engine last answered', async () => {
  const c = new EngineClient('Editing engine');
  const port = fakePort();
  c.attach(port, false);
  const t0 = performance.now();
  void c.call('save').catch(() => {});
  void c.call('open').catch(() => {});
  const s1 = c.stuck(t0 + 5000)!;
  assert.equal(s1.method, 'save');
  assert.ok(s1.ms >= 4900 && s1.ms < 5100, String(s1.ms));
  // the first answers late: the next one only starts then, so it is not "old" the moment it does
  port.onmessage({ data: { id: s1.id, ok: true, value: 1 } });
  const s2 = c.stuck(performance.now() + 100)!;
  assert.equal(s2.method, 'open');
  assert.ok(s2.ms < 500, 'the second call started when the first answered: ' + s2.ms);
});

test('stuck: a short call that went ahead is the one running', () => {
  const c = new EngineClient('Editing engine');
  const port = fakePort();
  c.attach(port, false);
  void c.call('viewTile').catch(() => {});
  void c.call('chars').catch(() => {});
  port.onmessage({ data: { id: 0, running: 2 } });
  assert.equal(c.stuck()!.method, 'chars');
  port.onmessage({ data: { id: 2, ok: true, value: 1 } });
  assert.equal(c.stuck()!.method, 'viewTile');
});
