// Text and style of a set of words: joined text, numbers as numbers, the look of a cell.
import type { FontInfo, Word } from './model';
import { readingOrder } from './rows';

const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻' };

/** a word's text with raised digits as superscript characters (m2 -> m²) */
export function plainWord(w: Word): string {
  if (!w.g.some((g) => g.va === 1)) return w.text;
  let s = '';
  // (after a letter - m2, mm4 - or a power of ten: "x 10" with a raised 4 is x 10⁴, not x 104)
  for (const g of w.g) s += g.va === 1 && SUP[g.c] && (/[a-zA-Z)]/.test(s.slice(-1)) || /^(10|[⁰-⁹⁺⁻¹²³]*10[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]*)$/.test(s)) ? SUP[g.c] : g.c;
  return s;
}
/** a word that is only raised digits ("x 10" then a small 4 set apart): goes onto the word before */
const raisedOnly = (w: Word) => w.g.length > 0 && w.g.every((g) => g.va === 1 && !!SUP[g.c]);
/** a line's words as text, raised digits set apart joined on as superscript */
function lineText(ws: Word[]): string {
  let s = '';
  for (const w of ws) {
    if (s && raisedOnly(w) && /(?:^|\s)10$|[a-zA-Z)]$/.test(s)) { for (const g of w.g) s += SUP[g.c]; continue; }
    s += (s ? ' ' : '') + plainWord(w);
  }
  return s;
}

/** lines of words -> text; join: ' ' (one paragraph) or '\n' */
export function linesText(lines: Word[][], join: string): string {
  const parts = lines.map((l) => lineText(readingOrder({ words: l, rtl: l.filter((w) => w.rtl).length > l.length / 2 })).trim()).filter(Boolean);
  if (join === '\n') return parts.join('\n');
  let s = '';
  for (const p of parts) {
    if (!s) { s = p; continue; }
    // "cement-" + "sand": keep the hyphen, no space
    if (/[A-Za-z]-$/.test(s) && /^[a-z]/.test(p)) s += p;
    else s += ' ' + p;
  }
  return s;
}

/** the look most of the text has */
export function lookOf(ws: Word[], fonts: FontInfo[]) {
  let n = 0, b = 0, it = 0, u = 0, st = 0;
  const fam = new Map<string, number>(), size = new Map<number, number>(), col = new Map<number, number>();
  for (const w of ws) for (const g of w.g) {
    if (!g.c.trim()) continue;
    n++;
    const f = fonts[g.f];
    if (g.bold || f?.bold) b++;
    if (f?.italic) it++;
    if (g.ul) u++;
    if (g.st) st++;
    if (f) fam.set(f.family, (fam.get(f.family) ?? 0) + 1);
    if (!g.va) { const k = Math.round(g.size * 2) / 2; size.set(k, (size.get(k) ?? 0) + 1); }
    col.set(g.color, (col.get(g.color) ?? 0) + 1);
  }
  const top = <K,>(m: Map<K, number>, d: K): K => { let best = d, bn = -1; for (const [k, v] of m) if (v > bn) { bn = v; best = k; } return best; };
  return { family: top(fam, 'Arial'), size: top(size, 10), bold: n > 0 && b >= n * 0.6, italic: n > 0 && it >= n * 0.6, ul: n > 0 && u >= n * 0.6, strike: n > 0 && st >= n * 0.6, color: top(col, 0) };
}

const CUR = /^(AED|USD|EUR|GBP|SAR|QAR|OMR|KWD|BHD|Dhs?\.?|Dirhams?|\$|€|£)\s?/i;
/**
 * "1,234.50" -> 1234.5 with the format it was printed in. Brackets and minus signs are negative,
 * "12.5%" is 0.125. Anything else (dates, references, words) -> null.
 */
export function parseNumber(raw: string, decimalComma = false): { v: number; fmt: string } | null {
  let s = raw.trim().replace(/[−–—]/g, '-');
  if (!s || s.length > 24) return null;
  let neg = false, paren = false, pct = false, cur = '';
  if (/^\(.*\)$/.test(s)) { neg = paren = true; s = s.slice(1, -1).trim(); }
  const m = CUR.exec(s);
  if (m) { cur = m[1]; s = s.slice(m[0].length).trim(); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1).trim(); }
  if (s.endsWith('-') && !neg) { neg = true; s = s.slice(0, -1).trim(); }
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim(); }
  // a file that writes decimals with a comma (47,4 - 1.234,56 - 1 234,5): read as such
  if (decimalComma) {
    if (/^\d{1,3}([ \u00a0\u202f.]\d{3})+(,\d+)?$|^\d+(,\d+)?$|^,\d+$/.test(s)) s = s.replace(/[ \u00a0\u202f.]/g, '').replace(',', '.');
    else return null;
  }
  // thousands set apart with spaces: 1 234 567.00
  if (/^\d{1,3}([ \u00a0\u202f]\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/[ \u00a0\u202f]/g, ',');
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$|^\.\d+$/.test(s)) return null;
  // "01", "007": codes, not numbers; nor 16 digits and more (Excel keeps 15: a reference number)
  if (/^0\d/.test(s) || s.replace(/\D/g, '').length > 15) return null;
  const v = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  const dec = (s.split('.')[1] || '').length;
  const thou = s.includes(',') || (v >= 10000 && !pct);
  let fmt = (thou ? '#,##0' : '0') + (dec ? '.' + '0'.repeat(dec) : '');
  if (pct) fmt = '0' + (dec ? '.' + '0'.repeat(dec) : '') + '%';
  if (cur) fmt = `"${cur} "` + fmt;
  if (paren) fmt = fmt + ';(' + fmt + ')';
  const val = (neg ? -v : v) / (pct ? 100 : 1);
  return { v: pct ? Number(val.toPrecision(12)) : val, fmt: fmt === '0' ? 'General' : fmt };
}

/**
 * Does the file write decimals with a comma (47,4 - 9,83 - 1.234,56)? Only when that is clear: a
 * comma followed by 1 or 2 digits again and again (8+ times), no number written the other way (1,234.56 -
 * 12.50), and "1,250"s (thousands, or three decimals - either way) at most half as many.
 * (A comma followed by 4+ digits was evidence too: "2,13400" - an OCR'd 2,134.00 that lost its
 * point - and a schedule's "3,4" references then turned 12,500 into 12.5.)
 */
export function usesDecimalComma(texts: string[]): boolean {
  let comma = 0, dot = 0, either = 0;
  for (const raw of texts) {
    const t = raw.trim();
    if (/^\d+,\d{1,2}$|^\d{1,3}(\.\d{3})+,\d+$/.test(t)) comma++;
    else if (/^\d{1,3}(,\d{3})+\.\d+$|^\d+\.\d{2}$|^\d{1,3}(,\d{3}){2,}$/.test(t)) dot++;
    else if (/^\d{1,3},\d{3}$/.test(t)) either++;
  }
  return comma >= 8 && dot <= comma * 0.05 && either <= comma * 0.5;
}

/** OCR misreads in a number column: O -> 0, l/I -> 1, S -> 5 (only when that makes a number) */
export function fixOcrNumber(s: string, dec2 = false): string {
  if (!/\d/.test(s) || /[a-z]{3,}/i.test(s)) return s;
  let t = s.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1').replace(/S(?=\d)|(?<=\d)S/g, '5').replace(/\s+(?=[\d,.]*$)/g, '');
  // the decimal point is the smallest mark on the page and OCR loses it: in a column printed with
  // two decimals, "2,13400" and "44100" are 2,134.00 and 441.00
  if (dec2 && !t.includes('.')) {
    if (/^\d{1,3}(,\d{3})*,\d{5}$/.test(t) || /^\d{3,}$/.test(t)) t = t.slice(0, -2) + '.' + t.slice(-2);
  }
  return parseNumber(t) ? t : s;
}
