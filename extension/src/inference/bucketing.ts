// Length bucketing for one inference flush.
//
// A flush holds ≤ maxBatch unique texts of different token lengths. Padding
// everything to the longest wastes compute (chat is mostly 3–15 tokens with a
// tail up to 64); one forward per length wastes per-call overhead. We sort by
// length and split the sorted list into contiguous groups minimising
//
//     Σ_groups ( overhead + size(group) · maxLen(group) )
//
// with an O(n²) DP (n ≤ 64 → trivial). `overhead` is the fixed cost of a
// forward call expressed in padded-token equivalents: large on WebGPU (kernel
// dispatch dominates), small on WASM.

export interface BucketPlan {
  /** Original indices per bucket, ascending token length inside each bucket. */
  buckets: number[][];
  /** Padded length per bucket. */
  lengths: number[];
  /** Σ size·len over buckets (padded tokens actually computed). */
  paddedTokens: number;
  /** Σ real tokens. */
  realTokens: number;
}

export function planBuckets(lengths: ArrayLike<number>, overhead: number, maxBucket = Infinity): BucketPlan {
  const n = lengths.length;
  if (n === 0) return { buckets: [], lengths: [], paddedTokens: 0, realTokens: 0 };
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => lengths[a]! - lengths[b]! || a - b);
  const len = order.map((i) => Math.max(1, lengths[i]!));

  // dp[i] = min cost to cover the first i sorted items; cut[i] = start of the last group.
  const dp = new Float64Array(n + 1);
  const cut = new Int32Array(n + 1);
  dp[0] = 0;
  for (let i = 1; i <= n; i++) {
    let best = Infinity;
    let bestJ = 0;
    const lo = Number.isFinite(maxBucket) ? Math.max(0, i - maxBucket) : 0;
    for (let j = i - 1; j >= lo; j--) {
      // group = sorted[j .. i-1], padded to len[i-1] (the longest, as sorted)
      const c = dp[j]! + overhead + (i - j) * len[i - 1]!;
      if (c < best) {
        best = c;
        bestJ = j;
      }
    }
    dp[i] = best;
    cut[i] = bestJ;
  }

  const buckets: number[][] = [];
  const blens: number[] = [];
  let i = n;
  while (i > 0) {
    const j = cut[i]!;
    buckets.push(order.slice(j, i));
    blens.push(len[i - 1]!);
    i = j;
  }
  buckets.reverse();
  blens.reverse();
  let padded = 0;
  for (let b = 0; b < buckets.length; b++) padded += buckets[b]!.length * blens[b]!;
  let real = 0;
  for (const l of len) real += l;
  return { buckets, lengths: blens, paddedTokens: padded, realTokens: real };
}
