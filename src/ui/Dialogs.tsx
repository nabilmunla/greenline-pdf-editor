// All the dialogs.
import { relabel, isAutoLabel, ptsOf } from './relabel';
import { NumIn } from './numin';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, type Toast } from './Modal';
import { Ico } from './icons';
import { gcc, baseName, dirName, joinPath, type AppInfo } from './api';
import { mu, muBatch, muBatchFile, renderers, onEngineRestart } from './engines';
import { fileArg, type FileRef } from '../engine/rpc';
import { orientScale, type PdfDoc, type Scale, type Viewport } from './doc';
import type { Dialog, Settings } from './App';
import { scaleFromCalibration } from './App';
import { STANDARD_SCALES, PT_M, dist, fmtLen, scalesInText, scaleFor, scaleText, measureValue, LEGACY_FMT, inViewport } from './geom';
import { BUILTIN_STAMPS, designSize, type StampDef } from './stamps';
import { StampScanDlg, loadScan, pasteScan, cleanQuick, type ScanSource } from './StampScan';
import { css, hex, fromHex, PALETTE, toolStyle } from './tools';
import { writeXlsx } from './xlsxwrite';
import { excelCell } from './table';
import { ocrPages, ocrLangOf, type OcrLang } from './ocr';
import { parseRanges, toRanges, planOutputs, uniqueNames, typedNumber, pdfDate, type OutMode, type OutPlan } from './dlgutil';
import { UpdatesSection, ReportsRow, WhatsNew, notesOf, noteVersions } from './Updates';
import { PrintDlg } from './PrintDlg';
import { CountTagDlg } from './CountTag';
import { ExportDlg, exportArea } from './ExportDlg';
import { AiKeysDialog } from './AiPanel';
import type { PageMark, StampDesign, RGB, Rect } from '../engine/mu';
import { APP_NAME } from './brand';

interface Props {
  dialog: Dialog;
  setDialog(d: Dialog | null): void;
  doc: PdfDoc | null;
  docs: PdfDoc[];
  settings: Settings;
  saveSettings(p: Partial<Settings>): void;
  A: Record<string, any>;
  toast(t: string, k?: Toast['kind'], a?: Toast['action'], ms?: number): number;
  busy<T>(label: string, fn: (set: (t: string) => void) => Promise<T>): Promise<T | undefined>;
  fail(e: unknown): void;
  passwordEntered(pw: string): Promise<void>;
  author: string;
  useStamp(s: StampDef): void;
  useSignature(s: { image: string; w: number; h: number }): void;
  newFromFile(file: string, name: string, temp?: boolean): Promise<PdfDoc>;
  info: AppInfo | null;
  pageSel: number[];
}

export function Dialogs(p: Props) {
  const close = () => p.setDialog(null);
  const d = p.dialog;
  switch (d.k) {
    case 'password': return <PasswordDlg name={baseName(d.path)} err={d.err} onOk={(pw) => void p.passwordEntered(pw)} onClose={close} />;
    case 'calibrate': return <CalibrateDlg {...p} page={d.page} a={d.a} b={d.b} />;
    case 'scale': return <ScaleDlg {...p} page={d.page} />;
    case 'viewport': return <ViewportDlg {...p} page={d.page} rect={d.rect} />;
    case 'stamps': return <StampsDlg {...p} scan0={d.scan} />;
    case 'copypages': return <CopyPagesDlg {...p} items={d.items} />;
    case 'signature': return <SignatureDlg {...p} />;
    case 'merge': return <MergeDlg key={(d.files || []).join('|')} {...p} files={d.files} />;
    case 'split': return <SplitDlg {...p} />;
    case 'extract': return <ExtractDlg {...p} />;
    case 'toPictures': return p.doc ? <ToPicturesDlg {...p} /> : null;
    case 'link': return p.doc ? <LinkDlg {...p} page={d.page} rect={d.rect} edit={d.edit} /> : null;
    case 'fromPictures': return <FromPicturesDlg {...p} files={d.files} />;
    case 'insert': return <InsertDlg {...p} at={d.at} mode={d.mode} />;
    case 'compress': return <CompressDlg {...p} files={d.files} />;
    case 'marks': return <MarksDlg {...p} batch={d.batch} />;
    case 'protect': return <ProtectDlg {...p} />;
    case 'ocr': return <OcrDlg {...p} />;
    case 'batch-ocr': return <BatchOcrDlg {...p} />;
    case 'batch-flatten': return <BatchFlattenDlg {...p} />;
    case 'redact-search': return <RedactSearchDlg {...p} />;
    case 'props': return <PropsDlg {...p} />;
    case 'counttag': return p.doc ? <CountTagDlg doc={p.doc} page={d.page} style={p.settings.styles?.['m-count']} close={close} toast={p.toast} fail={p.fail} setCountGroup={(g) => p.A.setCounting(g)} showTotals={() => p.A.totals()} /> : null;
    case 'print': return p.doc ? <PrintDlg doc={p.doc} page={d.page} area={d.area} pageSel={p.pageSel} settings={p.settings.print || {}} save={(s) => p.saveSettings({ print: s })} close={close} toast={p.toast} fail={p.fail} /> : null;
    case 'settings': return <SettingsDlg {...p} />;
    case 'whatsnew': return <WhatsNewDlg {...p} back={!!d.back} />;
    case 'licences': return <LicencesDlg onClose={() => p.setDialog({ k: 'settings' })} />;
    case 'report': return <ReportDlg {...p} shot={d.shot} />;
    case 'ai-keys': return <AiKeysDialog onClose={close} />;
    case 'crop': return <CropDlg {...p} page={d.page} rect={d.rect} />;
    case 'table': return <TableDlg {...p} rows={d.rows} page={d.page} rect={d.rect} docId={d.docId} />;
    case 'export': return p.doc ? <ExportDlg doc={p.doc} format={d.format} settings={p.settings} saveSettings={p.saveSettings} close={close} toast={p.toast} fail={p.fail} pickArea={() => p.A.tableArea()} /> : null;
    case 'about': return <Modal title={APP_NAME} onClose={close} sub={`Version ${p.info?.version}`} actions={<button className="btn primary" onClick={close}>Close</button>}><p className="hint">PDF engines: PDFium (Apache-2.0) for drawing, MuPDF (AGPL-3.0) for editing, Tesseract (Apache-2.0) for OCR. Everything runs on this PC.</p></Modal>;
  }
  return null;
}

// ---------------------------------------------------------------- helpers

// (page lists: dlgutil.ts - still found here by the other dialogs)
export { parseRanges, toRanges };

const sizeTxt = (b: number) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');

async function pickPdfs(title = 'Choose PDF files'): Promise<string[]> { return gcc.openDialog({ title }); }
async function pickFolderPdfs(): Promise<string[]> {
  const d = await gcc.dirDialog({ title: 'Choose a folder (PDFs in it and its sub-folders)' });
  return d ? gcc.listPdfs(d, true) : [];
}
/** pictures a PDF can be made of */
export const PICTURE_RE = /\.(jpe?g|jfif|png|tiff?|bmp|gif)$/i;
const PICTURE_FILTERS = [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'jfif', 'png', 'tif', 'tiff', 'bmp', 'gif'] }, { name: 'All files', extensions: ['*'] }];
async function pickPictures(): Promise<string[]> { return (await gcc.openDialog({ title: 'Choose pictures or scans', filters: PICTURE_FILTERS })).filter((f) => PICTURE_RE.test(f)); }
async function pickFolderPictures(): Promise<string[]> {
  const d = await gcc.dirDialog({ title: 'Choose a folder (the pictures in it)' });
  return d ? gcc.listPdfs(d, false, 'pictures') : [];
}

/** locked: a job is running through the list - it can't be changed under it (a file removed
 *  from the list was still processed, and replaced, with its row gone) */
function FileList({ files, setFiles, extra, locked, pictures }: { files: string[]; setFiles(f: string[]): void; extra?: (f: string, i: number) => React.ReactNode; locked?: boolean; pictures?: boolean }) {
  const pick = pictures ? pickPictures : () => pickPdfs();
  const pickDir = pictures ? pickFolderPictures : pickFolderPdfs;
  const move = (i: number, d: number) => { const f = files.slice(); const [x] = f.splice(i, 1); f.splice(Math.max(0, Math.min(f.length, i + d)), 0, x); setFiles(f); };
  return (
    <div className="flist">
      <div className="flist-tools">
        <button className="btn sm" disabled={locked} onClick={async () => setFiles([...files, ...(await pick()).filter((f) => !files.includes(f))])}><Ico n="plus" size={14} /> {pictures ? 'Add pictures' : 'Add files'}</button>
        <button className="btn sm" disabled={locked} onClick={async () => setFiles([...files, ...(await pickDir()).filter((f) => !files.includes(f))])}><Ico n="folder" size={14} /> Add folder</button>
        <button className="btn sm ghost" disabled={locked || files.length < 2} onClick={() => setFiles(files.slice().sort((a, b) => baseName(a).localeCompare(baseName(b), undefined, { numeric: true })))}>Sort A–Z</button>
        <span className="grow" />
        <span className="faint">{files.length} file{files.length === 1 ? '' : 's'}</span>
        {files.length > 0 && <button className="btn sm ghost" disabled={locked} onClick={() => setFiles([])}>Clear</button>}
      </div>
      <div className="flist-rows">
        {files.length === 0 && <div className="faint pad">{pictures ? 'No pictures yet – add pictures or a folder of them. You can also drop them here.' : 'No files yet – add files or a whole folder. You can also drop PDFs here.'}</div>}
        {files.map((f, i) => (
          <div key={f} className="frow">
            <span className="fi">{i + 1}</span>
            <span className="grow fn" title={f}>{baseName(f)}<span className="faint"> · {dirName(f)}</span></span>
            {extra?.(f, i)}
            <button className="btn sm icon ghost" title="Up" disabled={locked || i === 0} onClick={() => move(i, -1)}>↑</button>
            <button className="btn sm icon ghost" title="Down" disabled={locked || i === files.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button className="btn sm icon ghost" title="Remove" disabled={locked} onClick={() => setFiles(files.filter((x) => x !== f))}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** files dropped on the window while a dialog with a file list is open go into the list; the
 *  others dropped with them are named (they were dropped without a word) */
function useDropFiles(add: (f: string[]) => void, re: RegExp = /\.pdf$/i, say?: (text: string) => void) {
  useEffect(() => {
    const drop = (e: DragEvent) => {
      if (!document.querySelector('.flist')) return;
      const all = Array.from(e.dataTransfer?.files || []).map((f) => gcc.pathOf(f)).filter(Boolean);
      const paths = all.filter((x) => re.test(x));
      if (!paths.length) return;
      e.preventDefault(); e.stopImmediatePropagation();
      add(paths);
      const left = all.filter((x) => !re.test(x));
      if (left.length && say) say(`Not added: ${left.slice(0, 3).map(baseName).join(', ')}${left.length > 3 ? ` and ${left.length - 3} more` : ''} – this list takes ${re === PICTURE_RE ? 'pictures' : 'PDF files'} only.`);
    };
    window.addEventListener('drop', drop, true);
    return () => window.removeEventListener('drop', drop, true);
  }, [add, re, say]);
}

function OutputChoice({ mode, setMode, suffix, setSuffix, folder, setFolder, allowReplace, locked, problem }: { mode: OutMode; setMode(m: OutMode): void; suffix: string; setSuffix(s: string): void; folder: string; setFolder(f: string): void; allowReplace?: boolean; locked?: boolean; problem?: string | null }) {
  return (
    <div className="outc">
      <label className="check"><input type="radio" disabled={locked} checked={mode === 'suffix'} onChange={() => setMode('suffix')} /> Next to each original, adding <input className="input xs suf" disabled={locked} value={suffix} onChange={(e) => setSuffix(e.target.value)} /> to the name</label>
      <label className="check"><input type="radio" disabled={locked} checked={mode === 'folder'} onChange={() => setMode('folder')} /> Into a folder:
        <button className="btn sm" disabled={locked} onClick={async () => { const d = await gcc.dirDialog({ title: 'Save the new files in…' }); if (d) { setFolder(d); setMode('folder'); } }}>{folder ? baseName(folder) : 'Choose…'}</button>
      </label>
      {allowReplace && <label className="check"><input type="radio" disabled={locked} checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace the originals (a backup copy is kept)</label>}
      {problem && <p className="hint err">{problem}</p>}
    </div>
  );
}
/** where each result goes (planOutputs: never over an original unless "Replace" was chosen, nor
 *  over a file open in this window) */
const planFor = (p: Props, files: string[], mode: OutMode, suffix: string, folder: string): OutPlan =>
  planOutputs(files, mode, suffix, folder, p.docs.map((d) => d.path).filter((x): x is string => !!x));
/** new files that would replace files already there (other than the originals, which "Replace
 *  the originals" backs up): asked once, for all of them, before anything is written */
async function okToReplace(targets: string[]): Promise<boolean> {
  const there: string[] = [];
  for (const t of targets) if (await gcc.exists(t).catch(() => false)) there.push(t);
  if (!there.length) return true;
  const r = await gcc.confirm({
    message: there.length === 1 ? `“${baseName(there[0])}” is already there` : `${there.length} of the new files are already there`,
    detail: there.slice(0, 8).map((t) => '• ' + baseName(t)).join('\n') + (there.length > 8 ? `\n…and ${there.length - 8} more` : '') + (there.length === 1 ? '\n\nReplace it? The file there now is not kept.' : '\n\nReplace them? The files there now are not kept.'),
    buttons: ['Replace', 'Cancel'], type: 'warning',
  });
  return r === 0;
}
/** before a batch job writes anything: where each result goes (rows left out say why), and
 *  "replace them?" asked once - null: nothing starts */
async function startPlan(p: Props, files: string[], mode: OutMode, suffix: string, folder: string, setRes: (r: Record<string, string>) => void): Promise<OutPlan | null> {
  // (and the files open in the app's other windows)
  const elsewhere = await gcc.tabsElsewhere().catch(() => [] as string[]);
  const pl = planOutputs(files, mode, suffix, folder, [...p.docs.map((d) => d.path).filter((x): x is string => !!x), ...elsewhere]);
  if (pl.problem) { p.toast(pl.problem, 'err'); return null; }
  if (mode !== 'replace' && !(await okToReplace([...pl.out.values()]))) return null;
  setRes(Object.fromEntries([...pl.skip].map(([f, why]) => [f, 'left out: ' + why])));
  return pl;
}

// ---------------------------------------------------------------- password

function PasswordDlg({ name, err, onOk, onClose }: { name: string; err?: string; onOk(pw: string): void; onClose(): void }) {
  const [v, setV] = useState('');
  return (
    <Modal title="Password needed" sub={<>“{name}” is protected. Type its open password.</>} onClose={onClose}
      actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onOk(v)}>Open</button></>}>
      {err && <p className="err">{err}</p>}
      <input className="input" type="password" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onOk(v)} />
    </Modal>
  );
}

// ---------------------------------------------------------------- scale

/** the scale at a point of a page under these settings of the file (as doc.scaleAt) */
function scaleIn(data: PdfDoc['data'], rot: number, page: number, x: number, y: number, pg?: { w: number; h: number; rot: number }): Scale | null {
  for (const v of data.viewports?.[String(page)] || []) if (inViewport(v, x, y, pg)) return orientScale(v.scale, rot);
  return orientScale(data.scales?.[String(page)] ?? data.scales?.['*'] ?? null, rot);
}

/**
 * Change the file's scales or viewports. Measurements already drawn whose number was worked
 * out at the old scale get the new scale's number, in the same undo step (else the sheet, the
 * Excel export and the status bar disagree, and the old number then looks typed by hand); a
 * number someone typed stays. The change is shown at once (picking across, then up-down builds
 * on it) but taken back, and said, if the file can't take it - not left on screen unsaved.
 * Returns how many measurements changed (null: failed).
 */
function setScales(p: Props, patch: Partial<PdfDoc['data']>, name: string): Promise<number | null> {
  const doc = p.doc!;
  const before = doc.data;
  const after = { ...before, ...patch };
  doc.data = after;
  // (one after the other: the up-down (Y) step finds the numbers the across (X) step wrote)
  const run = scaleJob.then(async () => {
    try {
      const items: { page: number; id: number; patch: { contents: string; autoLabel?: boolean } }[] = [];
      for (const a of await doc.allAnnots()) {
        if (!a.kind?.startsWith('measure-') || a.kind === 'measure-count' || a.locked || !a.contents?.trim()) continue;
        const pts = (a.vertices || a.line || []) as [number, number][];
        if (!pts.length) continue;
        const rot = doc.pages[a.page]?.rot ?? 0;
        const fmt = a.fmt ?? LEGACY_FMT;
        const now = measureValue(a.kind, pts, scaleIn(after, rot, a.page, pts[0][0], pts[0][1], doc.pages[a.page]), fmt);
        // the app's own number (marked so, or the number at the old scale - to its last digit: the
        // corners are kept as 32-bit numbers, and a last digit off made it count as typed by hand)
        if (now && now !== a.contents.trim() && isAutoLabel(a, scaleIn(before, rot, a.page, pts[0][0], pts[0][1], doc.pages[a.page]))) items.push({ page: a.page, id: a.id, patch: { contents: now, autoLabel: true } });
      }
      await doc.update(items, name, patch);
      return items.length;
    } catch (e) {
      if (doc.data === after) { doc.data = before; doc.emit(); }
      p.fail(e);
      return null;
    }
  });
  scaleJob = run;
  return run;
}
let scaleJob: Promise<unknown> = Promise.resolve();
/** scale changes still being written (closing or saving waits for them: the dialog closes at once) */
export const scalesWritten = () => scaleJob.then(() => {}, () => {});

/**
 * Set a scale. `make` builds it from a page's current one: across (X) or up-down (Y) only keeps
 * each page's own other direction. Each entry remembers the page's turn (see orientScale).
 */
function applyScale(p: Props, page: number, make: (cur: Scale | null) => Scale, where: 'page' | 'all' | 'pages', both: boolean) {
  const doc = p.doc!;
  const scales = { ...(doc.data.scales || {}) };
  const rotOf = (k: string) => doc.pages[k === '*' ? page : Number(k)]?.rot ?? 0;
  const mk = (k: string, cur: Scale | null): Scale => ({ ...make(cur), rot: rotOf(k) });
  if (where === 'all') {
    if (both) { for (const k of Object.keys(scales)) delete scales[k]; scales['*'] = mk('*', null); }
    else {
      // across / up-down only, all pages: each page gets its own (pages may be turned differently -
      // "across" is across each page as shown); '*' (pages added later) keeps no turn
      const base = scales['*'] ?? null;
      for (let i = 0; i < doc.pages.length; i++) scales[String(i)] = mk(String(i), orientScale(scales[String(i)] ?? base, rotOf(String(i))));
      const star = make(base);
      delete star.rot;
      scales['*'] = star;
    }
  } else {
    for (const i of where === 'pages' && p.pageSel.length ? p.pageSel : [page]) scales[String(i)] = mk(String(i), doc.scaleAt(i));
  }
  const now = orientScale(scales[String(page)] ?? scales['*'] ?? null, rotOf(String(page)));
  const msg = `Scale ${now ? scaleText(now) : ''} set for ${where === 'all' ? 'all pages' : where === 'pages' ? p.pageSel.length + ' pages' : 'page ' + (page + 1)}`;
  void setScales(p, { scales }, 'Set scale').then((n) => { if (n !== null) p.toast(msg + (n ? ` – ${n} measurement${n === 1 ? '' : 's'} updated.` : '.'), 'ok'); });
}
/** Calibrate across (X) done: the next calibration of that file is for up-down (Y), for the same
 *  pages (a calibration much later, or in another file, starts afresh) */
let calibrateNext: { dir: Dir; where: 'page' | 'all' | 'pages'; doc: string; at: number } | null = null;

/** a scale for both directions, or only across (X) / up and down (Y) - drawings stretched one way */
type Dir = 'both' | 'x' | 'y';
function DirChoice({ dir, setDir, hint }: { dir: Dir; setDir(d: Dir): void; hint: string }) {
  return (
    <div className="row"><label>Direction</label>
      <div className="seg">
        <button className={dir === 'both' ? 'on' : ''} onClick={() => setDir('both')}>Both ways</button>
        <button className={dir === 'x' ? 'on' : ''} title="Across the page only" onClick={() => setDir('x')}>Across (X)</button>
        <button className={dir === 'y' ? 'on' : ''} title="Up and down the page only" onClick={() => setDir('y')}>Up-down (Y)</button>
      </div>
      {dir !== 'both' && <p className="hint">{hint}</p>}
    </div>
  );
}

function CalibrateDlg(p: Props & { page: number; a: [number, number]; b: [number, number] }) {
  const doc = p.doc!;
  const cur = doc.scaleAt(p.page);
  const [real, setReal] = useState('');
  const [unit, setUnit] = useState('m');
  // the up-down (Y) step after calibrating across (X) in this file: same pages as the X step
  const [next] = useState(() => { const n = calibrateNext; calibrateNext = null; return n && n.doc === doc.id && Date.now() - n.at < 10 * 60e3 ? n : null; });
  const [where, setWhere] = useState<'page' | 'all' | 'pages'>(next && !(next.where === 'pages' && p.pageSel.length < 2) ? next.where : 'page');
  // (a line drawn mostly across suggests X, mostly up-down Y - only when the page already has
  // separate scales; otherwise both ways)
  const dx = Math.abs(p.b[0] - p.a[0]), dy = Math.abs(p.b[1] - p.a[1]);
  const [dir, setDir] = useState<Dir>(() => next?.dir ?? (cur?.ky ? (dx >= dy ? 'x' : 'y') : 'both'));
  const along = dir === 'x' ? dx : dir === 'y' ? dy : dist(p.a, p.b);
  const tooSlanted = dir !== 'both' && along < 0.5 * dist(p.a, p.b);
  const paperMm = (along / 72) * 25.4;
  // ("6,5" is 6.5 - not 6; "Infinity" and the like are refused)
  const len = typedNumber(real, 0, 1e7);
  const ok = () => {
    if (len === null || tooSlanted) return;
    const pick = scaleFromCalibration([0, 0], [along, 0], len, unit);
    applyScale(p, p.page, (c) => scaleFor(c, pick, dir), where, dir === 'both');
    p.setDialog(null);
    p.A.setTool(dir === 'x' ? 'm-calibrate' : 'm-length');
    if (dir === 'x') { calibrateNext = { dir: 'y', where, doc: doc.id, at: Date.now() }; p.toast('Across (X) set. Now calibrate up-down (Y): draw a known vertical dimension.', 'info', undefined, 8000); }
  };
  return (
    <Modal title="Calibrate" see sub={<>The line you drew is {paperMm.toFixed(1)} mm on paper{dir === 'x' ? ' across' : dir === 'y' ? ' up-down' : ''}. How long is it really?</>} onClose={() => p.setDialog(null)}
      actions={<><button className="btn" onClick={() => p.setDialog(null)}>Cancel</button><button className="btn primary" onClick={ok} disabled={len === null || tooSlanted}>Set scale</button></>}>
      <div className="row"><label>Real length</label>
        <div className="hrow"><input className="input" autoFocus value={real} onChange={(e) => setReal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok()} placeholder="e.g. 6.5" />
          <select className="input" style={{ width: 90 }} value={unit} onChange={(e) => setUnit(e.target.value)}><option>m</option><option>mm</option><option>cm</option><option>ft</option><option>in</option></select></div>
        {/* (a comma can be a decimal or a thousands one: what was understood is said) */}
        {/,/.test(real) && len !== null && <p className="hint">Read as {len.toLocaleString('en-GB', { maximumFractionDigits: 6 })} {unit}.</p>}
      </div>
      <DirChoice dir={dir} setDir={setDir} hint={tooSlanted ? `This line runs mostly ${dir === 'x' ? 'up-down' : 'across'} - draw a ${dir === 'x' ? 'horizontal' : 'vertical'} dimension for this.` : dir === 'x' ? 'Only the scale across the page is set; up-down stays as it is.' : cur ? 'Only the scale up and down the page is set; across stays as it is.' : 'No scale yet: this one is used both ways until you set across (X).'} />
      <WhereChoice where={where} setWhere={setWhere} hasSel={p.pageSel.length > 1} />
    </Modal>
  );
}

function WhereChoice({ where, setWhere, hasSel }: { where: 'page' | 'all' | 'pages'; setWhere(w: 'page' | 'all' | 'pages'): void; hasSel: boolean }) {
  return (
    <div className="row"><label>Use it for</label>
      <div className="seg">
        <button className={where === 'page' ? 'on' : ''} onClick={() => setWhere('page')}>This page</button>
        {hasSel && <button className={where === 'pages' ? 'on' : ''} onClick={() => setWhere('pages')}>Selected pages</button>}
        <button className={where === 'all' ? 'on' : ''} onClick={() => setWhere('all')}>All pages</button>
      </div>
    </div>
  );
}

function ScaleDlg(p: Props & { page: number }) {
  const doc = p.doc!;
  const cur = doc.scaleAt(p.page);
  const [where, setWhere] = useState<'page' | 'all' | 'pages'>('page');
  const [found, setFound] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const [dir, setDir] = useState<Dir>(cur?.ky ? 'x' : 'both');
  useEffect(() => { void doc.chars(p.page).then((c) => setFound(scalesInText(c.text))); }, []);
  // X first, then Y: after picking across, the dialog stays for up-down
  const pick = (s: { label: string; k: number; imperial?: boolean }) => {
    applyScale(p, p.page, (c) => scaleFor(c, { k: s.k, label: s.label, imperial: s.imperial }, dir), where, dir === 'both');
    if (dir === 'x') setDir('y'); else p.setDialog(null);
  };
  const isOn = (label: string) => (dir === 'y' ? (cur?.labelY ?? cur?.label) === label : cur?.label === label);
  const vps = doc.data.viewports?.[String(p.page)] || [];
  // 1:N typed: "2,5" is 1:2.5 (not 1:2 under a "1:2,5" label); "Infinity" and the like are refused
  const n = typedNumber(custom, 0, 1e6);
  const useCustom = () => { if (n !== null) pick({ label: '1:' + n, k: PT_M * n }); };
  return (
    <Modal title="Drawing scale" wide sub={<>Page {p.page + 1}: {cur ? <b>{scaleText(cur)}</b> : 'no scale yet'}. Pick the scale printed on the drawing – or use <b>Calibrate</b> on a known dimension (safer when a drawing was printed to fit).</>} onClose={() => p.setDialog(null)}
      actions={<><button className="btn" onClick={() => { p.setDialog(null); p.A.setTool('m-calibrate'); }}>Calibrate instead…</button><button className="btn primary" onClick={() => p.setDialog(null)}>Close</button></>}>
      <WhereChoice where={where} setWhere={setWhere} hasSel={p.pageSel.length > 1} />
      <DirChoice dir={dir} setDir={setDir} hint={dir === 'x' ? 'Pick the scale across the page (X); then the one up and down (Y).' : cur ? 'Pick the scale up and down the page (Y) - e.g. the vertical scale of a long section.' : 'No scale yet: this one is used both ways until you set across (X).'} />
      {found.length > 0 && <div className="row"><label>Found on this sheet</label><div className="chips">{found.map((f) => { const s = STANDARD_SCALES.find((x) => x.label === f) || { label: f, k: PT_M * parseInt(f.slice(2), 10) }; return <button key={f} className="chip on" onClick={() => pick(s)}>{f}</button>; })}</div></div>}
      <div className="row"><label>Metric</label><div className="chips">{STANDARD_SCALES.filter((s) => !s.imperial).map((s) => <button key={s.label} className={'chip' + (isOn(s.label) ? ' on' : '')} onClick={() => pick(s)}>{s.label}</button>)}</div></div>
      <div className="row"><label>Imperial</label><div className="chips">{STANDARD_SCALES.filter((s) => s.imperial).map((s) => <button key={s.label} className={'chip' + (isOn(s.label) ? ' on' : '')} onClick={() => pick(s)}>{s.label}</button>)}</div></div>
      <div className="row"><label>Other 1:N</label><div className="hrow"><span>1 :</span><input className="input" style={{ width: 120 }} value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') useCustom(); }} /><button className="btn sm" disabled={n === null} onClick={useCustom}>Use{/,/.test(custom) && n !== null ? ` 1:${n}` : ''}</button></div></div>
      {vps.length > 0 && (
        <div className="row"><label>Viewports on this page</label>
          {vps.map((v, i) => <div key={i} className="hrow"><span className="grow">{v.name} – {scaleText(v.scale)}</span><button className="btn sm ghost" onClick={() => { const all = { ...(doc.data.viewports || {}) }; all[String(p.page)] = vps.filter((_, k) => k !== i); void setScales(p, { viewports: all }, 'Remove viewport'); p.setDialog(null); }}>Remove</button></div>)}
        </div>
      )}
      <p className="hint">The scale is saved inside the PDF, so it's there next time you open it.</p>
    </Modal>
  );
}

function ViewportDlg(p: Props & { page: number; rect: [number, number, number, number] }) {
  const doc = p.doc!;
  const [name, setName] = useState('Detail ' + ((doc.data.viewports?.[String(p.page)]?.length || 0) + 1));
  /** a different vertical scale in this box (a section with exaggerated heights): '' = same */
  const [yLabel, setYLabel] = useState('');
  const add = (s: { label: string; k: number; imperial?: boolean }) => {
    const all = { ...(doc.data.viewports || {}) };
    const x: Scale = { k: s.k, label: s.label, imperial: s.imperial };
    const ys = STANDARD_SCALES.find((q) => q.label === yLabel);
    const sc: Scale = { ...(ys ? scaleFor(x, { k: ys.k, label: ys.label }, 'y') : x), rot: doc.pages[p.page]?.rot ?? 0 };
    const v: Viewport = { rect: p.rect, scale: sc, name };
    all[String(p.page)] = [...(all[String(p.page)] || []), v];
    void setScales(p, { viewports: all }, 'Add viewport').then((n) => { if (n !== null) p.toast(`Viewport “${name}” at ${scaleText(sc)}: measurements inside it use that scale${n ? ` (${n} measurement${n === 1 ? '' : 's'} updated)` : ''}.`, 'ok'); });
    p.setDialog(null);
  };
  return (
    <Modal title="Viewport scale" sub="Measurements that start inside this box use its own scale (for details/sections drawn at another scale)." onClose={() => p.setDialog(null)} wide
      actions={<button className="btn" onClick={() => p.setDialog(null)}>Cancel</button>}>
      <div className="row"><label>Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="row"><label>Up-down (Y) scale</label>
        <select className="input" style={{ width: 220 }} value={yLabel} onChange={(e) => setYLabel(e.target.value)} title="Only for a box drawn with a different vertical scale (e.g. a long section)">
          <option value="">Same as across</option>
          {STANDARD_SCALES.map((s) => <option key={s.label} value={s.label}>{s.label}</option>)}
        </select>
      </div>
      <div className="row"><label>{yLabel ? 'Across (X) scale' : 'Scale'}</label><div className="chips">{STANDARD_SCALES.map((s) => <button key={s.label} className="chip" onClick={() => add(s)}>{s.label}</button>)}</div></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- stamps

/** a card that is clicked (a stamp, a signature) can be reached with Tab and used with Enter or
 *  Space too (its own small buttons, such as delete, keep their keys) */
const keyClick = (run: () => void) => ({
  role: 'button', tabIndex: 0,
  onKeyDown: (e: React.KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); run(); } },
});

export function StampPreview({ d, h = 46 }: { d: StampDesign; h?: number }) {
  const [W, H] = designSize(d);
  const c = css(d.color);
  let y = 8;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ height: h, maxWidth: '100%' }}>
      {d.fill && <rect x={1.5} y={1.5} width={W - 3} height={H - 3} fill={css(d.fill, d.fillOpacity ?? 0.12)} />}
      {d.border !== 'none' && <rect x={1} y={1} width={W - 2} height={H - 2} rx={d.border === 'box' ? 0 : 6} fill="none" stroke={c} strokeWidth={2} />}
      {d.border === 'double' && <rect x={4} y={4} width={W - 8} height={H - 8} rx={4} fill="none" stroke={c} strokeWidth={0.8} />}
      {d.lines.map((l, i) => { y += l.size; const el = <text key={i} x={W / 2} y={y + (d.border === 'double' ? 3 : 0) - l.size * 0.12} textAnchor="middle" fontSize={l.size} fontWeight={l.bold ? 700 : 400} fill={c} fontFamily="Arial, Helvetica, sans-serif">{l.text}</text>; y += l.size * 0.18; return el; })}
    </svg>
  );
}

function StampsDlg(p: Props & { scan0?: ScanSource }) {
  const mine = p.settings.stamps || [];
  const [tab, setTab] = useState<'pick' | 'new'>('pick');
  // a picture being made into a stamp (from a file, the clipboard, or a page)
  const [scan, setScan] = useState<ScanSource | null>(p.scan0 ?? null);
  const [lines, setLines] = useState<{ text: string; size: number; bold?: boolean }[]>([{ text: 'CHECKED', size: 18, bold: true }, { text: '{name} – {date}', size: 8 }]);
  const [color, setColor] = useState<RGB>([0.035, 0.19, 0.184]);
  const [border, setBorder] = useState<StampDesign['border']>('double');
  const [name, setName] = useState('');
  const design: StampDesign = { lines, color, border, fill: color, fillOpacity: 0.06 };
  const use = (s: StampDef) => { p.useStamp(s); p.setDialog(null); };
  const saveNew = () => {
    // (a name of only spaces was kept as it was: a blank caption and a blank choice in Stamp on every page)
    const s: StampDef = { id: 'u' + Date.now(), name: name.trim() || lines[0]?.text.trim() || 'Stamp', design };
    p.saveSettings({ stamps: [...mine, s] });
    setTab('pick');
  };
  const fromFile = async () => {
    const f = await gcc.openDialog({ title: 'A scan or photo of the stamp (or a scanned PDF)', single: true, filters: [{ name: 'Pictures and scans', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif', 'pdf'] }] });
    if (!f.length) return;
    try { setScan(await loadScan(f[0])); } catch (e) { p.toast('That picture could not be read: ' + String((e as Error)?.message || e).replace(/^The source image could not be decoded\.?$/, 'it is damaged or not a picture.'), 'err'); }
  };
  const fromClipboard = async () => {
    const s = await pasteScan().catch(() => null);
    if (s) setScan(s); else p.toast('There is no picture on the clipboard - copy one first (a screenshot, a picture in an email).', 'info');
  };
  const fromPage = () => { p.setDialog(null); p.A.setTool('stamp-grab'); };
  const saved = (s: StampDef, place: boolean) => {
    p.saveSettings({ stamps: [...mine, s] });
    setScan(null);
    if (place) use(s);
    else p.toast(`"${s.name}" saved - it is in Your stamps.`, 'ok');
  };
  if (scan) return <StampScanDlg src={scan} onBack={() => (p.scan0 && scan === p.scan0 ? p.setDialog(null) : setScan(null))} onSave={saved} toast={(t, k) => void p.toast(t, k)} />;
  const card = (s: StampDef, own: boolean) => (
    <div key={s.id} className={'scard' + (own ? ' own' : '')} onClick={() => use(s)} title={'Use ' + s.name} {...keyClick(() => use(s))}>
      {s.design ? <StampPreview d={s.design} h={own ? 38 : 46} /> : <img src={s.image} alt="" style={{ height: own ? 40 : 46 }} />}
      {own && <span className="sname">{s.name}</span>}
      {own && <button className="x" title="Delete this stamp" onClick={(e) => { e.stopPropagation(); p.saveSettings({ stamps: mine.filter((x) => x.id !== s.id) }); }}>×</button>}
    </div>
  );
  return (
    <Modal title="Stamps" wide="xl" onClose={() => p.setDialog(null)} actions={<button className="btn" onClick={() => p.setDialog(null)}>Close</button>}>
      <div className="seg" style={{ marginBottom: 12 }}><button className={tab === 'pick' ? 'on' : ''} onClick={() => setTab('pick')}>Choose</button><button className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>New stamp</button></div>
      {tab === 'pick' ? (
        <>
          <div className="row"><label>Ready-made stamps – {'{name}'} and {'{date}'} are filled in when you place them</label><div className="sgrid">{BUILTIN_STAMPS.map((s) => card(s, false))}</div></div>
          <div className="row"><label>Your stamps</label>
            <div className="sgrid">{mine.map((s) => card(s, true))}
              <div className="scard add" onClick={() => setTab('new')} {...keyClick(() => setTab('new'))}><Ico n="plus" /> Design one</div>
              <div className="scard add" onClick={() => void fromFile()} {...keyClick(() => void fromFile())} title="A scan or a phone photo of a stamp (picture or scanned PDF): the paper is taken away, the stamp straightened and cropped"><Ico n="image" /> From a scan or photo</div>
              <div className="scard add" onClick={() => void fromClipboard()} {...keyClick(() => void fromClipboard())} title="A picture you copied (a screenshot, a picture in an email)"><Ico n="copy" /> Paste a picture</div>
              {p.doc && <div className="scard add" onClick={fromPage} {...keyClick(fromPage)} title="Drag a box round a stamp on the open page (a scanned letter, a drawing)"><Ico n="stamp" /> From a page</div>}
            </div>
          </div>
        </>
      ) : (
        <div className="sdesign">
          <div className="sprev"><StampPreview d={design} h={90} /></div>
          {lines.map((l, i) => (
            <div key={i} className="hrow">
              <input className="input" value={l.text} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} />
              <select className="input" style={{ width: 80 }} value={l.size} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, size: Number(e.target.value) } : x)))}>{[6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 32].map((s) => <option key={s} value={s}>{s}</option>)}</select>
              <label className="check sm"><input type="checkbox" checked={!!l.bold} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, bold: e.target.checked } : x)))} /> Bold</label>
              <button className="btn sm ghost" onClick={() => setLines(lines.filter((_, k) => k !== i))} disabled={lines.length < 2}>×</button>
            </div>
          ))}
          <button className="btn sm" onClick={() => setLines([...lines, { text: '', size: 9 }])}>+ Line</button>
          <div className="hrow" style={{ marginTop: 10 }}>
            <span className="plab">Colour</span>
            {PALETTE.slice(0, 9).map((c, i) => <button key={i} className={'sw' + (hex(c) === hex(color) ? ' on' : '')} style={{ background: css(c) }} onClick={() => setColor(c)} />)}
            <input type="color" value={hex(color)} onChange={(e) => setColor(fromHex(e.target.value))} />
          </div>
          <div className="hrow"><span className="plab">Border</span>
            <div className="seg">{(['double', 'rounded', 'box', 'none'] as const).map((b) => <button key={b} className={border === b ? 'on' : ''} onClick={() => setBorder(b)}>{b}</button>)}</div>
          </div>
          <div className="hrow"><span className="plab">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={lines[0]?.text} /></div>
          <p className="hint">Fields: {'{name}'} = your name (Settings), {'{date}'}, {'{time}'}.</p>
          <div className="actions"><button className="btn" onClick={() => setTab('pick')}>Back</button><button className="btn primary" onClick={saveNew}>Save stamp</button></div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- copy to pages

/**
 * Where a copy goes on another page: the same distance from the nearest corner of the sheet (a
 * stamp in the bottom-right title block lands in the title block of an A1 and an A3 alike), or
 * the very same place.
 */
export function cornerShift(box: Rect, from: { w: number; h: number }, to: { w: number; h: number }, corner: boolean): [number, number] {
  const right = (box[0] + box[2]) / 2 > from.w / 2, bottom = (box[1] + box[3]) / 2 > from.h / 2;
  let dx = corner && right ? to.w - from.w : 0, dy = corner && bottom ? to.h - from.h : 0;
  // kept on the page (a smaller one: pushed in from the far edge; bigger than the page: from
  // the near one)
  if (box[2] + dx > to.w) dx = to.w - box[2];
  if (box[0] + dx < 0) dx = -box[0];
  if (box[3] + dy > to.h) dy = to.h - box[3];
  if (box[1] + dy < 0) dy = -box[1];
  return [dx, dy];
}

function CopyPagesDlg(p: Props & { items: { page: number; id: number }[] }) {
  const doc = p.doc!;
  const n = doc.pages.length;
  const from = [...new Set(p.items.map((x) => x.page))];
  const [which, setWhich] = useState<'all' | 'list'>('all');
  const [list, setList] = useState('');
  const [corner, setCorner] = useState(true);
  const [running, setRunning] = useState(false);
  const targets = which === 'all' ? [...Array(n).keys()] : parseRanges(list, n);
  // pages that get a copy (with markups on several pages: each of those gets the others' too)
  const count = [...new Set(targets)].filter((t) => !(from.length === 1 && t === from[0])).length;
  const listOnly = which === 'list' && list.trim() && from.length === 1 && targets.length > 0 && targets.every((t) => t === from[0]);
  const go = async () => {
    const pick = [...new Set(targets)];
    // the markups' box on each page they are on (page space as shown)
    const boxes = new Map<number, Rect>();
    /** whose labels are their numbers (measurements: worked out again on each page they land on) */
    const auto = new Map<string, boolean>();
    for (const pg of from) {
      const mine = (await doc.annots(pg)).filter((a) => p.items.some((x) => x.page === pg && x.id === a.id));
      for (const a of mine) { const q = ptsOf(a); auto.set(pg + ':' + a.id, isAutoLabel(a, q.length ? doc.scaleAt(pg, q[0][0], q[0][1]) : null)); }
      const bs = mine.map((a) => (a.box || a.rect) as Rect);
      if (bs.length) boxes.set(pg, [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))]);
    }
    // (one call: all of it is one undo step, also from several pages)
    const groups = from.filter((pg) => boxes.has(pg)).map((pg) => ({
      items: p.items.filter((x) => x.page === pg),
      targets: pick.filter((t) => t !== pg).map((t) => { const [dx, dy] = cornerShift(boxes.get(pg)!, doc.pages[pg], doc.pages[t], corner); return { page: t, dx, dy }; }),
    })).filter((g) => g.targets.length);
    let made = 0;
    setRunning(true);
    try {
      await p.busy('Copying…', async () => {
        if (!groups.length) return;
        const out = await doc.copyToPages(groups);
        made = out.length;
        // (each page's own scale: the copies kept the number of the page they came from)
        const was = groups.flatMap((g) => g.targets.flatMap(() => g.items.map((x) => !!auto.get(x.page + ':' + x.id))));
        await relabel(doc, out, out.length === was.length ? was : undefined, true).catch(() => {});
      });
    } finally { setRunning(false); }
    p.setDialog(null);
    if (made) p.toast(`Copied to ${count} page${count === 1 ? '' : 's'} – Ctrl+Z takes them all back.`, 'ok');
  };
  const many = p.items.length === 1 ? 'it' : `the ${p.items.length} markups`;
  return (
    <Modal title="Copy to pages" onClose={() => p.setDialog(null)} sub={`Puts a copy of ${many} on other pages of this file.`}
      actions={<><button className="btn" onClick={() => p.setDialog(null)}>Cancel</button><button className="btn primary" disabled={!count || running} onClick={() => void go()}>Copy to {count} page{count === 1 ? '' : 's'}</button></>}>
      <div className="row"><label>Pages</label>
        <label className="check"><input type="radio" checked={which === 'all'} onChange={() => setWhich('all')} /> {from.length === 1 ? `All other pages (${n - 1})` : `All pages (${n})`}</label>
        <label className="check"><input type="radio" checked={which === 'list'} onChange={() => setWhich('list')} /> These pages: <input className="input sm" style={{ width: 160 }} value={list} placeholder="e.g. 2-5, 9" onFocus={() => setWhich('list')} onChange={(e) => { setList(e.target.value); setWhich('list'); }} onKeyDown={(e) => { if (e.key === 'Enter' && count && !running) void go(); }} /></label>
        {which === 'list' && list.trim() && !count && <div className="hint err">{listOnly ? 'That is the page it is on - list other pages.' : `No pages of this file in that list (it has ${n}) - e.g. 2-5, 9.`}</div>}
      </div>
      <div className="row"><label>Where on the page</label>
        <label className="check"><input type="radio" checked={corner} onChange={() => setCorner(true)} /> Same distance from the nearest corner – right for sheets of other sizes (title blocks)</label>
        <label className="check"><input type="radio" checked={!corner} onChange={() => setCorner(false)} /> The very same place</label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- signature

function SignatureDlg(p: Props) {
  const sigs = p.settings.signatures || [];
  const [mode, setMode] = useState<'draw' | 'type'>(sigs.length ? 'draw' : 'draw');
  const [typed, setTyped] = useState(p.author);
  const cv = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  // the drawn strokes, kept: a click on another ink colour draws them again in it (the pad used
  // to be wiped, while "Save & place" stayed on and then did nothing)
  const strokes = useRef<[number, number][][]>([]);
  const [has, setHas] = useState(false);
  const [color, setColor] = useState('#0b2a7a');
  const pen = (g: CanvasRenderingContext2D) => { g.strokeStyle = color; g.lineWidth = 3.2; g.lineCap = 'round'; g.lineJoin = 'round'; };
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    if (mode === 'type') {
      if (typed) {
        g.fillStyle = color;
        g.font = '64px "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive';
        g.textBaseline = 'middle';
        g.fillText(typed, 20, c.height / 2);
      }
      setHas(!!typed);
      return;
    }
    pen(g);
    for (const s of strokes.current) { g.beginPath(); s.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); }
    setHas(strokes.current.some((s) => s.length > 1));
  }, [mode, typed, color]);
  const pos = (e: React.PointerEvent): [number, number] => { const r = cv.current!.getBoundingClientRect(); return [(e.clientX - r.left) * (cv.current!.width / r.width), (e.clientY - r.top) * (cv.current!.height / r.height)]; };
  // (the main button or a pen / finger only; a stroke whose release was lost - pointer cancelled,
  // button let go outside the window - ends instead of drawing on hover)
  const down = (e: React.PointerEvent) => { if (mode !== 'draw' || e.button !== 0) return; drawing.current = true; const g = cv.current!.getContext('2d')!; const p0 = pos(e); strokes.current.push([p0]); pen(g); g.beginPath(); g.moveTo(...p0); (e.target as HTMLElement).setPointerCapture(e.pointerId); };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    if (!(e.buttons & 1)) { drawing.current = false; return; }
    const g = cv.current!.getContext('2d')!; const p1 = pos(e); strokes.current[strokes.current.length - 1]?.push(p1); g.lineTo(...p1); g.stroke(); setHas(true);
  };
  const up = () => { drawing.current = false; };
  const clear = () => { strokes.current = []; cv.current!.getContext('2d')!.clearRect(0, 0, 900, 260); setHas(false); };
  /** crop to the ink and save as PNG */
  const save = () => {
    const c = cv.current!;
    const g = c.getContext('2d')!;
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 <= x0) { p.toast(mode === 'type' ? 'Type your name first.' : 'Draw your signature in the box first.', 'info'); return; }
    const pad = 6;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
    const o = document.createElement('canvas');
    o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
    o.getContext('2d')!.drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
    const k = 150 / o.width;
    const sig = { id: 's' + Date.now(), image: o.toDataURL('image/png'), w: o.width * k * 0.75, h: o.height * k * 0.75 };
    p.saveSettings({ signatures: [...sigs, sig] });
    p.useSignature(sig);
    p.setDialog(null);
  };
  const importImg = async () => {
    const f = await gcc.openDialog({ title: 'Signature picture or scan', single: true, filters: [{ name: 'Pictures and scans', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'pdf'] }] });
    if (!f.length) return;
    // the same clean-up as stamps: paper taken away (also under uneven light), the ink's own
    // colour, cropped to the signature
    // (an unreadable file: said in plain words, not the picture decoder's own message)
    const r = await p.busy('Cleaning the signature…', async () => {
      try { return await cleanQuick(await loadScan(f[0]), 900); } catch (e) { p.toast('That picture could not be read: ' + String((e as Error)?.message || e).replace(/^The source image could not be decoded\.?$/, 'it is damaged or not a picture.'), 'err'); return undefined; }
    });
    if (r === null) p.toast('No signature found in that picture (it looks blank).', 'info');
    if (!r) return;
    const k = 150 / r.w;
    const sig = { id: 's' + Date.now(), image: r.url, w: r.w * k * 0.75, h: r.h * k * 0.75 };
    p.saveSettings({ signatures: [...sigs, sig] });
    p.useSignature(sig);
    p.setDialog(null);
  };
  return (
    <Modal title="Signature" wide onClose={() => p.setDialog(null)} sub="Kept on this PC only. Placed as a picture you can move until you flatten it."
      actions={<><button className="btn" onClick={() => p.setDialog(null)}>Cancel</button><button className="btn primary" disabled={!has} onClick={save}>Save & place</button></>}>
      {sigs.length > 0 && (
        <div className="row"><label>Your signatures – click one to place it</label>
          <div className="sgrid">{sigs.map((s) => (
            <div key={s.id} className="scard sig" onClick={() => { p.useSignature(s); p.setDialog(null); }} {...keyClick(() => { p.useSignature(s); p.setDialog(null); })} title="Place this signature">
              <img src={s.image} alt="" />
              <button className="x" title="Delete this signature" onClick={(e) => { e.stopPropagation(); p.saveSettings({ signatures: sigs.filter((x) => x.id !== s.id) }); }}>×</button>
            </div>
          ))}</div>
        </div>
      )}
      <div className="hrow">
        <div className="seg"><button className={mode === 'draw' ? 'on' : ''} onClick={() => setMode('draw')}>Draw</button><button className={mode === 'type' ? 'on' : ''} onClick={() => setMode('type')}>Type</button></div>
        <button className="btn sm" onClick={() => void importImg()}><Ico n="image" size={14} /> From a picture / scan</button>
        <span className="grow" />
        {['#0b2a7a', '#000000', '#09302f'].map((c) => <button key={c} className={'sw' + (color === c ? ' on' : '')} style={{ background: c }} onClick={() => setColor(c)} />)}
        <button className="btn sm ghost" onClick={clear}>Clear</button>
      </div>
      {mode === 'type' && <input className="input" style={{ marginTop: 8 }} value={typed} onChange={(e) => setTyped(e.target.value)} />}
      <canvas ref={cv} width={900} height={260} className="sigpad" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} />
    </Modal>
  );
}

// ---------------------------------------------------------------- merge

function MergeDlg(p: Props & { files?: string[] }) {
  // (from Explorer's Combine: those files; otherwise the files open now)
  const [files, setFiles] = useState<string[]>(() => p.files?.length ? p.files : p.docs.filter((d) => d.path).map((d) => d.path!));
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [marks, setMarks] = useState(true);
  /** a merge under way: the list can't change under it (files added then were left out, silently) */
  const busyRef = useRef(false);
  const later = (n: number) => p.toast(`${n} file${n === 1 ? '' : 's'} not added – a merge is running. Add ${n === 1 ? 'it' : 'them'} when it has finished.`, 'info', undefined, 7000);
  useDropFiles((f) => { if (busyRef.current) { later(f.length); return; } setFiles((x) => [...x, ...f.filter((y) => !x.includes(y))]); }, undefined, (t) => p.toast(t, 'info', undefined, 7000));
  // more files from Explorer's Combine while this is open (the rest of a selection on a slow PC):
  // a list still in name order stays in name order, one put in an order of its own gets them at
  // the end
  useEffect(() => {
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const byName = (l: string[]) => l.slice().sort((a, b) => coll.compare(baseName(a), baseName(b)) || coll.compare(a, b));
    const add = (e: Event) => {
      e.preventDefault(); // (heard: App doesn't send them again)
      const f = (e as CustomEvent<string[]>).detail || [];
      if (busyRef.current) { later(f.length); return; }
      setFiles((x) => {
        const l = [...x, ...f.filter((y, i) => !x.includes(y) && f.indexOf(y) === i)];
        return byName(x).every((y, i) => y === x[i]) ? byName(l) : l;
      });
    };
    window.addEventListener('gcc-merge-add', add);
    return () => window.removeEventListener('gcc-merge-add', add);
  }, []);
  useEffect(() => {
    for (const f of files) if (counts[f] == null) void muBatch<number>('pageCountOf', fileArg(f)).then((n) => setCounts((c) => ({ ...c, [f]: n }))).catch((e) => setCounts((c) => ({ ...c, [f]: /2 GB or more/.test(String((e as Error)?.message)) ? -3 : -2 })));
  }, [files]);
  // the merge runs a file at a time (the engine writes the result to disk as it goes - a big set
  // of volumes no longer runs it out of memory), with its progress here and a Stop
  const [run, setRun] = useState<{ k: number; name: string; pages: number; phase: 'file' | 'write' | 'open' } | null>(null);
  const stop = useRef(false);
  const going = useRef(false);
  const go = async () => {
    if (going.current) return;
    going.current = true;
    stop.current = false;
    const job = 'merge-' + Date.now().toString(36);
    const temps: string[] = [];
    const list = files.slice();
    let done = 0;
    setRun({ k: 0, name: baseName(list[0]), pages: 0, phase: 'file' });
    try {
      await muBatch('mergeBegin', job);
      for (let k = 0; k < list.length; k++) {
        if (stop.current) break;
        const f = list[k];
        setRun({ k, name: baseName(f), pages: done, phase: 'file' });
        // a file open here with unsaved changes goes in as it is now (its markups and marks), not
        // as on disk; a protected one as an unprotected copy (from disk, or still locked, the
        // merge can't read it)
        const open = p.docs.find((x) => x.path === f && (x.dirty || !!x.password));
        const src = open ? await open.fileForSave(open.password ? { decrypt: true } : {}) : f;
        if (open) temps.push(src);
        const r = await muBatch<{ pages: number; total: number }>('mergeAdd', job, baseName(f), fileArg(src));
        done = r.total;
      }
      if (stop.current) { void muBatch('mergeEnd', job).catch(() => {}); p.toast('Merge stopped – no file was made.', 'info'); return; }
      setRun({ k: list.length, name: '', pages: done, phase: 'write' });
      const b = await muBatch<FileRef>('mergeFinish', job, marks);
      setRun({ k: list.length, name: '', pages: done, phase: 'open' });
      // opened here too: a result that can't be opened is said, with the dialog (and its list)
      // still there - not dropped after the dialog closed
      // 2 GB or more can't be opened here (the editing engine reads files through 32-bit positions):
      // kept where the person chooses - it used to be opened, fail ("TRYLATER") and be deleted
      if ((b.$file.size ?? 0) >= 2 ** 31) {
        const gb = ((b.$file.size ?? 0) / 2 ** 30).toFixed(1);
        const to = await gcc.saveDialog({ title: `The merged file is ${gb} GB – too big to open here. Save it as…`, name: 'Merged.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        if (!to) { void gcc.dropTemp([b.$file.path]); p.toast(`The merged file (${gb} GB) was not kept. ${APP_NAME} can't open files of 2 GB or more – merge fewer files at a time.`, 'info', undefined, 12000); return; }
        try { await gcc.commit(b.$file.path, to); } catch (e) { void gcc.dropTemp([b.$file.path]); throw e; }
        p.setDialog(null);
        p.toast(`Merged ${list.length} files – ${done} pages, ${gb} GB, saved as ${baseName(to)}. It is too big to open in ${APP_NAME} (2 GB or more); other PDF programs can open it.`, 'ok', undefined, 15000);
        return;
      }
      let d: PdfDoc;
      try { d = await p.newFromFile(b.$file.path, 'Merged.pdf'); } catch (e) { void gcc.dropTemp([b.$file.path]); throw e; }
      p.setDialog(null);
      p.toast(`Merged ${list.length} files – ${d.pages.length} pages. Save it with Ctrl+S.`, 'ok');
    } catch (e) {
      void muBatch('mergeEnd', job).catch(() => {});
      p.fail(e);
    } finally {
      if (temps.length) void gcc.dropTemp(temps);
      going.current = false;
      setRun(null);
    }
  };
  const total = files.reduce((s, f) => s + Math.max(0, counts[f] ?? 0), 0);
  // a file that can't be read, or needs a password to open: said which, before merging fails
  const bad = files.filter((f) => (counts[f] ?? 0) < 0);
  busyRef.current = !!run;
  // (a click beside the dialog or Escape never stops a merge under way - Stop does)
  const close = () => { if (run) return; stop.current = true; p.setDialog(null); };
  return (
    <Modal title="Merge files" wide onClose={close} sub="In this order, into one new PDF (opens in a new tab). Markups come along."
      actions={<><label className="check" style={{ marginRight: 'auto' }}><input type="checkbox" checked={marks} disabled={!!run} onChange={(e) => setMarks(e.target.checked)} /> A bookmark for each file</label>
        {run
          ? <button className="btn" onClick={() => { stop.current = true; }} disabled={run.phase !== 'file'}>Stop</button>
          : <button className="btn" onClick={close}>Cancel</button>}
        <button className="btn primary" disabled={!!run || files.length < 2 || bad.length > 0} onClick={() => void go()}>{run ? 'Merging…' : `Merge ${files.length} ${files.length === 1 ? 'file' : 'files'} (${total} pages)`}</button></>}>
      {bad.length > 0 && <p className="err">{bad.map((f) => `“${baseName(f)}” ${counts[f] === -1 ? 'needs a password to open (open it, Protect > Remove password, save, then merge)' : counts[f] === -3 ? 'is 2 GB or more – too big for ' + APP_NAME : "can't be read as a PDF"}`).join('; ')}. Remove {bad.length === 1 ? 'it' : 'them'} (×) to merge the rest.</p>}
      {run && (
        <div className="mprog">
          <div className="bar"><i style={{ width: `${Math.round(((run.phase === 'file' ? run.k : files.length) + (run.phase === 'open' ? 1 : run.phase === 'write' ? 0.5 : 0)) / (files.length + 1) * 100)}%` }} /></div>
          <div className="faint">{run.phase === 'file' ? `File ${run.k + 1} of ${files.length}: ${run.name}${run.pages ? ` – ${run.pages.toLocaleString('en-GB')} pages so far` : ''}…` : run.phase === 'write' ? `Writing the merged file (${run.pages.toLocaleString('en-GB')} pages)…` : 'Opening it…'}</div>
        </div>
      )}
      <FileList files={files} setFiles={setFiles} locked={!!run} extra={(f) => <span className={(counts[f] ?? 0) < 0 ? 'err' : 'faint'}>{counts[f] == null ? '…' : counts[f] === -1 ? 'password' : counts[f] < 0 ? 'unreadable' : counts[f] + ' p'}</span>} />
    </Modal>
  );
}

// ---------------------------------------------------------------- split

/** Extract pages: the pages typed like in Print ("1-3, 5, 8-10"), into a new PDF saved now or
 *  opened as a tab; and, if wanted, taken out of this file (one Ctrl+Z puts them back) */
function ExtractDlg(p: Props) {
  const doc = p.doc!;
  const n = doc.pages.length;
  const remembered = (() => { try { return JSON.parse(localStorage.getItem('extract') || '{}') as { then?: 'save' | 'tab'; remove?: boolean }; } catch { return {}; } })();
  const [range, setRange] = useState(() => toRanges(p.pageSel.length ? p.pageSel : [p.A.currentPage?.() ?? 0]));
  const [then, setThen] = useState<'save' | 'tab'>(remembered.then || 'save');
  const [remove, setRemove] = useState(!!remembered.remove);
  const [running, setRunning] = useState(false);
  const ps = parseRanges(range, n);
  const all = ps.length >= n;
  const problem = !range.trim() ? 'Type the pages, e.g. 1-3, 5, 8-10.' : !ps.length ? `None of those pages are in this file (it has ${n}).` : remove && all ? 'Every page would be taken out of this file – untick "Remove", or leave a page.' : '';
  const go = async () => {
    if (problem || running) return;
    try { localStorage.setItem('extract', JSON.stringify({ then, remove })); } catch { /* fine */ }
    setRunning(true);
    try {
      const f = await p.busy('Extracting…', () => doc.extract(ps));
      if (!f) return;
      const label = toRanges(ps).replace(/\s+/g, '');
      const name = `${doc.name.replace(/\.pdf$/i, '')} (pages ${label.length > 40 ? label.slice(0, 40) + '…' : label}).pdf`.replace(/[\\/:*?"<>|]/g, '_');
      let made = false;
      let tab: PdfDoc | null = null;
      const before = doc.changeCount;
      if (then === 'save') {
        const target = await gcc.saveDialog({ title: 'Save extracted pages', name });
        if (!target) { void gcc.dropTemp([f]); return; }
        // (never over a file open here - this one or another tab: the tab would still show the old
        // file while its original was swapped away)
        if (p.docs.some((d) => d.path && d.path.toLowerCase() === target.toLowerCase())) { void gcc.dropTemp([f]); p.toast(`${baseName(target)} is open here – choose another name.`, 'err', undefined, 7000); return; }
        // (a place that refuses the file - open in another program, read-only - is said)
        try { await gcc.commit(f, target, { noBackup: true }); } catch (e) { void gcc.dropTemp([f]); p.fail(e); return; }
        made = true;
        p.toast('Saved ' + baseName(target), 'ok', { label: 'Open', run: () => void p.A.openPaths([target]) });
      } else {
        try { tab = await p.newFromFile(f, name); } catch (e) { void gcc.dropTemp([f]); p.fail(e); return; }
        made = true;
      }
      if (made && remove) {
        // (the pages typed are this file's pages as they were: changed meanwhile, nothing is taken out)
        if (doc.changeCount !== before) p.toast(`${doc.name} was changed meanwhile – the pages were not taken out of it.`, 'info', undefined, 8000);
        else {
          // (taken out once the new file is safely made; Ctrl+Z puts them back)
          const ok = await p.busy('Removing the pages from ' + doc.name + '…', async () => { await doc.deletePages(ps); return true; });
          if (ok) p.toast(`${ps.length} ${ps.length === 1 ? 'page' : 'pages'} taken out of ${doc.name} – Ctrl+Z puts ${ps.length === 1 ? 'it' : 'them'} back.`, 'ok');
        }
      }
      p.setDialog(null);
      // (made while this dialog was open, the new tab waited behind it: now in front)
      if (tab) p.A.showDoc(tab.id);
    } finally { setRunning(false); }
  };
  return (
    <Modal title="Extract pages" sub="The pages chosen go into a new PDF, in the order typed." onClose={() => { if (!running) p.setDialog(null); }}
      actions={<><button className="btn" disabled={running} onClick={() => p.setDialog(null)}>Cancel</button><button className="btn primary" disabled={!!problem || running} onClick={() => void go()}>Extract {ps.length} {ps.length === 1 ? 'page' : 'pages'}</button></>}>
      <div className="row"><label>Pages (of {n})</label>
        <input className="input" autoFocus value={range} onChange={(e) => setRange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} placeholder="e.g. 1-3, 5, 8-10" />
      </div>
      <p className={'hint' + (problem ? ' err' : '')}>{problem || (ps.length === 1 ? 'Page ' + (ps[0] + 1) : `${ps.length} pages: ${toRanges(ps)}`)}</p>
      <div className="row"><label>Then</label>
        <label className="check"><input type="radio" checked={then === 'save'} onChange={() => setThen('save')} /> Save it as a new file now…</label>
        <label className="check"><input type="radio" checked={then === 'tab'} onChange={() => setThen('tab')} /> Open it as a new tab (save it later)</label>
      </div>
      <label className="check"><input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /> Remove these pages from this file afterwards (Ctrl+Z puts them back)</label>
    </Modal>
  );
}

function SplitDlg(p: Props) {
  const doc = p.doc!;
  const n = doc.pages.length;
  const [mode, setMode] = useState<'every' | 'ranges' | 'marks'>('every');
  const [every, setEvery] = useState('1');
  const [ranges, setRanges] = useState('1-' + Math.ceil(n / 2) + ', ' + (Math.ceil(n / 2) + 1) + '-' + n);
  const [marks, setMarks] = useState<{ title: string; page: number }[]>([]);
  useEffect(() => { void mu<{ title: string; page: number }[]>('outline', doc.id).then((m) => setMarks(m.filter((x) => x.page >= 0))); }, []);
  const parts = useMemo((): { name: string; pages: number[] }[] => {
    const base = doc.name.replace(/\.pdf$/i, '');
    if (mode === 'every') {
      const k = Math.max(1, parseInt(every, 10) || 1);
      const out = [];
      for (let i = 0; i < n; i += k) out.push({ name: `${base} - ${k === 1 ? 'p' + (i + 1) : 'p' + (i + 1) + '-' + Math.min(n, i + k)}`, pages: [...Array(Math.min(k, n - i)).keys()].map((x) => x + i) });
      return out;
    }
    if (mode === 'ranges') return ranges.split(/[;,]+/).map((r) => r.trim()).filter(Boolean).map((r) => ({ name: `${base} - p${r.replace(/\s/g, '')}`, pages: parseRanges(r, n) })).filter((x) => x.pages.length);
    const sorted = marks.slice().sort((a, b) => a.page - b.page);
    return sorted.map((m, i) => ({ name: `${base} - ${m.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}`, pages: [...Array((sorted[i + 1]?.page ?? n) - m.page).keys()].map((x) => x + m.page) })).filter((x) => x.pages.length);
  }, [mode, every, ranges, marks, n]);
  // each part its own file: bookmarks repeat ("Notes"), "1-3, 1-3" - a later part with the same
  // name wrote over the earlier one while the count said all were saved
  const names = useMemo(() => uniqueNames(parts.map((x) => x.name)), [parts]);
  const go = async () => {
    const dir = await gcc.dirDialog({ title: 'Save the parts in…', dir: doc.path ? dirName(doc.path) : undefined });
    if (!dir) return;
    const targets = names.map((x) => joinPath(dir, x + '.pdf'));
    if (!(await okToReplace(targets))) return;
    const done = await p.busy('Splitting…', async (set) => {
      let k = 0;
      for (const [i, part] of parts.entries()) {
        set(`Writing ${++k} of ${parts.length}…`);
        const f = await doc.extract(part.pages);
        await gcc.commit(f, targets[i], { noBackup: true });
      }
      return k;
    });
    if (done) { p.setDialog(null); p.toast(`Saved ${done} ${done === 1 ? 'file' : 'files'}.`, 'ok', { label: 'Show folder', run: () => void gcc.showInFolder(targets[0]) }); }
  };
  return (
    <Modal title="Split" wide onClose={() => p.setDialog(null)} sub={`${doc.name} – ${n} ${n === 1 ? 'page' : 'pages'}`}
      actions={<><button className="btn" onClick={() => p.setDialog(null)}>Cancel</button><button className="btn primary" disabled={!parts.length} onClick={() => void go()}>Split into {parts.length} files…</button></>}>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={mode === 'every' ? 'on' : ''} onClick={() => setMode('every')}>Every N pages</button>
        <button className={mode === 'ranges' ? 'on' : ''} onClick={() => setMode('ranges')}>Page ranges</button>
        <button className={mode === 'marks' ? 'on' : ''} onClick={() => setMode('marks')} disabled={!marks.length}>By bookmarks</button>
      </div>
      {mode === 'every' && <div className="row"><label>Pages per file</label><input className="input" style={{ width: 100 }} value={every} onChange={(e) => setEvery(e.target.value)} /></div>}
      {mode === 'ranges' && <div className="row"><label>One file per range (e.g. 1-3, 4-10, 11-)</label><input className="input" value={ranges} onChange={(e) => setRanges(e.target.value)} /></div>}
      <div className="plist">{parts.slice(0, 200).map((x, i) => <div key={i} className="faint">{names[i]}.pdf – {x.pages.length} page{x.pages.length > 1 ? 's' : ''}</div>)}{parts.length > 200 && <div className="faint">…and {parts.length - 200} more</div>}</div>
    </Modal>
  );
}

// ---------------------------------------------------------------- insert / replace

/**
 * Pages from another file into this one: inserted, or in place of pages of this one (revised
 * sheets). The other file is one open here (as it is now - unsaved changes included, no password
 * to type again) or a file on disk. Pages typed like in Print, in the order typed.
 */
function InsertDlg(p: Props & { at: number; mode?: 'insert' | 'replace' }) {
  const doc = p.doc!;
  const n = doc.pages.length;
  const others = p.docs.filter((d) => d.id !== doc.id && d.pages.length > 0);
  const [mode, setMode] = useState<'insert' | 'replace'>(p.mode || 'insert');
  // the other file: an open one (its id) or a file on disk
  const [srcId, setSrcId] = useState<string>(others[0]?.id || '');
  const [file, setFile] = useState('');
  const [fileCount, setFileCount] = useState(0);
  const [fileErr, setFileErr] = useState('');
  const [range, setRange] = useState('');
  const [where, setWhere] = useState<'after' | 'before' | 'start' | 'end'>('after');
  const [atText, setAtText] = useState(String(Math.min(n, Math.max(1, p.at))));
  const [targets, setTargets] = useState(() => toRanges(p.pageSel.length ? p.pageSel : [p.A.currentPage?.() ?? Math.max(0, p.at - 1)]));
  const [running, setRunning] = useState(false);
  const src = srcId ? others.find((d) => d.id === srcId) || null : null;
  const count = src ? src.pages.length : fileCount;
  const srcName = src ? src.name : file ? baseName(file) : '';
  const pickSeq = useRef(0);
  const pick = async () => {
    const f = await gcc.openDialog({ title: mode === 'replace' ? 'Take the new pages from' : 'Insert pages from', single: true });
    if (!f.length) return;
    // a file that is open here: taken as it is now (unsaved changes, password already given)
    const open = others.find((d) => d.path && d.path.toLowerCase() === f[0].toLowerCase());
    if (open) { setSrcId(open.id); setFile(''); setFileErr(''); p.toast(`${open.name} is open here – its pages are taken as they are now.`, 'info', undefined, 5000); return; }
    if (doc.path && doc.path.toLowerCase() === f[0].toLowerCase()) { setFileErr(mode === 'replace' ? 'That is this file – choose the file with the new pages.' : 'That is this file – use Duplicate, or drag pages in the Pages panel.'); return; }
    setSrcId(''); setFile(f[0]); setFileCount(0); setRange(''); setFileErr('');
    // (a file chosen again before the first one's count came: only the last one's count counts)
    const seq = ++pickSeq.current;
    const k = await muBatch<number>('pageCountOf', fileArg(f[0])).catch(() => -2);
    if (seq !== pickSeq.current) return;
    if (k === -1) setFileErr('That file needs a password: open it here first (it then shows in the list above).');
    else if (k === 0) setFileErr('That file has no pages.');
    else if (k < 1) setFileErr("That file can't be read as a PDF.");
    else setFileCount(k);
  };
  // nothing else open: straight to choosing a file, as before
  useEffect(() => { if (!others.length) void pick(); }, []);
  // an empty field is all pages; otherwise exactly the pages listed, in that order
  const tps = mode === 'replace' ? parseRanges(targets, n) : [];
  // nothing typed: Insert takes every page; Replace takes as many as are replaced - the same page
  // numbers when the other file has them (a revised set: 5-8 for 5-8), else its first pages
  const sameNums = tps.length > 0 && tps.every((t) => t < count);
  const auto = mode === 'replace' ? (tps.length && count ? (sameNums ? tps : count >= tps.length ? [...Array(tps.length).keys()] : [...Array(count).keys()]) : []) : count > 0 ? [...Array(count).keys()] : [];
  const pages = range.trim() ? parseRanges(range, count) : auto;
  const run = tps.every((t, k) => k === 0 || t === tps[k - 1] + 1);
  const atNum = parseInt(atText, 10);
  const at = where === 'start' ? 0 : where === 'end' ? n : where === 'after' ? atNum : atNum - 1;
  const problem = !srcName ? (fileErr || 'Choose the file the pages come from.')
    : fileErr || (count < 1 ? 'Reading the file…'
    : !pages.length ? `None of those pages are in ${srcName} (it has ${count}) – e.g. 1-3, 5.`
    : mode === 'insert' ? ((where === 'after' || where === 'before') && !(atNum >= 1 && atNum <= n) ? `Which page of this file? 1 to ${n}.` : '')
    : !targets.trim() ? 'Which pages of this file are to be replaced? e.g. 5 or 5-8.'
    : !tps.length ? `None of those pages are in this file (it has ${n}).`
    : new Set(tps).size !== tps.length ? 'A page to replace is listed twice.'
    : tps.length !== pages.length && !run ? `${tps.length} pages to replace and ${pages.length} to put in: give as many of each, or replace a run of pages (e.g. 5-8).`
    : tps.length - pages.length >= n ? 'A PDF needs at least one page.' : '');
  const plan = problem ? '' : mode === 'insert'
    ? `${pages.length === 1 ? 'Page ' + (pages[0] + 1) : pages.length + ' pages'} of ${srcName} go in ${where === 'start' ? 'at the start' : where === 'end' ? 'at the end' : (where === 'after' ? 'after' : 'before') + ' page ' + atNum}.`
    : tps.length === pages.length
      ? `${tps.length === 1 ? 'Page ' + (tps[0] + 1) + ' is' : 'Pages ' + toRanges(tps) + ' are'} replaced by ${pages.length === 1 ? 'page ' + (pages[0] + 1) : 'pages ' + toRanges(pages)} of ${srcName}, one for one. Bookmarks, links and page labels pointing at ${tps.length === 1 ? 'it' : 'them'} now show the new ${tps.length === 1 ? 'page' : 'pages'}; markups on the old ${tps.length === 1 ? 'page' : 'pages'} go with ${tps.length === 1 ? 'it' : 'them'}.`
      : tps.length < pages.length
        ? `${tps.length === 1 ? 'Page ' + (tps[0] + 1) + ' is' : 'Pages ' + toRanges(tps) + ' are'} replaced by ${pages.length} pages: the ${pages.length - tps.length} extra ${pages.length - tps.length === 1 ? 'one goes' : 'ones go'} in after page ${tps[tps.length - 1] + 1}.`
        : `Pages ${toRanges(tps)} (${tps.length}) are replaced by ${pages.length}: the ${tps.length - pages.length} left over ${tps.length - pages.length === 1 ? 'is' : 'are'} taken out.`;
  const go = async () => {
    if (problem || running) return;
    setRunning(true);
    try {
      const list = range.trim() || mode === 'replace' ? pages : undefined;
      const from = src ? { open: src } : { path: file };
      const what = pages.length === 1 ? 'page' : pages.length + ' pages';
      if (mode === 'insert') {
        const r = await p.busy('Inserting…', async () => { if (src) await doc.insertFromOpen(at, src, list); else await doc.insertFrom(at, file, list); return true; });
        if (!r) return;
        p.setDialog(null);
        p.A.goTo?.(at);
        p.toast(`Inserted ${what} of ${srcName} ${at === 0 ? 'at the start' : at >= n ? 'at the end' : 'after page ' + at} – Ctrl+Z takes ${pages.length === 1 ? 'it' : 'them'} out again.`, 'ok', undefined, 6000);
      } else {
        const r = await p.busy('Replacing…', async () => { await doc.replacePages(tps, from, list); return true; });
        if (!r) return;
        p.setDialog(null);
        p.A.goTo?.(tps[0]);
        p.toast(`Replaced ${tps.length === 1 ? 'page ' + (tps[0] + 1) : 'pages ' + toRanges(tps)} with ${what} of ${srcName} – Ctrl+Z puts the old ${tps.length === 1 ? 'page' : 'pages'} back.`, 'ok', undefined, 7000);
      }
    } finally { setRunning(false); }
  };
  const label = mode === 'insert' ? `Insert ${pages.length && !problem ? pages.length + ' ' : ''}${pages.length === 1 ? 'page' : 'pages'}` : `Replace ${tps.length && !problem ? tps.length + ' ' : ''}${tps.length === 1 ? 'page' : 'pages'}`;
  return (
    <Modal title={mode === 'insert' ? 'Insert pages' : 'Replace pages'} sub={mode === 'insert' ? 'Pages of another file – open here or on disk – go into this one.' : 'Revised sheets: pages of this file are swapped for pages of another, the rest stays as it is.'} onClose={() => !running && p.setDialog(null)}
      actions={<><button className="btn" disabled={running} onClick={() => p.setDialog(null)}>Cancel</button><button className="btn primary" disabled={!!problem || running} onClick={() => void go()}>{label}</button></>}>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={mode === 'insert' ? 'on' : ''} onClick={() => setMode('insert')}>Insert</button>
        <button className={mode === 'replace' ? 'on' : ''} onClick={() => setMode('replace')}>Replace</button>
      </div>
      {mode === 'replace' && (
        <div className="row"><label>Replace pages (of {n})</label>
          <input className="input" autoFocus value={targets} onChange={(e) => setTargets(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} placeholder="e.g. 5 or 5-8" />
        </div>
      )}
      <div className="row"><label>{mode === 'replace' ? 'With pages from' : 'From'}</label>
        <div className="srclist">
          {others.map((d) => (
            <label key={d.id} className="check"><input type="radio" name="src" checked={srcId === d.id} onChange={() => { setSrcId(d.id); setFileErr(''); setRange(''); }} /> <span className="fn">{d.name}</span> <span className="faint">– open, {d.pages.length} {d.pages.length === 1 ? 'page' : 'pages'}{d.dirty ? ', with its unsaved changes' : ''}</span></label>
          ))}
          <div className="hrow">
            {others.length > 0 && <input type="radio" name="src" checked={!srcId} onChange={() => { setSrcId(''); if (!file) void pick(); }} />}
            <span className="grow fn">{file ? baseName(file) + (fileCount ? ` – ${fileCount} ${fileCount === 1 ? 'page' : 'pages'}` : '') : others.length ? 'A file on disk' : '—'}</span>
            <button className="btn sm" onClick={() => void pick()}>Choose…</button>
          </div>
        </div>
      </div>
      {count > 0 && <div className="row"><label>Pages to take (of {count})</label><input className="input" value={range} placeholder={mode === 'replace' ? (auto.length ? `${toRanges(auto)} – or e.g. 1-3, 5` : 'e.g. 1-3, 5') : `All ${count} – or e.g. 1-3, 5`} onChange={(e) => setRange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} /></div>}
      {mode === 'insert' && (
        <div className="row"><label>Where</label>
          <div className="hrow">
            <select className="input" value={where} onChange={(e) => setWhere(e.target.value as never)}>
              <option value="after">After page</option><option value="before">Before page</option><option value="start">At the start</option><option value="end">At the end</option>
            </select>
            {(where === 'after' || where === 'before') && <input className="input" style={{ width: 80 }} value={atText} onChange={(e) => setAtText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} />}
          </div>
        </div>
      )}
      <p className={'hint' + (problem && srcName && count > 0 ? ' err' : '')}>{problem || plan}</p>
      {mode === 'insert' && <p className="hint">Tip: you can also drag pages from one file's Pages panel onto another file's tab.</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------- links

/** what was typed as a link target -> the address, or why not (www.x.com -> https://; a@b.com -> mailto:) */
export function linkTarget(raw: string): { uri: string } | { err: string } {
  const t = raw.trim();
  if (!t) return { err: 'Type the web address, e.g. https://www.example.com' };
  if (/\s/.test(t)) return { err: 'A web address has no spaces.' };
  if (/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(t)) return { uri: t };
  if (/^[^@\s/:?]+@[^@\s/?]+\.[a-z]{2,}(\?\S*)?$/i.test(t)) return { uri: 'mailto:' + t };
  if (/^https?:\/\/[^\s/]+\.[^\s]+/i.test(t)) return { uri: t };
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(t)) return { uri: 'https://' + t };
  return { err: 'Links go to web pages (https://…), e-mail addresses or pages of this file – not to programs or files on the PC.' };
}

function LinkDlg(p: Props & { page: number; rect: Rect; edit?: { k: number; uri: string | null; page: number } }) {
  const doc = p.doc!;
  const n = doc.pages.length;
  const e = p.edit;
  const [to, setTo] = useState<'web' | 'page'>(e && e.page >= 0 ? 'page' : 'web');
  const [url, setUrl] = useState(e?.uri && !e.uri.startsWith('#') ? e.uri.replace(/^mailto:/i, '') : '');
  const [pg, setPg] = useState(e && e.page >= 0 ? String(e.page + 1) : '');
  const [busy, setBusy] = useState(false);
  const target = to === 'web' ? linkTarget(url) : (() => { const k = parseInt(pg, 10); return k >= 1 && k <= n && /^\s*\d+\s*$/.test(pg) ? { page: k - 1 } : { err: `Which page? 1 to ${n}.` }; })();
  const problem = 'err' in target ? target.err : '';
  const save = async (del = false) => {
    if (busy || (!del && problem)) return;
    setBusy(true);
    try {
      const spec = del ? null : 'page' in target ? { page: target.page } : { uri: (target as { uri: string }).uri };
      const r = await p.busy(del ? 'Deleting the link…' : 'Saving the link…', async () => { if (e) await doc.setLink(p.page, e.k, spec); else await doc.addLink(p.page, p.rect, spec!); return true; });
      if (!r) return;
      p.setDialog(null);
      p.toast(del ? 'Link deleted – Ctrl+Z puts it back.' : e ? 'Link changed.' : `Link made${'page' in target ? ' to page ' + (target.page + 1) : ''}. Click it with the Select tool to follow it.`, 'ok', undefined, 5000);
    } finally { setBusy(false); }
  };
  return (
    <Modal title={e ? 'Change link' : 'New link'} sub={e ? `A link on page ${p.page + 1}.` : `Clicking the box you drew on page ${p.page + 1} will go here.`} onClose={() => !busy && p.setDialog(null)}
      actions={<>{e && <button className="btn danger" disabled={busy} onClick={() => void save(true)}>Delete link</button>}<span className="grow" /><button className="btn" disabled={busy} onClick={() => p.setDialog(null)}>Cancel</button><button className="btn primary" disabled={!!problem || busy} onClick={() => void save()}>{e ? 'Save' : 'Make link'}</button></>}>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={to === 'web' ? 'on' : ''} onClick={() => setTo('web')}>Web page or e-mail</button>
        <button className={to === 'page' ? 'on' : ''} onClick={() => setTo('page')}>Page in this file</button>
      </div>
      {to === 'web'
        ? <div className="row"><label>Address</label><input className="input" autoFocus value={url} onChange={(ev) => setUrl(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') void save(); }} placeholder="https://www.example.com or name@company.com" /></div>
        : <div className="row"><label>Page (1 to {n})</label><input className="input" autoFocus style={{ width: 120 }} value={pg} onChange={(ev) => setPg(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') void save(); }} placeholder={String(Math.min(n, p.page + 2))} /></div>}
      <p className={'hint' + (problem && (url || pg) ? ' err' : '')}>{problem && (url || pg) ? problem : 'page' in target ? `Goes to page ${target.page + 1}${doc.pages[target.page]?.label && doc.pages[target.page].label !== String(target.page + 1) ? ' (' + doc.pages[target.page].label + ')' : ''}.` : 'uri' in target ? `Goes to ${target.uri}${/^https?:/.test(target.uri) ? ' – people clicking it are asked first' : ''}.` : 'People clicking a web link are always asked before it opens.'}</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- pages <-> pictures

interface FileSpecLite { path: string; size?: number; delta?: string; mtime?: number }

/**
 * Pages saved as PNG or JPG pictures (markups as shown): one page to a file named in a Save
 * dialog, several into a folder ("<file> - p007.png"). Read in the batch engine from the file as
 * it is now; a page too big for the resolution asked (an A0 at 600 dpi) is made at less, and said.
 */
function ToPicturesDlg(p: Props) {
  const doc = p.doc!;
  const n = doc.pages.length;
  const kept = (() => { try { return JSON.parse(localStorage.getItem('to-pictures') || '{}') as { format?: 'png' | 'jpg'; dpi?: number }; } catch { return {}; } })();
  const [range, setRange] = useState(() => toRanges(p.pageSel.length ? p.pageSel : [p.A.currentPage?.() ?? 0]));
  const [format, setFormat] = useState<'png' | 'jpg'>(kept.format || 'png');
  const [dpi, setDpi] = useState(kept.dpi || 150);
  const [prog, setProg] = useState<{ text: string; pct: number } | null>(null);
  const stop = useRef(false);
  const ps = parseRanges(range, n);
  const first = ps.length ? doc.pages[ps[0]] : null;
  const px = (pg: { w: number; h: number }, d: number) => {
    let k = d / 72;
    if ((pg.w * k) * (pg.h * k) > 60e6) k = Math.sqrt(60e6 / (pg.w * pg.h));
    return [Math.round(pg.w * k), Math.round(pg.h * k), Math.round(k * 72)];
  };
  const size = first ? px(first, dpi) : null;
  const problem = !range.trim() ? 'Type the pages, e.g. 1-3, 5, or all.' : !ps.length ? `None of those pages are in this file (it has ${n}).` : '';
  const ext = format === 'jpg' ? 'jpg' : 'png';
  const base = doc.name.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_');
  const once = useRef(false);
  const go = async () => {
    // (a second click while the save / folder dialog is up would start a second job)
    if (problem || prog || once.current) return;
    once.current = true;
    try { await go1(); } finally { once.current = false; }
  };
  const go1 = async () => {
    try { localStorage.setItem('to-pictures', JSON.stringify({ format, dpi })); } catch { /* fine */ }
    // where: one page - a file; several - a folder, the names made from the file's
    const digits = String(n).length;
    const nameOf = (i: number) => `${base} - p${String(i + 1).padStart(Math.max(2, digits), '0')}.${ext}`;
    let targets: string[] = [];
    let folder = '';
    if (ps.length === 1) {
      const t = await gcc.saveDialog({ title: 'Save the page as a picture', name: `${base} - page ${ps[0] + 1}.${ext}`, path: doc.path ? joinPath(dirName(doc.path), `${base} - page ${ps[0] + 1}.${ext}`) : undefined, filters: [{ name: format === 'jpg' ? 'JPG picture' : 'PNG picture', extensions: [ext] }] });
      if (!t) return;
      targets = [new RegExp('\\.' + ext + '$', 'i').test(t) ? t : t.replace(/\.(png|jpe?g)$/i, '') + '.' + ext];
      folder = dirName(targets[0]);
    } else {
      const d = await gcc.dirDialog({ title: `Choose the folder for the ${ps.length} pictures`, dir: doc.path ? dirName(doc.path) : undefined });
      if (!d) return;
      folder = d;
      targets = ps.map((i) => joinPath(d, nameOf(i)));
      const there: string[] = [];
      for (const t of targets) if (await gcc.exists(t)) there.push(t);
      if (there.length) {
        const r = await gcc.confirm({ message: `${there.length} of these pictures ${there.length === 1 ? 'is' : 'are'} in that folder already`, detail: there.slice(0, 6).map((t) => baseName(t)).join('\n') + (there.length > 6 ? `\n…and ${there.length - 6} more` : '') + '\n\nReplace them?', buttons: ['Replace', 'Cancel'], type: 'warning' });
        if (r !== 0) return;
      }
    }
    stop.current = false;
    setProg({ text: 'Getting ready…', pct: 0 });
    let id: string | null = null;
    let snap: string | null = null;
    let done = 0;
    const smaller: string[] = [];
    try {
      const src = await mu<FileSpecLite>('drawSnapshot', doc.id, false);
      snap = src.delta || src.path;
      id = await muBatch<string>('batchOpen', fileArg(src.path, { size: src.size, delta: src.delta, mtime: src.mtime }), doc.password);
      for (const [k, i] of ps.entries()) {
        if (stop.current) break;
        setProg({ text: `Page ${i + 1} (${k + 1} of ${ps.length})…`, pct: k / ps.length });
        const r = await muBatchFile<{ bytes: FileRef; dpi: number }>('pageImage', id, i, { dpi, format, quality: 85 });
        if (r.dpi < dpi) smaller.push(`${i + 1} (${r.dpi} dpi)`);
        try { await gcc.commit(r.bytes.$file.path, targets[k], { noBackup: true }); } catch (e) { void gcc.dropTemp([r.bytes.$file.path]); throw e; }
        done++;
      }
      setProg(null);
      p.setDialog(null);
      const note = smaller.length ? ` – page${smaller.length === 1 ? '' : 's'} ${smaller.slice(0, 4).join(', ')}${smaller.length > 4 ? '…' : ''} made smaller (too big at ${dpi} dpi)` : '';
      if (done === 1) p.toast(`Saved ${baseName(targets[0])}${note}`, 'ok', { label: 'Open', run: () => void gcc.openExternal(targets[0]) }, 9000);
      else p.toast(`Saved ${done} picture${done === 1 ? '' : 's'}${stop.current ? ` (stopped – ${ps.length - done} not made)` : ''} in ${baseName(folder) || folder}${note}`, 'ok', { label: 'Show', run: () => void gcc.showInFolder(targets[0]) }, 9000);
    } catch (e) {
      setProg(null);
      p.fail(e);
    } finally {
      if (id) void muBatch('close', id).catch(() => {});
      if (snap) void gcc.dropTemp([snap]).catch(() => {});
    }
  };
  return (
    <Modal title="Save pages as pictures" sub="Each page as a PNG or JPG file, markups as shown." onClose={() => { if (!prog) p.setDialog(null); }}
      actions={<><button className="btn" onClick={() => { if (prog) stop.current = true; else p.setDialog(null); }}>{prog ? 'Stop' : 'Cancel'}</button><button className="btn primary" disabled={!!problem || !!prog} onClick={() => void go()}>Save {ps.length} {ps.length === 1 ? 'picture' : 'pictures'}…</button></>}>
      {prog ? (
        <div className="xprog"><div className="prog"><span className="dot busy" /> {prog.text}</div><div className="bar"><i style={{ width: Math.round(prog.pct * 100) + '%' }} /></div></div>
      ) : (
        <>
          <div className="row"><label>Pages (of {n})</label>
            <div className="hrow"><input className="input" autoFocus value={range} onChange={(e) => setRange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} placeholder="e.g. 1-3, 5" /><button className="btn sm ghost" onClick={() => setRange('1-' + n)}>All {n}</button></div>
          </div>
          <div className="row"><label>Format</label>
            <div className="seg"><button className={format === 'png' ? 'on' : ''} onClick={() => setFormat('png')} title="Sharp lines and text – drawings, tables">PNG – sharp</button><button className={format === 'jpg' ? 'on' : ''} onClick={() => setFormat('jpg')} title="Smaller files – photos, scans">JPG – smaller</button></div>
          </div>
          <div className="row"><label>Resolution</label>
            <select className="input" value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
              {[[96, 'screen'], [150, 'good for most'], [200, ''], [300, 'print'], [600, 'fine print']].map(([v, t]) => <option key={v} value={v}>{v} dpi{t ? ' – ' + t : ''}</option>)}
            </select>
          </div>
          <p className={'hint' + (problem ? ' err' : '')}>{problem || (size ? `${ps.length === 1 ? 'Page ' + (ps[0] + 1) + ' becomes' : ps.length + ' pages (' + toRanges(ps) + ') – page ' + (ps[0] + 1) + ' becomes'} ${size[0].toLocaleString()} × ${size[1].toLocaleString()} pixels${size[2] < dpi ? ` (at ${size[2]} dpi: too big at ${dpi})` : ''}.` : '')}</p>
          <p className="hint">{ps.length > 1 ? `They go into a folder you choose, named “${base} - p01.${ext}”…` : 'You choose the name and place next.'}</p>
        </>
      )}
    </Modal>
  );
}

/** pictures and scans (JPG, PNG, TIFF - each page of a multi-page one -, BMP, GIF) made into one
 *  new PDF, opened as a tab to check and save */
function FromPicturesDlg(p: Props & { files: string[] }) {
  const [files, setFiles] = useState<string[]>(p.files);
  const kept = (() => { try { return JSON.parse(localStorage.getItem('from-pictures') || '{}') as { size?: 'picture' | 'a4' | 'a3' | 'letter'; margin?: boolean }; } catch { return {}; } })();
  const [size, setSize] = useState<'picture' | 'a4' | 'a3' | 'letter'>(kept.size || 'picture');
  const [margin, setMargin] = useState(kept.margin ?? false);
  const [running, setRunning] = useState(false);
  useDropFiles((f) => { if (running) { p.toast('Not added – wait until the PDF is made.', 'info'); return; } setFiles((x) => [...x, ...f.filter((y) => !x.includes(y))]); }, PICTURE_RE, (t) => p.toast(t, 'info', undefined, 7000));
  useEffect(() => { if (!p.files.length) void pickPictures().then((f) => setFiles((x) => [...x, ...f.filter((y) => !x.includes(y))])); }, []);
  const go = async () => {
    if (!files.length || running) return;
    try { localStorage.setItem('from-pictures', JSON.stringify({ size, margin })); } catch { /* fine */ }
    setRunning(true);
    try {
      const r = await p.busy(`Making a PDF of ${files.length} picture${files.length === 1 ? '' : 's'}…`, () => muBatchFile<{ bytes: FileRef; pages: number; skipped: string[] }>('picturesToPdf', files.map((f) => ({ bytes: fileArg(f), name: baseName(f) })), { size, margin: margin ? 28.35 : 0 }));
      if (!r) return;
      const name = (files.length === 1 ? baseName(files[0]).replace(/\.[^.]+$/, '') : baseName(dirName(files[0])) || 'Pictures') + '.pdf';
      const tab = await p.newFromFile(r.bytes.$file.path, name, true);
      p.setDialog(null);
      p.A.showDoc(tab.id);
      // (scans have no text yet: reading them is one click away)
      p.toast(`Made ${name}: ${r.pages} page${r.pages === 1 ? '' : 's'}${r.skipped.length ? ` – not read: ${r.skipped.join(', ')}` : ''}. Save it when you're happy with it.`, r.skipped.length ? 'info' : 'ok', { label: 'Make searchable (OCR)', run: () => p.A.ocrOf(tab.id) }, 12000);
    } catch (e) { p.fail(e); } finally { setRunning(false); }
  };
  return (
    <Modal title="New PDF from pictures" wide sub="Photos, scans and screenshots become the pages of one PDF, in the order listed. A multi-page TIFF gives all its pages." onClose={() => { if (!running) p.setDialog(null); }}
      actions={<><button className="btn" disabled={running} onClick={() => p.setDialog(null)}>Cancel</button><button className="btn primary" disabled={!files.length || running} onClick={() => void go()}>Make PDF{files.length ? ` (${files.length} picture${files.length === 1 ? '' : 's'})` : ''}</button></>}>
      <FileList files={files} setFiles={setFiles} locked={running} pictures />
      <div className="row"><label>Page size</label>
        <div className="seg">
          {([['picture', 'As each picture'], ['a4', 'A4'], ['a3', 'A3'], ['letter', 'Letter']] as const).map(([k, t]) => <button key={k} className={size === k ? 'on' : ''} onClick={() => setSize(k)}>{t}</button>)}
        </div>
      </div>
      {size !== 'picture' && <label className="check"><input type="checkbox" checked={margin} onChange={(e) => setMargin(e.target.checked)} /> A 10 mm margin round each picture</label>}
      <p className="hint">{size === 'picture' ? 'Each page is the size of its picture at the picture’s own resolution (a 300 dpi A4 scan stays A4).' : `Each picture is fitted on ${size === 'letter' ? 'Letter' : size.toUpperCase()} paper, turned to suit it (landscape pictures on landscape pages).`} JPGs go in as they are – no quality lost.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- compress

const PRESETS = {
  light: { label: 'Light – no visible change', dpi: 300, quality: 85 },
  balanced: { label: 'Balanced – good for email', dpi: 150, quality: 70 },
  strong: { label: 'Strong – smallest', dpi: 96, quality: 55 },
};

function CompressDlg(p: Props & { files?: string[] }) {
  const [files, setFiles] = useState<string[]>(p.files || []);
  const [preset, setPreset] = useState<keyof typeof PRESETS>('balanced');
  const [mode, setMode] = useState<OutMode>('suffix');
  const [suffix, setSuffix] = useState(' (small)');
  const [folder, setFolder] = useState('');
  const [res, setRes] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const lock = useRef(false);
  useDropFiles((f) => { if (running) { p.toast('Not added – wait until it has finished.', 'info'); return; } setFiles((x) => [...x, ...f.filter((y) => !x.includes(y))]); }, undefined, (t) => p.toast(t, 'info', undefined, 7000));
  // more files from Explorer's Combine while this is open: added at the end (not while running)
  useEffect(() => {
    const add = (e: Event) => { const f = (e as CustomEvent<string[]>).detail || []; setFiles((x) => (lock.current ? x : [...x, ...f.filter((y) => !x.includes(y))])); };
    window.addEventListener('gcc-merge-add', add);
    return () => window.removeEventListener('gcc-merge-add', add);
  }, []);
  const plan = planFor(p, files, mode, suffix, folder);
  const go = async () => {
    if (lock.current) return; // (a second click while asking / working)
    lock.current = true;
    try {
      const pl = await startPlan(p, files, mode, suffix, folder, setRes);
      if (!pl) return;
      setRunning(true);
      let saved = 0, n = 0;
      for (const f of files) {
        const target = pl.out.get(f);
        if (!target) continue;
        setRes((r) => ({ ...r, [f]: 'working…' }));
        try {
          // an open file: as it is now (with unsaved markups), opened with the password it was
          // opened with; others straight from disk
          const open = p.docs.find((d) => d.path === f);
          const input = open ? await open.fileForSave({}) : null;
          let r1: { bytes: FileRef | null; report: { images: number; changed: number; before: number; after: number } };
          try { r1 = await muBatchFile('compress', fileArg(input || f), { dpi: PRESETS[preset].dpi, quality: PRESETS[preset].quality }, open?.password); }
          finally { if (input) void gcc.dropTemp([input]); }
          const { bytes: out, report } = r1;
          // (what happened, not a claim about the file: it may be big and have nothing to shrink)
          if (!out || report.after >= report.before * 0.98) { if (out) void gcc.dropTemp([out.$file.path]); setRes((r) => ({ ...r, [f]: `${report.images ? 'could not be made smaller' : 'no pictures to make lighter'} (${sizeTxt(report.before)}) – left as it is` })); continue; }
          await gcc.commit(out.$file.path, target, { noBackup: mode !== 'replace' });
          saved += report.before - report.after; n++;
          setRes((r) => ({ ...r, [f]: `${sizeTxt(report.before)} → ${sizeTxt(report.after)} (−${Math.round((1 - report.after / report.before) * 100)}%)` }));
        } catch (e) { setRes((r) => ({ ...r, [f]: 'failed: ' + String((e as Error).message || e) })); }
      }
      if (n) p.toast(`Saved ${n} smaller file${n > 1 ? 's' : ''} – ${sizeTxt(saved)} less in total.`, 'ok');
    } finally { setRunning(false); lock.current = false; }
  };
  return (
    <Modal title="Reduce file size" wide onClose={() => !running && p.setDialog(null)} sub="Pictures and scans are made lighter; line work and text stay exactly as they are. Unused data is cleaned out."
      actions={<><button className="btn" disabled={running} onClick={() => p.setDialog(null)}>Close</button><button className="btn primary" disabled={running || !files.length || !!plan.problem} onClick={() => void go()}>{running ? 'Working…' : `Reduce ${files.length} file${files.length === 1 ? '' : 's'}`}</button></>}>
      <div className="row"><label>How much</label><div className="seg full">{(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((k) => <button key={k} className={preset === k ? 'on' : ''} disabled={running} onClick={() => setPreset(k)}>{PRESETS[k].label}</button>)}</div></div>
      <FileList files={files} setFiles={setFiles} locked={running} extra={(f) => <span className="faint res">{res[f] || ''}</span>} />
      <OutputChoice mode={mode} setMode={setMode} suffix={suffix} setSuffix={setSuffix} folder={folder} setFolder={setFolder} allowReplace locked={running} problem={files.length ? plan.problem : null} />
    </Modal>
  );
}

// ---------------------------------------------------------------- page marks (numbers, headers, bates, watermark, stamp)

/** a Bates start / digits box as a whole number: 0 is a number ("|| 1" turned it into 1) and
 *  "1,000" is a thousand (it was read as 1); anything else that isn't a number: the default */
const batesNum = (s: string, dflt: number) => { const t = s.replace(/[\s,'\u2019]/g, ''); const v = Number(t); return t && Number.isInteger(v) && v >= 0 ? v : dflt; };

interface MarkForm {
  header: [string, string, string]; footer: [string, string, string]; hfSize: number; hfColor: RGB;
  numbers: boolean; numFormat: string; numPos: PageMark['pos'];
  bates: boolean; batesPrefix: string; batesStart: string; batesDigits: string; batesPos: PageMark['pos'];
  wm: boolean; wmText: string; wmSize: number; wmAngle: number; wmOpacity: number; wmColor: RGB; wmUnder: boolean;
  stamp: string; stampPos: PageMark['pos']; stampWidth: number;
  range: string; margin: number;
}
const MARK_DEFAULT: MarkForm = {
  header: ['', '', ''], footer: ['', '', ''], hfSize: 8, hfColor: [0.2, 0.2, 0.2],
  numbers: true, numFormat: 'Page {page} of {pages}', numPos: 'bc',
  bates: false, batesPrefix: '', batesStart: '1', batesDigits: '6', batesPos: 'br',
  wm: false, wmText: 'FOR TENDER PURPOSES ONLY', wmSize: 54, wmAngle: 45, wmOpacity: 0.15, wmColor: [0.8, 0.1, 0.1], wmUnder: false,
  stamp: '', stampPos: 'tr', stampWidth: 140, range: '', margin: 24,
};

function buildMarks(f: MarkForm, stamps: StampDef[]): PageMark[] {
  const m: PageMark[] = [];
  const t = (text: string, pos: PageMark['pos'], size = f.hfSize, extra: Partial<PageMark> = {}) => text.trim() && m.push({ kind: 'text', text, pos, size, color: f.hfColor, mx: f.margin, my: f.margin * 0.7, ...extra });
  (['tl', 'tc', 'tr'] as const).forEach((pos, i) => t(f.header[i], pos));
  (['bl', 'bc', 'br'] as const).forEach((pos, i) => t(f.footer[i], pos));
  if (f.numbers) t(f.numFormat, f.numPos, Math.max(f.hfSize, 9));
  if (f.bates) t('{bates}', f.batesPos, Math.max(f.hfSize, 9), { bold: true, color: [0, 0, 0] });
  if (f.wm && f.wmText.trim()) m.push({ kind: 'text', text: f.wmText, pos: 'mc', size: f.wmSize, angle: f.wmAngle, opacity: f.wmOpacity, color: f.wmColor, bold: true, under: f.wmUnder });
  const st = stamps.find((s) => s.id === f.stamp);
  if (st?.design) m.push({ kind: 'stamp', design: st.design, pos: f.stampPos, width: f.stampWidth, mx: f.margin, my: f.margin });
  if (st?.image) {
    // a damaged saved picture (cut short, not base64) is said instead of the click doing nothing
    let image: Uint8Array | null = null;
    try { image = Uint8Array.from(atob(st.image.split(',')[1] || ''), (c) => c.charCodeAt(0)); } catch { /* below */ }
    if (!image?.length) throw new Error(`The picture of the stamp "${st.name}" can't be read – add it again (Stamp).`);
    m.push({ kind: 'image', image, pos: f.stampPos, width: f.stampWidth, mx: f.margin, my: f.margin });
  }
  return m;
}

function PosPick({ v, set }: { v: PageMark['pos']; set(p: PageMark['pos']): void }) {
  const all: PageMark['pos'][] = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
  return <span className="pospick">{all.map((p) => <button key={p} className={v === p ? 'on' : ''} onClick={() => set(p)} title={p} />)}</span>;
}

function MarksDlg(p: Props & { batch: boolean }) {
  const [f, setF] = useState<MarkForm>(() => { try { return { ...MARK_DEFAULT, ...JSON.parse(localStorage.getItem('marks') || '{}') }; } catch { return MARK_DEFAULT; } });
  const [files, setFiles] = useState<string[]>([]);
  const [mode, setMode] = useState<OutMode>('suffix');
  const [suffix, setSuffix] = useState(' (stamped)');
  const [folder, setFolder] = useState('');
  const [res, setRes] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const lock = useRef(false);
  useDropFiles((x) => { if (running) { p.toast('Not added – wait until it has finished.', 'info'); return; } setFiles((y) => [...y, ...x.filter((z) => !y.includes(z))]); }, undefined, (t) => p.toast(t, 'info', undefined, 7000));
  const up = (patch: Partial<MarkForm>) => setF((x) => { const n = { ...x, ...patch }; try { localStorage.setItem('marks', JSON.stringify(n)); } catch { /* ok */ } return n; });
  const stamps = [...BUILTIN_STAMPS, ...(p.settings.stamps || [])];
  const onDoc = !p.batch && !!p.doc;
  const plan = planFor(p, files, mode, suffix, folder);
  const go = async () => {
    // ({date} and {time} from one moment - a dialog left open over midnight)
    const now = new Date();
    const date = now.toLocaleDateString('en-GB');
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    let marks: PageMark[];
    try { marks = buildMarks(f, stamps.map((s) => (s.design ? { ...s, design: { ...s.design, lines: s.design.lines.map((l) => ({ ...l, text: l.text.replace(/\{name\}/g, p.author).replace(/\{date\}/g, date).replace(/\{time\}/g, time) })) } } : s))); }
    catch (e) { p.toast(String((e as Error).message || e), 'err', undefined, 7000); return; }
    if (!marks.length) { p.toast('Nothing to add – fill in at least one mark.', 'info'); return; }
    if (onDoc) {
      const doc = p.doc!;
      const rng = f.range.trim() ? parseRanges(f.range, doc.pages.length) : null;
      // (a list with none of this file's pages - "1–5" with a long dash, "99" - marked nothing
      // and said "Done")
      if (rng && !rng.length) { p.toast(`No pages of this file in “${f.range.trim()}” (it has ${doc.pages.length}) – e.g. 2-10.`, 'err'); return; }
      const ctx = { file: doc.name.replace(/\.pdf$/i, ''), date, batesPrefix: f.batesPrefix, batesStart: batesNum(f.batesStart, 1), batesDigits: Math.min(15, batesNum(f.batesDigits, 6)), pages: rng ?? undefined };
      // (failed, or already running from a first click: no "Done", the dialog stays)
      const ok = await p.busy('Adding marks…', async () => { await doc.markPages(marks, ctx); return true; });
      if (!ok) return;
      p.setDialog(null);
      p.toast('Done – these marks are now part of the pages (Ctrl+Z to undo).', 'ok');
      return;
    }
    if (lock.current) return;
    lock.current = true;
    try {
      const pl = await startPlan(p, files, mode, suffix, folder, setRes);
      if (!pl) return;
      setRunning(true);
      let bates = batesNum(f.batesStart, 1), made = 0;
      for (const file of files) {
        const target = pl.out.get(file);
        if (!target) continue;
        setRes((r) => ({ ...r, [file]: 'working…' }));
        try {
          const n = await muBatch<number>('pageCountOf', fileArg(file));
          const rng = f.range.trim() ? parseRanges(f.range, n) : null;
          if (rng && !rng.length) { setRes((x) => ({ ...x, [file]: `left out: none of its ${n} pages are in “${f.range.trim()}”` })); continue; }
          const r = await muBatchFile<{ bytes: FileRef; pages: number }>('batchMark', fileArg(file), marks, { file: baseName(file).replace(/\.pdf$/i, ''), date, batesPrefix: f.batesPrefix, batesStart: bates, batesDigits: Math.min(15, batesNum(f.batesDigits, 6)), pages: rng ?? undefined });
          bates += r.pages; // Bates numbers run on across the files (the pages marked)
          await gcc.commit(r.bytes.$file.path, target, { noBackup: mode !== 'replace' });
          made++;
          setRes((x) => ({ ...x, [file]: `done – ${r.pages} ${r.pages === 1 ? 'page' : 'pages'} marked` }));
        } catch (e) { setRes((x) => ({ ...x, [file]: 'failed: ' + String((e as Error).message || e) })); }
      }
      p.toast(made === files.length ? `Stamped ${made} file${made === 1 ? '' : 's'}.` : `Stamped ${made} of ${files.length} files – the list says why not the others.`, made === files.length ? 'ok' : 'info');
    } finally { setRunning(false); lock.current = false; }
  };
  return (
    <Modal title={onDoc ? 'Page numbers, headers & watermark' : 'Stamp & number files'} wide="xl" onClose={() => !running && p.setDialog(null)}
      sub="Fields: {page} {pages} {date} {file} {bates}. Marks become part of the page."
      actions={<><button className="btn" disabled={running} onClick={() => p.setDialog(null)}>Close</button><button className="btn primary" disabled={running || (!onDoc && (!files.length || !!plan.problem))} onClick={() => void go()}>{onDoc ? 'Apply to this file' : running ? 'Working…' : `Apply to ${files.length} ${files.length === 1 ? 'file' : 'files'}`}</button></>}>
      <div className="marks">
        <div className="mcol">
          <div className="mbox"><b>Header</b><div className="hrow">{[0, 1, 2].map((i) => <input key={i} className="input sm" placeholder={['Left', 'Centre', 'Right'][i]} value={f.header[i]} onChange={(e) => { const h = f.header.slice() as MarkForm['header']; h[i] = e.target.value; up({ header: h }); }} />)}</div></div>
          <div className="mbox"><b>Footer</b><div className="hrow">{[0, 1, 2].map((i) => <input key={i} className="input sm" placeholder={['Left', 'Centre', 'Right'][i]} value={f.footer[i]} onChange={(e) => { const h = f.footer.slice() as MarkForm['footer']; h[i] = e.target.value; up({ footer: h }); }} />)}</div>
            <div className="hrow"><span className="plab">Size</span><NumIn className="input xs" min={1} max={144} value={f.hfSize} onChange={(v) => up({ hfSize: v })} /><span className="plab">Margin</span><NumIn className="input xs" min={0} max={500} value={f.margin} onChange={(v) => up({ margin: v })} /><span className="faint">pt</span></div>
          </div>
          <div className="mbox"><label className="check"><input type="checkbox" checked={f.numbers} onChange={(e) => up({ numbers: e.target.checked })} /> <b>Page numbers</b></label>
            <div className="hrow"><input className="input sm" value={f.numFormat} onChange={(e) => up({ numFormat: e.target.value })} /><PosPick v={f.numPos} set={(x) => up({ numPos: x })} /></div></div>
          <div className="mbox"><label className="check"><input type="checkbox" checked={f.bates} onChange={(e) => up({ bates: e.target.checked })} /> <b>Bates numbers</b> <span className="faint">(run on across files)</span></label>
            <div className="hrow"><span className="plab">Prefix</span><input className="input xs" value={f.batesPrefix} onChange={(e) => up({ batesPrefix: e.target.value })} /><span className="plab">Start</span><input className="input xs" value={f.batesStart} onChange={(e) => up({ batesStart: e.target.value })} /><span className="plab">Digits</span><input className="input xs" value={f.batesDigits} onChange={(e) => up({ batesDigits: e.target.value })} /><PosPick v={f.batesPos} set={(x) => up({ batesPos: x })} /></div></div>
        </div>
        <div className="mcol">
          <div className="mbox"><label className="check"><input type="checkbox" checked={f.wm} onChange={(e) => up({ wm: e.target.checked })} /> <b>Watermark</b></label>
            <input className="input sm" value={f.wmText} onChange={(e) => up({ wmText: e.target.value })} />
            <div className="hrow"><span className="plab">Size</span><NumIn className="input xs" min={1} max={1000} value={f.wmSize} onChange={(v) => up({ wmSize: v })} /><span className="plab">Angle</span><input className="input xs" type="number" value={f.wmAngle} onChange={(e) => up({ wmAngle: Number(e.target.value) || 0 })} />
              <span className="plab">Opacity</span><select className="input xs" value={f.wmOpacity} onChange={(e) => up({ wmOpacity: Number(e.target.value) })}>{[0.08, 0.15, 0.25, 0.4, 0.6, 1].map((o) => <option key={o} value={o}>{Math.round(o * 100)}%</option>)}</select>
              <input type="color" value={hex(f.wmColor)} onChange={(e) => up({ wmColor: fromHex(e.target.value) })} /></div>
            <label className="check sm"><input type="checkbox" checked={f.wmUnder} onChange={(e) => up({ wmUnder: e.target.checked })} /> Behind the page content</label>
          </div>
          <div className="mbox"><b>Stamp on every page</b>
            <div className="hrow"><select className="input sm" value={f.stamp} onChange={(e) => up({ stamp: e.target.value })}><option value="">— none —</option>{stamps.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><PosPick v={f.stampPos} set={(x) => up({ stampPos: x })} /></div>
            <div className="hrow"><span className="plab">Width</span><NumIn className="input xs" min={10} max={2000} value={f.stampWidth} onChange={(v) => up({ stampWidth: v })} /><span className="faint">pt</span></div>
          </div>
          <div className="mbox"><b>Pages</b><input className="input sm" placeholder="All pages (or e.g. 2-10)" value={f.range} onChange={(e) => up({ range: e.target.value })} /></div>
        </div>
      </div>
      {!onDoc && (
        <>
          <FileList files={files} setFiles={setFiles} locked={running} extra={(x) => <span className="faint res">{res[x] || ''}</span>} />
          <OutputChoice mode={mode} setMode={setMode} suffix={suffix} setSuffix={setSuffix} folder={folder} setFolder={setFolder} allowReplace locked={running} problem={files.length ? plan.problem : null} />
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- protect

function ProtectDlg(p: Props) {
  const doc = p.doc!;
  const [user, setUser] = useState('');
  const [owner, setOwner] = useState('');
  const [print, setPrint] = useState(true);
  const [copy, setCopy] = useState(true);
  const [edit, setEdit] = useState(false);
  const [notes, setNotes] = useState(true);
  const comma = /,/.test(user + owner);
  const go = async () => {
    // PDF permission bits: print 3 (+12 high quality), modify 4, copy 5, annotate 6, fill 9, extract 10, assemble 11
    let perm = 0xfffff0c0;
    if (print) perm |= (1 << 2) | (1 << 11);
    if (edit) perm |= (1 << 3) | (1 << 10);
    if (copy) perm |= (1 << 4) | (1 << 9);
    if (notes) perm |= (1 << 5) | (1 << 8);
    const target = await gcc.saveDialog({ title: 'Save the protected copy', name: doc.name.replace(/\.pdf$/i, '') + ' (protected).pdf' });
    if (!target) return;
    const b = await p.busy('Protecting…', () => doc.fileForSave({ password: { user, owner: owner || user, permissions: perm | 0 } }));
    if (!b) return;
    // (the target open in another program, or a read-only folder: said, and the temp copy goes)
    try { await gcc.commit(b, target, { noBackup: true }); }
    catch (e) { void gcc.dropTemp([b]); p.toast('Could not save the protected copy: ' + String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err', undefined, 9000); return; }
    p.setDialog(null);
    p.toast('Saved ' + baseName(target), 'ok');
  };
  return (
    <Modal title="Protect with a password" onClose={() => p.setDialog(null)} sub="AES-256. Saved as a new file; this one stays as it is."
      actions={<><button className="btn" onClick={() => p.setDialog(null)}>Cancel</button><button className="btn primary" disabled={(!user && !owner) || comma} onClick={() => void go()}>Save protected copy…</button></>}>
      <div className="row"><label>Password to open (leave empty: anyone can open, only the limits below apply)</label><input className="input" type="password" value={user} onChange={(e) => setUser(e.target.value)} /></div>
      <div className="row"><label>Password to change the limits</label><input className="input" type="password" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="(same as above)" /></div>
      {comma && <p className="hint err">A password can't contain a comma (,).</p>}
      <div className="row"><label>Allow</label>
        <label className="check"><input type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} /> Printing</label>
        <label className="check"><input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} /> Copying text and pictures</label>
        <label className="check"><input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} /> Comments and form filling</label>
        <label className="check"><input type="checkbox" checked={edit} onChange={(e) => setEdit(e.target.checked)} /> Changing pages and content</label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- OCR (this file)

/** 95 s -> "2 min", 20 s -> "20 s" */
const fmtLeft = (ms: number) => (ms < 60000 ? Math.max(5, Math.round(ms / 5000) * 5) + ' s' : Math.round(ms / 60000) + ' min');

function OcrDlg(p: Props) {
  const doc = p.doc!;
  const given = (p.dialog as { pages?: number[] }).pages;
  const [which, setWhich] = useState<'all' | 'this' | 'range'>(given?.length ? 'range' : 'all');
  const [range, setRange] = useState(() => (given?.length ? toRanges(given) : ''));
  const [lang, setLang] = useState<OcrLang>(ocrLangOf(p.settings.ocrLang));
  const [redo, setRedo] = useState(false);
  const [prog, setProg] = useState<string | null>(null);
  const stop = useRef(false);
  const started = useRef(false);
  const go = async () => {
    const cur = 0;
    const pages = which === 'all' ? [...doc.pages.keys()] : which === 'this' ? [cur] : parseRanges(range, doc.pages.length);
    if (!pages.length) { p.toast(`No pages of this file in that list (it has ${doc.pages.length}) – e.g. 1-5, 9.`, 'err'); return; }
    // (busy from the first click on: Start stayed on while the pages were looked at, and a
    // second click read the whole file twice)
    if (started.current) return;
    started.current = true;
    setProg('Looking at the pages…');
    stop.current = false;
    let done = 0, skipped = 0, words = 0;
    try {
      // pages that already have real text are left alone (a previous OCR layer counts too)
      const todo: number[] = [];
      for (const i of pages) {
        if (stop.current) break;
        // (redo: pages with real text are still left alone - an OCR copy over them made every
        // word come up twice in search and copy; only this app's own OCR layer is replaced)
        const st = await mu<'none' | 'ours' | 'text'>('ocrState', doc.id, i);
        if (st === 'text' || (st === 'ours' && !redo)) skipped++; else todo.push(i);
      }
      const t0 = Date.now();
      setProg(`Reading ${todo.length} page${todo.length === 1 ? '' : 's'}…`);
      await ocrPages(doc.id, todo.map((i) => ({ i, w: doc.pages[i].w, h: doc.pages[i].h })), lang, async (i, w) => {
        // (the whole run is one undo step: Ctrl+Z once takes it all back, not page by page)
        if (w.length) { await doc.addTextLayer(i, w.map((x) => ({ text: x.text, box: x.box })), words > 0); words += w.length; }
        done++;
        const left = todo.length - done;
        const each = (Date.now() - t0) / done;
        setProg(`Read ${done} of ${todo.length} pages${left ? ` – about ${fmtLeft(each * left)} left` : '…'}`);
      }, () => stop.current);
      p.setDialog(null);
      p.toast(`Text recognised on ${done} page${done === 1 ? '' : 's'} (${words} words)${skipped ? `, ${skipped} already had text` : ''}. Save to keep it.`, 'ok', undefined, 8000);
    } catch (e) { p.fail(e); setProg(null); } finally { started.current = false; }
  };
  return (
    <Modal title="Make scanned pages searchable" onClose={() => { stop.current = true; p.setDialog(null); }}
      sub="Reads the page images (offline) and adds invisible text, so you can search, select and copy. The pages look exactly the same."
      actions={<><button className="btn" onClick={() => { stop.current = true; if (!prog) p.setDialog(null); }}>{prog ? 'Stop' : 'Cancel'}</button><button className="btn primary" disabled={!!prog} onClick={() => void go()}>Start</button></>}>
      {prog ? <div className="prog"><span className="dot busy" /> {prog}</div> : (
        <>
          <div className="row"><label>Pages</label>
            <div className="seg"><button className={which === 'all' ? 'on' : ''} onClick={() => setWhich('all')}>All {doc.pages.length}</button><button className={which === 'range' ? 'on' : ''} onClick={() => setWhich('range')}>Some</button></div>
            {which === 'range' && <input className="input" placeholder="e.g. 1-5, 9" value={range} onChange={(e) => setRange(e.target.value)} />}
          </div>
          <div className="row"><label>Language</label><select className="input" value={lang} onChange={(e) => { setLang(e.target.value as OcrLang); p.saveSettings({ ocrLang: e.target.value as OcrLang }); }}><option value="eng+ara">English + Arabic</option><option value="eng">English</option><option value="ara">Arabic</option></select></div>
          <label className="check"><input type="checkbox" checked={redo} onChange={(e) => setRedo(e.target.checked)} /> Read again pages made searchable before (redo)</label>
          <p className="hint">Several pages are read at once. English only is faster than English + Arabic.</p>
        </>
      )}
    </Modal>
  );
}

function BatchOcrDlg(p: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [lang, setLang] = useState<OcrLang>(ocrLangOf(p.settings.ocrLang));
  const [mode, setMode] = useState<OutMode>('suffix');
  const [suffix, setSuffix] = useState(' (searchable)');
  const [folder, setFolder] = useState('');
  const [res, setRes] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const lock = useRef(false);
  useDropFiles((x) => { if (running) { p.toast('Not added – wait until it has finished.', 'info'); return; } setFiles((y) => [...y, ...x.filter((z) => !y.includes(z))]); }, undefined, (t) => p.toast(t, 'info', undefined, 7000));
  const plan = planFor(p, files, mode, suffix, folder);
  const go = async () => {
    if (lock.current) return;
    lock.current = true;
    try {
      stop.current = false;
      const pl = await startPlan(p, files, mode, suffix, folder, setRes);
      if (!pl) return;
      setRunning(true);
      for (const f of files) {
        if (stop.current) break;
        const target = pl.out.get(f);
        if (!target) continue;
        const rid = 'bocr-' + Math.random().toString(36).slice(2);
        let mid = '';
        let made: string | null = null;
        // (a drawing engine that starts afresh meanwhile - a planned restart of a big one, or out of
        // memory - gets the file again: it isn't a tab, the tabs' reopening misses it; the rest of
        // the file failed "Document is not open")
        const off = onEngineRestart((c, kind) => { if (kind === 'render') return c.call('open', [rid, fileArg(f), undefined]).then(() => {}); });
        try {
          // both engines read the file from disk on demand
          mid = await muBatch<string>('batchOpen', fileArg(f));
          // open in every drawing engine: pages are read side by side and any engine may draw one
          const info = (await Promise.all(renderers.map((r) => r.call<{ pages: { w: number; h: number }[] }>('open', [rid, fileArg(f), undefined]))))[0];
          let done = 0, read = 0;
          const todo: number[] = [];
          for (let i = 0; i < info.pages.length; i++) {
            if (stop.current) break;
            if (!(await muBatch<boolean>('hasText', mid, i))) todo.push(i);
          }
          setRes((r) => ({ ...r, [f]: `reading ${todo.length} page${todo.length === 1 ? '' : 's'}…` }));
          await ocrPages(rid, todo.map((i) => ({ i, w: info.pages[i].w, h: info.pages[i].h })), lang, async (i, w) => {
            read++;
            setRes((r) => ({ ...r, [f]: `page ${read} of ${todo.length}…` }));
            if (w.length) { await muBatch('addTextLayer', mid, i, w.map((x) => ({ text: x.text, box: x.box }))); done++; }
          }, () => stop.current);
          const cut = stop.current && read < todo.length;
          if (done) made = (await muBatchFile<FileRef>('save', mid, {})).$file.path;
          // (what happened: stopped, nothing found on the scans, or really nothing to do)
          else setRes((r) => ({ ...r, [f]: cut ? 'stopped – nothing written' : todo.length ? `no words found on its ${todo.length} scanned page${todo.length === 1 ? '' : 's'} – nothing written` : 'already searchable – nothing to do' }));
          // let go of the file before writing over it ("replace")
          await Promise.all(renderers.map((r) => r.call('close', [rid]).catch(() => {})));
          await muBatch('close', mid).catch(() => {});
          mid = '';
          if (made) {
            await gcc.commit(made, target, { noBackup: mode !== 'replace' });
            made = null;
            setRes((r) => ({ ...r, [f]: `done – ${done} page${done > 1 ? 's' : ''} read${cut ? ` (stopped: ${todo.length - read} not read)` : ''}` }));
          }
        } catch (e) { setRes((r) => ({ ...r, [f]: 'failed: ' + String((e as Error).message || e) })); }
        finally {
          off();
          await Promise.all(renderers.map((r) => r.call('close', [rid]).catch(() => {})));
          if (mid) await muBatch('close', mid).catch(() => {});
          if (made) void gcc.dropTemp([made]);
        }
      }
    } finally { setRunning(false); lock.current = false; }
  };
  return (
    <Modal title="Make files searchable (OCR)" wide onClose={() => { stop.current = true; if (!running) p.setDialog(null); }} sub="Scanned pages get invisible text; pages that already have text are left alone."
      actions={<><button className="btn" onClick={() => { stop.current = true; if (!running) p.setDialog(null); }}>{running ? 'Stop' : 'Close'}</button><button className="btn primary" disabled={running || !files.length || !!plan.problem} onClick={() => void go()}>{running ? 'Working…' : 'Start'}</button></>}>
      <div className="row"><label>Language</label><select className="input" disabled={running} value={lang} onChange={(e) => setLang(e.target.value as OcrLang)}><option value="eng+ara">English + Arabic</option><option value="eng">English</option><option value="ara">Arabic</option></select></div>
      <FileList files={files} setFiles={setFiles} locked={running} extra={(x) => <span className="faint res">{res[x] || ''}</span>} />
      <OutputChoice mode={mode} setMode={setMode} suffix={suffix} setSuffix={setSuffix} folder={folder} setFolder={setFolder} allowReplace locked={running} problem={files.length ? plan.problem : null} />
    </Modal>
  );
}

function BatchFlattenDlg(p: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [mode, setMode] = useState<OutMode>('suffix');
  const [suffix, setSuffix] = useState(' (flat)');
  const [folder, setFolder] = useState('');
  const [res, setRes] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const lock = useRef(false);
  useDropFiles((x) => { if (running) { p.toast('Not added – wait until it has finished.', 'info'); return; } setFiles((y) => [...y, ...x.filter((z) => !y.includes(z))]); }, undefined, (t) => p.toast(t, 'info', undefined, 7000));
  const plan = planFor(p, files, mode, suffix, folder);
  const go = async () => {
    if (lock.current) return;
    lock.current = true;
    try {
      const pl = await startPlan(p, files, mode, suffix, folder, setRes);
      if (!pl) return;
      setRunning(true);
      for (const f of files) {
        const target = pl.out.get(f);
        if (!target) continue;
        setRes((r) => ({ ...r, [f]: 'working…' }));
        try { const out = await muBatchFile<FileRef>('batchFlatten', fileArg(f)); await gcc.commit(out.$file.path, target, { noBackup: mode !== 'replace' }); setRes((r) => ({ ...r, [f]: 'done' })); }
        catch (e) { setRes((r) => ({ ...r, [f]: 'failed: ' + String((e as Error).message || e) })); }
      }
    } finally { setRunning(false); lock.current = false; }
  };
  return (
    <Modal title="Flatten files" wide onClose={() => !running && p.setDialog(null)} sub="All markups and form fields are burnt into the pages."
      actions={<><button className="btn" disabled={running} onClick={() => p.setDialog(null)}>Close</button><button className="btn primary" disabled={running || !files.length || !!plan.problem} onClick={() => void go()}>Flatten {files.length} files</button></>}>
      <FileList files={files} setFiles={setFiles} locked={running} extra={(x) => <span className="faint res">{res[x] || ''}</span>} />
      <OutputChoice mode={mode} setMode={setMode} suffix={suffix} setSuffix={setSuffix} folder={folder} setFolder={setFolder} allowReplace locked={running} problem={files.length ? plan.problem : null} />
    </Modal>
  );
}

// ---------------------------------------------------------------- redaction search

function RedactSearchDlg(p: Props) {
  const doc = p.doc!;
  const [terms, setTerms] = useState('');
  const [found, setFound] = useState<{ page: number; rects: number[][] }[] | null>(null);
  const [mc, setMc] = useState(false);
  const [ww, setWw] = useState(true);
  const [cut, setCut] = useState(false);
  const find = async () => {
    const list = terms.split('\n').map((t) => t.trim()).filter(Boolean);
    type Hit = { page: number; rects: number[][] };
    const all: Hit[] = [];
    const n = doc.pages.length, PART = 200, MAX = 5000;
    let capped = false;
    // every hit: one search gives back at most 5,000 (everything after the 5,000th was left
    // unmarked under "Found 5,000") - a part with that many is searched again in halves
    const search = async (t: string, from: number, to: number): Promise<Hit[]> => {
      const r = await renderers[0].call<Hit[]>('find', [doc.id, t, from, to, mc, ww]);
      if (r.length < MAX) return r;
      if (to - from <= 1) { capped = true; return r; }
      const mid = (from + to) >> 1;
      return [...(await search(t, from, mid)), ...(await search(t, mid, to))];
    };
    const ok = await p.busy('Searching…', async (set) => {
      await doc.drawReady();
      for (const [k, t] of list.entries()) {
        for (let from = 0; from < n; from += PART) {
          if (n > PART) set(`Searching${list.length > 1 ? ` for ${k + 1} of ${list.length}` : ''}… page ${from + 1} of ${n}`);
          all.push(...(await search(t, from, Math.min(n, from + PART))));
        }
      }
      return true;
    });
    // (a search that failed part-way is said as an error - not shown as the complete result)
    if (!ok) return;
    setFound(all);
    setCut(capped);
  };
  const mark = async () => {
    if (!found) return;
    const ok = await p.busy('Marking…', () => doc.createMany(found.flatMap((h) => h.rects.map((r) => { const hgt = r[3] - r[1]; return { page: h.page, spec: { type: 'Redact' as const, rect: [r[0], r[1] + hgt * 0.15, r[2], r[3] - hgt * 0.15] as [number, number, number, number], redactFill: toolStyle('redact-area', p.settings.styles?.['redact-area']).redact ?? [0, 0, 0] } }; })), 'Mark for redaction'));
    if (!ok) return;
    p.setDialog(null);
    p.toast(`${found.length} places marked. Check them, then press Apply to remove them for good.`, 'ok', undefined, 8000);
  };
  return (
    <Modal title="Find & mark for redaction" onClose={() => p.setDialog(null)} sub="One word or phrase per line (names, phone numbers, amounts…)."
      actions={<><button className="btn" onClick={() => p.setDialog(null)}>Cancel</button>{found ? <button className="btn primary" disabled={!found.length} onClick={() => void mark()}>Mark {found.length} places</button> : <button className="btn primary" disabled={!terms.trim()} onClick={() => void find()}>Find</button>}</>}>
      <textarea className="input ta" rows={5} value={terms} onChange={(e) => { setTerms(e.target.value); setFound(null); }} autoFocus />
      <div className="hrow"><label className="check sm"><input type="checkbox" checked={mc} onChange={(e) => { setMc(e.target.checked); setFound(null); }} /> Match case</label><label className="check sm"><input type="checkbox" checked={ww} onChange={(e) => { setWw(e.target.checked); setFound(null); }} /> Whole words</label></div>
      {found && <p className="hint">{found.length ? `Found ${found.length} on ${new Set(found.map((f) => f.page)).size} pages.` : 'Nothing found. Scanned pages need OCR first.'}</p>}
      {found && cut && <p className="hint err">A page has more than 5,000 of them: not all of that page's are listed. Mark these, apply, then search again.</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------- document properties

function PropsDlg(p: Props) {
  const doc = p.doc!;
  const [meta, setMeta] = useState<Record<string, string> | null>(null);
  // (properties that can't be read: said, instead of no dialog at all)
  useEffect(() => { mu<Record<string, string>>('getMeta', doc.id).then(setMeta).catch((e) => { p.fail(e); p.setDialog(null); }); }, []);
  if (!meta) return null;
  const pg = doc.pages[0] as typeof doc.pages[number] | undefined; // (a file with no pages)
  const size = (w: number, h: number) => `${Math.round((w / 72) * 25.4)} × ${Math.round((h / 72) * 25.4)} mm${paperName(w, h)}`;
  const save = async () => {
    try { await doc.setMeta({ Title: meta.Title, Author: meta.Author, Subject: meta.Subject, Keywords: meta.Keywords }); } catch (e) { p.fail(e); return; }
    p.setDialog(null);
  };
  return (
    <Modal title="Document properties" wide onClose={() => p.setDialog(null)} actions={<><button className="btn" onClick={() => p.setDialog(null)}>Cancel</button><button className="btn primary" onClick={() => void save()}>Save</button></>}>
      <div className="pgrid">
        <span>File</span><span className="fn">{doc.path || doc.name}</span>
        <span>Size</span><span>{sizeTxt(doc.size)}</span>
        <span>Pages</span><span>{doc.pages.length}{pg ? ` – first page ${size(pg.w, pg.h)}` : ''}</span>
        <span>Format</span><span>{meta.Version}{doc.password ? ', password protected' : ''}{doc.hasForms ? ', has form fields' : ''}</span>
        <span>Made by</span><span>{meta.Creator || '—'}{meta.Producer ? ' / ' + meta.Producer : ''}</span>
        <span>Created</span><span>{meta.CreationDate ? pdfDate(meta.CreationDate) : '—'}</span>
        <span>Modified</span><span>{meta.ModDate ? pdfDate(meta.ModDate) : '—'}</span>
        {(['Title', 'Author', 'Subject', 'Keywords'] as const).map((k) => [<span key={k + 'l'}>{k}</span>, <input key={k} className="input sm" value={meta[k]} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} />])}
      </div>
    </Modal>
  );
}
function paperName(w: number, h: number) {
  const mm = [Math.round((Math.min(w, h) / 72) * 25.4), Math.round((Math.max(w, h) / 72) * 25.4)];
  const list: [string, number, number][] = [['A0', 841, 1189], ['A1', 594, 841], ['A2', 420, 594], ['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210], ['Letter', 216, 279], ['Legal', 216, 356]];
  const f = list.find(([, a, b]) => Math.abs(a - mm[0]) <= 3 && Math.abs(b - mm[1]) <= 3);
  return f ? ` (${f[0]} ${w > h ? 'landscape' : 'portrait'})` : '';
}

// ---------------------------------------------------------------- settings

/** Settings > Help > What's new: this version's notes, earlier versions folded away */
function WhatsNewDlg(p: Props & { back: boolean }) {
  const cur = p.info?.version || '';
  // (opened from Settings: closing goes back there)
  const close = () => p.setDialog(p.back ? { k: 'settings' } : null);
  const vs = noteVersions();
  const mine = notesOf(cur);
  const older = vs.filter((v) => v !== cur && v.localeCompare(cur, undefined, { numeric: true }) < 0);
  return (
    <Modal title="What's new" sub={`Version ${cur}`} onClose={close} actions={<button className="btn primary" onClick={close}>Close</button>}>
      {mine ? <WhatsNew groups={mine} /> : <p className="hint">No notes for this version.</p>}
      {older.length > 0 && (
        <details className="wn-older">
          <summary>Earlier versions</summary>
          {older.map((v) => <div key={v}><div className="wn-ver">{v}</div><WhatsNew groups={notesOf(v)!} compact /></div>)}
        </details>
      )}
    </Modal>
  );
}

/** Settings changed but not saved yet, kept while Licences or What's new is open (they take the
 *  dialog's place and come back to it - the typed name used to be lost); Save keeps them,
 *  Cancel drops them */
let settingsDraft: { author: string; wheelZoom: boolean } | null = null;

function SettingsDlg(p: Props) {
  const [draft] = useState(() => { const d = settingsDraft; settingsDraft = null; return d; });
  const [author, setAuthor] = useState(draft?.author ?? (p.settings.author || p.info?.user || ''));
  // (the wheel too waits for Save: Cancel used to keep it)
  const [wheelZoom, setWheelZoom] = useState(draft?.wheelZoom ?? !!p.settings.wheelZoom);
  const away = (d: Dialog) => { settingsDraft = { author, wheelZoom }; p.setDialog(d); };
  return (
    <Modal title="Settings" onClose={() => p.setDialog(null)} actions={<><button className="btn" onClick={() => p.setDialog(null)}>Cancel</button><button className="btn primary" onClick={() => { p.saveSettings({ author, wheelZoom }); p.setDialog(null); }}>Save</button></>}>
      <div className="row"><label>Your name (on comments and stamps)</label><input className="input" value={author} onChange={(e) => setAuthor(e.target.value)} /></div>
      <div className="row"><label>Mouse wheel</label>
        <div className="seg"><button className={!wheelZoom ? 'on' : ''} onClick={() => setWheelZoom(false)}>Scrolls (Ctrl+wheel zooms)</button><button className={wheelZoom ? 'on' : ''} onClick={() => setWheelZoom(true)}>Zooms (Alt+wheel scrolls)</button></div>
      </div>
      <div className="row"><label>Open PDFs with {APP_NAME}</label>
        {p.info?.platform === 'linux' ? <>
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={async () => { const r = await gcc.registerOpenWith(); p.toast(r.ok ? `Done: PDFs now open in ${APP_NAME} (double-click).` : 'Could not set it: ' + (r.msg || 'refused'), r.ok ? 'ok' : 'err', undefined, 12000); }}>Make it the default for PDFs</button>
          <p className="hint">PDFs then open in {APP_NAME} when double-clicked. To change it back: right-click a PDF → Open With → Other Application (or the system's Preferred Applications).</p>
        </> : <>
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={async () => { const r = await gcc.registerOpenWith(); p.toast(r.ok ? `Registered. Now right-click any PDF > Open with > Choose another app > ${APP_NAME} > tick “Always”.` : 'Could not register: ' + (r.msg || 'Windows refused'), r.ok ? 'ok' : 'err', undefined, 12000); }}>Add to Windows “Open with”</button>
          <p className="hint">Windows lets only you pick the default app. After this, right-click a PDF → Open with → Choose another app → {APP_NAME} → tick “Always use this app”.</p>
        </>}
      </div>
      <div className="row"><label>Safety</label><p className="hint">Every save writes a new file first and swaps it in, and keeps the previous version in the backups folder (last 40). Unsaved work is copied every 45 s and offered back after a crash.</p>
        <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => void gcc.openExternal(joinPath(p.info?.localDir || p.info?.dataDir || '', 'backups'))}>Open backups folder</button>
      </div>
      <UpdatesSection toast={p.toast} />
      <ReportsRow onReport={() => void p.A.report()} onWhatsNew={() => away({ k: 'whatsnew', back: true })} />
      <div className="row"><label>About</label>
        <p className="hint">{APP_NAME} {p.info?.version}. Built on open-source parts: Electron, PDFium, MuPDF, Tesseract, Mozilla's translation engine and others.</p>
        <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => away({ k: 'licences' })}>Licences</button>
      </div>
    </Modal>
  );
}

/** what a problem report keeps of the text (reports.cjs) */
const REPORT_MAX = 20000;
/** Help > Report a problem: the person's words (+ the window as it was) to the reports folder */
function ReportDlg(p: Props & { shot: string | null }) {
  const [text, setText] = useState('');
  const [withShot, setWithShot] = useState(!!p.shot);
  const [sending, setSending] = useState(false);
  // (the public build sends reports anonymously: what the dialog says follows)
  const [anon, setAnon] = useState(false);
  useEffect(() => { void gcc.reportStatus().then((s) => setAnon(!!s.anon)).catch(() => {}); }, []);
  const send = async () => {
    setSending(true);
    try {
      const extra = { openFiles: p.docs.length };
      const st = await gcc.reportProblem(text.trim(), withShot, extra);
      p.setDialog(null);
      if (st.state === 'sent' && st.anon) p.toast('Sent anonymously - thank you.', 'ok', undefined, 6000);
      else if (st.anon) p.toast('Saved on this PC - it is sent anonymously once the internet can be reached.', 'info', undefined, 9000);
      else if (st.state === 'sent') p.toast('Thanks - your report is in the reports folder.', 'ok', undefined, 6000);
      else if (st.state === 'nofolder') p.toast('Saved on this PC. Set an updates folder (Settings) to send reports.', 'info', { label: 'Show', run: () => void gcc.reportOpenQueue() }, 9000);
      else if (st.state === 'web' && st.issue) { void gcc.openLink(st.issue); p.toast('Saved on this PC. Your browser opens a new issue on GitHub with your text - press Submit there (needs a free GitHub account). Attach the screenshot from the saved report if it helps.', 'info', { label: 'Show', run: () => void gcc.reportOpenQueue() }, 12000); }
      else if (st.state === 'web') p.toast('Saved on this PC.', 'info', { label: 'Show', run: () => void gcc.reportOpenQueue() }, 9000);
      else p.toast('Saved on this PC. It goes to the reports folder next time the server can be reached.', 'info', undefined, 9000);
    } catch (e) { p.fail(e); setSending(false); }
  };
  return (
    <Modal title="Report a problem" sub="What went wrong, and what did you expect? The more exact, the faster it gets fixed."
      onClose={() => p.setDialog(null)}
      actions={<><button className="btn" onClick={() => p.setDialog(null)}>Cancel</button><button className="btn primary" disabled={sending || (!text.trim() && !withShot)} onClick={() => void send()}>{sending ? 'Sending…' : 'Send report'}</button></>}>
      {/* (the reports keep 20,000 characters: said here, not cut off silently) */}
      <textarea className="input report-text" autoFocus maxLength={REPORT_MAX} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. I dragged a highlight's end on page 3 and it jumped to the line below." />
      {text.length > REPORT_MAX * 0.9 && <p className="hint">{text.length.toLocaleString('en-GB')} of {REPORT_MAX.toLocaleString('en-GB')} characters</p>}
      {p.shot && (
        <label className="report-shot">
          <input type="checkbox" checked={withShot} onChange={(e) => setWithShot(e.target.checked)} />
          <span>Attach this picture of the window</span>
          <img src={p.shot} alt="" className={withShot ? '' : 'off'} />
        </label>
      )}
      {anon
        ? <p className="hint">Sent anonymously to the developer's own receiver: your words{p.shot ? ', the picture if you keep it (it shows what is on screen)' : ''}, the app and Windows versions and the app's recent log - with your user name, PC name, file names and folders taken out. Never the PDF file itself. Settings › Help says more.</p>
        : <p className="hint">The report also includes the app version, Windows version, your Windows user name and the app's recent log (it can contain file names) - never the PDF itself.</p>}
    </Modal>
  );
}

/** the licence of the app and of the open-source parts it's built on (THIRD-PARTY-NOTICES.txt) */
function LicencesDlg({ onClose }: { onClose(): void }) {
  const [text, setText] = useState('Loading…');
  useEffect(() => { fetch('./THIRD-PARTY-NOTICES.txt').then((r) => (r.ok ? r.text() : Promise.reject(r.status))).then(setText).catch(() => setText('The licence file is missing from this copy.')); }, []);
  return (
    <Modal title="Licences" wide="xl" onClose={onClose} actions={<button className="btn primary" onClick={onClose}>Close</button>}>
      <pre className="licences">{text}</pre>
    </Modal>
  );
}

// ---------------------------------------------------------------- crop

function CropDlg(p: Props & { page: number; rect: [number, number, number, number] }) {
  const doc = p.doc!;
  const go = async (which: 'this' | 'all' | 'sel') => {
    const pages = which === 'all' ? [...doc.pages.keys()] : which === 'sel' ? p.pageSel : [p.page];
    const ok = await p.busy('Cropping…', async () => { await doc.crop(pages, p.rect); return true; });
    if (ok) p.setDialog(null);
  };
  const w = ((p.rect[2] - p.rect[0]) / 72) * 25.4, h = ((p.rect[3] - p.rect[1]) / 72) * 25.4;
  return (
    <Modal title="Crop" sub={`Keep ${Math.round(w)} × ${Math.round(h)} mm. Nothing is deleted – the rest is just hidden (Ctrl+Z to undo).`} onClose={() => p.setDialog(null)}
      actions={<><button className="btn" onClick={() => p.setDialog(null)}>Cancel</button>{p.pageSel.length > 1 && <button className="btn" onClick={() => void go('sel')}>Selected pages</button>}<button className="btn" onClick={() => void go('all')}>All pages</button><button className="btn primary" onClick={() => void go('this')}>This page</button></>} />
  );
}

// ---------------------------------------------------------------- table result

function TableDlg(p: Props & { rows: string[][]; page: number; rect: Rect; docId: string }) {
  const [saving, setSaving] = useState('');
  const once = useRef(false);
  // (the file the box was drawn on - not whichever is in front)
  const doc = p.docs.find((d) => d.id === p.docId) || null;
  const save = async () => {
    if (!doc || once.current) return;
    once.current = true;
    try { await save1(doc); } finally { once.current = false; }
  };
  const save1 = async (doc: PdfDoc) => {
    const base = doc.name.replace(/\.pdf$/i, '');
    const name = `${base} - page ${p.page + 1} table.xlsx`;
    let t = await gcc.saveDialog({ title: 'Save the table as Excel', name, path: doc.path ? joinPath(dirName(doc.path), name) : undefined, filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
    if (!t) return;
    if (!/\.xlsx$/i.test(t)) t = /\.(pdf|docx?|xlsx?|csv)$/i.test(t) ? t.replace(/\.[^.\\/]+$/, '.xlsx') : t + '.xlsx';
    if (doc.path && t.toLowerCase() === doc.path.toLowerCase()) { p.toast('That is the PDF itself – choose another name.', 'err'); return; }
    setSaving('Reading the area…');
    try {
      const r = await exportArea(doc, p.page, p.rect, t, p.settings.ocrLang || 'eng+ara', setSaving);
      p.setDialog(null);
      p.toast(`Saved ${baseName(t)}${r.scan ? ' – read with OCR: check the figures' : ''}`, 'ok', { label: 'Open', run: () => void gcc.openExternal(t!) }, 10000);
    } catch (e) {
      // (the engine could not: the table as shown here, as plain cells)
      try {
        await gcc.write(t, writeXlsx([{ name: 'Table', rows: p.rows.map((r) => r.map(excelCell)) }]), { noBackup: true });
        p.setDialog(null);
        p.toast(`Saved ${baseName(t)} as shown (the full reading failed: ${String((e as Error)?.message || e)})`, 'info', { label: 'Open', run: () => void gcc.openExternal(t!) }, 10000);
      } catch (e2) { setSaving(''); p.fail(e2); }
    }
  };
  return (
    <Modal title={`Table from page ${p.page + 1}`} wide="xl" sub={`Copied: ${p.rows.length} rows × ${p.rows[0]?.length || 0} columns – paste into Excel. Save as Excel reads just this area like Export to Excel does: ruled columns, numbers as numbers, merged headings. Drag another box for the next table.`} onClose={() => !saving && p.setDialog(null)}
      actions={<>{saving && <span className="hint grow">{saving}</span>}<button className="btn" disabled={!!saving} onClick={() => p.setDialog(null)}>Close</button><button className="btn primary" disabled={!!saving || !doc} onClick={() => void save()}><Ico n="excel" size={15} /> {saving ? 'Saving…' : 'Save as Excel…'}</button></>}>
      <div className="tprev"><table><tbody>{p.rows.slice(0, 200).map((r, i) => <tr key={i}>{r.map((c, k) => <td key={k}>{c}</td>)}</tr>)}</tbody></table></div>
    </Modal>
  );
}

export { fmtLen, PT_M };
