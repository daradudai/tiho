import { describe, expect, it, vi } from 'vitest';
import { createBarActions } from '../../../src/core/bar-actions';
import { DEFAULT_SETTINGS, PRESETS, type Settings } from '../../../src/core/settings';

function actions(o: Partial<Settings> = {}) {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...o };
  const deps = {
    getSettings: () => settings,
    save: vi.fn(),
    openSidePanel: vi.fn(),
    reveal: vi.fn(),
    platform: 'twitch' as const,
    setPeek: vi.fn(),
    setSolo: vi.fn(),
  };
  return { a: createBarActions(deps), deps };
}

describe('bar actions', () => {
  it('setLevel saves the whole level in one go, and turns this site on', () => {
    const { a, deps } = actions({ enabled: false, preset: 'custom', sites: { youtube: true, twitch: false, kick: true } });
    a.setLevel('focus');
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(deps.save).toHaveBeenCalledWith({
      enabled: true,
      sites: { youtube: true, twitch: true, kick: true },
      preset: 'focus',
      actions: PRESETS.focus,
    });
    a.setLevel('off');
    expect(deps.save).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('setMode saves only the mode', () => {
    const { a, deps } = actions();
    a.setMode('advanced');
    expect(deps.save).toHaveBeenCalledWith({ uiMode: 'advanced' });
  });

  it('Show hidden and Solo go to the runtime, never to the settings', () => {
    const { a, deps } = actions();
    a.setPeek(true);
    a.setSolo('spam');
    a.setSolo(null);
    expect(deps.setPeek).toHaveBeenCalledWith(true);
    expect(deps.setSolo.mock.calls).toEqual([['spam'], [null]]);
    expect(deps.save).not.toHaveBeenCalled();
  });
});
