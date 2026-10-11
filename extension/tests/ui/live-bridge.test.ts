// The live bridge between extension pages and the chat tab: startTiho serves
// tiho:live / tiho:getSnapshot once it shows a chat, connectLive follows the
// active tab, markNotFiltered ("Not spam") edits the user's rules.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleEngine } from '../../src/core/rules';
import { normalize } from '../../src/core/normalize';
import { SETTINGS_KEY, mergeSettings, type Settings, type UserRule } from '../../src/core/settings';
import type { LogEntry } from '../../src/core/store';
import type { ChatMessage } from '../../src/core/types';
import type { PlatformAdapter } from '../../src/platforms/types';
import { startTiho } from '../../src/runtime';
import { PORT_LIVE, allowPhrase, connectLive, markNotFiltered, type ActiveTab, type LiveSnapshot } from '../../src/ui/bridge';

// ───────────────────────── a small chrome.* fake ─────────────────────────

type Fn = (...a: any[]) => unknown;

function event() {
  const ls = new Set<Fn>();
  return {
    addListener: (f: Fn) => void ls.add(f),
    removeListener: (f: Fn) => void ls.delete(f),
    emit: (...a: unknown[]) => [...ls].map((f) => f(...a)),
    get size() {
      return ls.size;
    },
  };
}

function port(name: string) {
  const p = {
    name,
    sent: [] as unknown[],
    onMessage: event(),
    onDisconnect: event(),
    postMessage: (m: unknown) => void p.sent.push(m),
    disconnect: vi.fn(),
  };
  return p;
}

let storage: Record<string, unknown>;
let fake: ReturnType<typeof fakeChrome>;

function fakeChrome() {
  return {
    runtime: {
      id: 'tiho-test',
      lastError: undefined,
      onConnect: event(),
      onMessage: event(),
      connect: ({ name }: { name: string }) => port(name),
      sendMessage: async () => undefined,
    },
    storage: {
      local: {
        get: async (k: string) => (k in storage ? { [k]: structuredClone(storage[k]) } : {}),
        set: async (o: Record<string, unknown>) => void Object.assign(storage, structuredClone(o)),
      },
      onChanged: event(),
    },
    tabs: {
      query: async () => [{ id: 7, url: 'https://www.twitch.tv/somechannel' }],
      connect: (_id: number, { name }: { name: string }) => port(name),
      sendMessage: async () => undefined,
      onActivated: event(),
      onUpdated: event(),
    },
  };
}

beforeEach(() => {
  storage = {};
  fake = fakeChrome();
  vi.stubGlobal('chrome', fake);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ───────────────────────── startTiho serves the pages ─────────────────────────

const adapter: PlatformAdapter = {
  platform: 'twitch',
  matches: () => true,
  findChatList: (doc) => doc.querySelector('#chat'),
  rowSelector: '.msg',
  extract: (row): ChatMessage | null =>
    row.dataset.key
      ? {
          key: row.dataset.key,
          platform: 'twitch',
          channel: 'somechannel',
          author: 'ana',
          roles: 0,
          text: row.textContent ?? '',
          emotes: 0,
          mentions: [],
          isReply: false,
          isFirstMessage: false,
          paid: false,
          ts: Date.now(),
        }
      : null,
  channel: () => 'somechannel',
  barAnchor: () => null,
  theme: () => 'dark',
  viewer: () => [],
};

describe('startTiho ↔ side panel / popup', () => {
  it('answers nothing in a frame without a chat', async () => {
    document.body.innerHTML = '<div id="elsewhere"></div>';
    const tiho = await startTiho({ adapter });
    expect(fake.runtime.onConnect.size).toBe(0); // the panel's Port would disconnect: "no chat here"
    tiho.stop();
  });

  it('streams snapshots over tiho:live and takes reveal commands once it shows a chat', async () => {
    document.body.innerHTML = '<div id="chat"></div>';
    const tiho = await startTiho({ adapter });
    const reveal = vi.spyOn(tiho.runtime, 'reveal');

    const p = port(PORT_LIVE);
    fake.runtime.onConnect.emit(p);
    const first = p.sent[0] as { type: string; snapshot: LiveSnapshot };
    expect(first.type).toBe('snapshot');
    expect(first.snapshot).toMatchObject({ v: 2, platform: 'twitch', channel: 'somechannel', enabled: true, peek: false, solo: null });
    expect(first.snapshot.inChat).toMatchObject({ rows: 0, hidden: 0, folded: 0, inWaves: 0 });
    expect(first.snapshot).not.toHaveProperty('counts');
    expect(first.snapshot).not.toHaveProperty('totals');

    p.onMessage.emit({ type: 'reveal', key: 'k1' });
    p.onMessage.emit({ type: 'feedback', key: 'k2', label: 'clean' });
    expect(reveal.mock.calls.map((c) => c[0])).toEqual(['k1', 'k2']);

    // the popup's one-shot request
    const sendResponse = vi.fn();
    fake.runtime.onMessage.emit({ type: 'tiho:getSnapshot' }, {}, sendResponse);
    expect(sendResponse.mock.calls[0]![0]).toMatchObject({ v: 2, channel: 'somechannel' });

    tiho.stop();
    expect(fake.runtime.onConnect.size).toBe(0);
    expect(p.disconnect).toHaveBeenCalled();
  });

  it('takes Show hidden and Solo commands from the side panel; the next snapshot says so', async () => {
    storage[SETTINGS_KEY] = { uiMode: 'advanced' };
    document.body.innerHTML = '<div id="chat"></div>';
    const tiho = await startTiho({ adapter });
    const peek = vi.spyOn(tiho.runtime, 'setPeek');
    const solo = vi.spyOn(tiho.runtime, 'setSolo');
    const p = port(PORT_LIVE);
    fake.runtime.onConnect.emit(p);
    const latest = () => {
      const sendResponse = vi.fn();
      fake.runtime.onMessage.emit({ type: 'tiho:getSnapshot' }, {}, sendResponse);
      return sendResponse.mock.calls[0]![0] as LiveSnapshot;
    };

    p.onMessage.emit({ type: 'peek', on: true });
    expect(latest()).toMatchObject({ peek: true, solo: null });
    p.onMessage.emit({ type: 'solo', cat: 'nope' }); // not a category: dropped
    p.onMessage.emit({ type: 'solo', cat: 'spam' });
    expect(latest()).toMatchObject({ peek: false, solo: 'spam' });
    fake.runtime.onMessage.emit({ type: 'tiho:command', cmd: { type: 'solo', cat: null } }, {}, vi.fn()); // the one-shot path
    expect(latest()).toMatchObject({ peek: false, solo: null });
    expect(peek.mock.calls).toEqual([[true]]);
    expect(solo.mock.calls).toEqual([['spam'], [null]]);
    tiho.stop();
  });
});

// ───────────────────────── connectLive ─────────────────────────

describe('connectLive', () => {
  it('reports the tab at once when nothing serves it, and connects when the chat appears', async () => {
    vi.useFakeTimers();
    const SNAP = { v: 2, channel: 'somechannel' } as LiveSnapshot;
    let serving = false;
    fake.tabs.connect = (_id, { name }) => {
      const p = port(name);
      // Chrome disconnects a Port nobody listens to; a content script answers with a snapshot
      setTimeout(() => (serving ? p.onMessage.emit({ type: 'snapshot', snapshot: SNAP }) : p.onDisconnect.emit()), 0);
      return p;
    };
    const updates: [LiveSnapshot | null, ActiveTab | null][] = [];
    const conn = connectLive((s, t) => updates.push([s, t]));

    await vi.advanceTimersByTimeAsync(10);
    expect(updates).toEqual([[null, expect.objectContaining({ id: 7, platform: 'twitch' })]]); // "Waiting for chat…", not "No stream open"

    serving = true;
    await vi.advanceTimersByTimeAsync(2100); // the retry
    expect(updates.at(-1)![0]).toBe(SNAP);
    conn.dispose();
  });

  it('still goes stale while retries fail after the chat stopped answering', async () => {
    vi.useFakeTimers();
    const SNAP = { v: 2, channel: 'somechannel' } as LiveSnapshot;
    let serving = true;
    fake.tabs.connect = (_id, { name }) => {
      const p = port(name);
      setTimeout(() => {
        if (!serving) return p.onDisconnect.emit();
        p.onMessage.emit({ type: 'snapshot', snapshot: SNAP });
        serving = false;
        p.onDisconnect.emit(); // the content script went away after one snapshot
      }, 0);
      return p;
    };
    const updates: (LiveSnapshot | null)[] = [];
    const conn = connectLive((s) => updates.push(s));
    await vi.advanceTimersByTimeAsync(10);
    expect(updates).toEqual([SNAP]);
    await vi.advanceTimersByTimeAsync(4000); // retries every 2 s must not keep the stale timer from firing
    expect(updates.at(-1)).toBeNull();
    conn.dispose();
  });

  it('ignores snapshots of another version (a content script from before an update)', async () => {
    vi.useFakeTimers();
    fake.tabs.connect = (_id, { name }) => {
      const p = port(name);
      setTimeout(() => p.onMessage.emit({ type: 'snapshot', snapshot: { v: 1, channel: 'somechannel', totals: { seen: 9, filtered: 3 } } }), 0);
      return p;
    };
    const updates: (LiveSnapshot | null)[] = [];
    const conn = connectLive((s) => updates.push(s));
    await vi.advanceTimersByTimeAsync(4000);
    expect(updates).toEqual([null]); // "no chat here", once the stale timer runs out
    conn.dispose();
  });

  it('opens one Port when tab events overlap a connect in progress', async () => {
    const answers: ((tabs: { id: number; url: string }[]) => void)[] = [];
    fake.tabs.query = () => new Promise((r) => answers.push(r));
    const opened: ReturnType<typeof port>[] = [];
    fake.tabs.connect = (_id, { name }) => {
      const p = port(name);
      opened.push(p);
      return p;
    };
    const conn = connectLive(() => {});
    fake.tabs.onActivated.emit(); // the window switched tabs while the first connect waits
    for (const answer of answers) answer([{ id: 7, url: 'https://www.twitch.tv/somechannel' }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(answers).toHaveLength(2);
    expect(opened).toHaveLength(1);
    conn.dispose();
    expect(opened[0]!.disconnect).toHaveBeenCalled();
  });
});

// ───────────────────────── "Not spam" ─────────────────────────

const entry = (author: string, text: string): LogEntry => ({
  msg: { key: 'k1', author, text, ts: 0, platform: 'twitch', channel: 'somechannel' },
  verdict: { category: 'spam', action: 'collapse', reason: 'spam · 97%', source: 'model' },
});

async function rules(): Promise<UserRule[]> {
  return mergeSettings(storage[SETTINGS_KEY] as Partial<Settings> | undefined).rules;
}

function seed(r: UserRule[]): void {
  storage[SETTINGS_KEY] = { rules: r };
}

/** What the content script's rules decide for this message under the stored rules. */
async function userVerdict(author: string, text: string) {
  const e = new RuleEngine();
  e.setSettings({ rules: await rules(), trustPrivileged: true });
  const m: ChatMessage = { key: 'x', platform: 'twitch', channel: 'c', author, roles: 0, text, emotes: 0, mentions: [], isReply: false, isFirstMessage: false, paid: false, ts: 0 };
  return e.evaluate(m, normalize(m.text), 0).user;
}

describe('markNotFiltered', () => {
  const pasta =
    'I am not saying this streamer is the best player in the world but every single time he plays this map he finds a way to win the round ' +
    'against all odds and honestly chat you have to respect the grind because nobody else would sit here for twelve hours';

  it('"Allow this phrase" matches the long message it came from', async () => {
    expect(pasta.length).toBeGreaterThan(120);
    const conn = { send: vi.fn(), dispose() {} };
    const { rule } = await markNotFiltered(entry('ana', pasta), 'text', conn);
    expect(rule).toMatchObject({ kind: 'word', mode: 'allow', enabled: true, pattern: pasta });
    expect(await userVerdict('bob', pasta)).toBe('allow');
    expect(conn.send).toHaveBeenCalledWith({ type: 'feedback', key: 'k1', label: 'clean' });
  });

  it('cuts only past 500 characters, and then at a word boundary', () => {
    const long = `${'word '.repeat(120)}end`;
    const p = allowPhrase(long);
    expect(p.length).toBeLessThanOrEqual(500);
    expect(long.startsWith(p)).toBe(true);
    expect(p.endsWith('word')).toBe(true);
    expect(allowPhrase('  a   b\tc ')).toBe('a b c');
  });

  it('turns the user’s block rule for the author into an allow rule, and Undo restores it', async () => {
    const block: UserRule = { id: 'mine', kind: 'user', pattern: '@Spammer', mode: 'block', enabled: true };
    const other: UserRule = { id: 'other', kind: 'word', pattern: 'giveaway', mode: 'block', enabled: true };
    seed([block, other]);
    const res = await markNotFiltered(entry('spammer', 'buy my course'), 'author');
    expect(res.rule).toMatchObject({ id: 'mine', mode: 'allow', enabled: true });
    expect(await rules()).toEqual([{ ...block, mode: 'allow' }, other]);
    expect(await userVerdict('spammer', 'buy my course')).toBe('allow');

    await res.undo();
    expect(await rules()).toEqual([block, other]); // the user's own rule is back, not deleted
    expect(await userVerdict('spammer', 'buy my course')).toBe('block');
  });

  it('re-enables a disabled allow rule; an enabled one is left alone and Undo does nothing', async () => {
    seed([{ id: 'a', kind: 'user', pattern: 'ana', mode: 'allow', enabled: false }]);
    const first = await markNotFiltered(entry('Ana', 'hi'), 'author');
    expect(await rules()).toEqual([{ id: 'a', kind: 'user', pattern: 'ana', mode: 'allow', enabled: true }]);

    const again = await markNotFiltered(entry('Ana', 'hi'), 'author');
    expect(again.rule.id).toBe('a');
    await again.undo();
    expect((await rules())[0]!.enabled).toBe(true);

    await first.undo();
    expect((await rules())[0]!.enabled).toBe(false);
  });

  it('adds a new allow rule when none exists, and Undo removes only that one', async () => {
    seed([{ id: 'x', kind: 'word', pattern: 'kekw', mode: 'highlight', enabled: true }]);
    const res = await markNotFiltered(entry('zed', 'hello there'), 'author');
    expect(await rules()).toHaveLength(2);
    expect(res.rule).toMatchObject({ kind: 'user', pattern: 'zed', mode: 'allow' });
    await res.undo();
    expect(await rules()).toEqual([{ id: 'x', kind: 'word', pattern: 'kekw', mode: 'highlight', enabled: true }]);
  });
});
