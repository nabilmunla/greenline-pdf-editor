// Stamp from a scan (0.7): pictures made here like a phone photo of a stamped page - uneven light,
// yellowish paper, noise, dust, black text running through the stamp, the stamp turned - and the
// cleaned result checked against what was drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import { writeFileSync } from 'node:fs';
import * as mu from '../src/engine/mu';
import { analyse, alphaMap, keepMask, clean, dpiOf, type Img } from '../src/ui/stampclean';

const BLUE: [number, number, number] = [0.1, 0.25, 0.7];
const RED: [number, number, number] = [0.75, 0.12, 0.12];
const BLACK: [number, number, number] = [0.1, 0.1, 0.1];
type Kind = 'rect' | 'round';

/** a page with a stamp and/or black text, drawn by the PDF engine (2x: 144 dpi) */
function page(id: string, what: { stamp?: { kind: Kind; color: [number, number, number]; angle?: number }; text?: boolean }): Img {
  const d = new mupdf.PDFDocument();
  d.insertPage(-1, d.addPage([0, 0, 420, 300], 0, {}, ''));
  mu.open(id, d.saveToBuffer('').asUint8Array().slice());
  if (what.text) {
    for (let i = 0; i < 9; i++) mu.createAnnot(id, 0, { type: 'FreeText', rect: [20, 20 + i * 28, 400, 44 + i * 28], contents: 'The Contractor shall provide all labour plant and materials ' + i, font: { size: 13, color: [0, 0, 0] }, bw: 0, color: null, kind: 'textbox' });
  }
  const s = what.stamp;
  if (s && s.kind === 'rect') {
    mu.createAnnot(id, 0, { type: 'Stamp', rect: [150, 95, 330, 175], design: { lines: [{ text: 'APPROVED', size: 26, bold: true }, { text: 'SAMPLE CONTRACTOR', size: 10, bold: true }, { text: '26/10/2026', size: 10 }], color: s.color, border: 'double' }, angle: s.angle ?? 0 });
  } else if (s) {
    mu.createAnnot(id, 0, { type: 'Circle', rect: [170, 70, 300, 200], color: s.color, bw: 3 });
    mu.createAnnot(id, 0, { type: 'Circle', rect: [180, 80, 290, 190], color: s.color, bw: 1.2 });
    mu.createAnnot(id, 0, { type: 'FreeText', rect: [190, 118, 285, 152], contents: 'SEAL LLC\nDUBAI', font: { size: 13, color: s.color, bold: true }, bw: 0, color: null, kind: 'textbox', quadding: 1 });
  }
  const f = new mupdf.PDFDocument(mu.save(id));
  mu.close(id);
  const pix = f.loadPage(0).toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
  const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), p = pix.getPixels();
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = p[i * n]; data[i * 4 + 1] = p[i * n + 1]; data[i * 4 + 2] = p[i * n + 2]; data[i * 4 + 3] = 255; }
  return { w, h, data };
}

/** like a photo: yellowish paper, light falling off to one corner, noise, dust */
function photo(img: Img, seed = 1, specks: [number, number][] = []): Img {
  let sd = seed;
  const rnd = () => ((sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * 4;
    const light = 0.62 + 0.38 * (1 - (0.6 * x) / img.w - (0.4 * y) / img.h + 0.1 * Math.sin(x / 90));
    const tone = [0.95, 0.91, 0.8];
    for (let c = 0; c < 3; c++) out[i + c] = (img.data[i + c] / 255) * tone[c] * light * 255 + (rnd() - 0.5) * 14;
    out[i + 3] = 255;
  }
  for (const [sx, sy] of specks) for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) { const i = ((sy + dy) * img.w + sx + dx) * 4; out[i] = 60; out[i + 1] = 55; out[i + 2] = 50; }
  return { w: img.w, h: img.h, data: out };
}

/** a picture to look at (see-through shown over a grey checkerboard) */
function dump(img: Img, file: string) {
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, img.w, img.h], false);
  const p = pm.getPixels();
  for (let i = 0; i < img.w * img.h; i++) {
    const x = i % img.w, y = (i / img.w) | 0, a = img.data[i * 4 + 3] / 255;
    const bg = ((x >> 4) + (y >> 4)) % 2 ? 205 : 245;
    for (let c = 0; c < 3; c++) p[i * 3 + c] = img.data[i * 4 + c] * a + bg * (1 - a);
  }
  writeFileSync(file, pm.asPNG());
}

/** where something was drawn (darker than the paper) */
const maskOf = (img: Img, t = 0.25) => { const m = new Uint8Array(img.w * img.h); for (let i = 0; i < m.length; i++) m[i] = 1 - (0.3 * img.data[i * 4] + 0.59 * img.data[i * 4 + 1] + 0.11 * img.data[i * 4 + 2]) / 255 > t ? 1 : 0; return m; };
const bboxOf = (m: Uint8Array, w: number) => { let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (let i = 0; i < m.length; i++) if (m[i]) { const x = i % w, y = (i / w) | 0; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1 + 1, y1 + 1]; };

function check(name: string, stamp: { kind: Kind; color: [number, number, number]; angle?: number }, text: boolean) {
  const st = page(name + 's', { stamp });
  const tx = text ? page(name + 't', { text: true }) : null;
  const both = page(name + 'b', { stamp, text });
  const S = maskOf(st), T = tx ? maskOf(tx) : new Uint8Array(S.length);
  const sb = bboxOf(S, st.w);
  const specks: [number, number][] = [[40, 560], [790, 40], [800, 560], [60, 300]];
  const an = analyse(photo(both, 7, specks));
  assert.equal(an.k, 1);
  const a = alphaMap(an);
  const keep = keepMask(an, a);
  let paper = 0, np = 0, inter = 0, uni = 0, textLeft = 0, nt = 0;
  for (let i = 0; i < S.length; i++) {
    const v = keep[i] ? a[i] : 0;
    // (a few pixels round the drawing are its anti-aliased edge, not paper)
    const x = i % st.w, y = (i / st.w) | 0;
    let edge = false;
    for (let dy = -2; dy <= 2 && !edge; dy++) for (let dx = -2; dx <= 2 && !edge; dx++) { const j = (y + dy) * st.w + x + dx; if (j >= 0 && j < S.length && (S[j] || T[j])) edge = true; }
    if (!edge) { paper += v; np++; }
    if (!T[i]) { if (S[i] && v > 0.5) inter++; if (S[i] || v > 0.5) uni++; }
    if (T[i] && !S[i]) { let nearS = false; for (let dy = -2; dy <= 2 && !nearS; dy++) for (let dx = -2; dx <= 2 && !nearS; dx++) { const j = (y + dy) * st.w + x + dx; if (j >= 0 && j < S.length && S[j]) nearS = true; } if (!nearS) { textLeft += v; nt++; } }
  }
  const out = { paper: paper / np, iou: inter / uni, textLeft: nt ? textLeft / nt : 0, specks: specks.map(([x, y]) => (keep[(y + 1) * st.w + x + 1] ? a[(y + 1) * st.w + x + 1] : 0)), crop: an.crop, sb, angle: an.angle, hue: an.inkHue };
  console.log(`  ${name}: paper ${out.paper.toFixed(4)}, stamp overlap ${out.iou.toFixed(3)}, text left ${out.textLeft.toFixed(3)}, angle ${out.angle}, hue ${out.hue === null ? '-' : out.hue.toFixed(0)}, crop ${out.crop} vs ${sb}`);
  if (process.env.STAMP_DUMP) { dump(photo(both, 7, specks), process.env.STAMP_DUMP + '/' + name + '-in.png'); dump(clean(an).img, process.env.STAMP_DUMP + '/' + name + '-out.png'); }
  return out;
}

test('blue stamp over black text, uneven light, dust: paper gone, stamp kept, text left out', () => {
  const r = check('bt', { kind: 'rect', color: BLUE }, true);
  assert.ok(r.hue !== null && r.hue > 200 && r.hue < 250, 'blue ink found: hue ' + r.hue);
  assert.ok(r.paper < 0.015, 'paper see-through: mean opacity ' + r.paper.toFixed(4));
  assert.ok(r.iou > 0.8, 'the stamp kept: overlap ' + r.iou.toFixed(3));
  assert.ok(r.textLeft < 0.08, 'black text left out: mean opacity ' + r.textLeft.toFixed(3));
  assert.ok(r.specks.every((v) => v < 0.05), 'dust gone: ' + r.specks.map((v) => v.toFixed(2)));
  // crop: around the stamp, not the page of text
  const [x0, y0, x1, y1] = r.crop, [s0, t0, s1, t1] = r.sb;
  assert.ok(x0 <= s0 + 1 && y0 <= t0 + 1 && x1 >= s1 - 1 && y1 >= t1 - 1, `crop ${r.crop} holds the stamp ${r.sb}`);
  assert.ok((x1 - x0) * (y1 - y0) < 1.5 * (s1 - s0) * (t1 - t0), 'and not much more');
});

test('turned rectangular stamp is straightened; a round seal is left as it is', () => {
  const r = check('tr', { kind: 'rect', color: BLUE, angle: 6 }, false);
  assert.ok(Math.abs(r.angle - 6) <= 1, 'turned 6 degrees clockwise -> found ' + r.angle);
  const r2 = check('tl', { kind: 'rect', color: RED, angle: -4 }, true);
  assert.ok(Math.abs(r2.angle + 4) <= 1, 'red, turned 4 degrees the other way, text over it -> found ' + r2.angle);
  const o = check('rs', { kind: 'round', color: BLUE }, true);
  assert.equal(o.angle, 0, 'round seal: no turn');
  assert.ok(o.iou > 0.75 && o.paper < 0.015, `round seal clean: overlap ${o.iou.toFixed(3)}, paper ${o.paper.toFixed(4)}`);
});

test('black stamp: no colour to go by - paper still clean, stamp kept', () => {
  const r = check('bk', { kind: 'rect', color: BLACK }, false);
  assert.equal(r.hue, null, 'black ink');
  assert.ok(r.paper < 0.015 && r.iou > 0.8, `paper ${r.paper.toFixed(4)}, overlap ${r.iou.toFixed(3)}`);
});

test('the result: turned straight, see-through, the ink colour, sharp from a big picture, quick', () => {
  const st = page('big', { stamp: { kind: 'rect', color: BLUE, angle: 6 }, text: true });
  // a 3x bigger "photo" (2520 x 1800): the result is sampled from it, not from the working copy
  const W = st.w * 3, H = st.h * 3, d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, j = (((y / 3) | 0) * st.w + ((x / 3) | 0)) * 4; d[i] = st.data[j]; d[i + 1] = st.data[j + 1]; d[i + 2] = st.data[j + 2]; d[i + 3] = 255; }
  const big = photo({ w: W, h: H, data: d }, 3);
  const t0 = performance.now();
  const an = analyse(big);
  const t1 = performance.now();
  const c = clean(an, { maxSide: 1000 });
  const t2 = performance.now();
  assert.ok(an.k > 1.7, 'worked on a smaller copy: k ' + an.k.toFixed(2));
  assert.ok(Math.abs(c.angle + 6) <= 1, 'turned back ' + c.angle);
  const { w, h, data } = c.img;
  // the stamp's box is wider than tall (180 x 80 pt) once straight
  assert.ok(w / h > 1.8 && w / h < 2.7, `straight: ${w} x ${h}`);
  assert.ok(Math.max(w, h) > 700, 'sharp: sampled from the big picture (' + Math.max(w, h) + ' px)');
  let opaque = 0, clear = 0, blueish = 0;
  for (let i = 0; i < w * h; i++) {
    const A = data[i * 4 + 3];
    if (A > 200) { opaque++; if (data[i * 4 + 2] > data[i * 4] + 60) blueish++; } else if (A < 10) clear++;
  }
  assert.ok(clear > w * h * 0.5, 'mostly see-through: ' + ((100 * clear) / (w * h)).toFixed(0) + '%');
  assert.ok(opaque > 1000 && blueish / opaque > 0.95, 'the ink is blue');
  // corners clear (paper and black text gone)
  for (const [x, y] of [[2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3]]) assert.ok(data[(y * w + x) * 4 + 3] < 20, 'corner ' + x + ',' + y);
  console.log(`  analyse ${Math.round(t1 - t0)} ms, clean ${Math.round(t2 - t1)} ms for ${W} x ${H}`);
  assert.ok(t2 - t0 < 4000, 'quick enough');
  // as scanned: colours vary a little (shading kept); even colour: one colour
  const c2 = clean(an, { color: null, maxSide: 600 });
  const set = new Set<string>();
  for (let i = 0; i < c2.img.w * c2.img.h; i++) if (c2.img.data[i * 4 + 3] > 200) set.add(c2.img.data.slice(i * 4, i * 4 + 3).join());
  assert.ok(set.size > 20, 'as scanned keeps shading');
  // a turn of its own on top, and no straightening
  const c3 = clean(an, { straighten: false, turn: 90 });
  assert.ok(c3.img.h > c3.img.w, 'turned 90: taller than wide');
});

test('a worn stamp: faint purple ink, blotchy, soft scan, blue pen signature through it', () => {
  const PURPLE: [number, number, number] = [0.45, 0.2, 0.6];
  const st = page('wp', { stamp: { kind: 'round', color: PURPLE } });
  const tx = page('wt', { text: true });
  // a pen signature: a blue scribble across the seal's lower half
  const sig = new Uint8Array(st.w * st.h);
  for (let t = 0; t < 1; t += 0.0005) {
    const x = Math.round(360 + 260 * t), y = Math.round(330 + 40 * Math.sin(t * 25) - 30 * t);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sig[(y + dy) * st.w + x + dx] = 1;
  }
  // uneven inking (0.35 .. 1 of full strength, in blotches), then overprinted with text and pen
  const W = st.w, H = st.h, d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const blot = 0.35 + 0.65 * (0.5 + 0.25 * Math.sin(x / 13 + Math.cos(y / 17)) + 0.25 * Math.sin(y / 9 - x / 23));
    for (let c = 0; c < 3; c++) {
      const sv = 255 - (255 - st.data[i + c]) * blot;
      const pen = sig[y * W + x] ? [40, 60, 170][c] : 255;
      d[i + c] = (sv * tx.data[i + c] * pen) / (255 * 255);
    }
    d[i + 3] = 255;
  }
  // soft: 3 x 3 average
  const soft = new Uint8ClampedArray(d.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 4; c++) {
    let v = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; v += d[(yy * W + xx) * 4 + c]; n++; }
    soft[(y * W + x) * 4 + c] = v / n;
  }
  const an = analyse(photo({ w: W, h: H, data: soft }, 11));
  if (process.env.STAMP_DUMP) { dump(photo({ w: W, h: H, data: soft }, 11), process.env.STAMP_DUMP + '/worn-in.png'); dump(clean(an).img, process.env.STAMP_DUMP + '/worn-out.png'); }
  const a = alphaMap(an), keep = keepMask(an, a);
  const S = maskOf(st, 0.3), T = maskOf(tx);
  let inter = 0, uni = 0, sigKept = 0, ns = 0, textLeft = 0, nt = 0;
  for (let i = 0; i < S.length; i++) {
    const v = keep[i] ? a[i] : 0;
    if (!T[i] && !sig[i]) { if (S[i] && v > 0.3) inter++; if (S[i] || v > 0.3) uni++; }
    if (sig[i] && !S[i] && !T[i]) { sigKept += v; ns++; }
    if (T[i] && !S[i] && !sig[i]) { textLeft += v; nt++; }
  }
  console.log(`  worn: hue ${an.inkHue?.toFixed(0)}, overlap ${(inter / uni).toFixed(3)}, pen kept ${(sigKept / ns).toFixed(2)}, text left ${(textLeft / nt).toFixed(3)}, crop ${an.crop}`);
  assert.ok(an.inkHue !== null && an.inkHue > 250 && an.inkHue < 320, 'purple found: ' + an.inkHue);
  assert.ok(inter / uni > 0.7, 'the worn seal kept: ' + (inter / uni).toFixed(3));
  assert.ok(textLeft / nt < 0.1, 'text left out');
});

test('a phone photo of the sheet lying on a desk: the desk is not the ink', () => {
  const st = page('dk', { stamp: { kind: 'round', color: RED } });
  // the sheet (st, 840 x 600) shrunk into a 1100 x 860 photo with a brown, grainy desk round it
  const W = 1100, H = 860, ox = 150, oy = 120, sc = 0.8;
  const d = new Uint8ClampedArray(W * H * 4);
  let sd = 5;
  const rnd = () => ((sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const sx = Math.floor((x - ox) / sc), sy = Math.floor((y - oy) / sc);
    if (sx >= 0 && sy >= 0 && sx < st.w && sy < st.h) { const j = (sy * st.w + sx) * 4; d[i] = st.data[j]; d[i + 1] = st.data[j + 1]; d[i + 2] = st.data[j + 2]; }
    else { const grain = 0.85 + 0.15 * Math.sin(y / 7 + Math.sin(x / 40) * 3) + (rnd() - 0.5) * 0.1; d[i] = 140 * grain; d[i + 1] = 95 * grain; d[i + 2] = 55 * grain; }
    d[i + 3] = 255;
  }
  const img = photo({ w: W, h: H, data: d }, 9);
  const an = analyse(img);
  if (process.env.STAMP_DUMP) {
    dump(img, process.env.STAMP_DUMP + '/desk-in.png'); dump(clean(an).img, process.env.STAMP_DUMP + '/desk-out.png');
    const m = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { const v = an.bg && an.bg[i] ? 0 : 255; m[i * 4] = m[i * 4 + 1] = m[i * 4 + 2] = v; m[i * 4 + 3] = 255; } dump({ w: W, h: H, data: m }, process.env.STAMP_DUMP + '/desk-bg.png');
  }
  const a = alphaMap(an), keep = keepMask(an, a);
  let deskA = 0, nd = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const insideSheet = x >= ox - 4 && y >= oy - 4 && x < ox + st.w * sc + 4 && y < oy + st.h * sc + 4; if (!insideSheet) { deskA += keep[y * W + x] ? a[y * W + x] : 0; nd++; } }
  const hue = an.inkHue;
  console.log(`  desk: hue ${hue?.toFixed(0)}, desk opacity ${(deskA / nd).toFixed(4)}, crop ${an.crop}`);
  assert.ok(hue !== null && (hue < 25 || hue > 335), 'red ink found, not the desk: hue ' + hue);
  assert.ok(deskA / nd < 0.01, 'the desk is see-through');
  // crop round the seal (in the photo: (170..300 pt of the page) x 2 x 0.8 + offset)
  const [x0, y0, x1, y1] = an.crop;
  assert.ok(x0 > ox + 250 && x1 < ox + 520 && y0 > oy + 80 && y1 < oy + 360, 'cropped to the seal: ' + an.crop);
});

test('a seal cropped tight (touching the picture edge) is not taken for a desk', () => {
  const st = page('tt', { stamp: { kind: 'round', color: BLUE } });
  // the seal's square only (round 170..300 pt x 2 = 340..600 px, 140..400 px)
  const x0 = 338, y0 = 138, w = 264, h = 264;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) d.set(st.data.subarray(((y + y0) * st.w + x0) * 4, ((y + y0) * st.w + x0 + w) * 4), y * w * 4);
  const an = analyse(photo({ w, h, data: d }, 4));
  assert.equal(an.bg, null, 'no desk');
  const c = clean(an);
  let solid = 0;
  for (let i = 3; i < c.img.data.length; i += 4) if (c.img.data[i] > 200) solid++;
  assert.ok(solid > 4000, 'the ring and text kept: ' + solid + ' solid pixels');
});

test('scanner resolution from the file (real size on the page)', () => {
  // JFIF with 300 dpi
  const j = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x01, 0x2c, 0x01, 0x2c, 0x00, 0x00, 0xff, 0xda]);
  assert.equal(dpiOf(j), 300);
  j[13] = 0; // units 0: no meaning
  assert.equal(dpiOf(j), 0);
  // PNG pHYs 11811 px/m = 300 dpi
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 9, 0x70, 0x48, 0x59, 0x73, 0, 0, 0x2e, 0x23, 0, 0, 0x2e, 0x23, 1, 0, 0, 0, 0]);
  assert.equal(dpiOf(png), 300);
  // 72 dpi (a phone): not believed
  const p72 = png.slice(); p72[16] = 0; p72[17] = 0; p72[18] = 0x0b; p72[19] = 0x13;
  assert.equal(dpiOf(p72), 0);
});
