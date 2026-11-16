// PLAN 4.4 (mu.ts displayOverlay): the drawing copy's page objects are rebuilt as text, and their
// keys were written raw: a key with a space or a '#' broke the page object (a blank page in the
// drawing copy). Keys are now written with #xx escapes (ISO 32000-1 7.3.5). Based on the 3.1 test.
import '../src/engine/mupdf-pre.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import * as pf from '../src/engine/pdfium';
import { makeMerger } from '../src/engine/heavy';
import { lastXref } from '../src/engine/overlay';

const dir = mkdtempSync(join(tmpdir(), 'p44-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const store = (b: Uint8Array) => { const p = join(dir, `m${n++}.bin`); writeFileSync(p, b); return { path: p, size: b.length }; };

/** `strokes` short scattered strokes + a blue line; the page dictionary gets keys that need escaping:
 * a space, a '#', and a '(' (a raw '(' opens a string in the page object and breaks it) */
function heavyDoc(strokes: number): Uint8Array {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const lines: string[] = [];
  for (let i = 0; i < strokes; i++) { const x = (rnd() * 1180).toFixed(3), y = (rnd() * 830).toFixed(3); lines.push(`${x} ${y} m ${(+x + 0.8).toFixed(3)} ${(+y + 0.6).toFixed(3)} l S`); }
  const d = new mupdf.PDFDocument();
  const p1 = d.addStream('q 1 0 0 RG 2 w 100 100 m 600 500 l', {});
  const p2 = d.addStream('S 0 0 1 RG 0.1 w\n' + lines.join('\n') + '\nQ', {});
  const contents = d.newArray(); contents.push(p1); contents.push(p2);
  const pg = d.addPage([0, 0, 1190, 842], 0, {}, '');
  pg.put('Contents', contents);
  pg.put('My Key', 1);
  pg.put('My#Key', 2);
  pg.put('Paren(Key', 3);
  d.insertPage(-1, pg);
  return d.saveToBuffer('compress').asUint8Array().slice();
}
/** the drawing engines' copy: the file + the display update (as host.ts drawSnapshot makes it) */
function drawingCopy(id: string, bytes: Uint8Array): Uint8Array {
  const extra = mu.displayOverlay(id, bytes.length, lastXref(bytes.subarray(bytes.length - 4096)));
  assert.ok(extra, 'a display update');
  const parts: Uint8Array[] = [bytes];
  for (const x of extra) parts.push('bytes' in x ? x.bytes : new Uint8Array(readFileSync(x.path)));
  return new Uint8Array(Buffer.concat(parts));
}

test('4.4: a page dictionary key that needs escaping (space, #) does not break the drawing copy', async () => {
  const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  mu.setContentMerger(makeMerger(undefined, 100_000));
  mu.setDisplayStore(store);
  mu.setHeavyRaw(1e6);
  try {
    const bytes = heavyDoc(300_000);
    assert.ok(bytes.length > 1e6, 'big enough to be looked at: ' + bytes.length);
    const r = mu.open('k', bytes);
    assert.ok(r.look, 'pages to look at');
    const c = mu.heavyCandidates('k', [0]).candidates[0];
    assert.ok(c, 'the page is a candidate');
    const f = await mu.mergeForDisplay(bytes, c.streams);
    assert.ok(f, 'merged');
    assert.equal(mu.attachDisplay('k', 0, c.key, c.streams, f!), true);
    const copy = drawingCopy('k', bytes);
    // PDFium reads the copy: the page is there and draws (the merged blue line work)
    const info = pf.openDoc('kc', copy);
    assert.equal(info.pages.length, 1, 'page count');
    const w = Math.round(info.pages[0].w * 0.25), h = Math.round(info.pages[0].h * 0.25);
    const px = pf.render('kc', 0, 0.25, 0, 0, w, h);
    assert.equal(px.length, w * h * 4, 'a tile');
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) ink++;
    assert.ok(ink > 100, 'the page draws: non-white pixels ' + ink);
    pf.closeDoc('kc');
    mu.close('k');
  } finally {
    mu.setContentMerger(null);
    mu.setDisplayStore(null);
    mu.setHeavyRaw(2e6);
  }
});
