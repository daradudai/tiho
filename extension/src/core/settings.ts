import type { Action, Category, Platform } from './types';

export type PresetId = 'raw' | 'chill' | 'focus' | 'questions' | 'custom';

export interface UserRule {
  id: string;
  kind: 'word' | 'regex' | 'user';
  pattern: string;
  /** 'block' hides matching messages, 'allow' always shows them. */
  mode: 'block' | 'allow' | 'highlight';
  enabled: boolean;
}

export interface EngineSettings {
  enabled: boolean;
  url: string;
  /** Natural-language custom filters answered by the decision model. */
  filters: { id: string; question: string; action: Action; enabled: boolean }[];
  /** Ask the engine for a second opinion when the local model is unsure. */
  refineUncertain: boolean;
}

export interface Settings {
  enabled: boolean;
  sites: Record<Platform, boolean>;
  preset: PresetId;
  /** Action per category. */
  actions: Record<Category, Action>;
  /** 0 (lenient) .. 1 (strict). Shifts all model thresholds. */
  strictness: number;
  /** Collapse waves (many users posting the same thing) into one counter line. */
  collapseWaves: boolean;
  /** Hold new messages up to this many ms waiting for the model (0 = never hold). */
  holdMs: number;
  /** Never filter broadcaster / mods / VIPs. */
  trustPrivileged: boolean;
  /** Show category tint + reason tooltip on messages. */
  decorate: boolean;
  /** Show the in-chat bar. */
  showBar: boolean;
  rules: UserRule[];
  engine: EngineSettings;
  /** Prefer WebGPU when available. */
  preferGpu: boolean;
}

export const PRESETS: Record<Exclude<PresetId, 'custom'>, Record<Category, Action>> = {
  raw: { toxic: 'show', scam: 'show', spam: 'show', noise: 'show', negative: 'show', question: 'show', positive: 'show', clean: 'show' },
  chill: { toxic: 'hide', scam: 'hide', spam: 'collapse', noise: 'show', negative: 'show', question: 'highlight', positive: 'show', clean: 'show' },
  focus: { toxic: 'hide', scam: 'hide', spam: 'hide', noise: 'hide', negative: 'dim', question: 'highlight', positive: 'show', clean: 'show' },
  questions: { toxic: 'hide', scam: 'hide', spam: 'hide', noise: 'hide', negative: 'hide', question: 'highlight', positive: 'dim', clean: 'dim' },
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  sites: { youtube: true, twitch: true, kick: true },
  preset: 'chill',
  actions: { ...PRESETS.chill },
  strictness: 0.5,
  collapseWaves: true,
  holdMs: 250,
  trustPrivileged: true,
  decorate: true,
  showBar: true,
  rules: [],
  engine: { enabled: false, url: 'http://127.0.0.1:7377', filters: [], refineUncertain: true },
  preferGpu: true,
};

export const SETTINGS_KEY = 'hush.settings.v1';

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(stored ?? {}) } as Settings;
  s.sites = { ...DEFAULT_SETTINGS.sites, ...(stored?.sites ?? {}) };
  s.actions = { ...DEFAULT_SETTINGS.actions, ...(stored?.actions ?? {}) };
  s.engine = { ...DEFAULT_SETTINGS.engine, ...(stored?.engine ?? {}) };
  return s;
}

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(r[SETTINGS_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = mergeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const fn = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[SETTINGS_KEY]) cb(mergeSettings(changes[SETTINGS_KEY].newValue as Partial<Settings> | undefined));
  };
  chrome.storage.onChanged.addListener(fn);
  return () => chrome.storage.onChanged.removeListener(fn);
}
