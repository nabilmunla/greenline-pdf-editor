/// <reference types="node" />
// File access for the engines (they run as Node processes): PDFs are read on demand -
// only the bytes a page needs - so a 300 MB file costs a few MB of memory, not 300 MB.
//
// A source is bytes, or a file on disk, optionally "a file plus changes": the first `size`
// bytes of `path` followed by the bytes of `delta` (MuPDF's incremental save of the open
// document = the original file + appended changes, so only the appended part is written).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** mtime: the base file as it was when the changes (delta) were written against it - a file saved
 *  over in between is refused (its start is not what the changes belong to) */
export interface FileSrc { path: string; size?: number; delta?: string; mtime?: number }
export type Src = Uint8Array | FileSrc;
export const isFileSrc = (s: unknown): s is FileSrc => !!s && typeof s === 'object' && !ArrayBuffer.isView(s) && typeof (s as FileSrc).path === 'string';

/** what the engines read a document from (no file system in the engines themselves) */
export interface Reader { readonly size: number; read(buf: Uint8Array, off: number, len: number, pos: number): number; close(): void }

interface Part { fd: number; start: number; len: number }

/** a source read in pieces; several files back to back */
export class VFile implements Reader {
  readonly parts: Part[] = [];
  readonly size: number;
  /** the file (the base, when there are changes after it) as it was when opened - from the open
   *  handle itself, so it describes exactly the bytes read (a stat by name taken later could
   *  describe a file another program had saved meanwhile) */
  readonly opened: { size: number; mtime: number };
  private closed = false;
  constructor(src: FileSrc) {
    const fds: number[] = [];
    try {
      const a = fs.openSync(src.path, 'r');
      fds.push(a);
      const st = fs.fstatSync(a);
      const full = st.size;
      this.opened = { size: st.size, mtime: st.mtimeMs };
      if (src.delta && src.mtime != null && Math.abs(st.mtimeMs - src.mtime) > 1) throw new Error('The file was changed meanwhile');
      // (a base shorter than the changes were written against: something else was saved there -
      // the changes would be spliced in at the wrong place)
      if (src.delta && src.size != null && full < src.size) throw new Error('The file was changed meanwhile');
      const baseLen = src.delta ? Math.min(full, src.size ?? full) : full;
      this.parts.push({ fd: a, start: 0, len: baseLen });
      if (src.delta) {
        const b = fs.openSync(src.delta, 'r');
        fds.push(b);
        this.parts.push({ fd: b, start: baseLen, len: fs.fstatSync(b).size });
      }
    } catch (e) {
      for (const f of fds) try { fs.closeSync(f); } catch { /* */ }
      throw e;
    }
    this.size = this.parts.reduce((s, p) => s + p.len, 0);
  }
  /** read len bytes at pos into buf[off..]; returns bytes read (short only at the end) */
  read(buf: Uint8Array, off: number, len: number, pos: number): number {
    if (this.closed) return 0;
    let done = 0;
    for (const p of this.parts) {
      if (done >= len) break;
      const at = pos + done;
      if (at >= p.start + p.len || at < p.start) continue;
      const want = Math.min(len - done, p.start + p.len - at);
      let got = 0;
      while (got < want) {
        const n = fs.readSync(p.fd, buf, off + done + got, want - got, at - p.start + got);
        if (n <= 0) break; // file shorter than expected
        got += n;
      }
      done += got;
      if (got < want) break;
    }
    return done;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.parts) try { fs.closeSync(p.fd); } catch { /* already closed */ }
  }
}

export const workDir = () => path.join(os.tmpdir(), 'PDF Editor', 'work');

let tmpSeq = 0;
/** a fresh temp file path (its folder exists) */
export function tempPath(name = 'file.pdf'): string {
  const d = path.join(workDir(), process.pid + '-' + Date.now().toString(36) + '-' + (++tmpSeq));
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, name.replace(/[\\/:*?"<>|]/g, '_'));
}

/** write a view (e.g. straight out of the engine's memory) in pieces - no extra copy */
export function writeView(p: string, view: Uint8Array, from = 0) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'w');
  try {
    const CH = 16 << 20;
    for (let o = from; o < view.length; o += CH) {
      const end = Math.min(view.length, o + CH);
      let w = o;
      while (w < end) w += fs.writeSync(fd, view, w, end - w);
    }
  } finally { fs.closeSync(fd); }
}

/** remove temp files we made (only inside our work folder) */
export function removeTemp(paths: string[]) {
  const root = path.resolve(workDir()) + path.sep;
  for (const p of paths) {
    if (!p) continue;
    const f = path.resolve(p);
    if (!f.startsWith(root)) continue;
    try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* still open somewhere: cleaned at next start */ }
  }
}

export function statOf(p: string): { size: number; mtime: number } | null {
  try { const s = fs.statSync(p); return { size: s.size, mtime: s.mtimeMs }; } catch { return null; }
}
