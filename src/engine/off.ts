// PDFED_OFF / PDFED_ON: comma lists of switches that turn a part of the release candidate off or
// back on (support and the audit run; not in the UI). Read once at start.
//   giveway   view tiles are drawn in one call (PLAN 7.5: no slices)
//   prelook   a full save does not look at the unseen pages first (PLAN 5.4)
//   pin       merged / simplified pages are not pinned to drawing engine 1 on a PC under 2 GB free (PLAN 7.3, 5.5;
//             off by default since Phase 5 run 2 - PDFED_ON=pin)
/** switched off unless PDFED_ON names them. pin: PLAN 5.5's rule after run 2 - with it, a merged
 *  heavy sheet's first view at 1 GB free took 32,017 ms (row: < 25,500); without it at the same free memory 18,498 ms,
 *  zoom ×4 2,114 vs 5,033, and no engine ended out of memory (step 4). The code stays (support,
 *  PDFED_ON=pin). */
export const DEFAULT_OFF: readonly string[] = ['pin'];
const names = (v: string | undefined | null) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
/** the switches that are off: the defaults and those PDFED_OFF names, less those PDFED_ON names */
export const offList = (off: string | undefined | null, on?: string | undefined | null): Set<string> => {
  const s = new Set([...DEFAULT_OFF, ...names(off)]);
  for (const n of names(on)) s.delete(n);
  return s;
};
/** what the main process answers for app:off ({ off, on }; an older answer was the PDFED_OFF string) */
export const offOf = (v: unknown): Set<string> =>
  typeof v === 'string' || v == null ? offList(v as string | null) : offList((v as { off?: string }).off, (v as { on?: string }).on);
