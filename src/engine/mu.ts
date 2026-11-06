// MuPDF (as WebAssembly): the document of record. Every change goes through here:
// markups, pages, redaction, text edits, OCR text layer, forms, flattening, saving,
// compression. Every change is one journal operation, so undo/redo covers all of it.
// No DOM in here so the tests can run it in Node.
//
// Coordinates: "page space" = the page as shown, origin top-left, PDF points
// (MuPDF's own page space; PDFium's drawing uses the same).
import * as mupdf from 'mupdf';
import { sheetLayout, heavyForPrinter, AUTO_PICTURE_MAX_AREA, PICTURE_DPI, type PrintOpts } from './printlayout';
import { wrapText, TEXT_PAD, TYPE_PAD, AUTO_MIN } from './textwrap';
import { fontStack, availableFamilies, fontFromBytes, fontBytes, type FontRef } from './fonts';
import { layoutText, lineOps, measureLine, toUnicodeCMap, visualOrder, paraLevels, shapePiece, RTL_RE, type Line, type Glyph } from './shape';
import { runsText, reflowRuns, settle, dropKey, fullStyle, toRC, toDS, fromRC, cleanRuns, type TextRun, type BaseStyle, type FullStyle } from './richtext';
import type { Reader } from './files';

/** typefaces from the PC that text boxes can use (besides the built-in three) */
export function fontFamilies(): string[] { return availableFamilies(); }

/** a text box's font: one of the built-in three (Helv, TiRo, Cour) or a family from the PC */
export interface TextFont { size: number; color: number[]; family?: string; bold?: boolean; italic?: boolean }
export type { TextRun } from './richtext';

/** a PDF given as bytes, or read on demand from a file */
export type In = Uint8Array | Reader;
const inSize = (b: In) => (b instanceof Uint8Array ? b.length : b.size);

/**
 * Where the next finished file goes. Normally it is returned as bytes; the engine host sets
 * a sink to write it straight from MuPDF's memory to disk instead (no copy of a 500 MB file).
 */
let sink: ((view: Uint8Array) => void) | null = null;
export function withSink<T>(write: (view: Uint8Array) => void, run: () => T): T {
  sink = write;
  try { return run(); } finally { sink = null; }
}
const out_ = (b: mupdf.Buffer) => out(b);
/** the startxref value at the end of a file (-1 if not found) */
function startXref(b: In): number {
  const size = inSize(b);
  const n = Math.min(4096, size);
  let tail: Uint8Array;
  if (b instanceof Uint8Array) tail = b.subarray(size - n);
  else { tail = new Uint8Array(n); if (b.read(tail, 0, n, size - n) !== n) return -1; }
  const m = [...new TextDecoder('latin1').decode(tail).matchAll(/startxref\s+(\d+)/g)].pop();
  return m ? parseInt(m[1], 10) : -1;
}
/**
 * MuPDF's incremental save always appends every change since the file was opened, but after
 * a first incremental save it points /Prev at that save's cross-reference section - which
 * isn't in the next output (that one is again the original + all changes). Point /Prev back
 * at the original's section; padded with spaces so nothing moves. False = can't fix.
 */
function fixIncremental(v: Uint8Array, base: number, origXref: number): boolean {
  if (origXref < 0) return false;
  // nothing appended (every change undone): the file exactly as it is
  if (base > 0 && v.length === base) return true;
  const td = new TextDecoder('latin1');
  const from = Math.max(base, v.length - 65536);
  const tail = td.decode(v.subarray(from));
  const sx = tail.lastIndexOf('startxref');
  if (sx < 0) return false;
  const pi = tail.lastIndexOf('/Prev', sx);
  if (pi < 0) return false;
  const m = /^\/Prev\s+(\d+)/.exec(tail.slice(pi));
  if (!m) return false;
  if (parseInt(m[1], 10) === origXref) return true;
  const want = String(origXref);
  if (want.length > m[1].length) return false;
  const at = from + pi + m[0].length - m[1].length;
  const rep = want.padEnd(m[1].length, ' ');
  for (let i = 0; i < rep.length; i++) v[at + i] = rep.charCodeAt(i);
  return true;
}
/** incremental save of an open document, fixed as above (null if not possible) */
function saveIncremental(o: Open): mupdf.Buffer | null {
  const base = o.reader?.size ?? -1;
  const buf = o.doc.saveToBuffer('incremental');
  const v = buf.asUint8Array();
  const orig = o.reader ? base : -1;
  if (fixIncremental(v, orig >= 0 ? orig : 0, o.origXref ?? -1)) return buf;
  buf.destroy?.();
  return null;
}
/** a finished file: to the sink (returns empty bytes) or as bytes */
function out(buf: mupdf.Buffer): Uint8Array {
  try {
    const v = buf.asUint8Array();
    if (sink) { const w = sink; sink = null; w(v); return new Uint8Array(0); }
    return v.slice();
  } finally { buf.destroy?.(); }
}
/** a finished file made outside MuPDF (an export): to the sink, or back as bytes */
export function emit(v: Uint8Array): Uint8Array {
  if (sink) { const w = sink; sink = null; w(v); return new Uint8Array(0); }
  return v;
}
/** a file written in pieces (a big one, never whole in memory): to the sink piece by piece, or
 *  joined into bytes when there is no sink (tests) */
function emitStream(fill: (put: (b: string | Uint8Array) => void) => void): Uint8Array {
  const bytes = (b: string | Uint8Array) => (typeof b === 'string' ? Buffer.from(b, 'latin1') : b);
  if (sink) { const w = sink; sink = null; fill((b) => w(bytes(b))); return new Uint8Array(0); }
  const parts: Uint8Array[] = [];
  fill((b) => parts.push(typeof b === 'string' ? bytes(b) : b.slice()));
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * A PDF written object by object, never whole in memory: what MuPDF's own save can't do past
 * about 1 GB (it builds the whole file in the engine's memory, then fails: "realloc failed").
 * Only what the file uses is written (from the trailer's Root and Info - like a garbage-collected
 * save: deleted pages and redacted content don't stay in it); each stream's bytes are copied as
 * they are (from the file, or from `spilled` - a merge's temp file). Not for encrypted files
 * (their strings would come out decrypted).
 */
function writeObjects(doc: mupdf.PDFDocument, put: (b: string | Uint8Array) => void, spilled?: Map<number, { off: number; len: number }>, copy?: (off: number, len: number) => void) {
  const n = doc.countObjects();
  const tr = doc.getTrailer();
  // (an object's generation, as a reference to it gives it - "12 1 R")
  const genOf = (ref: mupdf.PDFObject) => { const m = /^\d+ (\d+) R$/.exec(ref.toString()); return m ? m[1] : '0'; };
  // what is used: everything reachable from the trailer
  const keep = new Set<number>();
  const queue: number[] = [];
  /** each object's generation as the references to it give it ("4 1 R"): newIndirect(num) always
   *  says 0 - written as 0 while the references said 1, strict readers lost those objects */
  const gen = new Map<number, string>();
  const walk = (v: mupdf.PDFObject, depth: number) => {
    if (depth > 64) return;
    if (v.isIndirect()) { const k = v.asIndirect(); if (k > 0 && k < n && !keep.has(k)) { keep.add(k); queue.push(k); gen.set(k, genOf(v)); } return; }
    if (v.isArray()) { for (let i = 0; i < v.length; i++) walk(v.get(i), depth + 1); return; }
    if (v.isDictionary()) v.forEach((x: mupdf.PDFObject) => walk(x, depth + 1));
  };
  for (const k of ['Root', 'Info']) walk(tr.get(k), 0);
  while (queue.length) walk(doc.newIndirect(queue.pop()!).resolve(), 0);
  let pos = 0;
  const w = (b: string | Uint8Array) => { put(b); pos += typeof b === 'string' ? b.length : b.length; };
  w('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n');
  const offs: number[] = [0];
  const gens: string[] = ['65535'];
  /** a stream's dictionary with its real length (written as text: the open document is not changed) */
  const dictWith = (obj: mupdf.PDFObject, len: number) => {
    let d = '<<';
    obj.forEach((v: mupdf.PDFObject, k: string | number) => { if (String(k) !== 'Length') d += doc.newName(String(k)).toString() + ' ' + v.toString(true, true); });
    return d + '/Length ' + len + '>>';
  };
  for (let num = 1; num < n; num++) {
    offs[num] = pos;
    const ref = doc.newIndirect(num);
    if (!keep.has(num)) { gens[num] = '0'; w(`${num} 0 obj\nnull\nendobj\n`); continue; }
    const g = (gens[num] = gen.get(num) ?? '0');
    const obj = ref.resolve();
    const sp = spilled?.get(num);
    if (sp && copy) {
      w(`${num} ${g} obj\n${dictWith(obj, sp.len)}\nstream\n`);
      copy(sp.off, sp.len);
      pos += sp.len;
      w('\nendstream\nendobj\n');
    } else if (ref.isStream()) {
      const raw = ref.readRawStream();
      try {
        const v = raw.asUint8Array();
        w(`${num} ${g} obj\n${dictWith(obj, v.length)}\nstream\n`);
        w(v);
        w('\nendstream\nendobj\n');
      } finally { raw.destroy?.(); }
    } else w(`${num} ${g} obj\n${obj.isNull() ? 'null' : obj.toString(true, true)}\nendobj\n`);
  }
  const xref = pos;
  let x = `xref\n0 ${n}\n0000000000 65535 f\r\n`;
  for (let num = 1; num < n; num++) x += String(offs[num]).padStart(10, '0') + ' ' + gens[num].padStart(5, '0') + ' n\r\n';
  // (an /Info written straight into the trailer - not as an object of its own - is kept too: title and author were lost)
  const ref = (k: string) => { const v = tr.get(k); return v.isIndirect() ? `/${k} ${v.asIndirect()} ${genOf(v)} R` : k === 'Info' && v.isDictionary() ? `/Info ${v.toString(true, true)}` : ''; };
  const id = tr.get('ID');
  x += `trailer\n<</Size ${n}${ref('Root')}${ref('Info')}${id.isArray() ? '/ID ' + id.toString(true, true) : ''}>>\nstartxref\n${xref}\n%%EOF\n`;
  w(x);
}
/** a file this big is saved in pieces (MuPDF's own save fails at about 1 GB) */
const STREAM_SAVE = 350e6;
const encrypted = (o: Open) => { try { return !o.doc.getTrailer().get('Encrypt').isNull(); } catch { return true; } };
/** "%PDF-" near the start (where every PDF program looks for it: the first 1 KB) */
function looksLikePdf(b: In): boolean {
  const n = Math.min(1024, inSize(b));
  if (n < 5) return false;
  let head: Uint8Array;
  if (b instanceof Uint8Array) head = b.subarray(0, n);
  else { head = new Uint8Array(n); try { if (b.read(head, 0, n, 0) < 5) return false; } catch { return false; } }
  return new TextDecoder('latin1').decode(head).includes('%PDF-');
}
/** starts like an office file, an archive or a picture (zip / docx / xlsx, old .doc / .xls, png, jpeg, gif, rtf) */
function otherKind(b: In): boolean {
  const head = new Uint8Array(8);
  if (b instanceof Uint8Array) head.set(b.subarray(0, 8));
  else { try { b.read(head, 0, Math.min(8, b.size), 0); } catch { return false; } }
  const starts = (...xs: number[]) => xs.every((x, i) => head[i] === x);
  return starts(0x50, 0x4b, 0x03, 0x04) || starts(0xd0, 0xcf, 0x11, 0xe0) || starts(0x89, 0x50, 0x4e, 0x47) || starts(0xff, 0xd8, 0xff) || starts(0x47, 0x49, 0x46, 0x38) || starts(0x7b, 0x5c, 0x72, 0x74, 0x66);
}
/**
 * The file carries a digital signature: its form says so (/SigFlags 1) or a signature field has
 * a value. Rewriting such a file (a full save) breaks every signature in it.
 */
function isSigned(doc: mupdf.PDFDocument): boolean {
  try {
    const form = doc.getTrailer().get('Root', 'AcroForm');
    if (!form.isDictionary()) return false;
    const sf = form.get('SigFlags');
    if (sf.isNumber() && (sf.asNumber() & 1)) return true;
    let seen = 0;
    const walk = (list: mupdf.PDFObject, depth: number): boolean => {
      for (let i = 0; i < list.length && seen < 5000; i++, seen++) {
        const f = list.get(i);
        if (!f.isDictionary()) continue;
        const ft = f.getInheritable('FT');
        if (ft.isName() && ft.asName() === 'Sig' && f.get('V').isDictionary()) return true;
        const kids = f.get('Kids');
        if (depth < 12 && kids.isArray() && walk(kids, depth + 1)) return true;
      }
      return false;
    };
    const fields = form.get('Fields');
    return fields.isArray() && walk(fields, 0);
  } catch { return false; }
}
/** files this big can't be read by the editing engine (see openIn) */
export const TOO_BIG = 2 ** 31;
export const tooBigText = (size: number) => `This file is ${(size / 2 ** 30).toFixed(1)} GB: PDF Editor can't open files of 2 GB or more. Other PDF programs can; to work on it here, split it into smaller files there first.`;
/** MuPDF document from bytes or a reader (the reader stays open while the document lives) */
export function openIn(b: In): mupdf.Document {
  if (b instanceof Uint8Array) return mupdf.Document.openDocument(b, 'application/pdf');
  // MuPDF.js reads a file through 32-bit positions: from 2 GB on it can't, and said only "TRYLATER"
  if (b.size >= TOO_BIG) throw new Error(tooBigText(b.size));
  const stm = new mupdf.Stream({ fileSize: () => b.size, read: (memory: Uint8Array, offset: number, length: number, position: number) => b.read(memory, offset, length, position), close() { /* closed by its owner */ } } as never);
  return mupdf.Document.openDocument(stm, 'application/pdf');
}

export type Rect = [number, number, number, number];
export type Pt = [number, number];
export type RGB = [number, number, number];

export const LOCKED = 128; // PDF annotation flag "Locked"
const HIDDEN = 2;
const PRINT = 4;

export interface AnnotData {
  id: number; // object number: stable while the file is open
  page: number;
  type: string;
  rect: Rect;
  color: number[] | null;
  ic: number[] | null;
  opacity: number;
  bw: number;
  dash: boolean;
  cloudy: number;
  contents: string;
  author: string;
  subject: string;
  modified: number | null;
  created: number | null;
  locked: boolean;
  hidden: boolean;
  icon?: string;
  quads?: number[][];
  vertices?: Pt[];
  line?: Pt[];
  ink?: Pt[][];
  le?: [string, string];
  callout?: Pt[];
  intent?: string;
  font?: TextFont;
  /** text box: parts of its text styled differently from the box (bold, colour, size...); none
   *  when all of it is in the box's own style */
  runs?: TextRun[];
  quadding?: number;
  /** text box: the box fits its text (width up to this many points, then it wraps) */
  autoWidth?: number | null;
  /** id of the markup this one answers (comment replies) */
  irt?: number;
  state?: string;
  /** GCC kind (measure, stamp, cloud, callout, area highlight...) kept in /GCCKind */
  kind?: string;
  group?: string;
  angle?: number;
  /** measurement: how its number shows (unit, decimals) - /GCCFmt; label text size - /GCCSize */
  fmt?: MeasureFmtData;
  labelSize?: number;
  /** measurement: its label is the number the app worked out (/GCCLabel /auto) - not typed by
   *  hand; worked out again when the scale changes or it is moved / pasted elsewhere */
  autoLabel?: boolean;
  /** unrotated box of a rotated markup */
  box?: Rect;
  /** a stamp drawn from one of the app's stamp designs (text stamps: they always keep their proportions) */
  designed?: boolean;
  /** widget (form field) data */
  field?: FieldData;
  /** redaction mark: the box left after applying (colour / 'auto' = page colour / 'none') */
  redactFill?: number[] | 'auto' | 'none';
}

/** maxLen: the most characters a text field takes (its /MaxLen) */
export interface FieldData { name: string; ftype: string; value: string; options?: string[]; readOnly: boolean; multiline: boolean; checked?: boolean; maxLen?: number }

export interface PageInfo { w: number; h: number; rot: number; label: string }

/** one step of our undo history: page list before/after and what changed (for redrawing only that) */
/** parts: MuPDF operations this one step is made of (a long job done in parts - MuPDF's undo
 *  bookkeeping slows down with the square of an operation's size) */
interface Entry { name: string; kind: 'a' | 'c' | 'm'; before?: PageInfo[]; after?: PageInfo[]; change?: unknown; parts?: number }

interface Open {
  doc: mupdf.PDFDocument;
  pages: Map<number, mupdf.PDFPage>;
  /** journal kinds aligned with MuPDF's undo stack: 'a' = markups only, 'c' = page content/structure */
  undo: Entry[];
  redo: Entry[];
  fonts: Map<string, mupdf.PDFObject>;
  author: string;
  changedContent: boolean;
  /** something was removed for good (pages, redactions, edited text): never save as "original +
   *  changes" again - the original part would still hold it */
  removedContent?: boolean;
  /** pages whose line work was merged on opening: saved in full (the old line work dropped) */
  merged?: number;
  password?: string;
  /** a whole TrueType font was embedded for text edits: subset it when saving */
  bigFont?: boolean;
  /** per embedded font: glyph -> letters (its ToUnicode, so copy and search find the words) */
  toUni?: Map<string, Map<number, string>>;
  /** the file it reads from (closed with the document) */
  reader?: Reader;
  /** where the original file's last cross-reference section starts (-1: unknown) */
  origXref?: number;
  /** size/rotation/label of every page, kept up to date by the page operations (reading
   *  them all again after every change cost ~1 s on a 300-page scan book) */
  infos?: PageInfo[];
  /** objects the file had when opened (higher numbers were made since) */
  fileObjs?: number;
  /** a markup that was in the file was deleted or flattened: "original + changes" would keep it
   *  (its text, its author) in the original part - saved in full from now on (files up to 64 MB) */
  droppedAnnots?: boolean;
  /** the last undo step an operation added (what noteChange may write to) */
  lastEntry?: Entry | null;
  /** the name of the operation under way (opMore cuts it into more journal steps) */
  opName?: string | null;
  /** the file is digitally signed: saved as "original + changes" wherever possible (rewriting the
   *  file breaks every signature) */
  signed?: boolean;
}
const docs = new Map<string, Open>();

let glyphless: Uint8Array | null = null;
/** the font used for the invisible OCR text (Tesseract's "glyphless" font) */
export function setGlyphlessFont(b: Uint8Array) { glyphless = b; }

function O(id: string): Open {
  const o = docs.get(id);
  if (!o) throw new Error('Document is not open');
  return o;
}
function pg(o: Open, i: number): mupdf.PDFPage {
  let p = o.pages.get(i);
  if (!p) {
    p = o.doc.loadPage(i) as mupdf.PDFPage;
    o.pages.set(i, p);
    hideReplies(p);
    if (o.pages.size > 64) {
      const first = o.pages.keys().next().value as number;
      if (first !== i) o.pages.delete(first);
    }
  }
  return p;
}
/** forget cached page objects (after anything that moves pages around) */
function resetPages(o: Open) { o.pages.clear(); }

function hideReplies(p: mupdf.PDFPage) {
  for (const a of p.getAnnotations()) {
    try { if (!a.getObject().get('IRT').isNull()) a.setHiddenForEditing(true); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- open / close

/** signed: the file carries a digital signature (saves append to it; see save) */
export interface OpenResult { pages: PageInfo[]; needsPassword: boolean; repaired: boolean; fixedTurn?: boolean; heavy?: number; title: string; author: string; encrypted: boolean; hasForms: boolean; signed?: boolean }

export function open(id: string, bytes: In, password?: string, author = ''): OpenResult {
  close(id);
  // another kind of file with a .pdf name (or an empty one): said so, not MuPDF's "no objects
  // found" - office files, archives and pictures are told by their first bytes without asking
  // MuPDF (each of its errors costs a little of its memory); anything else MuPDF tries to repair
  const notPdf = () => { if (!(bytes instanceof Uint8Array)) bytes.close(); return new Error(inSize(bytes) ? 'Not a PDF file (it may be another kind of file with a .pdf name).' : 'This file is empty (0 bytes).'); };
  if (!looksLikePdf(bytes) && (!inSize(bytes) || otherKind(bytes))) throw notPdf();
  let d: mupdf.Document;
  try { d = openIn(bytes); } catch (e) {
    if (!looksLikePdf(bytes)) throw notPdf();
    throw e;
  }
  if (d.needsPassword()) {
    if (!password || !d.authenticatePassword(password)) {
      d.destroy?.();
      if (!(bytes instanceof Uint8Array)) bytes.close();
      return { pages: [], needsPassword: true, repaired: false, title: '', author: '', encrypted: true, hasForms: false };
    }
  }
  const doc = d.asPDF();
  if (!doc) { d.destroy?.(); if (!(bytes instanceof Uint8Array)) bytes.close(); throw new Error('Not a PDF file'); }
  const o: Open = { doc, pages: new Map(), undo: [], redo: [], fonts: new Map(), author, changedContent: false, password, reader: bytes instanceof Uint8Array ? undefined : bytes, origXref: startXref(bytes) };
  try { o.fileObjs = doc.countObjects(); } catch { /* unknown */ }
  o.signed = isSigned(doc);
  docs.set(id, o);
  // a page turned by something other than a quarter turn (/Rotate 45): MuPDF rounds it, PDFium
  // cuts it down - the two would disagree on the page's shape (markups off the drawing). Set to
  // MuPDF's value here; the drawing engine then gets this copy.
  let turned = false;
  for (let i = 0, n = doc.countPages(); i < n; i++) {
    try {
      const po = doc.findPage(i);
      const r = po.getInheritable('Rotate');
      if (r.isNumber() && r.asNumber() % 90 !== 0) { po.put('Rotate', (((Math.round(r.asNumber() / 90) * 90) % 360) + 360) % 360); turned = true; }
    } catch { /* a broken page: left as it is */ }
  }
  const merged = mergeHeavyPages(o, bytes instanceof Uint8Array ? bytes.length : bytes.size);
  const pages = pageInfos(o);
  // (cached from here on: see Open.infos)
  doc.enableJournal();
  let hasForms = false;
  // (an empty list - a form whose fields were all flattened - is no form)
  try { const f = doc.getTrailer().get('Root', 'AcroForm', 'Fields'); hasForms = f.isArray() && f.length > 0; } catch { /* none */ }
  return {
    pages,
    needsPassword: false,
    repaired: doc.wasRepaired(),
    fixedTurn: turned || merged > 0,
    heavy: merged,
    title: doc.getMetaData('info:Title') || '',
    author: doc.getMetaData('info:Author') || '',
    encrypted: !!password,
    hasForms,
    signed: !!o.signed,
  };
}

/**
 * Pages whose line work is millions of separate little strokes (see strokes.ts) get it merged
 * on opening - drawn the same, but the drawing engine can hold the page (it ran out of memory).
 * The merging itself (inflate / merge / deflate) comes from the engine host (Node's zlib).
 * Skipped when transparency or blending is in play (merged strokes would overlap differently).
 * Returns the number of pages changed; the file then also saves in full (old line work dropped).
 */
let mergeContent: ((rawParts: Uint8Array[], force?: boolean) => Uint8Array | null) | null = null;
/** the merging: given the page's content streams (Flate-compressed, in order), the new compressed
 *  content - or null when the page is not one of those (see strokes.ts MIN_STROKES; `force`: asked
 *  for on a page that took the drawing engine down - a lower bar) */
export function setContentMerger(f: typeof mergeContent) { mergeContent = f; }
/** compressed bytes of a page's content worth a look when opening: only true monsters (the one
 *  that needed this: 45 MB). Ordinary dense sheets (8-22 MB) are not looked at - that cost 0.5 s
 *  each; one that does take the drawing engine down offers "Simplify" (simplifyPage) */
let HEAVY_RAW = 30e6;
/** tests: a lower bar (test files are smaller) */
export function setHeavyRaw(n: number) { HEAVY_RAW = n; }
function mergeHeavyPages(o: Open, fileSize: number): number {
  // (a smaller file can't hold such a page: no page is even looked at - each look reads an object)
  if (!mergeContent || fileSize < HEAVY_RAW) return 0;
  let changed = 0;
  /** pages sharing their content (one stream for several pages): merged once */
  const done = new Map<string, mupdf.PDFObject>();
  for (let i = 0, n = o.doc.countPages(); i < n; i++) if (mergePage(o, i, false, done)) changed++;
  if (changed) { o.changedContent = true; o.merged = changed; }
  return changed;
}
/** merge one page's strokes; true if its content was replaced */
function mergePage(o: Open, i: number, force: boolean, done: Map<string, mupdf.PDFObject>): boolean {
  try {
    const po = o.doc.findPage(i);
    const c = po.get('Contents');
    const list = c.isArray() ? [...Array(c.length).keys()].map((k) => c.get(k)) : [c];
    let total = 0;
    for (const s of list) { const l = s.get('Length'); if (l.isNumber()) total += l.asNumber(); }
    if (!force && total <= HEAVY_RAW) return false;
    const key = list.map((s) => (s.isIndirect() ? s.asIndirect() : -1)).join(',');
    if (done.has(key)) { po.put('Contents', done.get(key)!); return true; }
    if (list.some((s) => !s.isStream() || !s.get('GCCMerged').isNull())) return false;
    if (!opaqueStates(po)) return false;
    // every part Flate-compressed (as such files are); the parts are one content together - a
    // path can begin in one and be stroked in the next, so they are merged as one
    const flate = (s: mupdf.PDFObject) => { const f = s.get('Filter'); const nm = f.isName() ? f.asName() : f.isArray() && f.length === 1 && f.get(0).isName() ? f.get(0).asName() : ''; return nm === 'FlateDecode' && s.get('DecodeParms').isNull(); };
    if (!list.every(flate)) return false;
    const raws = list.map((s) => s.readRawStream());
    let out: Uint8Array | null = null;
    try { out = mergeContent!(raws.map((r) => r.asUint8Array()), force); } finally { for (const r of raws) r.destroy?.(); }
    if (!out) return false;
    const d = o.doc.newDictionary();
    d.put('Filter', o.doc.newName('FlateDecode'));
    d.put('GCCMerged', true);
    const ref = o.doc.addRawStream(out, d);
    po.put('Contents', ref);
    done.set(key, ref);
    return true;
  } catch { return false; /* left as it is */ }
}
/**
 * A page that took the drawing engines down (out of memory): its line work simplified on request
 * (one undo step). Throws when there's nothing to simplify (no runs of strokes, transparency...).
 */
export function simplifyPage(id: string, page: number): boolean {
  const o = O(id);
  return op(o, 'Simplify line work', 'c', () => {
    const done = new Map<string, mupdf.PDFObject>();
    if (!mergeContent || !mergePage(o, page, true, done)) throw new Error("This page's drawing can't be simplified (it isn't made of separate line pieces).");
    // other pages showing the same content (one stream for several pages) get the simplified one too
    const keyOf = (po: mupdf.PDFObject) => { const c = po.get('Contents'); return (c.isArray() ? [...Array(c.length).keys()].map((k) => c.get(k)) : [c]).map((x) => (x.isIndirect() ? x.asIndirect() : -1)).join(','); };
    for (let i = 0, n = o.doc.countPages(); i < n && done.size; i++) if (i !== page) { try { const po = o.doc.findPage(i); const r = done.get(keyOf(po)); if (r) po.put('Contents', r); } catch { /* left as it is */ } }
    o.merged = (o.merged ?? 0) + 1;
    o.changedContent = true;
    return true;
  });
}
/** no transparency / blend modes / soft masks in the page's graphics states */
function opaqueStates(po: mupdf.PDFObject): boolean {
  const gs = po.getInheritable('Resources').get('ExtGState');
  if (!gs.isDictionary()) return true;
  let ok = true;
  gs.forEach((v: mupdf.PDFObject) => {
    const g = v.resolve();
    if (!g.isDictionary()) return;
    for (const k of ['CA', 'ca']) { const a = g.get(k); if (a.isNumber() && a.asNumber() < 1) ok = false; }
    const bm = g.get('BM'); if (!bm.isNull() && !(bm.isName() && bm.asName() === 'Normal')) ok = false;
    const sm = g.get('SMask'); if (!sm.isNull() && !(sm.isName() && sm.asName() === 'None')) ok = false;
  });
  return ok;
}

export function setAuthor(id: string, author: string) { O(id).author = author; }
/** the file an open document reads from (engine host only) */
export function readerOf(id: string): Reader | null { return docs.get(id)?.reader ?? null; }

export function close(id: string) {
  const o = docs.get(id);
  if (!o) return;
  o.pages.clear();
  try { o.doc.destroy?.(); } catch { /* ignore */ }
  o.reader?.close();
  docs.delete(id);
}

/** one page's size (as shown), rotation and label */
function info1(o: Open, i: number): PageInfo {
  const p = o.doc.loadPage(i) as mupdf.PDFPage;
  const b = p.getBounds();
  const rot = p.getObject().getInheritable('Rotate').asNumber() || 0;
  const label = hasLabels(o) ? p.getLabel() : '';
  p.destroy?.();
  return { w: b[2] - b[0], h: b[3] - b[1], rot: ((rot % 360) + 360) % 360, label: label || String(i + 1) };
}
/** the file has its own page labels (i, ii, A-1...) - otherwise a page's label is its number */
const hasLabels = (o: Open) => !o.doc.getTrailer().get('Root', 'PageLabels').isNull();

function computeInfos(o: Open): PageInfo[] {
  const n = o.doc.countPages();
  const out: PageInfo[] = [];
  for (let i = 0; i < n; i++) out.push(info1(o, i));
  return out;
}
/** read from the file again, ignoring the cache (tests check the cache against it) */
export function freshPageInfos(id: string): PageInfo[] { return computeInfos(O(id)); }
export function pageInfos(o: Open | string): PageInfo[] {
  if (typeof o === 'string') o = O(o);
  if (!o.infos || o.infos.length !== o.doc.countPages()) o.infos = computeInfos(o);
  return o.infos;
}
/** after pages were added, removed or reordered: labels follow the new positions */
function relabel(o: Open, list: PageInfo[]): PageInfo[] {
  if (hasLabels(o)) return computeInfos(o);
  return list.map((x, i) => ({ ...x, label: String(i + 1) }));
}

/**
 * Page labels across a change to the page list. MuPDF's rearrangePages drops /PageLabels
 * outside its undo journal (a spec's "i, ii, 1, 2..." was lost for good, even after Undo) and
 * insertPage invents labels for files that have none ("1, 1, 2, 3..."). So the labels are taken
 * out first (an undoable change), and written back for the new order afterwards.
 */
function keepLabels<T>(o: Open, newOrder: (old: string[]) => (string | null)[], fn: () => T): T {
  const root = o.doc.getTrailer().get('Root');
  const had = !root.get('PageLabels').isNull();
  const old = had ? pageInfos(o).map((x) => x.label) : [];
  if (had) root.delete('PageLabels');
  const r = fn();
  if (!root.get('PageLabels').isNull()) root.delete('PageLabels'); // made up by MuPDF
  if (had) writeLabels(o, newOrder(old));
  return r;
}
const ROMAN: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
const toRoman = (n: number) => { let s = ''; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; };
function fromRoman(s: string): number { let n = 0, i = 0; for (const [v, r] of ROMAN) while (s.startsWith(r, i)) { n += v; i += r.length; } return i === s.length && toRoman(n) === s ? n : 0; }
/** labels as a /PageLabels number tree, in ranges where they run on (1, 2, 3 / i, ii / A-1, A-2) */
function writeLabels(o: { doc: mupdf.PDFDocument }, labels: (string | null)[]) {
  const n = o.doc.countPages();
  type L = { p: string; s: '' | 'D' | 'r' | 'R'; v: number };
  const parse = (t: string): L => {
    const m = /^(.*?)(\d+)$/.exec(t);
    if (m && !/^0\d/.test(m[2])) return { p: m[1], s: 'D', v: Number(m[2]) };
    if (/^[ivxlcdm]+$/.test(t) && fromRoman(t)) return { p: '', s: 'r', v: fromRoman(t) };
    if (/^[IVXLCDM]+$/.test(t) && fromRoman(t.toLowerCase())) return { p: '', s: 'R', v: fromRoman(t.toLowerCase()) };
    return { p: t, s: '', v: 0 };
  };
  const nums = o.doc.newArray();
  let prev: L | null = null;
  for (let i = 0; i < n; i++) {
    // a page added (no label of its own) runs on in the range of the page before it, as in other PDF
    // programs: a blank page inserted after "ii" is "iii" (it was given its position, "3", and a
    // later page was "3" too); before any labelled page: its position
    const t = labels[i];
    if (t == null && prev) { const q: L = prev; if (q.s) prev = { p: q.p, s: q.s, v: q.v + 1 }; continue; }
    const L = parse(t ?? String(i + 1));
    if (prev && L.s && L.s === prev.s && L.p === prev.p && L.v === prev.v + 1) { prev = L; continue; }
    const d = o.doc.newDictionary();
    if (L.s) d.put('S', o.doc.newName(L.s));
    if (L.p) d.put('P', o.doc.newString(L.p));
    if (L.s && L.v !== 1) d.put('St', L.v);
    nums.push(i);
    nums.push(d);
    prev = L;
  }
  const pl = o.doc.newDictionary();
  pl.put('Nums', nums);
  o.doc.getTrailer().get('Root').put('PageLabels', o.doc.addObject(pl));
}

export function countPages(id: string) { return O(id).doc.countPages(); }

// ---------------------------------------------------------------- journal

/**
 * Our steps in MuPDF's undo journal are marked; MuPDF adds steps of its own (an incremental
 * save of a file that was already saved incrementally once - by us or another program - records a
 * "Save document" step). Those are passed over by undo/redo; otherwise undo would undo the
 * save's bookkeeping instead of the user's last change (and the markup would stay).
 */
const OURS = '\u0001';
/** where the journal is (its position; a new step moves it on) */
function journalAt(o: Open): { position: number; length: number } {
  try { const j = journalOf(o); return { position: j.position, length: j.length }; } catch { return { position: -1, length: -1 }; }
}
/** the journal: where it is, how many steps, and a step's name when asked (each name is found by
 *  walking MuPDF's list of steps from the start) */
function journalOf(o: Open): { position: number; length: number; step(i: number): string | undefined } {
  const p = (o.doc as unknown as { pointer?: number }).pointer;
  if (rawJournal && typeof p === 'number') {
    const r = rawJournal;
    const length = r._wasm_pdf_undoredo_state_count(p);
    return { position: r._wasm_pdf_undoredo_state_position(p), length, step: (i) => (i >= 0 && i < length ? r.UTF8ToString(r._wasm_pdf_undoredo_step(p, i)) : undefined) };
  }
  const j = o.doc.getJournal();
  return { position: j.position, length: j.steps.length, step: (i) => j.steps[i] };
}
/** MuPDF's own journal functions, reachable when mupdf-pre.mjs loaded before MuPDF.js (see there) */
type RawJournal = { _wasm_pdf_undoredo_state_position(p: number): number; _wasm_pdf_undoredo_state_count(p: number): number; _wasm_pdf_undoredo_step(p: number, i: number): number; UTF8ToString(p: number): string };
const rawJournal: RawJournal | null = (() => {
  const m = (globalThis as { $libmupdf_wasm_Module?: Partial<RawJournal> }).$libmupdf_wasm_Module;
  return m && typeof m._wasm_pdf_undoredo_state_position === 'function' && typeof m._wasm_pdf_undoredo_state_count === 'function' && typeof m._wasm_pdf_undoredo_step === 'function' && typeof m.UTF8ToString === 'function' ? (m as RawJournal) : null;
})();
/** the quick way to read the journal is in use (tests check the engine has it) */
export function journalFast(): boolean { return !!rawJournal; }
/** (tests) the journal read both ways: they must agree */
export function journalBothWays(id: string) {
  const o = O(id);
  const q = journalOf(o), j = o.doc.getJournal();
  return { quick: { position: q.position, steps: [...Array(q.length).keys()].map((i) => q.step(i)) }, slow: { position: j.position, steps: j.steps } };
}
const ours = (step: string | undefined) => !!step && step.startsWith(OURS);

/** kind: a = markups, c = pages (content, page list), m = bookmarks only */
function op<T>(o: Open, name: string, kind: 'a' | 'c' | 'm', fn: () => T, join = false): T {
  const before = kind === 'c' ? pageInfos(o) : undefined;
  const j0 = journalAt(o);
  // (an operation that adds no step leaves nothing for noteChange to write to)
  o.lastEntry = null;
  // (opMore cuts only an operation at the top: '' = inside another one, left whole)
  const outer = o.opName;
  o.opName = (outer === undefined || outer === null) && j0.position >= 0 ? OURS + name : '';
  o.doc.beginOperation(OURS + name);
  try {
    const r = fn();
    o.doc.endOperation();
    o.opName = outer;
    // MuPDF drops an operation that changed nothing (moving nothing, deleting only locked
    // markups): recording it anyway made the next Undo undo the change before it
    const j1 = journalAt(o);
    if (j0.position >= 0 && j1.position === j0.position) { if (j1.length < j0.length) o.redo = []; return r; }
    // (cut into several journal steps by opMore: all undone and redone together)
    const parts = j0.position >= 0 && j1.position > j0.position ? j1.position - j0.position : 1;
    // (a later part of the same step: undone and redone with it)
    const last = o.undo[o.undo.length - 1];
    if (join && last) { last.parts = (last.parts || 1) + parts; if (kind === 'c') { last.after = pageInfos(o); o.changedContent = true; } o.redo = []; o.lastEntry = last; return r; }
    const entry: Entry = { name, kind, before, after: kind === 'c' ? pageInfos(o) : undefined };
    if (parts > 1) entry.parts = parts;
    o.undo.push(entry);
    o.lastEntry = entry;
    o.redo = [];
    if (kind === 'c') o.changedContent = true;
    return r;
  } catch (e) {
    try { o.doc.abandonOperation(); } catch { /* journal already closed */ }
    o.opName = outer;
    // (the parts opMore already closed: taken back too, the file as it was)
    try { for (let n = 0; n < 100000 && j0.position >= 0 && journalAt(o).position > j0.position && o.doc.canUndo(); n++) o.doc.undo(); } catch { /* as far as it goes */ }
    // (MuPDF dropped the steps that could be redone when the operation began - and now holds the
    // parts just taken back there: Redo must not redo those, nor be offered)
    if (journalAt(o).length !== j0.length) o.redo = [];
    resetPages(o);
    o.fonts.clear();
    o.infos = before;
    throw e;
  }
}

/**
 * MuPDF's undo journal looks every changed or new object up in a list kept per step, so one step
 * that touches thousands of objects slows down with the square of its size: 1,500 pages inserted
 * from another file took 11 s, 0.4 s in steps of 100 pages. Long work calls this every so often:
 * the step is closed and a new one begun - undone and redone together as one (op counts them).
 * Only at the top level of an operation (inside a nested one the outer step stays whole).
 */
function opMore(o: Open) {
  if (!o.opName) return;
  o.doc.endOperation();
  o.doc.beginOperation(o.opName);
}

/** what a page operation changed (the app redraws only that after undo/redo) - kept with the step.
 *  Only on the step the last operation added: one that changed nothing (marks on no pages) added
 *  none, and its note overwrote the step before - whose undo then redrew nothing */
export function noteChange(id: string, change: unknown) { const o = O(id); const e = o.undo[o.undo.length - 1]; if (e && e === o.lastEntry) e.change = change; }

export interface UndoResult { ok: boolean; kind: 'a' | 'c' | 'm'; name: string; pages: PageInfo[] | null; change?: unknown; dir?: 'undo' | 'redo' }
export function undo(id: string): UndoResult {
  const o = O(id);
  o.lastEntry = null;
  // (out of step with MuPDF's journal: nothing more can be undone - say so, not "Undo" forever)
  if (!o.doc.canUndo() || !o.undo.length) { o.undo = []; return { ok: false, kind: 'a', name: '', pages: null }; }
  const e = o.undo.pop()!;
  for (let part = 0; part < (e.parts || 1); part++) {
    const j = journalOf(o);
    let pos = j.position;
    while (pos > 0 && !ours(j.step(pos - 1))) { o.doc.undo(); pos--; }
    if (!o.doc.canUndo()) break;
    o.doc.undo();
  }
  o.redo.push(e);
  resetPages(o);
  // fonts made by an operation that is undone no longer exist: never reuse a cached one
  o.fonts.clear();
  if (e.kind === 'c') o.infos = e.before ?? computeInfos(o);
  return { ok: true, kind: e.kind, name: e.name, pages: e.kind === 'c' ? pageInfos(o) : null, change: e.change, dir: 'undo' };
}
export function redo(id: string): UndoResult {
  const o = O(id);
  o.lastEntry = null;
  if (!o.doc.canRedo() || !o.redo.length) { o.redo = []; return { ok: false, kind: 'a', name: '', pages: null }; }
  const e = o.redo.pop()!;
  for (let part = 0; part < (e.parts || 1); part++) {
    const j = journalOf(o);
    let pos = j.position;
    while (pos < j.length && !ours(j.step(pos))) { o.doc.redo(); pos++; }
    if (!o.doc.canRedo()) break;
    o.doc.redo();
    pos++;
    while (pos < j.length && !ours(j.step(pos))) { o.doc.redo(); pos++; }
  }
  o.undo.push(e);
  resetPages(o);
  // fonts made by an operation that is undone no longer exist: never reuse a cached one
  o.fonts.clear();
  if (e.kind === 'c') o.infos = e.after ?? computeInfos(o);
  return { ok: true, kind: e.kind, name: e.name, pages: e.kind === 'c' ? pageInfos(o) : null, change: e.change, dir: 'redo' };
}
export function history(id: string) {
  const o = O(id);
  return { undo: o.undo.map((e) => e.name), redo: o.redo.map((e) => e.name) };
}

// ---------------------------------------------------------------- annotations: read

const num = (o: mupdf.PDFObject) => { try { return o.isNull() ? null : o.asNumber(); } catch { return null; } };

function color(c: unknown): number[] | null {
  if (!c || !Array.isArray(c) || !c.length) return null;
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 4) return [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])];
  return c as number[];
}

function readAnnot(a: mupdf.PDFAnnotation, page: number, o: Open): AnnotData {
  const obj = a.getObject();
  const type = a.getType();
  const flags = a.getFlags();
  const d: AnnotData = {
    id: obj.asIndirect(),
    page,
    type,
    ...(type === 'Stamp' && !obj.get('GCCDesign').isNull() ? { designed: true } : {}),
    rect: (a.hasRect() ? a.getRect() : a.getBounds()) as Rect,
    color: null,
    ic: null,
    opacity: 1,
    bw: 1,
    dash: false,
    cloudy: 0,
    contents: '',
    author: '',
    subject: '',
    modified: null,
    created: null,
    locked: (flags & LOCKED) !== 0,
    hidden: (flags & HIDDEN) !== 0,
  };
  try { d.color = color(a.getColor()); } catch { /* none */ }
  try { if (a.hasInteriorColor()) d.ic = color(a.getInteriorColor()); } catch { /* none */ }
  try { d.opacity = a.getOpacity(); } catch { /* none */ }
  try { if (a.hasBorder()) { d.bw = a.getBorderWidth(); d.dash = a.getBorderStyle() === 'Dashed'; } } catch { /* none */ }
  try { if (a.hasBorderEffect() && a.getBorderEffect() === 'Cloudy') d.cloudy = a.getBorderEffectIntensity() || 1; } catch { /* none */ }
  try { d.contents = a.getContents() || ''; } catch { /* none */ }
  try { if (a.hasAuthor()) d.author = a.getAuthor() || ''; } catch { /* none */ }
  try { if (a.hasSubject()) d.subject = a.getSubject() || ''; } catch { /* none */ }
  try { const m = a.getModificationDate(); d.modified = m ? m.getTime() : null; } catch { /* none */ }
  try { const m = a.getCreationDate(); d.created = m ? m.getTime() : null; } catch { /* none */ }
  try { if (a.hasIcon()) d.icon = a.getIcon(); } catch { /* none */ }
  try { if (a.hasQuadPoints()) d.quads = a.getQuadPoints().map((q) => Array.from(q)); } catch { /* none */ }
  try { if (a.hasVertices()) d.vertices = a.getVertices().map((p) => [p[0], p[1]] as Pt); } catch { /* none */ }
  try { if (a.hasLine()) d.line = a.getLine().map((p) => [p[0], p[1]] as Pt); } catch { /* none */ }
  try { if (a.hasInkList()) d.ink = a.getInkList().map((s) => s.map((p) => [p[0], p[1]] as Pt)); } catch { /* none */ }
  try { if (a.hasLineEndingStyles()) { const l = a.getLineEndingStyles(); d.le = [l.start, l.end]; } } catch { /* none */ }
  { const c = calloutOf(o, a); if (c.length) d.callout = c; }
  // (read from the object: getIntent() throws for most markup types - see mupdf-guard.ts)
  { const it = obj.get('IT'); if (it.isName()) d.intent = it.asName(); }
  if (type === 'FreeText') {
    if (adoptable(a) || keepsLook(a)) { try { const f = foreignStyleCached(o, a); d.font = { size: f.size, color: f.color, family: f.family, ...(f.bold ? { bold: true } : {}), ...(f.italic ? { italic: true } : {}) }; } catch { /* none */ } }
    else try { const da = a.getDefaultAppearance(); const st = ftStyle(a); d.font = { size: da.size, color: color(da.color) || [0, 0, 0], family: st.family, ...(st.bold ? { bold: true } : {}), ...(st.italic ? { italic: true } : {}) }; } catch { /* none */ }
    { const r = adoptable(a) || keepsLook(a) ? foreignRuns(o, a) : ownRuns(a); if (r) d.runs = r; }
    try { d.quadding = a.getQuadding(); } catch { /* none */ }
    { const aw = obj.get('GCCAuto'); if (aw.isNumber() && aw.asNumber() > 0) d.autoWidth = aw.asNumber(); }
  }
  try { const irt = obj.get('IRT'); if (!irt.isNull()) d.irt = irt.asIndirect(); } catch { /* none */ }
  // (text strings; files saved by 0.5.0 and earlier have them as names)
  try { const st = textOf(obj.get('State')); if (st) d.state = st; } catch { /* none */ }
  try { const k = obj.get('GCCKind'); if (!k.isNull()) d.kind = k.asName(); } catch { /* none */ }
  try { const g = textOf(obj.get('GCCGroup')); if (g) d.group = g; } catch { /* none */ }
  try { const f = obj.get('GCCFmt'); if (f.isString()) d.fmt = JSON.parse(f.asString()); } catch { /* none */ }
  try { const z = obj.get('GCCSize'); if (z.isNumber()) d.labelSize = z.asNumber(); } catch { /* none */ }
  try { const l = obj.get('GCCLabel'); if (l.isName() && l.asName() === 'auto') d.autoLabel = true; } catch { /* none */ }
  try { const g = obj.get('GCCAngle'); if (!g.isNull()) { d.angle = g.asNumber(); d.box = arr(obj.get('GCCBox'), d.rect) as Rect; } } catch { /* none */ }
  if (type === 'Widget') d.field = readField(a as unknown as mupdf.PDFWidget);
  if (type === 'Redact') d.redactFill = redactFillOf(a);
  return d;
}

/** a text value that may be stored as a string or (older files) as a name */
function textOf(v: mupdf.PDFObject): string {
  return v.isString() ? v.asString() : v.isName() ? v.asName() : '';
}

/**
 * A callout's line (tip, knee, end at the box) in page space. Read from the /CL entry itself:
 * mupdf.js 1.28's getCalloutLine() reads the points from the wrong memory offsets (a 3-point
 * line came back as [p0, (p0.y, p1.x), (p1.x, p1.y)]) - moving a callout then sent its arrow off
 * somewhere else entirely.
 */
function calloutOf(o: Open, a: mupdf.PDFAnnotation): Pt[] {
  // (MuPDF gives every new FreeText a CL from the page corner: only a callout's counts)
  const it = a.getObject().get('IT');
  if (!it.isName() || it.asName() !== 'FreeTextCallout') return [];
  const cl = a.getObject().get('CL');
  if (!cl.isArray() || cl.length < 4) return [];
  const v = arr(cl, []);
  const C = pageCtmOf(o, a);
  const out: Pt[] = [];
  for (let i = 0; i + 1 < v.length && out.length < 3; i += 2) out.push([C[0] * v[i] + C[2] * v[i + 1] + C[4], C[1] * v[i] + C[3] * v[i + 1] + C[5]]);
  return out;
}

/**
 * Write a callout's line (points as shown). MuPDF's own conversion is wrong on pages turned 270
 * degrees - the line landed hundreds of points off the page - so /CL is written through the page
 * matrix that calloutOf reads it back with.
 */
function setCallout(o: Open, a: mupdf.PDFAnnotation, pts: Pt[]) {
  a.setCalloutLine(pts as unknown as mupdf.Point[]);
  const Ci = mupdf.Matrix.invert(pageCtmOf(o, a) as unknown as mupdf.Matrix) as unknown as number[];
  a.getObject().put('CL', pts.flatMap(([x, y]) => [+(Ci[0] * x + Ci[2] * y + Ci[4]).toFixed(3), +(Ci[1] * x + Ci[3] * y + Ci[5]).toFixed(3)]));
}

/** a text box's new box; a callout's tip read before (MuPDF garbles the line on 270-degree pages) */
function boxKeepTip(o: Open, a: mupdf.PDFAnnotation, r: number[]) {
  const cl = calloutOf(o, a);
  a.setRect(r as Rect);
  if (cl.length) setCallout(o, a, calloutPath(a.getRect() as Rect, cl[0]));
}

/**
 * A callout's line: from its tip to the side of the text box nearest to it, with an 18 pt knee.
 * Worked out again whenever the box or the tip moves - the tip stays where it points.
 */
/** a box with its corners in order (x0 < x1, y0 < y1) */
const ordered = (r: number[]): Rect => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];

export function calloutPath(b: Rect, tip: Pt): Pt[] {
  const [x0, y0, x1, y1] = b;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let att: Pt, knee: Pt;
  if (tip[0] < x0 - 4) { att = [x0, cy]; knee = [x0 - 18, cy]; }
  else if (tip[0] > x1 + 4) { att = [x1, cy]; knee = [x1 + 18, cy]; }
  else if (tip[1] < y0) { att = [cx, y0]; knee = [cx, y0 - 18]; }
  else { att = [cx, y1]; knee = [cx, y1 + 18]; }
  // a tip closer than the knee: straight line
  if (Math.hypot(tip[0] - att[0], tip[1] - att[1]) < 24) return [tip, att];
  return [tip, knee, att];
}

/** the box a redaction mark leaves: black unless set (GCCFill: [r g b], /Auto or /None) */
function redactFillOf(a: mupdf.PDFAnnotation): number[] | 'auto' | 'none' {
  const f = a.getObject().get('GCCFill');
  if (f.isName()) return f.asName() === 'Auto' ? 'auto' : 'none';
  if (f.isArray()) return arr(f, [0, 0, 0]);
  return [0, 0, 0];
}

/**
 * The colour of the page around a box (for redaction boxes that blend in): the page drawn
 * small around it, and the commonest colour of the ring just outside it.
 */
function colourAround(p: mupdf.PDFPage, r: Rect): number[] {
  const pad = 4, s = 2;
  const x0 = Math.floor((r[0] - pad) * s), y0 = Math.floor((r[1] - pad) * s), x1 = Math.ceil((r[2] + pad) * s), y1 = Math.ceil((r[3] + pad) * s);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [x0, y0, x1, y1], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  try { p.runPageContents(dev, mupdf.Matrix.scale(s, s)); } finally { dev.close(); }
  const px = pix.getPixels(), w = x1 - x0, h = y1 - y0;
  // commonest colour (in buckets), then the exact average of that bucket
  const count = new Map<number, number[]>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = x >= pad * s && x < w - pad * s && y >= pad * s && y < h - pad * s;
    if (inside) continue;
    const i = (y * w + x) * 3;
    const key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
    const c = count.get(key) || [0, 0, 0, 0];
    c[0]++; c[1] += px[i]; c[2] += px[i + 1]; c[3] += px[i + 2];
    count.set(key, c);
  }
  dev.destroy?.(); pix.destroy?.();
  let best: number[] = [1, 255, 255, 255];
  for (const c of count.values()) if (c[0] > best[0]) best = c;
  return [best[1] / best[0] / 255, best[2] / best[0] / 255, best[3] / best[0] / 255];
}

function readField(w: mupdf.PDFWidget): FieldData {
  const f: FieldData = { name: '', ftype: '', value: '', readOnly: false, multiline: false };
  try { f.name = w.getName(); } catch { /* none */ }
  try { f.ftype = w.getFieldType(); } catch { /* none */ }
  try { f.value = w.getValue(); } catch { /* none */ }
  try { f.readOnly = w.isReadOnly(); } catch { /* none */ }
  try { f.multiline = w.isMultiline(); } catch { /* none */ }
  try {
    if (w.isChoice()) {
      // options as shown; the field keeps the option's export value (/Opt pairs), shown here as
      // its label
      const shown = w.getOptions(false), kept = w.getOptions(true);
      f.options = shown;
      const k = kept.indexOf(f.value);
      if (k >= 0 && shown[k] != null) f.value = shown[k];
      // a list with several options chosen: shown as a list, and left alone here (changing it
      // through a single choice dropped every other selection)
      const v = fieldOf(w.getObject()).getInheritable('V');
      if (v.isArray() && v.length > 1) {
        const vals: string[] = [];
        v.forEach((x: mupdf.PDFObject) => { const s = textOf(x); const i = kept.indexOf(s); vals.push(i >= 0 && shown[i] != null ? shown[i] : s); });
        f.value = vals.join(', ');
        f.readOnly = true;
      }
    }
  } catch { /* none */ }
  // a check box / radio button is on when its OWN state (/AS) is - the value is the whole group's
  // (every option of a radio group read as chosen)
  try { if (w.isCheckbox() || w.isRadioButton()) f.checked = widgetOn(w); } catch { /* none */ }
  try { if (w.isText()) { const m = w.getMaxLen(); if (m > 0) f.maxLen = m; } } catch { /* none */ }
  return f;
}
/** a check box / radio button's own state is on */
function widgetOn(w: mupdf.PDFWidget): boolean {
  const as = w.getObject().get('AS');
  return as.isName() && as.asName() !== 'Off';
}
/** the field dictionary a widget belongs to (the widget itself when it is a whole field) */
function fieldOf(obj: mupdf.PDFObject): mupdf.PDFObject {
  let f = obj;
  for (let k = 0; k < 32 && f.get('T').isNull() && f.get('Parent').isDictionary(); k++) f = f.get('Parent');
  return f;
}

/** markups on one page (links and popups left out; replies included) */
export function annots(id: string, page: number): AnnotData[] {
  const o = O(id);
  const p = pg(o, page);
  const out: AnnotData[] = [];
  for (const a of p.getAnnotations()) {
    const t = a.getType();
    if (t === 'Popup' || t === 'Link') continue;
    try { out.push(readAnnot(a, page, o)); } catch { /* skip a broken one */ }
  }
  for (const w of p.getWidgets()) {
    try { out.push(readAnnot(w as unknown as mupdf.PDFAnnotation, page, o)); } catch { /* skip */ }
  }
  return out;
}

/** markups on every page (for the comments organizer) */
export function allAnnots(id: string): AnnotData[] {
  const o = O(id);
  const out: AnnotData[] = [];
  const n = o.doc.countPages();
  for (let i = 0; i < n; i++) {
    const p = pg(o, i);
    for (const a of p.getAnnotations()) {
      const t = a.getType();
      if (t === 'Popup' || t === 'Link') continue;
      try { out.push(readAnnot(a, i, o)); } catch { /* skip */ }
    }
  }
  return out;
}

/** find a markup to change (inside an operation): markups from some programs have no /P - it is
 *  set, or a turn was worked out in the page's own upside-down space (their text turned the other
 *  way round to its frame) */
function findToChange(o: Open, page: number, aid: number): mupdf.PDFAnnotation {
  const a = find(o, page, aid);
  const obj = a.getObject();
  if (obj.get('P').isNull()) obj.put('P', pg(o, page).getObject());
  return a;
}
function find(o: Open, page: number, aid: number): mupdf.PDFAnnotation {
  const p = pg(o, page);
  for (const a of p.getAnnotations()) if (a.getObject().asIndirect() === aid) return a;
  for (const w of p.getWidgets()) if (w.getObject().asIndirect() === aid) return w as unknown as mupdf.PDFAnnotation;
  throw new Error('That markup no longer exists');
}

// ---------------------------------------------------------------- annotations: draw

/**
 * Draw the markups + form fields of a page (transparent background) for one tile.
 * scale = device px per point; (x, y, w, h) = tile in device px. `hide` = markups being
 * dragged right now (drawn by the interface instead).
 */
const MULTIPLY = new Set(['Highlight']);
/**
 * pass 'hl' = highlighter markups only (shown with multiply blending, like a real
 * highlighter: the text stays readable); pass 'rest' = everything else, form fields included.
 */
export function renderAnnots(id: string, page: number, scale: number, x: number, y: number, w: number, h: number, hide: number[] = [], pass: 'hl' | 'rest' | 'all' = 'all'): Uint8ClampedArray | null {
  const o = O(id);
  const p = pg(o, page);
  const list = p.getAnnotations();
  const widgets = pass === 'hl' ? [] : p.getWidgets();
  const mine = (a: mupdf.PDFAnnotation) => pass === 'all' || (pass === 'hl') === MULTIPLY.has(a.getType());
  if (!list.some(mine) && !widgets.length) return null;
  const hidden: mupdf.PDFAnnotation[] = [];
  for (const a of [...list, ...(widgets as unknown as mupdf.PDFAnnotation[])]) {
    if ((hide.length && hide.includes(a.getObject().asIndirect())) || !mine(a)) {
      if (!a.getHiddenForEditing()) { a.setHiddenForEditing(true); hidden.push(a); }
    }
  }
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [Math.round(x), Math.round(y), Math.round(x) + w, Math.round(y) + h], true);
  pix.clear();
  const m = mupdf.Matrix.scale(scale, scale);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  try {
    p.runPageAnnots(dev, m);
    if (pass !== 'hl') p.runPageWidgets(dev, m);
  } finally {
    dev.close();
    for (const a of hidden) a.setHiddenForEditing(false);
  }
  const px = pix.getPixels();
  // MuPDF gives premultiplied RGBA; canvas ImageData wants straight alpha
  const out = new Uint8ClampedArray(px.length);
  let any = false;
  for (let i = 0; i < px.length; i += 4) {
    const al = px[i + 3];
    if (!al) continue;
    any = true;
    if (al === 255) { out[i] = px[i]; out[i + 1] = px[i + 1]; out[i + 2] = px[i + 2]; out[i + 3] = 255; continue; }
    out[i] = (px[i] * 255) / al; out[i + 1] = (px[i + 1] * 255) / al; out[i + 2] = (px[i + 2] * 255) / al; out[i + 3] = al;
  }
  dev.destroy?.();
  pix.destroy?.();
  return any ? out : null;
}

/** one markup alone (for smooth dragging in the interface) */
export function renderOne(id: string, page: number, aid: number, scale: number): { px: Uint8ClampedArray; x: number; y: number; w: number; h: number } | null {
  const o = O(id);
  const a = find(o, page, aid);
  const b = a.getBounds();
  const x = Math.floor(b[0] * scale) - 2, y = Math.floor(b[1] * scale) - 2;
  const w = Math.min(4096, Math.ceil(b[2] * scale) + 2 - x), h = Math.min(4096, Math.ceil(b[3] * scale) + 2 - y);
  if (w <= 0 || h <= 0) return null;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [x, y, x + w, y + h], true);
  pix.clear();
  const m = mupdf.Matrix.scale(scale, scale);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  try { a.run(dev, m); } finally { dev.close(); }
  const px = pix.getPixels();
  const out = new Uint8ClampedArray(px.length);
  for (let i = 0; i < px.length; i += 4) {
    const al = px[i + 3];
    if (!al) continue;
    out[i] = (px[i] * 255) / al; out[i + 1] = (px[i + 1] * 255) / al; out[i + 2] = (px[i + 2] * 255) / al; out[i + 3] = al;
  }
  // (freed now: MuPDF memory is not seen by JavaScript's garbage collector)
  dev.destroy?.();
  pix.destroy?.();
  return { px: out, x, y, w, h };
}

// ---------------------------------------------------------------- annotations: change

/** a measurement's number format (see ui/geom.ts MeasureFmt) */
export interface MeasureFmtData { unit?: 'auto' | 'm' | 'mm'; dm?: number; dmm?: number; da?: number; din?: number; legacy?: boolean }

export interface AnnotSpec {
  type: mupdf.PDFAnnotationType;
  rect?: Rect;
  color?: number[] | null;
  ic?: number[] | null;
  opacity?: number;
  bw?: number;
  dash?: boolean;
  cloudy?: number;
  contents?: string;
  subject?: string;
  icon?: string;
  quads?: number[][];
  vertices?: Pt[];
  line?: Pt[];
  ink?: Pt[][];
  le?: [string, string];
  callout?: Pt[];
  intent?: string;
  font?: TextFont;
  /** text box: its styled parts (null: all of it in the box's own style); sent with the text */
  runs?: TextRun[] | null;
  quadding?: number;
  /** text box: the box fits its text (width up to this many points, then it wraps) */
  autoWidth?: number | null;
  irt?: number;
  state?: string;
  kind?: string;
  locked?: boolean;
  hidden?: boolean;
  caption?: boolean;
  labelSize?: number;
  /** measurement: the label is the app's own number (see AnnotData.autoLabel) */
  autoLabel?: boolean;
  fmt?: MeasureFmtData | null;
  /** rotation, degrees clockwise as seen on screen (text boxes, stamps, shapes) */
  angle?: number;
  /** count markers: the count they belong to */
  group?: string;
  /** stamp: PNG/JPEG image bytes */
  image?: Uint8Array;
  /** stamp: drawn stamp design (ours) */
  design?: StampDesign;
  redactFill?: number[] | 'auto' | 'none';
}

/**
 * A text box made by another program: its drawing uses that program's fonts, often with letter
 * codes of their own - drawn again by MuPDF (from its rich text) the text came out garbled in the
 * page view ("Tower" -> "5PXFS").
 */
function notOurs(a: mupdf.PDFAnnotation): boolean {
  if (a.getType() !== 'FreeText') return false;
  const obj = a.getObject();
  return obj.get('GCCKind').isNull() && obj.get('GCCFont').isNull() && obj.get('GCCKeepLook').isNull() && obj.get('GCCRuns').isNull();
}
/** another program's box with its own drawing, never turned by us (0.5.0 turned such boxes after
 *  letting MuPDF redraw them - those are drawn again by this app instead) */
function foreignText(a: mupdf.PDFAnnotation): boolean {
  if (!notOurs(a)) return false;
  const obj = a.getObject();
  return obj.get('AP', 'N').isStream() && obj.get('GCCAngle').isNull();
}
/** another program's box that has anything of its own to read its look from (a new box of ours
 *  being made has none of these yet) */
function adoptable(a: mupdf.PDFAnnotation): boolean {
  if (!notOurs(a)) return false;
  const obj = a.getObject();
  return !obj.get('RC').isNull() || !obj.get('DS').isNull() || obj.get('AP', 'N').isStream();
}
/** its own drawing is kept (turned, faded) rather than drawn again */
function keepsLook(a: mupdf.PDFAnnotation): boolean { return a.getType() === 'FreeText' && !a.getObject().get('GCCKeepLook').isNull(); }

/** a text box's own style: its font, size, colour, bold, italic */
function baseOf(a: mupdf.PDFAnnotation): BaseStyle {
  const st = ftStyle(a);
  let size = 11, col = [0, 0, 0];
  try { const da = a.getDefaultAppearance(); size = da.size || 11; col = color(da.color) || [0, 0, 0]; } catch { /* default */ }
  return { family: st.family, size, color: col, bold: st.bold, italic: st.italic };
}
const sameBase = (x: BaseStyle, y: BaseStyle) => x.family === y.family && Math.abs(x.size - y.size) < 0.01 && x.bold === y.bold && x.italic === y.italic && x.color.length === y.color.length && x.color.every((v, i) => Math.abs(v - y.color[i]) < 0.002);
/** a text box's own style set (the built-in name stays in /DA: MuPDF draws the box with it, other
 *  programs fall back to it) */
function setBase(o: Open, a: mupdf.PDFAnnotation, b: BaseStyle) {
  const builtin = !!FT_FONT[b.family];
  a.setDefaultAppearance(builtin ? b.family : 'Helv', b.size, b.color as mupdf.AnnotColor);
  const fo = a.getObject();
  if (builtin) fo.delete('GCCFont'); else fo.put('GCCFont', o.doc.newString(b.family));
  if (b.bold) fo.put('GCCBold', true); else fo.delete('GCCBold');
  if (b.italic) fo.put('GCCItalic', true); else fo.delete('GCCItalic');
}

/** our own rich text: its runs, over the text as it is now (changed elsewhere: kept where it can be) */
function ownRuns(a: mupdf.PDFAnnotation, text?: string): TextRun[] | undefined {
  const g = a.getObject().get('GCCRuns');
  if (!g.isString()) return undefined;
  let rs: TextRun[];
  try { rs = cleanRuns(JSON.parse(g.asString())); } catch { return undefined; }
  if (!rs.length) return undefined;
  const t = text ?? (a.getContents() || '');
  return runsText(rs) === t ? rs : reflowRuns(rs, t);
}

/** our rich text written: /GCCRuns, and the standard /RC + /DS (other programs show and keep the
 *  formatting); none: all of it in the box's own style - saved exactly as before */
function writeRich(o: Open, a: mupdf.PDFAnnotation, runs: TextRun[] | undefined) {
  const obj = a.getObject();
  if (!runs) {
    if (!obj.get('GCCRuns').isNull()) { obj.delete('GCCRuns'); obj.delete('RC'); obj.delete('DS'); }
    return;
  }
  const b = baseOf(a);
  let q = 0;
  try { q = a.getQuadding(); } catch { /* left */ }
  obj.put('GCCRuns', o.doc.newString(JSON.stringify(runs)));
  obj.put('RC', o.doc.newString(toRC(b, runs, q)));
  obj.put('DS', o.doc.newString(toDS(b, q)));
}

/**
 * MuPDF drawing a markup again - a text box with rich text (ours) set aside meanwhile: MuPDF then
 * draws it from its rich text in its own way (fonts of its own, no Arabic), over ours.
 */
function updateQuiet(a: mupdf.PDFAnnotation) {
  const obj = a.getObject();
  if (a.getType() !== 'FreeText' || obj.get('GCCRuns').isNull()) { a.update(); return; }
  const rc = obj.get('RC'), ds = obj.get('DS');
  if (!rc.isNull()) obj.delete('RC');
  if (!ds.isNull()) obj.delete('DS');
  try { a.update(); }
  finally { if (!rc.isNull()) obj.put('RC', rc); if (!ds.isNull()) obj.put('DS', ds); }
}

/** another program's rich text as runs (kept per markup while its rich text and text don't change) */
const rcCache = new WeakMap<Open, Map<number, { k: string; v: TextRun[] | undefined }>>();
function foreignRuns(o: Open, a: mupdf.PDFAnnotation): TextRun[] | undefined {
  const obj = a.getObject();
  let x = '';
  try { const rc = obj.get('RC'); x = rc.isString() ? rc.asString() : rc.isStream() ? rc.readStream().asString() : ''; } catch { /* none */ }
  if (!x) return undefined;
  const text = a.getContents() || '';
  const k = x + '\u0000' + text;
  let m = rcCache.get(o);
  if (!m) { m = new Map(); rcCache.set(o, m); }
  const id = obj.asIndirect(), hit = m.get(id);
  if (hit && hit.k === k) return hit.v;
  let v: TextRun[] | undefined;
  try {
    const st = foreignStyleCached(o, a);
    const rs = fromRC(x, { family: st.family, size: st.size, color: st.color, bold: st.bold, italic: st.italic });
    // (its text as the rich text has it: the same words - line ends and spaces may differ)
    const norm = (t: string) => t.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (rs && norm(runsText(rs)) === norm(text)) v = reflowRuns(rs, text);
  } catch { v = undefined; }
  m.set(id, { k, v });
  return v;
}

/** a CSS colour (#f00, #ff1418, rgb(255,20,24)) as 0-1 RGB */
function cssColor(v: string): number[] | null {
  const h = /#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(v);
  if (h) { const x = h[1].length === 3 ? h[1].split('').map((c) => c + c).join('') : h[1]; return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255); }
  const r = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
  return r ? [r[1], r[2], r[3]].map((n) => Math.min(255, Number(n)) / 255) : null;
}

/**
 * The look of another program's text box as it shows: its rich text (first run) first, then its
 * style string, then the font its drawing uses, then its plain /DA (often without a colour).
 */
function foreignStyle(o: Open, a: mupdf.PDFAnnotation): { family: string; size: number; color: number[]; bold: boolean; italic: boolean } {
  const obj = a.getObject();
  type Css = { size: number; col: number[] | null; bold: boolean | null; italic: boolean | null; fam: string };
  const read = (css: string, into: Css) => {
    for (const decl of css.split(';')) {
      const k = decl.indexOf(':');
      if (k < 0) continue;
      const key = decl.slice(0, k).trim().toLowerCase(), v = decl.slice(k + 1).trim();
      if (key === 'font-size') { const m = /([\d.]+)\s*(pt|px)?/.exec(v); if (m && !into.size) into.size = Number(m[1]) * (m[2] === 'px' ? 0.75 : 1); }
      else if (key === 'font-weight') { if (into.bold === null) into.bold = /bold|[6-9]00/i.test(v); }
      else if (key === 'font-style') { if (into.italic === null) into.italic = /italic|oblique/i.test(v); }
      else if (key === 'color') { if (!into.col) into.col = cssColor(v); }
      else if (key === 'font-family') { if (!into.fam) into.fam = v; }
      else if (key === 'font') { // shorthand: [style] [weight] size family
        if (!into.size) { const m = /([\d.]+)\s*pt/.exec(v); if (m) into.size = Number(m[1]); }
        if (into.bold === null && /bold/i.test(v)) into.bold = true;
        if (into.italic === null && /italic|oblique/i.test(v)) into.italic = true;
        if (!into.fam) into.fam = v;
      }
    }
  };
  // rich text: the styles of its first run (body, paragraph, span - the innermost wins)
  const rcS: Css = { size: 0, col: null, bold: null, italic: null, fam: '' };
  try {
    const rc = obj.get('RC');
    const x = rc.isString() ? rc.asString() : rc.isStream() ? rc.readStream().asString() : '';
    if (x) {
      const end = x.search(/<\/span|<\/p/i);
      const styles = [...(end > 0 ? x.slice(0, end) : x).matchAll(/style\s*=\s*"([^"]*)"/gi)].map((m) => m[1]).reverse();
      for (const st of styles) read(st, rcS);
    }
  } catch { /* none */ }
  // the style string (often out of step with what shows: "20pt" over 7 pt text)
  const dsS: Css = { size: 0, col: null, bold: null, italic: null, fam: '' };
  try { const ds = obj.get('DS'); if (ds.isString()) read(ds.asString(), dsS); } catch { /* none */ }
  // its own drawing: the font it uses (Arial-BoldMT...), its text size and colour
  let apFont = '', apSize = 0, apCol: number[] | null = null;
  try {
    const n = obj.get('AP', 'N');
    const fonts = n.get('Resources', 'Font');
    if (fonts.isDictionary()) fonts.forEach((f: mupdf.PDFObject) => { if (!apFont) { const b = f.resolve().get('BaseFont'); if (b.isName()) apFont = b.asName(); } });
    if (n.isStream() && obj.get('GCCAngle').isNull()) {
      const t = n.readStream().asString();
      const bt = t.indexOf('BT');
      const tf = /\/\S+\s+([\d.]+)\s+Tf/.exec(t);
      if (tf) apSize = Number(tf[1]);
      const rg = bt >= 0 ? /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(t.slice(bt)) : null;
      if (rg) apCol = [Number(rg[1]), Number(rg[2]), Number(rg[3])];
    }
  } catch { /* none */ }
  type DA = { font: string; size: number; color: mupdf.AnnotColor };
  let da: DA | null = null;
  try { da = a.getDefaultAppearance() as unknown as DA; } catch { /* none */ }
  let daFont = String(da?.font || '');
  try { const bf = o.doc.getTrailer().get('Root', 'AcroForm', 'DR', 'Font', daFont, 'BaseFont'); if (bf.isName()) daFont += ' ' + bf.asName(); } catch { /* none */ }
  const fam = rcS.fam || dsS.fam;
  const names = `${fam} ${apFont} ${daFont}`;
  const family = /times|serif(?!.*sans)|roman|georgia|garamond/i.test(fam || apFont || daFont) && !/sans/i.test(fam) ? 'TiRo' : /cour|mono|consol/i.test(names) ? 'Cour' : 'Helv';
  const bold = rcS.bold ?? (apFont ? /bold|black|heavy|semibold/i.test(apFont) : null) ?? dsS.bold ?? /bold|black|heavy|semibold/i.test(daFont);
  const italic = rcS.italic ?? (apFont ? /italic|oblique/i.test(apFont) : null) ?? dsS.italic ?? /italic|oblique/i.test(daFont);
  // what shows wins: rich text, then its drawing, then /DA, then the style string
  const size = rcS.size || apSize || (da && da.size > 0 ? da.size : 0) || dsS.size || 11;
  const col = rcS.col || apCol || color(da?.color) || dsS.col || [0, 0, 0];
  return { family, size: Math.max(1, Math.min(400, size)), color: col, bold, italic };
}

/** foreignStyle per markup, kept while its drawing / style don't change (it unpacks the drawing:
 *  a page of 1,500 such comments was listed 2-4 times slower after every change) */
const styleCache = new WeakMap<Open, Map<number, { k: string; v: ReturnType<typeof foreignStyle> }>>();
function foreignStyleCached(o: Open, a: mupdf.PDFAnnotation): ReturnType<typeof foreignStyle> {
  const obj = a.getObject();
  const ap = obj.get('AP', 'N'), da = obj.get('DA');
  const k = `${ap.isIndirect() ? ap.asIndirect() : 0}|${da.isString() ? da.asString() : ''}|${obj.get('RC').isNull() ? 0 : 1}${obj.get('DS').isNull() ? 0 : 1}|${obj.get('GCCAngle').isNull() ? 0 : 1}`;
  let m = styleCache.get(o);
  if (!m) { m = new Map(); styleCache.set(o, m); }
  const id = obj.asIndirect(), hit = m.get(id);
  if (hit && hit.k === k) return hit.v;
  const v = foreignStyle(o, a);
  m.set(id, { k, v });
  return v;
}

/** its text or style is changed: from now on it is drawn by this app, in the standard font
 *  closest to its own, keeping its size, colour, bold / italic (its rich text is dropped) */
function adoptText(o: Open, a: mupdf.PDFAnnotation) {
  const obj = a.getObject();
  const st = foreignStyle(o, a);
  // (its rich text's own formatting - bold words, colours - kept as ours)
  const runs = foreignRuns(o, a);
  obj.delete('GCCKeepLook'); obj.delete('GCCAP'); obj.delete('RC'); obj.delete('DS');
  a.setDefaultAppearance(st.family, st.size, st.color as mupdf.AnnotColor);
  if (st.bold) obj.put('GCCBold', true); else obj.delete('GCCBold');
  if (st.italic) obj.put('GCCItalic', true); else obj.delete('GCCItalic');
  const it = obj.get('IT');
  const itn = it.isName() ? it.asName().toLowerCase() : '';
  const kind = itn === 'freetextcallout' || calloutOf(o, a).length ? 'callout' : itn === 'freetexttypewriter' ? 'typewriter' : 'textbox';
  obj.put('GCCKind', o.doc.newName(kind));
  if (runs) writeRich(o, a, runs);
  // typewriter text (no box): grows and shrinks with its text like this app's own - longer text
  // broke mid-word inside the other program's narrow box
  if (kind === 'typewriter' && !obj.get('GCCAuto').isNumber()) {
    const r = a.getRect();
    obj.put('GCCAuto', Math.max(360, Math.abs(r[2] - r[0])));
  }
  // its lines as they were: the other program set them without the small margin this app keeps -
  // the box is widened by that much, rather than the last word of each line wrapping
  try {
    const variant = BASE_VARIANT[st.family][(st.bold ? 1 : 0) + (st.italic ? 2 : 0)];
    const lines = (a.getContents() || '').split(/\r\n?|\n/).map((l) => l.trimEnd()).filter(Boolean);
    if (lines.length) {
      const bw = a.hasBorder() ? a.getBorderWidth() : 0;
      const need = Math.max(...lines.map((l) => measure(variant, l, st.size))) + 2 * (kind === 'typewriter' ? TYPE_PAD.x : TEXT_PAD.x) + 2 * bw + 0.5;
      const gb = obj.get('GCCBox');
      const r = gb.isNull() ? (a.getRect() as Rect) : arr(gb, [0, 0, 1, 1]);
      const w = Math.abs(r[2] - r[0]), extra = need - w;
      if (extra > 0 && extra <= Math.max(6, w * 0.15)) {
        const nr: Rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]) + extra, Math.max(r[1], r[3])];
        if (gb.isNull()) a.setRect(nr); else obj.put('GCCBox', nr);
      }
    }
  } catch { /* as it is */ }
}

/** changes that leave another program's text box looking as it does (turned, faded, its status) */
const LOOK_KEEPING = new Set(['angle', 'opacity', 'state', 'locked', 'hidden', 'subject', 'group']);

function apply(o: Open, a: mupdf.PDFAnnotation, s: Partial<AnnotSpec>, isNew: boolean) {
  const t = a.getType();
  // another program's text box: turned only - its own drawing is kept and turned; anything else
  // (text, font, colour...) - drawn by this app from now on
  if (!isNew && t === 'FreeText') {
    const keep = Object.entries(s).every(([k, v]) => LOOK_KEEPING.has(k) || v === undefined);
    // (a callout's line has to be drawn again to its new place: drawn by this app)
    if (foreignText(a) && keep && !calloutOf(o, a).length) { const obj = a.getObject(); obj.put('GCCAP', obj.get('AP', 'N')); obj.put('GCCKeepLook', true); }
    else if (adoptable(a) || (!keep && keepsLook(a))) adoptText(o, a);
  }
  // (the box's own style before: a style given to the whole box is taken by all its text)
  const base0 = t === 'FreeText' && !isNew && s.font ? baseOf(a) : null;
  if (s.rect && a.hasRect() && (isNew || !(s.vertices || s.line || s.ink || s.quads))) { if (t === 'FreeText' && !isNew) boxKeepTip(o, a, ordered(s.rect)); else a.setRect(ordered(s.rect)); }
  if (s.quads) a.setQuadPoints(s.quads as unknown as mupdf.Quad[]);
  if (s.vertices) a.setVertices(s.vertices as unknown as mupdf.Point[]);
  if (s.line) a.setLine(s.line[0] as unknown as mupdf.Point, s.line[1] as unknown as mupdf.Point);
  if (s.ink) a.setInkList(s.ink as unknown as mupdf.Point[][]);
  // a line's closed arrow heads are filled with its own colour (MuPDF leaves them hollow)
  const headsFollow = t === 'Line' && s.ic === undefined && (isNew || (() => { try { const ic = a.getInteriorColor(), c = a.getColor(); return !ic.length || (ic.length === c.length && ic.every((v, i) => Math.abs(v - c[i]) < 1e-3)); } catch { return false; } })());
  if (s.color !== undefined) a.setColor((s.color || []) as mupdf.AnnotColor);
  if (s.ic !== undefined && a.hasInteriorColor()) a.setInteriorColor((s.ic || []) as mupdf.AnnotColor);
  if (s.opacity !== undefined) a.setOpacity(s.opacity);
  if (s.bw !== undefined && a.hasBorder()) a.setBorderWidth(s.bw);
  if (s.dash !== undefined && a.hasBorder()) {
    if (s.dash) { a.setBorderStyle('Dashed'); a.setBorderDashPattern([4, 3]); }
    else { a.setBorderStyle('Solid'); a.clearBorderDash(); }
  }
  if (s.cloudy !== undefined && a.hasBorderEffect()) {
    if (s.cloudy > 0) { a.setBorderEffect('Cloudy'); a.setBorderEffectIntensity(s.cloudy); }
    else a.setBorderEffect('None');
  }
  if (s.le && a.hasLineEndingStyles()) a.setLineEndingStyles(s.le[0] as mupdf.PDFAnnotationLineEndingStyle, s.le[1] as mupdf.PDFAnnotationLineEndingStyle);
  if (headsFollow && a.hasInteriorColor() && (s.color !== undefined || s.le || isNew)) { try { const c = a.getColor(); if (c.length) a.setInteriorColor(c); } catch { /* none */ } }
  if (s.intent !== undefined) { try { a.setIntent(s.intent as mupdf.PDFAnnotationIntent); } catch { /* not for this type */ } }
  if (isNew && t === 'FreeText' && !(s.callout && s.callout.length)) a.getObject().delete('CL');
  if (s.callout && s.callout.length) { setCallout(o, a, calloutPath(a.getRect() as Rect, s.callout[0])); a.setCalloutStyle('ClosedArrow'); }
  if (s.font && t === 'FreeText') {
    const cur = ftStyle(a);
    const fam = s.font.family || cur.family;
    const base = !!FT_FONT[fam];
    // the built-in name stays in /DA (MuPDF draws the box with it; other programs fall back to it)
    a.setDefaultAppearance(base ? fam : 'Helv', s.font.size, s.font.color as mupdf.AnnotColor);
    const fo = a.getObject();
    if (base) fo.delete('GCCFont'); else fo.put('GCCFont', o.doc.newString(fam));
    const bold = s.font.bold ?? cur.bold, italic = s.font.italic ?? cur.italic;
    if (bold) fo.put('GCCBold', true); else fo.delete('GCCBold');
    if (italic) fo.put('GCCItalic', true); else fo.delete('GCCItalic');
    // (no /DS: with a default style MuPDF switches to its rich-text drawing, which redraws the box
    // on its own when saving - and can't draw Arabic)
    fo.delete('DS');
  }
  if (s.quadding !== undefined && t === 'FreeText') a.setQuadding(s.quadding);
  if (s.autoWidth !== undefined && t === 'FreeText') { if (s.autoWidth && s.autoWidth > 0) a.getObject().put('GCCAuto', s.autoWidth); else a.getObject().delete('GCCAuto'); }
  if (s.contents !== undefined) a.setContents(s.contents);
  if (s.subject !== undefined) a.setSubject(s.subject);
  if (s.icon !== undefined && a.hasIcon()) a.setIcon(s.icon);
  if (s.caption !== undefined && t === 'Line') a.setLineCaption(s.caption);
  const obj = a.getObject();
  if (s.kind !== undefined) obj.put('GCCKind', o.doc.newName(s.kind));
  // rich text: parts of the text styled on their own
  if (t === 'FreeText' && (s.runs || (!notOurs(a) && (s.runs !== undefined || s.font || s.contents !== undefined || s.quadding !== undefined)))) {
    const text = a.getContents() || '';
    let runs = s.runs !== undefined ? (s.runs ? cleanRuns(s.runs) : undefined) : ownRuns(a, text);
    if (runs && runsText(runs) !== text) runs = reflowRuns(runs, text);
    // a style given to the whole box (side panel, ribbon, the typing bar with nothing selected):
    // all of its text takes it
    if (s.runs === undefined && base0 && runs) {
      const b1 = baseOf(a);
      if (b1.bold !== base0.bold) runs = dropKey(runs, 'b');
      if (b1.italic !== base0.italic) runs = dropKey(runs, 'i');
      if (b1.family !== base0.family) runs = dropKey(runs, 'f');
      if (Math.abs(b1.size - base0.size) > 0.01) runs = dropKey(runs, 's');
      if (!sameBase({ ...b1, family: '', size: 0, bold: false, italic: false }, { ...base0, family: '', size: 0, bold: false, italic: false })) runs = dropKey(runs, 'c');
    }
    // (what all of it has alike becomes the box's own style: a bold box, not bold runs)
    const b = baseOf(a);
    const st = settle(b, runs);
    if (!sameBase(st.base, b)) setBase(o, a, st.base);
    writeRich(o, a, st.runs);
  }
  if (s.labelSize !== undefined) obj.put('GCCSize', s.labelSize);
  if (s.fmt !== undefined) { if (s.fmt) obj.put('GCCFmt', o.doc.newString(JSON.stringify(s.fmt))); else obj.delete('GCCFmt'); }
  // a measurement's label: the app's own number when it says so; any other change of the text is
  // the person's (kept from then on)
  if (s.autoLabel) obj.put('GCCLabel', o.doc.newName('auto'));
  else if (s.autoLabel === false || s.contents !== undefined) obj.delete('GCCLabel');
  // (a plain JS string would be written as a PDF *name*: text goes in through newString)
  if (s.group !== undefined) { if (s.group) obj.put('GCCGroup', o.doc.newString(s.group)); else obj.delete('GCCGroup'); }
  if (s.state !== undefined) {
    if (!s.state) { obj.delete('State'); obj.delete('StateModel'); } else {
      obj.put('State', o.doc.newString(s.state));
      obj.put('StateModel', o.doc.newString(s.state === 'Marked' || s.state === 'Unmarked' ? 'Marked' : 'Review'));
    }
  }
  if (s.locked !== undefined || s.hidden !== undefined) {
    // (only these two change: one its author kept out of print stays out of print)
    let f = a.getFlags();
    if (s.locked !== undefined) f = s.locked ? f | LOCKED : f & ~LOCKED;
    if (s.hidden !== undefined) f = s.hidden ? f | HIDDEN : f & ~HIDDEN;
    a.setFlags(f);
  }
  if (s.redactFill !== undefined && t === 'Redact') {
    if (Array.isArray(s.redactFill)) obj.put('GCCFill', s.redactFill.slice(0, 3));
    else obj.put('GCCFill', o.doc.newName(s.redactFill === 'auto' ? 'Auto' : 'None'));
  }
  a.setModificationDate(new Date());
  if (s.image) a.setStampImage(new mupdf.Image(s.image));
  if (s.design) { obj.put('GCCDesign', o.doc.newString(JSON.stringify(s.design))); drawStamp(o, a, s.design); }
  // a callout is not turned (its line points at a spot on the page; turned, its box and line
  // no longer fitted together and the markup's box came out upside down)
  const callout = t === 'FreeText' && obj.get('IT').isName() && obj.get('IT').asName() === 'FreeTextCallout';
  if (s.angle !== undefined && ROTATABLE.has(t) && !callout) {
    const ang = ((s.angle % 360) + 360) % 360;
    if (obj.get('GCCBox').isNull()) obj.put('GCCBox', geomRect(a));
    if (ang) obj.put('GCCAngle', ang); else obj.delete('GCCAngle');
  }
}

const ROTATABLE = new Set(['FreeText', 'Stamp', 'Square', 'Circle']);

/** the unrotated box (page space) */
function geomRect(a: mupdf.PDFAnnotation): Rect {
  const b = a.getObject().get('GCCBox');
  if (!b.isNull()) return arr(b, [0, 0, 0, 0]) as Rect;
  return (a.hasRect() ? a.getRect() : a.getBounds()) as Rect;
}

/**
 * Measurements: the value (Contents) is drawn on the markup itself - at the middle
 * of an area, along a polyline's middle segment, at an angle's corner.
 */
function finish(o: Open, a: mupdf.PDFAnnotation) {
  const obj = a.getObject();
  const t = a.getType();
  const boxObj = obj.get('GCCBox');
  let kind0 = '';
  try { const k = obj.get('GCCKind'); kind0 = k.isNull() ? '' : k.asName(); } catch { /* none */ }
  if (ROTATABLE.has(t) && !boxObj.isNull()) a.setRect(ordered(arr(boxObj, [0, 0, 1, 1])));
  // our labels wrap MuPDF's appearance: always start again from a fresh one
  else if (kind0.startsWith('measure-') && kind0 !== 'measure-count') a.setOpacity(a.getOpacity());
  if (t === 'FreeText') {
    const cl = calloutOf(o, a);
    if (cl.length) setCallout(o, a, calloutPath(a.getRect() as Rect, cl[0]));
  }
  // MuPDF may resize a stamp's box when it redraws it (rotated pages): remember the box
  const keep = t === 'Stamp' ? (a.getRect() as Rect) : null;
  const keepRaw = t === 'Stamp' ? arr(obj.get('Rect'), [0, 0, 1, 1]) : null;
  // a picture stamp (seal, signature, image) or another app's stamp: MuPDF can only draw its own
  // named stamps again - its appearance is kept (/GCCAP) and placed in the box after every change
  // (a turned picture lost its picture on the next move; a copy lost it at once)
  // another program's text box changed in a way not handled above (resized, pasted, its callout
  // moved): drawn by this app from now on - MuPDF's own drawing of its rich text came out garbled
  if (adoptable(a)) adoptText(o, a);
  const keepLook = keepsLook(a);
  const own = (t === 'Stamp' && obj.get('GCCDesign').isNull()) || keepLook;
  let orig = own ? obj.get('GCCAP') : null;
  if (own && orig!.isNull()) { const cur = unwrapped(obj); if (cur) { obj.put('GCCAP', cur); orig = cur; } }
  // text that needs a font from the PC (Arabic, other typefaces): MuPDF draws the box around a
  // stand-in letter, then the text is set by us (layoutFreeText) - its own drawing of such text
  // came out empty in every PDF program
  let realText: string | null = null;
  let rich: TextRun[] | undefined;
  if (t === 'FreeText' && !keepLook) {
    const tx = a.getContents() || '';
    rich = ownRuns(a, tx);
    if (rich || usesPcFont(a, tx)) { realText = tx; obj.put('Contents', o.doc.newString(tx.trim() ? 'x' : '')); }
  }
  if (keepLook) {
    // (clears MuPDF's "draw again" mark - it drew it again on the next save, from its rich text)
    // (its rich text set aside meanwhile: MuPDF's drawing of it - thrown away below - embedded a
    // font each time, which an "original + changes" save kept: 1.6 KB -> 52 KB after 5 turns)
    const r0 = arr(obj.get('Rect'), [0, 0, 1, 1]);
    const rc = obj.get('RC'), ds = obj.get('DS');
    if (!rc.isNull()) obj.delete('RC');
    if (!ds.isNull()) obj.delete('DS');
    try { a.update(); } catch { /* its /DA names a font of its own: the drawing is replaced anyway */ }
    finally { if (!rc.isNull()) obj.put('RC', rc); if (!ds.isNull()) obj.put('DS', ds); }
    const r1 = arr(obj.get('Rect'), [0, 0, 1, 1]);
    if (r1.some((v, i) => Math.abs(v - r0[i]) > 0.01)) obj.put('Rect', r0);
  } else try {
    // a measured length: its arrows are drawn with its number (sized from the number, not from
    // the line width - MuPDF's are 10x the width and at least 10 pt: huge beside a small number)
    // (only when the ends are drawn with the number below: not for an older length whose number
    // MuPDF draws as a caption, nor for one without a number)
    const le = kind0 === 'measure-length' && t === 'Line' && !a.getLineCaption() && !!a.getContents() ? obj.get('LE') : null;
    if (le && !le.isNull()) obj.put('LE', [o.doc.newName('None'), o.doc.newName('None')]);
    try { updateQuiet(a); } finally { if (le && !le.isNull()) obj.put('LE', le); }
    if (own && orig!.isNull()) { const cur = obj.get('AP', 'N'); if (cur.isStream()) { obj.put('GCCAP', cur); orig = cur; } }
    // (a turned text box too: its box is grown before the turn is applied below)
    if (t === 'FreeText') {
      if (rich) {
        // (couldn't be set in styles - no fonts at all: all of it in the box's own style)
        if (!layoutRich(o, a, realText!, rich) && !layoutFreeText(o, a, realText!, true)) { obj.put('Contents', o.doc.newString(realText!)); updateQuiet(a); fitText(o, a); }
      } else if (!layoutFreeText(o, a, realText ?? (a.getContents() || ''), realText !== null)) fitText(o, a);
      fixFreeTextFont(o, a); solidArrow(a);
    }
  } finally {
    if (realText !== null) obj.put('Contents', o.doc.newString(realText));
  }
  if (t === 'Text') noteIcon(a);
  // custom stamps: MuPDF would redraw them as its own default stamp
  const des = obj.get('GCCDesign');
  if (keep) {
    const now = a.getRect();
    if (Math.abs(now[0] - keep[0]) + Math.abs(now[1] - keep[1]) + Math.abs(now[2] - keep[2]) + Math.abs(now[3] - keep[3]) > 0.5) {
      // a picture stamp: its box put back as it was - not through MuPDF, which would draw its
      // default stamp again and shape the box like it (a round seal resized came out 3.8 : 1,
      // a tester's video); its picture is placed in the box below
      if (des.isNull()) obj.put('Rect', keepRaw!);
      else a.setRect(keep);
    }
  }
  if (t === 'Stamp' && !des.isNull()) { try { drawStamp(o, a, JSON.parse(des.asString())); } catch { /* keep */ } }
  if (own && orig && !orig.isNull()) placeAppearance(o, a, orig);
  if (ROTATABLE.has(t) && !boxObj.isNull()) {
    obj.put('GCCBox', a.getRect());
    const ang = num(obj.get('GCCAngle')) ?? 0;
    if (ang) rotateAppearance(o, a, ang);
  }
  let kind = '';
  try { const k = a.getObject().get('GCCKind'); kind = k.isNull() ? '' : k.asName(); } catch { /* none */ }
  if (!kind.startsWith('measure-') || kind === 'measure-count') return;
  if (t === 'Line' && a.getLineCaption()) return; // MuPDF draws the caption itself (older files)
  const text = a.getContents();
  if (!text) return;
  const v = a.hasVertices() ? a.getVertices().map((p) => [p[0], p[1]] as Pt) : a.hasLine() ? a.getLine().map((p) => [p[0], p[1]] as Pt) : [];
  if (v.length < 2) return;
  let at: Pt;
  if (kind === 'measure-area' || kind === 'measure-perimeter') {
    // centroid of the outline
    let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < v.length; i++) {
      const [x0, y0] = v[i], [x1, y1] = v[(i + 1) % v.length];
      const c = x0 * y1 - x1 * y0;
      A += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    }
    at = Math.abs(A) > 1e-6 ? [cx / (3 * A), cy / (3 * A)] : [v.reduce((s, p) => s + p[0], 0) / v.length, v.reduce((s, p) => s + p[1], 0) / v.length];
  } else if (kind === 'measure-angle') at = [v[1][0] + 6, v[1][1] - 6];
  const col = color(a.getColor()) || [0, 0, 0];
  // (down to 2 pt: a label made while zoomed in on a detail is small on the sheet, normal on screen)
  const size = Math.max(2, Math.min(72, Number(a.getObject().get('GCCSize').isNull() ? 10 : a.getObject().get('GCCSize').asNumber())));
  // (its place moves with its size: a fixed few points were far off a small number's line)
  if (kind === 'measure-angle') at = [v[1][0] + size * 0.5, v[1][1] - size * 0.5];
  else if (kind !== 'measure-area' && kind !== 'measure-perimeter') { const k = Math.floor((v.length - 1) / 2); at = [(v[k][0] + v[k + 1][0]) / 2, (v[k][1] + v[k + 1][1]) / 2 - size * 0.33]; }
  let ends: Ends | undefined;
  if (kind === 'measure-length' && t === 'Line') {
    const le = a.getObject().get('LE');
    const names = le.isArray() ? [0, 1].map((i) => { const n = le.get(i); return n.isName() ? n.asName() : 'None'; }) : ['None', 'None'];
    ends = { a: v[0], b: v[1], le: names, lw: a.getBorderWidth(), op: a.getOpacity() };
  }
  labelAppearance(o, a, text.split('\n'), at!, size, col, kind === 'measure-angle', ends);
}

/** a measured length's two ends (page space) and how each ends: drawn with the number */
type Ends = { a: Pt; b: Pt; le: string[]; lw: number; op: number };
/**
 * The line endings of a measured length, sized from its number (arrow about as long as the number
 * is tall), in PDF operators - points through `toU` (page -> the appearance's space). Returns the
 * operators and the points they reach (for the box).
 */
function endOps(e: Ends, size: number, pen: number, toU: (p: Pt) => Pt): { ops: string[]; pts: Pt[] } {
  const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { ops: [], pts: [] };
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  // arrow: length, half width (about 21 degrees each side) - from the number; on a line drawn
  // thick (older measurements) still wider than the line, or it disappears in it
  const bw = Math.max(0, e.lw || 0);
  // (never longer than half the line: on a short dimension the two heads overlapped into a blob
  // that hid the line)
  const L = Math.min(Math.max(size * 0.9, bw * 4), len * 0.45), H = L * 0.38;
  const T = Math.max(size * 0.6, bw * 2.5); // ticks and bars: half length
  const tick = `${+Math.max(pen, Math.min(pen * 1.8, size * 0.2), size * 0.06).toFixed(3)} w`;
  const ops: string[] = [], pts: Pt[] = [];
  const P = (p: Pt) => { const q = toU(p); pts.push(q); return `${+q[0].toFixed(3)} ${+q[1].toFixed(3)}`; };
  const circle = (c: Pt, r: number) => {
    const k = r * 0.5523;
    const pt = (x: number, y: number): Pt => [c[0] + x, c[1] + y];
    return `${P(pt(r, 0))} m ${P(pt(r, k))} ${P(pt(k, r))} ${P(pt(0, r))} c ${P(pt(-k, r))} ${P(pt(-r, k))} ${P(pt(-r, 0))} c ${P(pt(-r, -k))} ${P(pt(-k, -r))} ${P(pt(0, -r))} c ${P(pt(k, -r))} ${P(pt(r, -k))} ${P(pt(r, 0))} c h f`;
  };
  [0, 1].forEach((i) => {
    const tip = i ? e.b : e.a;
    const s = i ? -1 : 1; // into the line from this end
    const back: Pt = [tip[0] + ux * L * s, tip[1] + uy * L * s];
    const w1: Pt = [back[0] + nx * H, back[1] + ny * H], w2: Pt = [back[0] - nx * H, back[1] - ny * H];
    switch (e.le[i]) {
      case 'OpenArrow': ops.push(`${P(w1)} m ${P(tip)} l ${P(w2)} l S`); break;
      // (filled and outlined with the line's pen: covers the line's square end at the tip)
      case 'ClosedArrow': ops.push(`${P(w1)} m ${P(tip)} l ${P(w2)} l h b`); break;
      case 'Circle': ops.push(circle(tip, Math.max(size * 0.22, bw * 1.2))); break;
      case 'Butt': ops.push(`q ${tick} ${P([tip[0] + nx * T, tip[1] + ny * T])} m ${P([tip[0] - nx * T, tip[1] - ny * T])} l S Q`); break;
      case 'Slash': {
        // an architect's tick: 45 degrees across the line
        const tx = (ux + nx) * Math.SQRT1_2 * T, ty = (uy + ny) * Math.SQRT1_2 * T;
        ops.push(`q ${tick} ${P([tip[0] - tx, tip[1] - ty])} m ${P([tip[0] + tx, tip[1] + ty])} l S Q`);
        break;
      }
      default: break; // None (and styles not offered here: no ending)
    }
  });
  return { ops, pts };
}

/**
 * Add a text label to a markup's appearance. Everything is written as plain PDF content in
 * the page's own (unrotated) user space, so it stays upright on rotated sheets and shows
 * the same in other PDF programs.
 */
function labelAppearance(o: Open, a: mupdf.PDFAnnotation, lines: string[], at: Pt, size: number, col: number[], left: boolean, ends?: Ends) {
  const obj = a.getObject();
  const ap = obj.get('AP', 'N');
  if (ap.isNull() || !ap.isStream()) return;
  const C = pageCtmOf(o, a);
  const Ci = mupdf.Matrix.invert(C as unknown as mupdf.Matrix) as unknown as number[];
  const toU = (p: Pt): Pt => [Ci[0] * p[0] + Ci[2] * p[1] + Ci[4], Ci[1] * p[0] + Ci[3] * p[1] + Ci[5]];
  const r = arr(obj.get('Rect'), [0, 0, 1, 1]);
  const bb = arr(ap.get('BBox'), [0, 0, 1, 1]);
  const mx = arr(ap.get('Matrix'), [1, 0, 0, 1, 0, 0]);
  const cs = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(([x, y]) => [mx[0] * x + mx[2] * y + mx[4], mx[1] * x + mx[3] * y + mx[5]]);
  const tx0 = Math.min(...cs.map((c) => c[0])), tx1 = Math.max(...cs.map((c) => c[0])), ty0 = Math.min(...cs.map((c) => c[1])), ty1 = Math.max(...cs.map((c) => c[1]));
  const rx0 = Math.min(r[0], r[2]), ry0 = Math.min(r[1], r[3]), rx1 = Math.max(r[0], r[2]), ry1 = Math.max(r[1], r[3]);
  const sx = (rx1 - rx0) / Math.max(1e-6, tx1 - tx0), sy = (ry1 - ry0) / Math.max(1e-6, ty1 - ty0);
  // (the form applies its own /Matrix when drawn, so it is not part of this placement)
  const A0 = [sx, 0, 0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy];
  // label block in page space
  const lh = size * 1.15;
  const widths = lines.map((l) => measure('Helvetica-Bold', l, size));
  const tw = Math.max(...widths);
  const bx0 = left ? at[0] : at[0] - tw / 2;
  const by0 = at[1] - (lines.length * lh) / 2;
  const box: Pt[] = [[bx0 - 2, by0 - 1], [bx0 + tw + 2, by0 - 1], [bx0 + tw + 2, by0 + lines.length * lh + 1], [bx0 - 2, by0 + lines.length * lh + 1]];
  const ub = box.map(toU);
  const ops: string[] = [`q ${fmt(A0)} cm /X0 Do Q`];
  let endPts: Pt[] = [];
  if (ends) {
    // (the line's own pen - its arrows are at least 4x as long, so never blobs; solid even on a
    // dashed line)
    const lw = Math.max(0.05, ends.lw > 0 ? ends.lw : 0.05);
    const e = endOps(ends, size, lw, toU);
    if (e.ops.length) {
      const c = col.map((v) => +v.toFixed(3)).join(' ');
      ops.push(`q${ends.op < 1 ? ' /GSo gs' : ''} ${c} RG ${c} rg ${+lw.toFixed(3)} w 1 J 1 j [] 0 d`, ...e.ops, 'Q');
      endPts = e.pts.map((p) => [p[0], p[1]] as Pt);
      // (the box reaches the pen's edge too - ticks have a wider pen)
      const pad = Math.max(lw, size * 0.2);
      endPts = endPts.flatMap((p) => [[p[0] - pad, p[1] - pad], [p[0] + pad, p[1] + pad]] as Pt[]);
    }
  }
  ops.push(`q /GSb gs 1 1 1 rg ${ub.map((p, i) => `${+p[0].toFixed(3)} ${+p[1].toFixed(3)} ${i ? 'l' : 'm'}`).join(' ')} h f Q`);
  ops.push(`BT ${col.map((v) => +v.toFixed(3)).join(' ')} rg /FL 1 Tf`);
  lines.forEach((l, i) => {
    const x = left ? bx0 : at[0] - widths[i] / 2;
    const y = by0 + lh * i + size * 0.88;
    ops.push(`${fmt(mul([size, 0, 0, -size, x, y], Ci))} Tm ${pdfString(l)} Tj`);
  });
  ops.push('ET');
  const xs = [rx0, rx1, ...ub.map((p) => p[0]), ...endPts.map((p) => p[0])], ys = [ry0, ry1, ...ub.map((p) => p[1]), ...endPts.map((p) => p[1])];
  const nb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  ap.put('Type', 'XObject');
  ap.put('Subtype', 'Form');
  const op = ends && ends.op < 1 ? +Math.max(0, ends.op).toFixed(3) : 1;
  const res = o.doc.addObject({ XObject: { X0: ap }, Font: { FL: stdFont(o, 'Helvetica-Bold') }, ExtGState: { GSb: { Type: 'ExtGState', ca: 0.85 }, GSo: { Type: 'ExtGState', CA: op, ca: op } } });
  const wrap = o.doc.addStream(ops.join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: nb, Resources: res });
  const apd = o.doc.newDictionary();
  apd.put('N', wrap);
  obj.put('AP', apd);
  obj.put('Rect', nb);
}

/**
 * A comment's icon: a speech bubble in its colour with a dark outline and three text lines
 * (MuPDF's is a black blob in a square). Other icon names keep MuPDF's drawing.
 */
function noteIcon(a: mupdf.PDFAnnotation) {
  let icon = '';
  try { icon = a.getIcon(); } catch { return; }
  if (icon !== 'Comment') return;
  const ap = a.getObject().get('AP', 'N');
  if (ap.isNull() || !ap.isStream()) return;
  let c: number[] = [1, 0.82, 0.2];
  try { const k = a.getColor(); if (k.length === 3) c = k as number[]; else if (k.length === 1) c = [k[0], k[0], k[0]]; } catch { /* default */ }
  const f = (v: number) => +v.toFixed(3);
  const lum = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const ink = lum > 0.45 ? c.map((v) => f(v * 0.35)) : [0.15, 0.15, 0.15];
  const lines = lum > 0.45 ? ink : [1, 1, 1];
  const ops = [
    `${c.map(f).join(' ')} rg ${ink.join(' ')} RG 1.1 w 1 j`,
    // bubble with its tail (bottom left)
    '4.2 18.6 m 15.8 18.6 l 17.6 18.6 18.6 17.6 18.6 15.8 c 18.6 9 l 18.6 7.2 17.6 6.2 15.8 6.2 c',
    '9.4 6.2 l 4.6 1.6 l 5.6 6.2 l 4.2 6.2 l 2.4 6.2 1.4 7.2 1.4 9 c 1.4 15.8 l 1.4 17.6 2.4 18.6 4.2 18.6 c h B',
    `${lines.join(' ')} RG 1 w 1 J 5 15.2 m 15 15.2 l 5 12.4 m 15 12.4 l 5 9.6 m 11.5 9.6 l S`,
  ];
  ap.writeStream(ops.join('\n'));
  ap.put('BBox', [0, 0, 20, 20]);
}

/** a callout's arrow head: MuPDF fills it with the box colour (pale, looks hollow) - use the line's */
function solidArrow(a: mupdf.PDFAnnotation) {
  const obj = a.getObject();
  const ap = obj.get('AP', 'N');
  if (ap.isNull() || !ap.isStream() || !obj.get('CL').isArray()) return;
  const src = ap.readStream().asString();
  const rg = /(?:^|\n)([-\d. ]+) RG\n/.exec(src);
  const head = /\n((?:[-\d.]+ [-\d.]+ [ml]\n){3}h\nb\n)/.exec(src);
  if (!rg || !head || src.includes('\nq ' + rg[1] + ' rg')) return;
  const out = src.slice(0, head.index + 1) + `q ${rg[1]} rg\n${head[1]}Q\n` + src.slice(head.index + head[0].length);
  ap.writeStream(out);
}

const FT_FONT: Record<string, string> = { Helv: 'Helvetica', TiRo: 'Times-Roman', Cour: 'Courier' };
const FT_ASC: Record<string, number> = { Helv: 0.77, TiRo: 0.74, Cour: 0.68 };
export { wrapText, TEXT_PAD };

/** the font a text box asks for: family (built-in Helv/TiRo/Cour or a PC family), bold, italic */
function ftStyle(a: mupdf.PDFAnnotation): { family: string; bold: boolean; italic: boolean } {
  const obj = a.getObject();
  let family = 'Helv';
  try { const f = a.getDefaultAppearance().font; family = FT_FONT[f] ? f : 'Helv'; } catch { /* default */ }
  const g = obj.get('GCCFont');
  if (g.isString() && g.asString()) family = g.asString();
  else if (g.isName() && g.asName()) family = g.asName();
  const flag = (k: string) => { const v = obj.get(k); return v.isBoolean() ? v.asBoolean() : false; };
  return { family, bold: flag('GCCBold'), italic: flag('GCCItalic') };
}

/** the built-in fonts' bold / italic versions (regular, bold, italic, bold italic) */
const BASE_VARIANT: Record<string, string[]> = {
  Helv: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  TiRo: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  Cour: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

/** the text needs a font from the PC: another typeface, or letters the built-in fonts lack */
function usesPcFont(a: mupdf.PDFAnnotation, text: string): boolean {
  const st = ftStyle(a);
  if (FT_FONT[st.family] && fitsWinAnsi(text)) return false;
  return fontStack(st.family, st.bold, st.italic).length > 0;
}

/**
 * A font from the PC in this document (once: later text boxes use the same object; subset to
 * the letters used when saving). MuPDF hands back the object it made before for the same font,
 * which an undo may have removed since: a different digest (bytes added at the end, which font
 * readers ignore) makes a new one.
 */
const fontMark = (f: FontRef) => (f.key.split(/[\\/]/).pop() || f.key) + ':' + f.mu.getName();
function embedFont(o: Open, f: FontRef): mupdf.PDFObject {
  const key = 'emb:' + f.key;
  let obj = o.fonts.get(key);
  // (the marker is the font file's name: its full path - with the Windows user name in it for
  // fonts installed per user - is not written into the file)
  const mark = fontMark(f);
  if (ourObj(o, obj, 'GCCFont', mark)) return obj!;
  const bytes = fontBytes(f);
  obj = o.doc.addFont(f.mu);
  for (let k = 1; k < 8 && !isFont(o, obj, 'Type0'); k++) {
    const b = new Uint8Array(bytes.length + k);
    b.set(bytes);
    obj = o.doc.addFont(new mupdf.Font(f.family, b));
  }
  // MuPDF hands back the font already in the file when it has the same bytes (e.g. after an
  // undo emptied our cache): its letters list stays - only a really new font object starts afresh
  const had = obj.resolve().get('GCCFont');
  const fresh = !(had.isString() && had.asString() === mark);
  obj.resolve().put('GCCFont', o.doc.newString(mark));
  o.fonts.set(key, obj);
  if (fresh) o.toUni?.delete(f.key);
  o.bigFont = true;
  return obj;
}

/** note the letters behind the glyphs just written, and rewrite those fonts' ToUnicode */
function noteGlyphs(o: Open, lines: Line[]) {
  const used = new Set<FontRef>();
  o.toUni ??= new Map();
  for (const l of lines) for (const g of l.glyphs) {
    used.add(g.f);
    let m = o.toUni.get(g.f.key);
    if (!m) { m = new Map(); o.toUni.set(g.f.key, m); }
    // (right-to-left runs are marked /ReversedChars: readers turn the whole run round, the
    // letters behind one glyph too - a lam-alef stored as "لا" came out "ال", so it is stored the
    // other way round)
    if (g.u && !m.has(g.gid)) m.set(g.gid, g.rtl && g.u.length > 1 ? [...g.u].reverse().join('') : g.u);
  }
  // (rewritten when it has new glyphs - or the font object is new, e.g. after an undo)
  for (const f of used) {
    const fo = embedFont(o, f).resolve();
    const m = o.toUni.get(f.key)!;
    const done = fo.get('GCCToU');
    if (done.isNumber() && done.asNumber() === m.size) continue;
    fo.put('ToUnicode', o.doc.addStream(toUnicodeCMap(m), o.doc.newDictionary()));
    fo.put('GCCToU', m.size);
  }
}

/** one laid-out line of a text box, either in a built-in font or shaped in PC fonts */
interface SetLine { w: number; rtl: boolean; s?: string; line?: Line }

/**
 * A text box's text, laid out by us: MuPDF puts it right against the border (1 pt) and cuts
 * off what doesn't fit. Here it gets proper padding, wraps at words, follows the alignment, and
 * the box grows downwards until every line shows. Only the text part of MuPDF's appearance is
 * replaced (the box, its border and a callout's line stay MuPDF's). Text in a PC font (another
 * typeface, Arabic) is shaped and embedded; Arabic runs right to left and starts on the right.
 * false: left to MuPDF.
 */
function layoutFreeText(o: Open, a: mupdf.PDFAnnotation, text: string, pc: boolean): boolean {
  const obj = a.getObject();
  let kind = '';
  try { const k = obj.get('GCCKind'); kind = k.isNull() ? '' : k.asName(); } catch { /* none */ }
  const st = ftStyle(a);
  if (!pc && /[^\u0000-\u00ff\u20ac\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u2122]/.test(text)) return false;
  const stack = pc ? fontStack(st.family, st.bold, st.italic) : [];
  if (pc && !stack.length) return false;
  const fam = FT_FONT[st.family] ? st.family : 'Helv';
  const variant = BASE_VARIANT[fam][(st.bold ? 1 : 0) + (st.italic ? 2 : 0)];
  for (let round = 0; round < 4; round++) {
    const ap = obj.get('AP', 'N');
    if (ap.isNull() || !ap.isStream()) return false;
    const src = ap.readStream().asString();
    const m = /\nq\n(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) cm\nBT\n[\s\S]*?ET\nQ/.exec(src);
    if (!m && text.trim()) return false;
    let da: { font: string; size: number; color: number[] };
    try { const d = a.getDefaultAppearance(); da = { font: d.font, size: d.size || 11, color: (d.color || [0, 0, 0]) as number[] }; } catch { return false; }
    const fontsRes = ap.get('Resources').get('Font');
    if (fontsRes.isNull() || (!pc && fontsRes.get(da.font).isNull())) return false;
    const M = m ? m.slice(1, 7).map(Number) : [1, 0, 0, 1, 0, 0];
    // the box inside its border, in the text's own frame (Rect less RD, less the border)
    const R = arr(obj.get('Rect'), [0, 0, 1, 1]);
    const rd = obj.get('RD').isArray() ? arr(obj.get('RD'), [0, 0, 0, 0]) : [0, 0, 0, 0];
    const bw = a.hasBorder() ? a.getBorderWidth() : 0;
    const box = [Math.min(R[0], R[2]) + rd[0] + bw, Math.min(R[1], R[3]) + rd[1] + bw, Math.max(R[0], R[2]) - rd[2] - bw, Math.max(R[1], R[3]) - rd[3] - bw];
    const Mi = mupdf.Matrix.invert(M as unknown as mupdf.Matrix) as unknown as number[];
    const cs = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(([x, y]) => [Mi[0] * x + Mi[2] * y + Mi[4], Mi[1] * x + Mi[3] * y + Mi[5]]);
    const x0 = Math.min(...cs.map((c) => c[0])), x1 = Math.max(...cs.map((c) => c[0])), y0 = Math.min(...cs.map((c) => c[1])), y1 = Math.max(...cs.map((c) => c[1]));
    const typew = kind === 'typewriter';
    const P = typew ? TYPE_PAD : TEXT_PAD;
    const px = P.x, pt = P.top, pb = P.bottom;
    const size = da.size;
    const asc = pc ? Math.min(stack[0].asc, 1) : FT_ASC[fam];
    const below = pc ? Math.min(stack[0].desc, 0.45) + 0.1 : 0.26;
    const lh = size * (pc ? Math.max(1.2, Math.min(1.5, stack[0].asc + stack[0].desc)) : 1.2);
    const wOf = (s: string) => measure(variant, s, size);
    const setLines = (avail: number): SetLine[] => {
      if (!text) return [];
      if (pc) return layoutText(text, Math.max(0.5, avail / size), stack).map((l) => ({ w: l.width * size, rtl: l.rtl, line: l }));
      return wrapText(text, avail, wOf).map((s) => ({ w: wOf(s), rtl: false, s }));
    };
    // a box that fits its text (clicked, not dragged): as wide as the longest line, up to its
    // limit, then the text wraps; as tall as the lines - growing and shrinking with the typing
    const autoMax = obj.get('GCCAuto').isNumber() ? obj.get('GCCAuto').asNumber() : 0;
    if (autoMax > 0 && round < 3) {
      const wrapAt = Math.max(size, autoMax - 2 * bw - 2 * px);
      const ls = text ? setLines(wrapAt) : [];
      const textW = Math.max(size * AUTO_MIN, ...ls.map((l) => l.w));
      const wantW = textW + 2 * px + 0.02, wantH = pt + pb + (Math.max(1, ls.length) - 1) * lh + size * (asc + below);
      const dW = wantW - (x1 - x0), dH = wantH - (y1 - y0);
      if (Math.abs(dW) > 0.3 || Math.abs(dH) > 0.3) {
        const r = a.getRect();
        boxKeepTip(o, a, [r[0], r[1], Math.max(r[0] + 2, r[2] + dW), Math.max(r[1] + 2, r[3] + dH)]);
        updateQuiet(a);
        continue;
      }
    }
    const avail = Math.max(size, x1 - x0 - 2 * px);
    const lines = setLines(avail);
    const need = pt + pb + (lines.length ? (lines.length - 1) * lh + size * (asc + below) : 0);
    // too short: grow downwards (page space) and let MuPDF draw the box again
    if (need > y1 - y0 + 0.01 && round < 3) {
      const r = a.getRect();
      boxKeepTip(o, a, [r[0], r[1], r[2], r[3] + (need - (y1 - y0)) + 0.5]);
      updateQuiet(a);
      continue;
    }
    if (!m) return true;
    const q = a.getQuadding();
    const ops = ['q', M.join(' ') + ' cm', 'BT', da.color.length === 1 ? `${+da.color[0].toFixed(4)} g` : da.color.length === 4 ? `${da.color.map((v) => +v.toFixed(4)).join(' ')} k` : `${da.color.map((v) => +v.toFixed(4)).join(' ')} rg`];
    // fonts: the built-in one MuPDF put there, its bold/italic version, or PC fonts (embedded)
    const names = new Map<string, string>();
    const resName = (key: string, obj2: () => mupdf.PDFObject) => {
      let n = names.get(key);
      if (!n) { n = 'GCC' + (pc ? 'e' : 'b') + names.size; names.set(key, n); fontsRes.put(n, obj2()); }
      return n;
    };
    if (!pc) {
      const fname = variant === BASE_VARIANT[fam][0] ? da.font : resName(variant, () => stdFont(o, variant as 'Helvetica'));
      ops.push(`/${fname} ${+size.toFixed(3)} Tf`);
    }
    lines.forEach((l, i) => {
      // right-to-left text starts on the right (left alignment means "where the text starts")
      const al = l.rtl && q === 0 ? 2 : q;
      const x = x0 + px + (al === 1 ? (avail - l.w) / 2 : al === 2 ? avail - l.w : 0);
      const y = y1 - pt - size * asc - i * lh;
      if (l.line) ops.push(...lineOps(l.line, x, y, size, (f) => resName(f.key, () => embedFont(o, f))));
      else if (l.s) ops.push(`1 0 0 1 ${+x.toFixed(3)} ${+y.toFixed(3)} Tm ${pdfString(l.s)} Tj`);
    });
    ops.push('ET', 'Q');
    ap.writeStream(src.slice(0, m.index + 1) + ops.join('\n') + src.slice(m.index + m[0].length));
    if (pc) noteGlyphs(o, lines.map((l) => l.line!).filter(Boolean));
    return true;
  }
  return true;
}

/** a run of rich text with what drawing it takes: a built-in font, or PC fonts shaped */
interface RichRun { st: FullStyle; e: number; pc: boolean; stack: FontRef[]; variant: string; asc: number; below: number; lhf: number }
/** a piece of a line in one style (and one direction), placed at x from the line's start */
interface RichItem { s: number; e: number; k: number; lv: number; x: number; w: number; glyphs?: Glyph[] }
interface RichLine { items: RichItem[]; w: number; rtl: boolean; asc: number; below: number; lh: number }
interface RichPara { s: number; e: number; t: string; levels: Uint8Array; rtl: boolean }

/** line metrics of a font, in font sizes: built-in (as in layoutFreeText) or from the PC font */
const builtinMetrics = (fam: string) => ({ asc: FT_ASC[fam] ?? FT_ASC.Helv, below: 0.26, lhf: 1.2 });
const pcMetrics = (f: FontRef) => ({ asc: Math.min(f.asc, 1), below: Math.min(f.desc, 0.45) + 0.1, lhf: Math.max(1.2, Math.min(1.5, f.asc + f.desc)) });

/** visual order of pieces (bidi rule L2: from the highest level down to the lowest odd one,
 *  every stretch at that level or above turned round) */
function reorderL2<T extends { lv: number }>(items: T[]): T[] {
  if (!items.length) return items;
  const out = items.slice();
  const maxL = Math.max(...out.map((r) => r.lv));
  const minOdd = Math.min(...out.map((r) => r.lv).filter((l) => l % 2 === 1), maxL + 1);
  for (let lv = maxL; lv >= minOdd && lv > 0; lv--) {
    for (let i = 0; i < out.length;) {
      if (out[i].lv >= lv) {
        let j = i;
        while (j < out.length && out[j].lv >= lv) j++;
        out.splice(i, j - i, ...out.slice(i, j).reverse());
        i = j;
      } else i++;
    }
  }
  return out;
}

let richSeg: Intl.Segmenter | null | undefined;
/** where each whole letter (with its marks) in text [s, e) ends */
function letterEndsIn(text: string, s: number, e: number): number[] {
  if (richSeg === undefined) { try { richSeg = new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch { richSeg = null; } }
  const out: number[] = [];
  if (richSeg) { for (const g of richSeg.segment(text.slice(s, e))) out.push(s + g.index + g.segment.length); return out; }
  for (let i = s; i < e;) { i += text.codePointAt(i)! > 0xffff ? 2 : 1; while (i < e && /\p{M}/u.test(text[i])) i++; out.push(i); }
  return out;
}

/**
 * A text box with rich text, laid out by us: as layoutFreeText (padding, word wrap, alignment,
 * the box growing until all shows, fitting its text), with every run in its own font, size and
 * colour, underlines drawn under their text, each line as tall as its largest text. Built-in
 * fonts where the text allows; PC fonts (shaped, embedded) for other typefaces, letters beyond the
 * built-in ones and any right-to-left text. false: couldn't (no fonts) - left to the caller.
 */
function layoutRich(o: Open, a: mupdf.PDFAnnotation, text0: string, runs0: TextRun[]): boolean {
  const obj = a.getObject();
  let kind = '';
  try { const k = obj.get('GCCKind'); kind = k.isNull() ? '' : k.asName(); } catch { /* none */ }
  const base = baseOf(a);
  // (tabs as four spaces, as in a plain text box)
  const src = runsText(runs0) === text0 ? runs0 : reflowRuns(runs0, text0);
  const runs = src.map((r) => ({ ...r, t: r.t.replace(/\r\n?/g, '\n').replace(/\t/g, '    ') }));
  const text = runsText(runs);
  const rtlText = RTL_RE.test(text);
  const RR: RichRun[] = [];
  const kOf = new Int32Array(text.length);
  let at = 0;
  for (const r of runs) {
    const st = fullStyle(base, r);
    const builtin = !!FT_FONT[st.family];
    let pc = rtlText || !builtin || !fitsWinAnsi(r.t);
    const stack = pc ? fontStack(st.family, st.bold, st.italic) : [];
    // (no PC fonts at all: plain letters in the closest built-in font, others can't be set)
    if (pc && !stack.length) { if (rtlText || !fitsWinAnsi(r.t)) return false; pc = false; }
    const fam = FT_FONT[st.family] ? st.family : 'Helv';
    const variant = BASE_VARIANT[fam][(st.bold ? 1 : 0) + (st.italic ? 2 : 0)];
    kOf.fill(RR.length, at, at + r.t.length);
    at += r.t.length;
    RR.push({ st, e: at, pc, stack, variant, ...(pc ? pcMetrics(stack[0]) : builtinMetrics(fam)) });
  }
  // the box's own style: every line is at least as tall as its text (as in the typing box)
  const bm = (() => {
    if (FT_FONT[base.family] && !rtlText) return builtinMetrics(base.family);
    const st = fontStack(base.family, base.bold, base.italic);
    return st.length ? pcMetrics(st[0]) : builtinMetrics('Helv');
  })();
  const paras: RichPara[] = [];
  {
    let p = 0;
    for (const t of text.split('\n')) {
      const lv = rtlText && t ? paraLevels(t) : { levels: new Uint8Array(t.length), rtl: false };
      paras.push({ s: p, e: p + t.length, t, levels: lv.levels, rtl: lv.rtl });
      p += t.length + 1;
    }
  }
  const pieceW = (P: RichPara, s: number, e: number, k: number): number => {
    const R = RR[k];
    if (e <= s) return 0;
    if (!R.pc) return measure(R.variant, text.slice(s, e), R.st.size);
    return shapePiece(P.t, P.levels, s - P.s, e - P.s, R.stack).width * R.st.size;
  };
  const rangeW = (P: RichPara, s: number, e: number): number => {
    let w = 0;
    for (let i = s; i < e;) { const k = kOf[i], j = Math.min(e, RR[k].e); w += pieceW(P, i, j, k); i = j; }
    return w;
  };
  const trimEnd = (s: number, e: number) => { while (e > s && text[e - 1] === ' ') e--; return e; };
  /** lines [s, e) (spaces at their ends left off) wrapped to `avail` pt, per paragraph */
  const breakLines = (avail: number): { s: number; e: number; p: number }[] => {
    const out: { s: number; e: number; p: number }[] = [];
    paras.forEach((P, pi) => {
      if (P.e === P.s) { out.push({ s: P.s, e: P.s, p: pi }); return; }
      // words: with the spaces after them
      const words: [number, number][] = [];
      let ws = P.s;
      for (let i = P.s + 1; i <= P.e; i++) if (i === P.e || (text[i - 1] === ' ' && text[i] !== ' ')) { words.push([ws, i]); ws = i; }
      let ls = -1, le = P.s, lw = 0;
      for (const [wa, wb] of words) {
        const wt = trimEnd(wa, wb);
        const full = rangeW(P, wa, wb), trimmed = wt === wb ? full : rangeW(P, wa, wt);
        if (ls >= 0 && lw + trimmed <= avail) { le = wb; lw += full; continue; }
        if (ls >= 0) out.push({ s: ls, e: trimEnd(ls, le), p: pi });
        ls = -1;
        if (trimmed <= avail) { ls = wa; le = wb; lw = full; continue; }
        // a word longer than the line: as many whole letters as fit (at least one)
        const ends = letterEndsIn(text, wa, wt);
        let cs = wa;
        while (cs < wt) {
          let ce = -1;
          for (const i of ends) { if (i <= cs) continue; if (ce < 0 || rangeW(P, cs, i) <= avail) ce = i; else break; }
          if (ce >= wt) { ls = cs; le = wb; lw = rangeW(P, cs, wb); break; }
          out.push({ s: cs, e: ce, p: pi });
          cs = ce;
        }
      }
      if (ls >= 0) out.push({ s: ls, e: trimEnd(ls, le), p: pi });
    });
    return out;
  };
  /** a line's pieces in the order they show, placed, with its height */
  const build = (L: { s: number; e: number; p: number }): RichLine => {
    const P = paras[L.p];
    let items: RichItem[] = [];
    for (let i = L.s; i < L.e;) {
      const k = kOf[i];
      let j = Math.min(L.e, RR[k].e);
      const lv = rtlText ? P.levels[i - P.s] : 0;
      if (rtlText) { let m = i + 1; while (m < j && P.levels[m - P.s] === lv) m++; j = m; }
      items.push({ s: i, e: j, k, lv, x: 0, w: 0 });
      i = j;
    }
    if (rtlText) items = reorderL2(items);
    let x = 0;
    let asc = bm.asc * base.size, below = bm.below * base.size, lh = bm.lhf * base.size;
    for (const it of items) {
      const R = RR[it.k];
      if (R.pc) { const sh = shapePiece(P.t, P.levels, it.s - P.s, it.e - P.s, R.stack); it.glyphs = sh.glyphs; it.w = sh.width * R.st.size; }
      else it.w = measure(R.variant, text.slice(it.s, it.e), R.st.size);
      it.x = x;
      x += it.w;
      asc = Math.max(asc, R.asc * R.st.size); below = Math.max(below, R.below * R.st.size); lh = Math.max(lh, R.lhf * R.st.size);
    }
    return { items, w: x, rtl: P.rtl, asc, below, lh };
  };
  const heightOf = (ls: RichLine[]) => {
    if (!ls.length) return (bm.asc + bm.below) * base.size;
    let h = 0;
    for (let i = 0; i < ls.length - 1; i++) h += ls[i].lh;
    return h + ls[ls.length - 1].asc + ls[ls.length - 1].below;
  };
  const colorOp = (c: number[]) => (c.length === 1 ? `${+c[0].toFixed(4)} g` : c.length === 4 ? `${c.map((v) => +v.toFixed(4)).join(' ')} k` : `${c.map((v) => +v.toFixed(4)).join(' ')} rg`);
  for (let round = 0; round < 4; round++) {
    const ap = obj.get('AP', 'N');
    if (ap.isNull() || !ap.isStream()) return false;
    const srcAp = ap.readStream().asString();
    const m = /\nq\n(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) cm\nBT\n[\s\S]*?ET\nQ/.exec(srcAp);
    if (!m && text.trim()) return false;
    const fontsRes = ap.get('Resources').get('Font');
    if (fontsRes.isNull()) return false;
    const M = m ? m.slice(1, 7).map(Number) : [1, 0, 0, 1, 0, 0];
    // the box inside its border, in the text's own frame (as layoutFreeText)
    const R0 = arr(obj.get('Rect'), [0, 0, 1, 1]);
    const rd = obj.get('RD').isArray() ? arr(obj.get('RD'), [0, 0, 0, 0]) : [0, 0, 0, 0];
    const bw = a.hasBorder() ? a.getBorderWidth() : 0;
    const box = [Math.min(R0[0], R0[2]) + rd[0] + bw, Math.min(R0[1], R0[3]) + rd[1] + bw, Math.max(R0[0], R0[2]) - rd[2] - bw, Math.max(R0[1], R0[3]) - rd[3] - bw];
    const Mi = mupdf.Matrix.invert(M as unknown as mupdf.Matrix) as unknown as number[];
    const cs = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(([x, y]) => [Mi[0] * x + Mi[2] * y + Mi[4], Mi[1] * x + Mi[3] * y + Mi[5]]);
    const x0 = Math.min(...cs.map((c) => c[0])), x1 = Math.max(...cs.map((c) => c[0])), y0 = Math.min(...cs.map((c) => c[1])), y1 = Math.max(...cs.map((c) => c[1]));
    const P = kind === 'typewriter' ? TYPE_PAD : TEXT_PAD;
    const px = P.x, pt = P.top, pb = P.bottom;
    const autoMax = obj.get('GCCAuto').isNumber() ? obj.get('GCCAuto').asNumber() : 0;
    if (autoMax > 0 && round < 3) {
      const wrapAt = Math.max(base.size, autoMax - 2 * bw - 2 * px);
      const ls = breakLines(wrapAt).map(build);
      const textW = Math.max(base.size * AUTO_MIN, ...ls.map((l) => l.w));
      const dW = textW + 2 * px + 0.02 - (x1 - x0), dH = pt + pb + heightOf(ls) - (y1 - y0);
      if (Math.abs(dW) > 0.3 || Math.abs(dH) > 0.3) {
        const r = a.getRect();
        boxKeepTip(o, a, [r[0], r[1], Math.max(r[0] + 2, r[2] + dW), Math.max(r[1] + 2, r[3] + dH)]);
        updateQuiet(a);
        continue;
      }
    }
    const avail = Math.max(base.size, x1 - x0 - 2 * px);
    const lines = breakLines(avail).map(build);
    const need = pt + pb + (text ? heightOf(lines) : 0);
    if (need > y1 - y0 + 0.01 && round < 3) {
      const r = a.getRect();
      boxKeepTip(o, a, [r[0], r[1], r[2], r[3] + (need - (y1 - y0)) + 0.5]);
      updateQuiet(a);
      continue;
    }
    if (!m) return true;
    const q = a.getQuadding();
    const ops = ['q', M.join(' ') + ' cm', 'BT'];
    const under: string[] = [];
    const names = new Map<string, string>();
    const resName = (key: string, mk: () => mupdf.PDFObject) => {
      let n = names.get(key);
      if (!n) { n = 'GCCr' + names.size; names.set(key, n); fontsRes.put(n, mk()); }
      return n;
    };
    const shaped: Line[] = [];
    let col = '';
    let top = y1 - pt;
    for (const L of lines) {
      const al = L.rtl && q === 0 ? 2 : q;
      const x = x0 + px + (al === 1 ? (avail - L.w) / 2 : al === 2 ? avail - L.w : 0);
      const y = top - L.asc;
      for (const it of L.items) {
        const R = RR[it.k], size = R.st.size;
        const c = colorOp(R.st.color);
        if (c !== col) { ops.push(c); col = c; }
        const xi = x + it.x;
        if (it.glyphs) {
          const line: Line = { glyphs: it.glyphs, width: it.w / size, text: '', rtl: it.lv % 2 === 1 };
          ops.push(...lineOps(line, xi, y, size, (f) => resName(f.key, () => embedFont(o, f))));
          shaped.push(line);
        } else ops.push(`/${resName(R.variant, () => stdFont(o, R.variant))} ${+size.toFixed(3)} Tf`, `1 0 0 1 ${+xi.toFixed(3)} ${+y.toFixed(3)} Tm ${pdfString(text.slice(it.s, it.e))} Tj`);
        if (R.st.underline && it.w > 0) under.push(`${c} ${+xi.toFixed(3)} ${+(y - 0.125 * size).toFixed(3)} ${+it.w.toFixed(3)} ${+Math.max(0.4, 0.05 * size).toFixed(3)} re f`);
      }
      top -= L.lh;
    }
    ops.push('ET', ...under, 'Q');
    ap.writeStream(srcAp.slice(0, m.index + 1) + ops.join('\n') + srcAp.slice(m.index + m[0].length));
    if (shaped.length) noteGlyphs(o, shaped);
    return true;
  }
  return true;
}

/**
 * A text box grows (downwards) until all its text shows: MuPDF wraps the text to the box width
 * and simply cuts off what doesn't fit, so typed text could vanish below the box.
 */
function fitText(o: Open, a: mupdf.PDFAnnotation) {
  const want = (a.getContents() || '').replace(/\s+/g, '').length;
  if (!want) return;
  let size = 11;
  try { size = a.getDefaultAppearance().size || 11; } catch { /* default */ }
  for (let k = 0; k < 60; k++) {
    let got = 0;
    const st = a.toDisplayList().toStructuredText('');
    st.walk({ onChar(c: string) { if (c.trim()) got++; } } as never);
    st.destroy?.();
    if (got >= want) return;
    const r = a.getRect();
    boxKeepTip(o, a, [r[0], r[1], r[2], r[3] + size * 1.2]);
    updateQuiet(a);
  }
}

/** a copy of a stream object (MuPDF rewrites an appearance stream in place when it redraws) */
function cloneStream(o: Open, s: mupdf.PDFObject): mupdf.PDFObject {
  const d = o.doc.newDictionary();
  s.resolve().forEach((v: mupdf.PDFObject, k: string | number) => { if (String(k) !== 'Length' && String(k) !== 'Filter' && String(k) !== 'DecodeParms') d.put(String(k), v); });
  return o.doc.addStream(s.readStream(), d);
}

/** the appearance a stamp had before we turned it (our turn wraps it as /X0) */
function unwrapped(obj: mupdf.PDFObject): mupdf.PDFObject | null {
  const ap = obj.get('AP', 'N');
  if (!ap.isStream()) return null;
  const ang = num(obj.get('GCCAngle')) ?? 0;
  if (ang) { const x0 = ap.get('Resources', 'XObject', 'X0'); if (x0.isStream()) return x0; }
  return ap;
}

/** a kept appearance stretched into the markup's box, with its opacity */
function placeAppearance(o: Open, a: mupdf.PDFAnnotation, ap: mupdf.PDFObject) {
  const obj = a.getObject();
  const r = arr(obj.get('Rect'), [0, 0, 1, 1]);
  const bb = arr(ap.get('BBox'), [0, 0, 1, 1]);
  const mx = arr(ap.get('Matrix'), [1, 0, 0, 1, 0, 0]);
  const cs = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(([x, y]) => [mx[0] * x + mx[2] * y + mx[4], mx[1] * x + mx[3] * y + mx[5]]);
  const tx0 = Math.min(...cs.map((c) => c[0])), tx1 = Math.max(...cs.map((c) => c[0])), ty0 = Math.min(...cs.map((c) => c[1])), ty1 = Math.max(...cs.map((c) => c[1]));
  const rx0 = Math.min(r[0], r[2]), ry0 = Math.min(r[1], r[3]), rx1 = Math.max(r[0], r[2]), ry1 = Math.max(r[1], r[3]);
  // fitted to the box as the page is SHOWN: on a page turned a quarter the picture stays upright
  // and keeps its shape (it was drawn on its side and stretched, in other PDF programs too)
  const C = pageCtmOf(o, a);
  const Ci = mupdf.Matrix.invert(C as unknown as mupdf.Matrix) as unknown as number[];
  const shown = [[rx0, ry0], [rx1, ry0], [rx1, ry1], [rx0, ry1]].map(([x, y]) => [C[0] * x + C[2] * y + C[4], C[1] * x + C[3] * y + C[5]]);
  const dx0 = Math.min(...shown.map((q) => q[0])), dx1 = Math.max(...shown.map((q) => q[0])), dy0 = Math.min(...shown.map((q) => q[1])), dy1 = Math.max(...shown.map((q) => q[1]));
  const sxd = (dx1 - dx0) / Math.max(1e-6, tx1 - tx0), syd = (dy1 - dy0) / Math.max(1e-6, ty1 - ty0);
  // picture (y up) -> page as shown (y down) -> the page's own space
  const A0 = mul([sxd, 0, 0, -syd, dx0 - tx0 * sxd, dy0 + ty1 * syd], Ci);
  let op = 1;
  try { op = a.getOpacity(); } catch { /* 1 */ }
  const res = o.doc.newDictionary();
  const xo = o.doc.newDictionary();
  xo.put('X0', ap);
  res.put('XObject', xo);
  if (op < 1) { const g = o.doc.newDictionary(); const g0 = o.doc.newDictionary(); g0.put('Type', o.doc.newName('ExtGState')); g0.put('ca', op); g0.put('CA', op); g.put('G0', g0); res.put('ExtGState', g); }
  const wrap = o.doc.addStream(`q ${op < 1 ? '/G0 gs ' : ''}${fmt(A0)} cm /X0 Do Q`, { Type: 'XObject', Subtype: 'Form', BBox: [rx0, ry0, rx1, ry1], Resources: res });
  const apd = o.doc.newDictionary();
  apd.put('N', wrap);
  obj.put('AP', apd);
}

/** wrap the markup's appearance in a rotation about its centre (as seen on the page) */
function rotateAppearance(o: Open, a: mupdf.PDFAnnotation, deg: number) {
  const obj = a.getObject();
  let ap = obj.get('AP', 'N');
  if (ap.isNull() || !ap.isStream()) return;
  // the page this markup is on (for its user-space <-> page-space matrix) - also when that page
  // isn't among the pages read in, or the markup has no /P (the identity turned it the other way)
  const C = pageCtmOf(o, a);
  const Ci = mupdf.Matrix.invert(C as unknown as mupdf.Matrix) as unknown as number[];
  const r = arr(obj.get('Rect'), [0, 0, 1, 1]);
  const bb = arr(ap.get('BBox'), [0, 0, 1, 1]);
  const mx = arr(ap.get('Matrix'), [1, 0, 0, 1, 0, 0]);
  // appearance -> Rect (PDF 12.5.5)
  const cs = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(([x, y]) => [mx[0] * x + mx[2] * y + mx[4], mx[1] * x + mx[3] * y + mx[5]]);
  const tx0 = Math.min(...cs.map((c) => c[0])), tx1 = Math.max(...cs.map((c) => c[0])), ty0 = Math.min(...cs.map((c) => c[1])), ty1 = Math.max(...cs.map((c) => c[1]));
  const rx0 = Math.min(r[0], r[2]), ry0 = Math.min(r[1], r[3]), rx1 = Math.max(r[0], r[2]), ry1 = Math.max(r[1], r[3]);
  const sx = (rx1 - rx0) / Math.max(1e-6, tx1 - tx0), sy = (ry1 - ry0) / Math.max(1e-6, ty1 - ty0);
  // (the form applies its own /Matrix when drawn, so it is not part of this placement)
  const A0 = [sx, 0, 0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy];
  // rotation in page space about the box centre, carried into user space
  const cu = [(rx0 + rx1) / 2, (ry0 + ry1) / 2];
  const cp = [C[0] * cu[0] + C[2] * cu[1] + C[4], C[1] * cu[0] + C[3] * cu[1] + C[5]];
  const th = (deg * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th);
  const Rp = mul(mul([1, 0, 0, 1, -cp[0], -cp[1]], [co, si, -si, co, 0, 0]), [1, 0, 0, 1, cp[0], cp[1]]);
  const Ru = mul(mul(C, Rp), Ci);
  const M = mul(A0, Ru);
  const pts = cs.map(([x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]]);
  const nb = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  ap.put('Type', 'XObject');
  ap.put('Subtype', 'Form');
  const wrap = o.doc.addStream(`q ${fmt(M)} cm /X0 Do Q`, { Type: 'XObject', Subtype: 'Form', BBox: nb, Resources: { XObject: { X0: ap } } });
  const apd = o.doc.newDictionary();
  apd.put('N', wrap);
  obj.put('AP', apd);
  obj.put('Rect', nb);
}

export function createAnnot(id: string, page: number, s: AnnotSpec): AnnotData {
  const o = O(id);
  return op(o, 'Add ' + (s.kind || s.type).toLowerCase(), 'a', () => {
    const p = pg(o, page);
    const a = p.createAnnotation(s.type);
    if (o.author) a.setAuthor(o.author);
    a.setCreationDate(new Date());
    a.setFlags(PRINT);
    apply(o, a, s, true);
    if (s.irt != null) {
      const parent = find(o, page, s.irt);
      a.getObject().put('IRT', parent.getObject());
      a.setRect(parent.hasRect() ? parent.getRect() : parent.getBounds());
      a.setHiddenForEditing(true);
    }
    finish(o, a);
    return readAnnot(a, page, o);
  });
}

/** several markups in one go (one undo step), e.g. every hit of a redaction search */
export function createAnnots(id: string, items: { page: number; spec: AnnotSpec }[], name = 'Add markups'): AnnotData[] {
  const o = O(id);
  const make = ({ page, spec }: { page: number; spec: AnnotSpec }) => {
    const a = pg(o, page).createAnnotation(spec.type);
    if (o.author) a.setAuthor(o.author);
    a.setCreationDate(new Date());
    a.setFlags(PRINT);
    apply(o, a, spec, true);
    finish(o, a);
    return readAnnot(a, page, o);
  };
  return opParts(o, name, items, make);
}

/** many markups in one undo step, done in parts of 60: one MuPDF operation slows with every
 *  change in it (600 markups made in one: 6-12 s, in parts 0.5 s; see copyToPages). first: run
 *  once at the start of the step */
function opParts<I, R>(o: Open, name: string, items: I[], each: (x: I) => R, first?: () => void, join = false): R[] {
  const out: R[] = [];
  for (let i = 0; i < items.length || i === 0; i += 60) out.push(...op(o, name, 'a', () => { if (i === 0) first?.(); return items.slice(i, i + 60).map(each); }, i > 0 || join));
  return out;
}

/** join: part of the step before (measurements pasted or moved, their numbers worked out again
 *  where they now are: one Undo for both) */
export function updateAnnots(id: string, items: { page: number; id: number; patch: Partial<AnnotSpec> }[], name = 'Change markup', data?: Record<string, unknown>, join = false): AnnotData[] {
  const o = O(id);
  // (with the file's own settings changed in the same step: one Undo for both)
  return opParts(o, name, items, ({ page, id: aid, patch }) => {
    const a = findToChange(o, page, aid);
    apply(o, a, patch, false);
    finish(o, a);
    return readAnnot(a, page, o);
  }, () => { if (data) o.doc.getTrailer().get('Root').put('GCCData', o.doc.newString(JSON.stringify(data))); }, join);
}

/**
 * Copies of markups (copy / paste / duplicate), from this or another open file, onto a page,
 * shifted by (dx, dy) points. Everything is copied (style, text, measurement data, stamp
 * pictures) except the page link, pop-up and replies. One undo step.
 */
export function copyAnnots(fromId: string, items: { page: number; id: number }[], id: string, page: number, dx: number, dy: number): AnnotData[] {
  const src = O(fromId), o = O(id);
  return op(o, items.length > 1 ? 'Paste markups' : 'Paste markup', 'a', () => copyInto(src, o, items, page, dx, dy));
}

/**
 * Copies of markups on other pages of the same file (a stamp on every sheet): each group is the
 * markups of one page with the pages they go to, each shifted by its own (dx, dy). One undo step
 * for all - made in parts of a few dozen copies (in one MuPDF operation 400 copies took 26 s,
 * 1,500 never finished; in parts it grows in step with the number of pages).
 */
export function copyToPages(id: string, groups: { items: { page: number; id: number }[]; targets: { page: number; dx: number; dy: number }[] }[]): AnnotData[] {
  const o = O(id);
  const jobs = groups.flatMap((g) => g.targets.map((t) => ({ items: g.items, t })));
  const out: AnnotData[] = [];
  const PART = Math.max(1, Math.floor(60 / Math.max(1, Math.max(...groups.map((g) => g.items.length)))));
  for (let i = 0; i < jobs.length; i += PART) {
    const part = jobs.slice(i, i + PART);
    out.push(...op(o, 'Copy to pages', 'a', () => part.flatMap((j) => copyInto(o, o, j.items, j.t.page, j.t.dx, j.t.dy)), i > 0));
  }
  return out;
}

function copyInto(src: Open, o: Open, items: { page: number; id: number }[], page: number, dx: number, dy: number): AnnotData[] {
  const same = src === o;
  const SKIP = new Set(['Type', 'Subtype', 'P', 'Popup', 'IRT', 'NM', 'Parent', 'StructParent', 'AP', 'AS', 'OC']);
  const clone = (v: mupdf.PDFObject, deepStreams: boolean): mupdf.PDFObject => {
    if (v.isIndirect()) {
      if (!same) return o.doc.graftObject(v);
      if (deepStreams && v.isStream()) {
        const d = clone(v.resolve(), false);
        return o.doc.addRawStream(v.readRawStream(), d);
      }
      return v;
    }
    if (v.isArray()) { const a = o.doc.newArray(); for (let i = 0; i < v.length; i++) a.push(clone(v.get(i), deepStreams)); return a; }
    if (v.isDictionary()) {
      const d = o.doc.newDictionary();
      v.forEach((x: mupdf.PDFObject, k: string | number) => { if (String(k) !== 'Length' || !deepStreams) d.put(String(k), clone(x, deepStreams)); });
      return d;
    }
    return v;
  };
  {
    const dp = pg(o, page);
    const Cd = dp.getTransform() as unknown as number[];
    const Cdi = mupdf.Matrix.invert(Cd as unknown as mupdf.Matrix) as unknown as number[];
    const out: AnnotData[] = [];
    for (const it of items) {
      const a = find(src, it.page, it.id);
      const t = a.getType();
      if (t === 'Widget' || t === 'Popup' || t === 'Link') continue;
      const so = a.getObject();
      if (!so.get('IRT').isNull()) continue; // replies go with nothing
      const Cs = pg(src, it.page).getTransform() as unknown as number[];
      const b = dp.createAnnotation(t as mupdf.PDFAnnotationType);
      const bo = b.getObject();
      // (a callout's line is made again below: its old points, read on a page turned another way,
      // could lie thousands of points off - MuPDF then never finished working out the box)
      so.forEach((v: mupdf.PDFObject, k: string | number) => { const key = String(k); if (!SKIP.has(key) && !(t === 'FreeText' && (key === 'CL' || key === 'RD'))) bo.put(key, clone(v, false)); });
      // the picture of stamps / images (MuPDF can't draw those again)
      const ap = so.get('AP', 'N');
      if (t === 'Stamp' && ap.isStream()) { const d = o.doc.newDictionary(); d.put('N', same ? clone(ap, true) : o.doc.graftObject(ap)); bo.put('AP', d); }
      // another program's text box: the copy keeps its look (MuPDF's drawing of its rich text came
      // out garbled); one with a callout line is drawn by this app (the line is routed again)
      const foreign = foreignText(a);
      if (foreign && !calloutOf(src, a).length) { bo.put('GCCAP', same ? clone(ap, true) : o.doc.graftObject(ap)); bo.put('GCCKeepLook', true); }
      if (o.author) b.setAuthor(o.author);
      b.setCreationDate(new Date());
      b.setModificationDate(new Date());
      bo.delete('Locked');
      // not locked, not hidden; printing as the original does (one kept out of print stays so)
      b.setFlags(b.getFlags() & ~(LOCKED | HIDDEN));
      // same place on the page as the original (pages may differ in size / turn), then shifted
      const tip = calloutOf(src, a)[0];
      const f = (q: Pt): Pt => {
        const u = [Cdi[0] * q[0] + Cdi[2] * q[1] + Cdi[4], Cdi[1] * q[0] + Cdi[3] * q[1] + Cdi[5]];
        return [Cs[0] * u[0] + Cs[2] * u[1] + Cs[4] + dx, Cs[1] * u[0] + Cs[3] * u[1] + Cs[5] + dy];
      };
      const gb = so.get('GCCBox');
      if (!gb.isNull()) {
        // a turned markup: its box is kept in page space already
        const g = arr(gb, [0, 0, 1, 1]);
        bo.put('GCCBox', [g[0] + dx, g[1] + dy, g[2] + dx, g[3] + dy]);
      } else if (['FreeText', 'Stamp', 'Text', 'Redact', 'Square', 'Circle'].includes(t)) {
        // boxes: the original's box (page space) shifted - its /Rect may hold a callout line too
        const r = a.getRect();
        b.setRect([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
      } else transformAnnot(b, f);
      // a callout's tip stays on the page (pasted far from where it was copied, it could land
      // thousands of points off the sheet)
      if (tip) { const pb = dp.getBounds(); tip[0] = Math.max(pb[0] - dx, Math.min(pb[2] - dx, tip[0])); tip[1] = Math.max(pb[1] - dy, Math.min(pb[3] - dy, tip[1])); }
      if (tip) setCallout(o, b, calloutPath(b.getRect() as Rect, [tip[0] + dx, tip[1] + dy]));
      if (foreign && tip) adoptText(o, b);
      finish(o, b);
      // another program's markup (hatching, pattern fills, its own clouds): where the copy is the
      // original shifted (both pages turned the same way) its own drawing goes along, shifted -
      // drawn again by MuPDF it came out in MuPDF's plain style (a move kept it). Text boxes and
      // stamps are handled above; this app's own kinds are drawn again the same.
      if (t !== 'FreeText' && t !== 'Stamp' && so.get('GCCKind').isNull() && gb.isNull() && ap.isStream() && Cs.slice(0, 4).every((v, i) => Math.abs(v - Cd[i]) < 1e-6)) {
        try {
          // (where the original's user-space origin lands on this page: the shift in user space)
          const sx = Cs[4] + dx, sy = Cs[5] + dy;
          const ux = Cdi[0] * sx + Cdi[2] * sy + Cdi[4], uy = Cdi[1] * sx + Cdi[3] * sy + Cdi[5];
          const r0 = arr(so.get('Rect'), [0, 0, 0, 0]);
          const look = same ? cloneStream(o, ap) : o.doc.graftObject(ap);
          bo.put('Rect', [r0[0] + ux, r0[1] + uy, r0[2] + ux, r0[3] + uy]);
          // (the inner box as the original has it - MuPDF's drawing set one of its own)
          const rd = so.get('RD');
          if (rd.isArray()) bo.put('RD', clone(rd, false)); else bo.delete('RD');
          const apd = o.doc.newDictionary();
          apd.put('N', look);
          bo.put('AP', apd);
        } catch { /* MuPDF's drawing stays */ }
      }
      out.push(readAnnot(b, page, o));
    }
    return out;
  }
}

/** the hidden file a cut keeps its markups in (the originals are deleted straight away) */
export const CLIP = '\u0000clip';
/**
 * Cut: copies of the markups go into a hidden clipboard file first - pages there have the same
 * box and turn as the ones they came from, so pasting from it puts them where a copy from the
 * original would. Returns where the copies are (one clipboard page per source page, in order).
 */
export function clipStore(fromId: string, items: { page: number; id: number }[]): { page: number; id: number }[] {
  const src = O(fromId);
  close(CLIP);
  const doc = new mupdf.PDFDocument();
  const o: Open = { doc, pages: new Map(), undo: [], redo: [], fonts: new Map(), author: src.author, changedContent: true };
  docs.set(CLIP, o);
  doc.enableJournal();
  const from = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
  const out: { page: number; id: number }[] = [];
  from.forEach((sp, k) => {
    const so = pg(src, sp).getObject();
    const mb = arr(so.getInheritable('MediaBox'), [0, 0, 612, 792]) as Rect;
    let rot = 0;
    try { rot = so.getInheritable('Rotate').asNumber() || 0; } catch { /* none */ }
    const np = doc.addPage(mb, (((rot % 360) + 360) % 360) as mupdf.Rotate, {}, '');
    const cb = so.getInheritable('CropBox');
    if (cb.isArray()) np.put('CropBox', arr(cb, mb));
    const uu = so.get('UserUnit');
    if (uu.isNumber()) np.put('UserUnit', uu.asNumber());
    doc.insertPage(k, np);
    for (const a of copyAnnots(fromId, items.filter((i) => i.page === sp), CLIP, k, 0, 0)) out.push({ page: k, id: a.id });
  });
  return out;
}

/** move markups by (dx, dy) points */
export function moveAnnots(id: string, items: { page: number; id: number }[], dx: number, dy: number): AnnotData[] {
  const o = O(id);
  return opParts(o, 'Move', items, ({ page, id: aid }) => {
    const a = findToChange(o, page, aid);
    const obj = a.getObject();
    // moving keeps the markup's own drawing, just shifted: markups made in other programs
    // (hatches, rich text, their own clouds) used to be redrawn by MuPDF in its own style.
    // (Not a callout: its line has to be routed again.)
    const n = obj.get('AP', 'N');
    const keep = n.isStream() && !(a.getType() === 'FreeText' && calloutOf(o, a).length) ? cloneStream(o, n) : null;
    const r0 = arr(obj.get('Rect'), [0, 0, 0, 0]);
    transformAnnot(a, (p) => [p[0] + dx, p[1] + dy]);
    if (!keep) finish(o, a);
    else {
      updateQuiet(a); // (clears MuPDF's "draw again" mark - it would redraw it later otherwise)
      const C = pageCtmOf(o, a);
      const Ci = mupdf.Matrix.invert(C as unknown as mupdf.Matrix) as unknown as number[];
      const ux = Ci[0] * dx + Ci[2] * dy, uy = Ci[1] * dx + Ci[3] * dy;
      obj.put('Rect', [r0[0] + ux, r0[1] + uy, r0[2] + ux, r0[3] + uy]);
      const apd = o.doc.newDictionary();
      apd.put('N', keep);
      obj.put('AP', apd);
    }
    return readAnnot(a, page, o);
  });
}

/** resize one markup from its old box to a new box */
export function resizeAnnot(id: string, page: number, aid: number, to: Rect): AnnotData {
  const o = O(id);
  return op(o, 'Resize', 'a', () => {
    const a = findToChange(o, page, aid);
    // a text box given a size by hand keeps it (no longer fits itself to the text)
    // another program's text box: its text is set again to the new width, by this app
    if (adoptable(a) || keepsLook(a)) adoptText(o, a);
    if (a.getType() === 'FreeText') a.getObject().delete('GCCAuto');
    if (!a.getObject().get('GCCBox').isNull()) { a.getObject().put('GCCBox', ordered(to)); finish(o, a); return readAnnot(a, page, o); }
    const from = annotBox(a);
    const sx = (to[2] - to[0]) / Math.max(0.01, from[2] - from[0]);
    const sy = (to[3] - to[1]) / Math.max(0.01, from[3] - from[1]);
    transformAnnot(a, (p) => [to[0] + (p[0] - from[0]) * sx, to[1] + (p[1] - from[1]) * sy], to);
    finish(o, a);
    return readAnnot(a, page, o);
  });
}

/** the box the user sees as the markup's outline (geometry, not the wider drawn bounds) */
function annotBox(a: mupdf.PDFAnnotation): Rect {
  const pts: Pt[] = [];
  if (a.hasVertices()) a.getVertices().forEach((p) => pts.push([p[0], p[1]]));
  else if (a.hasLine()) a.getLine().forEach((p) => pts.push([p[0], p[1]]));
  else if (a.hasInkList()) a.getInkList().forEach((s) => s.forEach((p) => pts.push([p[0], p[1]])));
  else if (a.hasQuadPoints()) a.getQuadPoints().forEach((q) => { for (let i = 0; i < 8; i += 2) pts.push([q[i], q[i + 1]]); });
  if (!pts.length) return (a.hasRect() ? a.getRect() : a.getBounds()) as Rect;
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

function transformAnnot(a: mupdf.PDFAnnotation, f: (p: Pt) => Pt, newRect?: Rect) {
  const gb = a.getObject().get('GCCBox');
  if (!gb.isNull()) {
    const b = arr(gb, [0, 0, 1, 1]);
    if (newRect) a.getObject().put('GCCBox', ordered(newRect));
    else { const p1 = f([b[0], b[1]]), p2 = f([b[2], b[3]]); a.getObject().put('GCCBox', ordered([p1[0], p1[1], p2[0], p2[1]])); }
    return;
  }
  const tp = (p: mupdf.Point) => f([p[0], p[1]]) as unknown as mupdf.Point;
  if (a.hasQuadPoints()) {
    a.setQuadPoints(a.getQuadPoints().map((q) => { const r: number[] = []; for (let i = 0; i < 8; i += 2) { const n = f([q[i], q[i + 1]]); r.push(n[0], n[1]); } return r as unknown as mupdf.Quad; }));
  }
  if (a.hasVertices()) a.setVertices(a.getVertices().map(tp));
  else if (a.hasLine()) { const l = a.getLine(); a.setLine(tp(l[0]), tp(l[1])); }
  else if (a.hasInkList()) a.setInkList(a.getInkList().map((s) => s.map(tp)));
  else if (a.hasRect()) {
    const r = a.getRect();
    // (a callout's line as it was: MuPDF moves it along with the box - wrongly on pages turned 270
    // degrees; finish() routes it again from its tip)
    const cl = a.getType() === 'FreeText' ? a.getObject().get('CL') : null;
    const clKeep = cl && cl.isArray() ? arr(cl, []) : null;
    // (always in order: MuPDF never comes back from an upside-down box on a callout)
    if (newRect) a.setRect(ordered(newRect));
    else { const p1 = f([r[0], r[1]]), p2 = f([r[2], r[3]]); a.setRect(ordered([p1[0], p1[1], p2[0], p2[1]])); }
    if (clKeep) a.getObject().put('CL', clKeep);
  }
  // a callout's tip stays where it points; finish() fits the rest of the line to the box
}

export function deleteAnnots(id: string, items: { page: number; id: number }[]): number {
  const o = O(id);
  return op(o, items.length > 1 ? 'Delete ' + items.length + ' markups' : 'Delete markup', 'a', () => {
    let n = 0;
    for (const { page, id: aid } of items) {
      const p = pg(o, page);
      // (already gone - an undo, another window: nothing to delete)
      let a: mupdf.PDFAnnotation;
      try { a = find(o, page, aid); } catch { continue; }
      if (a.getFlags() & LOCKED) continue;
      // replies go with it - unless one of them is locked: then the whole thread stays (a locked
      // reply was deleted with its comment)
      const replies = threadOf(p, aid);
      if (replies.some((r) => r.getFlags() & LOCKED)) continue;
      for (const r of replies) { noteDropped(o, r); p.deleteAnnotation(r); }
      noteDropped(o, a);
      p.deleteAnnotation(a);
      n++;
    }
    return n;
  });
}

/**
 * The replies to a markup on its page, and the replies to those (the whole thread). A list of
 * its own: MuPDF's list shrinks as markups are deleted - going through it while deleting skipped
 * every other reply (left behind, pointing at nothing, never shown but still in the file).
 */
function threadOf(p: mupdf.PDFPage, aid: number): mupdf.PDFAnnotation[] {
  const all = [...p.getAnnotations()];
  const ids = new Set([aid]);
  const out: mupdf.PDFAnnotation[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const r of all) {
      if (out.includes(r)) continue;
      const irt = r.getObject().get('IRT');
      if (!irt.isNull() && ids.has(irt.asIndirect())) { out.push(r); ids.add(r.getObject().asIndirect()); grew = true; }
    }
  }
  return out;
}
/** a markup that came with the file is about to go (see Open.droppedAnnots) */
function noteDropped(o: Open, a: mupdf.PDFAnnotation) {
  try { if (o.fileObjs && a.getObject().asIndirect() < o.fileObjs) o.droppedAnnots = true; } catch { /* not in the file */ }
}

// ---------------------------------------------------------------- stamps

export interface StampDesign {
  lines: { text: string; size: number; bold?: boolean }[];
  color: RGB;
  border: 'box' | 'rounded' | 'double' | 'none';
  fill?: RGB | null;
  fillOpacity?: number;
}

function stdFont(o: Open, name: string): mupdf.PDFObject {
  let f = o.fonts.get(name);
  // (an undo can take the font object away again: then make a new one)
  if (f && !ourObj(o, f, 'GCCStd', name)) f = undefined;
  if (!f) {
    // written by hand: MuPDF's addSimpleFont hands back the font it made before - even when an
    // undo has removed that object since
    const d = o.doc.newDictionary();
    d.put('Type', o.doc.newName('Font'));
    d.put('Subtype', o.doc.newName('Type1'));
    d.put('BaseFont', o.doc.newName(name));
    d.put('Encoding', o.doc.newName('WinAnsiEncoding'));
    d.put('GCCStd', o.doc.newName(name));
    f = o.doc.addObject(d);
    o.fonts.set(name, f);
  }
  return f;
}

/**
 * An object we made and marked (key = value) that is still that object. An undo removes the
 * objects an operation made, and their numbers are then handed to the next new objects - a
 * remembered reference could point at a markup instead of a font. (Numbers past the end aren't
 * resolved at all: MuPDF logs a warning for each.)
 */
function ourObj(o: Open, f: mupdf.PDFObject | undefined, key: string, value: string): boolean {
  if (!f) return false;
  try {
    const n = f.asIndirect();
    if (n <= 0 || n >= o.doc.countObjects()) return false;
    const d = f.resolve();
    if (!d.isDictionary()) return false;
    const v = d.get(key);
    return v.isString() ? v.asString() === value : v.isName() ? v.asName() === value : false;
  } catch { return false; }
}
/** a font object MuPDF handed back is really a font of that kind (see ourObj) */
function isFont(o: Open, f: mupdf.PDFObject, subtype: string): boolean {
  try {
    const n = f.asIndirect();
    if (n <= 0 || n >= o.doc.countObjects()) return false;
    const d = f.resolve();
    return d.isDictionary() && d.get('Type').isName() && d.get('Type').asName() === 'Font' && d.get('Subtype').isName() && d.get('Subtype').asName() === subtype;
  } catch { return false; }
}

/**
 * MuPDF keeps the font it made for text box appearances; once an undo has removed that font
 * object, every later text box pointed at nothing (no text in other PDF programs / when printed).
 */
function fixFreeTextFont(o: Open, a: mupdf.PDFAnnotation) {
  const fonts = a.getObject().get('AP', 'N', 'Resources', 'Font');
  if (!fonts.isDictionary()) return;
  const names: string[] = [];
  fonts.forEach((_v: mupdf.PDFObject, k: string | number) => names.push(String(k)));
  // always our own font object (checking MuPDF's for life logs a "format error" each time)
  for (const k of names) if (FT_FONT[k]) fonts.put(k, stdFont(o, FT_FONT[k] as 'Helvetica'));
}

const fontCache = new Map<string, mupdf.Font>();
function measure(name: string, text: string, size: number): number {
  let f = fontCache.get(name);
  if (!f) { f = new mupdf.Font(name); fontCache.set(name, f); }
  let w = 0;
  for (const ch of text) w += f.advanceGlyph(f.encodeCharacter(ch.codePointAt(0)!));
  return w * size;
}

/** PDF literal string in WinAnsi (characters outside it become '?') */
export function pdfString(s: string): string {
  const win: Record<number, number> = { 0x20ac: 0x80, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99 };
  let out = '(';
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (win[c]) c = win[c];
    else if (c > 255) c = 63;
    if (c === 40 || c === 41 || c === 92) out += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}

export function stampSize(d: StampDesign): [number, number] {
  const pad = 8;
  let w = 0, h = pad;
  for (const l of d.lines) {
    w = Math.max(w, runWidth(l.text, l.size, !!l.bold));
    h += l.size * 1.18;
  }
  return [w + pad * 2 + (d.border === 'double' ? 6 : 0), h + pad + (d.border === 'double' ? 6 : 0)];
}

/** stamp appearance: vector box + text, so it stays sharp at any zoom and prints cleanly */
function drawStamp(o: Open, a: mupdf.PDFAnnotation, d: StampDesign) {
  const [W, H] = stampSize(d);
  const res = o.doc.addObject({
    Font: { FR: stdFont(o, 'Helvetica'), FB: stdFont(o, 'Helvetica-Bold') },
    ExtGState: { GS1: { Type: 'ExtGState', ca: d.fillOpacity ?? 0.12 } },
  });
  const ops = stampOps(o, d, W, H, res.get('Font'));
  const r = a.getRect();
  // keep the stamp's proportions: fit width to the rectangle, height follows
  const sc = (r[2] - r[0]) / W;
  a.setRect([r[0], r[1], r[2], r[1] + H * sc]);
  // drawn upright as the page is shown, whatever the page's /Rotate
  const C = pageCtmOf(o, a);
  const up = mul([1, 0, 0, -1, 0, 0], linInv(C));
  a.setAppearance(null, null, up as unknown as mupdf.Matrix, [0, 0, W, H], res, ops);
}

/**
 * A stamp design's drawing in its own space (W x H, y up): fill, border, lines of text. One
 * drawing for the stamp markup and for "Stamp on every page" (page marks drew square corners
 * for a rounded border and set the text 3 pt off for a double one). `fonts`: the drawing's font
 * resources (FR / FB; fonts from the PC are added for text the built-in ones can't show).
 */
function stampOps(o: Open, d: StampDesign, W: number, H: number, fonts: mupdf.PDFObject): string {
  const c = d.color.map((v) => v.toFixed(3)).join(' ');
  const s: string[] = [];
  s.push('q');
  if (d.fill) s.push(`/GS1 gs ${d.fill.map((v) => v.toFixed(3)).join(' ')} rg 1.5 1.5 ${W - 3} ${H - 3} re f`);
  s.push(`${c} RG 2 w`);
  const rr = (x: number, y: number, w: number, h: number, r: number) =>
    `${x + r} ${y} m ${x + w - r} ${y} l ${x + w} ${y} ${x + w} ${y + r} v ${x + w} ${y + h - r} l ${x + w} ${y + h} ${x + w - r} ${y + h} v ${x + r} ${y + h} l ${x} ${y + h} ${x} ${y + h - r} v ${x} ${y + r} l ${x} ${y} ${x + r} ${y} v h S`;
  if (d.border === 'box') s.push(`1 1 ${W - 2} ${H - 2} re S`);
  if (d.border === 'rounded') s.push(rr(1, 1, W - 2, H - 2, 6));
  if (d.border === 'double') { s.push(rr(1, 1, W - 2, H - 2, 6)); s.push('0.8 w'); s.push(rr(4, 4, W - 8, H - 8, 4)); }
  s.push('Q');
  s.push(`${TEXT_STATE} BT ${c} rg`);
  let y = H - 8 - (d.border === 'double' ? 3 : 0);
  const pc = (f: FontRef) => fontName(o, fonts, f);
  for (const l of d.lines) {
    y -= l.size;
    const run = textRun(o, l.text, l.size, !!l.bold, { base: () => (l.bold ? 'FB' : 'FR'), pc });
    s.push(run.ops((W - run.w) / 2, y));
    y -= l.size * 0.18;
  }
  s.push('ET');
  return s.join('\n');
}

/** the name a font from the PC has (or is given) in a font resource dictionary */
function fontName(o: Open, fonts: mupdf.PDFObject, f: FontRef): string {
  const ref = embedFont(o, f);
  let found = '';
  fonts.forEach((v: mupdf.PDFObject, k: string | number) => { if (!found && v.isIndirect() && v.asIndirect() === ref.asIndirect()) found = String(k); });
  if (found) return found;
  let i = 0;
  while (!fonts.get('GCCe' + i).isNull()) i++;
  fonts.put('GCCe' + i, ref);
  return 'GCCe' + i;
}

/** a line's font: the built-in one when it can show the text, otherwise the PC's (Arabic...) */
function pcStack(text: string, bold: boolean): FontRef[] | null {
  if (fitsWinAnsi(text)) return null;
  const st = fontStack('Helv', bold, false);
  return st.length ? st : null;
}
/** width of one line of a stamp / page mark (see textRun) */
function runWidth(text: string, size: number, bold: boolean): number {
  const st = pcStack(text, bold);
  return st ? measureLine(text, st) * size : measure(bold ? 'Helvetica-Bold' : 'Helvetica', text, size);
}
/**
 * One line of a stamp or page mark: in the built-in font when that can show it, otherwise shaped
 * in a font from the PC (Arabic joined, right to left) and embedded - the built-in fonts turned
 * every such letter into "?". names: the resource names to draw with. w = its width; ops(x, y) =
 * its drawing from the left end of its baseline (inside BT ... ET, y up).
 */
function textRun(o: Open, text: string, size: number, bold: boolean, names: { base: () => string; pc: (f: FontRef) => string }): { w: number; ops: (x: number, y: number) => string } {
  const st = pcStack(text, bold);
  const l = st ? layoutText(text, Infinity, st)[0] : null;
  if (l && l.glyphs.length) return { w: l.width * size, ops: (x, y) => { const s = lineOps(l, x, y, size, names.pc).join(' '); noteGlyphs(o, [l]); return s; } };
  return { w: measure(bold ? 'Helvetica-Bold' : 'Helvetica', text, size), ops: (x, y) => `/${names.base()} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${pdfString(text)} Tj` };
}

/** user space -> page space matrix of the page a markup sits on */
function pageCtmOf(o: Open, a: mupdf.PDFAnnotation): number[] {
  const po = a.getObject().get('P');
  if (!po.isNull()) {
    for (const [, pp] of o.pages) if (pp.getObject().asIndirect() === po.asIndirect()) return pp.getTransform() as unknown as number[];
    const n = o.doc.countPages();
    for (let i = 0; i < n; i++) if (o.doc.findPage(i).asIndirect() === po.asIndirect()) return pg(o, i).getTransform() as unknown as number[];
  }
  return [1, 0, 0, -1, 0, 0];
}
/** inverse of the linear part (no translation) */
function linInv(m: number[]): number[] {
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, 0, 0];
}

// ---------------------------------------------------------------- flatten

/**
 * Burn markups into the page content. Only those listed (or all when `items` is null).
 * Locked ones are flattened too when asked for explicitly; form fields only with `widgets`.
 */
export function flatten(id: string, items: { page: number; id: number }[] | null, opts: { widgets?: boolean; types?: string[] } = {}): number {
  const o = O(id);
  return op(o, items ? 'Flatten ' + items.length : 'Flatten all', 'c', () => {
    let n = 0;
    const byPage = new Map<number, Set<number> | null>();
    if (items) for (const it of items) { if (!byPage.has(it.page)) byPage.set(it.page, new Set()); byPage.get(it.page)!.add(it.id); }
    else for (let i = 0; i < o.doc.countPages(); i++) byPage.set(i, null);
    /** form fields flattened (taken off the form's list afterwards) */
    const gone = new Set<number>();
    for (const [page, ids] of byPage) {
      const p = pg(o, page);
      const list = p.getAnnotations().filter((a) => {
        const t = a.getType();
        if (t === 'Popup' || t === 'Link' || t === 'Redact') return false;
        if (!a.getObject().get('IRT').isNull()) return false; // replies have nothing to draw
        if (ids && !ids.has(a.getObject().asIndirect())) return false;
        if (opts.types && !opts.types.includes(a.getObject().get('GCCKind').isNull() ? t : a.getObject().get('GCCKind').asName()) && !opts.types.includes(t)) return false;
        return true;
      });
      const all: mupdf.PDFAnnotation[] = [...list];
      if (opts.widgets && !ids) all.push(...(p.getWidgets() as unknown as mupdf.PDFAnnotation[]));
      for (const a of all) {
        const aid = a.getObject().asIndirect();
        const widget = a.getType() === 'Widget';
        if (!(a.getFlags() & HIDDEN)) {
          if (bakeOne(o, p, a)) n++;
          // a form field that can't be drawn stays a field (deleted, its value was lost)
          else if (widget) continue;
        }
        noteDropped(o, a);
        // replies to it go with it (the whole thread, from a list of its own - see threadOf)
        for (const r of threadOf(p, aid)) { noteDropped(o, r); p.deleteAnnotation(r); }
        p.deleteAnnotation(a);
        if (widget) gone.add(aid);
      }
      p.update();
    }
    // flattened fields leave the form's list too (other programs listed them, with no page)
    pruneFields(o, gone);
    resetPages(o);
    return n;
  });
}

/** form fields whose widgets are all gone (object numbers in `gone`) taken off the form's list */
function pruneFields(o: Open, gone: Set<number>) {
  if (!gone.size) return;
  const fields = o.doc.getTrailer().get('Root', 'AcroForm', 'Fields');
  if (!fields.isArray()) return;
  const prune = (list: mupdf.PDFObject, depth: number) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const k = list.get(i);
      if (k.isIndirect() && gone.has(k.asIndirect())) { list.delete(i); continue; }
      const kids = k.get('Kids');
      if (!kids.isArray()) continue;
      if (kids.length && depth < 16) prune(kids, depth + 1);
      // (MuPDF takes a deleted widget off its parent's list itself: a parent left with none goes)
      const st = k.get('Subtype');
      if (!kids.length && !(st.isName() && st.asName() === 'Widget')) { list.delete(i); if (k.isIndirect()) gone.add(k.asIndirect()); }
    }
  };
  prune(fields, 0);
}

/**
 * A form field drawn from its value before it is burnt in: one without a drawing of its own, or
 * in a file that asks for every field to be drawn again (/NeedAppearances) - MuPDF bakes what is
 * there (none: the field and its value were lost; an old one: the old value).
 */
function drawField(o: Open, w: mupdf.PDFWidget) {
  const obj = w.getObject();
  const n = obj.get('AP', 'N');
  let need = !n.isStream() && !n.isDictionary();
  try { const na = o.doc.getTrailer().get('Root', 'AcroForm', 'NeedAppearances'); if (na.isBoolean() && na.asBoolean()) need = true; } catch { /* no form */ }
  if (!need) return;
  try {
    if (w.isText()) w.setTextValue(w.getValue());
    else if (w.isChoice()) {
      const v = fieldOf(obj).getInheritable('V');
      if (v.isArray() && v.length > 1) return; // several chosen: MuPDF draws one
      // drawn with the option's label, the export value kept (as setField does)
      const kept = w.getOptions(true), shown = w.getOptions(false);
      const cur = w.getValue(), k = kept.indexOf(cur);
      w.setChoiceValue(k >= 0 && shown[k] != null ? shown[k] : cur);
      (w as unknown as mupdf.PDFAnnotation).update();
      if (k >= 0 && shown[k] !== cur) { let h = obj; for (let i = 0; i < 32 && h.get('V').isNull() && h.get('Parent').isDictionary(); i++) h = h.get('Parent'); h.put('V', o.doc.newString(cur)); }
    }
  } catch { /* left as it is */ }
}

/** append a markup's appearance to the page content (PDF spec 12.5.5 placement) */
function bakeOne(o: Open, p: mupdf.PDFPage, a: mupdf.PDFAnnotation): boolean {
  if (a.getType() === 'Widget') drawField(o, a as unknown as mupdf.PDFWidget);
  updateQuiet(a);
  return bakeDict(o, p, a.getObject(), a.getOpacity());
}

/**
 * A markup's appearance (from its dictionary) appended to the page content. A markup on a layer
 * (/OC) stays on that layer: its content is marked with it (/OC … BDC … EMC) - burnt in without
 * it, a markup on a layer turned off showed and printed.
 */
function bakeDict(o: Open, p: mupdf.PDFPage, obj: mupdf.PDFObject, opac: number): boolean {
  let ap = obj.get('AP', 'N');
  if (ap.isDictionary() && !ap.isStream()) {
    const as = obj.get('AS');
    ap = as.isNull() ? ap.get('Off') : ap.get(as.asName());
  }
  if (!ap || ap.isNull() || !ap.isStream()) return false;
  const bb = arr(ap.get('BBox'), [0, 0, 1, 1]);
  const mx = arr(ap.get('Matrix'), [1, 0, 0, 1, 0, 0]);
  const rect = arr(obj.get('Rect'), [0, 0, 0, 0]);
  // transformed bbox
  const corners = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(([x, y]) => [mx[0] * x + mx[2] * y + mx[4], mx[1] * x + mx[3] * y + mx[5]]);
  const tx0 = Math.min(...corners.map((c) => c[0])), tx1 = Math.max(...corners.map((c) => c[0]));
  const ty0 = Math.min(...corners.map((c) => c[1])), ty1 = Math.max(...corners.map((c) => c[1]));
  const rx0 = Math.min(rect[0], rect[2]), ry0 = Math.min(rect[1], rect[3]), rx1 = Math.max(rect[0], rect[2]), ry1 = Math.max(rect[1], rect[3]);
  const sx = (rx1 - rx0) / Math.max(1e-6, tx1 - tx0), sy = (ry1 - ry0) / Math.max(1e-6, ty1 - ty0);
  const A = [sx, 0, 0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy];
  ap.put('Type', 'XObject');
  ap.put('Subtype', 'Form');
  const name = addResource(o, p, 'XObject', 'GCCa', ap);
  let pre = '';
  if (opac < 1) pre = `/${addResource(o, p, 'ExtGState', 'GCCo', o.doc.addObject({ Type: 'ExtGState', ca: opac, CA: opac }))} gs `;
  let open = '', shut = '';
  const oc = obj.get('OC');
  if (!oc.isNull() && (oc.isIndirect() ? oc.resolve() : oc).isDictionary()) {
    open = `/OC /${addResource(o, p, 'Properties', 'GCCl', oc.isIndirect() ? oc : o.doc.addObject(oc))} BDC `;
    shut = ' EMC';
  }
  appendContent(o, p, `${open}q ${TEXT_STATE} ${pre}${A.map((v) => +v.toFixed(5)).join(' ')} cm /${name} Do Q${shut}`);
  return true;
}
/** a markup dictionary's opacity (/CA; 1 when not given) */
const opacityOf = (d: mupdf.PDFObject) => { const v = d.get('CA'); return v.isNumber() ? Math.max(0, Math.min(1, v.asNumber())) : 1; };

function arr(x: mupdf.PDFObject, dflt: number[]): number[] {
  if (!x || x.isNull() || !x.isArray()) return dflt;
  const out: number[] = [];
  x.forEach((v) => out.push(v.asNumber()));
  return out;
}

// ---------------------------------------------------------------- page content helpers

/** make sure the page has its own Resources dict and return it */
function resources(o: Open, p: mupdf.PDFPage): mupdf.PDFObject {
  const po = p.getObject();
  let r = po.get('Resources');
  if (r.isNull()) {
    const inh = po.getInheritable('Resources');
    r = inh.isNull() ? o.doc.addObject({}) : o.doc.addObject(inh.resolve());
    po.put('Resources', r);
  }
  return r.resolve();
}

function addResource(o: Open, p: mupdf.PDFPage, kind: string, prefix: string, value: mupdf.PDFObject): string {
  const r = resources(o, p);
  let d = r.get(kind);
  if (d.isNull()) { d = o.doc.newDictionary(); r.put(kind, d); }
  d = d.resolve();
  // same object already there?
  let found = '';
  d.forEach((v, k) => { if (!found && v.isIndirect() && value.isIndirect() && v.asIndirect() === value.asIndirect()) found = String(k); });
  if (found) return found;
  let i = 1;
  while (!d.get(prefix + i).isNull()) i++;
  d.put(prefix + i, value);
  return prefix + i;
}

/**
 * Add drawing commands on top of the page. The old content is wrapped once in q/Q so
 * whatever state it leaves behind can't shift what we add.
 */
function appendContent(o: Open, p: mupdf.PDFPage, ops: string, under = false) {
  const po = p.getObject();
  let c = po.get('Contents');
  const list: mupdf.PDFObject[] = [];
  if (c.isArray()) c.forEach((v) => list.push(v));
  else if (!c.isNull()) list.push(c);
  const first = list[0];
  let wrapped = false;
  try { wrapped = !!first && first.isStream() && first.readStream().asString().startsWith('q %GCC'); } catch { /* not ours */ }
  const out = o.doc.newArray();
  if (!wrapped) {
    out.push(o.doc.addStream('q %GCC\n', {}));
    if (under) out.push(o.doc.addStream(ops + '\n', {}));
    for (const v of list) out.push(v);
    out.push(o.doc.addStream('\nQ %GCC\n', {}));
    if (!under) out.push(o.doc.addStream(ops + '\n', {}));
  } else {
    out.push(list[0]);
    if (under) out.push(o.doc.addStream(ops + '\n', {}));
    for (let i = 1; i < list.length; i++) out.push(list[i]);
    if (!under) out.push(o.doc.addStream(ops + '\n', {}));
  }
  po.put('Contents', out);
  c = out;
}

/** page space -> PDF user space matrix for this page */
function toUser(p: mupdf.PDFPage): number[] {
  return mupdf.Matrix.invert(p.getTransform()) as unknown as number[];
}
const mul = (a: number[], b: number[]) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const fmt = (m: number[]) => m.map((v) => +v.toFixed(4)).join(' ');
/**
 * Text state back to the PDF defaults, written before anything we add that draws text. BT/ET don't
 * reset it, and an earlier part of the page may have left it set: the OCR text layer of 0.8.0 and
 * before ended with invisible text (3 Tr) and its last squeeze (Tz) still on - page numbers, text
 * and flattened text boxes added after OCR were invisible.
 */
const TEXT_STATE = '0 Tr 100 Tz 0 Tc 0 Tw 0 Ts';

// ---------------------------------------------------------------- pages

/**
 * After page `i` was turned (by `delta` degrees, clockwise) or cropped: markups turned by this
 * app keep their unturned box in the page's space as shown (/GCCBox) - it is worked out again for
 * the page as it is now (C0 = the page's matrix before). Same size, about the same middle, turned
 * on by the page's turn: the markup looks as it did. (It was left in the old space: the frame
 * sat where the markup had been, and the next change moved the markup there.)
 */
function followPage(o: Open, i: number, C0: number[], delta: number) {
  const list = pg(o, i).getObject().get('Annots');
  if (!list.isArray()) return;
  const C1 = pg(o, i).getTransform() as unknown as number[];
  const back = mupdf.Matrix.invert(C0 as unknown as mupdf.Matrix) as unknown as number[];
  const M = mul(back, C1); // old page space -> user space -> new page space
  for (let k = 0; k < list.length; k++) {
    const a = list.get(k);
    const gb = a.get('GCCBox');
    if (!gb.isArray()) continue;
    const b = arr(gb, [0, 0, 1, 1]);
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, w = Math.abs(b[2] - b[0]), h = Math.abs(b[3] - b[1]);
    const nx = M[0] * cx + M[2] * cy + M[4], ny = M[1] * cx + M[3] * cy + M[5];
    a.put('GCCBox', [nx - w / 2, ny - h / 2, nx + w / 2, ny + h / 2]);
    if (!delta) continue;
    const ang = ((((num(a.get('GCCAngle')) ?? 0) + delta) % 360) + 360) % 360;
    if (ang) a.put('GCCAngle', ang); else a.delete('GCCAngle');
    // a text box's own turn (MuPDF sets it to the page's when the box is made: its text is drawn
    // upright as the page is shown) turns with the page too - or its text was set across the box
    const own = a.get('Rotate'), st = a.get('Subtype');
    if (own.isNumber() || (st.isName() && st.asName() === 'FreeText')) {
      const r = ((((own.isNumber() ? own.asNumber() : 0) + delta) % 360) + 360) % 360;
      if (r) a.put('Rotate', r); else a.delete('Rotate');
    }
  }
}

export function rotatePages(id: string, pages: number[], delta: number): PageInfo[] {
  const o = O(id);
  return op(o, 'Rotate pages', 'c', () => {
    for (const i of pages) {
      const C0 = pg(o, i).getTransform() as unknown as number[];
      const po = pg(o, i).getObject();
      let r = 0;
      try { r = po.getInheritable('Rotate').asNumber() || 0; } catch { /* none */ }
      po.put('Rotate', (((r + delta) % 360) + 360) % 360);
      o.pages.delete(i);
      followPage(o, i, C0, delta);
    }
    resetPages(o);
    const list = pageInfos(o).slice();
    for (const i of new Set(pages)) list[i] = info1(o, i);
    return (o.infos = list);
  });
}

/** new page order (indexes of the current pages; leaving one out deletes it, repeating duplicates it) */
/**
 * MuPDF's rearrangePages, keeping the catalogue. MuPDF (1.28) rebuilds /Root with only /Type,
 * /Pages, /Outlines, /OCProperties and labels - outside the journal: deleting or moving a page
 * dropped the form (/AcroForm), the page scales (/GCCData), attachments and named places (/Names),
 * XMP, language, open action..., and Undo didn't bring them back. Now: a journaled touch of /Root
 * first (Undo has it as it was), then what MuPDF dropped is put back - without what points at the
 * pages that go (their form fields, named places, an open action to them; tags (/StructTreeRoot)
 * reach every page, so they stay out when pages are removed - a deleted page must not survive in
 * the saved file through them).
 */
function rearrange(o: Open, keep: number[], own = Infinity) {
  const doc = o.doc;
  const n = doc.countPages();
  const kept = new Set(keep);
  const gone = new Set<number>();
  /** a page of the file itself goes (not only Replace's stand-ins, pages from `own` on) */
  let ownGone = false;
  const widgets = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (kept.has(i)) continue;
    if (i < own) ownGone = true;
    const pr = doc.findPage(i);
    if (pr.isIndirect()) gone.add(pr.asIndirect());
    const an = pr.get('Annots');
    if (an.isArray()) for (let j = 0; j < an.length; j++) { const a = an.get(j); if (a.isIndirect() && a.resolve().get('Subtype').isName() && a.resolve().get('Subtype').asName() === 'Widget') widgets.add(a.asIndirect()); }
  }
  const root = doc.getTrailer().get('Root');
  const before: [string, mupdf.PDFObject][] = [];
  root.forEach((v, k) => { before.push([String(k), v]); });
  // (MuPDF writes a new /Names holding only the named places it rebuilt: attachments, document
  // scripts, named pages... of the old one are put back into it below)
  const names: [string, mupdf.PDFObject][] = [];
  const nm0 = root.get('Names');
  if (nm0.isDictionary()) nm0.forEach((v, k) => { names.push([String(k), v]); });
  root.put('GCCKeep', true);
  root.delete('GCCKeep');
  doc.rearrangePages(keep);
  const now = doc.getTrailer().get('Root');
  for (const [k, v] of before) {
    if (!now.get(k).isNull()) continue;
    // (the tags of a page that went can hold its text: left out with it. Replace's stand-ins only
    // carried the new sheets in - the file's tags stay)
    if (ownGone && (k === 'StructTreeRoot' || k === 'MarkInfo')) continue;
    now.put(k, v);
  }
  const nm1 = now.get('Names');
  if (names.length && nm1.isDictionary()) for (const [k, v] of names) if (k !== 'Dests' && nm1.get(k).isNull()) nm1.put(k, v);
  if (widgets.size) dropFields(o, widgets);
  if (gone.size) { pruneDests(doc, gone); pruneThreads(doc, gone); }
}

/** named places, the old-style /Dests and an open action that go to a page that went: out */
function pruneDests(doc: mupdf.PDFDocument, gone: Set<number>) {
  const goesGone = (d: mupdf.PDFObject): boolean => {
    let v = d.isIndirect() ? d.resolve() : d;
    if (v.isDictionary()) v = v.get('D');
    if (v.isIndirect()) v = v.resolve();
    if (!v.isArray() || !v.length) return false;
    const pg = v.get(0);
    return pg.isIndirect() && gone.has(pg.asIndirect());
  };
  const root = doc.getTrailer().get('Root');
  const oa = root.get('OpenAction');
  if (!oa.isNull() && goesGone(oa)) root.delete('OpenAction');
  const old = root.get('Dests');
  if (old.isDictionary()) { const ks: string[] = []; old.forEach((v, k) => { if (goesGone(v)) ks.push(String(k)); }); for (const k of ks) old.delete(k); }
  const tree = (node: mupdf.PDFObject, depth: number, bad: (v: mupdf.PDFObject) => boolean) => {
    if (!node.isDictionary() || depth > 32) return;
    const nm = node.get('Names');
    if (nm.isArray()) for (let i = nm.length - 2; i >= 0; i -= 2) if (bad(nm.get(i + 1))) { nm.delete(i + 1); nm.delete(i); }
    const kids = node.get('Kids');
    if (kids.isArray()) for (let i = 0; i < kids.length; i++) tree(kids.get(i).resolve(), depth + 1, bad);
  };
  const names = root.get('Names');
  if (!names.isDictionary()) return;
  // (a missing entry is a null object whose resolve() throws in MuPDF.js)
  const sub = (k: string) => { const v = names.get(k); return v.isNull() ? null : v.resolve(); };
  const d = sub('Dests');
  if (d) tree(d, 0, goesGone);
  // (named pages and page templates are the page objects themselves)
  const isGone = (v: mupdf.PDFObject) => v.isIndirect() && gone.has(v.asIndirect());
  for (const k of ['Pages', 'Templates']) { const t = sub(k); if (t) tree(t, 0, isGone); }
}

/** page scales and viewports (kept by page number in /GCCData) follow their pages: newIndex ->
 *  the page's old index (-1 = a new page) */
function remapData(o: Open, from: number[]) {
  const root = o.doc.getTrailer().get('Root');
  const v = root.get('GCCData');
  if (v.isNull()) return;
  let d: Record<string, unknown>;
  try { d = JSON.parse(v.asString()); } catch { return; }
  let changed = false;
  for (const key of ['scales', 'viewports']) {
    const m = d[key] as Record<string, unknown> | undefined;
    if (!m || typeof m !== 'object') continue;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(m)) if (!/^\d+$/.test(k)) out[k] = val;
    from.forEach((old, j) => { if (old >= 0 && m[String(old)] !== undefined) out[String(j)] = m[String(old)]; });
    if (JSON.stringify(out) !== JSON.stringify(m)) { d[key] = out; changed = true; }
  }
  if (changed) root.put('GCCData', o.doc.newString(JSON.stringify(d)));
}

/** the page scales and viewports of `src`'s pages `pairs` [its page, page here] given to those pages
 *  here (a page without its own scale takes the file's one, '*'). Extract and Insert pages left them
 *  behind: the pages came without a scale, and the measurements on them kept old numbers that a scale
 *  set again never updated (0.8.5 blind review, B3-04). */
function carryScales(dst: mupdf.PDFDocument, src: mupdf.PDFDocument, pairs: [number, number][]) {
  const read = (d: mupdf.PDFDocument): Record<string, unknown> | null => {
    try { const v = d.getTrailer().get('Root', 'GCCData'); return v.isNull() ? null : JSON.parse(v.asString()); } catch { return null; }
  };
  const from = read(src);
  if (!from) return;
  const fs = (from.scales || {}) as Record<string, unknown>, fv = (from.viewports || {}) as Record<string, unknown>;
  const d = read(dst) ?? {};
  const scales = { ...((d.scales || {}) as Record<string, unknown>) }, vps = { ...((d.viewports || {}) as Record<string, unknown>) };
  let changed = false;
  for (const [sp, dp] of pairs) {
    const sc = fs[String(sp)] ?? fs['*'];
    if (sc !== undefined) { scales[String(dp)] = sc; changed = true; }
    if (fv[String(sp)] !== undefined) { vps[String(dp)] = fv[String(sp)]; changed = true; }
  }
  if (!changed) return;
  dst.getTrailer().get('Root').put('GCCData', dst.newString(JSON.stringify({ ...d, scales, viewports: vps })));
}

export function arrangePages(id: string, order: number[], name = 'Rearrange pages'): PageInfo[] {
  const o = O(id);
  if (!order.length) throw new Error('A PDF needs at least one page');
  const n = o.doc.countPages();
  if (order.length < n || [...Array(n).keys()].some((i) => !order.includes(i))) o.removedContent = true;
  const old = pageInfos(o);
  return op(o, name, 'c', () => { keepLabels(o, (l) => order.map((i) => l[i] ?? null), () => {
    // MuPDF lists a repeated page twice in the page tree but it stays ONE page object: a
    // markup added to the copy would show on the original too (and rotating one would turn
    // both). So pages are rearranged without repeats, then each repeat is a real copy.
    const seen = new Set<number>();
    const uniq = order.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
    rearrange(o, uniq);
    resetPages(o);
    if (uniq.length !== order.length) {
      const now = uniq.slice();
      for (let k = 0; k < order.length; k++) {
        if (now[k] === order[k]) continue;
        const from = now.indexOf(order[k]);
        o.doc.insertPage(k, copyPage(o, o.doc.findPage(from)));
        now.splice(k, 0, order[k]);
      }
      resetPages(o);
    }
    remapData(o, order);
  }); return (o.infos = relabel(o, order.map((i) => old[i]))); });
}

/** a direct value copied (dictionaries/arrays get their own copy; references stay shared) */
function directCopy(o: Open, v: mupdf.PDFObject): mupdf.PDFObject {
  if (v.isIndirect()) return v;
  if (v.isDictionary()) { const d = o.doc.newDictionary(); v.forEach((x, k) => d.put(k, directCopy(o, x))); return d; }
  if (v.isArray()) { const a = o.doc.newArray(); v.forEach((x) => a.push(directCopy(o, x))); return a; }
  return v;
}
/** an appearance stream of its own (MuPDF redraws appearances in place) */
function copyStream(o: Open, s: mupdf.PDFObject): mupdf.PDFObject {
  const r = s.resolve();
  if (!r.isStream()) return directCopy(o, s);
  const d = o.doc.newDictionary();
  r.forEach((x, k) => { if (k !== 'Length') d.put(k, directCopy(o, x)); });
  return o.doc.addRawStream(r.readRawStream(), d);
}
/** a page object of its own, with copies of its markups (form fields stay on the original) */
function copyPage(o: Open, src: mupdf.PDFObject): mupdf.PDFObject {
  const p = src.resolve();
  const d = o.doc.newDictionary();
  p.forEach((v, k) => { if (k !== 'Annots' && k !== 'Parent' && k !== 'StructParents' && k !== 'B') d.put(k, directCopy(o, v)); });
  for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (d.get(k).isNull()) { const v = p.getInheritable(k); if (!v.isNull()) d.put(k, directCopy(o, v)); }
  const page = o.doc.addObject(d);
  const annots = p.get('Annots');
  if (annots.isArray()) {
    const list = o.doc.newArray();
    const map = new Map<number, mupdf.PDFObject>();
    const made: [mupdf.PDFObject, mupdf.PDFObject][] = [];
    annots.forEach((ref) => {
      const a = ref.resolve();
      const st = a.get('Subtype');
      const t = st.isNull() ? '' : st.asName();
      if (t === 'Popup' || t === 'Widget' || !ref.isIndirect()) return;
      const n = o.doc.newDictionary();
      a.forEach((v, k) => {
        if (k === 'P' || k === 'Popup' || k === 'Parent') return;
        if (k === 'AP') {
          const ap = o.doc.newDictionary();
          v.resolve().forEach((s, sk) => {
            const r = s.resolve();
            if (r.isDictionary() && !r.isStream()) { const states = o.doc.newDictionary(); r.forEach((x, xk) => states.put(xk, copyStream(o, x))); ap.put(sk, states); }
            else ap.put(sk, copyStream(o, s));
          });
          n.put('AP', ap);
        } else n.put(k, directCopy(o, v));
      });
      n.put('P', page);
      const c = o.doc.addObject(n);
      map.set(ref.asIndirect(), c);
      made.push([a, c]);
      list.push(c);
    });
    // replies follow their copied markup
    for (const [a, c] of made) { const irt = a.get('IRT'); if (!irt.isNull() && map.has(irt.asIndirect())) c.put('IRT', map.get(irt.asIndirect())); }
    page.put('Annots', list);
  }
  return page;
}

export function deletePages(id: string, pages: number[]): PageInfo[] {
  const n = O(id).doc.countPages();
  const del = new Set(pages);
  const keep = [...Array(n).keys()].filter((i) => !del.has(i));
  return arrangePages(id, keep, pages.length > 1 ? `Delete ${pages.length} pages` : 'Delete page');
}

export function insertBlank(id: string, at: number, w: number, h: number, count = 1): PageInfo[] {
  const o = O(id);
  return op(o, 'Insert blank page', 'c', () => {
    const old = pageInfos(o);
    keepLabels(o, (l) => [...l.slice(0, at), ...Array(count).fill(null), ...l.slice(at)], () => { for (let i = 0; i < count; i++) o.doc.insertPage(at + i, o.doc.addPage([0, 0, w, h], 0, {}, '')); });
    resetPages(o);
    remapData(o, [...old.keys()].flatMap((i) => (i === at ? [...Array(count).fill(-1), i] : [i])).concat(at >= old.length ? Array(count).fill(-1) : []));
    const add = Array.from({ length: count }, () => ({ w, h, rot: 0, label: '' }));
    return (o.infos = relabel(o, [...old.slice(0, at), ...add, ...old.slice(at)]));
  });
}

/** insert pages of another PDF (all, or the listed ones) at `at` */
export function insertFrom(id: string, at: number, bytes: In, pages?: number[], password?: string): PageInfo[] {
  const o = O(id);
  const src = openOther(bytes, password);
  try {
    return insertPagesOf(o, at, src, pages);
  } finally {
    src.destroy?.();
  }
}

/** pages of another file open here, as it is now (unsaved changes and markups included; a
 *  file opened with a password is already open - nothing to ask) */
export function insertFromOpen(id: string, at: number, srcId: string, pages?: number[]): PageInfo[] {
  const o = O(id), s = O(srcId);
  if (o === s) throw new Error('Those pages are in this file already – use Duplicate, or drag them in the Pages panel.');
  const n = s.doc.countPages();
  if (pages?.some((i) => i < 0 || i >= n)) throw new Error(`That file has ${n} page${n === 1 ? '' : 's'}.`);
  return insertPagesOf(o, at, s.doc, pages);
}

/** form fields whose widgets (by object number) are gone: out of the form's field tree */
function dropFields(o: Open, widgets: Set<number>) {
  const form = o.doc.getTrailer().get('Root').get('AcroForm');
  if (!form.isDictionary()) return;
  /** fields left with no widget (taken out with them) */
  const gone = new Set(widgets);
  const prune = (arr: mupdf.PDFObject, depth: number) => {
    if (!arr.isArray() || depth > 32) return;
    for (let j = arr.length - 1; j >= 0; j--) {
      const f = arr.get(j);
      if (f.isIndirect() && widgets.has(f.asIndirect())) { arr.delete(j); continue; }
      const kids = f.resolve().get('Kids');
      if (kids.isArray()) {
        prune(kids, depth + 1);
        if (!kids.length) { if (f.isIndirect()) gone.add(f.asIndirect()); arr.delete(j); }
      }
    }
  };
  prune(form.get('Fields'), 0);
  // (the calculation order lists fields too: left there, a removed page's field - and the page,
  // through its /P - stayed in the saved file)
  const co = form.get('CO');
  if (co.isArray()) for (let j = co.length - 1; j >= 0; j--) { const f = co.get(j); if (f.isIndirect() && gone.has(f.asIndirect())) co.delete(j); }
}

/** article threads: beads on pages that went are taken out of their chain (a bead kept the page,
 *  content and all, in the saved file); a thread left with none goes */
function pruneThreads(doc: mupdf.PDFDocument, gone: Set<number>) {
  const threads = doc.getTrailer().get('Root').get('Threads');
  if (!threads.isArray()) return;
  const onGone = (b: mupdf.PDFObject) => { const p = b.resolve().get('P'); return p.isIndirect() && gone.has(p.asIndirect()); };
  for (let t = threads.length - 1; t >= 0; t--) {
    const ref = threads.get(t), th = ref.resolve();
    if (!th.isDictionary()) continue;
    const beads: mupdf.PDFObject[] = [];
    const seen = new Set<number>();
    for (let b = th.get('F'); b.isIndirect() && !seen.has(b.asIndirect()) && beads.length < 100000; b = b.resolve().get('N')) { seen.add(b.asIndirect()); beads.push(b); }
    if (!beads.some(onGone)) continue;
    const keep = beads.filter((b) => !onGone(b));
    if (!keep.length) { threads.delete(t); continue; }
    keep.forEach((b, i) => { const d = b.resolve(); d.put('N', keep[(i + 1) % keep.length]); d.put('V', keep[(i - 1 + keep.length) % keep.length]); });
    th.put('F', keep[0]);
    keep[0].resolve().put('T', ref);
  }
  if (!threads.length) doc.getTrailer().get('Root').delete('Threads');
}

/**
 * Pages of this file replaced by pages of another (revised sheets). Each replaced page keeps its
 * own object - bookmarks, links and page labels that point at it now show the new sheet; its old
 * markups go with the old sheet. More new pages than replaced: the rest go in after the last one;
 * fewer: the old ones left over go. `targets` one for one with the new pages, or a run of pages.
 */
export function replacePages(id: string, targets: number[], from: { open?: string; bytes?: In; password?: string }, pages?: number[]): PageInfo[] {
  const o = O(id);
  let src: mupdf.PDFDocument;
  let own = false;
  if (from.open) {
    const s = O(from.open);
    if (s === o) throw new Error('Choose another file to take the new pages from.');
    src = s.doc;
  } else { src = openOther(from.bytes!, from.password); own = true; }
  try {
    const n0 = o.doc.countPages(), ns = src.countPages();
    const list = pages ?? [...Array(ns).keys()];
    if (!targets.length) throw new Error('Which pages of this file are to be replaced?');
    if (!list.length) throw new Error('Which pages are to go in?');
    if (targets.some((t) => t < 0 || t >= n0)) throw new Error(`This file has ${n0} page${n0 === 1 ? '' : 's'}.`);
    if (list.some((i) => i < 0 || i >= ns)) throw new Error(`That file has ${ns} page${ns === 1 ? '' : 's'}.`);
    if (new Set(targets).size !== targets.length) throw new Error('A page to replace is listed twice.');
    const run = targets.every((t, k) => k === 0 || t === targets[k - 1] + 1);
    if (targets.length !== list.length && !run) throw new Error(`${targets.length} pages to replace and ${list.length} to put in: give as many of each, or replace a run of pages (e.g. 5-8).`);
    if (targets.length > list.length && n0 - (targets.length - list.length) < 1) throw new Error('A PDF needs at least one page');
    const both = Math.min(targets.length, list.length);
    const old = pageInfos(o);
    o.removedContent = true;
    return op(o, targets.length === 1 && list.length === 1 ? 'Replace page' : 'Replace pages', 'c', () => {
      const lastT = targets[targets.length - 1];
      const dropOld = new Set(targets.slice(both));
      const order: number[] = [];
      for (let i = 0; i < n0; i++) {
        if (!dropOld.has(i)) order.push(i);
        if (i === lastT) for (let k = both; k < list.length; k++) order.push(n0 + k);
      }
      const slot = new Map(targets.slice(0, both).map((t, k) => [t, k]));
      const gone = new Set<number>();
      /** stand-in page (object number) -> the old page object that took its place */
      const standIn = new Map<number, mupdf.PDFObject>();
      keepLabels(o, (l) => order.map((i) => (i < n0 ? l[i] ?? null : null)), () => {
        // the new sheets go in at the end for now, markups and all
        const gm = o.doc.newGraftMap();
        try {
          list.forEach((sp, k) => { if (k && k % 100 === 0) opMore(o); gm.graftPage(n0 + k, src, sp); });
          carryAnnots(o.doc, gm, src, list.map((sp, k) => [sp, n0 + k]));
          carryLayers(o.doc, gm, src);
        } finally { gm.destroy?.(); }
        resetPages(o);
        // then into the old pages' own objects
        for (let k = 0; k < both; k++) {
          const oldP = o.doc.findPage(targets[k]), newP = o.doc.findPage(n0 + k);
          // (the old sheet's form fields leave the form with it)
          const oa = oldP.get('Annots');
          if (oa.isArray()) for (let j = 0; j < oa.length; j++) { const a = oa.get(j); if (a.isIndirect() && a.resolve().get('Subtype').asName?.() === 'Widget') gone.add(a.asIndirect()); }
          const keys: string[] = [];
          oldP.forEach((_v, key) => { keys.push(String(key)); });
          for (const key of keys) if (key !== 'Parent' && key !== 'Type') oldP.delete(key);
          // (inherited from the other file's page tree: the old page's tree may say otherwise - its
          // /Rotate 90 or a CropBox on the /Pages node turned or cut the revised sheet)
          // (the stand-in has its own copies of what the revised sheet had, inherited there or not -
          // graftPage copies them; asked up its new tree it would answer with this file's)
          if (newP.get('Rotate').isNull()) oldP.put('Rotate', 0);
          if (newP.get('CropBox').isNull()) { const mb = newP.get('MediaBox'); if (!mb.isNull()) oldP.put('CropBox', mb); }
          if (newP.get('Resources').isNull()) oldP.put('Resources', o.doc.newDictionary());
          newP.forEach((v, key) => { const kk = String(key); if (kk !== 'Parent' && kk !== 'Type' && kk !== 'StructParents') oldP.put(kk, v); });
          // (the stand-in page goes in a moment: its markups now belong to the old page object -
          // left on it, they were taken for markups of a page that goes, and its fields left the form)
          newP.delete('Annots');
          const an = oldP.get('Annots');
          if (an.isArray()) for (let j = 0; j < an.length; j++) { const a = an.get(j).resolve(); if (a.isDictionary()) a.put('P', oldP); }
          if (newP.isIndirect()) standIn.set(newP.asIndirect(), oldP);
        }
        // links between the revised sheets went to the stand-in pages (which go): to the pages they
        // now are
        if (standIn.size) {
          const fix = (d: mupdf.PDFObject) => {
            const v = d.isIndirect() ? d.resolve() : d;
            if (!v.isArray() || !v.length) return;
            const pg = v.get(0);
            if (pg.isIndirect() && standIn.has(pg.asIndirect())) v.put(0, standIn.get(pg.asIndirect())!);
          };
          for (let i = 0; i < o.doc.countPages(); i++) {
            const an = o.doc.findPage(i).get('Annots');
            if (!an.isArray()) continue;
            for (let j = 0; j < an.length; j++) {
              const a = an.get(j).resolve();
              if (!a.isDictionary() || !a.get('Subtype').isName() || a.get('Subtype').asName() !== 'Link') continue;
              if (!a.get('Dest').isNull()) fix(a.get('Dest'));
              const act = a.get('A');
              if (act.isDictionary() && !act.get('D').isNull()) fix(act.get('D'));
            }
          }
        }
        if (gone.size) dropFields(o, gone);
        rearrange(o, order.map((i) => (i >= n0 && i < n0 + both ? -1 : i)).filter((i) => i >= 0), n0);
        resetPages(o);
        remapData(o, order.filter((i) => !(i >= n0 && i < n0 + both)).map((i) => (i < n0 ? i : -1)));
      });
      const final = order.filter((i) => !(i >= n0 && i < n0 + both));
      return (o.infos = relabel(o, final.map((i, j) => (i < n0 && !slot.has(i) ? old[i] : info1(o, j)))));
    });
  } finally {
    if (own) src.destroy?.();
  }
}

function insertPagesOf(o: Open, at: number, src: mupdf.PDFDocument, pages?: number[], label = 'Insert pages'): PageInfo[] {
  return op(o, label, 'c', () => {
    const list = pages ?? [...Array(src.countPages()).keys()];
    const old = pageInfos(o);
    const gm = o.doc.newGraftMap();
    try {
      keepLabels(o, (l) => [...l.slice(0, at), ...list.map(() => null), ...l.slice(at)], () => list.forEach((sp, k) => { if (k && k % 100 === 0) opMore(o); gm.graftPage(at + k, src, sp); }));
      // their markups, form fields and layers come along (graftPage leaves them behind)
      carryAnnots(o.doc, gm, src, list.map((sp, k) => [sp, at + k]));
      carryLayers(o.doc, gm, src);
    } finally { gm.destroy?.(); }
    resetPages(o);
    // (the scales of the pages after them move along)
    remapData(o, [...old.keys()].flatMap((i) => (i === at ? [...list.map(() => -1), i] : [i])).concat(at >= old.length ? list.map(() => -1) : []));
    // (and theirs come with them)
    carryScales(o.doc, src, list.map((sp, k) => [sp, at + k]));
    const add = list.map((_, k) => info1(o, at + k));
    return (o.infos = relabel(o, [...old.slice(0, at), ...add, ...old.slice(at)]));
  });
}

function openOther(bytes: In, password?: string): mupdf.PDFDocument {
  const d = openIn(bytes);
  if (d.needsPassword() && !(password && d.authenticatePassword(password))) throw new Error('That PDF needs a password');
  const p = d.asPDF();
  if (!p) throw new Error('Not a PDF file');
  return p;
}

/** a new PDF made of some pages of this one (markups, form fields, layers, bookmarks and page
 *  labels of those pages, and the file's title / author... included) */
export function extract(id: string, pages: number[]): Uint8Array {
  const o = O(id);
  const out = new mupdf.PDFDocument();
  try {
    const gm = out.newGraftMap();
    pages.forEach((sp, k) => gm.graftPage(k, o.doc, sp));
    carryAnnots(out, gm, o.doc, pages.map((sp, k) => [sp, k]));
    carryLayers(out, gm, o.doc);
    carryFileInfo(out, gm, o.doc);
    gm.destroy?.();
    carryScales(out, o.doc, pages.map((sp, k) => [sp, k]));
    // page labels ("A-101", "iv") of the pages taken, bookmarks that point at them
    if (hasLabels(o)) { const infos = pageInfos(o); writeLabels({ doc: out }, pages.map((i) => infos[i]?.label ?? null)); }
    const at = new Map<number, number>();
    pages.forEach((sp, k) => { if (!at.has(sp)) at.set(sp, k); });
    writeOutline(out, keepMarks(readOutline(o.doc), at));
    // (a whole font from the PC came along with text boxes / edited text: cut down to the letters used)
    if (o.bigFont) { try { out.subsetFonts(); } catch { /* keep the full font */ } }
    return out_(out.saveToBuffer('garbage=compact,compress'));
  } finally { out.destroy?.(); }
}

/** merge whole files into a new PDF; bookmarks: one per file (each file's own bookmarks under it) */
export function merge(files: { name: string; bytes: In; pages?: number[] }[], bookmarks = true): Uint8Array {
  const out = new mupdf.PDFDocument();
  try {
    let at = 0;
    const marks: OutItem[] = [];
    for (const f of files) {
      const src = openOther(f.bytes);
      const gm = out.newGraftMap();
      try {
        const list = f.pages ?? [...Array(src.countPages()).keys()];
        const first = at;
        const map = new Map<number, number>();
        for (const sp of list) { if (!map.has(sp)) map.set(sp, at); gm.graftPage(at++, src, sp); }
        // markups, form fields and layers come along (graftPage leaves them behind)
        carryAnnots(out, gm, src, list.map((sp, k) => [sp, first + k]));
        carryLayers(out, gm, src);
        carryScales(out, src, list.map((sp, k) => [sp, first + k]));
        // (a file that gave no pages gets no bookmark: one to the page after the end failed the merge)
        if (list.length) marks.push({ title: f.name.replace(/\.pdf$/i, ''), page: first, children: keepMarks(readOutline(src), map) });
      } finally {
        gm.destroy?.();
        src.destroy?.();
      }
    }
    writeOutline(out, bookmarks && marks.length > 1 ? marks : marks.flatMap((m) => m.children));
    return out_(out.saveToBuffer('garbage=compact,compress'));
  } finally { out.destroy?.(); }
}

/**
 * Merging a big set (a tender's volumes: 3,000 pages, 2 GB of scans) a file at a time, written
 * to disk as it goes. `merge` above builds the whole result in the engine's memory and then a
 * second copy to save it - past ~1 GB of files that ran out of memory ("realloc failed") and
 * nothing came out. Here each file's pages are grafted, then every new stream (page content,
 * scans, fonts - nearly all of the bytes) is handed to `spill` (the engine writes it to a temp
 * file) and emptied in memory; `mergeWrite` writes the PDF object by object at the end, the
 * streams copied back from the temp file. Memory stays about the size of the biggest file.
 */
export interface MergeState { out: mupdf.PDFDocument; at: number; marks: OutItem[]; spilled: Map<number, { off: number; len: number }>; next: number }
export function mergeStart(): MergeState {
  const out = new mupdf.PDFDocument();
  return { out, at: 0, marks: [], spilled: new Map(), next: out.countObjects() };
}
/** one file's pages (all, or `pages`) added at the end; spill(raw stream bytes) -> where it was written */
export function mergeAddFile(st: MergeState, name: string, bytes: In, spill: (raw: Uint8Array) => number, pages?: number[]): number {
  const { out } = st;
  const src = openOther(bytes);
  let added = 0;
  try {
    const gm = out.newGraftMap();
    try {
      const list = pages ?? [...Array(src.countPages()).keys()];
      const first = st.at;
      const map = new Map<number, number>();
      for (const sp of list) { if (!map.has(sp)) map.set(sp, st.at); gm.graftPage(st.at++, src, sp); added++; }
      carryAnnots(out, gm, src, list.map((sp, k) => [sp, first + k]));
      carryLayers(out, gm, src);
      carryScales(out, src, list.map((sp, k) => [sp, first + k]));
      if (list.length) st.marks.push({ title: name.replace(/\.pdf$/i, ''), page: first, children: keepMarks(readOutline(src), map) });
      // (a graft map keeps both files alive in the engine's memory until it is let go - also when
      // grafting failed)
    } finally { gm.destroy?.(); }
  } finally { src.destroy?.(); }
  spillNew(st, spill);
  return added;
}
/** every stream made since the last time: its bytes out to disk, emptied here */
function spillNew(st: MergeState, spill: (raw: Uint8Array) => number) {
  const n = st.out.countObjects();
  for (let num = st.next; num < n; num++) {
    const ref = st.out.newIndirect(num);
    if (!ref.isStream()) continue;
    const raw = ref.readRawStream();
    try { const v = raw.asUint8Array(); st.spilled.set(num, { off: spill(v), len: v.length }); }
    finally { raw.destroy?.(); }
    ref.writeRawStream(new Uint8Array(0));
  }
  st.next = n;
}
/**
 * The merged file, written in pieces: write(text or bytes); copy(off, len) writes a spilled
 * stream's bytes back out. Objects are written as MuPDF prints them (the dictionaries), with
 * each stream's real /Length.
 */
export function mergeWrite(st: MergeState, bookmarks: boolean, write: (b: string | Uint8Array) => void, copy: (off: number, len: number) => void) {
  writeOutline(st.out, bookmarks && st.marks.length > 1 ? st.marks : st.marks.flatMap((m) => m.children));
  writeObjects(st.out, write, st.spilled, copy);
}
export function mergeDrop(st: MergeState) { try { st.out.destroy?.(); } catch { /* gone */ } }

// ---------------------------------------------------------------- pages into another file

/** a bookmark for a new file: its page there (0-based) and the ones under it */
interface OutItem { title: string; page: number; children: OutItem[] }

/** a bookmark that opens another file or a web page ("file:A-101.pdf#page=1"): MuPDF gives it page 0,
 *  and it was taken for page 1 of this file (the panel went there; Extract / Merge rewrote it so) */
const elsewhere = (uri: unknown) => typeof uri === 'string' && uri !== '' && !uri.startsWith('#');
/** a file's bookmarks (page -1: one that points elsewhere) */
function readOutline(doc: mupdf.Document): Mark[] {
  const conv = (items: any[] | null | undefined, depth: number): Mark[] =>
    depth > 32 ? [] : (items || []).map((it: any) => {
      let page = -1;
      try { page = elsewhere(it.uri) ? -1 : it.page ?? (it.uri ? doc.resolveLink(it.uri) : -1); } catch { /* external */ }
      return { title: it.title || '', page: page ?? -1, children: conv(it.down, depth + 1) };
    });
  try { return conv(doc.loadOutline(), 0); } catch { return []; }
}
/** the bookmarks that point at pages being taken (`at`: old page -> new page); the ones under a
 *  bookmark that is left out move up a level */
function keepMarks(marks: Mark[], at: Map<number, number>): OutItem[] {
  const out: OutItem[] = [];
  for (const m of marks) {
    const kids = keepMarks(m.children, at);
    const p = at.get(m.page);
    if (p !== undefined) out.push({ title: m.title, page: p, children: kids });
    else out.push(...kids);
  }
  return out;
}
/** bookmarks written into a new file (after any it has) */
function writeOutline(doc: mupdf.PDFDocument, items: OutItem[]) {
  if (!items.length) return;
  const it = doc.outlineIterator();
  for (let k = 0; k < 100000 && it.next() === 0; k++) { /* to the end */ }
  const add = (list: OutItem[], depth: number) => {
    for (const m of list) {
      it.insert({ title: m.title, uri: '#page=' + (m.page + 1), open: false } as never);
      // (insert leaves the iterator after the new bookmark: back onto it, into its children)
      if (m.children.length && depth < 32 && it.prev() === 0 && it.down() >= 0) { add(m.children, depth + 1); it.up(); it.next(); }
    }
  };
  add(items, 0);
}

/** the file's title, author... language, viewer settings and colour profile copied into a file
 *  made of some of its pages (an extracted part opened untitled) */
function carryFileInfo(dst: mupdf.PDFDocument, gm: mupdf.PDFGraftMap, src: mupdf.PDFDocument) {
  for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate']) {
    try { const v = src.getMetaData('info:' + k); if (v) dst.setMetaData('info:' + k, v); } catch { /* none */ }
  }
  try { const l = src.getLanguage(); if (l) dst.setLanguage(l); } catch { /* none */ }
  const root = src.getTrailer().get('Root'), droot = dst.getTrailer().get('Root');
  for (const k of ['ViewerPreferences', 'OutputIntents']) {
    try { const v = root.get(k); if (!v.isNull() && !reachesPage(pageSet(src), v)) droot.put(k, gm.graftObject(v)); } catch { /* left out */ }
  }
}

/**
 * The layers (optional content) of pages copied from `src` into `dst`: graftPage copies the
 * pages' references to them but not the file's list of layers and which are off - content of a
 * hidden layer showed (and printed) in the new file. Copied through the pages' graft map, so the
 * same layer objects; added to a list `dst` already has (merging several files).
 */
function carryLayers(dst: mupdf.PDFDocument, gm: mupdf.PDFGraftMap, src: mupdf.PDFDocument) {
  const ocp = src.getTrailer().get('Root', 'OCProperties');
  if (!ocp.isDictionary()) return;
  try {
    if (reachesPage(pageSet(src), ocp)) return;
    const g = gm.graftObject(ocp);
    const root = dst.getTrailer().get('Root');
    const have = root.get('OCProperties');
    if (!have.isDictionary()) { root.put('OCProperties', g); return; }
    // both have layers: the new ones join the list (the file's own settings stay as they are),
    // every layer that was off stays off
    const items = (a: mupdf.PDFObject) => { const r: mupdf.PDFObject[] = []; if (a.isArray()) for (let i = 0; i < a.length; i++) r.push(a.get(i)); return r; };
    const num = (x: mupdf.PDFObject) => (x.isIndirect() ? x.asIndirect() : -1);
    const gd = g.get('D');
    const all = items(g.get('OCGs'));
    const gOn = new Set(items(gd.get('ON')).map(num));
    const gBase = gd.get('BaseState');
    const off = gBase.isName() && gBase.asName() === 'OFF' ? all.filter((x) => !gOn.has(num(x))) : items(gd.get('OFF'));
    const offNums = new Set(off.map(num));
    const listOf = (d: mupdf.PDFObject, k: string) => { let a = d.get(k); if (!a.isArray()) { a = dst.newArray(); d.put(k, a); } return a; };
    for (const x of all) listOf(have, 'OCGs').push(x);
    let D = have.get('D');
    if (!D.isDictionary()) { D = dst.newDictionary(); have.put('D', D); }
    const base = D.get('BaseState');
    if (base.isName() && base.asName() === 'OFF') { for (const x of all) if (!offNums.has(num(x))) listOf(D, 'ON').push(x); }
    else for (const x of off) listOf(D, 'OFF').push(x);
    for (const k of ['Order', 'Locked', 'RBGroups']) { const xs = items(gd.get(k)); if (xs.length) for (const x of xs) listOf(D, k).push(x); }
  } catch { /* the pages are there; their layers show as the file has them */ }
}

/** object numbers of a file's pages (read each time: the open file's pages change) */
function pageSet(doc: mupdf.PDFDocument): Set<number> {
  const s = new Set<number>();
  for (let i = 0, n = doc.countPages(); i < n; i++) { try { s.add(doc.findPage(i).asIndirect()); } catch { /* a broken page */ } }
  return s;
}

/**
 * Something copied would take a page of the source file with it (a link's target, a signature's
 * reference to the whole file...): MuPDF's graft follows every reference, so the new file would
 * get a stray copy of that page (or of the whole file). Followed to a limited depth; a value that
 * can't be told is treated as one that does.
 */
function reachesPage(pages: Set<number>, v: mupdf.PDFObject, seen = new Set<number>(), budget = { n: 20000 }, depth = 0, clear?: Set<number>): boolean {
  if (--budget.n < 0 || depth > 48) return true;
  if (v.isIndirect()) {
    const num = v.asIndirect();
    if (pages.has(num)) return true;
    if (seen.has(num) || clear?.has(num)) return false;
    seen.add(num);
    const r = v.resolve();
    // the file's catalogue or page tree: leads to every page
    const t = r.isDictionary() ? r.get('Type') : null;
    if (t && t.isName() && (t.asName() === 'Catalog' || t.asName() === 'Pages' || t.asName() === 'Page')) return true;
    return reachesPage(pages, r, seen, budget, depth + 1, clear);
  }
  if (v.isArray()) { for (let i = 0; i < v.length; i++) if (reachesPage(pages, v.get(i), seen, budget, depth + 1, clear)) return true; return false; }
  if (v.isDictionary()) {
    let r = false;
    v.forEach((x: mupdf.PDFObject) => { if (!r && reachesPage(pages, x, seen, budget, depth + 1, clear)) r = true; });
    return r;
  }
  return false;
}

/**
 * Markups and form fields of pages copied with graftPage (which leaves them behind - Merge,
 * Split, Extract, Insert pages and pages dragged out lost every comment, stamp, measurement and
 * filled-in field). pairs: [page in `src`, page in `dst`]. Each markup is copied through the
 * pages' graft map (pictures / fonts shared with the page copied once) and linked to its new
 * page; replies keep their markup; a link to a page that was copied too follows it, one to a page
 * left behind is dropped; form fields join `dst`'s form (a signature loses its value: it can't
 * be valid in another file - its drawing stays). Pop-ups are left out (made again by readers).
 */
function carryAnnots(dst: mupdf.PDFDocument, gm: mupdf.PDFGraftMap, src: mupdf.PDFDocument, pairs: [number, number][]) {
  const pages = pageSet(src);
  const newPage = new Map<number, mupdf.PDFObject>();
  // (a page taken twice: links to it go to its first copy)
  for (const [sp, dp] of pairs) { const n = src.findPage(sp).asIndirect(); if (!newPage.has(n)) newPage.set(n, dst.findPage(dp)); }
  /** objects copied by hand (those that point at pages), by source number */
  const made = new Map<number, mupdf.PDFObject | null>();
  /** objects found to lead to no page (a big resource dictionary shared by many markups is
   *  walked once, not once per markup - thousands of markups took minutes) */
  const clear = new Set<number>();
  const reaches = (v: mupdf.PDFObject) => {
    const seen = new Set<number>();
    const r = reachesPage(pages, v, seen, { n: 20000 }, 0, clear);
    // (no page anywhere under it: so for everything walked on the way)
    if (!r) for (const n of seen) clear.add(n);
    return r;
  };
  /** a value for the new file: a page reference becomes the new page; null = can't be carried */
  const copy = (v: mupdf.PDFObject, depth: number): mupdf.PDFObject | null => {
    if (depth > 40) return null;
    if (v.isIndirect()) {
      const num = v.asIndirect();
      if (pages.has(num)) return newPage.get(num) ?? null;
      if (made.has(num)) return made.get(num)!;
      if (!reaches(v)) return gm.graftObject(v);
      const r = v.resolve();
      const t = r.isDictionary() ? r.get('Type') : null;
      if (t && t.isName() && (t.asName() === 'Catalog' || t.asName() === 'Pages')) return null;
      if (v.isStream()) {
        made.set(num, null);
        const d = dst.newDictionary();
        r.forEach((x: mupdf.PDFObject, k: string | number) => { if (String(k) === 'Length') return; const c = copy(x, depth + 1); if (c) d.put(String(k), c); });
        const s = dst.addRawStream(v.readRawStream(), d);
        made.set(num, s);
        return s;
      }
      // (made first: an object that refers back to itself gets the copy)
      const ref = dst.createObject();
      made.set(num, ref);
      const body = copy(r, depth + 1);
      if (!body) { made.set(num, null); return null; }
      ref.writeObject(body);
      return ref;
    }
    if (v.isArray()) {
      const a = dst.newArray();
      for (let i = 0; i < v.length; i++) { const c = copy(v.get(i), depth + 1); if (!c) return null; a.push(c); }
      return a;
    }
    if (v.isDictionary()) {
      const d = dst.newDictionary();
      v.forEach((x: mupdf.PDFObject, k: string | number) => { const c = copy(x, depth + 1); if (c) d.put(String(k), c); });
      return d;
    }
    return v.isNull() ? null : v;
  };
  // form: the fields copied (by source number), and dst's list of fields
  const fields = new Map<number, mupdf.PDFObject>();
  let form: mupdf.PDFObject | null = null;
  const formOf = (): mupdf.PDFObject => {
    if (form) return form;
    const root = dst.getTrailer().get('Root');
    let f = root.get('AcroForm');
    if (!f.isDictionary()) { f = dst.addObject(dst.newDictionary()); root.put('AcroForm', f); }
    if (!f.get('Fields').isArray()) f.put('Fields', dst.newArray());
    // the form's default font and resources (fields drawn again use them)
    const sf = src.getTrailer().get('Root', 'AcroForm');
    if (sf.isDictionary()) {
      for (const k of ['DA', 'Q']) if (f.get(k).isNull() && !sf.get(k).isNull()) { const c = copy(sf.get(k), 0); if (c) f.put(k, c); }
      const na = sf.get('NeedAppearances');
      if (na.isBoolean() && na.asBoolean()) f.put('NeedAppearances', true);
      const sdr = sf.get('DR');
      if (sdr.isDictionary()) {
        let dr = f.get('DR');
        if (!dr.isDictionary()) { dr = dst.newDictionary(); f.put('DR', dr); }
        sdr.forEach((sub: mupdf.PDFObject, cat: string | number) => {
          const s = sub.resolve();
          if (!s.isDictionary()) return;
          let have = dr.get(String(cat));
          if (!have.isDictionary()) { have = dst.newDictionary(); dr.put(String(cat), have); }
          s.forEach((x: mupdf.PDFObject, k: string | number) => { if (have.get(String(k)).isNull()) { const c = copy(x, 0); if (c) have.put(String(k), c); } });
        });
      }
    }
    return (form = f);
  };
  /** a field (not a widget) copied once, with its parents; added to the form's list at the top */
  const fieldCopy = (ref: mupdf.PDFObject, depth: number): mupdf.PDFObject | null => {
    if (!ref.isIndirect() || depth > 16) return null;
    const num = ref.asIndirect();
    const had = fields.get(num);
    if (had) return had;
    const r = ref.resolve();
    if (!r.isDictionary()) return null;
    const d = dst.newDictionary();
    const sig = isSigField(r);
    r.forEach((x: mupdf.PDFObject, k: string | number) => {
      const key = String(k);
      if (key === 'Kids' || key === 'Parent' || (sig && (key === 'V' || key === 'Lock' || key === 'SV'))) return;
      const c = copy(x, 0);
      if (c) d.put(key, c);
    });
    d.put('Kids', dst.newArray());
    const nf = dst.addObject(d);
    fields.set(num, nf);
    const parent = r.get('Parent');
    const np = parent.isDictionary() ? fieldCopy(parent, depth + 1) : null;
    if (np) { nf.put('Parent', np); np.get('Kids').push(nf); }
    else formOf().get('Fields').push(nf);
    return nf;
  };
  const SKIP = new Set(['P', 'Popup', 'IRT', 'Parent', 'StructParent']);
  for (const [sp, dp] of pairs) {
    const sPage = src.findPage(sp);
    const list = sPage.get('Annots');
    if (!list.isArray()) continue;
    const np = dst.findPage(dp);
    let out = np.get('Annots');
    if (!out.isArray()) { out = dst.newArray(); np.put('Annots', out); }
    const map = new Map<number, mupdf.PDFObject>();
    const replies: [mupdf.PDFObject, mupdf.PDFObject][] = [];
    for (let i = 0; i < list.length; i++) {
      const ref = list.get(i);
      try {
        const a = ref.resolve();
        if (!a.isDictionary()) continue;
        const t = a.get('Subtype').isName() ? a.get('Subtype').asName() : '';
        if (t === 'Popup' || !t) continue;
        const sig = t === 'Widget' && isSigField(a);
        const nd = dst.newDictionary();
        a.forEach((x: mupdf.PDFObject, k: string | number) => {
          const key = String(k);
          if (SKIP.has(key) || (sig && (key === 'V' || key === 'Lock' || key === 'SV'))) return;
          const c = copy(x, 0);
          if (c) nd.put(key, c);
        });
        // a link whose target page was left behind: nothing to go to
        if (t === 'Link') {
          const act = nd.get('A');
          const lostGoTo = act.isDictionary() && act.get('S').isName() && act.get('S').asName() === 'GoTo' && act.get('D').isNull();
          if ((!a.get('Dest').isNull() && nd.get('Dest').isNull()) || (!a.get('A').isNull() && (act.isNull() || lostGoTo))) continue;
        }
        nd.put('P', np);
        const na = dst.addObject(nd);
        if (t === 'Widget') {
          const parent = a.get('Parent');
          const fp = parent.isDictionary() ? fieldCopy(parent, 0) : null;
          if (fp) { na.put('Parent', fp); fp.get('Kids').push(na); }
          else if (!a.get('FT').isNull() || !a.get('T').isNull()) formOf().get('Fields').push(na);
        }
        if (ref.isIndirect()) map.set(ref.asIndirect(), na);
        if (!a.get('IRT').isNull()) replies.push([a, na]);
        out.push(na);
      } catch { /* one that can't be copied: left out */ }
    }
    // replies follow their copied markup (one whose markup isn't there is no reply any more)
    for (const [a, na] of replies) { const irt = a.get('IRT'); const to = irt.isIndirect() ? map.get(irt.asIndirect()) : undefined; if (to) na.put('IRT', to); }
  }
}
/** a signature field (its value is a signature of the file it is in) */
function isSigField(f: mupdf.PDFObject): boolean {
  try { const ft = f.getInheritable('FT'); return ft.isName() && ft.asName() === 'Sig'; } catch { return false; }
}

export function cropPages(id: string, pages: number[], rect: Rect): PageInfo[] {
  const o = O(id);
  return op(o, 'Crop pages', 'c', () => {
    for (const i of pages) {
      const p = pg(o, i);
      // rect is in page space of page `pages[0]`; convert per page
      const m = toUser(p);
      const a = [rect[0], rect[1]], b = [rect[2], rect[3]];
      const ua = [m[0] * a[0] + m[2] * a[1] + m[4], m[1] * a[0] + m[3] * a[1] + m[5]];
      const ub = [m[0] * b[0] + m[2] * b[1] + m[4], m[1] * b[0] + m[3] * b[1] + m[5]];
      const C0 = p.getTransform() as unknown as number[];
      p.getObject().put('CropBox', [Math.min(ua[0], ub[0]), Math.min(ua[1], ub[1]), Math.max(ua[0], ub[0]), Math.max(ua[1], ub[1])]);
      o.pages.delete(i);
      followPage(o, i, C0, 0);
    }
    resetPages(o);
    const list = pageInfos(o).slice();
    for (const i of new Set(pages)) list[i] = info1(o, i);
    return (o.infos = list);
  });
}

// ---------------------------------------------------------------- outline

export interface Mark { title: string; page: number; children: Mark[] }
export function outline(id: string): Mark[] {
  const o = O(id);
  const conv = (items: any[] | null | undefined): Mark[] =>
    (items || []).map((it: any) => {
      let page = -1;
      try { page = elsewhere(it.uri) ? -1 : it.page ?? (it.uri ? o.doc.resolveLink(it.uri) : -1); } catch { /* external */ }
      return { title: it.title || '', page: page ?? -1, children: conv(it.down) };
    });
  try { return conv(o.doc.loadOutline()); } catch { return []; }
}

/** a bookmark as the Bookmarks panel edits it: all that is needed to write it back as it was
 *  (its destination as MuPDF gives it - page and view, a named place, a web address -, opened or
 *  closed, colour and bold / italic) */
export interface OutNode { title: string; page: number; uri: string | null; open: boolean; c?: number[]; f?: number; children: OutNode[]; /** its item in the file (object number): where it goes is taken from there as it was */ ref?: number; /** pointed at another page in the panel: goes to `page` now */ repoint?: boolean }

/** the outline's own items in order (each, then its children, then the next) */
function outlineObjs(doc: mupdf.PDFDocument): mupdf.PDFObject[] {
  const out: mupdf.PDFObject[] = [];
  const seen = new Set<number>();
  const go = (first: mupdf.PDFObject, depth: number) => {
    let cur = first;
    for (let k = 0; k < 100000 && cur.isIndirect() && depth < 64; k++) {
      const n = cur.asIndirect();
      if (seen.has(n)) return;
      seen.add(n);
      const d = cur.resolve();
      if (!d.isDictionary()) return;
      out.push(d);
      go(d.get('First'), depth + 1);
      cur = d.get('Next');
    }
  };
  // (get on a missing value fails in MuPDF.js: each step checked)
  const ol = doc.getTrailer().get('Root').get('Outlines');
  if (ol.isDictionary()) go(ol.get('First'), 0);
  return out;
}

/** the object numbers of outlineObjs' items, in the same order */
function outlineRefs(doc: mupdf.PDFDocument): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const go = (first: mupdf.PDFObject, depth: number) => {
    let cur = first;
    for (let k = 0; k < 100000 && cur.isIndirect() && depth < 64; k++) {
      const n = cur.asIndirect();
      if (seen.has(n)) return;
      seen.add(n);
      const d = cur.resolve();
      if (!d.isDictionary()) return;
      out.push(n);
      go(d.get('First'), depth + 1);
      cur = d.get('Next');
    }
  };
  const ol = doc.getTrailer().get('Root').get('Outlines');
  if (ol.isDictionary()) go(ol.get('First'), 0);
  return out;
}

export function outlineFull(id: string): OutNode[] {
  const o = O(id);
  let items: any[] = [];
  try { items = (o.doc.loadOutline() as any[]) || []; } catch { return []; }
  const raw = outlineObjs(o.doc);
  const rawRefs = outlineRefs(o.doc);
  let k = 0, total = 0;
  const count = (l: any[], d: number): void => { if (d > 32) return; for (const it of l) { total++; count(it.down || [], d + 1); } };
  count(items, 0);
  // (styles only when the two readings agree item for item)
  const styled = total === raw.length;
  const conv = (l: any[], d: number): OutNode[] => d > 32 ? [] : l.map((it: any) => {
    const r = styled ? raw[k++] : null;
    let page = -1;
    try { page = elsewhere(it.uri) ? -1 : it.page ?? (it.uri ? o.doc.resolveLink(it.uri) : -1); } catch { /* elsewhere */ }
    const n: OutNode = { title: it.title || '', page: page ?? -1, uri: it.uri ?? null, open: !!it.open, children: [] };
    if (r) {
      const rn = rawRefs[k - 1];
      if (rn) n.ref = rn;
      const c = r.get('C');
      if (c.isArray() && c.length === 3) { const v = [0, 1, 2].map((i) => c.get(i).asNumber()); if (v.some((x) => x !== 0)) n.c = v; }
      const f = r.get('F').asNumber();
      if (f) n.f = f;
    }
    n.children = conv(it.down || [], d + 1);
    return n;
  });
  return conv(items, 0);
}

/**
 * The whole outline written anew from the panel's list (one undo step). Built as the file's own
 * objects: a bookmark that was in the file keeps where it went exactly as it was (its view, a
 * named place, a web address, an action) unless it was pointed at another page; a new one goes to
 * its page. (MuPDF's outline iterator took 23 s for 3,000 bookmarks - every insert walks them.)
 */
export function setOutline(id: string, items: OutNode[], name = 'Edit bookmarks'): OutNode[] {
  const o = O(id);
  const n = o.doc.countPages();
  op(o, name, 'm', () => {
    const doc = o.doc;
    const root = doc.getTrailer().get('Root');
    const oldRoot = root.get('Outlines');
    // (an item's `ref` is honoured only if it is one of the outline's items now: after a save that
    // reopened the file (objects renumbered) a list read before pointed at other objects - a web
    // link's address became every bookmark's target)
    const current = new Set(outlineRefs(doc));
    root.delete('Outlines');
    if (!items.length) return;
    /** visible items under a list when everything open is open */
    const shown = (l: OutNode[]): number => l.reduce((c, m) => c + 1 + (m.open ? shown(m.children || []) : 0), 0);
    const make = (list: OutNode[], parent: mupdf.PDFObject, depth: number): mupdf.PDFObject[] => {
      const objs = list.map((m) => {
        const d = doc.newDictionary();
        d.put('Title', doc.newString(String(m.title ?? '').slice(0, 1000)));
        d.put('Parent', parent);
        const old = m.ref && current.has(m.ref) ? doc.newIndirect(m.ref).resolve() : null;
        // (a bookmark MuPDF gives no address for - "Next page", "Print", a form reset - keeps its
        // action too: only one pointed elsewhere in the panel gets a new place)
        if (old && old.isDictionary() && !m.repoint) {
          // (as it was in the file)
          for (const key of ['Dest', 'A', 'SE']) { const v = old.get(key); if (!v.isNull()) d.put(key, v); }
        } else if (m.uri && /^(https?:|mailto:)/i.test(m.uri)) {
          const a = doc.newDictionary();
          a.put('S', doc.newName('URI'));
          a.put('URI', doc.newString(m.uri));
          d.put('A', a);
        } else {
          const page = Math.round(m.page);
          if (page >= 0 && page < n) d.put('Dest', [doc.findPage(page), doc.newName('Fit')]);
        }
        if (m.c && m.c.length === 3) d.put('C', m.c.map((x) => Math.max(0, Math.min(1, Number(x) || 0))));
        if (m.f) d.put('F', m.f & 3);
        return { m, ref: doc.addObject(d) };
      });
      objs.forEach(({ m, ref }, i) => {
        const d = ref.resolve();
        if (i > 0) d.put('Prev', objs[i - 1].ref);
        if (i < objs.length - 1) d.put('Next', objs[i + 1].ref);
        const kids = depth < 32 ? m.children || [] : [];
        if (kids.length) {
          const k = make(kids, ref, depth + 1);
          d.put('First', k[0]);
          d.put('Last', k[k.length - 1]);
          // (closed: minus the items that would show if it were opened)
          d.put('Count', m.open ? shown(kids) : -shown(kids));
        }
      });
      return objs.map((x) => x.ref);
    };
    const top = doc.addObject(doc.newDictionary());
    const td = top.resolve();
    td.put('Type', doc.newName('Outlines'));
    const list = make(items, top, 0);
    td.put('First', list[0]);
    td.put('Last', list[list.length - 1]);
    td.put('Count', shown(items));
    root.put('Outlines', top);
    void oldRoot;
  });
  return outlineFull(id);
}

// ---------------------------------------------------------------- text (structure, editing)

export interface TLine { bbox: Rect; text: string; font: string; size: number; color: RGB; origin: Pt; dir: Pt; bold: boolean; italic: boolean; serif: boolean; mono: boolean; chars: Rect[] }
export interface TBlock { bbox: Rect; lines: TLine[] }

export function textBlocks(id: string, page: number): TBlock[] {
  const o = O(id);
  const p = pg(o, page);
  const st = p.toStructuredText('preserve-whitespace,preserve-spans');
  const blocks: TBlock[] = [];
  let cur: TBlock | null = null;
  let line: TLine | null = null;
  st.walk({
    beginTextBlock(b) { cur = { bbox: b as Rect, lines: [] }; },
    beginLine(b, _w, dir) { line = { bbox: b as Rect, text: '', font: '', size: 0, color: [0, 0, 0], origin: [0, 0], dir: [dir[0], dir[1]], bold: false, italic: false, serif: false, mono: false, chars: [] }; },
    onChar(c, origin, font, size, quad, col) {
      if (!line) return;
      if (!line.text) {
        line.font = font.getName();
        line.size = size;
        line.origin = [origin[0], origin[1]];
        line.color = (color(col) || [0, 0, 0]) as RGB;
        line.bold = font.isBold() || /bold|black|heavy|semibold/i.test(line.font);
        line.italic = font.isItalic() || /italic|oblique/i.test(line.font);
        line.serif = font.isSerif();
        line.mono = font.isMono();
      }
      line.text += c;
      const q = quad as unknown as number[];
      // (all four corners: on turned / upside-down text the "upper left" corner is not upper left)
      line.chars.push([Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])]);
    },
    endLine() { if (cur && line && line.text.trim()) cur.lines.push(line); line = null; },
    endTextBlock() { if (cur && cur.lines.length) blocks.push(cur); cur = null; },
  });
  st.destroy?.();
  return blocks;
}

export function hasText(id: string, page: number): boolean {
  const o = O(id);
  const st = pg(o, page).toStructuredText('');
  const t = st.asText();
  st.destroy?.();
  return t.replace(/\s+/g, '').length > 8;
}

/**
 * For "read the text again" (OCR redo): 'text' - the page has real text (typed, or another
 * program's invisible OCR text, which can't be told apart from ours safely): left alone, or
 * every word would be found twice; 'ours' - its only text is this app's OCR layer (replaced
 * when read again); 'none' - no text to speak of.
 */
export function ocrState(id: string, page: number): 'none' | 'ours' | 'text' {
  const o = O(id);
  const p = pg(o, page);
  let mine = false;
  try {
    const c = p.getObject().get('Contents');
    if (c.isArray()) c.forEach((v) => { try { if (!mine && v.readStream().asString().startsWith('%GCC-OCR')) mine = true; } catch { /* not ours */ } });
  } catch { /* none */ }
  // (OCR text is in a font that draws nothing - "GlyphLessFont", ours and Tesseract's)
  let real = 0, ocr = 0;
  const st = p.toStructuredText('');
  try {
    st.walk({ onChar(c: string, _o: unknown, font: mupdf.Font) { if (!c.trim()) return; let n = ''; try { n = font.getName(); } catch { /* unknown */ } if (/GlyphLess/i.test(n)) ocr++; else real++; } } as never);
  } finally { st.destroy?.(); }
  if (real > 8) return 'text';
  if (mine) return 'ours';
  return ocr > 8 ? 'text' : 'none';
}

export interface TextStyle { size: number; color: RGB; bold?: boolean; italic?: boolean; family?: 'sans' | 'serif' | 'mono' }

function baseFontFor(s: TextStyle): 'Helvetica' | 'Helvetica-Bold' | 'Times-Roman' | 'Times-Bold' | 'Courier' | 'Courier-Bold' | 'Helvetica-Oblique' | 'Times-Italic' {
  if (s.family === 'serif') return s.bold ? 'Times-Bold' : s.italic ? 'Times-Italic' : 'Times-Roman';
  if (s.family === 'mono') return s.bold ? 'Courier-Bold' : 'Courier';
  return s.bold ? 'Helvetica-Bold' : s.italic ? 'Helvetica-Oblique' : 'Helvetica';
}

const WIN_EXTRA = new Set([0x20ac, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2122]);
/** true when the text fits the built-in PDF fonts (Western European characters) */
export function fitsWinAnsi(t: string): boolean {
  for (const ch of t) { const c = ch.codePointAt(0)!; if (c > 255 && !WIN_EXTRA.has(c)) return false; }
  return true;
}

/** write lines of text as page content; origin = baseline start of the first line in page space */
function writeText(o: Open, p: mupdf.PDFPage, lines: string[], origin: Pt, s: TextStyle, dir: Pt = [1, 0], fontBytes?: Uint8Array, right?: number) {
  if (!fitsWinAnsi(lines.join(''))) {
    const fam = s.family === 'serif' ? 'TiRo' : s.family === 'mono' ? 'Cour' : 'Helv';
    const stack: FontRef[] = [];
    const own = fontBytes ? fontFromBytes('UserFont' + fontBytes.length, fontBytes) : null;
    if (own) stack.push(own);
    for (const f of fontStack(fam, !!s.bold, !!s.italic)) if (!stack.some((x) => x.key === f.key)) stack.push(f);
    if (stack.length) { writeTextShaped(o, p, lines, origin, s, dir, stack, right); return; }
  }
  const fname = baseFontFor(s);
  const name = addResource(o, p, 'Font', 'GCCf', stdFont(o, fname));
  const u = toUser(p);
  const parts: string[] = [];
  const lead = s.size * 1.2;
  lines.forEach((ln, k) => {
    // text matrix in page space (y down -> flip), then into user space
    // (the next line goes across the writing direction: below for left-to-right text, to the
    // left for text running down the sheet)
    const ox = origin[0] - dir[1] * lead * k, oy = origin[1] + dir[0] * lead * k;
    const tfz = [s.size * dir[0], s.size * dir[1], s.size * dir[1], -s.size * dir[0], ox, oy];
    const tm = mul(tfz, u);
    parts.push(`${fmt(tm)} Tm ${pdfString(ln)} Tj`);
  });
  appendContent(o, p, `q ${TEXT_STATE} BT /${name} 1 Tf ${s.color.map((v) => +v.toFixed(3)).join(' ')} rg ${parts.join(' ')} ET Q`);
}

/**
 * Same, in fonts from the PC (embedded, subset when saving): shaped (Arabic joined, right to
 * left, mixed with English and numbers). A right-to-left line keeps the old line's right end
 * (`right`) - where Arabic text starts.
 */
function writeTextShaped(o: Open, p: mupdf.PDFPage, lines: string[], origin: Pt, s: TextStyle, dir: Pt, stack: FontRef[], right?: number) {
  const u = toUser(p);
  const lead = s.size * 1.2;
  const names = new Map<string, string>();
  const nameOf = (f: FontRef) => {
    let n = names.get(f.key);
    if (!n) { n = addResource(o, p, 'Font', 'GCCu', embedFont(o, f)); names.set(f.key, n); }
    return n;
  };
  const parts: string[] = [];
  const done: Line[] = [];
  lines.forEach((ln, k) => {
    const l = layoutText(ln, Infinity, stack)[0];
    if (!l || !l.glyphs.length) return;
    done.push(l);
    let ox = origin[0] - dir[1] * lead * k, oy = origin[1] + dir[0] * lead * k;
    if (l.rtl && right !== undefined && dir[0] === 1 && dir[1] === 0) ox = right - l.width * s.size;
    // the line's own frame: page space, upright text, unit size (the font size goes in Tf)
    const L = mul([dir[0], dir[1], dir[1], -dir[0], ox, oy], u);
    parts.push(`q ${fmt(L)} cm BT ${s.color.map((v) => +v.toFixed(3)).join(' ')} rg ${lineOps(l, 0, 0, s.size, nameOf).join(' ')} ET Q`);
  });
  if (parts.length) { appendContent(o, p, `q ${TEXT_STATE}\n${parts.join('\n')}\nQ`); noteGlyphs(o, done); }
}

/**
 * Replace a piece of existing text: remove the glyphs under `area` (text only - line
 * work and pictures stay) and write the new text at the old baseline.
 */
export function replaceText(id: string, page: number, area: Rect[], text: string, origin: Pt, style: TextStyle, dir: Pt = [1, 0], fontBytes?: Uint8Array): void {
  const o = O(id);
  o.removedContent = true;
  op(o, 'Edit text', 'c', () => {
    const p = pg(o, page);
    // MuPDF applies every redaction mark on the page: the person's own marks (not applied yet)
    // are set aside for the moment - only the text being replaced goes
    const held: mupdf.PDFObject[] = [];
    for (const a of p.getAnnotations()) if (a.getType() === 'Redact') { const ob = a.getObject(); held.push(ob); ob.put('Subtype', o.doc.newName('GCCRedactHeld')); }
    for (const r of area) {
      const a = p.createAnnotation('Redact');
      a.setRect(tightenAcross(r, dir));
      a.update();
    }
    // black boxes off, images untouched (0 = none), line art untouched (0), text removed (0)
    try { p.applyRedactions(false, 0, 0, 0); }
    finally { for (const ob of held) ob.put('Subtype', o.doc.newName('Redact')); }
    if (text.trim()) writeText(o, p, text.split('\n'), origin, style, dir, fontBytes, Math.max(...area.map((r) => Math.max(r[0], r[2]))));
    p.update();
    resetPages(o);
  });
}

/** add new text straight into the page (permanent, like a typewriter flattened) */
export function addText(id: string, page: number, text: string, origin: Pt, style: TextStyle): void {
  const o = O(id);
  op(o, 'Add text', 'c', () => {
    const p = pg(o, page);
    writeText(o, p, text.split('\n'), origin, style);
    p.update();
  });
}

// ---------------------------------------------------------------- redaction

/** tighten() across the writing direction (text running down the sheet: narrower, not lower) */
function tightenAcross(r: Rect, dir: Pt, k = 0.22): Rect {
  if (Math.abs(dir[1]) <= Math.abs(dir[0])) return tighten(r, k);
  const w = r[2] - r[0];
  return [r[0] + w * k, r[1], r[2] - w * k, r[3]];
}

/** keep the middle of a text box, so marks made from text never touch the lines above/below */
export function tighten(r: Rect, k = 0.22): Rect {
  const h = r[3] - r[1];
  return [r[0], r[1] + h * k, r[2], r[3] - h * k];
}

export function searchQuads(id: string, page: number, needle: string): Rect[] {
  const o = O(id);
  const hits = pg(o, page).search(needle, '');
  return hits.map((h) => {
    const xs: number[] = [], ys: number[] = [];
    for (const q of h) { const a = q as unknown as number[]; for (let i = 0; i < 8; i += 2) { xs.push(a[i]); ys.push(a[i + 1]); } }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as Rect;
  });
}

/**
 * Apply every redaction mark (Redact markups) in the file: what is under them is
 * really removed - text, the covered part of pictures, and covered line work.
 */
export function applyRedactions(id: string, opts: { black?: boolean; lineArt?: boolean } = {}): number {
  const o = O(id);
  o.removedContent = true;
  return op(o, 'Apply redactions', 'c', () => {
    let n = 0;
    for (let i = 0; i < o.doc.countPages(); i++) {
      const p = pg(o, i);
      const marks = p.getAnnotations().filter((a) => a.getType() === 'Redact');
      if (!marks.length) continue;
      // the boxes left behind, each in its own colour (MuPDF's own are always black);
      // 'auto' = the page's colour around the mark, read before anything is removed
      const boxes: { r: Rect; c: number[] }[] = [];
      if (opts.black !== false) for (const a of marks) {
        const f = redactFillOf(a);
        if (f === 'none') continue;
        const r = a.getRect() as Rect;
        boxes.push({ r, c: f === 'auto' ? colourAround(p, r) : f });
      }
      // image: 2 = blank out covered pixels; line art: 1 = remove if fully covered; text: 0 = remove
      p.applyRedactions(false, 2, opts.lineArt === false ? 0 : 1, 0);
      if (boxes.length) {
        const u = toUser(p);
        const ops = boxes.map(({ r, c }) => {
          const q = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]].map(([x, y]) => [u[0] * x + u[2] * y + u[4], u[1] * x + u[3] * y + u[5]]);
          return `${c.slice(0, 3).map((v) => +v.toFixed(4)).join(' ')} rg ${q.map((pt, k) => `${+pt[0].toFixed(3)} ${+pt[1].toFixed(3)} ${k ? 'l' : 'm'}`).join(' ')} h f`;
        });
        appendContent(o, p, 'q ' + ops.join('\n') + ' Q');
      }
      p.update();
      n += marks.length;
    }
    resetPages(o);
    return n;
  });
}

// ---------------------------------------------------------------- forms

export function setField(id: string, page: number, aid: number, value: string | boolean): AnnotData {
  const o = O(id);
  return op(o, 'Fill form field', 'a', () => {
    const w = find(o, page, aid) as unknown as mupdf.PDFWidget;
    if (w.isCheckbox() || w.isRadioButton()) {
      const on = !!value && value !== 'Off';
      // (this button's own state: the value is the whole radio group's)
      if (on !== widgetOn(w)) w.toggle();
    } else if (w.isChoice()) {
      // the field keeps the chosen option's export value (/Opt pairs) - drawn with its label
      const label = String(value);
      const shown = w.getOptions(false), kept = w.getOptions(true);
      const k = shown.indexOf(label);
      w.setChoiceValue(label);
      (w as unknown as mupdf.PDFAnnotation).update();
      // (put straight in where the value went: not drawn again, so the box keeps showing the label)
      if (k >= 0 && kept[k] != null && kept[k] !== label) {
        let h = w.getObject();
        for (let n = 0; n < 32 && h.get('V').isNull() && h.get('Parent').isDictionary(); n++) h = h.get('Parent');
        h.put('V', o.doc.newString(kept[k]));
      }
      return readAnnot(w as unknown as mupdf.PDFAnnotation, page, o);
    } else {
      // no more than the field takes (its /MaxLen)
      let t = String(value);
      try { const m = w.getMaxLen(); if (m > 0 && [...t].length > m) t = [...t].slice(0, m).join(''); } catch { /* no limit */ }
      w.setTextValue(t);
    }
    (w as unknown as mupdf.PDFAnnotation).update();
    return readAnnot(w as unknown as mupdf.PDFAnnotation, page, o);
  });
}

// ---------------------------------------------------------------- OCR text layer

// cached per document in o.fonts (cleared on undo: an undone font object no longer exists)
function ocrFont(o: Open): mupdf.PDFObject {
  let f = o.fonts.get('\u0000ocr');
  if (f) return f;
  if (!glyphless) throw new Error('OCR font missing');
  const ff = o.doc.addStream(glyphless, { Length1: glyphless.length });
  const desc = o.doc.addObject({ Type: 'FontDescriptor', FontName: o.doc.newName('GlyphLessFont'), Flags: 5, FontBBox: [0, 0, 500, 1000], ItalicAngle: 0, Ascent: 1000, Descent: 0, CapHeight: 1000, StemV: 80, FontFile2: ff });
  const map = new Uint8Array(65536 * 2);
  for (let i = 0; i < 65536; i++) map[i * 2 + 1] = 1;
  const cmap = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
    '1 beginbfrange', '<0000> <FFFF> <0000>', 'endbfrange',
    'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end',
  ].join('\n');
  const cid = o.doc.addObject({
    Type: 'Font', Subtype: 'CIDFontType2', BaseFont: o.doc.newName('GlyphLessFont'),
    CIDSystemInfo: { Registry: 'Adobe', Ordering: 'Identity', Supplement: 0 },
    FontDescriptor: desc, DW: 500, CIDToGIDMap: o.doc.addStream(map, {}),
  });
  f = o.doc.addObject({ Type: 'Font', Subtype: 'Type0', BaseFont: o.doc.newName('GlyphLessFont'), Encoding: o.doc.newName('Identity-H'), DescendantFonts: [cid], ToUnicode: o.doc.addStream(cmap, {}) });
  o.fonts.set('\u0000ocr', f);
  return f;
}

export interface OcrWord { text: string; box: Rect }

/** invisible, selectable/searchable text over a scanned page (words in page space) */
/** join: part of the step before (one OCR run is one undo step, however many pages it read) */
export function addTextLayer(id: string, page: number, words: OcrWord[], replace = true, join = false): number {
  const o = O(id);
  return op(o, 'Recognise text', 'c', () => {
    const p = pg(o, page);
    if (replace) removeOcrLayer(o, p);
    const name = addResource(o, p, 'Font', 'GCCocr', ocrFont(o));
    const u = toUser(p);
    // (inside q ... Q: its invisible-text state must not carry on into what is added later)
    const parts: string[] = ['%GCC-OCR', `q ${TEXT_STATE} BT 3 Tr`];
    let n = 0;
    // the words of a line share its top and bottom: a selection or highlight covers the line
    // evenly (ascenders to descenders), not word by word at different heights
    const span = lineSpans(words);
    for (const [k, w] of words.entries()) {
      const t = w.text.trim();
      if (!t) continue;
      const [x0, , x1] = w.box;
      const [y0, y1] = span[k];
      const h = y1 - y0, wd = x1 - x0;
      if (h <= 0 || wd <= 0) continue;
      let chars = [...t].filter((c) => c.codePointAt(0)! < 0x10000);
      // right-to-left words are written in visual order; readers put them back in reading order
      // (by the bidi rules: numbers and Latin inside such a word keep their own order)
      if (/[\u0590-\u08ff\ufb1d-\ufefc]/.test(t)) chars = [...visualOrder(chars.join(''))];
      if (!chars.length) continue;
      const fs = h;
      const hz = (100 * wd) / (chars.length * 0.5 * fs);
      // the font's box runs from the baseline (descent 0) up one em: baseline on the box's bottom
      // edge puts the text's box (what selections and highlights are drawn from) on the words
      const tm = mul([fs, 0, 0, -fs, x0, y1], u);
      const hex = chars.map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).join('');
      parts.push(`/${name} 1 Tf ${hz.toFixed(2)} Tz ${fmt(tm)} Tm <${hex}> Tj`);
      n++;
    }
    parts.push('ET Q');
    appendContent(o, p, parts.join('\n'));
    p.update();
    return n;
  }, join);
}

/** each word's top and bottom: those of its line (words side by side that overlap in height) */
export function lineSpans(words: OcrWord[]): [number, number][] {
  const out: [number, number][] = words.map((w) => [w.box[1], w.box[3]]);
  // (sideways words - taller than wide and long - keep their own box)
  const idx = words.map((_, i) => i).filter((i) => { const b = words[i].box; return b[3] > b[1] && b[2] > b[0] && !(b[3] - b[1] > (b[2] - b[0]) * 1.5 && words[i].text.trim().length > 2); });
  idx.sort((a, b) => (words[a].box[1] + words[a].box[3]) - (words[b].box[1] + words[b].box[3]));
  const lines: { y0: number; y1: number; mid: number; h: number; ids: number[] }[] = [];
  for (const i of idx) {
    const [, y0, , y1] = words[i].box;
    const mid = (y0 + y1) / 2, h = y1 - y0;
    // the line whose middle this word's middle is close to (half the smaller height)
    let best: (typeof lines)[number] | null = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 6; k--) {
      const l = lines[k];
      if (Math.abs(l.mid - mid) <= Math.min(l.h, h) * 0.5 && (!best || Math.abs(l.mid - mid) < Math.abs(best.mid - mid))) best = l;
    }
    if (best) {
      best.ids.push(i);
      const hs = best.ids.map((j) => words[j].box[3] - words[j].box[1]).sort((a, b) => a - b);
      best.h = hs[hs.length >> 1];
      best.mid = best.ids.reduce((s, j) => s + (words[j].box[1] + words[j].box[3]) / 2, 0) / best.ids.length;
      best.y0 = Math.min(best.y0, y0); best.y1 = Math.max(best.y1, y1);
    } else lines.push({ y0, y1, mid, h, ids: [i] });
  }
  for (const l of lines) {
    // (one tall misread "word" - a stamp, a line read as "|" - must not stretch the whole line)
    const tops = l.ids.map((j) => words[j].box[1]).sort((a, b) => a - b), bots = l.ids.map((j) => words[j].box[3]).sort((a, b) => a - b);
    const top = l.ids.length > 2 ? tops[1] : tops[0], bot = l.ids.length > 2 ? bots[bots.length - 2] : bots[bots.length - 1];
    for (const j of l.ids) out[j] = [Math.min(top, words[j].box[1] + (words[j].box[3] - words[j].box[1]) * 0.3), Math.max(bot, words[j].box[3] - (words[j].box[3] - words[j].box[1]) * 0.3)];
  }
  return out;
}

function removeOcrLayer(o: Open, p: mupdf.PDFPage) {
  const po = p.getObject();
  const c = po.get('Contents');
  if (!c.isArray()) return;
  const keep = o.doc.newArray();
  let removed = false;
  c.forEach((v) => {
    let ours = false;
    try { ours = v.readStream().asString().startsWith('%GCC-OCR'); } catch { /* keep */ }
    if (ours) removed = true;
    else keep.push(v);
  });
  if (removed) po.put('Contents', keep);
}

// ---------------------------------------------------------------- page marks (header / footer / numbers / watermark / stamp)

export interface PageMark {
  kind: 'text' | 'stamp' | 'image';
  /** text with fields: {page} {pages} {date} {file} {bates} */
  text?: string;
  size?: number;
  color?: RGB;
  bold?: boolean;
  opacity?: number;
  /** where: 9-grid position + margins (pt) */
  pos: 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br';
  mx?: number;
  my?: number;
  /** degrees, counter-clockwise (watermark: 45) */
  angle?: number;

  under?: boolean;
  design?: StampDesign;
  image?: Uint8Array;
  /** image / stamp width in pt */
  width?: number;
}

export interface MarkContext { file: string; date: string; batesPrefix?: string; batesStart?: number; batesDigits?: number; pageFrom?: number; pageTo?: number; /** exactly these pages ("1-3, 9" is not 1 to 9) */ pages?: number[] }

/** stamp / number / watermark pages (permanent page content) */
export function markPages(id: string, marks: PageMark[], ctx: MarkContext): number {
  const o = O(id);
  return op(o, 'Add page marks', 'c', () => markDoc(o, marks, ctx));
}

function markDoc(o: Open, marks: PageMark[], ctx: MarkContext): number {
  const n = o.doc.countPages();
  const from = Math.max(0, ctx.pageFrom ?? 0), to = Math.min(n, ctx.pageTo ?? n);
  const list = ctx.pages ? [...new Set(ctx.pages)].filter((i) => i >= 0 && i < n).sort((a, b) => a - b) : Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
  let done = 0;
  const imgs = new Map<PageMark, { obj: mupdf.PDFObject; w: number; h: number }>();
  for (let k = 0; k < list.length; k++) {
    const i = list[k];
    const p = pg(o, i);
    const b = p.getBounds();
    const W = b[2] - b[0], H = b[3] - b[1];
    const u = toUser(p);
    for (const m of marks) {
      const fill = (s: string) => s
        .replace(/\{page\}/g, String(i + 1)).replace(/\{pages\}/g, String(n))
        .replace(/\{date\}/g, ctx.date).replace(/\{file\}/g, ctx.file)
        .replace(/\{bates\}/g, (ctx.batesPrefix || '') + String((ctx.batesStart ?? 1) + k).padStart(ctx.batesDigits ?? 6, '0'));
      let w = 0, h = 0;
      let draw = '';
      const gsName = m.opacity != null && m.opacity < 1 ? addResource(o, p, 'ExtGState', 'GCCo', o.doc.addObject({ Type: 'ExtGState', ca: m.opacity, CA: m.opacity })) : '';
      if (m.kind === 'text') {
        const size = m.size ?? 10;
        const lines = fill(m.text || '').split('\n');
        const fname = m.bold ? 'Helvetica-Bold' : 'Helvetica';
        // (Arabic and other letters the built-in font lacks: shaped in a font from the PC)
        const names = { base: () => addResource(o, p, 'Font', 'GCCf', stdFont(o, fname)), pc: (f: FontRef) => addResource(o, p, 'Font', 'GCCu', embedFont(o, f)) };
        const runs = lines.map((l) => textRun(o, l, size, !!m.bold, names));
        w = Math.max(...runs.map((r) => r.w));
        h = size * 1.2 * lines.length;
        const col = (m.color || [0, 0, 0]).map((v) => +v.toFixed(3)).join(' ');
        // local coords: origin bottom-left of the block, y up
        const tl = runs.map((r, k) => {
          const ax = m.pos.endsWith('r') ? w - r.w : m.pos.endsWith('c') ? (w - r.w) / 2 : 0;
          return r.ops(ax, h - size * (k + 1) * 1.2 + size * 0.25);
        }).join(' ');
        draw = `BT ${col} rg ${tl} ET`;
      } else if (m.kind === 'stamp' && m.design) {
        const [sw, sh] = stampSize(m.design);
        const sc = (m.width ?? sw) / sw;
        w = sw * sc; h = sh * sc;
        const xo = stampXObject(o, m.design);
        const xn = addResource(o, p, 'XObject', 'GCCs', xo);
        draw = `${sc} 0 0 ${sc} 0 0 cm /${xn} Do`;
      } else if (m.kind === 'image' && m.image) {
        let im = imgs.get(m);
        if (!im) {
          const image = new mupdf.Image(m.image);
          im = { obj: o.doc.addImage(image), w: image.getWidth(), h: image.getHeight() };
          imgs.set(m, im);
        }
        w = m.width ?? 120; h = (w * im.h) / im.w;
        const xn = addResource(o, p, 'XObject', 'GCCi', im.obj);
        draw = `${w} 0 0 ${h} 0 0 cm /${xn} Do`;
      }
      if (!draw) continue;
      const mx = m.mx ?? 28, my = m.my ?? 20;
      const cx = m.pos.endsWith('l') ? mx : m.pos.endsWith('r') ? W - mx - w : (W - w) / 2;
      const cy = m.pos.startsWith('t') ? my : m.pos.startsWith('b') ? H - my - h : (H - h) / 2;
      // block placed with its top-left at (cx, cy) in page space, rotated about its centre
      const ang = ((m.angle ?? 0) * Math.PI) / 180;
      const ccx = cx + w / 2, ccy = cy + h / 2;
      // local (y up, origin bottom-left) -> page (y down)
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const L = [1, 0, 0, -1, -w / 2, h / 2]; // to centred, y down
      const R = [cos, -sin, -sin * -1 * 0 + sin * 0 + -sin, 0, 0, 0];
      void R;
      const rot = [cos, -sin, sin, cos, 0, 0];
      const T = [1, 0, 0, 1, ccx, ccy];
      const M = mul(mul(mul(L, rot), T), u);
      appendContent(o, p, `q ${TEXT_STATE} ${gsName ? '/' + gsName + ' gs ' : ''}${fmt(M)} cm ${draw} Q`, m.under);
      done++;
    }
  }
  return done;
}

// cached per document in o.fonts (cleared on undo, like fonts)
function stampXObject(o: Open, d: StampDesign): mupdf.PDFObject {
  const m = o.fonts;
  const key = '\u0000stamp:' + JSON.stringify(d);
  let x = m.get(key);
  if (x) return x;
  const [W, H] = stampSize(d);
  // (the same drawing as the stamp markup's)
  const fonts = o.doc.newDictionary();
  fonts.put('FR', stdFont(o, 'Helvetica'));
  fonts.put('FB', stdFont(o, 'Helvetica-Bold'));
  const ops = stampOps(o, d, W, H, fonts);
  const res = o.doc.newDictionary();
  res.put('Font', fonts);
  res.put('ExtGState', { GS1: { Type: 'ExtGState', ca: d.fillOpacity ?? 0.12 } });
  x = o.doc.addStream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, W, H], Resources: res });
  m.set(key, x);
  return x;
}

// ---------------------------------------------------------------- save / compress / protect

export interface SaveOpts {
  /** append only the changes (fast, keeps digital signatures valid) */
  incremental?: boolean;
  garbage?: boolean;
  password?: { user?: string; owner?: string; permissions?: number } | null;
  /** remove passwords */
  decrypt?: boolean;
  sanitize?: boolean;
  clearMetadata?: boolean;
}

/** "original + changes" is possible for this save (nothing asks for the file to be rewritten) */
const appendable = (o: Open, s: SaveOpts) => !s.password && !s.decrypt && !s.sanitize && !s.clearMetadata && o.doc.canBeSavedIncrementally();

/**
 * Saving this way rewrites a digitally signed file, so its signatures stop being valid
 * (something was removed for good - pages, redactions, edited text - or the password,
 * "remove hidden info"... asked for a rewrite). The window can say so before saving.
 */
export function breaksSignatures(id: string, s: SaveOpts = {}): boolean {
  const o = O(id);
  return !!o.signed && !(appendable(o, s) && !o.removedContent);
}

export function save(id: string, s: SaveOpts = {}): Uint8Array {
  const o = O(id);
  const canInc = appendable(o, s);
  // original + changes: when asked and only markups changed, or always for big files (no
  // second copy of 300 MB in memory) - never once something was removed for good
  // (a file whose line work was merged is saved in full even when big, up to 400 MB - appended,
  // the old line work would stay in it and the file grow; above that the memory a full save
  // needs is the greater risk)
  const big = (o.reader?.size ?? 0) > 64e6 && !(o.merged && (o.reader?.size ?? 0) < 400e6);
  // a signed file: "original + changes" whenever it can be - also for Save as and after page
  // changes (rewriting the file breaks every signature in it; appended changes leave them
  // valid, shown as "changed since signing"), unless something was removed for good
  const keepSigs = !!o.signed && !o.removedContent;
  // saved in full (files up to 64 MB) even when only markups changed: a markup from the file was
  // deleted or flattened (the original part still holds it, its text and author), or a whole
  // font from the PC was embedded (only a full save cuts it down to the letters used)
  const tidy = !big && (!!o.droppedAnnots || !!o.bigFont);
  // a file this big (a merged set of volumes): written in pieces - MuPDF's own save, even "original
  // + changes", builds the whole file in memory and failed at about 1 GB (nothing was saved). Not
  // for what needs MuPDF's writer: a signed file (changes appended), a password set or taken off,
  // "remove hidden info", or an encrypted file
  if ((o.reader?.size ?? 0) > STREAM_SAVE && !keepSigs && !s.password && !s.decrypt && !s.sanitize && !s.clearMetadata && !encrypted(o)) {
    return emitStream((put) => writeObjects(o.doc, put));
  }
  if (canInc && !o.removedContent && (keepSigs || big || (s.incremental && !o.changedContent && !tidy))) {
    const b = saveIncremental(o);
    if (b) return out(b);
  }
  // Never garbage-collect the open document itself: that renumbers objects (markup ids)
  // and breaks undo. Write it plainly, then clean the copy: unused objects dropped - so
  // nothing redacted or deleted survives anywhere in the file.
  const plain = o.doc.saveToBuffer('');
  let tmp: mupdf.PDFDocument;
  try { tmp = mupdf.Document.openDocument(plain, 'application/pdf').asPDF()!; } catch (e) { plain.destroy?.(); throw e; }
  try {
    if (o.password) tmp.authenticatePassword(o.password);
    if (o.bigFont) { try { tmp.subsetFonts(); } catch { /* keep the full font */ } }
    // (the copy's properties are cleared - the open document keeps its own)
    if (s.clearMetadata) {
      for (const k of ['info:Title', 'info:Author', 'info:Subject', 'info:Keywords', 'info:Creator', 'info:Producer']) tmp.setMetaData(k, '');
      // the XMP packet holds the same (author, title, the program that made it): gone too
      try { tmp.getTrailer().get('Root').delete('Metadata'); } catch { /* none */ }
    }
    const opts = ['garbage=compact', 'compress', 'objstms'];
    if (s.sanitize) opts.push('sanitize', 'clean');
    if (s.password && (s.password.user || s.password.owner)) {
      opts.push('encrypt=aes-256');
      // (MuPDF's option list is split at commas - the password box refuses them)
      if (/,/.test((s.password.user || '') + (s.password.owner || ''))) throw new Error('A password can\'t contain a comma.');
      if (s.password.user) opts.push('user-password=' + s.password.user);
      opts.push('owner-password=' + (s.password.owner || s.password.user || ''));
      opts.push('permissions=' + (s.password.permissions ?? -1));
    } else if (s.decrypt) opts.push('encrypt=none');
    // (otherwise the file's own protection stays as it was - also a "permissions only" one,
    // which opens without a password)
    const b = out(tmp.saveToBuffer(opts.join(',')));
    // (merged line work: the open file still holds the old line work - "original + changes" would
    // put it back in the file, twice the size: stays a full save)
    if (!o.merged) o.changedContent = false;
    return b;
  } finally {
    tmp.destroy?.();
    plain.destroy?.();
  }
}

/** the current state as bytes for the drawing engine (doesn't touch the save state) */
export function snapshot(id: string): Uint8Array {
  return out(O(id).doc.saveToBuffer(''));
}

/**
 * The current state written for the drawing engines / recovery. When the document reads
 * from a file, MuPDF's incremental save is that file + appended changes, so only the
 * appended part is written (`write(view, from)`): a page rotated in a 500 MB file costs
 * a few KB, not 500 MB. Otherwise (repaired / bytes / asked for) the whole file.
 */
export function snapshotTo(id: string, write: (view: Uint8Array, from: number) => void, full = false, stream?: (fill: (put: (b: string | Uint8Array) => void) => void) => void): { base: number } {
  const o = O(id);
  const base = o.reader?.size ?? 0;
  // nothing changed since it was opened (a merged set just made, a tab restored and not touched
  // yet): the original as it is, and no changes
  // (from = base: no bytes past the original - the same contract as "original + changes")
  // (not for a file that was repaired on opening: the original is the damaged file the drawing
  // engines must not be given)
  if (!full && base > 0 && o.reader && !o.merged && !o.doc.wasRepaired() && !o.doc.hasUnsavedChanges()) { write(new Uint8Array(0), base); return { base }; }
  // past ~600 MB "original + changes" is built whole in memory and fails: a whole copy written in
  // pieces instead
  if (stream && base > 600e6 && !encrypted(o)) { stream((put) => writeObjects(o.doc, put)); return { base: 0 }; }
  if (!full && base > 0 && o.reader && o.doc.canBeSavedIncrementally()) {
    let buf: mupdf.Buffer | null = null;
    try {
      buf = saveIncremental(o);
      if (!buf) throw new Error('no incremental');
      const v = buf.asUint8Array();
      if (v.length >= base && sameStart(o.reader, v, base)) { write(v, base); return { base }; }
    } catch { /* fall back to a whole copy */ } finally { buf?.destroy?.(); }
  }
  const buf = o.doc.saveToBuffer('');
  try { write(buf.asUint8Array(), 0); } finally { buf.destroy?.(); }
  return { base: 0 };
}
/** the incremental save really starts with the file as it is (checked at both ends) */
function sameStart(r: Reader, v: Uint8Array, base: number): boolean {
  const n = Math.min(65536, base);
  const a = new Uint8Array(n);
  for (const at of [0, base - n]) {
    if (r.read(a, 0, n, at) !== n) return false;
    for (let i = 0; i < n; i++) if (a[i] !== v[at + i]) return false;
  }
  return true;
}

/** small JSON kept inside the PDF (page scales etc.) */
export function getData(id: string): Record<string, unknown> {
  const o = O(id);
  try {
    const v = o.doc.getTrailer().get('Root', 'GCCData');
    return v.isNull() ? {} : JSON.parse(v.asString());
  } catch { return {}; }
}
export function setData(id: string, data: Record<string, unknown>, name = 'Change settings') {
  const o = O(id);
  op(o, name, 'a', () => { o.doc.getTrailer().get('Root').put('GCCData', o.doc.newString(JSON.stringify(data))); });
}

export function setMeta(id: string, meta: Record<string, string>) {
  const o = O(id);
  op(o, 'Document properties', 'a', () => {
    for (const [k, v] of Object.entries(meta)) o.doc.setMetaData('info:' + k, v);
    // the file's XMP packet too, where it has these: other PDF programs show the title / author
    // from there (an edit here looked as if it hadn't worked)
    try {
      const md = o.doc.getTrailer().get('Root', 'Metadata');
      if (md.isStream()) {
        const old = md.readStream().asString();
        const x = xmpWith(old, meta);
        if (x !== old) md.writeStream(x);
      }
    } catch { /* left as it is */ }
  });
}

/** an XMP packet with the title / author / subject / keywords it already holds set to new values */
function xmpWith(x: string, meta: Record<string, string>): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // a language alternative or list (dc:title, dc:description, dc:creator): one entry with the value
  const list = (tag: string, kind: 'Alt' | 'Seq', v: string) => {
    x = x.replace(new RegExp(`(<${tag}>\\s*<rdf:${kind}>)[\\s\\S]*?(</rdf:${kind}>\\s*</${tag}>)`), (_m, a: string, b: string) =>
      `${a}<rdf:li${kind === 'Alt' ? ' xml:lang="x-default"' : ''}>${esc(v)}</rdf:li>${b}`);
  };
  // a simple property, as an element or as an attribute
  const simple = (tag: string, v: string) => {
    x = x.replace(new RegExp(`(<${tag}>)[\\s\\S]*?(</${tag}>)`), (_m, a: string, b: string) => a + esc(v) + b);
    x = x.replace(new RegExp(`(\\s${tag}=")[^"]*(")`), (_m, a: string, b: string) => a + esc(v) + b);
  };
  if (meta.Title !== undefined) list('dc:title', 'Alt', meta.Title);
  if (meta.Subject !== undefined) list('dc:description', 'Alt', meta.Subject);
  if (meta.Author !== undefined) list('dc:creator', 'Seq', meta.Author);
  if (meta.Keywords !== undefined) simple('pdf:Keywords', meta.Keywords);
  return x;
}
export function getMeta(id: string): Record<string, string> {
  const o = O(id);
  const out: Record<string, string> = {};
  for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']) out[k] = o.doc.getMetaData('info:' + k) || '';
  out.Version = 'PDF ' + (o.doc.getVersion() / 10).toFixed(1);
  return out;
}

export interface CompressOpts { dpi: number; quality: number; minBytes?: number; grayToGray?: boolean }
export interface CompressReport { images: number; changed: number; before: number; after: number }

/**
 * Shrink a PDF: pictures above `dpi` (assuming they span the biggest page) are scaled
 * down and saved as JPEG at `quality`; then everything is rewritten without unused
 * objects, with streams compressed and object streams. Line work and text untouched.
 */
export function compress(bytes: In, c: CompressOpts, password?: string): { bytes: Uint8Array | null; report: CompressReport } {
  const doc = openOther(bytes, password);
  const rep: CompressReport = { images: 0, changed: 0, before: inSize(bytes), after: 0 };
  try {
    let maxW = 0, maxH = 0;
    for (let i = 0; i < doc.countPages(); i++) {
      const b = doc.loadPage(i).getBounds();
      maxW = Math.max(maxW, b[2] - b[0]); maxH = Math.max(maxH, b[3] - b[1]);
    }
    const limW = (maxW / 72) * c.dpi, limH = (maxH / 72) * c.dpi;
    const n = doc.countObjects();
    for (let i = 1; i < n; i++) {
      let obj: mupdf.PDFObject;
      try { obj = doc.newIndirect(i); } catch { continue; }
      if (!obj.isStream()) continue;
      if (obj.get('Subtype').isNull() || obj.get('Subtype').asName() !== 'Image') continue;
      rep.images++;
      // (MuPDF memory is not seen by JavaScript's garbage collector: every picture, pixmap and
      // buffer made for one image is freed right after it - a long scan grew the engine by the
      // size of every page's pixels)
      const made: { destroy?: () => void }[] = [];
      const keep = <T extends { destroy?: () => void }>(x: T): T => { made.push(x); return x; };
      try {
        if (!obj.get('ImageMask').isNull() && obj.get('ImageMask').asBoolean()) continue;
        const bpc = num(obj.get('BitsPerComponent')) ?? 8;
        if (bpc < 8) continue; // bi-level scans: already tiny (CCITT/JBIG2)
        const raw = keep(obj.readRawStream());
        if (raw.getLength() < (c.minBytes ?? 40000)) continue;
        const img = keep(doc.loadImage(doc.newIndirect(i)));
        const w = img.getWidth(), h = img.getHeight();
        const k = Math.min(1, limW / w, limH / h, Math.max(limW, limH) / Math.max(w, h));
        let pix = keep(img.toPixmap());
        const cs = pix.getColorSpace();
        if (!cs || pix.getAlpha()) { pix = keep(pix.convertToColorSpace(cs && cs.isGray() ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, false)); }
        else if (!cs.isGray() && !cs.isRGB()) pix = keep(pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false));
        let nw = w, nh = h;
        if (k < 0.97) {
          nw = Math.max(1, Math.round(w * k)); nh = Math.max(1, Math.round(h * k));
          pix = keep(pix.warp([[0, 0], [w, 0], [w, h], [0, h]] as unknown as mupdf.Point[], nw, nh));
        }
        const jpg = pix.asJPEG(c.quality);
        if (jpg.length >= raw.getLength() * 0.9) continue;
        obj.writeRawStream(jpg);
        obj.put('Filter', doc.newName('DCTDecode'));
        obj.delete('DecodeParms');
        obj.delete('Decode');
        obj.put('Width', nw);
        obj.put('Height', nh);
        obj.put('BitsPerComponent', 8);
        obj.put('ColorSpace', doc.newName(pix.getColorSpace()?.isGray() ? 'DeviceGray' : 'DeviceRGB'));
        rep.changed++;
      } catch { /* leave that picture as it is */ } finally { for (const x of made) { try { x.destroy?.(); } catch { /* already gone */ } } }
    }
    const ob = doc.saveToBuffer('garbage=deduplicate,compress,compress-fonts,objstms');
    rep.after = ob.getLength();
    // no gain: null = keep the original as it is
    if (rep.after >= rep.before) { ob.destroy?.(); return { bytes: null, report: { ...rep, after: rep.before } }; }
    return { bytes: out(ob), report: rep };
  } finally {
    doc.destroy?.();
  }
}

/** repair: open (MuPDF rebuilds a broken file) and write a clean copy */
export function repair(bytes: In): { bytes: Uint8Array; repaired: boolean } {
  const doc = openOther(bytes);
  try {
    const r = doc.wasRepaired();
    return { bytes: out(doc.saveToBuffer('garbage=compact,compress')), repaired: r };
  } finally {
    doc.destroy?.();
  }
}

// ---------------------------------------------------------------- links

/** where a link goes: a web or e-mail address, or a page of this file (0-based) */
export interface LinkSpec { uri?: string; page?: number }
export interface LinkInfoMu { k: number; rect: Rect; uri: string | null; page: number }

function linkUri(o: Open, t: LinkSpec): string {
  if (t.page != null) return '#page=' + (Math.max(0, Math.min(o.doc.countPages() - 1, Math.round(t.page))) + 1);
  const u = String(t.uri ?? '').trim();
  // (only what the app itself would open: never a program, a file or a network share)
  if (!/^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(u) || u.length > 2000) throw new Error('A link goes to a web address (https://…), an e-mail address or a page of this file.');
  return u;
}

/** the links of a page as MuPDF lists them (k: their place in that list) */
export function linksOf(id: string, page: number): LinkInfoMu[] {
  const o = O(id);
  return pg(o, page).getLinks().map((l, k) => {
    const uri = l.getURI() || null;
    let p = -1;
    if (uri && !l.isExternal()) { try { p = o.doc.resolveLink(uri); } catch { /* elsewhere */ } }
    return { k, rect: l.getBounds() as Rect, uri, page: p };
  });
}

/** a new link over `rect` (as the page is shown); one undo step */
export function addLink(id: string, page: number, rect: Rect, t: LinkSpec): PageInfo[] {
  const o = O(id);
  const uri = linkUri(o, t);
  return op(o, 'Add link', 'c', () => {
    const r: Rect = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
    pg(o, page).createLink(r, uri);
    resetPages(o);
    return pageInfos(o);
  });
}

/** link k of the page pointed elsewhere, or deleted (t null); one undo step */
export function setLink(id: string, page: number, k: number, t: LinkSpec | null): PageInfo[] {
  const o = O(id);
  const uri = t ? linkUri(o, t) : '';
  return op(o, t ? 'Change link' : 'Delete link', 'c', () => {
    const p = pg(o, page);
    const l = p.getLinks()[k];
    if (!l) throw new Error('That link is no longer there.');
    if (t) l.setURI(uri);
    else {
      // MuPDF.js's deleteLink takes a link read from the file out of the page, but one made in
      // this session only out of its own list - the file kept it. So the page's link annotation
      // is found by where it is, and taken out if it is still there.
      const want = l.getBounds();
      const wantUri = l.getURI() || '';
      const ctm = p.getTransform();
      const an = p.getObject().get('Annots');
      const before = an.isArray() ? an.length : 0;
      let ref: mupdf.PDFObject | null = null, best = Infinity;
      if (an.isArray()) for (let j = 0; j < an.length; j++) {
        const e = an.get(j), a = e.resolve();
        if (!a.isDictionary() || !a.get('Subtype').isName() || a.get('Subtype').asName() !== 'Link') continue;
        const rr = a.get('Rect');
        if (!rr.isArray() || rr.length !== 4) continue;
        const r = mupdf.Rect.transform([0, 1, 2, 3].map((i) => rr.get(i).asNumber()) as Rect, ctm);
        const n: Rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
        // (two links on the same spot: the one going where this one goes)
        const act = a.get('A');
        const same = act.isDictionary() && act.get('URI').isString() ? act.get('URI').asString() === wantUri : !wantUri.startsWith('http') && !wantUri.startsWith('mailto');
        const dd = n.reduce((sum, v, i) => sum + Math.abs(v - want[i]), 0) + (same ? 0 : 1);
        if (dd < best) { best = dd; ref = e; }
      }
      p.deleteLink(l);
      // (only when MuPDF.js left it in the file - when it took it out, a second one there was taken too)
      const after = p.getObject().get('Annots');
      if (ref && best < 5 && an.isArray() && after.isArray() && after.length === before) {
        for (let j = 0; j < an.length; j++) {
          const e = an.get(j);
          if (e === ref || (e.isIndirect() && ref.isIndirect() && e.asIndirect() === ref.asIndirect())) { an.delete(j); break; }
        }
      }
    }
    resetPages(o);
    return pageInfos(o);
  });
}

// ---------------------------------------------------------------- pages <-> pictures

/** the most pixels a page picture may have (a picture of 60 million pixels is ~180 MB to draw) */
export const PICTURE_MAX_PX = 60e6;

/**
 * A page of a file opened with batchOpen as a PNG or JPG picture, markups drawn as shown. At
 * `dpi`, or less when the page is too big for that (an A0 sheet at 600 dpi): the dpi used is said.
 */
export function pageImage(id: string, page: number, o: { dpi: number; format: 'png' | 'jpg'; quality?: number }): { bytes: Uint8Array; w: number; h: number; dpi: number } {
  const d = O(id).doc;
  const p = d.loadPage(page);
  try {
    const b = p.getBounds();
    const W = (b[2] - b[0]) / 72, H = (b[3] - b[1]) / 72;
    let dpi = Math.max(10, Math.min(1200, o.dpi));
    if (W * H * dpi * dpi > PICTURE_MAX_PX) dpi = Math.floor(Math.sqrt(PICTURE_MAX_PX / (W * H)));
    const s = dpi / 72;
    const pix = p.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      // (the picture says its own resolution: printed / placed at the page's real size)
      pix.setResolution(dpi, dpi);
      const data = o.format === 'jpg' ? pix.asJPEG(Math.max(30, Math.min(100, o.quality ?? 85)), false) : pix.asPNG();
      return { bytes: emit(data), w: pix.getWidth(), h: pix.getHeight(), dpi };
    } finally { pix.destroy?.(); }
  } finally { p.destroy?.(); }
}

const IMAGE_EXT = /\.(jpe?g|jfif|png|tiff?|bmp|gif|jxr|webp)$/i;
const PAPER: Record<string, [number, number]> = { a4: [595.28, 841.89], a3: [841.89, 1190.55], letter: [612, 792] };
function bytesOf(b: In): Uint8Array {
  if (b instanceof Uint8Array) return b;
  if (b.size > 1.5e9) throw new Error('That picture is too big (over 1.5 GB).');
  const outB = new Uint8Array(b.size);
  for (let at = 0; at < b.size;) { const n = b.read(outB, at, b.size - at, at); if (n <= 0) break; at += n; }
  return outB;
}

/**
 * Pictures (JPG, PNG, TIFF - every page of a multi-page one -, BMP, GIF) into one PDF, a page per
 * picture: at the picture's own size (its dpi), or fitted on A4 / A3 / Letter turned to suit it.
 * JPGs go in as they are (no loss); a picture that can't be read is named, the rest still made.
 */
export function picturesToPdf(files: { bytes: In; name: string }[], o: { size: 'picture' | 'a4' | 'a3' | 'letter'; margin?: number }): { bytes: Uint8Array; pages: number; skipped: string[] } {
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, 'pdf', 'compress');
  let pages = 0, written = 0;
  const skipped: string[] = [];
  /** pages written for a picture that then failed (half drawn): taken out at the end */
  const failed: number[] = [];
  try {
    for (const f of files) {
      let d: mupdf.Document | null = null;
      try {
        if (!IMAGE_EXT.test(f.name)) throw new Error('not a picture');
        const data = bytesOf(f.bytes);
        // (a picture is drawn whole in the engine's memory: a 500-million-pixel scan would take it
        // down - but a JPEG goes into the PDF as it is, never opened up: an A0 sheet scanned at
        // 600 dpi is ~560 million pixels and only a few MB)
        const jpeg = data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
        if (!jpeg) try { const im = new mupdf.Image(data); const px = im.getWidth() * im.getHeight(); im.destroy?.(); if (px > 250e6) throw new Error(`too big (${Math.round(px / 1e6)} million pixels)`); } catch (e) { if (/too big/.test(String((e as Error)?.message))) throw e; }
        d = mupdf.Document.openDocument(data, f.name);
        const n = d.countPages();
        if (!n) throw new Error('no pictures in it');
        for (let i = 0; i < n; i++) {
          const pg = d.loadPage(i);
          try {
            const b = pg.getBounds();
            const pw = b[2] - b[0], ph = b[3] - b[1];
            let box: mupdf.Rect = [0, 0, pw, ph];
            let m: mupdf.Matrix = mupdf.Matrix.translate(-b[0], -b[1]);
            if (o.size !== 'picture') {
              const [a, c] = PAPER[o.size] || PAPER.a4;
              // (turned like the picture: a landscape photo on a landscape page)
              const [W, H] = pw > ph ? [c, a] : [a, c];
              const mg = Math.max(0, Math.min(72, o.margin ?? 0));
              const k = Math.min((W - 2 * mg) / pw, (H - 2 * mg) / ph);
              box = [0, 0, W, H];
              m = mupdf.Matrix.concat(mupdf.Matrix.translate(-b[0], -b[1]), mupdf.Matrix.concat(mupdf.Matrix.scale(k, k), mupdf.Matrix.translate((W - pw * k) / 2, (H - ph * k) / 2)));
            }
            const dev = w.beginPage(box);
            // (always ended: a picture that fails while drawn left its page open, and every picture
            // after it failed with "called begin page without ending the previous page")
            let ok = false;
            try { pg.run(dev, m); ok = true; } finally { w.endPage(); if (!ok) failed.push(written); written++; }
            pages++;
          } finally { pg.destroy?.(); }
        }
      } catch (e) {
        skipped.push(`${f.name} (${String((e as Error)?.message || e).replace(/^Error: /, '').slice(0, 80)})`);
      } finally { d?.destroy?.(); }
    }
    w.close();
    if (!pages) throw new Error('None of those could be read as pictures: ' + skipped.join(', '));
    if (failed.length) {
      const doc = mupdf.Document.openDocument(buf.asUint8Array().slice(), 'application/pdf').asPDF()!;
      try {
        for (const i of failed.reverse()) doc.deletePage(i);
        buf.destroy?.();
        return { bytes: out(doc.saveToBuffer('garbage=compact,compress')), pages, skipped };
      } finally { doc.destroy?.(); }
    }
    return { bytes: out(buf), pages, skipped };
  } catch (e) { buf.destroy?.(); throw e; } finally { w.destroy?.(); }
}

/** a file opened only for a batch job */
export function batchOpen(bytes: In, password?: string): string {
  const id = 'batch-' + Math.random().toString(36).slice(2);
  const doc = openOther(bytes, password);
  docs.set(id, { doc, pages: new Map(), undo: [], redo: [], fonts: new Map(), author: '', changedContent: true, reader: bytes instanceof Uint8Array ? undefined : bytes });
  return id;
}
export function batchMark(bytes: In, marks: PageMark[], ctx: MarkContext): { bytes: Uint8Array; pages: number } {
  const id = batchOpen(bytes);
  try {
    const o = O(id);
    const n = markDoc(o, marks, ctx);
    // (marks in a font from the PC - Arabic text: cut down to the letters used)
    if (o.bigFont) { try { o.doc.subsetFonts(); } catch { /* keep the full font */ } }
    return { bytes: out(o.doc.saveToBuffer('garbage=compact,compress')), pages: n };
  } finally { close(id); }
}
export function batchFlatten(bytes: In): Uint8Array {
  const id = batchOpen(bytes);
  try {
    const o = O(id);
    // Before MuPDF's bake, two kinds are taken off the pages' lists: redaction marks still to apply
    // (bake burnt them in as red outlines and dropped them - nothing under them was removed; Flatten
    // in the app keeps them too), put back after; and markups on a layer, burnt in on that layer
    // (bake ignores /OC: a markup on a layer turned off showed)
    const held: { pi: number; refs: mupdf.PDFObject[] }[] = [];
    const onLayer: { pi: number; d: mupdf.PDFObject }[] = [];
    const n = o.doc.countPages();
    for (let pi = 0; pi < n; pi++) {
      const po = o.doc.findPage(pi);
      const list = po.get('Annots');
      if (!list.isArray()) continue;
      const rest = o.doc.newArray();
      const refs: mupdf.PDFObject[] = [];
      let moved = false;
      for (let i = 0; i < list.length; i++) {
        const ref = list.get(i);
        const a = ref.resolve();
        const t = a.isDictionary() && a.get('Subtype').isName() ? a.get('Subtype').asName() : '';
        if (t === 'Redact') { refs.push(ref); moved = true; continue; }
        if (t && t !== 'Widget' && t !== 'Link' && t !== 'Popup' && !a.get('OC').isNull()) {
          moved = true;
          const f = a.get('F').isNumber() ? a.get('F').asNumber() : 0;
          if (!(f & HIDDEN) && a.get('IRT').isNull()) onLayer.push({ pi, d: a });
          continue;
        }
        rest.push(ref);
      }
      if (moved) po.put('Annots', rest);
      if (refs.length) held.push({ pi, refs });
    }
    o.doc.bake(true, true);
    for (const { pi, d } of onLayer) bakeDict(o, pg(o, pi), d, opacityOf(d));
    for (const { pi, refs } of held) {
      const po = o.doc.findPage(pi);
      let list = po.get('Annots');
      if (!list.isArray()) { list = o.doc.newArray(); po.put('Annots', list); }
      for (const r of refs) list.push(r);
    }
    return out(o.doc.saveToBuffer('garbage=compact,compress'));
  } finally { close(id); }
}

export function pageCountOf(bytes: In): number {
  const d = openIn(bytes);
  try { return d.needsPassword() ? -1 : d.countPages(); } finally { d.destroy?.(); }
}

/**
 * A page as a picture on white, at about `dpi` but at most `maxSide` pixels long (a stamp from a
 * scanned PDF: an A4 page at 300 dpi, an A0 drawing as sharp as the limit allows). s = pixels per point.
 */
export function pagePicture(bytes: In, page: number, dpi: number, maxSide: number): { px: Uint8ClampedArray; w: number; h: number; s: number; pages: number } {
  const d = openIn(bytes);
  try {
    if (d.needsPassword()) throw new Error('This PDF is protected with a password - open it in PDF Editor, then use "From a page".');
    const pages = d.countPages();
    const p = d.loadPage(page);
    const b = p.getBounds();
    const s = Math.min(dpi / 72, maxSide / Math.max(1, b[2] - b[0], b[3] - b[1]));
    const pix = p.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
    const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), src = pix.getPixels();
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = src[i * n]; px[i * 4 + 1] = src[i * n + 1]; px[i * 4 + 2] = src[i * n + 2]; px[i * 4 + 3] = 255; }
    pix.destroy?.();
    p.destroy?.();
    return { px, w, h, s, pages };
  } finally { d.destroy?.(); }
}

/** small picture of a page (for merge lists etc.) */
export function thumbOf(bytes: In, page: number, width: number): { px: Uint8ClampedArray; w: number; h: number; s: number } {
  const d = openIn(bytes);
  try {
    const p = d.loadPage(page);
    const b = p.getBounds();
    // (a sliver of a page - a strip far taller than wide - would make a picture of millions of pixels)
    const s = Math.min(width / Math.max(1, b[2] - b[0]), (width * 4) / Math.max(1, b[3] - b[1]));
    const pix = p.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, true, true);
    const px = new Uint8ClampedArray(pix.getPixels());
    // (MuPDF's pixels with alpha are premultiplied; the window reads them straight - edges came
    // out dark)
    for (let i = 0; i < px.length; i += 4) { const a = px[i + 3]; if (a && a < 255) { px[i] = (px[i] * 255) / a; px[i + 1] = (px[i + 1] * 255) / a; px[i + 2] = (px[i + 2] * 255) / a; } }
    const r = { px, w: pix.getWidth(), h: pix.getHeight(), s };
    pix.destroy?.();
    p.destroy?.();
    return r;
  } finally { d.destroy?.(); }
}

// ---------------------------------------------------------------- printing

/**
 * The file sent to the printer: each chosen page (or the part in view) placed on its sheet as
 * the print settings say - still vector, pictures not re-compressed. Markups are burnt in
 * (only those marked for printing) or left out; form fields always print.
 */
export function printFile(id: string, opts: PrintOpts): Uint8Array {
  const o = O(id);
  const pd = new mupdf.PDFDocument();
  try {
    // one graft map for everything copied: the pages' layer references then point at the same
    // copies as /OCProperties (separate copies made a hidden layer print), and fonts / pictures
    // shared by many pages are copied once
    const gm = pd.newGraftMap();
    opts.pages.forEach((pi, k) => gm.graftPage(k, o.doc, pi));
    // layers (optional content): the same ones on and off as in the file (without them every
    // hidden layer of a drawing would print)
    const ocp = o.doc.getTrailer().get('Root', 'OCProperties');
    if (!ocp.isNull()) pd.getTrailer().get('Root').put('OCProperties', gm.graftObject(ocp));
    // graftPage leaves the markups behind: copy the ones that print (without their page link,
    // pop-up and replies), then burn them into the page
    // (a markup's layer, /OC, comes along - through the same graft map, so it names the layer copied
    // with /OCProperties - and such a markup is burnt in on its layer below: MuPDF's bake ignores
    // /OC, and a markup on a layer turned off printed although it didn't show)
    const SKIP = new Set(['P', 'Popup', 'IRT', 'Parent', 'StructParent']);
    const onLayer: { k: number; d: mupdf.PDFObject }[] = [];
    opts.pages.forEach((pi, k) => {
      const list = o.doc.findPage(pi).get('Annots');
      if (!list.isArray()) return;
      const np = pd.findPage(k);
      const arr2 = pd.newArray();
      for (let i = 0; i < list.length; i++) {
        const a = list.get(i).resolve();
        if (!a.isDictionary()) continue;
        const t = a.get('Subtype').isName() ? a.get('Subtype').asName() : '';
        const f = a.get('F').isNumber() ? a.get('F').asNumber() : 0;
        if (t === 'Popup' || t === 'Link' || (f & HIDDEN) || !(f & PRINT)) continue;
        if (!a.get('IRT').isNull()) continue; // replies to comments (not shown on the page either)
        if (t !== 'Widget' && !opts.markups) continue;
        if (!a.get('AP').isDictionary() && t !== 'Widget') continue;
        const nd = pd.newDictionary();
        a.forEach((v: mupdf.PDFObject, key: string | number) => { if (!SKIP.has(String(key))) nd.put(String(key), gm.graftObject(v)); });
        nd.put('P', np);
        if (t !== 'Widget' && !nd.get('OC').isNull()) { onLayer.push({ k, d: nd }); continue; }
        arr2.push(pd.addObject(nd));
      }
      if (arr2.length) np.put('Annots', arr2);
    });
    pd.bake(true, true);
    if (onLayer.length) {
      const po = { doc: pd } as unknown as Open;
      for (const { k, d } of onLayer) bakeDict(po, pd.loadPage(k) as mupdf.PDFPage, d, opacityOf(d));
    }
    // which sheets go as pictures (decided on the page as it is in the file, before it is
    // placed on its sheet)
    const send = opts.send || 'vector';
    const layered = !ocp.isNull();
    const pic: boolean[] = opts.pages.map((pi) => {
      if (send === 'vector') return false;
      const p0 = pg(o, pi);
      const b0 = p0.getBounds();
      const L0 = sheetLayout(b0[2] - b0[0], b0[3] - b0[1], opts.region, opts);
      if (send === 'picture') return true;
      if (L0.W * L0.H > AUTO_PICTURE_MAX_AREA) return false;
      // (layers: what prints can differ from what shows - a layer only for printing, off on
      // screen - and the picture can't be trusted to have it: such files go as they are)
      if (layered) return false;
      // (the whole page's area at the print scale: its pictures' pixels are the whole page's)
      const sheetIn2 = (((b0[2] - b0[0]) * L0.k) / 72) * (((b0[3] - b0[1]) * L0.k) / 72);
      return heavyForPrinter(pageWeight(o.doc.findPage(pi)), sheetIn2, !!opts.gray);
    });
    for (let k = 0; k < opts.pages.length; k++) {
      const p = pd.loadPage(k) as mupdf.PDFPage;
      const b = p.getBounds();
      const L = sheetLayout(b[2] - b[0], b[3] - b[1], opts.region, opts);
      const ctm = p.getTransform() as unknown as number[];
      // page space (top-down) -> sheet (PDF, bottom-up)
      const S = [L.k, 0, 0, -L.k, L.ox - L.k * (L.r[0] - b[0]), L.H - L.oy + L.k * (L.r[1] - b[1])];
      const M = mul(ctm, S);
      const cw = (L.r[2] - L.r[0]) * L.k, ch = (L.r[3] - L.r[1]) * L.k;
      const obj = p.getObject();
      const old = obj.get('Contents');
      const list = pd.newArray();
      list.push(pd.addStream(`q ${+L.ox.toFixed(3)} ${+(L.H - L.oy - ch).toFixed(3)} ${+cw.toFixed(3)} ${+ch.toFixed(3)} re W n ${fmt(M)} cm\n`, {}));
      if (old.isArray()) for (let i = 0; i < old.length; i++) list.push(old.get(i));
      else if (!old.isNull()) list.push(old);
      list.push(pd.addStream('\nQ', {}));
      obj.put('Contents', list);
      obj.put('MediaBox', [0, 0, +L.W.toFixed(3), +L.H.toFixed(3)]);
      for (const key of ['CropBox', 'TrimBox', 'BleedBox', 'ArtBox', 'Rotate', 'UserUnit', 'Annots']) obj.delete(key);
      p.destroy?.();
    }
    const bytes = out(pd.saveToBuffer('compress'));
    // (the sheets to send as pictures are made from this file by the batch engine, one by one
    // - printPicture - so the open file stays usable and the print panel can show progress)
    if (send === 'vector') return bytes;
    return { bytes, pictures: pic.flatMap((x, k) => (x ? [k] : [])) } as unknown as Uint8Array;
  } finally { pd.destroy?.(); }
}

/**
 * Sheets of a print file made into pictures, a sheet at a time, and the file written in pieces -
 * as a merge is (mergeStart): every picture is handed to `spill` (the engine writes it to a temp
 * file) and emptied here, the file is written object by object at the end (only what it still
 * uses: the sheets' old content stays out), the pictures copied back from the temp file. Kept in
 * the engine's memory, 1,000 sheets of pictures ran it out of memory at the save ("realloc
 * failed") after minutes of work - nothing printed.
 */
export interface PicState { doc: mupdf.PDFDocument; spilled: Map<number, { off: number; len: number }>; next: number }
export function picStart(bytes: In): PicState {
  const doc = openOther(bytes);
  return { doc, spilled: new Map(), next: doc.countObjects() };
}
export function picSheet(st: PicState, k: number, gray: boolean, spill: (raw: Uint8Array) => number): void {
  const p = st.doc.loadPage(k);
  const b = p.getBounds();
  p.destroy?.();
  sheetAsPicture(st.doc, k, b[2] - b[0], b[3] - b[1], gray);
  // (the new picture and content streams out to disk, emptied here)
  const n = st.doc.countObjects();
  for (let num = st.next; num < n; num++) {
    const ref = st.doc.newIndirect(num);
    if (!ref.isStream()) continue;
    const raw = ref.readRawStream();
    try { const v = raw.asUint8Array(); st.spilled.set(num, { off: spill(v), len: v.length }); }
    finally { raw.destroy?.(); }
    ref.writeRawStream(new Uint8Array(0));
  }
  st.next = n;
}
export function picWrite(st: PicState, write: (b: string | Uint8Array) => void, copy: (off: number, len: number) => void) {
  writeObjects(st.doc, write, st.spilled, copy);
}
export function picDrop(st: PicState) { try { st.doc.destroy?.(); } catch { /* gone */ } }

/** how heavy a page is to print: bytes of drawing instructions, picture pixels (all, colour) -
 *  in the page and the forms it uses (each counted once) */
function pageWeight(page: mupdf.PDFObject): { content: number; imgPx: number; colourPx: number } {
  const w = { content: 0, imgPx: 0, colourPx: 0 };
  const seen = new Set<number>();
  const len = (s: mupdf.PDFObject) => { const n = s.get('Length'); return n.isNumber() ? n.asNumber() : 0; };
  const colourCs = (cs: mupdf.PDFObject): boolean => {
    try {
      if (cs.isName()) return ['DeviceRGB', 'CalRGB', 'DeviceCMYK', 'Lab'].includes(cs.asName());
      if (cs.isArray() && cs.length) {
        const t = cs.get(0).isName() ? cs.get(0).asName() : '';
        if (t === 'ICCBased') { const n = cs.get(1).get('N'); return n.isNumber() && n.asNumber() >= 3; }
        if (t === 'Indexed') return colourCs(cs.get(1));
        return ['CalRGB', 'Lab', 'DeviceN'].includes(t);
      }
    } catch { /* odd colour space */ }
    return false;
  };
  const walk = (res: mupdf.PDFObject, depth: number) => {
    if (!res.isDictionary() || depth > 4) return;
    const xo = res.get('XObject');
    if (!xo.isDictionary()) return;
    xo.forEach((v: mupdf.PDFObject) => {
      const num = v.isIndirect() ? v.asIndirect() : -1;
      if (num >= 0) { if (seen.has(num)) return; seen.add(num); }
      // (isStream() is only true of the reference, not of what it points at)
      if (!v.isStream()) return;
      const x = v.resolve();
      const st = x.get('Subtype').isName() ? x.get('Subtype').asName() : '';
      if (st === 'Image') {
        const ww = x.get('Width'), hh = x.get('Height');
        const px = ww.isNumber() && hh.isNumber() ? ww.asNumber() * hh.asNumber() : 0;
        w.imgPx += px;
        if (colourCs(x.get('ColorSpace'))) w.colourPx += px;
      } else if (st === 'Form') { w.content += len(x); walk(x.get('Resources'), depth + 1); }
    });
  };
  try {
    const c = page.get('Contents');
    if (c.isArray()) for (let i = 0; i < c.length; i++) w.content += len(c.get(i).resolve());
    else if (!c.isNull()) w.content += len(c.resolve());
    let res = page.get('Resources');
    // (inherited from the page tree)
    for (let p = page, d = 0; res.isNull() && d < 32; d++) { p = p.get('Parent'); if (p.isNull()) break; res = p.get('Resources'); }
    walk(res, 0);
  } catch { /* a damaged page: weighed as far as it reads */ }
  return w;
}

/**
 * A sheet of the print file replaced by one picture of itself (300 dpi, at most 60 million
 * pixels; grey for black & white): what a printer then gets is one picture instead of a scan
 * at full size or a drawing's lines one by one - far less for Windows and the printer to chew.
 */
function sheetAsPicture(pd: mupdf.PDFDocument, k: number, W: number, H: number, gray: boolean) {
  const p = pd.loadPage(k) as mupdf.PDFPage;
  try {
    const s = Math.min(PICTURE_DPI / 72, Math.sqrt(PICTURE_MAX_PX / Math.max(1, W * H)));
    // (drawn for printing: a layer set not to print stays out)
    const pix = (p as mupdf.PDFPage).toPixmap(mupdf.Matrix.scale(s, s), gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, false, true, 'Print');
    let jpg: Uint8Array;
    try { jpg = pix.asJPEG(88); } finally { pix.destroy?.(); }
    const img = new mupdf.Image(jpg);
    const ref = pd.addImage(img);
    img.destroy?.();
    const obj = p.getObject();
    const res = pd.newDictionary();
    const xo = pd.newDictionary();
    xo.put('Im0', ref);
    res.put('XObject', xo);
    obj.put('Resources', res);
    obj.put('Contents', pd.addStream(`q ${+W.toFixed(3)} 0 0 ${+H.toFixed(3)} 0 0 cm /Im0 Do Q`, {}));
    obj.delete('Group');
  } finally { p.destroy?.(); }
}

/** a picture of one printed sheet (print preview), `px` pixels on its long side */
export function printPreview(id: string, opts: PrintOpts, index: number, px: number): { px: Uint8ClampedArray; w: number; h: number; W: number; H: number; x: number; y: number; s: number } | null {
  const o = O(id);
  const pi = opts.pages[index];
  if (pi == null || pi >= o.doc.countPages()) return null;
  const p = pg(o, pi);
  const b = p.getBounds();
  const L = sheetLayout(b[2] - b[0], b[3] - b[1], opts.region, opts);
  const s = px / Math.max(L.W, L.H);
  const kk = L.k * s;
  const x0 = Math.max(0, Math.round(L.ox * s)), y0 = Math.max(0, Math.round(L.oy * s));
  // only what lands on the sheet
  const w = Math.max(1, Math.min(Math.round(L.W * s) - x0, Math.round((L.r[2] - L.r[0]) * kk)));
  const h = Math.max(1, Math.min(Math.round(L.H * s) - y0, Math.round((L.r[3] - L.r[1]) * kk)));
  const sx = L.ox < 0 ? -L.ox * s : 0, sy = L.oy < 0 ? -L.oy * s : 0;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], true);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const m = [kk, 0, 0, kk, -(L.r[0] - b[0]) * kk - sx, -(L.r[1] - b[1]) * kk - sy] as unknown as mupdf.Matrix;
  try {
    // the page, then what printFile() puts on the sheet: markups set to print (not hidden, not
    // replies) when markups are on, form fields always
    p.runPageContents(dev, m);
    for (const a of p.getAnnotations()) {
      const t = a.getType();
      if (t === 'Popup' || t === 'Link') continue;
      if (t !== 'Widget' && !opts.markups) continue;
      const f = a.getFlags();
      if ((f & HIDDEN) || !(f & PRINT)) continue;
      if (!a.getObject().get('IRT').isNull()) continue;
      try { a.run(dev, m); } catch { /* one that can't be drawn */ }
    }
    dev.close();
    return { px: new Uint8ClampedArray(pix.getPixels()), w, h, W: L.W, H: L.H, x: x0, y: y0, s };
  } finally { dev.destroy?.(); pix.destroy?.(); }
}
