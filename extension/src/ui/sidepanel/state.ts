// Side panel live state: one connection to the active tab, exposed as signals.

import { computed, signal } from '@preact/signals';
import type { LogEntry } from '../../core/store';
import { connectLive, type ActiveTab, type LiveConnection, type LiveSnapshot } from '../bridge';

export const live = signal<LiveSnapshot | null>(null);
export const activeTab = signal<ActiveTab | null>(null);
export const rate = computed(() => live.value?.rate ?? []);
export const vibe = computed(() => live.value?.vibe ?? []);

/** Questions/filtered entries accumulate across snapshots (snapshots carry only the latest N). */
export const questions = signal<LogEntry[]>([]);
export const filtered = signal<LogEntry[]>([]);
/** Session-local "answered" marks for the questions inbox. */
export const done = signal<Set<string>>(new Set());

let conn: LiveConnection | null = null;

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
