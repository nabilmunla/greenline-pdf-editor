// Text layout with real fonts: Arabic joined and right-to-left, mixed with English and numbers
// (Unicode bidi), any typeface. HarfBuzz shapes, bidi-js orders, lines wrap at spaces.
// Positions are in em (font size 1); the caller scales.
import * as hb from 'harfbuzzjs';
import bidiFactory from 'bidi-js';
import type { FontRef } from './fonts';

const bidi = bidiFactory();

/** u: the text this glyph stands for (a ligature: several letters; a mark split off: '') */
export interface Glyph { f: FontRef; gid: number; x: number; dx: number; dy: number; adv: number; u: string; rtl: boolean }
export interface Line { glyphs: Glyph[]; width: number; text: string; rtl: boolean }

const isSpace = (c: string) => c === ' ' || c === '\t' || c === ' ';
const MARK = /\p{M}/u;
/** strong right-to-left text anywhere (Arabic, Hebrew, ...) */
export const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;

/** which font draws each UTF-16 position: the first in the stack that has the character */
function fontsFor(text: string, s: number, e: number, stack: FontRef[]): FontRef[] {
  const out: FontRef[] = new Array(e - s);
  let prev: FontRef | null = null;
  for (let i = s; i < e; i++) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    let f: FontRef;
    // marks stay with their letter; spaces and punctuation with the text around them
    if (prev && (MARK.test(ch) || isSpace(ch) || cp === 0x200c || cp === 0x200d)) f = prev;
    else f = stack.find((x) => x.has(cp)) || stack[0];
    out[i - s] = f;
    if (cp > 0xffff) { out[i - s + 1] = f; i++; }
    prev = f;
  }
  return out;
}

interface Run { s: number; e: number; level: number; f: FontRef }

/** glyphs of text[s..e) in visual order, x from 0 (spaces at its end left off, unless kept) */
function shapeRange(text: string, levels: Uint8Array, s: number, e: number, stack: FontRef[], keepSpaces = false): { glyphs: Glyph[]; width: number } {
  if (!keepSpaces) while (e > s && isSpace(text[e - 1])) e--;
  if (e <= s) return { glyphs: [], width: 0 };
  const fonts = fontsFor(text, s, e, stack);
  const runs: Run[] = [];
  for (let i = s; i < e; i++) {
    const lv = levels[i], f = fonts[i - s];
    const last = runs[runs.length - 1];
    if (last && last.level === lv && last.f === f) last.e = i + 1;
    else runs.push({ s: i, e: i + 1, level: lv, f });
  }
  // visual order of the runs (bidi rule L2): from the highest level down to the lowest odd one,
  // reverse every stretch of runs at that level or above
  const maxL = Math.max(...runs.map((r) => r.level));
  const minOdd = Math.min(...runs.map((r) => r.level).filter((l) => l % 2 === 1), maxL + 1);
  for (let lv = maxL; lv >= minOdd && lv > 0; lv--) {
    for (let i = 0; i < runs.length;) {
      if (runs[i].level >= lv) {
        let j = i;
        while (j < runs.length && runs[j].level >= lv) j++;
        runs.splice(i, j - i, ...runs.slice(i, j).reverse());
        i = j;
      } else i++;
    }
  }
  const glyphs: Glyph[] = [];
  let x = 0;
  for (const r of runs) {
    const buf = new hb.Buffer();
    buf.addText(text, r.s, r.e - r.s);
    buf.guessSegmentProperties();
    buf.setDirection(r.level % 2 ? hb.Direction.RTL : hb.Direction.LTR);
    hb.shape(r.f.hb, buf);
    const inf = buf.getGlyphInfos();
    const pos = buf.getGlyphPositions();
    const k = 1 / r.f.upem;
    // the letters behind each glyph: its cluster up to the next cluster (first glyph of a cluster)
    const cls = [...new Set(inf.map((g) => g.cluster))].sort((p, q) => p - q);
    const seen = new Set<number>();
    for (let i = 0; i < inf.length; i++) {
      const p = pos[i];
      const c = inf[i].cluster;
      let u = '';
      if (!seen.has(c)) { seen.add(c); const nx = cls[cls.indexOf(c) + 1]; u = text.slice(c, nx === undefined ? r.e : nx); }
      glyphs.push({ f: r.f, gid: inf[i].codepoint, x, dx: p.xOffset * k, dy: p.yOffset * k, adv: p.xAdvance * k, u, rtl: r.level % 2 === 1 });
      x += p.xAdvance * k;
    }
  }
  return { glyphs, width: x };
}

/** the bidi levels of a paragraph, and whether it runs right to left (its first letter) */
export function paraLevels(text: string): { levels: Uint8Array; rtl: boolean } {
  const emb = bidi.getEmbeddingLevels(text);
  return { levels: emb.levels, rtl: (emb.paragraphs[0]?.level ?? 0) % 2 === 1 };
}

/** a piece of a paragraph in one style, shaped as it is (rich text: a line is several pieces) */
export function shapePiece(text: string, levels: Uint8Array, s: number, e: number, stack: FontRef[]): { glyphs: Glyph[]; width: number } {
  return shapeRange(text, levels, s, e, stack, true);
}

/** width in em of one line of text (no wrapping) */
export function measureLine(text: string, stack: FontRef[]): number {
  if (!text) return 0;
  const lv = bidi.getEmbeddingLevels(text);
  return shapeRange(text, lv.levels, 0, text.length, stack).width;
}

/**
 * Lines of `text` wrapped to `avail` em (Infinity: only at line breaks). Each paragraph takes its
 * direction from its first letter (Arabic: right to left).
 */
export function layoutText(text: string, avail: number, stack: FontRef[]): Line[] {
  const out: Line[] = [];
  for (const para of text.split(/\r\n|\r|\n/)) {
    if (!para) { out.push({ glyphs: [], width: 0, text: '', rtl: out.length ? out[out.length - 1].rtl : false }); continue; }
    const emb = bidi.getEmbeddingLevels(para);
    const rtl = (emb.paragraphs[0]?.level ?? 0) % 2 === 1;
    const width = (s: number, e: number) => shapeRange(para, emb.levels, s, e, stack).width;
    let start = 0;
    while (start < para.length) {
      // skip spaces at the start of a wrapped line
      if (start > 0) while (start < para.length && isSpace(para[start])) start++;
      if (start >= para.length) break;
      let end = para.length;
      if (avail !== Infinity && width(start, end) > avail) {
        // the furthest break (after a space) that still fits
        let best = -1;
        for (let i = start + 1; i < para.length; i++) {
          if (isSpace(para[i - 1]) && !isSpace(para[i])) {
            if (width(start, i) <= avail) best = i; else break;
          }
        }
        if (best > start) end = best;
        else {
          // one word longer than the line: as many letters as fit (at least one) - broken only
          // between whole letters: a letter keeps its marks (harakat, accents), a surrogate pair or
          // an emoji stays one (a haraka starting the next line was drawn on its own)
          const ends = letterEnds(para, start);
          end = ends[0] ?? para.length;
          for (const i of ends) { if (width(start, i) <= avail) end = i; else break; }
        }
      }
      const sh = shapeRange(para, emb.levels, start, end, stack);
      out.push({ glyphs: sh.glyphs, width: sh.width, text: para.slice(start, end).trimEnd(), rtl });
      start = end;
    }
  }
  return out;
}

/**
 * A word of a right-to-left line in the order it is seen, left to right (Unicode bidi, the line
 * right to left): its letters run backwards, numbers and Latin inside it keep their own order -
 * "٢٠٢٤" stays "٢٠٢٤" (reversing the whole word stored it as "٤٢٠٢": copied and searched wrong).
 */
export function visualOrder(text: string): string {
  const lv = bidi.getEmbeddingLevels(text, 'rtl');
  const chars = text.split('');
  for (const [s, e] of bidi.getReorderSegments(text, lv)) {
    const part = chars.slice(s, e + 1).reverse();
    for (let i = 0; i < part.length; i++) chars[s + i] = part[i];
  }
  // (a surrogate pair reversed with the letters is put back the right way round)
  return chars.join('').replace(/([\udc00-\udfff])([\ud800-\udbff])/g, '$2$1');
}

/** where each whole letter (grapheme: a letter with its marks) after `start` ends, in order */
let graphemes: Intl.Segmenter | null | undefined;
function letterEnds(text: string, start: number): number[] {
  if (graphemes === undefined) { try { graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch { graphemes = null; } }
  const out: number[] = [];
  if (graphemes) {
    for (const s of graphemes.segment(text)) { const e = s.index + s.segment.length; if (e > start) out.push(e); }
    return out;
  }
  // (no segmenter: code points, marks and joiners kept with the letter before)
  for (let i = start; i < text.length;) {
    i += text.codePointAt(i)! > 0xffff ? 2 : 1;
    while (i < text.length && (MARK.test(text[i]) || text[i] === '\u200d')) i++;
    out.push(i);
  }
  return out;
}

function hex4(n: number): string { return n.toString(16).padStart(4, '0'); }
const f3 = (v: number) => +v.toFixed(3);

/**
 * Content-stream operators that draw one line: glyph runs per font, positioned exactly as shaped.
 * `name(f)` gives the resource name of a font; (x, y) is the left end of the baseline; the text
 * space is upright (y up).
 */
export function lineOps(line: Line, x: number, y: number, size: number, name: (f: FontRef) => string): string[] {
  if (!line.glyphs.length) return [];
  const ops: string[] = [];
  let cur: FontRef | null = null;
  const g = line.glyphs;
  let i = 0;
  while (i < g.length) {
    // a run: same font, same direction, no vertical offset (marks with an offset stand alone)
    let j = i + 1;
    if (g[i].dy === 0) while (j < g.length && g[j].f === g[i].f && g[j].rtl === g[i].rtl && g[j].dy === 0) j++;
    const run = g.slice(i, j);
    if (run[0].f !== cur) { cur = run[0].f; ops.push(`/${name(cur)} ${f3(size)} Tf`); }
    const at = (gl: Glyph) => x + (gl.x + gl.dx) * size;
    const parts: string[] = [];
    let pen = 0;
    run.forEach((gl, k) => {
      if (k > 0) {
        // TJ numbers move the pen left (thousandths of the font size)
        const adj = ((pen - at(gl)) / size) * 1000;
        if (Math.abs(adj) > 0.05) parts.push(String(f3(adj)));
      }
      parts.push(`<${hex4(gl.gid)}>`);
      pen = at(gl) + cur!.mu.advanceGlyph(gl.gid) * size;
    });
    // right to left: drawn left to right, marked as reversed - text extraction and search then
    // read the words the right way round (as PDF programs expect it, PDF 1.4 "ReversedChars")
    const show = `1 0 0 1 ${f3(at(run[0]))} ${f3(y + run[0].dy * size)} Tm [${parts.join('')}] TJ`;
    ops.push(run[0].rtl ? `/ReversedChars BMC ${show} EMC` : show);
    i = j;
  }
  // (no ActualText for the whole line: PDFium then reads it twice)
  return ops;
}

/** a ToUnicode CMap: glyph id -> the letters it stands for (copy / search give real letters) */
export function toUnicodeCMap(map: Map<number, string>): string {
  const entries = [...map.entries()].filter(([, u]) => u).sort((a, b) => a[0] - b[0]);
  const out = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap', '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def', '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def', '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange'];
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    out.push(`${part.length} beginbfchar`);
    for (const [g, u] of part) { let h = ''; for (let k = 0; k < u.length; k++) h += hex4(u.charCodeAt(k)); out.push(`<${hex4(g)}> <${h}>`); }
    out.push('endbfchar');
  }
  out.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return out.join('\n');
}
