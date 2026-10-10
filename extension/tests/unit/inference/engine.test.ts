import { describe, expect, it } from 'vitest';
import { LABELS } from '../../../src/core/types';
import { InferenceEngine, type ModelLike } from '../../../src/inference/engine';
import type { WorkerOut } from '../../../src/inference/messages';
import { LatencyRing, RateMeter } from '../../../src/inference/stats';

const K = LABELS.length;

function fakeModel(over: Partial<ModelLike> = {}, runs: number[][][] = []): ModelLike {
  return {
    backend: 'wasm',
    variant: 'q8',
    version: 'test',
    maxLen: 64,
    thresholds: LABELS.map(() => 0.5),
    loadMs: 1,
    // one token per character, capped
    tokenize: (t: string) => Array.from({ length: Math.min(64, t.length + 2) }, (_, i) => i),
    run: async (seqs: number[][]) => {
      runs.push(seqs);
      const out = new Float32Array(seqs.length * K);
      seqs.forEach((s, b) => out.fill(s.length / 100, b * K, (b + 1) * K));
      return out;
    },
    dispose: async () => {},
    ...over,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('InferenceEngine', () => {
  it('loads, reports ready with thresholds, and answers aligned scores', async () => {
    const out: WorkerOut[] = [];
    const runs: number[][][] = [];
    const e = new InferenceEngine({ post: (m) => out.push(m), load: async () => fakeModel({}, runs) });
    e.init({ tuning: { maxWaitMs: 0 } });
    await until(() => e.getStatus().state === 'ready');
    const st = e.getStatus();
    expect(st.backend).toBe('wasm');
    expect(st.thresholds).toHaveLength(K);
    await e.classify(1, [
      { id: 'a', text: 'hi' },
      { id: 'b', text: 'a much longer message' },
    ]);
    const r = out.find((m) => m.type === 'scores') as Extract<WorkerOut, { type: 'scores' }>;
    expect(r.id).toBe(1);
    expect(r.ids).toEqual(['a', 'b']);
    expect(r.scores[0]).toHaveLength(K);
    expect(r.scores[0]![0]).toBeCloseTo(4 / 100, 4); // 'hi' → 4 tokens
    expect(r.scores[1]![0]).toBeCloseTo(23 / 100, 4);
    expect(r.backend).toBe('wasm');
  });

  it('caches by id across requests', async () => {
    const out: WorkerOut[] = [];
    const runs: number[][][] = [];
    const e = new InferenceEngine({ post: (m) => out.push(m), load: async () => fakeModel({}, runs) });
    e.init({ tuning: { maxWaitMs: 0 } });
    await e.classify(1, [{ id: 'a', text: 'x' }]);
    await e.classify(2, [{ id: 'a', text: 'x' }]);
    expect(runs.flat()).toHaveLength(1);
    expect(e.stats().cacheHitRate).toBeGreaterThan(0);
  });

  it('buckets very different lengths into separate forward calls on wasm', async () => {
    const runs: number[][][] = [];
    const e = new InferenceEngine({ post: () => {}, load: async () => fakeModel({}, runs) });
    e.init({ tuning: { maxWaitMs: 0, bucketOverhead: { wasm: 4, webgpu: 1000 } }, cache: false });
    const items = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, text: 'ab' })),
      { id: 'long', text: 'x'.repeat(80) },
    ];
    await e.classify(1, items);
    expect(runs.length).toBe(2);
    expect(runs.map((r) => r.length).sort((a, b) => a - b)).toEqual([1, 20]);
    expect(e.stats().padRatio).toBe(1);
  });

  it('reports load failure as error status and errors requests', async () => {
    const out: WorkerOut[] = [];
    const e = new InferenceEngine({
      post: (m) => out.push(m),
      load: async () => {
        throw new Error('no model');
      },
    });
    e.init({});
    await until(() => e.getStatus().state === 'error');
    expect(e.getStatus().error).toContain('no model');
    await e.classify(5, [{ id: 'a', text: 'x' }]);
    const err = out.find((m) => m.type === 'error') as Extract<WorkerOut, { type: 'error' }>;
    expect(err.id).toBe(5);
  });

  it('falls back to wasm after repeated WebGPU run failures', async () => {
    const devices: string[] = [];
    const e = new InferenceEngine({
      post: () => {},
      load: async (opts) => {
        devices.push(String(opts.device));
        if (opts.device === 'wasm') return fakeModel();
        return fakeModel({
          backend: 'webgpu',
          run: async () => {
            throw new Error('device lost');
          },
        });
      },
    });
    e.init({ device: 'auto', tuning: { maxWaitMs: 0 }, cache: false });
    await until(() => e.getStatus().state === 'ready');
    await e.classify(1, [{ id: 'a', text: 'x' }]);
    await e.classify(2, [{ id: 'b', text: 'y' }]);
    await until(() => e.getStatus().state === 'ready' && e.getStatus().backend === 'wasm');
    expect(devices).toEqual(['auto', 'wasm']);
    await tick();
  });

  it('forgets cached scores when another student is loaded (6-layer on WebGPU → 3-layer on WASM)', async () => {
    const out: WorkerOut[] = [];
    let gpuOk = true;
    const six = (seqs: number[][]) => new Float32Array(seqs.length * K).fill(0.45);
    const e = new InferenceEngine({
      post: (m) => out.push(m),
      load: async (opts) =>
        opts.device === 'wasm'
          ? fakeModel({ variant: 'uint8', version: 'v2-3L', thresholds: LABELS.map(() => 0.34) })
          : fakeModel({
              backend: 'webgpu',
              variant: 'q8',
              version: 'v2-6L',
              run: async (seqs) => {
                if (!gpuOk) throw new Error('device lost');
                return six(seqs);
              },
            }),
    });
    e.init({ device: 'auto', tuning: { maxWaitMs: 0 } });
    await e.classify(1, [{ id: 'kekw', text: 'KEKW' }]);
    gpuOk = false;
    await e.classify(2, [{ id: 'a', text: 'x' }]);
    await e.classify(3, [{ id: 'b', text: 'y' }]);
    await until(() => e.getStatus().state === 'ready' && e.getStatus().version === 'v2-3L');
    await e.classify(4, [{ id: 'kekw', text: 'KEKW' }]);
    const r = out.filter((m) => m.type === 'scores') as Extract<WorkerOut, { type: 'scores' }>[];
    expect(r[0]!.scores[0]![1]).toBeCloseTo(0.45); // 6-layer
    expect(r.at(-1)!.id).toBe(4);
    expect(r.at(-1)!.scores[0]![1]).toBeCloseTo(6 / 100); // scored again by the 3-layer, not the 6-layer's 0.45 from the cache
  });

  it('runs a batch again when the model is replaced during its forward pass', async () => {
    const out: WorkerOut[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const e = new InferenceEngine({
      post: (m) => out.push(m),
      load: async (opts) =>
        opts.device === 'wasm'
          ? fakeModel({ variant: 'uint8', version: 'v2-3L' })
          : fakeModel({
              backend: 'webgpu',
              version: 'v2-6L',
              run: async (seqs) => {
                await gate;
                return new Float32Array(seqs.length * K).fill(0.9);
              },
            }),
    });
    e.init({ device: 'webgpu', tuning: { maxWaitMs: 0 } });
    await until(() => e.getStatus().state === 'ready');
    const p = e.classify(1, [{ id: 'a', text: 'x' }]);
    await tick();
    e.init({ device: 'wasm' }); // "Use the GPU" switched off mid-pass
    await until(() => e.getStatus().version === 'v2-3L');
    release();
    await p;
    const r = out.find((m) => m.type === 'scores') as Extract<WorkerOut, { type: 'scores' }>;
    expect(r.scores[0]![0]).toBeCloseTo(3 / 100); // the 3-layer's answer, never the old model's 0.9
    await e.classify(2, [{ id: 'a', text: 'x' }]);
    const again = out.filter((m) => m.type === 'scores').at(-1) as Extract<WorkerOut, { type: 'scores' }>;
    expect(again.scores[0]![0]).toBeCloseTo(3 / 100); // and the cache holds that one too
  });

  it('disposes the model after idleDisposeMs and reloads on demand', async () => {
    let now = 0;
    let loads = 0;
    const e = new InferenceEngine({
      post: () => {},
      now: () => now,
      load: async () => {
        loads++;
        return fakeModel();
      },
    });
    e.init({ tuning: { maxWaitMs: 0, idleDisposeMs: 1000 } });
    await until(() => e.getStatus().state === 'ready');
    await e.classify(1, [{ id: 'a', text: 'x' }]);
    now = 5000;
    e.maybeIdleDispose();
    await until(() => e.getStatus().state === 'idle');
    await e.classify(2, [{ id: 'b', text: 'y' }]);
    expect(loads).toBe(2);
    expect(e.getStatus().state).toBe('ready');
  });
});

describe('stats helpers', () => {
  it('LatencyRing percentiles', () => {
    const r = new LatencyRing(100);
    for (let i = 1; i <= 100; i++) r.push(i);
    expect(r.percentile(0.5)).toBe(50);
    expect(r.percentile(0.95)).toBe(95);
    for (let i = 0; i < 100; i++) r.push(1000); // ring overwrites
    expect(r.percentile(0.5)).toBe(1000);
  });

  it('RateMeter counts events inside the window only', () => {
    let t = 0;
    const m = new RateMeter(1000, 100, () => t);
    m.add(50);
    t = 500;
    m.add(50);
    expect(m.rate()).toBe(100);
    t = 1550;
    expect(m.rate()).toBe(0);
  });
});
