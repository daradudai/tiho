// Mock live chat for the stress harness. Appends Twitch- or YouTube-shaped rows
// (markup matches src/platforms adapters) at a configurable rate from a real
// chat corpus, with realistic waves (many users, same text) and same-user
// duplicates, trims old rows like the real sites and auto-scrolls (forced
// layout, like the real chats). Also measures frames and long tasks.
//
//   window.__mock.start(rate) / stop() / stats() / resetStats()
//   ?hush=1 → loads harness.js (the Hush runtime bundle) after the corpus.
//   ?theme=light → the site's light theme (Twitch's default when logged out).
(() => {
  'use strict';
  const skin = document.documentElement.dataset.skin;
  const qs = new URLSearchParams(location.search);
  if (qs.get('theme') === 'light') {
    // the markers the adapters read: Twitch's html class, YouTube's [dark] attribute
    document.documentElement.classList.replace('tw-root--theme-dark', 'tw-root--theme-light');
    document.documentElement.removeAttribute('dark');
  }
  const YT = skin === 'youtube';
  const list = YT ? document.querySelector('#items') : document.querySelector('.chat-scrollable-area__message-container');
  const scroller = YT ? document.getElementById('item-scroller') : document.getElementById('scroller');
  const CAP = Number(qs.get('cap') || (YT ? 250 : 150));

  const S = {
    corpus: [],
    i: 0,
    rate: 0,
    t0: 0,
    due: 0,
    sent: 0,
    timer: 0,
    seed: Number(qs.get('seed') || 12345),
    wave: null,
    waves: 0,
    waveSent: 0,
    dupSent: 0,
    recent: [],
    // frames
    rafOn: false,
    last: 0,
    fN: 0,
    fSum: 0,
    f20: 0,
    f33: 0,
    f50: 0,
    dropped: 0,
    fRing: new Float64Array(4096),
    // long tasks
    ltN: 0,
    ltSum: 0,
    ltMax: 0,
    ltList: [],
    seq: 0,
  };
  const rnd = () => ((S.seed = (Math.imul(S.seed, 1664525) + 1013904223) >>> 0) / 4294967296);

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        S.ltN++;
        S.ltSum += e.duration;
        if (e.duration > S.ltMax) S.ltMax = e.duration;
        if (S.ltList.length < 200) S.ltList.push([Math.round(e.startTime), Math.round(e.duration)]);
      }
    }).observe({ type: 'longtask', buffered: false });
  } catch {}

  let loop = 0; // generation: a restart must never leave two rAF loops running
  function frameLoop(gen) {
    const f = (t) => {
      if (!S.rafOn || gen !== loop) return;
      onFrame(t);
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }

  function onFrame(t) {
    if (S.last) {
      const d = t - S.last;
      S.fRing[S.fN % S.fRing.length] = d;
      S.fN++;
      S.fSum += d;
      if (d > 20) S.f20++;
      if (d > 33.4) S.f33++;
      if (d > 50) S.f50++;
      if (d > 25) S.dropped += Math.round(d / 16.667) - 1;
    }
    S.last = t;
  }

  // ───────────────────────── message selection ─────────────────────────

  const SUFFIX = ['', '', ' LUL', ' KEKW', '!!', ' 😂', ' PogChamp'];
  const textOf = (m) => m.s.map((x) => (typeof x === 'string' ? x : x[0])).join('');

  function pickWaveSource() {
    const short = rnd() < 0.7;
    for (let k = 0; k < 400; k++) {
      const m = S.corpus[Math.floor(rnd() * S.corpus.length)];
      const t = textOf(m).trim();
      if (short ? t.length > 0 && t.length <= 20 : t.length >= 60 && t.length <= 300) return { m, short };
    }
    return { m: S.corpus[0], short: true };
  }

  function variant(src) {
    const m = src.m;
    if (src.short) {
      const r = rnd();
      if (r < 0.6) return m.s;
      if (r < 0.8) return [...m.s, ' ', ...m.s];
      return m.s.map((x) => (typeof x === 'string' ? (r < 0.9 ? x.toUpperCase() : x.toLowerCase()) : x));
    }
    return [...m.s, SUFFIX[Math.floor(rnd() * SUFFIX.length)]];
  }

  function next(now) {
    const rate = S.rate || 1;
    // waves: ~one every 15 s, lasting 4–8 s
    if (!S.wave && rnd() < 1 / (15 * rate)) {
      const src = pickWaveSource();
      S.wave = { src, until: now + 4000 + rnd() * 4000, share: src.short ? 0.25 : 0.12 };
      S.waves++;
    }
    if (S.wave && now > S.wave.until) S.wave = null;
    if (S.wave && rnd() < S.wave.share) {
      S.waveSent++;
      return { u: `waver${Math.floor(rnd() * 1e6)}`, r: rnd() < 0.3 ? 8 : 0, s: variant(S.wave.src), b: 0, f: 0 };
    }
    // same-user duplicate
    if (S.recent.length > 20 && rnd() < 0.03) {
      S.dupSent++;
      return S.recent[Math.floor(rnd() * S.recent.length)];
    }
    const m = S.corpus[S.i++ % S.corpus.length];
    if (S.recent.length >= 200) S.recent.shift();
    S.recent.push(m);
    return m;
  }

  // ───────────────────────── rendering ─────────────────────────

  const BADGE = {
    1: ['5527c58c-fb7d-422d-b71b-f309dcb85cc1', 'Broadcaster'],
    2: ['3267646d-33f0-4b17-b3df-f923a41db1d0', 'Moderator'],
    4: ['b817aba4-fad8-49e2-b88a-7cc744dfa6ec', 'VIP'],
    8: ['5d9f2208-5dd8-11e7-8513-2ff4adfae661', 'Subscriber'],
  };
  const COLORS = ['#ff4500', '#1e90ff', '#9acd32', '#daa520', '#ff69b4', '#00ff7f', '#b22222', '#8a2be2'];
  const el = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };

  function twitchRow(m) {
    const row = el('div');
    const wrap = el('div');
    row.appendChild(wrap);
    const line = el('div', 'chat-line__message');
    line.setAttribute('data-a-user', m.u.toLowerCase());
    line.setAttribute('data-a-target', 'chat-line-message');
    wrap.appendChild(line);
    const cont = el('div', 'chat-line__message-container');
    line.appendChild(cont);
    cont.appendChild(el('div'));
    const inner = el('div', 'chat-line__no-background');
    cont.appendChild(inner);
    const uc = el('span', 'chat-line__username-container');
    inner.appendChild(uc);
    for (const bit of [1, 2, 4, 8]) {
      if (!(m.r & bit)) continue;
      const b = el('img', 'chat-badge');
      b.alt = BADGE[bit][1];
      b.src = `https://static-cdn.jtvnw.net/badges/v1/${BADGE[bit][0]}/1`;
      uc.appendChild(b);
    }
    const name = el('span', 'chat-author__display-name');
    name.setAttribute('data-a-user', m.u.toLowerCase());
    name.style.color = COLORS[m.u.length % COLORS.length];
    name.textContent = m.u;
    uc.appendChild(name);
    const colon = el('span');
    colon.setAttribute('aria-hidden', 'true');
    colon.textContent = ': ';
    inner.appendChild(colon);
    const body = el('span');
    body.setAttribute('data-a-target', 'chat-line-message-body');
    for (const s of m.s) {
      if (typeof s === 'string') {
        if (!s) continue;
        const t = el('span', 'text-fragment');
        t.textContent = s;
        body.appendChild(t);
      } else {
        const img = el('img', 'chat-line__message--emote chat-image');
        img.alt = s[0];
        body.appendChild(img);
      }
    }
    if (m.b) {
      const c = el('strong', 'chat-line__message--cheer-amount');
      c.textContent = String(m.b);
      body.appendChild(c);
    }
    inner.appendChild(body);
    return row;
  }

  function youtubeRow(m) {
    const paid = m.b > 0;
    const row = el(paid ? 'yt-live-chat-paid-message-renderer' : 'yt-live-chat-text-message-renderer');
    row.id = `ChwKGkNMbm${(S.seq++).toString(36)}x${Math.floor(rnd() * 1e9).toString(36)}`;
    row.setAttribute('author-type', m.r & 2 ? 'moderator' : m.r & 1 ? 'owner' : m.r & 8 ? 'member' : '');
    const photo = el('div');
    photo.id = 'author-photo';
    row.appendChild(photo);
    const content = el('div');
    content.id = 'content';
    row.appendChild(content);
    const ts = el('span');
    ts.id = 'timestamp';
    ts.textContent = '12:34 PM';
    content.appendChild(ts);
    const chip = el('yt-live-chat-author-chip');
    const name = el('span');
    name.id = 'author-name';
    name.textContent = '@' + m.u;
    chip.appendChild(name);
    const badges = el('span');
    badges.id = 'chat-badges';
    if (m.r & 2) {
      const b = el('yt-live-chat-author-badge-renderer');
      b.setAttribute('type', 'moderator');
      badges.appendChild(b);
    }
    chip.appendChild(badges);
    content.appendChild(chip);
    if (paid) {
      const amt = el('span');
      amt.id = 'purchase-amount';
      amt.textContent = `$${(m.b / 100).toFixed(2)}`;
      content.appendChild(amt);
    }
    const msg = el('span');
    msg.id = 'message';
    for (const s of m.s) {
      if (typeof s === 'string') msg.appendChild(document.createTextNode(s));
      else {
        const img = el('img', 'emoji');
        img.alt = `:${s[0]}:`;
        msg.appendChild(img);
      }
    }
    content.appendChild(msg);
    return row;
  }

  const render = YT ? youtubeRow : twitchRow;

  // ───────────────────────── loop ─────────────────────────

  function tick() {
    const now = performance.now();
    const want = Math.floor(((now - S.t0) * S.rate) / 1000);
    let n = want - S.due;
    if (n <= 0) return;
    if (n > 400) n = 400; // never build an unbounded backlog
    S.due = want;
    for (let k = 0; k < n; k++) {
      const row = render(next(now));
      row.__t = now;
      list.appendChild(row);
      S.sent++;
    }
    let extra = list.childElementCount - CAP;
    while (extra-- > 0) list.firstElementChild.remove();
    scroller.scrollTop = scroller.scrollHeight; // autoscroll (forces layout, like the real chats)
  }

  function start(rate) {
    stop();
    S.rate = rate;
    S.t0 = performance.now();
    S.due = 0;
    S.timer = setInterval(tick, 25);
    S.rafOn = true;
    S.last = 0;
    frameLoop(++loop);
  }

  function stop() {
    if (S.timer) clearInterval(S.timer);
    S.timer = 0;
    S.rafOn = false;
  }

  function resetStats() {
    S.sent = S.waveSent = S.dupSent = S.waves = 0;
    S.fN = S.fSum = S.f20 = S.f33 = S.f50 = S.dropped = 0;
    S.ltN = S.ltSum = S.ltMax = 0;
    S.ltList = [];
  }

  function stats() {
    const n = Math.min(S.fN, S.fRing.length);
    const a = Array.from(S.fRing.subarray(0, n)).sort((x, y) => x - y);
    return {
      sent: S.sent,
      waves: S.waves,
      waveSent: S.waveSent,
      dupSent: S.dupSent,
      rows: list.childElementCount,
      frames: {
        n: S.fN,
        avg: S.fN ? S.fSum / S.fN : 0,
        p95: n ? a[Math.floor(n * 0.95)] : 0,
        p99: n ? a[Math.floor(n * 0.99)] : 0,
        over20: S.f20,
        over33: S.f33,
        over50: S.f50,
        dropped: S.dropped,
      },
      longTasks: { n: S.ltN, total: S.ltSum, max: S.ltMax, list: S.ltList.slice(0, 50) },
    };
  }

  const ready = fetch('corpus.json')
    .then((r) => r.json())
    .then((j) => {
      S.corpus = j.messages;
      if (qs.get('hush') === '1') {
        return new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'harness.js';
          s.onload = res;
          s.onerror = rej;
          document.head.appendChild(s);
        });
      }
    })
    .then(() => true);

  window.__mock = { ready, start, stop, stats, resetStats, list };
})();
