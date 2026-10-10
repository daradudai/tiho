// mountBar: shadow-DOM isolation, chips, actions, cleanup.
import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../../src/core/store';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { framedByOtherSite, mountBar, type MountOptions } from '../../src/ui/bar';
import type { BarActions } from '../../src/core/bar-actions';

const flush = () => new Promise((r) => setTimeout(r, 30));

/** The tests reach into the shadow root and drive the bar with el.click() (untrusted events). */
function setup(opts: MountOptions = { shadow: 'open', synthetic: true }) {
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
  const dispose = mountBar({ el: list, where: 'before' }, store, actions, opts);
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

  it('draws the mark and chip glyphs as images, not inline SVG (a paint chunk each, every frame)', async () => {
    const { root, dispose } = setup();
    await flush();
    expect(root.querySelectorAll('.hb-chip svg, .hush-live svg').length).toBe(0);
    const ico = root.querySelector('.hb-chip[data-c="toxic"] .hb-chip-ico') as HTMLElement;
    expect(ico.style.backgroundImage).toContain('data:image/svg+xml');
    expect(decodeURIComponent(ico.style.backgroundImage)).toContain('color="#ff6470"'); // dark theme toxic
    expect((root.querySelector('.hush-live') as HTMLElement).style.backgroundImage).toContain('data:image/svg+xml');
    dispose();
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

  it('is closed to page scripts: no shadowRoot to reach, synthetic events ignored', async () => {
    const closed = setup({});
    expect(closed.host.shadowRoot).toBeNull();
    closed.dispose();

    const { root, actions, dispose } = setup({ shadow: 'open' });
    await flush();
    (root.querySelector('.hb-chip[data-c="spam"]') as HTMLElement).click();
    (root.querySelector('.hb-seg-btn') as HTMLElement).click();
    root.querySelector('.hb-chip')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true }));
    (root.querySelector('.hb-mark') as HTMLElement).click();
    await flush();
    expect(actions.setAction).not.toHaveBeenCalled();
    expect(actions.setPreset).not.toHaveBeenCalled();
    expect(root.querySelector('.hb-menu')).toBeNull();
    expect(root.querySelector('.hb-panel')).toBeNull();
    dispose();
  });

  it('menus take focus, move with the arrow keys and give focus back on Escape or Tab', async () => {
    const { root, actions, dispose } = setup();
    await flush();
    const chip = root.querySelector('.hb-chip[data-c="spam"]') as HTMLElement; // chill: collapse
    chip.focus();
    chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true }));
    await flush();
    const items = [...root.querySelectorAll<HTMLElement>('.hb-menu [role="menuitemradio"]')];
    expect(root.activeElement).toBe(items.find((i) => i.dataset.a === 'collapse'));
    const key = (k: string) => (root.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowDown');
    expect((root.activeElement as HTMLElement).dataset.a).toBe('hide');
    key('ArrowDown'); // wraps around
    expect((root.activeElement as HTMLElement).dataset.a).toBe('show');
    key('End');
    expect((root.activeElement as HTMLElement).dataset.a).toBe('hide');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(root.querySelector('.hb-menu')).toBeNull();
    expect(root.activeElement).toBe(chip);

    (root.querySelector('.hb-preset-pill') as HTMLElement).click();
    await flush();
    expect((root.activeElement as HTMLElement).getAttribute('aria-checked')).toBe('true'); // the current preset
    key('Tab');
    await flush();
    expect(root.querySelector('.hb-menu')).toBeNull();
    expect(root.activeElement).toBe(root.querySelector('.hb-preset-pill'));
    expect(actions.setPreset).not.toHaveBeenCalled();
    dispose();
  });
});

describe('framedByOtherSite', () => {
  /** A fake frame: its host, the origins framing it (Chrome's location.ancestorOrigins) and the top's host. */
  const frame = (host: string, ancestors: string[] | null, topHost?: string): Window => {
    const w: Record<string, unknown> = { location: { hostname: host, ancestorOrigins: ancestors ?? undefined } };
    w.top = ancestors?.length || topHost ? { location: { hostname: topHost ?? 'unused' } } : w;
    return w as unknown as Window;
  };

  it('lets top-level chats and chats framed by their own site have the bar', () => {
    expect(framedByOtherSite(frame('www.twitch.tv', null))).toBe(false);
    expect(framedByOtherSite(frame('www.youtube.com', ['https://www.youtube.com']))).toBe(false); // live_chat in a watch page
    expect(framedByOtherSite(frame('www.youtube.com', ['https://studio.youtube.com']))).toBe(false);
    expect(framedByOtherSite(frame('www.twitch.tv', null, 'dashboard.twitch.tv'))).toBe(false);
  });

  it('flags embeds on other sites, sandboxed frames and tops it cannot read', () => {
    expect(framedByOtherSite(frame('www.twitch.tv', ['https://evil.example']))).toBe(true);
    expect(framedByOtherSite(frame('www.youtube.com', ['https://www.youtube.com', 'https://evil.example']))).toBe(true);
    expect(framedByOtherSite(frame('kick.com', ['null']))).toBe(true);
    const w = frame('www.twitch.tv', null, 'evil.example') as unknown as Record<string, unknown>;
    w.top = {
      get location(): Location {
        throw new DOMException('Blocked a frame with origin', 'SecurityError');
      },
    };
    expect(framedByOtherSite(w as unknown as Window)).toBe(true);
  });
});
