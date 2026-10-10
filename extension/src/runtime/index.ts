// Content-script bootstrap: settings + store + classifier Port + engine + bar.
// Everything chrome.* lives here so the engine stays testable without an
// extension context.

import { createBarActions, type MountBar } from '../core/bar-actions';
import { loadSettings, mergeSettings, onSettingsChanged, saveSettings } from '../core/settings';
import { createStore } from '../core/store';
import type { ModelStatus } from '../core/types';
import type { RuntimeMessage } from '../core/protocol';
import type { PlatformAdapter } from '../platforms/types';
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
  const classifier = new ClassifierClient(chromePortTransport, {
    onScores: (ids) => rt?.onScores(ids),
    onFailed: (ids) => rt?.onFailed(ids),
    onStatus: (s) => rt?.setModelStatus(s),
  });

  const barActions = createBarActions({
    getSettings: () => store.settings.peek(),
    save: (patch) => saveSettings(patch).catch((e) => console.warn('[hush] save settings failed', e)),
    openSidePanel: () => void send({ type: 'hush:openSidePanel' }),
    reveal: (key) => void rt?.reveal(key),
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

  rt.start();

  const runtime = rt;
  return {
    runtime,
    stop() {
      runtime.stop();
      offSettings();
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        /* gone */
      }
      classifier.close();
    },
  };
}
