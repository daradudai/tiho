import { describe, expect, it } from 'vitest';
import { categorize, confidence, decide, effectiveThresholds, modelCanHide, policyContext } from '../../../src/core/policy';
import { Sig, type RuleResult } from '../../../src/core/rules';
import { DEFAULT_SETTINGS, PRESETS, type Settings } from '../../../src/core/settings';
import type { WaveHit } from '../../../src/core/waves';

// LABELS order: toxic, spam, scam, noise, question, positive, negative
const S = (o: Partial<Record<'toxic' | 'spam' | 'scam' | 'noise' | 'question' | 'positive' | 'negative', number>>) => [
  o.toxic ?? 0,
  o.spam ?? 0,
  o.scam ?? 0,
  o.noise ?? 0,
  o.question ?? 0,
  o.positive ?? 0,
  o.negative ?? 0,
];
const R = (o: Partial<RuleResult> = {}): RuleResult => ({ sig: 0, reason: '', protect: false, ...o });
const ctxOf = (o: Partial<Settings> = {}, thr?: number[]) => policyContext({ ...DEFAULT_SETTINGS, ...o }, thr);

describe('policy', () => {
  it('category priority: toxic > scam > spam > noise > question > negative > positive', () => {
    const ctx = ctxOf();
    expect(decide(S({ toxic: 0.9, scam: 0.9 }), R(), null, ctx).category).toBe('toxic');
    expect(decide(S({ scam: 0.9, spam: 0.9 }), R(), null, ctx).category).toBe('scam');
    expect(decide(S({ spam: 0.9, noise: 0.9 }), R(), null, ctx).category).toBe('spam');
    expect(decide(S({ noise: 0.9, question: 0.9 }), R(), null, ctx).category).toBe('noise');
    expect(decide(S({ question: 0.9, negative: 0.9 }), R(), null, ctx).category).toBe('question');
    expect(decide(S({ negative: 0.9, positive: 0.9 }), R(), null, ctx).category).toBe('negative');
    expect(decide(S({ positive: 0.9 }), R(), null, ctx).category).toBe('positive');
    expect(decide(S({}), R(), null, ctx).category).toBe('clean');
  });

  it('maps category → action from settings and formats the reason', () => {
    const v = decide(S({ toxic: 0.94 }), R(), null, ctxOf());
    expect(v.action).toBe('hide'); // chill
    expect(v.reason).toBe('toxic · certain');
    expect(v.source).toBe('model');
    expect(decide(S({ toxic: 0.94 }), R(), null, ctxOf({ actions: PRESETS.raw })).action).toBe('show');
  });

  it('formats reasons for display', () => {
    const ctx = ctxOf();
    expect(decide(S({ question: 0.81 }), R(), null, ctx).reason).toBe('question · very likely');
    expect(decide(S({ toxic: 0.998 }), R(), null, ctx).reason).toBe('toxic · certain');
    expect(decide(S({}), R(), null, ctx).reason).toBe('');
    // a rule signal carried the label over its threshold: name it instead of a low score
    expect(decide(S({ scam: 0.3 }), R({ sig: Sig.LINK }), null, ctx).reason).toBe('scam · link');
    expect(decide(S({ scam: 0.7 }), R({ sig: Sig.LINK }), null, ctx).reason).toBe('scam · likely');
    expect(decide(S({ spam: 0.35 }), R({ sig: Sig.REPEAT }), null, ctx).reason).toBe('spam · repeat');
    expect(decide(null, R({ sig: Sig.QUESTION_MARK }), null, ctx).reason).toBe('question mark');
  });

  it("says how sure the model is against each label's calibrated threshold, not 50%", () => {
    const thr = [0.22, 0.53, 0.22, 0.44, 0.52, 0.26, 0.1]; // 6-layer student
    // 25% toxic is over toxic's line (22%): a confident hide, not "25%"
    expect(decide(S({ toxic: 0.25 }), R(), null, ctxOf({}, thr))).toMatchObject({ action: 'hide', reason: 'toxic · likely' });
    expect(decide(S({ toxic: 0.6 }), R(), null, ctxOf({}, thr)).reason).toBe('toxic · very likely');
    expect(decide(S({ toxic: 0.95 }), R(), null, ctxOf({}, thr)).reason).toBe('toxic · certain');
    expect(decide(S({ negative: 0.12 }), R(), null, ctxOf({}, thr)).reason).toBe('negative · likely');
    // Strict catches scores under the calibrated line: the reason says so
    expect(decide(S({ toxic: 0.15 }), R(), null, ctxOf({ strictness: 1 }, thr))).toMatchObject({ category: 'toxic', reason: 'toxic · maybe' });
    // the words do not move with strictness: Lenient lets fewer through, and those read as before
    expect(decide(S({ toxic: 0.25 }), R(), null, ctxOf({ strictness: 0 }, thr)).category).toBe('clean');
    expect(decide(S({ toxic: 0.6 }), R(), null, ctxOf({ strictness: 0 }, thr)).reason).toBe('toxic · very likely');
  });

  it('confidence: maybe < likely (≈ 3× odds over the line) < very likely < certain (near 1)', () => {
    expect(confidence(0.15, 0.22)).toBe('maybe');
    expect(confidence(0.22, 0.22)).toBe('likely');
    expect(confidence(0.45, 0.22)).toBe('likely'); // under 3× the odds at the line
    expect(confidence(0.5, 0.22)).toBe('very likely');
    expect(confidence(0.89, 0.22)).toBe('very likely');
    expect(confidence(0.9, 0.22)).toBe('certain');
    expect(confidence(1, 0.22)).toBe('certain');
    // a high line: near 1 but not well over it is only likely
    expect(confidence(0.9, 0.85)).toBe('likely');
  });

  it('uses model thresholds and shifts filtering labels with strictness', () => {
    const thr = [0.5, 0.5, 0.5, 0.5, 0.7, 0.5, 0.5];
    const strict = effectiveThresholds(thr, 1);
    const lenient = effectiveThresholds(thr, 0);
    const mid = effectiveThresholds(thr, 0.5);
    expect(mid[0]).toBeCloseTo(0.5, 5);
    expect(strict[0]!).toBeLessThan(0.5);
    expect(lenient[0]!).toBeGreaterThan(0.5);
    // question threshold is not shifted
    expect(strict[4]).toBeCloseTo(0.7, 5);
    expect(lenient[4]).toBeCloseTo(0.7, 5);
    expect(decide(S({ toxic: 0.4 }), R(), null, ctxOf({ strictness: 1 }, thr)).category).toBe('toxic');
    expect(decide(S({ toxic: 0.4 }), R(), null, ctxOf({ strictness: 0 }, thr)).category).toBe('clean');
    expect(decide(S({ question: 0.6 }), R(), null, ctxOf({}, thr)).category).toBe('clean');
  });

  it('rule signals nudge scores', () => {
    const ctx = ctxOf();
    expect(categorize(S({ scam: 0.3 }), Sig.LINK, ctx.thresholds).category).toBe('scam');
    expect(categorize(S({ scam: 0.6 }), Sig.LINK_OK, ctx.thresholds).category).toBe('clean');
    expect(categorize(S({ spam: 0.35 }), Sig.REPEAT, ctx.thresholds).category).toBe('spam');
  });

  it('rule-decided categories skip the model', () => {
    const v = decide(null, R({ cat: 'noise', reason: '!command' }), null, ctxOf({ actions: PRESETS.focus }));
    expect(v).toMatchObject({ category: 'noise', action: 'hide', reason: '!command', source: 'rule' });
  });

  it('falls back to signals without a model', () => {
    expect(decide(null, R({ sig: Sig.LINK }), null, ctxOf()).category).toBe('scam');
    expect(decide(null, R({ sig: Sig.QUESTION_MARK }), null, ctxOf()).category).toBe('question');
    expect(decide(null, R(), null, ctxOf()).category).toBe('clean');
  });

  it('protected messages are never hidden/collapsed/dimmed, highlight kept', () => {
    const p = R({ protect: true });
    expect(decide(S({ toxic: 0.99 }), p, null, ctxOf()).action).toBe('show');
    expect(decide(S({ question: 0.99 }), p, null, ctxOf()).action).toBe('highlight');
    expect(decide(null, R({ protect: true, cat: 'spam' }), null, ctxOf({ actions: PRESETS.focus })).action).toBe('show');
  });

  it('says so in the reason when protection keeps a message shown', () => {
    const p = R({ protect: true });
    expect(decide(S({ toxic: 0.94 }), p, null, ctxOf())).toMatchObject({ action: 'show', reason: 'toxic · certain · always shown' });
    expect(decide(null, R({ protect: true, cat: 'spam', reason: 'repeat' }), null, ctxOf()).reason).toBe('repeat · always shown');
    expect(decide(S({}), p, null, ctxOf({ actions: PRESETS.questions })).reason).toBe('always shown'); // clean has no reason of its own
    // nothing was capped: the reason stays as it is
    expect(decide(S({ question: 0.9 }), p, null, ctxOf()).reason).toBe('question · certain');
    expect(decide(S({ toxic: 0.94 }), p, null, ctxOf({ actions: PRESETS.raw })).reason).toBe('toxic · certain');
  });

  it('user rules override presets', () => {
    expect(decide(null, R({ user: 'block', reason: 'blocked: x' }), null, ctxOf({ actions: PRESETS.raw }))).toMatchObject({
      action: 'hide',
      source: 'user',
      reason: 'blocked: x',
    });
    expect(decide(S({ toxic: 0.99 }), R({ user: 'allow', protect: true }), null, ctxOf()).action).toBe('show');
    expect(decide(S({}), R({ user: 'highlight' }), null, ctxOf()).action).toBe('highlight');
  });

  it('wave members collapse (when enabled), heads keep their action', () => {
    const member: WaveHit = { id: 'w1', role: 'member', count: 12, users: 9, headKey: 'k' };
    const head: WaveHit = { ...member, role: 'head' };
    const v = decide(S({}), R(), member, ctxOf());
    expect(v).toMatchObject({ action: 'collapse', reason: 'wave ×12', wave: 'w1' });
    expect(decide(S({}), R(), head, ctxOf())).toMatchObject({ action: 'show', wave: 'w1' });
    expect(decide(S({}), R(), member, ctxOf({ collapseWaves: false })).action).toBe('show');
    // a hidden category stays hidden
    expect(decide(S({ toxic: 0.9 }), R(), member, ctxOf()).action).toBe('hide');
  });

  it('modelCanHide', () => {
    expect(modelCanHide(PRESETS.raw)).toBe(false);
    expect(modelCanHide(PRESETS.chill)).toBe(true);
  });
});
