// PDF Editor: frame, ribbon, document tabs, panels, and every action.
import { exportRunning, type ExportFormat } from './ExportDlg';
import { loadFonts } from './fontlist';
import { UpdateCard, useUpdates } from './Updates';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gcc, baseName, dirName, joinPath, type AppInfo, type Recovery, type TabMove, type UpdatedInfo } from './api';
import { startEngines, rendererFor, renderers, mu, editor as editWorker } from './engines';
import { PdfDoc, onCrash, wasPlannedRestart, plannedRestartLostWork, type Scale } from './doc';
import { previewCache, tiles } from './tiles';
import type { PrintSettings } from './PrintDlg';
import { Viewer, markClip, type ViewerApi, type ViewerEvent, type SelItem, type Hit, type PlaceItem } from './Viewer';
import { Ribbon, TAB_NAMES, type RibbonTab, type RibbonCmd } from './Ribbon';
import { ToolSearch, type ExtraCmd, type FoundCmd } from './ToolSearch';
import { AiPanel, forgetAiFor, type AiSettings } from './AiPanel';
import { SidePanel, type SideKind } from './Side';
import { PropsPanel, panelEditsDone } from './PropsPanel';
import { Ico } from './icons';
import { type Toast } from './Modal';
import { TOOLS, toolStyle, MEASURE_TOOLS, HOW_HINT, type ToolId, type Style, type MeasureHow } from './tools';
import { BUILTIN_STAMPS, fillFields, designSize, dataUrlToBytes, type StampDef } from './stamps';
import type { ScanSource } from './StampScan';
import { STANDARD_SCALES, PT_M, dist, fmtLen, scaleText, type MeasureFmt } from './geom';
import { measureNumber, perimeterNumber, numStyle } from './measurexl';
import { charsToWords, wordsToTable, toTsv, toHtml } from './table';
import { ocrPage, type OcrLang } from './ocr';
import { writeXlsx } from './xlsxwrite';
import * as D from './Dialogs';
import { dragged, dropPages, pagesLabel } from './pagedrag';
import { followPages, cleanSettings } from './pagesel';
import type { Pt, Rect, AnnotData, AnnotSpec } from '../engine/mu';
import { APP_NAME, WORD_LEAD, WORD_REST } from './brand';

export type ThemeMode = 'system' | 'light' | 'dark';
const resolveTheme = (m: ThemeMode) => (m !== 'system' ? m : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

export interface ChestItem { id: string; name: string; tool: ToolId; style: Partial<Style>; place?: { stampId?: string } }

export interface Settings {
  /** measuring: unit and decimals for new measurements */
  measureFmt?: MeasureFmt;
  /** how an Area / Perimeter is drawn: corners, a rectangle, a circle */
  measureHow?: MeasureHow;
  reopenAfterRestart?: string[] | null;
  author?: string;
  theme?: ThemeMode;
  styles?: Partial<Record<ToolId, Partial<Style>>>;
  stamps?: StampDef[];
  signatures?: { id: string; image: string; w: number; h: number }[];
  chest?: ChestItem[];
  recent?: string[];
  snap?: boolean;
  /** lines drawn straight (0 / 45 / 90°) without holding Shift - F8 */
  ortho?: boolean;
  /** Crosshair (F6) and Magnifier (F7) while drawing; the magnifier's zoom (x the view's) */
  cross?: boolean;
  loupe?: boolean;
  loupeZoom?: number;
  wheelZoom?: boolean;
  keepTool?: boolean;
  /** last print settings */
  print?: PrintSettings;
  /** the markup / tool settings panel on the right (false: closed) */
  propsPanel?: boolean;
  ocrLang?: OcrLang;
  /** export to Word / Excel: last choices */
  export?: { sheets?: 'joined' | 'pages'; ocr?: boolean; dropStamps?: boolean; open?: boolean };
  backups?: boolean;
  ai?: AiSettings;
}

export type Dialog =
  | { k: 'password'; path: string; err?: string; doc: PdfDoc }
  | { k: 'calibrate'; page: number; a: Pt; b: Pt }
  | { k: 'scale'; page: number }
  | { k: 'viewport'; page: number; rect: Rect }
  | { k: 'stamps'; scan?: ScanSource }
  | { k: 'copypages'; items: SelItem[] }
  | { k: 'signature' }
  | { k: 'merge'; files?: string[] }
  | { k: 'split' }
  | { k: 'extract' }
  | { k: 'toPictures' }
  | { k: 'link'; page: number; rect: Rect; edit?: { k: number; uri: string | null; page: number } }
  | { k: 'fromPictures'; files: string[] }
  | { k: 'insert'; at: number; mode?: 'insert' | 'replace' }
  | { k: 'compress'; files?: string[] }
  | { k: 'marks'; batch: boolean }
  | { k: 'protect' }
  | { k: 'ocr'; pages?: number[] }
  | { k: 'batch-ocr' }
  | { k: 'batch-flatten' }
  | { k: 'redact-search' }
  | { k: 'props' }
  | { k: 'print'; page: number }
  | { k: 'counttag'; page: number }
  | { k: 'settings' }
  | { k: 'whatsnew'; back?: boolean }
  | { k: 'licences' }
  | { k: 'report'; shot: string | null }
  | { k: 'ai-keys' }
  | { k: 'crop'; page: number; rect: Rect }
  | { k: 'table'; rows: string[][]; page: number; rect: Rect; docId: string }
  | { k: 'export'; format: ExportFormat }
  | { k: 'about' };

let toastSeq = 1;

/** dialogs that work on the file in front when they were opened */
const FOR_THE_FILE = new Set<Dialog['k']>(['calibrate', 'scale', 'viewport', 'copypages', 'split', 'extract', 'toPictures', 'link', 'table', 'insert', 'protect', 'ocr', 'redact-search', 'props', 'print', 'crop', 'export']);
const forTheFile = (x: Dialog | null) => !!x && (FOR_THE_FILE.has(x.k) || (x.k === 'marks' && !x.batch));

/** tabs closed whose engine clean-up is still running */
const closing = new Set<Promise<unknown>>();

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettingsState] = useState<Settings>({});
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState('');
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [docs, setDocs] = useState<PdfDoc[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ver, setVer] = useState(0);
  const [rtab, setRtab] = useState<RibbonTab>('home');
  const [tool, setToolState] = useState<ToolId>('select');
  const [sel, setSel] = useState<SelItem[]>([]);
  // the selected markups' data: the ribbon's Style group edits them (as the side panel does)
  const [selItems, setSelItems] = useState<AnnotData[]>([]);
  const [pageSel, setPageSel] = useState<number[]>([]);
  const [side, setSide] = useState<SideKind | null>('pages');
  /** every ribbon button (filled by the Ribbon; read by Find a tool) */
  const ribbonCmds = useRef<(() => RibbonCmd[]) | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiTab, setAiTab] = useState<'ask' | 'translate'>('ask');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const dialogRef = useRef<Dialog | null>(null);
  dialogRef.current = dialog;
  /** Explorer > Combine with PDF Editor: the Merge dialog with those files. More arriving later
   *  join an open Merge dialog; another dialog open (a password, a running job) is not replaced -
   *  they wait until it closes. One file on its own just opens. */
  const combineWaiting = useRef<string[]>([]);
  /** to the open Merge dialog - one just opened may not listen yet: asked again for up to 3 s */
  const toMerge = (files: string[], tries: number) => {
    if (!files.length) return;
    if (!window.dispatchEvent(new CustomEvent('gcc-merge-add', { detail: files, cancelable: true }))) return;
    if (dialogRef.current?.k !== 'merge') combineFiles(files);
    else if (tries < 20) window.setTimeout(() => toMerge(files, tries + 1), 150);
    else combineWaiting.current.push(...files);
  };
  const combineFiles = (files: string[]) => {
    const d = dialogRef.current;
    if (d?.k === 'merge') { toMerge(files, 0); return; }
    if (d) {
      if (files.length) toast(`Combine: ${files.length} file${files.length === 1 ? '' : 's'} from Explorer – the Merge dialog opens when this dialog is closed.`, 'info', undefined, 8000);
      combineWaiting.current.push(...files);
      return;
    }
    const all = [...new Set([...combineWaiting.current.splice(0), ...files])];
    // (marked open at once: a second batch before the next render joins it, not replaces it)
    if (all.length > 1) { const nd: Dialog = { k: 'merge', files: all }; dialogRef.current = nd; setDialog(nd); } else void openPaths(all);
  };
  useEffect(() => {
    if (dialog) return;
    // the next password-protected file waiting for its prompt
    const w = waitingPw.current.shift();
    if (w) { const d: Dialog = { k: 'password', path: w.path, doc: w.doc }; dialogRef.current = d; setDialog(d); return; }
    if (combineWaiting.current.length) combineFiles([]);
  }, [dialog]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const upd = useUpdates();
  const [updated, setUpdated] = useState<UpdatedInfo | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pageNo, setPageNo] = useState(0);
  const [status, setStatus] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  const [place, setPlace] = useState<PlaceItem | null>(null);
  const [countGroup, setCountGroup] = useState('Count 1');
  const [menu, setMenu] = useState<{ x: number; y: number; page: number; at: Pt; text: string | null } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [recovery, setRecovery] = useState<Recovery[]>([]);
  const [commentFocus, setCommentFocus] = useState(0);
  const [dragTab, setDragTab] = useState<string | null>(null);
  /** a tab being dragged: reordered along the strip, or out of it (to another window / a new one) */
  const [tabDrag, setTabDrag] = useState<{ id: string; x: number; y: number; out: boolean } | null>(null);
  /** a tab from another window is held over this one */
  const [dropHere, setDropHere] = useState(false);
  const [tabList, setTabList] = useState(false);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tabHover = useRef(0);
  const viewer = useRef<ViewerApi | null>(null);
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const doc = docs.find((d) => d.id === activeId) || null;
  const S = useRef(settings);
  S.current = settings;
  const styleSave = useRef(0);
  // (a style change still waiting to be written goes now if the window closes)
  useEffect(() => {
    const f = () => { if (styleSave.current) { window.clearTimeout(styleSave.current); styleSave.current = 0; void gcc.setSettings({ styles: S.current.styles }); } };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, []);
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const pageNoRef = useRef(0);
  pageNoRef.current = pageNo;
  // handle for the automated tests (and for support: F12 console)
  // an engine had to be restarted (out of memory on a monster file): the window carried on
  useEffect(() => onCrash((kind) => {
    if (kind === 'edit' && wasPlannedRestart()) {
      // ("all there" only when every file's unsaved work was copied first)
      if (plannedRestartLostWork()) toast('The editing engine was refreshed, but the latest changes of a file could not be kept for it (no room for the automatic copy?) – check your last changes; undo starts again from here.', 'err', undefined, 12000);
      else if (docsRef.current.length) toast('The editing engine was refreshed. Your work is all there; undo starts again from here.', 'info', undefined, 8000);
    }
    else if (kind === 'edit' && docsRef.current.length) toast('The editing engine ran out of memory and was restarted. Your files were reopened from the last automatic copy – changes from the last minute or so may need redoing; undo starts again.', 'info', undefined, 12000);
    setVer((v) => v + 1);
  }), []);
  // (tests: a tab dropped at a screen point, as a drag out of the strip ends)
  const moveRef = useRef<(id: string, x: number, y: number) => Promise<void>>(async () => {});
  moveRef.current = async (id, x, y) => { const d = docsRef.current.find((k) => k.id === id); if (d) await moveTab(d, await gcc.tabTarget(x, y), x, y); };
  useEffect(() => { (window as unknown as { __gcc: unknown }).__gcc = { moveTo: (id: string, x: number, y: number) => moveRef.current(id, x, y), docs: () => docsRef.current, active: () => docsRef.current.find((d) => d.id === activeRef.current) || null, viewer: () => viewer.current, tiles, engines: { mu, renderers, editor: editWorker }, ocr: (lang: OcrLang) => { const d = docsRef.current.find((x) => x.id === activeRef.current)!; return ocrPage(d.id, 0, d.pages[0].w, d.pages[0].h, { lang }); } }; }, []);

  // ---------------------------------------------------------------- start-up

  useEffect(() => {
    (async () => {
      try {
        const i = await gcc.info();
        // (a damaged entry in the settings file must not blank the window - nothing on screen could put it right)
        const raw = (await gcc.settings()) as Settings & { $stale?: boolean };
        const s = cleanSettings(raw);
        delete (s as { $stale?: boolean }).$stale;
        // the settings file was in use (an antivirus scan): a stand-in copy came - read again in a
        // moment, before anything is built on its lists (a stamp saved would replace them all)
        if (raw.$stale) {
          void (async () => {
            for (let k = 0; k < 15; k++) {
              await new Promise((r) => window.setTimeout(r, 2000));
              const t = (await gcc.settings().catch(() => null)) as (Settings & { $stale?: boolean }) | null;
              if (t && !t.$stale) { const c = cleanSettings(t); delete (c as { $stale?: boolean }).$stale; setSettingsState(c); return; }
            }
          })();
        }
        setInfo(i);
        setSettingsState(s);
        setThemeMode(s.theme || 'system');
        await startEngines();
        setReady(true);
        void loadFonts();
        setRecovery(await gcc.recoveryList());
        void gcc.updateAfterStart().then((x) => { if (x) setUpdated(x); }).catch(() => {});
        // after a restart for an update: the files that were open come back
        const again = Array.isArray(s.reopenAfterRestart) ? s.reopenAfterRestart.filter((x) => typeof x === 'string') : [];
        if (again.length) void gcc.setSettings({ reopenAfterRestart: null });
        const toOpen = [...again.filter((x) => !i.open.includes(x)), ...i.open];
        if (toOpen.length) void openPaths(toOpen);
      } catch (e) {
        setFatal(String((e as Error).message || e));
      }
    })();
    gcc.onOpen((files) => void openPaths(files));
    // another window changed the settings: taken in here, so this window's next write of a whole
    // list (recent files, stamps, signatures, Tool chest) keeps what the other one added or removed
    gcc.onSettings?.((patch) => setSettingsState((s) => ({ ...s, ...cleanSettings(patch as Partial<Settings>) })));
    gcc.onAdopt((p) => void adopt(p));
    gcc.onTabHover((on) => setDropHere(on));
    // Explorer > Combine with PDF Editor: the Merge dialog with those files (one file: just open it)
    gcc.onCombine((files) => combineFiles(files));
    gcc.ready();
    // the window's close button: with several files open, close just this one or all of them
    gcc.onClosing((o) => void (async () => {
      const ds = docsRef.current;
      const ex = exportRunning.docId ? ds.find((x) => x.id === exportRunning.docId) : null;
      if (ex && !(await stopExport(ex.name))) { gcc.closeCancelled(); return; }
      // (a restart for an update closes everything - "just this file" makes no sense there)
      if (ds.length > 1 && !o.restart) {
        const cur = ds.find((d) => d.id === activeRef.current) || ds[0];
        const r = await gcc.confirm({ message: `${ds.length} files are open`, detail: 'Close all of them, or just this file?', buttons: ['Close all', `Close only ${cur.name}`, 'Cancel'] });
        if (r === 2) { gcc.closeCancelled(); return; }
        if (r === 1) { await closeDoc(cur); gcc.closeCancelled(); return; }
      }
      if (!(await closeAll())) { gcc.closeCancelled(); return; }
      // a restart for an update reopens the files afterwards - listed once they are saved: a file
      // that got its name at the "Save changes?" question (a merged one, restored work) comes back too
      const paths = o.restart ? ds.map((d) => d.path).filter((x): x is string => !!x) : [];
      if (paths.length) await gcc.setSettings({ reopenAfterRestart: paths }).catch((e: unknown) => gcc.log('reopen list: ' + e));
      gcc.closed();
    })());
  }, []);

  useEffect(() => {
    const apply = () => { const r = resolveTheme(themeMode); document.documentElement.dataset.theme = r; void gcc.setTheme(r); };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [themeMode]);

  useEffect(() => { void gcc.setTitle(doc ? `${doc.name}${doc.dirty ? ' •' : ''} – ${APP_NAME}` : APP_NAME); }, [doc, ver]);

  /** settings changed: shown at once, written to disk; a write that fails says so (a stamp or a
   *  drawn signature looked saved - and was gone after a restart). Resolves false when not saved. */
  const saveSettings = useCallback((patch: Partial<Settings>): Promise<boolean> => {
    setSettingsState((s) => ({ ...s, ...patch }));
    return gcc.setSettings(patch as Record<string, unknown>).then(() => true, (e: unknown) => {
      gcc.log('settings: ' + e);
      toast("Your settings couldn't be saved on this PC (" + String((e as Error)?.message || e) + '). They stay until ' + APP_NAME + ' is closed.', 'err', undefined, 10000);
      return false;
    });
  }, []);

  // ---------------------------------------------------------------- toasts

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info', action?: Toast['action'], ms = 4500) => {
    const id = toastSeq++;
    // (the same message again while it shows: one, not a stack of copies)
    setToasts((t) => [...t.filter((x) => x.kind === 'busy' || x.text !== text).slice(-4), { id, text, kind, action }]);
    if (kind !== 'busy') window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
    return id;
  }, []);
  const updToast = (id: number, patch: Partial<Toast>) => setToasts((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  // an engine the app gave up on (it kept stopping): said, and left up for a while
  useEffect(() => {
    const f = (e: Event) => toast(String((e as CustomEvent).detail || 'An engine keeps stopping.'), 'err', undefined, 60000);
    window.addEventListener('gcc-engine-gaveup', f);
    return () => window.removeEventListener('gcc-engine-gaveup', f);
  }, [toast]);

  // ---------------------------------------------------------------- the selection's style (ribbon)

  useEffect(() => {
    let live = true;
    if (!doc || !sel.length) { setSelItems([]); return; }
    // (only the pages of the selection)
    void Promise.all([...new Set(sel.map((x) => x.page))].map((pg) => doc.annots(pg))).then((lists) => {
      if (live) setSelItems(lists.flat().filter((a) => sel.some((x) => x.page === a.page && x.id === a.id)));
    }).catch(() => { if (live) setSelItems([]); });
    return () => { live = false; };
  }, [doc, sel, ver]);
  /** a style change for the selected markups (a function: each its own, e.g. text keeps its font) */
  const editSel = (patch: Partial<AnnotSpec> | ((a: AnnotData) => Partial<AnnotSpec>)) => {
    if (!doc) return;
    // (the selection as it is now - the data can be a moment behind it; redactions and form
    // fields aren't styled from here)
    const now = selItems.filter((a) => sel.some((x) => x.page === a.page && x.id === a.id) && a.type !== 'Redact' && a.type !== 'Widget');
    const list = now.filter((a) => !a.locked);
    if (!list.length) { if (now.length) toast('Locked – unlock it first.', 'info'); return; }
    doc.update(list.map((a) => ({ page: a.page, id: a.id, patch: typeof patch === 'function' ? patch(a) : patch })), 'Change style').catch((e) => toast(String((e as Error).message || e), 'err'));
  };
  const endToast = (id: number, text?: string, kind: Toast['kind'] = 'ok') => {
    if (!text) { setToasts((t) => t.filter((x) => x.id !== id)); return; }
    updToast(id, { text, kind });
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };
  const fail = (e: unknown) => { gcc.log(String((e as Error)?.stack || e)); toast(String((e as Error)?.message || e), 'err', undefined, 8000); };

  /** run something long with a busy note */
  // once: the same job asked for again while it runs (a double-click on a dialog's Apply / Insert /
  // Merge, Ctrl+S pressed twice on one file) is not done twice. (Not for page turns and the like:
  // pressing Rotate twice means twice.) A text names the job (default: the label - two open
  // files with the same name had one label, and the second one's save was skipped without a word).
  const running = useRef(new Set<string>());
  const busy = async <T,>(label: string, fn: (set: (t: string) => void) => Promise<T>, once: boolean | string = false): Promise<T | undefined> => {
    const key = typeof once === 'string' ? once : label;
    if (once && running.current.has(key)) return undefined;
    if (once) running.current.add(key);
    const id = toast(label, 'busy');
    try {
      const r = await fn((t) => updToast(id, { text: t }));
      endToast(id);
      return r;
    } catch (e) {
      endToast(id);
      fail(e);
      return undefined;
    } finally { if (once) running.current.delete(key); }
  };

  // ---------------------------------------------------------------- documents

  // the selection never points at markups that are gone (undo, redo, a paste undone...): acting
  // on them failed with "That markup no longer exists"
  useEffect(() => {
    const d = docsRef.current.find((x) => x.id === activeRef.current);
    if (!d || !sel.length) return;
    let live = true;
    void Promise.all([...new Set(sel.map((s) => s.page))].map((pg) => d.annots(pg).then((l) => [pg, l] as const))).then((lists) => {
      if (!live) return;
      const ok = sel.filter((s) => lists.some(([pg, l]) => pg === s.page && l.some((a) => a.id === s.id)));
      if (ok.length !== sel.length) setSel(ok);
    }).catch(() => { /* the next change looks again */ });
    return () => { live = false; };
  }, [ver]);
  const watch = (d: PdfDoc) => d.on(() => setVer((v) => v + 1));

  const addRecent = (p: string) => {
    const r = [p, ...(S.current.recent || []).filter((x) => x.toLowerCase() !== p.toLowerCase())].slice(0, 15);
    saveSettings({ recent: r });
  };

  /** files being opened now, and password-protected ones waiting for their prompt (lower-case
   *  paths): asked to open again meanwhile (a second double-click in Explorer, the same file twice
   *  in one list), a file got two tabs that saved over each other */
  const opening = useRef(new Set<string>());
  const waitingPw = useRef<{ path: string; doc: PdfDoc }[]>([]);
  /** a password prompt - one at a time: several protected files opened together each get theirs
   *  in turn (only the last one was asked; the others were silently not opened) */
  const askPassword = (path: string, doc: PdfDoc) => {
    if (dialogRef.current) { waitingPw.current.push({ path, doc }); return; }
    const d: Dialog = { k: 'password', path, doc };
    dialogRef.current = d;
    setDialog(d);
  };
  const pwPending = (p: string) => {
    const k = p.toLowerCase();
    const cur = dialogRef.current;
    return (cur?.k === 'password' && cur.path.toLowerCase() === k) || waitingPw.current.some((w) => w.path.toLowerCase() === k);
  };

  async function openPaths(paths0: string[]): Promise<PdfDoc | null> {
    // pictures (opened, dropped, sent from Explorer): offered as a new PDF made of them
    const pics = paths0.filter((x) => D.PICTURE_RE.test(x));
    const paths = paths0.filter((x) => !D.PICTURE_RE.test(x));
    if (pics.length) {
      // (another window open here: said, not dropped silently)
      const busyWith = dialogRef.current && dialogRef.current.k !== 'fromPictures';
      if (busyWith) toast(`${pics.length} picture${pics.length === 1 ? '' : 's'} not taken – close the open window first, then drop ${pics.length === 1 ? 'it' : 'them'} again (or File > New from pictures).`, 'info', undefined, 8000);
      else setDialog((d) => (d?.k === 'fromPictures' ? { k: 'fromPictures', files: [...d.files, ...pics.filter((x) => !d.files.includes(x))] } : d ? d : { k: 'fromPictures', files: pics }));
    }
    if (!paths.length) return null;
    await startEngines();
    let last: PdfDoc | null = null;
    for (const p of paths) {
      const open = docsRef.current.find((d) => d.path && d.path.toLowerCase() === p.toLowerCase());
      if (open) { last = open; continue; }
      const key = p.toLowerCase();
      if (opening.current.has(key) || pwPending(p)) continue;
      opening.current.add(key);
      // the same file by another name (Y:\Tenders\x.pdf and \\server\share\Tenders\x.pdf): its tab
      const twin = await openTwin(p).catch(() => null);
      if (twin) { opening.current.delete(key); last = twin; continue; }
      const d = await busy('Opening ' + baseName(p) + '…', async () => {
        const st = await gcc.stat(p);
        const doc = new PdfDoc(p);
        // the engines read the file on demand: a 500 MB file is not loaded whole
        // (if it can't be opened, the engines let go of it - Windows would keep it locked)
        const r = await doc.load({ path: p }).catch(async (e) => { await doc.close().catch(() => {}); throw e; });
        if (r === 'password') { askPassword(p, doc); return null; }
        doc.readOnly = !!st && !st.writable;
        doc.mtime = st?.mtime || 0;
        // back to where it was last left
        const v = await gcc.viewGet(p).catch(() => null);
        if (v && v.anchor && v.anchor.page < doc.pages.length) {
          doc.view.fit = v.fit;
          doc.view.z = v.z || 0; // the exact zoom it had (in fit modes too: a refit keeps the spot)
          doc.view.anchor = v.anchor;
          doc.view.restore = true;
        }
        if (st) previewCache.set(doc.id, fingerprint(p + '|' + st.size + '|' + Math.round(st.mtime)));
        return doc;
      }).finally(() => opening.current.delete(key));
      if (d) { addDoc(d); last = d; addRecent(p); }
    }
    if (last && !holdFront()) setActiveId(last.id);
    return last;
  }

  /** which file each open tab is (asked once per path) */
  const fileIds = useRef(new Map<string, { path: string; real: string; fid: string }>());
  async function openTwin(p: string): Promise<PdfDoc | null> {
    const others = docsRef.current.filter((d) => d.path);
    if (!others.length) return null;
    const st = await gcc.stat(p);
    if (!st || (!st.real && !st.fid)) return null;
    for (const d of others) {
      let id = fileIds.current.get(d.id);
      if (!id || id.path !== d.path) {
        const s2 = await gcc.stat(d.path!).catch(() => null);
        id = { path: d.path!, real: s2?.real || '', fid: s2?.fid || '' };
        fileIds.current.set(d.id, id);
      }
      // (the resolved paths decide when both have one: the volume:file number comes as a plain
      // number, which on a big NTFS disk is rounded - two files next to each other in a folder
      // can share it, and the second one opened showed the first one's tab. The number only
      // where a path could not be resolved)
      if (st.real && id.real ? st.real === id.real : !!st.fid && st.fid === id.fid) return d;
    }
    return null;
  }

  /** a dialog working on the file in front is open: a file opened meanwhile (from Explorer, a tab
   *  from another window) waits behind it - in front, the dialog's crop / scale / pages went to it */
  /** a file brought to the front together with a dialog for it (A.ocrOf): that dialog stays */
  const dialogFor = useRef<string | null>(null);
  const holdFront = () => forTheFile(dialogRef.current) && docsRef.current.some((x) => x.id === activeRef.current);

  function addDoc(d: PdfDoc) {
    if (docsRef.current.includes(d)) return;
    watch(d);
    // (the ref at once: the next file of the same list is checked against it before React draws)
    docsRef.current = [...docsRef.current, d];
    setDocs((ds) => (ds.includes(d) ? ds : [...ds, d]));
    if (holdFront()) toast(`${d.name} is open in a new tab.`, 'info');
    else {
      setActiveId(d.id);
      setSel([]);
      setPageSel([]);
    }
    if (d.repaired) toast(`${d.name} was damaged; it was repaired while opening. Save to keep the repaired copy.`, 'info', undefined, 8000);
    if (d.heavy) toast(`${d.name} is an extremely heavy drawing (millions of separate line pieces). They were joined into fewer lines so it can be drawn at all - same drawing, very dense hatching may look a touch darker. The first picture can take half a minute.`, 'info', undefined, 12000);
    if (d.readOnly) toast(`${d.name} is read-only here – use Save as to keep changes.`, 'info');
  }

  /** a file whose password is known (moved here from another window) */
  async function openWithPassword(path: string, pw: string): Promise<PdfDoc | null> {
    await startEngines();
    const st = await gcc.stat(path);
    const d = new PdfDoc(path);
    const r = await d.load({ path }, pw).catch(async (e) => { await d.close().catch(() => {}); throw e; });
    if (r === 'password') { await d.close().catch(() => {}); return null; }
    d.readOnly = !!st && !st.writable;
    d.mtime = st?.mtime || 0;
    addDoc(d);
    return d;
  }

  /** the password typed: the file opens (a few seconds for a big one). Enter pressed again
   *  meanwhile does nothing; closing the prompt meanwhile means the file is not wanted after all */
  // (per file: a prompt closed while its file loads doesn't hold up the next one's Enter)
  const pwLoading = useRef(new Set<PdfDoc>());
  async function passwordEntered(pw: string) {
    const dlg = dialogRef.current;
    if (dlg?.k !== 'password' || pwLoading.current.has(dlg.doc)) return;
    const { doc: d, path } = dlg;
    pwLoading.current.add(d);
    const tid = toast('Opening ' + baseName(path) + '…', 'busy');
    let r: 'ok' | 'password';
    try { r = await d.load({ path }, pw); }
    catch (e) {
      // (the file gone, damaged...: said, and the engines let go of it - Windows would keep it locked)
      endToast(tid);
      await d.close().catch(() => {});
      setDialog((x) => (x?.k === 'password' && x.doc === d ? null : x));
      fail(e);
      return;
    } finally { pwLoading.current.delete(d); }
    endToast(tid);
    const now = dialogRef.current;
    if (now?.k !== 'password' || now.doc !== d) { await d.close().catch(() => {}); return; }
    if (r === 'password') { setDialog({ ...now, err: 'That password is not right.' }); return; }
    setDialog(null);
    const st = await gcc.stat(path);
    d.readOnly = !!st && !st.writable;
    addDoc(d);
    addRecent(path);
  }

  async function openDialog() {
    const files = await gcc.openDialog({ title: 'Open PDF' });
    if (files.length) await openPaths(files);
  }

  /** unsaved work back in a tab, from its recovery copy (left after a crash, or written to move
   *  the file here from another window) */
  async function restoreRec(r: { key: string; file: string; path: string | null; name: string; time?: number; base?: { path: string; size: number; mtime: number } | null; fileMtime?: number }, password?: string): Promise<PdfDoc | null> {
    await startEngines();
    // a copy of the recovery file is opened (the engines read it while the tab is open)
    let d: PdfDoc;
    if (r.base) {
      const st = await gcc.stat(r.base.path);
      if (!st || st.size !== r.base.size || Math.round(st.mtime) !== Math.round(r.base.mtime)) { toast(`${r.name} was changed since, so the unsaved work can't be put back on it.`, 'err'); return null; }
      d = new PdfDoc(null, r.name);
      if ((await d.load({ path: r.base.path, size: r.base.size, delta: await gcc.toTemp(r.file) }, password, true)) === 'password') { await d.close().catch(() => {}); throw new Error(`${r.name} needs its password.`); }
      addDoc(d);
    } else d = await loadNew(await gcc.toTemp(r.file), r.name, true, password);
    let path = r.path;
    // a whole copy (smaller files): its file was saved by something else after the copy was made -
    // saving over it would throw that away (the "changes only" copy above is refused the same way)
    if (!r.base && path && r.time) {
      const st = await gcc.stat(path).catch(() => null);
      // (the file's own time as it was then, when the copy says - both from the file server's clock;
      // a share whose clock runs ahead of this PC's made an untouched file look changed)
      if (st && (r.fileMtime ? Math.round(st.mtime) !== Math.round(r.fileMtime) : st.mtime > r.time + 2000)) {
        path = null;
        toast(`${baseName(r.path!)} was changed since this unsaved work was kept, so it comes back as a new file – Save asks where to keep it.`, 'info', undefined, 10000);
      }
    }
    d.path = path; d.name = r.name; d.dirty = true;
    // a recovery copy of its own first: if the app stops again before the next change,
    // the work is still there (the old one goes only once the new one is written)
    await d.writeRecoveryNow().catch((e) => gcc.log('recovery after restore: ' + e));
    await gcc.recoveryClear(r.key);
    setRecovery((x) => x.filter((y) => y.key !== r.key));
    return d;
  }

  // ---------------------------------------------------------------- tabs between windows

  /** a tab dragged out of the window (or "Move to new window"): its file opens in the other window
   *  - or a new one - and its tab here closes. Unsaved work goes along (undo starts again there). */
  async function moveTab(d: PdfDoc, target: number | null, x: number, y: number) {
    if (target === null && docsRef.current.length < 2) return;
    await settle(d);
    const page = d.id === activeRef.current ? pageNoRef.current : d.view.anchor?.page ?? 0;
    // (a file opened with its password goes with it: the other window opens it the same way)
    const p: TabMove = { path: d.path, name: d.name, page, readOnly: d.readOnly, password: d.password };
    const ok = await busy('Moving ' + d.name + '…', async () => {
      if (d.dirty || !d.path) {
        await d.writeRecoveryNow(true);
        if (!d.lastRecovery) throw new Error('Could not keep the unsaved work for the move.');
        p.rec = { key: d.id, file: d.lastRecovery.file, base: d.lastRecovery.base };
      } else if (d.view.anchor) await gcc.viewSet(d.path, { anchor: d.view.anchor, z: d.view.z, fit: d.view.fit, pages: d.pages.length }).catch(() => {});
      return gcc.tabMove(p, target, x, y);
    });
    if (!ok) { if (ok === false) toast(`${d.name} could not be opened in the other window; it stays here.`, 'err'); return; }
    // moved: this tab goes without asking (its work is in the other window now)
    d.dirty = false;
    await closeDoc(d, true);
    // a window whose last tab joined another window closes
    if (!docsRef.current.length && target !== null) gcc.closed();
  }
  /** a file arriving from another window */
  async function adopt(p: TabMove & { transfer: number }) {
    let d: PdfDoc | null = null;
    try {
      // the same file open here already: a clean copy here gives way to the one with changes;
      // changes on both sides - the move is refused (nothing is lost)
      const here = p.path ? docsRef.current.find((x) => x.path && x.path.toLowerCase() === p.path!.toLowerCase()) : null;
      if (here && p.rec) {
        if (here.dirty) { toast(`${p.name} is open here with unsaved changes of its own – save or close one of them first.`, 'err', undefined, 8000); gcc.adopted(p.transfer, false); return; }
        await closeDoc(here, true);
      }
      if (here && !p.rec) d = here;
      else if (p.rec) {
        d = await restoreRec({ ...p.rec, path: p.path, name: p.name }, p.password);
        if (d && p.readOnly) d.readOnly = true;
        if (d) toast(`${p.name} moved here with its unsaved changes – undo starts again from here.`, 'info', undefined, 6000);
      } else if (p.path) {
        d = p.password ? await openWithPassword(p.path, p.password) : await openPaths([p.path]);
      }
    } catch (e) { fail(e); }
    gcc.adopted(p.transfer, !!d);
    const pg = d ? Math.min(p.page, d.pages.length - 1) : 0;
    if (d && !holdFront()) {
      setActiveId(d.id);
      if (pg > 0) window.setTimeout(() => viewer.current?.goTo(pg), 150);
    } else if (d && pg > 0 && !d.view.restore) {
      // (waiting behind a dialog: it opens at its page when shown, not at page 1)
      d.view.anchor = { page: pg, x: 0, y: 0 };
      d.view.restore = true;
    }
  }

  /** a new tab from a file the app made (merge result, dragged pages...): no path until saved */
  async function newFromFile(file: string, name: string, temp = true) {
    const d = await loadNew(file, name, temp);
    // unsaved from the start, and its only other copy is a temp file (gone after a crash): a
    // recovery copy now - setting it as changed by hand skipped the automatic one
    void d.writeRecoveryNow().catch((e) => gcc.log('recovery of a new tab: ' + e));
    return d;
  }
  async function loadNew(file: string, name: string, temp = true, password?: string) {
    const d = new PdfDoc(null, name);
    if ((await d.load({ path: file }, password, temp)) === 'password') { await d.close().catch(() => {}); throw new Error(`${name} needs its password.`); }
    d.dirty = true;
    addDoc(d);
    return d;
  }

  async function saveDoc(d: PdfDoc, as = false): Promise<boolean> {
    try {
      // (a comment just typed is in the file, and the file is "saved" afterwards, not still changed)
      await settle(d);
      if (!as && d.path && !d.readOnly) {
        // a digitally signed file that this save would rewrite: asked first (a copy keeps the
        // signed original as it is)
        if (await d.breaksSignatures()) {
          const r = await gcc.confirm({ message: `“${d.name}” is digitally signed`, detail: 'Pages were deleted, something was redacted or text was edited, so saving rewrites the file and its digital signatures will no longer be valid.\n\nSave a copy under another name to keep the signed file as it is.', buttons: ['Save a copy…', 'Save anyway', 'Cancel'], type: 'warning' });
          if (r === 2) return false;
          if (r === 0) return saveDoc(d, true);
        }
        const ok = await busy('Saving ' + d.name + '…', () => d.save(), 'save:' + d.id);
        if (ok) { toast('Saved ' + d.name, 'ok', undefined, 2000); return true; }
        if (ok === undefined) return false;
        // (its file is not there any more or can't be written: said, or Ctrl+S just opened Save as)
        toast(`${d.name} can't be saved where it was (renamed, moved or deleted, its drive not connected, or read-only) – choose where to keep it.`, 'info', undefined, 8000);
      }
      const target = await gcc.saveDialog({ title: 'Save as', path: d.path ? joinPath(dirName(d.path), d.name.replace(/\.pdf$/i, '') + (d.readOnly && !as ? ' (edited)' : '') + '.pdf') : undefined, name: d.name });
      if (!target) return false;
      const other = docsRef.current.find((x) => x !== d && x.path && x.path.toLowerCase() === target.toLowerCase());
      if (other) { toast('That file is open in another tab – close it first.', 'err'); return false; }
      const ok = await busy('Saving ' + baseName(target) + '…', () => d.save(target), 'save:' + d.id);
      if (ok) { addRecent(target); toast('Saved ' + baseName(target), 'ok', undefined, 2500); setVer((v) => v + 1); }
      return !!ok;
    } catch (e) { fail(e); return false; }
  }

  /** what is still being typed is part of the file before it is saved, closed or moved: a
   *  comment in the right panel (saved when its box loses focus - a middle-click on the tab
   *  doesn't take the focus away) and a text box on the page; then the engine's answers to
   *  those changes, which is when the file counts as changed */
  async function settle(d: PdfDoc) {
    const f = document.activeElement as HTMLElement | null;
    if (f?.closest?.('.props')) f.blur();
    await d.finishEditing?.().catch(() => {});
    await panelEditsDone(d);
    // (Set scale / Calibrate close at once; the scale reaches the file a moment later)
    await D.scalesWritten();
  }

  /** close one tab; force: the "save?" question was already answered for it */
  async function closeDoc(d: PdfDoc, force = false): Promise<boolean> {
    // an export of this file under way: stopped only if the person says so
    if (exportRunning.docId === d.id && !(await stopExport(d.name))) return false;
    // a text box or comment still being typed in: its text counts as a change to ask about
    await settle(d);
    if (d.dirty && !force) {
      setActiveId(d.id);
      activeRef.current = d.id;
      const r = await gcc.confirm({ message: `Save changes to ${d.name}?`, detail: 'Your changes are lost if you don\'t save them.', buttons: ['Save', "Don't save", 'Cancel'] });
      if (r === 2) return false;
      if (r === 0 && !(await saveDoc(d))) return false;
    }
    // remember where it was left: it reopens at the same page, spot and zoom
    if (d.path && d.view.anchor) void gcc.viewSet(d.path, { anchor: d.view.anchor, z: d.view.z, fit: d.view.fit, pages: d.pages.length }).catch(() => {});
    forgetAiFor(d.id);
    // the tab goes at once; the engines let go of the file in the background
    const pc = d.close().catch((e) => gcc.log('close: ' + e));
    closing.add(pc);
    void pc.finally(() => closing.delete(pc));
    // (the refs, not this render's activeId: the question above may have switched tabs, and
    // closing several tabs in a row runs before React draws again - the refs are kept current here)
    const ds = docsRef.current;
    const i = ds.indexOf(d);
    const rest = ds.filter((x) => x !== d);
    const cur = activeRef.current;
    const next = cur === d.id || !rest.some((x) => x.id === cur) ? rest[Math.min(Math.max(i, 0), rest.length - 1)]?.id ?? null : cur;
    docsRef.current = rest;
    activeRef.current = next;
    setDocs((all) => all.filter((x) => x !== d));
    setActiveId(next);
    setSel([]);
    return true;
  }

  /** an export is running: stop it? (closing its file, or the window) */
  async function stopExport(name: string): Promise<boolean> {
    if (!exportRunning.docId) return true;
    const r = await gcc.confirm({ message: `${name} is being exported`, detail: 'Stop the export and close? Nothing is saved from it.', buttons: ['Stop and close', 'Cancel'] });
    if (r !== 0) return false;
    exportRunning.stop?.();
    setDialog((x) => (x?.k === 'export' ? null : x));
    // (the export ends at its next step; its file is let go)
    for (let i = 0; i < 40 && exportRunning.docId; i++) await new Promise((res) => setTimeout(res, 100));
    return true;
  }

  /** close several tabs; unsaved ones are asked about together (save all / don't save / each) */
  async function closeMany(list: PdfDoc[]): Promise<boolean> {
    for (const d of list) await settle(d);
    const dirty = list.filter((d) => d.dirty);
    let force = false;
    if (dirty.length > 1) {
      const r = await gcc.confirm({ message: `${dirty.length} files have unsaved changes`, detail: dirty.map((d) => '• ' + d.name).join('\n'), buttons: ['Save all', "Don't save", 'Ask for each', 'Cancel'] });
      if (r === 3) return false;
      if (r === 0) for (const d of dirty) { setActiveId(d.id); activeRef.current = d.id; if (!(await saveDoc(d))) return false; }
      force = r === 0 || r === 1;
    }
    for (const d of list) if (!(await closeDoc(d, force))) return false;
    return true;
  }

  async function closeAll(): Promise<boolean> {
    if (!(await closeMany([...docsRef.current]))) return false;
    // recovery copies of "don't save" files must be gone before the app ends
    await Promise.race([Promise.all([...closing]), new Promise((r) => setTimeout(r, 4000))]);
    return true;
  }

  async function movePagesIn(d: PdfDoc, from: number[], to: number) {
    const rest = [...Array(d.pages.length).keys()].filter((i) => !from.includes(i));
    const at = rest.filter((i) => i < to).length;
    const order = [...rest.slice(0, at), ...from, ...rest.slice(at)];
    if (order.every((v, i) => v === i)) return;
    await busy('Moving pages…', () => d.arrange(order, 'Move pages'));
    // (the chosen pages go with them: followPages below)
  }

  // ---------------------------------------------------------------- tools & styles

  // (measuring tools share one number format: unit and decimals)
  const style = useMemo(() => ({ ...toolStyle(tool, settings.styles?.[tool]), fmt: settings.measureFmt }), [tool, settings.styles, settings.measureFmt]);
  const setTool = useCallback((t: ToolId) => {
    // (0.8.4's Rectangle area tool - from a Tool Chest item or Find a tool - is the Area tool
    // drawing rectangles now)
    let how = S.current.measureHow || 'points';
    if (t === 'm-rectarea') { t = 'm-area'; how = 'rect'; saveSettings({ measureHow: how }); }
    setToolState(t);
    setMenu(null);
    if (t !== 'select') setSel([]);
    if (t === 'm-area' || t === 'm-perimeter') setStatus(HOW_HINT[how]);
    else if (TOOLS[t].hint) setStatus(TOOLS[t].hint);
    if (MEASURE_TOOLS.includes(t) && t !== 'm-calibrate' && doc && !doc.scaleAt(pageNo)) toast('This page has no scale yet – measurements show paper size. Use Calibrate or Scale first.', 'info', { label: 'Set scale', run: () => setDialog({ k: 'scale', page: viewer.current?.page() ?? 0 }) }, 7000);
  }, [doc, pageNo]);
  const setToolStyle = (t: ToolId, patch: Partial<Style>) => {
    if ('fmt' in patch) {
      const { fmt, ...rest } = patch;
      saveSettings({ measureFmt: fmt });
      if (!Object.keys(rest).length) return;
      patch = rest;
    }
    // (shown at once; written once the change stops - a slider dragged wrote the whole settings
    // file, stamps and signatures included, at every step)
    const styles = { ...(S.current.styles || {}), [t]: { ...(S.current.styles?.[t] || {}), ...patch } };
    S.current = { ...S.current, styles };
    setSettingsState((s) => ({ ...s, styles }));
    window.clearTimeout(styleSave.current);
    styleSave.current = window.setTimeout(() => { styleSave.current = 0; void saveSettings({ styles: S.current.styles }); }, 300);
  };

  /** the stamp picked last (the Tool Chest keeps it with the stamp tool) */
  const lastStamp = useRef<string | null>(null);
  /** a saved stamp's or signature's picture as bytes - a damaged one (not a picture, cut short)
   *  is said, instead of the click doing nothing */
  const pictureOf = (url: string, what: string) => {
    try { const b = dataUrlToBytes(url); if (b?.length) return b; } catch { /* below */ }
    toast(`The picture of ${what} can't be read – add it again (Stamp or Signature).`, 'err', undefined, 7000);
    return null;
  };
  function useStamp(s: StampDef) {
    const name = S.current.author || info?.user || '';
    if (s.design) {
      const des = fillFields(s.design, name);
      const [w, h] = designSize(des);
      setPlace({ spec: { type: 'Stamp', design: des, kind: 'stamp', subject: s.name }, w, h });
    } else if (s.image) {
      const image = pictureOf(s.image, `the stamp "${s.name}"`);
      if (!image) return;
      setPlace({ spec: { type: 'Stamp', image, kind: 'stamp', subject: s.name }, w: s.w || 120, h: s.h || 60, real: !!s.real });
    }
    lastStamp.current = s.id;
    setTool('stamp');
  }
  function useSignature(sig: { image: string; w: number; h: number }) {
    const image = pictureOf(sig.image, 'this signature');
    if (!image) return;
    setPlace({ spec: { type: 'Stamp', image, kind: 'signature', subject: 'Signature' }, w: sig.w, h: sig.h });
    setTool('signature');
  }
  async function pickImage() {
    const f = await gcc.openDialog({ title: 'Choose a picture', single: true, filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }] });
    if (!f.length) return;
    let bytes: Uint8Array;
    let bmp: ImageBitmap;
    // (a picture moved or deleted meanwhile is said too - the read was outside this, and nothing happened)
    try { bytes = await gcc.read(f[0]); }
    catch (e) { toast(`${baseName(f[0])} can't be read: ${String((e as Error)?.message || e)}`, 'err', undefined, 7000); return; }
    try { bmp = await createImageBitmap(new Blob([bytes as unknown as BlobPart])); }
    catch { toast('That picture can\'t be read (TIFF and some BMP files) – save it as PNG or JPEG and try again.', 'err', undefined, 7000); return; }
    const k = Math.min(1, 300 / Math.max(bmp.width, bmp.height));
    setPlace({ spec: { type: 'Stamp', image: bytes, kind: 'image', subject: baseName(f[0]) }, w: bmp.width * k, h: bmp.height * k });
    bmp.close();
    setTool('image');
  }

  // ---------------------------------------------------------------- actions on the open file

  const targetPages = (): number[] => (pageSel.length ? [...pageSel].sort((a, b) => a - b) : [viewer.current?.page() ?? pageNo]);

  const A = {
    open: openDialog,
    openPaths,
    save: () => doc && saveDoc(doc),
    saveAs: () => doc && saveDoc(doc, true),
    close: () => doc && closeDoc(doc),
    print: () => { if (doc) { const pg = viewer.current?.page() ?? pageNo; void (doc.finishEditing?.() ?? Promise.resolve()).catch(() => {}).then(() => setDialog({ k: 'print', page: pg })); } },
    undo: async () => { if (doc) { if (await doc.undoTyping?.().catch(() => false)) { setSel([]); return; } await doc.undo().catch(fail); setSel([]); } },
    redo: async () => { if (doc) { if (await doc.redoTyping?.().catch(() => false)) return; await doc.redo().catch(fail); setSel([]); } },
    setTool,
    zoomIn: () => viewer.current?.zoomBy(1.25),
    zoomOut: () => viewer.current?.zoomBy(0.8),
    setZoom: (z: number) => viewer.current?.setZoom(z),
    fit: (m: 'width' | 'page') => viewer.current?.fit(m),
    goTo: (p: number, r?: number[]) => viewer.current?.goTo(p, r),
    /** centre the view on a point of a page, zoom unchanged (the box on a thumbnail) */
    panTo: (p: number, x: number, y: number) => viewer.current?.goTo(p, [x, y, x, y], true),
    rotate: async (delta: number) => { if (!doc) return; await busy('Rotating…', () => doc.rotate(targetPages(), delta)); },
    deletePages: async () => {
      if (!doc) return;
      const ps = targetPages();
      if (ps.length >= doc.pages.length) { toast('A PDF needs at least one page.', 'err'); return; }
      const r = await gcc.confirm({ message: `Delete ${ps.length === 1 ? 'page ' + (ps[0] + 1) : ps.length + ' pages'}?`, detail: 'You can undo this with Ctrl+Z.', buttons: ['Delete', 'Cancel'] });
      if (r !== 0) return;
      await busy('Deleting pages…', () => doc.deletePages(ps));
      setPageSel([]);
    },
    duplicate: async () => {
      if (!doc) return;
      const ps = targetPages();
      const order: number[] = [];
      for (let i = 0; i < doc.pages.length; i++) { order.push(i); if (ps.includes(i)) order.push(i); }
      await busy('Duplicating…', () => doc.arrange(order, 'Duplicate pages'));
    },
    movePages: async (from: number[], to: number) => { if (doc) await movePagesIn(doc, from, to); },
    /** at = the position the new page(s) go to (default: after the current page) */
    insertBlank: async (at?: number) => { if (!doc) return; const pos = at ?? (viewer.current?.page() ?? 0) + 1; const pg = doc.pages[Math.max(0, Math.min(doc.pages.length - 1, pos - 1))]; await busy('Inserting…', () => doc.insertBlank(pos, pg.w, pg.h)); },
    insertFile: (at?: number) => doc && setDialog({ k: 'insert', at: at ?? (viewer.current?.page() ?? 0) + 1 }),
    /** pages of this file swapped for pages of another (revised sheets) */
    replacePages: () => doc && setDialog({ k: 'insert', at: (viewer.current?.page() ?? 0) + 1, mode: 'replace' }),
    // (the pages typed like in Print; saved now or opened as a tab; taken out of this file or not)
    extract: () => doc && setDialog({ k: 'extract' }),
    /** an area of a page as shown (page + markups) at s pixels per point */
    areaPicture: (d: PdfDoc, page: number, r: Rect, s: number) => areaPicture(d, page, r, s),
    /** pages as PNG / JPG files */
    toPictures: () => doc && setDialog({ k: 'toPictures' }),
    /** a new PDF made of pictures / scans */
    fromPictures: (files: string[] = []) => setDialog({ k: 'fromPictures', files }),
    /** the page in view (0-based) */
    currentPage: () => viewer.current?.page() ?? pageNo,
    /** bring an open file's tab to the front */
    showDoc: (id: string) => { if (docsRef.current.some((d) => d.id === id)) { setActiveId(id); activeRef.current = id; } },
    split: () => doc && setDialog({ k: 'split' }),
    merge: () => setDialog({ k: 'merge' }),
    compress: () => setDialog({ k: 'compress', files: doc?.path ? [doc.path] : [] }),
    exportWord: () => doc && setDialog({ k: 'export', format: 'docx' }),
    exportExcel: () => doc && setDialog({ k: 'export', format: 'xlsx' }),
    /** one table off a big drawing: drag a box, just that area goes to Excel */
    tableArea: () => { if (!doc) return; setDialog(null); setTool('table'); toast('Drag a box around the table – only what is inside it goes to Excel.', 'info', undefined, 6000); },
    marks: (batch = false) => setDialog({ k: 'marks', batch }),
    protect: () => doc && setDialog({ k: 'protect' }),
    removePassword: async () => {
      if (!doc) return;
      if (!doc.password) { toast('This file has no open password.', 'info'); return; }
      const target = doc.readOnly || !doc.path ? await gcc.saveDialog({ name: doc.name }) : doc.path;
      if (!target) return;
      if (target === doc.path && await doc.breaksSignatures(target, { decrypt: true })) {
        const r = await gcc.confirm({ message: `“${doc.name}” is digitally signed`, detail: 'Removing the password rewrites the file, so its digital signatures will no longer be valid.', buttons: ['Remove the password', 'Cancel'], type: 'warning' });
        if (r !== 0) return;
      }
      const ok = await busy('Removing the password…', () => doc.save(target, { decrypt: true }));
      if (ok) { doc.password = undefined; toast('Password removed.', 'ok'); }
    },
    sanitize: async () => {
      if (!doc) return;
      const r = await gcc.confirm({ message: 'Remove hidden information?', detail: 'Removes document properties (author, title…), scripts and unused content, then saves a copy. Markups are kept.', buttons: ['Choose where to save…', 'Cancel'] });
      if (r !== 0) return;
      const target = await gcc.saveDialog({ name: doc.name.replace(/\.pdf$/i, '') + ' (clean).pdf' });
      if (!target) return;
      const f = await busy('Cleaning…', () => doc.fileForSave({ sanitize: true, clearMetadata: true }));
      if (!f) return;
      try { await gcc.commit(f, target, { noBackup: true }); } catch (e) { void gcc.dropTemp([f]); fail(e); return; }
      toast('Saved ' + baseName(target), 'ok');
    },
    props: () => doc && setDialog({ k: 'props' }),
    ai: (t: 'ask' | 'translate' | 'setup') => {
      if (t === 'setup') { setDialog({ k: 'ai-keys' }); return; }
      if (!doc) { toast('Open a PDF first.', 'info'); return; }
      setAiTab(t);
      setAiOpen(true);
    },
    /** pages: start with these pages chosen (the Pages panel's menu) */
    ocr: (pages?: number[]) => doc && setDialog({ k: 'ocr', pages }),
    /** OCR of a given tab (a toast's button: made before that tab was the one in front) */
    ocrOf: (id: string) => {
      if (!docsRef.current.some((x) => x.id === id)) return;
      // (brought to the front with its dialog: the tab change below must not close that dialog)
      dialogFor.current = activeRef.current !== id ? id : null;
      setActiveId(id); activeRef.current = id; setDialog({ k: 'ocr' });
    },
    batchOcr: () => setDialog({ k: 'batch-ocr' }),
    batchFlatten: () => setDialog({ k: 'batch-flatten' }),
    applyRedactions: async () => {
      if (!doc) return;
      const n = (await doc.allAnnots()).filter((a) => a.type === 'Redact').length;
      if (!n) { toast('Nothing is marked for redaction. Use Redact area or Redact text first.', 'info'); return; }
      const r = await gcc.confirm({ message: `Apply ${n} redaction${n > 1 ? 's' : ''}?`, detail: 'Everything under the marks is removed from the file for good: text, pictures and line work. A black box stays in its place. (Ctrl+Z works until you close the file.)', buttons: ['Apply', 'Cancel'], type: 'warning' });
      if (r !== 0) return;
      // (only when it worked: after a failure "applied" sent people off to save a file that still had the text)
      const done = await busy('Redacting…', () => doc.applyRedactions({ black: true }));
      if (done === undefined) return;
      toast('Redactions applied. Save to make them permanent in the file.', 'ok');
    },
    redactSearch: () => doc && setDialog({ k: 'redact-search' }),
    flatten: async (what: 'all' | 'selected' | 'comments' | 'stamps' | 'measure' | 'forms') => {
      if (!doc) return;
      const label = { all: 'all markups', selected: 'the selected markups', comments: 'all comments and drawings', stamps: 'all stamps and signatures', measure: 'all measurements', forms: 'the form fields' }[what];
      const r = await gcc.confirm({ message: `Flatten ${label}?`, detail: 'Flattened markups become part of the page: they can no longer be moved, changed or deleted. (Ctrl+Z works until you close the file.)', buttons: ['Flatten', 'Cancel'] });
      if (r !== 0) return;
      const all = await doc.allAnnots();
      let items: SelItem[] | null = null;
      let opts: { widgets?: boolean; types?: string[] } = {};
      if (what === 'selected') items = sel;
      if (what === 'stamps') items = all.filter((a) => a.type === 'Stamp').map((a) => ({ page: a.page, id: a.id }));
      if (what === 'measure') items = all.filter((a) => a.kind?.startsWith('measure-')).map((a) => ({ page: a.page, id: a.id }));
      if (what === 'comments') items = all.filter((a) => a.type !== 'Stamp' && a.type !== 'Widget' && !a.kind?.startsWith('measure-') && a.type !== 'Redact').map((a) => ({ page: a.page, id: a.id }));
      if (what === 'forms') { items = null; opts = { widgets: true, types: ['Widget'] }; }
      if (what === 'all') opts = { widgets: false };
      if (items && !items.length) { toast('Nothing to flatten.', 'info'); return; }
      const n = await busy('Flattening…', () => doc.flatten(items, opts));
      setSel([]);
      if (n != null) toast(`Flattened ${n} markup${n === 1 ? '' : 's'}.`, 'ok');
    },
    stamps: () => setDialog({ k: 'stamps' }),
    signature: () => setDialog({ k: 'signature' }),
    image: pickImage,
    useStamp,
    scale: () => doc && setDialog({ k: 'scale', page: viewer.current?.page() ?? 0 }),
    /** the selected markups (a stamp, a title-block note) onto other pages */
    copyToPages: () => {
      if (!doc) return;
      if (!sel.length) { toast('Select the stamp or markups to copy first.', 'info'); return; }
      if (doc.pages.length < 2) { toast('This file has only one page.', 'info'); return; }
      setDialog({ k: 'copypages', items: sel });
    },
    /** size of all measurement numbers in this file (new ones too): k = 1 is the automatic size */
    labelScale: async (k: number) => {
      if (!doc || !(k > 0)) return;
      const old = Number(doc.data.labelK) || 1;
      if (Math.abs(k - old) < 1e-6) return;
      await busy('Label size…', async () => {
        // one undo step: the file's setting and every number already there (kept unclamped -
        // drawn between 2 and 72 pt - so 300 % then back to 100 % gives the sizes back)
        const list = (await doc.allAnnots()).filter((a) => a.kind?.startsWith('measure-') && a.kind !== 'measure-count' && !a.locked);
        await doc.update(list.map((a) => ({ page: a.page, id: a.id, patch: { labelSize: Math.round(Math.max(0.2, Math.min(720, (a.labelSize ?? 10) * (k / old))) * 100) / 100 } })), 'Label size', { labelK: k });
      });
      setVer((v) => v + 1);
    },
    exportMeasurements: async () => {
      if (!doc) return;
      const all = (await doc.allAnnots()).filter((a) => a.kind?.startsWith('measure-'));
      if (!all.length) { toast('No measurements in this file yet.', 'info'); return; }
      // the number as a number, its unit in the next cell (measurexl.ts); the label as written
      // on the drawing beside them
      // (an area's perimeter in its own columns beside it)
      const rows = [['Page', 'Type', 'Value', 'Unit', 'Perimeter', 'Unit', 'Label on the drawing', 'Count group', 'Author', 'Date'], ...all.map((a) => {
        const n = measureNumber(a, (pg, x, y) => doc.scaleAt(pg, x, y));
        const pn = perimeterNumber(a, (pg, x, y) => doc.scaleAt(pg, x, y));
        return [a.page + 1, (a.subject || a.kind || '').replace('measure-', ''), n ? { v: n.v, s: numStyle(n.dec) } : '', n ? n.unit : '', pn ? { v: pn.v, s: numStyle(pn.dec) } : '', pn ? pn.unit : '', a.contents || '', a.group || '', a.author, a.modified ? new Date(a.modified).toLocaleString('en-GB') : ''];
      })];
      const counts = new Map<string, number>();
      for (const a of all) if (a.kind === 'measure-count') counts.set(a.group || 'Count', (counts.get(a.group || 'Count') || 0) + 1);
      const target = await gcc.saveDialog({ title: 'Save measurements', name: doc.name.replace(/\.pdf$/i, '') + ' measurements.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
      if (!target) return;
      try { await gcc.write(target, writeXlsx([
        { name: 'Measurements', rows: rows.map((r, i) => (i === 0 ? r.map((v) => ({ v: v as string, s: 'h' as const })) : r)) as never, header: 1, widths: [7, 14, 12, 8, 12, 8, 30, 16, 16, 18] },
        { name: 'Counts', rows: [[{ v: 'Count', s: 'h' }, { v: 'Number', s: 'h' }], ...[...counts].map(([k, v]) => [k, v])] as never, header: 1, widths: [24, 10] },
      ]), { noBackup: true }); } catch (e) { fail(e); return; }
      toast('Saved ' + baseName(target), 'ok', { label: 'Open', run: () => void gcc.openExternal(target) });
    },
    togglePanel: () => saveSettings({ propsPanel: S.current.propsPanel === false }),
    /** how Area / Perimeter draw their shape (corners, rectangle, circle) - remembered */
    setHow: (h: MeasureHow) => { void saveSettings({ measureHow: h }); setStatus(HOW_HINT[h]); },
    /** the Counts & totals panel (left) */
    totals: () => setSide('totals'),
    /** count more of a name (from the Counts & totals panel) */
    countWith: (g: string) => { setCountGroup(g); setTool('m-count'); setStatus(`Counting "${g}" – click each one.`); },
    setCounting: (g: string) => setCountGroup(g),
    /** Count by tag: the tags written on the drawing found and counted in one go */
    countByTag: () => { if (doc) setDialog({ k: 'counttag', page: viewer.current?.page() ?? pageNo }); },
    toggleSnap: () => saveSettings({ snap: !(S.current.snap ?? true) }),
    toggleOrtho: () => saveSettings({ ortho: !S.current.ortho }),
    toggleCross: () => saveSettings({ cross: !S.current.cross }),
    toggleLoupe: () => saveSettings({ loupe: !S.current.loupe }),
    loupeZoom: (n: number) => saveSettings({ loupeZoom: n }),
    settings: () => setDialog({ k: 'settings' }),
    whatsNew: () => setDialog({ k: 'whatsnew' }),
    /** Help > Report a problem: the window is captured first (before the dialog covers it) */
    report: async () => { const shot = await gcc.reportCapture().catch(() => null); setDialog({ k: 'report', shot }); },
    about: () => setDialog({ k: 'about' }),
    find: () => { setSide('search'); window.setTimeout(() => (document.querySelector('.search-in') as HTMLInputElement | null)?.focus(), 30); },
    crop: () => setTool('crop'),
    chestUse: (c: ChestItem) => {
      // (an item from another version can name a tool this one doesn't have: drawing with it blanked the window)
      if (!TOOLS[c.tool]) { toast(`"${c.name}" is for a tool this version doesn't have.`, 'err'); return; }
      // (measurement number formats are one setting for all measuring, not part of a chest item -
      // a saved cloud reset the decimals)
      const { fmt: _f, ...st } = c.style as typeof c.style & { fmt?: unknown };
      void _f;
      // (0.8.4's Rectangle area items draw with the Area tool now: their look goes with them)
      setToolStyle(c.tool === 'm-rectarea' ? 'm-area' : c.tool, st);
      if (c.tool === 'm-rectarea') saveSettings({ measureHow: 'rect' });
      if (c.place?.stampId) { const st = [...BUILTIN_STAMPS, ...(S.current.stamps || [])].find((s) => s.id === c.place!.stampId); if (st) { useStamp(st); return; } }
      setTool(c.tool);
    },
    chestAdd: () => {
      // a stamp goes in with the stamp it places (an empty stamp tool only said "Pick a stamp first");
      // a signature or picture can't (they aren't kept with the tool)
      let place: ChestItem['place'];
      if (tool === 'stamp') {
        const sd = lastStamp.current ? [...BUILTIN_STAMPS, ...(S.current.stamps || [])].find((x) => x.id === lastStamp.current) : null;
        if (!sd) { toast('Pick a stamp first (Stamp), then add it to the Tool Chest.', 'info'); return; }
        place = { stampId: sd.id };
      } else if (tool === 'signature' || tool === 'image') { toast('Signatures and pictures can\'t go in the Tool Chest – drawing tools and stamps can.', 'info'); return; }
      const sname = place ? [...BUILTIN_STAMPS, ...(S.current.stamps || [])].find((x) => x.id === place!.stampId)?.name : null;
      const name = sname ? 'Stamp: ' + sname : TOOLS[tool].label + ' ' + ((S.current.chest || []).filter((c) => c.tool === tool).length + 1);
      const { fmt: _f, ...st } = style;
      void _f;
      saveSettings({ chest: [...(S.current.chest || []), { id: Math.random().toString(36).slice(2), name, tool, style: st, ...(place ? { place } : {}) }] });
      toast(`Added "${name}" to the Tool Chest.`, 'ok');
    },
    chestRemove: (id: string) => saveSettings({ chest: (S.current.chest || []).filter((c) => c.id !== id) }),
  };
  type Actions = typeof A;

  // ---------------------------------------------------------------- viewer events

  const onViewerEvent = useCallback(async (e: ViewerEvent) => {
    const d = docsRef.current.find((x) => x.id === activeId);
    switch (e.type) {
      case 'page': setPageNo(e.page); break;
      case 'zoom': setZoom(e.z); break;
      case 'status': setStatus(e.text); break;
      case 'note': toast(e.text, 'info', undefined, 8000); break;
      case 'error': toast(e.text, 'err'); break;
      case 'created': break;
      case 'comment': setSel([{ page: e.page, id: e.id }]); if (S.current.propsPanel === false) saveSettings({ propsPanel: true }); setCommentFocus((n) => n + 1); break;
      case 'menu': setMenu({ x: e.x, y: e.y, page: e.page, at: e.at, text: e.text }); break;
      case 'calibrate': setDialog({ k: 'calibrate', page: e.page, a: e.a, b: e.b }); break;
      case 'viewport': setDialog({ k: 'viewport', page: e.page, rect: e.rect }); setToolState('select'); setStatus(TOOLS.select.hint ?? ''); break;
      case 'crop': setDialog({ k: 'crop', page: e.page, rect: e.rect }); setToolState('select'); setStatus(TOOLS.select.hint ?? ''); break;
      case 'snapshot': if (d) await snapshot(d, e.page, e.rect); break;
      case 'table': if (d) await copyTable(d, e.page, e.rect); break;
      case 'link': if (d) setDialog({ k: 'link', page: e.page, rect: e.rect }); break;
      case 'linkAt': {
        if (!d) break;
        // the smallest link under the click (one inside another: the inner one)
        const ls = await mu<{ k: number; rect: Rect; uri: string | null; page: number }[]>('linksOf', d.id, e.page).catch(() => []);
        // (the engine was busy and another file came to the front meanwhile: not that file's link)
        if (activeRef.current !== d.id) break;
        const at = ls.filter((l) => e.pt[0] >= l.rect[0] - 1 && e.pt[0] <= l.rect[2] + 1 && e.pt[1] >= l.rect[1] - 1 && e.pt[1] <= l.rect[3] + 1)
          .sort((a, b) => (a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1]) - (b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1]))[0];
        if (at) setDialog({ k: 'link', page: e.page, rect: at.rect, edit: { k: at.k, uri: at.uri, page: at.page } });
        else setStatus('No link there – drag a box to make one.');
        break;
      }
      case 'ocr-area': if (d) await readArea(d, e.page, e.rect); break;
      case 'stamp-grab': if (d) await grabStamp(d, e.page, e.rect); break;
    }
  }, [activeId]);

  /** an area of a page as it is shown - the page and its markups - at s pixels per point */
  async function areaPicture(d: PdfDoc, page: number, r: Rect, s: number): Promise<OffscreenCanvas> {
    const x = Math.round(r[0] * s), y = Math.round(r[1] * s), w = Math.max(1, Math.round((r[2] - r[0]) * s)), h = Math.max(1, Math.round((r[3] - r[1]) * s));
    const base = await rendererFor(d.id, page).call<ImageBitmap>('tile', [d.id, page, s, x, y, w, h]);
    const hl = await editWorker.call<ImageBitmap | null>('annotTile', [d.id, page, s, x, y, w, h, [], 'hl']);
    const ann = await editWorker.call<ImageBitmap | null>('annotTile', [d.id, page, s, x, y, w, h, [], 'rest']);
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d')!;
    g.drawImage(base, 0, 0);
    if (hl) { g.globalCompositeOperation = 'multiply'; g.drawImage(hl, 0, 0); g.globalCompositeOperation = 'source-over'; }
    if (ann) g.drawImage(ann, 0, 0);
    base.close?.(); hl?.close?.(); ann?.close?.();
    return c;
  }

  async function snapshot(d: PdfDoc, page: number, r: Rect) {
    await busy('Copying picture…', async () => {
      const s = Math.min(4, 6000 / Math.max(r[2] - r[0], r[3] - r[1]), Math.max(2, 1200 / Math.max(r[2] - r[0], r[3] - r[1])));
      const c = await areaPicture(d, page, r, s);
      const w = c.width, h = c.height;
      const png = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
      await gcc.copyImage(png);
      toast(`Picture copied (${w} × ${h} px) – paste it into Word, Outlook or Excel.`, 'ok', {
        label: 'Save as PNG…', run: async () => { const t = await gcc.saveDialog({ name: 'snapshot.png', filters: [{ name: 'PNG picture', extensions: ['png'] }] }); if (t) await gcc.write(t, png, { noBackup: true }).then(() => toast('Saved ' + baseName(t), 'ok'), fail); },
      }, 7000);
    });
  }

  /** a stamp on a scanned page (or one placed as a markup): the area as shown, at about 400 dpi -> cleaned */
  async function grabStamp(d: PdfDoc, page: number, r: Rect) {
    if (Math.max(r[2] - r[0], r[3] - r[1]) < 20) { toast('Drag a box round the whole stamp.', 'info'); return; }
    const bmp = await busy('Taking the stamp…', async () => {
      const s = Math.min(400 / 72, 3300 / Math.max(1, r[2] - r[0], r[3] - r[1]));
      await d.drawReady();
      return { b: (await areaPicture(d, page, r, s)).transferToImageBitmap(), s };
    });
    if (!bmp) return;
    setTool('select');
    setDialog({ k: 'stamps', scan: { bmp: bmp.b, name: 'Stamp', ptPerPx: 1 / bmp.s } });
  }

  async function copyTable(d: PdfDoc, page: number, r: Rect) {
    const rows = await busy('Reading the table…', async (set) => {
      await d.drawReady();
      const chars = await rendererFor(d.id, page).call<{ c: string; b: number[] }[]>('charsIn', [d.id, page, r]);
      let words = charsToWords(chars);
      if (words.filter((w) => w.text.trim()).length < 2) {
        set('No text in that area – reading it (OCR)…');
        words = (await ocrPage(d.id, page, d.pages[page].w, d.pages[page].h, { lang: S.current.ocrLang || 'eng+ara', rect: r })).map((w) => ({ text: w.text, box: w.box }));
      }
      return wordsToTable(words);
    });
    if (!rows || !rows.length) { if (rows) toast('No text found in that area.', 'info'); return; }
    await gcc.copyText(toTsv(rows), toHtml(rows));
    // (another file came to the front while it was read - OCR takes seconds: copied, but the
    // dialog would offer to save the other file's area)
    if (activeRef.current !== d.id || !docsRef.current.includes(d)) { toast(`Table from ${d.name}, page ${page + 1} copied – paste it into Excel.`, 'ok', undefined, 7000); return; }
    setDialog({ k: 'table', rows, page, rect: r, docId: d.id });
  }

  async function readArea(d: PdfDoc, page: number, r: Rect) {
    const text = await busy('Reading…', async () => {
      await d.drawReady();
      const chars = await rendererFor(d.id, page).call<{ c: string; b: number[] }[]>('charsIn', [d.id, page, r]);
      let words = charsToWords(chars);
      if (words.length < 1) words = (await ocrPage(d.id, page, d.pages[page].w, d.pages[page].h, { lang: S.current.ocrLang || 'eng+ara', rect: r })).map((w) => ({ text: w.text, box: w.box }));
      return wordsToTable(words).map((row) => row.filter(Boolean).join('  ')).join('\n');
    });
    if (text == null) return;
    if (!text.trim()) { toast('No text found in that area.', 'info'); return; }
    await gcc.copyText(text);
    toast('Copied: ' + (text.length > 160 ? text.slice(0, 160) + '…' : text), 'ok', undefined, 7000);
  }

  // ---------------------------------------------------------------- keys

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (document.querySelector('.scrim')) return;
      const key = e.key.toLowerCase();
      // find a tool (Alt+Q)
      if (e.altKey && !e.ctrlKey && !e.shiftKey && key === 'q') { e.preventDefault(); (document.querySelector('.tsearch input') as HTMLInputElement | null)?.focus(); return; }
      // support: screen/layout facts to the clipboard (Ctrl+Alt+Shift+D)
      if (e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const v = document.querySelector('.viewer') as HTMLElement | null;
        const pg = document.querySelector('.pg') as HTMLElement | null;
        const R = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((x) => Math.round(x)); };
        const diag = JSON.stringify({
          version: info?.version, dpr: devicePixelRatio, screen: [screen.width, screen.height, screen.availWidth, screen.availHeight], inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight],
          viewer: v && { client: [v.clientWidth, v.clientHeight], scroll: [v.scrollLeft, v.scrollTop, v.scrollWidth, v.scrollHeight], rect: R(v) },
          page0: R(pg), zoom: doc?.view.z, fit: doc?.view.fit, pages: doc?.pages.slice(0, 2), docs: docs.length,
          body: R(document.body), html: [document.documentElement.clientWidth, document.documentElement.clientHeight],
          chain: (() => { const out: string[] = []; let el: HTMLElement | null = v; while (el && out.length < 8) { const r = el.getBoundingClientRect(); out.push(`${el.className.toString().split(' ')[0] || el.tagName}:${Math.round(r.top)}+${Math.round(r.height)}`); el = el.parentElement; } return out.join(' < '); })(),
        });
        void gcc.copyText(diag);
        toast(diag, 'info', undefined, 60000);
        return;
      }
      if (e.ctrlKey && !e.altKey) {
        if (key === 'o') { e.preventDefault(); void A.open(); return; }
        if (key === 's') { e.preventDefault(); void (e.shiftKey ? A.saveAs() : A.save()); return; }
        if (key === 'w' || key === 'f4') { e.preventDefault(); void A.close(); return; }
        if (key === 'p') { e.preventDefault(); void A.print(); return; }
        if (key === 'f') { e.preventDefault(); A.find(); return; }
        if (key === 'tab') { e.preventDefault(); const i = docs.findIndex((d) => d.id === activeId); const n = docs[(i + (e.shiftKey ? -1 : 1) + docs.length) % docs.length]; if (n) setActiveId(n.id); return; }
        // (a check box, list or colour just used - the ribbon's or the side panel's - has no undo
        // of its own: Ctrl+Z takes back the change it made; text fields keep their own undo)
        const control = t && (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && /^(checkbox|radio|range|color|button)$/i.test((t as HTMLInputElement).type)));
        if (typing && !control) return;
        if (key === 'z') { e.preventDefault(); void (e.shiftKey ? A.redo() : A.undo()); return; }
        if (key === 'y') { e.preventDefault(); void A.redo(); return; }
        if (typing) return;
        if (key === '=' || key === '+') { e.preventDefault(); A.zoomIn(); return; }
        if (key === '-') { e.preventDefault(); A.zoomOut(); return; }
        if (key === '0') { e.preventDefault(); A.fit('page'); return; }
        if (key === '1') { e.preventDefault(); A.setZoom(96 / 72); return; }
        if (key === '2') { e.preventDefault(); A.fit('width'); return; }
        return;
      }
      // next / previous search hit - also from the search box itself (where Ctrl+F leaves you)
      // (not from a text box or comment being typed in: the view jumped away from the text)
      if (e.key === 'F3' && !e.altKey && !e.metaKey && (!typing || (e.target as HTMLElement)?.closest?.('.search-in, .find-in, .search'))) { e.preventDefault(); if (hits.length) setHitIndex((i) => (i + (e.shiftKey ? hits.length - 1 : 1)) % hits.length); return; }
      if (typing || e.altKey || e.metaKey) return;
      if (e.key === 'F9') { e.preventDefault(); A.toggleSnap(); return; }
      if (e.key === 'F8') { e.preventDefault(); A.toggleOrtho(); return; }
      if (e.key === 'F6') { e.preventDefault(); A.toggleCross(); return; }
      if (e.key === 'F7') { e.preventDefault(); A.toggleLoupe(); return; }
      if (e.key === 'F4') { e.preventDefault(); A.togglePanel(); return; }
      if (e.key === 'PageDown' || e.key === 'PageUp') { /* native scrolling */ return; }
      if (e.key === 'Home' && !sel.length) { e.preventDefault(); A.goTo(0); return; }
      if (e.key === 'End' && !sel.length) { e.preventDefault(); if (doc) A.goTo(doc.pages.length - 1); return; }
      // Area / Perimeter: P, R, O pick how the shape is drawn (corners, rectangle, circle) - as
      // in the Estimation app's take-off - instead of the Pencil and Rectangle tools
      if ((tool === 'm-area' || tool === 'm-perimeter') && !e.shiftKey && (key === 'p' || key === 'r' || key === 'o')) {
        e.preventDefault();
        A.setHow(key === 'p' ? 'points' : key === 'r' ? 'rect' : 'circle');
        return;
      }
      if (e.key.length === 1 && !e.shiftKey) {
        const t2 = (Object.keys(TOOLS) as ToolId[]).find((id) => TOOLS[id].key === key);
        if (t2 && doc) { e.preventDefault(); if (t2 === 'stamp') A.stamps(); else setTool(t2); }
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  // drop PDFs on the window: files from Explorer open as tabs; pages dragged out of
  // another tab go into the open file (dropped on the page) or become a new tab
  useEffect(() => {
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    const drop = async (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      const paths = Array.from(e.dataTransfer.files).map((f) => gcc.pathOf(f)).filter((p) => /\.pdf$/i.test(p) || D.PICTURE_RE.test(p));
      const ours = paths.filter((p) => dragged.has(p));
      const ext = paths.filter((p) => !dragged.has(p));
      const target = docsRef.current.find((d) => d.id === activeRef.current) || null;
      const onPage = !!(e.target as HTMLElement | null)?.closest?.('.viewer');
      for (const p of ours) {
        const info = dragged.get(p)!;
        try {
          if (onPage && target && info.doc !== target.id) {
            const at = (viewer.current?.page() ?? target.pages.length - 1) + 1;
            await busy('Inserting pages…', async () => target.insertFrom(at, p));
            toast(`Copied ${pagesLabel(info.pages)} here, after page ${at}.`, 'ok');
          } else if (!(onPage && target && info.doc === target.id)) {
            await newFromFile(p, info.name, false);
          } else {
            // (its own pages let go on its own page - a drag out that came back: nothing changes, and that is said)
            toast(`Those pages are already in ${target.name} – to move them, drag them in the Pages panel.`, 'info');
          }
        } catch (er) { fail(er); }
      }
      if (ext.length) void openPaths(ext);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, []);

  // the pages chosen in the Pages panel stay the same pages when pages are inserted, deleted,
  // moved or undone (they are positions: Rotate went to the blank page inserted before page 4)
  const crevSeen = useRef<{ id: string; crev: number[] } | null>(null);
  useEffect(() => {
    if (!doc) { crevSeen.current = null; return; }
    const prev = crevSeen.current;
    crevSeen.current = { id: doc.id, crev: doc.crev };
    if (prev && prev.id === doc.id && prev.crev !== doc.crev) { const before = prev.crev, after = doc.crev; setPageSel((s) => followPages(s, before, after)); }
  }, [doc, doc?.crev]);

  // search hits are positions on the old pages: drop them when pages change
  useEffect(() => { setHits([]); }, [doc?.baseRev]);

  // selection only lives on the active document
  useEffect(() => {
    setSel([]); setPageSel([]); setHits([]); setToolState('select');
    // (not the last tool's instruction in the status bar)
    setStatus(TOOLS.select.hint ?? '');
    // a menu open for the last file would act on this one (its page 3, its markups)
    setMenu(null); setTabMenu(null);
    // a dialog for the last file (crop, scale, split, print...) would apply its pages to this one:
    // it goes. The window's X > "Close only this file" can close the file under its dialog
    // (files opened meanwhile wait behind it - holdFront - so this is its file being closed)
    const opened = dialogFor.current === activeId;
    dialogFor.current = null;
    setDialog((x) => (!opened && forTheFile(x) && !(x!.k === 'export' && exportRunning.docId) ? null : x));
  }, [activeId]);
  // a dialog opening closes a right-click menu (the menu is drawn above dialogs)
  useEffect(() => { if (dialog) { setMenu(null); setTabMenu(null); } }, [dialog]);
  // the tab's right-click menu: Escape closes it
  useEffect(() => {
    if (!tabMenu) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setTabMenu(null); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [tabMenu]);

  // ---------------------------------------------------------------- tab strip: drag, fit, list

  const tabsBox = useRef<HTMLDivElement | null>(null);
  const tabPtr = useRef<{ id: string; x0: number; y0: number; on: boolean; hover: number } | null>(null);
  const [tabsHidden, setTabsHidden] = useState(0);
  /** past the strip (above or below it by more than a tab's height, or out of the window) */
  const outOfStrip = (x: number, y: number) => {
    const r = tabsBox.current?.getBoundingClientRect();
    return !r || y < r.top - 34 || y > r.bottom + 34 || x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight;
  };
  function tabDown(e: React.PointerEvent, d: PdfDoc) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.x')) return;
    tabPtr.current = { id: d.id, x0: e.clientX, y0: e.clientY, on: false, hover: 0 };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* fine */ }
  }
  function tabMove(e: React.PointerEvent) {
    const t = tabPtr.current;
    if (!t) return;
    if (!t.on && Math.hypot(e.clientX - t.x0, e.clientY - t.y0) < 6) return;
    t.on = true;
    const out = outOfStrip(e.clientX, e.clientY);
    if (!out && stripRef.current) {
      // the place in the row: after every other tab whose middle is left of the pointer
      const ds = docsRef.current;
      const from = ds.findIndex((x) => x.id === t.id);
      const others = [...stripRef.current.querySelectorAll<HTMLElement>('.dtab')].filter((el) => el.dataset.id !== t.id);
      const to = others.filter((el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2 < e.clientX; }).length;
      if (from >= 0 && to !== from) { const next = ds.slice(); const [m] = next.splice(from, 1); next.splice(to, 0, m); docsRef.current = next; setDocs(next); }
      if (t.hover) { t.hover = 0; gcc.tabHover(null, null); }
    } else if (out && Date.now() - t.hover > 120) {
      t.hover = Date.now();
      gcc.tabHover(e.screenX, e.screenY);
    }
    setTabDrag({ id: t.id, x: e.clientX, y: e.clientY, out });
  }
  async function tabUp(e: React.PointerEvent, d: PdfDoc) {
    const t = tabPtr.current;
    tabPtr.current = null;
    if (!t || !t.on) return;
    setTabDrag(null);
    if (t.hover) gcc.tabHover(null, null);
    if (!outOfStrip(e.clientX, e.clientY)) return;
    const target = await gcc.tabTarget(e.screenX, e.screenY);
    await moveTab(d, target, e.screenX, e.screenY);
  }
  // where the strip is (another window's tab dropped here is found by it); how many tabs don't fit
  useEffect(() => {
    const el = tabsBox.current, sc = stripRef.current;
    if (!el || !sc) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      gcc.tabStrip({ x: r.left, y: r.top, w: r.width, h: r.height });
      const box = sc.getBoundingClientRect();
      setTabsHidden([...sc.querySelectorAll<HTMLElement>('.dtab')].filter((t) => { const b = t.getBoundingClientRect(); return b.right > box.right + 2 || b.left < box.left - 2; }).length);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    ro.observe(sc);
    window.addEventListener('resize', report);
    sc.addEventListener('scroll', report);
    return () => { ro.disconnect(); window.removeEventListener('resize', report); sc.removeEventListener('scroll', report); };
  }, [docs.length, ready]);
  // the files open here (for files opened from Explorer that are open in some window already)
  const pathsKey = docs.map((d) => d.path || '').join('|');
  /** the start all tab names share (a set of drawings): not shown on the tabs */
  const tabSkip = useMemo(() => sharedStart(docs.map((d) => d.name)), [docs.map((d) => d.name).join('\u0000')]);
  useEffect(() => { gcc.tabPaths(docs.map((d) => d.path).filter((x): x is string => !!x)); }, [pathsKey]);
  // the file shown is always in view on the strip
  useEffect(() => { stripRef.current?.querySelector<HTMLElement>('.dtab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [activeId, docs.length]);
  // the list of open files: Escape closes it
  useEffect(() => {
    if (!tabList) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setTabList(false); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [tabList]);

  // ---------------------------------------------------------------- render

  if (fatal) return <div className="fatal"><h2>{APP_NAME} could not start</h2><p>{fatal}</p></div>;

  const snapOn = settings.snap ?? true;
  const curScale = doc?.scaleAt(pageNo) ?? null;
  const resolved = resolveTheme(themeMode);

  // ---------------------------------------------------------------- find a tool
  const extraCmds: ExtraCmd[] = [
    { label: 'Pages', where: 'Left panel', title: 'Thumbnails of the pages: select, drag to reorder, rotate, delete', icon: 'thumbs', disabled: !doc, run: () => setSide('pages') },
    { label: 'Stamp from page', where: 'Comment > Stamp', title: 'Drag a box round a stamp on a scanned page: it is cleaned up (paper removed, straightened) and saved as one of your stamps', icon: 'stamp', disabled: !doc, run: () => setTool('stamp-grab') },
    { label: 'Bookmarks', where: 'Left panel', title: "The file's bookmarks (table of contents)", icon: 'bookmark', disabled: !doc, run: () => setSide('bookmarks') },
    { label: 'Comments list', where: 'Left panel', title: 'Every markup: group, filter, jump to it, replies, status, export to Excel', icon: 'comments', disabled: !doc, run: () => setSide('comments') },
    { label: 'Search text', where: 'Left panel', title: 'Find words in this file (Ctrl+F)', icon: 'search', disabled: !doc, run: () => A.find() },
    { label: 'Report a problem', where: 'File tab', title: 'Tell us what went wrong: saved to the reports folder for fixing', icon: 'report', run: () => void A.report() },
    { label: "What's new", where: 'File tab', title: 'What changed in this version, in short', icon: 'info', run: () => A.whatsNew() },
    { label: 'Undo', where: 'Title bar', title: 'Undo (Ctrl+Z)', icon: 'undo', disabled: !doc?.canUndo, run: () => void A.undo() },
    { label: 'Redo', where: 'Title bar', title: 'Redo (Ctrl+Y)', icon: 'redo', disabled: !doc?.canRedo, run: () => void A.redo() },
    { label: resolved === 'dark' ? 'Light theme' : 'Dark theme', where: 'Title bar', title: 'Light or dark colours', icon: resolved === 'dark' ? 'sun' : 'moon', run: () => { const m = resolved === 'dark' ? 'light' : 'dark'; setThemeMode(m); saveSettings({ theme: m }); } },
  ];
  /** a tool picked in "Find a tool": its tab comes up, the button is pointed out, and it runs */
  const runFound = (c: FoundCmd) => {
    // (why it can't be used now: "open a file first" was said even with a file open)
    const why = doc ? "can't be used right now (it needs something selected, or more pages, or there is nothing to do)" : 'open a file first';
    if (c.kind === 'extra') { if (c.disabled) toast(`${c.label} – ${why}.`, 'info'); else c.run(); return; }
    setRtab(c.tab);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const rib = document.querySelector('.ribbon');
      let el: HTMLElement | null = null;
      if (rib) {
        if (c.tool) el = rib.querySelector(`[data-tool="${c.tool}"]`);
        else if (c.check) el = ([...rib.querySelectorAll('label.rchk')] as HTMLElement[]).find((l) => l.textContent?.trim() === c.label) || null;
        else el = rib.querySelector(`[data-cmd="${CSS.escape(c.label)}"]`);
      }
      if (el) {
        const e2 = el;
        e2.classList.remove('found');
        void e2.offsetWidth;
        e2.classList.add('found');
        window.setTimeout(() => e2.classList.remove('found'), 1800);
      }
      if (c.disabled) { toast(`${c.label.replace(/…$/, '')} is on ${TAB_NAMES[c.tab]}${c.group ? ' › ' + c.group : ''} – ${why}.`, 'info'); return; }
      if (c.tool) setTool(c.tool);
      else if (c.check) (el?.querySelector('input') as HTMLInputElement | null)?.click();
      else el?.click();
    }));
  };

  return (
    <div className="app" onPointerDown={() => { if (menu) setMenu(null); if (tabMenu) setTabMenu(null); if (tabList) setTabList(false); }}>
      <div className="frame-top">
        <div className="topbar">
          <div className="brand"><img src="./gmark.svg" alt="" /><span className="word"><b>{WORD_LEAD}</b>{WORD_REST}</span></div>
          <div className="quick">
            <button className="tb-btn" title="Open (Ctrl+O)" onClick={() => void A.open()}><Ico n="open" size={18} /></button>
            <button className="tb-btn" title="Save (Ctrl+S)" disabled={!doc} onClick={() => void A.save()}><Ico n="save" size={18} /></button>
            {/* (Undo keeps the keyboard where it is: a text box being typed in is still open when the
                click comes, so the Undo is the box's own - see PdfDoc.undoTyping) */}
            <button className="tb-btn" title={doc?.canUndo ? 'Undo ' + doc.undoName.toLowerCase() + ' (Ctrl+Z)' : 'Undo (Ctrl+Z)'} disabled={!doc?.canUndo} onMouseDown={(e) => e.preventDefault()} onClick={() => void A.undo()}><Ico n="undo" size={18} /></button>
            <button className="tb-btn" title={doc?.canRedo ? 'Redo ' + doc.redoName.toLowerCase() + ' (Ctrl+Y)' : 'Redo (Ctrl+Y)'} disabled={!doc?.canRedo} onClick={() => void A.redo()}><Ico n="redo" size={18} /></button>
          </div>
          <div className="crumb">{doc && <span className="pname">{doc.name}{doc.dirty ? ' •' : ''}</span>}{doc?.readOnly && <span className="ro-badge">Read-only</span>}</div>
          <div className="spacer" />
          <ToolSearch commands={ribbonCmds} extras={extraCmds} onRun={runFound} hasDoc={!!doc} />
          <button className="tb-btn" title={resolved === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => { const m = resolved === 'dark' ? 'light' : 'dark'; setThemeMode(m); saveSettings({ theme: m }); }}><Ico n={resolved === 'dark' ? 'sun' : 'moon'} size={18} /></button>
          <button className="tb-btn" title="Settings" onClick={() => A.settings()}><Ico n="gear" size={18} /></button>
        </div>
        <div className="rtabs">
          {(['file', 'home', 'comment', 'measure', 'edit', 'organize', 'protect', 'ocr', 'ai', 'batch'] as RibbonTab[]).map((t) => (
            <button key={t} className={'rtab' + (rtab === t ? ' on' : '') + (t === 'file' ? ' file' : '')} onClick={() => setRtab(t)}>{{ file: 'File', home: 'Home', comment: 'Comment', measure: 'Measure', edit: 'Edit', organize: 'Organize', protect: 'Protect', ocr: 'OCR', ai: 'AI', batch: 'Batch' }[t]}</button>
          ))}
        </div>
      </div>
      <Ribbon
        tab={rtab} setTab={setRtab} doc={doc} tool={tool} style={style} A={A as unknown as Actions}
        setToolStyle={(p) => setToolStyle(tool, p)} settings={settings} saveSettings={saveSettings}
        zoom={zoom} countGroup={countGroup} setCountGroup={setCountGroup} recent={settings.recent || []} sel={sel} selItems={selItems} editSel={editSel}
        commands={ribbonCmds}
      />
      <div className={'dtabs' + (dropHere ? ' drop-here' : '')} ref={tabsBox}>
        <div className="dtabs-scroll" ref={stripRef} onWheel={(e) => { const el = stripRef.current; if (el && e.deltaY && el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY; }}>
        {docs.map((d) => (
          <div key={d.id} data-id={d.id} className={'dtab' + (d.id === activeId ? ' on' : '') + (dragTab === d.id ? ' dragover' : '') + (tabDrag?.id === d.id ? ' dragging' : '')} onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); void closeDoc(d); } else if (e.button === 0) setActiveId(d.id); }} title={d.path || d.name}
            onPointerDown={(e) => tabDown(e, d)} onPointerMove={tabMove} onPointerUp={(e) => void tabUp(e, d)} onPointerCancel={() => { tabPtr.current = null; setTabDrag(null); gcc.tabHover(null, null); }}
            onLostPointerCapture={() => { if (tabPtr.current && !tabPtr.current.on) tabPtr.current = null; }}
            onContextMenu={(e) => { e.preventDefault(); setTabMenu({ x: e.clientX, y: e.clientY, id: d.id }); }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return;
              e.preventDefault();
              if (dragTab !== d.id) {
                setDragTab(d.id);
                window.clearTimeout(tabHover.current);
                // hovering a tab with pages: switch to it, so they can be dropped where wanted
                tabHover.current = window.setTimeout(() => setActiveId(d.id), 450);
              }
            }}
            onDragLeave={() => { window.clearTimeout(tabHover.current); setDragTab(null); }}
            onDrop={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              window.clearTimeout(tabHover.current);
              setDragTab(null);
              const paths = Array.from(e.dataTransfer.files).map((f) => gcc.pathOf(f)).filter((p) => /\.pdf$/i.test(p));
              for (const p of paths) {
                try {
                  // dropped on the tab itself: at the end of that file (its own pages: moved there)
                  const info = dragged.get(p);
                  const own = info?.doc === d.id;
                  const last = own && info!.pages.every((pg, k) => pg === d.pages.length - info!.pages.length + k);
                  if (await dropPages(d, p, d.pages.length, (pg, to) => movePagesIn(d, pg, to))) {
                    const what = pagesLabel(info!.pages);
                    toast(own ? (last ? `${what[0].toUpperCase() + what.slice(1)} ${info!.pages.length > 1 ? 'are' : 'is'} already at the end of ${d.name}.` : `Moved ${what} to the end of ${d.name}.`) : `Added ${what} at the end of ${d.name}.`, own && last ? 'info' : 'ok');
                  } else await busy('Inserting…', () => d.insertFrom(d.pages.length, p));
                } catch (er) { fail(er); }
              }
            }}>
            <Ico n="file" size={15} className="dtab-ic" />
            <TabName name={d.name} skip={tabSkip} />
            {d.dirty && <span className="dirty" title="Unsaved changes" />}
            <button className="x" title="Close (Ctrl+W)" onMouseDown={(e) => { e.stopPropagation(); }} onClick={(e) => { e.stopPropagation(); void closeDoc(d); }}><Ico n="close" size={13} /></button>
          </div>
        ))}
        <button className="dtab-add" title="Open a PDF (Ctrl+O)" onClick={() => void A.open()}><Ico n="plus" size={15} /></button>
        </div>
        {docs.length > 1 && (
          <button className={'dtab-list' + (tabList ? ' on' : '')} title={`All open files (${docs.length})`} onPointerDown={(e) => e.stopPropagation()} onClick={() => setTabList((v) => !v)}>
            <Ico n="chev" size={14} />{tabsHidden > 0 && <span className="n">{docs.length}</span>}
          </button>
        )}
      </div>
      {tabList && docs.length > 1 && (
        <div className="cmenu tablist" ref={(el) => { el?.querySelector<HTMLElement>('button.on')?.scrollIntoView({ block: 'nearest' }); }} style={{ top: (tabsBox.current?.getBoundingClientRect().bottom ?? 120) + 2, right: 10 }} onPointerDown={(e) => e.stopPropagation()}>
          {docs.map((d) => (
            <button key={d.id} className={d.id === activeId ? 'on' : ''} title={d.path || d.name} onClick={() => { setActiveId(d.id); setTabList(false); }}>
              <Ico n="file" size={14} /><span className="nm" dir="auto">{d.name}</span>{d.dirty && <span className="dirty" title="Unsaved changes" />}
            </button>
          ))}
        </div>
      )}
      {tabDrag?.out && (() => {
        const d = docs.find((x) => x.id === tabDrag.id);
        return d ? <div className="tab-ghost" style={{ left: tabDrag.x + 10, top: tabDrag.y + 12 }}><Ico n="file" size={14} /><div><div className="nm" dir="auto">{d.name}</div><div className="hint">{docs.length > 1 ? 'Let go: a window of its own – or onto another window\'s tabs' : 'Let go onto another window\'s tabs'}</div></div></div> : null;
      })()}
      <div className="work">
        <div className="sheet">
          {doc ? (
            <div className="workarea">
              <div className="rail">
                {([['pages', 'thumbs', 'Pages'], ['bookmarks', 'bookmark', 'Bookmarks'], ['comments', 'comments', 'Comments list'], ['totals', 'count', 'Counts & totals'], ['search', 'search', 'Search (Ctrl+F)']] as [SideKind, string, string][]).map(([k, ic, t]) => (
                  <button key={k} className={'rail-btn' + (side === k ? ' on' : '')} title={t} onClick={() => setSide(side === k ? null : k)}><Ico n={ic} /></button>
                ))}
              </div>
              {side && (
                <SidePanel
                  kind={side} doc={doc} docs={docs} rev={ver} page={pageNo} pageSel={pageSel} setPageSel={setPageSel}
                  goTo={A.goTo} sel={sel} setSel={setSel} A={A as unknown as Actions}
                  hits={hits} setHits={setHits} hitIndex={hitIndex} setHitIndex={setHitIndex}
                  onClose={() => setSide(null)} toast={toast}
                />
              )}
              <div className="center">
                <Viewer
                  key={doc.id} doc={doc} rev={ver} tool={tool} setTool={setTool} style={style} place={place}
                  countGroup={countGroup} snapOn={snapOn} orthoOn={!!settings.ortho} crossOn={!!settings.cross} loupeOn={!!settings.loupe} loupeZoom={settings.loupeZoom ?? 3} wheelZoom={!!settings.wheelZoom} keepTool={!!settings.keepTool || ['highlight', 'underline', 'strike', 'squiggly', 'pencil', 'm-count', 'redact-area', 'redact-text', 'area-highlight', 'm-length', 'm-polylength', 'm-area', 'm-rectarea', 'm-perimeter', 'm-angle', 'edit-text'].includes(tool)}
                  sel={sel} setSel={setSel} hits={hits} hitIndex={hitIndex} onEvent={(e) => void onViewerEvent(e)} apiRef={viewer} readOnly={false}
                  how={settings.measureHow || 'points'}
                />
                {(tool === 'm-area' || tool === 'm-perimeter') && <HowBar how={settings.measureHow || 'points'} set={A.setHow} />}
              </div>
              {aiOpen ? (
                <AiPanel doc={doc} page={pageNo} pageSel={pageSel} goTo={(p) => A.goTo(p)} tab={aiTab} setTab={setAiTab} settings={settings} saveSettings={saveSettings} toast={toast}
                  openFile={(f, n) => (/[\\/]PDF Editor[\\/]work[\\/]/.test(f) ? newFromFile(f, n) : openPaths([f]))} onClose={() => setAiOpen(false)} onKeys={() => setDialog({ k: 'ai-keys' })} />
              ) : settings.propsPanel !== false && (
                <PropsPanel key={doc.id} how={settings.measureHow || 'points'} doc={doc} rev={ver} sel={sel} setSel={setSel} tool={tool} style={style} setToolStyle={(p) => setToolStyle(tool, p)} A={A as unknown as Actions} focusComment={commentFocus} onClose={() => saveSettings({ propsPanel: false })} toast={toast} author={settings.author || info?.user || ''} />
              )}
            </div>
          ) : (
            <Start ready={ready} recent={settings.recent || []} recovery={recovery} A={A as unknown as Actions} onRestore={async (r) => {
              // (a busy note while it opens; a second click doesn't restore it twice; a failure is said)
              if (await busy('Restoring ' + r.name + '…', () => restoreRec(r), 'restore:' + r.key)) toast('Restored your unsaved work – save it to keep it.', 'ok');
            }} onDiscard={async (r) => { await gcc.recoveryClear(r.key); setRecovery((x) => x.filter((y) => y.key !== r.key)); }} />
          )}
        </div>
      </div>
      <div className="statusbar">
        {doc ? (
          <>
            <span className="s">
              <PageBox page={pageNo} count={doc.pages.length} label={doc.pages[pageNo]?.label} labelOf={(i) => doc.pages[i]?.label} onGo={(p) => A.goTo(p)} />
            </span>
            <span className="s">
              <button className="sb-btn" onClick={() => A.zoomOut()} title="Zoom out (Ctrl -)">−</button>
              <ZoomBox z={zoom} onSet={(z) => A.setZoom(z)} />
              <button className="sb-btn" onClick={() => A.zoomIn()} title="Zoom in (Ctrl +)">+</button>
              <button className="sb-btn" onClick={() => A.fit('width')} title="Fit width (Ctrl+2)"><Ico n="fitw" size={14} /></button>
              <button className="sb-btn" onClick={() => A.fit('page')} title="Fit page (Ctrl+0)"><Ico n="fitp" size={14} /></button>
            </span>
            <span className="s"><button className={'sb-btn' + (curScale ? ' set' : '')} title="Scale of this page – click to change" onClick={() => A.scale()}>Scale: {curScale ? scaleText(curScale) : 'not set'}</button></span>
            <span className="s"><button className={'sb-btn' + (snapOn ? ' set' : '')} title="Snap to line ends, middles and markup corners (F9). Hold Ctrl to skip snapping for one click." onClick={() => A.toggleSnap()}><Ico n="magnet" size={14} /> Snap {snapOn ? 'on' : 'off'}</button></span>
            <span className="s"><button className={'sb-btn' + (settings.ortho ? ' set' : '')} title="Ortho (F8): lines and corners go straight - 0, 45 or 90° - without holding Shift" onClick={() => A.toggleOrtho()}><Ico n="ortho" size={14} /> Ortho {settings.ortho ? 'on' : 'off'}</button></span>
            <span className="s grow st">{status}</span>
            <span className="s">{doc.dirty ? 'Unsaved changes' : doc.path ? 'Saved' : ''}</span>
          </>
        ) : (
          <span className="s">{APP_NAME} {info?.version}</span>
        )}
      </div>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={'toast ' + (t.kind || '')}>
            <span className="bar" style={{ background: t.kind === 'err' ? 'var(--danger)' : t.kind === 'ok' ? 'var(--ok)' : 'var(--gold-300)' }} />
            {t.kind === 'busy' && <span className="dot busy" />}
            <span className="grow">{t.text}</span>
            {/* (not while a dialog is open: "Set scale", "Open"… would replace it and what was typed in it) */}
            {t.action && <button className="tbtn" disabled={!!dialog} title={dialog ? 'Close the dialog first' : undefined} onClick={() => { t.action!.run(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>{t.action.label}</button>}
            {t.kind !== 'busy' && <button className="tbtn" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>×</button>}
          </div>
        ))}
        <UpdateCard u={upd} updated={updated} onDone={() => setUpdated(null)} />
      </div>
      {tabMenu && (() => {
        const ds = docs;
        const i = ds.findIndex((x) => x.id === tabMenu.id);
        const d = ds[i];
        if (!d) return null;
        const item = (label: string, run: () => unknown, dis = false) => <button disabled={dis} onClick={() => { setTabMenu(null); void run(); }}>{label}</button>;
        return (
          <div className="cmenu" style={{ left: Math.min(tabMenu.x, window.innerWidth - 230), top: tabMenu.y }} onPointerDown={(e) => e.stopPropagation()}>
            {item('Close', () => closeDoc(d))}
            {item('Close others', () => closeMany(ds.filter((x) => x !== d)), ds.length < 2)}
            {item('Close tabs to the right', () => closeMany(ds.slice(i + 1)), i >= ds.length - 1)}
            {item('Close all', () => closeMany([...ds]))}
            <div className="sep" />
            {item('Move to a new window', () => moveTab(d, null, window.screenX + 60, window.screenY + 60), ds.length < 2)}
            <div className="sep" />
            {item('Show in folder', async () => { if (d.path && !(await gcc.showInFolder(d.path))) toast('Not shown: open the file again from File > Open to show its folder.', 'err'); }, !d.path)}
            {item('Copy file path', () => d.path && gcc.copyText(d.path).then(() => toast('Path copied.', 'ok')), !d.path)}
          </div>
        );
      })()}
      {menu && doc && <ContextMenu m={menu} doc={doc} sel={sel} A={A as unknown as Actions} close={() => setMenu(null)} setSel={setSel} viewer={viewer} toast={toast} setTool={setTool} />}
      {dialog && (
        <D.Dialogs
          // (a dialog closing itself closes only itself: a job it started - OCR after its X, an
          // insert, a merge - can end after another dialog came up in its place: a password
          // prompt or Combine's files waiting for it to close. They were closed with it, unseen)
          dialog={dialog} setDialog={(d) => { const mine = dialog; setDialog(d ?? ((cur) => (cur === mine ? null : cur))); }} doc={doc} docs={docs} settings={settings} saveSettings={saveSettings}
          A={A as unknown as Actions} toast={toast} busy={(l, f) => busy(l, f, true)} fail={fail} passwordEntered={passwordEntered} author={settings.author || info?.user || ''}
          useStamp={useStamp} useSignature={useSignature} newFromFile={newFromFile} info={info}
          pageSel={pageSel}
        />
      )}
    </div>
  );
}

/** short stable hash for cache file names */
function fingerprint(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519); }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

export type AppActions = ReturnType<typeof makeTypeHelper>;
function makeTypeHelper() { return {} as Record<string, (...a: any[]) => any>; }

/**
 * The page box. A file with page labels (i, ii, 1, 2…) shows the label; what is typed is read the
 * same way: a page's label first ("2" is the page labelled 2, "iii" the one labelled iii), else the
 * page at that place (5 = the 5th page). It used to show "2" and take a typed 2 as the 2nd page
 * (labelled ii), ignore labels typed in, and change to the place number on a click.
 */
export function pageFromTyped(t: string, count: number, labelOf: (i: number) => string | undefined): number | null {
  const v = t.trim();
  if (!v) return null;
  const low = v.toLowerCase();
  for (let i = 0; i < count; i++) { const l = labelOf(i); if (l != null && l.trim().toLowerCase() === low) return i; }
  if (!/^\d+$/.test(v)) return null;
  const n = parseInt(v, 10);
  return n >= 1 && n <= count ? n - 1 : null;
}
function PageBox({ page, count, label, labelOf, onGo }: { page: number; count: number; label?: string; labelOf(i: number): string | undefined; onGo(p: number): void }) {
  const [v, setV] = useState('');
  const [edit, setEdit] = useState(false);
  const shown = label && label !== String(page + 1) ? label : String(page + 1);
  return (
    <span className="pagebox" title={shown !== String(page + 1) ? `Page ${page + 1} of ${count} (labelled ${shown})` : undefined}>
      Page
      <input className="pb-in" value={edit ? v : shown} onFocus={(e) => { setEdit(true); setV(shown); requestAnimationFrame(() => e.target.select()); }} onBlur={() => setEdit(false)} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { const n = pageFromTyped(v, count, labelOf); if (n != null) onGo(n); (e.target as HTMLInputElement).blur(); } }} />
      of {count}
    </span>
  );
}

function ZoomBox({ z, onSet }: { z: number; onSet(z: number): void }) {
  const pct = Math.round((z * 72 / 96) * 100);
  const [v, setV] = useState('');
  const [edit, setEdit] = useState(false);
  return <input className="zb-in" value={edit ? v : pct + '%'} onFocus={(e) => { setEdit(true); setV(String(pct)); requestAnimationFrame(() => e.target.select()); }} onBlur={() => setEdit(false)} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { const n = parseFloat(v); if (n > 0) onSet((n / 100) * 96 / 72); (e.target as HTMLInputElement).blur(); } }} title="Zoom" />;
}

function Start({ ready, recent, recovery, A, onRestore, onDiscard }: { ready: boolean; recent: string[]; recovery: Recovery[]; A: Record<string, any>; onRestore(r: Recovery): void; onDiscard(r: Recovery): void }) {
  return (
    <div className="start">
      <div className="start-inner">
        <div className="start-hero">
          <img src="./gmark.svg" alt="" />
          <div>
            <h1><b>{WORD_LEAD}</b>{WORD_REST}</h1>
            <p>Open a PDF, or drop files here. Several files open side by side in tabs.</p>
          </div>
        </div>
        {recovery.length > 0 && (
          <div className="recover">
            <h3>Unsaved work from last time</h3>
            {recovery.map((r) => (
              <div key={r.key} className="rec-row">
                <Ico n="file" />
                <span className="grow"><b>{r.name}</b><span className="faint"> · {new Date(r.time).toLocaleString('en-GB')}</span></span>
                <button className="btn sm primary" onClick={() => onRestore(r)}>Restore</button>
                <button className="btn sm ghost" onClick={() => onDiscard(r)}>Discard</button>
              </div>
            ))}
          </div>
        )}
        <div className="start-actions">
          <button className="bigbtn" disabled={!ready} onClick={() => A.open()}><Ico n="open" size={26} /><span>Open PDF<small>Ctrl+O</small></span></button>
          <button className="bigbtn" disabled={!ready} onClick={() => A.merge()}><Ico n="merge" size={26} /><span>Combine files<small>Merge several PDFs into one</small></span></button>
          <button className="bigbtn" disabled={!ready} onClick={() => A.compress()}><Ico n="compress" size={26} /><span>Reduce file size<small>Shrink heavy PDFs</small></span></button>
          <button className="bigbtn" disabled={!ready} onClick={() => A.marks(true)}><Ico n="stamp" size={26} /><span>Stamp & number files<small>Headers, page numbers, Bates, stamps</small></span></button>
          <button className="bigbtn" disabled={!ready} onClick={() => A.batchOcr()}><Ico n="ocr" size={26} /><span>Make scans searchable<small>OCR, English + Arabic</small></span></button>
        </div>
        {recent.length > 0 && (
          <div className="recent">
            <h3>Recent files</h3>
            {recent.map((p) => (
              <button key={p} className="rec-file" onClick={() => A.openPaths([p])} title={p}>
                <Ico n="file" size={18} /><span className="nm">{baseName(p)}</span><span className="pt">{dirName(p)}</span>
              </button>
            ))}
          </div>
        )}
        {!ready && <p className="faint">Starting the PDF engines…</p>}
      </div>
    </div>
  );
}

function ContextMenu({ m, doc, sel, A, close, setSel, viewer, toast, setTool }: { m: { x: number; y: number; page: number; at: Pt; text: string | null }; doc: PdfDoc; sel: SelItem[]; A: Record<string, any>; close(): void; setSel(s: SelItem[]): void; viewer: React.MutableRefObject<ViewerApi | null>; toast: (t: string, k?: Toast['kind']) => void; setTool(t: ToolId): void }) {
  const [list, setList] = useState<AnnotData[]>([]);
  // (only the pages of the selection - reading every page of a long file made the menu's Lock /
  // Rotate / Edit come a second late)
  useEffect(() => {
    let live = true;
    void Promise.all([...new Set(sel.map((s) => s.page))].map((pg) => doc.annots(pg)))
      .then((lists) => { if (live) setList(lists.flat().filter((a) => sel.some((s) => s.id === a.id && s.page === a.page))); })
      .catch(() => { /* the menu shows the plain choices */ });
    return () => { live = false; };
  }, [sel]);
  const locked = list.length > 0 && list.every((a) => a.locked);
  const item = (label: string, run: () => unknown, dis = false, key?: string) => <button disabled={dis} onClick={() => { close(); void Promise.resolve().then(run).catch((e) => toast(String((e as Error)?.message || e), 'err')); }}>{label}{key && <span className="k">{key}</span>}</button>;
  const rotatable = list.length === 1 && ['FreeText', 'Stamp', 'Square', 'Circle'].includes(list[0].type) && !list[0].callout?.length;
  const style: React.CSSProperties = { left: Math.min(m.x, window.innerWidth - 230), top: Math.min(m.y, window.innerHeight - 330) };
  // Escape closes it (before the page's own Escape: that would also drop the selection)
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  return (
    <div className="cmenu" style={style} onPointerDown={(e) => e.stopPropagation()}>
      {m.text && <>
        {item('Copy text', () => gcc.copyText(m.text!), false, 'Ctrl+C')}
        {item('Highlight', () => setTool('highlight'))}
        <div className="sep" />
      </>}
      {sel.length > 0 ? <>
        {/* corners of an outline / a line by corners: where the right-click was */}
        {list.length === 1 && !locked && (() => {
          const c = viewer.current?.corners(m.page, list[0].id, m.at);
          if (!c || !c.editable) return null;
          return <>
            {c.corner >= 0 ? item('Delete this corner', () => viewer.current?.deleteCorner(m.page, list[0].id, c.corner), !c.canDelete, 'Alt+click') : item('Add a corner here', () => viewer.current?.addCorner(m.page, list[0].id, m.at))}
            {c.open && item('Continue this line', () => viewer.current?.continueLine(m.page, list[0].id, m.at))}
            {c.corner >= 0 && c.canContinueFrom && item('Continue from this corner', () => viewer.current?.continueLine(m.page, list[0].id, m.at, c.corner))}
            <div className="sep" />
          </>;
        })()}
        {item('Copy', () => viewer.current?.copyMarkups(false), false, 'Ctrl+C')}
        {item('Cut', () => viewer.current?.copyMarkups(true), locked, 'Ctrl+X')}
        {item('Duplicate', () => viewer.current?.duplicate(), false, 'Ctrl+D')}
        {doc.pages.length > 1 && item('Copy to other pages…', () => A.copyToPages())}
        <div className="sep" />
        {item(locked ? 'Unlock' : 'Lock', () => doc.update(sel.map((s) => ({ ...s, patch: { locked: !locked } })), locked ? 'Unlock' : 'Lock'))}
        {rotatable && item('Rotate 90° right', () => doc.update([{ ...sel[0], patch: { angle: ((list[0].angle || 0) + 90) % 360 } }], 'Rotate'))}
        {rotatable && item('Rotate 90° left', () => doc.update([{ ...sel[0], patch: { angle: ((list[0].angle || 0) + 270) % 360 } }], 'Rotate'))}
        {list.length === 1 && list[0].type === 'FreeText' && item('Edit text', () => viewer.current?.editAnnot(list[0].page, list[0].id), locked)}
        {item('Flatten', () => A.flatten('selected'))}
        <div className="sep" />
        {item('Delete', async () => { const n = await doc.remove(sel); if (n < sel.length) toast('Locked markups were not deleted.', 'info'); setSel([]); }, locked, 'Del')}
      </> : <>
        {markClip.cur && item('Paste markups here', () => viewer.current?.pasteMarkups({ page: m.page, p: m.at }))}
        {item('Paste picture', async () => {
          const png = await gcc.pasteImage();
          if (!png) { toast('There is no picture on the clipboard.', 'info'); return; }
          const bmp = await createImageBitmap(new Blob([png as unknown as BlobPart]));
          const k = Math.min(1, 300 / Math.max(bmp.width, bmp.height));
          const w = bmp.width * k * 0.75, h = bmp.height * k * 0.75;
          await doc.create(m.page, { type: 'Stamp', image: png, rect: [m.at[0], m.at[1], m.at[0] + w, m.at[1] + h], kind: 'image', subject: 'Picture' });
        })}
        {item('Add comment here', async () => { const a = await doc.create(m.page, { type: 'Text', rect: [m.at[0], m.at[1], m.at[0] + 20, m.at[1] + 20], icon: 'Comment', color: [1, 0.9, 0.15], contents: '' }); setSel([{ page: m.page, id: a.id }]); })}
        <div className="sep" />
        {item('Rotate page right', () => doc.rotate([m.page], 90))}
        {item('Rotate page left', () => doc.rotate([m.page], 270))}
        {item('Zoom to fit page', () => viewer.current?.fit('page'))}
      </>}
    </div>
  );
}

export { type Scale };
// helpers used by dialogs
export const scaleFromCalibration = (a: Pt, b: Pt, real: number, unit: string): Scale => {
  const m = unit === 'mm' ? real / 1000 : unit === 'cm' ? real / 100 : unit === 'ft' ? real * 0.3048 : unit === 'in' ? real * 0.0254 : real;
  const k = m / Math.max(1e-9, dist(a, b));
  const ratio = k / PT_M;
  return { k, label: `Calibrated (≈1:${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)})`, imperial: unit === 'ft' || unit === 'in' };
};
export { STANDARD_SCALES, fmtLen };

/** a tab's file name: when it doesn't fit, the middle goes ("Spec sec…n 07.pdf") - names that
 *  start alike stay told apart. `skip`: the start every open tab's name shares ("P04-24-ARC-DWG-"
 *  of a set of drawings) - left out, so the part that differs shows ("…1001 Rev C.pdf"; every tab
 *  of a set read "P04-24-ARC…ev C.pdf") */
/** how much of the start every name shares, ended where a word / part ends (a space, - _ . or a
 *  digit-to-letter change is not looked for: only separators) - 0 when under 8 characters or for
 *  one tab; at least 6 characters of each name are left */
export function sharedStart(names: string[]): number {
  if (names.length < 2) return 0;
  let n = names.reduce((m, x) => Math.min(m, x.length), Infinity);
  for (const x of names) { let i = 0; while (i < n && x[i].toLowerCase() === names[0][i].toLowerCase()) i++; n = i; }
  // back to just after a separator, so no word is cut
  while (n > 0 && !/[\s\-_.,]/.test(names[0][n - 1])) n--;
  if (n < 8 || names.some((x) => x.length - n < 6)) return 0;
  return n;
}

function TabName({ name, skip = 0 }: { name: string; skip?: number }) {
  if (skip > 0 && name.length > skip) name = '…' + name.slice(skip);
  if (name.length <= 16) return <span className="nm" dir="auto">{name}</span>;
  const k = /\.pdf$/i.test(name) ? 8 : 6;
  return <span className="nm split" dir="auto"><span className="h">{name.slice(0, -k)}</span><span className="t">{name.slice(-k)}</span></span>;
}

/** Area / Perimeter: how the shape is drawn - a strip at the foot of the page (as in the
 *  Estimation app's take-off). Keys P, R, O. */
function HowBar({ how, set }: { how: MeasureHow; set(h: MeasureHow): void }) {
  const items: [MeasureHow, string, string, string][] = [['points', 'Corners', 'P', 'Click each corner'], ['rect', 'Rectangle', 'R', 'Two opposite corners (Shift: a square)'], ['circle', 'Circle', 'O', 'The middle, then the edge']];
  return (
    <div className="howbar" role="radiogroup" aria-label="How the shape is drawn" onMouseDown={(e) => e.preventDefault()}>
      <span className="howbar-l">Draw as</span>
      {items.map(([h, label, key, title]) => (
        <button key={h} type="button" role="radio" aria-checked={how === h} className={how === h ? 'on' : ''} title={`${title} (${key})`} onClick={() => set(h)}>
          <Ico n={h === 'points' ? 'polygon' : h === 'rect' ? 'rect' : 'ellipse'} size={14} /> {label} <kbd>{key}</kbd>
        </button>
      ))}
    </div>
  );
}
