// Live smoke for the platform adapters (no extension needed):
//   node tests/tools/live-check.mjs <url> [seconds] [--headed]
// Bundles src/platforms, injects it into every frame of a real live page,
// observes the adapter's chat list exactly like the runtime (childList only)
// and reports extracted / null rows, µs per extract and a few samples.
import { chromium } from '@playwright/test';
import { build } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';

const [url, secsArg, ...flags] = process.argv.slice(2);
const secs = Number(secsArg ?? 20);
const out = await build({ input: path.resolve('src/platforms/index.ts'), output: { format: 'iife', name: 'HushPlatforms' }, write: false, logLevel: 'silent' });
const bundle = out.output[0].code;

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'hush-live-')), {
  channel: 'chrome',
  headless: !flags.includes('--headed'),
  viewport: { width: 1400, height: 950 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  args: ['--mute-audio', '--autoplay-policy=user-gesture-required'],
  bypassCSP: true,
});
const page = ctx.pages()[0];
await page.goto(url, { waitUntil: 'domcontentloaded' });
if (flags.includes('--shot')) setTimeout(() => page.screenshot({ path: path.join(process.env.TEMP, 'live-check.png') }).catch(() => {}), 20000);
for (const sel of ['button[aria-label^="Accept all"]', 'button:has-text("Accept all")', 'button:has-text("Accept")']) {
  try {
    await page.locator(sel).first().click({ timeout: 2000 });
  } catch {}
}

function installer(code) {
  if (window.__hushLive) return window.__hushLive.status;
  // eslint-disable-next-line no-new-func
  const P = new Function(code + ';return HushPlatforms;')();
  const a = P.detectAdapter(location);
  if (!a) return 'no-adapter';
  const st = (window.__hushLive = { status: 'waiting', a, n: 0, msgs: 0, nulls: 0, us: 0, samples: [], nullSamples: [], keys: new Map(), dupKeys: 0, attachedAt: 0 });
  const attach = () => {
    const list = a.findChatList(document);
    if (!list) return false;
    st.status = 'attached';
    st.list = list;
    st.meta = { platform: a.platform, channel: a.channel(document), theme: a.theme(document), anchor: (() => { const b = a.barAnchor(document); return b ? b.el.tagName + '.' + String(b.el.className).slice(0, 40) + ' ' + b.where : null; })(), viewer: a.viewer ? a.viewer(document) : undefined };
    const handle = (r) => {
      if (r.nodeType !== 1 || !r.matches(a.rowSelector)) return;
      const t0 = performance.now();
      const m = a.extract(r);
      st.us += (performance.now() - t0) * 1000;
      st.n++;
      if (m) {
        st.msgs++;
        const prev = st.keys.get(m.key);
        if (prev) {
          st.dupKeys++;
          if (prev.isConnected) st.dupLive = (st.dupLive || 0) + 1; // two mounted rows, same key → identical message
          else st.dupRemount = (st.dupRemount || 0) + 1; // earlier node gone → re-mount
        }
        st.keys.set(m.key, r);
        if (st.samples.length < 400) st.samples.push(m);
      } else if (st.nullSamples.length < 15) st.nullSamples.push(r.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '').slice(0, 300));
      else st.nulls++;
    };
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) handle(n);
    }).observe(list, { childList: true });
    return true;
  };
  if (!attach()) {
    const iv = setInterval(() => {
      if (attach()) clearInterval(iv);
    }, 500);
  }
  return st.status;
}

const t0 = Date.now();
let report = null;
while (Date.now() - t0 < (secs + 40) * 1000) {
  for (const f of page.frames()) {
    try {
      await f.evaluate(installer, bundle);
    } catch {}
  }
  await page.waitForTimeout(2000);
  if (Date.now() - t0 > secs * 1000) {
    for (const f of page.frames()) {
      try {
        const r = await f.evaluate(() => {
          const s = window.__hushLive;
          if (!s || s.status !== 'attached') return null;
          const nulls = s.n - s.msgs;
          const pick = (k) => s.samples.filter(k).slice(0, 3).map((m) => `${m.author} r=${m.roles} e=${m.emotes} paid=${m.paid} reply=${m.isReply} men=${JSON.stringify(m.mentions)} | ${m.text.slice(0, 70)}`);
          return {
            frame: location.href.slice(0, 90),
            meta: s.meta,
            rows: s.n,
            msgs: s.msgs,
            nulls,
            dupKeys: s.dupKeys,
            dupBothMounted: s.dupLive || 0,
            dupAfterUnmount: s.dupRemount || 0,
            usPerRow: s.n ? +(s.us / s.n).toFixed(2) : 0,
            withEmotes: s.samples.filter((m) => m.emotes).length,
            withRoles: s.samples.filter((m) => m.roles).length,
            replies: s.samples.filter((m) => m.isReply).length,
            mentions: s.samples.filter((m) => m.mentions.length).length,
            paid: s.samples.filter((m) => m.paid).length,
            emptyText: s.samples.filter((m) => !m.text).length,
            samples: pick(() => true).concat(pick((m) => m.roles), pick((m) => m.emotes), pick((m) => m.isReply), pick((m) => m.paid)),
            nullSamples: s.nullSamples.slice(0, 6),
          };
        });
        if (r) report = r;
      } catch {}
    }
    if (report) break;
  }
}
console.log(JSON.stringify(report ?? { error: 'never attached', frames: page.frames().map((f) => f.url()) }, null, 1));
await ctx.close();
