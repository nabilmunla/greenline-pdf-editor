// A stamp from a scan or a phone photo -> a clean stamp picture with a see-through background.
// No interface code here (testable in Node): pixels in, pixels out.
//
//  1. paper: its colour is measured in blocks across the picture (uneven light, shadows, yellowed
//     paper) and every pixel is divided by it - the paper becomes even white;
//  2. ink: the stamp's colour is found (the strongest coloured ink; else black ink);
//  3. colour to alpha: how much of that ink each pixel holds = its opacity; the colour comes out as
//     the ink's own (even) or as scanned (texture kept);
//  4. other ink: black text, lines or a signature in another colour are left out (hue + how
//     colourful a pixel is for its strength);
//  5. specks: small marks far from everything else go;
//  6. crop: the biggest group of stamp ink (letters joined up); 7. straighten: the angle at which
//     its lines line up best (a round seal is left as it is).
// The work is done on a copy at most 1400 px long; the result is sampled from the original, so a
// 600 dpi scan gives a sharp stamp.

export type RGB3 = [number, number, number];
export interface Img { w: number; h: number; data: Uint8ClampedArray | Uint8Array }
export type Box = [number, number, number, number];

export interface Analysis {
  src: Img;
  /** working pixel -> source pixel */
  k: number;
  W: number;
  H: number;
  /** working copy, paper divided out (0..1, 3 per pixel) */
  rgb: Float32Array;
  grid: { gw: number; gh: number; B: number; P: Float32Array };
  /** the ink found: colour (on white paper), its hue (null = black / grey ink), how colourful */
  ink: RGB3;
  inkHue: number | null;
  inkChroma: number;
  /** other ink (black text, another colour) is there to leave out */
  others: boolean;
  /** next to other ink (black text strokes and their soft edges): stricter there */
  near: Uint8Array | null;
  /** on other ink (its strokes, a pixel wider): where the stamp is hidden under it */
  under: Uint8Array | null;
  /** not the sheet: the desk or table round a photographed sheet (never ink) */
  bg: Uint8Array | null;
  /** suggested crop (working pixels) and tilt (degrees, + = turned clockwise on screen) */
  crop: Box;
  angle: number;
}

export interface CleanOpts {
  /** 0..1: how much faint marking is cleared (0.5 = normal) */
  strength?: number;
  /** leave out ink of other colours / black text (coloured stamps only) */
  removeOther?: boolean;
  /** the ink to look for (picked from the picture) instead of the one found */
  ink?: RGB3;
  /** output colour: a colour = even colour, null = as scanned (shading kept), undefined = the ink's */
  color?: RGB3 | null;
  crop?: Box;
  /** straighten by the angle found (default yes) */
  straighten?: boolean;
  /** extra turn in degrees (the person's) */
  turn?: number;
  /** longest side of the result in pixels */
  maxSide?: number;
}

export interface Cleaned {
  img: Img;
  /** the crop's size in source pixels (for the size on the page) */
  srcW: number;
  srcH: number;
  /** total turn applied (degrees) */
  angle: number;
}

const WORK = 1400;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function hueOf(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  if (c <= 1e-6) return 0;
  let h: number;
  if (mx === r) h = ((g - b) / c) % 6;
  else if (mx === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** working copy: area average to at most WORK px, over white where the picture is see-through */
function shrink(src: Img): { W: number; H: number; k: number; rgb: Float32Array } {
  const k = Math.max(1, Math.max(src.w, src.h) / WORK);
  const W = Math.max(1, Math.round(src.w / k)), H = Math.max(1, Math.round(src.h / k));
  const rgb = new Float32Array(W * H * 3);
  const cnt = new Float32Array(W * H);
  const d = src.data;
  for (let y = 0; y < src.h; y++) {
    const yy = Math.min(H - 1, Math.floor(y / k));
    for (let x = 0; x < src.w; x++) {
      const xx = Math.min(W - 1, Math.floor(x / k));
      const i = (y * src.w + x) * 4, o = yy * W + xx;
      const a = d[i + 3] / 255;
      rgb[o * 3] += (d[i] / 255) * a + (1 - a);
      rgb[o * 3 + 1] += (d[i + 1] / 255) * a + (1 - a);
      rgb[o * 3 + 2] += (d[i + 2] / 255) * a + (1 - a);
      cnt[o]++;
    }
  }
  for (let o = 0; o < W * H; o++) { const c = cnt[o] || 1; rgb[o * 3] /= c; rgb[o * 3 + 1] /= c; rgb[o * 3 + 2] /= c; }
  return { W, H, k, rgb };
}

/** paper colour per block: the brightest fifth of each block, steadied against its neighbours */
function paperGrid(rgb: Float32Array, W: number, H: number) {
  const B = Math.max(12, Math.round(Math.max(W, H) / 28));
  const gw = Math.ceil(W / B), gh = Math.ceil(H / B);
  let P = new Float32Array(gw * gh * 3);
  const lumB = new Float32Array(gw * gh);
  const hist = new Uint32Array(64);
  for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
    hist.fill(0);
    let n = 0;
    const x1 = Math.min(W, (bx + 1) * B), y1 = Math.min(H, (by + 1) * B);
    for (let y = by * B; y < y1; y++) for (let x = bx * B; x < x1; x++) {
      const o = (y * W + x) * 3;
      hist[Math.min(63, Math.floor((0.3 * rgb[o] + 0.59 * rgb[o + 1] + 0.11 * rgb[o + 2]) * 64))]++;
      n++;
    }
    // the level above which the brightest 20 % lie
    let acc = 0, t = 63;
    for (; t > 0; t--) { acc += hist[t]; if (acc >= n * 0.2) break; }
    let r = 0, g = 0, b = 0, m = 0;
    for (let y = by * B; y < y1; y++) for (let x = bx * B; x < x1; x++) {
      const o = (y * W + x) * 3;
      if ((0.3 * rgb[o] + 0.59 * rgb[o + 1] + 0.11 * rgb[o + 2]) * 64 >= t) { r += rgb[o]; g += rgb[o + 1]; b += rgb[o + 2]; m++; }
    }
    const q = (by * gw + bx) * 3;
    P[q] = r / (m || 1); P[q + 1] = g / (m || 1); P[q + 2] = b / (m || 1);
    lumB[by * gw + bx] = 0.3 * P[q] + 0.59 * P[q + 1] + 0.11 * P[q + 2];
  }
  // a block mostly covered by ink reads too dark: it takes its neighbours' paper
  for (let pass = 0; pass < 2; pass++) {
    const NP = P.slice();
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      const ls: number[] = [], cs: number[] = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = bx + dx, y = by + dy;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        ls.push(lumB[y * gw + x]); cs.push(y * gw + x);
      }
      if (!ls.length) continue;
      const sorted = [...ls].sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1];
      if (lumB[by * gw + bx] < med - 0.06) {
        // the neighbours at least as bright as the middle one
        let r = 0, g = 0, b = 0, m = 0;
        cs.forEach((c, i) => { if (ls[i] >= med) { r += P[c * 3]; g += P[c * 3 + 1]; b += P[c * 3 + 2]; m++; } });
        const q = (by * gw + bx) * 3;
        NP[q] = r / m; NP[q + 1] = g / m; NP[q + 2] = b / m;
      }
    }
    P = NP;
    for (let i = 0; i < gw * gh; i++) lumB[i] = 0.3 * P[i * 3] + 0.59 * P[i * 3 + 1] + 0.11 * P[i * 3 + 2];
  }
  // smoothed (3 x 3 average, twice)
  for (let pass = 0; pass < 2; pass++) {
    const NP = new Float32Array(P.length);
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      let r = 0, g = 0, b = 0, m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = bx + dx, y = by + dy;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        const c = (y * gw + x) * 3;
        r += P[c]; g += P[c + 1]; b += P[c + 2]; m++;
      }
      const q = (by * gw + bx) * 3;
      NP[q] = r / m; NP[q + 1] = g / m; NP[q + 2] = b / m;
    }
    P = NP;
  }
  return { gw, gh, B, P };
}

/** paper colour at a working-copy point (between block centres) */
function paperAt(g: Analysis['grid'], x: number, y: number, out: number[]) {
  const fx = Math.max(0, Math.min(g.gw - 1, x / g.B - 0.5)), fy = Math.max(0, Math.min(g.gh - 1, y / g.B - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(g.gw - 1, x0 + 1), y1 = Math.min(g.gh - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  for (let c = 0; c < 3; c++) {
    const a = g.P[(y0 * g.gw + x0) * 3 + c], b = g.P[(y0 * g.gw + x1) * 3 + c], d = g.P[(y1 * g.gw + x0) * 3 + c], e = g.P[(y1 * g.gw + x1) * 3 + c];
    out[c] = Math.max(0.08, (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
  }
}

/** the ink colour to look for */
function findInk(rgb: Float32Array, n: number): { ink: RGB3; hue: number | null; chroma: number; others: boolean } {
  const bins = new Float64Array(36);
  let colouredPx = 0, neutralPx = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const a = 1 - (0.3 * r + 0.59 * g + 0.11 * b);
    if (a < 0.2) continue;
    const c = Math.max(r, g, b) - Math.min(r, g, b);
    if (c > 0.12) { bins[Math.floor(hueOf(r, g, b) / 10) % 36] += c * a; colouredPx++; }
    else if (c < 0.08 && a > 0.35) neutralPx++;
  }
  // a coloured stamp: enough coloured ink (a stamp on a page of black text is still the stamp)
  const coloured = colouredPx > n * 0.0015;
  let hue: number | null = null;
  if (coloured) {
    let best = 0;
    for (let i = 0; i < 36; i++) { const v = bins[i] + 0.5 * (bins[(i + 35) % 36] + bins[(i + 1) % 36]); if (v > best) { best = v; hue = i * 10 + 5; } }
    // refined: the weighted mean of the hues near the peak
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) {
      const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
      const a = 1 - (0.3 * r + 0.59 * g + 0.11 * b), c = Math.max(r, g, b) - Math.min(r, g, b);
      if (a < 0.2 || c < 0.12) continue;
      const h = hueOf(r, g, b);
      if (hueDist(h, hue!) > 25) continue;
      sx += Math.cos((h * Math.PI) / 180) * c * a; sy += Math.sin((h * Math.PI) / 180) * c * a;
    }
    hue = ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
  }
  // its colour: the densest third of the pixels of that ink
  const darks: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const a = 1 - (0.3 * r + 0.59 * g + 0.11 * b), c = Math.max(r, g, b) - Math.min(r, g, b);
    if (a < 0.2) continue;
    if (hue !== null ? c > 0.12 && hueDist(hueOf(r, g, b), hue) <= 25 : c < 0.12) darks.push(i);
  }
  const lum = (i: number) => 0.3 * rgb[i * 3] + 0.59 * rgb[i * 3 + 1] + 0.11 * rgb[i * 3 + 2];
  // (by colourfulness for a coloured ink - its darkest pixels are where it runs into black text)
  const key = hue !== null ? (i: number) => -(Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) - Math.min(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])) : lum;
  darks.sort((x, y) => key(x) - key(y));
  const take = darks.slice(0, Math.max(1, Math.floor(darks.length / 3)));
  let ink: RGB3 = hue === null ? [0.12, 0.12, 0.12] : [0.15, 0.25, 0.65];
  if (take.length) {
    let r = 0, g = 0, b = 0;
    for (const i of take) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; }
    ink = [r / take.length, g / take.length, b / take.length];
  }
  // (never too close to white: everything would count as full ink)
  const l = 0.3 * ink[0] + 0.59 * ink[1] + 0.11 * ink[2];
  if (l > 0.7) { const f = 0.7 / l; ink = [ink[0] * f, ink[1] * f, ink[2] * f]; }
  const chroma = Math.max(...ink) - Math.min(...ink);
  return { ink, hue, chroma, others: hue !== null && neutralPx > n * 0.0015 };
}

interface InkRule { ink: RGB3; inv: number[]; hue: number | null; chroma: number; removeOther: boolean; floor: number }
const HUE_FULL = 28, HUE_NONE = 45; // degrees from the ink's hue: fully its ink .. not its ink
function rule(an: Analysis, o: CleanOpts): InkRule {
  const ink = o.ink ?? an.ink;
  const ch = Math.max(...ink) - Math.min(...ink);
  const hue = o.ink ? (ch > 0.12 ? hueOf(...ink) : null) : an.inkHue;
  // 1 / (1 - ink) per channel the ink darkens enough to measure by
  const inv = ink.map((v) => (1 - v > 0.08 ? 1 / (1 - v) : 0));
  const s = o.strength ?? 0.5;
  return { ink, inv, hue, chroma: ch, removeOther: (o.removeOther ?? true) && hue !== null, floor: 0.04 + 0.2 * clamp01(s) };
}

/** how much ink a pixel holds (0..1, before the clean-up floor); near: beside other ink */
function rawAlpha(r: number, g: number, b: number, R: InkRule, near = false): number {
  let a = Math.max((1 - r) * R.inv[0], (1 - g) * R.inv[1], (1 - b) * R.inv[2]);
  if (a <= 0) return 0;
  if (a > 1) a = 1;
  if (R.removeOther && R.hue !== null) {
    const c = Math.max(r, g, b) - Math.min(r, g, b);
    // as colourful as this much of the ink would be? (black text is dark but grey) - beside black
    // text more so: the soft edges of its letters pick up colour noise and would stay as dashes
    const rho = c / Math.max(a * R.chroma, near ? 0.05 : 0.02);
    let w = near ? clamp01((rho - 0.6) / 0.3) : clamp01((rho - 0.3) / 0.3);
    if (c >= (near ? 0.03 : 0.05)) w = Math.min(w, clamp01((HUE_NONE - hueDist(hueOf(r, g, b), R.hue)) / (HUE_NONE - HUE_FULL)));
    a *= w;
  }
  return a;
}
const cleanUp = (a: number, R: InkRule) => clamp01((a - R.floor) / (0.8 - R.floor));

/** the working copy's opacity map with the clean-up applied (specks not removed) */
export function alphaMap(an: Analysis, o: CleanOpts = {}): Float32Array {
  const R = rule(an, o);
  const n = an.W * an.H, out = new Float32Array(n);
  const near = an.near;
  for (let i = 0; i < n; i++) out[i] = cleanUp(rawAlpha(an.rgb[i * 3], an.rgb[i * 3 + 1], an.rgb[i * 3 + 2], R, !!near && near[i] === 1), R);
  return out;
}

/** square max filter of radius r on a 0/1 mask (two running passes) */
function dilate(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const t = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let cnt = 0;
    for (let x = -r; x < W; x++) {
      if (x + r < W && m[y * W + x + r]) cnt++;
      if (x - r - 1 >= 0 && m[y * W + x - r - 1]) cnt--;
      if (x >= 0) t[y * W + x] = cnt > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < W; x++) {
    let cnt = 0;
    for (let y = -r; y < H; y++) {
      if (y + r < H && t[(y + r) * W + x]) cnt++;
      if (y - r - 1 >= 0 && t[(y - r - 1) * W + x]) cnt--;
      if (y >= 0) out[y * W + x] = cnt > 0 ? 1 : 0;
    }
  }
  return out;
}

/** connected groups (8 neighbours): label per pixel (0 = none), sizes */
function groups(m: Uint8Array, W: number, H: number): { lab: Int32Array; size: number[] } {
  const lab = new Int32Array(W * H);
  const size: number[] = [0];
  const stack = new Int32Array(W * H);
  let next = 0;
  for (let i = 0; i < W * H; i++) {
    if (!m[i] || lab[i]) continue;
    next++;
    let sp = 0, n = 0;
    stack[sp++] = i; lab[i] = next;
    while (sp) {
      const p = stack[--sp];
      n++;
      const x = p % W, y = (p / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx;
        if (m[q] && !lab[q]) { lab[q] = next; stack[sp++] = q; }
      }
    }
    size.push(n);
  }
  return { lab, size };
}

/** ink to keep: specks far from everything else left out (an i's dot or a full stop stays) */
export function keepMask(an: Analysis, alpha: Float32Array): Uint8Array {
  const { W, H } = an;
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = alpha[i] > 0.25 ? 1 : 0;
  const { lab, size } = groups(m, W, H);
  const minA = Math.max(4, Math.round(W * H * 0.00002));
  const big = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (lab[i] && size[lab[i]] >= minA) big[i] = 1;
  const near = dilate(big, W, H, Math.max(3, Math.round(Math.max(W, H) * 0.012)));
  const keep = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) keep[i] = lab[i] && (size[lab[i]] >= minA || near[i]) ? 1 : 0;
  // (with a pixel of room: edges of strokes fainter than the 0.25 line stay)
  return dilate(keep, W, H, 1);
}

/** the stamp: the biggest group of ink once its letters are joined up */
function autoCrop(an: Analysis, alpha: Float32Array, keep: Uint8Array): Box {
  const { W, H } = an;
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = keep[i] && alpha[i] > 0.25 ? 1 : 0;
  const R = Math.max(3, Math.round(Math.max(W, H) * 0.025));
  const joined = dilate(m, W, H, R);
  const { lab, size } = groups(joined, W, H);
  if (size.length < 2) return [0, 0, W, H];
  const mass = new Float64Array(size.length);
  for (let i = 0; i < W * H; i++) if (m[i]) mass[lab[i]] += alpha[i];
  let best = 1;
  for (let l = 2; l < size.length; l++) if (mass[l] > mass[best]) best = l;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let i = 0; i < W * H; i++) {
    if (!m[i] || lab[i] !== best) continue;
    const x = i % W, y = (i / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return [0, 0, W, H];
  const pad = Math.max(3, Math.round(Math.max(x1 - x0, y1 - y0) * 0.04));
  return [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(W, x1 + 1 + pad), Math.min(H, y1 + 1 + pad)];
}

/** the tilt at which the ink's lines line up best (degrees; 0 when nothing lines up clearly) */
function tilt(an: Analysis, alpha: Float32Array, keep: Uint8Array, box: Box): number {
  const { W } = an;
  const xs: number[] = [], ys: number[] = [];
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  const step = Math.max(1, Math.round(Math.sqrt(area / 160000)));
  for (let y = box[1]; y < box[3]; y += step) for (let x = box[0]; x < box[2]; x += step) {
    const i = y * W + x;
    if (keep[i] && alpha[i] > 0.4) { xs.push(x); ys.push(y); }
  }
  if (xs.length < 200) return 0;
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const span = Math.hypot(box[2] - box[0], box[3] - box[1]);
  const nb = Math.ceil(span / step) + 4;
  const h1 = new Float64Array(nb), h2 = new Float64Array(nb);
  const score = (deg: number) => {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    h1.fill(0); h2.fill(0);
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i] - cx, y = ys[i] - cy;
      h1[Math.floor((y * c - x * s) / step + nb / 2)]++;
      h2[Math.floor((x * c + y * s) / step + nb / 2)]++;
    }
    let v = 0;
    for (let i = 0; i < nb; i++) v += h1[i] * h1[i] + h2[i] * h2[i];
    return v;
  };
  const s0 = score(0);
  let best = 0, bs = s0;
  for (let d = -15; d <= 15; d += 0.5) { const v = score(d); if (v > bs) { bs = v; best = d; } }
  for (let d = best - 0.4; d <= best + 0.4; d += 0.1) { const v = score(d); if (v > bs) { bs = v; best = d; } }
  // only a clear gain: round seals and handwriting have no lines to go by
  return bs > s0 * 1.12 && Math.abs(best) >= 0.4 ? Math.round(best * 10) / 10 : 0;
}

/** bilinear value of a working-copy map */
function sample(m: Float32Array, W: number, H: number, x: number, y: number): number {
  const fx = Math.max(0, Math.min(W - 1, x)), fy = Math.max(0, Math.min(H - 1, y));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  return (m[y0 * W + x0] * (1 - tx) + m[y0 * W + x1] * tx) * (1 - ty) + (m[y1 * W + x0] * (1 - tx) + m[y1 * W + x1] * tx) * ty;
}

/** grey-level max (grow) or min (shrink) over a (2r+1) square, in two passes (inline: a
 *  function call per comparison made this 15x slower - half a second per clean-up change) */
function rank(m: Float32Array, W: number, H: number, r: number, max: boolean): Float32Array {
  const t = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const a = Math.max(0, x - r), b = Math.min(W - 1, x + r);
      let v = m[row + a];
      if (max) { for (let i = a + 1; i <= b; i++) if (m[row + i] > v) v = m[row + i]; }
      else { for (let i = a + 1; i <= b; i++) if (m[row + i] < v) v = m[row + i]; }
      t[row + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    const a = Math.max(0, y - r), b = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      let v = t[a * W + x];
      if (max) { for (let i = a + 1; i <= b; i++) if (t[i * W + x] > v) v = t[i * W + x]; }
      else { for (let i = a + 1; i <= b; i++) if (t[i * W + x] < v) v = t[i * W + x]; }
      out[y * W + x] = v;
    }
  }
  return out;
}

/**
 * Where black text ran through the stamp its strokes have gaps: the stamp's ink closed over them
 * (grown, then shrunk back - a gap as wide as a letter's stroke fills, the stamp keeps its shape),
 * only beside that other ink.
 */
function bridgeMap(an: Analysis, alpha: Float32Array, keep: Uint8Array): Float32Array {
  const { W, H } = an;
  const m = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = keep[i] ? alpha[i] : 0;
  const r = Math.max(2, Math.round(Math.max(W, H) / 600));
  const closed = rank(rank(m, W, H, r, true), W, H, r, false);
  const out = new Float32Array(W * H);
  // (only on the other ink itself: closing letters next to a line of text would merge them)
  for (let i = 0; i < W * H; i++) if (an.under![i] && closed[i] > m[i]) out[i] = closed[i];
  return out;
}

/** the paper-free colour round a working-copy point (its darkest quarter of 7 x 7): the ink picked in the picture */
export function inkAt(an: Analysis, x: number, y: number): RGB3 {
  let r = 0, g = 0, b = 0, n = 0;
  // (the darkest pixels there: a click a pixel off a thin stroke still finds its ink)
  const pts: number[] = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const xx = Math.round(x) + dx, yy = Math.round(y) + dy;
    if (xx < 0 || yy < 0 || xx >= an.W || yy >= an.H) continue;
    pts.push(yy * an.W + xx);
  }
  const lum = (i: number) => 0.3 * an.rgb[i * 3] + 0.59 * an.rgb[i * 3 + 1] + 0.11 * an.rgb[i * 3 + 2];
  pts.sort((p, q) => lum(p) - lum(q));
  for (const i of pts.slice(0, Math.max(1, Math.ceil(pts.length / 4)))) { r += an.rgb[i * 3]; g += an.rgb[i * 3 + 1]; b += an.rgb[i * 3 + 2]; n++; }
  const ink: RGB3 = [r / n, g / n, b / n];
  const l = 0.3 * ink[0] + 0.59 * ink[1] + 0.11 * ink[2];
  return l > 0.7 ? (ink.map((v) => (v * 0.7) / l) as RGB3) : ink;
}

/**
 * A photo of a sheet lying on a desk: the desk round it (block by block: darker than the sheet's
 * paper, or clearly coloured, reaching in from the picture's edge along a good part of it), then
 * pixel by pixel along the sheet's edge (closer to the desk's colour or to the paper's). Without
 * this the desk's colour was taken for the ink and the sheet got a thick frame. A stamp touching
 * the picture's edge here and there is not a desk.
 */
function deskOf(raw: Float32Array, W: number, H: number, g: Analysis['grid']): Uint8Array | null {
  const { gw, gh, P } = g;
  const nb = gw * gh;
  if (gw < 4 || gh < 4) return null;
  const lum = (i: number) => 0.3 * P[i * 3] + 0.59 * P[i * 3 + 1] + 0.11 * P[i * 3 + 2];
  // (saturation, not chroma: the same in the shadow - wood is very saturated, yellowed paper is not)
  const sat = (i: number) => { const mx = Math.max(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); return mx > 0.02 ? (mx - Math.min(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])) / mx : 0; };
  const ls = [...Array(nb).keys()].map(lum).sort((a, b) => a - b);
  const Lref = ls[Math.floor(nb * 0.9)];
  const desky = new Uint8Array(nb);
  for (let i = 0; i < nb; i++) if (lum(i) < 0.4 * Lref || sat(i) > 0.35) desky[i] = 1;
  // from the edge of the picture inwards
  const desk = new Uint8Array(nb);
  const stack: number[] = [];
  for (let x = 0; x < gw; x++) for (const y of [0, gh - 1]) { const i = y * gw + x; if (desky[i] && !desk[i]) { desk[i] = 1; stack.push(i); } }
  for (let y = 0; y < gh; y++) for (const x of [0, gw - 1]) { const i = y * gw + x; if (desky[i] && !desk[i]) { desk[i] = 1; stack.push(i); } }
  while (stack.length) {
    const i = stack.pop()!, x = i % gw, y = (i / gw) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
      const j = yy * gw + xx;
      if (desky[j] && !desk[j]) { desk[j] = 1; stack.push(j); }
    }
  }
  // along a good part of the picture's edge (a seal touching it in a few places is not a desk) and
  // leaving a sheet (some paper)
  let edge = 0, onEdge = 0, deskN = 0;
  for (let i = 0; i < nb; i++) {
    const x = i % gw, y = (i / gw) | 0;
    if (desk[i]) deskN++;
    if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) { edge++; if (desk[i]) onEdge++; }
  }
  if (onEdge < edge * 0.3 || deskN > nb * 0.85 || deskN < 3) return null;
  // pixel by pixel: the desk's colour (a desk block next to it) or the paper's (its block); then
  // only what joins up with the desk (ink near the sheet's edge is not desk)
  const cand = new Uint8Array(W * H);
  const B = g.B;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const bi = Math.min(gh - 1, (y / B) | 0) * gw + Math.min(gw - 1, (x / B) | 0);
    // blocks next to the other kind decide pixel by pixel; the rest by the block
    let dsk = -1, pap = -1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const bx = (bi % gw) + dx, by = ((bi / gw) | 0) + dy;
      if (bx < 0 || by < 0 || bx >= gw || by >= gh) continue;
      const j = by * gw + bx;
      if (desk[j]) { if (dsk < 0 || j === bi) dsk = j; } else if (pap < 0 || j === bi) pap = j;
    }
    if (pap < 0) { cand[y * W + x] = 2; continue; } // (deep in the desk: a seed)
    if (dsk < 0) continue;
    const o = (y * W + x) * 3;
    const d2 = (j: number) => (raw[o] - P[j * 3]) ** 2 + (raw[o + 1] - P[j * 3 + 1]) ** 2 + (raw[o + 2] - P[j * 3 + 2]) ** 2;
    if (d2(dsk) < d2(pap)) cand[y * W + x] = 1;
  }
  const out = new Uint8Array(W * H);
  const st = new Int32Array(W * H);
  let sp = 0;
  for (let i = 0; i < W * H; i++) if (cand[i] === 2) { out[i] = 1; st[sp++] = i; }
  while (sp) {
    const i = st[--sp], x = i % W, y = (i / W) | 0;
    if (x > 0 && cand[i - 1] && !out[i - 1]) { out[i - 1] = 1; st[sp++] = i - 1; }
    if (x < W - 1 && cand[i + 1] && !out[i + 1]) { out[i + 1] = 1; st[sp++] = i + 1; }
    if (y > 0 && cand[i - W] && !out[i - W]) { out[i - W] = 1; st[sp++] = i - W; }
    if (y < H - 1 && cand[i + W] && !out[i + W]) { out[i + W] = 1; st[sp++] = i + W; }
  }
  return out;
}

/** look at a picture once: paper, ink, where the stamp is, how it is turned */
export function analyse(src: Img): Analysis {
  const { W, H, k, rgb } = shrink(src);
  const grid = paperGrid(rgb, W, H);
  const bg = deskOf(rgb, W, H, grid);
  const pap = [0, 0, 0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    paperAt(grid, x + 0.5, y + 0.5, pap);
    const o = (y * W + x) * 3;
    rgb[o] = clamp01(rgb[o] / pap[0]); rgb[o + 1] = clamp01(rgb[o + 1] / pap[1]); rgb[o + 2] = clamp01(rgb[o + 2] / pap[2]);
    // (the desk round a photographed sheet counts as paper: never ink, never the stamp's colour)
    if (bg && bg[y * W + x]) rgb[o] = rgb[o + 1] = rgb[o + 2] = 1;
  }
  const f = findInk(rgb, W * H);
  // black / grey ink (text, lines) and a couple of pixels round it
  let near: Uint8Array | null = null, under: Uint8Array | null = null;
  if (f.hue !== null) {
    const m = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
      if (1 - (0.3 * r + 0.59 * g + 0.11 * b) > 0.3 && Math.max(r, g, b) - Math.min(r, g, b) < 0.1) m[i] = 1;
    }
    near = dilate(m, W, H, Math.max(2, Math.round(Math.max(W, H) / 700)));
    under = dilate(m, W, H, 1);
  }
  const an: Analysis = { src, k, W, H, rgb, grid, ink: f.ink, inkHue: f.hue, inkChroma: f.chroma, others: f.others, near, under, bg, crop: [0, 0, W, H], angle: 0 };
  const alpha = alphaMap(an);
  const keep = keepMask(an, alpha);
  an.crop = autoCrop(an, alpha, keep);
  an.angle = tilt(an, alpha, keep, an.crop);
  // (the first clean with the usual settings uses these instead of working them out again)
  memo.set(an, { key: memoKey({}), alphaW: alpha, keep, bridge: an.under ? bridgeMap(an, alpha, keep) : null });
  return an;
}

/** the clean stamp: cropped, turned, see-through, sampled from the original picture */
const memo = new WeakMap<Analysis, { key: string; alphaW: Float32Array; keep: Uint8Array; bridge: Float32Array | null }>();
const memoKey = (o: CleanOpts) => JSON.stringify([o.strength ?? 0.5, o.removeOther ?? true, o.ink ?? null]);

export function clean(an: Analysis, o: CleanOpts = {}): Cleaned {
  const R = rule(an, o);
  // (the working-copy maps depend only on the ink settings: kept while turning, cropping, colouring)
  const key = memoKey(o);
  let m = memo.get(an);
  if (!m || m.key !== key) {
    const alphaW = alphaMap(an, o);
    const keep = keepMask(an, alphaW);
    m = { key, alphaW, keep, bridge: an.under && R.removeOther ? bridgeMap(an, alphaW, keep) : null };
    memo.set(an, m);
  }
  const { keep, bridge } = m;
  const crop = o.crop ?? an.crop;
  const angle = ((o.straighten ?? true) ? -an.angle : 0) + (o.turn ?? 0);
  const src = an.src, k = an.k;
  // the crop in source pixels, turned: the result's size
  const sx0 = crop[0] * k, sy0 = crop[1] * k, sx1 = crop[2] * k, sy1 = crop[3] * k;
  const cw = sx1 - sx0, ch = sy1 - sy0, ccx = (sx0 + sx1) / 2, ccy = (sy0 + sy1) / 2;
  const t = (angle * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const bw = Math.abs(cw * c) + Math.abs(ch * s), bh = Math.abs(cw * s) + Math.abs(ch * c);
  const maxSide = o.maxSide ?? 1000;
  const sc = Math.min(1, maxSide / Math.max(bw, bh)); // output px per source px
  const OW = Math.max(1, Math.round(bw * sc)), OH = Math.max(1, Math.round(bh * sc));
  const out = new Uint8ClampedArray(OW * OH * 4);
  const col = o.color === undefined ? R.ink : o.color;
  const sd = src.data, SW = src.w, SH = src.h;
  const pap = [0, 0, 0];
  // (each output pixel averages the source pixels under it when shrinking: no sparkle)
  const ss = sc < 0.6 ? 2 : 1;
  for (let oy = 0; oy < OH; oy++) for (let ox = 0; ox < OW; ox++) {
    let A = 0, r0 = 0, g0 = 0, b0 = 0;
    for (let jy = 0; jy < ss; jy++) for (let jx = 0; jx < ss; jx++) {
      // output pixel -> source point (turned back about the crop's centre)
      const u = (ox + (jx + 0.5) / ss) / sc - bw / 2, v = (oy + (jy + 0.5) / ss) / sc - bh / 2;
      const X = ccx + u * c + v * s, Y = ccy - u * s + v * c;
      if (X < sx0 - 0.5 || Y < sy0 - 0.5 || X > sx1 + 0.5 || Y > sy1 + 0.5 || X < 0 || Y < 0 || X > SW - 1 || Y > SH - 1) continue;
      // specks (decided on the working copy)
      const wx = Math.min(an.W - 1, Math.floor(X / k)), wy = Math.min(an.H - 1, Math.floor(Y / k));
      if (an.bg && an.bg[wy * an.W + wx]) continue;
      const kept = keep[wy * an.W + wx] === 1;
      const bridged = bridge && an.under![wy * an.W + wx] ? sample(bridge, an.W, an.H, X / k - 0.5, Y / k - 0.5) : 0;
      if (!kept && bridged <= 0) continue;
      // bilinear colour from the original, over white where it is see-through
      const x0 = Math.floor(X), y0 = Math.floor(Y), x1 = Math.min(SW - 1, x0 + 1), y1 = Math.min(SH - 1, y0 + 1);
      const tx = X - x0, ty = Y - y0;
      const px = [0, 0, 0];
      for (const [xx, yy, w] of [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]] as const) {
        const i = (yy * SW + xx) * 4, a = sd[i + 3] / 255;
        px[0] += w * ((sd[i] / 255) * a + 1 - a); px[1] += w * ((sd[i + 1] / 255) * a + 1 - a); px[2] += w * ((sd[i + 2] / 255) * a + 1 - a);
      }
      paperAt(an.grid, X / k, Y / k, pap);
      const r = clamp01(px[0] / pap[0]), g = clamp01(px[1] / pap[1]), b = clamp01(px[2] / pap[2]);
      const ra = rawAlpha(r, g, b, R, !!an.near && an.near[wy * an.W + wx] === 1);
      const own = kept ? cleanUp(ra, R) : 0;
      const a = Math.max(own, bridged);
      if (a <= 0) continue;
      A += a;
      if (col === null) {
        // as scanned: the colour that over white paper gives this pixel (bridged: the ink's)
        if (own >= bridged) {
          const q = Math.max(ra, 0.05);
          r0 += a * clamp01(1 - (1 - r) / q); g0 += a * clamp01(1 - (1 - g) / q); b0 += a * clamp01(1 - (1 - b) / q);
        } else { r0 += a * R.ink[0]; g0 += a * R.ink[1]; b0 += a * R.ink[2]; }
      }
    }
    if (A <= 0) continue;
    const n = ss * ss, i = (oy * OW + ox) * 4;
    if (col === null) { out[i] = (r0 / A) * 255; out[i + 1] = (g0 / A) * 255; out[i + 2] = (b0 / A) * 255; }
    else { out[i] = col[0] * 255; out[i + 1] = col[1] * 255; out[i + 2] = col[2] * 255; }
    out[i + 3] = (A / n) * 255;
  }
  // tight around what is left, with a little room
  let x0 = OW, y0 = OH, x1 = -1, y1 = -1;
  for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) if (out[(y * OW + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return { img: { w: 1, h: 1, data: new Uint8ClampedArray(4) }, srcW: 1, srcH: 1, angle };
  const pad = Math.max(2, Math.round(Math.max(x1 - x0, y1 - y0) * 0.02));
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(OW - 1, x1 + pad); y1 = Math.min(OH - 1, y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const img = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) img.set(out.subarray(((y + y0) * OW + x0) * 4, ((y + y0) * OW + x0 + w) * 4), y * w * 4);
  return { img: { w, h, data: img }, srcW: w / sc, srcH: h / sc, angle };
}

/**
 * The picture's resolution if it says (a scanner writes it: JPEG JFIF / PNG pHYs) - for the stamp's
 * real size on the page. 0 when unknown or not believable (phone photos say 72).
 */
export function dpiOf(bytes: Uint8Array): number {
  const ok = (d: number) => (d >= 100 && d <= 2400 ? Math.round(d) : 0);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JFIF APP0: units (1 = dpi, 2 = dots per cm), X density
    let i = 2;
    while (i + 4 < bytes.length && bytes[i] === 0xff) {
      const m = bytes[i + 1], len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (m === 0xe0 && bytes[i + 4] === 0x4a && bytes[i + 5] === 0x46 && bytes[i + 6] === 0x49 && bytes[i + 7] === 0x46) {
        const units = bytes[i + 11], xd = (bytes[i + 12] << 8) | bytes[i + 13];
        return units === 1 ? ok(xd) : units === 2 ? ok(xd * 2.54) : 0;
      }
      if (m === 0xda) break;
      i += 2 + len;
    }
    return 0;
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    let i = 8;
    while (i + 12 <= bytes.length) {
      const len = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
      const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
      if (type === 'pHYs') {
        const x = ((bytes[i + 8] << 24) | (bytes[i + 9] << 16) | (bytes[i + 10] << 8) | bytes[i + 11]) >>> 0;
        return bytes[i + 16] === 1 ? ok(x * 0.0254) : 0;
      }
      if (type === 'IDAT') break;
      i += 12 + len;
    }
  }
  return 0;
}
