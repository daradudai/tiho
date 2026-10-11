// In-browser inference benchmark (Playwright + unpacked extension, headed Chromium).
//
//   node tests/bench/make-sample.mjs                      # once: real chat texts → .data/ (git-ignored)
//   TIHO_OUT=.output-inference TIHO_BENCH=1 TIHO_MODEL_VARIANTS=all npx wxt build
//   node tests/bench/bench.mjs [--quick] [--only webgpu|wasm] [--variants q8f16,q8] [--wasm-best uint8] [--pipeline-only]
//
// Writes tests/bench/.data/results-<time>.json and prints a markdown summary.
// Uses Playwright's bundled Chromium (branded Chrome ignores --load-extension).

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const extDir = path.resolve(root, process.env.TIHO_EXT_DIR ?? '.output-inference/chrome-mv3');
const dataDir = path.join(here, '.data');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const quick = flag('--quick');
const only = opt('--only', '');
const variantFilter = opt('--variants', '');

if (!fs.existsSync(path.join(extDir, 'manifest.json'))) {
  console.error(`No build at ${extDir}. Run: TIHO_OUT=.output-inference TIHO_BENCH=1 TIHO_MODEL_VARIANTS=all npx wxt build`);
  process.exit(1);
}
const samplePath = path.join(dataDir, 'chat_sample.json');
if (!fs.existsSync(samplePath)) {
  console.error('No sample texts. Run: node tests/bench/make-sample.mjs');
  process.exit(1);
}
const texts = JSON.parse(fs.readFileSync(samplePath, 'utf8')).map((r) => r.text);
const modelFiles = JSON.parse(fs.readFileSync(path.join(extDir, 'models/tiho-lite/config.json'), 'utf8')).tiho.files;
const available = Object.keys(modelFiles).filter((v) => fs.existsSync(path.join(extDir, 'models/tiho-lite', modelFiles[v])));

/** Private bytes of every process of this browser binary (Windows), MB. */
function browserMemMB(exe) {
  if (os.platform() !== 'win32') return null;
  try {
    const ps = `$s=(Get-Process | Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' } | Measure-Object -Property PrivateMemorySize64 -Sum).Sum; [math]::Round($s/1MB)`;
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim());
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Samples browserMemMB every ~2 s (async) and keeps the peak. */
function peakSampler(exe) {
  let peak = 0;
  let stop = false;
  const ps = `$s=(Get-Process | Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' } | Measure-Object -Property PrivateMemorySize64 -Sum).Sum; [math]::Round($s/1MB)`;
  const loop = async () => {
    while (!stop && os.platform() === 'win32') {
      const v = await new Promise((r) => execFile('powershell', ['-NoProfile', '-Command', ps], (e, out) => r(e ? 0 : Number(out.trim()))));
      peak = Math.max(peak, v || 0);
      await sleep(1500);
    }
  };
  const done = loop();
  return async () => {
    stop = true;
    await done;
    return peak || null;
  };
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiho-bench-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 900, height: 700 },
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,WebGPUDeveloperFeatures',
      '--no-first-run',
    ],
  });
  const exe = chromium.executablePath();
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker', { timeout: 30_000 });
  const extId = new URL(sw.url()).host;
  // close the onboarding tab opened on install
  await sleep(1000);
  for (const p of ctx.pages()) if (p.url().includes('onboarding')) await p.close();

  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/error|warn|fail/i.test(t) && !t.startsWith('[bench]')) console.log('  [page]', t.slice(0, 300));
  });
  await page.goto(`chrome-extension://${extId}/bench.html`);
  await page.waitForFunction(() => !!window.tihoBench);
  const env = await page.evaluate(() => window.tihoBench.env());
  console.log('env', JSON.stringify(env));

  const memIdle = browserMemMB(exe);
  const results = { date: new Date().toISOString(), env, cpu: os.cpus()[0]?.model, cores: os.cpus().length, memIdleMB: memIdle, runs: [] };

  const batchSizes = [1, 8, 32, 64];
  const configs = [];
  const gpuVariants = ['q8f16', 'q8', 'fp16', 'q4f16'];
  const wasmVariants = ['q8', 'q8a4', 'uint8', 'q4'];
  const keep = (v) => available.includes(v) && (!variantFilter || variantFilter.split(',').includes(v));
  if (only !== 'wasm' && env.webgpu.ok) for (const v of gpuVariants) if (keep(v)) configs.push({ device: 'webgpu', variant: v });
  if (only !== 'webgpu') {
    for (const v of wasmVariants) if (keep(v)) configs.push({ device: 'wasm', variant: v, threads: env.crossOriginIsolated ? 4 : 1 });
    if (env.crossOriginIsolated) {
      const best = opt('--wasm-best', 'uint8');
      if (keep(best)) {
        configs.push({ device: 'wasm', variant: best, threads: 1 });
        configs.push({ device: 'wasm', variant: best, threads: 8 });
      }
    }
  }

  if (flag('--pipeline-only')) configs.length = 0;
  for (const c of configs) {
    const gpu = c.device === 'webgpu';
    const cfg = {
      ...c,
      texts,
      batchSizes,
      itemsPerSize: quick ? (gpu ? 128 : 64) : gpu ? 768 : 192,
      stream: { rate: gpu ? 150 : 60, seconds: quick ? 3 : 6, maxWaitMs: 12 },
    };
    console.log(`\n== ${c.device} ${c.variant}${c.threads ? ` threads=${c.threads}` : ''}`);
    const before = browserMemMB(exe);
    const stopPeak = peakSampler(exe);
    const r = await page.evaluate((cfg) => window.tihoBench.run(cfg), cfg);
    r.memPeakMB = await stopPeak();
    r.memBeforeMB = before;
    r.memAfterRunMB = browserMemMB(exe); // measured after the worker terminated → shows leaks only
    console.log(JSON.stringify(r));
    results.runs.push(r);
    await sleep(500);
  }

  // Peak memory of the production path: offscreen doc via background (default device choice).
  console.log('\n== pipeline (Port → background → offscreen → worker), default backend');
  const memBeforePipe = browserMemMB(exe);
  const pipe = await page.evaluate((cfg) => window.tihoBench.pipeline(cfg), { texts, batches: quick ? 30 : 120, batchSize: 16 });
  pipe.memBeforeMB = memBeforePipe;
  pipe.memLoadedMB = browserMemMB(exe);
  console.log(JSON.stringify(pipe));
  results.pipeline = pipe;

  fs.mkdirSync(dataDir, { recursive: true });
  const out = path.join(dataDir, `results-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${out}\n`);
  console.log(summary(results));
  await ctx.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

function summary(res) {
  const lines = [];
  lines.push('| backend | file | threads | load ms | B=1 msg/s (p50/p95 ms) | B=8 | B=32 | B=64 | stream rate→p50/p95 ms, avg batch | mem +MB (peak) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of res.runs) {
    if (r.error) {
      lines.push(`| ${r.device} | ${r.variant} | | ERROR: ${r.error} | | | | | |`);
      continue;
    }
    const b = (k) => (r.batches?.[k] ? `${r.batches[k].msgsPerSec} (${r.batches[k].p50ms}/${r.batches[k].p95ms})` : '');
    const s = r.stream ? `${r.stream.rate}/s → ${r.stream.p50ms}/${r.stream.p95ms}, ${r.stream.avgBatch}` : '';
    const mem = r.memPeakMB && r.memBeforeMB ? `+${r.memPeakMB - r.memBeforeMB} (${r.memPeakMB})` : '';
    lines.push(`| ${r.device} | ${r.variant} | ${r.threads ?? ''} | ${r.loadMs} | ${b(1)} | ${b(8)} | ${b(32)} | ${b(64)} | ${s} | ${mem} |`);
  }
  return lines.join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
