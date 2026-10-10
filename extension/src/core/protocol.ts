// Messaging protocol.
//
//  content script ──Port "hush:classify"──▶ background ──▶ offscreen (inference worker)
//
// Content scripts open one long-lived Port per frame and stream batches of
// texts; the background relays to the offscreen document, which owns the one
// model instance shared by every tab. Texts are deduplicated and cached
// upstream, so only unseen normalized texts travel.

import type { ModelStatus, PerfStats } from './types';

export const PORT_CLASSIFY = 'hush:classify';

export interface ClassifyItem {
  /** Cache key (normalized text). */
  id: string;
  text: string;
}

/** content → background (over Port) */
export type PortRequest = { type: 'classify'; batchId: number; items: ClassifyItem[] };

/** background → content (over Port) */
export type PortResponse =
  | { type: 'scores'; batchId: number; ids: string[]; scores: number[][]; ms: number; backend: string }
  | { type: 'error'; batchId: number; error: string }
  | { type: 'status'; status: ModelStatus };

/** One-shot runtime messages (chrome.runtime.sendMessage). */
export type RuntimeMessage =
  | { type: 'hush:getStatus' }
  | { type: 'hush:status'; status: ModelStatus }
  | { type: 'hush:perf'; tabId?: number; stats: PerfStats & { platform: string; channel: string; counts: Record<string, number> } }
  | { type: 'hush:getPerf' }
  | { type: 'hush:openSidePanel' }
  // background → offscreen
  | { type: 'hush:offscreen:init'; preferGpu: boolean }
  | { type: 'hush:offscreen:classify'; batchId: number; items: ClassifyItem[] };
