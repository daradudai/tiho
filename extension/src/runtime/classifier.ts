// Content-script side of inference: one long-lived Port per frame to the
// background, per-frame micro-batching, in-flight dedup and a bounded LRU of
// scores keyed by normalized text. Rules-only when no model is available.
//
// Hush Engine answers arrive later as an `engine` follow-up for ids that
// already have scores; they are attached to the cached score vectors in place
// (ScoreVector.engine), so every row holding that vector sees them the next
// time policy runs, and `onRescored` asks the runtime to run it now.

import { LRU } from '../core/lru';
import type { EngineOpinion, ScoreVector } from '../core/policy';
import { PORT_CLASSIFY, type ClassifyItem, type EngineFollowUp, type PortRequest, type PortResponse } from '../core/protocol';
import { LABELS, type ModelStatus } from '../core/types';

export interface ClassifierTransport {
  post(msg: PortRequest): void;
  onMessage(cb: (msg: PortResponse) => void): void;
  onDisconnect(cb: (reason?: string) => void): void;
  disconnect(): void;
}

/** Returns a connected transport, null if none is possible right now; throws if the extension context is gone. */
export type TransportFactory = () => ClassifierTransport | null;

export function chromePortTransport(): ClassifierTransport | null {
  const rt = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
  if (!rt?.connect) return null;
  if (!rt.id) throw new Error('Extension context invalidated.');
  const port = rt.connect({ name: PORT_CLASSIFY });
  return {
    post: (m) => port.postMessage(m),
    onMessage: (cb) => port.onMessage.addListener(cb as (m: unknown) => void),
    onDisconnect: (cb) =>
      port.onDisconnect.addListener(() => {
        cb(chrome.runtime.lastError?.message);
      }),
    disconnect: () => port.disconnect(),
  };
}

export interface ClassifierOptions {
  /** Content-side score cache (normalized text → scores). */
  cacheSize?: number;
  /** Items per PortRequest. */
  batchMax?: number;
  /** Give up on a batch after this long (rows fall back to rules). */
  timeoutMs?: number;
  now?: () => number;
  onScores?(ids: string[]): void;
  onFailed?(ids: string[]): void;
  /** Hush Engine answers were attached to the cached scores of these ids (verdicts may change). */
  onRescored?(ids: string[]): void;
  onStatus?(s: ModelStatus): void;
}

const LAT_RING = 256;

export class ClassifierClient {
  status: ModelStatus | null = null;
  readonly cache: LRU<string, ScoreVector>;
  /** Scores ever received over this client (any status). */
  answered = false;
  /** True once the extension context is gone: never reconnect. */
  dead = false;

  // stats
  sent = 0;
  received = 0;
  failed = 0;
  /** Texts the Hush Engine answered. */
  refined = 0;
  private lat = new Float64Array(LAT_RING);
  private latN = 0;

  private queue: ClassifyItem[] = [];
  private pending = new Set<string>(); // queued or in flight
  private batches = new Map<number, { ids: string[]; at: number }>();
  private seq = 1;
  private transport: ClassifierTransport | null = null;
  private retryAt = 0;
  private backoff = 500;
  private readonly batchMax: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private factory: TransportFactory,
    private opts: ClassifierOptions = {},
  ) {
    this.cache = new LRU(opts.cacheSize ?? 5000);
    this.batchMax = opts.batchMax ?? 32;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? (() => performance.now());
  }

  /** Worth sending requests: not dead and the model is not known to be unavailable. */
  get available(): boolean {
    if (this.dead) return false;
    const s = this.status;
    if (!s) return true; // unknown: try, the background queues or errors
    return s.state === 'ready' || s.state === 'idle';
  }

  /** Confident enough in timely answers to hold messages back. */
  get holdable(): boolean {
    if (this.dead) return false;
    const s = this.status;
    return s ? s.state === 'ready' : this.answered;
  }

  get inflight(): number {
    return this.pending.size;
  }

  lookup(id: string): ScoreVector | undefined {
    return this.cache.get(id);
  }

  /** Queue `text` for classification under cache key `id`. Deduplicated while queued / in flight. */
  request(id: string, text: string): void {
    if (this.pending.has(id)) return;
    this.pending.add(id);
    this.queue.push({ id, text });
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** Send everything queued (call once per frame). */
  flush(): void {
    if (!this.queue.length) return;
    const t = this.ensure();
    if (!t) {
      // can't send now: fail them so rows fall back to rules (shown)
      const ids = this.queue.map((q) => q.id);
      this.queue = [];
      for (const id of ids) this.pending.delete(id);
      this.failed += ids.length;
      this.opts.onFailed?.(ids);
      return;
    }
    const now = this.now();
    const q = this.queue;
    this.queue = [];
    for (let i = 0; i < q.length; i += this.batchMax) {
      const items = q.slice(i, i + this.batchMax);
      const batchId = this.seq++;
      this.batches.set(batchId, { ids: items.map((x) => x.id), at: now });
      try {
        t.post({ type: 'classify', batchId, items });
        this.sent += items.length;
      } catch {
        this.drop(batchId);
        this.lost();
        return;
      }
    }
  }

  /** Fail batches that took too long. Call ~1/s. */
  expire(): void {
    const now = this.now();
    for (const [id, b] of this.batches) if (now - b.at > this.timeoutMs) this.drop(id);
  }

  /** Inference round-trip latency percentiles (ms) over the last 256 batches. */
  latency(): { p50: number; p95: number } {
    const n = Math.min(this.latN, LAT_RING);
    if (!n) return { p50: 0, p95: 0 };
    const a = Array.from(this.lat.subarray(0, n)).sort((x, y) => x - y);
    return { p50: a[Math.floor(n * 0.5)]!, p95: a[Math.min(n - 1, Math.floor(n * 0.95))]! };
  }

  /** Open the Port now (so the background can push model status early). */
  connect(): boolean {
    return !!this.ensure();
  }

  setStatus(s: ModelStatus): void {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  close(): void {
    try {
      this.transport?.disconnect();
    } catch {
      /* already gone */
    }
    this.transport = null;
    this.dead = true;
  }

  // ─────────────────────────── internals ───────────────────────────

  private ensure(): ClassifierTransport | null {
    if (this.transport) return this.transport;
    if (this.dead) return null;
    const now = this.now();
    if (now < this.retryAt) return null;
    let t: ClassifierTransport | null = null;
    try {
      t = this.factory();
    } catch (e) {
      // "Extension context invalidated" → permanent
      if (/invalidated/i.test(String((e as Error)?.message ?? e))) this.dead = true;
      else this.scheduleRetry(now);
      return null;
    }
    if (!t) {
      this.scheduleRetry(now);
      return null;
    }
    t.onMessage((m) => this.onMessage(m));
    t.onDisconnect(() => {
      if (this.transport === t) this.lost();
    });
    this.transport = t;
    this.backoff = 500;
    return t;
  }

  private scheduleRetry(now: number): void {
    this.retryAt = now + this.backoff;
    this.backoff = Math.min(30_000, this.backoff * 2);
  }

  private lost(): void {
    this.transport = null;
    for (const id of Array.from(this.batches.keys())) this.drop(id);
    this.scheduleRetry(this.now());
  }

  private drop(batchId: number): void {
    const b = this.batches.get(batchId);
    if (!b) return;
    this.batches.delete(batchId);
    for (const id of b.ids) this.pending.delete(id);
    this.failed += b.ids.length;
    this.opts.onFailed?.(b.ids);
  }

  private onMessage(m: PortResponse): void {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'status') {
      this.setStatus(m.status);
      return;
    }
    if (m.type === 'engine') {
      this.mergeEngine(m);
      return;
    }
    const b = this.batches.get(m.batchId);
    if (m.type === 'error') {
      if (b) this.drop(m.batchId);
      return;
    }
    if (m.type !== 'scores') return;
    this.answered = true;
    if (b) {
      this.batches.delete(m.batchId);
      this.lat[this.latN++ % LAT_RING] = this.now() - b.at;
    }
    const ids = m.ids;
    for (let i = 0; i < ids.length; i++) {
      const s = m.scores[i];
      if (s) this.cache.set(ids[i]!, s);
      this.pending.delete(ids[i]!);
    }
    this.received += ids.length;
    // ids the background silently dropped from this batch
    if (b && b.ids.length !== ids.length) {
      const got = new Set(ids);
      const missing = b.ids.filter((x) => !got.has(x));
      for (const id of missing) this.pending.delete(id);
      if (missing.length) this.opts.onFailed?.(missing);
    }
    this.opts.onScores?.(ids);
  }

  private mergeEngine(m: EngineFollowUp): void {
    if (!Array.isArray(m.ids)) return;
    const keys = m.filters ? Object.keys(m.filters) : [];
    const ids: string[] = [];
    for (let i = 0; i < m.ids.length; i++) {
      const id = m.ids[i]!;
      const s = this.cache.peek(id);
      if (!s) continue; // evicted meanwhile: the engine opinion has nothing to refine
      const op: EngineOpinion = s.engine ?? {};
      for (const k of keys) {
        const p = m.filters[k]![i];
        if (typeof p === 'number' && Number.isFinite(p)) (op.filters ??= {})[k] = p;
      }
      const b = m.base?.[i];
      if (Array.isArray(b) && b.length === LABELS.length) op.base = b;
      s.engine = op;
      ids.push(id);
    }
    this.refined += ids.length;
    if (ids.length) this.opts.onRescored?.(ids);
  }
}
