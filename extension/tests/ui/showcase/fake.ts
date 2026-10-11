// Fake live data for the UI showcase: a Store fed like the runtime would.

import { batch } from '@preact/signals';
import { createStore, zeroInChat, type InChat, type LogEntry, type Store, type WaveInfo } from '../../../src/core/store';
import { DEFAULT_SETTINGS, PRESETS, levelPatch, type PresetId, type Settings } from '../../../src/core/settings';
import type { BarActions } from '../../../src/core/bar-actions';
import { CATEGORIES, type Action, type Category, type Platform } from '../../../src/core/types';

let seed = 7;
export function rnd(): number {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

export interface FakeMsg {
  author: string;
  color: string;
  text: string;
  c: Category;
  a?: Action;
  r?: string;
  w?: number;
  badges?: string[];
}

/** Hand-written, realistic chat (deterministic order for screenshots). */
export const CHAT: FakeMsg[] = [
  { author: 'nightowl_88', color: '#ff7f50', text: 'that clutch was actually insane', c: 'positive', r: 'positive · certain' },
  { author: 'Pixelmancer', color: '#1e90ff', text: 'KEKW', c: 'noise', r: 'wave ×37', w: 37 },
  { author: 'free_skins_bot', color: '#9acd32', text: 'FREE SKINS at csgo-drop .win/xqc claim now', c: 'scam', r: 'scam · certain' },
  { author: 'mira_lux', color: '#da70d6', text: 'what settings are you using for the sensitivity?', c: 'question', r: 'question · certain' },
  { author: 'tilted_tom', color: '#ff4500', text: 'you are so trash uninstall', c: 'toxic', r: 'toxic · certain' },
  { author: 'tilted_tom', color: '#ff4500', text: 'literally the worst player i have ever seen', c: 'toxic', r: 'toxic · likely' },
  { author: 'quietfox', color: '#2e8b57', text: 'chat is so calm today, love it', c: 'positive', r: 'positive · very likely' },
  { author: 'Sven_DE', color: '#b22222', text: 'warum spielt er nicht ranked heute?', c: 'question', r: 'question · certain' },
  { author: 'lowkey_lena', color: '#8a2be2', text: 'audio is a bit quiet compared to the game', c: 'negative', r: 'negative · likely' },
  { author: 'copypasta_king', color: '#daa520', text: 'POGGERS POGGERS POGGERS POGGERS POGGERS POGGERS', c: 'spam', r: 'spam · certain' },
  { author: 'ana_rs', color: '#00bfff', text: 'jajaja el último round fue increíble', c: 'positive', r: 'positive · very likely' },
  { author: 'mod_rex', color: '#00ad03', text: 'Reminder: be nice in chat, no spoilers please', c: 'clean', badges: ['mod'] },
  { author: 'mod_rex', color: '#00ad03', text: 'NO SPOILERS NO SPOILERS NO SPOILERS', c: 'spam', a: 'show', r: 'spam · very likely · always shown', badges: ['mod'] },
  { author: 'hypetrain', color: '#ff69b4', text: 'W', c: 'noise', r: 'noise · certain' },
  { author: 'devonk', color: '#5f9ea0', text: 'is the tournament on saturday or sunday?', c: 'question', r: 'question · certain' },
  { author: 'grr_gamer', color: '#cd5c5c', text: 'ok this patch honestly ruined the game', c: 'negative', r: 'negative · very likely' },
  { author: 'lucky_luna', color: '#ffa07a', text: 'GG that was clean', c: 'positive', r: 'positive · certain' },
  { author: 'clip_chimp', color: '#e67e22', text: 'NO WAY he hit that from across the map, somebody clip it', c: 'positive', r: 'positive · certain', w: 14 },
  { author: 'bigbrain', color: '#1e90ff', text: 'does anyone know which map pool they use for the finals?', c: 'question', r: 'question · very likely' },
];

const AUTHORS = ['zoe_plays', 'kaito', 'marek_pl', 'Juli', 'bigbrain', 'ostrich', 'leo_br', 'nadia', 'yuki', 'rook'];
const QUESTIONS = [
  'what mouse do you use?',
  'is this the new season already?',
  'how long have you been streaming today?',
  'qual é o nome dessa música?',
  'can you show the crosshair code?',
  'when is the next giveaway?',
  'você vai jogar ranked depois?',
  'wie heißt der song?',
];
const FILTERED: [string, Category, string][] = [
  ['you are so trash uninstall', 'toxic', 'toxic · certain'],
  ['FREE SKINS at csgo-drop .win claim now', 'scam', 'scam · certain'],
  ['follow4follow check my channel!!', 'scam', 'scam · very likely'],
  ['POGGERS POGGERS POGGERS POGGERS POGGERS', 'spam', 'spam · certain'],
  ['ez clap noob team diff', 'toxic', 'toxic · likely'],
  ['💰 crypto signals in bio 💰', 'scam', 'scam · certain'],
  ['aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'spam', 'char flood'],
  ['ты просто ужасно играешь, удали игру', 'toxic', 'toxic · very likely'],
  ['!drop', 'noise', '!command'],
  ['L', 'noise', 'noise · certain'],
];

function entry(key: string, author: string, text: string, category: Category, action: Action, reason: string, ageS: number): LogEntry {
  return {
    msg: { key, author, text, ts: Date.now() - ageS * 1000, platform: 'twitch', channel: 'xqc' },
    verdict: { category, action, reason, source: 'model' },
  };
}

/**
 * What the runtime's "in chat now" counters would say about these rows
 * (each row's category and the action written on it; opened rows count as
 * shown). Nothing is counted while Hush is off on the site.
 */
export function inChatOf(rows: { c: Category; a: Action; wm?: boolean }[], on = true): InChat {
  const n = zeroInChat();
  if (!on) return n;
  for (const r of rows) {
    n.rows++;
    if (r.wm) {
      n.inWaves++;
      continue;
    }
    n.byCat[r.c]++;
    if (r.a === 'hide') n.hidden++;
    else if (r.a === 'collapse') n.folded++;
  }
  return n;
}

/** Twitch keeps about 150 messages in its chat list: this mix of them (6 more are folded into waves). */
const LIST_MIX: Record<Category, number> = { toxic: 2, scam: 1, spam: 6, noise: 41, negative: 9, question: 7, positive: 22, clean: 58 };
const IN_WAVES = 6;

function listRows(s: Settings): { c: Category; a: Action; wm?: boolean }[] {
  const rows: { c: Category; a: Action; wm?: boolean }[] = CATEGORIES.flatMap((c) => Array.from({ length: LIST_MIX[c] }, () => ({ c, a: s.actions[c] })));
  for (let i = 0; i < IN_WAVES; i++) rows.push({ c: 'noise', a: 'show', wm: true });
  return rows;
}

/** Hush runs on this site (the runtime lets the list go otherwise). */
export const hushOn = (s: Settings, platform: string) => s.enabled && s.sites[platform as Platform] !== false;

export function makeStore(platform = 'twitch', theme: 'dark' | 'light' = 'dark', preset: PresetId = 'chill'): Store {
  const s = createStore({ ...DEFAULT_SETTINGS, preset, actions: preset === 'custom' ? DEFAULT_SETTINGS.actions : { ...PRESETS[preset] } });
  seed = 7;
  batch(() => {
    s.platform.value = platform;
    s.channel.value = platform === 'youtube' ? 'Lofi Girl' : platform === 'kick' ? 'trainwreckstv' : 'xqc';
    s.theme.value = theme;
    s.model.value = { state: 'ready', backend: 'webgpu', modelId: 'hush-lite/q8', version: 'v2-6L' };
    s.perf.value = { msgsPerSec: 86, inferPerSec: 41, cacheHitRate: 0.52, p50ms: 6, p95ms: 14, queue: 0 };
    s.inChat.value = inChatOf(listRows(s.settings.peek()), hushOn(s.settings.peek(), platform));
    s.seen.value = 9700;
    s.rate.value = Array.from({ length: 60 }, (_, i) => Math.max(8, 72 + 26 * Math.sin(i / 6) + 18 * Math.sin(i / 2.3) + rnd() * 22 + (i > 44 ? 30 : 0)));
    s.vibe.value = Array.from({ length: 60 }, (_, i) => Math.max(-1, Math.min(1, 0.25 * Math.sin(i / 7) + 0.2 + (i > 30 && i < 38 ? -0.55 : 0) + (rnd() - 0.5) * 0.18)));
    const now = Date.now();
    const waves: WaveInfo[] = [
      { id: 'w1', text: 'KEKW', count: 37, users: 34, startedAt: now - 9000, lastAt: now - 1200 },
      { id: 'w2', text: 'W', count: 21, users: 21, startedAt: now - 30000, lastAt: now - 4000 },
      { id: 'w3', text: 'LETSGO', count: 12, users: 11, startedAt: now - 70000, lastAt: now - 50000 },
      { id: 'w4', text: 'o7', count: 9, users: 9, startedAt: now - 120000, lastAt: now - 100000 },
    ];
    s.waves.value = waves;
    s.questions.value = QUESTIONS.map((q, i) => entry(`q${i}`, AUTHORS[i % AUTHORS.length], q, 'question', 'highlight', `question · ${i % 3 === 2 ? 'very likely' : 'certain'}`, 12 + i * 47));
    s.filtered.value = Array.from({ length: 40 }, (_, i) => {
      const [t, c, r] = FILTERED[i % FILTERED.length];
      return entry(`f${i}`, AUTHORS[(i * 3) % AUTHORS.length] + (i > 9 ? i : ''), t, c, c === 'spam' ? 'collapse' : 'hide', r, 4 + i * 23);
    });
  });
  return s;
}

/**
 * Simulate a busy chat: ~`mps` messages/s, store written once per frame. The
 * chat list keeps the last 150 messages, and the in-chat-now counters follow it.
 */
export function runLive(s: Store, mps = 90): () => void {
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let secAcc = 0;
  let secCount = 0;
  const cats: Category[] = ['clean', 'clean', 'clean', 'noise', 'noise', 'positive', 'positive', 'spam', 'negative', 'question', 'toxic', 'scam'];
  const list: Category[] = CATEGORIES.flatMap((c) => Array.from({ length: LIST_MIX[c] }, () => c));
  const tick = (t: number) => {
    const dt = (t - last) / 1000;
    last = t;
    acc += dt * mps * (0.7 + rnd() * 0.6);
    const n = Math.floor(acc);
    acc -= n;
    if (n > 0) {
      for (let i = 0; i < n; i++) list.push(cats[Math.floor(rnd() * cats.length)]);
      list.splice(0, list.length - 150);
      const st = s.settings.peek();
      batch(() => {
        s.inChat.value = inChatOf(
          list.map((c) => ({ c, a: st.actions[c] })),
          hushOn(st, s.platform.peek()),
        );
        s.seen.value += n;
      });
      secCount += n;
    }
    secAcc += dt;
    if (secAcc >= 1) {
      secAcc -= 1;
      const r = s.rate.peek().slice(1);
      r.push(secCount);
      secCount = 0;
      s.rate.value = r;
      if (rnd() < 0.2) {
        const v = s.vibe.peek().slice(1);
        v.push(Math.max(-1, Math.min(1, (v[v.length - 1] ?? 0) + (rnd() - 0.5) * 0.3)));
        s.vibe.value = v;
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/** Bar actions on the fake store, with the runtime's rules for the tab's views (Show hidden, Solo). */
export function fakeActions(s: Store, onReveal?: (key: string) => void): BarActions {
  const on = () => hushOn(s.settings.value, s.platform.peek());
  const save = (patch: Partial<Settings>) =>
    batch(() => {
      s.settings.value = { ...s.settings.value, ...patch };
      // Hush or the site off ends both views; Basic ends Solo.
      if (!on()) s.peek.value = false;
      if (!on() || s.settings.value.uiMode !== 'advanced') s.solo.value = null;
    });
  return {
    setPreset(p) {
      save({ preset: p, actions: p === 'custom' ? s.settings.value.actions : { ...PRESETS[p] } });
    },
    setAction(c, a) {
      save({ preset: 'custom', actions: { ...s.settings.value.actions, [c]: a } });
    },
    toggleEnabled() {
      save({ enabled: !s.settings.value.enabled });
    },
    openSidePanel() {
      console.log('[showcase] openSidePanel');
    },
    revealMessage(key) {
      console.log('[showcase] reveal', key);
      onReveal?.(key);
    },
    setMode(mode) {
      save({ uiMode: mode });
    },
    setLevel(level) {
      save(levelPatch(s.settings.value, level, (s.platform.peek() || undefined) as Platform | undefined));
    },
    setPeek(peek) {
      if (peek && !on()) return;
      batch(() => {
        s.peek.value = peek;
        if (peek) s.solo.value = null;
      });
    },
    setSolo(cat) {
      if (cat && (!on() || s.settings.value.uiMode !== 'advanced')) return;
      batch(() => {
        s.solo.value = cat === s.solo.value ? null : cat;
        if (s.solo.value) s.peek.value = false;
      });
    },
  };
}
