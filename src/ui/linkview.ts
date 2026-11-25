// Where a click on a link inside the file goes and how it is shown. Pure: unit-tested in
// tests/link-view.test.ts. A link's destination view is the PDF's own: /Fit = 2, /XYZ = 1 (left, top,
// zoom), ... (FPDFDest_GetView's codes). Only /Fit is honoured so far; the others show the page as
// before (13.2.12 adds the detail zoom here).

/** a destination's view as PDFium reports it: the view type and its parameters */
export interface LinkView { kind: number; params: number[] }
export const VIEW_FIT = 2;

/** the page to go to and whether to show all of it; null for a link that is not inside the file */
export function jumpOf(l: { page?: number; view?: LinkView }): { page: number; fit: boolean } | null {
  if (l.page == null || l.page < 0) return null;
  return { page: l.page, fit: l.view?.kind === VIEW_FIT };
}
