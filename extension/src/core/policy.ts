// Policy: (model scores, rule result, wave, settings) → Verdict.
//
// Category priority: toxic > scam > spam > noise > question > negative >
// positive > clean. A label is "on" when its score (nudged by rule signals)
// reaches its threshold; thresholds come from the model config
// (`tiho.thresholds`) and are shifted by `strictness` in logit space for the
// filtering labels (toxic, spam, scam, noise, negative). Reasons say how sure
// the model is in words, against the unshifted thresholds ("toxic · likely").
//
// Tiho Engine (optional): its answers arrive after the local scores and are
// attached to the same cached score vector (ScoreVector.engine). A custom
// filter that fires applies its action when that is stronger than the
// category's; with "second opinion" on, the engine's own scores (asked only
// when the local model was unsure) are averaged with the local ones, each
// measured against its own calibrated thresholds.

import { Sig, type RuleResult } from './rules';
import { activeFilters, filterKey, filterLabel, type EngineSettings, type Settings } from './settings';
import { ALWAYS_SHOWN, LABELS, type Action, type Category, type Label, type Verdict } from './types';
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
/** Probability kept away from 0 and 1, where logits are infinite. */
const clampP = (p: number) => Math.min(0.999, Math.max(0.001, p));

/** A model's threshold for label i, or 0.5 when it has none. */
function baseThreshold(base: ArrayLike<number> | undefined | null, i: number): number {
  const t = base && Number.isFinite(base[i]) ? base[i]! : 0.5;
  return Math.min(0.99, Math.max(0.01, t));
}

export function effectiveThresholds(base: ArrayLike<number> | undefined | null, strictness: number): Float32Array {
  const out = new Float32Array(LABELS.length);
  const s = Number.isFinite(strictness) ? Math.min(1, Math.max(0, strictness)) : 0.5;
  for (let i = 0; i < LABELS.length; i++) {
    let t = baseThreshold(base, i);
    if (STRICT_LABELS.has(LABELS[i]!)) t = sigmoid(logit(t) + (0.5 - s) * STRICT_SPAN);
    out[i] = t;
  }
  return out;
}

/**
 * Thresholds for the Tiho Engine's own scores (Clef-Flash on the base schema,
 * the teacher's), aligned with LABELS. Calibrated like the students' (best
 * F-beta, beta 0.7 for toxic, spam and scam: `best_threshold` in
 * ml/train/evaluate.py) on ml/data/gold_teacher.jsonl against the gold labels.
 * Its softmax puts clean messages at toxic 0.25 or spam 0.55 routinely, far
 * above the students' thresholds.
 */
export const ENGINE_THRESHOLDS: readonly number[] = [0.85, 0.85, 0.65, 0.34, 0.31, 0.13, 0.15];

/** Per-label logit shift that puts an engine score on the local model's scale (its threshold onto the local one). */
function engineShift(base: ArrayLike<number> | undefined | null): Float32Array {
  const out = new Float32Array(LABELS.length);
  for (let i = 0; i < LABELS.length; i++) out[i] = logit(baseThreshold(base, i)) - logit(ENGINE_THRESHOLDS[i]!);
  return out;
}

/** What the Tiho Engine said about a text. */
export interface EngineOpinion {
  /** Custom-filter probabilities by filter key. */
  filters?: Record<string, number>;
  /** The engine's scores aligned with LABELS (second opinion). */
  base?: number[];
}

/** Local model scores (aligned with LABELS), optionally carrying the engine's opinion of the same text. */
export type ScoreVector = number[] & { engine?: EngineOpinion };

export function engineOpinion(scores: ArrayLike<number> | null | undefined): EngineOpinion | undefined {
  return scores ? (scores as ScoreVector).engine : undefined;
}

/** A custom filter fires at this probability. */
export const FILTER_THRESHOLD = 0.5;

export interface PolicyFilter {
  key: string;
  action: Action;
  /** As the reason shows it ("filter: backseating"). */
  label: string;
}

export interface PolicyContext {
  actions: Record<Category, Action>;
  thresholds: Float32Array;
  /** The model's own calibrated thresholds, before strictness: a reason's confidence word is measured against them. */
  calibrated: Float32Array;
  collapseWaves: boolean;
  /** Enabled custom filters (empty when the engine is off). */
  filters: PolicyFilter[];
  /** Engine scores are averaged with the local ones when present. */
  refine: boolean;
  /** Logit shift per label from the engine's calibrated thresholds to the local model's. */
  engineShift: Float32Array;
}

export function policyContext(
  settings: Pick<Settings, 'actions' | 'strictness' | 'collapseWaves'> & { engine?: EngineSettings },
  baseThresholds?: ArrayLike<number> | null,
): PolicyContext {
  const engine = settings.engine;
  return {
    actions: settings.actions,
    thresholds: effectiveThresholds(baseThresholds, settings.strictness),
    calibrated: Float32Array.from(LABELS, (_, i) => baseThreshold(baseThresholds, i)),
    collapseWaves: settings.collapseWaves,
    filters: engine ? activeFilters(engine).map((f) => ({ key: filterKey(f), action: f.action, label: lowerFirst(filterLabel(f)) })) : [],
    refine: !!engine?.enabled && engine.refineUncertain,
    engineShift: engineShift(baseThresholds),
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
  if (sig & Sig.REPEAT) return { category: 'spam', reason: 'repeat' };
  if (sig & Sig.QUESTION_MARK) return { category: 'question', reason: 'question mark' };
  return { category: 'clean', reason: '' };
}

/** The rule signal that can carry a label over its threshold, as reason text. */
function signalWords(category: Category, sig: number): string {
  if (category === 'scam') return sig & Sig.LINK ? 'link' : sig & Sig.SCAM_WORDS ? 'scam words' : '';
  if (category === 'spam') return sig & Sig.REPEAT ? 'repeat' : sig & Sig.CAPS ? 'caps' : '';
  return '';
}

/**
 * Reason for a model call, as the hover chip, the tags and the log show it:
 * "toxic · likely" (how sure the model is, see confidence()), or the rule
 * signal that carried the label over its threshold when the score alone did
 * not ("scam · link").
 */
function modelReason(c: Categorized, sig: number, ctx: PolicyContext): string {
  if (c.category === 'clean') return '';
  const i = LABEL_INDEX[c.category];
  const why = c.score < ctx.thresholds[i]! ? signalWords(c.category, sig) : '';
  return `${c.category} · ${why || confidence(c.score, ctx.calibrated[i]!)}`;
}

/** Sentence-case label as reason text: "Backseating" → "backseating"; names keep their case ("Elden Ring spoilers"). */
function lowerFirst(label: string): string {
  return /^\p{Lu}\p{Ll}*(?:\s+[^\p{Lu}\s]|$)/u.test(label) ? label.replace(/^\p{Lu}/u, (ch) => ch.toLowerCase()) : label;
}

/**
 * Decide the verdict for one message.
 *
 * @param local model probabilities aligned with LABELS (possibly carrying
 *   the engine's opinion, see ScoreVector), or null when the model has no
 *   opinion (not loaded, rule-decided, timed out).
 * @param from where `local` came from ('model' | 'cache' | 'engine').
 */
export function decide(
  local: ArrayLike<number> | null | undefined,
  rule: RuleResult,
  wave: WaveHit | null | undefined,
  ctx: PolicyContext,
  from: Verdict['source'] = 'model',
): Verdict {
  let category: Category;
  let action: Action;
  let reason: string;
  let src: Verdict['source'];

  const engine = engineOpinion(local);
  let scores = local;
  let source = from;
  if (local && engine?.base && ctx.refine) {
    scores = secondOpinion(local, engine.base, ctx.engineShift);
    source = 'engine';
  }

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
    reason = modelReason(c, rule.sig, ctx);
    src = source;
    action = ctx.actions[category];
  } else {
    const f = fallback(rule.sig);
    category = f.category;
    reason = f.reason;
    src = 'rule';
    action = ctx.actions[category];
  }

  if (engine?.filters && ctx.filters.length && !rule.user) {
    const hit = firingFilter(engine.filters, ctx.filters);
    if (hit && SEVERITY[hit.action] > SEVERITY[action]) {
      action = hit.action;
      reason = `filter: ${hit.label}`;
      src = 'engine';
    }
  }

  let waveId: string | undefined;
  if (wave) {
    waveId = wave.id;
    if (wave.role === 'member' && ctx.collapseWaves && SEVERITY[action] < SEVERITY.collapse && rule.user !== 'allow') {
      action = 'collapse';
      reason = `wave ×${wave.count}`;
    }
  }

  // Protected authors are never dimmed, folded or hidden; the reason says so
  // (the hover chip and Solo's tag show it: "toxic · certain · always shown").
  if (rule.protect && SEVERITY[action] >= SEVERITY.dim) {
    action = 'show';
    reason = reason ? `${reason} · ${ALWAYS_SHOWN}` : ALWAYS_SHOWN;
  }

  const v: Verdict = { category, action, reason, source: src };
  if (scores) v.scores = Array.isArray(scores) ? (scores as number[]) : Array.from(scores);
  if (waveId) v.wave = waveId;
  return v;
}

/**
 * Local and engine scores averaged in logit space, the engine's first moved
 * onto the local scale (engineShift): a label is on when the two calibrated
 * margins together clear the local threshold. On the gold set's unsure
 * messages, the engine's raw scores against the local thresholds hid about
 * five times as many clean messages as the local model. The average hid fewer
 * clean ones and caught more bad ones than the 6-layer student alone, and came
 * out about even with the 3-layer one (measured with the v2 students).
 */
function secondOpinion(local: ArrayLike<number>, engine: ArrayLike<number>, shift: Float32Array): number[] {
  const out = new Array<number>(LABELS.length);
  for (let i = 0; i < LABELS.length; i++) {
    out[i] = sigmoid((logit(clampP(local[i] ?? 0)) + logit(clampP(engine[i] ?? 0)) + shift[i]!) / 2);
  }
  return out;
}

/** The firing filter with the strongest action (most confident among equals). */
function firingFilter(probs: Record<string, number>, filters: PolicyFilter[]): PolicyFilter | null {
  let best: PolicyFilter | null = null;
  let bestP = 0;
  for (const f of filters) {
    const p = probs[f.key];
    if (p === undefined || !(p >= FILTER_THRESHOLD)) continue;
    const d = best ? SEVERITY[f.action] - SEVERITY[best.action] : 1;
    if (d > 0 || (d === 0 && p > bestP)) {
      best = f;
      bestP = p;
    }
  }
  return best;
}

/** Logit distance from a threshold within which the local model counts as unsure (≈ 3× odds either way). */
const UNSURE_LOGIT = 1.1;

/** How sure the model is of a label, in words (see confidence()). */
export type Confidence = 'maybe' | 'likely' | 'very likely' | 'certain';

/** A raw score this high reads "certain" when it is also well over its threshold. */
const CERTAIN_P = 0.9;

/**
 * A label's score in words, measured against the model's calibrated
 * threshold for it rather than against 50%: thresholds differ per label
 * (toxic 0.22, negative 0.10), so a toxic score of 25% is already over the
 * line. Under the threshold it reads "maybe" (only Strict catches those),
 * within about 3× odds over it (UNSURE_LOGIT) "likely", further "very likely",
 * and "certain" when the score itself is near 1.
 */
export function confidence(p: number, t: number): Confidence {
  const m = logit(clampP(p)) - logit(clampP(t));
  if (m < 0) return 'maybe';
  if (m < UNSURE_LOGIT) return 'likely';
  return p >= CERTAIN_P ? 'certain' : 'very likely';
}

/**
 * True when the local model is unsure about a label whose action would change
 * what the viewer sees (dim or stronger): such texts are worth a second
 * opinion from the engine. Confident calls and labels that only highlight
 * are not, the engine's capacity is far below a busy chat's rate.
 */
export function isUnsure(scores: ArrayLike<number>, ctx: Pick<PolicyContext, 'actions' | 'thresholds'>): boolean {
  for (const l of PRIORITY) {
    const a = ctx.actions[l];
    if (SEVERITY[a] < SEVERITY.dim || a === ctx.actions.clean) continue;
    const i = LABEL_INDEX[l];
    if (Math.abs(logit(clampP(scores[i] ?? 0)) - logit(ctx.thresholds[i]!)) < UNSURE_LOGIT) return true;
  }
  return false;
}

/** True when a message could end up hidden/collapsed by the model under these settings (→ worth holding). */
export function modelCanHide(actions: Record<Category, Action>): boolean {
  for (const l of PRIORITY) {
    const a = actions[l];
    if (a === 'hide' || a === 'collapse') return true;
  }
  return false;
}
