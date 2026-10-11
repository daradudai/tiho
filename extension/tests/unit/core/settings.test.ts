import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PRESETS, advancedExtras, basicLevel, levelPatch, mergeSettings, type Settings } from '../../../src/core/settings';

const S = (o: Partial<Settings> = {}): Settings => mergeSettings({ ...DEFAULT_SETTINGS, ...o });

describe('settings: modes', () => {
  it('a fresh install and every install from before the modes land in Basic; Advanced is kept', () => {
    expect(mergeSettings(undefined).uiMode).toBe('basic');
    expect(DEFAULT_SETTINGS.uiMode).toBe('basic');
    const { uiMode: _, ...old } = DEFAULT_SETTINGS; // stored before uiMode existed
    expect(mergeSettings({ ...old, preset: 'focus' })).toMatchObject({ uiMode: 'basic', preset: 'focus' });
    expect(mergeSettings({ uiMode: 'expert' as never }).uiMode).toBe('basic');
    expect(mergeSettings({ uiMode: 'advanced' }).uiMode).toBe('advanced');
  });

  it('basicLevel reads the level back from the settings', () => {
    expect(basicLevel(S({ enabled: false }))).toBe('off');
    const twitchOff = S({ sites: { ...DEFAULT_SETTINGS.sites, twitch: false } });
    expect(basicLevel(twitchOff, 'twitch')).toBe('off');
    expect(basicLevel(twitchOff, 'kick')).toBe('chill');
    expect(basicLevel(twitchOff)).toBe('chill'); // no chat site to ask about
    expect(basicLevel(S({ preset: 'chill', actions: { ...PRESETS.chill } }))).toBe('chill');
    expect(basicLevel(S({ preset: 'focus', actions: { ...PRESETS.focus } }))).toBe('focus');
    for (const preset of ['raw', 'questions', 'custom'] as const) expect(basicLevel(S({ preset }))).toBeNull();
  });

  it('levelPatch: one patch per level, the site of the chat turned on', () => {
    const s = S({ enabled: false, preset: 'custom', sites: { youtube: true, twitch: false, kick: false } });
    expect(levelPatch(s, 'off', 'twitch')).toEqual({ enabled: false });
    expect(levelPatch(s, 'focus', 'twitch')).toEqual({
      enabled: true,
      sites: { youtube: true, twitch: true, kick: false },
      preset: 'focus',
      actions: PRESETS.focus,
    });
    expect(levelPatch(s, 'chill')).toEqual({ enabled: true, preset: 'chill', actions: PRESETS.chill }); // no chat tab: sites untouched
    expect(levelPatch(s, 'chill').actions).not.toBe(PRESETS.chill); // a copy
  });

  it('advancedExtras names what Advanced set up that still applies, in plain words', () => {
    expect(advancedExtras(DEFAULT_SETTINGS)).toEqual([]);
    const rule = { id: 'r', kind: 'word', pattern: 'spoiler', mode: 'block', enabled: true } as const;
    expect(advancedExtras(S({ rules: [rule] }))).toEqual(['your rules']);
    expect(advancedExtras(S({ rules: [{ ...rule, enabled: false }] }))).toEqual([]);
    const filter = { id: 'f', question: 'Is this backseating?', action: 'hide', enabled: true } as const;
    const engine = { ...DEFAULT_SETTINGS.engine, filters: [filter] };
    expect(advancedExtras(S({ engine }))).toEqual([]); // the engine is off
    expect(advancedExtras(S({ rules: [rule], engine: { ...engine, enabled: true }, strictness: 0.8 }))).toEqual([
      'your rules',
      'custom AI filters',
      'strictness',
    ]);
  });
});
