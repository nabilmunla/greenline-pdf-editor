// Print: our own panel (printer, pages, paper, size, markups) with a true preview of each sheet.
import type { Rect } from '../engine/mu';
// The engine makes the file for the printer (each page already placed on its sheet, vector),
// Chromium's PDF engine sends it to the printer.
import { NumIn } from './numin';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, type Toast } from './Modal';
import { Ico } from './icons';
import { gcc } from './api';
import { editor, muFile, muBatch } from './engines';
import type { FileRef } from '../engine/rpc';
import type { PdfDoc } from './doc';
import { PAPERS, paperName, sheetLayout, type PrintOpts } from '../engine/printlayout';
import { parseRanges, toRanges, paperSheets } from './dlgutil';

export interface PrintSettings {
  /** (up to 0.8.5: the printer used last, offered at every start - now only for the run it was
   *  chosen in, kept by the main process; a saved one is ignored) */
  printer?: string;
  paper?: string; // a PAPERS name, or 'page' (each page on a sheet of its own size)
  orient?: PrintOpts['orient'];
  scale?: PrintOpts['scale'];
  pct?: number;
  marginMm?: number;
  markups?: boolean;
  color?: boolean;
  duplex?: 'simplex' | 'longEdge' | 'shortEdge';
  /** sheets as they are, as pictures, or pictures only for the heavy ones (auto) */
  send?: 'auto' | 'vector' | 'picture';
}

interface Props {
  doc: PdfDoc;
  page: number;
  /** an area marked with the Snapshot tool on that page: offered first ("The marked area") */
  area?: Rect | null;
  pageSel: number[];
  settings: PrintSettings;
  save(s: PrintSettings): void;
  close(): void;
  toast(t: string, k?: Toast['kind'], a?: Toast['action'], ms?: number): number;
  fail(e: unknown): void;
}

type Which = 'all' | 'current' | 'view' | 'area' | 'selected' | 'range';
interface Printer { name: string; displayName: string; description: string; isDefault: boolean; status: number }

const MM = 72 / 25.4;
/** 0:42 */
const secs = (ms: number) => { const t = Math.round(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

export function PrintDlg(p: Props) {
  const { doc } = p;
  const n = doc.pages.length;
  const S = p.settings;
  const [printers, setPrinters] = useState<Printer[] | null>(null);
  const [printer, setPrinter] = useState('');
  const [copies, setCopies] = useState(1);
  const [collate, setCollate] = useState(true);
  const [which, setWhich] = useState<Which>(p.area ? 'area' : p.pageSel.length > 1 ? 'selected' : 'all');
  const [range, setRange] = useState(() => `${p.page + 1}`);
  const [subset, setSubset] = useState<'all' | 'odd' | 'even'>('all');
  const [reverse, setReverse] = useState(false);
  const [markups, setMarkups] = useState(S.markups ?? true);
  const [paper, setPaper] = useState(S.paper || 'A4');
  const [orient, setOrient] = useState<PrintOpts['orient']>(S.orient || 'auto');
  const [scale, setScale] = useState<PrintOpts['scale']>(S.scale || 'fit');
  const [pct, setPct] = useState(S.pct || 100);
  const [marginMm, setMarginMm] = useState(S.marginMm ?? 5);
  const [color, setColor] = useState(S.color ?? true);
  const [duplex, setDuplex] = useState<NonNullable<PrintSettings['duplex']>>(S.duplex || 'simplex');
  const [send, setSend] = useState<NonNullable<PrintSettings['send']>>(S.send || 'auto');
  /** Cancel pressed while the pictures are being made */
  const stop = useRef(false);
  /** when the current step started (the busy note counts the seconds: a long hand-over to the
   *  printer looked like nothing was happening) */
  const [since, setSince] = useState(0);
  const [, tick] = useState(0);
  const [sheet, setSheet] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (!busy) return; const t = window.setInterval(() => tick((x) => x + 1), 1000); return () => window.clearInterval(t); }, [busy]);
  const view = doc.visRects.get(p.page) ?? null;

  useEffect(() => {
    // the printer chosen earlier in this run, else Windows' default printer
    void Promise.all([gcc.printers(), gcc.sessionPrinter().catch(() => '')]).then(([l, last]) => {
      setPrinters(l);
      setPrinter((cur) => (cur && l.some((x) => x.name === cur) ? cur : l.some((x) => x.name === last) ? last : (l.find((x) => x.isDefault) || l[0])?.name || ''));
    });
  }, []);

  // the pages, in print order
  const pages = useMemo(() => {
    let l: number[];
    if (which === 'all') l = [...Array(n).keys()];
    else if (which === 'current' || which === 'view' || which === 'area') l = [p.page];
    else if (which === 'selected') l = [...p.pageSel].sort((a, b) => a - b);
    else l = parseRanges(range, n);
    if (which !== 'current' && which !== 'view' && which !== 'area') {
      if (subset === 'odd') l = l.filter((i) => i % 2 === 0);
      if (subset === 'even') l = l.filter((i) => i % 2 === 1);
    }
    return reverse ? l.slice().reverse() : l;
  }, [which, range, subset, reverse, n]);

  const paperDef = PAPERS.find((x) => x.name === paper) || null;
  const opts: PrintOpts = {
    pages, region: which === 'view' ? view : which === 'area' ? p.area ?? null : null,
    paper: paper === 'page' ? null : paperDef, orient, scale, pct, margin: marginMm * MM, markups,
    send, gray: !color,
  };
  const keep = (): PrintSettings => {
    if (printer) void gcc.sessionPrinter(printer).catch(() => {});
    return { paper, orient, scale, pct, marginMm, markups, color, duplex, send };
  };
  useEffect(() => { if (sheet >= pages.length) setSheet(Math.max(0, pages.length - 1)); }, [pages.length]);

  // what the current sheet's page looks like on it
  const cur = pages[sheet];
  const L = cur != null && doc.pages[cur] ? sheetLayout(doc.pages[cur].w, doc.pages[cur].h, opts.region, opts) : null;
  const pageSize = cur != null ? paperName(doc.pages[cur].w, doc.pages[cur].h) : null;
  const sheetName = L ? paperName(L.W, L.H) || `${Math.round(L.W / MM)} × ${Math.round(L.H / MM)} mm` : '';
  const clipped = L && (L.ox < -0.5 || L.oy < -0.5);

  // preview picture (the engine draws exactly what prints)
  const cv = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pv, setPv] = useState({ w: 300, h: 420 });
  const ask = useRef(0);
  // the preview fits the space it has (the dialog follows the window size)
  const [room, setRoom] = useState('');
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom(el.clientWidth + 'x' + el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const key = JSON.stringify([cur, opts.region, paper, orient, scale, pct, marginMm, markups, color, doc.crev[cur ?? 0], !!busy, room]);
  useEffect(() => {
    if (cur == null || !L) return;
    const el = box.current!;
    const maxW = el.clientWidth - 24, maxH = el.clientHeight - 24;
    const k = Math.min(maxW / L.W, maxH / L.H);
    const w = Math.max(40, Math.round(L.W * k)), h = Math.max(40, Math.round(L.H * k));
    setPv({ w, h });
    const n0 = ++ask.current;
    const d = window.devicePixelRatio || 1;
    const t = window.setTimeout(async () => {
      try {
        const r = await editor.call<{ bmp: ImageBitmap; W: number; H: number; x: number; y: number; s: number } | null>('printSheet', [doc.id, { ...opts, pages: [cur] }, 0, Math.round(Math.max(w, h) * d)]);
        if (n0 !== ask.current || !r || !cv.current) { r?.bmp.close?.(); return; }
        const c = cv.current;
        c.width = Math.round(w * d); c.height = Math.round(h * d);
        const g = c.getContext('2d')!;
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        // Black & white: shown so (the preview was in colour whatever was chosen)
        g.filter = color ? 'none' : 'grayscale(1)';
        g.drawImage(r.bmp, r.x * (c.width / Math.round(r.W * r.s)), r.y * (c.height / Math.round(r.H * r.s)), r.bmp.width * (c.width / Math.round(r.W * r.s)), r.bmp.height * (c.height / Math.round(r.H * r.s)));
        r.bmp.close?.();
        g.filter = 'none';
        // the margin kept clear (fit) - a faint line
        if ((scale === 'fit' || scale === 'shrink') && opts.paper && marginMm > 0) {
          // (the margin as the layout uses it: at most a quarter of the paper's short side)
          const m = L.m * (c.width / r.W);
          g.strokeStyle = 'rgba(30, 120, 140, 0.25)';
          g.setLineDash([4 * d, 4 * d]);
          g.strokeRect(m, m, c.width - 2 * m, c.height - 2 * m);
        }
      } catch { /* the next change asks again */ }
    }, 60);
    return () => window.clearTimeout(t);
  }, [key]);

  const step = (t: string) => { setBusy(t); setSince(Date.now()); };
  /**
   * The file for the printer (each page on its sheet). Sheets that are heavy for a printer
   * (big scans, dense line work - or all of them, "Pictures") are then made into one picture
   * each by the batch engine, one by one: progress shown, Cancel stops it, the open file stays
   * usable meanwhile. `pictures` = how many went as pictures.
   */
  const make = async (forFile = false): Promise<{ path: string; pictures: number } | null> => {
    const t0 = Date.now();
    // (Save as PDF: sheets as they are unless "Pictures" was chosen - a saved PDF of pictures
    // loses its text and its lines; Auto is about what printers chew on)
    const o = forFile && send === 'auto' ? { ...opts, send: 'vector' as const } : opts;
    const r = await muFile<FileRef | { bytes: FileRef; pictures: number[] }>('printFile', doc.id, o);
    if ('$file' in r) { gcc.log(`print: ${pages.length} sheets made in ${Date.now() - t0} ms (${Math.round((r.$file.size ?? 0) / 1024)} KB, as they are)`); return { path: r.$file.path, pictures: 0 }; }
    const vec = r.bytes.$file;
    if (!r.pictures.length) { gcc.log(`print: ${pages.length} sheets made in ${Date.now() - t0} ms (${Math.round((vec.size ?? 0) / 1024)} KB, none heavy)`); return { path: vec.path, pictures: 0 }; }
    const t1 = Date.now();
    // (a sheet at a time, each picture straight to disk - a long job never fills the engine)
    const job = 'print-' + Math.random().toString(36).slice(2);
    await muBatch('printPicBegin', job, { $file: { path: vec.path, size: vec.size } });
    try {
      for (let i = 0; i < r.pictures.length; i++) {
        if (stop.current) return null;
        setBusy(`Making sheet ${i + 1} of ${r.pictures.length} into a picture…`);
        await muBatch('printPicSheet', job, r.pictures[i], !color);
      }
      if (stop.current) return null;
      setBusy('Putting the sheets together…');
      const f = (await muBatch<FileRef>('printPicFinish', job)).$file;
      // (Cancel while it was being written: nothing goes to the printer)
      if (stop.current) { void gcc.dropTemp([f.path]).catch(() => {}); return null; }
      gcc.log(`print: ${pages.length} sheets made in ${t1 - t0} ms, ${r.pictures.length} as pictures in ${Date.now() - t1} ms (${Math.round((vec.size ?? 0) / 1024)} KB -> ${Math.round((f.size ?? 0) / 1024)} KB)`);
      return { path: f.path, pictures: r.pictures.length };
    } finally {
      // (the job let go first: Windows won't delete a file the engine still reads)
      await muBatch('printPicEnd', job).catch(() => {});
      void gcc.dropTemp([vec.path]).catch(() => {});
    }
  };
  const go = async (dialog = false) => {
    if (!pages.length) { p.toast('No pages to print – check the page numbers.', 'info'); return; }
    p.save(keep());
    stop.current = false;
    try {
      step(`Preparing ${pages.length} page${pages.length === 1 ? '' : 's'}…`);
      const m = await make();
      if (!m) { setBusy(null); return; }
      const f = m.path;
      step(dialog ? 'Opening the Windows print dialog…' : 'Sending to the printer…');
      const t0 = Date.now();
      // (the job's paper and orientation: the first sheet's - also with "Same as each page",
      // where it is that page's own size: a print job given no paper size is refused)
      const p0 = doc.pages[pages[0]];
      const first = sheetLayout(p0.w, p0.h, opts.region, opts);
      const r = await gcc.printRun(f, { deviceName: printer, copies, collate, color, duplex, sheet: { w: first.W, h: first.H }, sheets: pages.length, dialog });
      gcc.log(`print: handed to ${printer || 'the printer'} in ${Date.now() - t0} ms (${r.ok ? 'ok' : r.reason})`);
      if (!r.ok) {
        setBusy(null);
        if (/cancel/i.test(r.reason)) return;
        p.toast(`Printing failed${r.reason ? ': ' + r.reason : ''}.`, 'err');
        return;
      }
      p.close();
      const pr = printers?.find((x) => x.name === printer);
      const asPic = m.pictures ? ` (${m.pictures === pages.length ? (pages.length === 1 ? 'as a picture' : 'as pictures') : `${m.pictures} as pictures`})` : '';
      p.toast(dialog ? 'Sent to the printer.' : `${pages.length} page${pages.length === 1 ? '' : 's'}${copies > 1 ? ` × ${copies}` : ''} sent to ${pr?.displayName || printer || 'the printer'}${asPic}.`, 'ok');
    } catch (e) { setBusy(null); p.fail(e); }
  };
  /** the picked printer's own preferences (tray, quality, finishing) - then Print here; where that
   *  window can't open, Windows' print dialog as before */
  const prefs = async () => {
    if (!printer) return;
    setBusy(`Preferences of ${pr?.displayName || printer} are open in their own window…`);
    let r: { ok: boolean; reason?: string } = { ok: false };
    try { r = await gcc.printPrefs(printer); } catch { r = { ok: false }; }
    setBusy(null);
    if (r.ok) p.toast(`What you OK in the preferences of ${pr?.displayName || printer} applies when you print. Paper, copies, sides and colour are set here.`, 'info');
    else await go(true);
  };
  const savePdf = async () => {
    if (!pages.length) return;
    p.save(keep());
    const to = await gcc.saveDialog({ title: 'Save as PDF (as it would print)', name: doc.name.replace(/\.pdf$/i, '') + ' (print).pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!to) return;
    stop.current = false;
    try {
      step('Making the PDF…');
      const m = await make(true);
      if (!m) { setBusy(null); return; }
      await gcc.commit(m.path, to);
      p.close();
      p.toast('Saved.', 'ok', { label: 'Show', run: () => void gcc.showInFolder(to) });
    } catch (e) { setBusy(null); p.fail(e); }
  };

  const seg = <T extends string>(v: T, set: (x: T) => void, items: [T, string, string?][]) => (
    <div className="seg full">{items.map(([k, label, title]) => <button key={k} title={title} className={v === k ? 'on' : ''} onClick={() => set(k)}>{label}</button>)}</div>
  );
  const pr = printers?.find((x) => x.name === printer);

  return (
    <Modal title="Print" wide="xl" className="printdlg" onClose={() => { if (!busy) p.close(); }}
      actions={<>
        <button className="btn" disabled={!!busy} onClick={() => void savePdf()} title="Save these sheets as a PDF file instead of printing"><Ico n="save" size={14} /> Save as PDF…</button>
        <button className="btn" disabled={!!busy || !printers?.length || !printer} onClick={() => void prefs()} title={`The preferences of ${pr?.displayName || 'the printer picked'}: tray, quality, stapling… (kept for that printer). Paper, copies, sides and colour are set here.`}>Printer preferences…</button>
        <span className="grow" />
        <button className="btn" disabled={!!busy && !/into a picture|Putting the sheets/.test(busy)} onClick={() => { if (busy) { stop.current = true; setBusy('Stopping…'); return; } p.close(); }}>Cancel</button>
        <button className="btn primary" disabled={!!busy || !pages.length || !printers?.length} onClick={() => void go(false)}><Ico n="print" size={14} /> Print</button>
      </>}>
      <div className="pd">
        <div className="pd-set">
          <section>
            <h4>Printer</h4>
            <select className="input" value={printer} disabled={!printers?.length} onChange={(e) => setPrinter(e.target.value)}>
              {printers === null && <option>Looking for printers…</option>}
              {printers?.length === 0 && <option>No printers found</option>}
              {printers?.map((x) => <option key={x.name} value={x.name}>{x.displayName}{x.isDefault ? '  (default)' : ''}</option>)}
            </select>
            {pr?.description && <div className="faint small">{pr.description}</div>}
            <div className="pd-row">
              <label>Copies</label>
              <NumIn className="input num" min={1} max={999} int value={copies} onChange={setCopies} />
              {copies > 1 && <label className="check"><input type="checkbox" checked={collate} onChange={(e) => setCollate(e.target.checked)} /> Collate</label>}
            </div>
          </section>

          <section>
            <h4>Pages</h4>
            {seg<Which>(which, setWhich, [
              ['all', `All ${n}`],
              ['current', 'This page', `Page ${p.page + 1}`],
              ['view', 'What\'s in view', 'Only the part of this page on screen, enlarged to the paper'],
              ...(p.area ? [['area', 'The marked area', 'Only the area marked with the Snapshot tool, enlarged to the paper'] as [Which, string, string]] : []),
              ...(p.pageSel.length > 1 ? [['selected', `Selected ${p.pageSel.length}`, 'The pages selected in the Pages panel'] as [Which, string, string]] : []),
              ['range', 'Pages…'],
            ])}
            {which === 'range' && <input className="input" autoFocus placeholder="e.g. 1-5, 8, 11-" value={range} onChange={(e) => setRange(e.target.value)} />}
            {which === 'view' && !view && <div className="warn small">This page isn't on screen – scroll to it first.</div>}
            {(which === 'all' || which === 'range' || which === 'selected') && (
              <div className="pd-row">
                <select className="input" value={subset} onChange={(e) => setSubset(e.target.value as 'all' | 'odd' | 'even')}>
                  <option value="all">All of them</option><option value="odd">Odd pages only</option><option value="even">Even pages only</option>
                </select>
                <label className="check"><input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} /> Reverse order</label>
              </div>
            )}
            <div className="pd-row">
              <label>Print</label>
              {seg<'y' | 'n'>(markups ? 'y' : 'n', (v) => setMarkups(v === 'y'), [['y', 'Document and markups'], ['n', 'Document only', 'Leaves comments and markups out (form fields still print)']])}
            </div>
          </section>

          <section>
            <h4>Paper and size</h4>
            <div className="pd-row">
              <label>Paper</label>
              <select className="input" value={paper} onChange={(e) => setPaper(e.target.value)}>
                {PAPERS.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
                <option value="page">Same as each page{pageSize ? ` (${pageSize})` : ''}</option>
              </select>
            </div>
            {paper !== 'page' && (
              <>
                <div className="pd-row"><label>Orientation</label>{seg(orient, setOrient, [['auto', 'Auto', 'Turns the paper to suit each page'], ['portrait', 'Portrait'], ['landscape', 'Landscape']])}</div>
                <div className="pd-row"><label>Size</label>{seg(scale, setScale, [['fit', 'Fit', 'Fills the paper (inside the margin)'], ['actual', 'Actual size', '100 % - drawings stay to scale; may run off the paper'], ['shrink', 'Shrink large', 'Only pages bigger than the paper are made smaller'], ['custom', '%']])}</div>
                {scale === 'custom' && <div className="pd-row"><label>Scale</label><NumIn className="input num" min={1} max={1000} value={pct} onChange={setPct} /> %</div>}
                {(scale === 'fit' || scale === 'shrink') && <div className="pd-row"><label>Margin</label><NumIn className="input num" min={0} max={50} step={1} value={marginMm} onChange={setMarginMm} /> mm</div>}
              </>
            )}
          </section>

          <section>
            <h4>Output</h4>
            <div className="pd-row"><label>Send as</label>{seg(send, setSend, [
              ['auto', 'Auto', 'Sheets heavy for a printer - big scans, dense drawings - go as one picture each (much quicker to print); the rest exactly as they are'],
              ['vector', 'As they are', 'Every sheet exactly as it is: sharpest, but big scans and dense drawings can take a long time to print'],
              ['picture', 'Pictures', 'Every sheet as one picture (300 dpi): quickest for printers, text a touch less sharp (Save as PDF too)'],
            ])}</div>
            <div className="pd-row"><label>Colour</label>{seg<'c' | 'g'>(color ? 'c' : 'g', (v) => setColor(v === 'c'), [['c', 'Colour'], ['g', 'Black & white']])}</div>
            {/* (black & white is the printer's: the preview shows it, a PDF saved here keeps its colours
                - only sheets sent as pictures are made grey) */}
            {!color && <div className="pd-row"><label /><span className="faint small">{send === 'picture' ? 'Save as PDF makes grey pictures of the sheets too.' : 'The printer prints in black & white; Save as PDF keeps the colours.'}</span></div>}
            <div className="pd-row">
              <label>Sides</label>
              <select className="input" value={duplex} onChange={(e) => setDuplex(e.target.value as typeof duplex)}>
                <option value="simplex">One-sided</option><option value="longEdge">Two-sided, flip on long edge</option><option value="shortEdge">Two-sided, flip on short edge</option>
              </select>
            </div>
          </section>
        </div>

        <div className="pd-prev">
          <div className="pd-stage" ref={box}>
            {busy ? <div className="prog"><span className="dot busy" /> {busy}{since && Date.now() - since > 2500 ? <span className="faint"> {secs(Date.now() - since)}</span> : null}</div>
              : pages.length ? <canvas ref={cv} className="pd-sheet" style={{ width: pv.w, height: pv.h }} /> : <div className="faint">No pages to print.</div>}
          </div>
          <div className="pd-nav">
            <button className="btn sm icon" disabled={sheet <= 0} onClick={() => setSheet(sheet - 1)} title="Previous sheet"><span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Ico n="chevr" size={14} /></span></button>
            <span>{pages.length ? `Sheet ${sheet + 1} of ${pages.length}` : '–'}{cur != null ? ` · page ${cur + 1}` : ''}</span>
            <button className="btn sm icon" disabled={sheet >= pages.length - 1} onClick={() => setSheet(sheet + 1)} title="Next sheet"><Ico n="chevr" size={14} /></button>
          </div>
          {L && <div className="pd-info">
            {pageSize || `${Math.round(doc.pages[cur!].w / MM)} × ${Math.round(doc.pages[cur!].h / MM)} mm`} page on {sheetName}{L.W > L.H ? ' landscape' : ''} at <b>{Math.round(L.k * 100)} %</b>
            {clipped && <span className="warn"> – larger than the paper: the edges are cut off</span>}
            {Math.abs(L.k - 1) > 0.005 && <span className="faint"> · drawn scales no longer apply</span>}
          </div>}
          {copies > 1 && pages.length > 0 && <div className="faint small">{copies} copies{collate ? ', collated' : ''} – {paperSheets(pages.length, copies, collate, duplex !== 'simplex')} sheets of paper{duplex !== 'simplex' ? ' (two-sided)' : ''}</div>}
          {!pages.length && which === 'range' && <div className="warn small">Type the pages to print, e.g. 1-5, 8.</div>}
          <div className="faint small">Range: {pages.length ? toRanges([...pages].sort((a, b) => a - b)) : '–'}</div>
        </div>
      </div>
    </Modal>
  );
}
