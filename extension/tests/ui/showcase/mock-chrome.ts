// Minimal in-page `chrome.*` mock so the real popup / side panel / onboarding
// components run unmodified in the showcase.

import type { Store } from '../../../src/core/store';
import { snapshotFromStore } from '../../../src/ui/bridge';
import type { ModelStatus } from '../../../src/core/types';

type Listener = (...args: any[]) => any;

function evt() {
  const ls = new Set<Listener>();
  return {
    addListener: (f: Listener) => ls.add(f),
    removeListener: (f: Listener) => ls.delete(f),
    hasListener: (f: Listener) => ls.has(f),
    emit: (...a: any[]) => ls.forEach((f) => f(...a)),
  };
}

export interface MockOptions {
  store: Store | null;
  url?: string;
  model?: ModelStatus;
  engine?: boolean;
  /** Animate model download progress (onboarding). */
  downloading?: boolean;
}

export function installChrome(opts: MockOptions): { setModel(m: ModelStatus): void } {
  const data = new Map<string, unknown>();
  const onChanged = evt();
  const onMessage = evt();
  let model: ModelStatus = opts.model ?? { state: 'ready', backend: 'webgpu', modelId: 'hush-lite/q8', version: 'v2-6L' };

  const storageLocal = {
    async get(keys?: string | string[] | null) {
      const out: Record<string, unknown> = {};
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      for (const k of ks) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data.get(k), newValue: structuredClone(v) };
        data.set(k, structuredClone(v));
      }
      setTimeout(() => onChanged.emit(changes, 'local'), 0);
    },
    async remove(k: string) {
      data.delete(k);
    },
  };

  const port = (name: string) => {
    const onMsg = evt();
    const onDisc = evt();
    let timer: ReturnType<typeof setInterval> | 0 = 0;
    const p = {
      name,
      onMessage: onMsg,
      onDisconnect: onDisc,
      postMessage(m: any) {
        console.log('[mock port] ←', m);
      },
      disconnect() {
        if (timer) clearInterval(timer);
      },
    };
    if (opts.store) {
      const push = () => onMsg.emit({ type: 'snapshot', snapshot: snapshotFromStore(opts.store!) });
      setTimeout(push, 30);
      timer = setInterval(push, 1000);
    }
    return p;
  };

  const tab = { id: 1, url: opts.url ?? 'https://www.twitch.tv/xqc', active: true };

  (globalThis as any).chrome = {
    storage: { local: storageLocal, onChanged },
    runtime: {
      id: 'showcase',
      onMessage,
      onConnect: evt(),
      lastError: undefined,
      getURL: (p: string) => p,
      getManifest: () => ({ version: '0.1.0', name: 'Hush' }),
      async sendMessage(msg: any) {
        if (msg?.type === 'hush:getStatus') return { type: 'hush:status', status: model };
        if (msg?.type === 'hush:getPerf' && opts.store) {
          const s = opts.store;
          return { type: 'hush:perf', stats: { ...s.perf.peek(), platform: s.platform.peek(), channel: s.channel.peek(), counts: s.counts.peek() } };
        }
        return undefined;
      },
      openOptionsPage() {},
    },
    tabs: {
      async query() {
        return [tab];
      },
      async sendMessage(_id: number, msg: any) {
        if (msg?.type === 'hush:getSnapshot') return opts.store ? snapshotFromStore(opts.store) : undefined;
        if (msg?.type === 'hush:command') console.log('[mock] command', msg.cmd);
        return { ok: true };
      },
      connect: (_id: number, info: { name: string }) => port(info.name),
      create() {},
      onActivated: evt(),
      onUpdated: evt(),
    },
    sidePanel: { async open() {} },
    commands: {
      async getAll() {
        return [{ name: 'toggle-hush', description: 'Turn Hush on/off', shortcut: 'Alt+Shift+H' }];
      },
    },
  };

  // Engine health
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    if (u.includes('127.0.0.1:7377') || u.includes('localhost:7377')) {
      await new Promise((r) => setTimeout(r, 120));
      if (!opts.engine) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ model: 'clef-flash-9b-q8_0', device: 'cuda:0 RTX 3090', version: '0.1.0' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  if (opts.downloading) {
    let p = 0.08;
    model = { state: 'downloading', backend: 'none', progress: p, modelId: 'hush-lite/q8' };
    const id = setInterval(() => {
      p = Math.min(1, p + 0.035);
      model = p >= 1 ? { state: 'ready', backend: 'webgpu', modelId: 'hush-lite/q8', version: 'v2-6L' } : { ...model, progress: p };
      onMessage.emit({ type: 'hush:status', status: model }, {}, () => {});
      if (p >= 1) clearInterval(id);
    }, 400);
  }

  return {
    setModel(m) {
      model = m;
      onMessage.emit({ type: 'hush:status', status: m }, {}, () => {});
    },
  };
}
