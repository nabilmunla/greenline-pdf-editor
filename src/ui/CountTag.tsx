// Count by tag (0.8.5, as in the Estimation app's take-off): type the tag written on the drawing
// (D, FD-, W1...), find every one in the page's text - this page or all pages - and count them
// all in one go, a count mark on each, one undo step.
import { useMemo, useRef, useState } from 'react';
import { Modal, type Toast } from './Modal';
import type { PdfDoc } from './doc';
import type { AnnotSpec } from '../engine/mu';
import { wordsOf, findTags, perTagByDefault, middle, type TagHit, type TagMode, countNumbers } from './tagcount';
import { toolStyle, type Style } from './tools';

interface Props {
  doc: PdfDoc;
  page: number;
  style: Partial<Style> | undefined;
  close(): void;
  toast(t: string, k?: Toast['kind'], a?: Toast['action'], ms?: number): number;
  fail(e: unknown): void;
  /** counting from now on goes on under this name */
  setCountGroup(g: string): void;
  showTotals(): void;
}

export function CountTagDlg(p: Props) {
  const { doc } = p;
  const [tag, setTag] = useState(() => localStorage.getItem('counttag-tag') || '');
  const [mode, setMode] = useState<TagMode>(() => (localStorage.getItem('counttag-mode') as TagMode) || 'start');
  const [scope, setScope] = useState<'page' | 'all'>('page');
  const [busy, setBusy] = useState('');
  const [found, setFound] = useState<{ hits: TagHit[]; counted: number; tag: string; pages: number } | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [perTag, setPerTag] = useState(false);
  const [name, setName] = useState('');
  const stop = useRef(false);

  const find = async () => {
    const t = tag.trim();
    if (!t) return;
    try { localStorage.setItem('counttag-tag', t); localStorage.setItem('counttag-mode', mode); } catch { /* ok */ }
    stop.current = false;
    setFound(null);
    const pages = scope === 'page' ? [p.page] : [...doc.pages.keys()];
    const words: { page: number; words: ReturnType<typeof wordsOf> }[] = [];
    try {
      for (const [i, pg] of pages.entries()) {
        if (stop.current) break;
        if (pages.length > 1) setBusy(`Reading page ${i + 1} of ${pages.length}…`);
        words.push({ page: pg, words: wordsOf(await doc.chars(pg)) });
      }
      // marks where something is counted already (by any name) are left out: counting the same
      // tags again would count them twice
      const all = await doc.allAnnots();
      const counts = all.filter((a) => a.kind === 'measure-count');
      let hits = findTags(words, t, mode);
      const before = hits.length;
      // (a count mark ON this tag - its middle on the tag's words; a big mark on an A1 sheet
      // that only reaches over a tag beside it doesn't count it: W1 under a counted D01 was
      // left out as "counted already")
      hits = hits.filter((h) => {
        const pad = Math.max(2, (h.box[3] - h.box[1]) * 0.3);
        return !counts.some((c) => { const cx = (c.rect[0] + c.rect[2]) / 2, cy = (c.rect[1] + c.rect[3]) / 2; return c.page === h.page && cx >= h.box[0] - pad && cx <= h.box[2] + pad && cy >= h.box[1] - pad && cy <= h.box[3] + pad; });
      });
      setFound({ hits, counted: before - hits.length, tag: t, pages: words.length });
      setOff(new Set());
      setPerTag(perTagByDefault(hits));
      setName(t.toUpperCase());
    } catch (e) { p.fail(e); } finally { setBusy(''); }
  };

  const byName = useMemo(() => {
    const m = new Map<string, TagHit[]>();
    for (const h of found?.hits || []) { if (!m.has(h.text)) m.set(h.text, []); m.get(h.text)!.push(h); }
    return [...m].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [found]);
  const chosen = (found?.hits || []).filter((h) => !off.has(h.text));

  const count = async () => {
    if (!chosen.length) return;
    const one = name.trim() || (found?.tag || 'Count').toUpperCase();
    const st = toolStyle('m-count', p.style);
    try {
      setBusy(`Counting ${chosen.length}…`);
      // the numbers go on from what each name has already
      const all = await doc.allAnnots();
      const had = countNumbers(all);
      const items: { page: number; spec: AnnotSpec }[] = chosen.map((h) => {
        const grp = perTag ? h.text : one;
        const n = (had.get(grp) || 0) + 1;
        had.set(grp, n);
        const pg = doc.pages[h.page];
        // (as big as a mark clicked with the Count tool: bigger on big sheets)
        const k = pg ? Math.min(4, Math.max(1, Math.round((Math.max(pg.w, pg.h) / 842) * 2) / 2)) : 1;
        const r = 5 * k;
        const [x, y] = middle(h.box);
        return { page: h.page, spec: { type: 'Circle', rect: [x - r, y - r, x + r, y + r], color: st.color, ic: st.fill || st.color, bw: Math.round(Math.sqrt(k) * 10) / 10, opacity: st.opacity, dash: st.dash, kind: 'measure-count', group: grp, contents: grp + ' #' + n, subject: 'Count' } as AnnotSpec };
      });
      await doc.createMany(items, 'Count by tag');
      if (!perTag) p.setCountGroup(one);
      const names = perTag ? new Set(chosen.map((h) => h.text)).size : 1;
      p.close();
      p.toast(`Counted ${chosen.length} mark${chosen.length === 1 ? '' : 's'}${names > 1 ? ` under ${names} names` : ` as "${one}"`} – Ctrl+Z takes them all back.`, 'ok', { label: 'Totals', run: p.showTotals }, 7000);
    } catch (e) { setBusy(''); p.fail(e); }
  };

  const seg = <T extends string>(v: T, set: (x: T) => void, items: [T, string, string?][]) => (
    <div className="seg">{items.map(([k, label, title]) => <button key={k} type="button" title={title} className={v === k ? 'on' : ''} onClick={() => { set(k); setFound(null); }}>{label}</button>)}</div>
  );
  return (
    <Modal title="Count by tag" wide className="counttag" onClose={() => { if (busy) { stop.current = true; return; } p.close(); }}
      sub="The tags written on the drawing (door marks D01, D02…) found in its text and counted in one go."
      actions={<>
        <span className="grow" />
        <button className="btn" onClick={() => { if (busy) { stop.current = true; return; } p.close(); }}>{busy && /Reading/.test(busy) ? 'Stop' : 'Cancel'}</button>
        <button className="btn primary" disabled={!!busy || !chosen.length} onClick={() => void count()}>{chosen.length ? `Count ${chosen.length}` : 'Count'}</button>
      </>}>
      <div className="ct-form">
        <label className="ct-row"><span>Tag</span>
          <input className="input" autoFocus value={tag} placeholder="e.g. D, FD-, W1" onChange={(e) => { setTag(e.target.value); setFound(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void find(); } }} />
        </label>
        <div className="ct-row"><span>Find</span>{seg<TagMode>(mode, setMode, [['start', 'Starting with', 'The tag and then a number or - _ . / : D finds D01, D-A0101, not DOOR'], ['exact', 'Exactly', 'Only the whole word'], ['contain', 'Containing', 'Anywhere in a word']])}</div>
        <div className="ct-row"><span>On</span>{seg<'page' | 'all'>(scope, setScope, [['page', `This page (${p.page + 1})`], ['all', `All ${doc.pages.length} pages`]])}</div>
        <div className="ct-row"><span /><button className="btn" disabled={!tag.trim() || !!busy} onClick={() => void find()}>Find</button>{busy && <span className="faint"><span className="dot busy" /> {busy}</span>}</div>
      </div>
      {found && (
        <div className="ct-res">
          {!found.hits.length ? (
            <div className="faint">{found.counted ? `All ${found.counted} found are counted already.` : `No "${found.tag}" found ${found.pages > 1 ? `on the ${found.pages} pages` : 'on this page'} – scanned pages need OCR first (OCR tab).`}</div>
          ) : (
            <>
              <div className="ct-sum">{found.hits.length} found{found.counted ? `, ${found.counted} counted already (left out)` : ''} – untick what isn't to be counted:</div>
              <div className="ct-list">
                {byName.map(([n, l]) => (
                  <label key={n} className="check ct-item">
                    <input type="checkbox" checked={!off.has(n)} onChange={(e) => setOff((s) => { const x = new Set(s); if (e.target.checked) x.delete(n); else x.add(n); return x; })} />
                    <span className="ct-name">{n}</span><span className="ct-n">{l.length}</span>
                    {scope === 'all' && <span className="faint small">p. {[...new Set(l.map((h) => h.page + 1))].slice(0, 6).join(', ')}{new Set(l.map((h) => h.page)).size > 6 ? '…' : ''}</span>}
                  </label>
                ))}
              </div>
              <label className="check"><input type="checkbox" checked={perTag} onChange={(e) => setPerTag(e.target.checked)} /> A count name for each tag ({byName.filter(([n]) => !off.has(n)).length})</label>
              {!perTag && <label className="ct-row"><span>Count as</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
