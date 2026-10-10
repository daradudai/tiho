// Dev-only build of the UI showcase (tests/ui/showcase.html).
//   npx vite build -c tests/ui/vite.config.ts   → tests/ui/.dist
//   npx vite -c tests/ui/vite.config.ts          → dev server
import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  base: './',
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  resolve: { alias: { react: 'preact/compat', 'react-dom': 'preact/compat' } },
  build: {
    outDir: path.resolve(import.meta.dirname, '.dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: path.resolve(import.meta.dirname, 'showcase.html') },
    chunkSizeWarningLimit: 4096,
  },
  server: { port: 5199 },
});
