// Reactive state shared by the content-script runtime (writer) and the
// in-chat UI (reader). Preact signals: UI subscribes, runtime mutates in
// batches (at most once per animation frame) to keep renders cheap.

import { signal, type Signal } from '@preact/signals';
import type { Category, ChatMessage, ModelStatus, PerfStats, Verdict } from './types';
import type { Settings } from './settings';

export interface LogEntry {
  msg: Pick<ChatMessage, 'key' | 'author' | 'text' | 'ts' | 'platform' | 'channel'>;
  verdict: Verdict;
}

export interface WaveInfo {
  id: string;
  /** Representative text, e.g. "KEKW". */
  text: string;
  count: number;
  users: number;
  startedAt: number;
  lastAt: number;
}

export interface Store {
  settings: Signal<Settings>;
  model: Signal<ModelStatus>;
  perf: Signal<PerfStats>;
  /** Messages seen per category since page load. */
  counts: Signal<Record<Category, number>>;
  /** Total messages seen and filtered (hidden/collapsed) since load. */
  totals: Signal<{ seen: number; filtered: number }>;
  /** Messages per second, last 60 s (one bucket per second, oldest first). */
  rate: Signal<number[]>;
  /** Vibe = positive − negative share, last 60 buckets of 5 s, in [-1, 1]. */
  vibe: Signal<number[]>;
  /** Active and recent waves (most recent first, ≤ 10). */
  waves: Signal<WaveInfo[]>;
  /** Recent questions (most recent first, ≤ 100). */
  questions: Signal<LogEntry[]>;
  /** Recently filtered messages (most recent first, ≤ 200). */
  filtered: Signal<LogEntry[]>;
  platform: Signal<string>;
  channel: Signal<string>;
  theme: Signal<'dark' | 'light'>;
}

const zeroCounts = (): Record<Category, number> => ({
  toxic: 0, scam: 0, spam: 0, noise: 0, negative: 0, question: 0, positive: 0, clean: 0,
});

export function createStore(settings: Settings): Store {
  return {
    settings: signal(settings),
    model: signal<ModelStatus>({ state: 'idle', backend: 'none' }),
    perf: signal<PerfStats>({ msgsPerSec: 0, inferPerSec: 0, cacheHitRate: 0, p50ms: 0, p95ms: 0, queue: 0 }),
    counts: signal(zeroCounts()),
    totals: signal({ seen: 0, filtered: 0 }),
    rate: signal(new Array(60).fill(0)),
    vibe: signal(new Array(60).fill(0)),
    waves: signal<WaveInfo[]>([]),
    questions: signal<LogEntry[]>([]),
    filtered: signal<LogEntry[]>([]),
    platform: signal(''),
    channel: signal(''),
    theme: signal<'dark' | 'light'>('dark'),
  };
}
