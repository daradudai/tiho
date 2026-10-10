import { afterEach, describe, expect, it } from 'vitest';
import type { ScoreVector } from '../../../src/core/policy';
import type { PortRequest, PortResponse } from '../../../src/core/protocol';
import { DEFAULT_SETTINGS, filterKey, type EngineFilter, type Settings } from '../../../src/core/settings';
import type { ChatMessage } from '../../../src/core/types';
import type { PlatformAdapter } from '../../../src/platforms/types';
import { ClassifierClient, type ClassifierTransport } from '../../../src/runtime/classifier';
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

const BACKSEAT: EngineFilter = { id: 'a', question: 'Is this message backseating?', label: 'Backseating', action: 'hide', enabled: true };
const KEY = filterKey(BACKSEAT);
// toxic, spam, scam, noise, question, positive, negative
const CLEAN = [0.01, 0.01, 0.01, 0.02, 0.01, 0.1, 0.02];

describe('ClassifierClient: engine follow-up', () => {
  it('attaches engine answers to the cached scores and reports the ids', () => {
    const port = new FakePort();
    const rescored: string[][] = [];
    const c = new ClassifierClient(() => port, { onRescored: (ids) => rescored.push(ids) });
    c.request('go left', 'go left!');
    c.request('gg', 'gg');
    c.flush();
    const [req] = port.replyAll(CLEAN);
    port.emit({
      type: 'engine',
      batchId: req!.batchId,
      ids: ['go left', 'gg', 'evicted'],
      filters: { [KEY]: [0.93, null as unknown as number, 0.99] },
      base: [[0.9, 0, 0, 0, 0, 0, 0.4], [1, 2], null],
    });
    expect(rescored).toEqual([['go left', 'gg']]);
    const s = c.lookup('go left')!;
    expect(Array.from(s)).toEqual(CLEAN); // local scores untouched
    expect(s.engine).toEqual({ filters: { [KEY]: 0.93 }, base: [0.9, 0, 0, 0, 0, 0, 0.4] });
    expect(c.lookup('gg')!.engine).toEqual({}); // invalid values ignored
    expect(c.refined).toBe(2);
    // a later answer for another filter adds to the same opinion
    port.emit({ type: 'engine', batchId: 0, ids: ['go left'], filters: { fother: [0.2] } });
    expect(c.lookup('go left')!.engine!.filters).toEqual({ [KEY]: 0.93, fother: 0.2 });
  });
});

// ───────────────────────── runtime: verdicts from engine answers ─────────────────────────

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

describe('runtime with engine answers', () => {
  it('a custom filter hides the message once the engine answers', async () => {
    document.body.innerHTML = '<div id="chat"></div>';
    const list = document.getElementById('chat')!;
    const settings: Settings = { ...DEFAULT_SETTINGS, engine: { ...DEFAULT_SETTINGS.engine, enabled: true, filters: [BACKSEAT] } };
    const port = new FakePort();
    let runtime: HushRuntime;
    const classifier = new ClassifierClient(() => port, {
      now: () => 0,
      onScores: (ids) => runtime.onScores(ids),
      onFailed: (ids) => runtime.onFailed(ids),
      onRescored: (ids) => runtime.onRescored(ids),
      onStatus: (s) => runtime.setModelStatus(s),
    });
    runtime = rt = new HushRuntime({ adapter: adapter(), settings, classifier, now: () => 0, raf: () => 1, caf: () => {}, storeIntervalMs: 0, tickMs: 3_600_000 });
    runtime.start();
    classifier.connect();
    port.emit({ type: 'status', status: { state: 'ready', backend: 'wasm' } });
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

    const a = row('m1', 'bro jump on the left ledge');
    await frame();
    const [req] = port.replyAll(CLEAN);
    await frame();
    expect(a.getAttribute('data-hush-a')).toBe('show'); // local model: clean

    port.emit({ type: 'engine', batchId: req!.batchId, ids: req!.items.map((x) => x.id), filters: { [KEY]: [0.94] } });
    await frame();
    expect(a.getAttribute('data-hush-a')).toBe('hide');
    expect(a.getAttribute('data-hush-r')).toBe('filter: backseating');
    const v = runtime.store.filtered.value[0]?.verdict;
    expect(v).toMatchObject({ action: 'hide', reason: 'filter: backseating', source: 'engine' });

    // the same text again is decided from the cache, engine answer included
    const b = row('m2', 'bro jump on the left ledge');
    await frame();
    expect(port.sent).toHaveLength(0);
    expect(b.getAttribute('data-hush-a')).toBe('hide');
    expect((classifier.lookup(req!.items[0]!.id) as ScoreVector).engine?.filters?.[KEY]).toBe(0.94);
  });
});
