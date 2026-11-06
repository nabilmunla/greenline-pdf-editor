// Pages -> Word document: each PDF page starts a new Word page; sections change with the
// page size or the page header; page numbers become Word page-number fields.
import type { Box, ExportOpts, FontInfo, Pic, Word } from './model';
import { clamp, median, minOf, maxOf, pushAll } from './model';
import type { PageLayout } from './analyze';
import { rowText } from './analyze';
import type { Cell, Table } from './tables';
import { readingOrder, type Row } from './rows';
import { figures, markHeadings, pageFlow, paragraphs, type Block, type Para, type PageFlow, type PLine } from './flow';
import { Docx, esc, paraXml, runXml, tw, type ParaProps, type RunPart, type RunStyle, type Section } from './docx';
import { naturalLeading } from './fonts';

export type RegionPicture = (page: number, box: Box) => { data: Uint8Array; ext: 'png' | 'jpeg' } | null;

interface PageOut { pl: PageLayout; flow: PageFlow | null; counter?: number; hfKey: string; header: Row[]; footer: Row[] }

export function toWord(pages: PageLayout[], fonts: FontInfo[], o: ExportOpts, region?: RegionPicture): Uint8Array {
  const doc = new Docx();
  const outs: PageOut[] = [];
  const total = pages.length;
  // page numbers: which number on the page counts the pages
  const counters = pageCounters(pages);
  // numbers that aren't a page count stay where they are (in the text) - unless the same line
  // repeats on the next / previous page (a constant footer: it stays a footer, as plain text)
  const constant = pages.map((pl, k) => new Set([...pl.pageNo].filter((r) => [k - 1, k + 1].some((j) => {
    const o = pages[j];
    return !!o && [...o.pageNo].some((x) => o.running.get(x) === pl.running.get(r) && rowText(x) === rowText(r));
  }))));
  for (const [k, pl] of pages.entries()) {
    if (counters[k] !== undefined) continue;
    for (const r of [...pl.pageNo]) { pl.pageNo.delete(r); if (!constant[k].has(r)) pl.running.delete(r); }
  }
  for (const [k, pl] of pages.entries()) {
    const c = counters[k];
    let flow: PageFlow | null = null;
    if (pl.pm.kind !== 'drawing' && !(pl.pm.kind === 'scan' && !pl.pm.words.length) && pl.pm.kind !== 'empty') {
      const figs = figures(pl).map((box) => {
        const r = region?.(pl.pm.i, box);
        return r ? { box, pic: { box, data: r.data, ext: r.ext } as Pic } : null;
      }).filter((x): x is { box: Box; pic: Pic } => !!x);
      flow = pageFlow(pl, figs);
    }
    const header = [...pl.running.entries()].filter(([, z]) => z === 'h').map(([r]) => r).sort((a, b) => a.y0 - b.y0);
    const footer = [...pl.running.entries()].filter(([, z]) => z === 'f').map(([r]) => r).sort((a, b) => a.y0 - b.y0);
    const key = (rs: Row[]) => rs.map((r) => rowText(r).toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ')).join('|');
    outs.push({ pl, flow, counter: c, hfKey: key(header) + '//' + key(footer), header, footer });
  }
  markHeadings(outs.map((x) => (x.flow ? x.flow.blocks.filter((b): b is Para => b.kind === 'p') : [])), fonts);
  // the document's usual font
  const famCount = new Map<string, number>();
  const sizes: number[] = [];
  for (const pl of pages) for (const w of pl.pm.words) { const f = fonts[w.g[0]?.f]; if (f && !/symbol|wingdings/i.test(f.family)) famCount.set(f.family, (famCount.get(f.family) ?? 0) + w.text.length); sizes.push(w.size); }
  let defFont = 'Arial', best = 0;
  for (const [k, v] of famCount) if (v > best) { best = v; defFont = k; }
  const defSize = Math.round((median(sizes) || 11) * 2) / 2;

  // a table that carries on at the top of the next page: one Word table (Word breaks it itself)
  const joinedPage = new Set<number>();
  // (the table a page ends with - on an earlier page when the pages between were all table)
  let open: { blk: Block & { kind: 'table' }; k: number } | null = null;
  for (let k = 0; k < outs.length; k++) {
    const b = outs[k].flow;
    if (!b || !b.blocks.length) { open = null; continue; }
    const tb = b.blocks[0];
    if (open && k > 0 && tb.kind === 'table' && outs[k].hfKey === outs[open.k].hfKey) {
      const ta = open.blk;
      const tol = outs[k].pl.pm.ocr ? 10 : 4;
      if (Math.abs(outs[k].pl.pm.w - outs[open.k].pl.pm.w) <= 2 && ta.t.xs.length === tb.t.xs.length && ta.t.xs.every((x, i) => Math.abs(x - tb.t.xs[i]) <= tol)) {
        ta.t = joinTables(ta.t, tb.t);
        b.blocks.shift();
        joinedPage.add(k);
        // the whole page went into the table: it stays open for the next page
        if (!b.blocks.length) continue;
      }
    }
    const last = b.blocks[b.blocks.length - 1];
    open = last.kind === 'table' ? { blk: last, k } : null;
  }

  // ---------------------------------------------------------------- sections
  let sec: { s: Section; L: number; first: number } | null = null;
  const body = doc.body;
  let lastWasTable = false;
  const endSection = () => {
    if (!sec) return;
    const sp = doc.sectPr(sec.s);
    // the section's properties ride on its last paragraph
    const last = body.length - 1;
    if (last >= 0 && !lastWasTable && body[last].startsWith('<w:p>')) body[last] = attachSect(body[last], sp);
    else body.push(paraXml({ tiny: true, sect: sp }, ''));
    lastWasTable = false;
  };
  for (const [k, out] of outs.entries()) {
    const { pl, flow } = out;
    const W = pl.pm.w, H = pl.pm.h;
    const pictureOnly = !flow;
    const L = flow ? flow.L : 18, R = flow ? flow.R : W - 18;
    const prev = k > 0 ? outs[k - 1] : null;
    const newSection = !sec || Math.abs(sec.s.w - W) > 2 || Math.abs(sec.s.h - H) > 2 || out.hfKey !== prev!.hfKey || pictureOnly !== !prev!.flow
      || (out.counter !== undefined && prev?.counter !== undefined && out.counter !== prev.counter + 1);
    let pageBreak = false;
    if (newSection) {
      if (sec) {
        // the section ends with the previous page's last paragraph
        endSection();
      }
      const top = flow ? flow.top : 18, bottom = flow ? flow.bottom : H - 18;
      const hdrBottom = out.header.length ? Math.max(...out.header.map((r) => r.y1)) : 0;
      const ftrTop = out.footer.length ? Math.min(...out.footer.map((r) => r.y0)) : H;
      const margins: Section['margins'] = pictureOnly ? [18, 18, 18, 18] : [
        clamp(Math.min(top, Math.max(top - 4, hdrBottom + 4)) - 2, 14, 200),
        clamp(W - R - 2, 10, 150),
        clamp(Math.min(H - bottom, H - ftrTop + 2) * 0.55, 12, 110),
        clamp(L, 10, 150),
      ];
      sec = { s: { w: W, h: H, margins, pageStart: out.counter }, L: margins[3], first: k };
      sec.s.header = hfXml(out.header, pl, out.counter, total, margins[3], W - margins[1], fonts, doc);
      sec.s.footer = hfXml(out.footer, pl, out.counter, total, margins[3], W - margins[1], fonts, doc);
      if (!sec.s.header) delete sec.s.header;
      if (!sec.s.footer) delete sec.s.footer;
    } else {
      // a page the PDF filled carries straight on (Word moves to the next page itself - a forced
      // break after a page that runs a line longer in Word would leave a nearly blank page);
      // a page that stopped well short of the bottom (end of a chapter) starts a new page
      const pf = prev?.flow;
      // (a page with its own text keeps its page: there the layout is exact; a scan's text sizes are
      // estimates)
      const short = !pf || !pf.blocks.length || !prev!.pl.pm.ocr || prev!.pl.pm.h - pf.bottom > prev!.pl.pm.h * 0.2;
      pageBreak = !joinedPage.has(k) && short;
    }
    const s = sec!;
    const off = L - s.L; // this page's left edge against the section's margin
    const textW = W - s.s.margins[1] - s.s.margins[3];
    if (pictureOnly) {
      const snap = pl.pm.snapshot;
      if (snap) {
        const scale = Math.min((W - 36) / W, (H - 40) / H);
        body.push(paraXml({ pageBreak, jc: 'center', before: 0 }, doc.picture(snap, 'png', W * scale, H * scale)));
      } else body.push(paraXml({ pageBreak }, ''));
      lastWasTable = false;
      continue;
    }
    const blocks = flow!.blocks;
    // (a page that was all table went into the table above: nothing of its own)
    if (!blocks.length) { if (!joinedPage.has(k)) { body.push(paraXml({ pageBreak }, '')); lastWasTable = false; } continue; }
    let topY = s.s.margins[0];
    blocks.forEach((b, bi) => {
      const firstOnPage = bi === 0;
      const brk = firstOnPage && pageBreak;
      if (b.kind === 'p') {
        body.push(paraOut(b, fonts, doc, off, defFont, firstOnPage ? Math.max(0, b.y0 - topY - b.size * 0.2) : undefined, brk, pl));
        lastWasTable = false;
      } else if (b.kind === 'table') {
        if (brk || lastWasTable) body.push(paraXml({ tiny: true, pageBreak: brk }, ''));
        else if (firstOnPage && b.y0 - topY > 6) body.push(paraXml({ tiny: false, before: Math.max(0, b.y0 - topY - 12) }, ''));
        body.push(tablesXml(b.t, s.L, fonts, doc, defFont, pl));
        lastWasTable = true;
      } else {
        const pic = b.pic;
        let w = pic.box[2] - pic.box[0], h = pic.box[3] - pic.box[1];
        if (w > textW) { h *= textW / w; w = textW; }
        const mid = (b.x0 + b.x1) / 2;
        const jc = Math.abs(mid - (L + R) / 2) < 15 && w < textW * 0.9 ? 'center' : Math.abs(b.x1 - R) < 8 && b.x0 > L + 40 ? 'right' : 'left';
        const pp: ParaProps = { pageBreak: brk, jc, before: firstOnPage ? Math.max(0, b.y0 - topY) : b.before, left: jc === 'left' ? Math.max(0, b.x0 - L + off) : 0 };
        if (pic.data) body.push(paraXml(pp, doc.picture(pic.data, pic.ext || 'png', w, h)));
        lastWasTable = false;
      }
      topY = -1e9;
    });
  }
  if (sec) {
    const sp = doc.sectPr(sec.s);
    if (lastWasTable) body.push(paraXml({ tiny: true }, ''));
    body.push(sp);
  }
  return doc.finish(defFont, defSize, o.title || 'Document');
}

/** rows of b (its repeated header left out) added under a */
function joinTables(a: Table, b: Table): Table {
  const txt = (t: Table, r: number) => t.cells.filter((c) => c.r === r).map((c) => c.words.map((w) => w.text).join(' ')).join('|');
  let skip = 0;
  while (skip < b.rows.length && b.rows[skip].head && skip < a.rows.length && txt(b, skip) === txt(a, skip)) skip++;
  const off = a.rows.length - skip;
  return {
    ...a,
    box: [a.box[0], a.box[1], a.box[2], a.box[3]],
    rows: [...a.rows, ...b.rows.slice(skip).map((r) => ({ ...r, head: false }))],
    cells: [...a.cells, ...b.cells.filter((c) => c.r >= skip).map((c) => ({ ...c, r: c.r + off }))],
  };
}

// ---------------------------------------------------------------- page numbers

function pageCounters(pages: PageLayout[]): (number | undefined)[] {
  const nums = pages.map((pl) => [...pl.pageNo].sort((a, b) => a.y0 - b.y0).flatMap((r) => (rowText(r).match(/\d+/g) || []).map(Number)));
  const out: (number | undefined)[] = new Array(pages.length).fill(undefined);
  for (let k = 0; k < pages.length; k++) {
    const t = nums[k];
    if (!t.length) continue;
    const prev = k > 0 ? nums[k - 1] : null, next = k + 1 < pages.length ? nums[k + 1] : null;
    for (let i = 0; i < t.length; i++) {
      if ((prev && prev.length === t.length && prev[i] + 1 === t[i]) || (next && next.length === t.length && t[i] + 1 === next[i]) || (pages.length === 1 && t[i] === pages[k].pm.i + 1)) { out[k] = t[i]; break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- runs

function styleOfGlyph(g: Word['g'][number], fonts: FontInfo[], lineSize: number, defFont: string): RunStyle {
  const f = fonts[g.f];
  let font = f?.family || defFont;
  if (/^(symbol|wingdings)$/i.test(font) && !/[-]/.test(g.c)) font = defFont;
  return {
    font,
    size: Math.round((g.va ? lineSize : g.size) * 2) / 2,
    b: !!(g.bold || f?.bold) || undefined,
    i: !!f?.italic || undefined,
    u: g.ul || undefined,
    s: g.st || undefined,
    color: g.color && g.color !== 0 ? g.color : undefined,
    va: g.va || undefined,
    rtl: g.rtl || undefined,
  };
}
const sameStyle = (a: RunStyle, b: RunStyle) => a.font === b.font && a.size === b.size && a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.color === b.color && a.va === b.va && a.rtl === b.rtl;

function linkOf(w: Word, pl: PageLayout): string | undefined {
  const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
  return pl.pm.links.find((l) => cx >= l.box[0] && cx <= l.box[2] && cy >= l.box[1] && cy <= l.box[3])?.uri;
}

/** words -> run parts (one part per change of look) */
function wordsRuns(ws: Word[], fonts: FontInfo[], lineSize: number, defFont: string, pl: PageLayout | null, out: RunPart[]) {
  ws.forEach((w, k) => {
    const link = pl ? linkOf(w, pl) : undefined;
    if (k > 0) {
      const prevSt = out[out.length - 1]?.st;
      const st0 = styleOfGlyph(w.g[0], fonts, lineSize, defFont);
      const sp = prevSt ? { ...prevSt, va: undefined, u: prevSt.u && st0.u ? true : undefined } : st0;
      push(out, { text: ' ', st: sp, link: link && out[out.length - 1]?.link === link ? link : undefined });
    }
    for (const g of w.g) push(out, { text: g.c, st: styleOfGlyph(g, fonts, lineSize, defFont), link });
  });
}
function push(out: RunPart[], p: RunPart) {
  const last = out[out.length - 1];
  if (last && !last.tab && !last.field && !p.tab && !p.field && last.link === p.link && sameStyle(last.st, p.st)) last.text += p.text;
  else out.push(p);
}

function paraRuns(p: Para, fonts: FontInfo[], defFont: string, pl: PageLayout | null): RunPart[] {
  const out: RunPart[] = [];
  const size = p.size;
  p.lines.forEach((l, li) => {
    if (li > 0) {
      const prevText = out.map((x) => x.text).join('');
      const nextText = l.words[0]?.text ?? '';
      if (!(/[A-Za-z]-$/.test(prevText) && /^[a-z]/.test(nextText))) push(out, { text: ' ', st: out[out.length - 1]?.st ?? { font: defFont, size } });
    }
    if (li === 0 && l.marker && !p.rtl) {
      const geo = l.words.slice().sort((a, b) => a.x0 - b.x0);
      wordsRuns([geo[0]], fonts, size, defFont, pl, out);
      out.push({ text: '', tab: true, st: out[out.length - 1].st });
      wordsRuns(geo.slice(1), fonts, size, defFont, pl, out);
      return;
    }
    if (l.leader || (li === 0 && p.lines.length === 1 && l.segs.length > 1 && !p.rtl)) {
      l.segs.forEach((s, si) => {
        const ws = s.words.filter((w) => !w.leader);
        if (si > 0) out.push({ text: '', tab: true, st: out[out.length - 1]?.st ?? { font: defFont, size } });
        if (ws.length) wordsRuns(ws, fonts, size, defFont, pl, out);
      });
      return;
    }
    wordsRuns(l.words, fonts, size, defFont, pl, out);
  });
  return out;
}

function paraOut(p: Para, fonts: FontInfo[], doc: Docx, off: number, defFont: string, beforeOverride: number | undefined, pageBreak: boolean, pl: PageLayout | null): string {
  const runs = paraRuns(p, fonts, defFont, pl);
  const fam = runs.find((r) => r.text.trim())?.st.font || defFont;
  const natural = p.size * naturalLeading(fam);
  const line = p.pitch && Math.abs(p.pitch - natural) > p.size * 0.12 ? p.pitch : 0;
  const pp: ParaProps = {
    style: p.heading ? 'Heading' + p.heading : undefined,
    keepNext: !!p.heading || undefined,
    pageBreak,
    tabs: p.tabs.map(([x, k]) => [x + Math.max(0, off), k]),
    bidi: p.rtl || undefined,
    before: beforeOverride ?? p.before,
    line,
    left: p.align === 'center' || (p.align === 'right' && !p.rtl) ? 0 : Math.max(0, p.left + off),
    right: p.right,
    first: p.align === 'center' || p.align === 'right' ? 0 : p.first,
    jc: p.rtl ? (p.align === 'center' ? 'center' : undefined) : p.align,
  };
  return paraXml(pp, runs.map((r) => runXml(r, doc.link)).join(''));
}

// ---------------------------------------------------------------- tables

const rowLike = (ws: Word[]): Row => {
  const size = median(ws.map((w) => w.size));
  return { words: ws, x0: Math.min(...ws.map((w) => w.x0)), y0: Math.min(...ws.map((w) => w.y0)), x1: Math.max(...ws.map((w) => w.x1)), y1: Math.max(...ws.map((w) => w.y1)), base: median(ws.map((w) => w.base)), size, rtl: ws.filter((w) => w.rtl).length > ws.length / 2 };
};

function cellLines(c: Cell): PLine[] {
  return c.lines.map((ws) => {
    const r = rowLike(ws);
    const words = readingOrder(r);
    return { words, segs: [{ words: words.slice().sort((a, b) => a.x0 - b.x0), x0: r.x0, x1: r.x1 }], x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, base: r.base, size: r.size, rtl: r.rtl };
  });
}

const bdXml = (tag: string, w: number) => (w > 0 ? `<w:${tag} w:val="single" w:sz="${clamp(Math.round(w * 8), 2, 96)}" w:space="0" w:color="000000"/>` : `<w:${tag} w:val="nil"/>`);

/** Word takes 63 columns at most: a wider table (a programme, a schedule) goes in parts, one under the other */
function tablesXml(t: Table, L: number, fonts: FontInfo[], doc: Docx, defFont: string, pl: PageLayout): string {
  const nc = t.xs.length - 1;
  if (nc <= 63) return tableXml(t, L, fonts, doc, defFont, pl);
  const parts = Math.ceil(nc / 63), per = Math.ceil(nc / parts);
  const out: string[] = [];
  for (let c0 = 0; c0 < nc; c0 += per) {
    const c1 = Math.min(nc, c0 + per);
    const sh = t.xs[0] - t.xs[c0];
    const cells = t.cells.filter((c) => c.c < c1 && c.c + c.cs > c0).map((c) => ({ ...c, c: Math.max(c.c, c0) - c0, cs: Math.min(c.c + c.cs, c1) - Math.max(c.c, c0), words: c.c >= c0 ? c.words : [], lines: c.c >= c0 ? c.lines : [] }));
    if (out.length) out.push(paraXml({ tiny: true }, ''));
    out.push(tableXml({ ...t, xs: t.xs.slice(c0, c1 + 1).map((x) => x + sh), cells }, L, fonts, doc, defFont, pl));
  }
  return out.join('');
}

function tableXml(t: Table, L: number, fonts: FontInfo[], doc: Docx, defFont: string, pl: PageLayout): string {
  const nc = t.xs.length - 1;
  const widths = t.xs.slice(1).map((x, i) => Math.max(tw(4), tw(x - t.xs[i])));
  const total = widths.reduce((a, b) => a + b, 0);
  const out: string[] = [];
  out.push(`<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblInd w:w="${tw(t.xs[0] - L)}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="43" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="43" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>`);
  out.push('<w:tblGrid>' + widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>');
  const starts = new Map<string, Cell>();
  for (const c of t.cells) starts.set(c.r + ',' + c.c, c);
  const head = t.rows.filter((r) => r.head).length;
  for (let r = 0; r < t.rows.length; r++) {
    const row = t.rows[r];
    const h = Math.max(8, row.y1 - row.y0);
    out.push(`<w:tr><w:trPr><w:trHeight w:val="${tw(h)}" w:hRule="atLeast"/>${row.head && head && t.rows.length > head + 2 ? '<w:tblHeader/>' : ''}</w:trPr>`);
    for (let c = 0; c < nc;) {
      const cell = starts.get(r + ',' + c);
      const cover = cell ? null : t.cells.find((x) => x.c === c && x.r < r && x.r + x.rs > r);
      const cs = cell ? cell.cs : cover ? cover.cs : 1;
      const w = widths.slice(c, c + cs).reduce((a, b) => a + b, 0);
      const src = cell || cover;
      const pr: string[] = [`<w:tcW w:w="${w}" w:type="dxa"/>`];
      if (cs > 1) pr.push(`<w:gridSpan w:val="${cs}"/>`);
      if (cell && cell.rs > 1) pr.push('<w:vMerge w:val="restart"/>');
      else if (cover) pr.push('<w:vMerge/>');
      if (src) pr.push(`<w:tcBorders>${bdXml('top', src.bd[0])}${bdXml('left', src.bd[3])}${bdXml('bottom', src.bd[2])}${bdXml('right', src.bd[1])}</w:tcBorders>`);
      if (src?.fill !== undefined && src.fill !== 0xffffff) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${src.fill.toString(16).padStart(6, '0').toUpperCase()}"/>`);
      if (cell) pr.push(`<w:vAlign w:val="${vAlign(cell, t)}"/>`);
      let inner = '';
      if (cell && cell.words.length) {
        const x0 = t.xs[cell.c] + 2.2, x1 = t.xs[cell.c + cell.cs] - 2.2;
        const ps = paragraphs(cellLines(cell), x0, x1);
        // a description that wraps in its cell is one paragraph
        const merged = mergeCellParas(ps);
        inner = merged.map((p, i) => {
          const pp: Para = { ...p, before: i ? p.before : 0 };
          return paraOut(pp, fonts, doc, 0, defFont, i ? Math.max(0, Math.min(p.before, 6)) : 0, false, pl);
        }).join('');
      }
      if (!inner) inner = `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:rPr><w:sz w:val="${Math.round((t.size || 9) * 2)}"/></w:rPr></w:pPr></w:p>`;
      out.push(`<w:tc><w:tcPr>${pr.join('')}</w:tcPr>${inner}</w:tc>`);
      c += cs;
    }
    out.push('</w:tr>');
  }
  out.push('</w:tbl>');
  return out.join('');
}

/** lines that were split only by the cell's width belong together */
function mergeCellParas(ps: Para[]): Para[] {
  const out: Para[] = [];
  for (const p of ps) {
    const last = out[out.length - 1];
    if (last && last.align === p.align && Math.abs(last.size - p.size) < 0.6 && p.before < p.size * 0.6 && !p.lines[0].marker && last.align !== 'center') {
      pushAll(last.lines, p.lines);
      last.y1 = p.y1;
      if (!last.pitch && last.lines.length > 1) last.pitch = last.lines[1].base - last.lines[0].base;
    } else out.push({ ...p, lines: p.lines.slice() });
  }
  return out;
}

function vAlign(c: Cell, t: Table): 'top' | 'center' | 'bottom' {
  if (!c.words.length || c.rs > 1) return 'top';
  const row = t.rows[c.r];
  const y0 = minOf(c.words, (w) => w.y0), y1 = maxOf(c.words, (w) => w.y1);
  const top = y0 - row.y0, bot = row.y1 - y1;
  if (bot < top * 0.5 && top > 6) return 'bottom';
  if (Math.abs(top - bot) < 3 && top > 4) return 'center';
  return 'top';
}

// ---------------------------------------------------------------- headers / footers

function hfXml(rows: Row[], pl: PageLayout, counter: number | undefined, total: number, L: number, R: number, fonts: FontInfo[], doc: Docx): string {
  if (!rows.length) return '';
  const W = R - L;
  const defFont = fonts[rows[0].words[0]?.g[0]?.f]?.family || 'Arial';
  return rows.map((r) => {
    const segs: Word[][] = [];
    for (const w of r.words.slice().sort((a, b) => a.x0 - b.x0)) {
      const s = segs[segs.length - 1];
      if (s && w.x0 - s[s.length - 1].x1 < Math.max(r.size * 2, 12)) s.push(w);
      else segs.push([w]);
    }
    const parts: RunPart[] = [];
    const tabs: ParaProps['tabs'] = [];
    let jc: ParaProps['jc'] = 'left';
    segs.forEach((s, si) => {
      const x0 = s[0].x0, x1 = s[s.length - 1].x1;
      const kind = Math.abs((x0 + x1) / 2 - (L + R) / 2) < 12 ? 'center' : Math.abs(x1 - R) < 12 ? 'right' : 'left';
      if (segs.length === 1) jc = kind;
      else if (si > 0) { tabs.push([kind === 'center' ? W / 2 : kind === 'right' ? W : Math.max(0, x0 - L), kind]); parts.push({ text: '', tab: true, st: parts[parts.length - 1]?.st ?? { font: defFont, size: r.size } }); }
      const before = parts.length;
      wordsRuns(s, fonts, r.size, defFont, null, parts);
      // the page number -> a field
      if (pl.pageNo.has(r)) {
        for (let i = before; i < parts.length; i++) {
          const p = parts[i];
          const m = /\d+/g;
          let last = 0;
          const repl: RunPart[] = [];
          let hit: RegExpExecArray | null;
          let used = false;
          while ((hit = m.exec(p.text))) {
            const n = Number(hit[0]);
            const field = counter !== undefined && !used && n === counter ? 'PAGE' : n === total && total > 1 && used ? 'NUMPAGES' : null;
            if (!field) continue;
            if (field === 'PAGE') used = true;
            if (hit.index > last) repl.push({ ...p, text: p.text.slice(last, hit.index) });
            repl.push({ text: hit[0], st: p.st, field });
            last = hit.index + hit[0].length;
          }
          if (repl.length) { if (last < p.text.length) repl.push({ ...p, text: p.text.slice(last) }); parts.splice(i, 1, ...repl); i += repl.length - 1; }
        }
      }
    });
    return paraXml({ jc, tabs }, parts.map((p) => runXml(p, doc.link)).join(''));
  }).join('');
}

/** put a section's properties into a paragraph */
function attachSect(p: string, sp: string): string {
  if (p.startsWith('<w:p><w:pPr>')) return p.replace('</w:pPr>', sp + '</w:pPr>');
  return '<w:p><w:pPr>' + sp + '</w:pPr>' + p.slice(5);
}

export { esc };
