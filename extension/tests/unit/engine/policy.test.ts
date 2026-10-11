import { describe, expect, it } from 'vitest';
import { decide, isUnsure, policyContext, type ScoreVector } from '../../../src/core/policy';
import type { RuleResult } from '../../../src/core/rules';
import {
  DEFAULT_SETTINGS,
  PRESETS,
  activeFilters,
  channelKey,
  engineQuestion,
  filterKey,
  filterLabel,
  mergeSettings,
  type EngineFilter,
  type Settings,
} from '../../../src/core/settings';
import type { Action } from '../../../src/core/types';
import type { WaveHit } from '../../../src/core/waves';

// LABELS order: toxic, spam, scam, noise, question, positive, negative
const CLEAN = [0.01, 0.01, 0.01, 0.02, 0.01, 0.1, 0.02];
const TOXIC = [0.97, 0, 0, 0, 0, 0, 0.6];
const R = (o: Partial<RuleResult> = {}): RuleResult => ({ sig: 0, reason: '', protect: false, ...o });

const BACKSEAT: EngineFilter = { id: 'a', question: 'Is this message backseating: telling the streamer how to play?', label: 'Backseating', action: 'hide', enabled: true };
const SPOILER: EngineFilter = { id: 'b', question: 'spoil the story or the ending', action: 'collapse', enabled: true };

function ctxOf(filters: EngineFilter[] = [BACKSEAT, SPOILER], o: Partial<Settings['engine']> = {}, s: Partial<Settings> = {}, thr?: number[]) {
  return policyContext({ ...DEFAULT_SETTINGS, ...s, engine: { ...DEFAULT_SETTINGS.engine, enabled: true, filters, ...o } }, thr);
}

/** Local scores carrying an engine opinion, as the classifier caches them. */
function vec(local: number[], filters?: Record<string, number>, base?: number[]): ScoreVector {
  const v = local.slice() as ScoreVector;
  v.engine = { filters, base };
  return v;
}
const p = (f: EngineFilter, prob: number) => ({ [filterKey(f)]: prob });

describe('policy: custom filters', () => {
  it('a firing filter applies its action with a readable reason', () => {
    const v = decide(vec(CLEAN, p(BACKSEAT, 0.93)), R(), null, ctxOf());
    expect(v).toMatchObject({ category: 'clean', action: 'hide', reason: 'filter: backseating', source: 'engine' });
  });

  it('below the threshold nothing changes', () => {
    const v = decide(vec(CLEAN, p(BACKSEAT, 0.49)), R(), null, ctxOf());
    expect(v).toMatchObject({ action: 'show', reason: '', source: 'model' });
  });

  it('never weakens a stronger category action', () => {
    const hl: EngineFilter = { ...BACKSEAT, action: 'highlight' };
    const v = decide(vec(TOXIC, p(hl, 0.99)), R(), null, ctxOf([hl]));
    expect(v).toMatchObject({ category: 'toxic', action: 'hide', reason: 'toxic · certain' });
    // …but highlights an otherwise shown message
    expect(decide(vec(CLEAN, p(hl, 0.99)), R(), null, ctxOf([hl])).action).toBe('highlight');
  });

  it('the strongest firing filter wins', () => {
    const v = decide(vec(CLEAN, { ...p(BACKSEAT, 0.6), ...p(SPOILER, 0.99) }), R(), null, ctxOf());
    expect(v).toMatchObject({ action: 'hide', reason: 'filter: backseating' });
    expect(decide(vec(CLEAN, p(SPOILER, 0.8)), R(), null, ctxOf()).reason).toBe('filter: spoil the story or the ending');
    // sentence-case labels read as reason text, names keep their case
    const named = (label: string) => ({ ...BACKSEAT, label });
    const reasonOf = (f: EngineFilter) => decide(vec(CLEAN, p(f, 0.9)), R(), null, ctxOf([f])).reason;
    expect(reasonOf(named('Begging for subs & raids'))).toBe('filter: begging for subs & raids');
    expect(reasonOf(named('Elden Ring spoilers'))).toBe('filter: Elden Ring spoilers');
    expect(reasonOf(named('GTA RP drama'))).toBe('filter: GTA RP drama');
  });

  it('user rules and protection come first', () => {
    const v = vec(CLEAN, p(BACKSEAT, 0.99));
    expect(decide(v, R({ user: 'allow', reason: 'allow', protect: true }), null, ctxOf()).action).toBe('show');
    expect(decide(v, R({ user: 'highlight', reason: 'hl' }), null, ctxOf()).action).toBe('highlight');
    expect(decide(v, R({ protect: true }), null, ctxOf()).action).toBe('show');
  });

  it('is ignored when the engine or the filter is off', () => {
    const v = vec(CLEAN, p(BACKSEAT, 0.99));
    expect(decide(v, R(), null, ctxOf([BACKSEAT], { enabled: false })).action).toBe('show');
    expect(decide(v, R(), null, ctxOf([{ ...BACKSEAT, enabled: false }])).action).toBe('show');
    expect(decide(v, R(), null, policyContext(DEFAULT_SETTINGS)).action).toBe('show');
  });

  it('answers to an edited question are not reused', () => {
    const v = vec(CLEAN, p(BACKSEAT, 0.99));
    const edited = { ...BACKSEAT, question: 'Is this message about speedrun strategies?' };
    expect(decide(v, R(), null, ctxOf([edited])).action).toBe('show');
  });

  it('wave members still fold, a hiding filter still hides them', () => {
    const wave: WaveHit = { id: 'w1', role: 'member', count: 9, headKey: 'k' } as WaveHit;
    expect(decide(vec(CLEAN, p(BACKSEAT, 0.99)), R(), wave, ctxOf()).action).toBe('hide');
    expect(decide(vec(CLEAN, p({ ...BACKSEAT, action: 'dim' }, 0.99)), R(), wave, ctxOf([{ ...BACKSEAT, action: 'dim' }])).action).toBe('collapse');
  });
});

describe('policy: second opinion', () => {
  const unsureToxic = [0.3, 0, 0, 0, 0, 0, 0.2];
  const engineSaysToxic = [0.92, 0.01, 0.01, 0.01, 0.01, 0.02, 0.8];
  const engineSaysClean = [0.02, 0.01, 0.01, 0.01, 0.01, 0.3, 0.05];

  const THR = [0.22, 0.53, 0.22, 0.44, 0.52, 0.26, 0.1]; // 6-layer student

  it('engine scores are averaged with unsure local ones, each against its own thresholds', () => {
    // a borderline local call that the engine clearly rejects
    expect(decide(vec(unsureToxic, undefined, engineSaysClean), R(), null, ctxOf([], {}, {}, THR)).action).toBe('show');
    // both lean toxic: the engine is sure, the local model just below its threshold
    const v = decide(vec([0.2, 0, 0, 0, 0, 0, 0], undefined, [0.99, 0, 0, 0, 0, 0, 0.5]), R(), null, ctxOf([], {}, {}, THR));
    expect(v).toMatchObject({ category: 'toxic', action: 'hide', source: 'engine' });
    expect(v.scores![0]).toBeGreaterThan(0.22);
    expect(v.reason).toBe('toxic · very likely'); // the averaged score, against the local threshold
  });

  it("the engine's raw scores are never read against the local thresholds", () => {
    // Clef-Flash's softmax on a clean message: above the student's toxic 0.22
    // and spam 0.53, far below its own calibrated thresholds
    const local = [0.1, 0.4, 0.05, 0.05, 0.05, 0.1, 0.05];
    const engine = [0.25, 0.55, 0.05, 0.05, 0.02, 0.05, 0.03];
    expect(decide(vec(local, undefined, engine), R(), null, ctxOf([], {}, {}, THR))).toMatchObject({ category: 'clean', action: 'show' });
    // one fairly sure vote against a fairly sure one is not enough to hide
    expect(decide(vec(local, undefined, engineSaysToxic), R(), null, ctxOf([], {}, {}, THR))).toMatchObject({ category: 'negative', action: 'show' });
  });

  it('local scores stand when second opinion is off', () => {
    const v = decide(vec(TOXIC, undefined, engineSaysClean), R(), null, ctxOf([], { refineUncertain: false }));
    expect(v).toMatchObject({ category: 'toxic', source: 'model' });
  });

  it('asks for a second opinion only near a threshold that changes what is shown', () => {
    const thr = [0.23, 0.47, 0.13, 0.41, 0.49, 0.19, 0.13]; // shipped model thresholds
    const chill = ctxOf([], {}, {}, thr);
    expect(isUnsure(CLEAN, chill)).toBe(false);
    expect(isUnsure(TOXIC, chill)).toBe(false); // confidently toxic
    expect(isUnsure([0.2, 0, 0, 0, 0, 0, 0], chill)).toBe(true); // toxic near 0.23
    expect(isUnsure([0, 0.45, 0, 0, 0, 0, 0], chill)).toBe(true); // spam (collapse) near 0.47
    expect(isUnsure([0, 0, 0, 0, 0.5, 0, 0], chill)).toBe(false); // question only highlights
    expect(isUnsure([0, 0, 0, 0, 0, 0, 0.15], chill)).toBe(false); // negative is shown in chill…
    const focus = ctxOf([], {}, { actions: PRESETS.focus }, thr);
    expect(isUnsure([0, 0, 0, 0, 0, 0, 0.15], focus)).toBe(true); // …and dimmed in focus
    const raw = ctxOf([], {}, { actions: PRESETS.raw }, thr);
    expect(isUnsure([0.2, 0.45, 0.13, 0.4, 0, 0, 0.15], raw)).toBe(false); // nothing would change
  });
});

describe('settings: engine filters', () => {
  it('asks questions as written and turns "messages that …" phrases into one', () => {
    expect(engineQuestion('Is this message backseating?')).toBe('Is this message backseating?');
    expect(engineQuestion('  does it spoil   the ending ')).toBe('does it spoil the ending?');
    expect(engineQuestion('are backseating the streamer')).toBe('Chat messages that are backseating the streamer: is this message one of them?');
    expect(engineQuestion('Hide messages that beg for subs.')).toBe('Chat messages that beg for subs: is this message one of them?');
    expect(engineQuestion('talk about other streamers')).toBe('Chat messages that talk about other streamers: is this message one of them?');
  });

  it('keys follow the question, labels stay short', () => {
    expect(filterKey(BACKSEAT)).toBe(filterKey({ question: `${BACKSEAT.question}  ` }));
    expect(filterKey(BACKSEAT)).not.toBe(filterKey(SPOILER));
    expect(filterKey(BACKSEAT)).toMatch(/^f[0-9a-z]+$/);
    expect(filterLabel(BACKSEAT)).toBe('Backseating');
    expect(filterLabel({ question: 'Is this message about politics?' })).toBe('politics');
    expect(filterLabel({ question: 'Does this message spoil the ending?' })).toBe('spoil the ending');
    expect(filterLabel({ question: 'Hide messages that ask for a game change' })).toBe('ask for a game change');
    expect(filterLabel({ question: 'x'.repeat(80) }, 20)).toHaveLength(20);
  });

  it('active filters need the engine and a question', () => {
    const e = { ...DEFAULT_SETTINGS.engine, enabled: true, filters: [BACKSEAT, { ...SPOILER, enabled: false }, { ...SPOILER, id: 'c', question: '  ' }] };
    expect(activeFilters(e).map((f) => f.id)).toEqual(['a']);
    expect(activeFilters({ ...e, enabled: false })).toEqual([]);
  });

  it('old stored settings get the new engine fields', () => {
    const s = mergeSettings({ engine: { enabled: true, url: 'http://127.0.0.1:7377', filters: [], refineUncertain: false } as unknown as Settings['engine'] });
    expect(s.engine.contexts).toEqual({});
    expect(s.engine.refineUncertain).toBe(false);
    expect(channelKey('twitch', ' XQC ')).toBe('twitch/xqc');
  });

  it('the action type covers every filter action the UI offers', () => {
    const actions: Action[] = ['hide', 'collapse', 'dim', 'highlight'];
    for (const a of actions) expect(decide(vec(CLEAN, p({ ...BACKSEAT, action: a }, 0.9)), R(), null, ctxOf([{ ...BACKSEAT, action: a }])).action).toBe(a);
  });
});
