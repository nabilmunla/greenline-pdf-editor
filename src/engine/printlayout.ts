// Where a page goes on the printed sheet - one function used by the print preview (window) and by
// the engine that makes the file sent to the printer, so what you see is what prints.
// All in points; page space = the page as shown (turn and crop applied), origin top-left.

export type R4 = [number, number, number, number];

export interface PrintOpts {
  /** pages to print, in order (zero-based) */
  pages: number[];
  /** only this part of the page (the current view); with one page */
  region?: R4 | null;
  /** sheet size, portrait (w <= h); null = each page on a sheet of its own size */
  paper: { w: number; h: number } | null;
  orient: 'auto' | 'portrait' | 'landscape';
  scale: 'fit' | 'actual' | 'shrink' | 'custom';
  /** custom scale, % */
  pct?: number;
  /** white border kept clear when fitting (printers can't print to the edge) */
  margin: number;
  markups: boolean;
  /** how the sheets go to the printer: as they are (vector), each as one picture, or auto -
   *  pictures only for sheets that are heavy for a printer (big scans, dense line work) */
  send?: 'auto' | 'vector' | 'picture';
  /** printed in black & white: pictures made in grey (a third of the data) */
  gray?: boolean;
}

/** sheets this big or smaller are sent as pictures by "auto" (office printers; bigger sheets
 *  go to plotters, which are better off with the lines themselves) */
export const AUTO_PICTURE_MAX_AREA = 1190.55 * 1683.78 * 1.05; // A2
/** resolution of a sheet sent as a picture (at most PICTURE_MAX_PX pixels, mu.ts) */
export const PICTURE_DPI = 300;

/**
 * Is a page heavy for a printer, printed on a sheet of `sheetIn2` square inches? Printers get
 * what Windows makes of the page: a scan's pictures at full size (a 600 dpi colour scan is
 * ~140 MB a page by then), every line of a drawing one by one. Heavy: pictures finer than
 * ~360 dpi on the sheet, colour pictures printed in black & white (the grey copy is a third),
 * or line work over 3 MB.
 */
export function heavyForPrinter(w: { content: number; imgPx: number; colourPx: number }, sheetIn2: number, gray: boolean): boolean {
  if (w.content > 3e6) return true;
  if (sheetIn2 > 0 && w.imgPx / sheetIn2 > 360 * 360 && w.imgPx > 4e6) return true;
  if (gray && w.colourPx > 4e6) return true;
  return false;
}

export interface SheetLayout {
  /** sheet size */
  W: number; H: number;
  /** page-space scale */
  k: number;
  /** where the printed part's top-left lands on the sheet (top-down) */
  ox: number; oy: number;
  /** the printed part of the page (page space) */
  r: R4;
  /** the margin kept clear, as used (at most a quarter of the paper's short side - the preview's
   *  dashed line is drawn here, not at the margin typed) */
  m: number;
}

export function sheetLayout(pw: number, ph: number, region: R4 | null | undefined, o: Pick<PrintOpts, 'paper' | 'orient' | 'scale' | 'pct' | 'margin'>): SheetLayout {
  const r: R4 = region ? [Math.max(0, region[0]), Math.max(0, region[1]), Math.min(pw, region[2]), Math.min(ph, region[3])] : [0, 0, pw, ph];
  const rw = Math.max(1, r[2] - r[0]), rh = Math.max(1, r[3] - r[1]);
  if (!o.paper) return { W: rw, H: rh, k: 1, ox: 0, oy: 0, r, m: 0 };
  const short = Math.min(o.paper.w, o.paper.h), long = Math.max(o.paper.w, o.paper.h);
  const land = o.orient === 'landscape' || (o.orient === 'auto' && rw > rh);
  const W = land ? long : short, H = land ? short : long;
  const m = Math.max(0, Math.min(o.margin, Math.min(W, H) / 4));
  const fit = Math.min((W - 2 * m) / rw, (H - 2 * m) / rh);
  const k = o.scale === 'fit' ? fit : o.scale === 'shrink' ? Math.min(1, fit) : o.scale === 'custom' ? Math.max(0.01, (o.pct || 100) / 100) : 1;
  return { W, H, k, ox: (W - rw * k) / 2, oy: (H - rh * k) / 2, r, m };
}

/** paper sizes offered (points, portrait) */
export const PAPERS: { name: string; w: number; h: number }[] = [
  { name: 'A4', w: 595.28, h: 841.89 },
  { name: 'A3', w: 841.89, h: 1190.55 },
  { name: 'A2', w: 1190.55, h: 1683.78 },
  { name: 'A1', w: 1683.78, h: 2383.94 },
  { name: 'A0', w: 2383.94, h: 3370.39 },
  { name: 'A5', w: 419.53, h: 595.28 },
  { name: 'Letter', w: 612, h: 792 },
  { name: 'Legal', w: 612, h: 1008 },
  { name: 'Tabloid / Ledger', w: 792, h: 1224 },
];

/** the standard paper a page is (within 3 %), e.g. "A1" */
export function paperName(w: number, h: number): string | null {
  const s = Math.min(w, h), l = Math.max(w, h);
  for (const p of PAPERS) if (Math.abs(p.w - s) / p.w < 0.03 && Math.abs(p.h - l) / p.h < 0.03) return p.name;
  return null;
}
