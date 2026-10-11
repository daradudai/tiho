// Kick adapter (kick.com/<slug> and kick.com/popout/<slug>/chat).
//
// DOM (verified live 2026-10-10; Next.js + React + Tailwind):
//   #chatroom-messages[data-testid=chatroom-messages]            ← scroller
//     > div.relative (height: Npx)                               ← chat list (VIRTUALIZED)
//       > div[data-index=N].absolute (transform: translateY(…))  ← ROW
//           normal:  div.group > div.break-words > [span time, div(identity: div(badges) + button[data-prevent-expand] name),
//                    span[aria-hidden] ":", span(body: text | span[data-emote-name]>img | a)]
//           reply:   div.group > div[aria-haspopup=dialog] > div.flex-col > [button "Replying to <span>user</span>: …", div.break-words (as above)]
//           kicks:   div.border-(--accent) … button[data-prevent-expand] name " sent " amount, span.whitespace-pre-line (user text), img[src*=/kicks/]
//           system:  "New messages" divider, "X has subscribed!" (no data-prevent-expand button) → null
//   badges: div[data-testid=identity-badge-<broadcaster|moderator|vip|verified|subscriber|founder|og|sub_gifter|bot>]
//           + level badge svg[data-ds-icon=LevelNN] + cosmetic <img> badges (ignored)
//
// QUIRKS (important for the runtime):
//  * The list is virtualized: only ~30 rows are mounted; rows scrolled out of
//    view (or pushed out when the 300-message buffer is full) are UNMOUNTED and
//    re-MOUNTED as NEW nodes when scrolled back. `data-index` is NOT stable (the
//    buffer is capped at 300 and indices are reassigned), so the key is a
//    content hash (author + minute timestamp + text): a re-mounted row gets
//    the SAME key as before, while a genuine duplicate that is mounted at the
//    same time as the original gets an ordinal suffix (see remountKey).
//  * Rows are NOT recycled in place (no text mutations observed on mounted
//    rows across ~5k messages); content is complete at insertion.
//  * The virtualizer measures each row (offsetHeight) as it mounts, before any
//    content script has seen it, and again on every resize (ResizeObserver),
//    places rows by those sizes (translateY) and mounts as many as it takes to
//    fill the viewport (verified live 2026-10-11). A row that shrinks after it
//    mounted pulls more rows in, so here a row waiting for its verdict takes
//    no space (src/ui/decorations.ts, PlatformDeco.virtual).
//  * No message id / user id in the DOM.

import { Role } from '../core/types';
import type { PlatformAdapter } from './types';
import {
  addMention,
  cleanName,
  mentionsFromText,
  newAcc,
  pushEmote,
  remountKey,
  themeFromBackground,
  tidy,
  type TextAcc,
} from './common';

const RESERVED = new Set([
  '',
  'browse',
  'categories',
  'category',
  'search',
  'following',
  'dashboard',
  'settings',
  'subscriptions',
  'auth',
  'login',
  'signup',
  'clips',
  'video',
  'videos',
  'terms-of-service',
  'privacy-policy',
  'community-guidelines',
  'dmca-policy',
  'faq',
  'about',
  'kick-partner-program',
  'stream-key',
  'messages',
  'notifications',
  'wallet',
]);

const BADGE: Record<string, number> = {
  broadcaster: Role.BROADCASTER,
  moderator: Role.MOD,
  vip: Role.VIP,
  verified: Role.VERIFIED,
  subscriber: Role.SUB,
  founder: Role.SUB,
};

function walkBody(el: Element, acc: TextAcc): void {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    const t = n.nodeType;
    if (t === 3) {
      acc.text += n.nodeValue;
      continue;
    }
    if (t !== 1) continue;
    const e = n as Element;
    const emote = e.getAttribute('data-emote-name');
    if (emote !== null) {
      pushEmote(acc, emote);
      continue;
    }
    if (e.tagName === 'IMG') {
      pushEmote(acc, e.getAttribute('alt') || '');
      continue;
    }
    if (e.tagName === 'svg' || e.tagName === 'BUTTON') continue;
    walkBody(e, acc);
  }
}

function rolesOf(badgeBox: Element | null): number {
  let r = 0;
  if (!badgeBox) return r;
  for (let b = badgeBox.firstElementChild; b; b = b.nextElementSibling) {
    const id = b.getAttribute('data-testid');
    if (id && id.startsWith('identity-badge-')) r |= BADGE[id.slice(15)] ?? 0;
  }
  return r;
}

function channelFromPath(pathname: string): string {
  const p = pathname.split('/');
  const a = (p[1] ?? '').toLowerCase();
  if (a === 'popout') return (p[2] ?? '').toLowerCase();
  return RESERVED.has(a) ? '' : a;
}

let lastPath = '';
let lastChannel = '';

export const kick: PlatformAdapter = {
  platform: 'kick',
  observeSubtree: false,

  matches(loc) {
    const h = loc.hostname;
    if (h !== 'kick.com' && h !== 'www.kick.com') return false;
    const p = loc.pathname.split('/');
    const a = (p[1] ?? '').toLowerCase();
    if (a === 'popout') return (p[3] ?? '').toLowerCase() === 'chat' || p.length <= 3;
    if (RESERVED.has(a)) return false;
    const b = (p[2] ?? '').toLowerCase();
    return b === '' || b === 'chatroom';
  },

  findChatList(doc) {
    const scroller = doc.getElementById('chatroom-messages');
    if (!scroller) return null;
    // the virtual list is the (only) child; pick the one holding rows if more appear
    const first = scroller.firstElementChild as HTMLElement | null;
    for (let e = first; e; e = e.nextElementSibling as HTMLElement | null) {
      if (e.firstElementChild?.hasAttribute('data-index')) return e;
    }
    return first;
  },

  rowSelector: '#chatroom-messages > div > div[data-index]',

  extract(row) {
    const name = row.querySelector('button[data-prevent-expand]');
    if (!name) return null; // divider / subscription notice / unknown system row
    const author = cleanName((name.textContent || '').trim());
    if (!author) return null;
    const identity = name.parentElement;
    if (!identity) return null;
    const badgeBox = name.previousElementSibling;

    let body: Element | null = null;
    let paid = false;
    let ts = '';
    let isReply = false;
    const acc = newAcc();

    const sep = identity.nextElementSibling;
    if (sep && sep.getAttribute('aria-hidden') === 'true') {
      body = sep.nextElementSibling;
      const content = identity.parentElement;
      const first = content?.firstElementChild;
      if (first && first !== identity && first.tagName === 'SPAN') ts = first.textContent || '';
      // reply header is the previous sibling (a <button>) of the content block
      const prev = content?.previousElementSibling;
      if (prev && prev.tagName === 'BUTTON') {
        isReply = true;
        const target = prev.querySelector('span > span');
        if (target) addMention(acc, target.textContent || '');
      }
    } else {
      // Kicks gift ("<name> sent 500 [sticker]" + optional user message).
      // Require the gift sticker so an unknown layout fails closed (null)
      // instead of being mislabelled as paid (= never hidden).
      if (!row.querySelector('img[src*="/kicks/"]')) return null;
      body = row.querySelector('.whitespace-pre-line');
      paid = true;
      if (!body) return null;
    }
    if (!body) return null;

    walkBody(body, acc);
    mentionsFromText(acc);
    const text = tidy(acc.text);
    if (!text && !acc.emotes) return null;

    return {
      key: remountKey('k', row, author, text, ts),
      platform: 'kick',
      channel: kick.channel(row.ownerDocument),
      author,
      roles: rolesOf(badgeBox),
      text,
      emotes: acc.emotes,
      mentions: acc.mentions,
      isReply,
      isFirstMessage: false,
      paid,
      ts: Date.now(),
    };
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
    const scroller = doc.getElementById('chatroom-messages');
    // scroller's parent is the message area (pinned message overlay + list);
    // the bar goes right above it, below the chat header / leaderboard.
    const area = scroller?.parentElement;
    if (area) return { el: area, where: 'before' };
    const room = doc.getElementById('channel-chatroom');
    return room ? { el: room, where: 'prepend' } : null;
  },

  theme(doc) {
    const html = doc.documentElement;
    if (html.classList.contains('light') || html.getAttribute('data-theme') === 'light') return 'light';
    if (html.classList.contains('dark') || html.getAttribute('data-theme') === 'dark') return 'dark';
    // Kick has no theme marker today (dark only); verify via the background.
    return themeFromBackground(doc.body) ?? 'dark';
  },
};
