// Formatting + small reactive helpers shared by the bar and extension pages.

import { signal, effect, type ReadonlySignal, type Signal } from '@preact/signals';

/** 7 → "7", 1234 → "1.2k", 10500 → "11k", 2_400_000 → "2.4M" */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (a < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function grouped(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** 0.183 → "18%" (clamped, never "NaN%"). */
export function pct(x: number, digits = 0): string {
  if (!Number.isFinite(x)) return '0%';
  return `${(Math.max(0, Math.min(1, x)) * 100).toFixed(digits)}%`;
}

export function rate(n: number): string {
  if (n < 10) return n.toFixed(1).replace(/\.0$/, '');
  return String(Math.round(n));
}

export function signed(v: number, digits = 2): string {
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Vibe in [-1,1] → words. */
export function vibeWord(v: number): string {
  if (v > 0.45) return 'Glowing';
  if (v > 0.15) return 'Positive';
  if (v > -0.15) return 'Neutral';
  if (v > -0.45) return 'Grumpy';
  return 'Heated';
}

export function strictWord(v: number): string {
  if (v < 0.34) return 'Lenient';
  if (v < 0.67) return 'Balanced';
  return 'Strict';
}

/**
 * Mirror a signal at most once per `ms` (trailing edge, frame-aligned).
 * Keeps the UI at a steady, cheap cadence no matter how often the runtime
 * writes (counters at ~8 fps read better than at 60 fps anyway).
 */
export function throttled<T>(src: ReadonlySignal<T> | Signal<T>, ms: number): { sig: ReadonlySignal<T>; dispose: () => void } {
  const out = signal(src.peek());
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  let raf = 0;
  const flush = () => {
    timer = 0;
    raf = 0;
    last = performance.now();
    out.value = src.peek();
  };
  const schedule = () => {
    if (timer || raf) return;
    const wait = Math.max(0, ms - (performance.now() - last));
    const frame = () => {
      if (typeof requestAnimationFrame === 'function' && !document.hidden) raf = requestAnimationFrame(flush);
      else flush();
    };
    if (wait <= 0) frame();
    else timer = setTimeout(() => ((timer = 0), frame()), wait);
  };
  const dispose = effect(() => {
    src.value; // subscribe
    schedule();
  });
  return {
    sig: out,
    dispose: () => {
      dispose();
      if (timer) clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}

/** Build an SVG path for a series scaled into w×h (y grows downward). Returns [line, area]. */
export function seriesPath(values: number[], w: number, h: number, opts: { min?: number; max?: number; pad?: number } = {}): [string, string] {
  const n = values.length;
  if (n === 0) return ['', ''];
  const pad = opts.pad ?? 1.5;
  let max = opts.max ?? -Infinity;
  let min = opts.min ?? Infinity;
  if (opts.max === undefined) for (const v of values) if (v > max) max = v;
  if (opts.min === undefined) for (const v of values) if (v < min) min = v;
  if (max - min < 1e-9) max = min + 1;
  const sx = n > 1 ? w / (n - 1) : 0;
  const sy = (h - pad * 2) / (max - min);
  let d = '';
  for (let i = 0; i < n; i++) {
    const x = (i * sx).toFixed(1);
    const y = (h - pad - (values[i] - min) * sy).toFixed(1);
    d += i === 0 ? `M${x} ${y}` : `L${x} ${y}`;
  }
  const area = `${d}L${w} ${h}L0 ${h}Z`;
  return [d, area];
}

/** Smooth a series with a centered moving average (radius r). */
export function smooth(values: number[], r = 1): number[] {
  if (r <= 0) return values;
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let s = 0;
    let c = 0;
    for (let j = i - r; j <= i + r; j++) {
      if (j >= 0 && j < values.length) {
        s += values[j];
        c++;
      }
    }
    out[i] = s / c;
  }
  return out;
}
