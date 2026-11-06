// Stamp from a scan: the cleaning runs here, away from the window (a 12 MP photo takes a second).
import { analyse, clean, inkAt, type Analysis, type CleanOpts } from './stampclean';

let an: Analysis | null = null;
const post = (m: unknown, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);

self.onmessage = (e: MessageEvent<{ id: number; op: 'analyse'; w: number; h: number; data: ArrayBuffer } | { id: number; op: 'clean'; opts: CleanOpts } | { id: number; op: 'pick'; x: number; y: number }>) => {
  const m = e.data;
  try {
    if (m.op === 'analyse') {
      an = analyse({ w: m.w, h: m.h, data: new Uint8ClampedArray(m.data) });
      post({ id: m.id, info: { W: an.W, H: an.H, k: an.k, ink: an.ink, inkHue: an.inkHue, others: an.others, crop: an.crop, angle: an.angle } });
    } else if (m.op === 'clean') {
      if (!an) throw new Error('No picture');
      const c = clean(an, m.opts);
      const buf = (c.img.data as Uint8ClampedArray).buffer as ArrayBuffer;
      post({ id: m.id, w: c.img.w, h: c.img.h, data: buf, srcW: c.srcW, srcH: c.srcH, angle: c.angle }, [buf]);
    } else if (m.op === 'pick') {
      if (!an) throw new Error('No picture');
      post({ id: m.id, ink: inkAt(an, m.x, m.y) });
    }
  } catch (er) {
    post({ id: m.id, error: String((er as Error)?.message || er) });
  }
};
