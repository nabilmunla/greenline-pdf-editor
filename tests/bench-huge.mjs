import * as mupdf from 'mupdf';
import { init } from '@embedpdf/pdfium';
import fs from 'node:fs';
const T = () => performance.now();
const mem = () => (process.memoryUsage().rss / 1e6).toFixed(0) + ' MB rss';
const file = process.argv[2], mode = process.argv[3];
if (mode === 'mupdf') {
  const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; let reads = 0, bytes = 0;
  const stm = new mupdf.Stream({ fileSize: () => size, read(memory, offset, length, position) { reads++; const n = fs.readSync(fd, memory, offset, length, position); bytes += n; return n; }, close() {} });
  let t = T(); const doc = mupdf.Document.openDocument(stm, 'application/pdf'); const n = doc.countPages();
  console.log('mupdf stream open', (T() - t).toFixed(0), 'ms pages', n, mem(), 'read', (bytes / 1e6).toFixed(1), 'MB in', reads, 'reads');
  t = T(); const pg = doc.loadPage(0); const b = pg.getBounds(); const s = 1024 / Math.max(b[2], b[3]);
  const pix = pg.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, false);
  console.log('mupdf page0 preview', pix.getWidth() + 'x' + pix.getHeight(), (T() - t).toFixed(0), 'ms', mem(), 'read', (bytes / 1e6).toFixed(1), 'MB');
  t = T(); const z = 4; const tp = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [Math.round(b[2]*z/2), Math.round(b[3]*z/2), Math.round(b[2]*z/2)+512, Math.round(b[3]*z/2)+512], false); tp.clear(); const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, tp); pg.run(dev, mupdf.Matrix.scale(z, z)); dev.close();
  console.log('mupdf zoom tile 4x', (T() - t).toFixed(0), 'ms', mem());
  if (n > 50) { t = T(); for (let i = 100; i < 110; i++) { const p = doc.loadPage(i); const bb = p.getBounds(); const ss = 1024 / Math.max(bb[2], bb[3]); p.toPixmap(mupdf.Matrix.scale(ss, ss), mupdf.ColorSpace.DeviceRGB, false, false); } console.log('mupdf 10 previews', (T() - t).toFixed(0), 'ms', mem()); }
} else {
  const wasm = fs.readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
  const P = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) }); P.PDFiumExt_Init();
  const M = P.pdfium;
  const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; let bytes = 0;
  const getBlock = M.addFunction((param, pos, buf, len) => { const n = fs.readSync(fd, M.HEAPU8, buf, len, pos); bytes += n; return n === len ? 1 : 0; }, 'iiiii');
  const fa = M.wasmExports.malloc(12);
  M.setValue(fa, size, 'i32'); M.setValue(fa + 4, getBlock, 'i32'); M.setValue(fa + 8, 0, 'i32');
  let t = T(); const doc = P.FPDF_LoadCustomDocument(fa, 0);
  console.log('pdfium custom open', (T() - t).toFixed(0), 'ms doc', doc, 'err', P.FPDF_GetLastError(), 'pages', P.FPDF_GetPageCount(doc), mem(), 'read', (bytes / 1e6).toFixed(1), 'MB');
  t = T(); const p = P.FPDF_LoadPage(doc, 0); const w = P.FPDF_GetPageWidthF(p), h = P.FPDF_GetPageHeightF(p); const s = 1024 / Math.max(w, h);
  const W = Math.round(w * s), H = Math.round(h * s); const bm = P.FPDFBitmap_Create(W, H, 1); P.FPDFBitmap_FillRect(bm, 0, 0, W, H, 0xffffffff); P.FPDF_RenderPageBitmap(bm, p, 0, 0, W, H, 0, 0x10); P.FPDFBitmap_Destroy(bm);
  console.log('pdfium page0 preview', W + 'x' + H, (T() - t).toFixed(0), 'ms', mem(), 'read', (bytes / 1e6).toFixed(1), 'MB');
  t = T(); const z = 4; const bm2 = P.FPDFBitmap_Create(512, 512, 1); P.FPDFBitmap_FillRect(bm2, 0, 0, 512, 512, 0xffffffff); P.FPDF_RenderPageBitmap(bm2, p, -Math.round(w * z / 2), -Math.round(h * z / 2), Math.round(w * z), Math.round(h * z), 0, 0x10); P.FPDFBitmap_Destroy(bm2);
  console.log('pdfium zoom tile 4x', (T() - t).toFixed(0), 'ms', mem());
  const n = P.FPDF_GetPageCount(doc);
  if (n > 50) { t = T(); for (let i = 100; i < 110; i++) { const q = P.FPDF_LoadPage(doc, i); const ww = P.FPDF_GetPageWidthF(q), hh = P.FPDF_GetPageHeightF(q); const ss = 1024 / Math.max(ww, hh); const b3 = P.FPDFBitmap_Create(Math.round(ww*ss), Math.round(hh*ss), 1); P.FPDF_RenderPageBitmap(b3, q, 0, 0, Math.round(ww*ss), Math.round(hh*ss), 0, 0x10); P.FPDFBitmap_Destroy(b3); P.FPDF_ClosePage(q); } console.log('pdfium 10 previews', (T() - t).toFixed(0), 'ms', mem()); }
}
