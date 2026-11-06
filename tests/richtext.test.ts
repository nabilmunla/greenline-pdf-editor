// Rich text in text boxes: the run model, the standard rich text (/RC) both ways, and the engine
// (drawn per style, saved, opened again, moved, turned, flattened, undone; other programs' rich
// text read in). npx tsx --test tests/richtext.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import { guardMupdf } from '../src/engine/mupdf-guard';
import { styleRange, settle, reflowRuns, toRC, fromRC, cleanRuns, runsText, rangeStyle, dropKey, type TextRun, type BaseStyle } from '../src/engine/richtext';

mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));
guardMupdf(mupdf);

const BASE: BaseStyle = { family: 'Helv', size: 11, color: [0, 0, 0], bold: false, italic: false };
const R = (...rs: TextRun[]) => rs;
/** each visible letter with its style (line ends carry no look of their own) */
const letters = (rs: TextRun[]) => rs.flatMap((r) => [...r.t].filter((c) => c !== '\n').map((c) => JSON.stringify({ ...cleanRuns([{ ...r, t: 'x' }])[0], t: c })));

test('styleRange: only the selected part changes', () => {
  const rs = styleRange([{ t: 'Please check the beam' }], 7, 12, { b: true });
  assert.deepEqual(rs, [{ t: 'Please ' }, { t: 'check', b: true }, { t: ' the beam' }]);
  // across runs, and back to the box's own (undefined)
  const r2 = styleRange(rs, 0, 12, { b: undefined, c: [1, 0, 0] });
  assert.deepEqual(r2, [{ t: 'Please check', c: [1, 0, 0] }, { t: ' the beam' }]);
});

test('settle: what equals the box goes; what all of it has becomes the box\'s', () => {
  assert.equal(settle(BASE, R({ t: 'abc', b: false, s: 11 })).runs, undefined);
  const all = settle(BASE, R({ t: 'abc', b: true }, { t: 'def', b: true, i: true }));
  assert.equal(all.base.bold, true);
  assert.deepEqual(all.runs, [{ t: 'abc' }, { t: 'def', i: true }]);
  // a size over all of it: the box's size (lines then as tall as the text, as in the typing box)
  const sz = settle(BASE, R({ t: 'ab', s: 14 }, { t: 'cd', s: 14, u: true }));
  assert.equal(sz.base.size, 14);
  assert.deepEqual(sz.runs, [{ t: 'ab' }, { t: 'cd', u: true }]);
  // underline has no box setting: stays in the runs
  assert.deepEqual(settle(BASE, R({ t: 'ab', u: true })).runs, [{ t: 'ab', u: true }]);
});

test('reflowRuns: text changed elsewhere keeps the styles of what stayed', () => {
  const rs = R({ t: 'Check ' }, { t: 'beam', b: true }, { t: ' depth' });
  assert.deepEqual(reflowRuns(rs, 'Check the beam depth'), [{ t: 'Check the ' }, { t: 'beam', b: true }, { t: ' depth' }]);
  assert.deepEqual(reflowRuns(rs, 'Check beams depth'), [{ t: 'Check ' }, { t: 'beams', b: true }, { t: ' depth' }]);
  assert.equal(runsText(reflowRuns(rs, '')), '');
});

test('rangeStyle: the bar shows what the selection has alike', () => {
  const rs = R({ t: 'ab' }, { t: 'cd', b: true });
  assert.equal(rangeStyle(BASE, rs, 2, 4).bold, true);
  assert.equal(rangeStyle(BASE, rs, 1, 4).bold, undefined);
  // nothing selected: all of the text
  assert.equal(rangeStyle(BASE, rs, 3, 3).bold, undefined);
  assert.equal(rangeStyle(BASE, rs, 3, 3).size, 11);
});

test('/RC written and read back the same', () => {
  const rs = R({ t: 'Plain & <x> ' }, { t: 'bold', b: true }, { t: ' red\n', c: [1, 0, 0] }, { t: 'big', s: 18, u: true }, { t: '\n\nend', f: 'TiRo', i: true });
  const rc = toRC(BASE, rs, 1);
  assert.match(rc, /^<\?xml version="1.0"\?><body xmlns="http:\/\/www.w3.org\/1999\/xhtml"/);
  assert.match(rc, /text-align:center/);
  assert.match(rc, /&amp; &lt;x&gt;/);
  const back = fromRC(rc, BASE);
  assert.ok(back);
  assert.equal(runsText(back!), runsText(rs));
  assert.deepEqual(letters(settle(BASE, back!).runs!), letters(settle(BASE, rs).runs!));
});

test('/RC from another program: spans, <b>, entities, line breaks', () => {
  const rc = '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:20.0.0" xfa:spec="2.0.2" style="font-size:12.0pt;text-align:left;color:#000000;font-weight:normal;font-style:normal;font-family:Arial;font-stretch:normal"><p dir="ltr"><span style="font-family:Arial">Check the </span><span style="font-weight:bold;font-family:Arial">slab</span><span style="font-family:Arial">&#13;level &amp; <b>falls</b></span></p><p dir="ltr"><span style="color:#FF0000;font-family:Arial">RFI&#160;12</span></p></body>';
  const base = { ...BASE, size: 12 };
  const rs = fromRC(rc, base)!;
  assert.ok(rs);
  assert.equal(runsText(rs), 'Check the slab\nlevel & falls\nRFI 12');
  assert.ok(rs.some((r) => r.t === 'slab' && r.b));
  assert.ok(rs.some((r) => r.t.trim() === 'falls' && r.b));
  assert.ok(rs.some((r) => r.t.startsWith('RFI') && r.c && r.c[0] === 1));
  // all one style: nothing to keep as runs
  assert.equal(fromRC('<body><p><span style="font-weight:bold">x</span></p></body>', { ...BASE, bold: true }), null);
});

test('cleanRuns: bad values dropped', () => {
  assert.deepEqual(cleanRuns([{ t: 'a', b: 'yes', s: 9999, c: [2, 0, 0], f: '' }, { t: 'b', i: true }, { x: 1 }, null]), [{ t: 'a' }, { t: 'b', i: true }]);
  assert.deepEqual(dropKey(R({ t: 'a', b: true }, { t: 'b' }), 'b'), [{ t: 'ab' }]);
});

// ---------------------------------------------------------------- the engine

function blank(): Uint8Array {
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  return d.saveToBuffer('').asUint8Array().slice();
}
const RUNS: TextRun[] = [{ t: 'Check the ' }, { t: 'beam depth', b: true, c: [0.85, 0.1, 0.1] }, { t: ' and ' }, { t: 'confirm', i: true, u: true, s: 16 }];
const TEXT = runsText(RUNS);
function richBox(id: string, extra: Partial<mu.AnnotSpec> = {}) {
  const a = mu.createAnnot(id, 0, { type: 'FreeText', rect: [100, 100, 260, 130], contents: '', color: [1, 1, 0.8], bw: 1, font: { size: 11, color: [0, 0, 0] }, kind: 'textbox', ...extra });
  return mu.updateAnnots(id, [{ page: 0, id: a.id, patch: { contents: TEXT, runs: RUNS } }])[0];
}
const reopen = (id: string, to: string) => { mu.open(to, mu.save(id)); return mu.annots(to, 0); };
const apOf = (bytes: Uint8Array, pick = (o: mupdf.PDFObject) => true) => {
  const d = mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;
  const p = d.loadPage(0) as mupdf.PDFPage;
  const a = p.getAnnotations().find((x) => pick(x.getObject()))!;
  return { d, p, a, o: a.getObject(), ap: a.getObject().get('AP', 'N').readStream().asString() };
};

test('engine: a box with styled words is drawn per style and saved with /RC, /DS, /GCCRuns', () => {
  mu.open('r1', blank());
  const a = richBox('r1');
  assert.deepEqual(cleanRuns(a.runs), cleanRuns(RUNS));
  assert.equal(a.font!.bold, undefined);
  const { o, ap, a: an } = apOf(mu.save('r1'));
  assert.match(o.get('RC').asString(), /font-weight:bold[^>]*>beam depth</);
  assert.match(o.get('DS').asString(), /11pt Helvetica/);
  assert.equal(o.get('Contents').asString(), TEXT);
  // regular, bold and the bold-italic... fonts; red; an underline
  const fonts = new Set([...ap.matchAll(/\/(\S+) [\d.]+ Tf/g)].map((m) => m[1]));
  assert.ok(fonts.size >= 3, [...fonts].join());
  assert.match(ap, /0\.85 0\.1 0\.1 rg/);
  assert.match(ap, / re f/);
  assert.match(ap, /\/GCCr\d+ 16 Tf/);
  // copy and search read the words
  assert.match(an.toDisplayList().toStructuredText('').asText().replace(/\s+/g, ' '), /Check the beam depth and confirm/);
  mu.close('r1');
});

test('engine: opened again, MuPDF doesn\'t draw it again its own way (on view, save, move, flatten)', () => {
  mu.open('r2', blank());
  const a = richBox('r2');
  const ap0 = apOf(mu.save('r2')).ap;
  const back = reopen('r2', 'r2b');
  assert.deepEqual(cleanRuns(back[0].runs), cleanRuns(RUNS));
  // a page drawn again by MuPDF (it redraws what it thinks changed)
  const { p, a: an } = apOf(mu.save('r2b'));
  p.update();
  assert.equal(an.getObject().get('AP', 'N').readStream().asString(), ap0);
  // moved: its drawing kept (not MuPDF's rich-text drawing: that embeds fonts of its own)
  mu.moveAnnots('r2b', [{ page: 0, id: back[0].id }], 20, 30);
  const mv = apOf(mu.save('r2b')).ap;
  assert.doesNotMatch(mv, /\/F0 /);
  assert.match(mv, /\/GCCr\d/);
  // flattened: the styled text goes into the page
  mu.flatten('r2b', [{ page: 0, id: back[0].id }]);
  const d = mupdf.Document.openDocument(mu.save('r2b'), 'application/pdf');
  assert.match(d.loadPage(0).toStructuredText().asText().replace(/\s+/g, ' '), /Check the beam depth and confirm/);
  mu.close('r2'); mu.close('r2b');
  void a;
});

test('engine: the whole box given a style - all its text takes it; text changed elsewhere keeps the styles', () => {
  mu.open('r3', blank());
  const a = richBox('r3');
  const [b] = mu.updateAnnots('r3', [{ page: 0, id: a.id, patch: { font: { ...a.font!, color: [0, 0, 1] } } }]);
  assert.ok(b.runs && b.runs.every((r) => !r.c), JSON.stringify(b.runs));
  assert.ok(b.runs!.some((r) => r.t === 'beam depth' && r.b));
  const [c] = mu.updateAnnots('r3', [{ page: 0, id: a.id, patch: { font: { ...b.font!, size: 14 } } }]);
  assert.ok(c.runs!.every((r) => !r.s));
  // the side panel / AI / replace changed the text only
  const [e] = mu.updateAnnots('r3', [{ page: 0, id: a.id, patch: { contents: 'Please check the beam depth and confirm' } }]);
  assert.equal(runsText(e.runs!), 'Please check the beam depth and confirm');
  assert.ok(e.runs!.some((r) => r.t === 'beam depth' && r.b));
  // all of it bold = a bold box (no runs left, no /RC)
  const [f] = mu.updateAnnots('r3', [{ page: 0, id: a.id, patch: { contents: 'all bold', runs: [{ t: 'all bold', b: true }] } }]);
  assert.equal(f.runs, undefined);
  assert.equal(f.font!.bold, true);
  const { o } = apOf(mu.save('r3'));
  assert.ok(o.get('RC').isNull() && o.get('DS').isNull() && o.get('GCCRuns').isNull());
  mu.close('r3');
});

test('engine: undo / redo take the styles back and forth', () => {
  mu.open('r4', blank());
  const a = mu.createAnnot('r4', 0, { type: 'FreeText', rect: [100, 100, 260, 130], contents: 'Check the beam', font: { size: 11, color: [0, 0, 0] }, kind: 'textbox' });
  mu.updateAnnots('r4', [{ page: 0, id: a.id, patch: { contents: 'Check the beam', runs: [{ t: 'Check the ' }, { t: 'beam', b: true }] } }]);
  mu.undo('r4');
  assert.equal(mu.annots('r4', 0)[0].runs, undefined);
  mu.redo('r4');
  assert.ok(mu.annots('r4', 0)[0].runs!.some((r) => r.t === 'beam' && r.b));
  mu.close('r4');
});

test('engine: lines as tall as their largest text; wraps by width with mixed sizes', () => {
  mu.open('r5', blank());
  const small = mu.createAnnot('r5', 0, { type: 'FreeText', rect: [100, 100, 260, 120], contents: 'Check the beam depth and confirm', font: { size: 11, color: [0, 0, 0] }, kind: 'textbox' });
  const rich = richBox('r5');
  // the plain one: one line at 160 wide; the rich one (16 pt word): taller
  assert.ok(rich.rect[3] - rich.rect[1] > small.rect[3] - small.rect[1] + 4, `${rich.rect} vs ${small.rect}`);
  // fits its text (clicked, not dragged): as wide as its text, then wraps at its limit
  const auto = richBox('r5', { rect: [100, 300, 120, 316], autoWidth: 120 });
  assert.ok(auto.rect[2] - auto.rect[0] <= 120.5, String(auto.rect));
  const { ap } = apOf(mu.save('r5'), (o) => o.get('GCCAuto').isNumber());
  const ys = [...new Set([...ap.matchAll(/1 0 0 1 [\d.-]+ ([\d.-]+) Tm/g)].map((m) => Math.round(Number(m[1]))))];
  assert.ok(ys.length >= 2, 'wrapped onto 2+ lines: ' + ys.join());
  mu.close('r5');
});

test('engine: turned, callout and typewriter boxes keep their styles', () => {
  mu.open('r6', blank());
  const t = richBox('r6');
  const [tt] = mu.updateAnnots('r6', [{ page: 0, id: t.id, patch: { angle: 90 } }]);
  assert.ok(tt.runs!.some((r) => r.b));
  const co = richBox('r6', { rect: [300, 300, 460, 330], intent: 'FreeTextCallout', callout: [[250, 400]], kind: 'callout' });
  assert.ok(co.callout && co.runs!.some((r) => r.u));
  const tw = richBox('r6', { rect: [60, 500, 260, 516], color: null, bw: 0, kind: 'typewriter', autoWidth: 300 });
  assert.ok(tw.runs!.some((r) => r.s === 16));
  const bytes = mu.save('r6');
  const d = mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;
  for (const an of (d.loadPage(0) as mupdf.PDFPage).getAnnotations()) assert.match(an.toDisplayList().toStructuredText('').asText().replace(/\s+/g, ' '), /beam depth/);
  // pasted elsewhere: the copy keeps them
  const cp = mu.copyAnnots('r6', [{ page: 0, id: co.id }], 'r6', 0, 10, 10);
  assert.ok(cp[0].runs!.some((r) => r.u));
  mu.close('r6');
});

test('engine: Arabic with a styled word: drawn right to left, words readable', () => {
  mu.open('r7', blank());
  const runs: TextRun[] = [{ t: 'ملاحظة ' }, { t: 'مهمة', b: true, c: [1, 0, 0] }, { t: ' للمقاول' }];
  const a = mu.createAnnot('r7', 0, { type: 'FreeText', rect: [100, 100, 300, 130], contents: '', font: { size: 12, color: [0, 0, 0] }, kind: 'textbox' });
  mu.updateAnnots('r7', [{ page: 0, id: a.id, patch: { contents: runsText(runs), runs } }]);
  const { ap, a: an } = apOf(mu.save('r7'));
  assert.match(ap, /ReversedChars/);
  assert.match(ap, /1 0 0 rg/);
  const txt = an.toDisplayList().toStructuredText('').asText();
  assert.ok(/مهمة/.test(txt) && /ملاحظة/.test(txt), txt);
  // opened again: the Arabic runs come back as they were
  const back = reopen('r7', 'r7b');
  assert.deepEqual(cleanRuns(back[0].runs), cleanRuns(runs));
  mu.close('r7'); mu.close('r7b');
});

test('engine: another program\'s box with rich text - its bold words read in, kept when edited here', () => {
  // made as another program would: /RC with a bold word, its own drawing, no marks of ours
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ''));
  const p = d.loadPage(0) as mupdf.PDFPage;
  const an = p.createAnnotation('FreeText');
  an.setRect([100, 100, 300, 140]);
  an.setContents('Check the slab level');
  an.setDefaultAppearance('Helv', 12, [0, 0, 0]);
  an.update();
  an.getObject().put('RC', d.newString('<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" style="font-size:12pt;font-family:Helvetica;color:#000000"><p dir="ltr"><span>Check the </span><span style="font-weight:bold">slab</span><span> level</span></p></body>'));
  an.getObject().put('DS', d.newString('font: Helvetica 12pt; color:#000000'));
  mu.open('r8', d.saveToBuffer('').asUint8Array().slice());
  const [f] = mu.annots('r8', 0);
  assert.ok(f.runs && f.runs.some((r) => r.t === 'slab' && r.b), JSON.stringify(f.runs));
  // its text edited here: drawn by this app from now on, the bold word still bold
  const [g] = mu.updateAnnots('r8', [{ page: 0, id: f.id, patch: { contents: 'Check the slab level again' } }]);
  assert.ok(g.runs && g.runs.some((r) => r.t === 'slab' && r.b), JSON.stringify(g.runs));
  const { o, ap } = apOf(mu.save('r8'));
  assert.ok(o.get('GCCRuns').isString());
  assert.match(o.get('RC').asString(), /font-weight:bold[^>]*>slab</);
  assert.match(ap, /\/GCCr\d/);
  mu.close('r8');
});

test('engine: a word in a typeface from the PC (embedded, shaped) beside built-in text', () => {
  mu.open('r9', blank());
  const runs: TextRun[] = [{ t: 'Built-in and ' }, { t: 'Arial word', f: 'Arial', b: true }, { t: ' – “quoted”' }];
  const a = mu.createAnnot('r9', 0, { type: 'FreeText', rect: [100, 100, 300, 130], contents: '', font: { size: 11, color: [0, 0, 0] }, kind: 'textbox' });
  mu.updateAnnots('r9', [{ page: 0, id: a.id, patch: { contents: runsText(runs), runs } }]);
  const { ap, o, a: an } = apOf(mu.save('r9'));
  assert.match(ap, /\] TJ/);
  assert.match(ap, /\) Tj/);
  const fonts = o.get('AP', 'N', 'Resources', 'Font');
  let type0 = 0;
  fonts.forEach((f: mupdf.PDFObject) => { if (f.resolve().get('Subtype').asName() === 'Type0') type0++; });
  assert.ok(type0 >= 1, 'an embedded PC font');
  assert.match(an.toDisplayList().toStructuredText('').asText().replace(/\s+/g, ' '), /Built-in and Arial word – “quoted”/);
  mu.close('r9');
});
