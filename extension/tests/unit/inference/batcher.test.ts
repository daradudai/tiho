import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamicBatcher, OverloadedError } from '../../../src/inference/batcher';
import { LRU } from '../../../src/core/lru';

type Call = { keys: string[]; texts: string[] };

function setup(opts: Partial<ConstructorParameters<typeof DynamicBatcher<string>>[0]> = {}) {
  const calls: Call[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const b = new DynamicBatcher<string>({
    maxBatch: 4,
    maxWaitMs: 10,
    now: () => Date.now(),
    run: async (keys, texts) => {
      calls.push({ keys, texts });
      if (hold) await new Promise<void>((r) => (release = r));
      return texts.map((t) => t.toUpperCase());
    },
    ...opts,
  });
  return {
    b,
    calls,
    hold: () => (hold = true),
    release: () => {
      hold = false;
      release?.();
      release = null;
    },
  };
}

const flushMicro = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('DynamicBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits up to maxWaitMs to collect a batch', async () => {
    const { b, calls } = setup();
    const p1 = b.submit('a', 'a');
    vi.advanceTimersByTime(5);
    const p2 = b.submit('b', 'b');
    await flushMicro();
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(5);
    await flushMicro();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.keys).toEqual(['a', 'b']);
    expect(await p1).toBe('A');
    expect(await p2).toBe('B');
  });

  it('flushes immediately when maxBatch is reached', async () => {
    const { b, calls } = setup();
    const ps = ['a', 'b', 'c', 'd'].map((k) => b.submit(k, k));
    await flushMicro();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.keys).toHaveLength(4);
    expect(await Promise.all(ps)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('splits more than maxBatch items into consecutive flushes', async () => {
    const { b, calls } = setup();
    const ps = Array.from({ length: 10 }, (_, i) => b.submit(`k${i}`, `t${i}`));
    await flushMicro();
    vi.advanceTimersByTime(20);
    await flushMicro();
    await Promise.all(ps);
    expect(calls.map((c) => c.keys.length)).toEqual([4, 4, 2]);
  });

  it('dedups identical keys queued or in flight', async () => {
    const { b, calls, hold, release } = setup();
    hold();
    const p1 = b.submit('x', 'hello');
    const p2 = b.submit('x', 'hello');
    vi.advanceTimersByTime(10);
    await flushMicro();
    expect(calls).toHaveLength(1);
    const p3 = b.submit('x', 'hello'); // in flight → joins
    release();
    expect(await Promise.all([p1, p2, p3])).toEqual(['HELLO', 'HELLO', 'HELLO']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.keys).toEqual(['x']);
    expect(b.joined).toBe(2);
  });

  it('collects items that arrive during a forward pass into the next flush', async () => {
    const { b, calls, hold, release } = setup();
    hold();
    const p1 = b.submit('a', 'a');
    vi.advanceTimersByTime(10);
    await flushMicro();
    expect(calls).toHaveLength(1);
    const more = ['b', 'c', 'd'].map((k) => b.submit(k, k));
    vi.advanceTimersByTime(50); // they have waited long enough by the time the engine is free
    await flushMicro();
    expect(calls).toHaveLength(1); // still one in flight: no concurrent runs
    release();
    await p1;
    await flushMicro();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.keys).toEqual(['b', 'c', 'd']);
    await Promise.all(more);
  });

  it('serves repeats from the result cache without running', async () => {
    const cache = new LRU<string, string>(10);
    const { b, calls } = setup({ cache });
    const p = b.submit('a', 'a');
    vi.advanceTimersByTime(10);
    await flushMicro();
    expect(await p).toBe('A');
    expect(await b.submit('a', 'a')).toBe('A');
    expect(calls).toHaveLength(1);
    expect(b.cacheHits).toBe(1);
  });

  it('rejects every waiter of a failed flush and keeps going', async () => {
    let fail = true;
    const b = new DynamicBatcher<number>({
      maxBatch: 8,
      maxWaitMs: 0,
      run: async (keys) => {
        if (fail) throw new Error('boom');
        return keys.map(() => 1);
      },
    });
    const ps = [b.submit('a', 'a'), b.submit('b', 'b')];
    await expect(ps[0]).rejects.toThrow('boom');
    await expect(ps[1]).rejects.toThrow('boom');
    fail = false;
    expect(await b.submit('c', 'c')).toBe(1);
  });

  it('maxWaitMs=0 still batches items submitted in the same task', async () => {
    const { b, calls } = setup({ maxWaitMs: 0, maxBatch: 64 });
    const ps = Array.from({ length: 10 }, (_, i) => b.submit(`k${i}`, 'x'));
    await flushMicro();
    await Promise.all(ps);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.keys).toHaveLength(10);
  });

  it('applies backpressure when the queue is full', async () => {
    const { b, hold } = setup({ maxQueue: 2, maxBatch: 100, maxWaitMs: 1000 });
    hold();
    void b.submit('a', 'a');
    void b.submit('b', 'b');
    await expect(b.submit('c', 'c')).rejects.toBeInstanceOf(OverloadedError);
    // duplicates of queued keys still join
    void b.submit('a', 'a');
    expect(b.queueLength).toBe(2);
  });

  it('serves the newest items first when more are queued than one pass takes', async () => {
    const { b, calls, hold, release } = setup({ maxBatch: 2 });
    hold();
    const first = b.submit('a', 'a');
    vi.advanceTimersByTime(10);
    await flushMicro();
    const later = ['b', 'c', 'd', 'e'].map((k) => b.submit(k, k));
    release();
    await first;
    await flushMicro();
    expect(calls[1]!.keys).toEqual(['d', 'e']); // the newest rows are the ones on screen
    vi.advanceTimersByTime(10);
    await flushMicro();
    await Promise.all(later);
    expect(calls[2]!.keys).toEqual(['b', 'c']);
  });

  it('drops queued items nobody asked for within maxAgeMs instead of answering them late', async () => {
    const { b, calls, hold, release } = setup({ maxBatch: 64, maxAgeMs: 1000 });
    hold();
    const first = b.submit('a', 'a');
    vi.advanceTimersByTime(10);
    await flushMicro();
    const stale = b.submit('old', 'old');
    const kept = b.submit('again', 'again');
    vi.advanceTimersByTime(900);
    const fresh = b.submit('new', 'new');
    const rejoined = b.submit('again', 'again'); // asked again: still wanted
    vi.advanceTimersByTime(200); // the forward pass took 1.1 s
    release();
    await first;
    await expect(stale).rejects.toBeInstanceOf(OverloadedError);
    expect(await Promise.all([kept, rejoined, fresh])).toEqual(['AGAIN', 'AGAIN', 'NEW']);
    expect(calls[1]!.keys).toEqual(['again', 'new']);
    expect(b.expired).toBe(1);
  });

  it('failQueued rejects queued items', async () => {
    const { b } = setup({ maxWaitMs: 1000 });
    const p = b.submit('a', 'a');
    b.failQueued(new Error('reload'));
    await expect(p).rejects.toThrow('reload');
    expect(b.queueLength).toBe(0);
  });
});

describe('LRU as the worker score cache', () => {
  it('keeps the 20k most recently used entries', () => {
    const c = new LRU<string, number[]>(20_000);
    for (let i = 0; i < 25_000; i++) c.set(`t${i}`, [i]);
    expect(c.size).toBe(20_000);
    expect(c.get('t0')).toBeUndefined();
    expect(c.get('t24999')).toEqual([24999]);
    // touching an old entry protects it from eviction
    c.get('t5000');
    for (let i = 25_000; i < 25_100; i++) c.set(`t${i}`, [i]);
    expect(c.get('t5000')).toEqual([5000]);
    expect(c.get('t5001')).toBeUndefined();
  });
});
