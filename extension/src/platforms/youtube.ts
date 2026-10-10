// YouTube adapter. Runs INSIDE the chat iframe (www.youtube.com/live_chat?v=…,
// also the popout `live_chat?is_popout=1&v=…` and VOD `live_chat_replay`).
// The watch page itself never matches: its chat is the #chatframe iframe, so
// the content script must be injected with all_frames.
//
// DOM (verified live 2026-10-10; Polymer light DOM, no shadow roots):
//   yt-live-chat-item-list-renderer #item-offset > #items       ← chat list
//     > yt-live-chat-text-message-renderer#<message id>[author-type=owner|moderator|member|""]
//         #author-name (text "@handle") , #chat-badges > yt-live-chat-author-badge-renderer[type=verified|moderator|member|owner]
//         #message > text | img.emoji[alt] (unicode emoji → alt is the char; custom emoji → alt ":name:")
//     > yt-live-chat-paid-message-renderer#<id>       (Super Chat, #purchase-amount, optional #message)
//     > yt-live-chat-paid-sticker-renderer#<id>       (Super Sticker, no text)
//     > yt-live-chat-membership-item-renderer#<id>    (new member / milestone; milestone may carry #message)
//     > yt-live-chat-placeholder-item-renderer, yt-live-chat-viewer-engagement-message-renderer,
//       yt-live-chat-sponsorships-gift-*-renderer, yt-live-chat-mode-change-message-renderer …  (system → null)
// The element id IS the YouTube message id → used as key. Rows are appended
// (and trimmed from the top); they are hydrated synchronously before the
// MutationObserver callback runs. Rows are not recycled.

import { Role } from '../core/types';
import type { PlatformAdapter } from './types';
import { cleanName, contentKey, mentionsFromText, newAcc, pushEmote, themeFromBackground, tidy, type TextAcc } from './common';

const TEXT = 'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER';
const PAID = 'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER';
const STICKER = 'YT-LIVE-CHAT-PAID-STICKER-RENDERER';
const MEMBER = 'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER';

const AUTHOR_TYPE: Record<string, number> = {
  owner: Role.BROADCASTER,
  moderator: Role.MOD,
  member: Role.MEMBER,
};
const BADGE_TYPE: Record<string, number> = {
  owner: Role.BROADCASTER,
  moderator: Role.MOD,
  member: Role.MEMBER,
  verified: Role.VERIFIED,
};

/** A custom emoji name has letters or "_"; a unicode emoji alt has neither. */
const HAS_WORD = /[\p{L}_]/u;

/** Walk #message: text nodes, emoji <img>, links. */
function walkMessage(el: Element, acc: TextAcc): void {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    const t = n.nodeType;
    if (t === 3) {
      acc.text += n.nodeValue;
      continue;
    }
    if (t !== 1) continue;
    const e = n as Element;
    if (e.tagName === 'IMG') {
      // Standard emoji are images too: alt="😂" (tooltip ":face_with_tears_of_joy:")
      //   → keep the character as text, not counted as an emote.
      // Custom / channel emoji: alt="face-green-smiling" | "_おうえん" (tooltip ":_おうえん:")
      //   → emote code without colons, counted.
      let alt = e.getAttribute('alt') || '';
      if (alt && !HAS_WORD.test(alt)) {
        acc.text += alt;
        continue;
      }
      if (!alt) alt = e.getAttribute('shared-tooltip-text') || '';
      const L = alt.length;
      if (L > 2 && alt.charCodeAt(0) === 58 && alt.charCodeAt(L - 1) === 58) alt = alt.slice(1, L - 1);
      pushEmote(acc, alt);
      continue;
    }
    walkMessage(e, acc);
  }
}

/**
 * Depth-limited search for a descendant by id. Every chat row repeats the same
 * ids (#author-name, #message, …) and Blink's querySelector('#id') — and even
 * '[id=…]' — goes through the document id map and scans ALL elements with
 * that id (O(rows) per query: ~6 µs at 150 rows, ~50 µs at 2k). Walking the
 * few elements of one row is O(1).
 */
function findById(root: Element, id: string, depth: number): Element | null {
  for (let c = root.firstElementChild; c; c = c.nextElementSibling) {
    if (c.id === id) return c;
    if (depth > 1 && c.firstElementChild && c.tagName !== 'YT-IMG-SHADOW' && c.tagName !== 'svg') {
      const hit = findById(c, id, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

function directText(el: Element | null): string {
  if (!el) return '';
  let s = '';
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) s += n.nodeValue;
  return s || el.textContent || '';
}

function rolesOf(row: Element): number {
  let r = AUTHOR_TYPE[row.getAttribute('author-type') || ''] ?? 0;
  const badges = row.getElementsByTagName('yt-live-chat-author-badge-renderer');
  for (let i = 0; i < badges.length; i++) r |= BADGE_TYPE[badges[i]!.getAttribute('type') || ''] ?? 0;
  return r;
}

let cachedChannel = '';
let cachedHref = '';
let lastTry = 0;

export const youtube: PlatformAdapter = {
  platform: 'youtube',
  observeSubtree: false,

  matches(loc) {
    const h = loc.hostname;
    if (h !== 'www.youtube.com' && h !== 'youtube.com') return false;
    // live_chat and live_chat_replay (VOD chat replay — same DOM)
    return loc.pathname.startsWith('/live_chat');
  },

  findChatList(doc) {
    return (
      doc.querySelector<HTMLElement>('yt-live-chat-item-list-renderer #item-offset > #items') ??
      doc.querySelector<HTMLElement>('#items.yt-live-chat-item-list-renderer')
    );
  },

  rowSelector:
    'yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-paid-sticker-renderer, yt-live-chat-membership-item-renderer',

  extract(row) {
    const tag = row.tagName;
    const isText = tag === TEXT;
    if (!isText && tag !== PAID && tag !== STICKER && tag !== MEMBER) return null;
    if (row.hasAttribute('is-deleted')) return null;

    const chip = row.getElementsByTagName('yt-live-chat-author-chip')[0];
    const author = cleanName(directText(chip ? findById(chip, 'author-name', 1) : null).trim());
    if (!author) return null; // not hydrated / anonymous system item

    const acc = newAcc();
    // text: #content > #message-container > #message; paid/membership: #card > #content > #message
    const msg = findById(row, 'message', 4);
    if (msg) walkMessage(msg, acc);
    const text = tidy(acc.text);

    let paid = false;
    if (!isText) {
      paid = true;
      if (tag === STICKER) {
        // sticker only, no text
        acc.emotes++;
      } else if (tag === MEMBER && !text) {
        return null; // "Welcome to …" / "New member" announcement, no user text
      }
    } else if (!text && !acc.emotes) {
      return null;
    }
    mentionsFromText(acc);

    const id = row.id;
    return {
      key: id ? 'y' + id : contentKey('y', row, author, text),
      platform: 'youtube',
      channel: youtube.channel(row.ownerDocument),
      author,
      roles: rolesOf(row),
      text,
      emotes: acc.emotes,
      mentions: acc.mentions,
      isReply: false,
      isFirstMessage: false,
      paid,
      ts: Date.now(),
    };
  },

  channel(doc) {
    // The chat frame only knows the video id. Embedded chat may be loaded as
    // live_chat?continuation=… (no v=); the watch page is same-origin, so ask
    // the parent frame then.
    const href = doc.location?.href ?? '';
    if (href !== cachedHref || (!cachedChannel && Date.now() - lastTry > 2000)) {
      cachedHref = href;
      lastTry = Date.now();
      let v = '';
      try {
        v = new URL(href).searchParams.get('v') ?? '';
        if (!v) {
          const parent = doc.defaultView?.parent;
          if (parent && parent !== doc.defaultView) v = new URL(parent.location.href).searchParams.get('v') ?? '';
        }
      } catch {}
      cachedChannel = v;
    }
    return cachedChannel;
  },

  barAnchor(doc) {
    // Top of the message area, below the header/ticker: before the item list.
    const list = doc.querySelector<HTMLElement>('yt-live-chat-renderer #item-list');
    if (list) return { el: list, where: 'before' };
    const chat = doc.querySelector<HTMLElement>('yt-live-chat-renderer #chat');
    return chat ? { el: chat, where: 'prepend' } : null;
  },

  theme(doc) {
    const html = doc.documentElement;
    if (html.hasAttribute('dark')) return 'dark';
    // light mode has no attribute; fall back to the computed app background
    const app = doc.querySelector('yt-live-chat-app') ?? doc.body;
    return themeFromBackground(app) ?? 'light';
  },

  viewer(doc) {
    // Signed-in viewers see their own name above the input box.
    const chip = doc.querySelector('yt-live-chat-message-input-renderer yt-live-chat-author-chip');
    const el = chip ? findById(chip, 'author-name', 1) : null;
    const name = el ? cleanName(directText(el).trim()) : '';
    return name ? [name] : [];
  },
};
