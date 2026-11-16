// PLAN 1.5 (AUDIT B5): the engine's temp files do not outlive their use - the copy of the original
// that is kept when a file is saved over goes when the document is closed (or when the copy
// fails), and a file written for a call that then throws is removed.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// (before anything reads the work folder, which is under the temp folder)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plan15-'));
process.env.TMPDIR = scratch; process.env.TEMP = scratch; process.env.TMP = scratch;
process.argv[2] = 'assets'; // (where host.ts looks for glyphless.ttf)
const mupdf = await import('mupdf');
const mu = await import('../src/engine/mu');
const { editHandlers, runToFile } = await import('../src/engine/host');
const { VFile, workDir, removeTemp } = await import('../src/engine/files');

/** a PDF with `n` pages */
function makePdf(n: number): Uint8Array {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < n; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, `BT /F1 18 Tf 72 700 Td (PAGE ${i}) Tj ET`));
  return d.saveToBuffer('compress').asUint8Array().slice();
}
/** every file and folder under the work folder (empty list = nothing left behind) */
function leftovers(): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(workDir(), p)); if (e.isDirectory()) walk(p); } };
  if (fs.existsSync(workDir())) walk(workDir());
  return out;
}
/** as the window opens a file: the engine reads it through a handle and knows where it came from */
function openFile(h: Record<string, (...a: any[]) => any>, id: string, file: string) {
  const vf = new VFile({ path: file }) as InstanceType<typeof VFile> & { $src?: { path: string } };
  vf.$src = { path: file };
  h.open(id, vf);
}
/** what saving over a file does: a new file takes the old one's place (the open handle keeps the old content) */
function saveOver(file: string, bytes: Uint8Array) {
  const tmp = file + '.new';
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

const h = await editHandlers();

test('1.5: file saved over while open, then closed: no copy of the original is left in the work folder', () => {
  assert.deepEqual(leftovers(), []);
  const file = path.join(scratch, 'a.pdf');
  fs.writeFileSync(file, makePdf(2));
  openFile(h, 'a', file);
  mu.createAnnot('a', 0, { type: 'Square', rect: [10, 10, 60, 60] } as never);
  saveOver(file, makePdf(3));
  const snap = h.drawSnapshot('a');
  assert.ok(snap.delta, 'the changes are written against a copy of the original');
  assert.notEqual(snap.path, file);
  assert.ok(leftovers().some((p) => p.endsWith('base.pdf')), 'the copy exists while the document is open');
  h.close('a');
  // (the window removes the changes file itself, through rmTemp)
  removeTemp([snap.delta]);
  assert.deepEqual(leftovers(), []);
});

test('1.5: a copy of the original that fails half way is removed', () => {
  const file = path.join(scratch, 'b.pdf');
  fs.writeFileSync(file, makePdf(2));
  openFile(h, 'b', file);
  saveOver(file, makePdf(3));
  // the file was cut short by another program: the reader gives a short read
  const r = mu.readerOf('b')!;
  const read = r.read.bind(r);
  r.read = (buf, off, len, pos) => Math.max(0, read(buf, off, len, pos) - 1);
  const snap = h.drawSnapshot('b'); // (no base to be had: a whole copy is written instead)
  assert.equal(snap.delta, undefined);
  h.close('b');
  removeTemp([snap.path]);
  assert.deepEqual(leftovers(), []);
});

test('1.5: a call that throws after its file was started leaves no file (temp target)', () => {
  const file = path.join(scratch, 'c.pdf');
  fs.writeFileSync(file, makePdf(2));
  openFile(h, 'c', file);
  assert.throws(() => runToFile(mu.withSink, true, () => { mu.save('c'); throw new Error('after writing'); }), /after writing/);
  assert.deepEqual(leftovers(), []);
  // and it still works when nothing goes wrong: the file comes back and is kept
  const ok = runToFile(mu.withSink, true, () => mu.save('c')) as { $file: { path: string; size: number } };
  assert.ok(fs.existsSync(ok.$file.path), JSON.stringify(ok));
  assert.ok(ok.$file.size > 100, JSON.stringify(ok));
  removeTemp([ok.$file.path]);
  h.close('c');
  assert.deepEqual(leftovers(), []);
});

test('1.5: a call that throws after its file was started leaves no file (path given)', () => {
  const file = path.join(scratch, 'd.pdf');
  fs.writeFileSync(file, makePdf(2));
  openFile(h, 'd', file);
  const target = path.join(scratch, 'sub', 'result.pdf');
  assert.throws(() => runToFile(mu.withSink, target, () => { mu.save('d'); throw new Error('after writing'); }), /after writing/);
  assert.equal(fs.existsSync(target), false);
  h.close('d');
});
