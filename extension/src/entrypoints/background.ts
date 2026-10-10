// Background service worker: routes classify traffic between content-script
// Ports and the offscreen inference host, relays model status, aggregates
// per-tab perf for the UI, opens the side panel / onboarding.
//
// Stateless-ish by design (MV3 SWs die after ~30 s idle): Ports from open
// chats keep it alive; when it restarts, content scripts reconnect and the
// offscreen document is asked to reconnect (or re-created).

import { PORT_CLASSIFY, type RuntimeMessage } from '../core/protocol';
import { loadSettings, onSettingsChanged } from '../core/settings';
import type { ModelStatus, PerfStats } from '../core/types';
import { InferenceHub, type PortLike } from '../inference/hub';
import { MSG_OFFSCREEN_HELLO, PORT_OFFSCREEN } from '../inference/messages';

const OFFSCREEN_PATH = 'offscreen.html';
const STATUS_KEY = 'hush.modelStatus';

type TabPerf = PerfStats & { platform?: string; channel?: string; counts?: Record<string, number> };

export default defineBackground(() => {
  let creating: Promise<void> | null = null;

  async function hasOffscreen(): Promise<boolean> {
    const url = chrome.runtime.getURL(OFFSCREEN_PATH);
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [url],
    });
    return ctxs.length > 0;
  }

  async function ensureOffscreen(): Promise<void> {
    if (await hasOffscreen()) {
      // Exists (e.g. SW restarted): make it reconnect its Port.
      chrome.runtime.sendMessage({ type: MSG_OFFSCREEN_HELLO }).catch(() => {});
      return;
    }
    creating ??= chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Runs the on-device chat classifier (ONNX Runtime Web in a Worker).',
      })
      .catch((e: unknown) => {
        // Lost a race with another createDocument call: fine.
        if (!/single offscreen/i.test(String((e as Error)?.message ?? e))) throw e;
      })
      .finally(() => {
        creating = null;
      });
    await creating;
  }

  const hub = new InferenceHub({
    ensureOffscreen,
    broadcast: (m) => {
      chrome.runtime.sendMessage(m).catch(() => {
        /* no extension page open */
      });
    },
    saveStatus: (s) => {
      chrome.storage.session.set({ [STATUS_KEY]: s }).catch(() => {});
    },
  });

  chrome.storage.session
    .get(STATUS_KEY)
    .then((r) => hub.restoreStatus(r[STATUS_KEY] as ModelStatus | undefined))
    .catch(() => {});

  // GPU preference from settings.
  loadSettings()
    .then((s) => hub.setDevice(s.preferGpu ? 'auto' : 'wasm'))
    .catch(() => {});
  onSettingsChanged((s) => hub.setDevice(s.preferGpu ? 'auto' : 'wasm'));

  // If an offscreen document survived a SW restart, reattach right away.
  hasOffscreen()
    .then((yes) => {
      if (yes) chrome.runtime.sendMessage({ type: MSG_OFFSCREEN_HELLO }).catch(() => {});
    })
    .catch(() => {});

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === PORT_CLASSIFY) hub.addClient(port as unknown as PortLike);
    else if (port.name === PORT_OFFSCREEN) {
      if (port.sender?.url && !port.sender.url.startsWith(chrome.runtime.getURL(OFFSCREEN_PATH))) return;
      hub.attachOffscreen(port as unknown as PortLike);
    }
  });

  // ── per-tab perf (content scripts report ~1/s) ──
  const perf = new Map<number, { stats: TabPerf; at: number }>();
  chrome.tabs.onRemoved.addListener((tabId) => perf.delete(tabId));

  async function perfForUi(): Promise<{ stats: TabPerf; inference: unknown } | null> {
    let best: { stats: TabPerf; at: number } | undefined;
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id !== undefined) best = perf.get(tab.id);
    } catch {
      /* ignore */
    }
    if (!best) for (const p of perf.values()) if (!best || p.at > best.at) best = p;
    hub.requestStats();
    if (!best) return hub.stats ? { stats: emptyPerf(hub.stats), inference: hub.stats } : null;
    return { stats: best.stats, inference: hub.stats };
  }

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const msg = raw as RuntimeMessage | { type?: string; windowId?: number };
    switch (msg?.type) {
      case 'hush:getStatus':
        void hub.kick();
        sendResponse({ ...hub.getStatus(), perf: hub.stats ?? undefined });
        return false;
      case 'hush:perf': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined && 'stats' in msg) perf.set(tabId, { stats: msg.stats as TabPerf, at: Date.now() });
        return false;
      }
      case 'hush:getPerf':
        perfForUi().then(sendResponse, () => sendResponse(null));
        return true;
      case 'hush:openSidePanel': {
        // Must call sidePanel.open synchronously inside the user-gesture-carrying message.
        const tab = sender.tab;
        const windowId = (msg as { windowId?: number }).windowId ?? tab?.windowId;
        const p =
          tab?.id !== undefined
            ? chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId })
            : windowId !== undefined
              ? chrome.sidePanel.open({ windowId })
              : Promise.reject(new Error('no window'));
        p.then(
          () => sendResponse({ ok: true }),
          (e: unknown) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }),
        );
        return true;
      }
    }
    return false;
  });

  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      void chrome.tabs.create({ url: chrome.runtime.getURL('/onboarding.html') });
    }
  });
});

function emptyPerf(s: { inferPerSec: number; cacheHitRate: number; p50ms: number; p95ms: number; queue: number }): TabPerf {
  return { msgsPerSec: 0, inferPerSec: s.inferPerSec, cacheHitRate: s.cacheHitRate, p50ms: s.p50ms, p95ms: s.p95ms, queue: s.queue };
}
