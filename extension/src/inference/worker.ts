// Module Worker hosting the Hush Lite model (spawned by the offscreen document
// and by the bench page). Messages: see messages.ts.

import { REMOTE_MODEL_PINS } from './config';
import { InferenceEngine } from './engine';
import type { InitOptions, WorkerIn, WorkerOut } from './messages';
import { HushModel } from './model';

const scope = self as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
  location: Location;
  crossOriginIsolated?: boolean;
};

const coi = !!scope.crossOriginIsolated;
const cores = navigator.hardwareConcurrency || 4;

function threadsFor(opts: InitOptions): number {
  if (!coi) return 1; // SharedArrayBuffer unavailable → ORT runs single-threaded
  return Math.max(1, Math.min(opts.threads ?? Math.min(4, Math.floor(cores / 2)), cores));
}

const post = (m: WorkerOut) => scope.postMessage(m);
let threads = 1;

const engine = new InferenceEngine({
  post,
  crossOriginIsolated: coi,
  get threads() {
    return threads;
  },
  load: (opts, hooks) => {
    threads = threadsFor(opts);
    const bases = [opts.localModelBase, opts.remoteModelBase].filter((x): x is string => !!x);
    return HushModel.load({
      bases,
      ortBase: opts.ortBase ?? new URL('/ort/', scope.location.origin).href,
      device: opts.device ?? 'auto',
      variant: opts.variant,
      threads,
      pins: REMOTE_MODEL_PINS,
      onProgress: hooks.onProgress,
      onFallback: hooks.onFallback,
    });
  },
});

let initialized = false;

scope.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  switch (m?.type) {
    case 'init':
      initialized = true;
      engine.init(m.opts);
      break;
    case 'classify':
      if (!initialized) {
        initialized = true;
        engine.init({});
      }
      void engine.classify(m.id, m.items);
      break;
    case 'getStats':
      post({ type: 'stats', reqId: m.reqId, stats: engine.stats() });
      break;
    case 'dispose':
      void engine.unload().then(() => post({ type: 'status', status: { state: 'idle', backend: 'none' } }));
      break;
  }
};

// Periodic: idle model disposal + stats push while active.
setInterval(() => {
  engine.maybeIdleDispose();
  if (engine.activeWithin(2500)) post({ type: 'stats', stats: engine.stats() });
}, 2000);
