// The order an engine runs its calls in (PLAN 3.9, D6). An engine does one call at a time; the
// window keeps a few tiles queued at each engine so it is never idle. Two things used to wait
// behind them:
//  - a short call (the text of a page, a snap point, its links): it now goes ahead of the tiles
//    queued (never ahead of anything else - an open, a close or an edit keeps its place);
//  - tiles of a view already left (zoomed away): the window says which scales it still wants for
//    a document, and a view tile at another scale is answered "stale" instead of being drawn.

/** calls that answer quickly and may go ahead of queued tiles */
export const SHORT = new Set(['chars', 'charsIn', 'rangeRects', 'links', 'snap', 'heap']);
/** tiles of the view (dropped once their scale is no longer wanted); other tiles (thumbnails,
 *  pictures for export) are never dropped */
export const VIEW_TILE = 'viewTile';
const isTile = (m: string) => m === 'tile' || m === VIEW_TILE;

export interface QCall { method: string; args: unknown[]; seq: number }

export class CallQueue<C extends QCall> {
  readonly items: C[] = [];
  private want = new Map<string, Set<number>>();
  /** view tiles answered "stale" without being drawn */
  stale = 0;

  push(c: C) {
    if (!SHORT.has(c.method)) { this.items.push(c); return; }
    // (after the last call that is not a tile: short calls keep their order among everything else)
    let k = this.items.length;
    while (k > 0 && isTile(this.items[k - 1].method)) k--;
    this.items.splice(k, 0, c);
  }

  /** the scales of view tiles the window still wants for a document (null: forget the document) */
  wantScales(doc: string, scales: number[] | null) {
    if (scales) this.want.set(doc, new Set(scales));
    else this.want.delete(doc);
  }

  /** (PLAN 7.5) the short call at the front, taken to run in a tile's pause - only at the front:
   *  one queued behind an open, a close or an edit waits for it */
  takeShort(): C | undefined {
    return this.items.length && SHORT.has(this.items[0].method) ? this.items.shift() : undefined;
  }

  isStale(c: C) {
    if (c.method !== VIEW_TILE) return false;
    const w = this.want.get(String(c.args[0]));
    return !!w && !w.has(Number(c.args[2]));
  }

  /** the next call to run, and the view tiles found stale ahead of it (to be answered so) */
  next(): { call?: C; stale: C[]; jumped: boolean } {
    const stale: C[] = [];
    while (this.items.length) {
      const c = this.items.shift()!;
      if (this.isStale(c)) { stale.push(c); this.stale++; continue; }
      // (a call that went ahead of others that came before it: the window is told which call is
      // running, so if the engine goes down now it's that one that's blamed, not the oldest)
      return { call: c, stale, jumped: this.items.some((x) => x.seq < c.seq) };
    }
    return { stale, jumped: false };
  }
}
