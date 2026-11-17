// Calls to the engines. Each engine is a separate background process (see host.ts),
// reached through a message port. If an engine process dies (out of memory on a monster
// file), the app starts a new one and hands over a new port: calls in flight fail, the
// open files are reopened in it (see engines.ts), and everything else carries on.
type Pending = { res: (v: unknown) => void; rej: (e: Error) => void; method: string; t0: number };
/** slow calls (> 150 ms), newest last - for finding what makes the app wait (window.__gccSlow) */
export const slowCalls: { engine: string; method: string; ms: number; at: number }[] = [];
(globalThis as { __gccSlow?: unknown }).__gccSlow = slowCalls;

/** a file made or read by an engine */
export interface FileRef { $file: { path: string; size?: number; delta?: string; mtime?: number; extra?: ({ path: string; size: number } | { bytes: Uint8Array })[] } }
export const fileArg = (path: string, extra: { size?: number; delta?: string; mtime?: number; extra?: ({ path: string; size: number } | { bytes: Uint8Array })[] } = {}): FileRef => ({ $file: { path, ...extra } });
export const isFileRef = (v: unknown): v is FileRef => !!v && typeof v === 'object' && !!(v as FileRef).$file;

/** an error that is part of an engine going down and starting again (already reported as
 *  the engine's own crash - not one report per call that was waiting) */
export const engineDown = (e: Error) => Object.assign(e, { engineDown: true });
export const isEngineDown = (e: unknown) => !!(e && typeof e === 'object' && (e as { engineDown?: boolean }).engineDown);
/** an operating-system error reading or opening a file ("UNKNOWN: unknown error, read",
 *  "EIO: i/o error, read", "ENOENT: no such file or directory, open '…'") */
/** "the file could not be read from the disk any more": said once a minute, wherever the failed
 *  read is caught (most background reads are caught quietly - the person is still told) */
let fileReadAt = -1e9;
export function fileReadNotice() {
  const now = Date.now();
  if (now - fileReadAt < 60000 || typeof window === 'undefined') return;
  fileReadAt = now;
  // (the toast App shows for engine notices - see 'gcc-engine-gaveup' in App.tsx)
  window.dispatchEvent(new CustomEvent('gcc-engine-gaveup', { detail: 'A file could not be read from the disk any more - it was moved or deleted, or its drive or network went away. Save a copy if you have changes, then open it again.' }));
}
export const isFileReadError = (msg: string) => /^(?:UNKNOWN|EIO|EBUSY|ENOENT|EPERM|EACCES|ENXIO|ETIMEDOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EHOSTDOWN|ESTALE|ENODEV): [^,]*, (?:read|open|fstat|stat)\b/.test(msg);

export class EngineClient {
  private port: MessagePort | null = null;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private waiting: { id: number; msg: unknown }[] = [];
  /** number of calls in flight (used to spread tiles over engines) */
  busy = 0;
  /** when it was last asked for something (performance.now(); its memory asked for doesn't count) */
  lastUse = 0;
  /** times the engine had to be restarted */
  restarts = 0;
  constructor(public name: string) {}

  /** when the engine was last restarted (calls failing just after that are part of it) */
  private restartedAt = 0;
  attach(port: MessagePort, restarted: boolean, code = 0) {
    this.gone = null;
    if (restarted) {
      this.restarts++;
      this.restartedAt = performance.now();
      // an engine does one call at a time: the oldest one waiting is the one it was doing when it
      // went down (the "culprit" - unless it was a planned restart, exit 75, or the call that
      // broke it already answered with its fatal error and was blamed then: the calls still
      // waiting only queued behind it); the rest only waited
      // (a short call that went ahead of the tiles queued says so when it starts: then it is that one)
      const blame = !this.fatalSeen && code !== 75;
      let first = true;
      this.fatalSeen = false;
      const ahead = this.running !== null && this.pending.has(this.running) ? this.running : null;
      this.running = null;
      for (const [id, p] of this.pending) {
        const err = engineDown(new Error(this.name + ' restarted'));
        if (blame && (ahead !== null ? id === ahead : first)) Object.assign(err, { culprit: true });
        first = false;
        p.rej(err);
      }
      this.pending.clear();
      this.waiting = [];
      this.busy = 0;
    }
    else if (this.port) {
      // a new port with no restart (the engine itself is the same): what was posted to the old one
      // is never answered on the new one - what still waits to be posted is sent below as it is
      const queued = new Set(this.waiting.map((w) => w.id));
      for (const [id, p] of this.pending) {
        if (queued.has(id)) continue;
        this.pending.delete(id);
        this.busy--;
        p.rej(new Error(this.name + ' connection was replaced'));
      }
    }
    this.port?.close();
    this.port = port;
    port.onmessage = (e: MessageEvent) => this.reply(e.data);
    port.start();
    for (const w of this.waiting) port.postMessage(w.msg);
    this.waiting = [];
  }

  /** the app stopped starting this engine (it kept dying): calls fail at once with this, instead
   *  of waiting for an engine that is not coming */
  private gone: string | null = null;
  fail(message: string) {
    this.gone = message;
    for (const p of this.pending.values()) p.rej(engineDown(new Error(message)));
    this.pending.clear();
    this.waiting = [];
    this.busy = 0;
  }

  /** messages the engine sends on its own (e.g. 'recycle': restart me at a safe moment) */
  onNotice: ((notice: string) => void) | null = null;

  /** a call answered with a fatal error (the engine exits right after it): that call is the
   *  one that took the engine down, not the one waiting behind it when the restart comes */
  private fatalSeen = false;

  /** the call the engine started ahead of older ones (PLAN 3.9), until it answers */
  private running: number | null = null;

  private reply(d: { id: number; ok: boolean; value: unknown; error: string; notice?: string; fatal?: boolean; running?: number; stale?: boolean }) {
    if (d.notice) { this.onNotice?.(d.notice); return; }
    if (d.running) { this.running = d.running; return; }
    const p = this.pending.get(d.id);
    if (!p) return;
    this.pending.delete(d.id);
    if (this.running === d.id) this.running = null;
    this.busy--;
    const ms = performance.now() - p.t0;
    if (ms > 150) { slowCalls.push({ engine: this.name, method: p.method, ms: Math.round(ms), at: Math.round(p.t0) }); if (slowCalls.length > 200) slowCalls.shift(); }
    if (!d.ok) {
      const err = new Error(d.error);
      // (crash reports show the call that failed: "at reply / onmessage" said nothing - 4 reports
      // on the share could not be traced to their call)
      Object.assign(err, { engine: this.name, method: p.method });
      err.stack = `Error: ${d.error}\n    at engine ${this.name}: ${p.method}`;
      // the file could not be read from the disk any more (moved, deleted, a network drive or
      // USB stick gone, a cloud file not on the PC): Windows' answer, not the app's fault
      if (isFileReadError(d.error)) { Object.assign(err, { fileRead: true }); fileReadNotice(); }
      // (a view tile the window no longer wanted: not drawn, nothing went wrong)
      if (d.stale) { p.rej(Object.assign(err, { stale: true })); return; }
      // the engine running out of memory (its last answers before it is restarted), or a page
      // asked for before a restarted engine has the file open again: part of the restart
      if (/Aborted\(|Cannot enlarge memory/.test(d.error) || (/Document is not open/.test(d.error) && performance.now() - this.restartedAt < 30000)) engineDown(err);
      // (the first fatal answer only: whatever the broken engine still answers after it is not to blame)
      if (d.fatal && !this.fatalSeen) { this.fatalSeen = true; Object.assign(engineDown(err), { culprit: true }); }
      p.rej(err);
      return;
    }
    const v = d.value;
    if (hasImg(v, 0)) void toBitmaps(v, 0).then(p.res, (e) => p.rej(e instanceof Error ? e : new Error(String(e))));
    else p.res(v);
  }

  /** the scales of view tiles still wanted for a document (null: none any more); queued view
   *  tiles at other scales are answered "stale" instead of drawn (PLAN 3.9) */
  want(doc: string, scales: number[] | null) {
    try { this.port?.postMessage({ want: { doc, scales } }); } catch { /* a port going away: its queue goes with it */ }
  }

  /**
   * Call `method`. out: the file the call makes is written by the engine to a temp file
   * (true) or to the given path, and comes back as a FileRef instead of bytes.
   */
  call<T>(method: string, args: unknown[] = [], out?: boolean | string): Promise<T> {
    if (this.gone) return Promise.reject(new Error(this.gone));
    const id = this.seq++;
    if (method !== 'heap') this.lastUse = performance.now();
    this.busy++;
    const msg = { id, method, args, out };
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej, method, t0: performance.now() });
      try {
        if (this.port) this.port.postMessage(msg);
        else this.waiting.push({ id, msg });
      } catch (e) {
        // (the message could not be posted - a closed port, something that cannot be cloned: the
        // call is not in flight, and left counted it kept `busy` above 0, which blocks the idle restart)
        this.pending.delete(id);
        this.busy--;
        rej(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

type Img = { $img: 1; w: number; h: number; px: Uint8ClampedArray };
const isImg = (v: unknown): v is Img => !!v && typeof v === 'object' && (v as Img).$img === 1;
function hasImg(v: unknown, d: number): boolean {
  if (!v || typeof v !== 'object' || d > 2 || ArrayBuffer.isView(v)) return false;
  if (isImg(v)) return true;
  return Object.values(v).some((x) => hasImg(x, d + 1));
}
/** engine pictures (raw pixels) -> ImageBitmaps */
async function toBitmaps(v: unknown, d: number): Promise<unknown> {
  if (isImg(v)) return createImageBitmap(new ImageData(v.px as unknown as Uint8ClampedArray<ArrayBuffer>, v.w, v.h));
  if (!v || typeof v !== 'object' || d > 2 || ArrayBuffer.isView(v)) return v;
  if (Array.isArray(v)) return Promise.all(v.map((x) => toBitmaps(x, d + 1)));
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) o[k] = await toBitmaps(x, d + 1);
  return o;
}
