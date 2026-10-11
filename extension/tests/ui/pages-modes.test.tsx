// Extension pages in Basic and Advanced mode (docs/ux-modes.md, C1–C8): the
// Basic popup and side panel have one choice and no numbers, Advanced counts
// only what the chat holds now, Solo and Show hidden reach the tab.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESETS, SETTINGS_KEY, mergeSettings, type Settings } from '../../src/core/settings';
import type { InChat } from '../../src/core/store';
import { SNAPSHOT_V, type LiveSnapshot } from '../../src/ui/bridge';
import { settings, settingsReady } from '../../src/ui/kit/kit';
import { plainModelStatus } from '../../src/ui/model-status';
import { OnboardingApp } from '../../src/ui/onboarding/OnboardingApp';
import { PopupApp } from '../../src/ui/popup/PopupApp';
import { SidePanelApp } from '../../src/ui/sidepanel/SidePanelApp';

// ───────────────────────── a small chrome.* fake ─────────────────────────
// One fake for the whole file: the pages keep module state (settings
// listener, the side panel's live connection) across renders, as they would
// across one session.

type Fn = (...a: any[]) => unknown;

function event() {
  const ls = new Set<Fn>();
  return {
    addListener: (f: Fn) => void ls.add(f),
    removeListener: (f: Fn) => void ls.delete(f),
    emit: (...a: unknown[]) => [...ls].map((f) => f(...a)),
  };
}

function port(name: string) {
  const p = { name, sent: [] as any[], onMessage: event(), onDisconnect: event(), postMessage: (m: unknown) => void p.sent.push(m), disconnect: vi.fn() };
  return p;
}

const storage: Record<string, unknown> = {};
let snapshot: LiveSnapshot | null = null;
let lastPort: ReturnType<typeof port> | null = null;
const onChanged = event();
const set = vi.fn(async (o: Record<string, unknown>) => {
  const changes: Record<string, { newValue: unknown }> = {};
  for (const [k, v] of Object.entries(o)) {
    storage[k] = structuredClone(v);
    changes[k] = { newValue: structuredClone(v) };
  }
  onChanged.emit(changes, 'local');
});

beforeAll(() => {
  vi.stubGlobal('chrome', {
    runtime: { id: 'hush-test', lastError: undefined, onMessage: event(), onConnect: event(), sendMessage: async () => undefined, getManifest: () => ({ version: '0.1.0' }) },
    storage: { local: { get: async (k: string) => (k in storage ? { [k]: structuredClone(storage[k]) } : {}), set }, onChanged },
    tabs: {
      query: async () => [{ id: 7, url: 'https://www.twitch.tv/somechannel' }],
      sendMessage: async (_id: number, m: { type: string }) => (m.type === 'hush:getSnapshot' ? snapshot : undefined),
      connect: (_id: number, { name }: { name: string }) => (lastPort = port(name)),
      onActivated: event(),
      onUpdated: event(),
    },
    sidePanel: { open: async () => {} },
  });
});
afterAll(() => vi.unstubAllGlobals());

const IN_CHAT: InChat = {
  rows: 152,
  hidden: 9,
  folded: 4,
  inWaves: 20,
  byCat: { toxic: 1, scam: 0, spam: 8, noise: 30, negative: 12, question: 3, positive: 18, clean: 60 },
};

function snap(over: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    v: SNAPSHOT_V,
    platform: 'twitch',
    channel: 'somechannel',
    theme: 'dark',
    enabled: true,
    model: { state: 'ready', backend: 'webgpu', modelId: 'hush-lite/q8', version: 'v2-6L' },
    perf: { msgsPerSec: 3, inferPerSec: 2, cacheHitRate: 0.5, p50ms: 6, p95ms: 14, queue: 0 },
    inChat: IN_CHAT,
    peek: false,
    solo: null,
    rate: new Array(60).fill(3),
    vibe: new Array(60).fill(0),
    waves: [],
    questions: [],
    filtered: [],
    ts: Date.now() + 1,
    ...over,
  };
}

/** Stored settings, read by the page as if from chrome.storage. */
function stored(patch: Partial<Settings>): Settings {
  const s = mergeSettings(patch);
  storage[SETTINGS_KEY] = s;
  settings.value = s;
  settingsReady.value = true;
  return s;
}

const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

let el: HTMLElement;
beforeEach(() => {
  el = document.createElement('div');
  document.body.appendChild(el);
  snapshot = null;
  set.mockClear();
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  render(null, el);
  el.remove();
});

const byText = (sel: string, text: string) => [...el.querySelectorAll<HTMLElement>(sel)].find((b) => b.textContent?.trim() === text);

describe('popup, Basic', () => {
  it('has the three levels, the Advanced mode switch and the privacy line, and no number, toggle, chart, slider or side panel button (C1)', async () => {
    stored({ uiMode: 'basic' });
    await act(() => render(<PopupApp />, el));
    await tick();
    const radios = [...el.querySelectorAll('[role="radiogroup"] [role="radio"]')];
    expect(radios.map((r) => r.textContent)).toEqual(['Off', 'Clean', 'Quiet']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    const switches = [...el.querySelectorAll('[role="switch"]')];
    expect(switches.map((s) => s.getAttribute('aria-label'))).toEqual(['Advanced mode']); // no master toggle: Off is a level
    expect(el.textContent).toContain('Cleaning up Twitch chat');
    expect(el.textContent).toContain('Runs on your computer. Nothing leaves it.');
    expect(el.textContent).toContain('Hides insults, scams and spam. Questions stand out.');
    expect(el.textContent).not.toMatch(/\d|%/);
    expect(el.querySelector('.spark, input[type="range"]')).toBeNull();
    expect(byText('button', 'Side panel')).toBeUndefined();
  });

  it('picking Clean on a Twitch tab with Twitch off turns Twitch on and sets the preset in one save (C2)', async () => {
    stored({ uiMode: 'basic', preset: 'focus', actions: { ...PRESETS.focus }, sites: { youtube: true, twitch: false, kick: true } });
    await act(() => render(<PopupApp />, el));
    await tick();
    expect(el.textContent).toContain('Hush is off on Twitch');
    expect(el.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Off');
    await act(() => byText('[role="radio"]', 'Clean')!.click());
    await tick();
    expect(set).toHaveBeenCalledTimes(1);
    const saved = set.mock.calls[0][0][SETTINGS_KEY] as Settings;
    expect(saved).toMatchObject({ enabled: true, preset: 'chill', actions: PRESETS.chill, sites: { youtube: true, twitch: true, kick: true }, uiMode: 'basic' });
  });

  it('says so when the setup is custom, and names what Advanced mode still applies', async () => {
    stored({ uiMode: 'basic', preset: 'custom', rules: [{ id: 'r', kind: 'word', pattern: 'spoiler', mode: 'block', enabled: true }] });
    await act(() => render(<PopupApp />, el));
    await tick();
    expect(el.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
    expect(el.textContent).toContain("You're using a custom setup from Advanced mode. Pick a level to replace it.");
    expect(el.textContent).toContain('Also on from Advanced mode: your rules.');
  });

  it('turning on Advanced mode changes only the mode', async () => {
    const before = stored({ uiMode: 'basic' });
    await act(() => render(<PopupApp />, el));
    await tick();
    await act(() => (el.querySelector('[role="switch"]') as HTMLElement).click());
    await tick();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0][SETTINGS_KEY]).toEqual({ ...before, uiMode: 'advanced' });
    expect(el.querySelector('.pp-kpis, .pp-presets')).not.toBeNull(); // re-rendered as Advanced
  });
});

describe('popup, Advanced', () => {
  it('counts what the chat holds now: no "hushed", first KPI hidden + folded, presets Raw / Clean / Quiet / Questions (C3)', async () => {
    stored({ uiMode: 'advanced' });
    snapshot = snap();
    await act(() => render(<PopupApp />, el));
    await tick();
    await tick();
    const kpis = [...el.querySelectorAll('.pp-kpi')].map((k) => [k.querySelector('b')?.textContent, k.querySelector('span')?.textContent]);
    expect(kpis[0]).toEqual(['13', 'hidden in chat now']);
    expect(kpis.map((k) => k[1])).toEqual(['hidden in chat now', 'msgs/s now', 'mood']);
    expect(el.textContent).not.toMatch(/hushed|vibe/i);
    expect(el.textContent).toContain('last 60 s');
    expect(el.querySelector('.pp-strip .k-label')?.textContent).toBe('In chat now');
    expect([...el.querySelectorAll('.pp-preset b')].map((b) => b.textContent)).toEqual(['Raw', 'Clean', 'Quiet', 'Questions']);
    expect(byText('button', 'Side panel')).toBeDefined();
    expect(el.querySelector('[role="switch"][aria-label="Advanced mode"]')?.getAttribute('aria-checked')).toBe('true');
  });
});

describe('side panel', () => {
  it('in Basic is one page without tabs, and shows the tabs at once when Advanced mode is turned on (C4)', async () => {
    stored({ uiMode: 'basic' });
    await act(() => render(<SidePanelApp />, el));
    await tick();
    expect(el.querySelector('[role="tablist"]')).toBeNull();
    expect([...el.querySelectorAll('[role="radio"]')].map((r) => r.querySelector('b')?.firstChild?.textContent)).toEqual(['Off', 'Clean', 'Quiet']);
    expect(el.textContent).toContain('Recommended');
    expect(el.textContent).toContain('Adds live stats, the questions inbox, the hidden-messages log, rules and custom AI filters.');
    expect(el.textContent).not.toMatch(/\d|%/);
    await act(() => (el.querySelector('[role="switch"][aria-label="Advanced mode"]') as HTMLElement).click());
    expect(el.querySelector('[role="tablist"]')).not.toBeNull();
  });

  it('Live: the hero counts the chat now, Only on Spam sends Solo and stays pressed through the next snapshot (C5, C6)', async () => {
    stored({ uiMode: 'advanced' });
    await act(() => render(<SidePanelApp initialTab="live" />, el));
    await tick();
    await act(() => void lastPort!.onMessage.emit({ type: 'snapshot', snapshot: snap() }));

    const hero = el.querySelector('.sp-hero')!;
    expect(hero.textContent).toContain('In chat now');
    expect(hero.querySelector('.sp-hero-num')?.textContent).toBe('13hidden or folded');
    expect(hero.textContent).toContain('9 hidden · 4 folded · 152 messages');
    expect(hero.textContent).not.toContain('%');
    expect(el.querySelector('.sp-ring')).toBeNull();
    // every other number says what it covers
    for (const w of ['last 60 s', 'last 5 min', 'in chat now', 'recent', 'now', 'since this chat opened']) expect(el.textContent).toContain(w);

    const spam = () => el.querySelector('.sp-cat[data-c="spam"] .sp-only') as HTMLButtonElement;
    expect(spam().textContent).toBe('Only');
    await act(() => spam().click());
    expect(lastPort!.sent.at(-1)).toEqual({ type: 'solo', cat: 'spam' });
    expect(spam().textContent).toBe('Show all');
    expect(spam().getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('.sp-solo')?.textContent).toContain('Only Spam in chat');

    await act(() => void lastPort!.onMessage.emit({ type: 'snapshot', snapshot: snap({ solo: 'spam', ts: Date.now() + 5 }) }));
    expect(spam().getAttribute('aria-pressed')).toBe('true');

    // Show hidden is off while one category is shown alone; Show all ends Solo
    expect((el.querySelector('.sp-peek') as HTMLButtonElement).disabled).toBe(true);
    await act(() => spam().click());
    expect(lastPort!.sent.at(-1)).toEqual({ type: 'solo', cat: null });
    expect(spam().textContent).toBe('Only');
  });

  it('Live: Show hidden sends peek, and the buttons wait while Hush is off', async () => {
    stored({ uiMode: 'advanced' });
    await act(() => render(<SidePanelApp initialTab="live" />, el));
    await tick();
    await act(() => void lastPort!.onMessage.emit({ type: 'snapshot', snapshot: snap({ ts: Date.now() + 1 }) }));
    const peek = () => el.querySelector('.sp-peek') as HTMLButtonElement;
    expect(peek().textContent).toBe('Show hidden in chat');
    await act(() => peek().click());
    expect(lastPort!.sent.at(-1)).toEqual({ type: 'peek', on: true });
    expect(peek().textContent).toBe('Hide again');

    await act(() => void lastPort!.onMessage.emit({ type: 'snapshot', snapshot: snap({ enabled: false, ts: Date.now() + 10 }) }));
    expect(peek().disabled).toBe(true);
    expect((el.querySelector('.sp-only') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Inbox and Log say since when they count', async () => {
    stored({ uiMode: 'advanced' });
    await act(() => render(<SidePanelApp initialTab="inbox" />, el));
    await tick();
    await act(() => void lastPort!.onMessage.emit({ type: 'snapshot', snapshot: snap({ ts: Date.now() + 1 }) }));
    expect(el.querySelector('.sp-h2-sub')?.textContent).toMatch(/^\d+ asked since you opened this panel · \d+ open$/);
    await act(() => byText('[role="tab"]', 'Log')!.click());
    expect(el.querySelector('.sp-h2')?.textContent).toBe('Hidden messages');
    expect(el.querySelector('.sp-h2-sub')?.textContent).toBe('What Hush hid or folded since you opened this panel, newest first');
  });

  it('Settings starts with Mode, and switching it changes uiMode and nothing else (C7)', async () => {
    const before = stored({ uiMode: 'advanced', strictness: 0.7 });
    await act(() => render(<SidePanelApp initialTab="settings" />, el));
    await tick();
    expect(el.querySelector('.k-card .k-label')?.textContent).toBe('Mode');
    await act(() => byText('.k-seg-btn', 'Basic')!.click());
    await tick();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0][SETTINGS_KEY]).toEqual({ ...before, uiMode: 'basic' });
    expect(el.querySelector('[role="tablist"]')).toBeNull(); // now the Basic page
  });
});

describe('onboarding', () => {
  it('asks how much to hide (Clean, recommended, or Quiet), offers Advanced mode, and its demo bar has no percentage (C8)', async () => {
    // reduced motion: the demo shows "With Hush" and stays
    const g = globalThis as { matchMedia: unknown };
    const mm = g.matchMedia;
    g.matchMedia = (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} });
    try {
      stored({ uiMode: 'basic' });
      await act(() => render(<OnboardingApp />, el));
      await tick();
      const step2 = el.querySelector('.ob-presets')!;
      expect([...step2.querySelectorAll('[role="radio"] b')].map((b) => b.textContent)).toEqual(['Clean', 'Quiet']);
      expect(step2.querySelector('[aria-checked="true"]')?.textContent).toContain('Recommended');
      expect(el.querySelector('.ob-demo-bar')?.textContent).not.toMatch(/%|\d/);
      expect(el.querySelector('.ob-demo-bar')?.textContent).toContain('Show hidden');
      expect(el.textContent).not.toMatch(/Reads the room|calm meter|vibe|hushed/i);

      const box = el.querySelector('.ob-adv input') as HTMLInputElement;
      expect(box.checked).toBe(false);
      await act(() => box.click());
      await tick();
      expect((set.mock.calls.at(-1)![0][SETTINGS_KEY] as Settings).uiMode).toBe('advanced');
    } finally {
      g.matchMedia = mm;
    }
  });
});

describe('model status in plain words', () => {
  it('says something only while the model is not ready, never with a number', () => {
    expect(plainModelStatus({ state: 'downloading', backend: 'none', progress: 0.42 })).toEqual({
      text: 'Getting ready… Simple filters already work.',
      tone: 'load',
      progress: 0.42,
    });
    expect(plainModelStatus({ state: 'loading', backend: 'webgpu' })?.progress).toBeUndefined();
    expect(plainModelStatus({ state: 'error', backend: 'none', error: 'WebGPU adapter lost' })).toEqual({
      text: "Hush's AI didn't start. Simple filters still work.",
      tone: 'err',
    });
    expect(plainModelStatus({ state: 'ready', backend: 'webgpu' })).toBeNull();
    expect(plainModelStatus({ state: 'idle', backend: 'none' })).toBeNull();
    expect(plainModelStatus(null)).toBeNull();
  });
});
