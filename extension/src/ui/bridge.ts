// Bridge between extension pages (popup, side panel, onboarding) and the
// content-script runtime / background.
//
//   side panel ──chrome.tabs.connect(tabId, {name: 'hush:live'})──▶ content script
//                ◀── { type: 'snapshot', snapshot } every ~1 s while connected
//                ──▶ LiveCommand (reveal, feedback)
//   popup ──chrome.tabs.sendMessage(tabId, {type:'hush:getSnapshot'})──▶ content (one-shot)
//         ──chrome.runtime.sendMessage({type:'hush:getPerf'})──▶ background (fallback)
//   any page ──{type:'hush:getStatus'}──▶ background → ModelStatus
//   any page ──{type:'hush:engine:getStatus' | 'hush:engine:test'}──▶ background → Hush Engine
//
// The content side is one call: `serveLive(store, handlers)` (runtime agent).
// Nothing is pushed unless a page is listening.

import type { EngineStatus, EngineTestRequest, EngineTestResult, RuntimeMessage } from '../core/protocol';
import type { Store, LogEntry, WaveInfo } from '../core/store';
import type { Category, ModelStatus, PerfStats } from '../core/types';
import { loadSettings, saveSettings, type UserRule } from '../core/settings';

export const PORT_LIVE = 'hush:live';
export const FEEDBACK_KEY = 'hush.feedback.v1';

export interface LiveSnapshot {
  v: 1;
  platform: string;
  channel: string;
  theme: 'dark' | 'light';
  enabled: boolean;
  model: ModelStatus;
  perf: PerfStats;
  counts: Record<Category, number>;
  totals: { seen: number; filtered: number };
  /** msgs/s, last 60 s, oldest first */
  rate: number[];
  /** vibe in [-1,1], last 60 × 5 s, oldest first */
  vibe: number[];
  waves: WaveInfo[];
  /** most recent first, ≤ 50 */
  questions: LogEntry[];
  /** most recent first, ≤ 100 */
  filtered: LogEntry[];
  ts: number;
}

export type LiveCommand =
  | { type: 'reveal'; key: string }
  /** User says this message was misjudged; runtime should un-hide it now. */
  | { type: 'feedback'; key: string; label: Category };

/** Port messages content → page. */
export type LivePush = { type: 'snapshot'; snapshot: LiveSnapshot };

/** One-shot messages page → content (chrome.tabs.sendMessage). */
export type TabMessage = { type: 'hush:getSnapshot' } | { type: 'hush:command'; cmd: LiveCommand };

/* ───────────────────────── content-script side ───────────────────────── */

export function snapshotFromStore(store: Store): LiveSnapshot {
  const s = store.settings.peek();
  return {
    v: 1,
    platform: store.platform.peek(),
    channel: store.channel.peek(),
    theme: store.theme.peek(),
    enabled: s.enabled,
    model: store.model.peek(),
    perf: store.perf.peek(),
    counts: store.counts.peek(),
    totals: store.totals.peek(),
    rate: store.rate.peek(),
    vibe: store.vibe.peek(),
    waves: store.waves.peek(),
    questions: store.questions.peek().slice(0, 50),
    filtered: store.filtered.peek().slice(0, 100),
    ts: Date.now(),
  };
}

export interface LiveHandlers {
  reveal(key: string): void;
  feedback?(key: string, label: Category): void;
}

/**
 * Call once from the content-script runtime (only in the frame that hosts the
 * chat). Answers one-shot snapshot requests and streams snapshots (~1/s) to
 * connected pages. Returns a disposer.
 */
export function serveLive(store: Store, handlers: LiveHandlers, intervalMs = 1000): () => void {
  const ports = new Set<chrome.runtime.Port>();
  let timer: ReturnType<typeof setInterval> | 0 = 0;

  const handle = (cmd: LiveCommand) => {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.type === 'reveal') handlers.reveal(cmd.key);
    else if (cmd.type === 'feedback') (handlers.feedback ?? ((k) => handlers.reveal(k)))(cmd.key, cmd.label);
  };

  const pushAll = () => {
    if (!ports.size) return;
    const msg: LivePush = { type: 'snapshot', snapshot: snapshotFromStore(store) };
    for (const p of ports) {
      try {
        p.postMessage(msg);
      } catch {
        ports.delete(p);
      }
    }
  };

  const onConnect = (port: chrome.runtime.Port) => {
    if (port.name !== PORT_LIVE) return;
    ports.add(port);
    port.onMessage.addListener((m) => handle(m as LiveCommand));
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      if (!ports.size && timer) {
        clearInterval(timer);
        timer = 0;
      }
    });
    try {
      port.postMessage({ type: 'snapshot', snapshot: snapshotFromStore(store) } satisfies LivePush);
    } catch {
      /* ignore */
    }
    if (!timer) timer = setInterval(pushAll, intervalMs);
  };

  const onMessage = (msg: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
    const m = msg as TabMessage;
    if (m?.type === 'hush:getSnapshot') {
      sendResponse(snapshotFromStore(store));
      return;
    }
    if (m?.type === 'hush:command') {
      handle(m.cmd);
      sendResponse({ ok: true });
    }
  };

  chrome.runtime.onConnect.addListener(onConnect);
  chrome.runtime.onMessage.addListener(onMessage);
  return () => {
    chrome.runtime.onConnect.removeListener(onConnect);
    chrome.runtime.onMessage.removeListener(onMessage);
    if (timer) clearInterval(timer);
    for (const p of ports) p.disconnect();
    ports.clear();
  };
}

/* ───────────────────────────── page side ─────────────────────────────── */

export interface ActiveTab {
  id: number;
  url: string;
  platform: 'youtube' | 'twitch' | 'kick' | null;
  host: string;
}

export function platformOf(url: string | undefined): ActiveTab['platform'] {
  if (!url) return null;
  try {
    const h = new URL(url).hostname;
    if (h.endsWith('youtube.com')) return 'youtube';
    if (h.endsWith('twitch.tv')) return 'twitch';
    if (h === 'kick.com' || h.endsWith('.kick.com')) return 'kick';
  } catch {
    /* ignore */
  }
  return null;
}

export async function getActiveTab(): Promise<ActiveTab | null> {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t?.id) return null;
    const url = t.url ?? t.pendingUrl ?? '';
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* ignore */
    }
    return { id: t.id, url, platform: platformOf(url), host };
  } catch {
    return null;
  }
}

/** One-shot snapshot from the active tab's content script; null when no chat runtime answers. */
export async function getSnapshot(tabId: number, timeoutMs = 800): Promise<LiveSnapshot | null> {
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'hush:getSnapshot' } satisfies TabMessage),
      new Promise((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
    return res && (res as LiveSnapshot).v === 1 ? (res as LiveSnapshot) : null;
  } catch {
    return null;
  }
}

/** Fallback perf from the background (implemented by the background agent). */
export async function getPerf(): Promise<{ stats: PerfStats & { platform?: string; channel?: string; counts?: Record<string, number> } } | null> {
  try {
    const r = (await chrome.runtime.sendMessage({ type: 'hush:getPerf' })) as any;
    if (!r) return null;
    if (r.stats) return r;
    if (typeof r.msgsPerSec === 'number') return { stats: r };
    return null;
  } catch {
    return null;
  }
}

export async function sendCommand(tabId: number, cmd: LiveCommand): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'hush:command', cmd } satisfies TabMessage);
    return true;
  } catch {
    return false;
  }
}

export interface LiveConnection {
  send(cmd: LiveCommand): void;
  dispose(): void;
}

/**
 * Follow the active tab of this window and stream its snapshots. Calls
 * `onUpdate(snapshot | null, tab)`; null means "no chat here (yet)".
 */
export function connectLive(onUpdate: (s: LiveSnapshot | null, tab: ActiveTab | null) => void): LiveConnection {
  let port: chrome.runtime.Port | null = null;
  let tab: ActiveTab | null = null;
  let retry: ReturnType<typeof setTimeout> | 0 = 0;
  let stale: ReturnType<typeof setTimeout> | 0 = 0;
  let disposed = false;

  const clear = () => {
    if (retry) clearTimeout(retry);
    if (stale) clearTimeout(stale);
    retry = stale = 0;
    if (port) {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      port = null;
    }
  };

  const armStale = () => {
    if (stale) clearTimeout(stale);
    stale = setTimeout(() => onUpdate(null, tab), 3500);
  };

  const connect = async () => {
    clear();
    if (disposed) return;
    tab = await getActiveTab();
    if (!tab || !tab.platform) {
      onUpdate(null, tab);
      return;
    }
    try {
      const p = chrome.tabs.connect(tab.id, { name: PORT_LIVE });
      port = p;
      armStale();
      p.onMessage.addListener((m: LivePush) => {
        if (m?.type === 'snapshot') {
          armStale();
          onUpdate(m.snapshot, tab);
        }
      });
      p.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (port === p) port = null;
        if (!disposed) retry = setTimeout(connect, 2000);
      });
    } catch {
      onUpdate(null, tab);
      retry = setTimeout(connect, 2000);
    }
  };

  const onActivated = () => void connect();
  const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
    if (tab && id === tab.id && (info.url || info.status === 'complete')) void connect();
  };
  chrome.tabs.onActivated?.addListener(onActivated);
  chrome.tabs.onUpdated?.addListener(onUpdated);
  void connect();

  return {
    send(cmd) {
      if (port) {
        try {
          port.postMessage(cmd);
          return;
        } catch {
          /* fall through */
        }
      }
      if (tab) void sendCommand(tab.id, cmd);
    },
    dispose() {
      disposed = true;
      clear();
      chrome.tabs.onActivated?.removeListener(onActivated);
      chrome.tabs.onUpdated?.removeListener(onUpdated);
    },
  };
}

/* ───────────────────────── model / engine status ─────────────────────── */

function asStatus(r: any): ModelStatus | null {
  if (!r) return null;
  if (r.status && typeof r.status.state === 'string') return r.status as ModelStatus;
  if (typeof r.state === 'string') return r as ModelStatus;
  return null;
}

export async function getModelStatus(): Promise<ModelStatus | null> {
  try {
    return asStatus(await chrome.runtime.sendMessage({ type: 'hush:getStatus' }));
  } catch {
    return null;
  }
}

/** Live model status broadcasts ({type:'hush:status'}). */
export function onModelStatus(cb: (s: ModelStatus) => void): () => void {
  const fn = (msg: any) => {
    if (msg?.type === 'hush:status') {
      const s = asStatus(msg);
      if (s) cb(s);
    }
  };
  try {
    chrome.runtime.onMessage.addListener(fn);
  } catch {
    return () => {};
  }
  return () => chrome.runtime.onMessage.removeListener(fn);
}

export interface EngineHealth {
  ok: boolean;
  /** The engine runs but its model is not ready yet. */
  loading?: boolean;
  model?: string;
  device?: string;
  version?: string;
  ms?: number;
  error?: string;
}

/** Direct /health check from an extension page (fallback when the background does not answer). */
export async function checkEngine(url: string, timeoutMs = 1500): Promise<EngineHealth> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const info = {
      model: (j.model as string) ?? (j.decision_model as string) ?? undefined,
      device: (j.device as string) ?? undefined,
      version: (j.version as string) ?? undefined,
      ms: Math.round(performance.now() - t0),
    };
    if (j.ok === false) return { ...info, ok: false, loading: j.status !== 'error', error: (j.detail as string) || (j.status as string) || 'Not ready' };
    return { ...info, ok: true };
  } catch (e) {
    const msg = (e as Error)?.name === 'TimeoutError' ? 'Not responding' : 'Not running';
    return { ok: false, error: msg };
  }
}

function asEngineStatus(r: unknown): EngineStatus | null {
  const o = r as { status?: unknown } | null;
  const s = (o && typeof o.status === 'object' ? o.status : r) as EngineStatus | null;
  return s && typeof s === 'object' && typeof s.state === 'string' && typeof s.url === 'string' ? s : null;
}

/**
 * Hush Engine status from the background, which polls the engine while it is
 * enabled; `fresh` re-checks now. Falls back to a direct health check of
 * `url` when the background does not answer.
 */
export async function getEngineStatus(url: string, fresh = false): Promise<EngineStatus> {
  try {
    const s = asEngineStatus(await chrome.runtime.sendMessage({ type: 'hush:engine:getStatus', fresh } satisfies RuntimeMessage));
    if (s) return s;
  } catch {
    /* no background */
  }
  const h = await checkEngine(url);
  return {
    state: h.ok ? 'ready' : h.loading ? 'loading' : h.error === 'Not running' || h.error === 'Not responding' ? 'unreachable' : 'error',
    url,
    detail: h.ok ? undefined : h.error,
    model: h.model,
    device: h.device,
    version: h.version,
    pingMs: h.ms,
    answered: 0,
    expired: 0,
    latencyMs: 0,
    checkedAt: Date.now(),
  };
}

/** Live engine status broadcasts ({type:'hush:engine:status'}). */
export function onEngineStatus(cb: (s: EngineStatus) => void): () => void {
  const fn = (msg: any) => {
    if (msg?.type === 'hush:engine:status') {
      const s = asEngineStatus(msg);
      if (s) cb(s);
    }
  };
  try {
    chrome.runtime.onMessage.addListener(fn);
  } catch {
    return () => {};
  }
  return () => chrome.runtime.onMessage.removeListener(fn);
}

/** "NVIDIA GeForce RTX 3090 (24 GB)" → "RTX 3090 (24 GB)" */
function shortDevice(d: string | undefined): string {
  return (d ?? '').replace(/^(NVIDIA\s+)?(GeForce\s+)?/i, '').trim();
}

/** Human-readable engine status for extension pages. */
export function engineSummary(s: EngineStatus | null): { title: string; sub: string; tone: 'ok' | 'load' | 'err' | 'idle' } {
  if (!s) return { title: 'Checking…', sub: '', tone: 'load' };
  switch (s.state) {
    case 'off':
      return { title: 'Off', sub: 'Turn on to use custom filters', tone: 'idle' };
    case 'connecting':
      return { title: 'Connecting…', sub: s.url, tone: 'load' };
    case 'ready':
      return {
        title: 'Connected',
        sub: [s.model, shortDevice(s.device), s.latencyMs ? `~${s.latencyMs} ms per answer` : ''].filter(Boolean).join(' · '),
        tone: 'ok',
      };
    case 'loading':
      return { title: 'Loading the model…', sub: s.detail || 'Takes up to a minute', tone: 'load' };
    case 'unreachable':
      return { title: 'Not running', sub: `Nothing answers at ${s.url.replace(/^https?:\/\//, '')}`, tone: 'err' };
    case 'error':
      return { title: 'Engine problem', sub: s.detail || 'See the engine window for details', tone: 'err' };
  }
}

/** Ask the engine about one sample message ("Test filter"); waits for the answer. */
export async function testEngine(req: EngineTestRequest): Promise<EngineTestResult> {
  try {
    const r = (await chrome.runtime.sendMessage({ type: 'hush:engine:test', ...req } satisfies RuntimeMessage)) as EngineTestResult | undefined;
    return r && typeof r.ok === 'boolean' ? r : { ok: false, error: 'The extension background did not answer' };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/* ──────────────────────────── feedback ───────────────────────────────── */

export interface FeedbackEntry {
  ts: number;
  text: string;
  author: string;
  platform: string;
  channel: string;
  was: Category;
  reason: string;
  label: Category;
}

/**
 * "Not spam": remember locally (for future tuning, never uploaded), add an
 * allow rule, and tell the tab to un-hide the message now.
 */
export async function markNotFiltered(
  entry: LogEntry,
  scope: 'author' | 'text',
  conn?: LiveConnection | null,
): Promise<UserRule> {
  const rule: UserRule = {
    id: `fb-${Date.now().toString(36)}`,
    kind: scope === 'author' ? 'user' : 'word',
    pattern: scope === 'author' ? entry.msg.author : entry.msg.text.trim().slice(0, 120),
    mode: 'allow',
    enabled: true,
  };
  const s = await loadSettings();
  const dup = s.rules.find((r) => r.kind === rule.kind && r.pattern.toLowerCase() === rule.pattern.toLowerCase());
  if (!dup) await saveSettings({ rules: [...s.rules, rule] });
  try {
    const r = await chrome.storage.local.get(FEEDBACK_KEY);
    const list = ((r[FEEDBACK_KEY] as FeedbackEntry[]) ?? []).slice(-499);
    list.push({
      ts: Date.now(),
      text: entry.msg.text,
      author: entry.msg.author,
      platform: entry.msg.platform,
      channel: entry.msg.channel,
      was: entry.verdict.category,
      reason: entry.verdict.reason,
      label: 'clean',
    });
    await chrome.storage.local.set({ [FEEDBACK_KEY]: list });
  } catch {
    /* ignore */
  }
  conn?.send({ type: 'feedback', key: entry.msg.key, label: 'clean' });
  return dup ?? rule;
}
