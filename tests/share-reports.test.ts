// Engine errors name their call; Windows file-read errors are told apart (the four share reports, 16 Nov 2026)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineClient, isFileReadError } from '../src/engine/rpc.ts';

function answering(error: string) {
  const c = new EngineClient('Editing engine');
  const ch = new MessageChannel();
  ch.port2.onmessage = (e: MessageEvent) => ch.port2.postMessage({ id: e.data.id, ok: false, value: null, error });
  c.attach(ch.port1 as unknown as MessagePort, false);
  return { c, close: () => { ch.port1.close(); ch.port2.close(); } };
}

test('an engine error names its engine and call', async () => {
  const { c, close } = answering('invalid page number: 2');
  const e = await c.call('annots', ['d1', 1]).then(() => null, (x) => x as Error & { method?: string; engine?: string; fileRead?: boolean });
  close();
  assert.ok(e);
  assert.equal(e.message, 'invalid page number: 2');
  assert.equal(e.method, 'annots');
  assert.equal(e.engine, 'Editing engine');
  assert.match(String(e.stack), /at engine Editing engine: annots/);
  assert.equal(!!e.fileRead, false);
});

test('a Windows read error is marked as one (0.8.9: "UNKNOWN: unknown error, read")', async () => {
  const { c, close } = answering('UNKNOWN: unknown error, read');
  const e = await c.call('textBlocks', ['d1', 0]).then(() => null, (x) => x as Error & { fileRead?: boolean });
  close();
  assert.equal(e?.fileRead, true);
});

test('which messages are file-read errors', () => {
  for (const m of ['UNKNOWN: unknown error, read', 'EIO: i/o error, read', "ENOENT: no such file or directory, open 'C:\\x.pdf'", 'EBUSY: resource busy or locked, read', 'ETIMEDOUT: connection timed out, read'])
    assert.ok(isFileReadError(m), m);
  for (const m of ['invalid page number: 2', 'Could not read page 4', 'Document is not open', 'malloc (705937 bytes) failed', 'cannot read object 12', "EBUSY: resource busy or locked, copyfile 'a' -> 'b'"])
    assert.ok(!isFileReadError(m), m);
});
