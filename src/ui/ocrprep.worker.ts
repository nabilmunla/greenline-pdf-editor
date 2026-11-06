import { prep } from './ocrprep';

self.onmessage = (e: MessageEvent<{ id: number; bmp: ImageBitmap; W: number; H: number; quarter: number; denoise: number }>) => {
  const { id, bmp, W, H, quarter, denoise } = e.data;
  try {
    const pgm = prep(bmp, W, H, quarter, denoise);
    (self as unknown as Worker).postMessage({ id, pgm }, [pgm.buffer]);
  } catch (er) {
    (self as unknown as Worker).postMessage({ id, error: String((er as Error)?.message || er) });
  }
};
