// Inference configuration. Everything model-specific comes from the model's
// own config.json (`hush` block written by ml/export/export_onnx.py).

/** Folder name of the bundled dev model (extension/public/models/<name>/). */
export const LOCAL_MODEL_DIR = 'models/hush-lite/';

/**
 * Remote model source for builds without the bundled copy: a base URL with the
 * same layout (config.json, tokenizer.json, tokenizer_config.json, onnx/*.onnx)
 * that serves CORS, e.g. a Hugging Face `resolve/<commit>/` URL. Set at build
 * time with WXT_HUSH_MODEL_URL. There is no default: no official mirror is
 * published yet, and a build without a model filters with rules only.
 * The bundled local copy always wins when present.
 */
export const REMOTE_MODEL_URL: string = (import.meta.env?.WXT_HUSH_MODEL_URL as string | undefined) ?? '';

/** Expected content of one model file. */
export interface FilePin {
  /** lowercase hex */
  sha256: string;
  size: number;
}

declare const __HUSH_MODEL_PINS__: Record<string, FilePin> | null | undefined;

/**
 * Every file of the remote model (path relative to REMOTE_MODEL_URL → hash),
 * computed at build time from the model folder by modules/hush-inference.ts.
 * Remote files are used only if they match, so whoever controls the host can
 * break the download but never change what runs or how it is thresholded.
 * Null when the build has no remote source.
 */
export const REMOTE_MODEL_PINS: Record<string, FilePin> | null =
  typeof __HUSH_MODEL_PINS__ === 'undefined' ? null : __HUSH_MODEL_PINS__;

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
 * - q8:    fp32 activations, int8 weight-only MatMulNBits, int8 embeddings (~lossless).
 * - q8f16: same with fp16 activations (~lossless) — not faster on WebGPU in our runs.
 * - uint8: classic dynamic int8 (MatMulInteger) — ~2x faster than MatMulNBits in WASM,
 *          but ~0.5% of label decisions flip vs fp32.
 * - fp16:  exact, about twice the size of q8; only if nothing smaller is shipped.
 * The shipped folder holds a 6-layer student for q8 / q4f16 and a 3-layer one
 * for uint8 (ml/export/combine_variants.py); sizes are in docs/MODEL_CARD.md.
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
  /** Drop a queued text nobody asked for in this long (newest go first under load). */
  maxAgeMs: number;
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
  maxAgeMs: 2000,
  bucketOverhead: { webgpu: 384, wasm: 24 },
  idleDisposeMs: 10 * 60_000,
  maxChars: 1024,
};
