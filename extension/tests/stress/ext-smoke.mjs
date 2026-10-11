// End-to-end smoke with the REAL built extension (content script + background +
// offscreen) on the mock chats served at real chat URLs.
//
//   TIHO_OUT=.output-runtime npx wxt build      # build first
//   node tests/stress/ext-smoke.mjs [--rate=50] [--secs=10] [--headed]
//
// Checks: the content script attaches, rows get verdict attributes, the list is
// marked, the model status the runtime sees, long tasks / frame stalls, and the
// insert → verdict latency measured from the page (attribute observer).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarness } from './build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const opt = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const s = a.replace(/^--/, '');
    const i = s.indexOf('=');
    return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)];
  }),
);
const RATE = Number(opt.rate ?? 50);
const SECS = Number(opt.secs ?? 10);
const ext = path.resolve(here, '../../.output-runtime/chrome-mv3');
if (!fs.existsSync(path.join(ext, 'manifest.json'))) {
  console.error('build the extension first: TIHO_OUT=.output-runtime npx wxt build');
  process.exit(1);
}
const dist = await buildHarness();
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tiho-ext-')), {
  channel: 'chromium',
  headless: !opt.headed,
  viewport: { width: 420, height: 900 },
  args: [
    '--disable-gpu',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
  ],
});
await ctx.route('**/*', (r) => {
  const u = new URL(r.request().url());
  if (u.protocol === 'chrome-extension:') return r.continue();
  if (u.hostname === 'static-cdn.jtvnw.net') return r.fulfill({ contentType: 'image/gif', body: GIF });
  const base = path.basename(u.pathname);
  if (['mock.js', 'corpus.json'].includes(base)) return r.fulfill({ path: path.join(dist, base) });
  if (u.hostname === 'www.twitch.tv') return r.fulfill({ path: path.join(dist, 'twitch.html'), contentType: 'text/html' });
  if (u.hostname === 'www.youtube.com' && u.pathname.startsWith('/live_chat'))
    return r.fulfill({ path: path.join(dist, 'youtube.html'), contentType: 'text/html' });
  if (u.hostname === 'huggingface.co' || u.hostname.endsWith('hf.co') || u.hostname === '127.0.0.1' || u.hostname === 'localhost')
    return r.continue();
  return r.abort();
});

// close the onboarding tab the background opens on install
ctx.on('page', (p) => {
  if (p.url().includes('onboarding')) p.close().catch(() => {});
});

const results = {};
for (const skin of ['twitch', 'youtube']) {
  const page = await ctx.newPage();
  await page.goto(skin === 'twitch' ? 'https://www.twitch.tv/stresschan' : 'https://www.youtube.com/live_chat?v=extsmoke');
  await page.evaluate(() => window.__mock.ready);
  // page-side latency probe: insertion (row.__t) → first verdict attribute
  await page.evaluate(() => {
    const lat = (window.__lat = []);
    new MutationObserver((recs) => {
      const now = performance.now();
      for (const r of recs) {
        const el = r.target;
        const v = el.getAttribute('data-tiho-a');
        if (el.__t !== undefined && v && v !== 'pending') {
          lat.push(now - el.__t);
          el.__t = undefined;
        }
      }
    }).observe(window.__mock.list, { attributes: true, subtree: true, attributeFilter: ['data-tiho-a'] });
  });
  await page.evaluate((r) => window.__mock.start(r), RATE);
  await page.waitForTimeout(SECS * 1000);
  const out = await page.evaluate(() => {
    const list = window.__mock.list;
    const rows = Array.from(list.children);
    const lat = window.__lat.slice().sort((a, b) => a - b);
    const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : NaN);
    const byA = {};
    for (const r of rows) {
      const a = r.getAttribute('data-tiho-a');
      byA[a ?? '(none)'] = (byA[a ?? '(none)'] ?? 0) + 1;
    }
    return {
      rows: rows.length,
      decided: rows.filter((r) => r.hasAttribute('data-tiho-c')).length,
      actions: byA,
      listMarked: list.hasAttribute('data-tiho-list'),
      style: !!document.getElementById('tiho-row-style'),
      bar: !!document.querySelector('tiho-bar'),
      latency: { n: lat.length, p50: q(0.5), p95: q(0.95) },
      mock: window.__mock.stats(),
    };
  });
  await page.evaluate(() => window.__mock.stop());
  results[skin] = { ...out, mock: { sent: out.mock.sent, longTasks: out.mock.longTasks.n, longMax: out.mock.longTasks.max, over33: out.mock.frames.over33, frames: out.mock.frames.n } };
  await page.close();
}

// model status as the background sees it (asked from an extension page)
let status = null;
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 5000 }));
  const id = new URL(sw.url()).host;
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/sidepanel.html`).catch(() => {});
  status = await p.evaluate(() => chrome.runtime.sendMessage({ type: 'tiho:getStatus' })).catch((e) => String(e));
  await p.close();
} catch (e) {
  status = `unavailable: ${e}`;
}
await ctx.close();
console.log(JSON.stringify({ rate: RATE, secs: SECS, status, results }, null, 2));
