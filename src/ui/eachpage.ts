/**
 * One fetch per page, in order, each result handed over the moment it arrives (not after the last
 * page: while the person scrolls on, the page list changes before a slow last page is done, and
 * nothing would ever be shown). `live()` is asked before each fetch and again before each hand-over,
 * so a view change stops it at once and a late result is dropped.
 */
export async function eachPage<T>(pages: readonly number[], get: (page: number) => Promise<T>, put: (page: number, v: T) => void, live: () => boolean): Promise<void> {
  for (const i of pages) {
    if (!live()) return;
    const v = await get(i);
    if (!live()) return;
    put(i, v);
  }
}
