// Build the showcase and capture screenshots of every UI surface.
//
//   node tests/ui/shoot.mjs            # all shots
//   node tests/ui/shoot.mjs chat-      # only shots whose name starts with "chat-"
//   node tests/ui/shoot.mjs --no-build
import { chromium } from '@playwright/test';
import { build } from 'vite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '.dist');
const outDir = path.join(here, 'screenshots');
const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--'));
fs.mkdirSync(outDir, { recursive: true });

if (!args.includes('--no-build')) {
  await build({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'warn' });
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const f = path.join(dist, decodeURIComponent(u.pathname === '/' ? '/showcase.html' : u.pathname));
  if (!f.startsWith(dist) || !fs.existsSync(f)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/showcase.html`;

const shots = [];
const chat = (name, qs, w, h = 640, act) => shots.push({ name, url: `${base}?view=chat&${qs}`, w, h, act });
for (const theme of ['dark', 'light']) {
  for (const [p, w] of [['twitch', 340], ['youtube', 400], ['kick', 340]]) {
    chat(`chat-${p}-${theme}`, `platform=${p}&theme=${theme}`, w);
    chat(`chat-${p}-${theme}-open`, `platform=${p}&theme=${theme}`, w, 720, async (pg) => {
      await pg.locator('.hb-mark').click();
      await pg.waitForTimeout(250);
    });
  }
}
chat('chat-twitch-dark-chipmenu', 'platform=twitch&theme=dark', 340, 640, async (pg) => {
  await pg.locator('.hb-chip[data-c="spam"]').click({ button: 'right' });
  await pg.waitForTimeout(200);
});
chat('chat-twitch-dark-presetmenu', 'platform=twitch&theme=dark', 340, 640, async (pg) => {
  await pg.locator('.hb-preset-pill').click();
  await pg.waitForTimeout(200);
});
chat('chat-twitch-dark-tooltip', 'platform=twitch&theme=dark', 340, 640, async (pg) => {
  await pg.locator('.hb-chip[data-c="toxic"]').hover();
  await pg.waitForTimeout(450);
});
chat('chat-twitch-dark-hover', 'platform=twitch&theme=dark', 340, 640, async (pg) => {
  await pg.locator('.bd-row[data-hush-c="question"]').first().hover();
  await pg.waitForTimeout(500);
});
chat('chat-youtube-light-hover', 'platform=youtube&theme=light', 400, 640, async (pg) => {
  await pg.locator('.bd-row[data-hush-c="negative"]').first().hover();
  await pg.waitForTimeout(500);
});
chat('chat-twitch-dark-wide', 'platform=twitch&theme=dark&w=560', 560, 480);
chat('chat-youtube-dark-wide-light', 'platform=youtube&theme=light&w=560', 560, 480);
chat('chat-twitch-dark-loading', 'platform=twitch&theme=dark&model=downloading&empty', 340, 300);
chat('chat-twitch-dark-off', 'platform=twitch&theme=dark&off', 340, 300);
chat('chat-kick-dark-raw', 'platform=kick&theme=dark&preset=raw', 340, 640);
chat('chat-twitch-light-focus', 'platform=twitch&theme=light&preset=focus', 340, 640);

for (const theme of ['dark', 'light']) {
  shots.push({ name: `popup-${theme}`, url: `${base}?view=popup&theme=${theme}`, w: 360, h: 600, full: true });
  for (const tab of ['live', 'inbox', 'log', 'rules', 'settings'])
    shots.push({ name: `sidepanel-${tab}-${theme}`, url: `${base}?view=sidepanel&theme=${theme}&tab=${tab}${tab === 'rules' ? '&engine' : ''}`, w: 400, h: 900 });
  shots.push({ name: `onboarding-${theme}`, url: `${base}?view=onboarding&theme=${theme}&downloading`, w: 1280, h: 900, full: true, wait: 1600 });
}
shots.push({ name: 'popup-nochat-dark', url: `${base}?view=popup&theme=dark&nochat&model=downloading`, w: 360, h: 600, full: true });

const browser = await chromium.launch();
let n = 0;
for (const s of shots) {
  if (filter && !s.name.startsWith(filter)) continue;
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: s.name.startsWith('onboarding') ? 1 : 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(s.url, { waitUntil: 'networkidle' }).catch(() => page.goto(s.url));
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(s.wait ?? 350);
  if (s.act) await s.act(page);
  await page.screenshot({ path: path.join(outDir, `${s.name}.png`), fullPage: !!s.full });
  if (errors.length) console.log(`  ! ${s.name}:`, errors.filter((e) => !e.includes('fonts.g')).slice(0, 3).join(' | '));
  await ctx.close();
  n++;
}
await browser.close();
server.close();
console.log(`${n} screenshots → ${path.relative(process.cwd(), outDir)}`);
