// Hush design tokens (JS side). The CSS side lives in tokens.css; the two are
// kept in sync by tests/ui/tokens.test.ts. Use CSS variables in components and
// these values only where a raw color is needed (decorations injected into the
// host page, canvas, generated icons).

import type { Action, Category } from '../core/types';
import type { PresetId } from '../core/settings';

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
  clean: { label: 'Everything else', desc: 'Regular chat', color: { dark: '#b9bac6', light: '#7a7b88' } },
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

/** Order a chip click cycles through. */
export const ACTION_CYCLE: Action[] = ['show', 'dim', 'collapse', 'hide'];

export function nextAction(a: Action): Action {
  if (a === 'highlight') return 'dim';
  const i = ACTION_CYCLE.indexOf(a);
  return ACTION_CYCLE[(i + 1) % ACTION_CYCLE.length];
}

export const PRESET_META: Record<Exclude<PresetId, 'custom'>, { label: string; short: string; desc: string }> = {
  raw: { label: 'Raw', short: 'Raw', desc: 'Everything, unfiltered' },
  chill: { label: 'Chill', short: 'Chill', desc: 'No toxicity or scams, spam folded' },
  focus: { label: 'Focus', short: 'Focus', desc: 'Only real conversation' },
  questions: { label: 'Questions', short: 'Q&A', desc: 'Questions up front, the rest faded' },
};

export const PRESET_ORDER = ['raw', 'chill', 'focus', 'questions'] as const;

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
