// Small, allocation-free hashing helpers.

/** 32-bit FNV-1a over UTF-16 code units. */
export function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Murmur3 finalizer: good avalanche for a 32-bit input. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

// SWAR counters: 16 words × 4 byte-lanes = one 8-bit counter per hash bit.
const lanes = new Uint32Array(16);

/**
 * 64-bit SimHash over character 3-grams of `s` (padded with spaces so short
 * strings still produce grams; at most 255 grams). Bit i is set when more
 * than half of the gram hashes have it set. Returns [hi, lo] as unsigned
 * 32-bit ints in a caller-provided tuple to avoid allocation.
 *
 * Bits are counted SWAR-style (8 adds per 32-bit hash instead of 32), so a
 * 60-char message costs ~1 µs.
 */
export function simhash64(s: string, out: Uint32Array): Uint32Array {
  lanes.fill(0);
  const len = s.length < 255 ? s.length : 255;
  // `len` grams over " " + s + " "
  let a = 0x20;
  let b = len > 0 ? s.charCodeAt(0) : 0x20;
  for (let k = 0; k < len; k++) {
    const c = k + 1 < len ? s.charCodeAt(k + 1) : 0x20;
    const h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d);
    const h1 = fmix32(h);
    const h2 = fmix32(h ^ 0x5bd1e995);
    for (let j = 0; j < 8; j++) {
      lanes[j]! += (h1 >>> j) & 0x01010101;
      lanes[8 + j]! += (h2 >>> j) & 0x01010101;
    }
    a = b;
    b = c;
  }
  let hi = 0;
  let lo = 0;
  for (let j = 0; j < 8; j++) {
    const w1 = lanes[j]!;
    const w2 = lanes[8 + j]!;
    for (let byte = 0; byte < 4; byte++) {
      const bit = byte * 8 + j;
      if (((w1 >>> (byte * 8)) & 0xff) * 2 > len) lo |= 1 << bit;
      if (((w2 >>> (byte * 8)) & 0xff) * 2 > len) hi |= 1 << bit;
    }
  }
  out[0] = hi >>> 0;
  out[1] = lo >>> 0;
  return out;
}

export function hamming64(aHi: number, aLo: number, bHi: number, bLo: number): number {
  return popcount32((aHi ^ bHi) >>> 0) + popcount32((aLo ^ bLo) >>> 0);
}
