// The bar's View: store changes reach the bar in the same task when due
// (riding the runtime's frame), early ones wait for a later write or a
// trailing timer, and nothing is applied while the tab is hidden.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effect } from '@preact/signals';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { createStore, zeroInChat } from '../../src/core/store';
import { createView } from '../../src/ui/bar/view';

describe('bar view', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('applies a due change synchronously, in the writer’s task', () => {
    const store = createStore({ ...DEFAULT_SETTINGS });
    const { view, dispose } = createView(store);
    store.seen.value = 1;
    expect(view.seen.value).toBe(1);
    dispose();
  });

  it('rate-limits a field and delivers the last value late (next due write or trailing timer)', () => {
    const store = createStore({ ...DEFAULT_SETTINGS });
    const { view, dispose } = createView(store);
    store.seen.value = 1;
    vi.advanceTimersByTime(100);
    store.seen.value = 2; // too early: held back
    store.seen.value = 3;
    expect(view.seen.value).toBe(1);
    vi.advanceTimersByTime(400); // due at 500 ms: a write now goes straight through
    store.seen.value = 4;
    expect(view.seen.value).toBe(4);
    vi.advanceTimersByTime(100);
    store.seen.value = 5; // early again, and chat goes quiet
    vi.advanceTimersByTime(1000);
    expect(view.seen.value).toBe(5);
    dispose();
  });

  it('in-chat-now counters reach the bar at most 2×/s; the tab’s views at once', () => {
    const store = createStore({ ...DEFAULT_SETTINGS });
    const { view, dispose } = createView(store);
    const seen: number[] = [];
    const stop = effect(() => void seen.push(view.inChat.value.rows));
    for (let i = 1; i <= 20; i++) {
      store.inChat.value = { ...zeroInChat(), rows: i };
      vi.advanceTimersByTime(100); // a store flush every 100 ms for 2 s
    }
    vi.advanceTimersByTime(1000);
    expect(seen.length - 1).toBeLessThanOrEqual(5); // ≤ 2 per second (+ the trailing one)
    expect(seen.at(-1)).toBe(20);
    store.solo.value = 'spam';
    store.peek.value = true;
    expect(view.solo.value).toBe('spam');
    expect(view.peek.value).toBe(true);
    stop();
    dispose();
  });

  it('settings are never delayed', () => {
    const store = createStore({ ...DEFAULT_SETTINGS });
    const { view, dispose } = createView(store);
    store.settings.value = { ...store.settings.value, preset: 'focus' };
    store.settings.value = { ...store.settings.value, preset: 'raw' };
    expect(view.settings.value.preset).toBe('raw');
    dispose();
  });

  it('holds updates while the tab is hidden and applies them when it shows', () => {
    const store = createStore({ ...DEFAULT_SETTINGS });
    const { view, dispose } = createView(store);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    store.seen.value = 7;
    vi.advanceTimersByTime(2000);
    expect(view.seen.value).toBe(0);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(view.seen.value).toBe(7);
    dispose();
  });
});
