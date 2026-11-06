// Calls to the engines. Each engine is a separate background process (see host.ts),
// reached through a message port. If an engine process dies (out of memory on a monster
// file), the app starts a new one and hands over a new port: calls in flight fail, the
// open files are reopened in it (see engines.ts), and everything else carries on.
type Pending = { res: (v: unknown) => void; rej: (e: Error) => void; method: string; t0: number };
/** slow calls (> 150 ms), newest last - for finding what makes the app wait (window.__gccSlow) */
export const slowCalls: { engine: string; method: string; ms: number; at: number }[] = [];
(globalThis as { __gccSlow?: unknown }).__gccSlow = slowCalls;

/** a file made or read by an engine */
export interface FileRef { $file: { path: string; size?: number; delta?: string; mtime?: number } }
export const fileArg = (path: string, extra: { size?: number; delta?: string; mtime?: number } = {}): FileRef => ({ $file: { path, ...extra } });
export const isFileRef = (v: unknown): v is FileRef => !!v && typeof v === 'object' && !!(v as FileRef).$file;

/** an error that is part of an engine going down and starting again (already reported as
 *  the engine's own crash - not one report per call that was waiting) */
export const engineDown = (e: Error) => Object.assign(e, { engineDown: true });
export const isEngineDown = (e: unknown) => !!(e && typeof e === 'object' && (e as { engineDown?: boolean }).engineDown);

export class EngineClient {
  private port: MessagePort | null = null;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private waiting: { id: number; msg: unknown }[] = [];
  /** number of calls in flight (used to spread tiles over engines) */
  busy = 0;
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
      let first = !this.fatalSeen;
      this.fatalSeen = false;
      for (const p of this.pending.values()) {
        const err = engineDown(new Error(this.name + ' restarted'));
        if (first && code !== 75) Object.assign(err, { culprit: true });
        first = false;
        p.rej(err);
      }
      this.pending.clear();
      this.waiting = [];
      this.busy = 0;
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

  private reply(d: { id: number; ok: boolean; value: unknown; error: string; notice?: string; fatal?: boolean }) {
    if (d.notice) { this.onNotice?.(d.notice); return; }
    const p = this.pending.get(d.id);
    if (!p) return;
    this.pending.delete(d.id);
    this.busy--;
    const ms = performance.now() - p.t0;
    if (ms > 150) { slowCalls.push({ engine: this.name, method: p.method, ms: Math.round(ms), at: Math.round(p.t0) }); if (slowCalls.length > 200) slowCalls.shift(); }
    if (!d.ok) {
      const err = new Error(d.error);
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

  /**
   * Call `method`. out: the file the call makes is written by the engine to a temp file
   * (true) or to the given path, and comes back as a FileRef instead of bytes.
   */
  call<T>(method: string, args: unknown[] = [], out?: boolean | string): Promise<T> {
    if (this.gone) return Promise.reject(new Error(this.gone));
    const id = this.seq++;
    this.busy++;
    const msg = { id, method, args, out };
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej, method, t0: performance.now() });
      if (this.port) this.port.postMessage(msg);
      else this.waiting.push({ id, msg });
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
