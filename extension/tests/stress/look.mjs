// Screenshots of the mock chats with the real runtime, row stylesheet and bar
// (the stress harness bundle), in both site themes — what the decorations
// look like on Twitch- / YouTube-shaped rows written by the real runtime.
//
//   node tests/stress/look.mjs [--rate=12] [--secs=8] [--skins=twitch,youtube] [--no-build]
//
// Writes tests/stress/.runs/look/<skin>-<theme>[-hover|-pill|-revealed].png (git-ignored).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
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
const RATE = Number(opt.rate ?? 12);
const SECS = Number(opt.secs ?? 8);
const SKINS = String(opt.skins ?? 'twitch,youtube').split(',');
const out = path.join(here, '.runs', 'look');
fs.mkdirSync(out, { recursive: true });
const dist = opt['no-build'] ? path.join(here, '.out') : await buildHarness();
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const browser = await chromium.launch({ channel: 'chromium', args: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
for (const skin of SKINS)
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: skin === 'youtube' ? 400 : 340, height: 720 }, deviceScaleFactor: 2 });
    await ctx.route('**/*', (r) => {
      const u = new URL(r.request().url());
      if (u.hostname === 'static-cdn.jtvnw.net') return r.fulfill({ contentType: 'image/gif', body: GIF });
      const base = path.basename(u.pathname);
      if (['mock.js', 'harness.js', 'corpus.json'].includes(base)) return r.fulfill({ path: path.join(dist, base) });
      if (u.hostname === 'www.twitch.tv') return r.fulfill({ path: path.join(dist, 'twitch.html'), contentType: 'text/html' });
      if (u.hostname === 'www.youtube.com') return r.fulfill({ path: path.join(dist, 'youtube.html'), contentType: 'text/html' });
      return r.abort();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = skin === 'twitch' ? 'https://www.twitch.tv/stresschan' : 'https://www.youtube.com/live_chat?v=stress123';
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}tiho=1&theme=${theme}`);
    await page.evaluate(() => window.__mock.ready);
    await page.evaluate((r) => window.__mock.start(r), RATE);
    await page.waitForTimeout(SECS * 1000);
    await page.evaluate(() => window.__mock.stop());
    await page.waitForTimeout(400); // late verdicts land
    const name = `${skin}-${theme}`;
    const shot = (suffix = '') => page.screenshot({ path: path.join(out, `${name}${suffix}.png`) });
    await shot();

    // reason chip: the lowest shown row that has a reason
    const reasoned = page.locator('[data-tiho-r]:is([data-tiho-a="show"],[data-tiho-a="dim"],[data-tiho-a="highlight"])').last();
    if (await reasoned.count()) {
      await reasoned.hover();
      await page.waitForTimeout(450);
      await shot('-hover');
    }
    // the pill (its row is visibility:hidden, the pill halves are not), then reveal the run
    const pill = page.locator('[data-tiho-run]').last();
    if (await pill.count()) {
      await pill.scrollIntoViewIfNeeded();
      const at = { x: skin === 'youtube' ? 40 : 36, y: 13 };
      await pill.hover({ force: true, position: at });
      await page.waitForTimeout(150);
      await shot('-pill');
      await pill.click({ force: true, position: at });
      await page.waitForTimeout(250);
      await shot('-revealed');
    }
    const summary = await page.evaluate(() => {
      const rows = [...window.__mock.list.children];
      const n = (sel) => rows.filter((r) => r.matches(sel)).length;
      return { rows: rows.length, pills: n('[data-tiho-run]'), collapsed: n('[data-tiho-a="collapse"]'), open: n('[data-tiho-open]'), waveHeads: n('[data-tiho-wh]') };
    });
    console.log(name, JSON.stringify(summary), errors.length ? `errors: ${errors.join(' | ')}` : '');
    await ctx.close();
  }
await browser.close();
console.log(`→ ${path.relative(process.cwd(), out)}`);
