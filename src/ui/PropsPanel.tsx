// Right panel: properties of the selected markups (or of the tool about to be used).
import { isAutoLabel } from './relabel';
import { FontSelect, BoldItalic } from './fontlist';
import { useEffect, useRef, useState } from 'react';
import type { PdfDoc } from './doc';
import type { SelItem } from './Viewer';
import type { AnnotData, AnnotSpec, RGB } from '../engine/mu';
import { ColorPick } from './Ribbon';
import { TOOLS, NO_STYLE, HOW_HINT, BIG_SHEET_TEXT, type ToolId, type Style, type MeasureHow } from './tools';
import { markupName } from './Side';
import { Ico } from './icons';
import { measureValue, FMT_DEFAULTS, LEGACY_FMT, type MeasureFmt } from './geom';

/** keys typed in a box stay there (Delete must not delete the markup) - except the app's
 *  Ctrl shortcuts (save, close, open, print, next tab), which leave the box first so what
 *  was typed is kept */
function ownKeys(e: React.KeyboardEvent) {
  const k = e.key.toLowerCase();
  if (e.ctrlKey && ['s', 'w', 'o', 'p', 'tab', 'f4'].includes(k)) { (e.target as HTMLElement).blur(); return; }
  e.stopPropagation();
}

/** changes sent from this panel that the engine has not answered yet, per file. The file is
 *  marked changed only when the answer comes, and Ctrl+W leaves the comment box (sending what
 *  was typed) and closes the tab in the same key press - so closing and saving wait for these
 *  first, or the "Save changes?" question is skipped and the comment lost. */
const inFlight = new WeakMap<PdfDoc, Set<Promise<unknown>>>();
function track<T>(doc: PdfDoc, job: Promise<T>): Promise<T> {
  let set = inFlight.get(doc);
  if (!set) inFlight.set(doc, (set = new Set()));
  const s = set;
  s.add(job);
  void job.catch(() => {}).finally(() => s.delete(job));
  return job;
}
/** everything sent from the panel for this file has been answered (failed ones too) */
export async function panelEditsDone(doc: PdfDoc): Promise<void> {
  const s = inFlight.get(doc);
  if (s?.size) await Promise.allSettled([...s]);
}

interface Props {
  /** how Area / Perimeter draw (its hint) */
  how?: MeasureHow;
  doc: PdfDoc;
  rev: number;
  sel: SelItem[];
  setSel(s: SelItem[]): void;
  tool: ToolId;
  style: Style;
  setToolStyle(p: Partial<Style>): void;
  A: Record<string, any>;
  focusComment: number;
  onClose(): void;
  toast(t: string, k?: 'ok' | 'err' | 'info'): number;
  author: string;
}

const ROTATABLE = new Set(['FreeText', 'Stamp', 'Square', 'Circle']);

export function PropsPanel(p: Props) {
  const { doc } = p;
  const [items, setItems] = useState<AnnotData[]>([]);
  const [replies, setReplies] = useState<AnnotData[]>([]);
  useEffect(() => {
    let live = true;
    // only the pages of the selection (not every page of a 1,500-page file after each change)
    const pages = [...new Set(p.sel.map((x) => x.page))];
    void Promise.all(pages.map((pg) => doc.annots(pg))).then((lists) => {
      const all = lists.flat();
      if (!live) return;
      const it = all.filter((a) => p.sel.some((s) => s.page === a.page && s.id === a.id));
      setItems(it);
      // (replies to replies too - other programs thread them)
      const thread: AnnotData[] = [];
      if (it.length === 1) {
        const seen = new Set([it[0].id]);
        const walk = (id: number) => { for (const r of all) if (r.irt === id && !seen.has(r.id)) { seen.add(r.id); thread.push(r); walk(r.id); } };
        walk(it[0].id);
      }
      setReplies(thread.sort((a, b) => (a.created || 0) - (b.created || 0)));
    });
    return () => { live = false; };
  }, [p.sel, p.rev]);

  /** a change for the selected markups (a function: each its own, e.g. text keeps its font) */
  const upd = async (patch: Partial<AnnotSpec> | ((a: AnnotData) => Partial<AnnotSpec>), name = 'Change markup') => {
    const list = items.filter((a) => !a.locked || (typeof patch !== 'function' && 'locked' in patch));
    if (!list.length) { p.toast('Locked – unlock it first.', 'info'); return; }
    try { await track(doc, doc.update(list.map((a) => ({ page: a.page, id: a.id, patch: typeof patch === 'function' ? patch(a) : patch })), name)); } catch (e) { p.toast(String((e as Error).message || e), 'err'); }
  };

  if (!p.sel.length) {
    // the tool's own style
    const t = TOOLS[p.tool];
    return (
      <div className="props">
        <div className="side-head"><span>{p.tool === 'select' || p.tool === 'hand' ? 'Properties' : t.label}</span><button className="x" title="Hide this panel (Home > Settings panel brings it back)" onClick={p.onClose}><Ico n="close" size={14} /></button></div>
        <div className="props-body">
          {p.tool === 'select' || p.tool === 'hand'
            ? <div className="empty-props"><Ico n="select" size={22} /><p>Select a markup to change its colour, line, text or comment here.</p><p className="faint">Pick a tool on the ribbon to draw – its settings show here first.</p></div>
            : <p className="hint">{(p.tool === 'm-area' || p.tool === 'm-perimeter') && p.how ? HOW_HINT[p.how] : t.hint}</p>}
          {(p.tool === 'redact-area' || p.tool === 'redact-text') && <RedactFill value={p.style.redact ?? [0, 0, 0]} onChange={(v) => p.setToolStyle({ redact: v })} />}
          {!NO_STYLE.includes(p.tool) && (
            <>
              <StyleEditor
                type={p.tool === 'textbox' || p.tool === 'callout' || p.tool === 'typewriter' ? 'FreeText' : ['line', 'arrow', 'm-length'].includes(p.tool) ? 'Line' : ['rect', 'ellipse', 'polygon', 'cloud', 'm-area', 'm-rectarea', 'm-count'].includes(p.tool) ? 'Square' : 'Other'}
                color={p.style.color} fill={p.style.fill} width={p.style.width} opacity={p.style.opacity} dash={p.style.dash} cloudy={p.style.cloudy} fontSize={p.style.fontSize} fontColor={p.style.fontColor} family={p.style.fontFamily} bold={p.style.bold} italic={p.style.italic} le={p.style.le}
                set={(s) => p.setToolStyle({ ...(s.color !== undefined ? { color: s.color as RGB | null } : {}), ...(s.ic !== undefined ? { fill: s.ic as RGB | null } : {}), ...(s.bw !== undefined ? { width: s.bw } : {}), ...(s.opacity !== undefined ? { opacity: s.opacity } : {}), ...(s.dash !== undefined ? { dash: s.dash } : {}), ...(s.cloudy !== undefined ? { cloudy: s.cloudy } : {}), ...(s.font ? { fontSize: s.font.size, fontColor: s.font.color as RGB, fontFamily: s.font.family, bold: !!s.font.bold, italic: !!s.font.italic } : {}), ...(s.le ? { le: s.le } : {}) })}
              />
              {(p.tool === 'textbox' || p.tool === 'callout' || p.tool === 'typewriter') && <p className="faint small">{BIG_SHEET_TEXT}</p>}
              {MEASURE_KINDS[p.tool] && <FmtEditor fmt={p.style.fmt || {}} kinds={MEASURE_KINDS[p.tool]!} imperial={imperialIn(doc)} onChange={(f) => p.setToolStyle({ fmt: { ...(p.style.fmt || {}), ...f } })} />}
              <button className="btn sm" onClick={() => p.A.chestAdd()}><Ico n="chest" size={14} /> Add to Tool Chest</button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (!items.length) return <div className="props"><div className="side-head"><span>Properties</span></div></div>;
  const a = items[0];
  const one = items.length === 1;
  const locked = items.every((x) => x.locked);
  const anyLocked = items.some((x) => x.locked);
  const isMeasure = a.kind?.startsWith('measure-');
  // measurements: what their number format can change (lengths: unit + m/mm decimals, areas: m²)
  const fmtKinds = [...new Set(items.flatMap((x) => (x.kind ? MEASURE_KINDS['m-' + x.kind.slice(8)] || [] : [])))] as ('len' | 'area')[];
  const labelNow = Math.round(Math.max(2, Math.min(72, a.labelSize ?? 10)) * 10) / 10; // (as drawn)
  /** a new number format: each measurement's number written again with it (a label someone
   *  typed themselves stays as it is) */
  const setFmt = async (f: MeasureFmt) => {
    // (read again: the panel's copy can be a moment old - a label just typed would be overwritten)
    const pagesNow = new Map<number, AnnotData[]>();
    for (const pg of new Set(items.map((x) => x.page))) pagesNow.set(pg, await doc.annots(pg));
    const list = items.map((x) => pagesNow.get(x.page)?.find((y) => y.id === x.id) ?? x).filter((x) => !x.locked && x.kind?.startsWith('measure-') && x.kind !== 'measure-count');
    const patches = list.map((x) => {
      const fmt = { ...(x.fmt ?? LEGACY_FMT), ...f };
      const pts = (x.vertices || x.line || []) as [number, number][];
      const sc = pts.length ? doc.scaleAt(x.page, pts[0][0], pts[0][1]) : null;
      // typed by hand: not the number it shows now ("7.10 m" typed over 7.056 m looks like one)
      const own = !!x.contents && (!NUMBER_ONLY.test(x.contents.trim()) || !isAutoLabel(x, sc));
      return { page: x.page, id: x.id, patch: { fmt, ...(own || !pts.length ? {} : { contents: measureValue(x.kind!, pts, sc, fmt), autoLabel: true }) } as Partial<AnnotSpec> };
    });
    if (patches.length) try { await track(doc, doc.update(patches, 'Decimals')); } catch (e) { p.toast(String((e as Error).message || e), 'err'); }
  };
  return (
    <div className="props">
      <div className="side-head"><span>{one ? markupName(a) : `${items.length} markups`}</span><button className="x" onClick={p.onClose}><Ico n="close" size={14} /></button></div>
      <div className="props-body">
        {one && <div className="faint">Page {a.page + 1}{a.author ? ' · ' + a.author : ''}{a.modified ? ' · ' + new Date(a.modified).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : ''}</div>}
        {one && isMeasure && <div className="mval">{a.contents}</div>}
        {one && a.type !== 'Redact' && a.type !== 'Widget' && <CommentBox key={a.id} a={a} disabled={a.locked} focus={p.focusComment} onSave={(t) => upd({ contents: t }, 'Edit comment')} label={a.type === 'FreeText' ? 'Text' : isMeasure ? 'Label shown on the sheet' : 'Comment'} />}
        {a.type !== 'Redact' && a.type !== 'Widget' && (
          <fieldset disabled={locked}>
            {anyLocked && !locked && <div className="hint">Locked ones among them stay as they are.</div>}
            <StyleEditor type={a.type} color={a.type === 'FreeText' ? a.color : a.color} fill={a.ic} width={a.bw} opacity={a.opacity} dash={a.dash} cloudy={a.cloudy} fontSize={a.font?.size} fontColor={a.font?.color} family={a.font?.family} bold={a.font?.bold} italic={a.font?.italic} align={a.quadding} le={a.le as [string, string] | undefined} set={(s) => void upd(s, 'Change style')}
              setFont={(f) => void upd((x) => ({ font: { size: f.size ?? x.font?.size ?? 11, color: f.color ?? x.font?.color ?? [0, 0, 0], family: f.family ?? x.font?.family, bold: f.bold ?? !!x.font?.bold, italic: f.italic ?? !!x.font?.italic } }), 'Change style')} />
            {one && a.type === 'FreeText' && (
              <label className="check" title="On: the box grows and shrinks with its text (it wraps at the width it has now or 360 pt). Off: the box keeps its width, the text wraps inside it.">
                <input type="checkbox" checked={!!a.autoWidth} onChange={(e) => void upd({ autoWidth: e.target.checked ? Math.max(360, (a.box || a.rect)[2] - (a.box || a.rect)[0]) : null }, 'Box size')} /> Box fits the text
              </label>
            )}
            {one && ROTATABLE.has(a.type) && !a.callout?.length && (
              <div className="prow">
                <span className="plab">Rotation</span>
                <button className="btn sm icon" title="Rotate 90° left" onClick={() => void upd({ angle: (((a.angle || 0) - 90) % 360 + 360) % 360 }, 'Rotate')}><Ico n="rotl" size={14} /></button>
                {/* (one per markup: an angle typed for one markup stayed in the box and was given to the next one selected) */}
                <AngleInput key={a.id} value={a.angle || 0} onSet={(v) => void upd({ angle: v }, 'Rotate')} />
                <button className="btn sm icon" title="Rotate 90° right" onClick={() => void upd({ angle: ((a.angle || 0) + 90) % 360 }, 'Rotate')}><Ico n="rotr" size={14} /></button>
              </div>
            )}
            {fmtKinds.length > 0 && <FmtEditor {...commonFmt(items)} kinds={fmtKinds} imperial={imperialIn(doc)} onChange={(f) => void setFmt(f)} />}
            {isMeasure && a.kind !== 'measure-count' && (
              <div className="prow"><span className="plab">Number size</span>
                <select className="input xs" value={String(labelNow)} onChange={(e) => void upd({ labelSize: Number(e.target.value) }, 'Label size')}>
                  {[...new Set([2, 3, 4, 5, 6, 8, 10, 12, 14, 18, 24, 36, 48, labelNow])].sort((x, y) => x - y).map((v) => <option key={v} value={String(v)}>{v} pt</option>)}
                </select>
              </div>
            )}
          </fieldset>
        )}
        {a.type === 'Redact' && (
          <>
            <RedactFill value={a.redactFill ?? [0, 0, 0]} onChange={(v) => void upd({ redactFill: v }, 'Redaction box')} disabled={anyLocked} />
            <div className="hint">Marked only: nothing is removed until you press Apply redactions (Edit tab).</div>
          </>
        )}
        {a.type === 'Widget' && a.field && <div className="hint">Form field “{a.field.name}” – click it on the page to fill it in.</div>}
        {one && a.type !== 'Redact' && a.type !== 'Widget' && (
          <div className="prow">
            <span className="plab">Status</span>
            <select className="input xs" value={a.state || ''} onChange={(e) => void upd({ state: e.target.value }, 'Set status')} disabled={a.locked}>
              <option value="">None</option><option>Accepted</option><option>Rejected</option><option>Cancelled</option><option>Completed</option>
            </select>
          </div>
        )}
        <div className="prow">
          <button className={'btn sm' + (locked ? ' on' : '')} onClick={() => void upd({ locked: !locked }, locked ? 'Unlock' : 'Lock')}><Ico n={locked ? 'lock' : 'unlock'} size={14} /> {locked ? 'Locked' : 'Lock'}</button>
          <button className="btn sm" onClick={() => p.A.flatten('selected')} title="Burn into the page (can't be moved or deleted afterwards)"><Ico n="flatten" size={14} /> Flatten</button>
          <button className="btn sm danger" disabled={anyLocked} onClick={async () => { await doc.remove(items.map((x) => ({ page: x.page, id: x.id }))); p.setSel([]); }}><Ico n="delete" size={14} /> Delete</button>
        </div>
        {anyLocked && <div className="hint">Locked markups can't be moved, changed or deleted until unlocked.</div>}
        {one && a.type !== 'Redact' && a.type !== 'Widget' && (
          <div className="replies">
            <div className="plab">Replies</div>
            {replies.map((r) => (
              <div key={r.id} className="reply">
                <div className="faint">{r.author || '—'} · {r.created ? new Date(r.created).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : ''}
                  <button className="x" title="Delete reply" onClick={() => void doc.remove([{ page: r.page, id: r.id }]).catch((e) => p.toast(String((e as Error).message || e), 'err'))}>×</button>
                </div>
                <div dir="auto">{r.contents}</div>
              </div>
            ))}
            <ReplyBox key={a.id} onAdd={async (t) => {
              try { await track(doc, doc.create(a.page, { type: 'Text', irt: a.id, contents: t, icon: 'Comment' })); return true; }
              catch (e) { p.toast(String((e as Error).message || e), 'err'); return false; }
            }} />
          </div>
        )}
      </div>
    </div>
  );
}

/** the last focus request served (a new comment's box mounts after the request was made) */
let seenFocus = 0;
function CommentBox({ a, onSave, disabled, focus, label }: { a: AnnotData; onSave(t: string): void; disabled: boolean; focus: number; label: string }) {
  const [v, setV] = useState(a.contents || '');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setV(a.contents || ''), [a.contents]);
  // typed but not saved yet when the box goes away (another tab, another markup, the panel
  // closed): saved then, into the file it was typed for (this instance's onSave)
  const saved = useRef(a.contents || '');
  useEffect(() => { saved.current = a.contents || ''; }, [a.contents]);
  const now = useRef({ v, onSave });
  now.current = { v, onSave };
  const save = (t: string) => { if (t !== saved.current) { saved.current = t; onSave(t); } };
  useEffect(() => () => { const { v: t, onSave: f } = now.current; if (t !== saved.current) { saved.current = t; f(t); } }, []);
  // focus only when asked now (the counter went up), not every time a markup is selected later
  const seen = useRef(focus);
  const mountedAt = useRef(performance.now());
  useEffect(() => {
    const asked = focus !== seen.current || (focus && performance.now() - mountedAt.current < 300 && seenFocus !== focus);
    seen.current = focus;
    if (asked) { seenFocus = focus; ref.current?.focus(); }
  }, [focus]);
  return (
    <div className="prow col">
      <span className="plab">{label}</span>
      <textarea ref={ref} className="input ta" dir="auto" rows={4} disabled={disabled} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => save(v)} onKeyDown={(e) => { ownKeys(e); if (e.key === 'Enter' && e.ctrlKey) (e.target as HTMLTextAreaElement).blur(); }} placeholder="Type here…" />
    </div>
  );
}

function ReplyBox({ onAdd }: { onAdd(t: string): Promise<boolean> }) {
  const [v, setV] = useState('');
  const [sending, setSending] = useState(false);
  // the box is emptied only once the reply is in the file: a reply that failed (engine down)
  // stays there to send again; Enter twice while it goes sends it once
  const send = async () => {
    const t = v.trim();
    if (!t || sending) return;
    setSending(true);
    try { if (await onAdd(t)) setV((cur) => (cur.trim() === t ? '' : cur)); } finally { setSending(false); }
  };
  return (
    <div className="prow">
      <input className="input sm" dir="auto" placeholder="Reply…" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { ownKeys(e); if (e.key === 'Enter') void send(); }} />
      <button className="btn sm" disabled={!v.trim() || sending} onClick={() => void send()}><Ico n="reply" size={14} /></button>
    </div>
  );
}

function AngleInput({ value, onSet }: { value: number; onSet(v: number): void }) {
  const [v, setV] = useState(String(Math.round(value * 10) / 10));
  useEffect(() => setV(String(Math.round(value * 10) / 10)), [value]);
  return <input className="input xs ang" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { ownKeys(e); if (e.key === 'Enter') { const n = parseFloat(v); if (Number.isFinite(n)) onSet(((n % 360) + 360) % 360); } }} onBlur={() => { const n = parseFloat(v); if (Number.isFinite(n) && Math.abs(n - value) > 0.01) onSet(((n % 360) + 360) % 360); }} title="Degrees, clockwise" />;
}

/** the box a redaction leaves: black, white, the page's own colour around it, any colour, or none */
export /** the file has a feet-and-inches scale somewhere (only then inches' decimals are offered) */
const imperialIn = (doc: PdfDoc) => Object.values(doc.data.scales || {}).some((x) => x?.imperial) || Object.values(doc.data.viewports || {}).some((l) => l?.some((v) => v.scale?.imperial));
/** which number formats a measuring tool / measurement uses */
const MEASURE_KINDS: Partial<Record<string, ('len' | 'area')[]>> = { 'm-length': ['len'], 'm-polylength': ['len'], 'm-perimeter': ['len'], 'm-area': ['area', 'len'], 'm-rectarea': ['area'] };
/** a label that is just a measured number (written by the app, so it may be written again) */
const NUMBER_ONLY = /^(-?[\d.,]+ ?(m|mm|m²|sq ft|cm² \(paper\)|mm \(paper\))|\d+' [\d.]+")$/;

/** unit and decimals of measurement numbers */
/** the format several selected measurements share; where they differ, nothing is shown as picked */
function commonFmt(items: AnnotData[]): { fmt: MeasureFmt; mixed: Set<string> } {
  const ms = items.filter((x) => x.kind?.startsWith('measure-') && x.kind !== 'measure-count');
  const eff = (x: AnnotData, k: keyof MeasureFmt) => (x.fmt ?? LEGACY_FMT)[k] ?? (k === 'unit' ? 'auto' : FMT_DEFAULTS[k as keyof typeof FMT_DEFAULTS]);
  const fmt: MeasureFmt = {};
  const mixed = new Set<string>();
  for (const k of ['unit', 'dm', 'dmm', 'da', 'din'] as (keyof MeasureFmt)[]) {
    const vs = [...new Set(ms.map((x) => eff(x, k)))];
    if (vs.length > 1) mixed.add(k); else if (vs.length) (fmt as Record<string, unknown>)[k] = vs[0];
  }
  return { fmt, mixed };
}

function FmtEditor({ fmt, kinds, onChange, imperial, mixed }: { fmt: MeasureFmt; kinds: ('len' | 'area')[]; onChange(f: MeasureFmt): void; imperial?: boolean; mixed?: Set<string> }) {
  const d = (k: keyof typeof FMT_DEFAULTS) => (mixed?.has(k) ? '' : typeof fmt[k] === 'number' ? fmt[k]! : FMT_DEFAULTS[k]);
  const sel = (k: keyof typeof FMT_DEFAULTS, max: number, title: string) => (
    <select className="input xs" value={d(k)} title={title} onChange={(e) => e.target.value !== '' && onChange({ [k]: Number(e.target.value) })}>
      {mixed?.has(k) && <option value="">–</option>}
      {Array.from({ length: max + 1 }, (_, i) => <option key={i} value={i}>{i}</option>)}
    </select>
  );
  return (
    <>
      {kinds.includes('len') && (
        <div className="prow"><span className="plab">Unit</span>
          <select className="input xs grow" value={mixed?.has('unit') ? '' : fmt.unit || 'auto'} onChange={(e) => e.target.value !== '' && onChange({ unit: e.target.value as MeasureFmt['unit'] })}>
            {mixed?.has('unit') && <option value="">(they differ)</option>}
            <option value="auto">m (mm under 1 m)</option><option value="m">m always</option><option value="mm">mm always</option>
          </select>
        </div>
      )}
      <div className="prow fmt-dec"><span className="plab">Decimals</span>
        {kinds.includes('len') && <><span className="faint">m</span>{sel('dm', 4, 'Decimals in metres')}<span className="faint">mm</span>{sel('dmm', 3, 'Decimals in millimetres')}</>}
        {kinds.includes('area') && <><span className="faint">m²</span>{sel('da', 4, 'Decimals in square metres')}</>}
        {imperial && kinds.includes('len') && <><span className="faint">in</span>{sel('din', 3, 'Decimals of inches (feet-and-inches scales)')}</>}
      </div>
    </>
  );
}

function RedactFill({ value, onChange, disabled }: { value: number[] | 'auto' | 'none'; onChange(v: number[] | 'auto' | 'none'): void; disabled?: boolean }) {
  const isArr = Array.isArray(value);
  const k = value === 'auto' ? 'auto' : value === 'none' ? 'none' : isArr && value.every((v) => v < 0.02) ? 'black' : isArr && value.every((v) => v > 0.98) ? 'white' : 'colour';
  return (
    <div className="prow col">
      <span className="plab">Box left after redacting</span>
      <div className="seg full">
        <button disabled={disabled} className={k === 'black' ? 'on' : ''} onClick={() => onChange([0, 0, 0])}>Black</button>
        <button disabled={disabled} className={k === 'white' ? 'on' : ''} onClick={() => onChange([1, 1, 1])}>White</button>
        <button disabled={disabled} className={k === 'auto' ? 'on' : ''} title="The colour of the page around it – the box blends in" onClick={() => onChange('auto')}>Match page</button>
        <button disabled={disabled} className={k === 'none' ? 'on' : ''} title="No box: the area just stays empty" onClick={() => onChange('none')}>None</button>
      </div>
      <div className="prow"><span className="plab">Or a colour</span><ColorPick value={(k === 'colour' && isArr ? value : null) as RGB | null} onChange={(c) => c && onChange(c)} title="Box colour" /></div>
    </div>
  );
}

type FontPatch = { size?: number; color?: number[]; family?: string; bold?: boolean; italic?: boolean };
function StyleEditor(s: { type: string; color: number[] | null; fill: number[] | null; width: number; opacity: number; dash: boolean; cloudy: number; fontSize?: number; fontColor?: number[]; family?: string; bold?: boolean; italic?: boolean; align?: number; le?: [string, string]; set(p: Partial<AnnotSpec>): void; setFont?(p: FontPatch): void }) {
  // (several text boxes: each keeps its own font, size and colour - only what was changed is
  // the same for all)
  const font = (p: FontPatch) => ({ font: { size: p.size ?? s.fontSize ?? 11, color: p.color ?? s.fontColor ?? [0, 0, 0], family: p.family ?? s.family, bold: p.bold ?? !!s.bold, italic: p.italic ?? !!s.italic } });
  const setFont = (p: FontPatch) => (s.setFont ? s.setFont(p) : s.set(font(p)));
  const text = s.type === 'FreeText';
  const fillable = ['Square', 'Circle', 'Polygon', 'FreeText'].includes(s.type);
  const line = s.type === 'Line' || s.type === 'PolyLine';
  const markup = ['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Text'].includes(s.type);
  // (a stamp, signature or picture: its own colours - only how see-through it is)
  const picture = s.type === 'Stamp';
  return (
    <div className="style-ed">
      {!picture && <div className="prow"><span className="plab">{text ? 'Box colour' : 'Colour'}</span><ColorPick value={s.color as RGB | null} allowNone={text} onChange={(c) => s.set({ color: c })} title="Colour" /></div>}
      {fillable && !text && <div className="prow"><span className="plab">Fill</span><ColorPick value={s.fill as RGB | null} allowNone onChange={(c) => s.set({ ic: c })} title="Fill" /></div>}
      {text && <div className="prow"><span className="plab">Text</span><ColorPick value={(s.fontColor || [0, 0, 0]) as RGB} onChange={(c) => setFont({ color: c || [0, 0, 0] })} title="Text colour" />
        <select className="input xs" value={s.fontSize || 11} onChange={(e) => setFont({ size: Number(e.target.value) })}>{[...new Set([6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72, s.fontSize || 11])].sort((x, y) => x - y).map((w) => <option key={w} value={w}>{+w.toFixed(2)} pt</option>)}</select>
        <BoldItalic bold={s.bold} italic={s.italic} onChange={(p) => setFont(p)} />
      </div>}
      {text && <div className="prow"><span className="plab">Font</span>
        <FontSelect className="input xs wide" value={s.family} onChange={(f) => setFont({ family: f })} />
      </div>}
      {text && <div className="prow"><span className="plab">Align</span>
        <div className="seg">{['Left', 'Centre', 'Right'].map((n, i) => <button key={n} className={(s.align ?? 0) === i ? 'on' : ''} title={'Align ' + n.toLowerCase()} onClick={() => s.set({ quadding: i })}>{n}</button>)}</div>
      </div>}
      {!markup && !picture && <div className="prow"><span className="plab">Line</span>
        <select className="input xs" value={s.width} onChange={(e) => s.set({ bw: Number(e.target.value) })}>{[...new Set([0, 0.5, 1, 1.5, 2, 3, 4, 6, 8, s.width])].sort((x, y) => x - y).map((w) => <option key={w} value={w}>{+w.toFixed(2)} pt</option>)}</select>
        <label className="check sm"><input type="checkbox" checked={s.dash} onChange={(e) => s.set({ dash: e.target.checked })} /> Dashed</label>
      </div>}
      <div className="prow"><span className="plab">Opacity</span>
        <input type="range" min={10} max={100} step={5} value={Math.round(s.opacity * 100)} onChange={(e) => s.set({ opacity: Number(e.target.value) / 100 })} />
        <span className="faint">{Math.round(s.opacity * 100)}%</span>
      </div>
      {(fillable && !text || s.type === 'Polygon') && <div className="prow"><span className="plab">Edge</span>
        <select className="input xs" value={s.cloudy ? String(s.cloudy) : '0'} onChange={(e) => s.set({ cloudy: Number(e.target.value) })}><option value="0">Straight</option><option value="1">Cloud</option><option value="2">Big cloud</option></select>
      </div>}
      {line && <div className="prow"><span className="plab">Ends</span>
        <select className="input xs" value={(s.le || ['None', 'None']).join('|')} onChange={(e) => s.set({ le: e.target.value.split('|') as [string, string] })}>
          <option value="None|None">— none</option><option value="None|ClosedArrow">→ arrow</option><option value="None|OpenArrow">⇾ open arrow</option>
          <option value="ClosedArrow|ClosedArrow">↔ both</option><option value="OpenArrow|OpenArrow">⇿ open both</option><option value="Circle|ClosedArrow">●→</option><option value="Slash|Slash">/ ticks /</option><option value="Butt|Butt">| dimension |</option>
        </select>
      </div>}
    </div>
  );
}
