// The "which pages" control shared by Print, Search and Rotate: All / This page / Selected / Pages…
// with an optional odd / even choice. The rule itself is pickPages (dlgutil.ts).
import type { ReactNode } from 'react';
import type { PickWhich, PickSubset } from './dlgutil';

export interface PagePickProps {
  which: PickWhich;
  onWhich(w: PickWhich): void;
  range: string;
  onRange(s: string): void;
  subset: PickSubset;
  onSubset(s: PickSubset): void;
  n: number;
  /** zero-based page on screen */
  current: number;
  /** pages picked in the Pages panel (shown only when more than one) */
  selectedCount: number;
  /** more choices after "This page" (Print: what's in view, the marked area), as [key, label, hint] */
  extra?: [PickWhich, string, string?][];
  /** shown under the choices (Print: "This page isn't on screen") */
  note?: ReactNode;
  /** put in the odd / even row after the select (Print: Reverse order) */
  rowEnd?: ReactNode;
  /** leave out the odd / even row */
  noSubset?: boolean;
  /** label of the typed-pages choice */
  rangeLabel?: string;
}

export function PagePick(p: PagePickProps) {
  const items: [PickWhich, string, string?][] = [
    ['all', `All ${p.n}`],
    ['current', 'This page', `Page ${p.current + 1}`],
    ...(p.extra || []),
    ...(p.selectedCount > 1 ? [['selected', `Selected ${p.selectedCount}`, 'The pages selected in the Pages panel'] as [PickWhich, string, string]] : []),
    ['range', p.rangeLabel || 'Pages…'],
  ];
  return (
    <>
      <div className="seg full">{items.map(([k, label, title]) => <button key={k} title={title} className={p.which === k ? 'on' : ''} onClick={() => p.onWhich(k)}>{label}</button>)}</div>
      {p.which === 'range' && <input className="input" autoFocus placeholder="e.g. 1-5, 8, 11-" value={p.range} onChange={(e) => p.onRange(e.target.value)} />}
      {p.note}
      {!p.noSubset && (p.which === 'all' || p.which === 'range' || p.which === 'selected') && (
        <div className="pd-row">
          <select className="input" value={p.subset} onChange={(e) => p.onSubset(e.target.value as PickSubset)}>
            <option value="all">All of them</option><option value="odd">Odd pages only</option><option value="even">Even pages only</option>
          </select>
          {p.rowEnd}
        </div>
      )}
    </>
  );
}
