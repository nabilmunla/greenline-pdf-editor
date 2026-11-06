// Page picture -> clean grey PGM for Tesseract. Runs in a background worker (ocrprep.worker.ts),
// so the window stays smooth while pages are prepared; the same code is the fallback in-window.

/**
 * Median filter (square window 2r+1, smaller at the edges) with a sliding histogram that keeps
 * track of the median as it moves (Huang): the same result as searching the histogram for
 * every pixel, about 4x faster. Removes scan speckle, keeps letters.
 */
export function median(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const out = new Uint8Array(src.length);
  const hist = new Int32Array(256);
  const full = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < H; y++) {
    hist.fill(0);
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    let n = 0;
    for (let yy = y0; yy <= y1; yy++) for (let xx = 0; xx <= Math.min(W - 1, r); xx++) { hist[src[yy * W + xx]]++; n++; }
    // m = the median, lt = how many values in the window are below m
    let m = 0, lt = 0;
    for (let want = n === full ? full >> 1 : n >> 1; m < 256 && lt + hist[m] <= want; m++) lt += hist[m];
    for (let x = 0; x < W; x++) {
      const want = n === full ? full >> 1 : n >> 1;
      while (lt > want) { m--; lt -= hist[m]; }
      while (lt + hist[m] <= want) { lt += hist[m]; m++; }
      out[y * W + x] = m;
      const xo = x - r, xi = x + r + 1;
      for (let yy = y0; yy <= y1; yy++) {
        if (xo >= 0) { const v = src[yy * W + xo]; hist[v]--; n--; if (v < m) lt--; }
        if (xi < W) { const v = src[yy * W + xi]; hist[v]++; n++; if (v < m) lt++; }
      }
    }
  }
  return out;
}

/**
 * Shaded backgrounds (grey table headers, tinted cells) -> white, the text on them kept dark,
 * and white text on a dark band turned round: Tesseract's own threshold otherwise drops such
 * rows entirely. Each pixel is divided by its neighbourhood's background (the brightest
 * value of 24 px blocks, blended between block centres).
 */
export function flatten(g: Uint8Array, W: number, H: number): Uint8Array {
  const B = 24;
  const bw = Math.ceil(W / B), bh = Math.ceil(H / B);
  const mx = new Float32Array(bw * bh), mean = new Float32Array(bw * bh);
  const stats = (src: Uint8Array) => {
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let m = 0, s = 0, n = 0;
      const y1 = Math.min(H, (by + 1) * B), x1 = Math.min(W, (bx + 1) * B);
      for (let y = by * B; y < y1; y++) for (let x = bx * B, i = y * W + x; x < x1; x++, i++) { const v = src[i]; if (v > m) m = v; s += v; n++; }
      mx[by * bw + bx] = m; mean[by * bw + bx] = n ? s / n : 255;
    }
  };
  stats(g);
  let any = false;
  for (let k = 0; k < mx.length; k++) if (mx[k] < 228 && mx[k] > 60) { any = true; break; }
  let inv = false;
  for (let k = 0; k < mx.length; k++) if (mean[k] < 90 && mx[k] > 150) { inv = true; break; }
  if (!any && !inv) return g;
  const out = new Uint8Array(g);
  if (inv) {
    // dark bands holding light text: the right way round first
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const k = by * bw + bx;
      if (!(mean[k] < 90 && mx[k] > 150)) continue;
      const y1 = Math.min(H, (by + 1) * B), x1 = Math.min(W, (bx + 1) * B);
      for (let y = by * B; y < y1; y++) for (let x = bx * B, i = y * W + x; x < x1; x++, i++) out[i] = 255 - out[i];
    }
    stats(out);
  }
  // all-ink blocks (inside a big letter or a black box) borrow the background next to them
  const bg = new Float32Array(mx.length);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const k = by * bw + bx;
    let v = mx[k];
    if (v < 110) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = by + dy, xx = bx + dx; if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) v = Math.max(v, mx[yy * bw + xx]); }
    bg[k] = Math.max(110, v);
  }
  for (let y = 0; y < H; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5)), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0, i = y * W; x < W; x++, i++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5)), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      const b = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) + (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
      if (b >= 250) continue;
      const v = (out[i] * 255) / b;
      out[i] = v > 255 ? 255 : v;
    }
  }
  return out;
}

/**
 * Table lines taken out: Tesseract tends to give up on text boxed in by ruled lines (a table's
 * header row comes back empty). Long thin dark runs - across or down - are painted white;
 * thick black areas and letters are left alone.
 */
export function unline(g: Uint8Array, W: number, H: number): Uint8Array {
  const DARK = 140;
  const minH = Math.max(80, Math.round(W / 25)), minV = Math.max(60, Math.round(H / 55));
  const kill: number[] = [];
  const thin = (i0: number, step: number, n: number, side: number, lim: number) => {
    // pixels a little to each side of the run: mostly light
    let light = 0, tot = 0;
    for (const d of [-side, side]) for (let k = 0; k < n; k += 3) {
      const i = i0 + k * step + d;
      if (i < 0 || i >= lim) continue;
      tot++;
      if (g[i] > DARK) light++;
    }
    return tot > 0 && light > tot * 0.65;
  };
  for (let y = 0; y < H; y++) {
    let start = -1, miss = 0;
    for (let x = 0; x <= W; x++) {
      const dark = x < W && g[y * W + x] <= DARK;
      if (dark) { if (start < 0) start = x; miss = 0; continue; }
      if ((start >= 0 && ++miss > 4) || x === W) {
        const end = x - miss;
        if (start >= 0 && end - start >= minH && thin(y * W + start, 1, end - start, 5 * W, g.length)) for (let k = start; k < end; k++) kill.push(y * W + k);
        start = -1; miss = 0;
      }
    }
  }
  const hKill = kill.length;
  for (let x = 0; x < W; x++) {
    let start = -1, miss = 0;
    for (let y = 0; y <= H; y++) {
      const dark = y < H && g[y * W + x] <= DARK;
      if (dark) { if (start < 0) start = y; miss = 0; continue; }
      if ((start >= 0 && ++miss > 4) || y === H) {
        const end = y - miss;
        if (start >= 0 && end - start >= minV && thin(start * W + x, W, end - start, 5, g.length)) for (let k = start; k < end; k++) kill.push(k * W + x);
        start = -1; miss = 0;
      }
    }
  }
  if (!kill.length) return g;
  const out = new Uint8Array(g);
  for (const i of kill) out[i] = 255;
  // the line's soft grey edges go too (they would read as "|" and "_")
  for (let k = 0; k < kill.length; k++) {
    const i = kill[k];
    const across = k < hKill ? W : 1;
    for (const d of [-2, -1, 1, 2]) { const j = i + d * across; if (j >= 0 && j < out.length && out[j] < 235 && g[j] > 60) out[j] = 255; }
  }
  return out;
}

/** grey, (turned by 90° steps), de-speckled, contrast-stretched -> PGM bytes */
export function prep(bmp: ImageBitmap, W: number, H: number, quarter: number, denoise: number): Uint8Array {
  const turned = quarter % 2 === 1;
  const OW = turned ? H : W, OH = turned ? W : H;
  const c = new OffscreenCanvas(OW, OH);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, OW, OH);
  if (quarter) { g.translate(OW / 2, OH / 2); g.rotate((quarter * Math.PI) / 2); g.translate(-W / 2, -H / 2); }
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const px = g.getImageData(0, 0, OW, OH).data;
  const n = OW * OH;
  let grey: Uint8Array = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) grey[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
  // speckle first (stretching contrast before this would make the noise worse)
  if (denoise > 0) grey = median(grey, OW, OH, denoise);
  grey = flatten(grey, OW, OH);
  grey = unline(grey, OW, OH);
  const hist = new Uint32Array(256);
  for (let j = 0; j < n; j++) hist[grey[j]]++;
  // contrast stretch: darkest 0.5 % -> black, lightest 2 % -> white (faint photocopies, grey paper)
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < n * 0.005) lo++;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) < n * 0.02) hi--;
  if (hi - lo > 40 && (lo > 10 || hi < 245)) {
    const k = 255 / (hi - lo);
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round((v - lo) * k)));
    for (let j = 0; j < n; j++) grey[j] = lut[grey[j]];
  }
  const head = new TextEncoder().encode(`P5\n${OW} ${OH}\n255\n`);
  const out = new Uint8Array(head.length + n);
  out.set(head);
  out.set(grey, head.length);
  return out;
}
