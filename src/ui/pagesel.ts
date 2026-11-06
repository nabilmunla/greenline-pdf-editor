// Small pure helpers for the UI shell (no window, no engines: unit-tested in tests/uishell.test.ts).

/**
 * The pages chosen in the Pages panel after the page list changed. The choice is kept as page
 * positions, so without this a page inserted before them (or an undone move) made the ribbon's
 * Rotate / Delete / Extract act on other pages.
 * `before` / `after` are the per-page picture revisions (PdfDoc.crev): a page keeps its revision
 * when only other pages change, so a page that moved (pages inserted, deleted, reordered, undone)
 * is found again by it. A change made in place (rotate, crop, OCR, flatten) gives those pages new
 * revisions at the same positions: the choice stays as it is. Pages that are gone drop out.
 */
export function followPages(sel: number[], before: number[], after: number[]): number[] {
  if (!sel.length) return sel;
  const old = new Set(before);
  const inPlace = before.length === after.length && after.every((r, i) => r === before[i] || !old.has(r));
  if (inPlace) return sel;
  const at = new Map<number, number>();
  after.forEach((r, i) => { if (!at.has(r)) at.set(r, i); });
  const out: number[] = [];
  for (const i of sel) {
    const j = at.get(before[i]);
    if (j !== undefined && !out.includes(j)) out.push(j);
  }
  return out;
}

/** Shift+click in the Pages panel: every page from the anchor (the page clicked last without
 *  Shift) to this one - the anchor stays, so a second Shift+click reaches back from it */
export function pageRange(anchor: number, to: number): number[] {
  const out: number[] = [];
  for (let k = Math.min(anchor, to); k <= Math.max(anchor, to); k++) out.push(k);
  return out;
}

/** a version number later than another ("0.10.0" after "0.9.2") */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** settings read from disk, made safe to draw: a hand-edited or damaged settings file with a
 *  non-text entry in the recent list (or a Tool Chest entry that isn't one) blanked the window
 *  at start-up - nothing on screen could put it right. (A chest item for a tool this version
 *  doesn't have is kept - a newer version may - and refused when it is used.) */
export function cleanSettings<T extends { recent?: unknown; chest?: unknown }>(s: T): T {
  const out = { ...s };
  if (out.recent != null) out.recent = Array.isArray(out.recent) ? out.recent.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  if (out.chest != null) {
    out.chest = Array.isArray(out.chest)
      ? out.chest.filter((c) => !!c && typeof c === 'object' && typeof c.tool === 'string' && typeof c.name === 'string' && !!c.style && typeof c.style === 'object')
      : [];
  }
  return out;
}
