import { describe, expect, it } from 'vitest';
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
