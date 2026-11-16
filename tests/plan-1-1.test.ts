// PLAN 1.1 (AUDIT B1): an edit on a page with a huge content stream must not decode that stream
// to find out whether the page is already wrapped in "q %GCC ... Q %GCC" - and wraps it once.
import '../src/engine/mupdf-pre.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';

/** one page whose content is `strokes` short strokes (~30 bytes each) */
function bigPage(strokes: number): Uint8Array {
  const d = new mupdf.PDFDocument();
  const parts: string[] = ['0.2 w 0 0 0 RG'];
  for (let i = 0; i < strokes; i++) { const x = (i * 7) % 1600 + 20, y = Math.floor(i / 230) % 1100 + 20; parts.push(`${x} ${y} m ${x + 2} ${y + 1} l S`); }
  const p = d.addPage([0, 0, 1684, 1191], 0, {}, parts.join('\n'));
  d.insertPage(-1, p);
  return d.saveToBuffer('compress').asUint8Array().slice();
}

const wrappers = (id: string) => {
  const o = mupdf.Document.openDocument(mu.save(id), 'application/pdf').asPDF()!;
  const c = o.findPage(0).get('Contents');
  let open = 0, close = 0;
  const n = c.isArray() ? c.length : 1;
  for (let i = 0; i < n; i++) {
    const s = c.isArray() ? c.get(i) : c;
    const len = s.get('Length').resolve();
    if (len.isNumber() && len.asNumber() > 256) continue;
    const t = s.readStream().asString();
    if (t.startsWith('q %GCC')) open++;
    if (t.includes('Q %GCC')) close++;
  }
  return { open, close };
};

test('1.1: two flattens on a 6 MB content page: wrapped once, the big stream never decoded', () => {
  mu.open('w11', bigPage(200_000));
  // count every decode of the big content stream (compressed > 50 KB) from here on
  const proto = (mupdf as unknown as { PDFObject: { prototype: { readStream: () => unknown; get: (k: string) => mupdf.PDFObject } } }).PDFObject.prototype;
  const orig = proto.readStream;
  let bigDecodes = 0;
  proto.readStream = function (this: mupdf.PDFObject) {
    try { const l = this.get('Length').resolve(); if (l.isNumber() && l.asNumber() > 50_000) bigDecodes++; } catch { /* not a stream */ }
    return orig.call(this);
  };
  try {
    for (let k = 0; k < 2; k++) {
      const a = mu.createAnnot('w11', 0, { type: 'Square', rect: [100 + k * 50, 100, 140 + k * 50, 140], color: [1, 0, 0] } as never);
      const t = performance.now();
      assert.equal(mu.flatten('w11', [{ page: 0, id: a.id }]), 1);
      assert.ok(performance.now() - t < 2000, 'flatten is quick');
    }
  } finally { proto.readStream = orig; }
  assert.equal(bigDecodes, 0, 'the page content was decoded during an edit');
  assert.deepEqual(wrappers('w11'), { open: 1, close: 1 }, 'wrapped exactly once');
  mu.close('w11');
});
