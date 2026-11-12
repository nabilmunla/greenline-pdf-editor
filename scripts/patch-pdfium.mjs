// Makes the PDFium drawing engine able to use 4 GB instead of 2 GB (0.9.7).
//
// @embedpdf/pdfium is built for at most 2 GB: its JavaScript side reads memory addresses as
// signed numbers (an address past 2 GB comes out negative and reads or writes nothing), and it
// refuses to grow past 2 GB. This writes a patched copy of its JavaScript to
// src/engine/vendor/pdfium-4gb.js, doing what Emscripten itself does for a 4 GB build:
//  - the growth limit is 4 GB less one 64 KB page (as Emscripten: a full 4 GB wraps to 0)
//  - memory indexes shift unsigned (`>>>`), and the helpers that take an address read it unsigned
// The .wasm's own limit (32768 pages) is raised when the engine starts (pdfium.ts liftMemoryMax).
//
// Run again after updating @embedpdf/pdfium: every patch must match exactly, or this stops.
// (tests/engine.test.ts checks the copy is from the installed version.)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const PKG = 'node_modules/@embedpdf/pdfium';
const version = JSON.parse(readFileSync(`${PKG}/package.json`, 'utf8')).version;
let s = readFileSync(`${PKG}/dist/index.js`, 'utf8');

/** replace `from` with `to` exactly `n` times (a mismatch means the glue changed: stop) */
function rep(from, to, n = 1) {
  const got = s.split(from).length - 1;
  if (got !== n) throw new Error(`patch-pdfium: expected ${n} of ${JSON.stringify(from)}, found ${got}`);
  s = s.split(from).join(to);
}
/** add `code` at the start of the body of the function opened by `head` */
const enter = (head, code) => rep(head, `${head}\n      ${code}`);

// 1. the growth limit
rep('      // casing all heap size related code to treat 0 specially.\n      2147483648;',
  '      // casing all heap size related code to treat 0 specially.\n      4294901760; // (patched: 4 GB build)');

// 2. memory indexes: unsigned shifts (an address past 2 GB, signed, is negative)
let shifts = 0;
s = s.replace(/(HEAP\w*\[[^\]]*?\))>>([0-3])\)\]/g, (_m, a, b) => { shifts++; return `${a}>>>${b})]`; });
if (shifts < 80) throw new Error(`patch-pdfium: only ${shifts} memory indexes found`);
if (/HEAP\w*\[[^\]]*[^>]>>[0-3][^\]]*\]/.test(s)) throw new Error('patch-pdfium: a signed memory index is left');

// (an address halved outside a memory index: UTF16ToString's end - a slower fallback found the
// string anyway, but it's an address)
rep('var idx = endPtr >> 1;', 'var idx = endPtr >>> 1;');
if (/\b\w*(?:[pP]tr|[aA]ddr|[bB]uf)\w*\s*>>\s*[0-3]\b/.test(s)) throw new Error('patch-pdfium: an address is shifted signed: ' + s.match(/.{40}\b\w*(?:[pP]tr|[aA]ddr|[bB]uf)\w*\s*>>\s*[0-3]\b.{10}/)[0]);

// 3. helpers that take an address: read it unsigned
enter('function getValue(ptr, type = \'i8\') {', 'ptr >>>= 0;');
enter('function setValue(ptr, value, type = \'i8\') {', 'ptr >>>= 0;');
enter('var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead = NaN) => {', 'idx >>>= 0;');
enter('var UTF8ToString = (ptr, maxBytesToRead) => {', 'ptr >>>= 0;');
enter('var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {', 'outIdx >>>= 0;');
enter('var stringToUTF8 = (str, outPtr, maxBytesToWrite) => {', 'outPtr >>>= 0;');
enter('var UTF16ToString = (ptr, maxBytesToRead) => {', 'ptr >>>= 0;');
enter('var stringToUTF16 = (str, outPtr, maxBytesToWrite) => {', 'outPtr >>>= 0;');
enter('var zeroMemory = (address, size) => {', 'address >>>= 0;');
enter('var writeArrayToMemory = (array, buffer) => {', 'buffer >>>= 0;');
rep('var __emscripten_memcpy_js = (dest, src, num) => HEAPU8.copyWithin(dest, src, src + num);',
  'var __emscripten_memcpy_js = (dest, src, num) => { dest >>>= 0; src >>>= 0; num >>>= 0; HEAPU8.copyWithin(dest, src, src + num); };');
for (const [head, code] of OPTIONAL()) if (s.includes(head)) enter(head, code);

function OPTIONAL() {
  // (present in some Emscripten versions; patched when there)
  return [
    ['var stringToAscii = (str, buffer) => {', 'buffer >>>= 0;'],
    ['var writeAsciiToMemory = (str, buffer, dontAddNull) => {', 'buffer >>>= 0;'],
    ['var UTF32ToString = (ptr, maxBytesToRead) => {', 'ptr >>>= 0;'],
    ['var stringToUTF32 = (str, outPtr, maxBytesToWrite) => {', 'outPtr >>>= 0;'],
  ];
}
// (the file system calls - stat, getdents, open... - use the indexes above; PDFium reads its
// files through our own block reader, never the file system)
if (!s.includes('ptr >>>= 0') || !s.includes('4294901760')) throw new Error('patch-pdfium: not patched');

mkdirSync('src/engine/vendor', { recursive: true });
writeFileSync('src/engine/vendor/pdfium-4gb.js',
  `// @embedpdf/pdfium ${version}, patched for 4 GB by scripts/patch-pdfium.mjs - do not edit; run the script again.\n` +
  `export const PATCHED_FROM = ${JSON.stringify(version)};\n` + s);
writeFileSync('src/engine/vendor/pdfium-4gb.d.ts',
  `// types: the package's own (this is its JavaScript, patched)\nexport { init, DEFAULT_PDFIUM_WASM_URL } from '@embedpdf/pdfium';\nexport declare const PATCHED_FROM: string;\n`);
console.log(`pdfium ${version} patched: ${shifts} memory indexes`);
