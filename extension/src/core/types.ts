// Shared types. This file is the contract between content scripts, the
// background service worker, the offscreen inference host and the UI.

export type Platform = 'youtube' | 'twitch' | 'kick';

/** Author role bitmask. */
export const Role = {
  BROADCASTER: 1,
  MOD: 2,
  VIP: 4,
  SUB: 8,
  MEMBER: 16,
  VERIFIED: 32,
} as const;

export interface ChatMessage {
  /** Stable per message (platform id when available, else derived). */
  key: string;
  platform: Platform;
  channel: string;
  author: string;
  authorId?: string;
  /** Bitmask of Role.* */
  roles: number;
  /** Plain text; emote images replaced by their code (e.g. "KEKW"). */
  text: string;
  /** Number of emote images in the message. */
  emotes: number;
  mentions: string[];
  isReply: boolean;
  isFirstMessage: boolean;
  /** Superchat / bits / kicks / sticker — never hidden by default. */
  paid: boolean;
  ts: number;
}

/** Model heads, in output order. Keep in sync with ml/ and model config. */
export const LABELS = ['toxic', 'spam', 'scam', 'noise', 'question', 'positive', 'negative'] as const;
export type Label = (typeof LABELS)[number];

/** Filterable categories shown in the UI (labels + rule-only ones). */
export const CATEGORIES = ['toxic', 'scam', 'spam', 'noise', 'negative', 'question', 'positive', 'clean'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Probabilities per label, aligned with LABELS. */
export type Scores = Float32Array | number[];

export type Action = 'show' | 'highlight' | 'dim' | 'collapse' | 'hide';

export interface Verdict {
  /** Primary category used for styling and counters. */
  category: Category;
  action: Action;
  /** Short human readable reason, e.g. "toxic 0.94", "wave ×37", "link". */
  reason: string;
  /** Where the decision came from. */
  source: 'rule' | 'model' | 'engine' | 'cache' | 'user';
  scores?: number[];
  /** Wave id when this message belongs to a detected wave. */
  wave?: string;
}

export type ModelBackend = 'webgpu' | 'wasm' | 'engine' | 'none';

export interface ModelStatus {
  state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  backend: ModelBackend;
  progress?: number; // 0..1 during download
  error?: string;
  modelId?: string;
  version?: string;
  /** Calibrated per-label thresholds aligned with LABELS (model config `hush.thresholds`). Default 0.5. */
  thresholds?: number[];
}

export interface PerfStats {
  msgsPerSec: number;
  inferPerSec: number;
  cacheHitRate: number;
  p50ms: number;
  p95ms: number;
  queue: number;
  /** Content-script main-thread time per message, ms (avg over the last few seconds). */
  mainMs?: number;
}
