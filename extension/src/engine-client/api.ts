// Tiho Engine HTTP API (engine/README.md) and its mapping to extension types.
//
//   GET  /health        → Health
//   POST /v1/classify   ClassifyRequest → ClassifyResponse, or with `stream`
//                       one ClassifyLine per text as it is answered (NDJSON)
//
// The engine accepts only extension / localhost origins, so it is called from
// the background service worker (and extension pages), never from a content
// script.

import type { EngineStatus } from '../core/protocol';
import { DEFAULT_SETTINGS } from '../core/settings';
import { LABELS } from '../core/types';

/** Engine-side limit on filters per request (`/health` → limits). */
export const MAX_FILTERS = 32;

export interface Health {
  ok: boolean;
  /** starting | loading | waiting_backend | backend_down | ready | error */
  status: string;
  detail?: string;
  version?: string;
  decision_model?: string;
  device?: string;
}

export interface ClassifyRequest {
  messages: { id: string; text: string; platform?: string }[];
  filters: { id: string; question: string }[];
  base?: boolean;
  deadline_ms?: number;
  context?: string;
  /** Answer as NDJSON, one line per text as soon as it is ready (engines without it send JSON). */
  stream?: boolean;
}

export type BaseScores = Record<'toxic' | 'spam' | 'scam' | 'noise' | 'question' | 'clean' | 'positive' | 'negative', number>;

export type ClassifyResult =
  | { id: string | number; filters: Record<string, number>; base?: BaseScores; cached?: boolean }
  | { id: string | number; error: string };

export interface ClassifyResponse {
  results: ClassifyResult[];
  ms: number;
  expired?: number;
}

/** A line of a streamed classify answer: a result per text in the order they finish, then a summary. */
export type ClassifyLine = ClassifyResult | { done: true; ms: number; expired?: number };

/** The JSON object per line of a response body, as the lines arrive (anything else is skipped). */
export async function* ndjson<T extends object>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += dec.decode(value, { stream: !done });
      const lines = buf.split('\n');
      buf = done ? '' : lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        let v: unknown;
        try {
          v = JSON.parse(line);
        } catch {
          continue;
        }
        if (v && typeof v === 'object') yield v as T;
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => {}); // the reader stopped early: close the connection
  }
}

/** Engine base scores → a vector aligned with LABELS (the engine's extra `clean` is implied). */
export function baseToScores(b: BaseScores | undefined): number[] | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const out = LABELS.map((l) => b[l]);
  return out.every((p) => typeof p === 'number' && Number.isFinite(p)) ? out : undefined;
}

/** "http://127.0.0.1:7377/" → "http://127.0.0.1:7377" */
export function normalizeUrl(url: string | undefined): string {
  const u = (url ?? '').trim().replace(/\/+$/, '');
  return u || DEFAULT_SETTINGS.engine.url;
}

/** Turn a /health answer into the UI status (counters are filled in by the client). */
export function statusFromHealth(url: string, httpStatus: number, h: Partial<Health> | null, pingMs: number): Omit<EngineStatus, 'answered' | 'expired' | 'latencyMs'> {
  const base = { url, pingMs, checkedAt: Date.now() };
  if (!h || typeof h !== 'object' || (typeof h.ok !== 'boolean' && typeof h.status !== 'string')) {
    return { ...base, state: 'error', detail: httpStatus >= 400 ? `HTTP ${httpStatus}` : 'Something else answers at this address' };
  }
  const info = { model: h.decision_model || undefined, device: h.device || undefined, version: h.version || undefined };
  if (h.ok) return { ...base, ...info, state: 'ready' };
  switch (h.status) {
    case 'starting':
    case 'loading':
    case 'waiting_backend':
      return { ...base, ...info, state: 'loading', detail: h.detail || 'Loading the model' };
    default:
      return { ...base, ...info, state: 'error', detail: h.detail || h.status || 'Engine not ready' };
  }
}
