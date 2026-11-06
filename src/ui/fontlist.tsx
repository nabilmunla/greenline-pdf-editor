// Fonts for text boxes, callouts and typewriter text: the three built into every PDF program,
// and the typefaces found on this PC (embedded in the file, so others see the same).
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { mu } from './engines';

export const BUILTIN: [string, string][] = [['Helv', 'Helvetica'], ['TiRo', 'Times'], ['Cour', 'Courier']];
let pc: string[] = [];
const subs = new Set<() => void>();

/** asked once the editing engine runs */
export async function loadFonts(): Promise<void> {
  try { pc = (await mu<string[]>('fontFamilies')) || []; } catch { pc = []; }
  subs.forEach((f) => f());
}

export function useFonts(): string[] {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);
  return pc;
}

export const fontLabel = (f?: string) => BUILTIN.find((b) => b[0] === f)?.[1] || f || 'Helvetica';

/** CSS for the typing box (Windows has the same fonts by name) */
export function famCss(f?: string): string {
  if (!f || f === 'Helv') return 'Helvetica, Arial, sans-serif';
  if (f === 'TiRo') return '"Times New Roman", Times, serif';
  if (f === 'Cour') return '"Courier New", Courier, monospace';
  return `"${f.replace(/"/g, '')}", Arial, sans-serif`;
}

export function FontSelect({ value, onChange, className, title }: { value?: string; onChange(f: string): void; className?: string; title?: string }) {
  const fonts = useFonts();
  const v = value || 'Helv';
  const known = BUILTIN.some((b) => b[0] === v) || fonts.includes(v);
  return (
    <select className={className} value={v} title={title || 'Font'} onChange={(e) => onChange(e.target.value)}>
      <optgroup label="In every PDF program">
        {BUILTIN.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
      </optgroup>
      {(fonts.length > 0 || !known) && (
        <optgroup label="From this PC (included in the file)">
          {!known && <option value={v}>{v} (not on this PC)</option>}
          {fonts.map((f) => <option key={f} value={f} style={{ fontFamily: famCss(f) }}>{f}</option>)}
        </optgroup>
      )}
    </select>
  );
}

/** B / I buttons (and U where the text can be underlined: the typing bar) */
export function BoldItalic({ bold, italic, underline, onChange, className }: { bold?: boolean; italic?: boolean; underline?: boolean; onChange(p: { bold?: boolean; italic?: boolean; underline?: boolean }): void; className?: string }) {
  return (
    <span className={'bi ' + (className || '')}>
      <button type="button" className={'bi-b' + (bold ? ' on' : '')} title="Bold (Ctrl+B)" aria-pressed={!!bold} onClick={() => onChange({ bold: !bold })}>B</button>
      <button type="button" className={'bi-i' + (italic ? ' on' : '')} title="Italic (Ctrl+I)" aria-pressed={!!italic} onClick={() => onChange({ italic: !italic })}>I</button>
      {underline !== undefined && <button type="button" className={'bi-u' + (underline ? ' on' : '')} title="Underline (Ctrl+U)" aria-pressed={!!underline} onClick={() => onChange({ underline: !underline })}>U</button>}
    </span>
  );
}

// ---------------------------------------------------------------- pickers for the typing bar

/**
 * A drop-down for the bar above a text box being typed in. A plain <select> can't be used there:
 * the bar keeps the keyboard in the text (mousedown is stopped, or the text box would lose the
 * keyboard and finish) - and a <select> whose mousedown is stopped never opens. This list opens
 * from a button and is picked with clicks only, so the typing goes on.
 */
export function BarPick<T extends string | number>({ value, label, title, groups, onPick, width, itemStyle }: {
  value: T; label: string; title: string; width?: number;
  groups: { name?: string; items: { v: T; label: string }[] }[];
  onPick(v: T): void;
  itemStyle?(v: T): CSSProperties | undefined;
}) {
  const [open, setOpen] = useState<{ x: number; y: number; up: boolean; h: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // (before the list is painted: it is moved into the window first)
  useLayoutEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (list.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(null); } };
    const gone = () => setOpen(null);
    // (the page scrolled under it: the list would stay where it opened, away from its button)
    const scrolled = (e: Event) => { if (!list.current?.contains(e.target as Node)) setOpen(null); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('resize', gone);
    window.addEventListener('scroll', scrolled, true);
    // kept inside the window (near its right edge it was squeezed and the names cut)
    const el = list.current;
    if (el) { const r = el.getBoundingClientRect(); if (r.right > window.innerWidth - 8) el.style.left = Math.max(8, window.innerWidth - 8 - r.width) + 'px'; }
    // the current one in view
    const cur = list.current?.querySelector('.on') as HTMLElement | null;
    if (cur && list.current) list.current.scrollTop = cur.offsetTop - list.current.clientHeight / 2 + cur.offsetHeight / 2;
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc, true); window.removeEventListener('resize', gone); window.removeEventListener('scroll', scrolled, true); };
  }, [open]);
  const toggle = () => {
    if (open) { setOpen(null); return; }
    const r = btn.current!.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 10, above = r.top - 10;
    const up = below < 180 && above > below;
    setOpen({ x: r.left, y: up ? r.top - 4 : r.bottom + 4, up, h: Math.max(120, Math.min(340, up ? above : below)) });
  };
  return (
    <>
      <button ref={btn} type="button" className={'barpick' + (open ? ' open' : '')} title={title} style={width ? { width } : undefined} onClick={toggle} aria-haspopup="listbox" aria-expanded={!!open}>
        <span>{label}</span><i className="caret" />
      </button>
      {open && createPortal(
        <div ref={list} className="edpop" role="listbox" style={{ left: open.x, top: open.up ? undefined : open.y, bottom: open.up ? window.innerHeight - open.y : undefined, maxHeight: open.h }} onMouseDown={(e) => e.preventDefault()}>
          {groups.map((g, gi) => (
            <div key={gi}>
              {g.name && <div className="edpop-h">{g.name}</div>}
              {g.items.map((it) => (
                <button key={String(it.v)} type="button" role="option" aria-selected={it.v === value} className={it.v === value ? 'on' : ''} style={itemStyle?.(it.v)}
                  onClick={() => { setOpen(null); if (it.v !== value) onPick(it.v); }}>{it.label}</button>
              ))}
            </div>
          ))}
        </div>, document.body)}
    </>
  );
}

/** the font, for the typing bar (same lists as FontSelect); mixed: the selected text has several */
export function FontPick({ value, onChange, mixed }: { value?: string; onChange(f: string): void; mixed?: boolean }) {
  const fonts = useFonts();
  const v = value || 'Helv';
  const known = BUILTIN.some((b) => b[0] === v) || fonts.includes(v);
  const groups: { name?: string; items: { v: string; label: string }[] }[] = [{ name: 'In every PDF program', items: BUILTIN.map(([k, n]) => ({ v: k, label: n })) }];
  if (fonts.length || !known) groups.push({ name: 'From this PC (included in the file)', items: [...(!known ? [{ v, label: v + ' (not on this PC)' }] : []), ...fonts.map((f) => ({ v: f, label: f }))] });
  // (mixed: none shown as picked - any pick, the one the box has too, goes to all of the selection)
  return <BarPick value={mixed ? '\u0000' : v} label={mixed ? '—' : fontLabel(v)} title="Font" width={150} groups={groups} onPick={onChange} itemStyle={(f) => ({ fontFamily: famCss(f) })} />;
}

export const BAR_SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 60, 72];
/** the text size, for the typing bar (a size set elsewhere - 13.5 pt - is listed too) */
export function SizePick({ value, onChange, mixed }: { value: number; onChange(n: number): void; mixed?: boolean }) {
  const list = mixed || BAR_SIZES.includes(value) ? BAR_SIZES : [...BAR_SIZES, value].sort((a, b) => a - b);
  return <BarPick value={mixed ? NaN : value} label={mixed ? '—' : `${+value.toFixed(1)} pt`} title="Size" width={70} groups={[{ items: list.map((n) => ({ v: n, label: `${+n.toFixed(1)} pt` })) }]} onPick={onChange} />;
}
