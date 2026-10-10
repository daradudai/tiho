// Inference configuration. Everything model-specific comes from the model's
// own config.json (`hush` block written by ml/export/export_onnx.py).

/** Folder name of the bundled dev model (extension/public/models/<name>/). */
export const LOCAL_MODEL_DIR = 'models/hush-lite/';

/**
 * Production model source: a Hugging Face repo "resolve" URL (pin a tag or
 * commit so cached files never go stale), or any static host with the same
 * layout (config.json, tokenizer.json, tokenizer_config.json, onnx/*.onnx)
 * that serves CORS. Override at build time with WXT_HUSH_MODEL_URL.
 * The bundled local copy (dev builds) always wins when present.
 */
export const REMOTE_MODEL_URL: string =
  (import.meta.env?.WXT_HUSH_MODEL_URL as string | undefined) ??
  'https://huggingface.co/hush-chat/hush-lite/resolve/main/';

/** Cache Storage bucket for downloaded model files (remote source only). */
export const MODEL_CACHE = 'hush-models-v1';

/** onnxruntime-web runtime files copied into the build by modules/hush-inference.ts. */
export const ORT_DIR = 'ort/';
export const ORT_WASM = 'ort-wasm-simd-threaded.asyncify.wasm';
export const ORT_MJS = 'ort-wasm-simd-threaded.asyncify.mjs';

export type Device = 'webgpu' | 'wasm';

/**
 * Model file preference per backend, best first; the first one listed in
 * config.hush.files (and supported by the device) is used. See
 * tests/bench/RESULTS.md for the measurements behind this order.
 * - q8:    fp32 activations, int8 weight-only MatMulNBits, int8 embeddings (147 MB, ~lossless).
 * - q8f16: same with fp16 activations (144 MB, ~lossless) — not faster on WebGPU in our runs.
 * - uint8: classic dynamic int8 (MatMulInteger) — ~2x faster than MatMulNBits in WASM,
 *          but ~0.7% of label decisions flip vs fp32.
 * - fp16:  281 MB, exact; only if nothing smaller is shipped.
 */
export const VARIANT_PREFERENCE: Record<Device, string[]> = {
  webgpu: ['q8', 'q8f16', 'fp16', 'q4f16', 'fp32'],
  wasm: ['uint8', 'q8', 'q4', 'fp32'],
};

export interface InferenceTuning {
  /** Max unique texts per flush. */
  maxBatch: number;
  /** Max time the oldest queued text waits for company (≈ 1 frame). */
  maxWaitMs: number;
  /** Worker-side score cache (normalized text → scores). */
  cacheSize: number;
  /** Reject new texts while this many are queued. */
  maxQueue: number;
  /** Fixed cost of one forward call in padded-token equivalents (bucketing). */
  bucketOverhead: Record<Device, number>;
  /** Free model memory after this long without requests (0 = never). */
  idleDisposeMs: number;
  /** Max characters fed to the tokenizer (64 tokens never need more). */
  maxChars: number;
}

export const DEFAULT_TUNING: InferenceTuning = {
  maxBatch: 64,
  maxWaitMs: 12,
  cacheSize: 20_000,
  maxQueue: 4096,
  bucketOverhead: { webgpu: 384, wasm: 24 },
  idleDisposeMs: 10 * 60_000,
  maxChars: 1024,
};
