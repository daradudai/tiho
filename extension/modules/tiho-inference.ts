// WXT module for the inference subsystem (auto-loaded from modules/).
//
// 1. Ships the onnxruntime-web runtime (ort-wasm-simd-threaded.asyncify.{mjs,wasm})
//    from node_modules into `ort/` — MV3 forbids remote code, so nothing may
//    come from a CDN at runtime. (The asyncify build contains both the WASM CPU
//    EP and the WebGPU EP; it is what `onnxruntime-web/webgpu` loads.)
// 2. Bundled model (public/models/tiho-lite/): included when present unless
//    TIHO_BUNDLE_MODEL=0. Only the files of the variants in TIHO_MODEL_VARIANTS
//    (default "q8,uint8", looked up in its config.json `tiho.files`) are copied;
//    "all" = every onnx file except the 560 MB fp32 reference model.onnx.
//    Without a bundled model the worker downloads from WXT_TIHO_MODEL_URL
//    (REMOTE_MODEL_URL in src/inference/config.ts) when set, and runs rules-only
//    otherwise. Such a build pins the sha256 and size of every file it may fetch
//    (__TIHO_MODEL_PINS__), computed from the same model folder, so it needs that
//    folder at build time: TIHO_BUNDLE_MODEL=0 keeps it out of the zip.
// 3. The bench page (src/entrypoints/bench) is only built with TIHO_BENCH=1.
// 4. Cross-origin isolation for extension pages (COOP same-origin + COEP
//    credentialless) so ORT's WASM backend can use threads (SharedArrayBuffer)
//    in the offscreen document. Disable with TIHO_COI=0.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { addViteConfig, defineWxtModule } from 'wxt/modules';

const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
const MODEL_DIR = 'models/tiho-lite/';
/** Model files besides the onnx ones (what the worker fetches first). */
const MODEL_META = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];

/** `tiho.files` of the model folder's config.json (variant → path relative to the folder); {} without one. */
function modelFiles(dir: string): Record<string, string> {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')) as { tiho?: { files?: Record<string, string> } };
    return cfg.tiho?.files ?? {};
  } catch {
    return {};
  }
}

function sha256File(file: string): { sha256: string; size: number } {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.alloc(1 << 22);
  const fd = fs.openSync(file, 'r');
  let size = 0;
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; size += n) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), size };
}

export default defineWxtModule({
  name: 'tiho-inference',
  setup(wxt) {
    const env = process.env;
    const bundleModel = env.TIHO_BUNDLE_MODEL !== '0';
    const modelDir = path.join(wxt.config.publicDir, MODEL_DIR);
    const variantsEnv = (env.TIHO_MODEL_VARIANTS ?? 'q8,uint8').trim();
    const allowAll = variantsEnv === 'all';
    const variantFiles = modelFiles(modelDir);
    // onnx files to ship (paths relative to the model folder); with "all", every one but model.onnx
    const allowed = new Set(
      allowAll
        ? []
        : variantsEnv
            .split(',')
            .map((v) => variantFiles[v.trim()])
            .filter((f): f is string => !!f),
    );
    const isShipped = (rel: string) =>
      !rel.includes('onnx/') || (allowAll ? path.posix.basename(rel) !== 'model.onnx' : allowed.has(rel));
    const bench = env.TIHO_BENCH === '1';
    const coi = env.TIHO_COI !== '0';

    // Remote model source: pin every file the worker may fetch from it.
    let pins: Record<string, { sha256: string; size: number }> | null = null;
    if (env.WXT_TIHO_MODEL_URL) {
      if (!fs.existsSync(path.join(modelDir, 'config.json')))
        throw new Error(
          `[tiho-inference] WXT_TIHO_MODEL_URL needs the model folder at build time (${modelDir}) to pin its files' hashes; ` +
            'set TIHO_BUNDLE_MODEL=0 to leave it out of the build',
        );
      const onnx = allowAll ? Object.values(variantFiles).filter((f) => path.posix.basename(f) !== 'model.onnx') : [...allowed];
      pins = {};
      for (const rel of [...MODEL_META, ...onnx]) {
        const abs = path.join(modelDir, rel);
        if (fs.existsSync(abs)) pins[rel] = sha256File(abs);
      }
    }

    // Use ORT's "extern wasm" build: same code, but it does not embed the wasm
    // factory nor reference the .wasm via new URL(…, import.meta.url) — so Vite
    // does not emit a second 27 MB copy; we load both files from ort/ ourselves.
    // The remote model pins become a compile-time constant (src/inference/config.ts).
    addViteConfig(wxt, () => ({
      define: { __TIHO_MODEL_PINS__: JSON.stringify(pins) },
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
        if (!fs.existsSync(src)) throw new Error(`[tiho-inference] missing ${src} (npm install?)`);
        files.push({ absoluteSrc: src, relativeDest: `ort/${f}` });
      }
      // bundled model files
      for (let i = files.length - 1; i >= 0; i--) {
        const dest = files[i]!.relativeDest.replace(/\\/g, '/');
        if (!dest.startsWith('models/')) continue;
        const keep =
          bundleModel && dest.startsWith(MODEL_DIR) && isShipped(dest.slice(MODEL_DIR.length)) && !dest.endsWith('tiho_export.json');
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
