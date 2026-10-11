// Build the showcase and capture screenshots of every UI surface.
//
//   node tests/ui/shoot.mjs            # all shots
//   node tests/ui/shoot.mjs chat-      # only shots whose name starts with "chat-"
//   node tests/ui/shoot.mjs --no-build
//   TIHO_SHOWCASE_OUT=tests/ui/.dist-mine node tests/ui/shoot.mjs   # build into another folder (parallel runs)
import { chromium } from '@playwright/test';
import { build } from 'vite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.TIHO_SHOWCASE_OUT ? path.resolve(process.env.TIHO_SHOWCASE_OUT) : path.join(here, '.dist');
const outDir = path.join(here, 'screenshots');
const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--'));
fs.mkdirSync(outDir, { recursive: true });

if (!args.includes('--no-build')) {
  await build({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'warn', build: { outDir: dist } });
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
// In-chat bar and rows, in both modes (mode=basic is the default; every chat shot names its mode).
const openBar = async (pg) => {
  await pg.locator('.hb-mark').click();
  await pg.waitForTimeout(250);
};
for (const theme of ['dark', 'light']) {
  for (const [p, w] of [['twitch', 340], ['youtube', 400], ['kick', 340]]) {
    for (const mode of ['basic', 'advanced']) {
      chat(`chat-${p}-${theme}-${mode}`, `platform=${p}&theme=${theme}&mode=${mode}`, w);
      chat(`chat-${p}-${theme}-${mode}-open`, `platform=${p}&theme=${theme}&mode=${mode}`, w, 720, openBar);
    }
    // Show hidden (tags in plain words) and Solo (every row of one category, tagged): the floats must not overlap rows
    chat(`chat-${p}-${theme}-basic-peek`, `platform=${p}&theme=${theme}&mode=basic&peek`, w);
    chat(`chat-${p}-${theme}-advanced-peek`, `platform=${p}&theme=${theme}&mode=advanced&peek`, w);
    chat(`chat-${p}-${theme}-advanced-solo`, `platform=${p}&theme=${theme}&mode=advanced&solo=spam`, w);
    // Reason chip on hover (Advanced only: the last question, right under a long wave head)
    chat(`chat-${p}-${theme}-advanced-hover`, `platform=${p}&theme=${theme}&mode=advanced`, w, 640, async (pg) => {
      await pg.locator('.bd-row[data-tiho-c="question"]').last().hover();
      await pg.waitForTimeout(500);
    });
  }
  chat(`chat-twitch-${theme}-basic-off`, `platform=twitch&theme=${theme}&mode=basic&off`, 340, 300);
  chat(`chat-twitch-${theme}-advanced-solo-open`, `platform=twitch&theme=${theme}&mode=advanced&solo=spam`, 340, 720, openBar);
  chat(`chat-twitch-${theme}-advanced-chipmenu`, `platform=twitch&theme=${theme}&mode=advanced`, 340, 640, async (pg) => {
    await pg.locator('.hb-chip[data-c="spam"]').click({ button: 'right' });
    await pg.waitForTimeout(200);
  });
}
chat('chat-twitch-dark-basic-siteoff', 'platform=twitch&theme=dark&mode=basic&siteoff', 340, 300);
chat('chat-twitch-dark-basic-narrow', 'platform=twitch&theme=dark&mode=basic&w=280', 280, 300);
chat('chat-twitch-dark-basic-loading-open', 'platform=twitch&theme=dark&mode=basic&model=downloading&empty', 340, 640, openBar);
chat('chat-twitch-light-basic-error-open', 'platform=twitch&theme=light&mode=basic&model=error', 340, 640, openBar);
chat('chat-twitch-dark-basic-custom-open', 'platform=twitch&theme=dark&mode=basic&preset=raw', 340, 640, openBar);
chat('chat-twitch-dark-basic-tooltip', 'platform=twitch&theme=dark&mode=basic', 340, 400, async (pg) => {
  await pg.locator('.hb-level .hb-seg-btn').nth(2).hover();
  await pg.waitForTimeout(450);
});
chat('chat-twitch-dark-advanced-presetmenu', 'platform=twitch&theme=dark&mode=advanced', 340, 640, async (pg) => {
  await pg.locator('.hb-preset-pill').click();
  await pg.waitForTimeout(200);
});
chat('chat-twitch-dark-advanced-tooltip', 'platform=twitch&theme=dark&mode=advanced', 340, 400, async (pg) => {
  await pg.locator('.hb-chip[data-c="spam"]').hover();
  await pg.waitForTimeout(450);
});
// The chips that do not fit at 340 px, behind "+N"
chat('chat-twitch-dark-advanced-more', 'platform=twitch&theme=dark&mode=advanced', 340, 400, async (pg) => {
  await pg.locator('.hb-more').hover();
  await pg.waitForTimeout(450);
});
chat('chat-twitch-dark-advanced-off', 'platform=twitch&theme=dark&mode=advanced&off', 340, 300);
chat('chat-twitch-dark-advanced-loading', 'platform=twitch&theme=dark&mode=advanced&model=downloading&empty', 340, 300);
chat('chat-twitch-light-basic-pill', 'platform=twitch&theme=light&mode=basic', 340, 640, async (pg) => {
  await pg.locator('.bd-row[data-tiho-run]').last().hover({ force: true, position: { x: 50, y: 13 } }); // the row itself is visibility:hidden, its pill parts are not
  await pg.waitForTimeout(200);
});
chat('chat-twitch-dark-advanced-revealed', 'platform=twitch&theme=dark&mode=advanced', 340, 640, async (pg) => {
  await pg.locator('.bd-row[data-tiho-run]').last().click({ force: true, position: { x: 50, y: 13 } });
  await pg.waitForTimeout(200);
  await pg.locator('.bd-row[data-tiho-open]').last().hover();
  await pg.waitForTimeout(500);
});
// Solo and Show hidden mark rows with an edge only; the tag shows on hover, out of flow
for (const [p, w] of [['twitch', 340], ['kick', 340]])
  for (const [view, sel] of [['solo=spam', '.bd-row[data-tiho-c="spam"]'], ['peek', '.bd-row[data-tiho-a="hide"]']])
    chat(`chat-${p}-dark-advanced-${view.split('=')[0]}-hover`, `platform=${p}&theme=dark&mode=advanced&${view}`, w, 640, async (pg) => {
      await pg.locator(sel).nth(2).hover();
      await pg.waitForTimeout(500);
    });
// The bar alone at a narrow, the default and a wide chat column: one 36 px row, nothing clipped
for (const theme of ['dark', 'light'])
  for (const w of [300, 340, 500])
    for (const [name, qs] of [
      ['basic', 'mode=basic'],
      ['basic-peek', 'mode=basic&peek'],
      ['advanced', 'mode=advanced'],
      ['advanced-peek', 'mode=advanced&peek'],
      ['advanced-solo', 'mode=advanced&solo=question'],
    ])
      chat(`bar-twitch-${theme}-${w}-${name}`, `platform=twitch&theme=${theme}&${qs}&w=${w}`, w, 90);
chat('chat-twitch-dark-advanced-wide', 'platform=twitch&theme=dark&mode=advanced&w=560', 560, 480);
chat('chat-youtube-light-basic-wide', 'platform=youtube&theme=light&mode=basic&w=560', 560, 480);
chat('chat-kick-dark-advanced-raw', 'platform=kick&theme=dark&mode=advanced&preset=raw', 340, 640);
chat('chat-twitch-light-basic-quiet', 'platform=twitch&theme=light&mode=basic&preset=focus', 340, 640);

// Extension pages. Basic is the default mode; the Advanced popup and side panel tabs carry mode=advanced.
const popup = (name, qs) => shots.push({ name, url: `${base}?view=popup&${qs}`, w: 360, h: 600, full: true });
const panel = (name, qs, act) => shots.push({ name, url: `${base}?view=sidepanel&${qs}`, w: 400, h: 900, act });
for (const theme of ['dark', 'light']) {
  popup(`popup-basic-${theme}`, `theme=${theme}`);
  popup(`popup-advanced-${theme}`, `theme=${theme}&mode=advanced`);
  panel(`sidepanel-basic-${theme}`, `theme=${theme}`);
  for (const tab of ['live', 'inbox', 'log', 'rules', 'settings'])
    panel(`sidepanel-${tab}-${theme}`, `theme=${theme}&mode=advanced&tab=${tab}${tab === 'rules' ? '&engine' : ''}`);
  shots.push({ name: `onboarding-${theme}`, url: `${base}?view=onboarding&theme=${theme}&downloading`, w: 1280, h: 900, full: true, wait: 1600 });
}
popup('popup-basic-loading-dark', 'theme=dark&model=downloading');
popup('popup-basic-error-light', 'theme=light&model=error');
popup('popup-basic-custom-dark', 'theme=dark&preset=custom');
popup('popup-basic-off-light', 'theme=light&off');
popup('popup-basic-nochat-dark', 'theme=dark&nochat');
popup('popup-advanced-off-dark', 'theme=dark&mode=advanced&off');
panel('sidepanel-basic-loading-light', 'theme=light&model=loading');
panel('sidepanel-live-solo-dark', 'theme=dark&mode=advanced&tab=live&solo=spam', async (pg) => {
  await pg.locator('.sp-solo').scrollIntoViewIfNeeded();
  await pg.waitForTimeout(150);
});
panel('sidepanel-live-peek-light', 'theme=light&mode=advanced&tab=live&peek');
// The narrowest side panel (Chrome's minimum): the hero's words stay on one line
shots.push({ name: 'sidepanel-live-narrow-dark', url: `${base}?view=sidepanel&theme=dark&mode=advanced&tab=live&w=320`, w: 320, h: 640 });
panel('sidepanel-log-only-dark', 'theme=dark&mode=advanced&tab=log', async (pg) => {
  await pg.locator('.sp-filter[data-c="scam"]').click();
  await pg.waitForTimeout(150);
});

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
