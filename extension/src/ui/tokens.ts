// Hush design tokens (JS side). The CSS side lives in tokens.css; the two are
// kept in sync by tests/ui/tokens.test.ts. Use CSS variables in components and
// these values only where a raw color is needed (decorations injected into the
// host page, canvas, generated icons).

import type { Action, Category } from '../core/types';
import type { BasicLevel, PresetId } from '../core/settings';

export type Theme = 'dark' | 'light';

export interface CategoryMeta {
  label: string;
  /** One line, shown in menus and the side panel. */
  desc: string;
  color: Record<Theme, string>;
}

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  toxic: { label: 'Toxic', desc: 'Insults, harassment, hate, threats', color: { dark: '#ff6470', light: '#d42f42' } },
  scam: { label: 'Scam', desc: 'Bots, self-promo, crypto & "free" links', color: { dark: '#ff9452', light: '#c9560f' } },
  spam: { label: 'Spam', desc: 'Floods, copypasta, emote walls', color: { dark: '#edc04f', light: '#9c7400' } },
  noise: { label: 'Noise', desc: 'One-word reactions, "W", "L", commands', color: { dark: '#98a2b6', light: '#667085' } },
  negative: { label: 'Negative', desc: 'Complaints and criticism, no abuse', color: { dark: '#ee7bc2', light: '#bc3185' } },
  question: { label: 'Questions', desc: 'Genuine questions to the streamer or chat', color: { dark: '#5ab2ff', light: '#1a72d1' } },
  positive: { label: 'Positive', desc: 'Kind, supportive, hype', color: { dark: '#4cd69a', light: '#138a55' } },
  clean: { label: 'Other', desc: 'Regular chat', color: { dark: '#b9bac6', light: '#7a7b88' } },
};

/** Categories shown as chips in the compact bar (clean lives in the expanded view). */
export const CHIP_CATEGORIES: Category[] = ['toxic', 'scam', 'spam', 'noise', 'negative', 'question', 'positive'];

export const BRAND = {
  name: 'Hush',
  accent: { dark: '#8487ff', light: '#4f52e0' },
  accentSolid: { dark: '#6366f1', light: '#5457e8' },
  /** Logo gradient stops. */
  gradient: ['#7c83ff', '#a78bfa', '#5ab2ff'] as const,
} as const;

export const ACTION_META: Record<Action, { label: string; verb: string; desc: string }> = {
  show: { label: 'Show', verb: 'Shown', desc: 'Leave as is' },
  highlight: { label: 'Highlight', verb: 'Highlighted', desc: 'Make it stand out' },
  dim: { label: 'Dim', verb: 'Dimmed', desc: 'Fade it back' },
  collapse: { label: 'Fold', verb: 'Folded', desc: 'Fold into a thin "hidden" pill' },
  hide: { label: 'Hide', verb: 'Hidden', desc: 'Remove it from chat' },
};

// Words. A setting has one name on every surface (bar, popup, side panel,
// onboarding, README): the presets 'chill' and 'focus' are Basic's levels
// Clean and Quiet, and say the same thing in both modes.

export const PRESET_META: Record<Exclude<PresetId, 'custom'>, { label: string; short: string; desc: string }> = {
  raw: { label: 'Raw', short: 'Raw', desc: 'Hides nothing. Marks every message.' },
  chill: { label: 'Clean', short: 'Clean', desc: 'Hides insults, scams and spam. Questions stand out.' },
  focus: { label: 'Quiet', short: 'Quiet', desc: 'Also hides one-word replies like "W" and "LOL". Complaints are dimmed.' },
  questions: { label: 'Questions', short: 'Q&A', desc: 'Questions up front, the rest dimmed.' },
};

export const PRESET_ORDER = ['raw', 'chill', 'focus', 'questions'] as const;

/** Basic's one choice: how much Hush hides. Clean is the one to recommend. */
export const LEVEL_META: Record<BasicLevel, { label: string; desc: string; recommended?: true }> = {
  off: { label: 'Off', desc: 'Shows every message.' },
  chill: { label: PRESET_META.chill.label, desc: PRESET_META.chill.desc, recommended: true },
  focus: { label: PRESET_META.focus.label, desc: PRESET_META.focus.desc },
};

export const LEVEL_ORDER = ['off', 'chill', 'focus'] as const;

/** Sentences more than one surface says (Basic has no numbers, so none of these has one). */
export const PLAIN = {
  levelQuestion: 'How much should Hush hide?',
  on: 'Hush is cleaning up this chat.',
  off: 'Hush is off. Chat shows every message.',
  siteOff: (site: string) => `Hush is off on ${site}.`,
  loading: 'Getting ready… Simple filters already work.',
  error: "Hush's AI didn't start. Simple filters still work.",
  custom: "You're using a custom setup from Advanced mode. Pick a level to replace it.",
  customOff: 'Your custom setup from Advanced mode is kept while Hush is off. Turn it back on in Advanced mode, or pick a level to replace it.',
  extras: (extras: string[]) => `Also on from Advanced mode: ${extras.join(', ')}.`,
  advanced: 'Advanced mode',
  advancedHint: 'For streamers and mods: categories, stats, rules and custom AI filters.',
  basic: 'Basic mode',
  privacy: 'Runs on your computer. Nothing leaves it.',
} as const;

export const SITE_NAME: Record<string, string> = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };

/** Platform chat surfaces (approximate), used for solid overlays in-chat. */
export const PLATFORM_SURFACE: Record<string, Record<Theme, { bg: string; raised: string; line: string; font: string }>> = {
  twitch: {
    dark: { bg: '#18181b', raised: '#1f1f23', line: 'rgba(255,255,255,0.09)', font: 'Inter, Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif' },
    light: { bg: '#ffffff', raised: '#f7f7f8', line: 'rgba(0,0,0,0.09)', font: 'Inter, Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif' },
  },
  youtube: {
    dark: { bg: '#0f0f0f', raised: '#1c1c1c', line: 'rgba(255,255,255,0.1)', font: 'Roboto, Arial, sans-serif' },
    light: { bg: '#ffffff', raised: '#f8f8f8', line: 'rgba(0,0,0,0.1)', font: 'Roboto, Arial, sans-serif' },
  },
  kick: {
    dark: { bg: '#0f1012', raised: '#191b1f', line: 'rgba(255,255,255,0.08)', font: 'Inter, ui-sans-serif, system-ui, sans-serif' },
    light: { bg: '#ffffff', raised: '#f5f6f7', line: 'rgba(0,0,0,0.08)', font: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  },
  default: {
    dark: { bg: '#131318', raised: '#1b1b22', line: 'rgba(255,255,255,0.08)', font: 'var(--font-ui)' },
    light: { bg: '#ffffff', raised: '#f6f6f8', line: 'rgba(16,16,32,0.08)', font: 'var(--font-ui)' },
  },
};

export const FONT_UI =
  '"Inter var", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const FONT_MONO = 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace';

export const MOTION = { fast: 90, base: 140, ease: 'cubic-bezier(.2,.8,.2,1)' } as const;

export function categoryColor(c: Category, theme: Theme): string {
  return CATEGORY_META[c].color[theme];
}

/** Color for a vibe value in [-1, 1] (diverging: negative ← neutral → positive). */
export function vibeColor(v: number, theme: Theme): string {
  if (v > 0.05) return CATEGORY_META.positive.color[theme];
  if (v < -0.05) return CATEGORY_META.negative.color[theme];
  return theme === 'dark' ? '#8a8a99' : '#8a8a9a';
}
