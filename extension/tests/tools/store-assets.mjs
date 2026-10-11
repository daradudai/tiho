// Chrome Web Store images (docs/store/img/), from the real extension on live chats.
//
//   node tests/tools/store-assets.mjs promo
//       docs/store/src/promo.html → promo-small.png (440×280) and promo-marquee.png (1400×560)
//   node tests/tools/store-assets.mjs shots <twitch channel url> <kick or youtube url> [<third url>] [options]
//       live captures (raw/, 2× device pixels) → five 1280×800 screenshots with a caption band
//   node tests/tools/store-assets.mjs compose [--out DIR]
//       the five screenshots again from the captures already in DIR/raw (to change a caption)
// options:
//   --ext DIR    built extension (.output-final/chrome-mv3)
//   --out DIR    where the PNGs go (../docs/store/img); captures go to DIR/raw
//   --secs N     let each chat run N s before its first capture (60)
//   --wait N     how long a capture waits for offensive rows to scroll away (45)
//
// The first Twitch capture waits up to 120 s for a "N hidden · show" pill plus a wave or a
// highlighted question on screen, the Show hidden pair up to 90 s for a pill: pick a busy chat.
//
// Captions and layouts are in SHOTS below; docs/store/src/frame.html draws them. Chats are
// opened as popout chats (only the chat column), dark theme, Basic mode with the default level
// (Clean) unless a shot says otherwise. tests/tools/anonymize.js turns chatter names into fake
// handles, as for the README media; the channel name in the popup and side panel becomes
// "streamer". A capture waits (up to --wait s, 45) until no visible row is toxic or matches
// OFFENSIVE, and blurs such rows if it runs out of time (the log says so).
//
// The prefix the build uses for its attributes, messages and storage keys (data-<p>-a,
// <p>:command, <p>.settings.v1) is read from the build itself, so this works before and after
// a rename. All PNGs are written as 24-bit RGB (the store refuses alpha).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, '../..');
const repo = path.resolve(extRoot, '..');
const storeSrc = path.join(repo, 'docs/store/src');

const pos = [];
const opts = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) opts[a.slice(2)] = process.argv[++i];
  else pos.push(a);
}
const [cmd, ...urls] = pos;
const out = path.resolve(opts.out ?? path.join(repo, 'docs/store/img'));
const rawDir = path.join(out, 'raw');
const secs = Number(opts.secs ?? 60);
const waitClean = Number(opts.wait ?? 45);
fs.mkdirSync(out, { recursive: true });

/**
 * Windows in CSS px. A chat capture stops above the chat's input box, the popup capture at the
 * end of its content; the frame draws captures at their CSS size times the item's scale, shrunk
 * to fit (frame.html: 650 px tall stage).
 */
const CHAT = { w: 380, h: 760 };
const PANEL = { w: 400, h: 640 };
const POPUP = { w: 360, h: 900 };
/** Scrollbars of extension pages in their own windows (a real popup or side panel has none until it scrolls). */
const NO_SCROLLBARS = '::-webkit-scrollbar { display: none !important; } html, body { scrollbar-width: none !important; overflow-x: hidden !important; }';

/**
 * The five screenshots. items: [capture name, label?, scale?]. Captures: <site>-basic,
 * <site>-peek (Show hidden), twitch-solo (Advanced, spam alone), panel-solo (side panel,
 * Categories), popup-adv, panel-live (side panel, Live tab), twitch-adv.
 */
const SHOTS = [
  {
    file: 'screenshot-1.png',
    caption: 'Hides spam, scam links and abuse in live chat',
    sub: 'Pick Off, Clean or Quiet above the chat. Tiho does the rest.',
    items: [['twitch-basic', null, 1.05]],
    notesFirst: true,
    // the keys stand for what is in the capture; match the pill's count after a new capture
    notes: [
      { k: '1 hidden · show', v: 'Hidden messages fold into one line. Click to see them.' },
      { k: 'Same message ×N', v: 'When many people post the same thing, you see it once with a count.' },
      { k: 'Questions', v: 'Real questions get a soft highlight, so they don’t get lost.' },
    ],
  },
  {
    file: 'screenshot-2.png',
    caption: 'Anything it hides is one click away',
    sub: '“Show hidden” brings it back, faded and tagged with why. It still makes mistakes.',
    items: [['twitch-basic2', 'Clean'], ['twitch-peek', 'Show hidden']],
  },
  {
    file: 'screenshot-3.png',
    caption: 'One click: see only one category',
    sub: 'Advanced mode, for streamers and mods: check what went where.',
    items: [['twitch-solo', 'Only spam'], ['panel-solo', 'Side panel']],
  },
  {
    file: 'screenshot-4.png',
    caption: 'Runs on your computer. Nothing leaves it.',
    sub: 'Free. No account, no server, no tracking.',
    items: [['twitch-adv', 'Chat'], ['popup-adv', 'Popup'], ['panel-live', 'Side panel']],
  },
  {
    file: 'screenshot-5.png',
    caption: 'YouTube, Twitch and Kick',
    sub: 'Checked properly on English and about a dozen other languages.',
    items: [], // filled in with the other sites' captures
  },
];

/** Strong profanity and slurs that must not be readable in a store image. */
const OFFENSIVE =
  /n[i1!|]gg|f[a@4]gg?[o0]t|\bf[a@]g\b|retard|tr[a@]nny|\bkys\b|kill (yo)?urself|c[u*]nt|wh[o0]re|\bsl[u*]t|b[i1!]tch|f+[u*]+c+k|\bsh[i1!*]t|\bd[i1]ck|pussy|\bcock\b|\brap(e|ed|ist)\b|nazi|hitler|porn|\bsex/i;

if (cmd === 'promo') await promo();
else if (cmd === 'shots') {
  if (!urls.length) throw new Error('shots needs a Twitch channel url (and a Kick or YouTube one)');
  await shoot(urls);
  await compose();
} else if (cmd === 'compose') await compose();
else throw new Error('usage: store-assets.mjs promo | shots <twitch url> <kick|youtube url> | compose');

/* ─────────────────────────────── promo tiles ─────────────────────────────── */

async function promo() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(storeSrc, 'promo.html')).href);
  await page.evaluate(() => document.fonts.ready);
  for (const [id, file] of [['small', 'promo-small.png'], ['marquee', 'promo-marquee.png']]) {
    await page.locator(`#${id}`).screenshot({ path: path.join(out, file) });
    flatten(path.join(out, file));
    console.log('wrote', path.join(out, file));
  }
  await browser.close();
}

/* ─────────────────────────────── live captures ───────────────────────────── */

/** Prefix of the build's attributes, messages and storage keys: "tiho" ("hush" in builds from before the rename). */
function prefixOf(ext) {
  const chat = fs.readFileSync(path.join(ext, 'content-scripts/chat.js'), 'utf8');
  const p = chat.match(/data-([a-z]+)-a\b/)?.[1];
  if (!p) throw new Error(`no data-*-a attribute in ${ext}/content-scripts/chat.js`);
  return p;
}

/** twitch.tv/<ch> → its popout chat; kick.com/<ch> → its popout chat; youtube watch → live_chat. */
function chatUrl(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '');
  const first = u.pathname.split('/').filter(Boolean)[0];
  if (host === 'twitch.tv' && first && first !== 'popout') return { site: 'twitch', channel: first, url: `https://www.twitch.tv/popout/${first}/chat?popout=` };
  if (host === 'kick.com' && first && first !== 'popout') return { site: 'kick', channel: first, url: `https://kick.com/popout/${first}/chat` };
  if (host === 'youtube.com' && u.searchParams.get('v')) return { site: 'youtube', channel: '', url: `https://www.youtube.com/live_chat?is_popout=1&v=${u.searchParams.get('v')}` };
  const site = host.split('.')[0];
  return { site, channel: site === 'twitch' || site === 'kick' ? u.pathname.split('/')[2] ?? '' : '', url };
}

async function shoot(list) {
  const ext = path.resolve(opts.ext ?? path.join(extRoot, '.output-final/chrome-mv3'));
  const P = prefixOf(ext);
  const settingsKey = `${P}.settings.v1`;
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  console.log(`extension: ${manifest.name} ${manifest.version} (${ext}), prefix "${P}"`);
  fs.mkdirSync(rawDir, { recursive: true });
  const anonymizer = fs.readdirSync(here).find((f) => /^anonymi[sz]e.*\.js$/.test(f));
  if (!anonymizer) throw new Error(`no anonymize*.js in ${here}`);
  const chats = list.map(chatUrl);
  const channels = chats.map((c) => c.channel).filter(Boolean);

  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'store-shots-')), {
    headless: false,
    viewport: { width: CHAT.w, height: CHAT.h },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      '--enable-unsafe-webgpu',
      '--mute-audio',
      // off screen, so the real mouse cannot touch the chat; still counts as visible
      '--window-position=-3000,-3000',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  await ctx.addInitScript({ path: path.join(here, anonymizer) });
  await ctx.addInitScript(() => {
    try {
      if (location.hostname.endsWith('twitch.tv')) localStorage.setItem('twilight.theme', '1');
    } catch {}
  });
  await ctx.addCookies([
    { name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/' },
    { name: 'PREF', value: 'f6=400', domain: '.youtube.com', path: '/' },
  ]);
  // Extension pages in their own windows: their "active tab" is the chat tab; the channel name reads "streamer".
  await ctx.addInitScript((channels) => {
    if (location.protocol !== 'chrome-extension:') return;
    if (globalThis.chrome?.tabs?.query) {
      const query = chrome.tabs.query.bind(chrome.tabs);
      const CHAT = /^https:\/\/([^/]+\.)?(twitch\.tv|youtube\.com|kick\.com)\//;
      chrome.tabs.query = async (info) => {
        if (!info?.active || !(info.currentWindow || info.lastFocusedWindow)) return query(info);
        const chat = (await query({})).filter((t) => CHAT.test(t.url ?? ''));
        return chat.length ? [chat.find((t) => t.active) ?? chat[0]] : query(info);
      };
    }
    if (!channels.length) return;
    const re = new RegExp(`\\b(${channels.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
    const fix = (root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t; t = w.nextNode()) if (re.test(t.data)) t.data = t.data.replace(re, 'streamer');
    };
    const start = () => {
      fix(document.body);
      new MutationObserver(() => fix(document.body)).observe(document.body, { childList: true, subtree: true, characterData: true });
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  }, channels);

  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  await new Promise((r) => setTimeout(r, 1500));

  const setSettings = (patch) =>
    sw.evaluate(
      async ({ key, patch }) => {
        const cur = (await chrome.storage.local.get(key))[key] ?? {};
        await chrome.storage.local.set({ [key]: { ...cur, ...patch } });
      },
      { key: settingsKey, patch },
    );
  /** Show hidden / Solo in the chat tab, as the side panel sends them. */
  const command = (c) =>
    sw.evaluate(
      async ({ type, c }) => {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) if (/twitch\.tv|youtube\.com|kick\.com/.test(t.url ?? '')) await chrome.tabs.sendMessage(t.id, { type, cmd: c }).catch(() => {});
      },
      { type: `${P}:command`, c },
    );

  const report = {};
  for (const [i, chat] of chats.entries()) {
    await setSettings({ uiMode: 'basic' });
    const page = await ctx.newPage();
    for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {}); // onboarding, the last chat
    await page.goto(chat.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    for (const name of ['Reject', 'Reject all', 'Accept', 'Start Watching', 'Got it', 'Close']) {
      await page.getByRole('button', { name, exact: true }).first().click({ timeout: 600 }).catch(() => {});
    }
    // promos over the Twitch chat that may carry names (drops, hype train, callouts, the Bits leaderboard)
    await page.addStyleTag({ content: '[class*="community-highlight-stack"], [class*="hypeTrainBanner"], [data-test-selector^="chat-private-callout-queue"], [class*="channel-leaderboard"], [data-test-selector*="leaderboard"] { display: none !important; }' }).catch(() => {});
    console.log(`${chat.site}: ${chat.url}, waiting ${secs} s`);
    await page.waitForTimeout(secs * 1000);
    await page.mouse.move(1, 1);
    const cap = (name) => capture(page, P, name);

    if (i === 0) {
      // the first screenshot explains the pill, the wave count and the question highlight: wait for a moment that shows them
      const t1 = Date.now();
      let seen = await onScreen(page, P);
      while (!(seen.pills && (seen.waves || seen.highlighted)) && Date.now() - t1 < 120_000) {
        await page.waitForTimeout(3000);
        seen = await onScreen(page, P);
      }
      console.log('on screen:', JSON.stringify(seen));
      report.basic = await cap(`${chat.site}-basic`);
      await page.waitForTimeout(8000);
      // Clean and Show hidden a moment apart, so they show the same rows. Show hidden is the
      // view with more rows, so it is the one checked for offensive text; Clean is a subset.
      // First wait (up to 90 s) for something folded on screen, so the two differ.
      const peek = (on) => command({ type: 'peek', on });
      const t0 = Date.now();
      for (;;) {
        if ((await onScreen(page, P)).pills || Date.now() - t0 > 90_000) {
          await peek(true);
          await page.waitForTimeout(600);
          const clean = !(await offensiveRows(page, P)).length;
          if (clean || Date.now() - t0 > (90 + waitClean) * 1000) break;
          await peek(false);
        }
        await page.waitForTimeout(2500);
      }
      report.peek = await cap(`${chat.site}-peek`);
      await peek(false);
      await page.waitForTimeout(250);
      report.basic2 = await cap(`${chat.site}-basic2`);

      // Advanced: the chat and the side panel's Live tab; then Solo spam with its Categories card
      await setSettings({ uiMode: 'advanced' });
      await page.waitForTimeout(1500);
      const panel = await openWindow(ctx, sw, extId, 'sidepanel.html', PANEL.w, PANEL.h);
      await panel.waitForTimeout(2500);
      report.adv = await cap(`${chat.site}-adv`);
      await shotOf(panel, 'panel-live');
      await command({ type: 'solo', cat: 'spam' });
      await page.waitForTimeout(2500);
      const scrolled = await panel.evaluate(() => {
        const h = [...document.querySelectorAll('.k-card h3, .k-card header')].find((e) => /^\s*categories/i.test(e.textContent ?? ''));
        h?.closest('.k-card')?.scrollIntoView({ block: 'start' });
        return !!h;
      });
      if (!scrolled) console.log('side panel: no Categories card found, captured the top');
      await panel.waitForTimeout(1200);
      report.solo = await cap(`${chat.site}-solo`);
      await shotOf(panel, 'panel-solo');
      await command({ type: 'solo', cat: null });
      await panel.close();

      const pop = await openWindow(ctx, sw, extId, 'popup.html', POPUP.w, POPUP.h);
      await pop.waitForTimeout(2500);
      await shotOf(pop, 'popup-adv');
      await pop.close();
      await setSettings({ uiMode: 'basic' });
    } else {
      report[chat.site] = await cap(`${chat.site}-basic`);
    }
    // the page stays open until the next one is: closing the last window would end the browser
  }
  console.log(JSON.stringify(report, null, 1));
  await ctx.close();
}

/** An extension page in a window of its own, sized in CSS px. */
async function openWindow(ctx, sw, extId, file, width, height) {
  const opened = ctx.waitForEvent('page');
  await sw.evaluate(({ width, height }) => chrome.windows.create({ url: 'about:blank', type: 'popup', width, height, left: 40, top: 40 }), { width, height });
  const p = await opened;
  await p.setViewportSize({ width, height });
  await p.goto(`chrome-extension://${extId}/${file}`);
  await p.addStyleTag({ content: NO_SCROLLBARS });
  await p.waitForTimeout(1500);
  return p;
}

/** The side panel: its window. The popup: down to the end of its content (a real popup is at most 600 px tall and scrolls). */
async function shotOf(p, name) {
  const file = path.join(rawDir, `${name}.png`);
  if (name.startsWith('popup')) {
    const bottom = await p.evaluate(() => Math.ceil(Math.max(...[...document.body.querySelectorAll('*')].map((e) => e.getBoundingClientRect().bottom))));
    const vp = p.viewportSize();
    await p.screenshot({ path: file, clip: { x: 0, y: 0, width: vp.width, height: Math.min(vp.height, bottom) } });
  } else await p.screenshot({ path: file });
  console.log('captured', name);
}

/** Runs in the chat page: the part of the viewport above the chat's input box (the bottom of the list's scroller). */
function chatClip(P) {
  const row = document.querySelector(`[data-${P}-a]`);
  let s = row?.parentElement;
  while (s && s !== document.body && !/auto|scroll/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
  const bottom = s && s !== document.body ? Math.min(innerHeight, Math.round(s.getBoundingClientRect().bottom)) : innerHeight;
  return { x: 0, y: 0, width: innerWidth, height: bottom > 200 ? bottom : innerHeight };
}

/** Pills, waves and highlighted questions inside the chat's visible area. */
function onScreen(page, P) {
  return page.evaluate((P) => {
    const row = document.querySelector(`[data-${P}-a]`);
    if (!row) return { pills: 0, waves: 0, highlighted: 0 };
    let s = row.parentElement;
    while (s.parentElement && !/auto|scroll/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
    const { top, bottom } = s.getBoundingClientRect();
    const seen = (sel) => [...document.querySelectorAll(sel)].filter((r) => {
      const b = r.getBoundingClientRect();
      return b.height > 0 && b.top >= top && b.bottom <= bottom;
    }).length;
    return { pills: seen(`[data-${P}-run]`), waves: seen(`[data-${P}-wh]`), highlighted: seen(`[data-${P}-a="highlight"]`) };
  }, P);
}

/** Hand the bar's closed shadow root to the anonymizer, as media-shoot.mjs does (the expanded bar lists askers' names). */
async function anonymizeBar(page, P) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const roots = [];
    (function walk(n) {
      if (n.nodeName === `${P.toUpperCase()}-BAR`) roots.push(...(n.shadowRoots ?? []));
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) walk(c);
    })(root);
    for (const r of roots) {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: r.backendNodeId });
      await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function () { (window.__tihoAnon ?? window.__hushAnon)?.watch(this); }',
      });
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Screenshot of the chat (above its input box) once nothing offensive is readable, or with such rows blurred after --wait s. */
async function capture(page, P, name) {
  await anonymizeBar(page, P).catch((e) => console.log(`${name}: bar not anonymized (${e.message})`));
  const t0 = Date.now();
  let bad = await offensiveRows(page, P);
  while (bad.length && Date.now() - t0 < waitClean * 1000) {
    await page.waitForTimeout(2500);
    bad = await offensiveRows(page, P);
  }
  if (bad.length) {
    console.log(`${name}: blurring ${bad.length} row(s) that stayed on screen`);
    await offensiveRows(page, P, true);
  }
  const file = path.join(rawDir, `${name}.png`);
  await page.screenshot({ path: file, clip: await page.evaluate(chatClip, P) });
  if (bad.length) await page.evaluate(() => document.querySelectorAll('[data-store-blur]').forEach((r) => { r.style.filter = ''; r.removeAttribute('data-store-blur'); }));
  const counts = await page.evaluate((P) => {
    const n = (sel) => document.querySelectorAll(sel).length;
    return { rows: n(`[data-${P}-a]`), pills: n(`[data-${P}-run]`), waves: n(`[data-${P}-wh]`), highlighted: n(`[data-${P}-a="highlight"]`) };
  }, P);
  console.log('captured', name, JSON.stringify(counts), bad.length ? `(blurred ${bad.length})` : '');
  return { ...counts, blurred: bad.length };
}

/** Texts of the rows on screen that are toxic or match OFFENSIVE; with `blur`, blurs them too. */
function offensiveRows(page, P, blur = false) {
  return page.evaluate(
    ({ P, src, blur }) => {
      const re = new RegExp(src, 'i');
      const out = [];
      for (const row of document.querySelectorAll(`[data-${P}-a]`)) {
        const r = row.getBoundingClientRect();
        const cs = getComputedStyle(row);
        if (r.height < 2 || r.bottom < 0 || r.top > innerHeight || cs.visibility === 'hidden' || cs.display === 'none') continue;
        const text = row.textContent ?? '';
        if (row.getAttribute(`data-${P}-c`) !== 'toxic' && !re.test(text)) continue;
        out.push(text.slice(0, 80));
        if (blur) {
          row.style.filter = 'blur(6px)';
          row.setAttribute('data-store-blur', '');
        }
      }
      return out;
    },
    { P, src: OFFENSIVE.source, blur },
  );
}

/* ──────────────────────────────── compose ────────────────────────────────── */

async function compose() {
  const have = (n) => fs.existsSync(path.join(rawDir, `${n}.png`));
  const others = ['youtube-basic', 'kick-basic'].filter(have);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  for (const s of SHOTS) {
    let items = s.items;
    if (s.file === 'screenshot-5.png') {
      items = others.map((n) => [n, n.startsWith('youtube') ? 'YouTube' : 'Kick']);
      if (items.length < 2) items.push(['twitch-basic2', 'Twitch']);
    }
    items = items.filter(([n]) => have(n));
    if (!items.length) {
      console.log(`skip ${s.file}: no captures`);
      continue;
    }
    // CSS size of each capture (2× device pixels) times its scale, then one factor for all so they fit the stage
    const sized = items.map(([n, label, scale = 1]) => {
      const { width, height } = pngSize(path.join(rawDir, `${n}.png`));
      return { n, label, w: (width / 2) * scale, h: (height / 2) * scale };
    });
    const GAP = 36;
    const maxH = sized.some((x) => x.label) ? 590 : 615;
    const maxW = 1200 - (s.notes?.length ? 300 + GAP : 0) - GAP * (sized.length - 1);
    const f = Math.min(1, maxH / Math.max(...sized.map((x) => x.h)), maxW / sized.reduce((a, x) => a + x.w, 0));
    const spec = {
      caption: s.caption,
      sub: s.sub,
      notes: s.notes,
      notesFirst: s.notesFirst,
      items: sized.map((x) => ({
        src: pathToFileURL(path.join(rawDir, `${x.n}.png`)).href,
        label: x.label ?? undefined,
        w: Math.round(x.w * f),
        h: Math.round(x.h * f),
      })),
    };
    await page.goto(`${pathToFileURL(path.join(storeSrc, 'frame.html')).href}?shot=${s.file}#${encodeURIComponent(JSON.stringify(spec))}`); // a new document per shot
    await page.waitForSelector('body[data-ready]');
    await page.evaluate(() => document.fonts.ready);
    const file = path.join(out, s.file);
    await page.screenshot({ path: file });
    flatten(file);
    console.log('wrote', file);
  }
  await browser.close();
}

/** Width and height of a PNG, from its IHDR chunk. */
function pngSize(file) {
  const b = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, b, 0, 24, 0);
  fs.closeSync(fd);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Rewrite a PNG as 24-bit RGB (no alpha channel): the store's requirement. */
function flatten(file) {
  const py = 'import sys\nfrom PIL import Image\nim = Image.open(sys.argv[1])\nif im.mode != "RGB":\n    im.convert("RGB").save(sys.argv[1], optimize=True)\nprint(Image.open(sys.argv[1]).mode, Image.open(sys.argv[1]).size)';
  const pythons = [path.join(repo, 'ml/.venv/Scripts/python.exe'), path.join(repo, 'ml/.venv/bin/python'), 'python'];
  for (const exe of pythons) {
    if (exe !== 'python' && !fs.existsSync(exe)) continue;
    try {
      const r = execFileSync(exe, ['-c', py, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (!r.startsWith('RGB')) throw new Error(r);
      return;
    } catch (e) {
      if (exe === 'python') throw new Error(`could not flatten ${file} (needs Python with Pillow): ${e.message}`);
    }
  }
}
