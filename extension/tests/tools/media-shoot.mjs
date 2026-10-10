// Screenshots and a demo clip of Hush on a real live chat, for the README
// (docs/img/live-*.png, docs/img/hush-demo.gif / .mp4).
//
//   node tests/tools/media-shoot.mjs <channel url> <shot>[,<shot>…] [options]
//
// shots:
//   chat       the chat column with the bar          wide   video + chat
//   dashboard  the chat column with the bar expanded
//   live, inbox, log   side panel tabs               popup  the toolbar popup
//   engine     side panel → Rules → Custom AI filters, turned on with the
//              Backseating filter (Hush Engine must answer on 127.0.0.1:7377)
//   clip       --clip-secs of the chat column, frame by frame → NAME-clip.mp4 and .gif (needs ffmpeg)
// options:
//   --secs N        let the chat run N s before the first shot (60)
//   --light         light theme (Twitch and YouTube; dark otherwise)
//   --name NAME     file prefix (platform name): NAME-<shot>.png
//   --out DIR       output folder (<tmp>/hush-media)
//   --viewport WxH  CSS px of the chat page (1600x950); screenshots are 2× device pixels
//   --context TEXT  stream context for the engine shot; --test TEXT asks the filters about a sample message
//   --gap N         wait N s between shots (0); a shot listed twice is saved as NAME-<shot>-2.png
//   --engine-secs N let the engine answer N s before the engine shot (60)
//   --clip-secs N   length of the clip (15); --trim, --clip-height, --fps, --gif-width, --crf: see encode()
//
// Every frame of every page first gets tests/tools/anonymize.js: chatter names
// and @mentions become stable fake handles and avatars are hidden, without
// touching the text Hush reads. The side panel and the popup open as extension
// pages in their own windows (so the chat tab stays visible and keeps sending
// to the engine); a small shim makes their "active tab" the chat tab.
// Build first: HUSH_OUT=.output-media npx wxt build.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pos = [];
const opts = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) pos.push(a);
  else if (a === '--light') opts.light = true;
  else opts[a.slice(2)] = process.argv[++i];
}
const opt = (k, d) => opts[k] ?? d;
const [url, shotList = 'chat'] = pos;
const shots = shotList.split(',');
const secs = Number(opt('secs', 60));
const light = !!opts.light;
const name = opt('name', new URL(url).hostname.replace(/^www\./, '').split('.')[0]);
const out = path.resolve(opt('out', path.join(os.tmpdir(), 'hush-media')));
const [vw, vh] = opt('viewport', '1600x950').split('x').map(Number);
const ext = path.resolve(process.env.HUSH_EXT_DIR ?? '.output-media/chrome-mv3');
const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(out, { recursive: true });
/** Device scale: screenshots and clip frames are 2× the CSS size. */
const DPR = 2;

/** Promos and banners that are not part of the chat (and may carry names). */
const COSMETIC_CSS = `
  /* Twitch: drops / hype train cards over the chat, callouts above the input, the sign-up footer */
  [class*="community-highlight-stack"], [class*="hypeTrainBanner"], [data-test-selector^="chat-private-callout-queue"], footer:has(.tw-callout-message) { display: none !important; }`;

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'hush-media-')), {
  headless: false,
  viewport: { width: vw, height: vh },
  deviceScaleFactor: DPR,
  colorScheme: light ? 'light' : 'dark',
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--enable-unsafe-webgpu',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    // off screen, so the real mouse cannot hover or click the chat; the window
    // must still count as visible (also while the side panel window covers it)
    '--window-position=-3000,-3000',
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});

await ctx.addInitScript({ path: path.join(here, 'anonymize.js') });
// Twitch keeps its theme in localStorage ("1" = dark); YouTube in the PREF cookie.
await ctx.addInitScript((dark) => {
  try {
    if (location.hostname.endsWith('twitch.tv')) localStorage.setItem('twilight.theme', dark ? '1' : '0');
  } catch {}
}, !light);
await ctx.addCookies([
  { name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/' }, // consent: "reject all"
  ...(light ? [] : [{ name: 'PREF', value: 'f6=400', domain: '.youtube.com', path: '/' }]),
]);
// Extension pages find "their" tab with tabs.query({active, currentWindow}) (src/ui/bridge.ts):
// here they live in a window of their own, so answer with the chat tab.
await ctx.addInitScript(() => {
  if (location.protocol !== 'chrome-extension:' || !globalThis.chrome?.tabs?.query) return;
  const query = chrome.tabs.query.bind(chrome.tabs);
  const CHAT = /^https:\/\/([^/]+\.)?(twitch\.tv|youtube\.com|kick\.com)\//;
  chrome.tabs.query = async (info) => {
    if (!info?.active || !(info.currentWindow || info.lastFocusedWindow)) return query(info);
    const chat = (await query({})).filter((t) => CHAT.test(t.url ?? ''));
    return chat.length ? [chat.find((t) => t.active) ?? chat[0]] : query(info);
  };
});

let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await new Promise((r) => setTimeout(r, 1500));

// Shots assume default settings: note any change (a stray click on the headed window, say).
await sw.evaluate(() => {
  globalThis.__settingsLog = [];
  chrome.storage.onChanged.addListener((c) => {
    const s = c['hush.settings.v1']?.newValue;
    if (s) globalThis.__settingsLog.push(`${new Date().toISOString().slice(11, 19)} actions=${JSON.stringify(s.actions)} engine=${s.engine?.enabled}`);
  });
});

const page = await ctx.newPage();
for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {}); // onboarding
// Real input on the chat page is logged: the tool's own clicks, and any that would change what the shots show.
page.on('console', (m) => m.text().startsWith('[input]') && console.log(m.text()));
await page.addInitScript(() => {
  const log = (e) => e.isTrusted && console.log(`[input] ${new Date().toISOString().slice(11, 19)} ${e.type} ${e.key ?? `${e.clientX},${e.clientY}`}`);
  addEventListener('pointerdown', log, true);
  addEventListener('keydown', log, true);
});
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await dismissOverlays(page);
await page.addStyleTag({ content: COSMETIC_CSS }).catch(() => {});
await page.waitForTimeout(secs * 1000);
await dismissOverlays(page);

let panel = null;
const taken = {};
for (const [i, shot] of shots.entries()) {
  if (i) await page.waitForTimeout(Number(opt('gap', 0)) * 1000);
  taken[shot] = (taken[shot] ?? 0) + 1;
  const file = path.join(out, `${name}-${shot}${taken[shot] > 1 ? `-${taken[shot]}` : ''}.png`);
  await page.mouse.move(1, 1); // no hover chip or reply button on a row
  if (shot === 'chat' || shot === 'wide') {
    if (await barOpen(page)) await toggleBar(page);
    await page.screenshot({ path: file, clip: await crop(page, shot === 'wide') });
    console.log('on screen:', JSON.stringify(await onScreen(page)));
  } else if (shot === 'dashboard') {
    if (!(await barOpen(page))) await toggleBar(page);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: file, clip: await crop(page, false) });
    await toggleBar(page);
  } else if (shot === 'live' || shot === 'inbox' || shot === 'log') {
    panel ??= await openWindow('sidepanel.html', 400, 1000);
    await panel.getByRole('tab', { name: new RegExp(`^${shot}`, 'i') }).click();
    await panel.waitForTimeout(2500);
    await panel.screenshot({ path: file });
  } else if (shot === 'popup') {
    const pop = await openWindow('popup.html', 360, 640);
    await pop.waitForTimeout(2500);
    await pop.locator('body').screenshot({ path: file });
    await pop.close();
  } else if (shot === 'engine') {
    panel ??= await openWindow('sidepanel.html', 400, 1000);
    await engineShot(panel, file);
  } else if (shot === 'clip') {
    await anonymizeBar(page);
    await record(page, file.replace(/\.png$/, ''), Number(opt('clip-secs', 15)));
    continue;
  } else throw new Error(`unknown shot "${shot}"`);
  console.log('wrote', file);
}

console.log(JSON.stringify({ ...(await report(page)), settingsChanges: await sw.evaluate(() => globalThis.__settingsLog) }, null, 1));
await ctx.close();

/* ───────────────────────────────── helpers ───────────────────────────────── */

/** Cookie banners, age gates and promos that cover the player or the chat. */
async function dismissOverlays(p) {
  for (const name of ['Reject', 'Reject all', 'Reject All', 'Accept', 'Start Watching', 'Got it']) {
    await p.getByRole('button', { name, exact: true }).first().click({ timeout: 800 }).catch(() => {});
  }
}

/** Hand the bar's closed shadow root to the anonymizer (and remember it for toggleBar). */
async function anonymizeBar(p) {
  const cdp = await p.context().newCDPSession(p);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const roots = [];
  (function walk(n) {
    if (n.nodeName === 'HUSH-BAR') roots.push(...(n.shadowRoots ?? []));
    for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) walk(c);
  })(root);
  for (const r of roots) {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: r.backendNodeId });
    await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { window.__hushBarRoot = this; window.__hushAnon?.watch(this); }',
    });
  }
  await cdp.detach();
  return roots.length;
}

/** The frame that hosts the chat (YouTube: the live_chat iframe). */
async function chatFrame(p) {
  for (const f of p.frames()) if (await f.evaluate(() => !!document.querySelector('[data-hush-a]')).catch(() => false)) return f;
  return p.mainFrame();
}

/** Page offset of a frame's viewport. */
async function frameOffset(f) {
  const el = await f.frameElement().catch(() => null);
  if (!el) return { x: 0, y: 0 };
  const box = await el.boundingBox();
  const parent = await frameOffset(f.parentFrame());
  return { x: parent.x + box.x, y: parent.y + box.y };
}

async function barOpen(p) {
  await anonymizeBar(p);
  return (await chatFrame(p)).evaluate(() => window.__hushBarRoot?.querySelector('.hb-expand')?.getAttribute('aria-expanded') === 'true');
}

/** Bar → live stats, with real (trusted) clicks: the bar drops synthetic input. */
async function toggleBar(p) {
  await anonymizeBar(p);
  const f = await chatFrame(p);
  const r = await f.evaluate(() => {
    const b = window.__hushBarRoot?.querySelector('.hb-expand')?.getBoundingClientRect();
    return b && { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  if (!r) throw new Error('bar not found');
  const o = await frameOffset(f);
  await p.mouse.click(o.x + r.x, o.y + r.y);
  await p.mouse.move(1, 1);
}

/**
 * Runs in the page: the box of the chat column around `sel`, that is the
 * tallest on-screen ancestor about as wide as `sel` (the chat list's own
 * height is its scroll content, and wrappers may have none).
 */
function columnOf(sel) {
  const start = sel === 'list' ? document.querySelector('[data-hush-a]').parentElement : document.querySelector(sel);
  const w = start.getBoundingClientRect().width;
  const seen = (r) => Math.min(innerHeight, r.bottom) - Math.max(0, r.top);
  let best = start;
  for (let up = start.parentElement; up && up !== document.body && Math.abs(up.getBoundingClientRect().width - w) <= 24; up = up.parentElement) {
    if (seen(up.getBoundingClientRect()) >= seen(best.getBoundingClientRect())) best = up;
  }
  const r = best.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** The chat column (YouTube: the chat iframe's container in the watch page), or the player + chat when `wide`. */
async function crop(p, wide) {
  const f = await chatFrame(p);
  let box = f === p.mainFrame() ? await f.evaluate(columnOf, 'list') : await p.evaluate(columnOf, '#chatframe, iframe[src*="live_chat"]');
  if (wide) {
    const v = await p.evaluate(() => {
      const r = [...document.querySelectorAll('video')].map((e) => e.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      return r && { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    if (v) {
      const x = Math.min(v.x, box.x);
      const y = Math.min(v.y, box.y);
      box = { x, y, width: box.x + box.width - x, height: Math.max(v.y + v.height, box.y + box.height) - y };
    }
  }
  const vp = p.viewportSize();
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  return { x, y, width: Math.min(vp.width, box.x + box.width) - x, height: Math.min(vp.height, box.y + box.height) - y };
}

/** An extension page in a popup window of its own, sized in CSS px. */
async function openWindow(file, width, height) {
  const opened = ctx.waitForEvent('page');
  await sw.evaluate(({ width, height }) => chrome.windows.create({ url: 'about:blank', type: 'popup', width, height, left: 40, top: 40 }), { width, height });
  const p = await opened;
  await p.setViewportSize({ width, height });
  await p.goto(`chrome-extension://${extId}/${file}`);
  await p.waitForTimeout(1500);
  return p;
}

/** Rules → Custom AI filters: engine on, Backseating filter, stream context; then let it answer. */
async function engineShot(p, file) {
  await p.getByRole('tab', { name: /^rules/i }).click();
  const toggle = p.getByRole('switch', { name: 'Use Hush Engine' });
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await p.locator('.sp-suggest button', { hasText: 'Backseating' }).click();
  const context = opt('context', '');
  if (context) {
    await p.locator('#sp-context').fill(context);
    await p.locator('#sp-context').blur();
  }
  await p.waitForTimeout(Number(opt('engine-secs', 60)) * 1000);
  const sample = opt('test', '');
  if (sample) {
    await p.getByLabel('Sample message').fill(sample);
    await p.getByLabel('Sample message').press('Enter');
    await p.locator('.sp-test-out').waitFor({ timeout: 15000 });
  }
  const card = p.locator('.k-card', { has: p.locator('.sp-ai-title') });
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: file });
}

/**
 * Record `secs` of the chat column as back-to-back CDP screenshots (the
 * screencast would give CSS pixels; these are device pixels, 15 to 30 per s),
 * then let ffmpeg resample them to a constant frame rate: <base>.mp4 (H.264)
 * and <base>.gif (palettegen / paletteuse). Frames stay in <base>-frames.
 */
async function record(p, base, secs) {
  const dir = `${base}-frames`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const c = await crop(p, false);
  // CDP clips are in CSS pixels at scale 1
  const clip = { x: c.x, y: c.y, width: c.width, height: c.height, scale: DPR };
  const cdp = await p.context().newCDPSession(p);
  const frames = [];
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    const t = (Date.now() - t0) / 1000;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
    const f = path.join(dir, `${String(frames.length).padStart(5, '0')}.png`);
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    frames.push({ f, t });
  }
  await cdp.detach();
  // concat list with each frame's real duration
  const entry = (fr) => `file '${fr.f.replaceAll('\\', '/')}'`;
  const list = frames.map((fr, i) => `${entry(fr)}\nduration ${((frames[i + 1]?.t ?? secs) - fr.t).toFixed(4)}`);
  fs.writeFileSync(path.join(dir, 'list.txt'), `${list.join('\n')}\n${entry(frames.at(-1))}\n`);
  encode(dir, base);
  console.log(`wrote ${base}.mp4 and ${base}.gif from ${frames.length} frames in ${secs} s`);
}

/**
 * frames/list.txt → <base>.mp4 and <base>.gif. --trim S drops the first S
 * seconds, --clip-height N keeps the top N CSS px (say, without the chat
 * input); --fps, --gif-width and --crf tune the GIF and the MP4.
 */
function encode(dir, base) {
  const fps = Number(opt('fps', 15));
  const width = Number(opt('gif-width', 560));
  const height = Number(opt('clip-height', 0));
  const cut = `trim=start=${Number(opt('trim', 0))},setpts=PTS-STARTPTS${height ? `,crop=iw:${height * DPR}:0:0` : ''}`;
  const input = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt')];
  execFileSync('ffmpeg', [...input, '-vf', `${cut},fps=30,scale=trunc(iw/2)*2:-2`, '-c:v', 'libx264', '-preset', 'slow', '-crf', opt('crf', '24'), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${base}.mp4`], { stdio: 'inherit' });
  const gif = `${cut},fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  execFileSync('ffmpeg', [...input, '-vf', gif, `${base}.gif`], { stdio: 'inherit' });
}

/** Pills, highlighted rows and wave badges in view: to pick the shot that shows them all. */
async function onScreen(p) {
  return (await chatFrame(p)).evaluate(() => {
    const list = document.querySelector('[data-hush-a]').parentElement;
    let scroller = list.parentElement;
    while (scroller.parentElement && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const { top, bottom } = scroller.getBoundingClientRect();
    const seen = (sel) => [...list.querySelectorAll(sel)].filter((r) => {
      const b = r.getBoundingClientRect();
      return b.height > 0 && b.top >= top && b.bottom <= bottom;
    }).length;
    return { pills: seen('[data-hush-run]'), highlighted: seen('[data-hush-a="highlight"]'), waves: seen('[data-hush-wh]'), dimmed: seen('[data-hush-a="dim"]') };
  });
}

/** What Hush decided on the chat page, and the anonymizer's verdict check. */
async function report(p) {
  const f = await chatFrame(p);
  return f.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-hush-c]')];
    const act = {};
    for (const r of rows) act[r.dataset.hushA] = (act[r.dataset.hushA] || 0) + 1;
    return { rows: rows.length, actions: act, anonymized: document.querySelectorAll('[data-anon]').length, anon: window.__hushAnon?.check() };
  });
}
