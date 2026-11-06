// Export the open PDF to Word or Excel: pages are read in the batch engine; scanned pages
// are read here first (OCR) and their words handed over; the finished file is saved where
// the user chose.
import { useRef, useState } from 'react';
import { Modal, type Toast } from './Modal';
import { gcc, baseName, dirName, joinPath } from './api';
import { mu, muBatch, muBatchFile } from './engines';
import { fileArg, type FileRef } from '../engine/rpc';
import { ocrPagesFull, ocrPageFull, type OcrLang } from './ocr';
import type { PdfDoc } from './doc';
import type { Settings } from './App';
import { parseRanges } from './Dialogs';

export type ExportFormat = 'docx' | 'xlsx';
interface FileSpec { path: string; size?: number; delta?: string; mtime?: number }

interface Props {
  doc: PdfDoc;
  format: ExportFormat;
  settings: Settings;
  saveSettings(p: Partial<Settings>): void;
  close(): void;
  toast(t: string, k?: Toast['kind'], a?: Toast['action'], ms?: number): number;
  fail(e: unknown): void;
  /** the Table to Excel tool instead (one table off a big drawing) */
  pickArea?(): void;
}

/** the export running now (the window asks before closing its file or quitting) */
export const exportRunning: { docId: string | null; stop: (() => void) | null } = { docId: null, stop: null };

/**
 * One box on one page to an Excel file (the Table to Excel tool: a table lost on a big drawing):
 * read the way Export to Excel reads a page - ruled tables, numbers as numbers, merged headings -
 * but only what lies in the box. A scanned page is read with OCR first.
 */
export async function exportArea(doc: PdfDoc, page: number, box: number[], target: string, lang: OcrLang, say: (t: string) => void): Promise<{ scan: boolean; words: number }> {
  const id = 'area-' + Math.random().toString(36).slice(2);
  let running = false;
  let made: string | null = null;
  let snap: string | null = null;
  try {
    say('Reading the area…');
    const src = await mu<FileSpec>('drawSnapshot', doc.id, false);
    snap = src.delta || src.path;
    const b = box.map((v) => Math.round(v * 100) / 100) as [number, number, number, number];
    await muBatch('exportBegin', id, fileArg(src.path, { size: src.size, delta: src.delta, mtime: src.mtime }), doc.password, { format: 'xlsx', sheets: 'joined', dropStamps: true, title: doc.name.replace(/\.pdf$/i, ''), region: { page, box: b } });
    running = true;
    const r = await muBatch<{ kind: string; words: number }>('exportRead', id, page);
    let words = r.words;
    const scan = r.kind === 'scan' && !r.words;
    if (scan) {
      // (just the box, at full sharpness - the whole of an A0 sheet would take minutes and be read
      // coarser: past 7,000 dots the page is read at less than 300 dpi)
      say('The page is a scan – reading the area (OCR)…');
      const o = await ocrPageFull(doc.id, page, doc.pages[page].w, doc.pages[page].h, { lang, rect: box });
      words = (await muBatch<{ words: number }>('exportOcr', id, page, { words: o.words.map((w) => ({ text: w.text, box: w.box, conf: w.conf })), angle: o.angle })).words;
    }
    say('Writing the Excel file…');
    const out = await muBatchFile<FileRef>('exportFinish', id);
    running = false;
    made = out.$file.path;
    await gcc.commit(made, target, { noBackup: true });
    made = null;
    return { scan, words };
  } finally {
    if (running) await muBatch('exportEnd', id).catch(() => {});
    if (made) void gcc.dropTemp([made]);
    if (snap) void gcc.dropTemp([snap]).catch(() => {});
  }
}

const fmtLeft = (ms: number) =>(ms < 60_000 ? `${Math.max(5, Math.round(ms / 5000) * 5)} s` : `${Math.round(ms / 60_000)} min`);

export function ExportDlg(p: Props) {
  const doc = p.doc;
  const ex = p.settings.export || {};
  const [format, setFormat] = useState<ExportFormat>(p.format);
  const [which, setWhich] = useState<'all' | 'range'>('all');
  const [range, setRange] = useState('');
  const [sheets, setSheets] = useState<'joined' | 'pages'>(ex.sheets || 'joined');
  const [ocr, setOcr] = useState(ex.ocr ?? true);
  const [stamps, setStamps] = useState(ex.dropStamps ?? true);
  const [openAfter, setOpenAfter] = useState(ex.open ?? true);
  const [lang, setLang] = useState<OcrLang>(p.settings.ocrLang || 'eng+ara');
  const [prog, setProg] = useState<{ text: string; pct: number } | null>(null);
  const [err, setErr] = useState('');
  const stop = useRef(false);
  const job = useRef('');

  const pages = which === 'all' ? [...doc.pages.keys()] : parseRanges(range, doc.pages.length);
  const ext = format === 'docx' ? 'docx' : 'xlsx';
  const what = format === 'docx' ? 'Word' : 'Excel';

  const go = async () => {
    setErr('');
    const n = doc.pages.length;
    if (!pages.length) { setErr(`Which pages? This file has ${n} page${n === 1 ? '' : 's'} – for example 1-${Math.min(n, 5)}${n > 6 ? ', ' + n : ''}.`); return; }
    p.saveSettings({ export: { sheets, ocr, dropStamps: stamps, open: openAfter }, ocrLang: lang });
    const base = doc.name.replace(/\.pdf$/i, '');
    let target = await gcc.saveDialog({ title: `Export to ${what}`, name: base + '.' + ext, path: doc.path ? joinPath(dirName(doc.path), base + '.' + ext) : undefined, filters: [{ name: what, extensions: [ext] }] });
    if (!target) return;
    // a Word file is a .docx, an Excel file a .xlsx - whatever was typed ("x.pdf" would overwrite a PDF)
    if (!new RegExp('\\.' + ext + '$', 'i').test(target)) target = /\.(pdf|docx?|xlsx?|csv)$/i.test(target) ? target.replace(/\.[^.\\/]+$/, '.' + ext) : target + '.' + ext;
    if (doc.path && target.toLowerCase() === doc.path.toLowerCase()) { setErr('That is the PDF itself – choose another name.'); return; }
    stop.current = false;
    exportRunning.docId = doc.id;
    exportRunning.stop = () => { stop.current = true; };
    const id = 'export-' + Math.random().toString(36).slice(2);
    job.current = id;
    let made: string | null = null;
    let snap: string | null = null;
    const t0 = Date.now();
    try {
      setProg({ text: 'Getting ready…', pct: 0 });
      // the file as it is now (unsaved changes included)
      const src = await mu<FileSpec>('drawSnapshot', doc.id, false);
      // (the changes file - or a whole temp copy; the PDF itself is never dropped: main only
      // removes files in the app's temp folder)
      snap = src.delta || src.path;
      await muBatch('exportBegin', id, fileArg(src.path, { size: src.size, delta: src.delta, mtime: src.mtime }), doc.password, { format, sheets, dropStamps: stamps, title: base });
      const scans: number[] = [];
      for (const [k, i] of pages.entries()) {
        if (stop.current) throw new Error('stopped');
        const r = await muBatch<{ kind: string; words: number }>('exportRead', id, i);
        if (r.kind === 'scan' && !r.words) scans.push(i);
        setProg({ text: `Reading page ${k + 1} of ${pages.length}…`, pct: ((k + 1) / pages.length) * (scans.length && ocr ? 0.15 : 0.9) });
      }
      if (scans.length && ocr) {
        let done = 0;
        const tScan = Date.now();
        setProg({ text: `Reading ${scans.length} scanned page${scans.length === 1 ? '' : 's'} (OCR)…`, pct: 0.15 });
        await ocrPagesFull(doc.id, scans.map((i) => ({ i, w: doc.pages[i].w, h: doc.pages[i].h })), lang, async (i, r) => {
          await muBatch('exportOcr', id, i, { words: r.words.map((w) => ({ text: w.text, box: w.box, conf: w.conf })), angle: r.angle });
          done++;
          const each = (Date.now() - tScan) / done;
          const left = scans.length - done;
          setProg({ text: `Read ${done} of ${scans.length} scanned pages${left ? ` – about ${fmtLeft(each * left)} left` : '…'}`, pct: 0.15 + (done / scans.length) * 0.75 });
        }, () => stop.current);
      } else for (const i of scans) await muBatch('exportPicture', id, i);
      if (stop.current) throw new Error('stopped');
      setProg({ text: `Writing the ${what} file…`, pct: 0.93 });
      const out = await muBatchFile<FileRef>('exportFinish', id);
      job.current = '';
      made = out.$file.path;
      // (Stop while the file was being written: nothing is saved)
      if (stop.current) throw new Error('stopped');
      await gcc.commit(made, target, { noBackup: true });
      made = null;
      p.close();
      const secs = Math.round((Date.now() - t0) / 1000);
      const note = scans.length ? (ocr ? ` – ${scans.length} scanned page${scans.length === 1 ? ' was' : 's were'} read with OCR: check the figures` : ` – ${scans.length} scanned page${scans.length === 1 ? '' : 's'} not read`) : '';
      p.toast(`Saved ${baseName(target)}${note}${secs > 20 ? ` (${secs} s)` : ''}`, 'ok', { label: 'Open', run: () => void gcc.openExternal(target) }, 10000);
      if (openAfter) void gcc.openExternal(target).then((msg) => { if (msg) p.toast(`${baseName(target!)} was saved, but Windows has no program to open it (${msg}).`, 'info', undefined, 8000); }).catch(() => {});
    } catch (e) {
      if (String((e as Error)?.message || e) !== 'stopped' && !stop.current) { setErr(String((e as Error)?.message || e)); p.fail(e); }
      setProg(null);
    } finally {
      if (job.current) await muBatch('exportEnd', job.current).catch(() => {});
      job.current = '';
      if (made) void gcc.dropTemp([made]);
      // (the snapshot's changes file was for this export only)
      if (snap) void gcc.dropTemp([snap]).catch(() => {});
      exportRunning.docId = null;
      exportRunning.stop = null;
    }
  };
  const cancel = () => { stop.current = true; if (!prog) p.close(); };
  // a click beside the dialog or Escape closes it - but never stops an export under way (Stop does)
  const dismiss = () => { if (!prog) p.close(); };

  return (
    <Modal title={`Export to ${what}`} onClose={dismiss}
      sub={format === 'docx' ? 'An editable Word document: text in paragraphs, tables as tables, pictures, page headers and page numbers.' : 'A workbook with the tables as real cells – numbers as numbers – ready for pricing and checking.'}
      actions={<><button className="btn" onClick={cancel}>{prog ? 'Stop' : 'Cancel'}</button><button className="btn primary" disabled={!!prog} onClick={() => void go()}>Export…</button></>}>
      {prog ? (
        <div className="xprog">
          <div className="prog"><span className="dot busy" /> {prog.text}</div>
          <div className="bar"><i style={{ width: Math.round(prog.pct * 100) + '%' }} /></div>
        </div>
      ) : (
        <>
          <div className="row"><label>Format</label>
            <div className="seg"><button className={format === 'docx' ? 'on' : ''} onClick={() => setFormat('docx')}>Word (.docx)</button><button className={format === 'xlsx' ? 'on' : ''} onClick={() => setFormat('xlsx')}>Excel (.xlsx)</button></div>
          </div>
          <div className="row"><label>Pages</label>
            <div className="seg"><button className={which === 'all' ? 'on' : ''} onClick={() => setWhich('all')}>All {doc.pages.length}</button><button className={which === 'range' ? 'on' : ''} onClick={() => setWhich('range')}>Some</button></div>
            {which === 'range' && <input className="input" autoFocus placeholder="e.g. 1-5, 9" value={range} onChange={(e) => setRange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} />}
          </div>
          {/* (kept in place for Word too - the dialog doesn't jump when switching) */}
          {(
            <div className="row" style={format === 'xlsx' ? undefined : { visibility: 'hidden' }} aria-hidden={format !== 'xlsx'}><label>Sheets</label>
              <div className="seg"><button className={sheets === 'joined' ? 'on' : ''} onClick={() => setSheets('joined')} title="Tables that run over several pages become one table; page headers, footers and page numbers are left out; a new sheet starts where the page header changes (the next bill)">Join the pages</button><button className={sheets === 'pages' ? 'on' : ''} onClick={() => setSheets('pages')} title="Each page on its own sheet, as it is">One per page</button></div>
            </div>
          )}
          <label className="check"><input type="checkbox" checked={ocr} onChange={(e) => setOcr(e.target.checked)} /> Read scanned pages (OCR)</label>
          {ocr && (
            <div className="row sub"><label>Language</label><select className="input" value={lang} onChange={(e) => setLang(e.target.value as OcrLang)}><option value="eng+ara">English + Arabic</option><option value="eng">English</option><option value="ara">Arabic</option></select></div>
          )}
          {ocr && <label className="check sub"><input type="checkbox" checked={stamps} onChange={(e) => setStamps(e.target.checked)} /> Leave out stamps and handwriting in coloured ink</label>}
          <label className="check"><input type="checkbox" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} /> Open the file when it is done</label>
          <p className="hint">{format === 'xlsx' ? (ocr ? 'Scanned pages are read with OCR: check quantities and amounts against the PDF.' : 'Scanned pages are not read: their sheets stay empty.') : 'Text keeps its fonts, sizes and layout as closely as Word allows; ' + (ocr ? 'scanned pages are read with OCR.' : 'scanned pages go in as pictures.')}</p>
          {format === 'xlsx' && p.pickArea && <p className="hint">Only one table off a big drawing? <button className="link" onClick={() => { p.close(); p.pickArea!(); }}>Drag a box around it</button> – just that area goes to Excel.</p>}
          {err && <p className="hint err">{err}</p>}
        </>
      )}
    </Modal>
  );
}
