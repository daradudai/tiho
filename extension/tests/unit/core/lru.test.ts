import { describe, expect, it } from 'vitest';
import { LRU } from '../../../src/core/lru';

describe('LRU', () => {
  it('evicts the least recently used entry', () => {
    const l = new LRU<string, number>(3);
    l.set('a', 1).set('b', 2).set('c', 3);
    expect(l.get('a')).toBe(1); // a is now most recent
    l.set('d', 4); // evicts b
    expect(l.has('b')).toBe(false);
    expect(l.has('a')).toBe(true);
    expect(l.size).toBe(3);
  });

  it('overwrites without growing', () => {
    const l = new LRU<string, number>(2);
    l.set('a', 1).set('a', 2);
    expect(l.size).toBe(1);
    expect(l.get('a')).toBe(2);
  });

  it('peek does not refresh recency or count', () => {
    const l = new LRU<string, number>(2);
    l.set('a', 1).set('b', 2);
    expect(l.peek('a')).toBe(1);
    l.set('c', 3); // a was not refreshed → evicted
    expect(l.has('a')).toBe(false);
    expect(l.hits + l.misses).toBe(0);
  });

  it('tracks hit rate', () => {
    const l = new LRU<string, number>(10);
    l.set('a', 1);
    l.get('a');
    l.get('x');
    expect(l.hitRate()).toBe(0.5);
  });

  it('stays bounded under churn', () => {
    const l = new LRU<number, number>(5000);
    for (let i = 0; i < 100_000; i++) l.set(i, i);
    expect(l.size).toBe(5000);
    expect(l.has(99_999)).toBe(true);
    expect(l.has(94_999)).toBe(false);
  });

  it('stores falsy values', () => {
    const l = new LRU<string, number>(2);
    l.set('z', 0);
    expect(l.get('z')).toBe(0);
    expect(l.hits).toBe(1);
  });
});
