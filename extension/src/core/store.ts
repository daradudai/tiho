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
  /** Epoch ms (Date.now()), like ChatMessage.ts: extension pages compare them with their own clock. */
  startedAt: number;
  lastAt: number;
}

/**
 * The message rows the chat list holds right now: on Twitch the ~150 messages
 * it keeps, on Kick the ~30 mounted rows (rows in the list, not in the
 * viewport). Rows waiting for a verdict count as nothing, rows the viewer
 * opened as shown. Recounted as verdicts change, so a settings change shows up
 * in the next store flush.
 */
export interface InChat {
  /** Message rows the chat list holds now that have a verdict. */
  rows: number;
  /** ...whose action is hide (and the viewer has not opened them). */
  hidden: number;
  /** ...folded into "N hidden · show" pills (wave members not included). */
  folded: number;
  /** ...folded into a wave head's ×N. */
  inWaves: number;
  /** Per verdict category, wave members not included. Σ byCat + inWaves === rows. */
  byCat: Record<Category, number>;
}

export interface Store {
  settings: Signal<Settings>;
  model: Signal<ModelStatus>;
  perf: Signal<PerfStats>;
  /** What the chat list holds right now (see InChat). Flushed with the ≤ 4×/s store batch. */
  inChat: Signal<InChat>;
  /** New messages seen so far (a message re-mounted in a new node is not new). Drives the mark's activity pulse only; never shown. */
  seen: Signal<number>;
  /** Show hidden is on in this tab (a view: never saved). */
  peek: Signal<boolean>;
  /** Category shown alone in this tab (Advanced only, never saved), or null. */
  solo: Signal<Category | null>;
  /** Messages per second, last 60 s (one bucket per second, oldest first). */
  rate: Signal<number[]>;
  /** Mood = positive − negative share, last 60 buckets of 5 s (5 min), in [-1, 1]. */
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

export const zeroInChat = (): InChat => ({
  rows: 0,
  hidden: 0,
  folded: 0,
  inWaves: 0,
  byCat: { toxic: 0, scam: 0, spam: 0, noise: 0, negative: 0, question: 0, positive: 0, clean: 0 },
});

export function createStore(settings: Settings): Store {
  return {
    settings: signal(settings),
    model: signal<ModelStatus>({ state: 'idle', backend: 'none' }),
    perf: signal<PerfStats>({ msgsPerSec: 0, inferPerSec: 0, cacheHitRate: 0, p50ms: 0, p95ms: 0, queue: 0 }),
    inChat: signal(zeroInChat()),
    seen: signal(0),
    peek: signal(false),
    solo: signal<Category | null>(null),
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
