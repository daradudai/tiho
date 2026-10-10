// Extension pages: model status wording, the settings reset, the onboarding demo toggle.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { modelProblem, modelSummary } from '../../src/ui/model-status';
import { OnboardingApp } from '../../src/ui/onboarding/OnboardingApp';
import { filterDefaults } from '../../src/ui/sidepanel/SettingsTab';

describe('model status', () => {
  it('words load errors plainly and always says rules still filter', () => {
    const raw = 'model not found (TypeError: Failed to fetch chrome-extension://abcdefghijklmnop/models/hush-lite/config.json)';
    const s = modelSummary({ state: 'error', backend: 'none', error: raw });
    expect(s).toEqual({ title: 'Model not included in this build', sub: 'Rules still filter chat', tone: 'err' });
    expect(modelProblem('GET https://example.org/model_q8.onnx: 503 Service Unavailable')).toBe('Model download failed');
    expect(modelProblem('non-finite output on webgpu/q8')).toBe('Model could not run on this device');
    expect(modelProblem('offscreen: Only a single offscreen document may be created.')).toBe('Model could not load');
    expect(modelSummary({ state: 'error', backend: 'none' }).sub).toBe('Rules still filter chat');
  });
});

describe('settings reset', () => {
  it('"Reset filters to defaults" resets how chat is filtered, not where, whether or how Hush looks', () => {
    const d = filterDefaults();
    expect(Object.keys(d).sort()).toEqual(['actions', 'collapseWaves', 'holdMs', 'preset', 'strictness', 'trustPrivileged']);
    expect(d.actions).toEqual(DEFAULT_SETTINGS.actions);
    expect(d.actions).not.toBe(DEFAULT_SETTINGS.actions);
  });
});

describe('onboarding demo', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is a real toggle button, and the first click stops the auto-flip', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    vi.spyOn(chrome.commands, 'getAll').mockResolvedValue([] as never); // the keyboard tip
    const el = document.createElement('div');
    document.body.appendChild(el);
    await act(() => render(<OnboardingApp />, el));
    const toggle = el.querySelector('.ob-demo-toggle') as HTMLButtonElement;
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    await act(() => {
      vi.advanceTimersByTime(1000); // flips to "With Hush" by itself
    });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    await act(() => toggle.click()); // the viewer picks "Before"
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(toggle.getAttribute('aria-pressed')).toBe('false'); // and it stays

    render(null, el);
    el.remove();
  });
});
