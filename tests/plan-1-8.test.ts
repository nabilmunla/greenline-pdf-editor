// PLAN 1.8 (AUDIT B8, B9, B10)
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as mu from '../src/engine/mu';

mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));

test('1.8 B8: an error from the snapshot writer goes up and the file is not written a second time', async () => {
  const { VFile, tempPath } = await import('../src/engine/files');
  const orig = tempPath('b8.pdf');
  writeFileSync(orig, readFileSync('tests/data/long-spec.pdf'));
  mu.open('b8', new VFile({ path: orig }));
  mu.rotatePages('b8', [2], 90);
  // the incremental path (the file is on disk, one change): write() fails - the disk is full
  const calls: number[] = [];
  assert.throws(() => mu.snapshotTo('b8', (v) => { calls.push(v.length); throw new Error('disk full'); }), /disk full/);
  assert.equal(calls.length, 1, `write called ${calls.length} times: the whole file must not be written after the failure`);
  // the normal path still works, and still writes only the appended changes
  const seen: { len: number; from: number }[] = [];
  const s = mu.snapshotTo('b8', (v, from) => { seen.push({ len: v.length, from }); });
  assert.equal(seen.length, 1);
  assert.equal(s.base, readFileSync(orig).length, 'incremental: the original + appended changes');
  mu.close('b8');
});

test('1.8 B9: fontFromBytes tells two fonts of one name and one size apart', async () => {
  const { fontFromBytes, fontBytes } = await import('../src/engine/fonts');
  const dir = process.env.PDFED_FONT_DIRS?.split(':')[0] || '/usr/share/fonts/truetype/dejavu';
  const a = new Uint8Array(readFileSync(`${dir}/DejaVuSans.ttf`));
  // the same font with one byte changed in the middle (same name, same length)
  const b = a.slice();
  b[b.length >> 1] ^= 0xff;
  const ra = fontFromBytes('Same', a), rb = fontFromBytes('Same', b);
  assert.ok(ra && rb, 'both load');
  assert.notEqual(ra, rb, 'different bytes: different entries');
  assert.deepEqual(fontBytes(rb!), b, 'the second font is the one given');
  assert.equal(fontFromBytes('Same', a.slice()), ra, 'same bytes (a copy): the cached entry');
  assert.notEqual(fontFromBytes('Other', a), ra, 'another name: another entry');
});

// B10 lives in electron/main.cjs, which can't be loaded without Electron: the real commitFile and the
// few one-line helpers it uses are cut out of the file's own text and run against a temp folder,
// with the rest of its surroundings (backup, logging, the old-file list) stubbed.
test('1.8 B10: a failed commit keeps the engine file for a retry; a good one removes it and leaves no temp file', async () => {
  const { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const text = readFileSync('electron/main.cjs', 'utf8');
  const grab = (re: RegExp) => { const m = re.exec(text); assert.ok(m, 'found in main.cjs: ' + re); return m![0]; };
  const code = [
    grab(/^const stagingName = .*$/m), grab(/^const workDir = .*$/m), grab(/^const inWork = .*$/m), grab(/^const isPart = .*$/m),
    grab(/^async function commitFile\([\s\S]*?\n}\n/m),
    'return commitFile;',
  ].join('\n');
  const root = mkdtempSync(path.join(os.tmpdir(), 'plan18-'));
  const fakeOs = { tmpdir: () => root };
  const commitFile = new Function('path', 'os', 'fs', 'fsp', 'APP', 'backup', 'log', 'retrying', 'overwriteInPlace', 'oldFiles', 'cleanOld', 'sweepStaging', code)(
    path, fakeOs, fs, fs.promises, 'PDF Editor', async () => '', () => {}, (f: () => unknown) => f(), async () => {}, [], () => {}, () => {}) as (src: string, file: string, keepBackup: boolean) => Promise<{ size: number }>;
  try {
    const work = path.join(root, 'PDF Editor', 'work', 'job1');
    mkdirSync(work, { recursive: true });
    const src = path.join(work, 'out.pdf');
    writeFileSync(src, 'engine output');
    const dest = path.join(root, 'target');
    mkdirSync(dest);
    // a commit that fails: the target name is a folder with something in it (the swap is refused)
    const blocked = path.join(dest, 'doc.pdf');
    mkdirSync(path.join(blocked, 'inside'), { recursive: true });
    await assert.rejects(() => commitFile(src, blocked, false));
    assert.ok(existsSync(src), 'the engine file is still there after the failed commit');
    assert.equal(readFileSync(src, 'utf8'), 'engine output');
    assert.deepEqual(readdirSync(dest).filter((n) => n.startsWith('.~')), [], 'no staging file left beside the target');
    // the retry (another name) uses the same engine file
    const good = path.join(dest, 'doc2.pdf');
    const r = await commitFile(src, good, false);
    assert.equal(readFileSync(good, 'utf8'), 'engine output');
    assert.equal(r.size, 'engine output'.length);
    for (let i = 0; i < 50 && existsSync(work); i++) await new Promise((res) => setTimeout(res, 20));
    assert.ok(!existsSync(work), 'saved: the engine file and its work folder are removed');
    assert.deepEqual(readdirSync(dest).filter((n) => n.startsWith('.~')), [], 'no staging file left on the normal path');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
