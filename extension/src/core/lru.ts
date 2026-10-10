// Tiny bounded LRU on top of Map insertion order.
//
// get() refreshes recency (delete + re-insert), set() evicts the least
// recently used entry once `capacity` is exceeded. All operations O(1).

export class LRU<K, V> {
  private map = new Map<K, V>();
  hits = 0;
  misses = 0;

  constructor(public readonly capacity: number) {
    if (!(capacity > 0)) throw new Error('LRU capacity must be > 0');
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const m = this.map;
    const v = m.get(key);
    if (v === undefined) {
      if (!m.has(key)) {
        this.misses++;
        return undefined;
      }
    }
    // refresh recency
    m.delete(key);
    m.set(key, v as V);
    this.hits++;
    return v;
  }

  /** Read without touching recency or hit counters. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): this {
    const m = this.map;
    if (m.has(key)) m.delete(key);
    m.set(key, value);
    if (m.size > this.capacity) {
      // Map iterates in insertion order: first key is the LRU one.
      const oldest = m.keys().next().value as K;
      m.delete(oldest);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  hitRate(): number {
    const t = this.hits + this.misses;
    return t ? this.hits / t : 0;
  }
}
