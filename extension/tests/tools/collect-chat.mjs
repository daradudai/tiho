// Dev tool: collect diverse live-chat rows for fixtures. Not part of the build.
//
//   node tests/tools/collect-chat.mjs <listSelector> <outDir> <minutes> <url...> [--yt-all] [--headed]
//
// Opens every URL in its own tab, watches the chat list (direct children) and
// keeps up to 3 exemplars of every structural "signature" (custom tags, stable
// classes, data-* targets, badge names) plus the final list/doc snapshots.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [listSel, outDir, minutesArg, ...urls] = args.filter((a) => !a.startsWith('--'));
const minutes = Number(minutesArg);
fs.mkdirSync(outDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(
  fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'hush-collect-')),
  {
    channel: 'chrome',
    headless: !flags.includes('--headed'),
    viewport: { width: 1400, height: 1000 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled', '--mute-audio', '--autoplay-policy=user-gesture-required'],
  },
);

function installer(listSel) {
  if (window.__col && window.__col.list && window.__col.list.isConnected) return true;
  const list = document.querySelector(listSel);
  if (!list) return false;
  const col = (window.__col = { sigs: window.__col?.sigs ?? {}, nsig: 0, count: window.__col?.count ?? 0, idx: [], recent: [], list });
  const keepCls = (c) =>
    c.length < 48 &&
    !/^(Layout-sc|InjectLayout-sc|Sc[A-Z]|CoreText-sc|ScCore|ScSvg|ButtonIcon)/.test(c) &&
    !/^[a-zA-Z]{5,6}$/.test(c) &&
    !/^(style-scope|yt-live-chat-|tw-)/.test(c) &&
    !/^(px|py|pr|pl|mx|my|mr|ml|mt|mb|p|m|w|h|size|gap|text-\[|leading|top|left|inset|z|min-w|max-w)-/.test(c) &&
    !/^(lg|sm|md|xl|betterhover|group-hover|hover|focus):/.test(c);
  function sig(el) {
    const t = new Set();
    const walk = (e, d) => {
      const tag = e.tagName.toLowerCase();
      if (tag === 'svg' || tag === 'path') return;
      if (tag.includes('-')) t.add(tag);
      for (const c of e.classList) if (keepCls(c)) t.add('.' + c);
      for (const a of ['data-a-target', 'data-test-selector', 'data-testid', 'author-type', 'data-chat-entry']) {
        const v = e.getAttribute(a);
        if (v != null) t.add(a + '=' + v.replace(/\d+/g, '#').slice(0, 40));
      }
      if (tag.startsWith('yt-live-chat-author-badge-renderer')) t.add('ytbadge=' + (e.getAttribute('type') || '?'));
      if (tag === 'img') {
        const alt = (e.getAttribute('alt') || '').replace(/\d+/g, '#').slice(0, 30);
        if (e.classList.contains('chat-badge')) t.add('badge=' + alt);
        else if (/badge/i.test(e.getAttribute('src') || '') || e.closest('[data-testid^="identity-badge"]')) t.add('kbadge=' + alt);
      }
      if (d > 40) return;
      for (const k of e.children) walk(k, d + 1);
    };
    walk(el, 0);
    return [...t].sort().join(' ');
  }
  function onAdd(n) {
    col.count++;
    const s = sig(n);
    const di = n.getAttribute('data-index');
    if (di != null) col.idx.push([Date.now(), +di, (n.textContent || '').slice(0, 60)]);
    if (col.idx.length > 4000) col.idx.splice(0, 1000);
    const html = n.outerHTML;
    col.recent.push(html);
    if (col.recent.length > 80) col.recent.shift();
    let arr = col.sigs[s];
    if (!arr) {
      if (col.nsig > 600) return;
      arr = col.sigs[s] = [];
      col.nsig++;
    }
    if (arr.length < 3 && html.length < 60000) arr.push(html);
  }
  for (const c of list.children) onAdd(c);
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) onAdd(n);
  }).observe(list, { childList: true });
  return true;
}

const pages = [];
for (const url of urls) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);
  pages.push({ url, page, frame: null });
  page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('goto fail', url, String(e).slice(0, 100)));
}
await (ctx.pages()[0]?.url() === 'about:blank' ? ctx.pages()[0].close() : null);

const t0 = Date.now();
const merged = {};
let lastDump = 0;
async function harvest(final) {
  for (const p of pages) {
    try {
      if (!p.frame) {
        for (const f of p.page.frames()) {
          try {
            const has = await f.evaluate((s) => !!document.querySelector(s), listSel);
            if (!has) continue;
            if (flags.includes('--yt-all') && !p.switched) {
              p.switched = true;
              // NB: switching Top chat → Live chat REPLACES the #items element.
              try {
                await f.locator('yt-sort-filter-sub-menu-renderer #trigger, yt-sort-filter-sub-menu-renderer tp-yt-paper-menu-button').first().click({ timeout: 4000 });
                await f.locator('tp-yt-paper-listbox a, tp-yt-paper-listbox tp-yt-paper-item').nth(1).click({ timeout: 4000 });
                await new Promise((r) => setTimeout(r, 3000));
              } catch {}
            }
            if (await f.evaluate(installer, listSel)) {
              p.frame = f;
              console.log('installed', p.url, '→', f.url());
              break;
            }
          } catch {}
        }
        continue;
      }
      const data = await p.frame.evaluate(() => {
        const c = window.__col;
        if (!c) return null;
        const out = { sigs: c.sigs, count: c.count, idx: c.idx, stale: !c.list.isConnected };
        return out;
      });
      if (data?.stale) console.log('LIST REPLACED', p.url);
      if (!data || data.stale) {
        p.frame = null;
        continue;
      }
      p.count = data.count;
      p.idx = data.idx;
      for (const [s, arr] of Object.entries(data.sigs)) {
        const m = (merged[s] = merged[s] ?? []);
        for (const h of arr) if (m.length < 3 && !m.includes(h)) m.push(h);
      }
      if (final) {
        const snap = await p.frame.evaluate((sel) => {
          const list = document.querySelector(sel);
          return { list: list?.outerHTML ?? '', doc: document.documentElement.outerHTML, recent: window.__col.recent, url: location.href };
        }, listSel);
        const name = p.url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
        fs.writeFileSync(path.join(outDir, `snap-${name}.json`), JSON.stringify(snap));
      }
    } catch (e) {
      console.log('harvest err', p.url, String(e).slice(0, 120));
      p.frame = null;
    }
  }
  fs.writeFileSync(path.join(outDir, 'sigs.json'), JSON.stringify(merged, null, 1));
  fs.writeFileSync(
    path.join(outDir, 'meta.json'),
    JSON.stringify(pages.map((p) => ({ url: p.url, count: p.count, idx: p.idx })), null, 0),
  );
}

while (Date.now() - t0 < minutes * 60000) {
  await new Promise((r) => setTimeout(r, 15000));
  await harvest(false);
  if (Date.now() - lastDump > 60000) {
    lastDump = Date.now();
    console.log(
      `[${Math.round((Date.now() - t0) / 1000)}s] sigs=${Object.keys(merged).length} counts=${pages.map((p) => p.count ?? '-').join(',')}`,
    );
  }
}
await harvest(true);
console.log('done; sigs', Object.keys(merged).length);
await ctx.close();
