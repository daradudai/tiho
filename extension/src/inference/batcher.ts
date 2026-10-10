// Dynamic batcher for the inference worker.
//
// - Items are keyed (cache key = normalized text). Identical keys queued or in
//   flight share one slot (dedup across requests and tabs).
// - A flush happens when the queue reaches `maxBatch`, or `maxWaitMs` after the
//   oldest queued item arrived (≈ 1 frame), whichever is first.
// - One forward pass at a time; items that arrive meanwhile are collected and
//   flushed as soon as the engine is free (if they already waited long enough)
//   — the batch size adapts to load by itself.
// - Optional result cache in front (LRU of key → result).
//
// Pure: timers / clock are injectable so it is unit-testable.

export interface ResultCache<R> {
  get(key: string): R | undefined;
  set(key: string, value: R): unknown;
}

export interface BatcherOptions<R> {
  maxBatch: number;
  maxWaitMs: number;
  /** One flush. Must return results aligned with `keys`. */
  run: (keys: string[], texts: string[]) => Promise<R[]>;
  cache?: ResultCache<R> | null;
  /** Reject new unique items while this many are queued (backpressure). */
  maxQueue?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  onFlush?: (info: { size: number; ms: number; queued: number }) => void;
}

interface Slot<R> {
  text: string;
  at: number;
  waiters: Array<{ resolve: (r: R) => void; reject: (e: unknown) => void }>;
}

export class OverloadedError extends Error {
  constructor() {
    super('inference queue full');
    this.name = 'OverloadedError';
  }
}

export class DynamicBatcher<R> {
  private queue: string[] = [];
  private slots = new Map<string, Slot<R>>();
  private running = false;
  private timer: unknown = null;
  private microtask = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  // counters
  submitted = 0;
  cacheHits = 0;
  joined = 0;
  flushes = 0;
  itemsRun = 0;

  constructor(private opts: BatcherOptions<R>) {
    this.now = opts.now ?? (() => performance.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Unique items waiting for a forward pass (not counting the one in flight). */
  get queueLength(): number {
    return this.queue.length;
  }

  get busy(): boolean {
    return this.running;
  }

  /** Classify one item; resolves with its result. */
  submit(key: string, text: string): Promise<R> {
    this.submitted++;
    const cached = this.opts.cache?.get(key);
    if (cached !== undefined) {
      this.cacheHits++;
      return Promise.resolve(cached);
    }
    const slot = this.slots.get(key);
    if (slot) {
      this.joined++;
      return new Promise<R>((resolve, reject) => slot.waiters.push({ resolve, reject }));
    }
    if (this.opts.maxQueue && this.queue.length >= this.opts.maxQueue) return Promise.reject(new OverloadedError());
    return new Promise<R>((resolve, reject) => {
      this.slots.set(key, { text, at: this.now(), waiters: [{ resolve, reject }] });
      this.queue.push(key);
      this.schedule();
    });
  }

  /** Reject everything queued (e.g. model reload / fatal error). In-flight items finish normally. */
  failQueued(err: unknown): void {
    const keys = this.queue;
    this.queue = [];
    this.cancelTimer();
    for (const k of keys) {
      const s = this.slots.get(k);
      this.slots.delete(k);
      s?.waiters.forEach((w) => w.reject(err));
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.running || !this.queue.length) return;
    const { maxBatch, maxWaitMs } = this.opts;
    if (this.queue.length >= maxBatch) {
      this.cancelTimer();
      void this.flush();
      return;
    }
    const oldest = this.slots.get(this.queue[0]!)!.at;
    const wait = maxWaitMs - (this.now() - oldest);
    if (wait <= 0) {
      // Flush right after the current task, so items submitted synchronously
      // together (one request) still share a forward pass.
      if (!this.microtask) {
        this.microtask = true;
        queueMicrotask(() => {
          this.microtask = false;
          if (!this.running) {
            this.cancelTimer();
            void this.flush();
          }
        });
      }
      return;
    }
    if (this.timer === null) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        if (!this.running) void this.flush();
      }, wait);
    }
  }

  private async flush(): Promise<void> {
    if (this.running || !this.queue.length) return;
    this.running = true;
    const keys = this.queue.splice(0, this.opts.maxBatch);
    const texts = keys.map((k) => this.slots.get(k)!.text);
    const t0 = this.now();
    try {
      const results = await this.opts.run(keys, texts);
      this.flushes++;
      this.itemsRun += keys.length;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        const s = this.slots.get(k);
        this.slots.delete(k);
        const r = results[i];
        if (r === undefined) {
          s?.waiters.forEach((w) => w.reject(new Error('missing result')));
          continue;
        }
        this.opts.cache?.set(k, r);
        s?.waiters.forEach((w) => w.resolve(r));
      }
    } catch (e) {
      for (const k of keys) {
        const s = this.slots.get(k);
        this.slots.delete(k);
        s?.waiters.forEach((w) => w.reject(e));
      }
    } finally {
      this.running = false;
      this.opts.onFlush?.({ size: keys.length, ms: this.now() - t0, queued: this.queue.length });
      this.schedule();
    }
  }
}
