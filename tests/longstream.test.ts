// PLAN 14.7: a long stream is read whatever its length. MuPDF's fz_read_best limits a stream loaded
// whole to `initial * 200` bytes (100 MiB at least) - a size_t, 32 bits in MuPDF.js, which wraps once
// `initial` passes 21.47 MB: a stream of L bytes over 100 MiB was refused ("compression bomb
// detected") when 200 × L mod 2^32 < L (raw loads, MuPDF's own writer) - 600 × L for a decoded Flate
// load. The .wasm copy made at start (mupdf-pre.mjs) states no limit where the caller states none.
// Files generated in the temp folder (invented content), removed after.
import '../src/engine/mupdf-pre.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { VFile } from '../src/engine/files';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longstream-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const WORD = 'LONGSTREAM';

/**
 * One page whose content stream is `len` bytes in the file: with no filter (`body` null: a word, a
 * box, then comment lines up to the length), or the bytes given (`filter`: the /Filter value as
 * written, '/FlateDecode'). Written without MuPDF.
 */
function pagePdf(name: string, len: number, body: Uint8Array | null = null, filter = ''): string {
  const file = path.join(dir, name);
  const fd = fs.openSync(file, 'w');
  let pos = 0;
  const offs: number[] = [];
  const put = (b: string | Uint8Array) => { const v = typeof b === 'string' ? Buffer.from(b, 'latin1') : b; for (let w = 0; w < v.length;) w += fs.writeSync(fd, v, w, v.length - w); pos += v.length; };
  put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  offs[1] = pos; put('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n');
  offs[2] = pos; put('2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n');
  offs[3] = pos; put('3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>\nendobj\n');
  offs[4] = pos; put(`4 0 obj\n<</Length ${len}${filter ? '/Filter' + filter : ''}>>\nstream\n`);
  if (body) put(body);
  else {
    const head = `BT /F1 24 Tf 100 700 Td (${WORD}) Tj ET 0 0 1 rg 100 100 300 200 re f\n`;
    put(head);
    const line = Buffer.from('%' + 'x'.repeat(65534) + '\n', 'latin1');
    let left = len - head.length;
    while (left > line.length + 2) { put(line); left -= line.length; }
    put('%' + 'x'.repeat(left - 2) + '\n');
  }
  put('\nendstream\nendobj\n');
  offs[5] = pos; put('5 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n');
  const x = pos;
  put('xref\n0 6\n0000000000 65535 f \n' + offs.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  put(`trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`);
  fs.closeSync(fd);
  assert.equal(pos, fs.statSync(file).size);
  return file;
}
/** the page's content stream, read whole from the file: decoded and raw (lengths, or the error) */
function loads(file: string) {
  const v = new VFile({ path: file });
  const d = mu.openIn(v).asPDF()!;
  const r: string[] = [];
  try {
    const c = d.findPage(0).get('Contents');
    for (const how of ['readStream', 'readRawStream'] as const) {
      try { const b = c[how](); r.push(`${how} ${b.getLength()}`); b.destroy?.(); } catch (e) { r.push(`${how}: ${String((e as Error)?.message ?? e)}`); }
    }
  } finally { d.destroy?.(); v.close(); }
  return r;
}
/** a result opened again: its pages and whether the page's text is there */
function opens(b: Uint8Array): string {
  const d = mupdf.Document.openDocument(b, 'application/pdf');
  try { return `${d.countPages()} page(s), ${d.loadPage(0).toStructuredText().asText().includes(WORD) ? 'the text there' : 'no text'}`; } finally { d.destroy?.(); }
}
/** the copy made with `stream`: whole bytes, or the pieces joined */
function copyOf(id: string, full: boolean, pieces: boolean): Uint8Array {
  const parts: Uint8Array[] = [];
  let whole: Uint8Array | null = null;
  if (pieces) mu.setWholeAt(1);
  try {
    mu.snapshotTo(id, (v, from) => { whole = from ? null : v.slice(); if (from) throw new Error('not a whole copy'); }, full, pieces ? (fill) => fill((b) => parts.push(typeof b === 'string' ? Buffer.from(b, 'latin1') : b.slice())) : undefined);
  } finally { mu.setWholeAt(600e6); }
  return pieces ? new Uint8Array(Buffer.concat(parts)) : whole!;
}

for (const len of [107_375_183, 128_849_020]) {
  test(`a stream of ${len.toLocaleString('en')} bytes with no filter (200 × its length wraps under it): read whole, saved, copied`, () => {
    assert.ok(len > 100 * 2 ** 20 && (200 * len) % 2 ** 32 < len, 'a length the 32-bit limit refused');
    const file = pagePdf(`bad-${len}.pdf`, len);
    const id = 'L' + len;
    mu.open(id, new VFile({ path: file }));
    try {
      // (0.13.0: each of them "compression bomb detected")
      const got: Record<string, string> = { 'read whole': loads(file).join(', ') };
      mu.createAnnot(id, 0, { type: 'Square', rect: [50, 50, 200, 200], color: [1, 0, 0] });
      const run = (what: string, f: () => Uint8Array) => { try { got[what] = opens(f()); } catch (e) { got[what] = String((e as Error)?.message ?? e); } };
      run('save whole', () => mu.save(id, { clearMetadata: true }));
      mu.setStreamSaveForTests(1);
      try { run('save in pieces', () => mu.save(id)); } finally { mu.setStreamSaveForTests(0); }
      run('recovery copy whole', () => copyOf(id, true, false));
      run('recovery copy in pieces', () => copyOf(id, true, true));
      run('drawing copy in pieces', () => copyOf(id, false, true));
      const want = '1 page(s), the text there';
      assert.deepEqual(got, { 'read whole': `readStream ${len}, readRawStream ${len}`, 'save whole': want, 'save in pieces': want, 'recovery copy whole': want, 'recovery copy in pieces': want, 'drawing copy in pieces': want });
    } finally { mu.close(id); fs.rmSync(file, { force: true }); }
  });
}

test('a Flate content of 175,000,000 bytes packed to about 43 MB (600 × its length wraps under 175,000,000) is read decoded', () => {
  const size = 175_000_000;
  // random bytes (they do not pack) then zeros: the packed length is steered into the window where
  // 600 × it mod 2^32 is under the decoded size
  const lo = Math.ceil(6 * 2 ** 32 / 600), hi = Math.floor((6 * 2 ** 32 + size) / 600);
  const raw = new Uint8Array(size);
  let s = 7;
  const words = new Uint32Array(raw.buffer, 0, Math.floor(size / 4));
  let packed = new Uint8Array(0);
  for (let r = 43_050_000, tries = 0; tries < 4; tries++) {
    for (let i = 0; i < r / 4; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; words[i] = s >>> 0; }
    raw.fill(0, r);
    packed = zlib.deflateSync(raw, { level: 1 });
    if (packed.length >= lo && packed.length <= hi) break;
    r += Math.round(((lo + hi) / 2 - packed.length) * 0.99);
  }
  assert.ok(packed.length >= lo && packed.length <= hi, `packed to ${packed.length}, inside ${lo}..${hi}`);
  assert.ok((600 * packed.length) % 2 ** 32 < size, 'a length the 32-bit limit refused');
  const file = pagePdf('flate.pdf', packed.length, packed, '/FlateDecode');
  try {
    // (0.13.0: "compression bomb detected")
    assert.deepEqual(loads(file), [`readStream ${size}`, `readRawStream ${packed.length}`]);
  } finally { fs.rmSync(file, { force: true }); }
});

test('lengths the limit never refused read as before (85,900,346, 104,857,600, 107,373,182, 107,974,183)', () => {
  for (const len of [85_900_346, 104_857_600, 107_373_182, 107_974_183]) {
    const file = pagePdf(`good-${len}.pdf`, len);
    try { assert.deepEqual(loads(file), [`readStream ${len}`, `readRawStream ${len}`], String(len)); } finally { fs.rmSync(file, { force: true }); }
  }
});

/** `n` zero bytes Flate-packed (level 9: about n / 1030), made piece by piece */
async function zeros(n: number): Promise<Buffer> {
  const z = zlib.createDeflate({ level: 9 });
  const chunks: Buffer[] = [];
  z.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise((res, rej) => { z.on('end', res); z.on('error', rej); });
  const zero = Buffer.alloc(64 << 20);
  for (let left = n; left > 0; left -= zero.length) {
    if (!z.write(left >= zero.length ? zero : zero.subarray(0, left))) await new Promise((r) => z.once('drain', r));
  }
  z.end();
  await done;
  return Buffer.concat(chunks);
}
/** a page whose content is `packed` under `filter`, read whole: it ends in an error, and the document still answers */
function bomb(name: string, packed: Uint8Array, filter: string) {
  const file = pagePdf(name, packed.length, packed, filter);
  const v = new VFile({ path: file });
  const d = mu.openIn(v).asPDF()!;
  try {
    let err = '';
    try { d.findPage(0).get('Contents').readStream(); } catch (e) { err = String((e as Error)?.message ?? e); }
    assert.match(err, /realloc|compression bomb|memory/i, 'an error: ' + err);
    assert.equal(d.countPages(), 1, 'the document still answers');
    const on = (globalThis as { $mupdfPatch?: { bomb?: boolean } }).$mupdfPatch?.bomb;
    console.log(`${name} (${packed.length} bytes packed): ${on ? 'with' : 'without'} the limit patch, MuPDF's memory after it ${(mu.heap() / 2 ** 20).toFixed(0)} MiB (${err})`);
  } finally { d.destroy?.(); v.close(); fs.rmSync(file, { force: true }); }
}

test('a bomb packed twice (Flate on Flate, about 2 KB unpacking to 1 GB) still ends in an error, and the document still answers', async () => {
  const twice = zlib.deflateSync(await zeros(1e9), { level: 9 });
  assert.ok(twice.length < 16 << 10, `packed twice: ${twice.length} bytes`);
  bomb('bomb-twice.pdf', twice, '[/FlateDecode/FlateDecode]');
});

test('a real bomb (3 GB of zeros packed to about 3 MB) still ends in an error, and the document still answers', async () => {
  bomb('bomb.pdf', await zeros(3e9), '/FlateDecode');
});
