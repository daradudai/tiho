import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineFollowUp } from '../../../src/core/protocol';
import { DEFAULT_SETTINGS, filterKey, type EngineFilter, type Settings } from '../../../src/core/settings';
import type { EngineAnswer, EngineQuery } from '../../../src/engine-client/client';
import { EngineRouter, followUp } from '../../../src/engine-client/router';
import { InferenceHub, type PortLike } from '../../../src/inference/hub';

class FakePort implements PortLike {
  sent: any[] = [];
  private msgL: Array<(m: any) => void> = [];
  private discL: Array<() => void> = [];
  connected = true;
  constructor(
    public name: string,
    public sender?: PortLike['sender'],
  ) {}
  postMessage(m: unknown) {
    if (!this.connected) throw new Error('disconnected');
    this.sent.push(m);
  }
  disconnect() {
    this.connected = false;
    this.discL.forEach((cb) => cb());
  }
  onMessage = { addListener: (cb: (m: any) => void) => void this.msgL.push(cb) };
  onDisconnect = { addListener: (cb: () => void) => void this.discL.push(cb) };
  emit(m: unknown) {
    this.msgL.forEach((cb) => cb(m));
  }
  get engine(): EngineFollowUp[] {
    return this.sent.filter((m) => m.type === 'engine');
  }
}

const BACKSEAT: EngineFilter = { id: 'a', question: 'Is this message backseating?', label: 'Backseating', action: 'hide', enabled: true };
const KEY = filterKey(BACKSEAT);
const THR = [0.23, 0.47, 0.13, 0.41, 0.49, 0.19, 0.13];
// toxic, spam, scam, noise, question, positive, negative
const CLEAN = [0.01, 0.01, 0.01, 0.02, 0.01, 0.1, 0.02];
const UNSURE = [0.2, 0.01, 0.01, 0.02, 0.01, 0.1, 0.02];
const ENGINE_BASE = [0.9, 0, 0, 0, 0, 0, 0.5];

function settings(o: Partial<Settings['engine']> = {}): Settings {
  return { ...DEFAULT_SETTINGS, engine: { ...DEFAULT_SETTINGS.engine, enabled: true, filters: [BACKSEAT], contexts: { 'twitch/xqc': 'Elden Ring, no spoilers' }, ...o } };
}

type Answer = EngineAnswer | null | Promise<EngineAnswer | null>;

function setup(s = settings(), answer: (q: EngineQuery) => Answer = (q) => ({ filters: { [KEY]: /left/i.test(q.text) ? 0.9 : 0.1 }, base: q.base ? ENGINE_BASE : undefined })) {
  const asked: EngineQuery[] = [];
  const client = { ready: true, ask: vi.fn(async (q: EngineQuery) => (asked.push(q), answer(q))) };
  const router = new EngineRouter({
    client,
    thresholds: () => THR,
    tabInfo: (id) => (id === 7 ? { platform: 'twitch', channel: 'xQc' } : undefined),
  });
  router.setSettings(s);
  return { router, client, asked };
}

/** Let answers come in and the follow-up that collects them go out. */
const tick = () => vi.advanceTimersByTimeAsync(1);
const items = (...texts: string[]) => texts.map((t, i) => ({ id: `n${i}`, text: t }));
const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);
const p = (x: number): EngineAnswer => ({ filters: { [KEY]: x } });

/** Answers the test hands out one by one, by text. */
function later() {
  const waiting = new Map<string, (a: EngineAnswer | null) => void>();
  return {
    answer: (q: EngineQuery) => new Promise<EngineAnswer | null>((r) => waiting.set(q.text, r)),
    give: (text: string, a: EngineAnswer | null) => waiting.get(text)!(a),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('EngineRouter', () => {
  it('asks custom filters for every scored text; answers that arrive together share a follow-up', async () => {
    const { router, asked } = setup();
    const port = new FakePort('tiho:classify', { tab: { id: 7 }, url: 'https://www.twitch.tv/xqc' });
    router.onLocalScores({ port, batchId: 4, items: items('go left', 'nice play'), ids: ['n0', 'n1'], scores: [CLEAN, CLEAN] });
    await tick();
    expect(asked).toEqual([
      { text: 'go left', platform: 'twitch', context: 'Elden Ring, no spoilers', filters: [{ id: KEY, question: BACKSEAT.question }], base: false },
      { text: 'nice play', platform: 'twitch', context: 'Elden Ring, no spoilers', filters: [{ id: KEY, question: BACKSEAT.question }], base: false },
    ]);
    expect(port.engine).toEqual([{ type: 'engine', batchId: 4, ids: ['n0', 'n1'], filters: { [KEY]: [0.9, 0.1] } }]);
  });

  it('asks for a second opinion only where the local model is unsure', async () => {
    const { router, asked } = setup(settings({ filters: [] }));
    const port = new FakePort('tiho:classify', { url: 'https://kick.com/someone' });
    router.onLocalScores({ port, batchId: 1, items: items('hmm', 'hello'), ids: ['n0', 'n1'], scores: [UNSURE, CLEAN] });
    await tick();
    expect(asked).toEqual([{ text: 'hmm', platform: 'kick', context: undefined, filters: [], base: true }]);
    expect(port.engine).toEqual([{ type: 'engine', batchId: 1, ids: ['n0'], filters: {}, base: [ENGINE_BASE] }]);
  });

  it('stays quiet when off, when there is nothing to ask, or when the engine is down', async () => {
    const port = new FakePort('tiho:classify');
    const off = setup(settings({ enabled: false }));
    off.router.onLocalScores({ port, batchId: 1, items: items('go left'), ids: ['n0'], scores: [UNSURE] });
    const nothing = setup(settings({ filters: [], refineUncertain: false }));
    nothing.router.onLocalScores({ port, batchId: 1, items: items('go left'), ids: ['n0'], scores: [UNSURE] });
    const down = setup();
    (down.client as { ready: boolean }).ready = false;
    down.router.onLocalScores({ port, batchId: 1, items: items('go left'), ids: ['n0'], scores: [UNSURE] });
    await tick();
    expect(off.asked.length + nothing.asked.length + down.asked.length).toBe(0);
    expect(port.sent).toEqual([]);
  });

  it('spends no engine time on chats in background tabs', async () => {
    const { router, asked } = setup();
    const port = new FakePort('tiho:classify', { tab: { id: 7 } });
    router.onLocalScores({ port, batchId: 1, items: items('go left'), ids: ['n0'], scores: [UNSURE], hidden: true });
    router.onLocalScores({ port, batchId: 2, items: items('go right'), ids: ['n0'], scores: [CLEAN], hidden: false });
    await tick();
    expect(asked.map((q) => q.text)).toEqual(['go right']);
    expect(port.engine.map((m) => m.batchId)).toEqual([2]);
  });

  it('leaves out texts the engine did not answer, and sends nothing if none were', async () => {
    const { router } = setup(settings(), (q) => (q.text === 'late' ? null : { filters: { [KEY]: 0.7 } }));
    const port = new FakePort('tiho:classify');
    router.onLocalScores({ port, batchId: 2, items: items('late', 'ok'), ids: ['n0', 'n1'], scores: [CLEAN, CLEAN] });
    router.onLocalScores({ port, batchId: 3, items: items('late'), ids: ['n0'], scores: [CLEAN] });
    await tick();
    expect(port.engine).toEqual([{ type: 'engine', batchId: 2, ids: ['n1'], filters: { [KEY]: [0.7] } }]);
  });

  it('survives a port that closed while the engine was thinking', async () => {
    const { router } = setup();
    const port = new FakePort('tiho:classify');
    router.onLocalScores({ port, batchId: 2, items: items('go left'), ids: ['n0'], scores: [CLEAN] });
    port.connected = false;
    await tick();
    expect(port.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('posts each answer as it comes instead of waiting for the whole batch', async () => {
    const eng = later();
    const { router } = setup(settings(), eng.answer);
    const port = new FakePort('tiho:classify');
    router.onLocalScores({ port, batchId: 5, items: items('slow', 'fast', 'never'), ids: ids(3), scores: [CLEAN, CLEAN, CLEAN] });
    await tick();
    eng.give('fast', p(0.8));
    await tick();
    expect(port.engine).toEqual([{ type: 'engine', batchId: 5, ids: ['n1'], filters: { [KEY]: [0.8] } }]);
    await vi.advanceTimersByTimeAsync(400);
    eng.give('never', null);
    eng.give('slow', p(0.3));
    await tick();
    expect(port.engine).toEqual([
      { type: 'engine', batchId: 5, ids: ['n1'], filters: { [KEY]: [0.8] } },
      { type: 'engine', batchId: 5, ids: ['n0'], filters: { [KEY]: [0.3] } },
    ]);
  });

  it('flushes answers to a Port at most every 50 ms, one message per batch', async () => {
    const eng = later();
    const { router } = setup(settings(), eng.answer);
    const a = new FakePort('tiho:classify');
    const b = new FakePort('tiho:classify');
    router.onLocalScores({ port: a, batchId: 1, items: items('t0', 't1', 't2', 't3'), ids: ids(4), scores: [CLEAN, CLEAN, CLEAN, CLEAN] });
    router.onLocalScores({ port: a, batchId: 2, items: items('u0'), ids: ids(1), scores: [CLEAN] });
    router.onLocalScores({ port: b, batchId: 1, items: items('v0'), ids: ids(1), scores: [CLEAN] });
    await tick();

    // the first answers after a quiet spell go out at once, together
    eng.give('t0', p(0.1));
    eng.give('t1', p(0.2));
    await tick();
    expect(a.engine).toEqual([{ type: 'engine', batchId: 1, ids: ['n0', 'n1'], filters: { [KEY]: [0.1, 0.2] } }]);

    // more within 50 ms wait for the next flush; another Port is not held back
    eng.give('t2', p(0.3));
    eng.give('v0', p(0.5));
    await vi.advanceTimersByTimeAsync(20);
    eng.give('u0', p(0.4));
    await vi.advanceTimersByTimeAsync(20);
    expect(a.engine).toHaveLength(1);
    expect(b.engine).toEqual([{ type: 'engine', batchId: 1, ids: ['n0'], filters: { [KEY]: [0.5] } }]);
    await vi.advanceTimersByTimeAsync(15);
    expect(a.engine.slice(1)).toEqual([
      { type: 'engine', batchId: 1, ids: ['n2'], filters: { [KEY]: [0.3] } },
      { type: 'engine', batchId: 2, ids: ['n0'], filters: { [KEY]: [0.4] } },
    ]);

    // quiet again: the next answer goes out right away
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
    eng.give('t3', p(0.6));
    await tick();
    expect(a.engine.at(-1)).toEqual({ type: 'engine', batchId: 1, ids: ['n3'], filters: { [KEY]: [0.6] } });
  });

  it('dedups filters with the same question and follows settings changes', async () => {
    const twin = { ...BACKSEAT, id: 'b', label: 'again' };
    const { router, asked } = setup(settings({ filters: [BACKSEAT, twin, { ...BACKSEAT, id: 'c', enabled: false, question: 'Off?' }] }));
    const port = new FakePort('tiho:classify');
    router.onLocalScores({ port, batchId: 1, items: items('x'), ids: ['n0'], scores: [CLEAN] });
    router.setSettings(settings({ filters: [], refineUncertain: false }));
    expect(router.active).toBe(false);
    router.onLocalScores({ port, batchId: 2, items: items('y'), ids: ['n0'], scores: [UNSURE] });
    await tick();
    expect(asked.map((q) => q.filters.length)).toEqual([1]);
  });

  it('followUp keeps arrays aligned with ids', () => {
    const f = [{ id: 'f1', question: 'a?' }, { id: 'f2', question: 'b?' }];
    const m = followUp(9, ['x', 'y', 'z'], [{ filters: { f1: 0.1, f2: 0.2 } }, null, { filters: { f1: 0.3, f2: 0.4 }, base: ENGINE_BASE }], f);
    expect(m).toEqual({ type: 'engine', batchId: 9, ids: ['x', 'z'], filters: { f1: [0.1, 0.3], f2: [0.2, 0.4] }, base: [null, ENGINE_BASE] });
    expect(followUp(9, ['x'], [null], f)).toBeNull();
  });
});

describe('InferenceHub → EngineRouter', () => {
  it('local scores go out first, engine answers follow on the same Port', async () => {
    const { router, asked } = setup();
    const hub = new InferenceHub({ ensureOffscreen: async () => {}, broadcast: () => {}, onScores: (r) => router.onLocalScores(r) });
    const content = new FakePort('tiho:classify', { tab: { id: 7 } });
    const off = new FakePort('tiho:offscreen');
    hub.addClient(content);
    hub.attachOffscreen(off);
    content.emit({ type: 'classify', batchId: 12, items: [{ id: 'go left', text: 'Go LEFT!!' }, { id: 'gg', text: 'gg' }] });
    const req = off.sent.find((m) => m.type === 'classify');
    off.emit({ type: 'scores', id: req.id, ids: ['go left', 'gg'], scores: [CLEAN, CLEAN], ms: 3, backend: 'webgpu' });
    expect(content.sent.at(-1)).toMatchObject({ type: 'scores', batchId: 12, ids: ['go left', 'gg'] });
    await tick();
    expect(asked.map((q) => q.text)).toEqual(['Go LEFT!!', 'gg']); // the text as written, not the cache key
    expect(content.sent.at(-1)).toEqual({ type: 'engine', batchId: 12, ids: ['go left', 'gg'], filters: { [KEY]: [0.9, 0.1] } });
  });
});
