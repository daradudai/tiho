// The bar's View: store changes reach the bar in the same task when due
// (riding the runtime's frame), early ones wait for a later write or a
// trailing timer, and nothing is applied while the tab is hidden.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { createStore } from '../../src/core/store';
import { createView } from '../../src/ui/bar/view';

const totals = (seen: number) => ({ seen, filtered: 0 });

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
    store.totals.value = totals(1);
    expect(view.totals.value.seen).toBe(1);
    dispose();
  });

  it('rate-limits a field and delivers the last value late (next due write or trailing timer)', () => {
    const store = createStore({ ...DEFAULT_SETTINGS });
    const { view, dispose } = createView(store);
    store.totals.value = totals(1);
    vi.advanceTimersByTime(100);
    store.totals.value = totals(2); // too early: held back
    store.totals.value = totals(3);
    expect(view.totals.value.seen).toBe(1);
    vi.advanceTimersByTime(400); // due at 500 ms: a write now goes straight through
    store.totals.value = totals(4);
    expect(view.totals.value.seen).toBe(4);
    vi.advanceTimersByTime(100);
    store.totals.value = totals(5); // early again, and chat goes quiet
    vi.advanceTimersByTime(1000);
    expect(view.totals.value.seen).toBe(5);
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
    store.totals.value = totals(7);
    vi.advanceTimersByTime(2000);
    expect(view.totals.value.seen).toBe(0);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(view.totals.value.seen).toBe(7);
    dispose();
  });
});
