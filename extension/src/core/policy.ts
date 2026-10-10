// Policy: (model scores, rule result, wave, settings) → Verdict.
//
// Category priority: toxic > scam > spam > noise > question > negative >
// positive > clean. A label is "on" when its score (nudged by rule signals)
// reaches its threshold; thresholds come from the model config
// (`hush.thresholds`) and are shifted by `strictness` in logit space for the
// filtering labels (toxic, spam, scam, noise, negative).

import { Sig, type RuleResult } from './rules';
import type { Settings } from './settings';
import { LABELS, type Action, type Category, type Label, type Verdict } from './types';
import type { WaveHit } from './waves';

export const LABEL_INDEX: Record<Label, number> = {
  toxic: 0,
  spam: 1,
  scam: 2,
  noise: 3,
  question: 4,
  positive: 5,
  negative: 6,
};

/** Category priority, highest first (clean is the fallback). */
export const PRIORITY: Label[] = ['toxic', 'scam', 'spam', 'noise', 'question', 'negative', 'positive'];
const PRIORITY_IDX = PRIORITY.map((l) => LABEL_INDEX[l]);

/** Labels whose thresholds move with strictness. */
const STRICT_LABELS = new Set<Label>(['toxic', 'spam', 'scam', 'noise', 'negative']);

export const DEFAULT_THRESHOLDS: readonly number[] = LABELS.map(() => 0.5);

/** How severe an action is; used to combine (max) actions. */
export const SEVERITY: Record<Action, number> = { show: 0, highlight: 1, dim: 2, collapse: 3, hide: 4 };

/** Logit shift at strictness 0 / 1 (±STRICT_SPAN/2). */
const STRICT_SPAN = 3;

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function effectiveThresholds(base: ArrayLike<number> | undefined | null, strictness: number): Float32Array {
  const out = new Float32Array(LABELS.length);
  const s = Number.isFinite(strictness) ? Math.min(1, Math.max(0, strictness)) : 0.5;
  for (let i = 0; i < LABELS.length; i++) {
    let t = base && Number.isFinite(base[i]) ? base[i]! : 0.5;
    t = Math.min(0.99, Math.max(0.01, t));
    if (STRICT_LABELS.has(LABELS[i]!)) t = sigmoid(logit(t) + (0.5 - s) * STRICT_SPAN);
    out[i] = t;
  }
  return out;
}

export interface PolicyContext {
  actions: Record<Category, Action>;
  thresholds: Float32Array;
  collapseWaves: boolean;
}

export function policyContext(
  settings: Pick<Settings, 'actions' | 'strictness' | 'collapseWaves'>,
  baseThresholds?: ArrayLike<number> | null,
): PolicyContext {
  return {
    actions: settings.actions,
    thresholds: effectiveThresholds(baseThresholds, settings.strictness),
    collapseWaves: settings.collapseWaves,
  };
}

// Reused scratch buffer for nudged scores.
const eff = new Float32Array(LABELS.length);

/** Apply rule signals to raw scores (into `eff`). */
function nudge(scores: ArrayLike<number>, sig: number): Float32Array {
  for (let i = 0; i < LABELS.length; i++) eff[i] = scores[i] ?? 0;
  if (sig & Sig.LINK) eff[2] += 0.3;
  if (sig & Sig.LINK_OK) eff[2] -= 0.25;
  if (sig & Sig.SCAM_WORDS) eff[2] += 0.2;
  if (sig & Sig.REPEAT) eff[1] += 0.2;
  if (sig & Sig.CAPS) eff[1] += 0.1;
  return eff;
}

export interface Categorized {
  category: Category;
  /** Score of the winning label (raw, before nudging), or 0 for clean. */
  score: number;
}

export function categorize(scores: ArrayLike<number>, sig: number, thr: Float32Array): Categorized {
  const e = nudge(scores, sig);
  for (let k = 0; k < PRIORITY_IDX.length; k++) {
    const i = PRIORITY_IDX[k]!;
    if (e[i]! >= thr[i]!) return { category: PRIORITY[k]!, score: scores[i] ?? 0 };
  }
  return { category: 'clean', score: 0 };
}

/** Rules-only fallback when no model score is available. */
function fallback(sig: number): { category: Category; reason: string } {
  if (sig & Sig.LINK) return { category: 'scam', reason: 'link' };
  if (sig & Sig.REPEAT) return { category: 'spam', reason: 'repeats' };
  if (sig & Sig.QUESTION_MARK) return { category: 'question', reason: '?' };
  return { category: 'clean', reason: '' };
}

function fmt(label: string, score: number): string {
  return `${label} ${score.toFixed(2)}`;
}

/**
 * Decide the verdict for one message.
 *
 * @param scores model probabilities aligned with LABELS, or null when the
 *   model has no opinion (not loaded, rule-decided, timed out).
 * @param source where `scores` came from ('model' | 'cache' | 'engine').
 */
export function decide(
  scores: ArrayLike<number> | null | undefined,
  rule: RuleResult,
  wave: WaveHit | null | undefined,
  ctx: PolicyContext,
  source: Verdict['source'] = 'model',
): Verdict {
  let category: Category;
  let action: Action;
  let reason: string;
  let src: Verdict['source'];

  if (rule.user) {
    src = 'user';
    reason = rule.reason;
    if (rule.user === 'block') {
      category = rule.cat ?? (scores ? categorize(scores, rule.sig, ctx.thresholds).category : 'spam');
      if (category === 'clean') category = 'spam';
      action = 'hide';
    } else {
      category = rule.cat ?? (scores ? categorize(scores, rule.sig, ctx.thresholds).category : 'clean');
      action = rule.user === 'highlight' ? 'highlight' : ctx.actions[category] === 'highlight' ? 'highlight' : 'show';
    }
  } else if (rule.cat) {
    category = rule.cat;
    reason = rule.reason;
    src = 'rule';
    action = ctx.actions[category];
  } else if (scores) {
    const c = categorize(scores, rule.sig, ctx.thresholds);
    category = c.category;
    reason = category === 'clean' ? '' : fmt(category, c.score);
    src = source;
    action = ctx.actions[category];
  } else {
    const f = fallback(rule.sig);
    category = f.category;
    reason = f.reason;
    src = 'rule';
    action = ctx.actions[category];
  }

  let waveId: string | undefined;
  if (wave) {
    waveId = wave.id;
    if (wave.role === 'member' && ctx.collapseWaves && SEVERITY[action] < SEVERITY.collapse && rule.user !== 'allow') {
      action = 'collapse';
      reason = `wave ×${wave.count}`;
    }
  }

  if (rule.protect && SEVERITY[action] >= SEVERITY.dim) action = 'show';

  const v: Verdict = { category, action, reason, source: src };
  if (scores) v.scores = Array.isArray(scores) ? (scores as number[]) : Array.from(scores);
  if (waveId) v.wave = waveId;
  return v;
}

/** True when a message could end up hidden/collapsed by the model under these settings (→ worth holding). */
export function modelCanHide(actions: Record<Category, Action>): boolean {
  for (const l of PRIORITY) {
    const a = actions[l];
    if (a === 'hide' || a === 'collapse') return true;
  }
  return false;
}
