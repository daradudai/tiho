import { afterEach, describe, expect, it, vi } from 'vitest';
import { InferenceHub, type PortLike } from '../../../src/inference/hub';

class FakePort implements PortLike {
  sent: any[] = [];
  private msgL: Array<(m: any) => void> = [];
  private discL: Array<() => void> = [];
  connected = true;
  constructor(public name: string) {}
  postMessage(m: unknown) {
    if (!this.connected) throw new Error('disconnected');
    this.sent.push(m);
  }
  disconnect() {
    this.fireDisconnect();
  }
  onMessage = { addListener: (cb: (m: any) => void) => void this.msgL.push(cb) };
  onDisconnect = { addListener: (cb: () => void) => void this.discL.push(cb) };
  emit(m: unknown) {
    this.msgL.forEach((cb) => cb(m));
  }
  fireDisconnect() {
    this.connected = false;
    this.discL.forEach((cb) => cb());
  }
}

function setup() {
  const broadcasts: any[] = [];
  let ensured = 0;
  const hub = new InferenceHub({
    ensureOffscreen: async () => {
      ensured++;
    },
    broadcast: (m) => broadcasts.push(m),
  });
  return { hub, broadcasts, ensured: () => ensured };
}

describe('InferenceHub', () => {
  it('queues requests until the offscreen host connects, then routes replies by batchId', async () => {
    const { hub, ensured } = setup();
    const a = new FakePort('hush:classify');
    const b = new FakePort('hush:classify');
    hub.addClient(a);
    hub.addClient(b);
    expect(a.sent[0]).toMatchObject({ type: 'status', status: { state: 'idle' } });
    a.emit({ type: 'classify', batchId: 7, items: [{ id: 'x', text: 'hi' }] });
    b.emit({ type: 'classify', batchId: 7, items: [{ id: 'y', text: 'yo' }] });
    await Promise.resolve();
    expect(ensured()).toBeGreaterThan(0);

    const off = new FakePort('hush:offscreen');
    hub.attachOffscreen(off);
    expect(off.sent[0]).toMatchObject({ type: 'init' });
    const reqs = off.sent.filter((m) => m.type === 'classify');
    expect(reqs).toHaveLength(2);
    // reply out of order
    off.emit({ type: 'scores', id: reqs[1].id, ids: ['y'], scores: [[0.1]], ms: 3, backend: 'webgpu' });
    off.emit({ type: 'scores', id: reqs[0].id, ids: ['x'], scores: [[0.9]], ms: 4, backend: 'webgpu' });
    expect(a.sent.at(-1)).toEqual({ type: 'scores', batchId: 7, ids: ['x'], scores: [[0.9]], ms: 4, backend: 'webgpu' });
    expect(b.sent.at(-1)).toEqual({ type: 'scores', batchId: 7, ids: ['y'], scores: [[0.1]], ms: 3, backend: 'webgpu' });
  });

  it('broadcasts status changes to ports and extension pages (deduped)', () => {
    const { hub, broadcasts } = setup();
    const a = new FakePort('hush:classify');
    hub.addClient(a);
    const off = new FakePort('hush:offscreen');
    hub.attachOffscreen(off);
    const ready = { state: 'ready', backend: 'webgpu', version: 'v1', thresholds: [0.5] };
    off.emit({ type: 'status', status: ready });
    off.emit({ type: 'status', status: ready });
    expect(a.sent.filter((m) => m.type === 'status' && m.status.state === 'ready')).toHaveLength(1);
    expect(broadcasts).toEqual([{ type: 'hush:status', status: ready }]);
    expect(hub.getStatus()).toEqual(ready);
  });

  it('errors in-flight batches when the offscreen host goes away, and drops replies for closed ports', () => {
    const { hub } = setup();
    const a = new FakePort('hush:classify');
    const b = new FakePort('hush:classify');
    hub.addClient(a);
    hub.addClient(b);
    const off = new FakePort('hush:offscreen');
    hub.attachOffscreen(off);
    a.emit({ type: 'classify', batchId: 1, items: [{ id: 'x', text: 'hi' }] });
    b.emit({ type: 'classify', batchId: 2, items: [{ id: 'y', text: 'yo' }] });
    const [ra] = off.sent.filter((m) => m.type === 'classify');
    b.fireDisconnect();
    off.emit({ type: 'scores', id: ra.id + 1, ids: ['y'], scores: [[1]], ms: 1, backend: 'wasm' }); // b gone: ignored
    off.fireDisconnect();
    expect(a.sent.at(-1)).toMatchObject({ type: 'error', batchId: 1 });
  });

  it('answers empty batches immediately and forwards worker errors', () => {
    const { hub } = setup();
    const a = new FakePort('hush:classify');
    hub.addClient(a);
    const off = new FakePort('hush:offscreen');
    hub.attachOffscreen(off);
    a.emit({ type: 'classify', batchId: 3, items: [] });
    expect(a.sent.at(-1)).toMatchObject({ type: 'scores', batchId: 3, ids: [] });
    a.emit({ type: 'classify', batchId: 4, items: [{ id: 'z', text: 'z' }] });
    const req = off.sent.filter((m) => m.type === 'classify').at(-1);
    off.emit({ type: 'error', id: req.id, error: 'overloaded' });
    expect(a.sent.at(-1)).toEqual({ type: 'error', batchId: 4, error: 'overloaded' });
  });

  it('broadcasts a switch to another model even when backend and version stay the same', () => {
    const { hub, broadcasts } = setup();
    const off = new FakePort('hush:offscreen');
    hub.attachOffscreen(off);
    off.emit({ type: 'status', status: { state: 'ready', backend: 'webgpu', modelId: 'hush-lite/q8', version: 'v2' } });
    off.emit({ type: 'status', status: { state: 'ready', backend: 'webgpu', modelId: 'hush-lite/q4f16', version: 'v2' } });
    expect(broadcasts.map((b) => b.status.modelId)).toEqual(['hush-lite/q8', 'hush-lite/q4f16']);
  });

  it('tells onScores whether the batch came from a background tab', () => {
    const got: boolean[] = [];
    const hub = new InferenceHub({ ensureOffscreen: async () => {}, broadcast: () => {}, onScores: (r) => got.push(!!r.hidden) });
    const a = new FakePort('hush:classify');
    hub.addClient(a);
    const off = new FakePort('hush:offscreen');
    hub.attachOffscreen(off);
    a.emit({ type: 'classify', batchId: 1, items: [{ id: 'x', text: 'x' }], hidden: true });
    a.emit({ type: 'classify', batchId: 2, items: [{ id: 'y', text: 'y' }] });
    for (const r of off.sent.filter((m) => m.type === 'classify'))
      off.emit({ type: 'scores', id: r.id, ids: [r.items[0].id], scores: [[0]], ms: 1, backend: 'wasm' });
    expect(got).toEqual([true, false]);
  });

  it('sends the device preference to the host', () => {
    const { hub } = setup();
    hub.setDevice('wasm');
    const off = new FakePort('hush:offscreen');
    hub.attachOffscreen(off);
    expect(off.sent[0]).toEqual({ type: 'init', opts: { device: 'wasm' } });
    hub.setDevice('auto');
    expect(off.sent.at(-1)).toEqual({ type: 'init', opts: { device: 'auto' } });
  });
});

describe('InferenceHub: failed model load', () => {
  afterEach(() => vi.useRealTimers());

  const failed = { state: 'error', backend: 'none', error: 'GET config.json: 503' } as const;
  const inits = (off: FakePort) => off.sent.filter((m) => m.type === 'init').length;

  it('loads again with backoff while a chat is open, until the model is ready', () => {
    vi.useFakeTimers();
    const { hub } = setup();
    hub.addClient(new FakePort('hush:classify'));
    const off = new FakePort('hush:offscreen');
    hub.attachOffscreen(off);
    expect(inits(off)).toBe(1);
    off.emit({ type: 'status', status: failed });
    vi.advanceTimersByTime(4_999);
    expect(inits(off)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(inits(off)).toBe(2); // first retry after 5 s
    off.emit({ type: 'status', status: { state: 'downloading', backend: 'none', progress: 0.1 } });
    off.emit({ type: 'status', status: failed });
    vi.advanceTimersByTime(9_999);
    expect(inits(off)).toBe(2);
    vi.advanceTimersByTime(1);
    expect(inits(off)).toBe(3); // then 10 s
    off.emit({ type: 'status', status: { state: 'ready', backend: 'wasm', modelId: 'hush-lite/uint8', version: 'v2-3L' } });
    vi.advanceTimersByTime(600_000);
    expect(inits(off)).toBe(3);
    off.emit({ type: 'status', status: failed }); // a later failure starts from 5 s again
    vi.advanceTimersByTime(5_000);
    expect(inits(off)).toBe(4);
  });

  it('does not retry without an open chat, and starts again when one opens', () => {
    vi.useFakeTimers();
    const { hub } = setup();
    const off = new FakePort('hush:offscreen');
    hub.attachOffscreen(off);
    off.emit({ type: 'status', status: failed });
    vi.advanceTimersByTime(60_000);
    expect(inits(off)).toBe(1);
    hub.addClient(new FakePort('hush:classify'));
    vi.advanceTimersByTime(5_000);
    expect(inits(off)).toBe(2);
  });

  it('creates the inference host again when that is what failed', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const hub = new InferenceHub({
      ensureOffscreen: async () => {
        if (++calls === 1) throw new Error('offscreen quota');
      },
      broadcast: () => {},
    });
    hub.addClient(new FakePort('hush:classify'));
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.getStatus().state).toBe('error');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2);
  });
});
