// Internal messages of the inference subsystem.
//
//   background ──Port "tiho:offscreen"──▶ offscreen document ──postMessage──▶ worker
//
// The offscreen document is a dumb relay: it adds extension URLs to `init`
// and forwards everything else verbatim in both directions. The bench page
// talks to the same worker with the same messages.

import type { ClassifyItem } from '../core/protocol';
import type { ModelStatus } from '../core/types';
import type { Device, InferenceTuning } from './config';

export const PORT_OFFSCREEN = 'tiho:offscreen';
/** runtime message background → offscreen: (re)connect your port. */
export const MSG_OFFSCREEN_HELLO = 'tiho:offscreen:hello';

export interface InitOptions {
  /** Absolute base URLs (trailing slash). Filled in by the offscreen document. */
  localModelBase?: string;
  remoteModelBase?: string;
  ortBase?: string;
  /** Force a backend; default: WebGPU when available, else WASM. */
  device?: Device | 'auto';
  /** Force a model file (key of config.tiho.files), e.g. 'q8f16'. */
  variant?: string;
  /** WASM threads (needs crossOriginIsolated); default min(4, cores/2). */
  threads?: number;
  /** Use the worker score cache (bench turns it off). */
  cache?: boolean;
  tuning?: Partial<InferenceTuning>;
}

export interface InferenceStats {
  backend: string;
  variant: string;
  /** Request latency inside the worker (receive → scores), ms. */
  p50ms: number;
  p95ms: number;
  /** Forward pass time per flush, ms. */
  forwardP50ms: number;
  forwardP95ms: number;
  /** Texts through the model per second (5 s window). */
  inferPerSec: number;
  /** Texts requested per second (5 s window, includes cache hits). */
  requestsPerSec: number;
  cacheHitRate: number;
  cacheSize: number;
  /** Unique texts waiting for a forward pass. */
  queue: number;
  avgBatch: number;
  /** padded tokens / real tokens over recent flushes (1 = no padding waste). */
  padRatio: number;
  loadMs: number;
  totalInferred: number;
  crossOriginIsolated: boolean;
  threads: number;
}

/** to worker */
export type WorkerIn =
  | { type: 'init'; opts: InitOptions }
  | { type: 'classify'; id: number; items: ClassifyItem[] }
  | { type: 'getStats'; reqId?: number }
  | { type: 'dispose' };

/** from worker */
export type WorkerOut =
  | { type: 'status'; status: ModelStatus; stats?: InferenceStats }
  | { type: 'scores'; id: number; ids: string[]; scores: number[][]; ms: number; backend: string }
  | { type: 'error'; id: number; error: string }
  | { type: 'stats'; reqId?: number; stats: InferenceStats };

/** background → offscreen (over the port): same as WorkerIn. */
export type ToOffscreen = WorkerIn;
/** offscreen → background: worker output + relay-level errors. */
export type FromOffscreen = WorkerOut | { type: 'crashed'; error: string };
