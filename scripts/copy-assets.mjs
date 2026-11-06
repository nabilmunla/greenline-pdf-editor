// Copies engine files into public/ (served by the app; nothing is fetched from the internet).
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const pub = 'public';
mkdirSync(join(pub, 'ocr', 'core'), { recursive: true });
mkdirSync(join(pub, 'ocr', 'lang'), { recursive: true });
copyFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm', join(pub, 'pdfium.wasm'));
copyFileSync('assets/glyphless.ttf', join(pub, 'glyphless.ttf'));
copyFileSync('node_modules/tesseract.js/dist/worker.min.js', join(pub, 'ocr', 'worker.min.js'));
for (const f of readdirSync('node_modules/tesseract.js-core')) if (f.endsWith('.wasm.js')) copyFileSync(join('node_modules/tesseract.js-core', f), join(pub, 'ocr', 'core', f));
copyFileSync('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', join(pub, 'ocr', 'lang', 'eng.traineddata.gz'));
copyFileSync('node_modules/@tesseract.js-data/ara/4.0.0_best_int/ara.traineddata.gz', join(pub, 'ocr', 'lang', 'ara.traineddata.gz'));
console.log('assets copied');
