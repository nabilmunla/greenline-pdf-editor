// The ribbon: tabs of grouped tools.
import { isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Ico } from './icons';
import { TOOLS, PALETTE, NO_STYLE, BIG_SHEET_TEXT, css, hex, fromHex, type ToolId, type Style } from './tools';
import { baseName, dirName } from './api';
import type { PdfDoc } from './doc';
import type { Settings } from './App';
import type { SelItem } from './Viewer';
import { FMT_DEFAULTS } from './geom';
import type { RGB, AnnotData, AnnotSpec } from '../engine/mu';
import { markupName } from './Side';

export type RibbonTab = 'file' | 'home' | 'comment' | 'measure' | 'edit' | 'organize' | 'protect' | 'ocr' | 'ai' | 'batch';

interface Props {
  tab: RibbonTab;
  setTab(t: RibbonTab): void;
  doc: PdfDoc | null;
  tool: ToolId;
  style: Style;
  A: Record<string, any>;
  setToolStyle(p: Partial<Style>): void;
  settings: Settings;
  saveSettings(p: Partial<Settings>): void;
  zoom: number;
  countGroup: string;
  setCountGroup(s: string): void;
  recent: string[];
  sel: SelItem[];
  /** the selected markups (their data): the Style group edits them while they are selected */
  selItems?: AnnotData[];
  editSel?(patch: Partial<AnnotSpec> | ((a: AnnotData) => Partial<AnnotSpec>)): void;
  /** filled with a function listing every button of every tab (the tool search reads it) */
  commands?: { current: (() => RibbonCmd[]) | null };
}

/** one button of the ribbon, wherever it is (for the tool search) */
export interface RibbonCmd {
  tab: RibbonTab;
  group: string;
  label: string;
  /** its tooltip */
  title: string;
  icon: string;
  /** a drawing / markup tool (else a command button or a check box) */
  tool?: ToolId;
  check?: boolean;
  on?: boolean;
  disabled: boolean;
}

export const TAB_NAMES: Record<RibbonTab, string> = { file: 'File', home: 'Home', comment: 'Comment', measure: 'Measure', edit: 'Edit', organize: 'Organize', protect: 'Protect', ocr: 'OCR', ai: 'AI', batch: 'Batch' };

/** the buttons in a tab's content (walks the elements, nothing is drawn) */
function collect(node: ReactNode, tab: RibbonTab, group: string, out: RibbonCmd[]) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) collect(n, tab, group, out); return; }
  if (!isValidElement(node)) return;
  const el = node as ReactElement<Record<string, any>>;
  const pr = el.props;
  if (el.type === Group) { collect(pr.children, tab, pr.label, out); return; }
  if (el.type === ChestButton) { out.push({ tab, group, label: 'Tool Chest', title: 'Tool Chest: your saved tools (style, colour, stamp)', icon: 'chest', disabled: !!pr.disabled }); return; }
  if (el.type === FlattenButton) { out.push({ tab, group, label: 'Flatten', title: 'Burn markups into the page – selected ones, by kind, or everything', icon: 'flatten', disabled: !!pr.disabled }); return; }
  if (el.type === 'button' && (pr['data-cmd'] || pr['data-tool'])) {
    const kids = Array.isArray(pr.children) ? pr.children : [pr.children];
    const ico = kids.find((k: unknown) => isValidElement(k) && (k as ReactElement<Record<string, any>>).type === Ico) as ReactElement<Record<string, any>> | undefined;
    out.push({ tab, group, label: pr['data-cmd'] || '', title: pr.title || '', icon: ico?.props.n || '', tool: pr['data-tool'], on: / on$/.test(pr.className || ''), disabled: !!pr.disabled });
    return;
  }
  if (el.type === 'label' && /rchk/.test(pr.className || '')) {
    const kids = Array.isArray(pr.children) ? pr.children : [pr.children];
    const input = kids.find((k: unknown) => isValidElement(k) && (k as ReactElement).type === 'input') as ReactElement<Record<string, any>> | undefined;
    const text = kids.filter((k: unknown) => typeof k === 'string').join('').trim();
    if (input && text) out.push({ tab, group, label: text, title: pr.title || text, icon: 'check', check: true, on: !!input.props.checked, disabled: !!input.props.disabled });
    return;
  }
  if (pr && pr.children) collect(pr.children, tab, group, out);
}

const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="rgroup"><div className="rbtns">{children}</div><div className="rlabel">{label}</div></div>
);

export function Ribbon(p: Props) {
  const { doc, A, tool } = p;
  const dis = !doc;
  // too narrow for everything (smaller screens, Windows scaling 125-175 %): the ribbon steps down -
  // tighter spacing, then big buttons as small rows of three, then icons only -
  // instead of hiding the right-hand groups off the edge
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // (the Style group's width depends on what is selected too: a line adds its ends)
  const styleKey = p.sel.length ? [...new Set((p.selItems || []).map((a) => a.type))].join() : '';
  // (a reset measures again from level 0 on the next draw: measured now, the old level's layout
  // would push the new one straight to the top level - the File pane came out icons only)
  const resetting = useRef(false);
  useLayoutEffect(() => { if (fit !== 0) { resetting.current = true; setFit(0); } }, [width, p.tab, tool, !!doc, p.settings.propsPanel, styleKey]);
  useLayoutEffect(() => {
    if (resetting.current) { resetting.current = false; return; }
    const el = ref.current;
    if (!el || fit >= 4 || el.scrollWidth <= el.clientWidth + 1) return;
    // (the tool's style is only left out when the right-hand panel shows it)
    setFit(fit === 2 && p.settings.propsPanel === false ? 4 : fit + 1);
  });
  const T = (id: ToolId, ic: string, label?: string, big = true) => (
    <button key={id} data-tool={id} data-cmd={label ?? TOOLS[id].label} className={(big ? 'rb big' : 'rb') + (tool === id ? ' on' : '')} disabled={dis} title={TOOLS[id].label + (TOOLS[id].key ? ` (${TOOLS[id].key!.toUpperCase()})` : '') + ' – ' + TOOLS[id].hint} onClick={() => A.setTool(tool === id && id !== 'select' ? 'select' : id)}>
      <Ico n={ic} size={big ? 22 : 17} /><span>{label ?? TOOLS[id].label}</span>
    </button>
  );
  // the tooltip always names the button (on small screens the ribbon shows icons only)
  const tip = (label: string, title?: string) => {
    const name = label.replace(/…$/, '');
    if (!title) return name;
    if (/^(Ctrl|Shift|Alt|F\d)/.test(title)) return `${name} (${title})`;
    return title.toLowerCase().startsWith(name.toLowerCase()) ? title : `${name} – ${title}`;
  };
  const B = (ic: string, label: string, run: () => unknown, opts: { big?: boolean; title?: string; disabled?: boolean; on?: boolean } = {}) => (
    <button key={label} data-cmd={label} className={(opts.big !== false ? 'rb big' : 'rb') + (opts.on ? ' on' : '')} disabled={opts.disabled ?? dis} title={tip(label, opts.title)} onClick={() => void run()}>
      <Ico n={ic} size={opts.big !== false ? 22 : 17} /><span>{label}</span>
    </button>
  );
  const small = (ic: string, label: string, run: () => unknown, opts: { title?: string; disabled?: boolean; on?: boolean } = {}) => B(ic, label, run, { ...opts, big: false });

  const bodyOf = (tab: RibbonTab): ReactNode => {
  let body: ReactNode = null;
  switch (tab) {
    case 'file':
      body = (
        <div className="filepane">
          <div className="fcol">
            {B('open', 'Open…', A.open, { disabled: false, title: 'Open PDF (Ctrl+O)' })}
            {B('image', 'New from pictures…', () => A.fromPictures(), { disabled: false, title: 'Photos, scans (JPG, PNG, TIFF…) made into one PDF' })}
            {B('save', 'Save', A.save, { title: 'Save (Ctrl+S)' })}
            {B('save', 'Save as…', A.saveAs, { title: 'Save as (Ctrl+Shift+S)' })}
            {B('word', 'Export to Word…', A.exportWord, { title: 'An editable Word document: paragraphs, tables, pictures (scanned pages are read with OCR)' })}
            {B('excel', 'Export to Excel…', A.exportExcel, { title: 'The tables as real cells, numbers as numbers – bills of quantities joined across pages (scans read with OCR)' })}
            {B('table', 'Table area to Excel…', A.tableArea, { title: 'A table on a drawing: drag a box around it and only that area goes to Excel' })}
            {B('snapshot', 'Save as pictures…', A.toPictures, { title: 'Pages as PNG or JPG files' })}
            {B('print', 'Print…', A.print, { title: 'Print (Ctrl+P)' })}
            {B('props', 'Properties', A.props)}
            {B('close', 'Close', A.close, { title: 'Close this tab (Ctrl+W)' })}
            {B('gear', 'Settings', A.settings, { disabled: false })}
            {B('report', 'Report a problem', A.report, { disabled: false, title: 'Tell us what went wrong: saved to the reports folder for fixing' })}
            {B('info', "What's new", A.whatsNew, { disabled: false, title: 'What changed in this version, in short' })}
          </div>
          <div className="frecent">
            <div className="rlabel left">Recent files</div>
            {p.recent.length === 0 && <div className="faint">Nothing yet.</div>}
            {p.recent.slice(0, 8).map((f) => (
              <button key={f} className="rec-file sm" onClick={() => { A.openPaths([f]); p.setTab('home'); }} title={f}>
                <Ico n="file" size={16} /><span className="nm">{baseName(f)}</span><span className="pt">{dirName(f)}</span>
              </button>
            ))}
          </div>
        </div>
      );
      break;
    case 'home':
      body = (
        <>
          <Group label="File">{B('open', 'Open', A.open, { disabled: false })}{B('save', 'Save', A.save)}{B('print', 'Print', A.print)}</Group>
          <Group label="Tools">{T('select', 'select', 'Select')}{T('hand', 'hand', 'Hand')}{T('snapshot', 'snapshot', 'Snapshot')}{T('zoom', 'zoomarea', 'Zoom area')}</Group>
          <Group label="View">
            <div className="rstack">
              {small('zoomin', 'Zoom in', A.zoomIn, { title: 'Ctrl +' })}
              {small('zoomout', 'Zoom out', A.zoomOut, { title: 'Ctrl −' })}
            </div>
            <div className="rstack">
              {small('props', 'Settings panel', A.togglePanel, { title: 'Show or hide the panel on the right with the settings of the selected markup or tool (F4)', on: p.settings.propsPanel !== false })}
            </div>
            <div className="rstack">
              {small('fitw', 'Fit width', () => A.fit('width'), { title: 'Ctrl+2' })}
              {small('fitp', 'Fit page', () => A.fit('page'), { title: 'Ctrl+0' })}
            </div>
            <div className="rstack">
              {small('zoomarea', 'Actual size', () => A.setZoom(96 / 72), { title: 'Ctrl+1' })}
              <label className="rchk"><input type="checkbox" checked={!!p.settings.wheelZoom} onChange={(e) => p.saveSettings({ wheelZoom: e.target.checked })} /> Wheel zooms</label>
            </div>
          </Group>
          <Group label="Markup">{T('highlight', 'highlight')}{T('textbox', 'textbox')}{T('note', 'note', 'Comment')}{B('stamp', 'Stamp', A.stamps)}</Group>
          <Group label="Pages">{B('rotr', 'Rotate', () => A.rotate(90), { title: 'Rotate the selected pages (or this page) right' })}{B('insert', 'Insert', A.insertFile)}{B('delete', 'Delete', A.deletePages)}</Group>
          <Group label="Find">{B('search', 'Search', A.find, { title: 'Ctrl+F' })}</Group>
          <Group label="AI">{B('ai', 'Ask AI', () => A.ai('ask'), { title: 'Ask Claude or ChatGPT about this file – answers point to the pages' })}</Group>
        </>
      );
      break;
    case 'comment':
      body = (
        <>
          <Group label="Text markup">
            {T('highlight', 'highlight')}
            <div className="rstack">{T('underline', 'underline', undefined, false)}{T('strike', 'strike', undefined, false)}{T('squiggly', 'squiggly', undefined, false)}</div>
            {T('area-highlight', 'areahl', 'Area highlight')}
          </Group>
          <Group label="Text & comments">{T('note', 'note', 'Comment')}{T('textbox', 'textbox')}{T('callout', 'callout')}{T('typewriter', 'typewriter')}</Group>
          <Group label="Drawing">
            <div className="rgrid">
              {T('rect', 'rect', undefined, false)}{T('ellipse', 'ellipse', undefined, false)}{T('line', 'line', undefined, false)}
              {T('arrow', 'arrow', undefined, false)}{T('polyline', 'polyline', undefined, false)}{T('polygon', 'polygon', undefined, false)}
            </div>
            {T('cloud', 'cloud')}{T('pencil', 'pencil')}
          </Group>
          {/* (a stamp from a page: Stamp > From a page, and Find a tool - a fourth button here pushed
              the Style group off the ribbon at 1600 px) */}
          <Group label="Stamp & sign">{B('stamp', 'Stamp', A.stamps)}{B('signature', 'Signature', A.signature)}{B('image', 'Image', A.image)}</Group>
          <StyleFor p={p} />
          <Group label="Manage">
            <ChestButton settings={p.settings} A={A} disabled={dis} />
            <FlattenButton A={A} disabled={dis} hasSel={p.sel.length > 0} />
            <div className="rstack">
              <label className="rchk" title="Stay in the tool after placing a markup"><input type="checkbox" checked={!!p.settings.keepTool} onChange={(e) => p.saveSettings({ keepTool: e.target.checked })} /> Keep tool</label>
              {small('copy', 'Copy to pages', A.copyToPages, { disabled: dis || !p.sel.length || (doc?.pages.length ?? 0) < 2, title: 'Copy the selected stamp or markups onto other pages - all of them or some (same spot from the nearest corner)' })}
            </div>
          </Group>
        </>
      );
      break;
    case 'measure':
      body = (
        <>
          <Group label="Scale">{T('m-calibrate', 'calibrate', 'Calibrate')}{B('length', 'Scale', A.scale, { title: 'Set the drawing scale (1:50, 1:100…) for this page or all pages' })}{T('m-viewport', 'viewport', 'Viewport')}</Group>
          <Group label="Measure">{T('m-length', 'length', 'Length')}{T('m-polylength', 'polylength', 'Polylength')}{T('m-area', 'area', 'Area')}{T('m-angle', 'angle', 'Angle')}</Group>
          <Group label="Count">
            {T('m-count', 'count', 'Count')}{B('search', 'By tag…', A.countByTag, { title: 'Count by tag: the tags written on the drawing (door marks D01, D02…) found in its text and counted in one go' })}
            <div className="rstack">
              <span className="rlab">Counting</span>
              <input className="input sm" value={p.countGroup} onChange={(e) => p.setCountGroup(e.target.value)} title="Name of what you are counting (e.g. Doors D1). Each name is counted separately." />
            </div>
          </Group>
          <Group label="Labels">
            <div className="rstack">
              <span className="rlab">Number size</span>
              <select className="input xs" value={String(Number(p.doc?.data.labelK) || 1)} disabled={!p.doc} onChange={(e) => A.labelScale(Number(e.target.value))} title="Size of the measurement numbers and their arrows in this whole file - also the ones already there. 100%: sized for the zoom you measure at.">
                {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((k) => <option key={k} value={String(k)}>{k * 100}%</option>)}
              </select>
            </div>
            <div className="rstack">
              <span className="rlab">Decimals (m)</span>
              <select className="input xs" value={String(p.style.fmt?.dm ?? FMT_DEFAULTS.dm)} onChange={(e) => p.setToolStyle({ fmt: { ...(p.style.fmt || {}), dm: Number(e.target.value) } })} title="Decimals in metres for new measurements (millimetres, m², unit: side panel). Measurements already made: select them, then change it in the side panel.">
                {[0, 1, 2, 3, 4].map((k) => <option key={k} value={String(k)}>{k}</option>)}
              </select>
            </div>
          </Group>
          <Group label="Snap">{B('magnet', (p.settings.snap ?? true) ? 'Snap on' : 'Snap off', A.toggleSnap, { on: p.settings.snap ?? true, disabled: false, title: 'Snap to line ends, middles, lines, markup corners and square to the line you come from (⊥) (F9). Hold Ctrl while clicking to skip it once.' })}{B('ortho', p.settings.ortho ? 'Ortho on' : 'Ortho off', A.toggleOrtho, { on: !!p.settings.ortho, disabled: false, title: 'Ortho (F8): lines and corners go straight - 0, 45 or 90° - without holding Shift' })}{B('crosshair', 'Crosshair', A.toggleCross, { on: !!p.settings.cross, disabled: false, title: 'Crosshair (F6): lines across the view through the pointer - to line points up' })}{B('loupe', 'Magnifier', A.toggleLoupe, { on: !!p.settings.loupe, disabled: false, title: 'Magnifier (F7): a loupe beside the pointer shows the exact point a click puts down, magnified' })}{p.settings.loupe ? <label className="rsmall" title="How much the magnifier enlarges">×<select value={p.settings.loupeZoom ?? 3} onChange={(e) => A.loupeZoom(Number(e.target.value))}>{[2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}</select></label> : null}</Group>
          <StyleFor p={p} />
          <Group label="Results">{B('count', 'Totals', A.totals, { title: 'Counts and measurement totals of this file, in a panel on the left (by name, kind and page)' })}{B('excel', 'To Excel', A.exportMeasurements, { title: 'Save every measurement and count of this file to Excel' })}</Group>
        </>
      );
      break;
    case 'edit':
      body = (
        <>
          <Group label="Text">{T('edit-text', 'edittext', 'Edit text')}{T('typewriter', 'typewriter', 'Add text')}{B('image', 'Add image', A.image)}</Group>
          <Group label="Links">{T('link', 'link', 'Link')}</Group>
          <Group label="Redact">{T('redact-area', 'redact', 'Mark area')}{T('redact-text', 'redacttext', 'Mark text')}{B('search', 'Find & mark', A.redactSearch, { title: 'Find words (names, amounts…) and mark them all for redaction' })}{B('apply', 'Apply', A.applyRedactions, { title: 'Remove everything under the redaction marks for good' })}</Group>
          <Group label="Page marks">{B('number', 'Numbers & headers', () => A.marks(false), { title: 'Page numbers, headers/footers, Bates numbers, watermark or stamp on every page' })}</Group>
          <Group label="Flatten"><FlattenButton A={A} disabled={dis} hasSel={p.sel.length > 0} /></Group>
        </>
      );
      break;
    case 'organize':
      body = (
        <>
          <Group label="Insert">{B('insert', 'From file', A.insertFile, { title: 'Pages of another open file, or of a file on disk' })}{B('replace', 'Replace', A.replacePages, { title: 'Swap pages of this file for pages of another (revised sheets): bookmarks and links keep pointing at them' })}{B('blank', 'Blank page', A.insertBlank)}{B('duplicate', 'Duplicate', A.duplicate)}</Group>
          <Group label="Pages">{B('rotl', 'Rotate left', () => A.rotate(270))}{B('rotr', 'Rotate right', () => A.rotate(90))}{B('delete', 'Delete', A.deletePages)}{B('crop', 'Crop', A.crop)}</Group>
          <Group label="Out">{B('extract', 'Extract', A.extract, { title: 'Save the selected pages (or this page) as a new PDF' })}{B('split', 'Split', A.split)}{B('snapshot', 'Pictures', A.toPictures, { title: 'Save pages as PNG or JPG pictures' })}</Group>
          <Group label="Combine">{B('merge', 'Merge files', A.merge, { disabled: false })}</Group>
          <div className="rnote">Select pages in the Pages panel (Ctrl/Shift+click) to work on several at once; drag them to reorder.</div>
        </>
      );
      break;
    case 'protect':
      body = (
        <>
          <Group label="Password">{B('lock', 'Protect', A.protect, { title: 'Open password and permissions' })}{B('unlock', 'Remove', A.removePassword)}</Group>
          <Group label="Redact">{T('redact-area', 'redact', 'Mark area')}{T('redact-text', 'redacttext', 'Mark text')}{B('apply', 'Apply', A.applyRedactions)}</Group>
          <Group label="Clean">{B('sanitize', 'Remove hidden info', A.sanitize, { title: 'Save a copy without author/title data, scripts and unused content' })}{B('props', 'Properties', A.props)}</Group>
        </>
      );
      break;
    case 'ocr':
      body = (
        <>
          <Group label="Recognise">{B('ocr', 'Make searchable', A.ocr, { title: 'Read scanned pages (English + Arabic) and add invisible, searchable text' })}{T('ocr-area', 'readarea', 'Read area')}</Group>
          <Group label="Tables">{T('table', 'table', 'Table to Excel')}</Group>
          <Group label="Language">
            <div className="rstack">
              <select className="input sm" value={p.settings.ocrLang || 'eng+ara'} onChange={(e) => p.saveSettings({ ocrLang: e.target.value as Settings['ocrLang'] })}>
                <option value="eng+ara">English + Arabic</option>
                <option value="eng">English</option>
                <option value="ara">Arabic</option>
              </select>
              <span className="faint">Offline – nothing leaves the PC</span>
            </div>
          </Group>
        </>
      );
      break;
    case 'ai':
      body = (
        <>
          <Group label="Ask">{B('ai', 'Ask about this file', () => A.ai('ask'), { title: 'Questions about the open PDF; answers cite the pages (Claude or ChatGPT)' })}</Group>
          <Group label="Translate">{B('translate', 'Translate', () => A.ai('translate'), { title: 'Translate this page, selected pages or the whole file (English, Arabic and more)' })}</Group>
          <Group label="Set up">{B('key', 'AI keys', () => A.ai('setup'), { disabled: false, title: 'API keys for Claude / ChatGPT (stored encrypted on this PC)' })}</Group>
        </>
      );
      break;
    case 'batch':
      body = (
        <>
          <Group label="Files">{B('compress', 'Reduce size', A.compress, { disabled: false })}{B('merge', 'Merge', A.merge, { disabled: false })}{B('split', 'Split', A.split)}</Group>
          <Group label="Marks">{B('stamp', 'Stamp & number', () => A.marks(true), { disabled: false, title: 'Page numbers, Bates, headers, watermark or a stamp on many files at once' })}</Group>
          <Group label="Text">{B('ocr', 'Make searchable', A.batchOcr, { disabled: false })}</Group>
          <Group label="Markups">{B('flatten', 'Flatten files', A.batchFlatten, { disabled: false })}</Group>
        </>
      );
      break;
  }
  return body;
  };
  const body = bodyOf(p.tab);
  if (p.commands) p.commands.current = () => {
    const out: RibbonCmd[] = [];
    for (const t of Object.keys(TAB_NAMES) as RibbonTab[]) collect(bodyOf(t), t, t === 'file' ? 'File' : '', out);
    return out;
  };
  // (level 3 leaves the Style group out - not while the right-hand panel is closed: then it is
  // the only place to change the selected markups)
  return <div ref={ref} className={'ribbon' + (p.tab === 'file' ? ' file' : '') + [1, 2, 3, 4].filter((n) => n <= fit && !(n === 3 && p.settings.propsPanel === false)).map((n) => ' fit' + n).join('')}>{body}</div>;
}

function Swatch({ c, on, onPick, none }: { c: RGB | null; on: boolean; onPick(): void; none?: boolean }) {
  return <button className={'sw' + (on ? ' on' : '') + (none ? ' none' : '')} style={{ background: none ? undefined : css(c) }} onClick={onPick} title={none ? 'None' : hex(c)} />;
}

/**
 * A pop-up under its button, laid over everything (fixed to the window). Inside the ribbon - 98 px
 * high, its overflow hidden - a pop-up placed in the flow was cut off at the ribbon's edge:
 * Flatten "Everything", most of the Tool Chest and the custom colour could not be reached.
 * It closes when the mouse leaves it, and when anything under it scrolls or the window changes
 * size (it would no longer be by its button).
 */
function Pop({ anchor, className, close, children }: { anchor: React.RefObject<HTMLElement | null>; className: string; close(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect(), el = ref.current;
    if (!a || !el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    // below the button; above it when there is no room below
    let top = a.bottom + 3;
    if (top + h > window.innerHeight - 6 && a.top - 3 - h >= 6) top = a.top - 3 - h;
    setPos({ left: Math.max(6, Math.min(a.left, window.innerWidth - w - 6)), top: Math.max(6, Math.min(top, window.innerHeight - h - 6)) });
  }, []);
  const now = useRef(close);
  now.current = close;
  useEffect(() => {
    const off = (e: Event) => { if (!(e.target instanceof Node && ref.current?.contains(e.target))) now.current(); };
    // (a click anywhere else closes it too - not on its own button, which opens and closes it)
    const away = (e: PointerEvent) => { if (e.target instanceof Node && !ref.current?.contains(e.target) && !anchor.current?.contains(e.target)) now.current(); };
    const shut = () => now.current();
    window.addEventListener('scroll', off, true);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('resize', shut);
    return () => { window.removeEventListener('scroll', off, true); window.removeEventListener('pointerdown', away, true); window.removeEventListener('resize', shut); };
  }, []);
  return (
    <div ref={ref} className={className + ' float'} style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      // (not while Windows' colour picker from "More…" is open: the mouse going into it left the
      // pop-up, which closed and took the picker's colour with it)
      onMouseLeave={() => { const a = document.activeElement; if (a instanceof HTMLInputElement && a.type === 'color' && ref.current?.contains(a)) return; close(); }}>
      {children}
    </div>
  );
}

export function ColorPick({ value, onChange, allowNone, title }: { value: RGB | null; onChange(c: RGB | null): void; allowNone?: boolean; title: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <span className="cpick">
      <button ref={btn} className="cbtn" title={title} onClick={() => setOpen(!open)}>
        <span className={'cchip' + (value ? '' : ' none')} style={{ background: value ? css(value) : undefined }} />
        <Ico n="chev" size={12} />
      </button>
      {open && (
        <Pop anchor={btn} className="cpop" close={() => setOpen(false)}>
          <div className="cgrid">
            {allowNone && <Swatch c={null} none on={!value} onPick={() => { onChange(null); setOpen(false); }} />}
            {PALETTE.map((c, i) => <Swatch key={i} c={c} on={!!value && hex(value) === hex(c)} onPick={() => { onChange(c); setOpen(false); }} />)}
          </div>
          <label className="cmore">More… <input type="color" value={hex(value) || '#000000'} onChange={(e) => onChange(fromHex(e.target.value))} /></label>
        </Pop>
      )}
    </span>
  );
}

/** what the Style group offers */
type StyleKind = { textish: boolean; fillable: boolean; lineish: boolean; cloud: boolean; markup: boolean; picture?: boolean };
const kindOfTool = (tool: ToolId): StyleKind => ({
  textish: tool === 'textbox' || tool === 'callout' || tool === 'typewriter',
  // (not a text box or callout: their box has one colour, no fill - a Fill here did nothing)
  fillable: ['rect', 'ellipse', 'polygon', 'cloud', 'm-area', 'm-rectarea', 'm-count'].includes(tool),
  lineish: ['line', 'arrow', 'polyline', 'm-length'].includes(tool),
  cloud: ['rect', 'ellipse', 'polygon', 'cloud', 'm-area', 'm-rectarea', 'm-count'].includes(tool),
  markup: false,
});
const kindOfMarkup = (t: string): StyleKind => ({
  textish: t === 'FreeText',
  fillable: ['Square', 'Circle', 'Polygon'].includes(t), // (a text box has its box colour, no fill)
  lineish: t === 'Line' || t === 'PolyLine',
  cloud: ['Square', 'Circle', 'Polygon'].includes(t),
  markup: ['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Text'].includes(t),
  // (a stamp, signature or picture keeps its own colours: only how see-through it is)
  picture: t === 'Stamp',
});

/**
 * The Style group: the tool's style for what you draw next - or, while markups are selected, the
 * selected ones themselves (as the side panel; a closed side panel left no way to change them)
 */
function StyleFor({ p }: { p: Props }) {
  // (the selection as it is now: its data can be a moment behind)
  const items = (p.selItems || []).filter((a) => p.sel.some((x) => x.page === a.page && x.id === a.id) && a.type !== 'Redact' && a.type !== 'Widget');
  if (items.length && p.editSel) {
    const a = items[0];
    const style: Style = {
      ...p.style, color: (a.color ?? null) as RGB | null, fill: (a.ic ?? null) as RGB | null, width: a.bw ?? 0, opacity: a.opacity ?? 1, dash: !!a.dash,
      cloudy: a.cloudy || 0, fontSize: a.font?.size ?? 11, fontColor: (a.font?.color ?? [0, 0, 0]) as RGB, le: (a.le as [string, string] | undefined) ?? ['None', 'None'],
    };
    const edit = p.editSel;
    const set = (s: Partial<Style>) => {
      const out: Partial<AnnotSpec> = {};
      if ('color' in s) out.color = s.color;
      if ('fill' in s) out.ic = s.fill;
      if ('width' in s) out.bw = s.width;
      if ('opacity' in s) out.opacity = s.opacity;
      if ('dash' in s) out.dash = s.dash;
      if ('cloudy' in s) out.cloudy = s.cloudy;
      if ('le' in s) out.le = s.le;
      if ('fontSize' in s || 'fontColor' in s) {
        // each text keeps its own font, size or colour - only what was changed is the same for all
        edit((x) => ({ ...out, font: { size: s.fontSize ?? x.font?.size ?? 11, color: s.fontColor ?? x.font?.color ?? [0, 0, 0], family: x.font?.family, bold: !!x.font?.bold, italic: !!x.font?.italic } }));
        return;
      }
      edit(out);
    };
    const label = items.length === 1 ? markupName(a) : `${items.length} markups`;
    return <StyleGroup style={style} kind={kindOfMarkup(a.type)} label={'Selected – ' + label} set={set} disabled={items.every((x) => x.locked)} title="Changes the selected markups" />;
  }
  if (NO_STYLE.includes(p.tool)) return <StyleGroup style={p.style} kind={kindOfTool(p.tool)} label="Style" set={() => {}} disabled title="Select a markup to change its style here (or pick a drawing tool)" />;
  return <StyleGroup style={p.style} kind={kindOfTool(p.tool)} label={'Style – ' + TOOLS[p.tool].label} set={p.setToolStyle} title="For what you draw next" />;
}

function StyleGroup({ style, kind, label, set, disabled, title }: { style: Style; kind: StyleKind; label: string; set(p: Partial<Style>): void; disabled?: boolean; title?: string }) {
  const { textish, fillable, lineish } = kind;
  // (the lists always hold the value it has now - a measured length's 0.36 pt, an area's 55 %)
  const widths = [...new Set([0, 0.5, 1, 1.5, 2, 3, 4, 6, 8, style.width])].sort((x, y) => x - y);
  const opacities = [...new Set([1, 0.8, 0.6, 0.5, 0.4, 0.25, style.opacity])].sort((x, y) => y - x);
  const sizes = [...new Set([6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72, style.fontSize])].sort((x, y) => x - y);
  return (
    <fieldset className="rgroup stylegrp" disabled={disabled} title={title}>
      <div className="rbtns style">
        <div className="rstack">
          {!kind.picture && <span className="srow"><span className="rlab">{textish ? 'Box' : 'Colour'}</span><ColorPick value={style.color} onChange={(c) => set({ color: c })} allowNone={textish} title="Line / markup colour" /></span>}
          {fillable && <span className="srow"><span className="rlab">Fill</span><ColorPick value={style.fill} onChange={(c) => set({ fill: c })} allowNone title="Fill colour" /></span>}
          {textish && <span className="srow"><span className="rlab">Text</span><ColorPick value={style.fontColor} onChange={(c) => set({ fontColor: c || [0, 0, 0] })} title="Text colour" /></span>}
        </div>
        <div className="rstack">
          {!kind.markup && !kind.picture && <span className="srow"><span className="rlab">Width</span>
            <select className="input xs" value={style.width} onChange={(e) => set({ width: Number(e.target.value) })}>{widths.map((w) => <option key={w} value={w}>{+w.toFixed(2)} pt</option>)}</select>
          </span>}
          <span className="srow"><span className="rlab">Opacity</span>
            <select className="input xs" value={style.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })}>{opacities.map((w) => <option key={w} value={w}>{Math.round(w * 100)}%</option>)}</select>
          </span>
          {textish && <span className="srow"><span className="rlab">Size</span>
            <select className="input xs" value={style.fontSize} title={BIG_SHEET_TEXT} onChange={(e) => set({ fontSize: Number(e.target.value) })}>{sizes.map((w) => <option key={w} value={w}>{+w.toFixed(2)} pt</option>)}</select>
          </span>}
        </div>

        <div className="rstack">
          {!kind.markup && !kind.picture && <label className="rchk"><input type="checkbox" checked={style.dash} onChange={(e) => set({ dash: e.target.checked })} /> Dashed</label>}
          {kind.cloud && !textish && <label className="rchk"><input type="checkbox" checked={style.cloudy > 0} onChange={(e) => set({ cloudy: e.target.checked ? 1 : 0 })} /> Cloud edge</label>}
          {lineish && <span className="srow"><span className="rlab">Ends</span>
            <select className="input xs" value={style.le.join('|')} onChange={(e) => set({ le: e.target.value.split('|') as [string, string] })}>
              <option value="None|None">— none</option><option value="None|ClosedArrow">→ arrow</option><option value="None|OpenArrow">⇾ open arrow</option>
              <option value="ClosedArrow|ClosedArrow">↔ both</option><option value="OpenArrow|OpenArrow">⇿ open both</option><option value="Circle|ClosedArrow">●→</option><option value="Slash|Slash">/ ticks /</option><option value="Butt|Butt">| dimension |</option>
            </select>
          </span>}
        </div>
      </div>
      <div className="rlabel">{label}</div>
    </fieldset>
  );
}

function ChestButton({ settings, A, disabled }: { settings: Settings; A: Record<string, any>; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const items = settings.chest || [];
  return (
    <span className="cpick">
      <button ref={btn} className="rb big" data-cmd="Tool Chest" disabled={disabled} onClick={() => setOpen(!open)} title="Tool Chest: your saved tools (style, colour, stamp)"><Ico n="chest" size={22} /><span>Tool Chest</span></button>
      {open && (
        <Pop anchor={btn} className="cpop menu" close={() => setOpen(false)}>
          {items.length === 0 && <div className="faint pad">Empty. Style a tool, then “Add current tool”.</div>}
          {items.map((c) => (
            <div key={c.id} className="chest-row">
              <button className="grow" onClick={() => { A.chestUse(c); setOpen(false); }}>
                <span className="cchip" style={{ background: css(c.style.color || null) }} /> {c.name}
              </button>
              <button className="x" title="Remove" onClick={() => A.chestRemove(c.id)}>×</button>
            </div>
          ))}
          <div className="sep" />
          <button onClick={() => { A.chestAdd(); setOpen(false); }}>+ Add current tool</button>
        </Pop>
      )}
    </span>
  );
}

function FlattenButton({ A, disabled, hasSel }: { A: Record<string, any>; disabled: boolean; hasSel: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const it = (label: string, k: string, dis = false) => <button disabled={dis} onClick={() => { setOpen(false); void A.flatten(k); }}>{label}</button>;
  return (
    <span className="cpick">
      <button ref={btn} className="rb big" data-cmd="Flatten" disabled={disabled} onClick={() => setOpen(!open)} title="Burn markups into the page"><Ico n="flatten" size={22} /><span>Flatten</span></button>
      {open && (
        <Pop anchor={btn} className="cpop menu" close={() => setOpen(false)}>
          {it('Selected markups', 'selected', !hasSel)}
          {it('All comments & drawings', 'comments')}
          {it('All stamps & signatures', 'stamps')}
          {it('All measurements', 'measure')}
          {it('Form fields', 'forms')}
          <div className="sep" />
          {it('Everything', 'all')}
        </Pop>
      )}
    </span>
  );
}
