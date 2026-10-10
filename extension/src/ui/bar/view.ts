// Frame-aligned, rate-limited mirror of the runtime Store.
//
// The runtime may write the store as often as it likes; the bar only ever
// sees one batched update per animation frame, and each field has its own
// cadence (counters ~8 fps, charts ~1-2 fps). Nothing runs while the tab is
// hidden (rAF is paused).

import { batch, effect, signal, type Signal } from '@preact/signals';
import type { Store } from '../../core/store';

type Key = Exclude<keyof Store, never>;
type Val<K extends Key> = Store[K] extends { value: infer T } ? T : never;
export type View = { [K in Key]: Signal<Val<K>> };

/** Minimum ms between UI updates per store field. */
const CADENCE: Record<Key, number> = {
  settings: 0,
  theme: 0,
  platform: 0,
  channel: 0,
  model: 100,
  counts: 125,
  totals: 125,
  perf: 500,
  rate: 500,
  vibe: 1000,
  waves: 400,
  questions: 300,
  filtered: 1000,
};

export function createView(store: Store): { view: View; dispose: () => void } {
  const keys = Object.keys(CADENCE) as Key[];
  const view = {} as Record<Key, Signal<unknown>>;
  const last = {} as Record<Key, number>;
  const dirty = new Set<Key>();
  const disposers: (() => void)[] = [];
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;

  const now = () => performance.now();

  const flush = () => {
    raf = 0;
    const t = now();
    batch(() => {
      for (const k of dirty) {
        if (t - last[k] >= CADENCE[k] - 4) {
          view[k].value = (store[k] as Signal<unknown>).peek();
          last[k] = t;
          dirty.delete(k);
        }
      }
    });
    if (dirty.size) schedule();
  };

  const schedule = () => {
    if (raf || timer) return;
    const t = now();
    let wait = Infinity;
    for (const k of dirty) wait = Math.min(wait, last[k] + CADENCE[k] - t);
    const frame = () => {
      timer = 0;
      raf = requestAnimationFrame(flush);
    };
    if (wait <= 4) frame();
    else timer = setTimeout(frame, wait);
  };

  for (const k of keys) {
    const src = store[k] as Signal<unknown> | undefined;
    if (!src) continue;
    view[k] = signal(src.peek());
    last[k] = -Infinity;
    let first = true;
    disposers.push(
      effect(() => {
        void src.value;
        if (first) {
          first = false;
          return;
        }
        dirty.add(k);
        schedule();
      }),
    );
  }

  return {
    view: view as unknown as View,
    dispose: () => {
      for (const d of disposers) d();
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    },
  };
}
