// Quick look at Tiho on a real live chat: load the built extension, open a
// channel, wait, screenshot the chat and print what Tiho decided.
//
//   node tests/tools/live-look.mjs <url> [seconds] [outPrefix]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] ?? 'https://www.twitch.tv/directory/all';
const secs = Number(process.argv[3] ?? 40);
const out = process.argv[4] ?? 'live';
const ext = path.resolve(process.env.TIHO_EXT_DIR ?? '.output-bench/chrome-mv3');
const shots = path.resolve('tests/tools/.shots');
fs.mkdirSync(shots, { recursive: true });

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tiho-look-')), {
  headless: false,
  viewport: { width: 1600, height: 950 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
// close the onboarding tab the extension opens on install
await new Promise((r) => setTimeout(r, 1500));
for (const p of ctx.pages()) if (p.url().includes('onboarding')) await p.screenshot({ path: path.join(shots, `${out}-onboarding.png`) }).catch(() => {});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(secs * 1000);

const frames = [page, ...page.frames()];
let report = null;
for (const f of frames) {
  report = await f.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-tiho-c]')];
    if (!rows.length) return null;
    const by = {};
    const act = {};
    for (const r of rows) {
      by[r.dataset.tihoC] = (by[r.dataset.tihoC] || 0) + 1;
      act[r.dataset.tihoA] = (act[r.dataset.tihoA] || 0) + 1;
    }
    const sample = rows
      .filter((r) => r.dataset.tihoA !== 'show')
      .slice(-25)
      .map((r) => `${r.dataset.tihoA}/${r.dataset.tihoC} (${r.dataset.tihoR || ''}) :: ${(r.textContent || '').replace(/\s+/g, ' ').slice(0, 100)}`);
    return { rows: rows.length, by, act, bar: !!document.querySelector('tiho-bar'), sample };
  }).catch(() => null);
  if (report) break;
}
console.log(JSON.stringify(report, null, 1));
await page.screenshot({ path: path.join(shots, `${out}.png`) });
await ctx.close();
