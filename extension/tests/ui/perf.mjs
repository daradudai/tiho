// Bar under load: fake store written every frame at N msg/s (showcase ?live).
// Reports long tasks, frame pacing and main-thread time spent in the bar.
//   node tests/ui/perf.mjs [mps=150] [--no-build]
import { chromium } from '@playwright/test';
import { build } from 'vite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '.dist');
const mps = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 150);
if (!process.argv.includes('--no-build')) await build({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'warn' });
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const f = path.join(dist, u.pathname === '/' ? '/showcase.html' : u.pathname);
  if (!fs.existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/showcase.html?view=chat&platform=twitch&theme=dark&live&mps=${mps}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 340, height: 720 } });
await page.goto(url);
await page.waitForTimeout(800);
for (const open of [false, true]) {
  if (open) {
    await page.locator('.hb-mark').click();
    await page.waitForTimeout(300);
  }
  const r = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const long = [];
        const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration)));
        po.observe({ type: 'longtask', buffered: false });
        const frames = [];
        let last = performance.now();
        const t0 = last;
        // count DOM mutations inside the bar's shadow root (≈ render work)
        const host = document.querySelector('hush-bar');
        let muts = 0;
        const mo = new MutationObserver((l) => (muts += l.length));
        mo.observe(host.shadowRoot, { subtree: true, childList: true, characterData: true, attributes: true });
        const tick = (t) => {
          frames.push(t - last);
          last = t;
          if (t - t0 < 5000) requestAnimationFrame(tick);
          else {
            po.disconnect();
            mo.disconnect();
            frames.sort((a, b) => a - b);
            resolve({
              frames: frames.length,
              p50: frames[Math.floor(frames.length * 0.5)].toFixed(1),
              p99: frames[Math.floor(frames.length * 0.99)].toFixed(1),
              longTasks: long.length,
              mutationsPerSec: Math.round(muts / 5),
              seen: window.__store.totals.peek().seen,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log(`${mps} msg/s, panel ${open ? 'open' : 'closed'}:`, r);
}
await browser.close();
server.close();
