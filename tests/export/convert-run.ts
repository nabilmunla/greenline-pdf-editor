import * as mupdf from 'mupdf';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ExportJob } from '../../src/engine/convert/index';
import { median, flatten, unline } from '../../src/ui/ocrprep';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const [inp, out] = args;
if (!inp || !out) { console.error('usage: convert.mjs in.pdf out.xlsx|out.docx'); process.exit(2); }
const doc = mupdf.Document.openDocument(readFileSync(inp), 'application/pdf');
const job = new ExportJob(doc, { format: out.toLowerCase().endsWith('.docx') ? 'docx' : 'xlsx', sheets: flags.has('--pages-sheets') ? 'pages' : 'joined', title: path.basename(inp).replace(/\.pdf$/i, '') });
const t0 = performance.now();
let tess: any = null;
async function ocr(i: number) {
  if (!tess) {
    const { createWorker } = await import('tesseract.js');
    tess = await createWorker(['eng', 'ara'], 1, { langPath: path.join(here, '../../public/ocr/lang'), gzip: true, cacheMethod: 'none' } as any);
    await tess.setParameters({ preserve_interword_spaces: '1' });
  }
  const p = doc.loadPage(i);
  const b = p.getBounds();
  const s = 300 / 72;
  const pix = p.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceGray, false, true);
  const W = pix.getWidth(), H = pix.getHeight();
  // the app's OCR preparation: speckle out (median), contrast stretched (src/ui/ocrprep.ts)
  const src = pix.getPixels(), st = pix.getStride();
  let grey = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grey[y * W + x] = src[y * st + x];
  grey = median(grey, W, H, 1);
  grey = unline(flatten(grey, W, H), W, H);
  const hist = new Uint32Array(256); for (const v of grey) hist[v]++;
  let lo = 0, hi = 255, acc = 0; const n = W * H;
  while (lo < 255 && (acc += hist[lo]) < n * 0.005) lo++;
  acc = 0; while (hi > 0 && (acc += hist[hi]) < n * 0.02) hi--;
  if (hi - lo > 40 && (lo > 10 || hi < 245)) { const k = 255 / (hi - lo); for (let i = 0; i < n; i++) grey[i] = Math.max(0, Math.min(255, Math.round((grey[i] - lo) * k))); }
  const head = Buffer.from(`P5\n${W} ${H}\n255\n`);
  const png = Buffer.concat([head, Buffer.from(grey)]);
  const r = await tess.recognize(png, { rotateAuto: true }, { blocks: true, text: false });
  const angle = r.data.rotateRadians || 0;
  const cx = W / 2, cy = H / 2, ca = Math.cos(-angle), sa = Math.sin(-angle);
  const unrot = (x: number, y: number) => [cx + (x - cx) * ca - (y - cy) * sa, cy + (x - cx) * sa + (y - cy) * ca];
  const words: { text: string; box: number[]; conf: number }[] = [];
  for (const bl of r.data.blocks || []) for (const pa of bl.paragraphs) for (const ln of pa.lines) for (const wd of ln.words) {
    const t = wd.text.trim();
    if (!t || wd.confidence < 20) continue;
    const pts = [[wd.bbox.x0, wd.bbox.y0], [wd.bbox.x1, wd.bbox.y0], [wd.bbox.x1, wd.bbox.y1], [wd.bbox.x0, wd.bbox.y1]].map(([x, y]) => (angle ? unrot(x, y) : [x, y]));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    words.push({ text: t, conf: wd.confidence, box: [Math.min(...xs) / s, Math.min(...ys) / s, Math.max(...xs) / s, Math.max(...ys) / s] });
  }
  void b;
  return { words, angle };
}
// OCR_CACHE=dir: keep each page's OCR words (keyed by the file, the page and the preparation code)
// so layout work on real scans doesn't wait for Tesseract every run
const cacheDir = process.env.OCR_CACHE;
const fileKey = cacheDir ? createHash('sha1').update(readFileSync(inp)).update(readFileSync(path.join(here, '../../src/ui/ocrprep.ts'))).update(readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16) : '';
async function ocrCached(i: number) {
  if (!cacheDir) return ocr(i);
  const f = path.join(cacheDir, `${fileKey}-${i}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const r = await ocr(i);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(f, JSON.stringify(r));
  return r;
}
let scans = 0;
for (let i = 0; i < job.count(); i++) {
  const r = job.read(i);
  if (r.kind === 'scan' && !r.words) {
    if (flags.has('--no-ocr')) { job.picture(i); continue; }
    scans++;
    job.addOcr(i, await ocrCached(i));
  }
}
const t1 = performance.now();
writeFileSync(out, job.finish());
if (tess) await tess.terminate();
console.error(`pages ${job.count()} scans ${scans} read ${(t1 - t0).toFixed(0)} ms write ${(performance.now() - t1).toFixed(0)} ms`);
