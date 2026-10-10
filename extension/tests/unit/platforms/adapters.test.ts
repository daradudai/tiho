import { afterAll, describe, expect, it } from 'vitest';
import { Role, type ChatMessage } from '../../../src/core/types';
import { detectAdapter, kick, twitch, youtube } from '../../../src/platforms';
import type { PlatformAdapter } from '../../../src/platforms/types';
import { loadFixture, type Loaded } from './fixture';

const loaded: Loaded[] = [];
afterAll(async () => {
  for (const l of loaded) await l.close();
});

function open(file: string, url: string) {
  const l = loadFixture(file, url);
  loaded.push(l);
  const adapter = detectAdapter(l.doc.location as unknown as Location);
  if (!adapter) throw new Error('no adapter for ' + url);
  const list = adapter.findChatList(l.doc);
  if (!list) throw new Error('no chat list in ' + file);
  const rows = Array.from(list.children) as HTMLElement[];
  return { ...l, adapter, list, rows };
}

/** Rows labelled with data-fixture="…" (special fixtures). */
function byLabel(rows: HTMLElement[], a: PlatformAdapter) {
  const out = new Map<string, { row: HTMLElement; isRow: boolean; msg: ChatMessage | null }>();
  for (const row of rows) {
    const label = row.getAttribute('data-fixture');
    if (!label) continue;
    const isRow = row.matches(a.rowSelector);
    out.set(label, { row, isRow, msg: isRow ? a.extract(row) : null });
  }
  return out;
}

function sane(m: ChatMessage, platform: string) {
  expect(m.platform).toBe(platform);
  expect(m.author.length).toBeGreaterThan(0);
  expect(m.author.startsWith('@')).toBe(false);
  expect(m.text).toBe(m.text.trim());
  expect(m.text).not.toMatch(/\s{2}|[\n\t ​]/);
  expect(m.key.length).toBeGreaterThan(1);
  expect(m.emotes).toBeGreaterThanOrEqual(0);
  for (const n of m.mentions) expect(n.startsWith('@')).toBe(false);
}

// ---------------------------------------------------------------------------

describe('detectAdapter / matches', () => {
  const cases: [string, string | null][] = [
    ['https://www.youtube.com/live_chat?v=abc&is_popout=1', 'youtube'],
    ['https://www.youtube.com/live_chat?continuation=0ofMyA', 'youtube'],
    ['https://www.youtube.com/live_chat_replay?continuation=xyz', 'youtube'],
    ['https://www.youtube.com/watch?v=abc', null],
    ['https://www.youtube.com/', null],
    ['https://m.youtube.com/live_chat?v=abc', null],
    ['https://www.twitch.tv/gorgc', 'twitch'],
    ['https://www.twitch.tv/popout/gorgc/chat?popout=', 'twitch'],
    ['https://www.twitch.tv/embed/gorgc/chat?parent=example.com', 'twitch'],
    ['https://www.twitch.tv/moderator/gorgc', 'twitch'],
    ['https://dashboard.twitch.tv/popout/u/gorgc/stream-manager/chat', 'twitch'],
    ['https://www.twitch.tv/', null],
    ['https://www.twitch.tv/directory/all', null],
    ['https://www.twitch.tv/gorgc/videos', null],
    ['https://www.twitch.tv/videos/123456', null],
    ['https://kick.com/absi', 'kick'],
    ['https://kick.com/popout/absi/chat', 'kick'],
    ['https://kick.com/browse', null],
    ['https://kick.com/categories/just-chatting', null],
    ['https://kick.com/absi/videos/abc', null],
    ['https://example.com/live_chat', null],
  ];
  for (const [url, want] of cases) {
    it(`${url} → ${want}`, () => {
      const u = new URL(url) as unknown as Location;
      expect(detectAdapter(u)?.platform ?? null).toBe(want);
    });
  }
});

describe('rowSelector is usable by the runtime', () => {
  for (const a of [youtube, twitch, kick]) {
    it(a.platform, () => {
      const { doc } = loadFixture('twitch/special.html', 'https://www.twitch.tv/popout/gorgc/chat');
      expect(() => doc.querySelector(a.rowSelector)).not.toThrow();
      expect(() => doc.querySelector(`:is(${a.rowSelector})[data-hush-a="hide"]`)).not.toThrow();
      expect(a.observeSubtree).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Whole-list fixtures: every row extracts, keys are unique, page helpers work.

const LISTS: { file: string; url: string; platform: string; channel: string; theme: 'dark' | 'light'; minMsgs: number }[] = [
  { file: 'youtube/popout.html', url: 'https://www.youtube.com/live_chat?is_popout=1&v=l2oa8BexdmU', platform: 'youtube', channel: 'l2oa8BexdmU', theme: 'light', minMsgs: 30 },
  { file: 'youtube/special-dark.html', url: 'https://www.youtube.com/live_chat?v=Hna6tCKcve8', platform: 'youtube', channel: 'Hna6tCKcve8', theme: 'dark', minMsgs: 10 },
  { file: 'twitch/channel-page.html', url: 'https://www.twitch.tv/jinnytty', platform: 'twitch', channel: 'jinnytty', theme: 'light', minMsgs: 30 },
  { file: 'twitch/popout-dark.html', url: 'https://www.twitch.tv/popout/gorgc/chat', platform: 'twitch', channel: 'gorgc', theme: 'dark', minMsgs: 30 },
  { file: 'twitch/special.html', url: 'https://www.twitch.tv/popout/gorgc/chat', platform: 'twitch', channel: 'gorgc', theme: 'light', minMsgs: 15 },
  { file: 'twitch/seventv.html', url: 'https://www.twitch.tv/gorgc', platform: 'twitch', channel: 'gorgc', theme: 'light', minMsgs: 30 },
  { file: 'kick/channel-page.html', url: 'https://kick.com/absi', platform: 'kick', channel: 'absi', theme: 'dark', minMsgs: 25 },
  { file: 'kick/popout.html', url: 'https://kick.com/popout/zengibre/chat', platform: 'kick', channel: 'zengibre', theme: 'dark', minMsgs: 25 },
  { file: 'kick/special.html', url: 'https://kick.com/popout/absi/chat', platform: 'kick', channel: 'absi', theme: 'dark', minMsgs: 12 },
];

describe.each(LISTS)('$file', ({ file, url, platform, channel, theme, minMsgs }) => {
  const f = open(file, url);
  const msgs = f.rows.filter((r) => r.matches(f.adapter.rowSelector)).map((r) => f.adapter.extract(r));
  const ok = msgs.filter((m): m is ChatMessage => !!m);

  it('detects the platform and the list', () => {
    expect(f.adapter.platform).toBe(platform);
    expect(f.rows.length).toBeGreaterThan(10);
  });
  it('channel / theme / bar anchor', () => {
    expect(f.adapter.channel(f.doc)).toBe(channel);
    expect(f.adapter.theme(f.doc)).toBe(theme);
    const anchor = f.adapter.barAnchor(f.doc);
    expect(anchor).not.toBeNull();
    expect(anchor!.el.isConnected).toBe(true);
    // the bar must sit above the list, never inside it
    expect(f.list.contains(anchor!.el)).toBe(false);
    if (anchor!.where === 'before') expect(anchor!.el.contains(f.list) || anchor!.el.nextElementSibling !== null).toBe(true);
  });
  it(`extracts ≥ ${minMsgs} messages with sane fields`, () => {
    expect(ok.length).toBeGreaterThanOrEqual(minMsgs);
    for (const m of ok) {
      sane(m, platform);
      expect(m.channel).toBe(channel);
    }
  });
  it('keys are unique within the list', () => {
    const keys = new Set(ok.map((m) => m.key));
    expect(keys.size).toBe(ok.length);
  });
  it('re-extracting the same node returns the same key', () => {
    const r = f.rows.find((x) => x.matches(f.adapter.rowSelector) && f.adapter.extract(x));
    expect(f.adapter.extract(r!)!.key).toBe(f.adapter.extract(r!)!.key);
  });
});

// ---------------------------------------------------------------------------
// Special rows, one per kind.

describe('YouTube special rows', () => {
  const f = open('youtube/special-dark.html', 'https://www.youtube.com/live_chat?v=Hna6tCKcve8');
  const L = byLabel(f.rows, f.adapter);
  const m = (k: string) => {
    const e = L.get(k);
    expect(e, k).toBeTruthy();
    return e!.msg!;
  };
  it('plain text', () => {
    expect(m('plain')).toMatchObject({ roles: 0, emotes: 0, paid: false, isReply: false });
    expect(m('plain').text.length).toBeGreaterThan(3);
  });
  it('key is the YouTube message id', () => {
    expect(m('plain').key).toBe('y' + L.get('plain')!.row.id);
  });
  it('unicode emoji images become characters, not emotes', () => {
    expect(m('emoji-unicode').text).toContain('🇪🇨');
    expect(m('emoji-unicode').emotes).toBe(0);
    expect(m('emoji-only').text.length).toBeGreaterThan(0);
    expect(m('emoji-only').emotes).toBe(0);
  });
  it('custom emoji become their name and are counted', () => {
    expect(m('emoji-custom').emotes).toBeGreaterThanOrEqual(1);
    expect(m('emoji-custom').text).toMatch(/face-green-smiling/);
    expect(m('emoji-custom').text).not.toContain(':');
  });
  it('roles from author-type and badges', () => {
    expect(m('owner').roles & Role.BROADCASTER).toBeTruthy();
    expect(m('moderator').roles & Role.MOD).toBeTruthy();
    expect(m('member').roles & Role.MEMBER).toBeTruthy();
    expect(m('verified').roles & Role.VERIFIED).toBeTruthy();
    expect(m('plain').roles).toBe(0);
  });
  it('mentions', () => {
    expect(m('mention').mentions.length).toBe(1);
    expect(m('mention').text.startsWith('@' + m('mention').mentions[0])).toBe(true);
  });
  it('super chat and super sticker are paid', () => {
    expect(m('superchat')).toMatchObject({ paid: true });
    expect(m('superchat').text.length).toBeGreaterThan(5);
    expect(m('sticker')).toMatchObject({ paid: true, text: '', emotes: 1 });
  });
  it('system rows are null / not rows', () => {
    expect(L.get('membership-new')!.isRow).toBe(true);
    expect(L.get('membership-new')!.msg).toBeNull();
    for (const k of ['gift-purchase', 'gift-redemption', 'placeholder', 'engagement']) {
      expect(L.get(k)!.isRow, k).toBe(false);
      expect(youtube.extract(L.get(k)!.row), k).toBeNull();
    }
  });
});

describe('Twitch special rows', () => {
  const f = open('twitch/special.html', 'https://www.twitch.tv/popout/gorgc/chat');
  const L = byLabel(f.rows, f.adapter);
  const m = (k: string) => {
    const e = L.get(k);
    expect(e, k).toBeTruthy();
    return e!.msg!;
  };
  it('system rows → null', () => {
    for (const k of ['welcome', 'deleted', 'notice-streak']) {
      expect(L.get(k)!.isRow, k).toBe(true);
      expect(L.get(k)!.msg, k).toBeNull();
    }
  });
  it('plain', () => {
    expect(m('plain')).toMatchObject({ text: 'nrg wake up', roles: 0, emotes: 0, paid: false, isReply: false });
    expect(m('plain').authorId).toBe(m('plain').author.toLowerCase());
  });
  it('emotes become their code', () => {
    expect(m('emote-only')).toMatchObject({ text: 'LUL', emotes: 1 });
    expect(m('text-and-emote').text).toBe('NRG should ask china teams for fire power LUL');
    expect(m('text-and-emote').emotes).toBe(1);
    expect(m('me-italic').text).toBe('Chat just did a 7x SCATTER combo SeemsGood');
  });
  it('badges → roles (UUID based, locale independent)', () => {
    expect(m('moderator').roles & Role.MOD).toBeTruthy();
    expect(m('broadcaster(synthesized)').roles & Role.BROADCASTER).toBeTruthy();
    expect(m('vip').roles & Role.VIP).toBeTruthy();
    expect(m('verified').roles & Role.VERIFIED).toBeTruthy();
    expect(m('subscriber').roles & Role.SUB).toBeTruthy();
    expect(m('plain').roles).toBe(0);
  });
  it('mentions and replies', () => {
    expect(m('mention').mentions).toEqual(['Gorgc']);
    expect(m('reply').isReply).toBe(true);
    expect(m('reply').mentions.length).toBe(1); // reply target
    expect(m('reply').text).not.toMatch(/Replying to/);
    expect(m('plain').isReply).toBe(false);
  });
  it('cheer is paid; cheermote code without the amount', () => {
    expect(m('cheer').paid).toBe(true);
    expect(m('cheer').text.startsWith('Cheer300 Tomorrow is Sunday')).toBe(true);
  });
  it('links keep their text', () => {
    expect(m('link').text).toMatch(/: https:\/\/www\.you\S+/);
  });
  it('international display name: author = display, authorId = login', () => {
    expect(m('intl-name').author).not.toMatch(/[()]/);
    expect(m('intl-name').authorId).toBeTruthy();
  });
  it('user messages inside notices (streak / resub / highlight) are extracted', () => {
    expect(m('notice-streak-with-message').text.length).toBeGreaterThan(0);
    expect(m('notice-resub-with-message').text.length).toBeGreaterThan(0);
    expect(m('highlighted').mentions).toEqual(['Gorgc']);
  });
  it('identical content in two nodes → different keys (ordinal), same node → same key', () => {
    const row = L.get('plain')!.row;
    const a = row.cloneNode(true) as HTMLElement;
    const b = row.cloneNode(true) as HTMLElement;
    f.list.append(a, b);
    const ka = twitch.extract(a)!.key;
    const kb = twitch.extract(b)!.key;
    expect(ka).not.toBe(kb);
    expect(twitch.extract(a)!.key).toBe(ka);
    a.remove();
    b.remove();
  });
});

describe('Twitch + 7TV rows', () => {
  const f = open('twitch/seventv.html', 'https://www.twitch.tv/gorgc');
  const L = byLabel(f.rows, f.adapter);
  it('finds the 7TV list (not the outer <seventv-container>)', () => {
    expect(f.list.tagName).toBe('MAIN');
    expect(f.list.classList.contains('seventv-chat-list')).toBe(true);
    expect(f.rows.every((r) => r.matches(twitch.rowSelector))).toBe(true);
  });
  it('welcome → null', () => {
    expect(L.get('welcome')!.msg).toBeNull();
  });
  it('key is the Twitch message id (msg-id)', () => {
    const r = f.rows.find((x) => twitch.extract(x))!;
    expect(twitch.extract(r)!.key).toBe('t' + r.getAttribute('msg-id'));
  });
  it('reply', () => {
    const m = L.get('reply')!.msg!;
    expect(m.isReply).toBe(true);
    expect(m.mentions).toHaveLength(1);
    expect(m.text).not.toMatch(/Replying/);
  });
  it('7TV emotes are counted and become their code', () => {
    const ms = f.rows.map((r) => twitch.extract(r)).filter((m): m is ChatMessage => !!m);
    const lul = ms.find((m) => m.text === 'LUL LUL LUL LUL');
    expect(lul?.emotes).toBe(4);
    expect(ms.filter((m) => m.emotes > 0).length).toBeGreaterThan(10);
    expect(ms.some((m) => m.roles & Role.SUB)).toBe(true);
  });
});

describe('Kick special rows', () => {
  const f = open('kick/special.html', 'https://kick.com/popout/absi/chat');
  const L = byLabel(f.rows, f.adapter);
  const m = (k: string) => {
    const e = L.get(k);
    expect(e, k).toBeTruthy();
    return e!.msg!;
  };
  it('plain', () => {
    expect(m('plain')).toMatchObject({ roles: 0, emotes: 0, paid: false, isReply: false });
  });
  it('emotes', () => {
    expect(m('emote-only')).toMatchObject({ text: 'KEKW', emotes: 1 });
    expect(m('text-and-emote').emotes).toBe(1);
    expect(m('text-and-emote').text).toMatch(/ absi29$/);
  });
  it('badges → roles', () => {
    expect(m('broadcaster').roles).toBe(Role.BROADCASTER | Role.VERIFIED);
    expect(m('moderator').roles & Role.MOD).toBeTruthy();
    expect(m('vip').roles & Role.VIP).toBeTruthy();
    expect(m('subscriber').roles & Role.SUB).toBeTruthy();
    expect(m('founder').roles & Role.SUB).toBeTruthy();
    expect(m('plain').roles).toBe(0);
  });
  it('mentions in text and reply target', () => {
    expect(m('mention').mentions).toHaveLength(1);
    expect(m('reply').isReply).toBe(true);
    expect(m('reply').mentions).toHaveLength(1);
    expect(m('reply').text).not.toMatch(/Replying to/);
  });
  it('links keep their text', () => {
    expect(m('link').text).toMatch(/^https:\/\/creators\.sa\//);
  });
  it('kicks gift is paid and keeps the user text', () => {
    expect(m('kicks-gift')).toMatchObject({ paid: true, text: 'hello there' });
  });
  it('system rows → null', () => {
    expect(L.get('subscription-notice')!.msg).toBeNull();
    expect(L.get('new-messages-divider')!.msg).toBeNull();
  });
  it('a re-mounted row (unmounted, then a new node with the same content) gets the same key', () => {
    const row = L.get('plain')!.row;
    const k = kick.extract(row)!.key;
    const next = row.nextElementSibling;
    row.remove();
    const clone = row.cloneNode(true) as HTMLElement;
    clone.setAttribute('data-index', '999');
    f.list.insertBefore(clone, next);
    expect(kick.extract(clone)!.key).toBe(k);
  });
});

// ---------------------------------------------------------------------------
// Micro-benchmark (happy-dom is a JS DOM, several times slower than Chrome;
// see tests/tools/bench-adapters.mjs for real-browser numbers).

describe('extract() micro-benchmark', () => {
  it('µs per row', () => {
    const out: string[] = [];
    for (const { file, url } of LISTS) {
      const f = open(file, url);
      const base = f.rows.filter((r) => r.matches(f.adapter.rowSelector));
      const nodes: HTMLElement[] = [];
      for (let c = 0; c < 15; c++)
        for (const r of base) {
          const n = r.cloneNode(true) as HTMLElement;
          f.list.appendChild(n);
          nodes.push(n);
        }
      for (const r of base) f.adapter.extract(r); // warm-up
      const t0 = performance.now();
      for (const n of nodes) f.adapter.extract(n);
      const us = ((performance.now() - t0) * 1000) / nodes.length;
      out.push(`${file.padEnd(28)} ${us.toFixed(1).padStart(7)} µs/row (${nodes.length} rows, happy-dom)`);
      expect(us).toBeLessThan(1000);
    }
    console.log('\n' + out.join('\n'));
  });
});

describe('Kick keys: re-mount vs duplicate', () => {
  it('a duplicate mounted alongside the original gets a distinct key; a re-mount after unmount gets the original key', () => {
    const f = open('kick/special.html', 'https://kick.com/popout/absi/chat');
    const row = f.rows.find((r) => r.getAttribute('data-fixture') === 'plain')!;
    const k0 = kick.extract(row)!.key;
    const dup = row.cloneNode(true) as HTMLElement;
    f.list.appendChild(dup); // original still mounted → genuine duplicate
    const k1 = kick.extract(dup)!.key;
    expect(k1).not.toBe(k0);
    expect(kick.extract(dup)!.key).toBe(k1); // memoized per node
    row.remove(); // original scrolled out (unmounted)…
    const again = row.cloneNode(true) as HTMLElement;
    f.list.appendChild(again); // …and re-mounted as a new node
    expect(kick.extract(again)!.key).toBe(k0);
  });
});
