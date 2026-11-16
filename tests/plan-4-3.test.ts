// PLAN 4.3: heavy pages of a protected file that opens without a password (permissions only) are
// drawn from merged line work again - the drawing copy is a decrypted whole copy plus the display
// update; the file's own save stays encrypted with its line work untouched. A file that needs a
// password to open: no decrypted copy is ever written.
import '../src/engine/mupdf-pre.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plan43-'));
process.env.TMPDIR = scratch; process.env.TEMP = scratch; process.env.TMP = scratch;
process.argv[2] = 'assets';
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const mupdf = await import('mupdf');
const mu = await import('../src/engine/mu');
const pf = await import('../src/engine/pdfium');
const { editHandlers } = await import('../src/engine/host');
const { VFile, workDir } = await import('../src/engine/files');
const { makeMerger, countStrokes } = await import('../src/engine/heavy');

/** 300,000 short strokes + a red line; protected with `opts` */
function heavyDoc(opts: string): Uint8Array {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const lines: string[] = [];
  for (let i = 0; i < 300_000; i++) { const x = (rnd() * 1180).toFixed(3), y = (rnd() * 830).toFixed(3); lines.push(`${x} ${y} m ${(+x + 0.8).toFixed(3)} ${(+y + 0.6).toFixed(3)} l S`); }
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 1190, 842], 0, {}, 'q 1 0 0 RG 2 w 100 100 m 600 500 l S 0 0 1 RG 0.1 w\n' + lines.join('\n') + '\nQ'));
  return d.saveToBuffer('compress,' + opts).asUint8Array().slice();
}
const OWNER_ONLY = 'encrypt=aes-256,owner-password=own,user-password=,permissions=-3904';
const USER_PW = 'encrypt=aes-256,owner-password=own,user-password=pw';
const docOf = (b: Uint8Array, pw?: string) => { const d = mupdf.Document.openDocument(b, 'application/pdf').asPDF()!; if (pw) d.authenticatePassword(pw); return d; };
const strokesOf = (b: Uint8Array, pw?: string) => { const d = docOf(b, pw); const c = d.findPage(0).get('Contents'); return countStrokes(Buffer.from((c.isArray() ? c.get(0) : c).readStream().asUint8Array())); };
const contentOf = (b: Uint8Array, pw?: string) => { const d = docOf(b, pw); const c = d.findPage(0).get('Contents'); return Buffer.from((c.isArray() ? c.get(0) : c).readStream().asUint8Array()); };
const red = (b: Uint8Array, pw?: string) => {
  const d = mupdf.Document.openDocument(b, 'application/pdf'); if (pw) d.authenticatePassword(pw);
  const px = d.loadPage(0).toPixmap(mupdf.Matrix.scale(0.5, 0.5), mupdf.ColorSpace.DeviceRGB, false, true).getPixels();
  let r = 0; for (let i = 0; i < px.length; i += 3) if (px[i] > 200 && px[i + 1] < 80 && px[i + 2] < 80) r++;
  return r;
};
const readSrc = (s: { path: string; extra?: ({ path: string; size: number } | { bytes: Uint8Array })[] }) => new Uint8Array(Buffer.concat([fs.readFileSync(s.path), ...(s.extra ?? []).map((x) => ('bytes' in x ? Buffer.from(x.bytes) : fs.readFileSync(x.path)))]));
function filesUnder(d: string): string[] { const out: string[] = []; const walk = (x: string) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory()) walk(p); else out.push(p); } }; if (fs.existsSync(d)) walk(d); return out; }

const h = await editHandlers();
// (smaller bars than the app's: test files are smaller)
mu.setContentMerger(makeMerger(undefined, 100_000));
mu.setHeavyRaw(1e6);
const wasm = fs.readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

function openFile(id: string, file: string, pw?: string) {
  const vf = new VFile({ path: file }) as InstanceType<typeof VFile> & { $src?: { path: string } };
  vf.$src = { path: file };
  return h.open(id, vf, pw) as { look?: boolean; needsPassword: boolean };
}

test('4.3: permissions-only file: heavy page drawn merged from a decrypted copy; its save stays encrypted, line work untouched', async () => {
  const bytes = heavyDoc(OWNER_ONLY);
  assert.equal(docOf(bytes).needsPassword(), false);
  assert.equal(docOf(bytes).getTrailer().get('Encrypt').isNull(), false, 'the test file is protected');
  const file = path.join(scratch, 'prot.pdf');
  fs.writeFileSync(file, bytes);
  const r = openFile('p', file);
  assert.equal(r.look, true, 'its pages are looked at');
  const c = (h.heavyCandidates('p', [0]) as { candidates: { key: string; streams: number[] }[] }).candidates[0];
  assert.ok(c, 'the heavy page is a candidate');
  const f = (await h.mergeForDisplay(new VFile({ path: file }), c.streams, false)) as { path: string; size: number } | null;
  assert.ok(f, 'merged (its content read decrypted)');
  assert.equal(h.attachDisplay('p', 0, c.key, c.streams, f), true);
  assert.equal(mu.drawPlain('p'), true);
  const snap = h.drawSnapshot('p') as { path: string; delta?: string; extra?: [] };
  assert.ok(!snap.delta && snap.extra?.length, 'a whole copy plus the display update');
  const copy = readSrc(snap);
  assert.equal(docOf(copy).getTrailer().get('Encrypt').isNull(), true, 'the drawing copy is decrypted');
  const s0 = strokesOf(bytes), s1 = strokesOf(copy);
  assert.ok(s0 >= 300_000 && s1 < s0 / 50, `strokes ${s0} -> ${s1}`);
  assert.equal(red(copy), red(bytes), 'same drawing');
  // PDFium opens it without a password and draws the page
  const info = pf.openDoc('pc', copy);
  assert.equal(info.pages.length, 1);
  const px = pf.render('pc', 0, 0.3, 0, 0, 200, 200);
  let dark = 0; for (let i = 0; i < px.length; i += 4) if (px[i + 2] > 150 && px[i] < 100) dark++;
  assert.ok(dark > 50, 'the merged line work is drawn');
  pf.closeDoc('pc');
  // the file's own save: still encrypted, the same line work
  const saved = mu.save('p') as Uint8Array;
  assert.equal(docOf(saved).getTrailer().get('Encrypt').isNull(), false, 'still protected (after a decrypted drawing copy was made)');
  // (and again after a second drawing copy, a full save this time)
  h.drawSnapshot('p');
  assert.equal(docOf(mu.save('p', { incremental: false }) as Uint8Array).getTrailer().get('Encrypt').isNull(), false, 'still protected');
  assert.ok(contentOf(saved).equals(contentOf(bytes)), 'line work unchanged');
  assert.equal(strokesOf(saved), s0);
  h.close('p');
});

test('4.3: a file that needs a password: not looked at, no decrypted copy written', async () => {
  const bytes = heavyDoc(USER_PW);
  assert.equal(docOf(bytes).needsPassword(), true);
  const file = path.join(scratch, 'pw.pdf');
  fs.writeFileSync(file, bytes);
  const r = openFile('q', file, 'pw');
  assert.equal(r.needsPassword, false);
  assert.ok(!r.look, 'not looked at');
  assert.deepEqual(h.heavyCandidates('q', [0]), { candidates: [], shown: [] });
  // (even with merged line work attached by hand, nothing decrypted is made)
  const f = await mu.mergeForDisplay(bytes, [], true);
  assert.equal(f, null);
  assert.equal(mu.drawPlain('q'), false);
  assert.throws(() => mu.snapshotTo('q', () => {}, true, undefined, true));
  const before = new Set(filesUnder(workDir()));
  h.drawSnapshot('q', true);
  h.drawSnapshot('q');
  for (const p of filesUnder(workDir())) {
    if (before.has(p)) continue;
    const b = fs.readFileSync(p);
    if (b.subarray(0, 5).toString('latin1') !== '%PDF-') continue;
    const d = mupdf.Document.openDocument(new Uint8Array(b), 'application/pdf').asPDF()!;
    assert.equal(d.needsPassword(), true, 'every PDF in the work folder still needs the password: ' + path.basename(p));
  }
  h.close('q');
});
