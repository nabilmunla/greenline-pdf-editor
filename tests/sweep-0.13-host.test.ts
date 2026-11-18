// 0.13 deep ritual: the sweep's findings in the engine host (src/engine/host.ts), one test each. The host
// runs here in this process with a fake port, as in tests/cancel.test.ts.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// (before anything reads the work folder, which is under the temp folder)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep13-host-'));
process.env.TMPDIR = scratch; process.env.TEMP = scratch; process.env.TMP = scratch;
process.argv[2] = 'assets'; // (where host.ts looks for glyphless.ttf)

type Fn = (e: { data: any; ports?: any[] }) => void;
const parent: { fns: Fn[]; sent: any[] } = { fns: [], sent: [] };
(process as any).parentPort = { on(_ev: string, f: Fn) { parent.fns.push(f); }, postMessage(m: unknown) { parent.sent.push(m); } };

const mupdf = await import('mupdf');
const mu = await import('../src/engine/mu');
const { startHost, editHandlers, isCancelled } = await import('../src/engine/host');
const { workDir } = await import('../src/engine/files');

const waiting = new Map<number, (m: any) => void>();
const listeners: Fn[] = [];
const port = {
  on(ev: string, f: Fn) { if (ev === 'message') listeners.push(f); },
  postMessage(m: any) { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } },
  start() {},
};
const post = (data: unknown) => { for (const f of listeners) f({ data }); };
let seq = 1;
const call = (method: string, ...args: unknown[]) => new Promise<any>((res) => { const id = seq++; waiting.set(id, res); post({ id, method, args }); });

startHost('edit', editHandlers(), mu.withSink);
for (let i = 0; i < 400 && !parent.sent.some((m) => m.type === 'ready'); i++) await new Promise((r) => setTimeout(r, 25));
assert.ok(parent.sent.some((m) => m.type === 'ready'), 'the host came up');
for (const f of parent.fns) f({ data: { type: 'port' }, ports: [port] });
test.after(() => { fs.rmSync(scratch, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50); });

const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
const fds = () => fs.readdirSync('/proc/self/fd').length;

test('5: extractBig - the result can\'t be started (out of memory): its spill file and handle are let go', async () => {
  const proto = (mupdf as any).PDFDocument.prototype;
  const orig = proto.countObjects;
  // (mergeStart's new document: the first thing it asks it fails, as MuPDF out of memory would)
  let once = true;
  proto.countObjects = function (this: unknown, ...a: unknown[]) { if (once) { once = false; throw new Error('malloc (1024 bytes) failed'); } return orig.apply(this, a); };
  const before = fds();
  let r: any;
  try { r = await call('extractBig', 'x-oom', 'none', [0, 1]); } finally { proto.countObjects = orig; }
  assert.equal(r.ok, false);
  assert.match(String(r.error), /malloc/);
  assert.deepEqual(walk(workDir()).filter((p) => /extract-streams\.bin$/.test(p)), [], 'no spill file left');
  assert.equal(fds(), before, 'no file handle left open');
  assert.equal(isCancelled('x-oom'), false);
});

test('4: a Stop that comes after its job ended is not kept for the engine\'s life', async () => {
  // (the window's Stop pressed as the job finished: { cancel } after the job's own clean-up)
  for (let i = 0; i < 1000; i++) post({ cancel: 'late-' + i });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(isCancelled('late-0'), false, 'the oldest have gone');
  assert.equal(isCancelled('late-999'), true, 'a recent one is still read (its job may be waiting its turn)');
  // (a Stop for a job waiting in the queue still stops it when it runs)
  post({ cancel: 'waiting-job' });
  assert.equal(isCancelled('waiting-job'), true);
});
