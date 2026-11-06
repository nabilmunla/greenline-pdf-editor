// Turn the text in an area into a table: words -> rows (by baseline) -> columns (by
// the vertical gaps that no word crosses). Works on PDF text and on OCR words alike.
import type { XCell, XStyle } from './xlsxwrite';

export interface WordBox { text: string; box: number[] }

/** characters (from the PDF) into words */
export function charsToWords(chars: { c: string; b: number[] }[]): WordBox[] {
  const words: WordBox[] = [];
  let cur: WordBox | null = null;
  for (const ch of chars) {
    if (/\s/.test(ch.c)) { cur = null; continue; }
    const h = ch.b[3] - ch.b[1];
    if (cur) {
      const sameLine = Math.abs((cur.box[1] + cur.box[3]) / 2 - (ch.b[1] + ch.b[3]) / 2) < h * 0.5;
      const gap = ch.b[0] - cur.box[2];
      if (sameLine && gap < h * 0.35 && gap > -h) {
        cur.text += ch.c;
        cur.box = [Math.min(cur.box[0], ch.b[0]), Math.min(cur.box[1], ch.b[1]), Math.max(cur.box[2], ch.b[2]), Math.max(cur.box[3], ch.b[3])];
        continue;
      }
    }
    cur = { text: ch.c, box: ch.b.slice() };
    words.push(cur);
  }
  return words;
}

export function wordsToTable(words: WordBox[]): string[][] {
  if (!words.length) return [];
  const hs = words.map((w) => w.box[3] - w.box[1]).sort((a, b) => a - b);
  const mh = hs[Math.floor(hs.length / 2)] || 8;
  // rows: cluster by vertical centre
  const sorted = words.slice().sort((a, b) => (a.box[1] + a.box[3]) - (b.box[1] + b.box[3]));
  const rows: WordBox[][] = [];
  let rc = -Infinity;
  for (const w of sorted) {
    const c = (w.box[1] + w.box[3]) / 2;
    if (rows.length && c - rc < mh * 0.55) { rows[rows.length - 1].push(w); rc = (rc * (rows[rows.length - 1].length - 1) + c) / rows[rows.length - 1].length; }
    else { rows.push([w]); rc = c; }
  }
  // merge words of a row that sit close together into phrases (cells)
  const cells = rows.map((r) => {
    r.sort((a, b) => a.box[0] - b.box[0]);
    const out: WordBox[] = [];
    for (const w of r) {
      const last = out[out.length - 1];
      if (last && w.box[0] - last.box[2] < mh * 0.9) { last.text += ' ' + w.text; last.box = [last.box[0], Math.min(last.box[1], w.box[1]), w.box[2], Math.max(last.box[3], w.box[3])]; }
      else out.push({ text: w.text, box: w.box.slice() });
    }
    return out;
  });
  // columns: x ranges covered by cells; gaps between them split columns.
  // A cell that runs right across the gap between two cells of another row - a title over the
  // whole table, a merged header over several columns, a long line running into the next
  // column - would join those columns into one (every row then came out as a single glued
  // cell). Such cells are left out when finding the columns, and go into the first column
  // they cover.
  const tol = mh * 0.3;
  const gaps: [number, number][] = [];
  for (const r of cells) for (let k = 1; k < r.length; k++) gaps.push([r[k - 1].box[2], r[k].box[0]]);
  const across = new Set(cells.flat().filter((c) => gaps.some(([l, g]) => c.box[0] <= l + tol && c.box[2] >= g - tol)));
  // (every cell runs across some gap: no way to tell - all of them count, as before)
  const forCols = cells.flat().filter((c) => !across.has(c));
  const spans = (forCols.length ? forCols : cells.flat()).map((c) => [c.box[0], c.box[2]]).sort((a, b) => a[0] - b[0]);
  const cols: number[][] = [];
  for (const s of spans) {
    const last = cols[cols.length - 1];
    if (last && s[0] <= last[1] + tol) last[1] = Math.max(last[1], s[1]);
    else cols.push([s[0], s[1]]);
  }
  const colOf = (c: WordBox) => {
    if (forCols.length && across.has(c)) { const i = cols.findIndex((k) => k[1] >= c.box[0] - tol); return i < 0 ? cols.length - 1 : i; }
    const mid = (c.box[0] + c.box[2]) / 2;
    let best = 0, bd = Infinity;
    cols.forEach((k, i) => { const d = mid < k[0] ? k[0] - mid : mid > k[1] ? mid - k[1] : 0; if (d < bd) { bd = d; best = i; } });
    return best;
  };
  return cells.map((r) => {
    const row = new Array(cols.length).fill('');
    for (const c of r) { const i = colOf(c); row[i] = row[i] ? row[i] + ' ' + c.text : c.text; }
    return row;
  });
}

/**
 * A cell Excel would take as a formula when it is pasted in (= + - @ first): text read from a
 * PDF could run something there (=HYPERLINK, =WEBSERVICE). Plain numbers (-5, +12.5) are fine.
 */
export const formulaLike = (c: string) => /^[=+\-@]/.test(c.trim()) && !/^[-+]?\d[\d,]*(\.\d+)?%?$/.test(c.trim());
// (pasted as text: a leading ' keeps the cell as text; in the HTML copy Excel is told the cell
// is text, so it shows exactly what was read)
export const toTsv = (t: string[][]) => t.map((r) => r.map((c) => { const x = c.replace(/\t|\r|\n/g, ' '); return formulaLike(x) ? "'" + x : x; }).join('\t')).join('\r\n');
export const toHtml = (t: string[][]) => '<table>' + t.map((r) => '<tr>' + r.map((c) => (formulaLike(c) ? '<td style="mso-number-format:\'\\@\'">' : '<td>') + c.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</td>').join('') + '</tr>').join('') + '</table>';

/**
 * Numbers like 1,234.50 become real numbers for Excel. Codes stay text, exactly as read: a
 * leading zero ("007", "0123"), commas that are not thousands ("1,2,3"), more digits than Excel
 * keeps (15 - a 19-digit reference would be rounded).
 */
export function cellValue(s: string): string | number {
  const t = s.trim();
  const m = /^-?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/.exec(t);
  if (!m) return s;
  if (m[1].length > 1 && m[1][0] === '0') return s;
  if (t.replace(/[-,.]/g, '').replace(/^0+/, '').length > 15) return s;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : s;
}

/** the same as an Excel cell: a number keeps the look it had ("12.50", "1.10", "1,250") */
export function excelCell(s: string): XCell {
  const v = cellValue(s);
  if (typeof v !== 'number') return v;
  const dec = /\.(\d+)$/.exec(s.trim())?.[1].length ?? 0;
  const st: XStyle | undefined = dec === 2 ? 'n2' : dec === 3 ? 'n3' : dec === 0 && s.includes(',') ? 'n0' : undefined;
  return st ? { v, s: st } : v;
}
