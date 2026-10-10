// Dev tool: list currently-live big channels per platform.
//   node tests/tools/find-live.mjs twitch|kick|youtube
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const which = process.argv[2];
const ctx = await chromium.launchPersistentContext(
  fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'hush-find-')),
  { channel: 'chrome', headless: !process.argv.includes('--headed'), locale: 'en-US', args: ['--disable-blink-features=AutomationControlled', '--mute-audio'] },
);
const page = ctx.pages()[0] ?? (await ctx.newPage());
const urls = {
  twitch: 'https://www.twitch.tv/directory/all',
  kick: 'https://kick.com/browse',
  youtube: 'https://www.youtube.com/results?search_query=live&sp=EgJAAQ%253D%253D',
};
await page.goto(process.argv[3]?.startsWith('http') ? process.argv[3] : urls[which], { waitUntil: 'domcontentloaded' });
for (const sel of ['button:has-text("Accept all")', 'button:has-text("Accept")']) {
  try { await page.locator(sel).first().click({ timeout: 2500 }); } catch {}
}
await page.waitForTimeout(8000);
const links = await page.evaluate((which) => {
  const out = new Set();
  const sel = which === 'youtube' ? 'a#video-title, a#thumbnail' : 'a[href]';
  for (const a of document.querySelectorAll(sel)) {
    const h = a.getAttribute('href') || '';
    const t = (a.textContent || a.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (which === 'youtube' && h.includes('/watch')) out.add(h + ' | ' + t);
    if (which === 'twitch' && /^\/[a-z0-9_]+$/i.test(h) && !/^\/(directory|search|p|settings|downloads|jobs|turbo)$/.test(h)) out.add(h + ' | ' + t);
    if (which === 'kick' && /^\/[a-z0-9_-]+$/i.test(h) && !/^\/(browse|categories|search|following|dashboard)$/.test(h)) out.add(h + ' | ' + t);
  }
  return [...out].slice(0, 40);
}, which);
console.log(links.join('\n'));
if (!links.length) await page.screenshot({ path: path.join(process.env.TEMP, `find-${which}.png`) });
await ctx.close();
