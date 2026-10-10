# Hush extension

Chrome MV3 extension built with [WXT](https://wxt.dev) 0.21, TypeScript, Preact 11 and `@preact/signals`. For what Hush does, see the [main README](../README.md); for how the parts fit together, [docs/architecture.md](../docs/architecture.md). This page is for working on the code.

## Commands

Node.js 22. Run everything from `extension/`.

```sh
npm ci                 # install (also runs `wxt prepare`, which generates .wxt/)
npm run dev            # WXT dev mode: rebuilds and reloads on change
npm run build          # production build → .output/chrome-mv3
npm run zip            # build + zip → .output/hush-<version>-chrome.zip
npx tsc --noEmit       # typecheck
npx vitest run         # unit tests (happy-dom)
```

To try a build, open `chrome://extensions`, turn on Developer mode, **Load unpacked** and pick `.output/chrome-mv3`. After a rebuild, click the reload icon on the Hush card and reload the chat tab.

## Source map

```
src/
  core/          platform-agnostic logic, no chrome.* or DOM globals (unit-tested)
    types.ts       ChatMessage, labels, categories, actions, Verdict: the shared contract
    normalize.ts   text normalization for cache keys, rules and waves
    rules.ts       Tier-0 rules: user rules, commands, links, floods, duplicates, scam patterns
    waves.ts       cross-user wave detection (exact keys + SimHash LSH)
    policy.ts      scores + rule signals + settings → Verdict
    settings.ts    Settings, presets, chrome.storage.local helpers
    store.ts       signals shared by the runtime (writer) and the in-chat UI (reader)
  platforms/     DOM adapters: youtube.ts, twitch.ts (incl. 7TV), kick.ts; matches.ts = injection targets
  runtime/       content-script engine: observer, per-frame read/resolve/write, classifier Port client, row stylesheet
  inference/     offscreen host + worker: model loading, ONNX Runtime Web session, batching, bucketing, cache, stats
  ui/            in-chat bar (shadow DOM), message decorations, popup, side panel, onboarding, shared kit + tokens
  entrypoints/   WXT entrypoints: background.ts, chat.content.ts, offscreen/, popup/, sidepanel/, onboarding/, bench/
modules/
  hush-inference.ts   WXT module: copies the ORT runtime, filters bundled model files, cross-origin isolation, bench page
tests/
  unit/          vitest: core, runtime, inference, platform adapters against fixtures/
  ui/            vitest UI tests + showcase (mock surfaces) + screenshot and icon scripts
  stress/        content-script stress benchmark on mock chats (Playwright)
  bench/         in-browser inference benchmark (Playwright)
  tools/         live-site probes and fixture tooling for adapter work
```

## The model

The model lives in `public/models/hush-lite/` and is **git-ignored**. Layout (written by [`ml/export/export_onnx.py`](../ml/export/export_onnx.py)):

```
public/models/hush-lite/
  config.json              HF config + `hush` block: labels, thresholds, max_len, files, sizes, version
  tokenizer.json           13.7 MB
  tokenizer_config.json
  onnx/model_quantized.onnx   q8, 119 MB     WebGPU default
  onnx/model_uint8.onnx       uint8, 117 MB  WASM default
  onnx/model_q4f16.onnx       q4f16, 65 MB   optional, WebGPU only
  onnx/model.onnx             fp32 reference, never bundled
  hush_export.json         export report (sizes, parity), never bundled
```

Get it by copying `models/hush-lite/` from a release zip, or by exporting a checkpoint:

```sh
# from the repo root, in the ml/ environment
python ml/export/export_onnx.py --model ml/runs/v2-9L/best --out extension/public/models/hush-lite \
    --precisions q8,uint8,q4f16 --model-version v2-9L
```

**How the extension finds it.** The inference worker tries two base URLs in order and uses the first whose `config.json` loads:

1. the bundled copy, `chrome-extension://<id>/models/hush-lite/`;
2. `REMOTE_MODEL_URL` from [`src/inference/config.ts`](src/inference/config.ts), overridable at build time with `WXT_HUSH_MODEL_URL`. Any static host with the same layout and CORS works (for example a Hugging Face `resolve/<revision>/` URL; pin a tag or commit). Downloaded files go to Cache Storage (`hush-models-v1`), keyed by URL and model version; files of older versions are pruned.

<!-- TODO(lead): REMOTE_MODEL_URL points at huggingface.co/hush-chat/hush-lite, which is not published yet. -->
The default remote URL (`huggingface.co/hush-chat/hush-lite`) is not published yet, so for now a build without a bundled model has no model: the rules work, the model status shows an error.

**Which file runs.** `config.json → hush.files` lists the shipped variants. With WebGPU available (and "Use the GPU" on), the worker picks the first of `q8, q8f16, fp16, q4f16, fp32` that exists; otherwise WASM with `uint8, q8, q4, fp32`. If a variant fails to load or produces non-finite output during warm-up, it falls back to the next one, then to WASM. The reasoning behind this order is in [tests/bench/RESULTS.md](tests/bench/RESULTS.md).

## Build switches

Environment variables read at build time:

| Variable | Default | Effect |
|---|---|---|
| `HUSH_OUT` | `.output` | output folder; give parallel builds their own (`HUSH_OUT=.output-a`) |
| `HUSH_BUNDLE_MODEL` | on | `0` leaves `public/models/` out of the build entirely |
| `HUSH_MODEL_VARIANTS` | `q8,uint8` | which ONNX files to bundle: comma list of `fp32, fp16, q8f16, q8, uint8, q4, q4f16, q8a4`, or `all` (everything except fp32) |
| `WXT_HUSH_MODEL_URL` | see above | remote model base URL (must end with `/`) |
| `HUSH_COI` | on | `0` drops cross-origin isolation (COOP/COEP) from extension pages; WASM then runs single-threaded |
| `HUSH_BENCH` | off | `1` also builds the benchmark page (`bench.html`) |

The ONNX Runtime Web files (`ort-wasm-simd-threaded.asyncify.{mjs,wasm}`, about 27 MB) are always copied from `node_modules` into `ort/`: Manifest V3 forbids remote code, so nothing loads from a CDN.

## Debugging

| What | Where to look |
|---|---|
| Content script (adapter, runtime, bar) | the chat page's DevTools console. On YouTube the chat is the `live_chat` iframe: pick that frame in the console's context menu. |
| Routing, model status | `chrome://extensions` → Hush → "service worker" |
| Model loading and inference | `chrome://extensions` → Hush → Inspect views: `offscreen.html` (the worker's messages appear there too) |
| Popup, side panel | right-click inside them → Inspect |
| What Hush decided for a row | hover it (reason tooltip), or look at its `data-hush-a` / `data-hush-c` / `data-hush-r` attributes |

The offscreen document terminates its worker after 10 minutes without requests (WASM memory never shrinks) and starts a new one on the next message, so a cold "loading" status after a pause is normal.

## Tests and tools

| Command | What |
|---|---|
| `npx vitest run` | unit tests: core logic, runtime, inference engine (fake model), adapters against `tests/fixtures/` |
| `npx vite -c tests/ui/vite.config.ts` | UI showcase dev server (port 5199): every surface on mock data, `?view=chat\|popup\|sidepanel\|onboarding&theme=dark\|light&platform=twitch\|youtube\|kick` |
| `node tests/ui/shoot.mjs [prefix]` | screenshots of the showcase into `tests/ui/screenshots/` |
| `node tests/ui/render-icons.mjs` | redraws `public/icon/*.png` from the logo geometry |
| `npx playwright test --project=stress` | quick runtime smoke on the mock chats (about a minute) |
| `node tests/stress/run-stress.mjs` | full content-script benchmark, writes [tests/stress/RESULTS.md](tests/stress/RESULTS.md) (needs `node tests/stress/make-corpus.mjs` first) |
| `node tests/stress/ext-smoke.mjs` | end-to-end with the real built extension on the mock chats (build with `HUSH_OUT=.output-runtime` first) |
| `node tests/bench/bench.mjs` | inference benchmark, see [tests/bench/RESULTS.md](tests/bench/RESULTS.md) for the build it needs |
| `node tests/tools/live-check.mjs <url>` | runs the adapters on a real live page and reports extracted vs. skipped rows |

The stress corpus and the bench sample are drawn from real chat logs in `ml/data/raw/` (git-ignored) and stay git-ignored themselves. Scripts that load the extension use Playwright's bundled Chromium, because branded Chrome ignores `--load-extension`.

## Conventions

- `src/core` stays free of `chrome.*` and DOM globals; anything that touches Chrome APIs is injected, so it can be tested in vitest.
- The content script follows the performance rules in [SPEC.md §8](../SPEC.md#8-performance-rules): one observer, one read pass and one write pass per frame, attributes only, no layout reads.
- Rows are styled only through the stylesheet in `src/runtime/styles.ts`, driven by `data-hush-*` attributes and `--hush-*` custom properties. The in-chat bar renders in a shadow root.
- Colors and spacing come from `src/ui/tokens.css`; every surface supports light and dark.
