// Pill runs: the runtime marks the LAST collapsed row of every run with its
// length (data-hush-run) so the stylesheet draws one "N hidden · show" pill
// per run with plain attribute selectors. Rules-only runtime (no model).
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PRESETS, type Settings } from '../../src/core/settings';
import type { ChatMessage } from '../../src/core/types';
import type { PlatformAdapter } from '../../src/platforms/types';
import { HushRuntime } from '../../src/runtime/engine';
import { STYLE_ID } from '../../src/runtime/styles';

const adapter: PlatformAdapter = {
  platform: 'twitch',
  matches: () => true,
  findChatList: (doc) => doc.querySelector('#chat'),
  rowSelector: '.msg',
  extract(row): ChatMessage | null {
    const d = row.dataset;
    if (!d.key) return null;
    return {
      key: d.key,
      platform: 'twitch',
      channel: 'test',
      author: d.user ?? 'anon',
      roles: 0,
      text: row.textContent ?? '',
      emotes: 0,
      mentions: [],
      isReply: false,
      isFirstMessage: false,
      paid: false,
      ts: 0,
    };
  },
  channel: () => 'test',
  barAnchor: () => null,
  theme: () => 'light',
};

let list: HTMLElement;
let rt: HushRuntime;
let seq = 0;

function setup(settings: Partial<Settings> = {}) {
  document.body.innerHTML = '<div id="chat"></div>';
  list = document.getElementById('chat')!;
  rt = new HushRuntime({
    adapter,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    classifier: null,
    now: () => 1000 + seq,
    raf: () => 1,
    caf: () => {},
    tickMs: 3_600_000,
  });
  rt.start();
  rt.flushNow();
}

function add(text: string, before?: Element): HTMLElement {
  const el = document.createElement('div');
  el.className = 'msg';
  el.dataset.key = `k${seq}`;
  el.dataset.user = `user${seq++}`;
  el.textContent = text;
  list.insertBefore(el, before ?? null);
  return el;
}
/** Character flood → spam → collapse (chill); every one distinct, so no wave. */
const pill = (before?: Element) => add(String.fromCharCode(97 + (seq % 26)).repeat(30) + seq, before);
/** Plain text → clean → show. */
const msg = (before?: Element) => add(`a normal message number ${seq}`, before);
/** Blocked word → hide (takes no space). */
const hidden = () => add(`spoiler number ${seq}`);

const frame = async () => {
  await new Promise((r) => setTimeout(r, 0)); // deliver MutationObserver records
  rt.flushNow();
};
const runs = () => Array.from(list.children, (el) => el.getAttribute('data-hush-run') ?? (el.getAttribute('data-hush-a') === 'collapse' ? '·' : '-')).join(' ');

afterEach(() => rt?.stop());

describe('pill runs', () => {
  it('marks only the last row of each run, with the run length', async () => {
    setup();
    msg();
    pill();
    pill();
    pill();
    msg();
    pill();
    await frame();
    expect(runs()).toBe('- · · 3 - 1');
  });

  it('moves the mark when a run grows at the bottom', async () => {
    setup();
    msg();
    pill();
    await frame();
    expect(runs()).toBe('- 1');
    pill();
    await frame();
    expect(runs()).toBe('- · 2');
    pill();
    pill();
    await frame();
    expect(runs()).toBe('- · · · 4');
    msg();
    pill();
    await frame();
    expect(runs()).toBe('- · · · 4 - 1');
  });

  it('rows that take no space do not break a run', async () => {
    setup({ rules: [{ id: 'r', kind: 'word', pattern: 'spoiler', mode: 'block', enabled: true }] });
    pill();
    hidden();
    pill();
    await frame();
    expect(runs()).toBe('· - 2');
  });

  it('merges and splits runs when a row in between changes', async () => {
    setup();
    const a = pill();
    const mid = msg();
    pill();
    await frame();
    expect(runs()).toBe('1 - 1');
    // a late row inserted mid-run, then removed again
    const late = pill(mid);
    await frame();
    expect(runs()).toBe('· 2 - 1');
    mid.remove();
    await frame();
    expect(runs()).toBe('· · 3');
    late.remove();
    await frame();
    expect(runs()).toBe('· 2');
    a.remove();
    await frame();
    expect(runs()).toBe('1');
  });

  it('reveal(key) splits the run around the revealed row', async () => {
    setup();
    pill();
    const b = pill();
    pill();
    await frame();
    expect(runs()).toBe('· · 3');
    expect(rt.reveal(b.dataset.key!)).toBe(true);
    expect(runs()).toBe('1 - 1');
    expect(b.hasAttribute('data-hush-open')).toBe(true);
  });

  it('clicking the pill reveals its whole run at once', async () => {
    setup();
    msg();
    const a = pill();
    const b = pill();
    const c = pill();
    const after = msg();
    const next = pill();
    await frame();
    expect(runs()).toBe('- · · 3 - 1');
    c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (const el of [a, b, c]) expect(el.hasAttribute('data-hush-open')).toBe(true);
    expect(after.hasAttribute('data-hush-open')).toBe(false);
    expect(next.hasAttribute('data-hush-open')).toBe(false);
    await frame();
    expect(runs()).toBe('- - - - - 1');
    expect(a.getAttribute('data-hush-a')).toBe('show');
  });

  it('re-marks every run when settings change, and clears marks when nothing collapses', async () => {
    setup();
    pill();
    pill();
    msg();
    pill();
    await frame();
    expect(runs()).toBe('· 2 - 1');
    rt.setSettings({ ...DEFAULT_SETTINGS, preset: 'raw', actions: { ...PRESETS.raw } });
    rt.flushNow();
    expect(runs()).toBe('- - - -');
    expect(list.querySelector('[data-hush-run]')).toBeNull();
    rt.setSettings({ ...DEFAULT_SETTINGS });
    rt.flushNow();
    expect(runs()).toBe('· 2 - 1');
  });

  it('injects the decorated row stylesheet for the platform and theme', async () => {
    setup();
    await frame();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    expect(css).toContain('[data-hush-list]>:not([data-hush-a])');
    expect(css).toContain('content:attr(data-hush-run) " hidden"');
    expect(css).toContain('--hush-indent:20px'); // twitch skin
    expect(css).toContain('--hush-c-toxic:#d42f42'); // light theme
    rt.setSettings({ ...DEFAULT_SETTINGS, decorate: false });
    const plain = document.getElementById(STYLE_ID)?.textContent ?? '';
    expect(plain).not.toContain('content:attr(data-hush-r)');
    expect(plain).toContain('content:attr(data-hush-run) " hidden"');
  });
});
