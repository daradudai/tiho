// Bench page (built only with TIHO_BENCH=1). Exposes `window.tihoBench` for
// tests/bench/bench.mjs:
//   - run(cfg):      spawns a fresh inference worker (same code the offscreen
//                    document uses), loads the model with a forced backend /
//                    file, then measures fixed-size batches and a simulated chat stream.
//   - pipeline(cfg): goes through the real path (Port → background → offscreen → worker).
//   - env():         WebGPU / cross-origin-isolation facts.

import { PORT_CLASSIFY, type PortResponse } from '../../core/protocol';
import type { ModelStatus } from '../../core/types';
import { LOCAL_MODEL_DIR, ORT_DIR, type Device } from '../../inference/config';
import type { InferenceStats, InitOptions, WorkerIn, WorkerOut } from '../../inference/messages';
import { webgpuInfo } from '../../inference/gpu';

const logEl = document.getElementById('log')!;
const log = (...a: unknown[]) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  logEl.textContent += s + '\n';
  console.log('[bench]', s);
};

interface RunCfg {
  device: Device;
  variant: string;
  threads?: number;
  texts: string[];
  batchSizes: number[];
  /** Items per batch size to push through (≥ batch size). */
  itemsPerSize: number;
  /** Simulated chat stream: msgs/s and duration. */
  stream?: { rate: number; seconds: number; maxWaitMs: number };
}

function pct(a: number[], p: number): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}
const r2 = (x: number) => Math.round(x * 100) / 100;

class WorkerClient {
  w: Worker;
  private waiters = new Map<number, (m: WorkerOut) => void>();
  private statusWaiters: Array<(s: ModelStatus) => void> = [];
  status: ModelStatus = { state: 'idle', backend: 'none' };
  lastStats: InferenceStats | null = null;
  private seq = 1;

  constructor() {
    this.w = new Worker(new URL('../../inference/worker.ts', import.meta.url), { type: 'module', name: 'tiho-bench' });
    this.w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === 'status') {
        this.status = m.status;
        if (m.stats) this.lastStats = m.stats;
        for (const w of this.statusWaiters.splice(0)) w(m.status);
      } else if (m.type === 'scores' || m.type === 'error') {
        this.waiters.get(m.id)?.(m);
        this.waiters.delete(m.id);
      } else if (m.type === 'stats') {
        this.lastStats = m.stats;
        if (m.reqId !== undefined) this.waiters.get(-m.reqId)?.(m);
      }
    };
  }

  post(m: WorkerIn) {
    this.w.postMessage(m);
  }

  async waitReady(timeoutMs = 600_000): Promise<ModelStatus> {
    const t0 = performance.now();
    while (this.status.state !== 'ready' && this.status.state !== 'error') {
      if (performance.now() - t0 > timeoutMs) throw new Error('load timeout');
      await new Promise<ModelStatus>((r) => this.statusWaiters.push(r));
    }
    return this.status;
  }

  classify(items: { id: string; text: string }[]): Promise<WorkerOut> {
    const id = this.seq++;
    return new Promise((r) => {
      this.waiters.set(id, r);
      this.post({ type: 'classify', id, items });
    });
  }

  stats(): Promise<InferenceStats> {
    const reqId = this.seq++;
    return new Promise((r) => {
      this.waiters.set(-reqId, (m) => r((m as { stats: InferenceStats }).stats));
      this.post({ type: 'getStats', reqId });
    });
  }

  terminate() {
    this.w.terminate();
  }
}

async function memory(): Promise<Record<string, number> | null> {
  const p = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    memory?: { usedJSHeapSize: number };
  };
  const out: Record<string, number> = {};
  if (p.memory) out.pageJsHeapMB = r2(p.memory.usedJSHeapSize / 1e6);
  if (crossOriginIsolated && p.measureUserAgentSpecificMemory) {
    try {
      const m = await Promise.race([
        p.measureUserAgentSpecificMemory(),
        new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
      ]);
      if (m) out.uaSpecificMB = r2(m.bytes / 1e6);
    } catch {
      /* not allowed */
    }
  }
  return out;
}

async function run(cfg: RunCfg) {
  const res: Record<string, unknown> = { device: cfg.device, variant: cfg.variant };
  const c = new WorkerClient();
  try {
    const t0 = performance.now();
    const opts: InitOptions = {
      localModelBase: chrome.runtime.getURL(LOCAL_MODEL_DIR),
      ortBase: chrome.runtime.getURL(ORT_DIR),
      device: cfg.device,
      variant: cfg.variant,
      threads: cfg.threads,
      cache: false,
      tuning: { maxWaitMs: 0, idleDisposeMs: 0, maxBatch: 64 },
    };
    c.post({ type: 'init', opts });
    const st = await c.waitReady();
    res.loadMs = Math.round(performance.now() - t0);
    if (st.state !== 'ready') {
      res.error = st.error;
      return res;
    }
    res.backend = st.backend;
    res.modelId = st.modelId;
    const s0 = await c.stats();
    res.threads = s0.threads;
    res.crossOriginIsolated = s0.crossOriginIsolated;
    res.workerLoadMs = s0.loadMs;

    let k = 0;
    const next = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => {
        const text = cfg.texts[k++ % cfg.texts.length]!;
        return { id: `${tag}:${k}:${i}`, text };
      });

    // first-request latency after load (shapes not seen in warmup)
    const tf = performance.now();
    await c.classify(next(8, 'first'));
    res.firstBatch8Ms = r2(performance.now() - tf);

    const sizes: Record<string, unknown> = {};
    for (const B of cfg.batchSizes) {
      const lat: number[] = [];
      const n = Math.max(B * 3, Math.ceil(cfg.itemsPerSize / B) * B);
      // warm this size
      await c.classify(next(B, `w${B}`));
      const t = performance.now();
      for (let done = 0; done < n; done += B) {
        const t1 = performance.now();
        const out = await c.classify(next(B, `b${B}`));
        if (out.type === 'error') throw new Error(out.error);
        lat.push(performance.now() - t1);
      }
      const total = performance.now() - t;
      sizes[B] = { msgsPerSec: Math.round((n * 1000) / total), p50ms: r2(pct(lat, 0.5)), p95ms: r2(pct(lat, 0.95)), n };
      log(cfg.device, cfg.variant, 'B=' + B, sizes[B]);
    }
    res.batches = sizes;

    if (cfg.stream) {
      // Simulated chat: every 16 ms a frame's worth of messages arrives (as a content
      // script would send), dynamic batching with the production wait.
      c.post({ type: 'init', opts: { ...opts, tuning: { maxWaitMs: cfg.stream.maxWaitMs, idleDisposeMs: 0, maxBatch: 64 } } });
      await c.waitReady();
      const lat: number[] = [];
      const pending: Promise<void>[] = [];
      const t = performance.now();
      let carry = 0;
      let sent = 0;
      while (performance.now() - t < cfg.stream.seconds * 1000) {
        carry += (cfg.stream.rate * 16) / 1000;
        const n = Math.floor(carry);
        carry -= n;
        if (n > 0) {
          const t1 = performance.now();
          sent += n;
          pending.push(c.classify(next(n, 's')).then(() => void lat.push(performance.now() - t1)));
        }
        await new Promise((r) => setTimeout(r, 16));
      }
      await Promise.all(pending);
      const total = performance.now() - t;
      const st2 = await c.stats();
      res.stream = {
        rate: cfg.stream.rate,
        achievedMsgsPerSec: Math.round((sent * 1000) / total),
        p50ms: r2(pct(lat, 0.5)),
        p95ms: r2(pct(lat, 0.95)),
        avgBatch: st2.avgBatch,
        padRatio: st2.padRatio,
        forwardP50ms: st2.forwardP50ms,
        forwardP95ms: st2.forwardP95ms,
      };
      log(cfg.device, cfg.variant, 'stream', res.stream);
    }
    res.memory = await memory();
    return res;
  } catch (e) {
    res.error = String((e as Error)?.message ?? e);
    return res;
  } finally {
    c.terminate();
  }
}

/** End-to-end through background + offscreen, like a content script. */
async function pipeline(cfg: { texts: string[]; batches: number; batchSize: number; timeoutMs?: number }) {
  const port = chrome.runtime.connect({ name: PORT_CLASSIFY });
  const statuses: ModelStatus[] = [];
  const waiters = new Map<number, (m: PortResponse) => void>();
  let ready: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  port.onMessage.addListener((m: PortResponse) => {
    if (m.type === 'status') {
      statuses.push(m.status);
      if (m.status.state === 'ready' || m.status.state === 'error') ready();
    } else waiters.get(m.batchId)?.(m);
  });
  const t0 = performance.now();
  await Promise.race([readyP, new Promise((r) => setTimeout(r, cfg.timeoutMs ?? 600_000))]);
  const readyMs = Math.round(performance.now() - t0);
  const last = statuses[statuses.length - 1];
  const lat: number[] = [];
  let k = 0;
  let errors = 0;
  for (let b = 1; b <= cfg.batches; b++) {
    const items = Array.from({ length: cfg.batchSize }, (_, i) => ({
      id: `p:${b}:${i}:${Math.random()}`,
      text: cfg.texts[k++ % cfg.texts.length]!,
    }));
    const t1 = performance.now();
    const m = await new Promise<PortResponse>((r) => {
      waiters.set(b, r);
      port.postMessage({ type: 'classify', batchId: b, items });
    });
    if (m.type !== 'scores') errors++;
    lat.push(performance.now() - t1);
  }
  const status = (await chrome.runtime.sendMessage({ type: 'tiho:getStatus' })) as ModelStatus & { perf?: InferenceStats };
  port.disconnect();
  return {
    readyMs,
    states: [...new Set(statuses.map((s) => s.state))],
    status: last,
    getStatus: status,
    p50ms: r2(pct(lat, 0.5)),
    p95ms: r2(pct(lat, 0.95)),
    errors,
  };
}

async function envInfo() {
  return {
    userAgent: navigator.userAgent,
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
    webgpu: await webgpuInfo(),
  };
}

(window as unknown as { tihoBench: unknown }).tihoBench = { run, pipeline, env: envInfo, memory };
log('ready');
