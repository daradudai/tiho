// Bundle tests/stress/harness.ts (runtime + adapters + bar) into .out/harness.js
// (IIFE, minified like the production content script) and copy the mock pages.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, '.out');

export async function buildHarness({ minify = true } = {}) {
  fs.mkdirSync(out, { recursive: true });
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    publicDir: false,
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
    resolve: { alias: { react: 'preact/compat', 'react-dom': 'preact/compat' } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      target: 'es2022',
      outDir: out,
      emptyOutDir: false,
      minify,
      sourcemap: false,
      lib: {
        entry: path.join(here, 'harness.ts'),
        formats: ['iife'],
        name: 'TihoStress',
        fileName: () => 'harness.js',
      },
    },
  });
  for (const f of ['twitch.html', 'youtube.html', 'mock.js']) fs.copyFileSync(path.join(here, 'mock', f), path.join(out, f));
  const corpus = path.join(here, '.corpus', 'corpus.json');
  if (!fs.existsSync(corpus)) throw new Error('missing corpus: run `node tests/stress/make-corpus.mjs` first');
  fs.copyFileSync(corpus, path.join(out, 'corpus.json'));
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildHarness();
  const size = fs.statSync(path.join(out, 'harness.js')).size;
  console.log(`harness.js ${(size / 1024).toFixed(1)} kB → ${out}`);
}
