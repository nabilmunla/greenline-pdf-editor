// Sheet-number helpers: the drawing number in a file name, with and without revision / status
// codes, and the title-strip geometry of a sheet. Pure (no I/O), unit-tested in tests/sheetno.test.ts.
// Ported unchanged from Rev Radar 0.4.5 src/ui/pairing.ts / titleblock.ts (the examples in the
// comments and tests are invented numbers).

const stripExt = (s: string) => s.replace(/\.pdf$/i, '');

/**
 * Revision marks at the end of a name: "Rev B", "REV.03", "_R2", "(1)", "- Copy". Each needs a
 * separator in front, and a bare R needs digits ("Tower A", "Floor 2", "Interior" stay whole).
 */
const REV_TAIL = /([\s_\-.(]+(rev(ision)?[\s_\-.]*[a-z]?\d{0,3}[a-z]?|r\d{1,3}[a-z]?)\)?)$|([\s_-]*\(\d+\))$|([\s_-]*-?\s*copy)$/i;

export function normName(name: string): string {
  let s = stripExt(name).toUpperCase().trim();
  for (let k = 0; k < 3; k++) {
    const m = REV_TAIL.exec(s);
    const t = s.replace(REV_TAIL, '').trim();
    // (a bare "R1" with no other number in the name is the sheet's own code - a roof level - not
    //  a revision: "PRJ-AR-GA-R1" and "-R2" are two sheets)
    if (t === s || t.length < 3 || (m && /^[\s_\-.(]+R\d/i.test(m[0]) && !/\d/.test(t))) break;
    s = t;
  }
  return s.replace(/[\s_\-.,()[\]]+/g, ' ').trim();
}

/**
 * The drawing number in a name: the longest run of parts joined by - _ . that ends with a
 * part holding digits ("PRJ-AB1-DWG-AR-10140 - GA L04" -> "PRJ-AB1-DWG-AR-10140").
 */
const DATE_RUN = /^(\d{4}[-_.]\d{1,2}[-_.]\d{1,2}|\d{1,2}[-_.]\d{1,2}[-_.]\d{2,4})$/;
export function drawingNo(name: string, asWritten = false): string {
  const raw = stripExt(name), s = raw.toUpperCase();
  let best = '', bestRaw = '';
  for (const m of s.matchAll(/[A-Z0-9]+(?:[-_.][A-Z0-9]+)+/g)) {
    const r = m[0];
    if (DATE_RUN.test(r)) continue; // an issue date in the name is not the sheet's number
    let parts = r.split(/[-_.]/), skip = 0;
    // (an issue date in front, "20261001_A-101": not part of the number)
    if (parts.length > 2 && /^(19|20)\d\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(parts[0]) && parts.slice(1).some((q) => /\d/.test(q))) { skip = parts[0].length + 1; parts = parts.slice(1); }
    let end = -1;
    for (let i = parts.length - 1; i >= 0; i--) if (/\d/.test(parts[i]) && !/^(REV|R)\d*$/.test(parts[i])) { end = i; break; }
    if (end < 0) continue;
    const key = parts.slice(0, end + 1).join('-');
    if (key.replace(/-/g, '').length > best.replace(/-/g, '').length) {
      best = key;
      // (as written: "P111.1-AB7-DWG-AR-100101", not the "P111-1-..." the pairing compares)
      const len = parts.slice(0, end + 1).reduce((t, q) => t + q.length, 0) + end;
      bestRaw = raw.length === s.length ? raw.substr(m.index! + skip, len) : key;
    }
  }
  // (no run: a short code - "A101" anywhere, "AR 101" only at the start: "PART 01", "LEVEL 02",
  //  "SECTION 10" are counters, not sheet numbers)
  if (!best) { const m = s.match(/^[A-Z]{1,4}\s?\d{2,5}[A-Z]?\b/) || s.match(/\b[A-Z]{1,4}\d{2,5}[A-Z]?\b/); best = bestRaw = m ? m[0].replace(/\s/g, '') : ''; }
  return asWritten ? bestRaw : best;
}

/**
 * The drawing number without last parts that are revision / status codes (P02, C03, T1, S2-P03,
 * "A101_C02"); level and zone codes stay (L01, B2, R1, GF are different sheets).
 */
const REV_CODE = /^(P|C|T|D|S|IFC|IFT|IFA|REV)\d{1,2}[A-Z]?$/;
export function drawingNoBare(key: string): string {
  const parts = key.split('-');
  let n = parts.length;
  for (let k = 0; k < 2 && n >= 2 && REV_CODE.test(parts[n - 1]) && parts.slice(0, n - 1).some((p) => /\d/.test(p)); k++) n--;
  return parts.slice(0, n).join('-');
}

/** the drawing number with leading zeros dropped ("AR-0101" / "AR-101", "GA-L01" / "GA-L1") */
export function noZeros(key: string): string {
  return key ? key.split('-').map((p) => p.replace(/^([A-Z]*)0+(?=\d)/, '$1')).join('-') : '';
}

/** the drawing number as written in the name, without a revision / status code after it
 *  ("PRJ-AR-GA-01005_C02" -> "PRJ-AR-GA-01005", "P111.1-AB7-DWG-AR-100101" as it is) */
export function sheetNo(name: string): string {
  const w = drawingNo(name, true), d = drawingNo(name), bare = drawingNoBare(d);
  if (!w || bare === d) return w;
  // (the first parts, as many as the bare number has, with their separators as written)
  const n = bare.split('-').length;
  let out = '', k = 0;
  for (const m of w.matchAll(/[^-_.]+|[-_.]/g)) {
    if (/^[-_.]$/.test(m[0])) { if (k >= n) break; out += m[0]; } else { if (k >= n) break; out += m[0]; k++; }
  }
  return out.replace(/[-_.]+$/, '') || w;
}

/** what is left of a file name for a title once the number is taken: nothing if that is only a
 *  revision mark, a copy number, a date or punctuation ("(1)", "2026-10-28", "RevB", "_C02") */
export function cleanTitle(t: string): string {
  let s = t.trim();
  for (let k = 0; k < 3; k++) {
    const u = s.replace(/^[\s_\-.]*(rev(ision)?[\s_\-.]*[a-z]?\d{0,3}[a-z]?|\(\d+\)|copy|[pctds]\d{1,2}[a-z]?|\d{4}[-_.]?\d{2}[-_.]?\d{2}|\d{1,2}[-_.]\d{1,2}[-_.]\d{2,4})(?=$|[\s_\-.(])/i, '')
      .replace(/[\s_\-.(]+(rev(ision)?[\s_\-.]*[a-z]?\d{0,3}[a-z]?|\(\d+\)|copy|\d{4}[-_.]?\d{2}[-_.]?\d{2})\)?$/i, '').trim();
    if (u === s) break;
    s = u;
  }
  // (a letter of any script - Arabic, Cyrillic, Greek, CJK titles were erased by an ASCII-only test,
  //  RR-033; only numbers / marks / punctuation are not a title)
  return /\p{L}/u.test(s) ? s.replace(/^[\s_\-.]+|[\s_\-.]+$/g, '') : '';
}

const MM_ = 72 / 25.4;
/**
 * Where title strips start: the right fifth / bottom 15 % of the sheet, but at least 120 / 60 mm
 * of paper (a title block keeps its real size: on an A3 it takes far more of the sheet than on an A0)
 */
export const rightStrip = (w: number) => w - Math.max(0.2 * w, 120 * MM_);
export const bottomStrip = (h: number) => h - Math.max(0.15 * h, 60 * MM_);

export const sizeKey = (s: { w: number; h: number }) => `${Math.round(s.w / 10) * 10}x${Math.round(s.h / 10) * 10}`;

/**
 * The strip along the sheet edge where title blocks sit (right fifth, bottom 15% - at least 120 / 60
 * mm of paper - and the outer margin).
 * Kept narrow: a notes column or key plan that changed on most sheets is a real change.
 */
export function inTitleBand(b: number[], w: number, h: number): boolean {
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  return cx > rightStrip(w) || cy > bottomStrip(h) || cx < w * 0.035 || cy < h * 0.035;
}
