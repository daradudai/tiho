// Small, allocation-free telemetry helpers used by the inference worker.

/** Ring buffer of the last N samples with percentile queries. */
export class LatencyRing {
  private buf: Float64Array;
  private n = 0;

  constructor(readonly capacity = 512) {
    this.buf = new Float64Array(capacity);
  }

  push(v: number): void {
    this.buf[this.n++ % this.capacity] = v;
  }

  get count(): number {
    return Math.min(this.n, this.capacity);
  }

  /** p in [0,1]; 0 when empty. Nearest-rank on a sorted copy (≤ capacity items). */
  percentile(p: number): number {
    const k = this.count;
    if (!k) return 0;
    const a = this.buf.slice(0, k).sort();
    return a[Math.min(k - 1, Math.max(0, Math.ceil(p * k) - 1))]!;
  }

  mean(): number {
    const k = this.count;
    if (!k) return 0;
    let s = 0;
    for (let i = 0; i < k; i++) s += this.buf[i]!;
    return s / k;
  }

  clear(): void {
    this.n = 0;
  }
}

/** Events per second over a sliding window, using fixed time slots. */
export class RateMeter {
  private slots: Float64Array;
  private stamps: Float64Array;

  constructor(
    readonly windowMs = 5000,
    readonly slotMs = 250,
    private now: () => number = () => performance.now(),
  ) {
    const k = Math.ceil(windowMs / slotMs);
    this.slots = new Float64Array(k);
    this.stamps = new Float64Array(k).fill(-Infinity);
  }

  add(count = 1): void {
    const t = this.now();
    const slot = Math.floor(t / this.slotMs);
    const i = slot % this.slots.length;
    if (this.stamps[i] !== slot) {
      this.stamps[i] = slot;
      this.slots[i] = 0;
    }
    this.slots[i]! += count;
  }

  /** Events/s over the window (only slots inside the window count). */
  rate(): number {
    const t = this.now();
    const cur = Math.floor(t / this.slotMs);
    const oldest = cur - this.slots.length + 1;
    let sum = 0;
    for (let i = 0; i < this.slots.length; i++) if (this.stamps[i]! >= oldest) sum += this.slots[i]!;
    return (sum * 1000) / this.windowMs;
  }
}
