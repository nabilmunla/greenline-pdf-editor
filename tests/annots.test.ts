// Every markup type: create, move, resize, rotate, restyle, edit text, undo - on upright and
// turned pages - and the geometry must be exactly what the user did.
// npx tsx --test tests/annots.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { guardMupdf, mupdfErrors } from '../src/engine/mupdf-guard';

mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));
guardMupdf(mupdf);

function doc(rot: number): Uint8Array {
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 595, 842], rot as 0, {}, ''));
  return d.saveToBuffer('').asUint8Array().slice();
}

type A = mu.AnnotData;
const pts = (a: A): mu.Pt[] => [
  ...(a.line || []), ...(a.vertices || []), ...((a.ink || []).flat()),
  ...((a.quads || []).flatMap((q) => [[q[0], q[1]], [q[6], q[7]]] as mu.Pt[])),
];
const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;
const box = (a: A) => {
  // a pencil's box is its strokes (the rect also holds the line width)
  if (a.ink) { const p = a.ink.flat(); return [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))] as mu.Rect; }
  return a.box || a.rect;
};

const SPECS: [string, mu.AnnotSpec, { resize?: boolean; rotate?: boolean; text?: boolean }][] = [
  ['rectangle', { type: 'Square', rect: [100, 100, 200, 160], color: [1, 0, 0], bw: 2 }, { resize: true, rotate: true }],
  ['cloud rect', { type: 'Square', rect: [100, 100, 200, 160], color: [1, 0, 0], cloudy: 1 }, { resize: true, rotate: true }],
  ['ellipse', { type: 'Circle', rect: [100, 100, 180, 150], color: [0, 0, 1], ic: [1, 1, 0] }, { resize: true, rotate: true }],
  ['line', { type: 'Line', line: [[100, 100], [250, 180]], color: [0, 0, 0] }, {}],
  ['arrow', { type: 'Line', line: [[100, 100], [250, 180]], le: ['None', 'ClosedArrow'] }, {}],
  ['polyline', { type: 'PolyLine', vertices: [[100, 100], [160, 140], [220, 110]] }, {}],
  ['polygon', { type: 'Polygon', vertices: [[100, 100], [200, 100], [150, 180]], ic: [0, 1, 0] }, {}],
  ['cloud polygon', { type: 'Polygon', vertices: [[100, 100], [200, 100], [150, 180]], cloudy: 1, kind: 'cloud' }, {}],
  ['pencil', { type: 'Ink', ink: [[[100, 100], [130, 140], [170, 120]]] }, { resize: true }],
  ['highlight', { type: 'Highlight', quads: [[100, 100, 200, 100, 100, 112, 200, 112]], color: [1, 1, 0] }, {}],
  ['text box', { type: 'FreeText', rect: [100, 100, 260, 130], contents: 'Hello', font: { size: 11, color: [0, 0, 0] }, kind: 'textbox' }, { resize: true, rotate: true, text: true }],
  ['typewriter', { type: 'FreeText', rect: [100, 100, 320, 120], contents: 'Typed', color: null, bw: 0, font: { size: 11, color: [0, 0, 0] }, kind: 'typewriter' }, { resize: true, text: true }],
  ['callout', { type: 'FreeText', rect: [300, 300, 450, 340], contents: '', intent: 'FreeTextCallout', callout: [[200, 200]], font: { size: 11, color: [0, 0, 0] }, kind: 'callout' }, { resize: true, text: true }],
  ['note', { type: 'Text', rect: [100, 100, 120, 120], icon: 'Comment', contents: 'note' }, {}],
  ['stamp', { type: 'Stamp', rect: [100, 100, 220, 140], design: { lines: [{ text: 'APPROVED', size: 16, bold: true }], color: [0, 0.4, 0], border: 'rounded' }, kind: 'stamp' }, { resize: true, rotate: true }],
  ['length', { type: 'Line', line: [[100, 100], [300, 100]], contents: '5.00 m', kind: 'measure-length' }, {}],
  ['area', { type: 'Polygon', vertices: [[100, 100], [200, 100], [200, 200]], contents: '5 m²', kind: 'measure-area' }, {}],
  ['count', { type: 'Circle', rect: [100, 100, 110, 110], kind: 'measure-count', group: 'D1', contents: 'D1 #1' }, {}],
  ['redaction', { type: 'Redact', rect: [100, 100, 200, 120] }, { resize: true }],
];

/** the text the markups on page 1 show (from their appearance) */
function shownText(id: string) {
  const out = mu.save(id);
  const d = mupdf.Document.openDocument(out, 'application/pdf');
  const p = d.loadPage(0) as mupdf.PDFPage;
  let s = '';
  for (const a of p.getAnnotations()) { const st = a.toDisplayList().toStructuredText(''); st.walk({ onChar(c: string) { s += c; }, endLine() { s += ' '; } } as never); }
  return s.replace(/\s+/g, ' ');
}

for (const rot of [0, 90]) {
  for (const [name, spec, can] of SPECS) {
    test(`${name} on a ${rot ? 'turned' : 'upright'} page`, () => {
      const id = `${name}-${rot}`;
      mu.open(id, doc(rot));
      const a0 = mu.createAnnot(id, 0, spec);
      // created where asked
      if (spec.rect && spec.type !== 'Text' && spec.type !== 'Stamp') {
        const b = box(a0);
        if (spec.kind !== 'callout' && spec.kind !== 'textbox') assert.ok(near(b[0], spec.rect[0], 2) && near(b[1], spec.rect[1], 2), `${name}: created at ${b.map(Math.round)} not ${spec.rect}`);
        else assert.ok(near(b[0], spec.rect[0], 0.6) && near(b[1], spec.rect[1], 0.6) && near(b[2], spec.rect[2], 0.6), `${name}: box ${b.map(Math.round)} not ${spec.rect}`);
      }
      if (spec.callout) assert.deepEqual(a0.callout![0].map(Math.round), spec.callout[0], 'callout tip');
      // move by (15, -10): every point moves by exactly that
      const a1 = mu.moveAnnots(id, [{ page: 0, id: a0.id }], 15, -10)[0];
      const b0 = box(a0), b1 = box(a1);
      assert.ok(near(b1[0] - b0[0], 15) && near(b1[1] - b0[1], -10) && near(b1[2] - b0[2], 15) && near(b1[3] - b0[3], -10), `${name}: box moved ${b0.map(Math.round)} -> ${b1.map(Math.round)}`);
      const p0 = pts(a0), p1 = pts(a1);
      assert.equal(p1.length, p0.length, `${name}: points kept`);
      p0.forEach((p, i) => assert.ok(near(p1[i][0] - p[0], 15) && near(p1[i][1] - p[1], -10), `${name}: point ${i} moved ${p} -> ${p1[i]}`));
      if (a0.callout) {
        assert.deepEqual(a1.callout![0].map(Math.round), a0.callout[0].map(Math.round), 'callout tip stays where it points');
        const end = a1.callout![a1.callout!.length - 1];
        const r = a1.rect;
        assert.ok(end[0] >= r[0] - 0.6 && end[0] <= r[2] + 0.6 && end[1] >= r[1] - 0.6 && end[1] <= r[3] + 0.6, `callout line ends on the box: ${end} box ${r.map(Math.round)}`);
      }
      // resize
      let last = a1;
      if (can.resize) {
        const t: mu.Rect = [b1[0], b1[1], b1[2] + 40, b1[3] + 30];
        last = mu.resizeAnnot(id, 0, a1.id, t);
        const b2 = box(last);
        // every side, the height too (it was never checked, and stamps had 40 pt of slack): a
        // designed stamp keeps its proportions on purpose (drawStamp - the width decides, the
        // height follows), everything else takes the box asked for
        const tol = spec.type === 'Ink' ? 3 : 1;
        const bottom = spec.type === 'Stamp' ? b2[1] + ((b2[2] - b2[0]) * (b1[3] - b1[1])) / (b1[2] - b1[0]) : t[3];
        assert.ok(near(b2[0], t[0], tol) && near(b2[1], t[1], tol) && near(b2[2], t[2], tol) && near(b2[3], bottom, tol), `${name}: resized to ${b2.map(Math.round)}, asked ${t.map(Math.round)}`);
      }
      if (can.rotate) {
        const before = box(last);
        last = mu.updateAnnots(id, [{ page: 0, id: a1.id, patch: { angle: 30 } }])[0];
        assert.equal(last.angle, 30, `${name}: angle`);
        const after = box(last);
        assert.ok(before.every((v, i) => near(v, after[i], 1)), `${name}: rotating kept the box ${before.map(Math.round)} -> ${after.map(Math.round)}`);
        // moving a turned markup moves it
        const m = mu.moveAnnots(id, [{ page: 0, id: a1.id }], 5, 5)[0];
        assert.ok(near(box(m)[0] - after[0], 5), `${name}: turned markup moves`);
        last = m;
      }
      // restyle keeps the geometry
      const g = box(last);
      const c = mu.updateAnnots(id, [{ page: 0, id: a1.id, patch: { color: [0.2, 0.5, 0.2], opacity: 0.6 } }])[0];
      assert.ok(box(c).every((v, i) => near(v, g[i], 1)), `${name}: colour change moved it ${g.map(Math.round)} -> ${box(c).map(Math.round)}`);
      if (can.text) {
        const long = 'This is a much longer piece of text that will not fit on one line of this box at all, so it must wrap onto several lines';
        const tx = mu.updateAnnots(id, [{ page: 0, id: a1.id, patch: { contents: long } }])[0];
        assert.equal(tx.contents, long);
        assert.ok(near(box(tx)[0], g[0], 1) && near(box(tx)[1], g[1], 1), `${name}: grows downwards only`);
        // every word shows (MuPDF cuts off what doesn't fit in the box)
        const shown = shownText(id);
        for (const w of long.split(' ')) assert.ok(shown.includes(w), `${name}: "${w}" not shown (box ${box(tx).map(Math.round)}): ${shown}`);
        const al = mu.updateAnnots(id, [{ page: 0, id: a1.id, patch: { quadding: 1, font: { size: 14, color: [1, 0, 0], family: 'TiRo' } } }])[0];
        assert.equal(al.quadding, 1);
        assert.equal(al.font?.family, 'TiRo');
        assert.equal(al.font?.size, 14);
      }
      // undo everything: back to nothing
      while (mu.history(id).undo.length) mu.undo(id);
      assert.equal(mu.annots(id, 0).length, 0, `${name}: undo removed it`);
      while (mu.history(id).redo.length) mu.redo(id);
      assert.equal(mu.annots(id, 0).length, spec.irt ? 2 : 1, `${name}: redo`);
      // the saved file has it
      const out = mu.save(id);
      const d2 = mupdf.Document.openDocument(out, 'application/pdf').asPDF()!;
      assert.equal((d2.loadPage(0) as mupdf.PDFPage).getAnnotations().filter((x) => x.getType() !== 'Popup').length, 1, `${name}: saved`);
      mu.close(id);
    });
  }
}

test('a text box made after an undo still has its font (MuPDF kept pointing at the removed one)', () => {
  mu.open('uf', doc(0));
  mu.createAnnot('uf', 0, { type: 'FreeText', rect: [100, 400, 300, 440], contents: 'One', font: { size: 11, color: [1, 0, 0] }, kind: 'textbox' });
  mu.undo('uf');
  const a = mu.createAnnot('uf', 0, { type: 'FreeText', rect: [100, 400, 300, 440], contents: 'Two', font: { size: 11, color: [1, 0, 0] }, kind: 'textbox' });
  assert.equal(a.callout, undefined, 'a plain text box has no callout line');
  const d2 = mupdf.Document.openDocument(mu.save('uf'), 'application/pdf').asPDF()!;
  const an = (d2.loadPage(0) as mupdf.PDFPage).getAnnotations()[0];
  const f = an.getObject().get('AP', 'N', 'Resources', 'Font', 'Helv');
  assert.ok(f.isIndirect() && f.resolve().get('BaseFont').asName() === 'Helvetica', 'font is there: ' + f);
  // and the text sits inside the box with some room
  let first: number[] | null = null;
  an.toDisplayList().toStructuredText('').walk({ onChar(_c: string, _o: number[], _f: unknown, _s: number, q: number[]) { first ??= q; } } as never);
  assert.ok(first && first[0] >= a.rect[0] + 3, 'left padding: ' + first);
  mu.close('uf');
});

test('copy / paste: every kind, in the same file, into another one, onto a turned page', () => {
  mu.open('cp1', doc(0));
  mu.open('cp2', doc(0));
  mu.open('cp3', doc(90));
  const made = SPECS.filter(([, sp]) => !sp.irt).map(([n, sp]) => [n, mu.createAnnot('cp1', 0, sp)] as const);
  for (const target of ['cp1', 'cp2', 'cp3']) {
    const before = mu.annots(target, 0).length;
    const out = mu.copyAnnots('cp1', made.map(([, a]) => ({ page: 0, id: a.id })), target, 0, 20, 30);
    assert.equal(out.length, made.length, 'all pasted');
    assert.equal(mu.annots(target, 0).length, before + made.length);
    out.forEach((b, i) => {
      const [n, a] = made[i];
      assert.equal(b.type, a.type, n);
      assert.equal(b.kind, a.kind, n);
      assert.equal(b.contents || '', a.contents || '', n + ' text');
      const ba = box(a), bb = box(b);
      assert.ok(near(bb[0] - ba[0], 20, 1) && near(bb[1] - ba[1], 30, 1), `${n}: pasted 20,30 further (${ba.map(Math.round)} -> ${bb.map(Math.round)})`);
      if (a.callout) assert.ok(near(b.callout![0][0] - a.callout[0][0], 20, 1), n + ': callout tip moves with the copy');
    });
    // the original is untouched by changes to the copy
    mu.updateAnnots(target, out.map((b) => ({ page: 0, id: b.id, patch: { color: [0, 1, 0] } })));
    const orig = mu.annots('cp1', 0).find((x) => x.id === made[0][1].id)!;
    assert.deepEqual(orig.color, made[0][1].color, 'original keeps its colour');
    mu.undo(target);
    mu.undo(target);
    assert.equal(mu.annots(target, 0).length, before, 'one undo removes the paste');
  }
  mu.close('cp1'); mu.close('cp2'); mu.close('cp3');
});

test('a picture stamp keeps its picture: move, resize, turn, then move / restyle / copy again', () => {
  for (const rot of [0, 90]) {
    mu.open('img', doc(rot));
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false);
    pix.clear(200);
    const a = mu.createAnnot('img', 0, { type: 'Stamp', image: pix.asPNG().slice(), rect: [100, 100, 300, 200], kind: 'image', subject: 'Picture' });
    const pictures = () => {
      const p = mupdf.Document.openDocument(mu.save('img'), 'application/pdf').loadPage(0) as mupdf.PDFPage;
      return p.getAnnotations().map((an) => { let n = 0; an.toDisplayList().run(new mupdf.Device({ fillImage() { n++; } } as never), mupdf.Matrix.identity); return n; });
    };
    const steps: [string, () => void][] = [
      ['move', () => mu.moveAnnots('img', [{ page: 0, id: a.id }], 20, 20)],
      ['resize', () => mu.resizeAnnot('img', 0, a.id, [120, 120, 400, 300])],
      ['turn', () => mu.updateAnnots('img', [{ page: 0, id: a.id, patch: { angle: 30 } }])],
      ['move turned', () => mu.moveAnnots('img', [{ page: 0, id: a.id }], 5, 5)],
      ['comment', () => mu.updateAnnots('img', [{ page: 0, id: a.id, patch: { contents: 'seal' } }])],
      ['opacity', () => mu.updateAnnots('img', [{ page: 0, id: a.id, patch: { opacity: 0.5 } }])],
      ['copy', () => mu.copyAnnots('img', [{ page: 0, id: a.id }], 'img', 0, 30, 30)],
    ];
    for (const [n, f] of steps) { f(); assert.ok(pictures().every((x) => x === 1), `${rot}: picture still there after ${n}: ${pictures()}`); }
    const b = mu.annots('img', 0)[0];
    assert.equal(b.angle, 30);
    mu.close('img');
  }
});

test("moving another app's markups keeps their own drawing (hatches, rich text...)", () => {
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  const p = d.loadPage(0) as mupdf.PDFPage;
  for (const t of ['Square', 'FreeText', 'Polygon', 'Ink'] as const) {
    const a = p.createAnnotation(t);
    if (t === 'Polygon') a.setVertices([[100, 300], [200, 300], [150, 380]]);
    else if (t === 'Ink') a.setInkList([[[300, 300], [350, 340], [400, 310]]]);
    else a.setRect([100, 100, 200, 160]);
    if (t === 'FreeText') a.setContents('rich');
    a.setFlags(4);
    a.update();
    const r = arr4(a.getObject().get('Rect'));
    const ap = d.addStream('% FOREIGN-AP\n0 0 1 RG ' + `${r[0]} ${r[1]} m ${r[2]} ${r[3]} l S`, { Type: 'XObject', Subtype: 'Form', BBox: r });
    const apd = d.newDictionary(); apd.put('N', ap); a.getObject().put('AP', apd);
  }
  mu.open('fa', d.saveToBuffer('').asUint8Array().slice());
  const before = mu.annots('fa', 0);
  mu.moveAnnots('fa', before.map((a) => ({ page: 0, id: a.id })), 30, 40);
  const q = mupdf.Document.openDocument(mu.save('fa'), 'application/pdf').asPDF()!;
  for (const a of (q.loadPage(0) as mupdf.PDFPage).getAnnotations()) {
    assert.ok(a.getObject().get('AP', 'N').readStream().asString().includes('FOREIGN-AP'), a.getType() + ' kept its drawing');
  }
  mu.annots('fa', 0).forEach((a, i) => { const b0 = box(before[i]), b1 = box(a); assert.ok(near(b1[0] - b0[0], 30) && near(b1[1] - b0[1], 40), `${a.type} moved`); });
  mu.undo('fa');
  assert.ok(near(box(mu.annots('fa', 0)[0])[0], box(before[0])[0]), 'undo puts it back');
  mu.close('fa');
});
const arr4 = (o: mupdf.PDFObject) => [0, 1, 2, 3].map((i) => o.get(i).asNumber()) as [number, number, number, number];

test('an action that changes nothing is not an undo step (it made Undo undo the wrong thing)', () => {
  mu.open('noop', doc(0));
  const a = mu.createAnnot('noop', 0, { type: 'Square', rect: [10, 10, 100, 100] });
  const b = mu.createAnnot('noop', 0, { type: 'Circle', rect: [200, 200, 300, 300] });
  mu.updateAnnots('noop', [{ page: 0, id: b.id, patch: { locked: true } }]);
  assert.equal(mu.deleteAnnots('noop', [{ page: 0, id: b.id }]), 0, 'locked: not deleted');
  mu.moveAnnots('noop', [], 5, 5);
  assert.deepEqual(mu.history('noop').undo, ['Add square', 'Add circle', 'Change markup']);
  mu.undo('noop');
  assert.equal(mu.annots('noop', 0).find((x) => x.id === b.id)?.locked, false, 'first undo: the lock');
  mu.undo('noop');
  assert.deepEqual(mu.annots('noop', 0).map((x) => x.id), [a.id], 'second undo: the circle');
  mu.undo('noop');
  assert.equal(mu.annots('noop', 0).length, 0, 'third: the square');
  assert.equal(mu.history('noop').undo.length, 0, 'nothing left to undo');
  mu.close('noop');
});

test('an upside-down box on a callout does not hang MuPDF (it looped forever: a paste froze the app)', { timeout: 20000 }, () => {
  mu.open('inv', doc(90));
  const c = mu.createAnnot('inv', 0, { type: 'FreeText', rect: [300, 300, 450, 340], contents: 'x', intent: 'FreeTextCallout', callout: [[200, 200]], font: { size: 11, color: [0, 0, 0] }, kind: 'callout' });
  const r = mu.resizeAnnot('inv', 0, c.id, [450, 380, 300, 300]);
  assert.ok(r.rect[0] < r.rect[2] && r.rect[1] < r.rect[3], 'box in order');
  mu.updateAnnots('inv', [{ page: 0, id: c.id, patch: { rect: [500, 500, 400, 450] } }]);
  // turning a callout is refused (its box came out upside down)
  const t = mu.updateAnnots('inv', [{ page: 0, id: c.id, patch: { angle: 90 } }])[0];
  assert.ok(!t.angle && t.rect[0] < t.rect[2] && t.rect[1] < t.rect[3], 'callout not turned');
  mu.close('inv');
});

test('a pasted callout keeps its tip on the page', () => {
  mu.open('tip', doc(0));
  const c = mu.createAnnot('tip', 0, { type: 'FreeText', rect: [400, 600, 550, 640], contents: 'x', intent: 'FreeTextCallout', callout: [[20, 30]], font: { size: 11, color: [0, 0, 0] }, kind: 'callout' });
  const [b] = mu.copyAnnots('tip', [{ page: 0, id: c.id }], 'tip', 0, -350, -500);
  assert.ok(b.callout![0][0] >= -0.5 && b.callout![0][1] >= -0.5, 'tip on the page: ' + b.callout![0]);
  mu.close('tip');
});

test('a text box that fits its text: grows and shrinks with it, wraps at its limit, keeps a size given by hand', () => {
  for (const rot of [0, 90]) {
    mu.open('fit', doc(rot));
    const a = mu.createAnnot('fit', 0, { type: 'FreeText', rect: [100, 100, 120, 115], contents: '', color: [1, 1, 0.8], bw: 1, font: { size: 11, color: [1, 0, 0] }, kind: 'textbox', autoWidth: 300 });
    const w = (b: A) => b.rect[2] - b.rect[0], h = (b: A) => b.rect[3] - b.rect[1];
    const short = mu.updateAnnots('fit', [{ page: 0, id: a.id, patch: { contents: 'A short note' } }])[0];
    const long = mu.updateAnnots('fit', [{ page: 0, id: a.id, patch: { contents: 'A much longer note that will certainly not fit within three hundred points so it wraps' } }])[0];
    const back = mu.updateAnnots('fit', [{ page: 0, id: a.id, patch: { contents: 'Hi' } }])[0];
    assert.ok(w(short) > 40 && w(short) < 90 && h(short) < 22, `${rot}: one short line ${short.rect.map(Math.round)}`);
    assert.ok(w(long) > 200 && w(long) <= 302 && h(long) > 25, `${rot}: wraps at the limit ${long.rect.map(Math.round)}`);
    assert.ok(w(back) < w(short) && h(back) < 22, `${rot}: shrinks again ${back.rect.map(Math.round)}`);
    assert.ok(near(back.rect[0], 100, 1) && near(back.rect[1], 100, 1), 'top-left stays');
    const fixed = mu.resizeAnnot('fit', 0, a.id, [100, 100, 200, 140]);
    assert.ok(!fixed.autoWidth, 'resized by hand: fixed size');
    const t = mu.updateAnnots('fit', [{ page: 0, id: a.id, patch: { contents: 'x' } }])[0];
    assert.ok(near(w(t), 100, 2), 'fixed width kept ' + t.rect.map(Math.round));
    mu.close('fit');
  }
});

test('deleting or flattening a comment takes all its replies (every other one stayed); a locked reply keeps the thread', () => {
  mu.open('thr', doc(0));
  const c = mu.createAnnot('thr', 0, { type: 'Square', rect: [100, 100, 200, 160], color: [1, 0, 0] });
  for (const t of ['one', 'two', 'three']) mu.createAnnot('thr', 0, { type: 'Text', irt: c.id, contents: t });
  const r3 = mu.annots('thr', 0).find((a) => a.contents === 'three')!;
  mu.createAnnot('thr', 0, { type: 'Text', irt: r3.id, contents: 'answer to three' });
  assert.equal(mu.deleteAnnots('thr', [{ page: 0, id: c.id }]), 1);
  assert.equal(mu.annots('thr', 0).length, 0, 'no replies left behind: ' + mu.annots('thr', 0).map((a) => a.contents));
  mu.undo('thr');
  // a locked reply: the thread stays as it is
  const one = mu.annots('thr', 0).find((a) => a.contents === 'one')!;
  mu.updateAnnots('thr', [{ page: 0, id: one.id, patch: { locked: true } }]);
  assert.equal(mu.deleteAnnots('thr', [{ page: 0, id: c.id }]), 0);
  assert.equal(mu.annots('thr', 0).length, 5);
  mu.updateAnnots('thr', [{ page: 0, id: one.id, patch: { locked: false } }]);
  mu.flatten('thr', [{ page: 0, id: c.id }]);
  assert.equal(mu.annots('thr', 0).length, 0, 'flattened: its replies are gone too');
  mu.close('thr');
});

test('lock, hide and copy leave a markup kept out of print out of print', () => {
  const d = new mupdf.PDFDocument(doc(0));
  const sq = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Square'), Rect: [100, 600, 200, 700], C: [0, 0, 1], F: 0 });
  d.findPage(0).put('Annots', [sq]);
  mu.open('prt', d.saveToBuffer('').asUint8Array().slice());
  const a = mu.annots('prt', 0)[0];
  mu.updateAnnots('prt', [{ page: 0, id: a.id, patch: { locked: true } }]);
  mu.updateAnnots('prt', [{ page: 0, id: a.id, patch: { locked: false, hidden: true } }]);
  mu.updateAnnots('prt', [{ page: 0, id: a.id, patch: { hidden: false } }]);
  const copy = mu.copyAnnots('prt', [{ page: 0, id: a.id }], 'prt', 0, 0, 120)[0];
  const f = new mupdf.PDFDocument(mu.save('prt')).loadPage(0) as mupdf.PDFPage;
  for (const x of f.getAnnotations()) assert.equal(x.getFlags() & 4, 0, 'not printing: ' + x.getObject().asIndirect() + ' / copy ' + copy.id);
  mu.close('prt');
});

test("a copy of another program's markup keeps its own drawing (hatching), shifted", () => {
  const d = new mupdf.PDFDocument(doc(0));
  const ap = d.addStream('% hatch\n0 0 1 RG 0 0 m 100 60 l 20 0 m 100 48 l S', { Type: d.newName('XObject'), Subtype: d.newName('Form'), BBox: [0, 0, 100, 60] });
  const sq = d.addObject({ Type: d.newName('Annot'), Subtype: d.newName('Square'), Rect: [100, 600, 200, 660], C: [0, 0, 1], F: 4, AP: { N: ap } });
  d.findPage(0).put('Annots', [sq]);
  mu.open('hatch', d.saveToBuffer('').asUint8Array().slice());
  const a = mu.annots('hatch', 0)[0];
  const c = mu.copyAnnots('hatch', [{ page: 0, id: a.id }], 'hatch', 0, 50, 0)[0];
  const f = new mupdf.PDFDocument(mu.save('hatch'));
  const cp = (f.loadPage(0) as mupdf.PDFPage).getAnnotations().find((x) => x.getObject().get('Rect').get(0).asNumber() > 120)!;
  assert.ok(cp.getObject().get('AP', 'N').readStream().asString().includes('% hatch'), 'its own drawing came along');
  assert.ok(near(c.rect[0], 150) && near(c.rect[2], 250), 'shifted: ' + c.rect.map(Math.round));
  mu.close('hatch');
});

test('a short measured length: its arrow heads are no longer than half the line (they overlapped into a blob)', () => {
  mu.open('short', doc(0));
  const m = mu.createAnnot('short', 0, { type: 'Line', line: [[100, 100], [106, 100]], le: ['ClosedArrow', 'ClosedArrow'], contents: '0.05 m', kind: 'measure-length', labelSize: 12 });
  const f = new mupdf.PDFDocument(mu.save('short'));
  const a = (f.loadPage(0) as mupdf.PDFPage).getAnnotations().find((x) => x.getObject().asIndirect() === m.id)!;
  const s = a.getObject().get('AP', 'N').readStream().asString();
  const heads = [...s.matchAll(/([-\d.]+) ([-\d.]+) m ([-\d.]+) ([-\d.]+) l ([-\d.]+) ([-\d.]+) l h b/g)].map((g) => g.slice(1).map(Number));
  assert.equal(heads.length, 2, s);
  for (const h of heads) {
    const backX = (h[0] + h[4]) / 2;
    assert.ok(Math.abs(backX - h[2]) <= 3.01, `arrow ${Math.abs(backX - h[2]).toFixed(2)} pt long on a 6 pt line`);
  }
  mu.close('short');
});

test('no MuPDF errors in any of it', () => { assert.equal(mupdfErrors(), 0); });
