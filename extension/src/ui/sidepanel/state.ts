// Side panel live state: one connection to the active tab, exposed as signals.

import { computed, signal } from '@preact/signals';
import type { EngineStatus } from '../../core/protocol';
import type { LogEntry } from '../../core/store';
import type { Category } from '../../core/types';
import { connectLive, getEngineStatus, onEngineStatus, type ActiveTab, type LiveConnection, type LiveSnapshot } from '../bridge';
import { settings } from '../kit/kit';

export const live = signal<LiveSnapshot | null>(null);
export const activeTab = signal<ActiveTab | null>(null);
export const rate = computed(() => live.value?.rate ?? []);
export const vibe = computed(() => live.value?.vibe ?? []);

/** Questions/filtered entries accumulate across snapshots (snapshots carry only the latest N). */
export const questions = signal<LogEntry[]>([]);
export const filtered = signal<LogEntry[]>([]);
/** Session-local "answered" marks for the questions inbox. */
export const done = signal<Set<string>>(new Set());

/** Tiho Engine connection (pushed by the background on change, polled for counters). */
export const engineStatus = signal<EngineStatus | null>(null);

/**
 * What this panel asked the tab for (Show hidden, Solo) and when: shown at
 * once, and kept until a snapshot made after the request answers with the
 * tab's own state (which may differ: Solo needs Advanced and Tiho on).
 */
const asked = signal<{ peek: boolean; solo: Category | null; at: number } | null>(null);

/** The tab's views: what its last snapshot says, or what this panel just asked for. */
export const views = computed(() => {
  const a = asked.value;
  const s = live.value;
  return a ? { peek: a.peek, solo: a.solo } : { peek: s?.peek ?? false, solo: s?.solo ?? null };
});

/** A view can be asked for while a chat answers and Tiho is on. */
export const canView = computed(() => !!live.value?.enabled);

/** Show hidden in the tab, or hide again. */
export function setPeek(on: boolean): void {
  asked.value = { peek: on, solo: views.value.solo, at: Date.now() };
  conn?.send({ type: 'peek', on });
}

/** Show only this category in the tab; null, or the soloed one again, shows everything. Entering Solo ends Show hidden. */
export function setSolo(cat: Category | null): void {
  const next = cat === views.value.solo ? null : cat;
  asked.value = { peek: next ? false : views.value.peek, solo: next, at: Date.now() };
  conn?.send({ type: 'solo', cat: next });
}

let conn: LiveConnection | null = null;
let engineWatch = false;

function mergeLog(prev: LogEntry[], next: LogEntry[], cap: number): LogEntry[] {
  if (!next.length) return prev;
  const seen = new Set(prev.map((e) => e.msg.key));
  const fresh = next.filter((e) => !seen.has(e.msg.key));
  if (!fresh.length) return prev;
  return [...fresh, ...prev].slice(0, cap);
}

export function startLive(): LiveConnection {
  if (conn) return conn;
  let channel = '';
  conn = connectLive((s, tab) => {
    activeTab.value = tab;
    if (s && s.channel !== channel) {
      channel = s.channel;
      questions.value = [];
      filtered.value = [];
    }
    // One machine, one clock: a snapshot made after the request carries the tab's answer.
    if (!s || (asked.value && s.ts >= asked.value.at)) asked.value = null;
    live.value = s;
    if (s) {
      questions.value = mergeLog(questions.value, s.questions, 300);
      filtered.value = mergeLog(filtered.value, s.filtered, 500);
    }
  });
  return conn;
}

export function connection(): LiveConnection | null {
  return conn;
}

/** Re-read the engine status; `fresh` makes the background check the engine now. */
export async function refreshEngine(fresh = false): Promise<void> {
  engineStatus.value = await getEngineStatus(settings.value.engine.url, fresh);
}

export function startEngineStatus(pollMs = 5000): void {
  if (engineWatch) return;
  engineWatch = true;
  void refreshEngine();
  onEngineStatus((s) => (engineStatus.value = s));
  setInterval(() => {
    if (settings.value.engine.enabled) void refreshEngine();
  }, pollMs);
}
