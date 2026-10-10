// Stress harness entry: bundled (vite, IIFE) into the mock chat page. Runs the
// real runtime with the real platform adapters and the real in-chat bar; the
// background/offscreen inference is replaced by a simulated Port with
// realistic batch latency (so hold / late-verdict paths are exercised).
//
// window.__hush = { runtime, stats(), reset() }

import { createBarActions } from '../../src/core/bar-actions';
import type { PortRequest, PortResponse } from '../../src/core/protocol';
import { DEFAULT_SETTINGS, PRESETS, type PresetId, type Settings } from '../../src/core/settings';
import { createStore } from '../../src/core/store';
import { twitch } from '../../src/platforms/twitch';
import { youtube } from '../../src/platforms/youtube';
import { ClassifierClient, type ClassifierTransport } from '../../src/runtime/classifier';
import { HushRuntime } from '../../src/runtime/engine';
import { findMountBar } from '../../src/runtime/index';
import { cleanForModel, normalize } from '../../src/core/normalize';

const qs = new URLSearchParams(location.search);
const LAT_BASE = Number(qs.get('lat') ?? 25); // ms per batch round-trip
const LAT_ITEM = Number(qs.get('latItem') ?? 0.4); // ms per item (batched inference)

// ───────────── simulated inference (scores from cheap keyword heuristics) ─────────────

const RE_TOXIC = /\b(idiot|stupid|retard|trash|loser|kys|kill yourself|fuck you|stfu|dumb|ugly|clown|hurensohn|puta|pendejo|cabron|сука|блять|идиот|kurwa|orospu|bitch|cunt|n[i1]gg)/i;
const RE_POS = /\b(love|great|amazing|pog|gg|nice|good|beautiful|best|thanks|thank you|lets go|let's go|danke|gracias|super|geil)\b|❤|😍|🥰/i;
const RE_NEG = /\b(boring|bad|worst|cringe|sucks|hate|terrible|awful|mid|L stream)\b/i;
const RE_SCAM = /\b(viewers|followers|crypto|bitcoin|free|giveaway|promo)\b/i;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

function score(text: string): number[] {
  const j = hash(text) * 0.15;
  const s = [j * 0.5, j * 0.5, j * 0.3, j, j, j, j];
  if (RE_TOXIC.test(text)) s[0] = 0.8 + j;
  if (RE_SCAM.test(text)) s[2] = 0.35 + j;
  if (text.length < 8) s[3] = 0.55 + j;
  if (text.includes('?')) s[4] = 0.7 + j;
  if (RE_POS.test(text)) s[5] = 0.7 + j;
  if (RE_NEG.test(text)) s[6] = 0.6 + j;
  return s;
}

class SimTransport implements ClassifierTransport {
  private cb: ((m: PortResponse) => void) | null = null;
  batches = 0;
  items = 0;
  post(req: PortRequest) {
    this.batches++;
    this.items += req.items.length;
    const lat = LAT_BASE + LAT_ITEM * req.items.length;
    setTimeout(() => {
      this.cb?.({
        type: 'scores',
        batchId: req.batchId,
        ids: req.items.map((x) => x.id),
        scores: req.items.map((x) => score(x.text)),
        ms: lat,
        backend: 'sim',
      });
    }, lat);
  }
  onMessage(cb: (m: PortResponse) => void) {
    this.cb = cb;
    setTimeout(() => cb({ type: 'status', status: { state: 'ready', backend: 'wasm' } }), 0);
  }
  onDisconnect() {}
  disconnect() {}
}

// ───────────── runtime ─────────────

const adapter = document.documentElement.dataset.skin === 'youtube' ? youtube : twitch;
const preset = (qs.get('preset') ?? 'chill') as Exclude<PresetId, 'custom'>;
let settings: Settings = {
  ...DEFAULT_SETTINGS,
  preset,
  actions: { ...PRESETS[preset] },
  holdMs: Number(qs.get('hold') ?? DEFAULT_SETTINGS.holdMs),
  decorate: qs.get('deco') !== '0',
};
const store = createStore(settings);
const transport = new SimTransport();

const LAT_N = 1 << 15;
const lat = new Float64Array(LAT_N);
let latN = 0;
let pendingShown = 0;

let rt: HushRuntime;
const classifier = new ClassifierClient(() => transport, {
  onScores: (ids) => rt.onScores(ids),
  onFailed: (ids) => rt.onFailed(ids),
  onStatus: (s) => rt.setModelStatus(s),
});

rt = new HushRuntime({
  adapter,
  settings,
  store,
  classifier,
  mountBar: qs.get('bar') === '0' ? null : findMountBar(),
  barActions: createBarActions({
    getSettings: () => settings,
    save: (patch) => {
      settings = { ...settings, ...patch };
      rt.setSettings(settings);
    },
    openSidePanel: () => {},
    reveal: (k) => rt.reveal(k),
  }),
  onDecision: (row, _v, final) => {
    const t = (row as HTMLElement & { __t?: number }).__t;
    if (t === undefined) return;
    if (final) {
      lat[latN++ % LAT_N] = performance.now() - t;
      (row as HTMLElement & { __t?: number }).__t = undefined;
    } else pendingShown++;
  },
});
rt.start();
classifier.connect();

function pct(a: Float64Array, n: number, p: number) {
  const m = Math.min(n, a.length);
  if (!m) return 0;
  const s = Array.from(a.subarray(0, m)).sort((x, y) => x - y);
  return s[Math.min(m - 1, Math.floor(m * p))]!;
}

const w = window as unknown as Record<string, unknown>;
w.__hush = {
  core: { normalize, cleanForModel },
  runtime: rt,
  stats() {
    const m = rt.metrics;
    return {
      msgs: m.msgs,
      mainMs: m.mainMs,
      msPerMsg: m.msgs ? m.mainMs / m.msgs : 0,
      maxSliceMs: m.maxSliceMs,
      split: m.split.map((x) => (m.msgs ? (x / m.msgs) * 1000 : 0)),
      slices: m.slices,
      frames: m.frames,
      decided: { ...m.decided },
      extractErrors: m.extractErrors,
      latency: { n: Math.min(latN, LAT_N), p50: pct(lat, latN, 0.5), p95: pct(lat, latN, 0.95), p99: pct(lat, latN, 0.99) },
      provisionalShown: pendingShown,
      sim: { batches: transport.batches, items: transport.items },
      cacheHitRate: classifier.cache.hitRate(),
      sizes: rt.debugSizes(),
      totals: store.totals.peek(),
      counts: store.counts.peek(),
      waves: store.waves.peek().slice(0, 5).map((x) => ({ text: x.text.slice(0, 40), count: x.count, users: x.users })),
      barMounted: !!document.querySelector('hush-bar'),
    };
  },
  /** Pause / resume filtering in place (paired A/B in one page). */
  setEnabled(on: boolean) {
    settings = { ...settings, enabled: on };
    rt.setSettings(settings);
  },
  reset() {
    const m = rt.metrics;
    m.msgs = 0;
    m.mainMs = 0;
    m.maxSliceMs = 0;
    m.split = [0, 0, 0];
    m.slices = 0;
    m.frames = 0;
    m.decided = { rule: 0, cache: 0, model: 0, fallback: 0, timeout: 0 };
    latN = 0;
    pendingShown = 0;
    transport.batches = transport.items = 0;
  },
};

// Diagnostics: ?css=none|nosib|nochild|nois — rewrite the injected row stylesheet.
const cssMode = qs.get('css');
if (cssMode) {
  const el = document.getElementById('hush-row-style');
  if (el) {
    let css = el.textContent ?? '';
    if (cssMode === 'none') css = '';
    const keep = (pred: (l: string) => boolean) => (css = css.split('\n').filter(pred).join('\n'));
    if (cssMode.includes('nosib')) keep((l) => !l.includes('+'));
    if (cssMode.includes('nochild')) keep((l) => !l.includes('>*{'));
    if (cssMode.includes('nois')) css = css.replaceAll(`:is(${adapter.rowSelector})`, '.chat-scrollable-area__message-container>div');
    el.textContent = css;
  }
}
