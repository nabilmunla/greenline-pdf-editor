// PLAN 10.7b: a protected or signed file over 1.2 GB says on open what it cannot do (its saves
// run out of memory: measured in 10.7), and a save that does run out says so in plain words.
// At full size (1.3 GB generated, needs ~3 GB of disk and an engine's 2 GB of memory) only with
// PDFED_BIG_TESTS=1; otherwise the size limit is lowered (setLockedBigForTests) and the files are small.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { VFile } from '../src/engine/files';
import { makeProtectedBig } from './gen/protected-big.mjs';
import { lockedBigNotice } from '../src/ui/bigLocked';

mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));
const dir = mkdtempSync(join(tmpdir(), 'pdfed-pb7b-test-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

/** a generated file of about `mb` MB of the kind asked for, opened as `id` */
function openGen(id: string, kind: 'protected' | 'signed' | 'plain', mb: number) {
  const f = join(dir, `${kind}-${mb}.pdf`);
  makeProtectedBig(f, mb * 1e6, kind as 'protected');
  return mu.open(id, new VFile({ path: f }));
}

test('the notice is for a protected or signed file over the limit: not a smaller one, not an unprotected big one', () => {
  mu.setLockedBigForTests(27e6);
  try {
    // (30 MB stands for 1.3 GB, 25 MB for 1.1 GB: the limit is 27 MB here, 1.2 GB there)
    for (const [kind, want] of [['protected', 'protected'], ['signed', 'signed']] as const) {
      const big = openGen('b-' + kind, kind, 30);
      assert.equal(big.lockedBig, want, kind + ' over the limit');
      mu.close('b-' + kind);
      const small = openGen('s-' + kind, kind, 25);
      assert.equal(small.lockedBig, undefined, kind + ' under the limit');
      mu.close('s-' + kind);
    }
    const plain = openGen('plain', 'plain', 30);
    assert.equal(plain.lockedBig, undefined, 'a big file that is neither');
    assert.equal(plain.pages.length, 3);
    mu.close('plain');
  } finally { mu.setLockedBigForTests(0); }
  // (and with the real limit a 30 MB file is nothing)
  assert.equal(openGen('real', 'protected', 30).lockedBig, undefined);
  mu.close('real');
});

test('a save that runs out of memory on such a file says so in plain words; on any other file it is left as it was', () => {
  const proto = mupdf.PDFDocument.prototype as unknown as { saveToBuffer: (...a: unknown[]) => unknown };
  const real = proto.saveToBuffer;
  const failing = () => { proto.saveToBuffer = function () { throw new Error('realloc (1861718086 bytes) failed'); }; };
  mu.setLockedBigForTests(27e6);
  try {
    for (const kind of ['protected', 'signed'] as const) {
      openGen('p', kind, 30);
      mu.rotatePages('p', [0], 90);
      failing();
      for (const opts of [{ incremental: true }, {}]) {
        assert.throws(() => mu.save('p', opts), (e: Error) => e.message === mu.LOCKED_BIG_SAVE, kind + ' ' + JSON.stringify(opts));
      }
      proto.saveToBuffer = real;
      mu.close('p');
    }
    // under the limit, or not protected or signed: MuPDF's own message, as before
    for (const [kind, mb] of [['protected', 25], ['plain', 30]] as const) {
      openGen('q', kind, mb);
      mu.rotatePages('q', [0], 90);
      failing();
      assert.throws(() => mu.save('q', { incremental: true }), /realloc \(1861718086 bytes\) failed/, kind + ' ' + mb);
      proto.saveToBuffer = real;
      mu.close('q');
    }
  } finally { proto.saveToBuffer = real; mu.setLockedBigForTests(0); }
  assert.doesNotMatch(mu.LOCKED_BIG_SAVE, /realloc|malloc/);
  // (the save that works is as it was)
  openGen('w', 'protected', 30);
  mu.rotatePages('w', [0], 90);
  assert.equal(mupdf.Document.openDocument(mu.save('w', { incremental: true }), 'application/pdf').countPages(), 3);
  mu.close('w');
});

test('the notice text names the file and the kind, and what to do instead', () => {
  const t = (k: 'protected' | 'signed' | 'both') => lockedBigNotice('Spec.pdf', k);
  assert.match(t('protected'), /^Spec\.pdf is protected and over 1\.2 GB\./);
  assert.match(t('protected'), /ask for an unprotected copy\.$/);
  assert.match(t('signed'), /^Spec\.pdf is digitally signed and over 1\.2 GB\./);
  assert.match(t('signed'), /ask for an unsigned copy\.$/);
  assert.match(t('both'), /protected and digitally signed/);
  assert.match(t('both'), /ask for an unprotected, unsigned copy\.$/);
  for (const k of ['protected', 'signed', 'both'] as const) {
    assert.match(t(k), /view it and mark it up, but saving it may fail/);
    assert.match(t(k), /print the pages you need to a PDF/);
    assert.ok(t(k).length < 260, 'short: ' + t(k).length);
  }
});

test('at full size (PDFED_BIG_TESTS=1): 1.3 GB protected and signed files give the notice, a 1.1 GB one does not, a save gives the plain message', { skip: !process.env.PDFED_BIG_TESTS }, () => {
  for (const kind of ['protected', 'signed'] as const) {
    const small = openGen('f1', kind, 1100);
    assert.equal(small.lockedBig, undefined, kind + ' 1.1 GB');
    mu.close('f1');
    rmSync(join(dir, `${kind}-1100.pdf`), { force: true });
    const r = openGen('f2', kind, 1300);
    assert.equal(r.lockedBig, kind, kind + ' 1.3 GB');
    mu.rotatePages('f2', [0], 90);
    assert.throws(() => mu.save('f2', { incremental: true }), (e: Error) => e.message === mu.LOCKED_BIG_SAVE);
    mu.close('f2');
    rmSync(join(dir, `${kind}-1300.pdf`), { force: true });
  }
});
