// PLAN 3.5 (D1): a page of big pictures is drawn in slabs - tiles are cut out of one PDFium draw
// of up to 4,096 px square - and the tiles are the same, pixel for pixel, as tiles drawn on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import * as pf from '../src/engine/pdfium';

const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
// (the tests below decide at once: a page's first tile isn't timed first - that is tested on its own, last)
pf.slabStats.slowMs = 0;

/** a one-page PDF: a grey picture of `n` x `n` pixels (a pattern) over the whole 600 x 600 page, and a line over it */
function picturePdf(n: number, lines = 0): Uint8Array {
  const img = Buffer.alloc(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) img[y * n + x] = ((x * 7) ^ (y * 13)) & 255;
  const z = deflateSync(img, { level: 1 });
  let more = '';
  for (let i = 0; i < lines; i++) more += `${(i * 7) % 600} ${(i * 13) % 600} m ${(i * 7) % 600 + 5} ${(i * 13) % 600 + 3} l S\n`;
  const cs = Buffer.from('q 600 0 0 600 0 0 cm /Im0 Do Q 1 0 0 RG 3 w 10 10 m 590 500 l S\n' + more);
  const parts: Buffer[] = [];
  const offs: number[] = [];
  let len = 0;
  const put = (b: Buffer | string) => { const x = typeof b === 'string' ? Buffer.from(b, 'latin1') : b; parts.push(x); len += x.length; };
  const obj = (i: number, body: (Buffer | string)[]) => { offs[i] = len; put(`${i} 0 obj\n`); body.forEach(put); put('\nendobj\n'); };
  put('%PDF-1.7\n');
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
  obj(3, ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>']);
  obj(4, [`<< /Length ${cs.length} >>\nstream\n`, cs, '\nendstream']);
  obj(5, [`<< /Type /XObject /Subtype /Image /Width ${n} /Height ${n} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, z, '\nendstream']);
  const x = len;
  put(`xref\n0 6\n0000000000 65535 f \n` + [1, 2, 3, 4, 5].map((i) => String(offs[i]).padStart(10, '0') + ' 00000 n \n').join(''));
  put(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}

const big = picturePdf(4200); // 4,200 x 4,200 = 17.6 megapixels: drawn in slabs
// 7.3 x 600 = 4,380 px: more than a slab a side
const SCALE = 7.3;
/** the same as drawn on its own, to the eye: a scaled picture's resampling rounds a few values
 *  differently with another clip (seen: up to 2 levels of 255, on about 1 value in 1,000) */
function same(a: Uint8ClampedArray, b: Uint8ClampedArray, what: string) {
  assert.equal(a.length, b.length, what);
  let n = 0, mx = 0;
  for (let i = 0; i < a.length; i++) { const e = Math.abs(a[i] - b[i]); if (e) { n++; mx = Math.max(mx, e); } }
  assert.ok(mx <= 2 && n < a.length / 200, `${what}: ${n} values off, by up to ${mx}`);
}
/** the tiles of a 1,600 x 950 view centred at (cx, cy), centre first - as PageTiles asks */
function view(W: number, H: number, cx: number, cy: number): [number, number, number, number][] {
  const out: [number, number, number, number, number][] = [];
  for (let ty = Math.max(0, Math.floor((cy - 475) / 512)); ty * 512 < Math.min(H, cy + 475); ty++)
    for (let tx = Math.max(0, Math.floor((cx - 800) / 512)); tx * 512 < Math.min(W, cx + 800); tx++) {
      const x = tx * 512, y = ty * 512, w = Math.min(512, W - x), h = Math.min(512, H - y);
      out.push([x, y, w, h, Math.hypot(x + w / 2 - cx, y + h / 2 - cy)]);
    }
  return out.sort((a, b) => a[4] - b[4]).map(([x, y, w, h]) => [x, y, w, h]);
}

test('3.5: a view of a big-picture page is one draw, its tiles cut out of it look as drawn on their own', () => {
  pf.openDoc('p35a', big);
  const W = Math.ceil(600 * SCALE);
  // (the middle of the page, a corner, an edge: each view one draw)
  for (const [cx, cy] of [[2190, 2190], [300, 200], [4300, 2000]]) {
    const tiles = view(W, W, cx, cy);
    const before = { ...pf.slabStats };
    const got = tiles.map(([x, y, w, h]) => pf.render('p35a', 0, SCALE, x, y, w, h));
    assert.ok(pf.slabStats.calls - before.calls <= 1, `one draw at most for the view at ${cx},${cy}`);
    assert.equal(pf.slabStats.served - before.served, tiles.length);
    slabsOff(() => tiles.forEach(([x, y, w, h], k) => same(pf.render('p35a', 0, SCALE, x, y, w, h), got[k], `tile ${x},${y}`)));
    // the same view again: no draw at all
    const again = pf.slabStats.calls;
    for (const [x, y, w, h] of tiles) pf.render('p35a', 0, SCALE, x, y, w, h);
    assert.equal(pf.slabStats.calls, again);
  }
  pf.closeDoc('p35a');
});

test('3.5: a view at fit is one draw, however many tiles it takes (the last row and column too)', () => {
  pf.openDoc('p35b', big);
  // 600 x 1.7509 = 1,050.5 px: the window asks for ceil (1,051), PDFium draws round (1,051 or 1,050)
  for (const s of [1.75, 1.7509, 1.7491]) {
    const W = Math.ceil(600 * s);
    const before = { ...pf.slabStats };
    const got: Uint8ClampedArray[] = [];
    for (let y = 0; y < W; y += 512) for (let x = 0; x < W; x += 512) got.push(pf.render('p35b', 0, s, x, y, Math.min(512, W - x), Math.min(512, W - y)));
    assert.equal(pf.slabStats.calls - before.calls, 1, 'one draw at ' + s);
    assert.equal(pf.slabStats.served - before.served, 9);
    let k = 0;
    slabsOff(() => { for (let y = 0; y < W; y += 512) for (let x = 0; x < W; x += 512) { const d = pf.render('p35b', 0, s, x, y, Math.min(512, W - x), Math.min(512, W - y)); same(d, got[k], `tile ${k} at ${s}`); k++; } });
  }
  pf.closeDoc('p35b');
});

test('3.5: a page of small pictures, thumbnails and closing a file: drawn as before, nothing kept', () => {
  pf.openDoc('p35c', picturePdf(600));
  const before = { ...pf.slabStats };
  pf.render('p35c', 0, 2, 0, 0, 512, 512);
  assert.equal(pf.slabStats.drawn, before.drawn);
  assert.equal(pf.slabStats.calls - before.calls, 1);
  pf.closeDoc('p35c');
  pf.openDoc('p35d', big);
  const b2 = { ...pf.slabStats };
  pf.render('p35d', 0, 1, 0, 0, 300, 300, true); // (with annotations: a thumbnail of another file)
  assert.equal(pf.slabStats.drawn, b2.drawn);
  pf.render('p35d', 0, 1, 0, 0, 300, 300);
  assert.equal(pf.slabStats.drawn - b2.drawn, 1);
  pf.closeDoc('p35d');
  pf.openDoc('p35d', big);
  pf.render('p35d', 0, 1, 0, 0, 300, 300);
  assert.equal(pf.slabStats.drawn - b2.drawn, 2, 'a slab of a closed file is not reused by a file opened under the same id');
  pf.closeDoc('p35d');
});

function slabsOff(f: () => void) { pf.slabStats.on = false; try { f(); } finally { pf.slabStats.on = true; } }

test('3.5: no room for a slab (engine near its restart point, or the PC short of memory): tiles drawn on their own, slabs let go', () => {
  pf.openDoc('p35e', big);
  const W = Math.ceil(600 * SCALE);
  const tiles = view(W, W, 2190, 2190);
  pf.render('p35e', 0, SCALE, ...tiles[0]);
  assert.equal(pf.slabsHeld(), 1);
  let asked = 0;
  pf.setSlabRoom(() => { asked++; return false; });
  try {
    const before = { ...pf.slabStats };
    // (another scale: a new slab would be needed)
    const got = tiles.slice(0, 4).map(([x, y, w, h]) => pf.render('p35e', 0, SCALE / 2, x / 2, y / 2, w, h));
    assert.ok(asked > 0);
    assert.equal(pf.slabStats.drawn, before.drawn, 'no slab drawn');
    assert.equal(pf.slabStats.calls - before.calls, 4, 'each tile drawn on its own');
    assert.equal(pf.slabsHeld(), 0, 'the slab held was let go');
    slabsOff(() => tiles.slice(0, 4).forEach(([x, y, w, h], k) => same(pf.render('p35e', 0, SCALE / 2, x / 2, y / 2, w, h), got[k], 'tile ' + k)));
  } finally { pf.setSlabRoom(() => true); }
  pf.closeDoc('p35e');
});

test('3.5: slabs are let go when no picture page has been drawn for a while', async () => {
  pf.openDoc('p35f', big);
  const idle = pf.slabStats.idleMs;
  pf.slabStats.idleMs = 50;
  try {
    pf.render('p35f', 0, 1, 0, 0, 300, 300);
    assert.equal(pf.slabsHeld(), 1);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(pf.slabsHeld(), 0);
  } finally { pf.slabStats.idleMs = idle; }
  pf.closeDoc('p35f');
});

test('3.5: the host gives a slab room only below the planned restart point and with the PC\'s memory to spare', async () => {
  const { slabRoomFor } = await import('../src/engine/host');
  const GB = 1024 ** 3, slab = 126e6;
  // (restart point 2.9 GB on a 4 GB-capable engine; 2 GB engine: 1.8 GB)
  assert.equal(slabRoomFor(slab, 1.0 * GB, 4 * GB, 6 * GB, 2.9 * GB), true);
  assert.equal(slabRoomFor(slab, 2.85 * GB, 4 * GB, 6 * GB, 2.9 * GB), false, 'would pass the restart point');
  assert.equal(slabRoomFor(slab, 1.75 * GB, 2 * GB, 6 * GB, 2.9 * GB), false, 'unpatched 2 GB engine: below 1.8 GB only');
  assert.equal(slabRoomFor(slab, 1.0 * GB, 4 * GB, 0.355 * GB, 2.9 * GB), false, 'a PC with 355 MB free (the reports)');
  assert.equal(slabRoomFor(slab, 1.0 * GB, 4 * GB, 1.6 * GB, 2.9 * GB), false, 'free memory would fall under 1.5 GB');
});

test('3.5: a drawing with big pictures and many objects is not drawn in slabs (it costs by the area drawn)', () => {
  pf.openDoc('p35g', picturePdf(4200, 2500));
  const before = { ...pf.slabStats };
  pf.render('p35g', 0, 2, 0, 0, 512, 512);
  assert.equal(pf.slabStats.drawn, before.drawn);
  assert.equal(pf.slabStats.calls - before.calls, 1);
  pf.closeDoc('p35g');
});

test('3.5: a page\'s first tiles are drawn on their own and timed: slabs only if they stay slow', () => {
  const W = Math.ceil(600 * SCALE);
  const tiles = view(W, W, 2190, 2190);
  try {
    // fast pictures (here: anything under a very high bar) - tiles as before, no slab ever
    pf.slabStats.slowMs = 1e9;
    pf.openDoc('p35h', big);
    let before = { ...pf.slabStats };
    for (const t of tiles) pf.render('p35h', 0, SCALE, ...t);
    assert.equal(pf.slabStats.drawn, before.drawn);
    assert.equal(pf.slabStats.calls - before.calls, tiles.length);
    pf.closeDoc('p35h');
    // slow pictures (any draw takes over 1 ms): the first two tiles on their own, the rest from one slab
    pf.slabStats.slowMs = 1;
    pf.openDoc('p35h', big);
    before = { ...pf.slabStats };
    for (const t of tiles) pf.render('p35h', 0, SCALE, ...t);
    assert.equal(pf.slabStats.calls - before.calls, 3);
    assert.equal(pf.slabStats.served - before.served, tiles.length - 2);
    pf.closeDoc('p35h');
  } finally { pf.slabStats.slowMs = 0; }
});
