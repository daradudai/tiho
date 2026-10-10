// Content side of a model switch: the 6-layer student (WebGPU) and the 3-layer
// one (WASM) have their own thresholds, so a score of one must never be judged
// against the other's. After a switch the content cache starts empty and rows
// on screen are scored again instead of re-thresholded.

import { afterEach, describe, expect, it } from 'vitest';
import type { PortRequest, PortResponse } from '../../../src/core/protocol';
import { DEFAULT_SETTINGS } from '../../../src/core/settings';
import type { ChatMessage, ModelStatus } from '../../../src/core/types';
import type { PlatformAdapter } from '../../../src/platforms/types';
import { ClassifierClient, modelKey, type ClassifierTransport } from '../../../src/runtime/classifier';
import { HushRuntime } from '../../../src/runtime/engine';

class FakePort implements ClassifierTransport {
  sent: PortRequest[] = [];
  private msg: ((m: PortResponse) => void) | null = null;
  post(m: PortRequest) {
    this.sent.push(m);
  }
  onMessage(cb: (m: PortResponse) => void) {
    this.msg = cb;
  }
  onDisconnect() {}
  disconnect() {}
  emit(m: PortResponse) {
    this.msg!(m);
  }
  replyAll(score: number[]) {
    const reqs = this.sent;
    this.sent = [];
    for (const r of reqs) this.emit({ type: 'scores', batchId: r.batchId, ids: r.items.map((x) => x.id), scores: r.items.map(() => score.slice()), ms: 3, backend: 'wasm' });
    return reqs;
  }
}

// toxic, spam, scam, noise, question, positive, negative
const THR_6L = [0.22, 0.53, 0.22, 0.44, 0.52, 0.26, 0.1];
const THR_3L = [0.17, 0.34, 0.23, 0.45, 0.39, 0.28, 0.1];
const SIX: ModelStatus = { state: 'ready', backend: 'webgpu', modelId: 'hush-lite/q8', version: 'v2-6L', thresholds: THR_6L };
const THREE: ModelStatus = { state: 'ready', backend: 'wasm', modelId: 'hush-lite/uint8', version: 'v2-3L', thresholds: THR_3L };
/** spam 0.45: clean for the 6-layer (0.53), spam for the 3-layer (0.34) */
const BORDERLINE = [0.01, 0.45, 0.01, 0.02, 0.01, 0.05, 0.02];
const CLEAN = [0.01, 0.05, 0.01, 0.02, 0.01, 0.05, 0.02];

describe('ClassifierClient across a model switch', () => {
  it('keeps its score cache for one model only', () => {
    const port = new FakePort();
    const c = new ClassifierClient(() => port);
    c.setStatus(SIX);
    c.request('kekw', 'KEKW');
    c.flush();
    port.replyAll(BORDERLINE);
    c.setStatus({ state: 'idle', backend: 'none' }); // released after idling: same model when it comes back
    c.setStatus(SIX);
    expect(c.lookup('kekw')).toBeDefined();
    c.setStatus(THREE);
    expect(c.lookup('kekw')).toBeUndefined();
  });

  it('tells the background when the page is in a background tab', () => {
    const port = new FakePort();
    let hidden = true;
    const c = new ClassifierClient(() => port, { hidden: () => hidden });
    c.request('a', 'a');
    c.flush();
    hidden = false;
    c.request('b', 'b');
    c.flush();
    expect(port.sent.map((r) => r.hidden)).toEqual([true, undefined]);
  });

  it('modelKey names the loaded model only', () => {
    expect(modelKey(SIX)).toBe('hush-lite/q8@v2-6L');
    expect(modelKey({ state: 'loading', backend: 'none' })).toBe('');
    expect(modelKey(null)).toBe('');
  });
});

function adapter(): PlatformAdapter {
  return {
    platform: 'twitch',
    matches: () => true,
    findChatList: (doc) => doc.querySelector('#chat'),
    rowSelector: '.msg',
    extract(row): ChatMessage | null {
      const d = row.dataset;
      if (!d.key) return null;
      return {
        key: d.key,
        platform: 'twitch',
        channel: 'test',
        author: d.key,
        roles: 0,
        text: row.textContent ?? '',
        emotes: 0,
        mentions: [],
        isReply: false,
        isFirstMessage: false,
        paid: false,
        ts: 0,
      };
    },
    channel: () => 'test',
    barAnchor: (doc) => ({ el: doc.querySelector('#chat') as HTMLElement, where: 'before' }),
    theme: () => 'dark',
  };
}

let rt: HushRuntime | null = null;
afterEach(() => rt?.stop());

describe('runtime across a model switch', () => {
  it('scores rows on screen again with the new model instead of re-thresholding the old scores', async () => {
    document.body.innerHTML = '<div id="chat"></div>';
    const list = document.getElementById('chat')!;
    const port = new FakePort();
    let runtime: HushRuntime;
    const classifier = new ClassifierClient(() => port, {
      now: () => 0,
      hidden: () => false,
      onScores: (ids) => runtime.onScores(ids),
      onFailed: (ids) => runtime.onFailed(ids),
      onStatus: (s) => runtime.setModelStatus(s),
    });
    runtime = rt = new HushRuntime({ adapter: adapter(), settings: DEFAULT_SETTINGS, classifier, now: () => 0, raf: () => 1, caf: () => {}, storeIntervalMs: 0, tickMs: 3_600_000 });
    runtime.start();
    classifier.connect();
    port.emit({ type: 'status', status: SIX });
    runtime.flushNow();

    const row = (key: string, text: string) => {
      const el = document.createElement('div');
      el.className = 'msg';
      el.dataset.key = key;
      el.textContent = text;
      list.appendChild(el);
      return el;
    };
    const frame = async () => {
      await new Promise((r) => setTimeout(r, 0));
      runtime.flushNow();
    };

    const a = row('m1', 'that was a crazy play honestly');
    await frame();
    port.replyAll(BORDERLINE);
    await frame();
    expect(a.getAttribute('data-hush-a')).toBe('show'); // 6-layer: 0.45 < 0.53

    port.emit({ type: 'status', status: THREE }); // GPU lost: the worker now runs the 3-layer student
    await frame();
    expect(a.getAttribute('data-hush-a')).toBe('show'); // not folded on the 6-layer's score
    const [again] = port.sent;
    expect(again?.items.map((x) => x.text)).toEqual(['that was a crazy play honestly']);

    port.replyAll(CLEAN);
    await frame();
    expect(a.getAttribute('data-hush-a')).toBe('show');

    // a repeat is decided on the 3-layer's score from the cache
    const b = row('m2', 'that was a crazy play honestly');
    await frame();
    expect(port.sent).toHaveLength(0);
    expect(b.getAttribute('data-hush-a')).toBe('show');

    // and a 3-layer score above its own threshold folds as usual
    const c = row('m3', 'first time watching this channel');
    await frame();
    port.replyAll(BORDERLINE);
    await frame();
    expect(c.getAttribute('data-hush-a')).toBe('collapse');
  });
});
