// PLAN 10.1 (ENGINE-STUDY-2 B1): Cancel reaches a running Combine. The engine does one call at a
// time, so a `mergeAdd` on a big file used to run to its end whatever the window said: the check
// "has the job been dropped" between its steps could never be true. `{ cancel: job }` is taken at
// once (like `want`) and the job reads it between steps.
// The host runs here in this process with a fake port, as the window's would be.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// (before anything reads the work folder, which is under the temp folder)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-'));
process.env.TMPDIR = scratch; process.env.TEMP = scratch; process.env.TMP = scratch;
process.argv[2] = 'assets'; // (where host.ts looks for glyphless.ttf)

// the engine process's parent port, as the host reads it when it is loaded
type Fn = (e: { data: any; ports?: any[] }) => void;
const parent: { fns: Fn[]; sent: any[] } = { fns: [], sent: [] };
(process as any).parentPort = { on(_ev: string, f: Fn) { parent.fns.push(f); }, postMessage(m: unknown) { parent.sent.push(m); } };

const mupdf = await import('mupdf');
const { startHost, editHandlers, isCancelled } = await import('../src/engine/host');
const { workDir } = await import('../src/engine/files');

// the window's end of one message port
const replies: any[] = [];
const waiting = new Map<number, (m: any) => void>();
const listeners: Fn[] = [];
const port = {
  on(ev: string, f: Fn) { if (ev === 'message') listeners.push(f); },
  postMessage(m: any) { replies.push(m); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } },
  start() {},
};
const post = (data: unknown) => { for (const f of listeners) f({ data }); };
let seq = 1;
const call = (method: string, ...args: unknown[]) => new Promise<any>((res) => { const id = seq++; waiting.set(id, res); post({ id, method, args }); });

startHost('edit', editHandlers());
for (let i = 0; i < 400 && !parent.sent.some((m) => m.type === 'ready'); i++) await new Promise((r) => setTimeout(r, 25));
assert.ok(parent.sent.some((m) => m.type === 'ready'), 'the host came up');
for (const f of parent.fns) f({ data: { type: 'port' }, ports: [port] });

/** a PDF of `n` pages, each with `k` comments (text notes) */
function makePdf(n: number, k: number): string {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < n; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, `BT /F1 18 Tf 72 700 Td (PAGE ${i}) Tj ET`));
  for (let i = 0; i < n && k; i++) {
    const pg = d.loadPage(i) as mupdf.PDFPage;
    for (let j = 0; j < k; j++) { const a = pg.createAnnotation('Text'); a.setRect([20 + j * 30, 20, 40 + j * 30, 40]); a.setContents('note ' + i + '/' + j); }
  }
  const file = path.join(scratch, `gen-${n}-${k}.pdf`);
  fs.writeFileSync(file, d.saveToBuffer('compress').asUint8Array());
  return file;
}
const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
const spills = () => walk(workDir()).filter((p) => p.endsWith('merge-streams.bin'));

test('10.1: Cancel posted during a mergeAdd stops it between steps and lets everything go', async () => {
  const big = makePdf(400, 3);
  const small = makePdf(3, 0);
  assert.equal((await call('mergeBegin', 'j1')).ok, true);

  // count the pages grafted, and send the cancel as the first step ends (a message of its own,
  // arriving while the engine is between two steps)
  const gm = (mupdf as any).PDFGraftMap.prototype;
  const orig = gm.graftPage;
  let grafted = 0, spillThen: string[] = [], before = replies.length;
  gm.graftPage = function (this: unknown, ...a: unknown[]) {
    const r = orig.apply(this, a);
    if (++grafted === 1) setImmediate(() => { spillThen = spills(); post({ cancel: 'j1' }); });
    return r;
  };
  let res: any;
  try { res = await call('mergeAdd', 'j1', 'big.pdf', { $file: { path: big } }); } finally { gm.graftPage = orig; }

  assert.equal(res.ok, false, 'the add did not run to its end');
  assert.match(res.error, /stopped/);
  assert.ok(grafted < 400, `the file's last page was not grafted (${grafted} of 400)`);
  assert.equal(spillThen.length, 1, 'the spill file existed while it ran');
  assert.deepEqual(spills(), [], 'the spill file is removed');
  // the cancel is a message, not a call: nothing was answered for it
  assert.equal(replies.slice(before).filter((m) => m.id === undefined || m.id === 0).length, 0);
  assert.equal(replies.length - before, 1, 'one answer for the whole add (none for the cancel)');
  assert.equal(isCancelled('j1'), true, 'the flag stays until the job begins again');

  // the same job id again: a new begin clears the flag, and an add works
  assert.equal((await call('mergeBegin', 'j1')).ok, true);
  assert.equal(isCancelled('j1'), false);
  const r2 = await call('mergeAdd', 'j1', 'small.pdf', { $file: { path: small } });
  assert.equal(r2.ok, true, r2.error);
  assert.deepEqual(r2.value, { pages: 3, total: 3 });
  assert.equal((await call('mergeEnd', 'j1')).ok, true);
  assert.deepEqual(spills(), []);
});

test('10.1: a cancel for one job does not touch another, and a cancel before the add is honoured', async () => {
  const small = makePdf(3, 0);
  assert.equal((await call('mergeBegin', 'a')).ok, true);
  post({ cancel: 'b' });
  const r = await call('mergeAdd', 'a', 'small.pdf', { $file: { path: small } });
  assert.equal(r.ok, true, r.error);
  post({ cancel: 'a' });
  const r2 = await call('mergeAdd', 'a', 'small.pdf', { $file: { path: small } });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /stopped/);
  assert.deepEqual(spills(), []);
  assert.equal((await call('mergeEnd', 'a')).ok, true);
});

test.after(() => { fs.rmSync(scratch, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50); });
