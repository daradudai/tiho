// Background service worker: routes classify traffic between content-script
// Ports and the offscreen inference host, relays model status, aggregates
// per-tab perf for the UI, opens the side panel / onboarding, and injects the
// content script into chats that were open when Tiho was installed or updated.
// When the optional Tiho Engine is on, it also forwards scored texts to it (the
// engine only accepts extension origins, so content scripts cannot call it) and
// answers the UI's engine status / "Test filter" requests.
//
// Stateless-ish by design (MV3 SWs die after ~30 s idle): Ports from open
// chats keep it alive; when it restarts, content scripts reconnect and the
// offscreen document is asked to reconnect (or re-created).

import { MatchPattern } from 'wxt/utils/match-patterns';
import { PORT_CLASSIFY, type EngineStatus, type RuntimeMessage } from '../core/protocol';
import { loadSettings, onSettingsChanged, type Settings } from '../core/settings';
import type { ModelStatus, PerfStats } from '../core/types';
import { EngineClient } from '../engine-client/client';
import { EngineRouter } from '../engine-client/router';
import { InferenceHub, type PortLike } from '../inference/hub';
import { MSG_OFFSCREEN_HELLO, PORT_OFFSCREEN } from '../inference/messages';

const OFFSCREEN_PATH = 'offscreen.html';
const STATUS_KEY = 'tiho.modelStatus';

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

  const broadcast = (m: RuntimeMessage) => {
    chrome.runtime.sendMessage(m).catch(() => {
      /* no extension page open */
    });
  };

  // per-tab perf (content scripts report ~1/s); also tells the engine router which channel a tab shows
  const perf = new Map<number, { stats: TabPerf; at: number }>();
  chrome.tabs.onRemoved.addListener((tabId) => perf.delete(tabId));

  const engine = new EngineClient({
    onStatus: (status: EngineStatus) => broadcast({ type: 'tiho:engine:status', status }),
  });

  const hub = new InferenceHub({
    ensureOffscreen,
    broadcast,
    saveStatus: (s) => {
      chrome.storage.session.set({ [STATUS_KEY]: s }).catch(() => {});
    },
    onScores: (r) => router.onLocalScores(r),
  });

  const router = new EngineRouter({
    client: engine,
    thresholds: () => hub.getStatus().thresholds,
    tabInfo: (tabId) => perf.get(tabId)?.stats,
  });

  chrome.storage.session
    .get(STATUS_KEY)
    .then((r) => hub.restoreStatus(r[STATUS_KEY] as ModelStatus | undefined))
    .catch(() => {});

  // GPU preference and Tiho Engine from settings.
  const applySettings = (s: Settings) => {
    hub.setDevice(s.preferGpu ? 'auto' : 'wasm');
    engine.configure(s.engine.enabled, s.engine.url);
    router.setSettings(s);
  };
  const settingsLoaded = loadSettings()
    .then(applySettings)
    .catch(() => {});
  onSettingsChanged(applySettings);

  async function engineStatus(fresh: boolean): Promise<EngineStatus> {
    await settingsLoaded;
    const s = engine.status;
    return fresh || s.state === 'connecting' ? engine.check() : s;
  }

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
      case 'tiho:getStatus':
        void hub.kick();
        sendResponse({ ...hub.getStatus(), perf: hub.stats ?? undefined });
        return false;
      case 'tiho:reloadModel':
        hub.reload();
        return false;
      case 'tiho:perf': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined && 'stats' in msg) perf.set(tabId, { stats: msg.stats as TabPerf, at: Date.now() });
        return false;
      }
      case 'tiho:getPerf':
        perfForUi().then(sendResponse, () => sendResponse(null));
        return true;
      case 'tiho:engine:getStatus':
        engineStatus(!!(msg as { fresh?: boolean }).fresh).then(sendResponse, () => sendResponse(null));
        return true;
      case 'tiho:engine:test': {
        // extension pages only (the side panel), never content scripts
        if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
        const { text, filters, context, platform } = msg as Extract<RuntimeMessage, { type: 'tiho:engine:test' }>;
        settingsLoaded
          .then(() => engine.test({ text, filters, context, platform }))
          .then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }));
        return true;
      }
      case 'tiho:openSidePanel': {
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
    if (details.reason === 'install' || details.reason === 'update') void injectOpenChats();
  });
});

/**
 * Chrome runs content scripts only in pages loaded after Tiho was installed,
 * and an update cuts the copies already running off from the extension (they
 * stop themselves). Inject the manifest's content scripts into the chat frames
 * open now, so those chats filter again without a reload. A frame that gets
 * the script twice (it was still loading during the install) runs only the
 * newer copy (chat.content.ts). Chats embedded in other sites (a Twitch embed,
 * YouTube Studio) start with their next page load.
 */
async function injectOpenChats(): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const cs of chrome.runtime.getManifest().content_scripts ?? []) {
    if (!cs.js?.length || !cs.matches?.length) continue;
    const patterns = cs.matches.map((m) => new MatchPattern(m));
    // whole sites, not just the matched paths: YouTube's chat is a frame of the watch page
    const sites = [...new Set(cs.matches.map((m) => m.replace(/^(.*?:\/\/[^/]*)\/.*$/, '$1/*')))];
    const tabs = await chrome.tabs.query({ url: sites, discarded: false }).catch(() => []);
    for (const tab of tabs) if (tab.id !== undefined) jobs.push(injectChatFrames(tab.id, cs.js, patterns, !!cs.all_frames));
  }
  await Promise.all(jobs);
}

/** Inject `files` into the frames of a tab whose URL matches one of `patterns`. */
async function injectChatFrames(tabId: number, files: string[], patterns: MatchPattern[], allFrames: boolean): Promise<void> {
  const isChat = (url?: string) => !!url && patterns.some((p) => p.includes(url));
  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames }, func: () => location.href });
    const documentIds = frames.filter((f) => isChat(f.result)).map((f) => f.documentId);
    if (documentIds.length) await chrome.scripting.executeScript({ target: { tabId, documentIds }, files });
  } catch (e) {
    // closed, navigated away or showing an error page meanwhile: it gets the script on its next load
    console.warn(`[tiho] could not inject into tab ${tabId}:`, e);
  }
}

function emptyPerf(s: { inferPerSec: number; cacheHitRate: number; p50ms: number; p95ms: number; queue: number }): TabPerf {
  return { msgsPerSec: 0, inferPerSec: s.inferPerSec, cacheHitRate: s.cacheHitRate, p50ms: s.p50ms, p95ms: s.p95ms, queue: s.queue };
}
