// Dev tool: turn raw live captures (from collect-chat.mjs / probe-chat.mjs)
// into small, sanitized HTML fixtures under tests/fixtures/<platform>/.
//
//   node tests/tools/make-fixtures.mjs <captureDir>
//
// Sanitizing: scripts/styles/links/meta/iframes removed, everything off the
// path html → chat list is pruned (except a few kept siblings), svg path data
// and srcset dropped, YouTube avatars + context-menu params blanked, every
// viewer name replaced by a fake one (consistently across attributes, text,
// mentions and reply headers). Streamer/channel names are kept.
import { Window } from 'happy-dom';
import fs from 'node:fs';
import path from 'node:path';

const CAP = process.argv[2];
const OUT = path.resolve('tests/fixtures');
const DATE = '2026-10-10';

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(CAP, p), 'utf8'));
const readText = (p) => fs.readFileSync(path.join(CAP, p), 'utf8');

function parse(html) {
  const win = new Window({ url: 'https://example.invalid/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true, navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true } } });
  const doc = win.document;
  doc.open();
  doc.write(html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, ''));
  doc.close();
  return { win, doc };
}

function fragment(doc, html) {
  const t = doc.createElement('template');
  t.innerHTML = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  return [...t.content.children];
}

/** Keep only the html → list path (plus kept siblings), put `rows` in the list. */
function buildDoc(srcHtml, listSel, rowsHtml, keep = [], htmlAttrs = null) {
  const { win, doc } = parse(srcHtml);
  const list = doc.querySelector(listSel);
  if (!list) throw new Error('list not found: ' + listSel);
  for (let el = list; el && el !== doc.documentElement; el = el.parentElement) {
    const parent = el.parentElement;
    if (!parent) break;
    for (const sib of [...parent.children]) {
      if (sib === el || sib.tagName === 'HEAD') continue;
      if (keep.some((k) => sib.matches(k))) continue;
      sib.remove();
    }
  }
  doc.head.innerHTML = '<meta charset="utf-8">';
  while (list.firstChild) list.firstChild.remove();
  for (const h of rowsHtml) for (const n of fragment(doc, h)) list.appendChild(n);
  if (htmlAttrs) {
    for (const a of [...doc.documentElement.attributes]) doc.documentElement.removeAttribute(a.name);
    for (const [k, v] of Object.entries(htmlAttrs)) doc.documentElement.setAttribute(k, v);
  }
  // scrub
  for (const e of doc.querySelectorAll('script,style,link,meta:not([charset]),noscript,iframe,template,video,audio,source')) e.remove();
  for (const e of doc.querySelectorAll('[srcset]')) e.removeAttribute('srcset');
  for (const e of doc.querySelectorAll('defs, dom-if, ps-dom-if, yt-icon-button#menu-button, #inline-action-buttons > *, yt-interaction, #ticker-items > *')) e.remove();
  const tw = doc.createTreeWalker(doc.documentElement, 128 /* SHOW_COMMENT */);
  const comments = [];
  while (tw.nextNode()) comments.push(tw.currentNode);
  for (const c of comments) c.remove();
  for (const e of doc.querySelectorAll('path,stop,linearGradient,radialGradient')) {
    if (e.hasAttribute('d')) e.setAttribute('d', 'M0 0');
  }
  for (const e of doc.querySelectorAll('[whole-message-clickable]')) e.setAttribute('whole-message-clickable', '{}');
  for (const e of doc.querySelectorAll('#author-photo img, yt-img-shadow img')) e.setAttribute('src', 'https://yt4.ggpht.com/avatar-placeholder');
  for (const e of doc.querySelectorAll('[aria-controls^="radix-"]')) e.setAttribute('aria-controls', 'radix-x');
  const html = '<!doctype html>\n' + doc.documentElement.outerHTML;
  win.happyDOM.close();
  return html;
}

// ---------------------------------------------------------------------------
// Anonymization

function makeAnon(keepNames) {
  const map = new Map();
  const keep = new Set(keepNames.map((n) => n.toLowerCase()));
  return {
    add(name) {
      const n = (name || '').trim().replace(/^@/, '').replace(/^\(|\)$/g, '').trim();
      if (n.length < 3 || keep.has(n.toLowerCase()) || /^[0-9a-f]+$/i.test(n)) return; // hex-like names would hit ids
      const k = n.toLowerCase();
      if (!map.has(k)) map.set(k, { i: map.size + 1, forms: new Set() });
      map.get(k).forms.add(n);
    },
    apply(html) {
      // longest names first so "abc_def" is replaced before "abc"
      const entries = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
      for (const [k, { i }] of entries) {
        const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'giu');
        html = html.replace(re, (m) => (m === m.toLowerCase() ? `viewer${i}` : `Viewer${i}`));
      }
      return html;
    },
  };
}

function collectNames(html, anon, selectors, attrs) {
  const { win, doc } = parse('<html><body>' + html + '</body></html>');
  for (const s of selectors) for (const e of doc.querySelectorAll(s)) anon.add(e.textContent);
  for (const a of attrs) for (const e of doc.querySelectorAll(`[${a}]`)) anon.add(e.getAttribute(a));
  // "@name" mentions in text
  for (const m of doc.body.textContent.matchAll(/@([\p{L}\p{N}_][\p{L}\p{N}_.\-]{2,})/gu)) anon.add(m[1].replace(/[.\-]+$/, ''));
  win.happyDOM.close();
}

function write(platform, name, header, html) {
  const dir = path.join(OUT, platform);
  fs.mkdirSync(dir, { recursive: true });
  const out = html.replace('<!doctype html>\n', `<!doctype html>\n<!-- ${header.replace(/--/g, '—')} -->\n`);
  fs.writeFileSync(path.join(dir, name), out);
  console.log('wrote', platform + '/' + name, (out.length / 1024).toFixed(0) + ' KB');
}

const lastN = (arr, n) => arr.slice(Math.max(0, arr.length - n));
const pick = (all, re) => all.filter((h) => re.test(h));
// first candidate not used by another label (so every special row is a distinct message)
const USED = new Set();
const F = (arr, pred) => {
  const h = arr.find((x) => !USED.has(x) && pred(x));
  if (h) USED.add(h);
  return h;
};

// ---------------------------------------------------------------------------
// Twitch
{
  const NAMES = ['.chat-author__display-name', '.chatter-name', '.chat-author__intl-login', '.mention-fragment', 'p[title] span'];
  const ATTRS = ['data-a-user'];
  const KEEP = ['.stream-chat-header', '.chat-room__content > .chat-input'];
  const streamers = ['gorgc', 'jinnytty', 'valorant', 'psherotv', 'ziqoftw', 'rocketbeanstv', 'eslcs', 'StreamElements', 'Fossabot', 'Nightbot', 'Moobot'];

  // 1) channel page (www.twitch.tv/jinnytty), light theme as captured
  {
    const doc = readText('tw-jinny/doc.html');
    const listHtml = readText('tw-jinny/list.html');
    const { win, doc: d } = parse('<html><body>' + listHtml + '</body></html>');
    const rows = [...d.querySelector('.chat-scrollable-area__message-container').children].map((e) => e.outerHTML);
    win.happyDOM.close();
    const anon = makeAnon(streamers);
    collectNames(rows.join(''), anon, NAMES, ATTRS);
    const html = buildDoc(doc, '.chat-scrollable-area__message-container', lastN(rows, 32), KEEP);
    write('twitch', 'channel-page.html', `Twitch channel page www.twitch.tv/jinnytty, logged out, light theme. Captured live ${DATE}; sanitized, viewer names faked.`, anon.apply(html));
  }

  // 2) popout chat (www.twitch.tv/popout/gorgc/chat): last rows incl. mentions/emotes; dark theme variant
  {
    const snap = readJson('col-tw/snap-www_twitch_tv_popout_gorgc_chat.json');
    const { win, doc: d } = parse('<html><body>' + snap.list + '</body></html>');
    const rows = [...d.querySelector('.chat-scrollable-area__message-container').children].map((e) => e.outerHTML);
    win.happyDOM.close();
    const anon = makeAnon(streamers);
    const sel = lastN(rows, 36);
    collectNames(sel.join(''), anon, NAMES, ATTRS);
    const html = buildDoc(snap.doc, '.chat-scrollable-area__message-container', sel, KEEP, {
      class: 'tw-root--hover js-focus-visible tw-root--theme-dark',
      lang: 'en-US',
    });
    write('twitch', 'popout-dark.html', `Twitch popout chat www.twitch.tv/popout/gorgc/chat, logged out. Captured live ${DATE}; <html> class switched to tw-root--theme-dark (as Twitch does in dark mode). Sanitized, viewer names faked.`, anon.apply(html));
  }

  // 3) special rows (each one annotated with data-fixture="…")
  {
    let all = Object.values(readJson('col-tw/sigs.json')).flat();
    for (const f of fs.readdirSync(path.join(CAP, 'col-tw')).filter((f) => f.startsWith('snap'))) all = all.concat(readJson('col-tw/' + f).recent);
    const tag = (h, label) => h.replace(/^<div\b/, `<div data-fixture="${label}"`);
    const mod = F(pick(all, /alt="Moderator"/), () => true);
    // synthesized: no broadcaster spoke while capturing; same markup as a mod row with the broadcaster badge
    const broadcaster = mod
      .replace(/alt="Moderator"/g, 'alt="Broadcaster"')
      .replace(/aria-label="Moderator badge"/g, 'aria-label="Broadcaster badge"')
      .replace(/3267646d-33f0-4b17-b3df-f923a41db1d0/g, '5527c58c-fb7d-422d-b71b-f309dcb85cc1');
    const welcome = F(pick(all, /chat-welcome-message/), () => true);
    const items = [
      ['welcome', welcome],
      ['plain', pick(all, /data-a-target="chat-line-message"/).find((h) => !/chat-badge|emote|mention|Replying/.test(h))],
      ['emote-only', pick(all, /chat-line__message--emote/).find((h) => !/text-fragment/.test(h))],
      ['text-and-emote', pick(all, /chat-line__message--emote/).find((h) => /text-fragment/.test(h) && !/cheer/.test(h))],
      ['moderator', mod],
      ['broadcaster(synthesized)', broadcaster],
      ['vip', F(pick(all, /alt="VIP"/), () => true)],
      ['verified', F(pick(all, /alt="Verified"/), () => true)],
      ['subscriber', pick(all, /Subscriber \(/)[0]],
      ['mention', pick(all, /mention-fragment/).find((h) => !/Replying to/.test(h))],
      ['reply', pick(all, /Replying to/)[0]],
      ['cheer', pick(all, /cheer-amount/)[0]],
      ['link', F(pick(all, /<a [^>]*href="http/), () => true)],
      ['me-italic', F(pick(all, /italicized/), () => true)],
      ['intl-name', pick(all, /chat-author__intl-login/)[0]],
      ['deleted', pick(all, /deleted-notice/)[0]],
      ['notice-streak', F(pick(all, /Watch Streak/), (h) => !/chat-line__message/.test(h))],
      ['notice-streak-with-message', F(pick(all, /Watch Streak/), (h) => /chat-line__message/.test(h))],
      ['notice-resub-with-message', F(pick(all, /ubscribed/), (h) => /user-notice-line/.test(h) && /chat-line__message/.test(h) && !/Watch Streak/.test(h))],
      ['highlighted', F(pick(all, /Highlight My Message/), () => true)],
    ].filter(([, h]) => h);
    const rows = items.map(([l, h]) => tag(h, l));
    const anon = makeAnon(streamers);
    collectNames(rows.join(''), anon, NAMES, ATTRS);
    const snap = readJson('col-tw/snap-www_twitch_tv_popout_gorgc_chat.json');
    const html = buildDoc(snap.doc, '.chat-scrollable-area__message-container', rows, KEEP);
    write('twitch', 'special.html', `Twitch special rows (one of each kind, labelled by data-fixture), real markup captured live ${DATE} from several channels; broadcaster row synthesized from a moderator row. Sanitized, viewer names faked.`, anon.apply(html));
    console.log('  twitch special:', items.map(([l]) => l).join(', '));
  }
}

// Twitch + 7TV extension (www.twitch.tv/gorgc with 7TV loaded)
if (fs.existsSync(path.join(CAP, '7tv-cap3/doc.html'))) {
  const doc = readText('7tv-cap3/doc.html');
  const { win, doc: d } = parse(doc);
  let rows = lastN([...d.querySelector('main.seventv-chat-list').children].map((e) => e.outerHTML), 30);
  win.happyDOM.close();
  // + welcome and a reply row from another 7TV capture (www.twitch.tv/popout/jinnytty/chat)
  if (fs.existsSync(path.join(CAP, '7tv-cap/doc.html'))) {
    const { win: w2, doc: d2 } = parse(readText('7tv-cap/doc.html'));
    const all2 = [...d2.querySelector('main.seventv-chat-list').children];
    const welcome = all2.find((e) => e.querySelector('.seventv-welcome-message'));
    const reply = all2.find((e) => e.querySelector('.seventv-reply-part'));
    if (welcome) welcome.setAttribute('data-fixture', 'welcome');
    if (reply) reply.setAttribute('data-fixture', 'reply');
    rows = [welcome, reply].filter(Boolean).map((e) => e.outerHTML).concat(rows);
    w2.happyDOM.close();
  }
  const anon = makeAnon(['gorgc']);
  collectNames(rows.join(''), anon, ['.seventv-chat-user-username'], []);
  const html = buildDoc(doc, 'main.seventv-chat-list', rows, ['.stream-chat-header']);
  write('twitch', 'seventv.html', `Twitch channel page www.twitch.tv/gorgc with the 7TV extension (v${JSON.parse(fs.readFileSync(path.join(CAP, 'ext/7tv/manifest.json'), 'utf8')).version}) — 7TV replaces the native list. Captured live ${DATE}; sanitized, viewer names faked.`, anon.apply(html));
}

// ---------------------------------------------------------------------------
// Kick
{
  const NAMES = ['button[data-prevent-expand]', 'button.font-bold', 'button span.ml-1 > span:first-child'];
  const ATTRS = [];
  const KEEP = ['#chatroom-footer', '.relative.flex.min-h-\\[38px\\]'];
  const streamers = ['absi', 'tck10', 'ogabdullah', 'sacy', 'clavicular', 'deenthegreat', 'zengibre', 'StreamElements', 'BotRix', 'KickBot'];
  const rowsOf = (listHtml) => {
    const { win, doc: d } = parse('<html><body>' + listHtml + '</body></html>');
    const root = d.body.firstElementChild;
    const box = root.firstElementChild?.hasAttribute('data-index') ? root : root.querySelector(':scope > div') ?? root;
    const rows = [...box.children].filter((e) => e.hasAttribute('data-index')).map((e) => e.outerHTML);
    win.happyDOM.close();
    return rows;
  };

  // 1) channel page kick.com/absi (probe capture)
  {
    const doc = readText('kick-absi/doc.html');
    const rows = rowsOf(readText('kick-absi/list.html'));
    const anon = makeAnon(streamers);
    collectNames(rows.join(''), anon, NAMES, ATTRS);
    const html = buildDoc(doc, '#chatroom-messages > div', rows, KEEP);
    write('kick', 'channel-page.html', `Kick channel page kick.com/absi, logged out (Kick is dark-only; no theme marker). Captured live ${DATE}; virtualized list (rows absolutely positioned, data-index). Sanitized, viewer names faked.`, anon.apply(html));
  }
  // 2) popout kick.com/popout/zengibre/chat (emote heavy)
  {
    const snap = readJson('col-kick/snap-kick_com_popout_zengibre_chat.json');
    const rows = rowsOf(snap.list);
    const anon = makeAnon(streamers);
    collectNames(rows.join(''), anon, NAMES, ATTRS);
    const html = buildDoc(snap.doc, '#chatroom-messages > div', rows, KEEP);
    write('kick', 'popout.html', `Kick popout chat kick.com/popout/zengibre/chat, logged out. Captured live ${DATE}. Sanitized, viewer names faked.`, anon.apply(html));
  }
  // 3) special rows
  {
    let all = Object.values(readJson('col-kick/sigs.json')).flat();
    for (const f of fs.readdirSync(path.join(CAP, 'col-kick')).filter((f) => f.startsWith('snap'))) all = all.concat(readJson('col-kick/' + f).recent);
    const tag = (h, label) => h.replace(/^<div\b/, `<div data-fixture="${label}"`);
    const items = [
      ['plain', F(all, (h) => /data-prevent-expand/.test(h) && !/data-emote-name|identity-badge-|Replying to/.test(h) && /font-normal">[^<]{8,}</.test(h))],
      ['emote-only', F(all, (h) => /font-normal"><span[^>]*data-emote-name="[^"]+"[^>]*>(?:(?!<\/span><\/span>).)*<\/span><\/span><\/div>/.test(h))],
      ['text-and-emote', F(all, (h) => /font-normal">[^<]+<span[^>]*data-emote-name/.test(h))],
      ['broadcaster', F(all, (h) => /identity-badge-broadcaster/.test(h))],
      ['moderator', F(all, (h) => /identity-badge-moderator/.test(h) && !/identity-badge-broadcaster/.test(h))],
      ['vip', F(all, (h) => /identity-badge-vip/.test(h))],
      ['subscriber', F(all, (h) => /identity-badge-subscriber/.test(h) && !/identity-badge-(moderator|vip|broadcaster)/.test(h))],
      ['founder', F(all, (h) => /identity-badge-founder/.test(h))],
      ['mention', F(all, (h) => /font-normal">[^<]*@[A-Za-z0-9_]{3,}/.test(h) && /data-prevent-expand/.test(h))],
      ['og', F(all, (h) => /identity-badge-og/.test(h))],
      ['reply', F(all, (h) => /Replying to/.test(h))],
      ['link', F(all, (h) => /<a href="https?:/.test(h) && /data-prevent-expand/.test(h))],
      ['kicks-gift', F(all, (h) => /border-\(--accent\)/.test(h))],
      ['subscription-notice', F(all, (h) => /has subscribed|subscribed for/.test(h))],
      ['new-messages-divider', F(all, (h) => /New messages/.test(h))],
    ].filter(([, h]) => h);
    const rows = items.map(([l, h]) => tag(h, l));
    const anon = makeAnon(streamers);
    collectNames(rows.join(''), anon, NAMES, ATTRS);
    const snap = readJson('col-kick/snap-kick_com_popout_absi_chat.json');
    const html = buildDoc(snap.doc, '#chatroom-messages > div', rows, KEEP);
    write('kick', 'special.html', `Kick special rows (labelled by data-fixture), real markup captured live ${DATE} from several channels. Sanitized, viewer names faked.`, anon.apply(html));
    console.log('  kick special:', items.map(([l]) => l).join(', '));
  }
}

// ---------------------------------------------------------------------------
// YouTube
{
  const NAMES = ['#author-name'];
  const ATTRS = [];
  const KEEP = ['yt-live-chat-header-renderer', '#ticker'];
  const LIST = '#items.yt-live-chat-item-list-renderer';
  const ytDirs = fs.readdirSync(CAP).filter((d) => d.startsWith('col-yt-') && fs.existsSync(path.join(CAP, d, 'sigs.json')));
  let all = [];
  const snaps = [];
  for (const d of ytDirs) {
    all = all.concat(Object.values(readJson(d + '/sigs.json')).flat());
    for (const f of fs.readdirSync(path.join(CAP, d)).filter((f) => f.startsWith('snap'))) {
      const s = readJson(d + '/' + f);
      snaps.push(s);
      all = all.concat(s.recent);
    }
  }
  const rowsOf = (listHtml) => {
    const { win, doc: d } = parse('<html><body>' + listHtml + '</body></html>');
    const rows = [...d.querySelector(LIST).children].map((e) => e.outerHTML);
    win.happyDOM.close();
    return rows;
  };
  const streamers = [];
  // 1) busiest popout snapshot, light
  const best = snaps.sort((a, b) => b.list.length - a.list.length)[0];
  {
    const rows = lastN(rowsOf(best.list), 34);
    const anon = makeAnon(streamers);
    collectNames(rows.join(''), anon, NAMES, ATTRS);
    const html = buildDoc(best.doc, LIST, rows, KEEP);
    write('youtube', 'popout.html', `YouTube popout chat ${best.url.replace(/v=.*/, 'v=…')} ("Live chat" mode), logged out, light theme. Captured live ${DATE}. Sanitized: avatars/context params blanked, viewer handles faked.`, anon.apply(html));
  }
  // 2) special rows, dark theme (YouTube sets <html dark>)
  {
    const tag = (h, label) => h.replace(/^<([a-z-]+)\b/, `<$1 data-fixture="${label}"`);
    const textRows = all.filter((h) => h.startsWith('<yt-live-chat-text-message-renderer'));
    const CUSTOM_EMOJI = /<img class="[^"]*\bemoji\b[^"]*" src="https:\/\/yt3\.ggpht\.com[^"]*" alt="[^"]*[\p{L}_][^"]*"/u;
    const items = [
      ['plain', F(textRows, (h) => /author-type=""/.test(h) && !/<img[^>]*emoji|yt-live-chat-author-badge-renderer/.test(h) && /id="message"[^>]*>[^<]{6,}/.test(h))],
      ['emoji-unicode', F(textRows, (h) => /class="[^"]*emoji[^"]*"[^>]*alt="[^:]/.test(h) && /id="message"[^>]*>[^<]{3,}/.test(h))],
      ['emoji-custom', F(textRows, (h) => CUSTOM_EMOJI.test(h) && /id="message"[^>]*>[^<]{3,}/.test(h)) ?? F(textRows, (h) => CUSTOM_EMOJI.test(h))],
      ['emoji-only', F(textRows, (h) => /id="message"[^>]*><img[^>]*>(?:<img[^>]*>)*<\/span>/.test(h))],
      ['owner', F(textRows, (h) => /author-type="owner"/.test(h))],
      ['moderator', F(textRows, (h) => /author-type="moderator"/.test(h))],
      ['member', F(textRows, (h) => /author-type="member"/.test(h))],
      ['verified', F(textRows, (h) => /type="verified"/.test(h))],
      ['mention', F(textRows, (h) => /id="message"[^>]*>[^<]*@[\w.-]{3,}/.test(h))],
      ['superchat', F(all, (h) => h.startsWith('<yt-live-chat-paid-message-renderer') && /id="message"[^>]*>[^<]{2,}/.test(h)) ?? F(all, (h) => h.startsWith('<yt-live-chat-paid-message-renderer'))],
      ['sticker', F(all, (h) => h.startsWith('<yt-live-chat-paid-sticker-renderer'))],
      ['membership-milestone', F(all, (h) => h.startsWith('<yt-live-chat-membership-item-renderer') && /id="message"[^>]*>[^<]{2,}/.test(h))],
      ['membership-new', F(all, (h) => h.startsWith('<yt-live-chat-membership-item-renderer') && !/id="message"[^>]*>[^<]{2,}/.test(h))],
      ['gift-purchase', F(all, (h) => h.startsWith('<ytd-sponsorships-live-chat-gift-purchase-announcement-renderer') || h.startsWith('<yt-live-chat-sponsorships-gift-purchase-announcement-renderer'))],
      ['gift-redemption', F(all, (h) => h.startsWith('<ytd-sponsorships-live-chat-gift-redemption-announcement-renderer') || h.startsWith('<yt-live-chat-sponsorships-gift-redemption-announcement-renderer'))],
      ['placeholder', F(all, (h) => h.startsWith('<yt-live-chat-placeholder-item-renderer'))],
      ['engagement', F(all, (h) => h.startsWith('<yt-live-chat-viewer-engagement-message-renderer'))],
      ['mode-change', F(all, (h) => h.startsWith('<yt-live-chat-mode-change-message-renderer'))],
    ].filter(([, h]) => h);
    const rows = items.map(([l, h]) => tag(h, l));
    const anon = makeAnon(streamers);
    collectNames(rows.join(''), anon, NAMES, ATTRS);
    const html = buildDoc(best.doc, LIST, rows, KEEP, {
      style: 'font-size: 10px;font-family: Roboto, Arial, sans-serif;',
      dark: '',
      'darker-dark-theme': '',
    });
    write('youtube', 'special-dark.html', `YouTube chat special rows (labelled by data-fixture), real markup captured live ${DATE} from several streams; <html dark> as YouTube sets it in dark mode. Sanitized: avatars/context params blanked, viewer handles faked.`, anon.apply(html));
    console.log('  youtube special:', items.map(([l]) => l).join(', '));
  }
}
