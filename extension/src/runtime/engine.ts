// The per-frame content-script engine.
//
//  MutationObserver (chat list, childList) ──▶ queue
//  (while filtering, the list carries data-tiho-list: rows without a verdict
//   attribute are invisible from birth — no flash, no per-row premark write)
//                                                │ rAF (timer when hidden, 1 s watchdog)
//                                                ▼
//  READ  phase: adapter.extract → normalize → rules → waves → cache → policy
//               misses → classifier queue; held rows stay invisible
//  RESOLVE    : scores that arrived (coalesced with page frames), failed
//               batches, hold timeouts, late Tiho Engine answers
//  WRITE phase: data-tiho-a / -c / -r / -wh / -wm attribute diffs, then
//               data-tiho-run on the last row of every changed pill run
//               (that row is the pill: a button for the keyboard too)
//  FLUSH      : classifier batch → Port; Store (≤ 4 Hz, one batch())
//
// What the list holds right now (Store.inChat) is kept in O(1) per change:
// each row remembers what it adds to the counters, and every write or removal
// moves them by the difference. Show hidden and Solo (views of this tab) swap
// the stylesheet and write nothing on rows.
//
// No layout reads, no inline styles, one stylesheet. Rows are tracked in a
// WeakMap; a row whose content changes (recycled node) is re-evaluated. A
// message seen before that comes back in a new node keeps what was decided
// about it (recent, by ChatMessage.key), and its scores while the model that
// gave them is loaded.

import { batch } from '@preact/signals';
import { LRU } from '../core/lru';
import { cleanForModel, normalize } from '../core/normalize';
import { decide, modelCanHide, policyContext, type PolicyContext } from '../core/policy';
import { needsModel, RuleEngine, Sig, type RuleResult } from '../core/rules';
import type { Settings } from '../core/settings';
import { createStore, zeroInChat, type InChat, type LogEntry, type Store } from '../core/store';
import type { Category, ChatMessage, ModelStatus, PerfStats, Verdict } from '../core/types';
import { WaveDetector, type WaveHit, type WaveOptions } from '../core/waves';
import type { BarActions, MountBar } from '../core/bar-actions';
import type { PlatformAdapter } from '../platforms/types';
import { modelKey, type ClassifierClient } from './classifier';
import { ATTR, RowStyles, type StyleOptions } from './styles';

export interface RuntimeReport {
  stats: PerfStats & { platform: string; channel: string };
}

export interface RuntimeOptions {
  adapter: PlatformAdapter;
  settings: Settings;
  store?: Store;
  doc?: Document;
  classifier?: ClassifierClient | null;
  /** Monotonic ms clock (default performance.now). */
  now?: () => number;
  raf?: (cb: () => void) => number;
  caf?: (id: number) => void;
  mountBar?: MountBar | null;
  barActions?: BarActions | null;
  /** Called every ~2 s with perf (e.g. forwarded to the background). */
  onReport?: (r: RuntimeReport) => void;
  /** Min interval between Store writes for counters/logs (ms). */
  storeIntervalMs?: number;
  /** Housekeeping interval (ms). */
  tickMs?: number;
  waves?: WaveOptions;
  /** Debug hook: called when a row gets a verdict (final = not provisional). */
  onDecision?: (row: HTMLElement, v: Verdict, final: boolean) => void;
  /** Called whenever the runtime attaches to a chat list (e.g. to open the classifier Port lazily). */
  onAttach?: (list: HTMLElement) => void;
}

/** What a row adds to InChat: nothing (no verdict yet), shown, hidden, folded into a pill, or folded into a wave head. */
type Tally = '' | 'shown' | 'hidden' | 'folded' | 'wave';

interface RowState {
  key: string;
  text: string;
  msg: ChatMessage;
  norm: string;
  rule: RuleResult;
  wave: WaveHit | null;
  scores: number[] | null;
  /** Model that gave `scores` (modelKey): another model's scores are asked again, not re-thresholded. */
  model: string;
  verdict: Verdict | null;
  /** Verdict is final (not provisional / not waiting for the model). */
  final: boolean;
  waiting: boolean;
  viaModel: boolean;
  /** Hold deadline (0 = not held). */
  deadline: number;
  t0: number;
  /** What this row adds to inChat now, from the attributes written on it (see tally)... */
  tk: Tally;
  /** ...and under which category ('' when it adds nothing). */
  tc: Category | '';
  loggedFiltered: boolean;
  loggedQuestion: boolean;
  vibed: boolean;
  revealed: boolean;
  // attribute values currently on the row
  a: string;
  c: string;
  r: string;
  wh: number;
  /** When the wave counter was last written (throttled: it relayouts the head row). */
  whAt: number;
  wm: boolean;
  /** Collapsed rows in this row's pill run up to and including it (0 when not collapsed). */
  run: number;
  /** data-tiho-run value on the row (0 = none): only the run's last row carries it. */
  rm: number;
  /** Stamp of the last run re-count that covered this row. */
  runAt: number;
  /** Visibility class last written: 0 takes no space, 1 pill, 2 visible (-1 unknown). */
  vis: number;
}

const LAT_RING = 4096;
/** Messages remembered after their row is gone (more than any platform keeps mounted or buffered). */
const RECENT_MESSAGES = 1024;
const WAVE_COUNTER_MS = 250;
const RESOLVE_COALESCE_MS = 40;
const COALESCE_MIN_RATE = 20; // msg/s
const COLLAPSED = `[${ATTR.action}="collapse"]`;
/** What the pill row says to assistive tech (the pill itself is drawn by the stylesheet). */
const pillLabel = (n: number) => `${n} hidden message${n === 1 ? '' : 's'}, show`;

/** 0 = takes no space (hidden / wave member), 1 = collapsed (part of a pill run), 2 = visible. */
function visClass(el: Element): number {
  const a = el.getAttribute(ATTR.action);
  if (a === 'hide') return 0;
  if (a !== 'collapse' || el.hasAttribute(ATTR.open)) return 2;
  return el.hasAttribute(ATTR.waveMember) ? 0 : 1;
}

const PCT_SAMPLE = 512;
const pctScratch = new Float64Array(PCT_SAMPLE);

/** p50 / p95 over the most recent ≤ 512 samples of a ring (one in-place numeric sort). */
function percentiles(ring: Float64Array, n: number): [number, number] {
  const m = Math.min(n, ring.length, PCT_SAMPLE);
  if (!m) return [0, 0];
  const size = ring.length;
  for (let i = 0; i < m; i++) pctScratch[i] = ring[(n - 1 - i + size * 2) % size]!;
  const a = pctScratch.subarray(0, m).sort();
  return [a[Math.floor((m - 1) * 0.5)]!, a[Math.floor((m - 1) * 0.95)]!];
}

export class TihoRuntime {
  readonly store: Store;
  readonly adapter: PlatformAdapter;
  readonly rules = new RuleEngine();
  readonly waves: WaveDetector;

  /** Instrumentation (read by tests and the stress harness). */
  readonly metrics = {
    msgs: 0,
    /** Total main-thread ms spent in runtime callbacks. */
    mainMs: 0,
    /** Longest single runtime callback, ms. */
    maxSliceMs: 0,
    slices: 0,
    /** Main-thread ms split by callback: [observer, frame, housekeeping]. */
    split: [0, 0, 0] as [number, number, number],
    frames: 0,
    decided: { rule: 0, cache: 0, model: 0, fallback: 0, timeout: 0 },
    extractErrors: 0,
    lat: new Float64Array(LAT_RING),
    latN: 0,
    modelLat: new Float64Array(LAT_RING),
    modelLatN: 0,
  };

  private doc: Document;
  private settings: Settings;
  private ctx: PolicyContext;
  private thresholds: number[] | null = null;
  /** Model loaded now (modelKey of the last ready status). */
  private model = '';
  private classifier: ClassifierClient | null;
  private now: () => number;
  private raf: (cb: () => void) => number;
  private caf: (id: number) => void;
  private styles = new RowStyles();

  private list: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private states = new WeakMap<Element, RowState>();
  private retries = new WeakMap<Element, number>();
  private retryQueue: HTMLElement[] = [];
  private live = new Set<HTMLElement>();
  private byKey = new Map<string, HTMLElement>();
  /**
   * State of recent messages by ChatMessage.key, kept across detach. A message
   * that comes back in a new node (Kick re-mounts rows scrolled back into
   * view, YouTube re-renders the list on a chat-mode switch, Tiho or the site
   * turned off and on) keeps its verdict and is not counted, logged or fed to
   * the duplicate tracker and waves a second time. Its scores stand while
   * their model is loaded; after a switch it is scored again (see process).
   */
  private recent = new LRU<string, RowState>(RECENT_MESSAGES);
  private queue = new Set<HTMLElement>();
  private dirty = new Set<HTMLElement>();
  private waiting = new Map<string, HTMLElement[]>();
  private held = new Set<HTMLElement>();
  private resolvedIds: string[] = [];
  private failedIds: string[] = [];
  /** Normalized texts whose cached scores got a Tiho Engine answer since the last frame. */
  private rescored = new Set<string>();
  private waveDirty = new Set<string>();
  private waveHeads = new Map<string, string>();
  /** Rows (or neighbours of removed rows) whose pill run must be re-counted. */
  private runDirty = new Set<Element>();
  private runStamp = 0;

  private running = false;
  private active = false;
  /** The settings can hide or fold a message (an action or a block rule). */
  private canHide = false;
  /** Hide rows until their first verdict (list-level data-tiho-list). */
  private holdAtBirth = false;
  private listMarked = false;
  /** First pass over the rows present at attach is done (only then mark the list). */
  private primed = false;
  /** A runtime error happened: never hide rows at birth again (fail open). */
  private failOpen = false;
  private lastFrameAt = 0;
  private holdOn = false;
  private scheduled = false;
  private scheduledAt = 0;
  private rafId = 0;
  private fallbackId: ReturnType<typeof setTimeout> | 0 = 0;
  private resolveTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private laterTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private holdTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private nextDeadline = Infinity;
  private tickTimer: ReturnType<typeof setInterval> | 0 = 0;
  private ticks = 0;
  private href = '';
  private channel = '';
  private theme: 'dark' | 'light' = 'dark';
  /** Views of this tab, never saved (mirrored in store.peek / store.solo). */
  private peek = false;
  private solo: Category | null = null;

  // store accumulators
  /** What the list holds now (see tally); copied into the store when it changed. */
  private inChat: InChat = zeroInChat();
  private inChatDirty = false;
  private seen = 0;
  private newQuestions: LogEntry[] = [];
  private newFiltered: LogEntry[] = [];
  private storeDirty = false;
  private wavesDirty = false;
  private lastStoreAt = -Infinity;
  private readonly storeIntervalMs: number;
  private readonly tickMs: number;
  private secCount = 0;
  private rateArr: number[];
  private vibeArr: number[];
  private vibePos = 0;
  private vibeNeg = 0;
  private vibeN = 0;
  private lastPerf = { at: 0, received: 0, msgs: 0, mainMs: 0 };
  private mainEwma = 0;

  // bar
  private mountBar: MountBar | null;
  private barActions: BarActions | null;
  private barCleanup: (() => void) | null = null;
  private barAnchor: HTMLElement | null = null;
  private onReport?: (r: RuntimeReport) => void;
  private onDecision?: (row: HTMLElement, v: Verdict, final: boolean) => void;
  private onAttach?: (list: HTMLElement) => void;

  constructor(o: RuntimeOptions) {
    this.adapter = o.adapter;
    this.settings = o.settings;
    this.store = o.store ?? createStore(o.settings);
    this.doc = o.doc ?? document;
    this.classifier = o.classifier ?? null;
    this.now = o.now ?? (() => performance.now());
    const win = this.doc.defaultView ?? (globalThis as unknown as Window);
    this.raf = o.raf ?? ((cb) => win.requestAnimationFrame(cb));
    this.caf = o.caf ?? ((id) => win.cancelAnimationFrame(id));
    this.mountBar = o.mountBar ?? null;
    this.barActions = o.barActions ?? null;
    this.onReport = o.onReport;
    this.onDecision = o.onDecision;
    this.onAttach = o.onAttach;
    this.storeIntervalMs = o.storeIntervalMs ?? 250;
    this.tickMs = o.tickMs ?? 1000;
    this.waves = new WaveDetector(o.waves);
    this.rateArr = this.store.rate.peek().slice();
    this.vibeArr = this.store.vibe.peek().slice();
    this.ctx = policyContext(o.settings);
    this.applySettings(o.settings, false);
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.store.platform.value = this.adapter.platform;
    this.tickTimer = setInterval(() => this.tick(), this.tickMs);
    this.tryAttach();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = 0;
    this.detach(true);
    this.unmountBar();
    this.styles.remove();
    for (const t of [this.holdTimer, this.resolveTimer, this.laterTimer]) if (t) clearTimeout(t);
    this.holdTimer = this.resolveTimer = this.laterTimer = 0;
    this.cancelFrame();
  }

  get attached(): boolean {
    return !!this.list;
  }

  setSettings(s: Settings): void {
    this.applySettings(s, true);
  }

  setModelStatus(s: ModelStatus): void {
    this.store.model.value = s;
    const model = modelKey(s);
    const swapped = !!model && !!this.model && model !== this.model;
    if (model) this.model = model;
    const thr = s.thresholds && s.thresholds.length ? s.thresholds : null;
    if (thr && JSON.stringify(thr) !== JSON.stringify(this.thresholds)) {
      this.thresholds = thr;
      this.ctx = policyContext(this.settings, thr);
      if (!swapped) this.reevaluateAll(false);
    }
    if (swapped) this.rescoreAll();
    this.holdOn = this.computeHold();
  }

  /** Scores for these cache ids landed in the classifier cache. */
  onScores(ids: string[]): void {
    for (const id of ids) this.resolvedIds.push(id);
    this.scheduleResolve();
  }

  /** These ids will not get scores (error / timeout / disconnect). */
  onFailed(ids: string[]): void {
    for (const id of ids) this.failedIds.push(id);
    this.scheduleResolve();
  }

  /** Tiho Engine answers were attached to the cached scores of these ids: rows already decided on them may change. */
  onRescored(ids: string[]): void {
    for (const id of ids) this.rescored.add(id);
    this.scheduleResolve();
  }

  /**
   * Late verdicts ride along with the next frame the page renders anyway (new
   * rows arriving schedule one); only if none comes within RESOLVE_COALESCE_MS
   * do we request a frame of our own. Saves a style/layout/paint pass per
   * model round-trip at the cost of ≤ RESOLVE_COALESCE_MS latency — only in
   * fast chats (slow chats have no frames to ride and nothing to save).
   */
  private scheduleResolve(): void {
    if (this.scheduled || this.resolveTimer) return;
    if (this.rateArr[this.rateArr.length - 1]! < COALESCE_MIN_RATE) {
      this.schedule();
      return;
    }
    this.resolveTimer = setTimeout(() => {
      this.resolveTimer = 0;
      this.schedule();
    }, RESOLVE_COALESCE_MS);
  }

  /** Un-hide a message (by ChatMessage.key) and scroll it into view. */
  reveal(key: string): boolean {
    const row = this.byKey.get(key);
    const st = row && this.states.get(row);
    if (!row || !st) return false;
    if (this.solo && st.c !== this.solo) this.setViews(false, null); // Solo hides it: show everything first
    st.revealed = true;
    row.setAttribute(ATTR.open, '');
    this.writeRow(row, st);
    if (this.runDirty.size) this.writeRuns();
    try {
      row.scrollIntoView({ block: 'nearest' });
    } catch {
      /* not in a scrollable view */
    }
    return true;
  }

  /**
   * Show hidden in this tab (never saved): hidden and folded rows come back in
   * place, faded and tagged. Ends Solo. Ignored while Tiho is off here.
   */
  setPeek(on: boolean): void {
    if (on && !this.active) return;
    this.setViews(on, on ? null : this.solo);
  }

  /**
   * Show only this category in this tab (never saved); the same one again, or
   * null, shows everything. Ends Show hidden. Advanced mode only, and only
   * while Tiho is on here: ignored otherwise.
   */
  setSolo(cat: Category | null): void {
    if (cat && (!this.active || this.settings.uiMode !== 'advanced')) return;
    const next = cat === this.solo ? null : cat;
    this.setViews(next ? false : this.peek, next);
  }

  /**
   * The views are user actions: the store changes at once (not with the
   * store batch), then one stylesheet swap. Nothing is written on rows and
   * nothing is decided again. Solo also changes what is held at birth.
   */
  private setViews(peek: boolean, solo: Category | null): void {
    if (peek === this.peek && solo === this.solo) return;
    const soloChanged = solo !== this.solo;
    this.peek = peek;
    this.solo = solo;
    batch(() => {
      this.store.peek.value = peek;
      this.store.solo.value = solo;
    });
    this.styles.update(this.styleOpts());
    if (soloChanged) {
      this.syncHold();
      this.syncListMark();
    }
  }

  /** Run a frame synchronously (tests / harness). */
  flushNow(): void {
    this.cancelFrame();
    this.scheduled = true;
    this.frame();
  }

  /** Run housekeeping synchronously (tests / harness). */
  tickNow(): void {
    this.tick();
  }

  /** Sizes of internal structures (memory diagnostics). */
  debugSizes(): Record<string, number> {
    let waiting = 0;
    for (const w of this.waiting.values()) waiting += w.length;
    return {
      live: this.live.size,
      byKey: this.byKey.size,
      queue: this.queue.size,
      dirty: this.dirty.size,
      waitingIds: this.waiting.size,
      waitingRows: waiting,
      held: this.held.size,
      waveHeads: this.waveHeads.size,
      waveClusters: this.waves.clusters,
      cache: this.classifier ? this.classifier.cache.size : 0,
      inflight: this.classifier ? this.classifier.inflight : 0,
    };
  }

  // ───────────────────────────── settings ─────────────────────────────

  private applySettings(s: Settings, reevaluate: boolean): void {
    const prev = this.settings;
    this.settings = s;
    if (reevaluate) this.store.settings.value = s;
    this.rules.setSettings(s);
    this.ctx = policyContext(s, this.thresholds);
    const blockRules = s.rules.some((r) => r.enabled && r.mode === 'block');
    this.canHide = Object.values(s.actions).some((a) => a === 'hide' || a === 'collapse') || blockRules;
    const wasActive = this.active;
    this.active = s.enabled && s.sites[this.adapter.platform] !== false;
    if (this.solo && s.uiMode !== 'advanced') this.setViews(this.peek, null); // Solo is Advanced only (off here: detach ends both views)
    this.syncHold();
    if (!this.running) return;
    if (this.list) this.styles.update(this.styleOpts());
    if (wasActive && !this.active) {
      this.detach(true);
      this.styles.remove();
    } else if (!wasActive && this.active) {
      this.tryAttach();
    } else if (reevaluate && this.list) {
      const rulesChanged = prev.rules !== s.rules || prev.trustPrivileged !== s.trustPrivileged;
      this.reevaluateAll(rulesChanged);
    }
    this.syncListMark();
    this.ensureBar();
  }

  /** Set / remove data-tiho-list on the chat list (rows hidden until their first verdict). */
  private syncListMark(): void {
    const want = !!this.list && this.primed && this.active && this.holdAtBirth && !this.failOpen;
    if (want === this.listMarked) return;
    this.listMarked = want;
    const list = this.list;
    if (!list) return;
    if (!want) {
      list.removeAttribute(ATTR.list);
      return;
    }
    // children that are not rows (and rows already decided without an
    // attribute) must never fall under the hide-at-birth rule
    const kids = list.children;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (!k.hasAttribute(ATTR.action) && !this.queue.has(k as HTMLElement) && !this.held.has(k as HTMLElement))
        k.setAttribute(ATTR.action, '');
    }
    list.setAttribute(ATTR.list, '');
  }

  /**
   * New rows are hidden from birth, and held for the model, when the settings
   * can hide one, or during Solo: any row may turn out to be another category.
   */
  private syncHold(): void {
    this.holdAtBirth = this.canHide || !!this.solo;
    this.holdOn = this.computeHold();
  }

  private computeHold(): boolean {
    const s = this.settings;
    return !!this.classifier && s.holdMs > 0 && this.classifier.holdable && (modelCanHide(s.actions) || !!this.solo);
  }

  private styleOpts(): StyleOptions {
    const s = this.settings;
    return { decorate: s.decorate, theme: this.theme, platform: this.adapter.platform, mode: s.uiMode, peek: this.peek, solo: this.solo };
  }

  /** Recompute verdicts for every live row (settings / thresholds changed). */
  private reevaluateAll(rulesChanged: boolean): void {
    const now = this.now();
    for (const row of this.live) {
      const st = this.states.get(row);
      if (!st) continue;
      if (rulesChanged) {
        const dup = !!(st.rule.sig & Sig.DUPLICATE);
        st.rule = this.rules.evaluate(st.msg, st.norm, now, dup);
      }
      this.redecide(row, st);
    }
    this.schedule();
  }

  /**
   * Another model was loaded (the 3-layer student after a lost GPU, say). The
   * old one's scores mean nothing against the new thresholds, so rows decided
   * on them are asked again instead of re-thresholded; they keep their verdict
   * until the new scores land. Messages off screen are asked again when they
   * come back (process).
   */
  private rescoreAll(): void {
    const cl = this.classifier;
    for (const row of this.live) {
      const st = this.states.get(row);
      if (!st) continue;
      if (st.scores && !st.waiting && cl?.available) this.ask(cl, row, st);
      else this.redecide(row, st);
    }
    this.schedule();
  }

  // ───────────────────────────── attach / observe ─────────────────────────────

  private loc(): Location {
    return (this.doc.defaultView ?? window).location;
  }

  private tryAttach(): void {
    if (!this.running || !this.active) return;
    if (this.list && this.list.isConnected) return;
    if (this.list) this.detach(false);
    const loc = this.loc();
    let list: HTMLElement | null = null;
    try {
      if (!this.adapter.matches(loc)) return;
      list = this.adapter.findChatList(this.doc);
    } catch {
      return;
    }
    if (list) this.attach(list);
  }

  private attach(list: HTMLElement): void {
    this.list = list;
    this.primed = false;
    try {
      this.onAttach?.(list);
    } catch {
      /* caller's problem */
    }
    this.href = this.loc().href;
    try {
      this.theme = this.adapter.theme(this.doc);
      this.channel = this.adapter.channel(this.doc);
      this.rules.setViewer(this.adapter.viewer?.(this.doc) ?? null);
    } catch {
      /* adapter best-effort */
    }
    this.store.theme.value = this.theme;
    this.store.channel.value = this.channel;
    const root = list.getRootNode();
    const inShadow = root.nodeType === 11 && 'host' in root;
    this.styles.mount(inShadow ? (root as ShadowRoot) : this.doc, this.styleOpts());

    const sub = !!this.adapter.observeSubtree;
    this.observer = new MutationObserver(this.onMutations);
    this.observer.observe(list, { childList: true, subtree: sub, characterData: sub });
    list.addEventListener('click', this.onClick, true);
    list.addEventListener('keydown', this.onKeyDown, true);

    // rows already present
    const kids = list.children;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i] as HTMLElement;
      if (this.isRow(k)) this.queue.add(k);
    }
    this.ensureBar();
    this.schedule();
  }

  private detach(clear: boolean): void {
    this.setViews(false, null); // Tiho or the site off, another channel or page
    this.observer?.disconnect();
    this.observer = null;
    this.list?.removeEventListener('click', this.onClick, true);
    this.list?.removeEventListener('keydown', this.onKeyDown, true);
    this.list?.removeAttribute(ATTR.list);
    this.listMarked = false;
    // the list holds nothing now; the next store flush says so (scheduled below)
    for (const row of this.live) {
      const st = this.states.get(row);
      if (st) {
        st.tk = '';
        st.tc = '';
      }
      if (clear) this.clearRow(row);
    }
    if (clear) this.states = new WeakMap();
    this.inChat = zeroInChat();
    this.inChatDirty = this.storeDirty = true;
    this.list = null;
    this.live.clear();
    this.byKey.clear();
    this.queue.clear();
    this.retryQueue.length = 0;
    this.dirty.clear();
    this.waiting.clear();
    this.held.clear();
    this.rescored.clear();
    this.waveHeads.clear();
    this.waveDirty.clear();
    this.runDirty.clear();
    this.schedule();
  }

  private isRow(n: Node): n is HTMLElement {
    if (n.nodeType !== 1) return false;
    try {
      return (n as Element).matches(this.adapter.rowSelector);
    } catch {
      return false;
    }
  }

  private rowOf(n: Node | null): HTMLElement | null {
    const list = this.list;
    let cur: Node | null = n;
    while (cur && cur.parentNode !== list) cur = cur.parentNode;
    return cur && this.isRow(cur) ? cur : null;
  }

  private onMutations = (records: MutationRecord[]): void => {
    const t0 = performance.now();
    const list = this.list;
    if (!list) return;
    const marked = this.listMarked;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i]!;
      if (rec.type === 'childList' && rec.target === list) {
        const added = rec.addedNodes;
        for (let j = 0; j < added.length; j++) {
          const n = added[j]!;
          if (this.isRow(n)) this.queue.add(n);
          else if (marked && n.nodeType === 1) (n as Element).setAttribute(ATTR.action, ''); // not a row: never hide
        }
        const removed = rec.removedNodes;
        let regroup = false;
        for (let j = 0; j < removed.length; j++) {
          const n = removed[j]!;
          if (n.nodeType === 1 && this.onRemoved(n as HTMLElement)) regroup = true;
        }
        // a pill run lost a row, or two runs now touch: re-count around the gap
        const near = regroup ? (rec.nextSibling ?? rec.previousSibling) : null;
        if (near && near.nodeType === 1) this.runDirty.add(near as Element);
      } else {
        // subtree change inside a row (only when adapter.observeSubtree)
        const row = this.rowOf(rec.target);
        if (row && row.isConnected) this.queue.add(row);
      }
    }
    this.schedule();
    this.account(t0, 0);
  };

  /** Forget a removed row; true when it took space (pill runs around it may change). */
  private onRemoved(n: HTMLElement): boolean {
    if (!this.live.delete(n)) {
      this.queue.delete(n);
      return false;
    }
    const st = this.states.get(n);
    if (!st) return false;
    this.untally(st);
    if (this.byKey.get(st.key) === n) this.byKey.delete(st.key);
    if (st.deadline) {
      st.deadline = 0;
      this.held.delete(n);
    }
    return st.vis !== 0;
  }

  // Show hidden and Solo show rows as they are: clicks and keys are the page's
  // (a click on a username in a peeked folded row must not open its run for good).
  private onClick = (e: Event): void => {
    if (this.peek || this.solo) return;
    const t = e.target as Element | null;
    const row = t && typeof t.closest === 'function' ? t.closest(`${COLLAPSED}:not([${ATTR.open}])`) : null;
    if (row && row.parentElement === this.list) this.openPill(row, e);
  };

  /** Enter or Space on the focused pill (the run's last row, a button: see markRun) opens it like a click. */
  private onKeyDown = (e: KeyboardEvent): void => {
    if ((e.key !== 'Enter' && e.key !== ' ') || this.peek || this.solo) return;
    const row = e.target as Element | null;
    if (row && row.parentElement === this.list && row.hasAttribute(ATTR.run) && !row.hasAttribute(ATTR.open)) this.openPill(row, e);
  };

  /**
   * The pill stands for its whole run (it is drawn by the run's last row):
   * expand every collapsed row of it; rows taking no space stay hidden. The
   * attribute shows them now, the next frame settles their verdicts and runs.
   */
  private openPill(row: Element, e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    this.revealRun(row, 'previousElementSibling');
    this.revealRun(row.nextElementSibling, 'nextElementSibling');
    this.schedule();
  }

  private revealRun(from: Element | null, step: 'previousElementSibling' | 'nextElementSibling'): void {
    for (let r = from; r; r = r[step]) {
      const v = visClass(r);
      if (v === 2) return;
      if (v === 0) continue;
      r.setAttribute(ATTR.open, '');
      const st = this.states.get(r);
      this.markRun(r, st, 0); // no longer a pill (nor a button)
      if (st) {
        st.revealed = true;
        this.dirty.add(r as HTMLElement);
      }
    }
  }

  // ───────────────────────────── frame loop ─────────────────────────────

  private schedule(): void {
    if (this.scheduled || !this.running) return;
    this.scheduled = true;
    this.scheduledAt = performance.now();
    this.rafId = this.raf(this.frame);
    // rAF does not fire in hidden documents; keep processing (throttled) anyway.
    // (Visible documents need no per-frame timer: the 1 s tick is the watchdog.)
    if (this.doc.visibilityState === 'hidden') this.fallbackId = setTimeout(this.frame, 50);
  }

  private cancelFrame(): void {
    if (!this.scheduled) return;
    this.scheduled = false;
    this.caf(this.rafId);
    if (this.fallbackId) clearTimeout(this.fallbackId);
    this.fallbackId = 0;
  }

  private frame = (): void => {
    if (!this.scheduled) return;
    this.cancelFrame();
    if (!this.running) return;
    const t0 = performance.now();
    this.metrics.frames++;
    const now = this.now();
    this.lastFrameAt = now;
    try {
      this.runFrame(now);
    } catch (e) {
      // never leave the chat hidden because of a bug: fail open
      this.failOpen = true;
      this.syncListMark();
      console.warn('[tiho] runtime error, filtering paused for new rows', e);
    }
    this.account(t0, 1);
  };

  private runFrame(now: number): void {
    if (this.resolveTimer) {
      clearTimeout(this.resolveTimer);
      this.resolveTimer = 0;
    }
    // READ
    if (this.queue.size) {
      for (const row of this.queue) this.process(row, now);
      this.queue.clear();
      if (this.retryQueue.length) {
        for (const r of this.retryQueue) this.queue.add(r);
        this.retryQueue.length = 0;
      }
    }
    // RESOLVE
    if (this.resolvedIds.length) this.resolve(this.resolvedIds, true, now);
    if (this.failedIds.length) this.resolve(this.failedIds, false, now);
    if (this.rescored.size) this.rescore();
    if (this.held.size && now >= this.nextDeadline) this.expireHolds(now);

    // WRITE
    if (this.dirty.size) {
      for (const row of this.dirty) {
        const st = this.states.get(row);
        if (st && row.isConnected) this.writeRow(row, st);
      }
      this.dirty.clear();
    }
    if (this.waveDirty.size) this.writeWaveHeads(now);
    if (this.runDirty.size) this.writeRuns();

    // FLUSH
    this.classifier?.flush();
    if (this.storeDirty && now - this.lastStoreAt >= this.storeIntervalMs) this.flushStore(now);
    else if (this.storeDirty) this.scheduleLater(this.storeIntervalMs);
    if (this.queue.size) this.schedule(); // retries
    this.primed = true;
    this.syncListMark(); // after the first pass over pre-existing rows
  }

  private scheduleLater(ms: number): void {
    if (this.laterTimer) return;
    this.laterTimer = setTimeout(() => {
      this.laterTimer = 0;
      this.schedule();
    }, ms);
  }

  private account(t0: number, kind: 0 | 1 | 2): void {
    const dt = performance.now() - t0;
    const m = this.metrics;
    m.split[kind] += dt;
    m.mainMs += dt;
    m.slices++;
    if (dt > m.maxSliceMs) m.maxSliceMs = dt;
  }

  // ───────────────────────────── read phase ─────────────────────────────

  private process(row: HTMLElement, now: number): void {
    if (!row.isConnected) return;
    let msg: ChatMessage | null = null;
    try {
      msg = this.adapter.extract(row);
    } catch {
      this.metrics.extractErrors++;
    }
    const prev = this.states.get(row);
    if (!msg) {
      if (prev) {
        this.forget(row, prev);
        this.clearRow(row);
        row.setAttribute(ATTR.action, '');
        if (prev.vis !== 2) this.runDirty.add(row);
        return;
      }
      // Not a message — or not hydrated yet (content rendered after insertion):
      // retry on the next two frames (still invisible meanwhile), then mark it
      // seen (data-tiho-a="") so it is never hidden.
      const n = this.retries.get(row) ?? 0;
      if (n < 2) {
        this.retries.set(row, n + 1);
        this.retryQueue.push(row);
      } else row.setAttribute(ATTR.action, '');
      return;
    }
    if (prev) {
      if (prev.key === msg.key && prev.text === msg.text) {
        // same message re-added / no-op content change
        this.live.add(row);
        this.byKey.set(prev.key, row);
        this.tally(prev);
        return;
      }
      this.forget(row, prev); // recycled node: new message in an old row
    }

    // Our attributes always include data-tiho-a: one read tells whether the
    // node carries any (recycled row) — fresh rows skip six more reads.
    const a0 = row.getAttribute(ATTR.action);
    const known = this.recall(row, msg);
    const norm = known ? known.norm : normalize(msg.text);
    const rule = this.rules.evaluate(msg, norm, now, known ? !!(known.rule.sig & Sig.DUPLICATE) : undefined);
    const st: RowState = {
      key: msg.key,
      text: msg.text,
      msg,
      norm,
      rule,
      wave: null,
      scores: null,
      model: '',
      verdict: null,
      final: false,
      waiting: false,
      viaModel: false,
      deadline: 0,
      t0: now,
      tk: '',
      tc: '',
      loggedFiltered: false,
      loggedQuestion: false,
      vibed: false,
      revealed: false,
      a: a0 ?? '',
      c: a0 === null ? '' : (row.getAttribute(ATTR.category) ?? ''),
      r: a0 === null ? '' : (row.getAttribute(ATTR.reason) ?? ''),
      wh: 0,
      whAt: 0,
      wm: a0 !== null && row.hasAttribute(ATTR.waveMember),
      run: 0,
      rm: 0,
      runAt: 0,
      // a fresh row (no attributes) takes space like a visible one; a recycled one may have been a pill
      vis: a0 === null ? 2 : -1,
    };
    if (a0 !== null) {
      if (row.hasAttribute(ATTR.waveHead)) row.removeAttribute(ATTR.waveHead);
      if (row.hasAttribute(ATTR.open)) row.removeAttribute(ATTR.open);
      this.markRun(row, undefined, 0);
    }
    this.states.set(row, st);
    this.live.add(row);
    this.byKey.set(msg.key, row);
    this.recent.set(msg.key, st);
    if (known) this.restore(row, st, known, now);
    else {
      this.seen++;
      this.secCount++;
      this.metrics.msgs++;
      this.storeDirty = true;
      if (norm && rule.user !== 'block' && rule.user !== 'allow') {
        const hit = this.waves.observe(norm, msg.authorId || msg.author, msg.key, now, msg.text, this.headAlive);
        if (hit) this.onWave(row, st, hit);
      }
    }

    const ctx = this.ctx;
    if (!needsModel(rule)) {
      this.metrics.decided.rule++;
      this.setVerdict(row, st, decide(null, rule, st.wave, ctx, 'rule'), true, now);
      return;
    }
    const cl = this.classifier;
    // a known message keeps its scores, even once out of the cache, while their model is loaded
    const cached = (cl && norm ? cl.lookup(norm) : undefined) ?? (known && known.model === this.model ? known.scores : null);
    if (cached) {
      st.scores = cached;
      st.model = this.model;
      this.metrics.decided.cache++;
      this.setVerdict(row, st, decide(cached, rule, st.wave, ctx, st.viaModel ? 'model' : 'cache'), true, now);
      return;
    }
    if (cl && norm && cl.available) {
      this.ask(cl, row, st);
      if (known && known.scores && known.verdict) {
        // Scored by the model loaded before: like the rows on screen when it
        // changed (rescoreAll), it keeps its verdict until the new scores land.
        st.scores = known.scores;
        st.model = known.model;
        this.setVerdict(row, st, known.verdict, false, now);
        return;
      }
      const waveMember = st.wave && st.wave.role === 'member' && ctx.collapseWaves;
      if (this.holdOn && !rule.protect && !rule.user && !waveMember) {
        st.deadline = now + this.settings.holdMs;
        this.held.add(row);
        this.armHold(st.deadline, now);
        this.dirty.add(row);
      } else {
        this.setVerdict(row, st, this.provisional(st), false, now);
      }
      return;
    }
    this.metrics.decided.fallback++;
    this.setVerdict(row, st, decide(null, rule, st.wave, ctx, 'rule'), true, now);
  }

  /**
   * What was decided about this message in another node, or null when it is
   * new. The other node, if still tracked, stops standing for it.
   */
  private recall(row: HTMLElement, msg: ChatMessage): RowState | null {
    const known = this.recent.peek(msg.key);
    if (!known || known.text !== msg.text) return null;
    const old = this.byKey.get(msg.key);
    if (old && old !== row) {
      // the list re-rendered and the old node is not gone yet
      const st = this.states.get(old);
      if (st) this.untally(st);
      this.live.delete(old);
      this.held.delete(old);
      this.states.delete(old);
    }
    // a late score for the old node must not decide (and count) it again
    known.waiting = false;
    known.deadline = 0;
    return known;
  }

  /** Carry a known message's verdict bookkeeping over to its new node (st). */
  private restore(row: HTMLElement, st: RowState, known: RowState, now: number): void {
    st.wave = known.wave;
    st.viaModel = known.viaModel;
    st.t0 = 0; // its latency was measured the first time
    st.loggedFiltered = known.loggedFiltered;
    st.loggedQuestion = known.loggedQuestion;
    st.vibed = known.vibed;
    st.revealed = known.revealed;
    if (st.revealed) row.setAttribute(ATTR.open, '');
    const w = st.wave;
    if (w && w.role === 'head') {
      // the counter it showed; a wave still running updates it
      if (known.wh) {
        row.setAttribute(ATTR.waveHead, String(known.wh));
        st.wh = known.wh;
        st.whAt = now;
      }
      if (!this.waveHeads.has(w.id)) this.waveHeads.set(w.id, st.key);
      this.waveDirty.add(w.id);
    }
  }

  /** Ask the classifier for a row's scores; resolve() decides the row when they land. */
  private ask(cl: ClassifierClient, row: HTMLElement, st: RowState): void {
    cl.request(st.norm, cleanForModel(st.msg.text));
    const w = this.waiting.get(st.norm);
    if (w) w.push(row);
    else this.waiting.set(st.norm, [row]);
    st.waiting = true;
  }

  private headAlive = (key: string): boolean => {
    const r = this.byKey.get(key);
    return !!r && r.isConnected;
  };

  private forget(row: HTMLElement, st: RowState): void {
    this.untally(st);
    if (this.byKey.get(st.key) === row) this.byKey.delete(st.key);
    if (st.deadline) this.held.delete(row);
    st.deadline = 0;
    st.waiting = false;
    this.states.delete(row);
  }

  private provisional(st: RowState): Verdict {
    return decide(null, { sig: 0, reason: '', protect: st.rule.protect, user: st.rule.user }, st.wave, this.ctx, 'rule');
  }

  private onWave(row: HTMLElement, st: RowState, hit: WaveHit): void {
    st.wave = hit;
    this.waveHeads.set(hit.id, hit.headKey);
    this.waveDirty.add(hit.id);
    this.wavesDirty = true;
    if (hit.retro) {
      for (const k of hit.retro) {
        const r = this.byKey.get(k);
        const s = r && this.states.get(r);
        if (!r || !s || s === st) continue;
        s.wave = { ...hit, role: 'member', retro: undefined };
        this.redecide(r, s);
      }
    }
    const headRow = this.byKey.get(hit.headKey);
    if (headRow && headRow !== row) {
      const hs = this.states.get(headRow);
      if (hs && (!hs.wave || hs.wave.id !== hit.id || hs.wave.role !== 'head')) {
        hs.wave = { ...hit, role: 'head', retro: undefined };
        this.redecide(headRow, hs);
      }
    }
  }

  /** Recompute a row's verdict from what we know (scores / rules / wave). */
  private redecide(row: HTMLElement, st: RowState): void {
    if (!st.verdict) return; // held: decided when scores land / hold expires
    const now = this.now();
    let v: Verdict;
    if (st.scores) v = decide(st.scores, st.rule, st.wave, this.ctx, st.viaModel ? 'model' : 'cache');
    else if (st.waiting) v = this.provisional(st);
    else v = decide(null, st.rule, st.wave, this.ctx, 'rule');
    this.setVerdict(row, st, v, st.final, now);
  }

  // ───────────────────────────── resolve ─────────────────────────────

  private resolve(ids: string[], ok: boolean, now: number): void {
    const cl = this.classifier;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const rows = this.waiting.get(id);
      if (!rows) continue;
      this.waiting.delete(id);
      const scores = ok && cl ? (cl.cache.peek(id) ?? null) : null;
      for (const row of rows) {
        const st = this.states.get(row);
        if (!st || st.norm !== id || !st.waiting) continue;
        st.waiting = false;
        if (st.deadline) {
          st.deadline = 0;
          this.held.delete(row);
        }
        st.scores = scores;
        st.model = this.model;
        st.viaModel = !!scores;
        if (scores) this.metrics.decided.model++;
        else this.metrics.decided.fallback++;
        const v = scores ? decide(scores, st.rule, st.wave, this.ctx, 'model') : decide(null, st.rule, st.wave, this.ctx, 'rule');
        this.setVerdict(row, st, v, true, now);
      }
    }
    ids.length = 0;
    if (!this.held.size && this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = 0;
      this.nextDeadline = Infinity;
    }
  }

  /**
   * Re-decide live rows showing a text the Tiho Engine just answered. The
   * answer rides on the cached score vector (ScoreVector.engine); rows still
   * waiting for scores pick it up in resolve().
   */
  private rescore(): void {
    const ids = this.rescored;
    const cl = this.classifier;
    for (const row of this.live) {
      const st = this.states.get(row);
      if (!st || !st.scores || !ids.has(st.norm)) continue;
      // re-requested after an eviction or a model switch: the vector that has the answer
      const answered = cl?.cache.peek(st.norm);
      if (answered) {
        st.scores = answered;
        st.model = this.model;
      }
      this.redecide(row, st);
    }
    ids.clear();
  }

  private armHold(deadline: number, now: number): void {
    if (deadline >= this.nextDeadline && this.holdTimer) return;
    this.nextDeadline = Math.min(this.nextDeadline, deadline);
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(
      () => {
        this.holdTimer = 0;
        this.schedule();
      },
      Math.max(0, this.nextDeadline - now) + 2,
    );
  }

  private expireHolds(now: number): void {
    let next = Infinity;
    for (const row of this.held) {
      const st = this.states.get(row);
      if (!st || !st.deadline) {
        this.held.delete(row);
        continue;
      }
      if (st.deadline <= now) {
        st.deadline = 0;
        this.held.delete(row);
        this.metrics.decided.timeout++;
        this.setVerdict(row, st, this.provisional(st), false, now);
      } else if (st.deadline < next) next = st.deadline;
    }
    this.nextDeadline = next;
    if (next !== Infinity) this.armHold(next, now);
  }

  // ───────────────────────────── verdict bookkeeping ─────────────────────────────

  private setVerdict(row: HTMLElement, st: RowState, v: Verdict, final: boolean, now: number): void {
    st.verdict = v;
    st.final = final;
    const cat = v.category;
    if (final) {
      const m = this.metrics;
      if (st.t0) {
        const lat = now - st.t0;
        m.lat[m.latN++ % LAT_RING] = lat;
        if (st.viaModel) m.modelLat[m.modelLatN++ % LAT_RING] = lat;
        st.t0 = 0;
      }
      const filt = v.action === 'hide' || v.action === 'collapse';
      const waveMember = !!(st.wave && st.wave.role === 'member' && v.action === 'collapse');
      if (filt && !st.loggedFiltered && !waveMember) {
        st.loggedFiltered = true;
        this.pushLog(this.newFiltered, st, v, 200);
      }
      if (cat === 'question' && !st.loggedQuestion) {
        st.loggedQuestion = true;
        this.pushLog(this.newQuestions, st, v, 100);
      }
      if (!st.vibed) {
        st.vibed = true;
        this.vibeN++;
        if (cat === 'positive') this.vibePos++;
        else if (cat === 'negative' || cat === 'toxic') this.vibeNeg++;
      }
    }
    this.dirty.add(row);
    this.onDecision?.(row, v, final);
  }

  private pushLog(buf: LogEntry[], st: RowState, v: Verdict, cap: number): void {
    const m = st.msg;
    buf.push({
      msg: { key: m.key, author: m.author, text: m.text, ts: m.ts, platform: m.platform, channel: m.channel },
      verdict: v,
    });
    if (buf.length > cap) buf.shift();
    this.storeDirty = true;
  }

  // ───────────────────────────── write phase ─────────────────────────────

  private writeRow(row: HTMLElement, st: RowState): void {
    const v = st.verdict;
    let a: string;
    let c = '';
    let r = '';
    if (v) {
      a = v.action;
      c = v.category;
      r = v.reason;
    } else if (st.deadline) {
      // Held: already invisible via the list rule while it has no verdict
      // attribute — skip the write (saves one style recalc per held row).
      if (this.listMarked && st.a === '') return;
      a = 'pending';
    } else a = 'show';
    if (st.revealed && a !== 'show' && a !== 'highlight') a = 'show';
    if (st.a !== a) {
      row.setAttribute(ATTR.action, a);
      st.a = a;
    }
    if (st.c !== c) {
      if (c) row.setAttribute(ATTR.category, c);
      else row.removeAttribute(ATTR.category);
      st.c = c;
    }
    if (st.r !== r) {
      if (r) row.setAttribute(ATTR.reason, r);
      else row.removeAttribute(ATTR.reason);
      st.r = r;
    }
    const wm = !!(v && st.wave && st.wave.role === 'member' && a === 'collapse');
    if (st.wm !== wm) {
      if (wm) row.setAttribute(ATTR.waveMember, '');
      else row.removeAttribute(ATTR.waveMember);
      st.wm = wm;
    }
    this.tally(st);
    // Pill runs are re-counted once all rows of the frame are written
    // (writeRuns). A row at the bottom that is not and was not collapsed
    // cannot change any run: skip it (the common case).
    const vis = a === 'hide' || wm ? 0 : a === 'collapse' ? 1 : 2;
    if (st.vis !== vis) {
      if (vis === 1 || st.vis === 1 || st.vis === -1 || row.nextElementSibling) this.runDirty.add(row);
      st.vis = vis;
    }
    if (vis !== 1 && st.rm) this.markRun(row, st, 0);
  }

  /**
   * Consecutive collapsed rows (skipping rows that take no space) read as ONE
   * pill, drawn by the run's last row, which carries the run length in
   * data-tiho-run; the run's other rows take no space. For each changed row:
   * start at the nearest collapsed row before it (its prefix count is known)
   * and re-count forward to the end of its run (of both runs, when the row
   * now splits one), moving the mark to the last row. Appending at the
   * bottom is O(1); a change inside a run is O(run).
   */
  private writeRuns(): void {
    const stamp = ++this.runStamp;
    const list = this.list;
    for (const row of this.runDirty) {
      // gone, or already covered by an earlier re-count in this pass
      if (row.parentElement !== list || this.states.get(row)?.runAt === stamp) continue;
      let from: Element = row;
      let n = 0;
      for (let s = row.previousElementSibling; s; s = s.previousElementSibling) {
        const v = visClass(s);
        if (v === 0) continue;
        if (v === 1) {
          from = s;
          n = (this.states.get(s)?.run || 1) - 1;
        }
        break;
      }
      let last: Element | null = null;
      for (let r: Element | null = from; r; r = r.nextElementSibling) {
        const v = visClass(r);
        if (v === 2) {
          if (last) this.markRun(last, this.states.get(last), n);
          last = null;
          if (r !== row) break; // the run ends here
          n = 0; // the changed row itself splits the run: re-count the part after it
          continue;
        }
        const rs = this.states.get(r);
        if (rs) {
          rs.runAt = stamp;
          rs.run = v === 1 ? n + 1 : 0;
        }
        if (v === 0) continue;
        n++;
        if (last) this.markRun(last, this.states.get(last), 0);
        last = r;
      }
      if (last) this.markRun(last, this.states.get(last), n); // the run ends the list
    }
    this.runDirty.clear();
  }

  /**
   * Move a run mark onto (n > 0) or off (0) a row. The marked row is the pill,
   * so it is also a button for the keyboard (focusable, named "3 hidden
   * messages, show"; Enter or Space opens it, see onKeyDown). Chat rows have
   * no tabindex, role or aria-label of their own, so removing ours is safe.
   */
  private markRun(row: Element, st: RowState | undefined, n: number): void {
    if (st ? st.rm === n : !n && !row.hasAttribute(ATTR.run)) return;
    if (n) {
      row.setAttribute(ATTR.run, String(n));
      row.setAttribute('tabindex', '0');
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', pillLabel(n));
    } else {
      row.removeAttribute(ATTR.run);
      row.removeAttribute('tabindex');
      row.removeAttribute('role');
      row.removeAttribute('aria-label');
    }
    if (st) st.rm = n;
  }

  private writeWaveHeads(now: number): void {
    let later = false;
    for (const id of this.waveDirty) {
      const key = this.waveHeads.get(id);
      const row = key ? this.byKey.get(key) : undefined;
      const st = row && this.states.get(row);
      if (!row || !st || !st.wave || st.wave.id !== id || st.wave.role !== 'head') {
        this.waveDirty.delete(id);
        continue;
      }
      const n = this.waves.countOf(id);
      if (n < 2 || n === st.wh) {
        this.waveDirty.delete(id);
        continue;
      }
      // the counter text relayouts the head row: ≤ 4 updates/s per wave
      if (st.wh && now - st.whAt < WAVE_COUNTER_MS) {
        later = true;
        continue;
      }
      row.setAttribute(ATTR.waveHead, String(n));
      st.wh = n;
      st.whAt = now;
      this.waveDirty.delete(id);
    }
    if (later) this.scheduleLater(WAVE_COUNTER_MS);
  }

  private clearRow(row: HTMLElement): void {
    row.removeAttribute(ATTR.action);
    row.removeAttribute(ATTR.category);
    row.removeAttribute(ATTR.reason);
    row.removeAttribute(ATTR.waveHead);
    row.removeAttribute(ATTR.waveMember);
    row.removeAttribute(ATTR.open);
    this.markRun(row, undefined, 0);
  }

  // ───────────────────────────── in chat now ─────────────────────────────

  /**
   * Move inChat from what a row added so far to what the attributes written
   * on it say now (its verdict's category; shown, hidden, folded, or folded
   * into a wave head), in O(1). Every write of a live row's (a, c, wm) ends
   * here and every row leaving `live` is untallied, so the counters always
   * equal a recount of the list.
   */
  private tally(st: RowState): void {
    const c = st.c as Category | '';
    const k: Tally = !c ? '' : st.wm ? 'wave' : st.a === 'hide' ? 'hidden' : st.a === 'collapse' ? 'folded' : 'shown';
    this.contribute(st, k, c);
  }

  private untally(st: RowState): void {
    this.contribute(st, '', '');
  }

  private contribute(st: RowState, k: Tally, c: Category | ''): void {
    if (st.tk === k && st.tc === c) return;
    this.count(st.tk, st.tc, -1);
    this.count(k, c, 1);
    st.tk = k;
    st.tc = c;
    this.inChatDirty = this.storeDirty = true;
  }

  private count(k: Tally, c: Category | '', d: number): void {
    if (!k) return;
    const n = this.inChat;
    n.rows += d;
    if (k === 'wave') {
      n.inWaves += d;
      return;
    }
    n.byCat[c as Category] += d;
    if (k === 'hidden') n.hidden += d;
    else if (k === 'folded') n.folded += d;
  }

  // ───────────────────────────── store ─────────────────────────────

  private flushStore(now: number): void {
    this.lastStoreAt = now;
    this.storeDirty = false;
    const s = this.store;
    const nq = this.newQuestions;
    const nf = this.newFiltered;
    this.newQuestions = [];
    this.newFiltered = [];
    const wavesDirty = this.wavesDirty;
    this.wavesDirty = false;
    const inChat = this.inChatDirty ? { ...this.inChat, byCat: { ...this.inChat.byCat } } : null;
    this.inChatDirty = false;
    batch(() => {
      if (inChat) s.inChat.value = inChat;
      s.seen.value = this.seen;
      if (nq.length) s.questions.value = nq.reverse().concat(s.questions.peek()).slice(0, 100);
      if (nf.length) s.filtered.value = nf.reverse().concat(s.filtered.peek()).slice(0, 200);
      if (wavesDirty) {
        // waves run on this.now; the store is epoch ms, like ChatMessage.ts
        const epoch = Date.now() - now;
        s.waves.value = this.waves.list(now).map((w) => ({ ...w, startedAt: w.startedAt + epoch, lastAt: w.lastAt + epoch }));
      }
    });
  }

  // ───────────────────────────── housekeeping ─────────────────────────────

  private tick(): void {
    if (!this.running) return;
    const t0 = performance.now();
    const now = this.now();
    this.ticks++;

    const loc = this.loc();
    if (loc.href !== this.href) {
      this.href = loc.href;
      if (this.list) {
        let ok = true;
        try {
          ok = this.adapter.matches(loc);
        } catch {
          ok = false;
        }
        if (!ok) this.detach(false);
      }
    }
    if (!this.list || !this.list.isConnected) this.tryAttach();

    if (this.list) {
      try {
        const theme = this.adapter.theme(this.doc);
        if (theme !== this.theme) {
          this.theme = theme;
          this.store.theme.value = theme;
          this.styles.update(this.styleOpts());
        }
        const ch = this.adapter.channel(this.doc);
        if (ch !== this.channel) {
          this.channel = ch;
          this.store.channel.value = ch;
          this.setViews(false, null);
          this.waves.reset();
          this.rules.reset();
          this.recent.clear();
        }
        if (this.ticks % 5 === 1 && this.adapter.viewer) this.rules.setViewer(this.adapter.viewer(this.doc));
      } catch {
        /* adapter best-effort */
      }
    }
    this.ensureBar();
    if (this.waveHeads.size > 64) {
      for (const id of this.waveHeads.keys()) if (!this.waves.isActive(id)) this.waveHeads.delete(id);
    }

    // a frame was requested but rAF never came (occluded / throttled window): run it now
    if (this.scheduled && performance.now() - this.scheduledAt > 500) {
      this.frame();
    }
    // watchdog: rows waiting but frames stalled (e.g. throttled) → show them
    if (this.listMarked && this.queue.size && now - this.lastFrameAt > 1500) {
      this.listMarked = false;
      this.list?.removeAttribute(ATTR.list);
    }

    this.waves.sweep(now);
    this.wavesDirty = true;
    this.storeDirty = true;
    this.classifier?.expire();
    this.holdOn = this.computeHold();

    // rate (1 s buckets) and vibe (5 s buckets)
    this.rateArr.shift();
    this.rateArr.push(this.secCount);
    this.secCount = 0;
    if (this.ticks % 5 === 0) {
      this.vibeArr.shift();
      this.vibeArr.push(this.vibeN ? (this.vibePos - this.vibeNeg) / this.vibeN : 0);
      this.vibePos = this.vibeNeg = this.vibeN = 0;
    }
    const perf = this.perfStats(now);
    batch(() => {
      this.store.rate.value = this.rateArr.slice();
      if (this.ticks % 5 === 0) this.store.vibe.value = this.vibeArr.slice();
      this.store.perf.value = perf;
    });
    if (this.onReport && this.list && this.ticks % 2 === 0) {
      this.onReport({ stats: { ...perf, platform: this.adapter.platform, channel: this.channel } });
    }
    this.schedule();
    this.account(t0, 2);
  }

  private perfStats(now: number): PerfStats {
    const m = this.metrics;
    const cl = this.classifier;
    const lp = this.lastPerf;
    const dt = Math.max(0.001, (now - lp.at) / 1000);
    const received = cl ? cl.received : 0;
    const dMsgs = m.msgs - lp.msgs;
    const dMain = m.mainMs - lp.mainMs;
    if (dMsgs > 0) {
      const perMsg = dMain / dMsgs;
      this.mainEwma = this.mainEwma ? this.mainEwma * 0.7 + perMsg * 0.3 : perMsg;
    }
    const pct = percentiles(m.modelLat, m.modelLatN);
    const stats: PerfStats = {
      msgsPerSec: this.rateArr[this.rateArr.length - 1] ?? 0,
      inferPerSec: lp.at ? (received - lp.received) / dt : 0,
      cacheHitRate: cl ? cl.cache.hitRate() : 0,
      p50ms: pct[0],
      p95ms: pct[1],
      queue: cl ? cl.inflight : 0,
      mainMs: this.mainEwma,
    };
    this.lastPerf = { at: now, received, msgs: m.msgs, mainMs: m.mainMs };
    return stats;
  }

  // ───────────────────────────── bar ─────────────────────────────

  private ensureBar(): void {
    if (!this.mountBar || !this.barActions || !this.running) return;
    let anchor: { el: HTMLElement; where: 'before' | 'prepend' } | null = null;
    try {
      anchor = this.adapter.matches(this.loc()) ? this.adapter.barAnchor(this.doc) : null;
    } catch {
      anchor = null;
    }
    if (!anchor) return;
    if (this.barCleanup && this.barAnchor === anchor.el && anchor.el.isConnected) return;
    this.unmountBar();
    try {
      const r = this.mountBar(anchor, this.store, this.barActions);
      this.barCleanup = typeof r === 'function' ? r : () => {};
      this.barAnchor = anchor.el;
    } catch (e) {
      console.warn('[tiho] bar mount failed', e);
      this.mountBar = null;
    }
  }

  private unmountBar(): void {
    const c = this.barCleanup;
    this.barCleanup = null;
    this.barAnchor = null;
    if (c) {
      try {
        c();
      } catch {
        /* ignore */
      }
    }
  }
}
