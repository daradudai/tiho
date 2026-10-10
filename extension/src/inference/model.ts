// Hush Lite model: tokenizer (transformers.js) + ONNX Runtime Web session.
//
// Runs inside the inference worker. We use transformers.js for the tokenizer
// and drive onnxruntime-web (the very module transformers.js bundles) directly
// for the session: fixed I/O (input_ids, attention_mask → logits), so we get
// full control over file choice, session options, caching and progress.
//
// Files come from the bundled copy (dev) or a remote base URL (prod) and are
// kept in Cache Storage keyed by URL + model version.

import * as ort from 'onnxruntime-web/webgpu';
import { PreTrainedTokenizer, env as tjsEnv } from '@huggingface/transformers';
import { LABELS } from '../core/types';
import { MODEL_CACHE, ORT_MJS, ORT_WASM, VARIANT_PREFERENCE, type Device } from './config';
import { webgpuInfo } from './gpu';

export interface HushModelConfig {
  labels: string[];
  thresholds?: Record<string, number> | number[];
  max_len?: number;
  /** alias written by training */
  max_length?: number;
  files: Record<string, string>;
  sizes?: Record<string, number>;
  version?: string;
  placeholder?: boolean;
  /**
   * Per-file overrides when variants are different students sharing one
   * tokenizer (e.g. a 6-layer model for WebGPU and a 3-layer one for WASM):
   * each variant is calibrated separately.
   */
  variant_thresholds?: Record<string, Record<string, number> | number[]>;
  variant_info?: Record<string, { layers?: number; version?: string }>;
}

export interface LoadProgress {
  phase: 'downloading' | 'loading';
  /** 0..1, download phase only */
  progress?: number;
  file?: string;
}

export interface LoadOptions {
  /** Candidate base URLs, first reachable wins (local bundle, then remote). */
  bases: string[];
  ortBase: string;
  device: Device | 'auto';
  variant?: string;
  threads: number;
  onProgress?: (p: LoadProgress) => void;
  /** Called when a backend/variant attempt fails and we fall back. */
  onFallback?: (what: string, err: unknown) => void;
}

const F16_VARIANTS = new Set(['fp16', 'q8f16', 'q4f16']);

let ortConfigured = false;
function configureOrt(ortBase: string, threads: number): void {
  // Never let anything reach a CDN: MV3 forbids remote code, and we ship the runtime.
  tjsEnv.allowRemoteModels = false;
  tjsEnv.allowLocalModels = false;
  tjsEnv.useBrowserCache = false;
  ort.env.wasm.wasmPaths = { mjs: ortBase + ORT_MJS, wasm: ortBase + ORT_WASM };
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  if (ort.env.webgpu) ort.env.webgpu.powerPreference = 'high-performance';
  ortConfigured = true;
}

// ───────────────────────────── fetching ─────────────────────────────

const isHttp = (u: string) => /^https?:/i.test(u);

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches !== 'undefined' ? await caches.open(MODEL_CACHE) : null;
  } catch {
    return null;
  }
}

/** GET with progress; Cache Storage for http(s) sources keyed by `cacheKey`. */
async function fetchBytes(
  url: string,
  cacheKey: string | null,
  onBytes?: (loaded: number, total: number) => void,
  expectedSize = 0,
): Promise<Uint8Array> {
  const cache = cacheKey && isHttp(url) ? await openCache() : null;
  if (cache) {
    const hit = await cache.match(cacheKey!);
    if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      onBytes?.(buf.byteLength, buf.byteLength);
      return buf;
    }
  }
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || expectedSize || 0;
  let bytes: Uint8Array;
  if (!res.body || !onBytes) {
    bytes = new Uint8Array(await res.arrayBuffer());
  } else {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    let out: Uint8Array | null = total ? new Uint8Array(total) : null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (out && loaded + value.byteLength <= out.byteLength) out.set(value, loaded);
      else {
        if (out) {
          chunks.push(out.subarray(0, loaded));
          out = null;
        }
        chunks.push(value);
      }
      loaded += value.byteLength;
      onBytes(loaded, Math.max(total, loaded));
    }
    if (out && loaded === out.byteLength) bytes = out;
    else if (out) bytes = out.subarray(0, loaded);
    else {
      bytes = new Uint8Array(loaded);
      let o = 0;
      for (const c of chunks) {
        bytes.set(c, o);
        o += c.byteLength;
      }
    }
  }
  if (cache) {
    try {
      await cache.put(
        cacheKey!,
        new Response(bytes as Uint8Array<ArrayBuffer>, {
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) },
        }),
      );
    } catch (e) {
      console.warn('[hush] model cache put failed', e);
    }
  }
  return bytes;
}

async function fetchJson<T>(url: string, cacheKey: string | null): Promise<T> {
  // Small files: network first (picks up a new model version), cache as offline fallback.
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
    const text = await res.text();
    if (cacheKey && isHttp(url)) {
      const cache = await openCache();
      await cache?.put(cacheKey, new Response(text, { headers: { 'content-type': 'application/json' } })).catch(() => {});
    }
    return JSON.parse(text) as T;
  } catch (e) {
    if (cacheKey && isHttp(url)) {
      const hit = await (await openCache())?.match(cacheKey);
      if (hit) return (await hit.json()) as T;
    }
    throw e;
  }
}

/** Drop cached files of other model versions from this base. */
async function pruneCache(base: string, version: string): Promise<void> {
  const cache = await openCache();
  if (!cache) return;
  for (const req of await cache.keys()) {
    const u = req.url;
    if (u.startsWith(base) && !u.endsWith('.json') && !u.includes(`v=${encodeURIComponent(version)}`)) {
      await cache.delete(req);
    }
  }
}

// ───────────────────────────── model ─────────────────────────────

export class HushModel {
  /** Index into model outputs for each of LABELS (-1 = missing). */
  private readonly labelIndex: number[];
  readonly numOut: number;
  private readonly padId: number;
  private readonly eosId: number | null;
  readonly maxLen: number;
  readonly thresholds: number[];
  /** Wall time of load() incl. download, session creation and warmup. */
  loadMs = 0;

  private constructor(
    private session: ort.InferenceSession,
    readonly tokenizer: PreTrainedTokenizer,
    readonly cfg: HushModelConfig,
    readonly backend: Device,
    readonly variant: string,
    readonly base: string,
  ) {
    this.numOut = cfg.labels.length;
    this.labelIndex = LABELS.map((l) => cfg.labels.indexOf(l));
    this.maxLen = cfg.max_len || cfg.max_length || 64;
    this.padId = (tokenizer as unknown as { pad_token_id?: number }).pad_token_id ?? 0;
    const probe = tokenizer.encode('a');
    this.eosId = probe.length >= 2 ? probe[probe.length - 1]! : null;
    const t = cfg.variant_thresholds?.[variant] ?? cfg.thresholds;
    this.thresholds = LABELS.map((l, j) => {
      if (this.labelIndex[j]! < 0) return 1; // label missing from this model: never fires
      const v = Array.isArray(t) ? t[cfg.labels.indexOf(l)] : (t as Record<string, number> | undefined)?.[l];
      return typeof v === 'number' ? v : 0.5;
    });
  }

  get version(): string {
    return this.cfg.variant_info?.[this.variant]?.version ?? this.cfg.version ?? 'unknown';
  }

  /**
   * Token ids incl. special tokens, truncated to max_len (keeps the final EOS like HF truncation).
   * Whitespace runs are collapsed first: transformers.js and HF tokenizers (Rust) merge runs of
   * spaces differently for this Gemma-style BPE (~1.6% of chat lines differed); with collapsed
   * whitespace they agree on 100% of 4k sampled chat lines. Training should apply the same
   * normalization (`re.sub(r"\s+", " ", text).strip()`).
   */
  tokenize(text: string, maxChars = 1024): number[] {
    const clean = (text.length > maxChars ? text.slice(0, maxChars) : text).replace(/\s+/g, ' ').trim();
    const ids = this.tokenizer.encode(clean);
    if (ids.length <= this.maxLen) return ids;
    const cut = ids.slice(0, this.maxLen);
    if (this.eosId !== null) cut[this.maxLen - 1] = this.eosId;
    return cut;
  }

  /**
   * One forward pass over token sequences (padded to the longest).
   * Returns probabilities aligned with LABELS, row-major [B, LABELS.length].
   */
  async run(seqs: number[][]): Promise<Float32Array> {
    const B = seqs.length;
    let L = 1;
    for (const s of seqs) if (s.length > L) L = s.length;
    const ids = new BigInt64Array(B * L);
    const mask = new BigInt64Array(B * L);
    const pad = BigInt(this.padId);
    for (let b = 0; b < B; b++) {
      const s = seqs[b]!;
      const o = b * L;
      for (let i = 0; i < L; i++) {
        if (i < s.length) {
          ids[o + i] = BigInt(s[i]!);
          mask[o + i] = 1n;
        } else ids[o + i] = pad;
      }
    }
    const feeds = {
      input_ids: new ort.Tensor('int64', ids, [B, L]),
      attention_mask: new ort.Tensor('int64', mask, [B, L]),
    };
    const out = await this.session.run(feeds);
    const logitsT = out.logits!;
    const logits = (logitsT.location === 'cpu' ? logitsT.data : await logitsT.getData()) as Float32Array;
    const K = LABELS.length;
    const probs = new Float32Array(B * K);
    for (let b = 0; b < B; b++) {
      for (let j = 0; j < K; j++) {
        const src = this.labelIndex[j]!;
        if (src < 0) continue;
        const x = logits[b * this.numOut + src]!;
        probs[b * K + j] = 1 / (1 + Math.exp(-x));
      }
    }
    for (const t of Object.values(out)) t.dispose?.();
    return probs;
  }

  async dispose(): Promise<void> {
    try {
      await this.session.release();
    } catch {
      /* already gone */
    }
  }

  // ───────────────────────────── loading ─────────────────────────────

  static async load(opts: LoadOptions): Promise<HushModel> {
    const t0 = performance.now();
    if (!ortConfigured) configureOrt(opts.ortBase, opts.threads);
    else ort.env.wasm.numThreads = opts.threads;

    // 1. locate the model (first base whose config.json loads)
    let base = '';
    let config: { hush?: HushModelConfig } | null = null;
    let lastErr: unknown = null;
    for (const b of opts.bases) {
      try {
        config = await fetchJson(b + 'config.json', b + 'config.json');
        base = b;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!config) throw new Error(`model not found (${String(lastErr)})`);
    const cfg = config.hush;
    if (!cfg?.files || !cfg.labels) throw new Error('config.json has no `hush` block (export with ml/export/export_onnx.py)');
    const version = cfg.version ?? 'unversioned';
    const keyFor = (file: string) => `${base}${file}?v=${encodeURIComponent(version)}`;
    if (isHttp(base)) void pruneCache(base, version).catch(() => {});

    // 2. pick backend + file
    const gpu = opts.device === 'wasm' ? { ok: false, f16: false } : await webgpuInfo();
    const devices: Device[] =
      opts.device === 'wasm' ? ['wasm'] : opts.device === 'webgpu' ? ['webgpu'] : gpu.ok ? ['webgpu', 'wasm'] : ['wasm'];

    // Progress accounting: tokenizer + model file of the first attempt.
    let tokBytes = 0;
    let modelBytes = 0;
    let tokTotal = 0;
    let modelTotal = 0;
    const report = (file: string) => {
      const total = tokTotal + modelTotal;
      if (total > 0) opts.onProgress?.({ phase: 'downloading', progress: (tokBytes + modelBytes) / total, file });
    };

    const attempts: Array<{ device: Device; variant: string }> = [];
    for (const d of devices) {
      const prefs = opts.variant ? [opts.variant] : VARIANT_PREFERENCE[d];
      const ok = prefs.filter((v) => cfg.files[v] && (d !== 'webgpu' || !F16_VARIANTS.has(v) || gpu.f16));
      // at most two variants per device: a broken file/op support issue rarely affects both
      for (const v of ok.slice(0, 2)) attempts.push({ device: d, variant: v });
    }
    if (!attempts.length) throw new Error(`no usable model file for ${devices.join('/')}`);

    // 3. tokenizer (parallel with the first model download)
    modelTotal = cfg.sizes?.[attempts[0]!.variant] ?? 0;
    const tokP = (async () => {
      const [tj, tc] = await Promise.all([
        fetchBytes(base + 'tokenizer.json', keyFor('tokenizer.json'), (l, t) => {
          tokBytes = l;
          tokTotal = t;
          report('tokenizer.json');
        }),
        fetchJson<Record<string, unknown>>(base + 'tokenizer_config.json', base + 'tokenizer_config.json'),
      ]);
      return new PreTrainedTokenizer(JSON.parse(new TextDecoder().decode(tj)), tc);
    })();

    const fileCache = new Map<string, Uint8Array>();
    for (const a of attempts) {
      const file = cfg.files[a.variant]!;
      try {
        let bytes = fileCache.get(file);
        if (!bytes) {
          modelBytes = 0;
          modelTotal = cfg.sizes?.[a.variant] ?? modelTotal;
          bytes = await fetchBytes(
            base + file,
            keyFor(file),
            (l, t) => {
              modelBytes = l;
              modelTotal = t;
              report(file);
            },
            cfg.sizes?.[a.variant],
          );
          fileCache.set(file, bytes);
        }
        const tokenizer = await tokP;
        opts.onProgress?.({ phase: 'loading', file });
        const session = await ort.InferenceSession.create(bytes, {
          executionProviders: [a.device],
          graphOptimizationLevel: 'all',
          logSeverityLevel: 3,
        });
        const model = new HushModel(session, tokenizer, cfg, a.device, a.variant, base);
        await model.warmup();
        model.loadMs = performance.now() - t0;
        return model;
      } catch (e) {
        lastErr = e;
        opts.onFallback?.(`${a.device}/${a.variant}`, e);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Compile kernels for common shapes and sanity-check outputs (catches fp16 overflow / broken EPs). */
  private async warmup(): Promise<void> {
    const sample = ['hello chat', 'what game is this?', 'KEKW KEKW KEKW', 'que pasa', 'lol', 'gg wp'];
    const seqs = sample.map((t) => this.tokenize(t));
    for (const [b, l] of [
      [1, 0],
      [4, 0],
      [16, 24],
      [64, 12],
    ] as const) {
      const batch = Array.from({ length: b }, (_, i) => {
        const s = seqs[i % seqs.length]!;
        return l ? Array.from({ length: l }, (_, k) => s[k % s.length]!) : s;
      });
      const p = await this.run(batch);
      for (const v of p) if (!Number.isFinite(v)) throw new Error(`non-finite output on ${this.backend}/${this.variant}`);
    }
  }
}
