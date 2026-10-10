// Anonymizer for the README media. tests/tools/media-shoot.mjs injects it into
// every frame of every page before the page's own scripts run.
//
// Chat author names and @mentions become stable fake handles (the same real
// name always gets the same one: "pixel_otter", "nightowl88", …) and avatars
// become colored initials. On the chat sites it never changes text that Hush
// reads:
//   * an author (or mention) element gets data-anon="<fake>"; CSS hides its own
//     text and draws the fake one in ::before. An attribute write inside a row
//     is not a childList mutation of the chat list, so the runtime never sees it.
//   * a plain-text "@name" inside a message (YouTube, Kick, reply previews), or
//     a bare word that is the name of a chatter seen on the page (Twitch's watch
//     streak notices), is wrapped in such an element only once the row carries
//     data-hush-a, that is after Hush extracted it. The runtime observes the
//     chat list without subtree (observeSubtree is false on all three
//     platforms) and extracts a row once, so its text, key and verdict stay
//     what they were.
// Extension pages (side panel, popup) and the in-chat bar (a closed shadow
// root, which media-shoot.mjs hands to watch() through CDP) get their text
// rewritten instead: nothing reads it back.
//
// window.__hushAnon = { fake(name), watch(root), check() }. check() counts how
// many rows changed verdict after their first one, with and without a wrapped
// name. (Wrapping keeps the text itself, so even a re-read would see the same.)
(() => {
  if (window.__hushAnon) return;

  const ADJ = ['pixel', 'night', 'lunar', 'mango', 'cosmic', 'velvet', 'turbo', 'quiet', 'frosty', 'neon', 'maple', 'echo', 'sunny', 'rusty', 'misty', 'atomic', 'cobalt', 'amber', 'olive', 'nova', 'cloud', 'cherry', 'pepper', 'silver', 'salty', 'sleepy', 'lucky', 'tiny', 'brave', 'mellow', 'crispy', 'dusty', 'fuzzy', 'golden', 'hazel', 'jolly', 'kiwi', 'lemon', 'mossy', 'noble'];
  const NOUN = ['otter', 'owl', 'fox', 'panda', 'lynx', 'koala', 'heron', 'badger', 'gecko', 'yak', 'moth', 'finch', 'bison', 'orca', 'wombat', 'raven', 'ferret', 'lemur', 'newt', 'puffin', 'crow', 'hare', 'seal', 'toad', 'wolf', 'bear', 'duck', 'goat', 'mole', 'swan', 'crab', 'eel', 'lark', 'mink', 'pug', 'squid', 'tapir', 'vole', 'wren', 'zebu'];
  const cap = (s) => s[0].toUpperCase() + s.slice(1);

  /** lowercase real name → fake, and lowercase fake → fake (a fake is never renamed again) */
  const byReal = new Map();
  const fakes = new Map();

  /** FNV-1a of the lowercase name without "@" → "pixel_otter" | "nightowl88" | "LunarFox" | "mango_koala7". */
  function fake(name) {
    const key = String(name).trim().replace(/^@/, '').toLowerCase();
    if (!key) return key;
    const f0 = fakes.get(key) ?? byReal.get(key);
    if (f0) return f0;
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
    const a = ADJ[h % ADJ.length];
    const b = NOUN[(h >>> 8) % NOUN.length];
    const n = (h >>> 20) % 100;
    const f = [`${a}_${b}`, `${a}${b}${n}`, `${cap(a)}${cap(b)}`, `${a}_${b}${n % 10}`][(h >>> 16) % 4];
    byReal.set(key, f);
    fakes.set(f.toLowerCase(), f);
    return f;
  }

  const isFake = (name) => fakes.has(name.trim().replace(/^@/, '').toLowerCase());
  /** The fake handle in the same form: keeps a leading "@". */
  const fakeAs = (text) => (text.trim().startsWith('@') ? '@' : '') + fake(text);

  // "@name", not inside a word or an e-mail address
  const MENTION = /(^|[^\p{L}\p{N}_@.])@([\p{L}\p{N}_][\p{L}\p{N}_.-]*[\p{L}\p{N}_]|[\p{L}\p{N}_])/gu;

  const replaceMentions = (s) => s.replace(MENTION, (m, pre, name) => (isFake(name) ? m : `${pre}@${fake(name)}`));

  const host = location.hostname;
  const SITE =
    location.protocol === 'chrome-extension:'
      ? 'ext'
      : host.endsWith('twitch.tv')
        ? 'twitch'
        : host.endsWith('youtube.com')
          ? 'youtube'
          : host === 'kick.com' || host.endsWith('.kick.com')
            ? 'kick'
            : '';
  if (!SITE) return;

  /* ─────────────────────── extension pages and the bar ────────────────────── */

  // Author names in the side panel (Inbox, Log) and the bar's latest questions.
  const AUTHOR_TEXT = '.sp-q-meta b bdi, .hp-q-body b bdi';

  function rewrite(root) {
    for (const el of root.querySelectorAll(AUTHOR_TEXT)) {
      const real = el.textContent || '';
      if (!real || isFake(real)) continue;
      const f = fakeAs(real);
      el.textContent = f;
      // the side panel's avatar shows the author's initial
      const av = el.closest('article')?.querySelector('.sp-av');
      if (av) av.textContent = f.replace(/^[^a-z0-9]+/i, '')[0].toUpperCase();
    }
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      if (t.data.indexOf('@') < 0) continue;
      const next = replaceMentions(t.data);
      if (next !== t.data) t.data = next;
    }
  }

  /** Keep a document body or shadow root rewritten while its UI re-renders. */
  function watch(root) {
    if (root.__anonWatched) return;
    root.__anonWatched = true;
    let queued = false;
    const run = () => {
      queued = false;
      rewrite(root);
    };
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(run);
    }).observe(root, { childList: true, subtree: true, characterData: true });
    run();
  }

  if (SITE === 'ext') {
    window.__hushAnon = { fake, watch, check: () => ({ site: SITE }) };
    const start = () => watch(document.body);
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
    return;
  }

  /* ─────────────────────────────── chat sites ────────────────────────────── */

  const SITES = {
    twitch: {
      // display names (native, 7TV), names in sub / watch-streak notices
      author: '.chat-author__display-name, .seventv-chat-user-username, .chatter-name',
      // mention fragments, the reply preview's "@target"
      mention: '.mention-fragment, .chat-line__message-mention, .chat-line__message-container > :first-child p > span',
      avatar: '',
      css: `
        .chat-author__intl-login { display: none !important; }
        /* top gifters / cheerers marquee above the chat */
        div:has(> button[aria-label*="Leaderboard" i]) { display: none !important; }`,
    },
    youtube: {
      author: '#author-name',
      mention: '',
      avatar: '#author-photo',
      css: `
        /* the ticker and the pinned banner carry avatars and names */
        yt-live-chat-ticker-renderer, yt-live-chat-banner-manager { display: none !important; }`,
    },
    kick: {
      // display names, the reply preview's "Replying to <span>name</span>"
      author: '#chatroom-messages button[data-prevent-expand], #chatroom-messages [aria-haspopup] button > span > span:not(.inline)',
      mention: '',
      avatar: '',
      css: `
        /* the pinned message names its sender; the gifters leaderboard above the chat */
        [data-testid="pinned-message-modal"], div:has(> div > button[aria-label*="leaderboard" i]) { display: none !important; }`,
    },
  };

  const CSS = `
    [data-anon] { font-size: 0 !important; }
    [data-anon]::before { content: attr(data-anon); font-size: var(--anon-fs, 13px); }
    [data-anon-i] { position: relative; border-radius: 50%; overflow: hidden; background: hsl(var(--anon-h) 42% 52%) !important; }
    [data-anon-i] img { visibility: hidden !important; }
    [data-anon-i]::after { content: attr(data-anon-i); position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font: 600 12px/1 system-ui, sans-serif; }`;

  /** Text of the element itself, without its children's (YouTube's #author-name also holds the badges). */
  function ownText(el) {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.data;
    return s.trim();
  }

  /** The element that holds the visible name (the first one down the tree with text of its own). */
  function textHolder(el) {
    for (let c = el; c; c = c.firstElementChild) if (ownText(c)) return c;
    return null;
  }

  /** Chatter names seen on this page (lowercase, without "@"), to find them in plain text too. */
  const seenNames = new Set();

  function rename(el, mention) {
    const t = textHolder(el);
    if (!t || t.hasAttribute('data-anon')) return;
    const real = ownText(t);
    if (mention && !real.startsWith('@')) return; // the reply preview's other spans
    if (!mention) seenNames.add(real.replace(/^@/, '').toLowerCase());
    t.style.setProperty('--anon-fs', getComputedStyle(t).fontSize);
    t.setAttribute('data-anon', fakeAs(real));
  }

  function hideAvatar(el) {
    if (el.hasAttribute('data-anon-i')) return;
    const chip = el.parentElement?.querySelector('#author-name');
    const f = fake((chip && ownText(chip)) || '?');
    let h = 0;
    for (let i = 0; i < f.length; i++) h = (h * 31 + f.charCodeAt(i)) >>> 0;
    el.style.setProperty('--anon-h', String(h % 360));
    el.setAttribute('data-anon-i', f[0].toUpperCase());
  }

  // a word, maybe with "@": every "@name" is a name; a bare word only when it is a chatter's name
  // ("Watch Streak reached!: <name> is currently on…", "Really <name>, …")
  const WORD = /(^|[^\p{L}\p{N}_@.])(@?)([\p{L}\p{N}_][\p{L}\p{N}_.-]*[\p{L}\p{N}_]|[\p{L}\p{N}_])/gu;
  const isName = (at, word) => (at ? !isFake(word) : word.length >= 4 && seenNames.has(word.toLowerCase()));

  /** Wrap the names in the text of a row Hush has extracted in [data-anon] spans; returns how many text nodes had one. */
  function wrapNames(row) {
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      if (!t.data.trim() || t.parentElement?.closest('[data-anon]')) continue;
      for (const m of t.data.matchAll(WORD)) {
        if (!isName(m[2], m[3])) continue;
        hits.push(t);
        break;
      }
    }
    for (const t of hits) {
      const fs = getComputedStyle(t.parentElement).fontSize;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const m of t.data.matchAll(WORD)) {
        if (!isName(m[2], m[3])) continue;
        const start = m.index + m[1].length;
        frag.append(t.data.slice(at, start));
        const span = document.createElement('span');
        span.textContent = m[2] + m[3];
        span.style.setProperty('--anon-fs', fs);
        span.setAttribute('data-anon', m[2] + fake(m[3]));
        frag.append(span);
        at = start + m[2].length + m[3].length;
      }
      frag.append(t.data.slice(at));
      t.replaceWith(frag);
    }
    return hits.length;
  }

  const S = SITES[SITE];
  const each = (root, sel, fn) => {
    if (!sel) return;
    if (root.nodeType === 1 && root.matches(sel)) fn(root);
    for (const el of root.querySelectorAll(sel)) fn(el);
  };
  const sweep = (root) => {
    each(root, S.author, (el) => rename(el, false));
    each(root, S.mention, (el) => rename(el, true));
    each(root, S.avatar, hideAvatar);
  };

  /**
   * Every decided row → whether a name in it was wrapped, and its first verdict
   * ("action|category") that was no longer pending. A row may still change
   * verdict later (a late model score, the engine, a wave): check() compares
   * how often that happens with and without a wrapped name.
   */
  const rows = new Map();
  const verdict = (row) => `${row.getAttribute('data-hush-a')}|${row.getAttribute('data-hush-c')}`;

  function onVerdict(row) {
    let st = rows.get(row);
    if (!st) rows.set(row, (st = { wrapped: wrapNames(row) > 0, first: '' }));
    if (!st.first && row.getAttribute('data-hush-a') !== 'pending') st.first = verdict(row);
  }

  function check() {
    const out = { site: SITE, wrapped: { rows: 0, changed: 0 }, other: { rows: 0, changed: 0 }, samples: [] };
    for (const [row, st] of rows) {
      if (!row.isConnected || !st.first || !row.hasAttribute('data-hush-c')) continue;
      const bucket = st.wrapped ? out.wrapped : out.other;
      bucket.rows++;
      if (verdict(row) === st.first) continue;
      bucket.changed++;
      if (st.wrapped && out.samples.length < 5) out.samples.push(`${st.first} → ${verdict(row)}`);
    }
    return out;
  }

  const install = () => {
    const style = document.createElement('style');
    style.id = 'hush-anon-style';
    style.textContent = CSS + S.css;
    document.head.append(style);
    sweep(document);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') onVerdict(r.target);
        else
          for (const n of r.addedNodes) {
            if (n.nodeType === 1) sweep(n);
            else if (n.nodeType === 3 && n.parentElement) sweep(n.parentElement); // text hydrated after the element
          }
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-hush-a'] });
  };

  window.__hushAnon = { fake, watch, check };
  if (document.head) install();
  else document.addEventListener('DOMContentLoaded', install);
})();
