// PLAN 10.7: the generated big protected / signed file (tests/gen/protected-big.mjs) is what the
// measurement needs - a permissions-only file that opens without a password, and a file whose form
// says it is signed - and it saves and draws like any other at the same size. The measurement at 700 MB
// and 1.1 GB is tests/bench/protected-big-bench.ts (recorded in PROGRESS; no code changed by it).
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { VFile } from '../src/engine/files';
import { makeProtectedBig } from './gen/protected-big.mjs';

mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));
const dir = mkdtempSync(join(tmpdir(), 'pdfed-pb-test-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

test('a generated protected file: the size asked for, opens without a password, is encrypted, saves', () => {
  const f = join(dir, 'p.pdf');
  const made = makeProtectedBig(f, 30e6, 'protected');
  assert.equal(statSync(f).size, made.size);
  assert.ok(made.size >= 30e6 && made.size < 33e6);
  const r = mu.open('p', new VFile({ path: f }));
  assert.equal(r.needsPassword, false);
  assert.equal(r.pages.length, 3);
  assert.equal(r.signed, false);
  // (the stream bytes in the file are encrypted: the same stream read back, not the plain filler)
  const d = mupdf.Document.openDocument(readFileSync(f), 'application/pdf').asPDF()!;
  assert.ok(!d.getTrailer().get('Encrypt').isNull());
  mu.rotatePages('p', [0], 90);
  const bytes = mu.save('p', { incremental: true });
  const after = mupdf.Document.openDocument(bytes, 'application/pdf');
  assert.equal(after.countPages(), 3);
  assert.equal(after.loadPage(0).getBounds()[2], 842, 'the turned page is landscape');
  mu.close('p');
});

test('a generated signed file: its form says so, and a save keeps the original bytes in front', () => {
  const f = join(dir, 's.pdf');
  const made = makeProtectedBig(f, 30e6, 'signed');
  const r = mu.open('s', new VFile({ path: f }));
  assert.equal(r.signed, true);
  assert.equal(r.pages.length, 3);
  mu.rotatePages('s', [1], 90);
  const bytes = mu.save('s', { incremental: true });
  assert.ok(bytes.length > made.size);
  assert.deepEqual(Buffer.from(bytes.subarray(0, 4096)), readFileSync(f).subarray(0, 4096));
  mu.close('s');
});
