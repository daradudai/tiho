// Dev tool: DOM probe for live chats. Not part of the build or test suite.
//
//   node tests/tools/probe-chat.mjs <url> <listSelector> <outDir> [seconds] [--headed]
//
// Opens the URL in real Chrome (fresh temp profile, anonymous), finds the frame
// that contains <listSelector>, records mutation behaviour of its direct
// children for N seconds (rows added/removed, node reuse, text churn inside
// existing rows → recycling) and dumps raw HTML of the list + chat column.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const [url, listSel, outDir, secsArg, ...flags] = process.argv.slice(2);
const secs = Number(secsArg ?? 15);
const headed = flags.includes('--headed');
fs.mkdirSync(outDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(
  fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'tiho-probe-')),
  {
    channel: 'chrome',
    headless: !headed,
    viewport: { width: 1500, height: 950 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled', '--mute-audio', '--autoplay-policy=user-gesture-required'],
  },
);
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultTimeout(60000);
await page.goto(url, { waitUntil: 'domcontentloaded' });

for (const sel of [
  'button[aria-label^="Accept all"]',
  'button:has-text("Accept all")',
  'button:has-text("Accept")',
  'button[data-a-target="consent-banner-accept"]',
]) {
  try {
    await page.locator(sel).first().click({ timeout: 2000 });
  } catch {}
}

async function findFrame() {
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    for (const f of page.frames()) {
      try {
        const n = await f.evaluate((s) => document.querySelectorAll(s).length, listSel);
        if (n > 0) return f;
      } catch {}
    }
    await page.waitForTimeout(1000);
  }
  return null;
}
const frame = await findFrame();
if (!frame) {
  await page.screenshot({ path: path.join(outDir, 'noframe.png') });
  fs.writeFileSync(path.join(outDir, 'noframe.html'), await page.content());
  console.log('NO LIST FOUND; frames:', page.frames().map((f) => f.url()));
  await ctx.close();
  process.exit(1);
}
console.log('frame:', frame.url());
if (flags.includes('--yt-all')) {
  // Switch YouTube "Top chat" → "Live chat" (all messages).
  try {
    await frame.locator('yt-sort-filter-sub-menu-renderer #trigger, yt-sort-filter-sub-menu-renderer tp-yt-paper-menu-button').first().click({ timeout: 5000 });
    await frame.locator('tp-yt-paper-listbox a, tp-yt-paper-listbox tp-yt-paper-item').nth(1).click({ timeout: 5000 });
    console.log('switched to Live chat');
  } catch (e) {
    console.log('could not switch chat mode', String(e).slice(0, 200));
  }
}
await page.waitForTimeout(3000);

await frame.evaluate((sel) => {
  const list = document.querySelector(sel);
  const st = (window.__probe = {
    added: 0,
    removed: 0,
    readded: 0,
    inRowChildList: 0,
    inRowText: 0,
    inRowAttr: {},
    textChangedRows: 0,
    snap: new Map(),
    removedSet: new WeakSet(),
    listReplaced: 0,
    list,
  });
  for (const c of list.children) st.snap.set(c, c.textContent);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList' && m.target === list) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          st.added++;
          if (st.removedSet.has(n)) st.readded++;
          st.snap.set(n, n.textContent);
          // hydration timing: is content there at observer-callback time?
          const t0 = n.textContent.trim().length;
          const a0 = n.attributes.length;
          st.hyd = st.hyd ?? { emptyAtCb: 0, grewByRaf: 0, grewBy500: 0, attrsGrewByRaf: 0, n: 0 };
          st.hyd.n++;
          if (t0 === 0) st.hyd.emptyAtCb++;
          requestAnimationFrame(() => {
            if (n.textContent.trim().length !== t0) st.hyd.grewByRaf++;
            if (n.attributes.length !== a0) st.hyd.attrsGrewByRaf++;
          });
          setTimeout(() => {
            if (n.textContent.trim().length !== t0) st.hyd.grewBy500++;
          }, 500);
        }
        for (const n of m.removedNodes) {
          if (n.nodeType !== 1) continue;
          st.removed++;
          st.removedSet.add(n);
        }
      } else if (m.type === 'attributes') {
        const k = (m.target.parentElement === list ? 'ROW:' : '') + m.attributeName;
        st.inRowAttr[k] = (st.inRowAttr[k] ?? 0) + 1;
      } else if (m.type === 'characterData') st.inRowText++;
      else st.inRowChildList++;
    }
  }).observe(list, { childList: true, subtree: true, attributes: true, characterData: true });
}, listSel);

await page.waitForTimeout(secs * 1000);

const result = await frame.evaluate((sel) => {
  const st = window.__probe;
  const list = document.querySelector(sel);
  for (const [n, t] of st.snap) if (n.isConnected && n.textContent !== t) st.textChangedRows++;
  const tagCounts = {};
  for (const c of list.children) {
    const k = c.tagName.toLowerCase() + '.' + [...c.classList].slice(0, 3).join('.');
    tagCounts[k] = (tagCounts[k] ?? 0) + 1;
  }
  let shadows = 0;
  for (const e of document.querySelectorAll('*')) if (e.shadowRoot) shadows++;
  const chain = [];
  for (let el = list; el; el = el.parentElement)
    chain.push(
      el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') +
        (el.classList.length ? '.' + [...el.classList].slice(0, 4).join('.') : '') +
        (el.shadowRoot ? '[shadow]' : '') +
        ` (children=${el.children.length})`,
    );
  let col = list;
  for (let i = 0; i < 7 && col.parentElement && col.parentElement !== document.body; i++) col = col.parentElement;
  return {
    url: location.href,
    sameListNode: list === st.list,
    htmlAttrs: Object.fromEntries([...document.documentElement.attributes].map((a) => [a.name, a.value.slice(0, 300)])),
    bodyAttrs: Object.fromEntries([...document.body.attributes].map((a) => [a.name, a.value.slice(0, 300)])),
    listChildren: list.children.length,
    tagCounts,
    shadows,
    stats: {
      added: st.added,
      removed: st.removed,
      readded: st.readded,
      inRowChildList: st.inRowChildList,
      inRowText: st.inRowText,
      inRowAttr: st.inRowAttr,
      textChangedRows: st.textChangedRows,
      hydration: st.hyd,
    },
    chain,
    listHTML: list.outerHTML,
    columnHTML: col.outerHTML.slice(0, 4_000_000),
    docHTML: document.documentElement.outerHTML.slice(0, 6_000_000),
  };
}, listSel);

for (const k of ['listHTML', 'columnHTML', 'docHTML']) {
  fs.writeFileSync(path.join(outDir, k.replace('HTML', '') + '.html'), result[k]);
  delete result[k];
}
fs.writeFileSync(path.join(outDir, 'probe.json'), JSON.stringify(result, null, 2));
await page.screenshot({ path: path.join(outDir, 'page.png') });
console.log(JSON.stringify(result, null, 2));
await ctx.close();
