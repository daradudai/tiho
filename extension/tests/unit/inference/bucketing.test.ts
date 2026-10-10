import { describe, expect, it } from 'vitest';
import { planBuckets } from '../../../src/inference/bucketing';

const all = (b: number[][]) => b.flat().sort((x, y) => x - y);

describe('planBuckets', () => {
  it('empty input', () => {
    expect(planBuckets([], 10)).toEqual({ buckets: [], lengths: [], paddedTokens: 0, realTokens: 0 });
  });

  it('covers every index exactly once and sorts by length inside buckets', () => {
    const lens = [5, 64, 3, 12, 12, 40, 7, 3];
    const p = planBuckets(lens, 8);
    expect(all(p.buckets)).toEqual(lens.map((_, i) => i));
    for (let b = 0; b < p.buckets.length; b++) {
      const ls = p.buckets[b]!.map((i) => lens[i]!);
      expect(ls).toEqual([...ls].sort((x, y) => x - y));
      expect(p.lengths[b]).toBe(Math.max(...ls));
    }
    expect(p.realTokens).toBe(lens.reduce((a, b) => a + b, 0));
  });

  it('huge overhead → one bucket padded to the longest', () => {
    const lens = [3, 4, 60, 5];
    const p = planBuckets(lens, 1e9);
    expect(p.buckets).toHaveLength(1);
    expect(p.lengths).toEqual([60]);
    expect(p.paddedTokens).toBe(4 * 60);
  });

  it('zero overhead → no padding at all (one bucket per distinct length)', () => {
    const lens = [3, 3, 9, 9, 9, 20];
    const p = planBuckets(lens, 0);
    expect(p.paddedTokens).toBe(p.realTokens);
  });

  it('splits a long outlier away from many short texts when it pays off', () => {
    const lens = [...Array(31).fill(6), 64];
    const p = planBuckets(lens, 24);
    // one bucket: 32*64 = 2048 + 24 ; two buckets: 31*6 + 64 + 48 = 298
    expect(p.buckets).toHaveLength(2);
    expect(p.paddedTokens).toBe(31 * 6 + 64);
  });

  it('is optimal vs brute force on small random inputs', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let t = 0; t < 50; t++) {
      const n = 1 + Math.floor(rnd() * 8);
      const lens = Array.from({ length: n }, () => 1 + Math.floor(rnd() * 64));
      const ov = Math.floor(rnd() * 100);
      const p = planBuckets(lens, ov);
      const cost = p.paddedTokens + ov * p.buckets.length;
      // brute force over contiguous partitions of the sorted list
      const s = [...lens].sort((a, b) => a - b);
      let best = Infinity;
      for (let mask = 0; mask < 1 << (n - 1); mask++) {
        let c = 0;
        let start = 0;
        for (let i = 0; i < n; i++) {
          if (i === n - 1 || mask & (1 << i)) {
            c += ov + (i - start + 1) * s[i]!;
            start = i + 1;
          }
        }
        best = Math.min(best, c);
      }
      expect(cost).toBe(best);
    }
  });

  it('respects maxBucket', () => {
    const p = planBuckets(Array(10).fill(5), 1e6, 4);
    expect(p.buckets.every((b) => b.length <= 4)).toBe(true);
    expect(all(p.buckets)).toHaveLength(10);
  });
});
