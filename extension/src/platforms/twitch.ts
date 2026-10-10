// Twitch adapter (www.twitch.tv channel pages, popout / embed / moderator chat).
//
// DOM (verified live 2026-10-10, native chat, logged out):
//   .chat-scrollable-area__message-container[role=log]       ← chat list
//     > div                                                   ← ROW (one per line)
//       > div > div.chat-line__message[data-a-user=<login>]   ← user message
//            .chat-line__message-container
//              > div (reply header when replying, else empty) > … p > span "@target"
//            img.chat-badge[alt][src=…/badges/v1/<uuid>/1]
//            .chat-author__display-name[data-a-user]  (+ .chat-author__intl-login " (login)")
//            [data-a-target=chat-line-message-body] > .text-fragment | .mention-fragment
//                 | img.chat-line__message--emote[alt] | a.link-fragment/<a> | strong.chat-line__message--cheer-amount
//       > div > div > div[data-test-selector=user-notice-line]   ← sub / raid / streak / points notice
//            (Highlight-my-message & resub notices embed a .chat-line__message --inline → extracted)
//       > div > div > .chat-line__status                         ← "Welcome to the chat room!"
// No message id in the DOM (it lives only in React props) → content key.
// Rows are NOT recycled: React keys by message id, rows are appended at the
// bottom and trimmed from the top (cap ≈150). Content is complete when the
// row is inserted (no async hydration).
//
// FrankerFaceZ re-renders lines with the same .chat-line__message class (we
// fall back to `.message` body and `.ffz-badge[data-badge]`; cheers are
// span.ffz-cheer, and links and cheers carry `ffz-tooltip`); BTTV injects
// emote <img alt> into native lines (handled).
//
// 7TV (verified live with the 7TV extension, 2026-10-10): the native list is
// REMOVED and replaced by a Vue list:
//   #seventv-message-container > main.seventv-chat-list           ← chat list
//     > div.seventv-message[msg-id=<twitch message id>]             ← ROW
//         .seventv-reply-part > .seventv-reply-message-part "Replying to @x: …"
//         span.seventv-user-message > .seventv-chat-user > .seventv-chat-user-badge-list .seventv-chat-badge img[alt][srcset]
//                                                      > .seventv-chat-user-username
//                                   .seventv-chat-message-body > .text-token | .emote-token img.seventv-chat-emote[alt] | .mention-token
// (an outer <seventv-container class="seventv-chat-list"> also exists — not the list).
// 7TV rows are not recycled either (Vue keys by msg-id), content complete at insertion.

import { Role, type ChatMessage } from '../core/types';
import type { PlatformAdapter } from './types';
import {
  addMention,
  cleanName,
  contentKey,
  firstSegment,
  mentionsFromText,
  newAcc,
  pushEmote,
  themeFromBackground,
  tidy,
  type TextAcc,
} from './common';

const LIST = '.chat-scrollable-area__message-container';
const LIST_7TV = 'main.seventv-chat-list';

/** First path segments that are never a channel. */
const RESERVED = new Set([
  '',
  'directory',
  'search',
  'settings',
  'subscriptions',
  'inventory',
  'wallet',
  'drops',
  'downloads',
  'jobs',
  'turbo',
  'prime',
  'store',
  'p',
  'friends',
  'messages',
  'following',
  'videos',
  'broadcast',
  'creatorcamp',
  'bits',
  'activate',
  'login',
  'signup',
  'privacy',
  'legal',
  'payments',
  'u',
]);

/** Global badge set UUIDs (static-cdn.jtvnw.net/badges/v1/<uuid>/…). Locale-independent. */
const BADGE_UUID: Record<string, number> = {
  '5527c58c-fb7d-422d-b71b-f309dcb85cc1': Role.BROADCASTER,
  '3267646d-33f0-4b17-b3df-f923a41db1d0': Role.MOD,
  '0822047b-65e0-46f2-94a9-d1091d685d33': Role.MOD, // lead moderator
  'b817aba4-fad8-49e2-b88a-7cc744dfa6ec': Role.VIP,
  'd12a2e27-16f6-41d0-ab77-b780518f00a3': Role.VERIFIED, // partner
  '511b78a9-ab37-472f-9569-457753bbe7d3': Role.SUB, // founder
  '5d9f2208-5dd8-11e7-8513-2ff4adfae661': Role.SUB, // default subscriber
};
// Fallback on the (localized) badge title. Subscriber badges are per-channel
// images, so they are only recognisable by title.
const RE_BROADCASTER = /^(broadcaster|streamer|emittente|emisor|diffuseur|transmissor|nadawca|yayıncı|стример|транслятор|ストリーマー|방송인|主播)/i;
const RE_MOD = /moderat|модератор|モデレーター|모더레이터|版主|管理員|管理员/i;
const RE_VIP = /^vip$/i;
const RE_VERIFIED = /^(verified|verifiziert|verificad|vérifié|verificat|zweryfikowan|doğrulan|подтвержд|認証済み|인증됨|已验证|已驗證)/i;
const RE_SUB = /subscri|founder|abonn|suscri|assinant|iscritt|abonent|subskryb|abone|подпис|основател|サブスク|구독|订阅|訂閱|tilaaja|prenumer|předplat|gründer|fundador|fondateur/i;

const badgeCache = new Map<string, number>();

function badgeRole(img: Element): number {
  const src = img.getAttribute('src') || img.getAttribute('srcset') || ''; // 7TV only sets srcset
  const alt = img.getAttribute('alt') || '';
  const ck = src || alt;
  const hit = badgeCache.get(ck);
  if (hit !== undefined) return hit;
  let r = 0;
  const i = src.indexOf('/badges/v1/');
  if (i >= 0) r = BADGE_UUID[src.slice(i + 11, i + 47)] ?? 0;
  if (!r && alt) {
    if (RE_BROADCASTER.test(alt)) r = Role.BROADCASTER;
    else if (RE_MOD.test(alt)) r = Role.MOD;
    else if (RE_VIP.test(alt)) r = Role.VIP;
    else if (RE_VERIFIED.test(alt)) r = Role.VERIFIED;
    else if (RE_SUB.test(alt)) r = Role.SUB;
  }
  if (badgeCache.size > 2000) badgeCache.clear();
  badgeCache.set(ck, r);
  return r;
}

const FFZ_BADGE: Record<string, number> = {
  broadcaster: Role.BROADCASTER,
  moderator: Role.MOD,
  lead_moderator: Role.MOD,
  vip: Role.VIP,
  partner: Role.VERIFIED,
  subscriber: Role.SUB,
  founder: Role.SUB,
};

const RE_FIRST_COLOR = /ff75e6|ff38db|255,\s*117,\s*230|255,\s*56,\s*219/i;
const RE_FIRST_LABEL = /^\s*(first time chat|1st time chat)/i;

let cheerSeen = false;

/**
 * Hover cards rendered inside a message (BTTV's emote tooltips, Twitch's
 * tw-tooltip): never message text. FFZ's `ffz-tooltip` class marks tokens that
 * HAVE a tooltip (links, cheers, emotes) and must be read.
 */
const HOVER_CARD = /(?:^|\s)(?:bttv-tooltip|tw-tooltip|ffz__tooltip)(?:\s|$)/;

/** Code of an FFZ cheermote, like a native one ("Cheer1000"). */
function ffzCheer(e: Element): string {
  const alt = e.getAttribute('alt') || e.querySelector('img')?.getAttribute('alt') || '';
  if (alt) return alt.replace(/\s+/g, '');
  return (e.getAttribute('data-prefix') || 'Cheer') + (e.getAttribute('data-amount') || '').replace(/\D+/g, '');
}

/** Walk the message body: text nodes, mention fragments, emote <img alt>, links. */
function walkBody(el: Element, acc: TextAcc): void {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    const t = n.nodeType;
    if (t === 3) {
      acc.text += n.nodeValue;
      continue;
    }
    if (t !== 1) continue;
    const e = n as Element;
    const tag = e.tagName;
    if (tag === 'IMG') {
      // emotes (native / BTTV / FFZ / cheermotes "Cheer 300" → "Cheer300")
      let alt = e.getAttribute('alt') || '';
      if (alt.indexOf(' ') >= 0 && e.classList.contains('chat-image__animated')) alt = alt.replace(/\s+/g, '');
      pushEmote(acc, alt);
      continue;
    }
    if (tag === 'svg' || tag === 'BUTTON' || tag === 'STYLE') continue;
    const cls = e.className;
    if (cls && typeof cls === 'string') {
      if (cls.indexOf('mention-fragment') >= 0 || cls.indexOf('chat-line__message-mention') >= 0) {
        const name = e.textContent || '';
        acc.text += name;
        addMention(acc, name);
        continue;
      }
      if (cls.indexOf('text-fragment') >= 0) {
        acc.text += e.textContent;
        continue;
      }
      if (cls.indexOf('cheer-amount') >= 0) {
        cheerSeen = true; // "300" next to the cheermote → bits → paid
        continue;
      }
      if (cls.indexOf('ffz-cheer') >= 0) {
        // FFZ: <span class="ffz-cheer ffz-tooltip" data-prefix="Cheer" data-amount="1,000" alt="Cheer1000">
        cheerSeen = true;
        pushEmote(acc, ffzCheer(e));
        continue;
      }
      if (cls.indexOf('tooltip') >= 0 && HOVER_CARD.test(cls)) continue;
    }
    walkBody(e, acc);
  }
}

/** A sub / resub notice carries the subscriber's own message in this container. */
const SUB_MESSAGE = '[data-a-target$="subscription-message__custom-message"]';

function extractNative(row: HTMLElement, line: HTMLElement, channel: string): ChatMessage | null {
  const cont = line.querySelector('.chat-line__message-container');
  const scope = cont ?? line;
  const body =
    scope.querySelector<HTMLElement>('[data-a-target="chat-line-message-body"]') ??
    scope.querySelector<HTMLElement>('.message'); // FFZ
  if (!body) return null; // deleted placeholder ("message deleted by a moderator") or unknown
  const nameEl = scope.querySelector('.chat-author__display-name');
  const author = cleanName((nameEl?.textContent ?? line.getAttribute('data-user') ?? '').trim());
  if (!author) return null;
  const authorId = (line.getAttribute('data-a-user') ?? nameEl?.getAttribute('data-a-user') ?? line.getAttribute('data-user')) || undefined;

  let roles = 0;
  const badges = scope.querySelectorAll('img.chat-badge');
  for (let i = 0; i < badges.length; i++) roles |= badgeRole(badges[i]!);
  if (!badges.length) {
    const ffz = line.querySelectorAll('.ffz-badge[data-badge]');
    for (let i = 0; i < ffz.length; i++) roles |= FFZ_BADGE[ffz[i]!.getAttribute('data-badge')!] ?? 0;
  }

  const acc = newAcc();
  cheerSeen = false;
  walkBody(body, acc);
  // bits, or the message of a sub / resub (paid, like a YouTube membership milestone)
  const box = line.parentElement;
  const paid = cheerSeen || (!!box && box.hasAttribute('data-a-target') && box.matches(SUB_MESSAGE));
  mentionsFromText(acc);

  // Reply: the first child of .chat-line__message-container renders
  // [source-only line (shared chat), reply line, shared-chat cheer]; it is
  // empty for normal lines. The reply line is <p title=…>Replying to <span>@target</span>: …</p>.
  let isReply = false;
  const head = cont?.firstElementChild;
  if (head && head.firstElementChild && head.nextElementSibling) {
    const target = head.querySelector('p > span');
    const name = target?.textContent || '';
    if (name.charCodeAt(0) === 64 /* @ */) {
      isReply = true;
      addMention(acc, name);
    }
  } else if (!cont && line.querySelector('.chat-line__reply, [data-test-selector="chat-reply-preview"]')) {
    isReply = true; // FFZ / older layout
  }

  // First-time chatter: Twitch only shows the "First Time Chat" highlight to
  // the BROADCASTER and MODERATORS (accessRoles in Twitch's bundle, 2026-10).
  // It marks the line .chat-line__message--highlighted and paints
  // .chat-line__message-highlight in #FF75E6 (dark) / #FF38DB (light).
  // Unverifiable logged-out → best effort; always false for regular viewers.
  let isFirstMessage = false;
  if (line.classList.contains('chat-line__message--highlighted')) {
    const hl = line.querySelector('.chat-line__message-highlight');
    isFirstMessage = RE_FIRST_COLOR.test(hl?.getAttribute('style') || '') || RE_FIRST_LABEL.test(head?.textContent || '');
  }

  const text = tidy(acc.text);
  if (!text && !acc.emotes) return null;
  return {
    key: contentKey('t', row, authorId || author, text),
    platform: 'twitch',
    channel,
    author,
    authorId,
    roles,
    text,
    emotes: acc.emotes,
    mentions: acc.mentions,
    isReply,
    isFirstMessage,
    paid,
    ts: Date.now(),
  };
}

// --- 7TV ---------------------------------------------------------------------
function walk7tv(el: Element, acc: TextAcc): void {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) {
      acc.text += n.nodeValue;
      continue;
    }
    if (n.nodeType !== 1) continue;
    const e = n as Element;
    if (e.tagName === 'IMG') {
      pushEmote(acc, e.getAttribute('alt') || '');
      continue;
    }
    const cls = typeof e.className === 'string' ? e.className : '';
    if (cls.indexOf('emote-token') >= 0 || cls.indexOf('seventv-emote-box') >= 0) {
      // first <img> is the emote; further ones are zero-width overlays
      let code = e.querySelector('img')?.getAttribute('alt') || '';
      // The span after every emote holds the bits of a cheermote ("1000"), empty otherwise.
      const amount = e.nextElementSibling;
      const bits = amount && amount.tagName === 'SPAN' ? (amount.textContent || '').replace(/\D+/g, '') : '';
      if (bits) {
        cheerSeen = true;
        if (!/\d$/.test(code)) code += bits; // "Cheer" + "1000", like a native cheermote
        n = amount!; // the amount is not message text
      }
      pushEmote(acc, code);
      continue;
    }
    if (cls.indexOf('seventv-chat-message-buttons') >= 0) continue;
    if (cls.indexOf('mention-token') >= 0) {
      const name = e.textContent || '';
      acc.text += name;
      addMention(acc, name);
      continue;
    }
    if (cls.indexOf('tooltip') >= 0) continue;
    walk7tv(e, acc);
  }
}

const REPLY_TARGET = /@([^\s:]+)/;

function extract7tv(row: HTMLElement, channel: string): ChatMessage | null {
  const user = row.querySelector('.seventv-chat-user-username');
  const body = row.querySelector('.seventv-chat-message-body');
  if (!user || !body) return null; // welcome / notices
  let author = (user.textContent || '').trim();
  const paren = author.indexOf(' (');
  if (paren > 0) author = author.slice(0, paren); // "表示名 (login)"
  author = cleanName(author);
  if (!author) return null;
  let roles = 0;
  const badges = row.querySelectorAll('.seventv-chat-badge img');
  for (let i = 0; i < badges.length; i++) roles |= badgeRole(badges[i]!);
  const acc = newAcc();
  cheerSeen = false;
  walk7tv(body, acc);
  mentionsFromText(acc);
  let isReply = false;
  const reply = row.querySelector('.seventv-reply-message-part');
  if (reply) {
    isReply = true;
    const m = REPLY_TARGET.exec(reply.textContent || '');
    if (m) addMention(acc, m[1]!);
  }
  const text = tidy(acc.text);
  if (!text && !acc.emotes) return null;
  const id = row.getAttribute('msg-id');
  return {
    key: id ? 't' + id : contentKey('t', row, author.toLowerCase(), text),
    platform: 'twitch',
    channel,
    author,
    roles,
    text,
    emotes: acc.emotes,
    mentions: acc.mentions,
    isReply,
    isFirstMessage: false,
    paid: cheerSeen,
    ts: Date.now(),
  };
}

/**
 * The line a notice row embeds (resub, watch streak, highlighted message).
 * Several lines mean the "row" is a wrapper Twitch (or an extension) put
 * between the list and the rows: not a message, or one verdict would apply to
 * all of chat.
 */
function soleLine(row: HTMLElement): HTMLElement | null {
  const lines = row.querySelectorAll<HTMLElement>('.chat-line__message');
  return lines.length === 1 ? lines[0]! : null;
}

function channelFromPath(pathname: string): string {
  const p = pathname.split('/');
  const a = (p[1] ?? '').toLowerCase();
  // /popout/<ch>/chat, /embed/<ch>/chat, /moderator/<ch>, /popout/u/<ch>/… (dashboard)
  if (a === 'popout' || a === 'embed' || a === 'moderator') {
    const b = (p[2] ?? '').toLowerCase();
    return b === 'u' ? (p[3] ?? '').toLowerCase() : b;
  }
  return RESERVED.has(a) ? '' : a;
}

let lastPath = '';
let lastChannel = '';

export const twitch: PlatformAdapter = {
  platform: 'twitch',
  observeSubtree: false,

  matches(loc) {
    const h = loc.hostname;
    if (h !== 'www.twitch.tv' && h !== 'twitch.tv' && h !== 'dashboard.twitch.tv') return false;
    if (h === 'dashboard.twitch.tv') return true; // stream manager has a chat pane
    const seg = firstSegment(loc.pathname);
    if (seg === 'popout' || seg === 'embed' || seg === 'moderator') return true;
    // channel pages (/<login>, /<login>/…), but not VODs/clips (no live chat list)
    if (RESERVED.has(seg)) return false;
    const second = (loc.pathname.split('/')[2] ?? '').toLowerCase();
    return second === '' || second === 'chat' || second === 'about' || second === 'schedule';
  },

  findChatList(doc) {
    // 7TV removes the native list and renders its own; prefer it when present.
    return doc.querySelector<HTMLElement>(LIST_7TV) ?? doc.querySelector<HTMLElement>(LIST);
  },

  // Direct children of the list. System rows (welcome, notices) also match;
  // extract() returns null for them.
  rowSelector: `${LIST} > div, ${LIST_7TV} > .seventv-message`,

  extract(row) {
    const ch = twitch.channel(row.ownerDocument);
    if (row.classList.contains('seventv-message')) return extract7tv(row, ch);
    // native: row > div > div.chat-line__message (fast path), else search
    const fast = row.firstElementChild?.firstElementChild as HTMLElement | null | undefined;
    const line = row.classList.contains('chat-line__message')
      ? row
      : fast && fast.classList.contains('chat-line__message')
        ? fast
        : soleLine(row);
    if (line) return extractNative(row, line, ch);
    return null; // welcome / user-notice without user text / deleted / not a row
  },

  channel(doc) {
    const path = doc.location?.pathname ?? '';
    if (path !== lastPath) {
      lastPath = path;
      lastChannel = channelFromPath(path);
    }
    return lastChannel;
  },

  barAnchor(doc) {
    // native and 7TV lists both live inside .chat-list--default / --other
    const list = doc.querySelector<HTMLElement>(LIST) ?? doc.querySelector<HTMLElement>(LIST_7TV);
    const scroller = list?.closest<HTMLElement>('[class*="chat-list--"]');
    if (scroller) return { el: scroller, where: 'before' };
    const content = doc.querySelector<HTMLElement>('.chat-room__content');
    return content ? { el: content, where: 'prepend' } : null;
  },

  theme(doc) {
    const c = doc.documentElement.classList;
    if (c.contains('tw-root--theme-dark')) return 'dark';
    if (c.contains('tw-root--theme-light')) return 'light';
    const room = doc.querySelector('[data-a-target^="chat-theme-"]');
    const t = room?.getAttribute('data-a-target');
    if (t === 'chat-theme-dark') return 'dark';
    if (t === 'chat-theme-light') return 'light';
    return themeFromBackground(doc.body) ?? 'dark';
  },

  viewer(doc) {
    // Signed in, Twitch keeps the login in a readable cookie and the display
    // name, which can differ ("도비" for dobi_kr), in twilight-user; the user
    // menu's avatar is labelled with the display name.
    const names: string[] = [];
    const cookie = doc.cookie || '';
    const login = /(?:^|;\s*)login=([^;]+)/.exec(cookie);
    if (login) names.push(decodeURIComponent(login[1]!));
    const user = /(?:^|;\s*)twilight-user=([^;]+)/.exec(cookie);
    if (user) {
      try {
        const name: unknown = JSON.parse(decodeURIComponent(user[1]!))?.displayName;
        if (typeof name === 'string' && name) names.push(name);
      } catch {
        /* not JSON */
      }
    }
    const alt = doc.querySelector('[data-a-target="user-menu-toggle"] img[alt]')?.getAttribute('alt');
    if (alt) names.push(alt);
    return names;
  },
};
