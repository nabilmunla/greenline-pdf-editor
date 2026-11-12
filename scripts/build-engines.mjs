// Bundles the engine processes into electron/engines/render.mjs and edit.mjs.
// MuPDF stays a separate module next to it (it loads its .wasm from its own folder).
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
const outDir = 'electron/engines';
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'mupdf'), { recursive: true });
for (const f of ['mupdf.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm']) copyFileSync(join('node_modules/mupdf/dist', f), join(outDir, 'mupdf', f));
// (ES modules: said so - Node otherwise tried them as CommonJS first, warned and parsed them twice)
writeFileSync(join(outDir, 'mupdf', 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
// (loaded before MuPDF.js: see the file)
copyFileSync('src/engine/mupdf-pre.mjs', join(outDir, 'mupdf', 'pre.js'));
// HarfBuzz (text shaping: Arabic, PC fonts) also loads its .wasm from its own folder
mkdirSync(join(outDir, 'harfbuzz'), { recursive: true });
for (const f of ['index.mjs', 'harfbuzz.js', 'harfbuzz.wasm']) copyFileSync(join('node_modules/harfbuzzjs/dist', f), join(outDir, 'harfbuzz', f));
// (harfbuzz.js is an ES module: said so, Node read it twice at every engine start - and wrote a
// warning to the log each time)
writeFileSync(join(outDir, 'harfbuzz', 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
await build({
  entryPoints: { render: 'src/engine/host-render.ts', edit: 'src/engine/host-edit.ts' },
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  splitting: false,
  sourcemap: false,
  legalComments: 'none',
  // (./mupdf/pre.js first: imports run in the order written, before any of the bundle)
  banner: { js: "import './mupdf/pre.js'; import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [{
    name: 'mupdf-external',
    setup(b) {
      b.onResolve({ filter: /^mupdf$/ }, () => ({ path: './mupdf/mupdf.js', external: true }));
      b.onResolve({ filter: /^harfbuzzjs$/ }, () => ({ path: './harfbuzz/index.mjs', external: true }));
    },
  }],
  logLevel: 'warning',
});
// offline translator: its engine script + Mozilla's loader for the Bergamot runtime
mkdirSync(join(outDir, 'bergamot'), { recursive: true });
copyFileSync('src/engine/mt-host.mjs', join(outDir, 'translate.mjs'));
copyFileSync('vendor/bergamot/bergamot-translator.js', join(outDir, 'bergamot', 'bergamot-translator.js'));
console.log('engines built');
