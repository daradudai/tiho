import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PortRequest, PortResponse } from '../../../src/core/protocol';
import { DEFAULT_SETTINGS, PRESETS, type Settings } from '../../../src/core/settings';
import { Role, type ChatMessage } from '../../../src/core/types';
import type { PlatformAdapter } from '../../../src/platforms/types';
import { ClassifierClient, type ClassifierTransport } from '../../../src/runtime/classifier';
import { HushRuntime } from '../../../src/runtime/engine';

// ───────────────────────── fakes ─────────────────────────

function fakeAdapter(o: { observeSubtree?: boolean; listId?: string } = {}): PlatformAdapter {
  return {
    platform: 'twitch',
    matches: () => true,
    findChatList: (doc) => doc.querySelector(`#${o.listId ?? 'chat'}`),
    rowSelector: '.msg',
    extract(row): ChatMessage | null {
      const d = row.dataset;
      if (!d.key) return null;
      return {
        key: d.key,
        platform: 'twitch',
        channel: 'test',
        author: d.user ?? 'anon',
        roles: Number(d.roles ?? 0),
        text: row.textContent ?? '',
        emotes: Number(d.emotes ?? 0),
        mentions: [],
        isReply: false,
        isFirstMessage: false,
        paid: d.paid === '1',
        ts: 0,
      };
    },
    channel: () => 'test',
    barAnchor: (doc) => ({ el: doc.querySelector('#chat') as HTMLElement, where: 'before' }),
    theme: () => 'dark',
    viewer: () => 'me',
    observeSubtree: o.observeSubtree,
  };
}

class FakePort implements ClassifierTransport {
  sent: PortRequest[] = [];
  private msg: ((m: PortResponse) => void) | null = null;
  private disc: (() => void) | null = null;
  post(m: PortRequest) {
    this.sent.push(m);
  }
  onMessage(cb: (m: PortResponse) => void) {
    this.msg = cb;
  }
  onDisconnect(cb: () => void) {
    this.disc = cb;
  }
  disconnect() {}
  get items() {
    return this.sent.flatMap((r) => r.items);
  }
  /** Answer every pending request with `score(text)`. */
  replyAll(score: (text: string) => number[]) {
    const reqs = this.sent;
    this.sent = [];
    for (const r of reqs)
      this.msg!({
        type: 'scores',
        batchId: r.batchId,
        ids: r.items.map((x) => x.id),
        scores: r.items.map((x) => score(x.text)),
        ms: 3,
        backend: 'wasm',
      });
  }
  status(state: 'ready' | 'loading') {
    this.msg!({ type: 'status', status: { state, backend: 'wasm' } });
  }
  kill() {
    this.disc!();
  }
}

// toxic, spam, scam, noise, question, positive, negative
const TOXIC = [0.97, 0, 0, 0, 0, 0, 0.6];
const CLEAN = [0, 0, 0, 0, 0, 0.1, 0];
const QUESTION = [0, 0, 0, 0, 0.9, 0, 0];
const scorer = (t: string) => (/idiot|trash/i.test(t) ? TOXIC : t.includes('?') ? QUESTION : CLEAN);

let clock = 0;
let seq = 0;
let list: HTMLElement;
let port: FakePort;
let rt: HushRuntime;
let classifier: ClassifierClient;

function setup(o: { settings?: Partial<Settings>; adapter?: PlatformAdapter; model?: boolean | 'none' } = {}) {
  document.body.innerHTML = '<div id="chat"></div>';
  list = document.getElementById('chat')!;
  port = new FakePort();
  const settings = { ...DEFAULT_SETTINGS, ...o.settings };
  classifier = new ClassifierClient(() => port, {
    now: () => clock,
    onScores: (ids) => rt.onScores(ids),
    onFailed: (ids) => rt.onFailed(ids),
    onStatus: (s) => rt.setModelStatus(s),
  });
  rt = new HushRuntime({
    adapter: o.adapter ?? fakeAdapter(),
    settings,
    classifier: o.model === 'none' ? null : classifier,
    now: () => clock,
    raf: () => 1,
    caf: () => {},
    storeIntervalMs: 0,
    tickMs: 3_600_000,
  });
  rt.start();
  if (o.model !== false && o.model !== 'none') {
    classifier.connect();
    port.status('ready');
  }
  rt.flushNow(); // first frame: pre-existing rows done, list marked
}

function row(text: string, o: { user?: string; roles?: number; emotes?: number; paid?: boolean; key?: string } = {}) {
  const el = document.createElement('div');
  el.className = 'msg';
  el.dataset.key = o.key ?? `m${seq++}`;
  el.dataset.user = o.user ?? `user${seq}`;
  if (o.roles) el.dataset.roles = String(o.roles);
  if (o.emotes) el.dataset.emotes = String(o.emotes);
  if (o.paid) el.dataset.paid = '1';
  el.textContent = text;
  list.appendChild(el);
  return el;
}

const settle = () => new Promise((r) => setTimeout(r, 0)); // deliver MutationObserver records
async function frame() {
  await settle();
  rt.flushNow();
}
const A = (el: Element) => el.getAttribute('data-hush-a');
const C = (el: Element) => el.getAttribute('data-hush-c');
/** Invisible while waiting for the model: no verdict attribute under a marked list (or explicit pending). */
const held = (el: Element) =>
  A(el) === 'pending' || (!el.hasAttribute('data-hush-a') && !!el.parentElement?.hasAttribute('data-hush-list'));

beforeEach(() => {
  clock = 1000;
});
afterEach(() => {
  rt?.stop();
});

// ───────────────────────── tests ─────────────────────────

describe('runtime: rules path', () => {
  it('decides rule cases in the first frame without the model', async () => {
    setup();
    const cmd = row('!drop');
    const flood = row('a'.repeat(40));
    await frame();
    expect(C(cmd)).toBe('noise');
    expect(A(cmd)).toBe('show'); // chill: noise → show
    expect(C(flood)).toBe('spam');
    expect(A(flood)).toBe('collapse'); // chill: spam → collapse
    expect(port.items.length).toBe(0);
  });

  it('works rules-only without a classifier', async () => {
    setup({ model: 'none' });
    expect(list.hasAttribute('data-hush-list')).toBe(true); // rows hidden until their first verdict
    const r = row('you are an idiot');
    await settle();
    expect(r.hasAttribute('data-hush-a')).toBe(false); // nothing written in the observer callback
    rt.flushNow();
    expect(A(r)).toBe('show');
    expect(C(r)).toBe('clean');
  });

  it('ignores non-message rows', async () => {
    setup();
    const sys = document.createElement('div');
    sys.className = 'msg';
    sys.textContent = 'Welcome to the chat room!';
    list.appendChild(sys);
    await frame();
    expect(sys.hasAttribute('data-hush-a')).toBe(false); // maybe not hydrated yet: retried for 2 frames
    rt.flushNow();
    rt.flushNow();
    expect(A(sys)).toBe(''); // seen, never hidden
  });

  it('marks non-row children as seen so the list rule never hides them', async () => {
    setup();
    const other = document.createElement('section');
    list.appendChild(other);
    await settle();
    expect(other.getAttribute('data-hush-a')).toBe('');
  });

  it('removes the list mark when disabled or when the preset hides nothing', async () => {
    setup();
    expect(list.hasAttribute('data-hush-list')).toBe(true);
    rt.setSettings({ ...DEFAULT_SETTINGS, preset: 'raw', actions: PRESETS.raw });
    expect(list.hasAttribute('data-hush-list')).toBe(false);
    const other = document.createElement('section'); // added while unmarked
    list.appendChild(other);
    await settle();
    expect(other.hasAttribute('data-hush-a')).toBe(false);
    rt.setSettings({ ...DEFAULT_SETTINGS });
    expect(list.hasAttribute('data-hush-list')).toBe(true);
    expect(other.getAttribute('data-hush-a')).toBe(''); // never hidden by the list rule
    rt.stop();
    expect(list.hasAttribute('data-hush-list')).toBe(false);
  });

  it('picks up rows hydrated after insertion', async () => {
    setup();
    const late = document.createElement('div');
    late.className = 'msg';
    list.appendChild(late);
    await frame();
    late.dataset.key = 'late-1';
    late.textContent = '!drop';
    rt.flushNow();
    expect(C(late)).toBe('noise');
  });
});

describe('runtime: model path + hold', () => {
  it('holds ambiguous rows as pending, then applies the model verdict', async () => {
    setup();
    const bad = row('you are trash and an idiot');
    const ok = row('what a great play that was');
    await frame();
    expect(held(bad)).toBe(true);
    expect(held(ok)).toBe(true);
    expect(port.items.map((i) => i.text)).toEqual(['you are trash and an idiot', 'what a great play that was']);
    port.replyAll(scorer);
    rt.flushNow();
    expect(A(bad)).toBe('hide');
    expect(C(bad)).toBe('toxic');
    expect(bad.getAttribute('data-hush-r')).toBe('toxic 0.97');
    expect(A(ok)).toBe('show');
    expect(C(ok)).toBe('clean');
  });

  it('shows after holdMs when the model is slow; a late score still hides', async () => {
    setup();
    const bad = row('such an idiot streamer');
    await frame();
    expect(held(bad)).toBe(true);
    clock += 300; // > holdMs (250)
    rt.flushNow();
    expect(A(bad)).toBe('show');
    port.replyAll(scorer);
    rt.flushNow();
    expect(A(bad)).toBe('hide');
  });

  it('does not hold when the preset cannot hide anything', async () => {
    setup({ settings: { actions: PRESETS.raw, preset: 'raw' } });
    const r = row('such an idiot streamer');
    await frame();
    expect(A(r)).toBe('show');
    port.replyAll(scorer);
    rt.flushNow();
    expect(A(r)).toBe('show');
    expect(C(r)).toBe('toxic');
  });

  it('dedups in-flight texts and serves repeats from the cache', async () => {
    setup();
    const a = row('hello there chat', { user: 'a' });
    const b = row('HELLO there chat', { user: 'b' });
    await frame();
    expect(port.items.length).toBe(1);
    port.replyAll(scorer);
    rt.flushNow();
    expect(A(a)).toBe('show');
    expect(A(b)).toBe('show');
    const c = row('hello there chat', { user: 'c' });
    await frame();
    expect(A(c)).toBe('show');
    expect(C(c)).toBe('clean');
    expect(port.items.length).toBe(0); // cache hit, nothing sent
  });

  it('protected (mod / paid) rows are never held or hidden', async () => {
    setup();
    const mod = row('you idiot', { roles: Role.MOD });
    const paid = row('trash stream lol here is 5 bucks', { paid: true });
    await frame();
    expect(A(mod)).toBe('show');
    expect(A(paid)).toBe('show');
    port.replyAll(scorer);
    rt.flushNow();
    expect(C(mod)).toBe('toxic');
    expect(A(mod)).toBe('show');
    expect(A(paid)).toBe('show');
  });

  it('questions are highlighted and logged in the store', async () => {
    setup();
    const q = row('when is the next stream?');
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    expect(A(q)).toBe('highlight');
    expect(rt.store.questions.value[0]?.msg.text).toBe('when is the next stream?');
    expect(rt.store.counts.value.question).toBe(1);
  });

  it('falls back to rules when the port dies', async () => {
    setup();
    const r = row('this is some text here');
    await frame();
    expect(held(r)).toBe(true);
    port.kill();
    rt.flushNow();
    expect(A(r)).toBe('show');
    expect(C(r)).toBe('clean');
  });
});

describe('runtime: waves', () => {
  it('collapses later members into the first message with a live counter', async () => {
    setup();
    const rows = ['a', 'b', 'c', 'd', 'e'].map((u) => row('KEKW', { user: u, emotes: 1 }));
    await frame();
    const [head, ...members] = rows;
    expect(head!.getAttribute('data-hush-wh')).toBe('5');
    expect(A(head!)).toBe('show');
    // members after the head collapse (b, c retroactively once the 4th user arrives)
    for (const m of members) {
      expect(A(m)).toBe('collapse');
      expect(m.hasAttribute('data-hush-wm')).toBe(true);
    }
    expect(rt.store.waves.value[0]?.count).toBe(5);
  });
});

describe('runtime: DOM churn', () => {
  it('re-evaluates recycled rows (adapter.observeSubtree)', async () => {
    setup({ adapter: fakeAdapter({ observeSubtree: true }) });
    const r = row('!drop');
    await frame();
    expect(C(r)).toBe('noise');
    // node reused for another message
    r.dataset.key = 'recycled-1';
    r.textContent = 'a'.repeat(40);
    await frame();
    expect(C(r)).toBe('spam');
    expect(A(r)).toBe('collapse');
  });

  it('re-attaches when the chat list is replaced', async () => {
    setup();
    const first = row('!drop');
    await frame();
    expect(rt.attached).toBe(true);
    list.remove();
    const fresh = document.createElement('div');
    fresh.id = 'chat';
    document.body.appendChild(fresh);
    list = fresh;
    rt.tickNow();
    expect(rt.attached).toBe(true);
    const r = row('!points');
    await frame();
    expect(C(r)).toBe('noise');
    expect(first.isConnected).toBe(false);
  });

  it('settings changes re-apply verdicts to live rows', async () => {
    setup();
    const bad = row('what an idiot');
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    expect(A(bad)).toBe('hide');
    rt.setSettings({ ...DEFAULT_SETTINGS, preset: 'raw', actions: PRESETS.raw });
    rt.flushNow();
    expect(A(bad)).toBe('show');
    rt.setSettings({ ...DEFAULT_SETTINGS, enabled: false });
    expect(bad.hasAttribute('data-hush-a')).toBe(false);
  });

  it('user rules apply immediately and override presets', async () => {
    setup({ settings: { rules: [{ id: '1', kind: 'word', pattern: 'spoiler', mode: 'block', enabled: true }] } });
    const r = row('SPOILER he dies at the end');
    await frame();
    expect(A(r)).toBe('hide');
    expect(r.getAttribute('data-hush-r')).toBe('blocked: spoiler');
    expect(port.items.length).toBe(0);
  });

  it('reveal(key) and clicking a collapsed pill un-hide rows', async () => {
    setup();
    const a = row('b'.repeat(40), { key: 'x1' });
    const b = row('c'.repeat(40), { key: 'x2' });
    await frame();
    expect(A(a)).toBe('collapse');
    // consecutive pills read as one: the run's last row carries its length
    expect(a.hasAttribute('data-hush-run')).toBe(false);
    expect(b.getAttribute('data-hush-run')).toBe('2');
    expect(rt.reveal('x1')).toBe(true);
    expect(A(a)).toBe('show');
    expect(a.hasAttribute('data-hush-open')).toBe(true);
    expect(b.getAttribute('data-hush-run')).toBe('1');
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(b.hasAttribute('data-hush-open')).toBe(true);
  });

  it('fills the store: totals, counts, filtered log, perf', async () => {
    setup();
    row('!drop');
    row('z'.repeat(40));
    row('nice play');
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    const s = rt.store;
    expect(s.totals.value.seen).toBe(3);
    expect(s.totals.value.filtered).toBe(1);
    expect(s.counts.value.noise).toBe(1);
    expect(s.counts.value.spam).toBe(1);
    expect(s.counts.value.clean).toBe(1);
    expect(s.filtered.value[0]?.verdict.category).toBe('spam');
    rt.tickNow();
    expect(s.rate.value.at(-1)).toBe(3);
    expect(rt.metrics.msgs).toBe(3);
  });

  it('never writes inline styles on rows', async () => {
    setup();
    for (let i = 0; i < 50; i++) row(i % 3 ? `message number ${i} here` : 'x'.repeat(30));
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    for (const el of Array.from(list.children)) expect(el.getAttribute('style')).toBeNull();
    expect(document.getElementById('hush-row-style')).not.toBeNull();
  });
});
