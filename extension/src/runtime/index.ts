// Content-script bootstrap: settings + store + classifier Port + engine + bar,
// and the live bridge the popup and side panel read (ui/bridge.ts serveLive).
// Everything chrome.* lives here so the engine stays testable without an
// extension context.

import { createBarActions, type MountBar } from '../core/bar-actions';
import { loadSettings, mergeSettings, onSettingsChanged, saveSettings } from '../core/settings';
import { createStore } from '../core/store';
import type { ModelStatus } from '../core/types';
import type { RuntimeMessage } from '../core/protocol';
import type { PlatformAdapter } from '../platforms/types';
import { serveLive } from '../ui/bridge';
import { ClassifierClient, chromePortTransport } from './classifier';
import { HushRuntime } from './engine';

export { HushRuntime } from './engine';
export { ClassifierClient } from './classifier';

// The in-chat bar is optional: bundle it when src/ui/bar exists, run without it otherwise.
const uiModules = import.meta.glob<{ mountBar?: MountBar }>(['../ui/bar/index.{ts,tsx}', '../ui/bar.{ts,tsx}'], {
  eager: true,
});

export function findMountBar(): MountBar | null {
  for (const m of Object.values(uiModules)) if (typeof m?.mountBar === 'function') return m.mountBar;
  return null;
}

function send(msg: RuntimeMessage): Promise<unknown> {
  try {
    return chrome.runtime.sendMessage(msg).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined); // extension context invalidated
  }
}

function asStatus(x: unknown): ModelStatus | null {
  const s = (x && typeof x === 'object' && 'status' in x ? (x as { status: unknown }).status : x) as ModelStatus | null;
  return s && typeof s === 'object' && typeof s.state === 'string' ? s : null;
}

/**
 * False once Hush was updated, disabled or removed: Chrome leaves this script
 * running in the page, cut off from the extension.
 */
function contextAlive(): boolean {
  try {
    return typeof chrome === 'undefined' || !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

const CONTEXT_CHECK_MS = 1000;

export interface StartOptions {
  adapter: PlatformAdapter;
}

export interface HushHandle {
  runtime: HushRuntime;
  stop(): void;
}

export async function startHush({ adapter }: StartOptions): Promise<HushHandle> {
  const settings = await loadSettings().catch(() => mergeSettings(undefined));
  const store = createStore(settings);

  let rt: HushRuntime | null = null;
  let statusAsked = false;
  let offLive: (() => void) | null = null;
  const classifier = new ClassifierClient(chromePortTransport, {
    onScores: (ids) => rt?.onScores(ids),
    onFailed: (ids) => rt?.onFailed(ids),
    onRescored: (ids) => rt?.onRescored(ids),
    onStatus: (s) => rt?.setModelStatus(s),
  });

  const barActions = createBarActions({
    getSettings: () => store.settings.peek(),
    save: (patch) => saveSettings(patch).catch((e) => console.warn('[hush] save settings failed', e)),
    openSidePanel: () => void send({ type: 'hush:openSidePanel' }),
    reveal: (key) => void rt?.reveal(key),
    platform: adapter.platform,
    setPeek: (on) => rt?.setPeek(on),
    setSolo: (cat) => rt?.setSolo(cat),
  });

  rt = new HushRuntime({
    adapter,
    settings,
    store,
    classifier,
    mountBar: findMountBar(),
    barActions,
    onReport: (r) => void send({ type: 'hush:perf', stats: r.stats }),
    // Open the Port (and wake the model) only once a chat is on screen:
    // SPA pages without a chat stay idle.
    onAttach: () => {
      classifier.connect();
      // Popup and side panel (hush:live, hush:getSnapshot) are answered only
      // by a frame that shows a chat, never by an empty SPA page or embed.
      if (!offLive) {
        try {
          offLive = serveLive(store, {
            reveal: (key) => void rt?.reveal(key),
            peek: (on) => rt?.setPeek(on),
            solo: (cat) => rt?.setSolo(cat),
          });
        } catch {
          /* no extension context (tests) */
        }
      }
      if (!statusAsked) {
        statusAsked = true;
        void send({ type: 'hush:getStatus' }).then((res) => {
          const s = asStatus(res);
          if (s && !classifier.status) classifier.setStatus(s);
        });
      }
    },
  });

  const onMessage = (m: unknown) => {
    if (m && typeof m === 'object' && (m as RuntimeMessage).type === 'hush:status') {
      const s = asStatus(m);
      if (s) classifier.setStatus(s);
    }
  };
  try {
    chrome.runtime.onMessage.addListener(onMessage);
  } catch {
    /* no extension context (tests) */
  }
  const offSettings = (() => {
    try {
      return onSettingsChanged((s) => rt?.setSettings(s));
    } catch {
      return () => {};
    }
  })();

  const runtime = rt;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(watch);
    runtime.stop(); // rows, list mark, stylesheet and bar go back to the page's own
    for (const off of [offLive, offSettings, () => chrome.runtime.onMessage.removeListener(onMessage)]) {
      try {
        off?.();
      } catch {
        /* extension context gone */
      }
    }
    classifier.close();
  };
  // An orphaned script would keep filtering with frozen settings and a bar
  // whose switches no longer save: stop as soon as the context is gone (the
  // classifier notices first when it tries to reconnect).
  const watch = setInterval(() => {
    if (classifier.dead || !contextAlive()) stop();
  }, CONTEXT_CHECK_MS);

  rt.start();

  return { runtime, stop };
}
