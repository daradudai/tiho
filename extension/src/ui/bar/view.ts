// Rate-limited mirror of the runtime Store that rides the page's own frames.
//
// The runtime writes the store from its frame callback (≤ 4×/s) and its 1 s
// tick: tasks that render a frame anyway. The view applies a change right
// there, in the same task, when the field's cadence allows it, so the bar's
// DOM updates join a frame the page renders anyway instead of asking for
// frames of their own (an extra frame per update was most of the bar's cost
// in tests/stress). A change that comes too early waits for the next store
// write that is due, or for a short trailing timer once chat goes quiet.
// Each field has its own cadence (counters 2 fps, charts and status ≤ 1 fps);
// nothing is applied while the tab is hidden.

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
  counts: 500,
  totals: 500,
  perf: 1000,
  rate: 1000,
  vibe: 1000,
  waves: 1000,
  questions: 300,
  filtered: 1000,
};

/** Grace after a field is due before its own timer applies it (a store write usually comes first). */
const TRAIL_MS = 120;

export function createView(store: Store): { view: View; dispose: () => void } {
  const keys = Object.keys(CADENCE) as Key[];
  const view = {} as Record<Key, Signal<unknown>>;
  const last = {} as Record<Key, number>;
  const dirty = new Set<Key>();
  const disposers: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | 0 = 0;

  /** Apply every dirty field that is due; leave the rest to the next write or a trailing timer. */
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = 0;
    if (document.hidden) return; // applied on visibilitychange
    const t = performance.now();
    let wait = Infinity;
    batch(() => {
      for (const k of dirty) {
        const due = last[k] + CADENCE[k] - t;
        if (due <= 4) {
          view[k].value = (store[k] as Signal<unknown>).peek();
          last[k] = t;
          dirty.delete(k);
        } else if (due < wait) wait = due;
      }
    });
    if (dirty.size) timer = setTimeout(flush, wait + TRAIL_MS);
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
        flush();
      }),
    );
  }

  const onVisible = () => {
    if (!document.hidden && dirty.size) flush();
  };
  document.addEventListener('visibilitychange', onVisible);

  return {
    view: view as unknown as View,
    dispose: () => {
      for (const d of disposers) d();
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) clearTimeout(timer);
    },
  };
}
