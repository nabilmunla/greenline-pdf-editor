// Line ends: the ten MuPDF styles, and one picker (Start, swap, End) used by the ribbon's Style
// group and the side panel. Start = the first point drawn (the PDF /LE order).

export type LineEnd = { name: string; glyph: string; label: string };

export const LINE_ENDS: LineEnd[] = [
  { name: 'None', glyph: '–', label: 'None' },
  { name: 'ClosedArrow', glyph: '►', label: 'Arrow' },
  { name: 'OpenArrow', glyph: '>', label: 'Open arrow' },
  { name: 'RClosedArrow', glyph: '◄', label: 'Arrow pointing in' },
  { name: 'ROpenArrow', glyph: '<', label: 'Open arrow pointing in' },
  { name: 'Circle', glyph: '●', label: 'Circle' },
  { name: 'Square', glyph: '■', label: 'Square' },
  { name: 'Diamond', glyph: '◆', label: 'Diamond' },
  { name: 'Butt', glyph: '|', label: 'Bar' },
  { name: 'Slash', glyph: '/', label: 'Tick' },
];

/** the start end points the other way: its glyphs are mirrored so "◄ Arrow" reads as an arrow at the start */
const MIRROR: Record<string, string> = { '►': '◄', '◄': '►', '>': '<', '<': '>' };

/** the options of one select: the ten styles, plus the value's own name when it is not one of them (a foreign file) */
export function endOptions(value: string, which: 'start' | 'end' = 'end'): { value: string; text: string }[] {
  const out = LINE_ENDS.map((e) => ({ value: e.name, text: `${which === 'start' ? MIRROR[e.glyph] ?? e.glyph : e.glyph} ${e.label}` }));
  if (!LINE_ENDS.some((e) => e.name === value)) out.push({ value, text: value });
  return out;
}

export function EndsPicker({ value, onChange }: { value: readonly string[] | undefined; onChange(le: [string, string]): void }) {
  const start = value?.[0] || 'None', end = value?.[1] || 'None';
  const sel = (which: 'start' | 'end', v: string) => (
    <select className="input xs" data-end={which} value={v} title={which === 'start' ? 'Start (the first point)' : 'End (the last point)'}
      onChange={(e) => onChange(which === 'start' ? [e.target.value, end] : [start, e.target.value])}>
      {endOptions(v, which).map((o) => <option key={o.value} value={o.value}>{o.text}</option>)}
    </select>
  );
  return (
    <span className="ends">
      {sel('start', start)}
      <button type="button" className="btn sm icon" data-end="swap" disabled={start === end} title="Swap start and end" onClick={() => onChange([end, start])}>⇄</button>
      {sel('end', end)}
    </span>
  );
}
