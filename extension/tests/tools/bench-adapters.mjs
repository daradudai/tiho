// Real-browser micro-benchmark of adapter.extract() on the saved fixtures.
//   node tests/tools/bench-adapters.mjs
// Bundles src/platforms with rolldown, serves each fixture at its real URL in
// headless Chromium and times extract() per row (fresh, un-memoized nodes).
import { chromium } from '@playwright/test';
import { build } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';

const out = await build({
  input: path.resolve('src/platforms/index.ts'),
  output: { format: 'iife', name: 'HushPlatforms' },
  write: false,
  logLevel: 'silent',
});
const bundle = out.output[0].code;

const FIX = [
  ['youtube/popout.html', 'https://www.youtube.com/live_chat?is_popout=1&v=dQw4w9WgXcQ'],
  ['youtube/special-dark.html', 'https://www.youtube.com/live_chat?v=dQw4w9WgXcQ'],
  ['twitch/channel-page.html', 'https://www.twitch.tv/jinnytty'],
  ['twitch/popout-dark.html', 'https://www.twitch.tv/popout/gorgc/chat'],
  ['twitch/special.html', 'https://www.twitch.tv/popout/gorgc/chat'],
  ['twitch/seventv.html', 'https://www.twitch.tv/gorgc'],
  ['kick/channel-page.html', 'https://kick.com/absi'],
  ['kick/popout.html', 'https://kick.com/popout/zengibre/chat'],
  ['kick/special.html', 'https://kick.com/popout/absi/chat'],
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const results = [];
for (const [file, url] of FIX) {
  const html = fs.readFileSync(path.resolve('tests/fixtures', file), 'utf8');
  await page.unroute('**/*').catch(() => {});
  await page.route('**/*', (r) =>
    r.request().url() === url ? r.fulfill({ status: 200, contentType: 'text/html', body: html }) : r.abort(),
  );
  await page.goto(url);
  await page.addScriptTag({ content: bundle });
  const res = await page.evaluate(() => {
    const P = window.HushPlatforms;
    const a = P.detectAdapter(location);
    const list = a.findChatList(document);
    const base = [...list.children].filter((r) => r.matches(a.rowSelector));
    // replicate rows so every timed extract sees a fresh node (no key memo)
    const COPIES = 60;
    const frag = document.createDocumentFragment();
    const nodes = [];
    for (let c = 0; c < COPIES; c++)
      for (const r of base) {
        const n = r.cloneNode(true);
        nodes.push(n);
        frag.appendChild(n);
      }
    list.appendChild(frag);
    // warm up on the originals
    for (let i = 0; i < 50; i++) for (const r of base) a.extract(r);
    let msgs = 0;
    const t0 = performance.now();
    for (const n of nodes) if (a.extract(n)) msgs++;
    const dt = performance.now() - t0;
    return { platform: a.platform, rows: nodes.length, msgs, usPerRow: (dt * 1000) / nodes.length };
  });
  results.push({ file, ...res, usPerRow: +res.usPerRow.toFixed(2) });
}
console.table(results);
await browser.close();
