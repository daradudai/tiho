// Quick runtime smoke on the mock chats (the full benchmark is run-stress.mjs).
//   npx playwright test --project=stress
import { chromium, expect, test, type Browser } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain ESM helper without types
import { buildHarness } from './build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ISO = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const FLAGS = ['--disable-gpu', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'];

let dist = '';
let browser: Browser;

test.beforeAll(async () => {
  test.skip(!fs.existsSync(path.join(here, '.corpus', 'corpus.json')), 'run `node tests/stress/make-corpus.mjs` first');
  dist = await buildHarness();
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: FLAGS });
});

test.afterAll(async () => {
  await browser?.close();
});

interface HushStats {
  msgs: number;
  msPerMsg: number;
  maxSliceMs: number;
  latency: { p50: number; p95: number };
  sizes: Record<string, number>;
  inChat: { rows: number; hidden: number; folded: number };
  waves: { count: number }[];
}

for (const skin of ['twitch', 'youtube'] as const) {
  test(`${skin}: 100 msg/s for 10 s stays within budget`, async () => {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route('**/*', (r) => {
      const u = new URL(r.request().url());
      if (u.hostname === 'static-cdn.jtvnw.net')
        return r.fulfill({ contentType: 'image/gif', body: GIF, headers: { 'cross-origin-resource-policy': 'cross-origin' } });
      const base = path.basename(u.pathname);
      if (['mock.js', 'harness.js', 'corpus.json'].includes(base)) return r.fulfill({ path: path.join(dist, base) });
      if (u.hostname === 'www.twitch.tv') return r.fulfill({ path: path.join(dist, 'twitch.html'), contentType: 'text/html', headers: ISO });
      if (u.hostname === 'www.youtube.com') return r.fulfill({ path: path.join(dist, 'youtube.html'), contentType: 'text/html', headers: ISO });
      return r.abort();
    });
    const page = await ctx.newPage();
    await page.goto(skin === 'twitch' ? 'https://www.twitch.tv/stresschan?hush=1' : 'https://www.youtube.com/live_chat?v=smoke&hush=1');
    await page.evaluate(() => (window as any).__mock.ready);
    await page.evaluate(() => (window as any).__mock.start(100));
    await page.waitForTimeout(3000);
    await page.evaluate(() => (window as any).__hush.reset());
    await page.waitForTimeout(10_000);
    const s: HushStats = await page.evaluate(() => (window as any).__hush.stats());
    const rows = await page.evaluate(() => {
      const list: HTMLElement = (window as any).__mock.list;
      const all = Array.from(list.children);
      const decided = all.filter((r) => r.hasAttribute('data-hush-a')).length;
      return { total: all.length, decided };
    });
    await ctx.close();

    expect(s.msgs).toBeGreaterThan(800);
    // every row on screen has been decided (only the newest frame's rows may be in flight)
    expect(rows.decided).toBeGreaterThanOrEqual(rows.total - 10);
    // budgets
    expect(s.maxSliceMs).toBeLessThan(50); // no long task caused by Hush
    expect(s.msPerMsg).toBeLessThan(0.3); // Hush JS per message
    expect(s.latency.p95).toBeLessThan(300); // hold 250 ms + slack
    // bounded state
    expect(s.sizes.live).toBeLessThanOrEqual(rows.total);
    expect(s.sizes.byKey).toBeLessThanOrEqual(rows.total);
    expect(s.sizes.cache).toBeLessThanOrEqual(5000);
    expect(s.sizes.waveClusters).toBeLessThanOrEqual(4096);
    expect(s.inChat.hidden + s.inChat.folded).toBeGreaterThan(0);
  });
}
