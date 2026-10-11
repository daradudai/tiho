// mountBar: shadow-DOM isolation, Basic and Advanced modes, the tab's views
// (Show hidden, Solo), keyboard, actions, cleanup (docs/ux-modes.md, B1–B12).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { options } from 'preact';
import { createStore, zeroInChat, type InChat } from '../../src/core/store';
import { DEFAULT_SETTINGS, PRESETS, type Settings } from '../../src/core/settings';
import { framedByOtherSite, mountBar, type MountOptions } from '../../src/ui/bar';
import type { BarActions } from '../../src/core/bar-actions';
import * as tokens from '../../src/ui/tokens';

const flush = () => new Promise((r) => setTimeout(r, 30));

interface Setup {
  settings?: Partial<Settings>;
  opts?: MountOptions;
  inChat?: InChat;
}

/** The tests reach into the shadow root and drive the bar with el.click() (untrusted events). */
function setup({ settings, opts = { shadow: 'open', synthetic: true }, inChat }: Setup = {}) {
  document.body.innerHTML = '<div id="col"><div id="list"></div></div>';
  const store = createStore({ ...DEFAULT_SETTINGS, ...settings });
  store.platform.value = 'twitch';
  if (inChat) store.inChat.value = inChat;
  const actions: BarActions = {
    setPreset: vi.fn(),
    setAction: vi.fn(),
    toggleEnabled: vi.fn(),
    openSidePanel: vi.fn(),
    revealMessage: vi.fn(),
    setMode: vi.fn(),
    setLevel: vi.fn(),
    setPeek: vi.fn(),
    setSolo: vi.fn(),
  };
  const list = document.getElementById('list')!;
  const dispose = mountBar({ el: list, where: 'before' }, store, actions, opts);
  const host = document.querySelector('hush-bar') as HTMLElement;
  const root = host.shadowRoot!;
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)];
  return { store, actions, dispose, host, root, $, $$ };
}

const advanced: Partial<Settings> = { uiMode: 'advanced' };

/** 152 messages in chat now: 9 hidden, 4 folded, 8 of them spam, 6 more folded into waves. */
function busyChat(): InChat {
  const n = zeroInChat();
  Object.assign(n.byCat, { toxic: 1, scam: 8, spam: 8, noise: 41, negative: 9, question: 3, positive: 10, clean: 66 });
  return { ...n, rows: 152, hidden: 9, folded: 4, inWaves: 6 };
}

/** Everything the bar says: its text, and the words it gives assistive tech and tooltips. */
function words(root: ShadowRoot): string {
  const bar = root.querySelector('.hb')!;
  const attrs = [...bar.querySelectorAll('*')].flatMap((el) => ['aria-label', 'data-tip', 'data-tip-sub'].map((a) => el.getAttribute(a) ?? ''));
  return `${bar.textContent} ${attrs.join(' ')}`;
}

const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, ...init }));

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('mountBar', () => {
  it('inserts a shadow host before the anchor and removes it on dispose', async () => {
    const { host, root, dispose } = setup();
    await flush();
    expect(host.nextElementSibling?.id).toBe('list');
    expect(root.querySelector('style')).not.toBeNull(); // (CSS ?inline is empty under vitest)
    expect(root.querySelector('.hb-row')).not.toBeNull();
    dispose();
    expect(document.querySelector('hush-bar')).toBeNull();
  });

  it('draws the mark and chip glyphs as images, not inline SVG (a paint chunk each, every frame)', async () => {
    const { root, dispose } = setup({ settings: advanced });
    await flush();
    expect(root.querySelectorAll('.hb-chip svg, .hush-live svg').length).toBe(0);
    const ico = root.querySelector('.hb-chip[data-c="toxic"] .hb-chip-ico') as HTMLElement;
    expect(ico.style.backgroundImage).toContain('data:image/svg+xml');
    expect(decodeURIComponent(ico.style.backgroundImage)).toContain('color="#ff6470"'); // dark theme toxic
    expect((root.querySelector('.hush-live') as HTMLElement).style.backgroundImage).toContain('data:image/svg+xml');
    dispose();
  });

  it('hides itself when showBar is off', async () => {
    const { host, store, dispose } = setup();
    store.settings.value = { ...store.settings.value, showBar: false };
    expect(host.style.display).toBe('none');
    dispose();
  });

  it('is closed to page scripts: no shadowRoot to reach, synthetic events ignored', async () => {
    const closed = setup({ opts: {} });
    expect(closed.host.shadowRoot).toBeNull();
    closed.dispose();

    for (const mode of ['basic', 'advanced'] as const) {
      const { root, $, actions, dispose } = setup({ settings: { uiMode: mode }, opts: { shadow: 'open' } });
      await flush();
      for (const el of root.querySelectorAll<HTMLElement>('.hb-chip, .hb-seg-btn, .hb-peek, .hb-peek-ico')) el.click();
      root.querySelector('.hb-chip')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true }));
      $('.hb-mark').click();
      await flush();
      for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
      expect(root.querySelector('.hb-menu, .hb-panel')).toBeNull();
      dispose();
    }
  });
});

describe('Basic bar', () => {
  it('is the mark, one question with Off / Clean / Quiet, and Show hidden: no chevron, chips or model dot (B1)', async () => {
    const { $, $$, dispose } = setup();
    await flush();
    expect($('.hb').dataset.mode).toBe('basic');
    expect($('.hb-mark').getAttribute('aria-label')).toBe('Hush options');
    const group = $('.hb-row [role="radiogroup"]');
    expect(group.getAttribute('aria-label')).toBe('How much should Hush hide?');
    expect($$('.hb-row [role="radio"]').map((r) => r.textContent)).toEqual(['Off', 'Clean', 'Quiet']);
    expect($('.hb-peek').textContent).toBe('Show hidden');
    expect($$('.hb-expand, .hb-chip, .hb-status, .hb-preset-pill').length).toBe(0);
    dispose();
  });

  it('never shows a number and never re-renders while chat flows (B2)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { store, root, $, dispose } = setup({ inChat: busyChat() });
    await vi.advanceTimersByTimeAsync(50);
    $('.hb-mark').click(); // the sheet too
    await vi.advanceTimersByTimeAsync(50);
    expect(root.querySelector('.hb-sheet')).not.toBeNull();

    let renders = 0;
    const prev = options.diffed;
    options.diffed = (vnode) => {
      if (typeof vnode.type === 'function') renders++;
      prev?.(vnode);
    };
    try {
      for (let i = 1; i <= 6; i++) {
        // 50 msg/s: everything the runtime flushes about chat
        const n = busyChat();
        n.rows += i * 7;
        n.byCat.noise += i * 7;
        store.inChat.value = n;
        store.seen.value += 50;
        store.rate.value = [...store.rate.peek().slice(1), 50 + i];
        store.vibe.value = [...store.vibe.peek().slice(1), i / 10];
        store.waves.value = [{ id: 'w', text: 'KEKW', count: 10 * i, users: 10 * i, startedAt: 0, lastAt: 0 }];
        store.perf.value = { ...store.perf.peek(), p50ms: i, msgsPerSec: 50 };
        await vi.advanceTimersByTimeAsync(600);
      }
      expect(renders).toBe(0);
      expect(words(root)).not.toMatch(/[0-9%]/);
      // (the counter works: a settings change does re-render)
      store.settings.value = { ...store.settings.value, preset: 'focus', actions: { ...PRESETS.focus } };
      await vi.advanceTimersByTimeAsync(50);
      expect(renders).toBeGreaterThan(0);
    } finally {
      options.diffed = prev;
      dispose();
    }
  });

  it('follows the level the settings amount to; a custom setup checks nothing and says so (B3)', async () => {
    const { store, $, $$, dispose } = setup();
    await flush();
    const checked = () => $$('.hb-row [role="radio"]').filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent);
    expect(checked()).toEqual(['Clean']);
    store.settings.value = { ...store.settings.value, preset: 'focus', actions: { ...PRESETS.focus } };
    await flush();
    expect(checked()).toEqual(['Quiet']);
    store.settings.value = { ...store.settings.value, preset: 'custom' };
    await flush();
    expect(checked()).toEqual([]);
    expect($('.hb-level').hasAttribute('data-none')).toBe(true);
    $('.hb-mark').click();
    await flush();
    expect($('.hb-sheet').textContent).toContain("You're using a custom setup from Advanced mode. Pick a level to replace it.");
    expect($$('.hb-sheet [role="radio"][aria-checked="true"]').length).toBe(0);
    dispose();
  });

  it('picks a level with a click or the arrow keys', async () => {
    const { $$, actions, dispose } = setup();
    await flush();
    const radios = $$('.hb-row [role="radio"]');
    radios[2]!.click();
    expect(actions.setLevel).toHaveBeenCalledWith('focus');
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]); // the checked one is the Tab stop
    radios[1]!.focus();
    key(radios[1]!, 'ArrowLeft');
    expect(actions.setLevel).toHaveBeenLastCalledWith('off');
    dispose();
  });

  it('says Hush is off where Show hidden was, everywhere or on this site only (B4)', async () => {
    const { store, $, dispose } = setup({ settings: { enabled: false } });
    await flush();
    expect($('.hb-peek')).toBeNull();
    expect($('.hb-offnote').textContent).toBe('Hush is off');
    expect($('.hb-row [aria-checked="true"]').textContent).toBe('Off');
    store.settings.value = { ...store.settings.value, enabled: true, sites: { ...store.settings.value.sites, twitch: false } };
    await flush();
    expect($('.hb-offnote').textContent).toBe('Off on Twitch');
    expect($('.hb-mark').dataset.tip).toBe('Hush is off on Twitch.');
    dispose();
  });

  it('Show hidden toggles its label and aria-pressed and calls setPeek (B5)', async () => {
    const { store, $, actions, dispose } = setup();
    await flush();
    const btn = $('.hb-peek');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Show hidden'); // kept when only the eye shows (< 300 px)
    btn.click();
    expect(actions.setPeek).toHaveBeenCalledWith(true);
    store.peek.value = true;
    await flush();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.textContent).toBe('Hide again');
    expect(btn.getAttribute('aria-label')).toBe('Hide again');
    btn.click();
    expect(actions.setPeek).toHaveBeenLastCalledWith(false);
    dispose();
  });

  it('the sheet: status, levels, notes, the Advanced mode switch and privacy (B6)', async () => {
    const { $, $$, actions, dispose } = setup({ settings: { rules: [{ id: 'r', kind: 'word', pattern: 'x', mode: 'block', enabled: true }] } });
    await flush();
    $('.hb-mark').click();
    await flush();
    const sheet = $('.hb-sheet');
    expect(sheet.textContent).toContain('Hush is cleaning up this chat.');
    expect($$('.hb-sheet [role="radio"]').length).toBe(3);
    expect(sheet.textContent).toContain('Recommended');
    expect(sheet.textContent).toContain('Also on from Advanced mode: your rules.');
    expect(sheet.textContent).toContain('"Show hidden" brings back anything Hush hid.');
    expect(sheet.textContent).toContain('Runs on your computer. Nothing leaves it.');
    const sw = $('.hb-sheet [role="switch"]');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    sw.click();
    expect(actions.setMode).toHaveBeenCalledWith('advanced');
    dispose();
  });

  it('switching to Advanced keeps the sheet open, as the live view', async () => {
    const { store, $, dispose } = setup();
    await flush();
    $('.hb-mark').click();
    await flush();
    store.settings.value = { ...store.settings.value, uiMode: 'advanced' };
    await flush();
    expect($('.hb-sheet')).toBeNull();
    expect($('.hb-panel')).not.toBeNull();
    dispose();
  });

  it('the mark shows model progress only, in plain words', async () => {
    const { store, $, dispose } = setup();
    await flush();
    const model = () => new Promise((r) => setTimeout(r, 150)); // model status: ≤ 10×/s
    expect($('.hb-mark').dataset.tip).toBe('Hush is cleaning up this chat.');
    expect($('.hb-ring, .hb-ring-spin, .hb-mark-err')).toBeNull();
    store.model.value = { state: 'downloading', backend: 'none', progress: 0.4 };
    await model();
    expect($('.hb-mark svg.hb-ring')).not.toBeNull();
    expect($('.hb-mark').dataset.tip).toBe('Getting ready… Simple filters already work.');
    store.model.value = { state: 'loading', backend: 'webgpu' };
    await model();
    expect($('.hb-ring-spin')).not.toBeNull();
    store.model.value = { state: 'error', backend: 'none', error: 'x' };
    await model();
    expect($('.hb-mark-err')).not.toBeNull();
    expect($('.hb-mark').dataset.tip).toBe("Hush's AI didn't start. Simple filters still work.");
    $('.hb-mark').click();
    await flush();
    expect($('.hs-status').textContent).toContain('Retry');
    dispose();
  });
});

describe('Advanced bar', () => {
  it('a chip click shows only that category, a second one everything; never changes the action (B7)', async () => {
    const { store, $, actions, dispose } = setup({ settings: advanced, inChat: busyChat() });
    await flush();
    const spam = $('.hb-chip[data-c="spam"]');
    expect(spam.getAttribute('aria-label')).toBe('Spam, folded, 8 in chat now. Show only spam.');
    spam.click();
    expect(actions.setSolo).toHaveBeenCalledWith('spam');
    store.solo.value = 'spam';
    await flush();
    expect(spam.getAttribute('aria-pressed')).toBe('true');
    expect($('.hb-chip[data-c="toxic"]').hasAttribute('data-faded')).toBe(true);
    spam.click();
    expect(actions.setSolo).toHaveBeenLastCalledWith(null);
    $('.hb-chip[data-c="toxic"]').click(); // a faded chip switches
    expect(actions.setSolo).toHaveBeenLastCalledWith('toxic');
    expect(actions.setAction).not.toHaveBeenCalled();
    dispose();
  });

  it('right-click opens the chip menu: Show only first, then the actions', async () => {
    const { store, $, $$, actions, dispose } = setup({ settings: advanced, inChat: busyChat() });
    await flush();
    $('.hb-chip[data-c="spam"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true }));
    await flush();
    expect($('.hb-menu-cat').textContent).toContain('8 in chat now');
    const items = $$('.hb-menu [role^="menuitem"]');
    expect(items[0]!.textContent).toBe('Show only Spam');
    expect(items.slice(1).map((i) => i.textContent)).toEqual(['Show', 'Highlight', 'Dim', 'Fold', 'Hide']);
    items[5]!.click();
    expect(actions.setAction).toHaveBeenCalledWith('spam', 'hide');
    store.solo.value = 'spam';
    await flush();
    $('.hb-chip[data-c="spam"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true }));
    await flush();
    const first = $('.hb-menu [role="menuitem"]');
    expect(first.textContent).toBe('Show everything');
    first.click();
    expect(actions.setSolo).toHaveBeenCalledWith(null);
    dispose();
  });

  it('during Solo the pill takes the preset’s place and counts what is in chat now (B8)', async () => {
    const { store, $, actions, dispose } = setup({ settings: advanced, inChat: busyChat() });
    store.solo.value = 'spam';
    await flush();
    expect($('.hb-preset-pill')).toBeNull();
    expect($('.hb-peek-ico')).toBeNull(); // no Show hidden during Solo
    const pill = $('.hb-solo');
    expect(pill.textContent).toBe('Only Spam · 8');
    expect(pill.getAttribute('aria-label')).toBe('Showing only spam, 8 in chat now. Show all messages.');
    store.solo.value = 'scam';
    await flush();
    expect($('.hb-solo').textContent).toBe('Only Scam · 8');
    store.inChat.value = zeroInChat();
    await new Promise((r) => setTimeout(r, 650)); // counters: ≤ 2×/s
    expect($('.hb-solo').textContent).toBe('Only Scam · none yet');
    $('.hb-solo').click();
    expect(actions.setSolo).toHaveBeenCalledWith(null);
    dispose();
  });

  it('the preset menu applies a preset; labels are Raw, Clean, Quiet, Questions', async () => {
    const { $, $$, actions, dispose } = setup({ settings: advanced });
    await flush();
    expect($('.hb-preset-pill').textContent).toBe('Clean');
    $('.hb-preset-pill').click();
    await flush();
    const items = $$('.hb-menu-item');
    expect(items.map((i) => i.querySelector('b')!.textContent)).toEqual(['Raw', 'Clean', 'Quiet', 'Questions']);
    items[2]!.click();
    expect(actions.setPreset).toHaveBeenCalledWith('focus');
    dispose();
  });

  it('Show hidden is an eye; off, the row says so and offers Turn on', async () => {
    const { store, $, actions, dispose } = setup({ settings: advanced });
    await flush();
    $('.hb-peek-ico').click();
    expect(actions.setPeek).toHaveBeenCalledWith(true);
    store.settings.value = { ...store.settings.value, enabled: false };
    await flush();
    expect($('.hb-paused').textContent).toContain('Hush is off');
    expect($('.hb-chip')).toBeNull();
    ($('.hb-paused button') as HTMLElement).click();
    expect(actions.toggleEnabled).toHaveBeenCalled();
    dispose();
  });

  it('the live view: in chat now, category rows (click: Solo, ▾: change), Other, Basic mode (B6, B10)', async () => {
    const { store, $, $$, actions, dispose } = setup({ settings: advanced, inChat: busyChat() });
    store.questions.value = [
      {
        msg: { key: 'k1', author: 'ana', text: 'what mouse?', ts: Date.now(), platform: 'twitch', channel: 'x' },
        verdict: { category: 'question', action: 'highlight', reason: 'question · 95%', source: 'model' },
      },
    ];
    await flush();
    $('.hb-mark').click();
    await flush();
    expect($('.hp-now').textContent).toBe('152 messages · 9 hidden · 4 folded');
    expect($('.hb-panel').textContent).toContain('last 60 s');
    expect($('.hb-panel').textContent).toContain('last 5 min');
    expect($$('.hp-cat').map((c) => c.dataset.c)).toContain('clean');
    expect($('.hp-cat[data-c="clean"]').textContent).toContain('Other');

    $('.hp-cat[data-c="spam"] .hp-cat-main').click();
    expect(actions.setSolo).toHaveBeenCalledWith('spam');
    $('.hp-cat[data-c="spam"] .hp-cat-more').click();
    await flush();
    expect($('.hb-menu [role="menuitem"]').textContent).toBe('Show only Spam');
    expect($('.hb-panel')).not.toBeNull(); // the menu opens over the panel

    store.solo.value = 'spam';
    await flush();
    expect($('.hp-now').textContent).toBe('Only Spam: 8 of 152 messages');
    expect($('.hp-cat[data-c="spam"] .hp-cat-main').getAttribute('aria-pressed')).toBe('true');

    ($('.hp-q') as HTMLElement).click();
    expect(actions.revealMessage).toHaveBeenCalledWith('k1');
    const basic = $$('.hp-foot button').find((b) => b.textContent === 'Basic mode')!;
    basic.click();
    expect(actions.setMode).toHaveBeenCalledWith('basic');
    dispose();
  });

  it('menus take focus, move with the arrow keys and give focus back on Escape or Tab', async () => {
    const { root, $, actions, dispose } = setup({ settings: advanced });
    await flush();
    const chip = $('.hb-chip[data-c="spam"]'); // clean: fold
    chip.focus();
    chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true }));
    await flush();
    const items = [...root.querySelectorAll<HTMLElement>('.hb-menu [role="menuitemradio"]')];
    expect(root.activeElement).toBe(items.find((i) => i.dataset.a === 'collapse'));
    const press = (k: string) => key(root.activeElement!, k);
    press('ArrowDown');
    expect((root.activeElement as HTMLElement).dataset.a).toBe('hide');
    press('ArrowDown'); // wraps around, to Show only
    expect((root.activeElement as HTMLElement).textContent).toBe('Show only Spam');
    press('End');
    expect((root.activeElement as HTMLElement).dataset.a).toBe('hide');
    key(document, 'Escape');
    await flush();
    expect(root.querySelector('.hb-menu')).toBeNull();
    expect(root.activeElement).toBe(chip);

    $('.hb-preset-pill').click();
    await flush();
    expect((root.activeElement as HTMLElement).getAttribute('aria-checked')).toBe('true'); // the current preset
    press('Tab');
    await flush();
    expect(root.querySelector('.hb-menu')).toBeNull();
    expect(root.activeElement).toBe($('.hb-preset-pill'));
    expect(actions.setPreset).not.toHaveBeenCalled();
    dispose();
  });
});

describe('Escape (B9)', () => {
  it('closes a menu, then the panel, then ends Solo, then Show hidden', async () => {
    const { store, $, actions, dispose } = setup({ settings: advanced });
    store.solo.value = 'spam';
    await flush();
    $('.hb-mark').click();
    await flush();
    $('.hp-cat[data-c="toxic"] .hp-cat-more').click();
    await flush();
    key(document, 'Escape');
    await flush();
    expect($('.hb-menu')).toBeNull();
    expect($('.hb-panel')).not.toBeNull();
    key(document, 'Escape');
    await flush();
    expect($('.hb-panel')).toBeNull();
    expect(actions.setSolo).not.toHaveBeenCalled();
    key(document, 'Escape');
    expect(actions.setSolo).toHaveBeenCalledWith(null);
    store.solo.value = null;
    store.peek.value = true;
    await flush();
    key(document, 'Escape');
    expect(actions.setPeek).toHaveBeenCalledWith(false);
    dispose();
  });

  it('is left alone while the viewer types, and when no view or popover is open', async () => {
    const { store, actions, dispose } = setup();
    await flush();
    key(document, 'Escape');
    expect(actions.setPeek).not.toHaveBeenCalled();
    store.peek.value = true;
    await flush();
    const box = document.createElement('div');
    box.contentEditable = 'true';
    box.setAttribute('contenteditable', 'true');
    document.body.append(box);
    const input = document.createElement('input');
    document.body.append(input);
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    box.dispatchEvent(e);
    key(input, 'Escape');
    expect(actions.setPeek).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    key(document, 'Escape');
    expect(actions.setPeek).toHaveBeenCalledWith(false);
    dispose();
  });
});

describe('words', () => {
  it('no surface says hushed, Vibe, click to cycle, Open dashboard or Hush is paused (B11)', async () => {
    const banned = /hushed|vibe|click to cycle|open dashboard|hush is paused|resume/i;
    for (const mode of ['basic', 'advanced'] as const) {
      for (const enabled of [true, false]) {
        const { root, $, dispose } = setup({ settings: { uiMode: mode, enabled }, inChat: busyChat() });
        await flush();
        expect(words(root)).not.toMatch(banned);
        $('.hb-mark').click();
        await flush();
        expect(words(root)).not.toMatch(banned);
        dispose();
      }
    }
    const { root, $, dispose } = setup({ settings: advanced });
    await flush();
    $('.hb-chip[data-c="spam"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true }));
    await flush();
    expect(words(root)).not.toMatch(banned);
    $('.hb-preset-pill').click();
    await flush();
    expect(words(root)).not.toMatch(banned);
    dispose();
    expect('nextAction' in tokens).toBe(false);
    expect('ACTION_CYCLE' in tokens).toBe(false);
  });

  it('levels and presets say the same thing (one name per setting on every surface)', () => {
    expect(tokens.LEVEL_META.chill.label).toBe(tokens.PRESET_META.chill.label);
    expect(tokens.LEVEL_META.focus.desc).toBe(tokens.PRESET_META.focus.desc);
    expect(tokens.LEVEL_ORDER.map((l) => tokens.LEVEL_META[l].label)).toEqual(['Off', 'Clean', 'Quiet']);
    expect(tokens.PRESET_ORDER.map((p) => tokens.PRESET_META[p].label)).toEqual(['Raw', 'Clean', 'Quiet', 'Questions']);
    for (const s of [...Object.values(tokens.LEVEL_META).map((m) => m.desc), ...Object.values(tokens.PLAIN).filter((x) => typeof x === 'string')])
      expect(s).not.toMatch(/[0-9%]/);
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
