// Document export jobs in the engine: open the file, read the pages one by one (scans get
// their words from the window's OCR), then write the Word or Excel file.
import * as mupdf from 'mupdf';
import type { ExportOpts, PageModel } from './model';
import { FontTable, readPage } from './extract';
import { analyzePage, dropStampText, markRunning, type PageLayout } from './analyze';
import { toExcel } from './toExcel';
import { toWord } from './toWord';
import { ocrPage, type OcrIn } from './scan';

export class ExportJob {
  fonts = new FontTable();
  pages: PageModel[] = [];
  constructor(public doc: mupdf.Document, public opts: ExportOpts, public release?: () => void) {}
  count() { return this.doc.countPages(); }
  /** read page i; scans come back as kind 'scan' with no words (unless they carry a text layer) */
  read(i: number) {
    const pm = readPage(this.doc, i, this.fonts, { pictures: this.opts.format === 'docx', dpi: 200, region: this.opts.region?.page === i ? this.opts.region.box : undefined });
    this.clip(pm);
    this.pages[i] = pm;
    return { kind: pm.kind, words: pm.words.length, w: pm.w, h: pm.h };
  }
  /** a scan's words from OCR (page points) and the turn Tesseract straightened it by */
  addOcr(i: number, ocr: OcrIn) {
    const pm = this.pages[i] ?? readPage(this.doc, i, this.fonts, { pictures: false, dpi: 150 });
    this.pages[i] = ocrPage(this.doc, pm, ocr, this.fonts, this.opts);
    this.clip(this.pages[i]);
    return { words: this.pages[i].words.length };
  }
  /** only the area asked for (see ExportOpts.region): what lies outside it goes */
  private clip(pm: PageModel) {
    const r = this.opts.region;
    if (!r || r.page !== pm.i) return;
    let [X0, Y0, X1, Y1] = r.box;
    // (a page read turned: the box as drawn on the page as shown, turned with it)
    const tn = pm.turned;
    if (tn) {
      const T = tn.turn === 1 ? (x: number, y: number) => [y, tn.w - x] : tn.turn === 3 ? (x: number, y: number) => [tn.h - y, x] : (x: number, y: number) => [tn.w - x, tn.h - y];
      const [a, b] = T(X0, Y0), [c, d] = T(X1, Y1);
      [X0, Y0, X1, Y1] = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    }
    const mid = (b: { x0: number; y0: number; x1: number; y1: number }) => { const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2; return cx >= X0 && cx <= X1 && cy >= Y0 && cy <= Y1; };
    const cut = (b: number[]): [number, number, number, number] | null => { const c: [number, number, number, number] = [Math.max(b[0], X0), Math.max(b[1], Y0), Math.min(b[2], X1), Math.min(b[3], Y1)]; return c[2] - c[0] > 0.5 && c[3] - c[1] > 0.5 ? c : null; };
    pm.words = pm.words.filter(mid);
    pm.rulings = pm.rulings.flatMap((l) => {
      const [lo, hi, a0, a1] = l.o === 'h' ? [Y0, Y1, X0, X1] : [X0, X1, Y0, Y1];
      if (l.c < lo - 1 || l.c > hi + 1) return [];
      const a = Math.max(l.a, a0), b = Math.min(l.b, a1);
      return b - a >= 2 ? [{ ...l, a, b }] : [];
    });
    pm.fills = pm.fills.flatMap((f) => { const c = cut(f.box); return c ? [{ ...f, box: c }] : []; });
    pm.pics = pm.pics.filter((p) => mid({ x0: p.box[0], y0: p.box[1], x1: p.box[2], y1: p.box[3] }));
    pm.shapes = pm.shapes.flatMap((b) => { const c = cut(b); return c ? [c] : []; });
    pm.links = pm.links.filter((l) => mid({ x0: l.box[0], y0: l.box[1], x1: l.box[2], y1: l.box[3] }));
    // a drawing with a table in the box: the table is what is wanted
    if (pm.kind === 'drawing' && pm.words.length) pm.kind = 'text';
  }
  /** a scan to show as a picture (not read): Word gets the page picture */
  picture(i: number) {
    const pm = this.pages[i];
    if (!pm || this.opts.format !== 'docx') return;
    pm.snapshot = pagePng(this.doc, i, 150);
  }
  finish(): Uint8Array {
    const word = this.opts.format === 'docx';
    const done = this.pages.filter(Boolean);
    for (const pm of done) if (pm.kind === 'drawing' && word && !pm.snapshot) pm.snapshot = pagePng(this.doc, pm.i, 150);
    // Word's pages are 1 to 22 inches: bigger sheets (A1, A0) and tiny ones are scaled to fit, text and all
    if (word) for (const pm of done) {
      const big = Math.max(pm.w, pm.h), small = Math.min(pm.w, pm.h);
      const k = big > 1580 ? 1580 / big : small < 72 ? Math.min(72 / Math.max(1, small), 1580 / big) : 1;
      if (k !== 1) scalePage(pm, k);
    }
    if (this.opts.dropStamps !== false) dropStampText(done);
    const layouts: PageLayout[] = done.map((pm) => analyzePage(pm, word));
    markRunning(layouts);
    return word ? toWord(layouts, this.fonts.list, this.opts, (i, box) => regionPicture(this.doc, i, box, 200)) : toExcel(layouts, this.fonts.list, this.opts);
  }
}

/** a page model at k times its size (coordinates, sizes, lines) */
export function scalePage(pm: PageModel, k: number) {
  const b = (x: number[]) => { for (let i = 0; i < 4; i++) x[i] *= k; };
  pm.w *= k; pm.h *= k; pm.bodySize *= k;
  for (const w of pm.words) {
    w.x0 *= k; w.y0 *= k; w.x1 *= k; w.y1 *= k; w.base *= k; w.size *= k;
    for (const g of w.g) { g.x0 *= k; g.y0 *= k; g.x1 *= k; g.y1 *= k; g.base *= k; g.size *= k; }
  }
  for (const r of pm.rulings) { r.c *= k; r.a *= k; r.b *= k; r.w = Math.max(0.1, r.w * k); }
  for (const f of pm.fills) b(f.box);
  for (const p of pm.pics) b(p.box);
  for (const s of pm.shapes) b(s);
  for (const l of pm.links) b(l.box);
}

export function pagePng(doc: mupdf.Document, i: number, dpi: number): Uint8Array {
  const p = doc.loadPage(i);
  try {
    const b = p.getBounds();
    const s = Math.min(dpi / 72, 3000 / Math.max(1, b[2] - b[0], b[3] - b[1]));
    const pix = p.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
    const png = pix.asPNG().slice();
    pix.destroy?.();
    return png;
  } finally { p.destroy?.(); }
}

/** a part of a page as a picture (vector figures: logos, charts) */
export function regionPicture(doc: mupdf.Document, i: number, box: number[], dpi: number): { data: Uint8Array; ext: 'png' | 'jpeg' } | null {
  const p = doc.loadPage(i);
  try {
    const b = p.getBounds();
    const pad = 2;
    const x0 = box[0] - pad, y0 = box[1] - pad, w = box[2] - box[0] + pad * 2, h = box[3] - box[1] + pad * 2;
    const s = Math.min(dpi / 72, 2500 / Math.max(w, h));
    const pw = Math.max(1, Math.round(w * s)), ph = Math.max(1, Math.round(h * s));
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, pw, ph], false);
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    p.run(dev, [s, 0, 0, s, -(x0 + b[0]) * s, -(y0 + b[1]) * s]);
    dev.close();
    const data = pix.asPNG().slice();
    dev.destroy?.();
    pix.destroy?.();
    return { data, ext: 'png' };
  } catch { return null; } finally { p.destroy?.(); }
}

// ---------------------------------------------------------------- engine calls

const jobs = new Map<string, ExportJob>();

export function exportBegin(id: string, doc: mupdf.Document, opts: ExportOpts, release?: () => void) {
  exportEnd(id);
  const j = new ExportJob(doc, opts, release);
  jobs.set(id, j);
  return { pages: j.count() };
}
const J = (id: string) => { const j = jobs.get(id); if (!j) throw new Error('The export was stopped.'); return j; };
export const exportRead = (id: string, i: number) => J(id).read(i);
export const exportOcr = (id: string, i: number, ocr: OcrIn) => J(id).addOcr(i, ocr);
export const exportPicture = (id: string, i: number) => J(id).picture(i);
export function exportFinish(id: string): Uint8Array {
  const j = J(id);
  try { return j.finish(); } finally { exportEnd(id); }
}
export function exportEnd(id: string) {
  const j = jobs.get(id);
  if (!j) return true;
  jobs.delete(id);
  try { j.doc.destroy?.(); } catch { /* gone */ }
  try { j.release?.(); } catch { /* closed */ }
  return true;
}
