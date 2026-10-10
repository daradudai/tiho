// Inference engine: model lifecycle + dynamic batching + score cache + stats.
// Hosted by the worker (worker.ts); model loading is injected so the whole
// thing is unit-testable with a fake model.

import { LRU } from '../core/lru';
import type { ClassifyItem } from '../core/protocol';
import { LABELS, type ModelBackend, type ModelStatus } from '../core/types';
import { DynamicBatcher, OverloadedError } from './batcher';
import { planBuckets } from './bucketing';
import { DEFAULT_TUNING, type Device, type InferenceTuning } from './config';
import type { InferenceStats, InitOptions, WorkerOut } from './messages';
import { LatencyRing, RateMeter } from './stats';

export interface ModelLike {
  readonly backend: Device;
  readonly variant: string;
  readonly version: string;
  readonly maxLen: number;
  readonly thresholds: number[];
  readonly loadMs: number;
  tokenize(text: string, maxChars?: number): number[];
  /** probabilities aligned with LABELS, row-major [B, LABELS.length] */
  run(seqs: number[][]): Promise<Float32Array>;
  dispose(): Promise<void>;
}

export interface LoaderHooks {
  onProgress(p: { phase: 'downloading' | 'loading'; progress?: number; file?: string }): void;
  onFallback(what: string, err: unknown): void;
}

export type ModelLoader = (opts: InitOptions, hooks: LoaderHooks) => Promise<ModelLike>;

export interface EngineEnv {
  post(msg: WorkerOut): void;
  load: ModelLoader;
  now?: () => number;
  crossOriginIsolated?: boolean;
  threads?: number;
}

const K = LABELS.length;
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

export class InferenceEngine {
  private model: ModelLike | null = null;
  private loading: Promise<ModelLike> | null = null;
  private opts: InitOptions = {};
  private tuning: InferenceTuning = DEFAULT_TUNING;
  private status: ModelStatus = { state: 'idle', backend: 'none' };
  private cache: LRU<string, number[]>;
  private batcher: DynamicBatcher<number[]>;
  private lastActivity = 0;
  private lastProgressPost = 0;
  private forceDevice: Device | null = null;
  private gpuFailures = 0;

  // stats
  private reqLat = new LatencyRing(512);
  private fwdLat = new LatencyRing(256);
  private batchSizes = new LatencyRing(256);
  private inferRate: RateMeter;
  private reqRate: RateMeter;
  private padded = 0;
  private real = 0;
  private totalInferred = 0;
  private readonly now: () => number;

  constructor(private env: EngineEnv) {
    this.now = env.now ?? (() => performance.now());
    this.inferRate = new RateMeter(5000, 250, this.now);
    this.reqRate = new RateMeter(5000, 250, this.now);
    this.cache = new LRU(this.tuning.cacheSize);
    this.batcher = this.makeBatcher();
  }

  private makeBatcher(): DynamicBatcher<number[]> {
    const t = this.tuning;
    return new DynamicBatcher<number[]>({
      maxBatch: t.maxBatch,
      maxWaitMs: t.maxWaitMs,
      maxQueue: t.maxQueue,
      cache: this.opts.cache === false ? null : this.cache,
      now: this.now,
      run: (_keys, texts) => this.infer(texts),
    });
  }

  getStatus(): ModelStatus {
    return this.status;
  }

  /** (Re)configure. Reloads the model only if backend/variant/threads changed. */
  init(opts: InitOptions): void {
    const prev = this.opts;
    this.opts = { ...prev, ...opts };
    const tuning = { ...DEFAULT_TUNING, ...opts.tuning };
    const tuningChanged = JSON.stringify(tuning) !== JSON.stringify(this.tuning);
    if (tuningChanged || prev.cache !== this.opts.cache) {
      this.tuning = tuning;
      if (this.cache.capacity !== tuning.cacheSize) this.cache = new LRU(tuning.cacheSize);
      this.batcher.failQueued(new Error('reconfigured'));
      this.batcher = this.makeBatcher();
    }
    const modelChanged =
      prev.device !== this.opts.device || prev.variant !== this.opts.variant || prev.threads !== this.opts.threads;
    if (modelChanged && (this.model || this.loading)) {
      void this.unload().then(() => this.ensureModel().catch(() => {}));
    } else {
      this.ensureModel().catch(() => {});
    }
    this.pushStatus();
  }

  /** Handle one classify request; posts `scores` (fulfilled ids only) or `error`. */
  async classify(id: number, items: ClassifyItem[]): Promise<void> {
    const t0 = this.now();
    this.lastActivity = t0;
    this.reqRate.add(items.length);
    if (this.status.state === 'error' && !this.loading) {
      this.env.post({ type: 'error', id, error: this.status.error ?? 'model unavailable' });
      return;
    }
    const settled = await Promise.allSettled(items.map((it) => this.batcher.submit(it.id, it.text)));
    const ids: string[] = [];
    const scores: number[][] = [];
    let firstErr: unknown = null;
    for (let i = 0; i < items.length; i++) {
      const r = settled[i]!;
      if (r.status === 'fulfilled') {
        ids.push(items[i]!.id);
        scores.push(r.value);
      } else firstErr ??= r.reason;
    }
    const ms = this.now() - t0;
    this.reqLat.push(ms);
    if (!ids.length) {
      this.env.post({ type: 'error', id, error: errMsg(firstErr) });
      return;
    }
    this.env.post({ type: 'scores', id, ids, scores, ms: Math.round(ms * 10) / 10, backend: this.model?.backend ?? 'none' });
  }

  stats(): InferenceStats {
    const b = this.batcher;
    const lookups = b.submitted;
    return {
      backend: this.model?.backend ?? this.status.backend,
      variant: this.model?.variant ?? '',
      p50ms: r1(this.reqLat.percentile(0.5)),
      p95ms: r1(this.reqLat.percentile(0.95)),
      forwardP50ms: r1(this.fwdLat.percentile(0.5)),
      forwardP95ms: r1(this.fwdLat.percentile(0.95)),
      inferPerSec: r1(this.inferRate.rate()),
      requestsPerSec: r1(this.reqRate.rate()),
      cacheHitRate: lookups ? r1((100 * (b.cacheHits + b.joined)) / lookups) / 100 : 0,
      cacheSize: this.cache.size,
      queue: b.queueLength,
      avgBatch: r1(this.batchSizes.mean()),
      padRatio: this.real ? Math.round((100 * this.padded) / this.real) / 100 : 1,
      loadMs: Math.round(this.model?.loadMs ?? 0),
      totalInferred: this.totalInferred,
      crossOriginIsolated: !!this.env.crossOriginIsolated,
      threads: this.env.threads ?? 1,
    };
  }

  /** Free the model if idle for longer than tuning.idleDisposeMs. Call periodically. */
  maybeIdleDispose(): void {
    const ms = this.tuning.idleDisposeMs;
    if (!ms || !this.model || this.loading) return;
    if (this.now() - this.lastActivity < ms || this.batcher.busy || this.batcher.queueLength) return;
    void this.unload().then(() => this.setStatus({ state: 'idle', backend: 'none' }));
  }

  /** Was there any request in the last `ms`? */
  activeWithin(ms: number): boolean {
    return this.now() - this.lastActivity < ms;
  }

  async unload(): Promise<void> {
    const m = this.model ?? (this.loading ? await this.loading.catch(() => null) : null);
    this.model = null;
    this.loading = null;
    await m?.dispose();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private ensureModel(): Promise<ModelLike> {
    if (this.model) return Promise.resolve(this.model);
    if (this.loading) return this.loading;
    const opts: InitOptions = { ...this.opts, device: this.forceDevice ?? this.opts.device ?? 'auto' };
    this.setStatus({ state: 'loading', backend: this.status.backend === 'none' ? 'none' : this.status.backend });
    const p = this.env
      .load(opts, {
        onProgress: (pr) => {
          if (pr.phase === 'downloading') {
            const t = this.now();
            if (t - this.lastProgressPost < 150 && (pr.progress ?? 0) < 1) return;
            this.lastProgressPost = t;
            this.setStatus({ state: 'downloading', backend: 'none', progress: Math.min(1, pr.progress ?? 0) });
          } else this.setStatus({ state: 'loading', backend: 'none' });
        },
        onFallback: (what, err) => console.warn(`[hush] ${what} failed, falling back:`, err),
      })
      .then((m) => {
        if (this.loading !== p) {
          void m.dispose();
          throw new Error('superseded');
        }
        this.model = m;
        this.loading = null;
        this.setStatus({
          state: 'ready',
          backend: m.backend as ModelBackend,
          modelId: `hush-lite/${m.variant}`,
          version: m.version,
          thresholds: m.thresholds,
        });
        return m;
      })
      .catch((e) => {
        if (this.loading === p) {
          this.loading = null;
          this.setStatus({ state: 'error', backend: 'none', error: errMsg(e) });
          this.batcher.failQueued(e);
        }
        throw e;
      });
    this.loading = p;
    return p;
  }

  /** Batcher flush: tokenize → bucket by length → forward per bucket. */
  private async infer(texts: string[]): Promise<number[][]> {
    const m = await this.ensureModel();
    const seqs = texts.map((t) => m.tokenize(t, this.tuning.maxChars));
    const plan = planBuckets(
      seqs.map((s) => s.length),
      this.tuning.bucketOverhead[m.backend] ?? 32,
      this.tuning.maxBatch,
    );
    const out: number[][] = new Array(texts.length);
    const t0 = this.now();
    try {
      for (const bucket of plan.buckets) {
        const probs = await m.run(bucket.map((i) => seqs[i]!));
        for (let r = 0; r < bucket.length; r++) {
          const row = new Array<number>(K);
          for (let j = 0; j < K; j++) row[j] = round4(probs[r * K + j]!);
          out[bucket[r]!] = row;
        }
      }
      this.gpuFailures = 0;
    } catch (e) {
      await this.onRunError(m, e);
      throw e;
    }
    const ms = this.now() - t0;
    this.fwdLat.push(ms);
    this.batchSizes.push(texts.length);
    this.inferRate.add(texts.length);
    this.totalInferred += texts.length;
    this.padded += plan.paddedTokens;
    this.real += plan.realTokens;
    if (this.real > 1e7) {
      this.padded /= 2;
      this.real /= 2;
    }
    return out;
  }

  /** WebGPU device lost / EP failure: after 2 consecutive failures switch to WASM. */
  private async onRunError(m: ModelLike, e: unknown): Promise<void> {
    console.warn('[hush] inference failed', e);
    if (m.backend !== 'webgpu' || this.model !== m) return;
    if (++this.gpuFailures < 2) return;
    this.forceDevice = 'wasm';
    this.gpuFailures = 0;
    await this.unload();
    this.ensureModel().catch(() => {});
  }

  private setStatus(s: ModelStatus): void {
    this.status = s;
    this.pushStatus();
  }

  private pushStatus(): void {
    this.env.post({ type: 'status', status: this.status, stats: this.status.state === 'ready' ? this.stats() : undefined });
  }
}

function r1(x: number): number {
  return Math.round(x * 10) / 10;
}

function errMsg(e: unknown): string {
  if (e instanceof OverloadedError) return 'overloaded';
  if (e instanceof Error) return e.message;
  return String(e ?? 'unknown error');
}
