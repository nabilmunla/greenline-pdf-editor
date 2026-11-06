import { useState } from 'react';

/**
 * A number box that can be emptied while typing. The boxes put their default straight back when
 * emptied (`Number('') || 1`), so the new digits went after it: Backspace then 3 gave 13 copies,
 * 50 % became 1000 %, a 10 pt footer 810 pt. Here the text typed is kept as it is; each value that
 * makes sense is passed on as it is typed, and leaving the box shows the value in use again.
 */
export function NumIn(p: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; int?: boolean; className?: string; title?: string; disabled?: boolean }) {
  const [txt, setTxt] = useState<string | null>(null);
  const min = p.min ?? -Infinity, max = p.max ?? Infinity;
  return (
    <input className={p.className} type="number" min={p.min} max={p.max} step={p.step} title={p.title} disabled={p.disabled}
      value={txt ?? String(p.value)}
      onChange={(e) => {
        const t = e.target.value;
        setTxt(t);
        const n = Number(t);
        if (t.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && (!p.int || Number.isInteger(n))) p.onChange(n);
      }}
      onBlur={() => setTxt(null)}
      onKeyDown={(e) => { if (e.key === 'Enter') setTxt(null); }} />
  );
}
