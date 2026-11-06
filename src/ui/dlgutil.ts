// Small pure helpers of the dialogs (page lists, where batch results go, typed numbers, PDF
// dates) - kept apart from Dialogs.tsx so they can be tested without a window.

/** "1-3, 5, 8-" (also "2 4", "5-3") -> zero-based page indexes, each page once, in the order typed */
export function parseRanges(s: string, n: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (i: number) => { if (!seen.has(i)) { seen.add(i); out.push(i); } };
  for (const part of s.replace(/\s*-\s*/g, '-').split(/[,;\s]+/)) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^(\d*)-(\d*)$/);
    if (m) {
      let a = m[1] ? parseInt(m[1], 10) : 1, b = m[2] ? parseInt(m[2], 10) : n;
      if (a > b) [a, b] = [b, a];
      for (let i = Math.max(1, a); i <= Math.min(n, b); i++) add(i - 1);
    } else if (/^\d+$/.test(t)) { const i = parseInt(t, 10); if (i >= 1 && i <= n) add(i - 1); }
  }
  return out;
}

/** [0,1,2,5] -> "1-3, 6" */
export const toRanges = (ps: number[]) => {
  const a = [...new Set(ps)].sort((x, y) => x - y), out: string[] = [];
  for (let i = 0; i < a.length; ) { let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; out.push(i === j ? String(a[i] + 1) : `${a[i] + 1}-${a[j] + 1}`); i = j + 1; }
  return out.join(', ');
};

/**
 * A number typed by a person: "2,5" is 2.5 (a decimal comma), "1:" style junk, "Infinity" and
 * anything outside [min, max] is null.
 */
export function typedNumber(s: string, min = 0, max = Infinity): number | null {
  const t = s.trim().replace(/\s+/g, '');
  // (one comma and no point: a decimal comma; otherwise commas are thousands)
  const x = /^[^.]*,[^,.]*$/.test(t) && !/^\d{1,3},\d{3}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(x)) return null;
  const v = Number(x);
  return Number.isFinite(v) && v > min && v <= max ? v : null;
}

/** a PDF date ("D:20230615093000+04'00'") as people write it: "15 Jun 2023, 09:30"; anything else as it is */
export function pdfDate(s: string | undefined): string {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec((s || '').trim());
  if (!m) return s || '';
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2] || 1) - 1];
  if (!mon) return s || '';
  const day = `${Number(m[3] || 1)} ${mon} ${m[1]}`;
  return m[4] ? `${day}, ${m[4]}:${m[5] || '00'}` : day;
}

// ---------------------------------------------------------------- where batch results go

export type OutMode = 'suffix' | 'folder' | 'replace';

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
const joinPath = (d: string, f: string) => d.replace(/[\\/]+$/, '') + (d.includes('\\') ? '\\' : '/') + f;
/** the same file? (Windows: case and / or \ don't matter) */
export const samePath = (a: string, b: string) => { const n = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase(); return n(a) === n(b); };

export interface OutPlan {
  /** nothing can start: what to change first */
  problem: string | null;
  /** where each file's result goes */
  out: Map<string, string>;
  /** files left out, and why */
  skip: Map<string, string>;
}

/**
 * Where each batch result is written. Never over an original unless "Replace the originals" was
 * chosen: an empty addition to the name, or the originals' own folder, would have put each
 * result in its original's place with no copy kept. Never over another file of the list, nor
 * over a file open in a tab (the tab would not know, and its next save would put the old
 * contents back). Two files of the same name going into one folder - or a name that is
 * another file of the list - get " (2)", " (3)"...
 */
export function planOutputs(files: string[], mode: OutMode, suffix: string, folder: string, open: string[] = []): OutPlan {
  const out = new Map<string, string>(), skip = new Map<string, string>();
  if (mode === 'suffix') {
    if (!suffix.trim()) return { problem: 'Type something to add to the names, e.g. " (new)" - with nothing added, each result would take its original\'s place. To do that, choose "Replace the originals".', out, skip };
    if (/[\\/:*?"<>|]/.test(suffix)) return { problem: 'What is added to the names can\'t contain \\ / : * ? " < > |', out, skip };
  }
  if (mode === 'folder' && !folder) return { problem: 'Choose the folder for the new files.', out, skip };
  const taken: string[] = [];
  for (const f of files) {
    if (mode === 'folder' && samePath(dirName(f), folder)) { skip.set(f, 'it is in that folder already - choose another folder'); continue; }
    const name = baseName(f).replace(/\.pdf$/i, '');
    let t = mode === 'replace' ? f : mode === 'folder' ? joinPath(folder, name + '.pdf') : joinPath(dirName(f), name + suffix + '.pdf');
    if (mode !== 'replace') for (let k = 2; [...taken, ...files].some((x) => samePath(x, t)); k++) t = joinPath(dirName(t), `${name}${mode === 'suffix' ? suffix : ''} (${k}).pdf`);
    if (open.some((x) => samePath(x, t))) { skip.set(f, `"${baseName(t)}" is open - close it first${mode === 'replace' ? ', or save the result next to it' : ''}`); continue; }
    taken.push(t);
    out.set(f, t);
  }
  return { problem: null, out, skip };
}

/** names made different from each other: "Notes", "Notes (2)", "Notes (3)" (case doesn't count) */
export function uniqueNames(names: string[]): string[] {
  const seen: string[] = [];
  return names.map((n) => {
    let x = n;
    for (let k = 2; seen.includes(x.toLowerCase()); k++) x = `${n} (${k})`;
    seen.push(x.toLowerCase());
    return x;
  });
}

/** printed sheets of paper: two-sided puts two pages on each (a copy starts on a new sheet when collated) */
export function paperSheets(pages: number, copies: number, collate: boolean, twoSided: boolean): number {
  if (!twoSided) return pages * copies;
  return collate ? copies * Math.ceil(pages / 2) : Math.ceil((pages * copies) / 2);
}
