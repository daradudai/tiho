import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineStatus } from '../../../src/core/protocol';
import { EngineClient, type EngineClientOptions, type EngineQuery } from '../../../src/engine-client/client';
import { answerAll, deferred, FakeEngine, json, READY, streamed } from './fake-engine';

const F = [{ id: 'fback', question: 'Is this message backseating?' }];
const q = (text: string, o: Partial<EngineQuery> = {}): EngineQuery => ({ text, filters: F, base: false, platform: 'twitch', ...o });

let fake: FakeEngine;
let statuses: EngineStatus[];

function client(o: EngineClientOptions = {}) {
  return new EngineClient({ fetch: fake.fetch, now: () => Date.now(), onStatus: (s) => statuses.push(s), ...o });
}

/** Let fetch promises and their continuations run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

async function connected(o: EngineClientOptions = {}) {
  const c = client(o);
  c.configure(true, 'http://127.0.0.1:7377/');
  await flush();
  expect(c.ready).toBe(true);
  return c;
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = new FakeEngine();
  statuses = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('EngineClient: health', () => {
  it('does nothing while disabled', async () => {
    const c = client();
    c.configure(false, 'http://127.0.0.1:7377');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.calls).toHaveLength(0);
    expect(c.status.state).toBe('off');
    expect(await c.ask(q('go left'))).toBeNull();
  });

  it('connects, reports model and device, then polls every 10 s', async () => {
    const c = client();
    c.configure(true, 'http://127.0.0.1:7377/');
    expect(c.status.state).toBe('connecting');
    await flush();
    expect(c.status).toMatchObject({ state: 'ready', url: 'http://127.0.0.1:7377', model: 'Clef-Flash-Q8_0', device: READY.device });
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'ready']);
    expect(fake.healthCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_900);
    expect(fake.healthCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.healthCalls).toHaveLength(2);
    expect(statuses).toHaveLength(2); // unchanged status is not re-broadcast
  });

  it('backs off while nothing answers and recovers', async () => {
    fake.health = () => new TypeError('Failed to fetch');
    const c = client();
    c.configure(true, 'http://127.0.0.1:7377');
    await flush();
    expect(c.status).toMatchObject({ state: 'unreachable', detail: 'Not running' });
    // 2 s, 4 s, 8 s, 16 s, 30 s, 30 s …
    const at: number[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 120; i++) {
      const n = fake.healthCalls.length;
      await vi.advanceTimersByTimeAsync(1000);
      if (fake.healthCalls.length > n) at.push(Math.round((Date.now() - t0) / 1000));
    }
    expect(at.slice(0, 6)).toEqual([2, 6, 14, 30, 60, 90]);
    fake.health = () => json(READY);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(c.status.state).toBe('ready');
  });

  it('polls fast while the engine loads its model', async () => {
    fake.health = () => json({ ok: false, status: 'loading', detail: 'loading model' });
    const c = client();
    c.configure(true, 'http://127.0.0.1:7377');
    await flush();
    expect(c.status).toMatchObject({ state: 'loading', detail: 'loading model' });
    expect(c.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.healthCalls).toHaveLength(2);
    fake.health = () => json(READY);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(c.ready).toBe(true);
  });

  it('flags something that is not a Tiho Engine', async () => {
    fake.health = () => json({ hello: 'world' });
    const c = client();
    c.configure(true, 'http://127.0.0.1:7377');
    await flush();
    expect(c.status.state).toBe('error');
  });

  it('stops polling when disabled', async () => {
    const c = await connected();
    c.configure(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.healthCalls).toHaveLength(1);
    expect(c.status.state).toBe('off');
  });
});

describe('EngineClient: classify', () => {
  it('batches asks within 50 ms into one request and maps answers', async () => {
    const c = await connected();
    const p = [c.ask(q('go left')), c.ask(q('nice play')), c.ask(q('use the bow', { platform: 'kick' }))];
    await vi.advanceTimersByTimeAsync(49);
    expect(fake.classifyCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.classifyCalls).toHaveLength(1);
    const body = fake.classifyCalls[0]!.body!;
    expect(body.messages.map((m) => [m.text, m.platform])).toEqual([
      ['go left', 'twitch'],
      ['nice play', 'twitch'],
      ['use the bow', 'kick'],
    ]);
    expect(body.filters).toEqual(F);
    expect(body.base).toBeUndefined();
    expect(body.deadline_ms).toBeGreaterThan(2000);
    expect(body.deadline_ms).toBeLessThanOrEqual(2500);
    expect(await Promise.all(p)).toEqual([{ filters: { fback: 0.9 } }, { filters: { fback: 0.9 } }, { filters: { fback: 0.9 } }]);
    expect(c.status.answered).toBe(3);
  });

  it('sends a full batch at once, the rest after the wait', async () => {
    const c = await connected();
    for (let i = 0; i < 33; i++) void c.ask(q(`msg ${i}`));
    await flush();
    expect(fake.classifyCalls.map((x) => x.body!.messages.length)).toEqual([32]);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.classifyCalls.map((x) => x.body!.messages.length)).toEqual([32, 1]);
  });

  it('groups by question set, second opinion and context', async () => {
    const c = await connected();
    void c.ask(q('a'));
    void c.ask(q('b', { base: true }));
    void c.ask(q('c', { context: 'Elden Ring, no spoilers' }));
    void c.ask(q('d', { filters: [], base: true }));
    await vi.advanceTimersByTimeAsync(50);
    const bodies = fake.classifyCalls.map((x) => x.body!);
    expect(bodies).toHaveLength(4);
    expect(bodies.find((b) => b.messages[0]!.text === 'b')).toMatchObject({ base: true, filters: F });
    expect(bodies.find((b) => b.messages[0]!.text === 'c')).toMatchObject({ context: 'Elden Ring, no spoilers' });
    expect(bodies.find((b) => b.messages[0]!.text === 'd')).toMatchObject({ base: true, filters: [] });
  });

  it('maps engine base scores to LABELS order', async () => {
    const c = await connected();
    const a = c.ask(q('you are trash', { base: true }));
    await vi.advanceTimersByTimeAsync(50);
    // toxic, spam, scam, noise, question, positive, negative
    expect((await a)!.base).toEqual([0.8, 0.01, 0.01, 0.02, 0.01, 0.05, 0.7]);
  });

  it('dedups in flight and caches answers', async () => {
    const c = await connected();
    const a = c.ask(q('KEKW'));
    const b = c.ask(q('KEKW'));
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.classifyCalls[0]!.body!.messages).toHaveLength(1);
    expect(await a).toEqual(await b);
    expect(await c.ask(q('KEKW'))).toEqual(await a);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.classifyCalls).toHaveLength(1);
    // a different question set is a different answer
    void c.ask(q('KEKW', { filters: [{ id: 'fspoil', question: 'Spoiler?' }] }));
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.classifyCalls).toHaveLength(2);
  });

  it('gives no opinion for texts the engine could not answer in time', async () => {
    const c = await connected();
    fake.classify = (req) => json({ results: [{ id: req.messages[0]!.id, error: 'expired' }, { id: req.messages[1]!.id, filters: { fback: 0.2 } }], ms: 2500, expired: 1 });
    const a = c.ask(q('one'));
    const b = c.ask(q('two'));
    await vi.advanceTimersByTimeAsync(50);
    expect(await a).toBeNull();
    expect(await b).toEqual({ filters: { fback: 0.2 } });
    expect(c.status).toMatchObject({ answered: 1, expired: 1 });
  });

  it('drops texts that waited past their deadline and tells the engine the time left', async () => {
    const c = await connected({ maxInflight: 1 });
    const slow = deferred<Response>();
    let first = true;
    fake.classify = (req) => {
      if (!first) return answerAll()(req);
      first = false;
      return slow.promise;
    };
    const a = c.ask(q('first'));
    await vi.advanceTimersByTimeAsync(50); // sent, engine is slow
    const stale = c.ask(q('waits too long'));
    await vi.advanceTimersByTimeAsync(1000);
    const fresh = c.ask(q('fresh'));
    await vi.advanceTimersByTimeAsync(1300); // stale: 2.3 s old
    slow.resolve(answerAll()(fake.classifyCalls[0]!.body!));
    await flush();
    expect(await a).not.toBeNull();
    expect(await stale).toBeNull();
    expect(fake.classifyCalls).toHaveLength(2);
    const body = fake.classifyCalls[1]!.body!;
    expect(body.messages.map((m) => m.text)).toEqual(['fresh']);
    expect(body.deadline_ms).toBe(2500 - 1300);
    expect(await fresh).not.toBeNull();
  });

  it('aborts a request at its deadline', async () => {
    const c = await connected();
    fake.classify = (_req, call) =>
      new Promise((_, reject) => call.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const a = c.ask(q('hello'));
    await vi.advanceTimersByTimeAsync(50 + 2450 + 499);
    let done = false;
    void a.then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await a).toBeNull();
    expect(c.status.state).toBe('ready'); // slow is not down
  });

  it('marks the engine unreachable when a request cannot connect', async () => {
    const c = await connected();
    fake.classify = () => new TypeError('Failed to fetch');
    fake.health = () => new TypeError('Failed to fetch');
    const a = c.ask(q('hello'));
    await vi.advanceTimersByTimeAsync(50);
    expect(await a).toBeNull();
    expect(c.status).toMatchObject({ state: 'unreachable', detail: 'Connection lost' });
    expect(await c.ask(q('more'))).toBeNull(); // not ready: not even queued
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.healthCalls.length).toBeGreaterThan(1);
  });

  it('re-checks health when the engine says it is not ready', async () => {
    const c = await connected();
    fake.classify = () => json({ error: { code: 'loading', message: 'engine is loading' } }, 503);
    fake.health = () => json({ ok: false, status: 'loading', detail: 'model reloading' });
    const a = c.ask(q('hello'));
    await vi.advanceTimersByTimeAsync(50);
    expect(await a).toBeNull();
    expect(c.status.state).toBe('loading');
  });

  it('cancels queued texts when switched off', async () => {
    const c = await connected();
    const a = c.ask(q('hello'));
    c.configure(false);
    expect(await a).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.classifyCalls).toHaveLength(0);
  });

  it('answers "Test filter" without batching', async () => {
    const c = await connected();
    fake.classify = (req) => json({ results: [{ id: req.messages[0]!.id, filters: { fback: 0.87 } }], ms: 180 });
    const r = await c.test({ text: 'jump left', filters: F, context: ' Elden Ring ', platform: 'twitch' });
    expect(r).toEqual({ ok: true, filters: { fback: 0.87 }, ms: 0 }); // round trip as the user waits for it (fake clock)
    expect(fake.classifyCalls[0]!.body).toMatchObject({ deadline_ms: 0, context: 'Elden Ring', messages: [{ text: 'jump left', platform: 'twitch' }] });

    fake.classify = () => json({ error: { code: 'loading', message: 'engine is loading' } }, 503);
    expect(await c.test({ text: 'x', filters: F })).toEqual({ ok: false, error: 'Engine not ready: engine is loading' });
    fake.classify = () => new TypeError('Failed to fetch');
    expect(await c.test({ text: 'x', filters: F })).toEqual({ ok: false, error: 'Tiho Engine is not running' });
  });
});

describe('EngineClient: streamed answers', () => {
  /** The next classify request answers with a stream the test writes. */
  function streaming() {
    const out: ReturnType<typeof streamed>[] = [];
    fake.classify = (_req, call) => {
      const s = streamed(call.signal);
      out.push(s);
      return s.response;
    };
    return out;
  }

  it('asks for a stream and settles each text as its line arrives', async () => {
    const c = await connected();
    const s = streaming();
    const got: (string | null)[] = [];
    const ask = (text: string) => c.ask(q(text)).then((a) => void got.push(a ? `${text} ${a.filters.fback}` : null));
    void ask('one');
    void ask('two');
    void ask('three');
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.classifyCalls[0]!.body!.stream).toBe(true);
    s[0]!.write({ id: '1', filters: { fback: 0.7 }, cached: false });
    await flush();
    expect(got).toEqual(['two 0.7']);
    await vi.advanceTimersByTimeAsync(300);
    s[0]!.write({ id: '0', filters: { fback: 0.1 } }, { id: '2', error: 'expired' });
    await flush();
    expect(got).toEqual(['two 0.7', 'one 0.1', null]);
    expect(c.status).toMatchObject({ answered: 2, expired: 1 });
    s[0]!.write({ done: true, ms: 312, expired: 1 });
    s[0]!.end();
    await flush();
    expect(c.status.state).toBe('ready');
    expect(await c.ask(q('two'))).toEqual({ filters: { fback: 0.7 } }); // cached on arrival
  });

  it('reads lines split across chunks, several per chunk, and a last one without a newline', async () => {
    const c = await connected();
    const s = streaming();
    const p = [c.ask(q('a')), c.ask(q('b')), c.ask(q('c')), c.ask(q('d'))];
    await vi.advanceTimersByTimeAsync(50);
    s[0]!.chunk('{"id":"0","filters":{"fb');
    s[0]!.chunk('ack":0.25}}\n\n{"id":"1","filters":{"fback":0.5}}\nnot json\n[1,2]\n{"id":"2","fil');
    s[0]!.chunk('ters":{"fback":0.75}}\n{"id":"3","filters":{"fback":1}}');
    s[0]!.end();
    expect((await Promise.all(p)).map((a) => a?.filters.fback)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(c.status.state).toBe('ready');
  });

  it('keeps answers that arrived when the deadline aborts the rest', async () => {
    const c = await connected();
    const s = streaming();
    const a = c.ask(q('quick'));
    const b = c.ask(q('stuck'));
    await vi.advanceTimersByTimeAsync(50);
    s[0]!.write({ id: '0', filters: { fback: 0.6 } });
    await flush();
    expect(await a).toEqual({ filters: { fback: 0.6 } });
    let done = false;
    void b.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2450 + 499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await b).toBeNull();
    s[0]!.write({ id: '1', filters: { fback: 0.9 } }); // too late: nobody reads it
    await flush();
    expect(c.status).toMatchObject({ state: 'ready', answered: 1, expired: 1 });
  });

  it('holds its request slot until the stream ends', async () => {
    const c = await connected({ maxInflight: 1 });
    const s = streaming();
    const a = c.ask(q('first'));
    await vi.advanceTimersByTimeAsync(50);
    const b = c.ask(q('second'));
    s[0]!.write({ id: '0', filters: { fback: 0.4 } });
    await vi.advanceTimersByTimeAsync(100);
    expect(await a).not.toBeNull();
    expect(fake.classifyCalls).toHaveLength(1); // answered, but the stream is still open
    s[0]!.write({ done: true, ms: 120, expired: 0 });
    s[0]!.end();
    await flush();
    expect(fake.classifyCalls).toHaveLength(2);
    s[1]!.write({ id: '0', filters: { fback: 0.3 } });
    s[1]!.end();
    expect(await b).toEqual({ filters: { fback: 0.3 } });
  });

  it('marks the engine unreachable when the stream breaks off', async () => {
    const c = await connected();
    const s = streaming();
    fake.health = () => new TypeError('Failed to fetch');
    const a = c.ask(q('answered'));
    const b = c.ask(q('lost'));
    await vi.advanceTimersByTimeAsync(50);
    s[0]!.write({ id: '0', filters: { fback: 0.2 } });
    s[0]!.fail(new TypeError('network error'));
    expect(await a).toEqual({ filters: { fback: 0.2 } });
    expect(await b).toBeNull();
    expect(c.status).toMatchObject({ state: 'unreachable', detail: 'Connection lost' });
  });

  it('takes a whole-batch JSON answer from an engine that cannot stream', async () => {
    const c = await connected();
    fake.classify = (req) => json({ results: req.messages.map((m) => ({ id: m.id, filters: { fback: m.text === 'x' ? 0.9 : 0.1 } })), ms: 40 });
    const p = [c.ask(q('x')), c.ask(q('y'))];
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.classifyCalls[0]!.body!.stream).toBe(true);
    expect(await Promise.all(p)).toEqual([{ filters: { fback: 0.9 } }, { filters: { fback: 0.1 } }]);
  });
});
