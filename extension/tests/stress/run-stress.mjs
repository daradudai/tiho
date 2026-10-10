// Hush stress benchmark (Playwright, Chromium new-headless).
//
//   node tests/stress/make-corpus.mjs          # once: sample real chat → .corpus/ (git-ignored)
//   node tests/stress/run-stress.mjs [options]  # builds the harness, runs, writes RESULTS.md
//
// Options (all optional):
//   --rates=10,50,100,200   message rates (msg/s) for the A/B runs
//   --secs=6                measured seconds per half-cycle
//   --rounds=6              paused/running cycles per scenario (medians of paired differences)
//   --skins=twitch,youtube  mock skins (markup matches src/platforms adapters)
//   --soak=300              memory soak seconds at 100 msg/s (0 = skip)
//   --cpu=4                 extra A/B run at 100 msg/s with CDP CPU throttling ×N (0 = skip)
//   --bar=10,100            extra A/B runs WITH the in-chat bar at these rates (0 = skip);
//                           all other scenarios measure the runtime alone (bar not mounted)
//   --mode=bundle|extension bundle: runtime bundled into the page (default);
//                           extension: load the built extension (.output-runtime) unpacked
//   --headed                show the browser
//   --out=RESULTS.md
//
// Each scenario is a paired A/B inside one page: Hush paused / running in
// alternating windows, so the per-message cost attributable to Hush is the CDP
// main-thread delta (TaskDuration: script + style + layout + paint) divided by
// messages; the runtime's own JS time is measured inside it too. Every page
// first warms the JIT (5 s at 200 msg/s) so numbers reflect a running chat,
// not the first second after page load.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarness } from './build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, '../..');
const opt = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const s = a.replace(/^--/, '');
    const i = s.indexOf('=');
    return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)];
  }),
);
const RATES = String(opt.rates ?? '10,50,100,200').split(',').map(Number);
const SECS = Number(opt.secs ?? 6);
const ROUNDS = Number(opt.rounds ?? 6);
const SKINS = String(opt.skins ?? 'twitch,youtube').split(',');
const SOAK = Number(opt.soak ?? 300);
const CPU = Number(opt.cpu ?? 4);
const MODE = String(opt.mode ?? 'bundle');
const HEADED = !!opt.headed;
const OUT = path.resolve(here, String(opt.out ?? 'RESULTS.md'));
const WARM_JIT = 5000; // at 200 msg/s
const SETTLE = 2000; // at the target rate
// Software compositing (GPU may be busy with other work → stalled frames) and
// no background throttling (new-headless may treat the window as occluded).
const FLAGS = ['--disable-gpu', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'];
const EXTRA_Q = opt.q ? '&' + String(opt.q) : '';

// Cross-origin isolation gives performance.now() 5 µs resolution (100 µs + jitter
// otherwise, which inflates the runtime's self-timing of short callbacks ~5×).
const ISO = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const dist = await buildHarness();
const runsDir = path.join(here, '.runs');
fs.mkdirSync(runsDir, { recursive: true });

// ───────────────────────── browser / pages ─────────────────────────

let browser = null;
let persistent = null;
async function context() {
  if (MODE === 'extension') {
    const ext = path.join(extRoot, '.output-runtime', 'chrome-mv3');
    if (!fs.existsSync(ext)) throw new Error('build the extension first: HUSH_OUT=.output-runtime npx wxt build');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-stress-'));
    persistent = await chromium.launchPersistentContext(dir, {
      channel: 'chromium',
      headless: !HEADED,
      viewport: { width: 420, height: 900 },
      args: [...FLAGS, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    return persistent;
  }
  browser ??= await chromium.launch({ channel: 'chromium', headless: !HEADED, args: FLAGS });
  return browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 1 });
}

async function route(ctx, skin) {
  await ctx.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.hostname === 'static-cdn.jtvnw.net')
      return r.fulfill({
        status: 200,
        contentType: 'image/gif',
        body: GIF,
        headers: { 'cache-control': 'max-age=3600', 'cross-origin-resource-policy': 'cross-origin' },
      });
    const base = path.basename(u.pathname);
    if (['mock.js', 'harness.js', 'corpus.json'].includes(base)) return r.fulfill({ path: path.join(dist, base) });
    if (skin === 'twitch' && u.hostname === 'www.twitch.tv')
      return r.fulfill({ path: path.join(dist, 'twitch.html'), contentType: 'text/html', headers: ISO });
    if (skin === 'youtube' && u.hostname === 'www.youtube.com' && u.pathname.startsWith('/live_chat'))
      return r.fulfill({ path: path.join(dist, 'youtube.html'), contentType: 'text/html', headers: ISO });
    return r.abort();
  });
}

async function open(skin, hush, cpu = 1, q = '') {
  const ctx = await context();
  await route(ctx, skin);
  const page = MODE === 'extension' ? (ctx.pages()[0] ?? (await ctx.newPage())) : await ctx.newPage();
  // bundle mode: ?hush=1 makes the mock load harness.js; extension mode: the content script injects itself
  const flag = MODE === 'bundle' && hush ? 1 : 0;
  const url =
    skin === 'twitch'
      ? `https://www.twitch.tv/stresschan?hush=${flag}${EXTRA_Q}${q}`
      : `https://www.youtube.com/live_chat?v=stress123&hush=${flag}${EXTRA_Q}${q}`;
  await page.goto(url);
  await page.evaluate(() => window.__mock.ready);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  return { ctx, page, cdp };
}

async function close(ctx) {
  if (MODE === 'extension') {
    await ctx.close();
    persistent = null;
  } else await ctx.close();
}

async function perf(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function heap(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const h = await cdp.send('Runtime.getHeapUsage');
  return h.usedSize;
}

// ───────────────────────── scenarios ─────────────────────────

async function run({ skin, rate, secs, hush, cpu = 1, round = 0 }) {
  const { ctx, page, cdp } = await open(skin, hush, cpu);
  await page.evaluate(() => window.__mock.start(200));
  await page.waitForTimeout(WARM_JIT);
  await page.evaluate((r) => window.__mock.start(r), rate);
  await page.waitForTimeout(SETTLE);
  await page.evaluate(() => {
    window.__mock.resetStats();
    window.__hush?.reset();
  });
  const p0 = await perf(cdp);
  await page.waitForTimeout(secs * 1000);
  const p1 = await perf(cdp);
  const mock = await page.evaluate(() => window.__mock.stats());
  const h = await page.evaluate(() => (window.__hush ? window.__hush.stats() : null));
  const decorated = await page.evaluate(
    () => window.__mock.list.querySelectorAll('[data-hush-c]').length + '/' + window.__mock.list.children.length,
  );
  await page.evaluate(() => window.__mock.stop());
  await close(ctx);
  const d = (k) => ((p1[k] ?? 0) - (p0[k] ?? 0)) * 1000;
  const r = {
    skin,
    rate,
    secs,
    hush,
    cpu,
    sent: mock.sent,
    cdp: { task: d('TaskDuration'), script: d('ScriptDuration'), style: d('RecalcStyleDuration'), layout: d('LayoutDuration') },
    mock,
    runtime: h,
    decorated,
  };
  const tag = `${skin}-${rate}-${hush ? 'hush' : 'base'}${cpu > 1 ? `-cpu${cpu}` : ''}-r${round}`;
  fs.writeFileSync(path.join(runsDir, `${tag}.json`), JSON.stringify(r, null, 2));
  const ours = h ? `ours ${(h.msPerMsg * 1000).toFixed(1)} µs/msg, max slice ${h.maxSliceMs.toFixed(2)} ms, lat p95 ${h.latency.p95.toFixed(0)} ms` : '';
  console.log(
    `${tag.padEnd(26)} sent ${String(mock.sent).padStart(6)}  task ${(r.cdp.task / mock.sent).toFixed(3)} ms/msg  long ${mock.longTasks.n}  >33ms ${mock.frames.over33}  ${ours}`,
  );
  return r;
}

async function soak(secs) {
  const skin = 'twitch';
  const { ctx, page, cdp } = await open(skin, true);
  await page.evaluate(() => window.__mock.start(100));
  const samples = [];
  const t0 = Date.now();
  await page.waitForTimeout(30_000);
  samples.push({ t: 30, heap: await heap(cdp), sizes: await page.evaluate(() => window.__hush?.stats().sizes ?? null) });
  await page.evaluate(() => {
    window.__mock.resetStats();
    window.__hush?.reset();
  });
  const p0 = await perf(cdp);
  while ((Date.now() - t0) / 1000 < secs) {
    await page.waitForTimeout(Math.min(60_000, secs * 1000 - (Date.now() - t0)));
    const t = Math.round((Date.now() - t0) / 1000);
    samples.push({ t, heap: await heap(cdp), sizes: await page.evaluate(() => window.__hush?.stats().sizes ?? null) });
    console.log(`soak t=${t}s heap ${(samples.at(-1).heap / 1048576).toFixed(2)} MB`);
  }
  const p1 = await perf(cdp);
  const mock = await page.evaluate(() => window.__mock.stats());
  const h = await page.evaluate(() => (window.__hush ? window.__hush.stats() : null));
  await page.evaluate(() => window.__mock.stop());
  await close(ctx);
  const d = (k) => ((p1[k] ?? 0) - (p0[k] ?? 0)) * 1000;
  const cdpm = { task: d('TaskDuration'), script: d('ScriptDuration'), style: d('RecalcStyleDuration'), layout: d('LayoutDuration') };
  const r = { secs, samples, mock, runtime: h, cdp: cdpm };
  fs.writeFileSync(path.join(runsDir, 'soak.json'), JSON.stringify(r, null, 2));
  return r;
}

// ───────────────────────── main ─────────────────────────

const med = (a) => {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : NaN;
};
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Paired A/B inside one page: Hush is paused / resumed in place every
 * SECS seconds (order alternates per cycle, 1 s settle after each toggle is
 * discarded), so both halves of a pair see the same page state and nearly
 * the same machine load. Reported deltas are medians of per-cycle differences.
 */
async function paired(skin, rate, cpu = 1, variant = '') {
  const { ctx, page, cdp } = await open(skin, true, cpu, variant === 'with bar' ? '' : '&bar=0');
  await page.evaluate(() => window.__mock.start(200));
  await wait(WARM_JIT);
  await page.evaluate((r) => window.__mock.start(r), rate);
  await wait(SETTLE);
  const base = [];
  const hush = [];
  for (let k = 0; k < ROUNDS; k++) {
    for (const on of k % 2 ? [true, false] : [false, true]) {
      await page.evaluate((v) => window.__hush.setEnabled(v), on);
      await wait(1000);
      await page.evaluate(() => {
        window.__mock.resetStats();
        window.__hush.reset();
      });
      const p0 = await perf(cdp);
      await wait(SECS * 1000);
      const p1 = await perf(cdp);
      const mock = await page.evaluate(() => window.__mock.stats());
      const h = on ? await page.evaluate(() => window.__hush.stats()) : null;
      const d = (key) => ((p1[key] ?? 0) - (p0[key] ?? 0)) * 1000;
      (on ? hush : base).push({
        sent: mock.sent,
        cdp: { task: d('TaskDuration'), script: d('ScriptDuration'), style: d('RecalcStyleDuration'), layout: d('LayoutDuration') },
        mock,
        runtime: h,
      });
    }
  }
  await page.evaluate(() => window.__mock.stop());
  await close(ctx);
  const per = (r, key) => r.cdp[key] / (r.sent || 1);
  const sl = (r) => (r.cdp.style + r.cdp.layout) / (r.sent || 1);
  const diff = (fn) => med(hush.map((h, i) => fn(h) - fn(base[i])));
  const res = {
    skin,
    rate,
    cpu,
    variant,
    msgs: med(hush.map((r) => r.sent)),
    dTask: diff((r) => per(r, 'task')),
    dScript: diff((r) => per(r, 'script')),
    dStyleLayout: diff(sl),
    task: { base: med(base.map((r) => per(r, 'task'))), hush: med(hush.map((r) => per(r, 'task'))) },
    script: { base: med(base.map((r) => per(r, 'script'))), hush: med(hush.map((r) => per(r, 'script'))) },
    styleLayout: { base: med(base.map(sl)), hush: med(hush.map(sl)) },
    js: med(hush.map((r) => r.runtime.msPerMsg * 1000)),
    maxSlice: Math.max(...hush.map((r) => r.runtime.maxSliceMs)),
    longTasks: { base: sum(base.map((r) => r.mock.longTasks.n)), hush: sum(hush.map((r) => r.mock.longTasks.n)) },
    over33: { base: sum(base.map((r) => r.mock.frames.over33)), hush: sum(hush.map((r) => r.mock.frames.over33)) },
    frames: { base: sum(base.map((r) => r.mock.frames.n)), hush: sum(hush.map((r) => r.mock.frames.n)) },
    lat: { p50: med(hush.map((r) => r.runtime.latency.p50)), p95: med(hush.map((r) => r.runtime.latency.p95)) },
    decided: ['rule', 'cache', 'model', 'timeout'].map((key) => sum(hush.map((r) => r.runtime.decided[key]))),
    filtered: med(hush.map((r) => r.runtime.totals.filtered / Math.max(1, r.runtime.totals.seen))),
  };
  const tag = `${skin}-${rate}${cpu > 1 ? `-cpu${cpu}` : ''}${variant ? '-' + variant.replace(/W+/g, '') : ''}`;
  fs.writeFileSync(path.join(runsDir, `paired-${tag}.json`), JSON.stringify({ res, base, hush }, null, 2));
  console.log(
    `${tag.padEnd(16)} Δtask ${res.dTask.toFixed(3)} ms/msg  Δscript ${res.dScript.toFixed(3)}  Δstyle+layout ${res.dStyleLayout.toFixed(3)}  ` +
      `JS ${res.js.toFixed(1)} µs/msg  max slice ${res.maxSlice.toFixed(2)} ms  lat ${res.lat.p50.toFixed(0)}/${res.lat.p95.toFixed(0)} ms  ` +
      `long ${res.longTasks.base}/${res.longTasks.hush}  >33ms ${res.over33.base}/${res.over33.hush}`,
  );
  return res;
}

const results = [];
const started = new Date();
for (const skin of SKINS) {
  for (const rate of skin === 'twitch' ? RATES : RATES.filter((r) => r === 100 || r === 200)) results.push(await paired(skin, rate));
}
for (const r of String(opt.bar ?? '10,100').split(',').map(Number).filter(Boolean)) results.push(await paired('twitch', r, 1, 'with bar'));
if (CPU > 1) results.push(await paired('twitch', 100, CPU));
const soakRes = SOAK > 0 ? await soak(SOAK) : null;
await browser?.close();
fs.writeFileSync(path.join(runsDir, 'summary.json'), JSON.stringify({ results, soak: soakRes }, null, 2));

// ───────────────────────── report ─────────────────────────

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const sign = (x, d = 3) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : '–');
const tick = '`';
const code = (s) => tick + s + tick;
const lines = [];
lines.push('# Hush content-script stress results');
lines.push('');
lines.push(
  `Generated by ${code('node tests/stress/run-stress.mjs')} on ${started.toISOString().slice(0, 16).replace('T', ' ')} UTC — ` +
    `${os.cpus()[0]?.model.trim()} (${os.cpus().length} threads), ${os.platform()} ${os.release()}, ` +
    `Chromium new-headless with software compositing, mode: ${MODE}. ` +
    'The machine was shared with other jobs (model training / inference), so absolute numbers carry noise; ' +
    'the A/B design below is built to cancel most of it.',
);
lines.push('');
lines.push(
  `Mock chat pages (${code('tests/stress/mock/')}) render Twitch- / YouTube-shaped rows (the real adapters extract them) from 20k real chat lines ` +
    `(${code('ml/data/raw')}, sampled to the git-ignored ${code('.corpus/')}), with injected waves (~1 per 15 s, 4–8 s, 12–25 % of traffic) ` +
    'and 3 % same-user repeats, trim to 150 (Twitch) / 250 (YouTube) rows and auto-scroll after every 25 ms batch ' +
    '(a forced layout, like the real sites). The Hush runtime runs with the real adapters, ' +
    'preset *chill* (hold 250 ms) and a simulated inference Port (25 ms + 0.4 ms/item per batch, keyword scores) — ' +
    'the model itself runs in the offscreen document, off the page main thread. ' +
    'The in-chat bar (UI workstream) is mounted only in rows marked *(with bar)* and in the soak, so the runtime and the bar are measured separately.',
);
lines.push('');
lines.push(
  `Method: one page per scenario; JIT warm-up (5 s at 200 msg/s), 2 s settle, then ${ROUNDS} cycles of Hush paused / running ` +
    `(${SECS} s each, order alternating, 1 s after every toggle discarded). Deltas are medians of the per-cycle differences.`,
);
lines.push('');
lines.push('- **Hush JS** — time inside Hush callbacks (observer, frame, timers) per message, self-measured (cross-origin-isolated timers, ~2 µs/slice bias).');
lines.push(`- **Δ main thread** — CDP ${code('TaskDuration')} per message, running − paused: Hush JS *plus* the style/layout/paint work its attributes cause (incl. actually hiding/collapsing the filtered share).`);
lines.push('- **max slice** — longest single Hush callback. Long tasks (> 50 ms) and frames > 33 ms are page-wide counts (paused / running).');
lines.push('- **latency** — row inserted → final verdict attribute written (p50 / p95), all messages incl. model round-trips.');
lines.push('');
lines.push(
  '| skin | msg/s | msgs per window | Hush JS µs/msg | Δ main thread ms/msg | Δ script ms/msg | Δ style+layout ms/msg | max slice ms | long tasks paused / running | frames >33 ms paused / running | latency p50 / p95 ms | filtered | decided rule / cache / model / timeout |',
);
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
const label = (r) => r.skin + (r.cpu > 1 ? ` (CPU ×${r.cpu})` : '') + (r.variant ? ` (${r.variant})` : '');
for (const r of results) {
  lines.push(
    `| ${label(r)} | ${r.rate} | ${r.msgs} | ${f(r.js, 1)} | ${sign(r.dTask)} | ${sign(r.dScript)} | ${sign(r.dStyleLayout)} | ` +
      `${f(r.maxSlice)} | ${r.longTasks.base} / ${r.longTasks.hush} | ${r.over33.base} / ${r.over33.hush} | ${f(r.lat.p50, 0)} / ${f(r.lat.p95, 0)} | ` +
      `${f(r.filtered * 100, 0)} % | ${r.decided.join(' / ')} |`,
  );
}
lines.push('');
lines.push('Absolute medians (ms per message, whole page main thread) for reference:');
lines.push('');
lines.push('| skin | msg/s | task paused → running | script paused → running | style+layout paused → running |');
lines.push('|---|---|---|---|---|');
for (const r of results)
  lines.push(
    `| ${label(r)} | ${r.rate} | ${f(r.task.base, 3)} → ${f(r.task.hush, 3)} | ${f(r.script.base, 3)} → ${f(r.script.hush, 3)} | ` +
      `${f(r.styleLayout.base, 3)} → ${f(r.styleLayout.hush, 3)} |`,
  );
lines.push('');
if (soakRes) {
  const s0 = soakRes.samples[0];
  const s1 = soakRes.samples.at(-1);
  const mb = (b) => (b / 1048576).toFixed(2);
  const n = soakRes.mock.sent || 1;
  lines.push(`## Memory / steady state — Twitch skin, 100 msg/s, ${soakRes.secs} s (${soakRes.mock.sent} msgs measured after the 30 s mark)`);
  lines.push('');
  lines.push('JS heap after a forced GC (whole page: mock chat + Hush runtime + bar) and Hush structure sizes:');
  lines.push('');
  lines.push('| t (s) | heap MB | live rows | byKey | wave clusters | score cache | in flight | held |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const s of soakRes.samples) {
    const z = s.sizes ?? {};
    lines.push(`| ${s.t} | ${mb(s.heap)} | ${z.live ?? '–'} | ${z.byKey ?? '–'} | ${z.waveClusters ?? '–'} | ${z.cache ?? '–'} | ${z.inflight ?? '–'} | ${z.held ?? '–'} |`);
  }
  lines.push('');
  lines.push(
    `Heap ${mb(s0.heap)} → ${mb(s1.heap)} MB (${sign((s1.heap - s0.heap) / 1048576, 2)} MB over ${s1.t - s0.t} s). ` +
      `Steady state (JIT warm): Hush JS ${f(soakRes.runtime?.msPerMsg * 1000, 1)} µs/msg; page main thread ${f(soakRes.cdp.task / n, 3)} ms/msg in total ` +
      `(script ${f(soakRes.cdp.script / n, 3)}, style+layout ${f((soakRes.cdp.style + soakRes.cdp.layout) / n, 3)}); ` +
      `max Hush slice ${f(soakRes.runtime?.maxSliceMs)} ms; latency p50/p95 ${f(soakRes.runtime?.latency.p50, 0)}/${f(soakRes.runtime?.latency.p95, 0)} ms; ` +
      `page long tasks ${soakRes.mock.longTasks.n}; frames > 33 ms ${soakRes.mock.frames.over33} of ${soakRes.mock.frames.n}.`,
  );
  lines.push('');
}
lines.push('Targets: < 0.3 ms main-thread per message attributable to Hush; no long task > 50 ms caused by Hush (max slice).');
lines.push('');
lines.push(`Raw per-run JSON: ${code('tests/stress/.runs/')} (git-ignored).`);
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`\nwrote ${OUT}`);
