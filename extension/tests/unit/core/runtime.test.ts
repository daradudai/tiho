import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortRequest, PortResponse } from '../../../src/core/protocol';
import { DEFAULT_SETTINGS, PRESETS, filterKey, type EngineFilter, type Settings } from '../../../src/core/settings';
import { zeroInChat, type InChat } from '../../../src/core/store';
import { CATEGORIES, Role, type Action, type Category, type ChatMessage } from '../../../src/core/types';
import type { PlatformAdapter } from '../../../src/platforms/types';
import { ClassifierClient, type ClassifierTransport } from '../../../src/runtime/classifier';
import { TihoRuntime } from '../../../src/runtime/engine';

// ───────────────────────── fakes ─────────────────────────

/** The channel the fake page shows (tests change it to navigate). */
let channel = 'test';

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
    channel: () => channel,
    barAnchor: (doc) => ({ el: doc.querySelector('#chat') as HTMLElement, where: 'before' }),
    theme: () => 'dark',
    viewer: () => ['me'],
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
        scores: r.items.map((x) => score(x.text).slice()), // fresh arrays, as over a real Port (engine answers attach to them)
        ms: 3,
        backend: 'wasm',
      });
  }
  status(state: 'ready' | 'loading') {
    this.msg!({ type: 'status', status: { state, backend: 'wasm' } });
  }
  emit(m: PortResponse) {
    this.msg!(m);
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
let rt: TihoRuntime;
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
    onRescored: (ids) => rt.onRescored(ids),
    onStatus: (s) => rt.setModelStatus(s),
  });
  rt = new TihoRuntime({
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
const A = (el: Element) => el.getAttribute('data-tiho-a');
const C = (el: Element) => el.getAttribute('data-tiho-c');
/** Invisible while waiting for the model: no verdict attribute under a marked list (or explicit pending). */
const held = (el: Element) =>
  A(el) === 'pending' || (!el.hasAttribute('data-tiho-a') && !!el.parentElement?.hasAttribute('data-tiho-list'));

beforeEach(() => {
  clock = 1000;
  channel = 'test';
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
    expect(list.hasAttribute('data-tiho-list')).toBe(true); // rows hidden until their first verdict
    const r = row('you are an idiot');
    await settle();
    expect(r.hasAttribute('data-tiho-a')).toBe(false); // nothing written in the observer callback
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
    expect(sys.hasAttribute('data-tiho-a')).toBe(false); // maybe not hydrated yet: retried for 2 frames
    rt.flushNow();
    rt.flushNow();
    expect(A(sys)).toBe(''); // seen, never hidden
  });

  it('marks non-row children as seen so the list rule never hides them', async () => {
    setup();
    const other = document.createElement('section');
    list.appendChild(other);
    await settle();
    expect(other.getAttribute('data-tiho-a')).toBe('');
  });

  it('removes the list mark when disabled or when the preset hides nothing', async () => {
    setup();
    expect(list.hasAttribute('data-tiho-list')).toBe(true);
    rt.setSettings({ ...DEFAULT_SETTINGS, preset: 'raw', actions: PRESETS.raw });
    expect(list.hasAttribute('data-tiho-list')).toBe(false);
    const other = document.createElement('section'); // added while unmarked
    list.appendChild(other);
    await settle();
    expect(other.hasAttribute('data-tiho-a')).toBe(false);
    rt.setSettings({ ...DEFAULT_SETTINGS });
    expect(list.hasAttribute('data-tiho-list')).toBe(true);
    expect(other.getAttribute('data-tiho-a')).toBe(''); // never hidden by the list rule
    rt.stop();
    expect(list.hasAttribute('data-tiho-list')).toBe(false);
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
    expect(bad.getAttribute('data-tiho-r')).toBe('toxic · certain');
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
    expect(mod.getAttribute('data-tiho-r')).toBe('toxic · certain · always shown');
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
    expect(rt.store.inChat.value.byCat.question).toBe(1);
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

describe('runtime: Tiho Engine follow-ups', () => {
  const BACKSEAT: EngineFilter = { id: 'b', question: 'Is this message backseating?', label: 'Backseating', action: 'hide', enabled: true };

  it('a late custom-filter answer re-decides rows already on screen', async () => {
    setup({ settings: { engine: { ...DEFAULT_SETTINGS.engine, enabled: true, filters: [BACKSEAT] } } });
    const a = row('go left there is a ledge', { user: 'a' });
    await frame();
    const [req] = port.sent;
    port.replyAll(scorer);
    rt.flushNow();
    expect(A(a)).toBe('show'); // local model: clean
    const b = row('go left there is a ledge', { user: 'b' }); // same text, decided from the cache
    await frame();
    expect(A(b)).toBe('show');
    expect(rt.store.inChat.value.hidden).toBe(0);

    port.emit({ type: 'engine', batchId: req!.batchId, ids: req!.items.map((x) => x.id), filters: { [filterKey(BACKSEAT)]: [0.91] } });
    rt.flushNow();
    for (const r of [a, b]) {
      expect(A(r)).toBe('hide');
      expect(r.getAttribute('data-tiho-r')).toBe('filter: backseating');
    }
    expect(rt.store.inChat.value.hidden).toBe(2);
    expect(rt.store.filtered.value[0]?.verdict).toMatchObject({ action: 'hide', source: 'engine' });
  });

  it('an answer below the filter threshold leaves the verdict alone', async () => {
    setup({ settings: { engine: { ...DEFAULT_SETTINGS.engine, enabled: true, filters: [BACKSEAT] } } });
    const a = row('nice ledge jump', { user: 'a' });
    await frame();
    const [req] = port.sent;
    port.replyAll(scorer);
    rt.flushNow();
    port.emit({ type: 'engine', batchId: req!.batchId, ids: req!.items.map((x) => x.id), filters: { [filterKey(BACKSEAT)]: [0.12] } });
    rt.flushNow();
    expect(A(a)).toBe('show');
    expect(C(a)).toBe('clean');
  });
});

describe('runtime: waves', () => {
  it('collapses later members into the first message with a live counter', async () => {
    setup();
    const rows = ['a', 'b', 'c', 'd', 'e'].map((u) => row('KEKW', { user: u, emotes: 1 }));
    await frame();
    const [head, ...members] = rows;
    expect(head!.getAttribute('data-tiho-wh')).toBe('5');
    expect(A(head!)).toBe('show');
    // members after the head collapse (b, c retroactively once the 4th user arrives)
    for (const m of members) {
      expect(A(m)).toBe('collapse');
      expect(m.hasAttribute('data-tiho-wm')).toBe(true);
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
    expect(bad.hasAttribute('data-tiho-a')).toBe(false);
  });

  it('user rules apply immediately and override presets', async () => {
    setup({ settings: { rules: [{ id: '1', kind: 'word', pattern: 'spoiler', mode: 'block', enabled: true }] } });
    const r = row('SPOILER he dies at the end');
    await frame();
    expect(A(r)).toBe('hide');
    expect(r.getAttribute('data-tiho-r')).toBe('blocked: spoiler');
    expect(port.items.length).toBe(0);
  });

  it('reveal(key) and clicking a collapsed pill un-hide rows', async () => {
    setup();
    const a = row('b'.repeat(40), { key: 'x1' });
    const b = row('c'.repeat(40), { key: 'x2' });
    await frame();
    expect(A(a)).toBe('collapse');
    // consecutive pills read as one: the run's last row carries its length
    expect(a.hasAttribute('data-tiho-run')).toBe(false);
    expect(b.getAttribute('data-tiho-run')).toBe('2');
    expect(rt.reveal('x1')).toBe(true);
    expect(A(a)).toBe('show');
    expect(a.hasAttribute('data-tiho-open')).toBe(true);
    expect(b.getAttribute('data-tiho-run')).toBe('1');
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(b.hasAttribute('data-tiho-open')).toBe(true);
  });

  it('the row that draws a pill is a button named after its run; the attributes follow the mark', async () => {
    setup();
    const button = (el: Element) => ['tabindex', 'role', 'aria-label'].map((n) => el.getAttribute(n));
    const a = row('b'.repeat(40));
    const b = row('c'.repeat(40));
    await frame();
    expect(button(a)).toEqual([null, null, null]);
    expect(button(b)).toEqual(['0', 'button', '2 hidden messages, show']);
    const c = row('d'.repeat(40));
    await frame();
    expect(button(b)).toEqual([null, null, null]);
    expect(button(c)).toEqual(['0', 'button', '3 hidden messages, show']);

    // written only when the mark changes, not every frame
    const mo = new MutationObserver(() => {});
    mo.observe(list, { subtree: true, attributes: true, attributeFilter: ['tabindex', 'role', 'aria-label'] });
    row('nice play here'); // ends the run: the mark stays where it is
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    expect(mo.takeRecords()).toHaveLength(0);
    mo.disconnect();

    rt.stop();
    expect(button(c)).toEqual([null, null, null]);
  });

  it('fills the store: in chat now, filtered log, perf', async () => {
    setup();
    row('!drop');
    row('z'.repeat(40));
    row('nice play');
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    const s = rt.store;
    expect(s.seen.value).toBe(3);
    expect(s.inChat.value).toMatchObject({ rows: 3, hidden: 0, folded: 1, inWaves: 0 });
    expect(s.inChat.value.byCat).toMatchObject({ noise: 1, spam: 1, clean: 1 });
    expect(s.filtered.value[0]?.verdict.category).toBe('spam');
    rt.tickNow();
    expect(s.rate.value.at(-1)).toBe(3);
    expect(rt.metrics.msgs).toBe(3);
  });

  it('a pill is a button: Enter or Space opens its run, like a click', async () => {
    setup();
    const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const a = row('b'.repeat(40));
    const b = row('c'.repeat(40));
    row('!drop'); // noise, shown: ends the run
    const c = row('d'.repeat(40));
    await frame();
    expect(key(a, 'Enter')).toBe(true); // not the pill: left to the page
    expect(key(b, 'x')).toBe(true);
    expect(a.hasAttribute('data-tiho-open')).toBe(false);
    expect(key(b, 'Enter')).toBe(false); // handled
    expect(a.hasAttribute('data-tiho-open')).toBe(true);
    expect(b.hasAttribute('data-tiho-open')).toBe(true);
    expect(b.hasAttribute('tabindex')).toBe(false); // no longer a button, at once
    expect(c.hasAttribute('data-tiho-open')).toBe(false); // another run
    expect(key(c, ' ')).toBe(false);
    expect(c.hasAttribute('data-tiho-open')).toBe(true);
    await frame();
    for (const r of [a, b, c]) expect(A(r)).toBe('show');
  });

  it('never writes inline styles on rows', async () => {
    setup();
    for (let i = 0; i < 50; i++) row(i % 3 ? `message number ${i} here` : 'x'.repeat(30));
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    for (const el of Array.from(list.children)) expect(el.getAttribute('style')).toBeNull();
    expect(document.getElementById('tiho-row-style')).not.toBeNull();
  });
});

describe('runtime: a message seen again', () => {
  /** A new node for the same message (Kick re-mount, YouTube re-render). */
  function copyOf(el: HTMLElement): HTMLElement {
    const fresh = document.createElement('div');
    fresh.className = 'msg';
    for (const [k, v] of Object.entries(el.dataset)) if (!k.startsWith('tiho')) fresh.dataset[k] = v;
    fresh.textContent = el.textContent;
    return fresh;
  }

  /** The same message in a new node where the old one was. */
  function remount(el: HTMLElement): HTMLElement {
    const fresh = copyOf(el);
    el.replaceWith(fresh);
    return fresh;
  }

  /** Decided and scrolled away (Kick unmounts it); returns the node it comes back in. */
  async function scrolledAway(text: string): Promise<HTMLElement> {
    const el = row(text, { user: 'eve' });
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    const back = copyOf(el);
    el.remove();
    await frame();
    return back;
  }

  it('keeps its scores while their model is loaded, even once out of the cache', async () => {
    setup();
    const back = await scrolledAway('you are trash');
    classifier.cache.clear(); // evicted meanwhile
    list.appendChild(back);
    await frame();
    expect(port.items).toHaveLength(0);
    expect(A(back)).toBe('hide');
  });

  it('after a model switch keeps its verdict while the new model scores it again', async () => {
    setup();
    const ready = (version: string) => port.emit({ type: 'status', status: { state: 'ready', backend: 'wasm', modelId: 'tiho-lite', version } });
    ready('6l');
    const back = await scrolledAway('you are trash');
    ready('3l'); // the other student
    list.appendChild(back);
    await frame();
    expect(port.items.map((x) => x.text)).toEqual(['you are trash']); // asked again, not re-thresholded
    expect(A(back)).toBe('hide'); // meanwhile the verdict it had, never held
    port.replyAll(() => CLEAN); // the new model disagrees
    rt.flushNow();
    expect(A(back)).toBe('show');
    expect(rt.store.seen.value).toBe(1);
    expect(rt.store.inChat.value).toMatchObject({ rows: 1, hidden: 0 });
  });

  it('in a new node keeps its verdict: no "repeat", not counted, logged or classified again', async () => {
    setup();
    const ask = row('is the boss fight next?', { user: 'bob' });
    const bad = row('you are trash', { user: 'eve' });
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    expect(A(ask)).toBe('highlight');
    expect(A(bad)).toBe('hide');
    const s = rt.store;
    const seen = s.seen.value;

    const ask2 = remount(ask);
    const bad2 = remount(bad);
    row('nice play', { user: 'zed' });
    await frame();
    expect(port.items.map((x) => x.text)).toEqual(['nice play']);
    port.replyAll(scorer);
    rt.flushNow();
    expect(A(ask2)).toBe('highlight');
    expect(C(ask2)).toBe('question');
    expect(A(bad2)).toBe('hide');
    expect(s.seen.value).toBe(seen + 1);
    // the list holds the two new nodes and the new message: nothing counted twice
    expect(s.inChat.value).toMatchObject({ rows: 3, hidden: 1, folded: 0 });
    expect(s.inChat.value.byCat).toMatchObject({ question: 1, toxic: 1, clean: 1 });
    expect(s.filtered.value).toHaveLength(1);
    expect(s.questions.value).toHaveLength(1);
  });

  it('Tiho turned off and on: rows on screen keep their verdicts', async () => {
    setup();
    const ok = row('see you all tomorrow', { user: 'bob' });
    const bad = row('you are trash', { user: 'eve' });
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    rt.setSettings({ ...DEFAULT_SETTINGS, enabled: false });
    expect(ok.hasAttribute('data-tiho-a')).toBe(false);
    rt.setSettings({ ...DEFAULT_SETTINGS });
    rt.flushNow();
    expect(A(ok)).toBe('show');
    expect(ok.hasAttribute('data-tiho-r')).toBe(false);
    expect(A(bad)).toBe('hide');
    expect(rt.store.seen.value).toBe(2);
    expect(rt.store.inChat.value).toMatchObject({ rows: 2, hidden: 1 });
  });

  it('a real repeat by the same author still folds', async () => {
    setup();
    row('see you all tomorrow', { user: 'bob' });
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    const again = row('see you all tomorrow', { user: 'bob' });
    await frame();
    expect(A(again)).toBe('collapse');
    expect(again.getAttribute('data-tiho-r')).toBe('repeat');
  });

  it('a wave head keeps its counter, a row the viewer opened stays open', async () => {
    setup();
    const wave = ['a', 'b', 'c', 'd', 'e'].map((u) => row('KEKW', { user: u, emotes: 1 }));
    row('z'.repeat(40), { key: 'p1' });
    await frame();
    expect(rt.reveal('p1')).toBe(true);
    const head = remount(wave[0]!);
    const member = remount(wave[2]!);
    const opened = remount(list.querySelector<HTMLElement>('[data-key="p1"]')!);
    await frame();
    expect(A(head)).toBe('show');
    expect(head.getAttribute('data-tiho-wh')).toBe('5');
    expect(head.hasAttribute('data-tiho-wm')).toBe(false);
    expect(member.hasAttribute('data-tiho-wm')).toBe(true);
    expect(A(opened)).toBe('show');
    expect(opened.hasAttribute('data-tiho-open')).toBe(true);
    expect(rt.store.seen.value).toBe(6);
  });
});

// ───────────────────────── in chat now ─────────────────────────

/** InChat recounted from the attributes on the list: what the store must always say. */
function recount(): InChat {
  const n = zeroInChat();
  for (const el of Array.from(list.children)) {
    const c = C(el) as Category | null;
    if (!c) continue;
    n.rows++;
    if (el.hasAttribute('data-tiho-wm')) {
      n.inWaves++;
      continue;
    }
    n.byCat[c]++;
    if (A(el) === 'hide') n.hidden++;
    else if (A(el) === 'collapse') n.folded++;
  }
  return n;
}

const inChat = () => rt.store.inChat.value;

/** The same message in a new node where the old one was (Kick re-mounts rows scrolled back into view). */
function remountRow(el: HTMLElement): HTMLElement {
  const fresh = document.createElement('div');
  fresh.className = 'msg';
  for (const [k, v] of Object.entries(el.dataset)) if (!k.startsWith('tiho')) fresh.dataset[k] = v;
  fresh.textContent = el.textContent;
  el.replaceWith(fresh);
  return fresh;
}

describe('runtime: in chat now', () => {
  it('always equals a recount of the list: adds, verdicts, reveals, removals, recycled and re-mounted nodes', async () => {
    setup({ adapter: fakeAdapter({ observeSubtree: true }) });
    let r = 7;
    const rand = (n: number) => (r = (r * 16807) % 2147483647) % n;
    const TEXTS = ['you are trash', 'nice play', 'when is the next stream?', '!drop', 'KEKW', 'b'.repeat(40), 'c'.repeat(40), 'GG', 'that boss fight was wild'];
    const PRESET_IDS = ['raw', 'chill', 'focus', 'questions'] as const;
    let enabled = true;
    for (let step = 0; step < 400; step++) {
      const rows = Array.from(list.children) as HTMLElement[];
      const pick = rows[rand(rows.length || 1)];
      const text = TEXTS[rand(TEXTS.length)]!;
      switch (rand(12)) {
        case 0:
        case 1:
        case 2: // a new message; KEKW from many people makes a wave
          row(text, { user: `u${rand(9)}`, emotes: text === 'KEKW' ? 1 : 0 });
          break;
        case 3: // scrolled out of the list
          pick?.remove();
          break;
        case 4: // a recycled node shows another message
          if (pick) {
            pick.dataset.key = `r${seq++}`;
            pick.textContent = text;
          }
          break;
        case 5: // the same message re-mounted in a new node
          if (pick) remountRow(pick);
          break;
        case 6: // "Show in chat", or a click on a pill
          if (pick && rand(2)) rt.reveal(pick.dataset.key ?? '');
          else pick?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          break;
        case 7: {
          const p = PRESET_IDS[rand(PRESET_IDS.length)]!;
          rt.setSettings({ ...DEFAULT_SETTINGS, preset: p, actions: { ...PRESETS[p] } });
          break;
        }
        case 8: // Tiho off and on again
          enabled = !enabled;
          rt.setSettings({ ...DEFAULT_SETTINGS, enabled });
          break;
        case 9: // holds run out
          clock += 300;
          break;
        case 10: // the node moves (removed and added again)
          if (pick) list.insertBefore(pick, rows[rand(rows.length)]!);
          break;
        case 11: // a new node for the same message while the old one is still there (YouTube re-renders)
          if (pick?.dataset.key) {
            const copy = pick.cloneNode(true) as HTMLElement;
            for (const k of Object.keys(copy.dataset)) if (k.startsWith('tiho')) delete copy.dataset[k];
            for (const n of ['tabindex', 'role', 'aria-label']) copy.removeAttribute(n);
            pick.after(copy);
            await frame();
            pick.remove();
          }
          break;
      }
      await frame();
      if (rand(3) === 0) {
        port.replyAll(scorer);
        rt.flushNow();
      }
      const want = recount();
      expect(inChat(), `step ${step}`).toEqual(want);
      expect(Object.values(want.byCat).reduce((a, b) => a + b, 0) + want.inWaves).toBe(want.rows);
    }
    expect(rt.store.waves.value.length).toBeGreaterThan(0); // waves did form along the way
  });

  it('follows a settings change in the next store flush', async () => {
    setup();
    for (const ch of 'bcdef') row(ch.repeat(40)); // char floods: spam
    for (let i = 0; i < 95; i++) row(i % 10 ? `message number ${i} here` : `you are trash number ${i}`, { user: `u${i}` });
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    expect(inChat()).toMatchObject({ rows: 100, hidden: 10, folded: 5 });
    const hideAll = Object.fromEntries(CATEGORIES.map((c) => [c, 'hide'])) as Record<Category, Action>;
    rt.setSettings({ ...DEFAULT_SETTINGS, preset: 'custom', actions: hideAll });
    rt.flushNow();
    expect(inChat()).toMatchObject({ rows: 100, hidden: 100, folded: 0 });
    rt.setSettings({ ...DEFAULT_SETTINGS, preset: 'custom', actions: { ...hideAll, spam: 'show' } });
    rt.flushNow();
    expect(inChat().byCat.spam).toBe(5);
    expect(inChat().hidden).toBe(95);
  });

  it('reads 0 once Tiho or the site is off (the store is flushed, not frozen), and counts again when back', async () => {
    setup();
    row('you are trash');
    row('nice play');
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    expect(inChat()).toMatchObject({ rows: 2, hidden: 1 });
    for (const off of [{ enabled: false }, { sites: { ...DEFAULT_SETTINGS.sites, twitch: false } }]) {
      rt.setSettings({ ...DEFAULT_SETTINGS, ...off });
      rt.flushNow();
      expect(inChat()).toEqual(zeroInChat());
      rt.setSettings({ ...DEFAULT_SETTINGS });
      rt.flushNow();
      expect(inChat()).toMatchObject({ rows: 2, hidden: 1 });
    }
  });

  it('writes the store only when the list changed', async () => {
    setup();
    row('nice play');
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    const before = inChat();
    rt.tickNow(); // housekeeping marks the store dirty every second
    rt.flushNow();
    expect(inChat()).toBe(before);
  });
});

// ───────────────────────── Show hidden and Solo ─────────────────────────

describe('runtime: Show hidden and Solo', () => {
  const advanced = { uiMode: 'advanced' } as const;
  const css = () => document.getElementById('tiho-row-style')!.textContent!;

  /** A toxic message (hidden), two spam floods (one pill), a question (highlighted), a clean one. */
  async function chat(): Promise<HTMLElement[]> {
    const rows = [row('you are trash'), row('b'.repeat(40)), row('c'.repeat(40)), row('when is the next stream?'), row('nice play')];
    await frame();
    port.replyAll(scorer);
    rt.flushNow();
    return rows;
  }

  it('are a stylesheet swap: nothing is written on rows', async () => {
    setup({ settings: advanced });
    await chat();
    const mo = new MutationObserver(() => {});
    mo.observe(list, { subtree: true, attributes: true });
    const before = css();
    rt.setPeek(true);
    expect(css()).toContain('content:"hidden · " attr(data-tiho-r)');
    rt.setSolo('spam');
    expect(css()).toContain('[data-tiho-c]:not([data-tiho-c="spam"]){display:none!important}');
    rt.setSolo(null);
    expect(css()).toBe(before);
    rt.flushNow();
    expect(mo.takeRecords().filter((m) => m.target !== list)).toHaveLength(0);
    mo.disconnect();
  });

  it('Basic tags hidden rows in plain words', async () => {
    setup();
    await chat();
    rt.setPeek(true);
    expect(rt.store.peek.value).toBe(true);
    expect(css()).toContain('content:"Hidden · insult"');
    expect(css()).not.toContain('attr(data-tiho-r)'); // no reasons, no chips
  });

  it('Solo: Advanced only, while Tiho is on; ends with Basic, Tiho or the site off, another channel', async () => {
    setup();
    await chat();
    rt.setSolo('spam'); // Basic: ignored
    expect(rt.store.solo.value).toBeNull();
    rt.setSettings({ ...DEFAULT_SETTINGS, ...advanced });
    rt.setSolo('spam');
    expect(rt.store.solo.value).toBe('spam');
    rt.setSolo('toxic'); // another one: switches
    expect(rt.store.solo.value).toBe('toxic');
    rt.setSolo('toxic'); // the same again: everything
    expect(rt.store.solo.value).toBeNull();

    const ends: (() => void)[] = [
      () => rt.setSettings({ ...DEFAULT_SETTINGS, uiMode: 'basic' }),
      () => rt.setSettings({ ...DEFAULT_SETTINGS, ...advanced, enabled: false }),
      () => rt.setSettings({ ...DEFAULT_SETTINGS, ...advanced, sites: { ...DEFAULT_SETTINGS.sites, twitch: false } }),
      () => {
        channel = 'someone-else';
        rt.tickNow();
      },
    ];
    for (const end of ends) {
      rt.setSettings({ ...DEFAULT_SETTINGS, ...advanced });
      rt.flushNow();
      rt.setSolo('spam');
      expect(rt.store.solo.value).toBe('spam');
      end();
      expect(rt.store.solo.value).toBeNull();
    }
    rt.setSettings({ ...DEFAULT_SETTINGS, ...advanced, enabled: false });
    rt.setSolo('spam'); // off: ignored
    expect(rt.store.solo.value).toBeNull();
  });

  it('Show hidden: Solo turns it off; it ends with Tiho off or another channel and survives a level or mode change', async () => {
    setup({ settings: advanced });
    await chat();
    rt.setPeek(true);
    rt.setSolo('spam');
    expect(rt.store.peek.value).toBe(false);
    rt.setPeek(true); // and the other way round
    expect([rt.store.peek.value, rt.store.solo.value]).toEqual([true, null]);
    rt.setSettings({ ...DEFAULT_SETTINGS, ...advanced, preset: 'focus', actions: { ...PRESETS.focus } });
    rt.setSettings({ ...DEFAULT_SETTINGS, uiMode: 'basic' });
    expect(rt.store.peek.value).toBe(true);
    rt.setSettings({ ...DEFAULT_SETTINGS, enabled: false });
    expect(rt.store.peek.value).toBe(false);
    rt.setPeek(true); // off: ignored
    expect(rt.store.peek.value).toBe(false);
    rt.setSettings({ ...DEFAULT_SETTINGS });
    rt.flushNow();
    rt.setPeek(true);
    channel = 'someone-else';
    rt.tickNow();
    expect(rt.store.peek.value).toBe(false);
    rt.setPeek(true);
    rt.stop();
    expect(rt.store.peek.value).toBe(false);
  });

  it('leave clicks and Enter on a folded row to the page', async () => {
    setup({ settings: advanced });
    const [, a, b] = await chat();
    expect(b!.getAttribute('data-tiho-run')).toBe('2');
    const page = vi.fn();
    document.addEventListener('click', page);
    const enter = () => b!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    for (const [on, off] of [
      [() => rt.setPeek(true), () => rt.setPeek(false)],
      [() => rt.setSolo('spam'), () => rt.setSolo(null)],
    ]) {
      on!();
      b!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(enter()).toBe(true); // not handled
      await frame();
      expect([a, b].some((r) => r!.hasAttribute('data-tiho-open'))).toBe(false);
      off!();
    }
    expect(page).toHaveBeenCalledTimes(2);
    b!.dispatchEvent(new MouseEvent('click', { bubbles: true })); // no view: the pill opens its run
    expect(page).toHaveBeenCalledTimes(2);
    expect(b!.hasAttribute('data-tiho-open')).toBe(true);
    document.removeEventListener('click', page);
  });

  it('Solo hides new rows from birth and holds them for the model, even under Raw; both stop on exit', async () => {
    setup({ settings: { ...advanced, preset: 'raw', actions: { ...PRESETS.raw } } });
    expect(list.hasAttribute('data-tiho-list')).toBe(false);
    rt.setSolo('toxic');
    expect(list.hasAttribute('data-tiho-list')).toBe(true);
    const r = row('such an idiot streamer');
    await frame();
    expect(held(r)).toBe(true);
    port.replyAll(scorer);
    rt.flushNow();
    expect([A(r), C(r)]).toEqual(['show', 'toxic']); // Raw's verdict, untouched by Solo
    rt.setSolo(null);
    expect(list.hasAttribute('data-tiho-list')).toBe(false);
    const r2 = row('what a lovely evening');
    await frame();
    expect(A(r2)).toBe('show'); // not held
  });

  it('"Show in chat" of a row Solo hides ends Solo first', async () => {
    setup({ settings: advanced });
    const [bad, spam] = await chat();
    rt.setSolo('spam');
    expect(rt.reveal(spam!.dataset.key!)).toBe(true);
    expect(rt.store.solo.value).toBe('spam'); // one of the soloed rows: Solo stays
    expect(rt.reveal(bad!.dataset.key!)).toBe(true);
    expect(rt.store.solo.value).toBeNull();
    expect(A(bad!)).toBe('show');
    expect(bad!.hasAttribute('data-tiho-open')).toBe(true);
  });

  it('change no verdict and no count', async () => {
    setup({ settings: advanced });
    await chat();
    const before = { ...inChat() };
    const attrs = () => Array.from(list.children).map((el) => [A(el), C(el), el.getAttribute('data-tiho-r')].join('|'));
    const was = attrs();
    rt.setSolo('question');
    rt.flushNow();
    rt.setPeek(true);
    rt.flushNow();
    expect(attrs()).toEqual(was);
    expect(inChat()).toEqual(before);
  });
});
