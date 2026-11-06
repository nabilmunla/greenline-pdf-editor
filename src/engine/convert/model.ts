// Document export (PDF -> Word / Excel): what a page is turned into before any layout is
// decided. Page points, origin top left, y down (MuPDF's structured-text space).

export type Box = [number, number, number, number];

export interface FontInfo {
  /** the name a Windows PC knows ("Arial", "Times New Roman") */
  family: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
}

export interface Glyph {
  c: string;
  x0: number; y0: number; x1: number; y1: number;
  /** baseline */
  base: number;
  size: number;
  /** index into the session's font list */
  f: number;
  /** 0xRRGGBB */
  color: number;
  rtl: boolean;
  /** raised (1) / lowered (-1) against its line */
  va?: number;
  ul?: boolean;
  st?: boolean;
  bold?: boolean;
}

export interface Word {
  text: string;
  x0: number; y0: number; x1: number; y1: number;
  base: number;
  size: number;
  g: Glyph[];
  rtl: boolean;
  /** OCR confidence (scans) */
  conf?: number;
  /** a run of dots (leader) */
  leader?: boolean;
  /** turned text (vertical): 1 = reads downwards, 3 = upwards */
  turn?: number;
}

export interface Ruling {
  o: 'h' | 'v';
  /** y of a horizontal line, x of a vertical one */
  c: number;
  /** extent along the line */
  a: number; b: number;
  /** thickness */
  w: number;
  color: number;
  /** used up as an underline / strike-through */
  used?: boolean;
}

export interface Fill { box: Box; color: number }

export interface Pic {
  box: Box;
  /** PNG or JPEG bytes (Word only) */
  data?: Uint8Array;
  ext?: 'png' | 'jpeg';
  /** covers (nearly) the whole page: a scan */
  full?: boolean;
}

export type PageKind = 'text' | 'scan' | 'drawing' | 'empty';

export interface PageModel {
  i: number;
  w: number; h: number;
  kind: PageKind;
  words: Word[];
  rulings: Ruling[];
  fills: Fill[];
  pics: Pic[];
  /** other vector shapes (logos, charts, drawing linework): their boxes */
  shapes: Box[];
  links: { box: Box; uri: string }[];
  /** text came from OCR (or a scan's invisible text layer) */
  ocr: boolean;
  /** body font size guess of the page (most common) */
  bodySize: number;
  /** picture of the whole page (drawings / scans not read): PNG */
  snapshot?: Uint8Array;
  /** the page was printed sideways and is read turned (see readPage): the quarter turns and the
   *  page's size as shown - a box drawn on the page as shown is turned the same way */
  turned?: { turn: 1 | 2 | 3; w: number; h: number };
}

/** options the window passes in */
export interface ExportOpts {
  format: 'docx' | 'xlsx';
  /** Excel: one sheet per page, or tables joined across pages (one sheet per bill/section) */
  sheets?: 'joined' | 'pages';
  /** leave out running headers, footers and page numbers (Excel) */
  dropRunning?: boolean;
  /** scans: leave out stamps and coloured handwriting */
  dropStamps?: boolean;
  /** document title (file name) */
  title?: string;
  /** only this area of one page (a table among the details of a drawing): page index and box in
   *  page points (as shown, top-left origin) */
  region?: { page: number; box: [number, number, number, number] };
}

export const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const quantile = (a: number[], q: number): number => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** smallest / largest of f over a list of any length (Math.min(...xs) stops at ~125,000 items) */
export function minOf<T>(xs: readonly T[], f: (x: T) => number): number { let m = Infinity; for (const x of xs) { const v = f(x); if (v < m) m = v; } return m; }
export function maxOf<T>(xs: readonly T[], f: (x: T) => number): number { let m = -Infinity; for (const x of xs) { const v = f(x); if (v > m) m = v; } return m; }
/** dst.push(...src) for lists of any length */
export function pushAll<T>(dst: T[], src: readonly T[]): T[] { for (const x of src) dst.push(x); return dst; }
