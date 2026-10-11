// Offscreen document (reason WORKERS): owns the one inference Worker shared by
// every tab and relays messages between it and the background SW over a Port.
// Offscreen documents only get chrome.runtime, which is all we need.

import { LOCAL_MODEL_DIR, ORT_DIR, REMOTE_MODEL_URL } from '../../inference/config';
import {
  MSG_OFFSCREEN_HELLO,
  PORT_OFFSCREEN,
  type FromOffscreen,
  type InitOptions,
  type ToOffscreen,
  type WorkerOut,
} from '../../inference/messages';

const urls = (): InitOptions => ({
  localModelBase: chrome.runtime.getURL(LOCAL_MODEL_DIR),
  remoteModelBase: REMOTE_MODEL_URL,
  ortBase: chrome.runtime.getURL(ORT_DIR),
});

let port: chrome.runtime.Port | null = null;
let lastInit: InitOptions = urls();
let lastStatus: WorkerOut | null = null;
let worker: Worker | null = null;
let crashes = 0;
let wasReady = false;

function spawn(): Worker {
  const w = new Worker(new URL('../../inference/worker.ts', import.meta.url), { type: 'module', name: 'tiho-inference' });
  w.onmessage = (e: MessageEvent<WorkerOut>) => {
    const m = e.data;
    if (m?.type === 'status') {
      lastStatus = m;
      if (m.status.state === 'ready') wasReady = true;
      else if (m.status.state === 'idle' && wasReady && worker === w) {
        // The engine released the model after idling. WASM memory never shrinks, so drop
        // the whole worker to give the ~0.5–1.5 GB back; it is respawned on the next request.
        wasReady = false;
        worker = null;
        w.terminate();
      }
    }
    send(m);
  };
  w.onerror = (e) => {
    e.preventDefault?.();
    send({ type: 'crashed', error: e.message || 'worker error' });
    w.terminate();
    if (worker === w) worker = null;
    if (++crashes > 3) {
      send({ type: 'status', status: { state: 'error', backend: 'none', error: `inference worker crashed: ${e.message}` } });
      return;
    }
    ensureWorker();
  };
  return w;
}

/** The worker, (re)spawned and initialised on demand. */
function ensureWorker(): Worker {
  if (!worker) {
    worker = spawn();
    worker.postMessage({ type: 'init', opts: lastInit } satisfies ToOffscreen);
  }
  return worker;
}

function send(m: FromOffscreen): void {
  if (!port) return;
  try {
    port.postMessage(m);
  } catch {
    port = null;
  }
}

function connect(): void {
  if (port) return;
  const p = chrome.runtime.connect({ name: PORT_OFFSCREEN });
  port = p;
  p.onMessage.addListener((m: ToOffscreen) => {
    if (m?.type === 'init') {
      lastInit = { ...lastInit, ...m.opts, ...urls() };
      if (worker) worker.postMessage({ type: 'init', opts: lastInit } satisfies ToOffscreen);
      else ensureWorker();
      return;
    }
    if (m?.type === 'getStats' && !worker) return; // nothing loaded, nothing to report
    ensureWorker().postMessage(m);
  });
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
    // Don't reconnect on our own: that would keep waking a SW that wants to sleep.
    // The background sends MSG_OFFSCREEN_HELLO when it needs us again.
  });
  if (lastStatus) send(lastStatus);
}

chrome.runtime.onMessage.addListener((m: { type?: string }) => {
  if (m?.type === MSG_OFFSCREEN_HELLO) connect();
  return false;
});

connect();
