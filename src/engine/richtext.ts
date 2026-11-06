// Rich text in text boxes, callouts and typewriter text: parts of the text in bold, italic,
// underlined, another colour, size or font. Shared by the engine (what is saved and drawn) and
// the typing box (what is typed).
//
// The text is a list of runs. A run holds only what differs from the box's own style (its /DA
// font, size, colour, bold, italic): a box whose text is all one style has no runs at all and is
// saved exactly as before. In the file: /GCCRuns (ours, JSON) + /RC (the standard rich text, so
// other PDF programs keep the formatting when they edit the box) + /DS; /Contents stays the plain
// text (search, the comments list, export, copy and the AI read it).

/** a piece of text and how it differs from the box's own style */
export interface TextRun {
  t: string;
  /** bold, italic, underline */
  b?: boolean;
  i?: boolean;
  u?: boolean;
  /** colour (0-1 RGB) */
  c?: number[];
  /** size (pt) */
  s?: number;
  /** font family (Helv / TiRo / Cour or a PC family) */
  f?: string;
}
export type RunStyle = Omit<TextRun, 't'>;
/** the box's own style */
export interface BaseStyle { family: string; size: number; color: number[]; bold: boolean; italic: boolean }
/** a run's style worked out against the box's own */
export interface FullStyle { family: string; size: number; color: number[]; bold: boolean; italic: boolean; underline: boolean }

const KEYS = ['b', 'i', 'u', 'c', 's', 'f'] as const;
type Key = (typeof KEYS)[number];

const sameColor = (a?: number[], b?: number[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.002);
const sameVal = (k: Key, a: unknown, b: unknown) => (k === 'c' ? sameColor(a as number[], b as number[]) : k === 's' ? Math.abs((a as number) - (b as number)) < 0.01 : a === b);
const baseVal = (base: BaseStyle, k: Key): unknown => (k === 'b' ? base.bold : k === 'i' ? base.italic : k === 'u' ? false : k === 'c' ? base.color : k === 's' ? base.size : base.family);

export function sameStyle(a: RunStyle, b: RunStyle): boolean {
  for (const k of KEYS) {
    const x = a[k], y = b[k];
    if (x === undefined && y === undefined) continue;
    if (x === undefined || y === undefined || !sameVal(k, x, y)) return false;
  }
  return true;
}
export const styleOf = (r: TextRun): RunStyle => { const s: RunStyle = {}; for (const k of KEYS) if (r[k] !== undefined) (s as Record<string, unknown>)[k] = r[k]; return s; };
export const runsText = (runs: TextRun[]): string => runs.map((r) => r.t).join('');

export function fullStyle(base: BaseStyle, r: RunStyle): FullStyle {
  return { family: r.f ?? base.family, size: r.s ?? base.size, color: r.c ?? base.color, bold: r.b ?? base.bold, italic: r.i ?? base.italic, underline: r.u ?? false };
}

/** adjacent runs of the same style joined, empty ones dropped */
export function joinRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    if (!r.t) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last, r)) last.t += r.t;
    else out.push({ ...r, ...(r.c ? { c: [...r.c] } : {}) });
  }
  return out;
}

/**
 * Runs against the box's own style: what equals it is dropped; what all the text has alike
 * becomes the box's own style (bold over all of it = a bold box). No differences left: no runs.
 */
export function settle(base: BaseStyle, runs: TextRun[] | undefined, promote = true): { base: BaseStyle; runs: TextRun[] | undefined } {
  if (!runs) return { base, runs: undefined };
  let rs = joinRuns(runs).map((r) => {
    const o: TextRun = { t: r.t };
    for (const k of KEYS) if (r[k] !== undefined && !sameVal(k, r[k], baseVal(base, k))) (o as unknown as Record<string, unknown>)[k] = r[k];
    return o;
  });
  rs = joinRuns(rs);
  const nb: BaseStyle = { ...base, color: [...base.color] };
  if (promote && rs.length && rs.some((r) => r.t.trim())) {
    for (const k of ['b', 'i', 'c', 's', 'f'] as const) {
      // (what the visible text has alike: a space typed after it in the box's own style doesn't count)
      const vis = rs.filter((r) => r.t.trim());
      const v = vis[0][k];
      if (v === undefined || !vis.every((r) => r[k] !== undefined && sameVal(k, r[k], v))) continue;
      if (rs.some((r) => !r.t.trim() && r[k] !== undefined && !sameVal(k, r[k], v))) continue;
      if (k === 'b') nb.bold = v as boolean; else if (k === 'i') nb.italic = v as boolean; else if (k === 'c') nb.color = [...(v as number[])]; else if (k === 's') nb.size = v as number; else nb.family = v as string;
      for (const r of rs) delete r[k];
    }
    rs = joinRuns(rs);
  }
  if (!rs.some((r) => KEYS.some((k) => r[k] !== undefined))) return { base: nb, runs: undefined };
  return { base: nb, runs: rs };
}

/** the style at each character (one entry per UTF-16 unit) */
function charStyles(runs: TextRun[]): RunStyle[] {
  const out: RunStyle[] = [];
  for (const r of runs) { const s = styleOf(r); for (let i = 0; i < r.t.length; i++) out.push(s); }
  return out;
}

/** text [s, e) given `patch` (undefined values: back to the box's own) */
export function styleRange(runs: TextRun[], s: number, e: number, patch: RunStyle): TextRun[] {
  const out: TextRun[] = [];
  let at = 0;
  for (const r of runs) {
    const a = at, b = at + r.t.length;
    at = b;
    if (b <= s || a >= e) { out.push({ ...r }); continue; }
    const i0 = Math.max(s, a) - a, i1 = Math.min(e, b) - a;
    if (i0 > 0) out.push({ ...r, t: r.t.slice(0, i0) });
    const mid: TextRun = { ...r, t: r.t.slice(i0, i1) };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete (mid as unknown as Record<string, unknown>)[k]; else (mid as unknown as Record<string, unknown>)[k] = v; }
    out.push(mid);
    if (i1 < r.t.length) out.push({ ...r, t: r.t.slice(i1) });
  }
  return joinRuns(out);
}

/** one key taken off every run (the whole box was given it) */
export function dropKey(runs: TextRun[] | undefined, k: Key): TextRun[] | undefined {
  if (!runs) return runs;
  return joinRuns(runs.map((r) => { const o = { ...r }; delete o[k]; return o; }));
}

/** the style of [s, e): a key is set only when all of it has the same value (base values filled in) */
export function rangeStyle(base: BaseStyle, runs: TextRun[] | undefined, s: number, e: number): Partial<FullStyle> {
  const text = runs ? runsText(runs) : '';
  const cs = runs ? charStyles(runs) : [];
  if (!runs || !text.length) return fullStyle(base, {});
  let a = Math.max(0, Math.min(s, e)), b = Math.min(text.length, Math.max(s, e));
  if (a === b) { a = 0; b = text.length; }
  const out: Partial<FullStyle> = {};
  const first = fullStyle(base, cs[a]);
  for (const k of Object.keys(first) as (keyof FullStyle)[]) {
    let all = true;
    for (let i = a; i < b && all; i++) {
      if (text[i] === '\n') continue;
      const v = fullStyle(base, cs[i])[k];
      all = k === 'color' ? sameColor(v as number[], first.color) : v === first[k];
    }
    if (all) (out as Record<string, unknown>)[k] = first[k];
  }
  return out;
}

/**
 * The runs kept over a new text (typed elsewhere: the side panel, another program): the start and
 * end that didn't change keep their styles, new text takes the style of the letter before it.
 */
export function reflowRuns(runs: TextRun[], text: string): TextRun[] {
  const old = runsText(runs);
  if (old === text) return runs.map((r) => ({ ...r }));
  const cs = charStyles(runs);
  let p = 0;
  while (p < old.length && p < text.length && old[p] === text[p]) p++;
  let q = 0;
  while (q < old.length - p && q < text.length - p && old[old.length - 1 - q] === text[text.length - 1 - q]) q++;
  const out: TextRun[] = [];
  for (let i = 0; i < p; i++) out.push({ ...cs[i], t: text[i] });
  const ins = text.slice(p, text.length - q);
  if (ins) out.push({ ...(p > 0 ? cs[p - 1] : cs[old.length - q] ?? {}), t: ins });
  for (let i = old.length - q; i < old.length; i++) out.push({ ...cs[i], t: old[i] });
  return joinRuns(out);
}

// ---------------------------------------------------------------- PDF rich text (/RC, /DS)

export const FAMILY_CSS: Record<string, string> = { Helv: 'Helvetica', TiRo: 'Times New Roman', Cour: 'Courier New' };
const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
export const cssHex = (c: number[]) => '#' + (c.length === 1 ? [c[0], c[0], c[0]] : c.length === 4 ? [1 - Math.min(1, c[0] + c[3]), 1 - Math.min(1, c[1] + c[3]), 1 - Math.min(1, c[2] + c[3])] : c).map(hex2).join('');
const famName = (f: string) => { const n = FAMILY_CSS[f] || f; return /[\s,]/.test(n) ? `'${n.replace(/'/g, '')}'` : n; };
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RTL_START = /^[^A-Za-zÀ-ɏ֐-ࣿיִ-ﻼ]*[֐-ࣿיִ-ﻼ]/;

function css(st: FullStyle): string {
  return `font-size:${+st.size.toFixed(2)}pt;color:${cssHex(st.color)};font-weight:${st.bold ? 'bold' : 'normal'};font-style:${st.italic ? 'italic' : 'normal'};font-family:${famName(st.family)}`;
}

/** /DS: the box's own style */
export function toDS(base: BaseStyle, align = 0): string {
  return `font: ${base.bold ? 'bold ' : ''}${base.italic ? 'italic ' : ''}${+base.size.toFixed(2)}pt ${famName(base.family)}; text-align:${['left', 'center', 'right'][align] || 'left'}; color:${cssHex(base.color)}`;
}

/** /RC: the text as XHTML (a paragraph per line, a span per run) */
export function toRC(base: BaseStyle, runs: TextRun[], align = 0): string {
  const al = ['left', 'center', 'right'][align] || 'left';
  const bst = fullStyle(base, {});
  const paras: string[][] = [[]];
  for (const r of runs) {
    const st = fullStyle(base, r);
    const parts = r.t.split('\n');
    parts.forEach((p, k) => {
      if (k > 0) paras.push([]);
      if (p) paras[paras.length - 1].push(`<span style="${css(st)}${st.underline ? ';text-decoration:underline' : ''}">${xml(p)}</span>`);
    });
  }
  const text = runsText(runs).split('\n');
  const body = paras.map((p, i) => `<p dir="${RTL_START.test(text[i] || '') ? 'rtl' : 'ltr'}">${p.length ? p.join('') : '<br/>'}</p>`).join('');
  return `<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:11.0.0" xfa:spec="2.0.2" style="${css(bst)};text-align:${al}">${body}</body>`;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unent = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return ''; } }
  return ENT[e.toLowerCase()] ?? m;
});

/** a CSS colour (#f00, #ff1418, rgb(255,20,24)) as 0-1 RGB */
export function cssColor(v: string): number[] | null {
  const h = /#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(v);
  if (h) { const x = h[1].length === 3 ? h[1].split('').map((c) => c + c).join('') : h[1]; return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255); }
  const r = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
  return r ? [r[1], r[2], r[3]].map((n) => Math.min(255, Number(n)) / 255) : null;
}
/** a CSS font family as one of ours: the three built into every PDF program, closest match */
export function cssFamily(v: string): string {
  return /times|serif(?!.*sans)|roman|georgia|garamond/i.test(v) && !/sans/i.test(v) ? 'TiRo' : /cour|mono|consol/i.test(v) ? 'Cour' : 'Helv';
}

type Css = { size?: number; color?: number[]; bold?: boolean; italic?: boolean; underline?: boolean; family?: string };
function readCss(s: string, into: Css): Css {
  const o = { ...into };
  for (const decl of s.split(';')) {
    const k = decl.indexOf(':');
    if (k < 0) continue;
    const key = decl.slice(0, k).trim().toLowerCase(), v = decl.slice(k + 1).trim();
    if (key === 'font-size') { const m = /([\d.]+)\s*(pt|px)?/.exec(v); if (m) o.size = Number(m[1]) * (m[2] === 'px' ? 0.75 : 1); }
    else if (key === 'font-weight') o.bold = /bold|[6-9]00/i.test(v);
    else if (key === 'font-style') o.italic = /italic|oblique/i.test(v);
    else if (key === 'color') { const c = cssColor(v); if (c) o.color = c; }
    else if (key === 'text-decoration') o.underline = /underline/i.test(v);
    else if (key === 'font-family') o.family = cssFamily(v);
    else if (key === 'font') {
      const m = /([\d.]+)\s*pt/.exec(v);
      if (m) o.size = Number(m[1]);
      if (/bold/i.test(v)) o.bold = true;
      if (/italic|oblique/i.test(v)) o.italic = true;
      o.family = cssFamily(v.replace(/[\d.]+\s*pt/, ''));
    }
  }
  return o;
}

/**
 * Another program's rich text (/RC) as runs against `base` (its look as worked out by the engine).
 * null: nothing usable, or all one style.
 */
export function fromRC(rc: string, base: BaseStyle): TextRun[] | null {
  const body = /<body[\s\S]*$/i.exec(rc)?.[0];
  if (!body) return null;
  const root: Css = {};
  const stack: { tag: string; css: Css }[] = [{ tag: '#', css: root }];
  const paras: { t: string; st: Css }[][] = [];
  let cur: { t: string; st: Css }[] | null = null;
  const endPara = () => { if (cur) { while (cur.length && cur[cur.length - 1].t.endsWith('\n')) { const l = cur[cur.length - 1]; l.t = l.t.slice(0, -1); if (!l.t) cur.pop(); else break; } paras.push(cur); cur = null; } };
  const re = /<(\/?)([a-z][\w:]*)([^>]*?)(\/?)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[5] !== undefined) {
      const t = unent(m[5]).replace(/\r\n?/g, '\n');
      if (!t) continue;
      // (white space between tags outside a paragraph: layout of the XML, not text)
      if (!cur && !t.trim()) continue;
      cur ??= [];
      cur.push({ t, st: stack[stack.length - 1].css });
      continue;
    }
    const close = m[1] === '/', tag = m[2].toLowerCase(), self = m[4] === '/';
    const block = tag === 'p' || tag === 'div' || tag === 'body';
    if (close) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      if (block) endPara();
      continue;
    }
    if (tag === 'br') { cur ??= []; cur.push({ t: '\n', st: stack[stack.length - 1].css }); continue; }
    if (block) endPara();
    let st = stack[stack.length - 1].css;
    if (tag === 'b' || tag === 'strong') st = { ...st, bold: true };
    else if (tag === 'i' || tag === 'em') st = { ...st, italic: true };
    else if (tag === 'u') st = { ...st, underline: true };
    const sm = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[3]);
    if (sm) st = readCss(unent(sm[2] ?? sm[3] ?? ''), st);
    if (!self) stack.push({ tag, css: st });
    // (a paragraph starts one; text straight in the body starts one when it comes)
    if (block && tag !== 'body') cur = [];
  }
  endPara();
  if (!paras.length) return null;
  const runs: TextRun[] = [];
  paras.forEach((p, i) => {
    if (i > 0) runs.push({ t: '\n', ...(runs.length ? styleOf(runs[runs.length - 1]) : {}) });
    for (const { t, st } of p) {
      const r: TextRun = { t };
      if (st.bold !== undefined) r.b = st.bold;
      if (st.italic !== undefined) r.i = st.italic;
      if (st.underline) r.u = true;
      if (st.color) r.c = st.color;
      if (st.size) r.s = Math.max(1, Math.min(400, st.size));
      if (st.family) r.f = st.family;
      runs.push(r);
    }
  });
  // (null too when it is all one style: the box's own look covers it)
  return settle(base, runs, false).runs ?? null;
}

/** runs read from a file or sent in: only well-formed values kept (anything else: the box's own) */
export function cleanRuns(v: unknown): TextRun[] {
  if (!Array.isArray(v)) return [];
  const out: TextRun[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object' || typeof (x as TextRun).t !== 'string') continue;
    const r = x as Record<string, unknown>, o: TextRun = { t: r.t as string };
    for (const k of ['b', 'i', 'u'] as const) if (typeof r[k] === 'boolean') o[k] = r[k] as boolean;
    if (Array.isArray(r.c) && r.c.length === 3 && r.c.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) o.c = (r.c as number[]).slice();
    if (typeof r.s === 'number' && r.s >= 1 && r.s <= 400) o.s = r.s;
    if (typeof r.f === 'string' && r.f && r.f.length < 100) o.f = r.f;
    out.push(o);
  }
  return joinRuns(out);
}
