// Cross-user wave detection ("KEKW ×37").
//
// A wave = many distinct users posting (near-)identical text within a short
// window. Waves are culture, not spam: the first message stays visible with a
// live counter, later ones collapse into it.
//
// Matching, O(1) amortized per message:
//   1. exact key: normalized text (short messages: the set of distinct tokens,
//      so "KEKW", "KEKW KEKW" and "kekw" are one wave);
//   2. near-duplicates (copypasta with small edits): 64-bit SimHash over char
//      3-grams, LSH-indexed by 8 bands of 8 bits; candidates verified by
//      Hamming distance (≤ 9 by default: edits measure 3–11 bits on a 100-char
//      copypasta, unrelated texts ~32). A cluster keeps up to 4 representative
//      hashes so drifting variants still find it.
// Memory is bounded: clusters expire after `windowMs` of silence, at most
// `maxClusters` are kept, bucket lists are capped.

import { hamming64, simhash64 } from './hash';
import type { WaveInfo } from './store';

export interface WaveOptions {
  /** Sliding window: users must post within this span; clusters die after this much silence. */
  windowMs?: number;
  /** Distinct users needed to call it a wave. */
  minUsers?: number;
  /** Max Hamming distance for near-duplicate matches. */
  maxHamming?: number;
  /** Shortest normalized text that gets a SimHash (shorter texts match exactly only). */
  minSimLen?: number;
  maxClusters?: number;
}

export interface WaveHit {
  id: string;
  /** 'head' = visible message carrying the counter; 'member' = collapses into the head. */
  role: 'head' | 'member';
  /** Messages in the wave so far (including this one). */
  count: number;
  /** Distinct users so far. */
  users: number;
  /** Message key of the current head. */
  headKey: string;
  /**
   * Only on the message that turned the cluster into a wave: keys of the
   * earlier messages (already shown) that should now collapse into the head.
   */
  retro?: string[];
}

interface RingEntry {
  user: string;
  key: string;
  ts: number;
}

interface Cluster {
  id: number;
  text: string;
  startedAt: number;
  lastAt: number;
  count: number;
  users: Set<string>;
  userCount: number;
  ring: RingEntry[];
  isWave: boolean;
  headKey: string;
  /** Representative SimHashes (hi, lo pairs), ≤ MAX_SIMS. */
  sims: number[];
  /** Exact keys registered for this cluster (for cleanup). */
  keys: string[];
  dead: boolean;
}

const BANDS = 8;
const RING = 16;
const MAX_KEYS = 24;
const MAX_SIMS = 4;
const BUCKET = 12;
const MAX_USERS_TRACKED = 512;

/** Exact-match key: short messages → sorted distinct tokens; longer → normalized text. */
export function waveKey(norm: string): string {
  if (norm.length > 48) return norm;
  let spaces = 0;
  for (let i = 0; i < norm.length; i++) if (norm.charCodeAt(i) === 0x20) spaces++;
  if (spaces === 0 || spaces > 3) return norm;
  const toks = norm.split(' ');
  const uniq = Array.from(new Set(toks)).sort();
  return uniq.join(' ');
}

function band(hi: number, lo: number, b: number): number {
  return b < 4 ? (lo >>> (b * 8)) & 0xff : (hi >>> ((b - 4) * 8)) & 0xff;
}

export class WaveDetector {
  readonly windowMs: number;
  readonly minUsers: number;
  readonly maxHamming: number;
  readonly minSimLen: number;
  readonly maxClusters: number;

  private exact = new Map<string, Cluster>();
  private bands: Map<number, Cluster[]>[] = [];
  private active = new Map<number, Cluster>();
  private ended: WaveInfo[] = [];
  private nextId = 1;
  private sim = new Uint32Array(2);
  /** Number of clusters alive (for tests / metrics). */
  clusters = 0;

  constructor(opts: WaveOptions = {}) {
    this.windowMs = opts.windowMs ?? 10_000;
    this.minUsers = Math.max(2, opts.minUsers ?? 4);
    this.maxHamming = opts.maxHamming ?? 9;
    this.minSimLen = opts.minSimLen ?? 24;
    this.maxClusters = opts.maxClusters ?? 4096;
    for (let b = 0; b < BANDS; b++) this.bands.push(new Map());
  }

  /**
   * Feed one message. Returns null while the message is not part of a wave.
   * `headAlive(key)` lets the caller report that the head row is gone (scrolled
   * out / recycled); the current message is then promoted to head.
   */
  observe(
    norm: string,
    user: string,
    msgKey: string,
    ts: number,
    text: string,
    headAlive?: (key: string) => boolean,
  ): WaveHit | null {
    if (!norm) return null;
    const wk = waveKey(norm);
    let c = this.exact.get(wk);
    if (c && (c.dead || ts - c.lastAt > this.windowMs)) {
      this.kill(c);
      c = undefined;
    }
    let simDone = false;
    if (!c && wk.length >= this.minSimLen) {
      simhash64(wk, this.sim);
      simDone = true;
      const hi = this.sim[0]!;
      const lo = this.sim[1]!;
      c = this.nearest(hi, lo, ts);
      if (c) {
        if (c.keys.length < MAX_KEYS) {
          c.keys.push(wk);
          this.exact.set(wk, c);
        }
        if (c.sims.length < MAX_SIMS * 2) this.index(c, hi, lo);
      }
    }

    if (!c) {
      this.create(wk, user, msgKey, ts, text, simDone);
      return null;
    }

    // ── join cluster
    c.count++;
    c.lastAt = ts;
    if (!c.users.has(user)) {
      c.userCount++;
      if (c.users.size < MAX_USERS_TRACKED) c.users.add(user);
    }

    if (c.isWave) {
      let role: WaveHit['role'] = 'member';
      // the head seen again (its row re-mounted) stays the head
      if (c.headKey === msgKey || (headAlive && !headAlive(c.headKey))) {
        c.headKey = msgKey;
        role = 'head';
      }
      return { id: 'w' + c.id, role, count: c.count, users: c.userCount, headKey: c.headKey };
    }

    // ── not a wave yet: sliding-window distinct users
    const ring = c.ring;
    if (ring.length >= RING) ring.shift();
    ring.push({ user, key: msgKey, ts });
    const from = ts - this.windowMs;
    let start = 0;
    while (start < ring.length && ring[start]!.ts < from) start++;
    if (start > 0) ring.splice(0, start);
    let distinct = 0;
    for (let i = 0; i < ring.length; i++) {
      let seen = false;
      for (let j = 0; j < i; j++)
        if (ring[j]!.user === ring[i]!.user) {
          seen = true;
          break;
        }
      if (!seen) distinct++;
    }
    if (distinct < this.minUsers) return null;

    // ── wave detected
    c.isWave = true;
    c.count = ring.length;
    c.startedAt = ring[0]!.ts;
    c.headKey = ring[0]!.key;
    const retro: string[] = [];
    for (let i = 1; i < ring.length - 1; i++) retro.push(ring[i]!.key);
    c.ring = [];
    this.active.set(c.id, c);
    let role: WaveHit['role'] = 'member';
    if (headAlive && !headAlive(c.headKey)) {
      c.headKey = msgKey;
      role = 'head';
    }
    return { id: 'w' + c.id, role, count: c.count, users: c.userCount, headKey: c.headKey, retro };
  }

  /** Current count for a wave id (for counters), 0 if unknown. */
  countOf(id: string): number {
    const c = this.active.get(Number(id.slice(1)));
    return c ? c.count : 0;
  }

  isActive(id: string): boolean {
    const c = this.active.get(Number(id.slice(1)));
    return !!c && !c.dead;
  }

  /** Expire silent clusters. Call about once per second. */
  sweep(now: number): void {
    const win = this.windowMs;
    for (const [k, c] of this.exact) {
      if (c.dead) this.exact.delete(k);
      else if (now - c.lastAt > win) this.kill(c);
    }
    // Band buckets: drop fully-dead lists; partially dead ones are capped
    // (BUCKET) and skipped by nearest(), so no per-key reallocation here.
    for (const m of this.bands) {
      for (const [k, list] of m) {
        let alive = false;
        for (let i = list.length - 1; i >= 0; i--) {
          const c = list[i]!;
          if (!c.dead && now - c.lastAt <= win) {
            alive = true;
            break;
          }
        }
        if (!alive) m.delete(k);
      }
    }
    for (const c of this.active.values()) if (c.dead || now - c.lastAt > win) this.kill(c);
  }

  /** Active waves (live counters) + recently ended, most recent first, ≤ limit. */
  list(now: number, limit = 10): WaveInfo[] {
    const out: WaveInfo[] = [];
    for (const c of this.active.values()) {
      if (now - c.lastAt <= this.windowMs) out.push(info(c));
    }
    out.sort((a, b) => b.lastAt - a.lastAt);
    for (const w of this.ended) {
      if (out.length >= limit) break;
      if (!out.some((o) => o.id === w.id)) out.push(w);
    }
    return out.slice(0, limit);
  }

  reset(): void {
    this.exact.clear();
    for (const m of this.bands) m.clear();
    this.active.clear();
    this.ended = [];
    this.clusters = 0;
  }

  // ───────────────────────── internals ─────────────────────────

  private create(wk: string, user: string, msgKey: string, ts: number, text: string, simDone: boolean): void {
    if (this.clusters >= this.maxClusters) {
      this.sweep(ts);
      if (this.clusters >= this.maxClusters) this.evictOldest();
    }
    const c: Cluster = {
      id: this.nextId++,
      text,
      startedAt: ts,
      lastAt: ts,
      count: 1,
      users: new Set([user]),
      userCount: 1,
      ring: [{ user, key: msgKey, ts }],
      isWave: false,
      headKey: msgKey,
      sims: [],
      keys: [wk],
      dead: false,
    };
    this.exact.set(wk, c);
    this.clusters++;
    if (wk.length >= this.minSimLen) {
      if (!simDone) simhash64(wk, this.sim);
      this.index(c, this.sim[0]!, this.sim[1]!);
    }
  }

  /** Add a representative hash to a cluster and to the band index. */
  private index(c: Cluster, hi: number, lo: number): void {
    c.sims.push(hi, lo);
    for (let b = 0; b < BANDS; b++) {
      const m = this.bands[b]!;
      const key = band(hi, lo, b);
      const list = m.get(key);
      if (!list) m.set(key, [c]);
      else if (list[list.length - 1] !== c) {
        if (list.length >= BUCKET) list.shift();
        list.push(c);
      }
    }
  }

  private nearest(hi: number, lo: number, ts: number): Cluster | undefined {
    let best: Cluster | undefined;
    let bestD = this.maxHamming + 1;
    for (let b = 0; b < BANDS; b++) {
      const list = this.bands[b]!.get(band(hi, lo, b));
      if (!list) continue;
      for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i]!;
        if (c.dead || ts - c.lastAt > this.windowMs) continue;
        const s = c.sims;
        for (let j = 0; j < s.length; j += 2) {
          const d = hamming64(hi, lo, s[j]!, s[j + 1]!);
          if (d < bestD) {
            bestD = d;
            best = c;
            if (d === 0) return c;
          }
        }
      }
    }
    return best;
  }

  private kill(c: Cluster): void {
    if (c.dead) return;
    c.dead = true;
    this.clusters--;
    for (const k of c.keys) if (this.exact.get(k) === c) this.exact.delete(k);
    if (c.isWave) {
      this.active.delete(c.id);
      this.ended.unshift(info(c));
      if (this.ended.length > 10) this.ended.length = 10;
    }
    // band entries are pruned lazily (skipped as dead, removed by sweep)
  }

  private evictOldest(): void {
    // Map preserves insertion order: the first entries are the oldest clusters.
    let n = Math.max(1, this.maxClusters >> 4);
    for (const c of this.exact.values()) {
      if (n-- <= 0) break;
      this.kill(c);
    }
  }
}

function info(c: Cluster): WaveInfo {
  return {
    id: 'w' + c.id,
    text: c.text,
    count: c.count,
    users: c.userCount,
    startedAt: c.startedAt,
    lastAt: c.lastAt,
  };
}
