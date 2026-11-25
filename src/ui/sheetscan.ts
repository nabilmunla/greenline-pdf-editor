// "Link the sheets", the reading side (PLAN 7.6): every page's text is read from the drawing engines
// with their own 'chars' call - not doc.chars, whose 40-page cache a whole-file read would fill - and
// reduced to candidates (tokensOf) at once, so nothing but a few hundred small words per page is
// kept. Pages are spread over the engines, a few at a time. A page an engine does not hold is
// loaded for the read only and let go at once (it kept up to 24, dense ones 8 s longer - sweep S5),
// so a file of any length leaves the engines as they were.
import type { PdfDoc } from './doc';
import { renderers } from './engines';
import { isEngineDown } from '../engine/rpc';
import { tokensOf, sheetIndex, findRefs, unlessStopped, dupLine, type PageToks } from './sheets';

export interface SheetScan {
  /** the file's pages, for the sheet index */
  pages: PageToks[];
  /** stopped by the person: nothing was read to the end */
  stopped: boolean;
  /** a page that could not be read (0-based): the scan stopped there */
  failed: { page: number; why: string } | null;
}

/** pages asked of an engine together (one look at them first, then their text one by one) */
const CHUNK = 8;

/**
 * Read the text of every page and reduce it. progress(done, total) after each page; stopped() is
 * asked between pages. A page that fails to read ends the scan (nothing is half-done: the caller
 * writes nothing).
 */
export async function scanPages(doc: PdfDoc, progress: (done: number, total: number) => void, stopped: () => boolean): Promise<SheetScan> {
  const n = doc.pages.length;
  const pages: PageToks[] = new Array(n);
  const out: SheetScan = { pages, stopped: false, failed: null };
  await doc.drawReady();
  let next = 0, done = 0;
  const worker = async (k: number) => {
    while (!out.failed && !out.stopped) {
      if (stopped()) { out.stopped = true; return; }
      const a = next;
      if (a >= n) return;
      const b = Math.min(n, a + CHUNK);
      next = b;
      // (heavy pages are merged first - drawing engines given the line work as it is can run out of
      // memory reading them; Cancel does not wait for a merge to end: sweep S10)
      try { await unlessStopped(doc.ensurePages(Array.from({ length: b - a }, (_, i) => a + i)), stopped); } catch { /* looked at again when read */ }
      if (stopped()) { out.stopped = true; return; }
      for (let p = a; p < b; p++) {
        if (out.failed) return;
        if (stopped()) { out.stopped = true; return; }
        try {
          // (a worker keeps to its engine; one switched off meanwhile leaves the list, so it is read at each call)
          // (an engine that starts afresh meanwhile - its memory over the mark after a dense page -
          // fails the calls in flight: asked again once it is back, up to 3 times; "page could not
          // be read" ended a 2,062-page run - e2e-combine-big)
          let c: { text: string; box: Float32Array } | null = null;
          for (let tries = 0; !c; tries++) {
            const eng = renderers[k % renderers.length];
            try { c = await eng.call<{ text: string; box: Float32Array }>('chars', [doc.id, p, false]); }
            catch (e) { if (!isEngineDown(e) || tries >= 3 || stopped()) throw e; await new Promise((r) => setTimeout(r, 1500)); }
          }
          const pg = doc.pages[p];
          pages[p] = tokensOf(p, c, pg.w, pg.h, pg.label);
        } catch (e) {
          out.failed = { page: p, why: String((e as Error)?.message || e) };
          return;
        }
        done++;
        progress(done, n);
      }
    }
  };
  await Promise.all(renderers.map((_, k) => worker(k)));
  return out;
}

export interface SheetPlan {
  links: { page: number; box: [number, number, number, number]; target: number }[];
  marks: { page: number; title: string }[];
  sheets: number;
  noText: number;
  /** numbers on more than one page, linked to the first copy */
  dups: string[];
}

/** what the scan found: the links and the bookmark titles ("<number> <title>", or the number alone) */
export function planSheets(pages: PageToks[]): SheetPlan {
  const have = pages.filter(Boolean);
  const idx = sheetIndex(have);
  const links = findRefs(have, idx).map((r) => ({ page: r.page, box: r.box, target: r.target }));
  const marks = idx.sheets.map((s) => ({ page: s.page, title: s.title ? s.no + ' ' + s.title : s.no }));
  return { links, marks, sheets: idx.sheets.length, noText: idx.noText, dups: idx.dups };
}

const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
/** "38 pages have no text: OCR them, then run this again." ('' when every page has text) */
export const noTextLine = (n: number) => (n > 0 ? (n === 1 ? '1 page has no text: OCR it, then run this again.' : `${n.toLocaleString('en-GB')} pages have no text: OCR them, then run this again.`) : '');
export const NOTHING_FOUND = 'No sheet numbers found. Nothing was changed.';

/** the closing message; the first line says what was written */
export function doneText(r: { links: number; sheetsWithLinks: number; bookmarks: number; wantLinks: boolean; wantMarks: boolean }, noText: number, dups: string[] = []): string {
  const parts: string[] = [];
  if (r.wantLinks) parts.push(r.links ? `${plural(r.links, 'link')} on ${plural(r.sheetsWithLinks, 'sheet')}` : 'No links');
  if (r.wantMarks) parts.push(plural(r.bookmarks, 'bookmark'));
  const t = parts.join(', ') + '. Undo removes them.';
  return [t, dupLine(dups), noTextLine(noText)].filter(Boolean).join(' ');
}
