// CPU profile of the Hush runtime inside the mock chat (unminified bundle).
//   node tests/stress/profile.mjs [--rate=100] [--secs=8] [--skin=twitch] [--q=bar=0]
// Prints the top self-time functions; writes .runs/profile.cpuprofile (open in DevTools).
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
const rate = Number(opt.rate ?? 100);
const secs = Number(opt.secs ?? 8);
const skin = String(opt.skin ?? 'twitch');
const q = opt.q ? '&' + opt.q : '';
const dist = await buildHarness({ minify: false });
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const browser = await chromium.launch({
  channel: 'chromium',
  headless: true,
  args: ['--disable-gpu', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'],
});
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
await ctx.route('**/*', (r) => {
  const u = new URL(r.request().url());
  if (u.hostname === 'static-cdn.jtvnw.net')
    return r.fulfill({ contentType: 'image/gif', body: GIF, headers: { 'cross-origin-resource-policy': 'cross-origin' } });
  const base = path.basename(u.pathname);
  if (['mock.js', 'harness.js', 'corpus.json'].includes(base)) return r.fulfill({ path: path.join(dist, base) });
  const iso = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
  if (u.hostname === 'www.twitch.tv') return r.fulfill({ path: path.join(dist, 'twitch.html'), contentType: 'text/html', headers: iso });
  if (u.hostname === 'www.youtube.com') return r.fulfill({ path: path.join(dist, 'youtube.html'), contentType: 'text/html', headers: iso });
  return r.abort();
});
const page = await ctx.newPage();
await page.goto(skin === 'twitch' ? `https://www.twitch.tv/stresschan?hush=1${q}` : `https://www.youtube.com/live_chat?v=x&hush=1${q}`);
await page.evaluate(() => window.__mock.ready);
const cdp = await ctx.newCDPSession(page);
await page.evaluate((r) => window.__mock.start(r), rate);
await page.waitForTimeout(2000);
await page.evaluate(() => window.__hush.reset());
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');
await page.waitForTimeout(secs * 1000);
const { profile } = await cdp.send('Profiler.stop');
const st = await page.evaluate(() => window.__hush.stats());
await browser.close();

fs.mkdirSync(path.join(here, '.runs'), { recursive: true });
fs.writeFileSync(path.join(here, '.runs', 'profile.cpuprofile'), JSON.stringify(profile));

// self time per function
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) {
  const n = byId.get(profile.samples[i]);
  const cf = n.callFrame;
  const k = `${cf.functionName || '(anon)'} ${path.basename(cf.url || '')}:${cf.lineNumber + 1}`;
  self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
}
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
console.log(`msgs ${st.msgs}, hush JS ${(st.msPerMsg * 1000).toFixed(1)} µs/msg`);
for (const [k, ms] of top) console.log(`${ms.toFixed(1).padStart(8)} ms  ${(((ms / st.msgs) * 1000) || 0).toFixed(1).padStart(6)} µs/msg  ${k}`);
