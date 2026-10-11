import { fnv1a } from './hash';
import type { Action, Category, Platform } from './types';

export type PresetId = 'raw' | 'chill' | 'focus' | 'questions' | 'custom';

/** Which UI the bar, popup and side panel show. UI only: filtering is the same in both. */
export type UiMode = 'basic' | 'advanced';

/** What Basic offers: Off, Clean (preset 'chill') or Quiet (preset 'focus'). */
export type BasicLevel = 'off' | 'chill' | 'focus';

export interface UserRule {
  id: string;
  kind: 'word' | 'regex' | 'user';
  pattern: string;
  /** 'block' hides matching messages, 'allow' always shows them. */
  mode: 'block' | 'allow' | 'highlight';
  enabled: boolean;
}

export interface EngineFilter {
  id: string;
  /**
   * What to look for, as written by the user: a yes/no question about "this
   * message", or the end of "Hide messages that …" (see engineQuestion).
   */
  question: string;
  action: Action;
  enabled: boolean;
  /** Short name for lists and verdict reasons ("Backseating"); derived from the question when missing. */
  label?: string;
  /** Id of the built-in preset this filter was added from. */
  preset?: string;
}

export interface EngineSettings {
  enabled: boolean;
  url: string;
  /** Natural-language custom filters answered by the decision model. */
  filters: EngineFilter[];
  /** Ask the engine for a second opinion when the local model is unsure. */
  refineUncertain: boolean;
  /** Stream context per channel ("Streamer is playing Elden Ring, no spoilers"), keyed by channelKey(). */
  contexts: Record<string, string>;
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
  /** Which UI the bar, popup and side panel show. UI only: filtering is the same in both modes. */
  uiMode: UiMode;
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
  engine: { enabled: false, url: 'http://127.0.0.1:7377', filters: [], refineUncertain: true, contexts: {} },
  preferGpu: true,
  uiMode: 'basic',
};

export const SETTINGS_KEY = 'tiho.settings.v1';

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(stored ?? {}) } as Settings;
  s.sites = { ...DEFAULT_SETTINGS.sites, ...(stored?.sites ?? {}) };
  s.actions = { ...DEFAULT_SETTINGS.actions, ...(stored?.actions ?? {}) };
  s.engine = { ...DEFAULT_SETTINGS.engine, ...(stored?.engine ?? {}) };
  if (!Array.isArray(s.engine.filters)) s.engine.filters = [];
  if (!s.engine.contexts || typeof s.engine.contexts !== 'object') s.engine.contexts = {};
  // Installs from before the modes (no uiMode) and unknown values land in Basic.
  s.uiMode = stored?.uiMode === 'advanced' ? 'advanced' : 'basic';
  return s;
}

// ── Basic mode ──
//
// Basic offers one choice, a level; Advanced has the presets, actions and
// everything else. Both edit the same settings, so a level is read back from
// them, and what Advanced set up that Basic cannot show is named in plain words.

/**
 * The Basic level these settings amount to: 'off' when Tiho is off (or off on
 * `platform`), the preset when it is Clean or Quiet, null for any other setup
 * (Raw, Questions or custom: "a custom setup from Advanced mode").
 */
export function basicLevel(s: Settings, platform?: Platform): BasicLevel | null {
  if (!s.enabled || (platform && s.sites[platform] === false)) return 'off';
  return s.preset === 'chill' || s.preset === 'focus' ? s.preset : null;
}

/**
 * The settings patch that picks a level, saved in one go: 'off' turns Tiho
 * off; Clean and Quiet turn it on, and on `platform` too when given (the site
 * of the chat the viewer is looking at), with the preset and its actions.
 */
export function levelPatch(s: Settings, level: BasicLevel, platform?: Platform): Partial<Settings> {
  if (level === 'off') return { enabled: false };
  const patch: Partial<Settings> = { enabled: true, preset: level, actions: { ...PRESETS[level] } };
  if (platform) patch.sites = { ...s.sites, [platform]: true };
  return patch;
}

/**
 * Advanced settings that still apply in Basic, in plain words ("your rules",
 * "custom AI filters", "strictness"); empty for a fresh install.
 */
export function advancedExtras(s: Settings): string[] {
  const out: string[] = [];
  if (s.rules.some((r) => r.enabled)) out.push('your rules');
  if (activeFilters(s.engine).length) out.push('custom AI filters');
  if (s.strictness !== DEFAULT_SETTINGS.strictness) out.push('strictness');
  return out;
}

// ── Tiho Engine custom filters ──
//
// A filter is stored as the user wrote it; what the engine is asked and the
// key its answers travel under are derived from that text, so editing a
// filter never reuses answers given to the old wording.

/** "Is this …", "Does it …" — but not "are backseating …", which completes "messages that". */
const QUESTION_START = /^(?:is|are|does|do|did|has|have|can|could|would|will|should|was|were)\s+(?:this|it|the|that|there|these|they|someone|anyone)\b/i;
const MESSAGES_THAT = /^(?:(?:hide|dim|fold|collapse|highlight)\s+)?(?:(?:chat|live[- ]chat)\s+)?messages?\s+(?:that|which|who|where)\s+/i;

/** The yes/no question the engine is asked for a filter. */
export function engineQuestion(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.endsWith('?')) return t;
  if (QUESTION_START.test(t)) return `${t}?`;
  const phrase = t.replace(MESSAGES_THAT, '').replace(/[.!\s]+$/, '');
  return `Chat messages that ${phrase}: is this message one of them?`;
}

/** Key a filter's answers travel under (engine request id, content-side score map). */
export function filterKey(f: Pick<EngineFilter, 'question'>): string {
  return `f${fnv1a(engineQuestion(f.question)).toString(36)}`;
}

/** Short human-readable name: the label, or the question without its "Is this message …" frame. */
export function filterLabel(f: Pick<EngineFilter, 'question' | 'label'>, max = 32): string {
  let t = f.label?.trim();
  if (!t) {
    t = f.question
      .trim()
      .replace(/\s+/g, ' ')
      .replace(MESSAGES_THAT, '')
      .replace(/^(?:is|does)\s+(?:this|the)\s+(?:chat\s+)?message\s+(?:about\s+)?/i, '')
      .replace(/^(?:is|does)\s+it\s+/i, '')
      .replace(/[?.!:\s]+$/, '');
  }
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Filters the engine should answer right now (engine on, filter on, non-empty). */
export function activeFilters(e: EngineSettings): EngineFilter[] {
  return e.enabled ? e.filters.filter((f) => f.enabled && f.question.trim()) : [];
}

/** Key for per-channel engine settings ("twitch/xqc"). */
export function channelKey(platform: string, channel: string): string {
  return `${platform}/${channel.trim().toLowerCase()}`;
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
