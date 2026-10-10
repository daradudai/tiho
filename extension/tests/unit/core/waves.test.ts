import { describe, expect, it } from 'vitest';
import { hamming64, simhash64 } from '../../../src/core/hash';
import { normalize } from '../../../src/core/normalize';
import { WaveDetector, waveKey, type WaveHit } from '../../../src/core/waves';

const obs = (w: WaveDetector, text: string, user: string, key: string, ts: number, alive?: (k: string) => boolean) =>
  w.observe(normalize(text), user, key, ts, text, alive);

describe('waveKey', () => {
  it('merges repeated / reordered short emote combos', () => {
    expect(waveKey('kekw')).toBe('kekw');
    expect(waveKey('kekw kekw kekw')).toBe('kekw');
    expect(waveKey('lul kekw')).toBe(waveKey('kekw lul'));
    expect(waveKey('this is a much longer sentence here')).toBe('this is a much longer sentence here');
  });
});

describe('WaveDetector', () => {
  it('detects ≥ N distinct users within the window, head = first message', () => {
    const w = new WaveDetector({ minUsers: 4 });
    expect(obs(w, 'KEKW', 'a', 'm1', 0)).toBeNull();
    expect(obs(w, 'KEKW KEKW', 'b', 'm2', 1000)).toBeNull();
    expect(obs(w, 'kekw', 'c', 'm3', 2000)).toBeNull();
    const hit = obs(w, 'KEKW', 'd', 'm4', 3000)!;
    expect(hit).not.toBeNull();
    expect(hit.role).toBe('member');
    expect(hit.headKey).toBe('m1');
    expect(hit.retro).toEqual(['m2', 'm3']);
    expect(hit.count).toBe(4);
    const next = obs(w, 'KEKW', 'e', 'm5', 4000)!;
    expect(next.role).toBe('member');
    expect(next.count).toBe(5);
    expect(next.retro).toBeUndefined();
    expect(w.countOf(next.id)).toBe(5);
  });

  it('the head seen again stays the head, even while its key is alive', () => {
    const w = new WaveDetector({ minUsers: 2 });
    obs(w, 'KEKW', 'a', 'm1', 0);
    expect(obs(w, 'KEKW', 'b', 'm2', 100)!.headKey).toBe('m1');
    const again = obs(w, 'KEKW', 'a', 'm1', 200, () => true)!;
    expect(again.role).toBe('head');
    expect(again.headKey).toBe('m1');
  });

  it('same user repeating is not a wave', () => {
    const w = new WaveDetector({ minUsers: 3 });
    for (let i = 0; i < 10; i++) expect(obs(w, 'PogChamp', 'same', `m${i}`, i * 100)).toBeNull();
  });

  it('users spread wider than the window do not form a wave', () => {
    const w = new WaveDetector({ minUsers: 4, windowMs: 10_000 });
    expect(obs(w, 'lol', 'a', 'm1', 0)).toBeNull();
    expect(obs(w, 'lol', 'b', 'm2', 6000)).toBeNull();
    expect(obs(w, 'lol', 'c', 'm3', 12_000)).toBeNull();
    expect(obs(w, 'lol', 'd', 'm4', 18_000)).toBeNull();
  });

  it('cluster expires after silence', () => {
    const w = new WaveDetector({ minUsers: 2, windowMs: 1000 });
    obs(w, 'hype', 'a', 'm1', 0);
    expect(obs(w, 'hype', 'b', 'm2', 5000)).toBeNull(); // new cluster
    expect(obs(w, 'hype', 'c', 'm3', 5500)).not.toBeNull();
  });

  it('matches near-duplicate copypasta via SimHash', () => {
    const base =
      'I am the streamer now. Everybody listen to me, I will be taking over the stream and you will all obey me';
    const variants = [
      base,
      base + ' KEKW',
      base.replace('Everybody', 'Everyone'),
      base.replace('obey', 'obay') + '!!',
      'LUL ' + base,
    ];
    const w = new WaveDetector({ minUsers: 4 });
    let hit: WaveHit | null = null;
    variants.forEach((t, i) => {
      hit = obs(w, t, `u${i}`, `m${i}`, i * 500) ?? hit;
    });
    expect(hit).not.toBeNull();
  });

  it('does not merge unrelated messages', () => {
    const w = new WaveDetector({ minUsers: 2 });
    const texts = [
      'what game is this streamer playing today',
      'can someone tell me the song name please',
      'this boss fight is taking forever honestly',
      'i think he should use the other weapon here',
      'how long has the stream been going on for',
    ];
    texts.forEach((t, i) => expect(obs(w, t, `u${i}`, `m${i}`, i * 100)).toBeNull());
  });

  it('promotes a new head when the old head row is gone', () => {
    const w = new WaveDetector({ minUsers: 2 });
    obs(w, 'GG', 'a', 'm1', 0);
    const alive = new Set(['m1', 'm2']);
    const h1 = obs(w, 'GG', 'b', 'm2', 100, (k) => alive.has(k))!;
    expect(h1.headKey).toBe('m1');
    alive.delete('m1');
    const h2 = obs(w, 'GG', 'c', 'm3', 200, (k) => alive.has(k) || k === 'm3')!;
    expect(h2.role).toBe('head');
    expect(h2.headKey).toBe('m3');
    const h3 = obs(w, 'GG', 'd', 'm4', 300, () => true)!;
    expect(h3.role).toBe('member');
    expect(h3.headKey).toBe('m3');
  });

  it('lists active and ended waves, most recent first', () => {
    const w = new WaveDetector({ minUsers: 2, windowMs: 1000 });
    obs(w, 'first wave', 'a', 'a1', 0);
    obs(w, 'first wave', 'b', 'a2', 10);
    obs(w, 'second wave', 'a', 'b1', 500);
    obs(w, 'second wave', 'b', 'b2', 600);
    let l = w.list(700);
    expect(l.map((x) => x.text)).toEqual(['second wave', 'first wave']);
    w.sweep(5000);
    l = w.list(5000);
    expect(l.length).toBe(2); // ended waves are kept as "recent"
    expect(w.clusters).toBe(0);
  });

  it('memory stays bounded with unique traffic', () => {
    const w = new WaveDetector({ maxClusters: 2000 });
    for (let i = 0; i < 50_000; i++) w.observe(`unique message number ${i} with some padding`, `u${i}`, `k${i}`, i, 'x');
    expect(w.clusters).toBeLessThanOrEqual(2000);
  });

  it('is O(1)-ish: 100k observations quickly', () => {
    const w = new WaveDetector();
    const texts = Array.from({ length: 500 }, (_, i) => normalize(`message ${i % 50} about thing ${i} lol`));
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) {
      w.observe(texts[i % 500]!, `u${i % 997}`, `k${i}`, i * 10, 'x');
      if (i % 100 === 0) w.sweep(i * 10); // ~1 Hz at 100 msg/s
    }
    const per = (performance.now() - t0) / 100_000;
    expect(per).toBeLessThan(0.03); // < 30 µs, typically a few µs
  });
});

describe('simhash64', () => {
  it('near texts are close, different texts are far', () => {
    const a = simhash64('the quick brown fox jumps over the lazy dog', new Uint32Array(2));
    const b = simhash64('the quick brown fox jumps over the lazy dog!', new Uint32Array(2));
    const c = simhash64('completely unrelated sentence about cooking pasta', new Uint32Array(2));
    const dAB = hamming64(a[0]!, a[1]!, b[0]!, b[1]!);
    const dAC = hamming64(a[0]!, a[1]!, c[0]!, c[1]!);
    expect(dAB).toBeLessThan(8);
    expect(dAC).toBeGreaterThan(16);
  });
});
