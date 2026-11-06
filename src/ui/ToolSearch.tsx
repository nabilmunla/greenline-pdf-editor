// "Find a tool": a search box in the title bar for when you can't remember which tab a tool is
// on. Type what you want to do ("page numbers", "compress", "measure area", "password"):
// matching tools are listed with where they live (Edit › Page marks). Enter switches to that
// tab, points the button out and runs it. The list comes from the ribbon itself (RibbonCmd),
// so it can't drift from what the ribbon shows. Alt+Q jumps here.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Ico } from './icons';
import { TAB_NAMES, type RibbonCmd } from './Ribbon';

/** things that aren't on the ribbon */
export interface ExtraCmd { label: string; where: string; title: string; icon: string; disabled?: boolean; run(): void }
export type FoundCmd = (RibbonCmd & { kind: 'ribbon' }) | (ExtraCmd & { kind: 'extra' });

/** words people use for a tool that aren't in its name or tooltip */
const ALSO: Record<string, string> = {
  'open': 'file load browse',
  'save as': 'copy export duplicate file rename',
  'print': 'printer paper hard copy',
  'reduce size': 'compress smaller shrink optimise optimize file size mb',
  'merge': 'combine join append add files together',
  'merge files': 'combine join append add files together',
  'split': 'separate break divide into files',
  'extract': 'take out save pages pull',
  'from file': 'insert pages add pages another file append open files tabs',
  'insert': 'insert pages add pages another file append',
  'blank page': 'empty new page add page',
  'duplicate': 'copy page repeat',
  'rotate': 'turn',
  'rotate left': 'turn anticlockwise counterclockwise',
  'rotate right': 'turn clockwise',
  'crop': 'trim cut margins',
  'delete': 'remove pages',
  'make searchable': 'ocr scan recognise recognize scanned text',
  'read area': 'ocr copy text from scan picture text',
  'copy table': 'excel table rows columns spreadsheet',
  'table to excel': 'copy table excel rows columns spreadsheet area part of drawing schedule',
  'table area to excel': 'copy table excel rows columns spreadsheet area part of drawing schedule',
  'replace': 'replace pages revised sheets revision swap substitute',
  'pictures': 'save pages as png jpg jpeg images export picture',
  'save as pictures': 'save pages as png jpg jpeg images export picture',
  'new from pictures': 'images to pdf jpg png tiff photos scans create pdf from pictures',
  'link': 'hyperlink url web address link to page website email',
  'protect': 'password encrypt lock security permissions',
  'remove': 'unlock decrypt remove password',
  'remove hidden info': 'metadata sanitize sanitise clean author privacy',
  'numbers & headers': 'page numbers numbering header footer bates watermark',
  'stamp & number': 'batch stamp watermark page numbers many files',
  'signature': 'sign signing initials',
  'image': 'picture photo logo insert image',
  'add image': 'picture photo logo insert image',
  'stamp': 'approved rejected received draft for construction seal company scan',
  'calibrate': 'scale known length dimension set scale',
  'scale': 'drawing scale 1:100 1:50 ratio',
  'viewport': 'detail scale part of sheet',
  'length': 'distance measure line dimension metres meters',
  'polylength': 'run length path distance pipes cables',
  'area': 'square metres sqm m2 floor area rectangle area circle area round perimeter boundary edge length around circumference outline skirting',
  'totals': 'counts summary count total how many sum quantities results',
  'rectangle area': 'square metres sqm m2 floor area box rectangular room drag',
  'angle': 'degrees slope',
  'count': 'tally number of quantity items doors',
  'to excel': 'export measurements xlsx spreadsheet quantities',
  'snap on': 'snapping magnet grab corners',
  'snap off': 'snapping magnet grab corners',
  'edit text': 'change text modify text fix typo wording',
  'add text': 'type text write typewriter',
  'typewriter': 'type text write',
  'mark area': 'redact black out hide erase censor',
  'mark text': 'redact black out hide erase censor',
  'find & mark': 'redact search names amounts',
  'apply': 'apply redaction burn remove for good',
  'flatten': 'burn markups merge markups permanent',
  'flatten files': 'burn markups batch permanent',
  'tool chest': 'saved tools favourites favorites presets',
  'comment': 'note sticky note',
  'text box': 'textbox free text type',
  'callout': 'arrow text leader label',
  'cloud': 'revision cloud',
  'pencil': 'freehand ink draw sketch',
  'highlight': 'marker yellow',
  'area highlight': 'highlight box region',
  'rectangle': 'box square',
  'ellipse': 'circle oval',
  'polyline': 'lines path',
  'polygon': 'shape',
  'translate': 'arabic english language translation',
  'ask about this file': 'chat question ai claude chatgpt summary',
  'ask ai': 'chat question ai claude chatgpt summary',
  'ai keys': 'api key setup claude chatgpt',
  'search': 'find text word all open files across files',
  'zoom in': 'bigger enlarge magnify',
  'zoom out': 'smaller',
  'fit width': 'zoom whole width',
  'fit page': 'zoom whole page',
  'actual size': '100% zoom real size',
  'zoom area': 'zoom box window',
  'snapshot': 'copy picture image screenshot',
  'stamp from page': 'seal scan company picture remove background clean grab',
  'copy to pages': 'stamp all pages every page repeat duplicate',
  'export to word': 'convert pdf to word docx doc editable document text',
  'export to excel': 'convert pdf to excel xlsx xls spreadsheet boq bill of quantities table tables numbers',
  'hand': 'pan move drag scroll',
  'select': 'pointer arrow choose',
  'properties': 'document info title author',
  'settings panel': 'properties panel right panel f4',
  'settings': 'options preferences author name',
  'wheel zooms': 'mouse wheel scroll zoom',
  'keep tool': 'stay repeat sticky tool',
};

const norm = (s: string) => s.toLowerCase().replace(/…/g, '').replace(/[^a-z0-9&:%]+/g, ' ').trim();
const words = (s: string) => norm(s).split(' ').filter(Boolean);

/** edit distance, stopping early beyond `max` */
function near(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const prev = new Array(b.length + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return false;
    for (let j = 0; j <= b.length; j++) prev[j] = row[j];
  }
  return prev[b.length] <= max;
}

/** how well one typed word matches a list of words (0 = not at all) */
function wordScore(t: string, list: string[]): number {
  let best = 0;
  for (const w of list) {
    if (w === t) return 1;
    if (w.startsWith(t)) best = Math.max(best, 0.9);
    else if (t.length >= 3 && w.includes(t)) best = Math.max(best, 0.6);
    else if (t.length >= 4) {
      const max = t.length >= 7 ? 2 : 1;
      // a typo in the word, or in the start of a longer word
      if (near(t, w, max) || (w.length > t.length && near(t, w.slice(0, t.length), max))) best = Math.max(best, 0.55);
    }
  }
  return best;
}

export function searchCmds(cmds: FoundCmd[], query: string): FoundCmd[] {
  const q = words(query);
  if (!q.length) return [];
  const full = norm(query);
  const scored: { c: FoundCmd; s: number; i: number }[] = [];
  cmds.forEach((c, i) => {
    const label = words(c.label);
    const where = words(c.kind === 'ribbon' ? TAB_NAMES[c.tab] + ' ' + c.group : c.where);
    const also = words(ALSO[norm(c.label)] || '');
    const title = words(c.title);
    let s = 0;
    for (const t of q) {
      const m = Math.max(wordScore(t, label) * 10, wordScore(t, also) * 6, wordScore(t, where) * 4, wordScore(t, title) * 3);
      if (!m) return; // every word has to match something
      s += m;
    }
    const nl = norm(c.label);
    if (nl === full) s += 25;
    else if (nl.startsWith(full)) s += 12;
    if (c.disabled) s -= 2;
    scored.push({ c, s, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.c);
}

/** the same tool on several tabs is one result (its places listed together) */
function merge(list: RibbonCmd[]): (RibbonCmd & { kind: 'ribbon'; also?: string[] })[] {
  const out: (RibbonCmd & { kind: 'ribbon'; also?: string[] })[] = [];
  const byKey = new Map<string, RibbonCmd & { kind: 'ribbon'; also?: string[] }>();
  for (const c of list) {
    const key = c.tool ? 'tool:' + c.tool : '';
    const had = key ? byKey.get(key) : undefined;
    if (had) { (had.also ||= []).push(TAB_NAMES[c.tab] + ' › ' + c.group); continue; }
    const e = { ...c, kind: 'ribbon' as const };
    if (key) byKey.set(key, e);
    out.push(e);
  }
  return out;
}

const shortcutOf = (c: FoundCmd) => {
  const m = c.title.match(/\(((?:Ctrl|Shift|Alt|F\d+)[^)]*|[A-Z0-9])\)/);
  return m ? m[1] : '';
};
const whereOf = (c: FoundCmd) => (c.kind === 'ribbon' ? TAB_NAMES[c.tab] + (c.group ? ' › ' + c.group : '') : c.where);

const RECENT = 'gcc.toolsearch.recent';
const loadRecent = (): string[] => { try { const v = JSON.parse(localStorage.getItem(RECENT) || '[]'); return Array.isArray(v) ? v.slice(0, 6) : []; } catch { return []; } };
const keyOf = (c: FoundCmd) => (c.kind === 'ribbon' ? (c.tool ? 'tool:' + c.tool : c.tab + ':' + c.label) : 'x:' + c.label);

export function ToolSearch({ commands, extras, onRun, hasDoc = true }: { commands: { current: (() => RibbonCmd[]) | null }; extras: ExtraCmd[]; onRun(c: FoundCmd): void; hasDoc?: boolean }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // read the ribbon when the list opens (buttons change with the open file / tool)
  const [stamp, setStamp] = useState(0);
  const all: FoundCmd[] = useMemo(() => {
    void stamp;
    if (!open) return [];
    const r = commands.current ? merge(commands.current()) : [];
    return [...r, ...extras.map((e) => ({ ...e, kind: 'extra' as const }))];
  }, [stamp, extras, open]);
  const results = useMemo(() => {
    if (q.trim()) return searchCmds(all, q).slice(0, 9);
    return recent.map((k) => all.find((c) => keyOf(c) === k)).filter((c): c is FoundCmd => !!c);
  }, [q, all, recent]);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [open]);

  const run = (c: FoundCmd) => {
    const k = keyOf(c);
    const next = [k, ...recent.filter((x) => x !== k)].slice(0, 6);
    setRecent(next);
    try { localStorage.setItem(RECENT, JSON.stringify(next)); } catch { /* not kept */ }
    setOpen(false);
    setQ('');
    input.current?.blur();
    onRun(c);
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = results[at]; if (c) run(c); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setQ(''); input.current?.blur(); }
    e.stopPropagation();
  };

  return (
    <div className="tsearch" ref={box}>
      <span className="tsearch-in">
        <Ico n="search" size={14} />
        <input ref={input} value={q} placeholder="Find a tool…" spellCheck={false}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => { setStamp((n) => n + 1); setOpen(true); }}
          onKeyDown={keys} aria-label="Find a tool" />
        {!q && <span className="tsearch-k">Alt+Q</span>}
      </span>
      {open && (
        <div className="tsearch-pop" role="listbox">
          {!q.trim() && !results.length && (
            <div className="tsearch-hint">Type what you want to do – e.g. <i>page numbers</i>, <i>compress</i>, <i>measure area</i>, <i>password</i>, <i>redact</i>. Enter takes you to the tool.</div>
          )}
          {!q.trim() && results.length > 0 && <div className="tsearch-sub">Recently used</div>}
          {q.trim() && !results.length && <div className="tsearch-hint">Nothing called that. Try another word – e.g. <i>size</i> instead of <i>compress</i>.</div>}
          {results.map((c, i) => {
            const sc = shortcutOf(c);
            const also = c.kind === 'ribbon' ? (c as { also?: string[] }).also : undefined;
            return (
              <button key={keyOf(c) + i} className={'tsearch-row' + (i === at ? ' on' : '') + (c.disabled ? ' dis' : '')} onMouseEnter={() => setAt(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => run(c)} title={c.title}>
                <span className="ic"><Ico n={c.icon || 'search'} size={17} /></span>
                <span className="nm">{c.label.replace(/…$/, '')}{c.kind === 'ribbon' && c.check ? (c.on ? ' (on)' : ' (off)') : ''}</span>
                {/* (with a file open it is off for another reason: nothing selected, one page only, nothing to undo) */}
                <span className="wh">{whereOf(c)}{also?.length ? ' · ' + also.join(' · ') : ''}{c.disabled ? (hasDoc ? ' – not available now' : ' – open a file first') : ''}</span>
                {sc && <span className="kb">{sc}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
