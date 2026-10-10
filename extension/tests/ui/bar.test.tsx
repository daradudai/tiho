// mountBar: shadow-DOM isolation, chips, actions, cleanup.
import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../../src/core/store';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { mountBar } from '../../src/ui/bar';
import type { BarActions } from '../../src/core/bar-actions';

const flush = () => new Promise((r) => setTimeout(r, 30));

function setup() {
  document.body.innerHTML = '<div id="col"><div id="list"></div></div>';
  const store = createStore({ ...DEFAULT_SETTINGS });
  store.platform.value = 'twitch';
  const actions: BarActions = {
    setPreset: vi.fn(),
    setAction: vi.fn(),
    toggleEnabled: vi.fn(),
    openSidePanel: vi.fn(),
    revealMessage: vi.fn(),
  };
  const list = document.getElementById('list')!;
  const dispose = mountBar({ el: list, where: 'before' }, store, actions);
  const host = document.querySelector('hush-bar') as HTMLElement;
  return { store, actions, dispose, host, root: host.shadowRoot! };
}

describe('mountBar', () => {
  it('inserts a shadow host before the anchor', async () => {
    const { host, root, dispose } = setup();
    await flush();
    expect(host.nextElementSibling?.id).toBe('list');
    expect(root.querySelector('style')).not.toBeNull(); // (CSS ?inline is empty under vitest)
    expect(root.querySelector('.hb-row')).not.toBeNull();
    expect(root.querySelectorAll('.hb-chip').length).toBe(7);
    dispose();
    expect(document.querySelector('hush-bar')).toBeNull();
  });

  it('chip click cycles the category action', async () => {
    const { root, actions, dispose } = setup();
    await flush();
    const spam = root.querySelector('.hb-chip[data-c="spam"]') as HTMLElement; // chill: collapse
    spam.click();
    expect(actions.setAction).toHaveBeenCalledWith('spam', 'hide');
    const toxic = root.querySelector('.hb-chip[data-c="toxic"]') as HTMLElement; // chill: hide
    toxic.click();
    expect(actions.setAction).toHaveBeenCalledWith('toxic', 'show');
    dispose();
  });

  it('preset menu applies a preset', async () => {
    const { root, actions, dispose } = setup();
    await flush();
    (root.querySelector('.hb-preset-pill') as HTMLElement).click();
    await flush();
    const items = root.querySelectorAll('.hb-menu-item');
    expect(items.length).toBe(4);
    (items[2] as HTMLElement).click();
    expect(actions.setPreset).toHaveBeenCalledWith('focus');
    dispose();
  });

  it('expands into the dashboard and reveals questions', async () => {
    const { root, store, actions, dispose } = setup();
    store.questions.value = [
      {
        msg: { key: 'k1', author: 'ana', text: 'what mouse?', ts: Date.now(), platform: 'twitch', channel: 'x' },
        verdict: { category: 'question', action: 'highlight', reason: 'question · 95%', source: 'model' },
      },
    ];
    await flush();
    (root.querySelector('.hb-mark') as HTMLElement).click();
    await flush();
    expect(root.querySelector('.hb-panel')).not.toBeNull();
    (root.querySelector('.hp-q') as HTMLElement).click();
    expect(actions.revealMessage).toHaveBeenCalledWith('k1');
    dispose();
  });

  it('hides itself when showBar is off', async () => {
    const { host, store, dispose } = setup();
    store.settings.value = { ...store.settings.value, showBar: false };
    expect(host.style.display).toBe('none');
    dispose();
  });
});
