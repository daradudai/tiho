// Background-side client for the optional Hush Engine (local GPU server).
//
//   ask(query) ──▶ group by (filters, base, context) ──≤ 50 ms or 32 texts──▶ POST /v1/classify
//              ◀── answer, or null = no opinion (expired, overloaded, engine down)
//
// Health is polled only while the engine is enabled: every 10 s when ready,
// every 2 s while it loads, backing off from 2 s to 30 s while nothing
// answers. An answer that lands seconds late is useless in a live chat, so
// every text carries a deadline (2.5 s from ask): texts that can no longer
// make it are dropped before they are sent, requests tell the engine how much
// time is left (deadline_ms) and are aborted shortly after it. Under load the
// newest texts go first (they are the ones on screen). Answers are cached in
// a small LRU, so the same text from several tabs costs one request.

import { LRU } from '../core/lru';
import type { EngineStatus, EngineTestRequest, EngineTestResult } from '../core/protocol';
import {
  MAX_FILTERS,
  baseToScores,
  normalizeUrl,
  statusFromHealth,
  type ClassifyRequest,
  type ClassifyResponse,
  type Health,
} from './api';

export interface EngineQuery {
  text: string;
  platform?: string;
  /** Stream context for the channel the text comes from. */
  context?: string;
  /** Custom filters: id = filter key, question = what the engine is asked. */
  filters: { id: string; question: string }[];
  /** Also ask for the engine's own category scores (second opinion). */
  base: boolean;
}

export interface EngineAnswer {
  /** Probability per filter id. */
  filters: Record<string, number>;
  /** Engine scores aligned with LABELS (only when asked with `base`). */
  base?: number[];
}

export interface EngineClientOptions {
  fetch?: typeof fetch;
  /** Monotonic ms clock (default performance.now). */
  now?: () => number;
  /** Status changes (state, detail, model, device); counters alone do not notify. */
  onStatus?(s: EngineStatus): void;
  /** Texts per request. */
  batchMax?: number;
  /** Max wait for a batch to fill, ms. */
  batchWaitMs?: number;
  /** Time from ask() after which an answer is no longer wanted, ms. */
  deadlineMs?: number;
  /** Concurrent classify requests (Chrome allows 6 connections per host). */
  maxInflight?: number;
  cacheSize?: number;
}

const HEALTH_READY_MS = 10_000;
const HEALTH_LOADING_MS = 2_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const HEALTH_TIMEOUT_MS = 2_500;
/** A text with less time left than this is not worth sending. */
const MIN_BUDGET_MS = 250;
/** Extra wait past the deadline for the HTTP round trip. */
const ABORT_SLACK_MS = 500;
/** Texts queued per group before the oldest are dropped. */
const MAX_QUEUED = 256;
const TEST_TIMEOUT_MS = 30_000;

interface Entry {
  key: string;
  text: string;
  platform?: string;
  at: number;
  done: ((a: EngineAnswer | null) => void)[];
}

interface Group {
  key: string;
  filters: EngineQuery['filters'];
  base: boolean;
  context?: string;
  /** Oldest first. */
  entries: Entry[];
  /** Batch-fill timer; 0 = ready to go (or blocked on the in-flight limit). */
  timer: ReturnType<typeof setTimeout> | 0;
}

const isTimeout = (e: unknown) => {
  const n = (e as Error)?.name;
  return n === 'TimeoutError' || n === 'AbortError';
};

export class EngineClient {
  private enabled = false;
  private url = normalizeUrl(undefined);
  private st: EngineStatus = { state: 'off', url: this.url, answered: 0, expired: 0, latencyMs: 0 };
  private groups = new Map<string, Group>();
  /** Queued or in-flight texts by cache key (dedup). */
  private waiting = new Map<string, Entry>();
  private cache: LRU<string, EngineAnswer>;
  private inflight = 0;
  private aborts = new Set<AbortController>();
  private pollTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private backoff = BACKOFF_MIN_MS;
  private checking: Promise<EngineStatus> | null = null;
  /** Bumped on every reconfiguration: answers for an old configuration are ignored. */
  private epoch = 0;

  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly batchMax: number;
  private readonly batchWaitMs: number;
  private readonly deadlineMs: number;
  private readonly maxInflight: number;

  constructor(private opts: EngineClientOptions = {}) {
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = opts.now ?? (() => performance.now());
    this.batchMax = opts.batchMax ?? 32;
    this.batchWaitMs = opts.batchWaitMs ?? 50;
    this.deadlineMs = opts.deadlineMs ?? 2500;
    this.maxInflight = opts.maxInflight ?? 4;
    this.cache = new LRU(opts.cacheSize ?? 2000);
  }

  get status(): EngineStatus {
    return this.st;
  }

  /** Enabled and answering: worth asking. */
  get ready(): boolean {
    return this.enabled && this.st.state === 'ready';
  }

  /** Apply settings: start / stop health polling, switch engines. */
  configure(enabled: boolean, url?: string): void {
    const u = normalizeUrl(url);
    if (enabled === this.enabled && u === this.url) return;
    if (u !== this.url) this.cache.clear();
    this.enabled = enabled;
    this.url = u;
    this.epoch++;
    this.checking = null;
    this.stopPolling();
    this.cancelAll();
    this.backoff = BACKOFF_MIN_MS;
    this.setStatus({ state: enabled ? 'connecting' : 'off', url: u });
    if (enabled) void this.check();
  }

  /** Check health now (deduplicated); resolves with the new status. */
  check(): Promise<EngineStatus> {
    if (!this.enabled) return Promise.resolve(this.st);
    if (!this.checking) {
      const p = this.probe().finally(() => {
        if (this.checking === p) this.checking = null;
      });
      this.checking = p;
    }
    return this.checking;
  }

  /**
   * The engine's answer for one text, batched with others asked within
   * `batchWaitMs`. Null when there is no opinion in time (or the engine is
   * not ready): callers keep the local verdict.
   */
  ask(q: EngineQuery): Promise<EngineAnswer | null> {
    if (!this.ready || (!q.filters.length && !q.base) || !q.text) return Promise.resolve(null);
    const filters = q.filters.slice(0, MAX_FILTERS);
    const gkey = `${q.base ? 1 : 0}\x1f${q.context ?? ''}\x1f${filters.map((f) => f.id).join(',')}`;
    const key = `${gkey}\x1f${q.platform ?? ''}\x1f${q.text}`;
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const known = this.waiting.get(key);
      if (known) {
        known.done.push(resolve);
        return;
      }
      const e: Entry = { key, text: q.text, platform: q.platform, at: this.now(), done: [resolve] };
      this.waiting.set(key, e);
      let g = this.groups.get(gkey);
      if (!g) {
        g = { key: gkey, filters, base: q.base, context: q.context || undefined, entries: [], timer: 0 };
        this.groups.set(gkey, g);
      }
      g.entries.push(e);
      if (g.entries.length > MAX_QUEUED) this.settle(g.entries.shift()!, null);
      if (g.entries.length >= this.batchMax) this.flush(g);
      else if (!g.timer) {
        const grp = g;
        grp.timer = setTimeout(() => {
          grp.timer = 0;
          this.flush(grp);
        }, this.batchWaitMs);
      }
    });
  }

  /** One-off request for the side panel's "Test filter" (not batched, not cached, waits for the answer). */
  async test(req: EngineTestRequest): Promise<EngineTestResult> {
    const body: ClassifyRequest = {
      messages: [{ id: 't', text: req.text, ...(req.platform ? { platform: req.platform } : {}) }],
      filters: req.filters.slice(0, MAX_FILTERS),
      deadline_ms: 0,
    };
    if (req.context?.trim()) body.context = req.context.trim();
    const t0 = this.now();
    try {
      const res = await this.fetch(`${this.url}/v1/classify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      const j = (await res.json().catch(() => null)) as (ClassifyResponse & { error?: { code?: string; message?: string } }) | null;
      if (res.status === 503) {
        void this.check();
        return { ok: false, error: j?.error?.message ? `Engine not ready: ${j.error.message}` : 'Engine not ready yet' };
      }
      if (!res.ok || !j) return { ok: false, error: j?.error?.message ?? `HTTP ${res.status}` };
      const r = j.results?.[0];
      if (!r || 'error' in r) return { ok: false, error: r && 'error' in r ? `Engine: ${r.error}` : 'No answer' };
      return { ok: true, filters: r.filters, ms: Math.round(this.now() - t0) };
    } catch (e) {
      return { ok: false, error: isTimeout(e) ? 'The engine did not answer in time' : 'Hush Engine is not running' };
    }
  }

  dispose(): void {
    this.configure(false, this.url);
  }

  // ───────────────────────────── health ─────────────────────────────

  private async probe(): Promise<EngineStatus> {
    this.stopPolling();
    const epoch = this.epoch;
    const url = this.url;
    const t0 = this.now();
    let next: Omit<EngineStatus, 'answered' | 'expired' | 'latencyMs'>;
    try {
      const res = await this.fetch(`${url}/health`, { cache: 'no-store', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      const h = (await res.json().catch(() => null)) as Partial<Health> | null;
      next = statusFromHealth(url, res.status, h, Math.round(this.now() - t0));
    } catch (e) {
      next = { state: 'unreachable', url, detail: isTimeout(e) ? 'Not responding' : 'Not running', checkedAt: Date.now() };
    }
    if (epoch !== this.epoch) return this.st; // reconfigured meanwhile
    this.setStatus(next);
    this.schedulePoll();
    return this.st;
  }

  private schedulePoll(): void {
    this.stopPolling();
    if (!this.enabled) return;
    const s = this.st.state;
    let ms: number;
    if (s === 'ready' || s === 'loading') {
      this.backoff = BACKOFF_MIN_MS;
      ms = s === 'ready' ? HEALTH_READY_MS : HEALTH_LOADING_MS;
    } else {
      ms = this.backoff;
      this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = 0;
      void this.check();
    }, ms);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = 0;
  }

  /** A classify request could not reach the engine: report it and re-check soon. */
  private lost(): void {
    if (this.st.state === 'ready') this.setStatus({ ...this.st, state: 'unreachable', detail: 'Connection lost' });
    this.backoff = BACKOFF_MIN_MS;
    this.schedulePoll();
  }

  private setStatus(next: Omit<EngineStatus, 'answered' | 'expired' | 'latencyMs'>): void {
    const prev = this.st;
    this.st = { ...next, answered: prev.answered, expired: prev.expired, latencyMs: prev.latencyMs };
    const changed =
      prev.state !== next.state ||
      prev.url !== next.url ||
      prev.detail !== next.detail ||
      prev.model !== next.model ||
      prev.device !== next.device ||
      prev.version !== next.version;
    if (changed) this.opts.onStatus?.(this.st);
  }

  // ───────────────────────────── batching ─────────────────────────────

  private flush(g: Group): void {
    if (g.timer) {
      clearTimeout(g.timer);
      g.timer = 0;
    }
    while (g.entries.length) {
      // drop texts that can no longer be answered in time (oldest first)
      const oldest = this.now() - (this.deadlineMs - MIN_BUDGET_MS);
      let stale = 0;
      while (stale < g.entries.length && g.entries[stale]!.at < oldest) stale++;
      if (stale) for (const e of g.entries.splice(0, stale)) this.settle(e, null);
      if (!g.entries.length) break;
      if (this.inflight >= this.maxInflight) return; // pump() resumes when a request finishes
      // newest first: under load these are the texts on screen, older ones may expire
      const batch = g.entries.splice(Math.max(0, g.entries.length - this.batchMax));
      void this.send(g, batch);
    }
    if (!g.entries.length && !g.timer && this.groups.get(g.key) === g) this.groups.delete(g.key);
  }

  /** A request slot freed up: send what was blocked on it. */
  private pump(): void {
    for (const g of [...this.groups.values()]) {
      if (this.inflight >= this.maxInflight) return;
      if (!g.timer && g.entries.length) this.flush(g);
    }
  }

  private async send(g: Group, batch: Entry[]): Promise<void> {
    const epoch = this.epoch;
    const left = this.deadlineMs - (this.now() - batch[0]!.at);
    const body: ClassifyRequest = {
      messages: batch.map((e, i) => ({ id: String(i), text: e.text, ...(e.platform ? { platform: e.platform } : {}) })),
      filters: g.filters,
      deadline_ms: Math.max(MIN_BUDGET_MS, Math.round(left)),
    };
    if (g.base) body.base = true;
    if (g.context) body.context = g.context;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(MIN_BUDGET_MS, left) + ABORT_SLACK_MS);
    this.aborts.add(ac);
    this.inflight++;
    const t0 = this.now();
    const answers: (EngineAnswer | null)[] = batch.map(() => null);
    try {
      const res = await this.fetch(`${this.url}/v1/classify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (res.status === 503) void this.check(); // engine up, model not (any more)
      else if (res.ok) {
        const j = (await res.json()) as ClassifyResponse;
        for (const r of j.results ?? []) {
          const i = Number(r.id);
          if (!('error' in r) && i >= 0 && i < batch.length && r.filters) answers[i] = { filters: r.filters, base: baseToScores(r.base) };
        }
        const ms = this.now() - t0;
        this.st.latencyMs = this.st.latencyMs ? Math.round(this.st.latencyMs * 0.8 + ms * 0.2) : Math.round(ms);
      }
    } catch (e) {
      if (!ac.signal.aborted && !isTimeout(e) && epoch === this.epoch) this.lost();
    } finally {
      clearTimeout(timer);
      this.aborts.delete(ac);
      this.inflight--;
    }
    for (let i = 0; i < batch.length; i++) {
      const e = batch[i]!;
      const a = answers[i]!;
      if (a && epoch === this.epoch) this.cache.set(e.key, a);
      this.settle(e, a);
    }
    this.pump();
  }

  private settle(e: Entry, a: EngineAnswer | null, count = true): void {
    if (this.waiting.get(e.key) === e) this.waiting.delete(e.key);
    if (count) {
      if (a) this.st.answered++;
      else this.st.expired++;
    }
    for (const d of e.done) d(a);
  }

  /** Drop everything queued and abort requests in flight (their texts get no answer). */
  private cancelAll(): void {
    for (const g of this.groups.values()) {
      if (g.timer) clearTimeout(g.timer);
      for (const e of g.entries) this.settle(e, null, false);
    }
    this.groups.clear();
    for (const ac of this.aborts) ac.abort();
  }
}
