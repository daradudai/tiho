// Background-side router between content-script Ports and the offscreen
// inference host. Chrome APIs are injected so routing is unit-testable.
//
//   content Port ("hush:classify") ──{classify, batchId}──▶ hub ──{classify, id: gid}──▶ offscreen Port
//   content Port ◀──{scores, batchId}── hub ◀──{scores, id: gid}── offscreen Port
//
// Local scores are also handed to `onScores` (the background forwards them to
// the optional Hush Engine, whose answers go to the same Port later).
//
// A model that failed to load (network down during the download, crashed
// worker) is retried with backoff while any chat is open, so it comes back
// without the viewer toggling settings or restarting Chrome. The popup and
// side panel's Retry loads it again at once (`reload`).
//
// The SW may be killed at any time; nothing here must survive it: content
// scripts reconnect their Ports (with backoff) and the offscreen document
// reconnects when asked (MSG_OFFSCREEN_HELLO) or when it is re-created.

import type { ClassifyItem, PortRequest, PortResponse } from '../core/protocol';
import type { ModelStatus } from '../core/types';
import type { Device } from './config';
import type { FromOffscreen, InferenceStats, ToOffscreen } from './messages';

export interface PortLike {
  name: string;
  sender?: { tab?: { id?: number }; url?: string };
  postMessage(m: unknown): void;
  disconnect?(): void;
  onMessage: { addListener(cb: (m: any) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export interface HubDeps {
  /** Create the offscreen document if missing; ask an existing one to (re)connect. */
  ensureOffscreen(): Promise<void>;
  /** chrome.runtime.sendMessage to extension pages (popup / side panel / onboarding). */
  broadcast(m: { type: 'hush:status'; status: ModelStatus }): void;
  /** Persist the last status (chrome.storage.session) so a restarted SW answers quickly. */
  saveStatus?(s: ModelStatus): void;
  /** Local scores for a batch were posted to its Port (ids / scores as sent). */
  onScores?(r: LocalScores): void;
  now?: () => number;
}

export interface LocalScores {
  port: PortLike;
  batchId: number;
  items: ClassifyItem[];
  ids: string[];
  scores: number[][];
  /** The tab was in the background when it asked: nobody is looking at these rows. */
  hidden?: boolean;
}

interface Inflight {
  port: PortLike;
  batchId: number;
  items: ClassifyItem[];
  hidden: boolean;
  at: number;
}

const MAX_PENDING_ITEMS = 8192;
/** Retry a failed model load after this long, doubling up to RETRY_MAX_MS. */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

export class InferenceHub {
  private clients = new Set<PortLike>();
  private off: PortLike | null = null;
  private inflight = new Map<number, Inflight>();
  private pending: Array<{ id: number; items: ClassifyItem[] }> = [];
  private pendingItems = 0;
  private gid = 1;
  private status: ModelStatus = { state: 'idle', backend: 'none' };
  private kicking: Promise<void> | null = null;
  private device: Device | 'auto' = 'auto';
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = RETRY_MIN_MS;
  stats: InferenceStats | null = null;
  private readonly now: () => number;

  constructor(private deps: HubDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get connected(): boolean {
    return !!this.off;
  }

  getStatus(): ModelStatus {
    return this.status;
  }

  /** Restore a status persisted by a previous SW instance (only if we know nothing better). */
  restoreStatus(s: ModelStatus | undefined): void {
    if (s && !this.off && this.status.state === 'idle') this.status = s;
  }

  setDevice(d: Device | 'auto'): void {
    if (d === this.device) return;
    this.device = d;
    this.sendOff({ type: 'init', opts: { device: d } });
  }

  /** Make sure the offscreen host exists and is loading/serving the model. */
  kick(): Promise<void> {
    if (this.off) return Promise.resolve();
    this.kicking ??= this.deps
      .ensureOffscreen()
      .catch((e) => {
        this.setStatus({ state: 'error', backend: 'none', error: `offscreen: ${String((e as Error)?.message ?? e)}` });
      })
      .finally(() => {
        this.kicking = null;
      });
    return this.kicking;
  }

  addClient(port: PortLike): void {
    this.clients.add(port);
    port.onMessage.addListener((m: PortRequest) => this.onClientMessage(port, m));
    port.onDisconnect.addListener(() => {
      this.clients.delete(port);
      for (const [id, f] of this.inflight) if (f.port === port) this.inflight.delete(id);
      this.pending = this.pending.filter((p) => {
        const keep = this.inflight.has(p.id);
        if (!keep) this.pendingItems -= p.items.length;
        return keep;
      });
    });
    safePost(port, { type: 'status', status: this.status } satisfies PortResponse);
    void this.kick();
    this.retryLater();
  }

  attachOffscreen(port: PortLike): void {
    if (this.off && this.off !== port) {
      try {
        this.off.disconnect?.();
      } catch {
        /* stale */
      }
    }
    this.off = port;
    port.onMessage.addListener((m: FromOffscreen) => this.onOffscreenMessage(m));
    port.onDisconnect.addListener(() => {
      if (this.off !== port) return;
      this.off = null;
      this.failInflight('inference host disconnected');
      if (this.clients.size) setTimeout(() => void this.kick(), 250);
    });
    this.sendOff({ type: 'init', opts: { device: this.device } });
    const queued = this.pending;
    this.pending = [];
    this.pendingItems = 0;
    for (const q of queued) this.sendOff({ type: 'classify', id: q.id, items: q.items });
  }

  requestStats(): void {
    this.sendOff({ type: 'getStats' });
  }

  /** Load a failed model again now (the viewer pressed Retry), even without an open chat; the backoff starts over. */
  reload(): void {
    if (this.status.state !== 'error') return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryMs = RETRY_MIN_MS;
    this.load();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private onClientMessage(port: PortLike, m: PortRequest): void {
    if (!m || m.type !== 'classify' || !Array.isArray(m.items)) return;
    if (!m.items.length) {
      safePost(port, { type: 'scores', batchId: m.batchId, ids: [], scores: [], ms: 0, backend: this.status.backend });
      return;
    }
    const id = this.gid++;
    this.inflight.set(id, { port, batchId: m.batchId, items: m.items, hidden: m.hidden === true, at: this.now() });
    if (this.off) {
      this.sendOff({ type: 'classify', id, items: m.items });
      return;
    }
    if (this.pendingItems + m.items.length > MAX_PENDING_ITEMS) {
      this.inflight.delete(id);
      safePost(port, { type: 'error', batchId: m.batchId, error: 'inference host starting' } satisfies PortResponse);
      return;
    }
    this.pending.push({ id, items: m.items });
    this.pendingItems += m.items.length;
    void this.kick();
  }

  private onOffscreenMessage(m: FromOffscreen): void {
    switch (m?.type) {
      case 'scores': {
        const f = this.inflight.get(m.id);
        if (!f) return;
        this.inflight.delete(m.id);
        safePost(f.port, {
          type: 'scores',
          batchId: f.batchId,
          ids: m.ids,
          scores: m.scores,
          ms: m.ms,
          backend: m.backend,
        } satisfies PortResponse);
        this.deps.onScores?.({ port: f.port, batchId: f.batchId, items: f.items, ids: m.ids, scores: m.scores, hidden: f.hidden });
        return;
      }
      case 'error': {
        const f = this.inflight.get(m.id);
        if (!f) return;
        this.inflight.delete(m.id);
        safePost(f.port, { type: 'error', batchId: f.batchId, error: m.error } satisfies PortResponse);
        return;
      }
      case 'status':
        if (m.stats) this.stats = m.stats;
        this.setStatus(m.status);
        return;
      case 'stats':
        this.stats = m.stats;
        return;
      case 'crashed':
        this.failInflight(`inference worker crashed: ${m.error}`);
        this.setStatus({ state: 'loading', backend: 'none' });
        return;
    }
  }

  private failInflight(error: string): void {
    const all = [...this.inflight.values()];
    this.inflight.clear();
    this.pending = [];
    this.pendingItems = 0;
    for (const f of all) safePost(f.port, { type: 'error', batchId: f.batchId, error } satisfies PortResponse);
  }

  private setStatus(s: ModelStatus): void {
    const prev = this.status;
    this.status = s;
    if (s.state === 'ready') this.retryMs = RETRY_MIN_MS;
    this.retryLater();
    if (
      prev.state === s.state &&
      prev.backend === s.backend &&
      prev.progress === s.progress &&
      prev.error === s.error &&
      prev.modelId === s.modelId &&
      prev.version === s.version
    )
      return;
    for (const p of this.clients) safePost(p, { type: 'status', status: s } satisfies PortResponse);
    this.deps.broadcast({ type: 'hush:status', status: s });
    if (s.state !== 'downloading') this.deps.saveStatus?.(s);
  }

  /** While a chat is open, try a failed load again: after 5 s, then twice as long each time, up to 5 min. */
  private retryLater(): void {
    if (this.status.state !== 'error' || this.retryTimer || !this.clients.size) return;
    const ms = this.retryMs;
    this.retryMs = Math.min(RETRY_MAX_MS, ms * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.status.state === 'error' && this.clients.size) this.load();
    }, ms);
  }

  /** `init` makes the worker load again; without a host (or when its Port just failed), create one. */
  private load(): void {
    this.sendOff({ type: 'init', opts: { device: this.device } });
    if (!this.off) void this.kick();
  }

  private sendOff(m: ToOffscreen): void {
    if (!this.off) return;
    try {
      this.off.postMessage(m);
    } catch {
      this.off = null;
    }
  }
}

function safePost(port: PortLike, m: unknown): void {
  try {
    port.postMessage(m);
  } catch {
    /* port closed */
  }
}
