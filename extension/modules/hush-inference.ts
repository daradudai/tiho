// WXT module for the inference subsystem (auto-loaded from modules/).
//
// 1. Ships the onnxruntime-web runtime (ort-wasm-simd-threaded.asyncify.{mjs,wasm})
//    from node_modules into `ort/` — MV3 forbids remote code, so nothing may
//    come from a CDN at runtime. (The asyncify build contains both the WASM CPU
//    EP and the WebGPU EP; it is what `onnxruntime-web/webgpu` loads.)
// 2. Bundled model (public/models/hush-lite/): included when present unless
//    HUSH_BUNDLE_MODEL=0. Only the files the extension can pick are copied
//    (HUSH_MODEL_VARIANTS, default "q8,uint8"; "all" = every onnx file except
//    the 560 MB fp32 reference model.onnx). Without a bundled model the worker downloads from
//    REMOTE_MODEL_URL (src/inference/config.ts) and caches it.
// 3. The bench page (src/entrypoints/bench) is only built with HUSH_BENCH=1.
// 4. Cross-origin isolation for extension pages (COOP same-origin + COEP
//    credentialless) so ORT's WASM backend can use threads (SharedArrayBuffer)
//    in the offscreen document. Disable with HUSH_COI=0.

import fs from 'node:fs';
import path from 'node:path';
import { addViteConfig, defineWxtModule } from 'wxt/modules';

const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
const VARIANT_FILES: Record<string, string> = {
  fp32: 'model.onnx',
  fp16: 'model_fp16.onnx',
  q8f16: 'model_q8f16.onnx',
  q8: 'model_quantized.onnx',
  uint8: 'model_uint8.onnx',
  q4: 'model_q4.onnx',
  q4f16: 'model_q4f16.onnx',
  q8a4: 'model_q8a4.onnx',
};

export default defineWxtModule({
  name: 'hush-inference',
  setup(wxt) {
    const env = process.env;
    const bundleModel = env.HUSH_BUNDLE_MODEL !== '0';
    const variantsEnv = (env.HUSH_MODEL_VARIANTS ?? 'q8,uint8').trim();
    const allowAll = variantsEnv === 'all';
    const allowed =
      allowAll
        ? new Set<string>()
        : new Set(
            variantsEnv
              .split(',')
              .map((v) => VARIANT_FILES[v.trim()])
              .filter(Boolean),
          );
    const bench = env.HUSH_BENCH === '1';
    const coi = env.HUSH_COI !== '0';

    // Use ORT's "extern wasm" build: same code, but it does not embed the wasm
    // factory nor reference the .wasm via new URL(…, import.meta.url) — so Vite
    // does not emit a second 27 MB copy; we load both files from ort/ ourselves.
    addViteConfig(wxt, () => ({
      resolve: {
        alias: [
          {
            find: /^onnxruntime-web\/webgpu$/,
            replacement: path.resolve(wxt.config.root, 'node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs'),
          },
        ],
      },
    }));

    wxt.hooks.hook('entrypoints:resolved', (_wxt, entrypoints) => {
      for (const e of entrypoints) if (e.name === 'bench' && !bench) e.skipped = true;
    });

    wxt.hooks.hook('build:publicAssets', (_wxt, files) => {
      // onnxruntime-web runtime
      const ortDist = path.resolve(wxt.config.root, 'node_modules/onnxruntime-web/dist');
      for (const f of ORT_FILES) {
        const src = path.join(ortDist, f);
        if (!fs.existsSync(src)) throw new Error(`[hush-inference] missing ${src} (npm install?)`);
        files.push({ absoluteSrc: src, relativeDest: `ort/${f}` });
      }
      // bundled model files
      for (let i = files.length - 1; i >= 0; i--) {
        const dest = files[i]!.relativeDest.replace(/\\/g, '/');
        if (!dest.startsWith('models/')) continue;
        const keep =
          bundleModel &&
          (!dest.includes('/onnx/') ||
            (allowAll ? path.posix.basename(dest) !== 'model.onnx' : allowed.has(path.posix.basename(dest)))) &&
          !dest.endsWith('hush_export.json');
        if (!keep) files.splice(i, 1);
      }
    });

    if (coi) {
      wxt.hooks.hook('build:manifestGenerated', (_wxt, manifest) => {
        const m = manifest as Record<string, unknown>;
        m.cross_origin_opener_policy ??= { value: 'same-origin' };
        m.cross_origin_embedder_policy ??= { value: 'credentialless' };
      });
    }
  },
});
