import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// the build's name and look (src/ui/brand.ts): the public build's package.json carries its own
// "displayName" and "brand"; the company build has neither (PDF Editor, the company colours)
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  base: './',
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['mupdf'] },
  define: {
    __APP_NAME__: JSON.stringify(pkg.displayName || pkg.productName || 'PDF Editor'),
    __BRAND__: JSON.stringify(pkg.brand || ''),
  },
});
