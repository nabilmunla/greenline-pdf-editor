// Count by tag (0.8.5, as in the Estimation app's take-off): the marks written on a drawing - door
// tags D01, D02, FD-03... - found in the page's text, so each can be counted where it is, in one
// go. Pure functions (tests/tagcount.test.ts); the dialog is CountTag.tsx.
import type { Rect } from '../engine/mu';

export interface Word { text: string; box: Rect }
export interface TagHit { page: number; text: string; box: Rect }
export type TagMode = 'start' | 'exact' | 'contain';

/** punctuation round a tag that isn't part of it: "(D01)," -> D01 */
const EDGE = /^[\s()[\]{}<>,;:"'`·•*]+|[\s()[\]{}<>,;:"'`·•*.]+$/g;

/**
 * The words of a page from its characters (PDFium: one box per character, none for the spaces
 * and line breaks it puts between words): runs of characters with boxes and no white space.
 */
export function wordsOf(c: { text: string; box: Float32Array }): Word[] {
  const out: Word[] = [];
  let s = '', b: Rect | null = null;
  const flush = () => {
    if (s && b) {
      // (the box keeps the trimmed brackets - a mark goes in its middle, near enough)
      const t = s.replace(EDGE, '');
      if (t) out.push({ text: t, box: b });
    }
    s = ''; b = null;
  };
  for (let i = 0; i < c.text.length; i++) {
    const ch = c.text[i];
    const x0 = c.box[i * 4], y0 = c.box[i * 4 + 1], x1 = c.box[i * 4 + 2], y1 = c.box[i * 4 + 3];
    if (/\s/.test(ch) || Number.isNaN(x0)) { flush(); continue; }
    s += ch;
    b = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1];
  }
  flush();
  return out;
}

/**
 * Does a word match the tag? Starting with: the tag, then a number or a separator - "D" finds
 * D01, D-A0101-A, D.3, not DOOR (a tag ending in a number or a separator takes anything after
 * it). Exactly: the whole word. Containing: anywhere in it. Case is ignored.
 */
export function matchTag(word: string, tag: string, mode: TagMode): boolean {
  const w = word.toUpperCase(), t = tag.trim().toUpperCase();
  if (!t) return false;
  if (mode === 'exact') return w === t;
  if (mode === 'contain') return w.includes(t);
  if (!w.startsWith(t)) return false;
  if (w.length === t.length) return true;
  return /[0-9\-_./]/.test(w[t.length]) || /[0-9\-_./]$/.test(t);
}

/** a found tag's name for counting: as written on the drawing, upper case */
export const tagName = (t: string) => t.toUpperCase();

/**
 * The marks on the pages that match, each once: the same text drawn twice on itself (fake
 * bold) is one mark. In page order, top to bottom, left to right.
 */
export function findTags(pages: { page: number; words: Word[] }[], tag: string, mode: TagMode): TagHit[] {
  const out: TagHit[] = [];
  for (const { page, words } of pages) {
    const here: TagHit[] = [];
    for (const w of words) {
      if (!matchTag(w.text, tag, mode)) continue;
      const cx = (w.box[0] + w.box[2]) / 2, cy = (w.box[1] + w.box[3]) / 2, h = Math.max(1, w.box[3] - w.box[1]);
      const name = tagName(w.text);
      if (here.some((o) => o.text === name && Math.abs((o.box[0] + o.box[2]) / 2 - cx) < h * 0.5 && Math.abs((o.box[1] + o.box[3]) / 2 - cy) < h * 0.5)) continue;
      here.push({ page, text: name, box: w.box });
    }
    here.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
    out.push(...here);
  }
  return out;
}

/** "a count name for each tag" starts ticked only when the tags repeat (types: at most 15
 *  names, at least two of each on average) - door numbers each found once would make 126
 *  names of one */
export function perTagByDefault(hits: TagHit[]): boolean {
  const names = new Set(hits.map((h) => h.text));
  return names.size > 1 && names.size <= 15 && hits.length >= names.size * 2;
}

/** the middle of a found tag (where its count mark goes) */
export const middle = (b: Rect): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/**
 * The highest count number each group has so far ("Doors #7" -> 7; a mark whose text was changed
 * counts as one more): the next mark of a group gets the one after. Counting the marks instead gave
 * a number twice once a mark was deleted (#1, #3, then #3 again).
 */
export function countNumbers(all: { kind?: string; group?: string; contents?: string }[]): Map<string, number> {
  const hi = new Map<string, number>(), n = new Map<string, number>();
  for (const a of all) {
    if (a.kind !== 'measure-count') continue;
    const g = a.group || 'Count';
    n.set(g, (n.get(g) || 0) + 1);
    const m = /#\s*(\d+)\s*$/.exec(a.contents || '');
    if (m) hi.set(g, Math.max(hi.get(g) || 0, Number(m[1])));
  }
  for (const [g, c] of n) hi.set(g, Math.max(hi.get(g) || 0, c));
  return hi;
}
