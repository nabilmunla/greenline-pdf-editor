// One open PDF (one tab). MuPDF (editing worker) holds the document of record; the
// PDFium workers hold a copy for drawing, refreshed when page content changes.
import { gcc, baseName, dirName, joinPath } from './api';
import { mu, muFile, renderers, editor, onEngineRestart } from './engines';
import type { EngineClient } from '../engine/rpc';
import { tiles } from './tiles';
import { fileArg, isEngineDown, engineDown, type FileRef } from '../engine/rpc';
import type { AnnotData, PageInfo, AnnotSpec, Rect, Pt, TBlock, TextStyle, PageMark, MarkContext, SaveOpts, OutNode } from '../engine/mu';

export type { AnnotData, PageInfo, AnnotSpec, Rect, Pt };

/** a PDF on disk as the engines read it: a file, or a file + a file of changes after it */
export interface FileSpec { path: string; size?: number; delta?: string; mtime?: number }
const toArg = (f: FileSpec | Uint8Array) => (f instanceof Uint8Array ? f.slice() : fileArg(f.path, { size: f.size, delta: f.delta, mtime: f.mtime }));
/** temp files of a source (ours; the user's file never is) */
const tempsOf = (f: FileSpec | null | undefined) => (f ? [f.delta, f.path].filter((x): x is string => !!x) : []);

/** open documents (so they can be reopened when an engine had to restart) */
const openDocs = new Set<PdfDoc>();
onEngineRestart(async (c, kind) => {
  if (kind === 'batch') return;
  for (const d of openDocs) {
    try {
      if (kind === 'edit') await d.reopenAfterCrash();
      else await d.reopenIn(c);
    } catch (e) { gcc.log('reopen after engine restart: ' + e); }
  }
  tiles.retry();
  for (const f of crashListeners) f(kind);
});
const crashListeners = new Set<(kind: 'render' | 'edit') => void>();
/** the editing engine asked for a planned restart: fresh recovery copies first, then let it go */
let planned = false;
/** a file with unsaved work had no fresh recovery copy at the planned restart (disk full...) */
let plannedLoss = false;
editor.onNotice = (n) => {
  if (n !== 'recycle') return;
  void (async () => {
    for (const d of openDocs) { try { await d.writeRecoveryNow(); } catch (e) { plannedLoss ||= d.dirty; gcc.log('recycle recovery: ' + e); } }
    // (a big file's copy takes seconds: changes made meanwhile are written once more, or the
    // restarted engine would reopen without them)
    for (const d of openDocs) { if (d.dirty && d.changedSince()) { try { await d.writeRecoveryNow(); } catch (e) { plannedLoss = true; gcc.log('recycle recovery: ' + e); } } }
    planned = true;
    gcc.log('editing engine: planned restart');
    await editor.call('exitNow').catch(() => {});
  })();
};
/** true once after a planned restart (no "ran out of memory" message) */
export const wasPlannedRestart = () => { const p = planned; planned = false; return p; };
/** after a planned restart: true once if some unsaved work could not be kept for it */
export const plannedRestartLostWork = () => { const l = plannedLoss; plannedLoss = false; return l; };
/** told when an engine had to restart (the app shows a message for the editing engine) */
export const onCrash = (f: (kind: 'render' | 'edit') => void) => { crashListeners.add(f); return () => { crashListeners.delete(f); }; };

let seq = 1;
/** unique revision numbers (page content / markup layer) */
let revSeq = 1;
const nextRev = () => ++revSeq;

/** what a content change did to the pages (so untouched pages keep their pictures) */
export type Change = { all: true } | { none: true } | { pages: number[] } | { order: number[]; n?: number } | { insert: number; count: number } | { remove: number; count: number };

/** the page list after replacing `targets` (a run, or one for one) by `nNew` pages: old page
 *  index, or -1 for a new one (same as mu.replacePages) */
export function replaceOrder(n0: number, targets: number[], nNew: number): number[] {
  const both = Math.min(targets.length, nNew);
  const swapped = new Set(targets.slice(0, both));
  const drop = new Set(targets.slice(both));
  const last = targets[targets.length - 1];
  const out: number[] = [];
  for (let i = 0; i < n0; i++) {
    if (!drop.has(i)) out.push(swapped.has(i) ? -1 : i);
    if (i === last) for (let k = both; k < nNew; k++) out.push(-1);
  }
  return out;
}

/** the change that undoes `ch` (n = number of pages before undoing) */
function invert(ch: Change, n: number): Change {
  if ('order' in ch) {
    // after = order.map(i => before[i]); before[j] = after[first k with order[k] === j] (a page that
    // was deleted comes back new: -1)
    const back: number[] = [];
    const before = ch.n ?? Math.max(...ch.order, -1) + 1;
    for (let j = 0; j < before; j++) back.push(ch.order.indexOf(j));
    return { order: back };
  }
  if ('insert' in ch) return { remove: ch.insert, count: ch.count };
  if ('remove' in ch) return { insert: ch.remove, count: ch.count };
  void n;
  return ch;
}

export interface Scale {
  /** metres per PDF point (across the page, X - and both ways unless ky is set) */
  k: number;
  label: string;
  /** imperial display */
  imperial?: boolean;
  /** a different scale up and down the page (Y), metres per point - e.g. a section drawn with
   *  its heights exaggerated, or a sheet printed stretched */
  ky?: number;
  labelY?: string;
  /** the page's turn when it was set: a page turned a quarter since has across and up-down swapped */
  rot?: number;
}
export { orientScale } from './geom';
export interface Viewport { rect: Rect; scale: Scale; name: string }
export interface DocData {
  scales?: Record<string, Scale>;
  viewports?: Record<string, Viewport[]>;
  [k: string]: unknown;
}

import { orientScale, inViewport } from './geom';

export class PdfDoc {
  id = 'd' + seq++ + '-' + Math.random().toString(36).slice(2, 7);
  path: string | null;
  name: string;
  pages: PageInfo[] = [];
  baseRev = 0;
  /** content revision per page: tiles are keyed by it, so a page keeps its pictures when
   *  other pages change or it moves (negative = the page as it was in the file) */
  crev: number[] = [];
  annRev: number[] = [];
  dirty = false;
  /** pages whose line work was merged on opening (millions of strokes): drawing them takes time */
  heavy = 0;
  /** goes up with every change: a save only marks the file saved if nothing changed meanwhile */
  private changes = 0;
  /** set by the page view while a text box is being typed in: puts the text in */
  finishEditing?: () => Promise<void>;
  /** set by the page view: Undo (the title bar's) while a text box is typed in - true when that
   *  was the undo (a box just made goes, with its own steps) */
  undoTyping?: () => Promise<boolean>;
  /** set by the page view: Redo while a shape is being drawn - true when it put a point back */
  redoTyping?: () => Promise<boolean>;
  readOnly = false;
  password?: string;
  size = 0;
  mtime = 0;
  repaired = false;
  /** repaired, and something was missing (see OpenResult.lossy): the user is told */
  lossy = false;
  hasForms = false;
  /** carries a digital signature (saves append to it where they can, so it stays valid) */
  signed = false;
  data: DocData = {};
  canUndo = false;
  canRedo = false;
  undoName = '';
  redoName = '';
  private annotCache = new Map<number, AnnotData[]>();
  private allCache: AnnotData[] | null = null;
  private charCache = new Map<string, { text: string; box: Float32Array }>();
  private blockCache = new Map<string, TBlock[]>();
  private listeners = new Set<() => void>();
  private recTimer: number | null = null;
  private changedSinceRecovery = false;
  /** changed since the last recovery copy was made */
  changedSince() { return this.changedSinceRecovery; }
  /** where the editing engine reads the document from (after a save: the saved file) */
  src: FileSpec | Uint8Array | null = null;
  /** what the drawing engines have open */
  private drawSrc: FileSpec | Uint8Array | null = null;
  /** temp files owned by this document (removed when it closes) */
  private temps = new Set<string>();
  closed = false;
  lastRecovery: { file: string; base: { path: string; size: number; mtime: number } | null } | null = null;
  /** view state kept per tab */
  view = {
    z: 0, sx: 0, sy: 0, page: 0, fit: 'width' as 'width' | 'page' | 'none',
    /** the point at the top-left of the view, in page coordinates (kept up to date by the viewer) */
    anchor: null as { page: number; x: number; y: number } | null,
    /** opened with the view it had when it was last closed: go back there */
    restore: false,
  };

  constructor(path: string | null, name?: string) {
    this.path = path;
    this.name = name || (path ? baseName(path) : 'Untitled.pdf');
  }

  on(f: () => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  emit() { for (const f of this.listeners) f(); }

  /** the part of each page in view, in page coordinates (the viewer keeps it up to date; the
   *  Pages panel draws it as a box on the thumbnails). Separate from emit(): no app re-render. */
  visRects = new Map<number, Rect>();
  private viewListeners = new Set<() => void>();
  onView(f: () => void) { this.viewListeners.add(f); return () => { this.viewListeners.delete(f); }; }
  viewChanged() { for (const f of this.viewListeners) f(); }

  /**
   * Open in the engines: from a file (read on demand, never loaded whole) or bytes.
   * `temp`: the file is ours (a merge result, a recovery copy...) and goes when the tab closes.
   */
  async load(src: FileSpec | Uint8Array, password?: string, temp = false): Promise<'ok' | 'password'> {
    const user = await gcc.user(); // (the author's name, else the Windows user - not the whole settings file)
    const r = await mu<{ pages: PageInfo[]; needsPassword: boolean; repaired: boolean; lossy?: boolean; fixedTurn?: boolean; heavy?: number; hasForms: boolean; size?: number }>('open', this.id, toArg(src), password, user);
    if (r.needsPassword) return 'password';
    if (temp && !(src instanceof Uint8Array)) for (const t of tempsOf(src)) this.temps.add(t);
    this.src = src;
    this.password = password;
    this.pages = r.pages;
    this.repaired = r.repaired;
    this.lossy = !!r.lossy;
    this.heavy = r.heavy || 0;
    this.hasForms = r.hasForms;
    this.signed = !!(r as { signed?: boolean }).signed;
    this.annRev = r.pages.map(() => 0);
    this.crev = r.pages.map((_, k) => -(k + 1));
    this.size = src instanceof Uint8Array ? src.length : r.size ?? 0;
    // a repaired file: give PDFium MuPDF's clean copy (PDFium may choke on the broken one)
    // (also a file whose pages MuPDF had to straighten, and a protected one)
    if (r.repaired || r.fixedTurn || password) await this.redraw(await mu<FileSpec>('drawSnapshot', this.id, true));
    else await this.redraw(src);
    this.data = await mu<DocData>('getData', this.id);
    await this.refreshHistory();
    openDocs.add(this);
    // (in the log a problem report carries: which file was open when an engine went down)
    gcc.log(`opened ${this.name}: ${r.pages.length} pages, ${Math.round(this.size / 1e5) / 10} MB${r.heavy ? `, ${r.heavy} heavy pages simplified` : ''}${r.repaired ? (r.lossy ? ', repaired (damaged)' : ', repaired (index only)') : ''}`);
    return 'ok';
  }

  /**
   * Open `src` in every drawing engine; the previous drawing copy (if ours) goes.
   * looksSame: it draws exactly like the copy before (only invisible text changed): pictures
   * already asked for are kept, not thrown away.
   */
  private async redraw(src: FileSpec | Uint8Array, looksSame = false) {
    // the tab was closed meanwhile: its engines already let go of it - not opened in them again
    // (it stayed open there for good), and the copy made for it goes
    if (this.closed) { this.dropCopy(src); return; }
    const prev = this.drawSrc;
    if (!looksSame) tiles.bump(this.id);
    try { await Promise.all(renderers.map((w) => w.call('open', [this.id, toArg(src), this.password]))); }
    catch (e) { if (this.closed) { this.dropCopy(src); return; } throw e; }
    if (this.closed) {
      await Promise.all(renderers.map((w) => w.call('close', [this.id]).catch(() => {})));
      this.dropCopy(src);
      return;
    }
    if (!looksSame) tiles.bump(this.id);
    this.drawSrc = src;
    if (!(src instanceof Uint8Array)) for (const t of tempsOf(src)) if (t !== this.srcPath()) this.temps.add(t);
    if (prev && !(prev instanceof Uint8Array)) {
      const keep = new Set(src instanceof Uint8Array ? [] : tempsOf(src));
      const gone = tempsOf(prev).filter((t) => this.temps.has(t) && !keep.has(t) && t !== this.srcPath());
      for (const t of gone) this.temps.delete(t);
      if (gone.length) void gcc.dropTemp(gone);
    }
    if (this.drawStale) {
      // the drawing engines had an older copy for a while (a redraw after a change failed):
      // pictures made from it carry the new names - every page is drawn afresh
      this.drawStale = false;
      const old = this.crev;
      this.crev = this.pages.map(nextRev);
      tiles.dropRevs(this.id, new Set(old));
      this.charCache.clear();
      this.emit();
    }
  }
  private srcPath() { return this.src && !(this.src instanceof Uint8Array) ? this.src.path : ''; }
  /** a drawing copy that is not going to be used: its temp files go (never the document's own file) */
  private dropCopy(src: FileSpec | Uint8Array) {
    if (src instanceof Uint8Array) return;
    const t = tempsOf(src).filter((x) => x !== this.srcPath());
    if (t.length) void gcc.dropTemp(t);
  }
  /** the drawing engines may not have the latest content (a redraw after a change failed):
   *  the next redraw gives every page new pictures */
  private drawStale = false;
  /** changes that show (not invisible OCR text) applied in MuPDF whose pictures are not yet
   *  asked for under new names: while one is under way a new drawing copy may already hold it */
  private changing = 0;

  private drawTimer: number | null = null;
  private drawJob: Promise<void> | null = null;
  private redrawSoon() {
    if (this.drawTimer) clearTimeout(this.drawTimer);
    this.drawTimer = window.setTimeout(() => { this.drawTimer = null; void this.runRedraw(); }, 800);
  }
  private cancelRedrawSoon() { if (this.drawTimer) { clearTimeout(this.drawTimer); this.drawTimer = null; } }
  private runRedraw(): Promise<void> {
    const prev = this.drawJob;
    const job = (async () => {
      await prev;
      if (this.closed) return;
      // only invisible text changed since the engines' copy (OCR): either copy draws the same
      // pictures, so those under way are kept (thrown away, nothing asked for them again - pages
      // stayed unsharp until the view moved). Not while a change that shows is under way or
      // after a failed redraw: the new copy may then hold more than the pictures' names say.
      // (decided as the copy is asked for: a change asked for after it is not in it)
      const same = this.changing === 0 && !this.drawStale;
      try { await this.redraw(await mu<FileSpec>('drawSnapshot', this.id, false), same); } catch (e) { gcc.log('redraw: ' + e); }
      this.charCache.clear();
    })();
    this.drawJob = job;
    void job.finally(() => { if (this.drawJob === job) this.drawJob = null; });
    return job;
  }
  /** the drawing engines have every change (before reading text, searching...) */
  async drawReady() {
    if (this.drawTimer) { this.cancelRedrawSoon(); await this.runRedraw(); return; }
    await this.drawJob;
  }

  /** the file the drawing engines read was saved over (their copy is then out of date) */
  private sourceReplaced = false;
  /** one drawing engine was restarted: it gets what the others have open */
  async reopenIn(c: EngineClient) {
    if (this.sourceReplaced || this.drawStale || !this.drawSrc) { await this.refreshDrawing(); return; }
    await c.call('open', [this.id, toArg(this.drawSrc), this.password]);
  }

  /** give all drawing engines the current state again */
  async refreshDrawing() {
    await this.redraw(await mu<FileSpec>('drawSnapshot', this.id, false));
    this.sourceReplaced = false;
  }

  /**
   * The editing engine was restarted (it ran out of memory): the document comes back from
   * the last recovery copy, or from its file. Undo history is gone.
   */
  async reopenAfterCrash() {
    const rec = this.lastRecovery;
    const from: FileSpec | Uint8Array | null = rec ? (rec.base ? { path: rec.base.path, size: rec.base.size, delta: rec.file } : { path: rec.file }) : this.src;
    if (!from) return;
    const user = await gcc.user(); // (the author's name, else the Windows user - not the whole settings file)
    const r = await mu<{ pages: PageInfo[]; needsPassword: boolean }>('open', this.id, toArg(from), this.password, user);
    if (r.needsPassword) return;
    if (rec) this.src = from; // the recovery file stays until this tab closes
    // work brought back from the recovery copy is not in the file: unsaved, whatever happens
    // next (a redraw that failed below left it "saved" - closing asked nothing and deleted the copy)
    this.dirty = !!rec || this.dirty;
    // (a change too: the copy can be a minute older than what was on screen - the count tool's
    // next number, worked out from its last mark, must be counted again)
    this.changes++;
    this.pages = r.pages;
    // (the file's objects are numbered afresh: the Bookmarks panel reads its list again - an edit
    // made from the old one pointed at other objects)
    this.marksRev++;
    this.crev = r.pages.map(nextRev);
    this.annRev = r.pages.map(nextRev);
    this.annotCache.clear();
    this.allCache = null;
    this.charCache.clear();
    this.blockCache.clear();
    // (the old pictures are never asked for again)
    tiles.drop(this.id + '|');
    try {
      this.data = await mu<DocData>('getData', this.id);
      await this.refreshDrawing();
    } catch (e) {
      // the tab stays usable: the drawing engines get the document with the next change / restart
      gcc.log('reopen after the editing engine restarted: ' + e);
      this.drawStale = true;
    }
    await this.refreshHistory().catch(() => {});
    this.emit();
  }

  async close() {
    if (this.recTimer) clearTimeout(this.recTimer);
    this.cancelRedrawSoon();
    openDocs.delete(this);
    // nothing more drawn for it: queued tiles dropped, late ones refused, its pictures and notes go
    tiles.closeDoc(this.id);
    this.closed = true;
    await gcc.recoveryClear(this.id).catch(() => {});
    await Promise.all([...renderers.map((w) => w.call('close', [this.id]).catch(() => {})), mu('close', this.id).catch(() => {})]);
    if (this.temps.size) await gcc.dropTemp([...this.temps]).catch(() => {});
    gcc.docsClosed();
  }

  // -------------------------------------------------------------- tiles

  baseKey(page: number) { return `${this.id}|${this.baseRev}|${page}`; }
  annKey(page: number) { return `${this.id}|a${this.annRev[page] ?? 0}|${page}`; }

  // -------------------------------------------------------------- markups

  async annots(page: number): Promise<AnnotData[]> {
    let a = this.annotCache.get(page);
    if (!a) {
      a = await mu<AnnotData[]>('annots', this.id, page);
      this.annotCache.set(page, a);
    }
    return a;
  }
  cachedAnnots(page: number) { return this.annotCache.get(page); }

  async allAnnots(): Promise<AnnotData[]> {
    if (!this.allCache) this.allCache = await mu<AnnotData[]>('allAnnots', this.id);
    return this.allCache;
  }

  private touched(pages: Iterable<number>) {
    const old = new Set<string>();
    for (const p of pages) {
      if (this.annRev[p] != null) old.add(this.annRev[p] + '|' + p);
      this.annRev[p] = nextRev();
      this.annotCache.delete(p);
    }
    // the markup pictures of the old revisions are never asked for again
    tiles.dropAnn(this.id, old);
    this.allCache = null;
    this.changed();
  }
  /** goes up with every change (a count tool can tell nothing else changed since its last mark) */
  get changeCount() { return this.changes; }

  private changed() {
    this.dirty = true;
    this.changes++;
    this.changedSinceRecovery = true;
    this.scheduleRecovery();
    void this.refreshHistory().then(() => this.emit());
  }

  async refreshHistory() {
    const h = await mu<{ undo: string[]; redo: string[] }>('history', this.id);
    this.canUndo = h.undo.length > 0;
    this.canRedo = h.redo.length > 0;
    this.undoName = h.undo[h.undo.length - 1] || '';
    this.redoName = h.redo[h.redo.length - 1] || '';
  }

  async create(page: number, spec: AnnotSpec): Promise<AnnotData> {
    const a = await mu<AnnotData>('createAnnot', this.id, page, spec);
    this.touched([page]);
    return a;
  }
  async createMany(items: { page: number; spec: AnnotSpec }[], name?: string): Promise<AnnotData[]> {
    if (!items.length) return [];
    const r = await mu<AnnotData[]>('createAnnots', this.id, items, name);
    this.touched(new Set(items.map((i) => i.page)));
    return r;
  }
  /** change markups; `data`: the file's own settings changed in the same undo step */
  /** join: part of the step before (one Undo for both) */
  async update(items: { page: number; id: number; patch: Partial<AnnotSpec> }[], name?: string, data?: Partial<DocData>, join = false): Promise<AnnotData[]> {
    if (!items.length && !data) return [];
    const all = data ? { ...this.data, ...data } : undefined;
    const r = await mu<AnnotData[]>('updateAnnots', this.id, items, name, all, join);
    if (all) { this.data = all; this.changed(); }
    this.touched(new Set(items.map((i) => i.page)));
    return r;
  }
  async move(items: { page: number; id: number }[], dx: number, dy: number) {
    const r = await mu<AnnotData[]>('moveAnnots', this.id, items, dx, dy);
    this.touched(new Set(items.map((i) => i.page)));
    return r;
  }
  async resize(page: number, id: number, to: Rect) {
    const r = await mu<AnnotData>('resizeAnnot', this.id, page, id, to);
    this.touched([page]);
    return r;
  }
  /** copies of markups on other pages of this file (per source page: the pages and each page's
   *  shift) - one undo step */
  async copyToPages(groups: { items: { page: number; id: number }[]; targets: { page: number; dx: number; dy: number }[] }[]): Promise<AnnotData[]> {
    const r = await mu<AnnotData[]>('copyToPages', this.id, groups);
    this.touched(new Set(groups.flatMap((g) => g.targets.map((t) => t.page))));
    return r;
  }
  /** copies of markups from this or another open file onto a page, shifted by (dx, dy) */
  async paste(fromId: string, items: { page: number; id: number }[], page: number, dx: number, dy: number): Promise<AnnotData[]> {
    const r = await mu<AnnotData[]>('copyAnnots', fromId, items, this.id, page, dx, dy);
    this.touched([page]);
    return r;
  }
  /** cut: copies of these markups kept aside (the engine's hidden clipboard file) - returns
   *  the file's name and where the copies are, to paste from after the originals are deleted */
  async clipStore(items: { page: number; id: number }[]): Promise<{ docId: string; items: { page: number; id: number }[] }> {
    return { docId: '\u0000clip', items: await mu<{ page: number; id: number }[]>('clipStore', this.id, items) };
  }
  async remove(items: { page: number; id: number }[]): Promise<number> {
    const n = await mu<number>('deleteAnnots', this.id, items);
    this.touched(new Set(items.map((i) => i.page)));
    return n;
  }
  async setField(page: number, id: number, value: string | boolean) {
    const r = await mu<AnnotData>('setField', this.id, page, id, value);
    this.touched([page]);
    return r;
  }

  // -------------------------------------------------------------- content changes (redraw base)

  /** after anything that changes page content or the page list */
  private async contentChanged(pages: PageInfo[] | undefined, ch: Change) {
    // Invisible text (OCR) changes no picture, no page size and no markup: only the text is new
    // (read again from the drawing engines, keyed by baseRev). They get it a moment later, once
    // for a run of pages, instead of after every page (text, search and copy wait for it).
    // (This re-read the whole page list and gave every page new markup pictures - per OCR page.)
    if ('none' in ch) {
      if (pages) this.pages = pages;
      this.baseRev++;
      this.charCache.clear();
      this.blockCache.clear();
      this.redrawSoon();
      this.changed();
      return;
    }
    const before = this.pages.length;
    if (pages) this.pages = pages;
    else this.pages = await mu<PageInfo[]>('pageInfos', this.id);
    this.baseRev++;
    // what the drawing engines show: the file + only the changed parts (small, quick).
    // MuPDF has the change already: if this fails (a drawing engine went down meanwhile...) the
    // document still counts as changed below - it was left half done: new page list, old
    // pictures, not "changed" (closing asked nothing, no recovery copy)
    this.cancelRedrawSoon();
    await this.drawJob;
    let failed: unknown = null;
    try { await this.redraw(await mu<FileSpec>('drawSnapshot', this.id, false)); } catch (e) { failed = e; }
    // which pages keep their pictures
    const old = this.crev.slice();
    const n = this.pages.length;
    let next: number[];
    if ('order' in ch) next = ch.order.map((i) => (i >= 0 ? old[i] : undefined) ?? nextRev());
    else if ('remove' in ch) next = [...old.slice(0, ch.remove), ...old.slice(ch.remove + ch.count)];
    else if ('insert' in ch) next = [...old.slice(0, ch.insert), ...Array.from({ length: n - before }, nextRev), ...old.slice(ch.insert)];
    else if ('pages' in ch) { next = old.slice(); for (const p of ch.pages) next[p] = nextRev(); }
    else next = this.pages.map(nextRev);
    if (next.length !== n) next = this.pages.map(nextRev);
    this.crev = next;
    const keep = new Set(next);
    tiles.dropRevs(this.id, new Set(old.filter((r) => !keep.has(r))));
    this.charCache.clear();
    this.blockCache.clear();
    this.annotCache.clear();
    // markup layers: page numbers may have shifted, so every page gets a fresh one (and the
    // old markup pictures, never asked for again, go)
    this.annRev = this.pages.map(nextRev);
    tiles.drop(this.id + '|a');
    this.allCache = null;
    this.changed();
    if (failed) {
      // the drawing engines may still have the copy from before: they get the document again
      // and every page is drawn afresh (also when an engine restarts first: reopenIn)
      this.drawStale = true;
      void this.runRedraw();
      gcc.log('redraw after a change: ' + failed);
      // (an engine that went down is restarted and said so on its own; the change itself is in)
      if (!isEngineDown(failed)) throw failed;
    }
  }

  async content<T>(method: string, ch: Change, ...args: unknown[]): Promise<T> {
    // (a change that shows is under way until its pictures are asked for under new names: a
    // drawing copy made meanwhile may already hold it - see runRedraw)
    const shows = !('none' in ch);
    if (shows) this.changing++;
    try {
      const r = await mu<T>(method, this.id, ...args);
      // (page scales and viewports are kept by page number: they moved with the pages)
      if ('order' in ch || 'insert' in ch || 'remove' in ch || 'all' in ch) this.data = await mu<DocData>('getData', this.id).catch(() => this.data);
      // kept with the undo step: undo/redo then redraw only what this changed
      void mu('noteChange', this.id, 'insert' in ch ? { insert: ch.insert, count: (Array.isArray(r) ? (r as unknown[]).length : this.pages.length) - this.pages.length } : 'order' in ch ? { ...ch, n: this.pages.length } : ch).catch(() => {});
      await this.contentChanged(Array.isArray(r) && r.length && (r[0] as PageInfo).w !== undefined && (r[0] as PageInfo).label !== undefined ? (r as unknown as PageInfo[]) : undefined, ch);
      return r;
    } finally { if (shows) this.changing--; }
  }

  rotate(pages: number[], delta: number) { return this.content<PageInfo[]>('rotatePages', { pages }, pages, delta); }
  /** a page too heavy for the drawing engines: its line work simplified (strokes merged) */
  simplify(page: number) { return this.content<boolean>('simplifyPage', { pages: [page] }, page); }
  arrange(order: number[], name?: string) { return this.content<PageInfo[]>('arrangePages', { order }, order, name); }
  deletePages(pages: number[]) { const del = new Set(pages); return this.content<PageInfo[]>('deletePages', { order: this.pages.map((_, i) => i).filter((i) => !del.has(i)) }, pages); }
  insertBlank(at: number, w: number, h: number, count = 1) { return this.content<PageInfo[]>('insertBlank', { insert: at, count }, at, w, h, count); }
  /** pages of another PDF (a file path, or bytes) */
  insertFrom(at: number, from: string | Uint8Array, pages?: number[]) { return this.content<PageInfo[]>('insertFrom', { insert: at, count: 0 }, at, typeof from === 'string' ? fileArg(from) : from, pages); }
  /** a new link over `rect`: to a web / e-mail address, or a page of this file */
  addLink(page: number, rect: Rect, t: { uri?: string; page?: number }) { return this.content<PageInfo[]>('addLink', { pages: [page] }, page, rect, t); }
  /** link k of the page (as mu.linksOf lists them) pointed elsewhere, or deleted (t null) */
  setLink(page: number, k: number, t: { uri?: string; page?: number } | null) { return this.content<PageInfo[]>('setLink', { pages: [page] }, page, k, t); }
  /** goes up when the bookmarks change (an edit, its undo / redo) */
  marksRev = 0;
  /** the bookmarks written anew (one undo step): see mu.setOutline */
  async setOutline(items: OutNode[], name: string): Promise<OutNode[]> {
    const r = await mu<OutNode[]>('setOutline', this.id, items, name);
    this.marksRev++;
    this.changed();
    return r;
  }
  /** pages of another file open here, as it is now (unsaved changes included) */
  insertFromOpen(at: number, src: PdfDoc, pages?: number[]) { return this.content<PageInfo[]>('insertFromOpen', { insert: at, count: 0 }, at, src.id, pages); }
  /** pages replaced by pages of another file (open here, or a path): see mu.replacePages */
  replacePages(targets: number[], from: { open: PdfDoc } | { path: string; password?: string }, pages?: number[]) {
    const nNew = pages?.length ?? ('open' in from ? from.open.pages.length : -1);
    const ch: Change = nNew === targets.length ? { pages: targets } : nNew > 0 ? { order: replaceOrder(this.pages.length, targets, nNew), n: this.pages.length } : { all: true };
    return this.content<PageInfo[]>('replacePages', ch, targets, 'open' in from ? { open: from.open.id } : { bytes: fileArg(from.path), password: from.password }, pages);
  }
  crop(pages: number[], rect: Rect) { return this.content<PageInfo[]>('cropPages', { pages }, pages, rect); }
  flatten(items: { page: number; id: number }[] | null, opts: { widgets?: boolean; types?: string[] } = {}) {
    return this.content<number>('flatten', items ? { pages: [...new Set(items.map((i) => i.page))] } : { all: true }, items, opts);
  }
  async applyRedactions(opts: { black?: boolean; lineArt?: boolean } = {}) {
    const pages = [...new Set((await this.allAnnots()).filter((a) => a.type === 'Redact').map((a) => a.page))];
    return this.content<number>('applyRedactions', { pages }, opts);
  }
  replaceText(page: number, area: Rect[], text: string, origin: Pt, style: TextStyle, dir: Pt, fontBytes?: Uint8Array) { return this.content<void>('replaceText', { pages: [page] }, page, area, text, origin, style, dir, fontBytes); }
  /** OCR text is invisible: the page looks the same, its pictures stay */
  /** join: one undo step with the page before (one OCR run) */
  addTextLayer(page: number, words: { text: string; box: Rect }[], join = false) { return this.content<number>('addTextLayer', { none: true }, page, words, true, join); }
  markPages(marks: PageMark[], ctx: MarkContext) {
    const from = Math.max(0, ctx.pageFrom ?? 0), to = Math.min(this.pages.length, ctx.pageTo ?? this.pages.length);
    const pages = ctx.pages ?? Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
    return this.content<number>('markPages', { pages }, marks, ctx);
  }

  /** the pages as a new PDF in a temp file (path) */
  async extract(pages: number[]): Promise<string> { return (await muFile<FileRef>('extract', this.id, pages)).$file.path; }

  async undo() { await this.step('undo'); }
  async redo() { await this.step('redo'); }
  private async step(dir: 'undo' | 'redo') {
    // (may change what pages show: under way like a page change - see runRedraw)
    this.changing++;
    try {
      const r = await mu<{ ok: boolean; kind: 'a' | 'c' | 'm'; pages: PageInfo[] | null }>(dir, this.id);
      // nothing more to undo / redo (the engine let go of its list): the button goes grey - it
      // stayed on and did nothing, silently
      if (!r.ok) { await this.refreshHistory(); this.emit(); return; }
      await this.afterHistory(r);
    } finally { this.changing--; }
  }
  private async afterHistory(r: { kind: 'a' | 'c' | 'm'; pages: PageInfo[] | null; change?: Change; dir?: 'undo' | 'redo' }) {
    // (bookmarks only: nothing on the pages changed)
    if (r.kind === 'm') { this.marksRev++; this.changed(); return; }
    this.data = await mu<DocData>('getData', this.id);
    if (r.kind === 'c') await this.contentChanged(r.pages ?? undefined, r.change ? (r.dir === 'undo' ? invert(r.change, this.pages.length) : r.change) : { all: true });
    else this.touched(this.pages.map((_, i) => i));
  }

  // -------------------------------------------------------------- text

  async chars(page: number) {
    await this.drawReady();
    const k = this.baseRev + ':' + page;
    let c = this.charCache.get(k);
    if (!c) {
      c = await renderers[0].call<{ text: string; box: Float32Array }>('chars', [this.id, page]);
      this.charCache.set(k, c);
      if (this.charCache.size > 40) this.charCache.delete(this.charCache.keys().next().value as string);
    }
    return c;
  }
  async rangeRects(page: number, start: number, count: number) {
    await this.drawReady();
    return renderers[0].call<number[][]>('rangeRects', [this.id, page, start, count]);
  }
  private linkCache = new Map<string, { rect: number[]; url?: string; page?: number }[]>();
  /** links on a page (asked once per page and content version, not on every scroll) */
  async links(page: number) {
    const k = this.baseRev + ':' + page;
    let l = this.linkCache.get(k);
    if (!l) {
      l = await renderers[0].call<{ rect: number[]; url?: string; page?: number }[]>('links', [this.id, page]).catch(() => []);
      this.linkCache.set(k, l);
      if (this.linkCache.size > 200) this.linkCache.delete(this.linkCache.keys().next().value as string);
    }
    return l;
  }

  async blocks(page: number) {
    const k = this.baseRev + ':' + page;
    let b = this.blockCache.get(k);
    if (!b) {
      b = await mu<TBlock[]>('textBlocks', this.id, page);
      this.blockCache.set(k, b);
      // (the last 40 pages, like the characters: Edit text over a long file kept them all)
      if (this.blockCache.size > 40) this.blockCache.delete(this.blockCache.keys().next().value as string);
    }
    return b;
  }

  // -------------------------------------------------------------- data kept in the PDF

  async setData(patch: Partial<DocData>, name?: string) {
    this.data = { ...this.data, ...patch };
    await mu('setData', this.id, this.data, name);
    this.changed();
  }
  /** document properties (title, author...): a change like any other - unsaved, in the
   *  recovery copy, seen by a save already running (Document properties set `dirty` by hand) */
  async setMeta(meta: Record<string, string>) {
    await mu('setMeta', this.id, meta);
    this.changed();
  }
  scaleAt(page: number, x?: number, y?: number): Scale | null {
    // a scale with no usable factor (0.7.x could save k: null, or a file edited elsewhere) is
    // treated as no scale - not as 0 m per point or NaN in every measurement
    const ok = (sc: Scale | null | undefined) => sc && Number.isFinite(sc.k) && sc.k > 0 && (sc.ky == null || (Number.isFinite(sc.ky) && sc.ky > 0)) ? sc : null;
    if (x != null && y != null) {
      const vps = this.data.viewports?.[String(page)] || [];
      for (const v of vps) if (inViewport(v, x, y, this.pages[page]) && ok(v.scale)) return orientScale(v.scale, this.pages[page]?.rot ?? 0);
    }
    return orientScale(ok(this.data.scales?.[String(page)]) ?? ok(this.data.scales?.['*']) ?? null, this.pages[page]?.rot ?? 0);
  }

  // -------------------------------------------------------------- save

  /** the document as it would be saved, in a temp file (print, save a copy...) */
  async fileForSave(o: SaveOpts = {}): Promise<string> { return (await muFile<FileRef>('save', this.id, o)).$file.path; }

  /** saving now (to its own file, or `to`) rewrites this signed file, so its digital signatures
   *  stop being valid (pages deleted, something redacted, text edited, a password change) */
  async breaksSignatures(to?: string, o: SaveOpts = {}): Promise<boolean> {
    if (!this.signed) return false;
    const sameFile = !to || to === this.path;
    return !!(await mu<boolean>('breaksSignatures', this.id, { incremental: sameFile && !o.password && !o.decrypt, ...o }).catch(() => false));
  }

  /** save to its own file (or `to`); returns false if the user has to pick a place */
  async save(to?: string, o: SaveOpts = {}): Promise<boolean> {
    await this.finishEditing?.().catch(() => {});
    const target = to || this.path;
    if (!target) return false;
    const gen = this.changes;
    if (!to) {
      const st = await gcc.stat(target);
      // gone (renamed or moved in Explorer, its folder too, deleted): a place is picked - saving
      // made a new copy at the old name (even the old folder again) and said "Saved", while the
      // file the person has now kept its old content
      if (!st || !st.writable) return false;
    }
    const sameFile = !to || to === this.path;
    const opts = { incremental: sameFile && !o.password && !o.decrypt, ...o };
    // written straight into the target's folder (hidden name), then swapped in: a 300 MB file
    // is not written to the temp folder first and copied across drives afterwards
    const part = joinPath(dirName(target), '.~' + baseName(target) + '.' + Math.random().toString(36).slice(2, 8) + '.part');
    let f: FileRef;
    try { f = await editor.call<FileRef>('save', [this.id, opts], part); }
    catch (e) {
      void gcc.dropTemp([part]);
      if (/memory|Aborted/i.test(String(e))) throw e;
      // the editing engine went down while saving: trying again at once reached the new engine
      // before it had the file open again ("Document is not open" was all the person saw)
      if (isEngineDown(e)) throw engineDown(new Error('Saving was cut short: the editing engine had to start again. Nothing was written - save again in a moment.'));
      f = await muFile<FileRef>('save', this.id, opts); // that folder refused: the temp folder, as before
    }
    const r = await gcc.commit(f.$file.path, target);
    const wasSource = this.srcPath() === target;
    if (wasSource || (this.drawSrc && !(this.drawSrc instanceof Uint8Array) && this.drawSrc.path === target)) this.sourceReplaced = true;
    this.path = target;
    this.name = baseName(target);
    this.size = r.size;
    this.mtime = r.mtime;
    this.readOnly = false;
    // a change made while saving is not in the file: it stays unsaved (and in the recovery copy)
    if (this.changes === gen) {
      this.dirty = false;
      this.changedSinceRecovery = false;
      this.lastRecovery = null;
      await gcc.recoveryClear(this.id);
    }
    if (o.decrypt) {
      // the password is off the saved file, but the open document is still the protected one:
      // the next save (changes appended to it) put the password back. What is open becomes the
      // saved file (undo history starts again)
      this.password = undefined;
      await this.reopenFrom({ path: target });
      const lost = this.changes !== gen;
      if (this.dirty) { this.dirty = false; this.changedSinceRecovery = false; this.lastRecovery = null; await gcc.recoveryClear(this.id); }
      // (as below: a change made while it was saving is not in the file, and what is open now is
      // the file - it went without a word, the file marked saved)
      if (lost) { this.emit(); throw new Error(`The password was removed from ${this.name}, but the changes made while it was saving were not kept (it was opened again from the saved file). Please make them again.`); }
    } else if (r.inPlace && wasSource) {
      // another program holds the file, so it was overwritten in place - under the engines
      // still reading it: open the saved file afresh (undo history starts again; what is open
      // is then exactly the file)
      await this.reopenFrom({ path: target });
      const lost = this.changes !== gen;
      if (this.dirty) { this.dirty = false; this.changedSinceRecovery = false; this.lastRecovery = null; await gcc.recoveryClear(this.id); }
      // a change made while it was saving is not in the file, and what is open now is the file:
      // that change is gone - said so (it vanished without a word, the file marked saved)
      if (lost) { this.emit(); throw new Error(`${this.name} was saved, but another program is holding it, so it was opened again from the saved file - the changes made while it was saving were not kept. Please make them again.`); }
    } else {
      // the saved file is now what a restarted engine would reopen (a temp source stays
      // listed in this.temps: the engine still reads it until the tab closes)
      this.src = { path: target };
    }
    this.emit();
    return true;
  }

  /** open again from a file (after it was overwritten in place) */
  private async reopenFrom(src: FileSpec) {
    const user = await gcc.user(); // (the author's name, else the Windows user - not the whole settings file)
    const r = await mu<{ pages: PageInfo[] }>('open', this.id, toArg(src), this.password, user);
    this.src = src;
    this.pages = r.pages;
    // (renumbered by the full save: the Bookmarks panel reads its list again)
    this.marksRev++;
    this.crev = r.pages.map(nextRev);
    this.annRev = r.pages.map(nextRev);
    this.annotCache.clear();
    this.allCache = null;
    this.charCache.clear();
    this.blockCache.clear();
    // (the old pictures are never asked for again)
    tiles.drop(this.id + '|');
    await this.redraw(src);
    await this.refreshHistory();
  }

  /** a recovery copy of unsaved work right now (before a planned engine restart; to move the
   *  file to another window - force: a file with no path of its own yet, even unchanged) */
  async writeRecoveryNow(force = false) {
    if (this.closed || (!this.dirty && !force)) return;
    // (cleared before writing: a change made while the copy is written keeps it set)
    this.changedSinceRecovery = false;
    try {
      const file = await gcc.recoveryPath(this.id);
      const r = await mu<{ base: { path: string; size: number; mtime: number } | null }>('writeRecovery', this.id, file, 64e6);
      await gcc.recoveryMeta(this.id, { path: this.path, name: this.name, base: r.base, fileMtime: this.mtime || undefined });
      this.lastRecovery = { file, base: r.base };
    } catch (e) { this.changedSinceRecovery = true; throw e; }
  }

  private scheduleRecovery() {
    if (this.recTimer) return;
    this.recTimer = window.setTimeout(async () => {
      this.recTimer = null;
      if (this.closed || !this.dirty || !this.changedSinceRecovery) return;
      this.changedSinceRecovery = false;
      try {
        // written by the engine straight to disk; for a huge file only the changes
        const file = await gcc.recoveryPath(this.id);
        const r = await mu<{ base: { path: string; size: number; mtime: number } | null }>('writeRecovery', this.id, file, 64e6);
        if (this.closed || !this.dirty) { await gcc.recoveryClear(this.id); return; }
        await gcc.recoveryMeta(this.id, { path: this.path, name: this.name, base: r.base, fileMtime: this.mtime || undefined });
        this.lastRecovery = { file, base: r.base };
      } catch (e) { gcc.log('recovery: ' + e); }
    }, this.size > 150e6 ? 120_000 : 45_000);
  }
}
