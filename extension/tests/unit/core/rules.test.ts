import { describe, expect, it } from 'vitest';
import { normalize } from '../../../src/core/normalize';
import { compileRules, needsModel, RuleEngine, Sig } from '../../../src/core/rules';
import { DEFAULT_SETTINGS, type UserRule } from '../../../src/core/settings';
import { Role, type ChatMessage } from '../../../src/core/types';

let seq = 0;
function msg(text: string, o: Partial<ChatMessage> = {}): ChatMessage {
  return {
    key: `k${seq++}`,
    platform: 'twitch',
    channel: 'test',
    author: o.author ?? `user${seq}`,
    roles: 0,
    text,
    emotes: 0,
    mentions: [],
    isReply: false,
    isFirstMessage: false,
    paid: false,
    ts: 0,
    ...o,
  };
}

function engine(rules: UserRule[] = [], viewer?: string) {
  const e = new RuleEngine();
  e.setSettings({ ...DEFAULT_SETTINGS, rules });
  if (viewer) e.setViewer(viewer);
  return e;
}

const ev = (e: RuleEngine, m: ChatMessage, now = 0) => e.evaluate(m, normalize(m.text), now);
const rule = (kind: UserRule['kind'], pattern: string, mode: UserRule['mode']): UserRule => ({
  id: `${kind}:${pattern}:${mode}`,
  kind,
  pattern,
  mode,
  enabled: true,
});

describe('rules: decided categories', () => {
  const e = engine();

  it('!command → noise', () => {
    const r = ev(e, msg('!drop'));
    expect(r.cat).toBe('noise');
    expect(r.sig & Sig.COMMAND).toBeTruthy();
    expect(needsModel(r)).toBe(false);
    expect(ev(e, msg('!!!')).sig & Sig.COMMAND).toBeFalsy();
  });

  it('char flood / emote flood / repeated tokens → spam', () => {
    expect(ev(e, msg('a'.repeat(30))).cat).toBe('spam');
    expect(ev(e, msg('PogChamp '.repeat(12), { emotes: 12 })).cat).toBe('spam');
    expect(ev(e, msg('LUL LUL LUL LUL LUL LUL LUL LUL LUL')).cat).toBe('spam');
    const few = ev(e, msg('LUL LUL LUL that was great LUL LUL LUL'));
    expect(few.cat).toBeUndefined();
  });

  it('ascii art → spam', () => {
    expect(ev(e, msg('⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠿⠛⠛⠛⠋⠉⠈⠉⠉⠉⠉⠛⠻⢿⣿⣿⣿')).cat).toBe('spam');
  });

  it('emote-only and emoji-only → noise', () => {
    expect(ev(e, msg('KEKW', { emotes: 1 })).cat).toBe('noise');
    expect(ev(e, msg('KEKW LUL', { emotes: 2 })).cat).toBe('noise');
    expect(ev(e, msg('😂😂😂')).cat).toBe('noise');
    expect(ev(e, msg('KEKW that is so funny', { emotes: 1 })).cat).toBeUndefined();
  });

  it('trivially short reactions → noise', () => {
    for (const t of ['W', 'L', '?', 'lol', 'LMAO', 'hahahaha', 'kkkkkk', 'ахахах', 'LETS GO', 'ok ok', '1', '+1', 'gg', '草'])
      expect(ev(e, msg(t)).cat, t).toBe('noise');
  });

  it('keeps short real questions / words for the model', () => {
    for (const t of ['why?', 'is it?', 'what game is this', 'なぜ', 'hi chat how are you', 'Кога е следващият стрийм?']) {
      const r = ev(e, msg(t));
      expect(r.cat, t).toBeUndefined();
      expect(needsModel(r)).toBe(true);
    }
    expect(ev(e, msg('Кога е следващият стрийм?')).sig & Sig.QUESTION_MARK).toBeTruthy();
  });

  it('duplicate by same user within 30 s → spam', () => {
    const d = engine();
    const a = msg('this streamer is great', { author: 'bob' });
    expect(ev(d, a, 1000).cat).toBeUndefined();
    const r = ev(d, msg('THIS streamer is great \u{E0000}', { author: 'bob' }), 5000);
    expect(r.cat).toBe('spam');
    expect(r.sig & Sig.DUPLICATE).toBeTruthy();
    // other user: not a duplicate
    expect(ev(d, msg('this streamer is great', { author: 'carol' }), 6000).cat).toBeUndefined();
    // after the window
    expect(ev(d, msg('this streamer is great', { author: 'bob' }), 60_000).cat).toBeUndefined();
  });

  it('knownDup re-evaluation does not feed the tracker', () => {
    const d = engine();
    const m = msg('hello there friends', { author: 'x' });
    expect(d.evaluate(m, normalize(m.text), 0, false).cat).toBeUndefined();
    expect(d.evaluate(m, normalize(m.text), 1, false).cat).toBeUndefined();
    expect(d.evaluate(m, normalize(m.text), 2, true).cat).toBe('spam');
  });

  it('the same message seen again (same key) is no repeat; a later copy still is', () => {
    const d = engine();
    const m = msg('hello there friends', { author: 'x' });
    expect(ev(d, m, 0).cat).toBeUndefined();
    expect(ev(d, m, 5000).cat).toBeUndefined(); // its row re-mounted
    expect(ev(d, msg('hello there friends', { author: 'x' }), 6000).cat).toBe('spam');
  });
});

describe('rules: links and scams', () => {
  const e = engine();

  it('untrusted link → LINK signal (model decides)', () => {
    const r = ev(e, msg('look at this https://sketchy-site.xyz/abc'));
    expect(r.sig & Sig.LINK).toBeTruthy();
    expect(r.cat).toBeUndefined();
    expect(ev(e, msg('go to coolstuff.com now')).sig & Sig.LINK).toBeTruthy();
  });

  it('allow-listed links and privileged authors → LINK_OK', () => {
    expect(ev(e, msg('https://clips.twitch.tv/SomeClip')).sig & Sig.LINK_OK).toBeTruthy();
    expect(ev(e, msg('en.wikipedia.org/wiki/Chess is a good read')).sig & Sig.LINK_OK).toBeTruthy();
    const mod = ev(e, msg('new video https://youtu.be/abc', { roles: Role.MOD }));
    expect(mod.sig & Sig.LINK_OK).toBeTruthy();
    expect(mod.sig & Sig.LINK).toBeFalsy();
  });

  it('does not see links in normal sentences', () => {
    expect(ev(e, msg('that was crazy.it was so good')).sig & (Sig.LINK | Sig.LINK_OK)).toBeFalsy();
    expect(ev(e, msg('version 1.5.2 is out')).sig & (Sig.LINK | Sig.LINK_OK)).toBeFalsy();
  });

  it('obvious scam patterns → scam', () => {
    expect(ev(e, msg('Best viewers on streamboo .com')).cat).toBe('scam');
    expect(ev(e, msg('Wanna become famous? Buy followers, primes and viewers')).cat).toBe('scam');
    expect(ev(e, msg('fr33 r0bux at robux-gift.xyz')).cat).toBe('scam');
    expect(ev(e, msg('ꜰʀᴇᴇ ɴɪᴛʀᴏ for everyone')).cat).toBe('scam');
    expect(ev(e, msg('follow4follow?')).cat).toBe('scam');
  });

  it('link + first-time chatter or scam words → scam', () => {
    expect(ev(e, msg('hey check this site.xyz/abc', { isFirstMessage: true })).cat).toBe('scam');
    expect(ev(e, msg('crypto airdrop at airdrop-now.io')).cat).toBe('scam');
  });
});

describe('rules: signals and protection', () => {
  it('caps signal', () => {
    const r = ev(engine(), msg('WHY IS THIS GAME SO HARD TODAY'));
    expect(r.sig & Sig.CAPS).toBeTruthy();
    expect(r.cat).toBeUndefined();
  });

  it('privileged / paid / viewer mention → protect', () => {
    const e = engine([], 'MeViewer');
    expect(ev(e, msg('you are all idiots', { roles: Role.MOD })).protect).toBe(true);
    expect(ev(e, msg('you are all idiots', { roles: Role.BROADCASTER })).protect).toBe(true);
    expect(ev(e, msg('you are all idiots', { roles: Role.SUB })).protect).toBe(false);
    expect(ev(e, msg('take my money', { paid: true })).protect).toBe(true);
    const m1 = ev(e, msg('hey whats up', { mentions: ['meviewer'] }));
    expect(m1.protect).toBe(true);
    expect(m1.sig & Sig.MENTIONS_VIEWER).toBeTruthy();
    expect(ev(e, msg('@MeViewer you there?')).protect).toBe(true);
    expect(ev(e, msg('@MeViewerX you there?')).protect).toBe(false);
  });

  it("the viewer's own messages are protected and never a repeat", () => {
    const e = engine();
    e.setViewer(['dobi_kr', '도비']);
    const own = (text: string, t = 0) => ev(e, msg(text, { author: '도비', authorId: 'dobi_kr' }), t);
    expect(own('when is the next stream?').protect).toBe(true);
    expect(own('when is the next stream?', 1000).sig & Sig.OWN).toBeTruthy();
    expect(own('when is the next stream?', 2000).cat).toBeUndefined(); // asked again: not spam
    expect(own('!uptime').protect).toBe(true);
    expect(ev(e, msg('nice', { author: 'Dobi_KR' })).protect).toBe(true); // login, any case
    expect(ev(e, msg('nice', { author: 'someone' })).protect).toBe(false);
  });

  it('mentions by any of the viewer names are protected', () => {
    const e = engine();
    e.setViewer(['dobi_kr', '@도비']);
    expect(ev(e, msg('@도비 you are trash', { mentions: ['도비'] })).sig & Sig.MENTIONS_VIEWER).toBeTruthy();
    expect(ev(e, msg('@도비 you are trash')).protect).toBe(true); // found in the text
    expect(ev(e, msg('@DOBI_KR hi')).protect).toBe(true);
    expect(ev(e, msg('@도비야 hi')).protect).toBe(false);
    e.setViewer(null);
    expect(ev(e, msg('@도비 hi', { mentions: ['도비'] })).protect).toBe(false);
  });

  it('trustPrivileged=false removes privileged protection', () => {
    const e = new RuleEngine();
    e.setSettings({ ...DEFAULT_SETTINGS, trustPrivileged: false });
    expect(ev(e, msg('whatever text here', { roles: Role.MOD })).protect).toBe(false);
  });
});

describe('rules: user rules', () => {
  it('block word (normalized, whole word, prefix with *)', () => {
    const e = engine([rule('word', 'spoiler', 'block'), rule('word', 'elden*', 'block')]);
    const r = ev(e, msg('SP0ILER: he dies'));
    expect(r.user).toBe('block');
    expect(needsModel(r)).toBe(false);
    expect(ev(e, msg('nospoilers please')).user).toBeUndefined();
    expect(ev(e, msg('eldenring boss is hard')).user).toBe('block');
  });

  it('CJK words match as substrings', () => {
    const e = engine([rule('word', 'ネタバレ', 'block')]);
    expect(ev(e, msg('これはネタバレです')).user).toBe('block');
  });

  it('users and regex; allow beats block beats highlight', () => {
    const e = engine([
      rule('user', '@Troll', 'block'),
      rule('user', 'friend', 'allow'),
      rule('regex', '^hello\\b', 'highlight'),
      rule('word', 'hello', 'block'),
      rule('word', 'pizza', 'allow'),
    ]);
    expect(ev(e, msg('nice game', { author: 'troll' })).user).toBe('block');
    const f = ev(e, msg('KYS', { author: 'Friend' }));
    expect(f.user).toBe('allow');
    expect(f.protect).toBe(true);
    expect(ev(e, msg('hello world')).user).toBe('block');
    expect(ev(e, msg('hello pizza')).user).toBe('allow');
  });

  it('invalid regex is reported, not thrown', () => {
    const c = compileRules([rule('regex', '([', 'block')]);
    expect(c.errors.length).toBe(1);
    expect(c.regex.length).toBe(0);
  });

  it('disabled rules are ignored', () => {
    const e = engine([{ ...rule('word', 'pizza', 'block'), enabled: false }]);
    expect(ev(e, msg('pizza time')).user).toBeUndefined();
  });
});

describe('rules: performance', () => {
  it('evaluates in < 50 µs per message', () => {
    const e = engine([rule('word', 'spoiler', 'block'), rule('regex', 'elden\\s?ring', 'block')], 'viewer');
    const texts = [
      'LUL that was insane',
      'fr33 r0bux at robux.xyz',
      'KEKW KEKW KEKW',
      'Здравей, как си?',
      'what game is this?',
      'W',
      '!drop',
      'https://clips.twitch.tv/abc look at this',
      'THIS IS SO MUCH FUN LETS GOOOOOOO',
    ];
    const msgs = texts.map((t, i) => msg(t, { author: `u${i}` }));
    const norms = msgs.map((m) => normalize(m.text));
    const n = 30_000;
    for (let i = 0; i < 3000; i++) e.evaluate(msgs[i % msgs.length]!, norms[i % msgs.length]!, i * 100_000);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) e.evaluate(msgs[i % msgs.length]!, norms[i % msgs.length]!, i * 100_000);
    expect((performance.now() - t0) / n).toBeLessThan(0.05);
  });
});
