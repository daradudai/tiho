// Messaging protocol.
//
//  content script ──Port "tiho:classify"──▶ background ──▶ offscreen (inference worker)
//                                                     └──▶ Tiho Engine (optional, localhost)
//
// Content scripts open one long-lived Port per frame and stream batches of
// texts; the background relays to the offscreen document, which owns the one
// model instance shared by every tab. Texts are deduplicated and cached
// upstream, so only unseen normalized texts travel. When the Tiho Engine is
// on, the background also forwards the scored texts to it and sends its
// answers later as an `engine` follow-up for the same ids.

import type { ModelStatus, PerfStats } from './types';

export const PORT_CLASSIFY = 'tiho:classify';

export interface ClassifyItem {
  /** Cache key (normalized text). */
  id: string;
  text: string;
}

/** content → background (over Port). `hidden`: sent from a background tab (the Tiho Engine skips it). */
export type PortRequest = { type: 'classify'; batchId: number; items: ClassifyItem[]; hidden?: boolean };

/** background → content (over Port) */
export type PortResponse =
  | { type: 'scores'; batchId: number; ids: string[]; scores: number[][]; ms: number; backend: string }
  | { type: 'error'; batchId: number; error: string }
  | { type: 'status'; status: ModelStatus }
  | EngineFollowUp;

/**
 * Tiho Engine answers for ids that already got local scores. Arrays are
 * aligned with `ids`; ids the engine could not answer in time are left out.
 */
export interface EngineFollowUp {
  type: 'engine';
  /** The batch whose local scores this refines. */
  batchId: number;
  ids: string[];
  /** Custom-filter probability per filter key (settings `filterKey`). */
  filters: Record<string, number[]>;
  /** Engine scores aligned with LABELS where a second opinion was asked, else null. */
  base?: (number[] | null)[];
}

/** Tiho Engine connection, as the background sees it. */
export interface EngineStatus {
  /**
   * off: disabled in settings · connecting: first check pending · ready ·
   * loading: the engine runs but its model is not ready yet · unreachable:
   * nothing answers at `url` · error: the engine (or whatever answers) reports a problem.
   */
  state: 'off' | 'connecting' | 'ready' | 'loading' | 'unreachable' | 'error';
  url: string;
  detail?: string;
  /** Decision model, e.g. "Clef-Flash-Q8_0". */
  model?: string;
  device?: string;
  version?: string;
  /** Round trip of the last health check, ms. */
  pingMs?: number;
  /** Answers received / texts that got no answer in time, since the background started. */
  answered: number;
  expired: number;
  /** Typical classify round trip, ms (0 until the first answer). */
  latencyMs: number;
  checkedAt?: number;
}

export interface EngineTestRequest {
  text: string;
  filters: { id: string; question: string }[];
  context?: string;
  platform?: string;
}

export type EngineTestResult = { ok: true; filters: Record<string, number>; ms: number } | { ok: false; error: string };

/** One-shot runtime messages (chrome.runtime.sendMessage). */
export type RuntimeMessage =
  | { type: 'tiho:getStatus' }
  | { type: 'tiho:status'; status: ModelStatus }
  // Retry in the popup / side panel: load a model that failed to load again now
  | { type: 'tiho:reloadModel' }
  | { type: 'tiho:perf'; tabId?: number; stats: PerfStats & { platform: string; channel: string } }
  | { type: 'tiho:getPerf' }
  | { type: 'tiho:openSidePanel' }
  // Tiho Engine (extension pages ↔ background)
  | { type: 'tiho:engine:getStatus'; fresh?: boolean }
  | { type: 'tiho:engine:status'; status: EngineStatus }
  | ({ type: 'tiho:engine:test' } & EngineTestRequest)
  // background → offscreen
  | { type: 'tiho:offscreen:init'; preferGpu: boolean }
  | { type: 'tiho:offscreen:classify'; batchId: number; items: ClassifyItem[] };
