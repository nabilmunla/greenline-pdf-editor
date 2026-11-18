// PLAN 10.5 (ENGINE-STUDY-2 R4): the MuPDF engines say how much memory MuPDF holds. `heap` is a call,
// and every answer carries it (the window decides from it: the batch engine starts again when a job
// has grown it past 600 MB, the editing engine's person is asked at 1.6 GB). The host runs here in
// this process with a fake port, as the window's would be.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-'));
process.env.TMPDIR = scratch; process.env.TEMP = scratch; process.env.TMP = scratch;
process.argv[2] = 'assets';

type Fn = (e: { data: any; ports?: any[] }) => void;
const parent: { fns: Fn[]; sent: any[] } = { fns: [], sent: [] };
(process as any).parentPort = { on(_ev: string, f: Fn) { parent.fns.push(f); }, postMessage(m: unknown) { parent.sent.push(m); } };

const { startHost, editHandlers } = await import('../src/engine/host');
const { EngineClient } = await import('../src/engine/rpc');

const waiting = new Map<number, (m: any) => void>();
const listeners: Fn[] = [];
const port = {
  on(ev: string, f: Fn) { if (ev === 'message') listeners.push(f); },
  postMessage(m: any) { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } },
  start() {},
};
let seq = 1;
const call = (method: string, ...args: unknown[]) => new Promise<any>((res) => { const id = seq++; waiting.set(id, res); for (const f of listeners) f({ data: { id, method, args } }); });
startHost('edit', editHandlers());
for (let i = 0; i < 400 && !parent.sent.some((m) => m.type === 'ready'); i++) await new Promise((r) => setTimeout(r, 25));
assert.ok(parent.sent.some((m) => m.type === 'ready'), 'the host came up');
for (const f of parent.fns) f({ data: { type: 'port' }, ports: [port] });

/** a one-page PDF with a stream of `mb` MB (written by hand: MuPDF's memory in this process is the engine's) */
function bigPdf(mb: number): Uint8Array {
  const body = Buffer.alloc(mb << 20, 0x41);
  const head = '%PDF-1.4\n';
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n',
  ];
  const parts: Buffer[] = [Buffer.from(head)];
  const at: number[] = [];
  let off = head.length;
  for (const o of objs) { at.push(off); parts.push(Buffer.from(o)); off += o.length; }
  at.push(off);
  const o4 = Buffer.concat([Buffer.from(`4 0 obj<</Length ${body.length}>>stream\n`), body, Buffer.from('\nendstream endobj\n')]);
  parts.push(o4); off += o4.length;
  const xref = `xref\n0 5\n0000000000 65535 f \n${at.map((a) => String(a).padStart(10, '0') + ' 00000 n \n').join('')}trailer<</Size 5/Root 1 0 R>>\nstartxref\n${off}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return new Uint8Array(Buffer.concat(parts));
}

test('10.5: heap is a number, and every answer carries it', async () => {
  const r = await call('heap');
  assert.equal(r.ok, true, r.error);
  assert.equal(typeof r.value, 'number');
  assert.ok(r.value > 8 << 20, 'MuPDF holds some memory once loaded: ' + r.value);
  assert.equal(r.heap, r.value, 'the answer carries the same figure');
  const m = await call('memory');
  assert.equal(typeof m.heap, 'number', 'any other answer carries it too');
  const bad = await call('noSuchCall');
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.heap, 'number', 'and an error answer');
});

test('10.5: heap grows after an 80 MB open', async () => {
  // (80, not 50: a new engine's MuPDF has about 15 MB free inside its memory, so a 50 MB open grew it
  // by as little as 35 MB - it passed the 40 only while MuPDF.js leaked every object it wrapped, PLAN 10.19)
  const bytes = bigPdf(80);
  const before = (await call('heap')).value as number;
  const o = await call('open', 'big', bytes);
  assert.equal(o.ok, true, o.error);
  const after = (await call('heap')).value as number;
  assert.ok(after - before >= 40 << 20, `grew by ${((after - before) / 2 ** 20).toFixed(0)} MB (${before} -> ${after})`);
  assert.ok(o.heap >= after - (1 << 20) || o.heap > before, 'the open answer already carries the new size');
  await call('close', 'big');
});

test('10.5: the window side keeps the figure of the last answer; a new engine starts at 0', () => {
  const c = new EngineClient('Batch engine');
  const p: any = { postMessage() {}, start() {}, close() {}, onmessage: null };
  c.attach(p, false);
  assert.equal(c.heap, 0);
  void c.call('open').catch(() => {});
  p.onmessage({ data: { id: 1, ok: true, value: 1, heap: 700 << 20 } });
  assert.equal(c.heap, 700 << 20);
  void c.call('open').catch(() => {});
  p.onmessage({ data: { id: 2, ok: true, value: 1 } });
  assert.equal(c.heap, 700 << 20, 'an answer without a figure (a drawing engine) leaves it');
  c.attach({ postMessage() {}, start() {}, close() {}, onmessage: null } as any, true, 75);
  assert.equal(c.heap, 0, 'restarted: the new engine has none yet');
});
