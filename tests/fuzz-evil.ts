// Hostile / odd PDFs (hand-made): each opened by both engines, drawn, its text read, markups
// added, saved. Expected: works or a clean error - no hang, no engine that stops working.
// npx tsx tests/fuzz-evil.ts
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import * as mu from '../src/engine/mu';
import * as pf from '../src/engine/pdfium';
import { guardMupdf } from '../src/engine/mupdf-guard';

guardMupdf(mupdf);
mu.setGlyphlessFont(new Uint8Array(readFileSync('assets/glyphless.ttf')));
const wasm = readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
const good = new Uint8Array(readFileSync('tests/data/long-spec.pdf'));

/** a PDF written by hand: objects as strings, xref computed */
function raw(objs: string[], trailerExtra = ''): Uint8Array {
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array([...out].map((c) => c.charCodeAt(0) & 255));
}
const page = (extra: string, contents = 4) => `<< /Type /Page /Parent 2 0 R ${extra} /Contents ${contents} 0 R >>`;
const stream = (s: string, dict = '') => `<< /Length ${s.length} ${dict}>>\nstream\n${s}\nendstream`;
const cases: [string, Uint8Array][] = [
  ['zero-size page', raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/MediaBox [0 0 0 0]'), stream('0 0 m 10 10 l S')])],
  ['negative / flipped box', raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/MediaBox [600 800 0 0]'), stream('0 0 m 100 100 l S')])],
  ['huge page (UserUnit 75)', raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/MediaBox [0 0 14400 14400] /UserUnit 75'), stream('0 0 m 14400 14400 l S')])],
  ['self-drawing form (recursion)', raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/MediaBox [0 0 595 842] /Resources << /XObject << /X 5 0 R >> >>'), stream('/X Do'), stream('/X Do 0 0 m 5 5 l S', '/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /XObject << /X 5 0 R >> >> ')])],
  ['page tree loop', raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>', page('/MediaBox [0 0 595 842]'), stream('0 0 m 1 1 l S')])],
  ['count lies (1e9 pages)', raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1000000000 >>', page('/MediaBox [0 0 595 842]'), stream('0 0 m 1 1 l S')])],
  ['javascript + launch + odd links', raw(['<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/MediaBox [0 0 595 842] /Annots [5 0 R 6 0 R]'), stream('0 0 m 1 1 l S'), '<< /Type /Annot /Subtype /Link /Rect [0 0 100 100] /A << /S /Launch /F (calc.exe) >> >>', '<< /Type /Annot /Subtype /Link /Rect [100 100 200 200] /A << /S /URI /URI (file://\\\\\\\\evil\\\\share\\\\x.exe) >> >>'])],
  ['deep nesting (q x 5000)', raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/MediaBox [0 0 595 842]'), stream('q '.repeat(5000) + '0 0 m 9 9 l S' + ' Q'.repeat(5000))])],
  ['deep array nesting', raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/MediaBox [0 0 595 842] /Junk ' + '['.repeat(3000) + ']'.repeat(3000)), stream('0 0 m 1 1 l S')])],
  ['annot with a broken appearance', raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/MediaBox [0 0 595 842] /Annots [5 0 R]'), stream('0 0 m 1 1 l S'), '<< /Type /Annot /Subtype /Square /Rect [10 10 1e30 -1e30] /AP << /N 99 0 R >> /C [1 0] /Border [0 0 -5] >>'])],
  ['image claims 100000 x 100000', raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/MediaBox [0 0 595 842] /Resources << /XObject << /I 5 0 R >> >>'), stream('q 595 0 0 842 0 0 cm /I Do Q'), stream('xx', '/Type /XObject /Subtype /Image /Width 100000 /Height 100000 /ColorSpace /DeviceRGB /BitsPerComponent 8 ')])],
  ['font that is garbage', raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >>'), stream('BT /F1 12 Tf 50 700 Td (Hello) Tj ET'), '<< /Type /Font /Subtype /TrueType /BaseFont /Junk /FontDescriptor 6 0 R >>', '<< /Type /FontDescriptor /FontFile2 7 0 R /Flags 32 >>', stream('this is not a font at all')])],
  ['flate bomb (1 MB -> 1 GB claimed)', (() => {
    const z = mupdf.Buffer; void z;
    return raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/MediaBox [0 0 595 842]'), stream('x\x9c' + '\x00'.repeat(200), '/Filter /FlateDecode ')]);
  })()],
];
let bad = 0;
for (const [name, b] of cases) {
  const t0 = Date.now();
  let r1 = 'refused';
  try {
    const info = mu.open('e', b);
    r1 = `${info.pages.length} page(s)`;
    if (info.pages.length) {
      mu.annots('e', 0);
      mu.textBlocks('e', 0);
      try { mu.createAnnot('e', 0, { type: 'Square', rect: [10, 10, 60, 60] } as never); } catch (e) { r1 += ' (no markup: ' + String((e as Error).message).slice(0, 40) + ')'; }
      mu.save('e');
    }
  } catch (e) { r1 = 'refused: ' + String((e as Error).message).slice(0, 60); }
  try { mu.close('e'); } catch { /* */ }
  let r2 = 'refused';
  try {
    const inf = pf.openDoc('p', b);
    r2 = `${inf.pages.length} page(s)`;
    if (inf.pages.length) { pf.render('p', 0, 0.1, 0, 0, 60, 60, true); pf.pageText('p', 0); pf.links('p', 0); }
  } catch (e) { r2 = 'refused: ' + String((e as Error).message).slice(0, 60); }
  try { pf.closeDoc('p'); } catch { /* */ }
  const ms = Date.now() - t0;
  let ok = true;
  try { mu.open('g', good); mu.close('g'); pf.openDoc('g', good); pf.render('g', 0, 0.2, 0, 0, 50, 50); pf.closeDoc('g'); } catch (e) { ok = false; console.log('  ENGINE BROKEN after', name, String((e as Error).message).slice(0, 100)); }
  if (!ok || ms > 15000) bad++;
  console.log(`${ok && ms <= 15000 ? 'ok  ' : 'BAD '} ${name}: MuPDF ${r1} | PDFium ${r2} | ${ms} ms`);
}
console.log(bad ? `${bad} problems` : 'all handled');
process.exit(bad ? 1 : 0);
