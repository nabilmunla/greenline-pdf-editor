// What the drawing engines read on top of their copy of a document: one more incremental update
// (new objects + a cross-reference section pointing back at the copy's last one). Used for heavy
// pages drawn from merged line work - display only, never in a saved file (D2).
import type { ExtraPart } from './files';

const latin1 = (s: string): Uint8Array => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };

/**
 * streams: new stream objects whose (already Flate-compressed) data is a file; objs: objects
 * given again (PDF syntax of their value). `len` = bytes of the copy so far, `prevXref` = where
 * its last cross-reference section starts, `size` = the new /Size, `trailer` = the other trailer
 * entries (/Root ... /Info ...). The parts come back in order; the file parts are not copied.
 */
export function overlay(streams: { num: number; file: { path: string; size: number } }[], objs: { num: number; gen: number; body: string }[], len: number, prevXref: number, size: number, trailer: string): ExtraPart[] {
  const extra: ExtraPart[] = [];
  const offs = new Map<number, [number, number]>();
  let at = len;
  const put = (s: string) => { const b = latin1(s); extra.push({ bytes: b }); at += b.length; };
  // (a line break first: the copy may end without one after %%EOF)
  put('\n');
  for (const s of streams) {
    offs.set(s.num, [at, 0]);
    put(`${s.num} 0 obj\n<</Length ${s.file.size}/Filter/FlateDecode>>\nstream\n`);
    extra.push({ path: s.file.path, size: s.file.size });
    at += s.file.size;
    put('\nendstream\nendobj\n');
  }
  for (const o of objs) {
    offs.set(o.num, [at, o.gen]);
    put(`${o.num} ${o.gen} obj\n${o.body}\nendobj\n`);
  }
  const xref = at;
  // a classic table, one subsection per object (entries are exactly 20 bytes)
  let t = 'xref\n';
  for (const k of [...offs.keys()].sort((a, b) => a - b)) {
    const [o, g] = offs.get(k)!;
    t += `${k} 1\n${String(o).padStart(10, '0')} ${String(g).padStart(5, '0')} n \n`;
  }
  t += `trailer\n<</Size ${size}${trailer}/Prev ${prevXref}>>\nstartxref\n${xref}\n%%EOF\n`;
  put(t);
  return extra;
}

/** where the last cross-reference section of a file's last `n` bytes says it starts (-1: none) */
export function lastXref(tail: Uint8Array): number {
  let s = '';
  for (let i = 0; i < tail.length; i++) s += String.fromCharCode(tail[i]);
  const m = [...s.matchAll(/startxref\s+(\d+)/g)].pop();
  return m ? parseInt(m[1], 10) : -1;
}
