import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['mupdf'] },
});
