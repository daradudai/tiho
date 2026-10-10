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

To try a build, open `chrome://extensions`, turn on Developer mode, **Load unpacked** and pick `.output/chrome-mv3`. After a rebuild, click the reload icon on the Hush card. The background then injects the new content script into the YouTube, Twitch and Kick chats that are open, so they need no reload; a chat embedded in another site starts with its next page load.

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
  engine-client/ background client for Hush Engine: health polling, request batching, deadlines, follow-up answers to tabs
  ui/            in-chat bar (shadow DOM), message decorations, popup, side panel, onboarding, shared kit + tokens
  entrypoints/   WXT entrypoints: background.ts, chat.content.ts, offscreen/, popup/, sidepanel/, onboarding/, bench/
modules/
  hush-inference.ts   WXT module: copies the ORT runtime, filters bundled model files, cross-origin isolation, bench page
tests/
  unit/          vitest: core, runtime, inference, engine client, platform adapters against fixtures/
  ui/            vitest UI tests + showcase (mock surfaces) + screenshot and icon scripts
  stress/        content-script stress benchmark on mock chats (Playwright)
  bench/         in-browser inference benchmark (Playwright)
  tools/         live-site probes and fixture tooling for adapter work
```

## The model

The model lives in `public/models/hush-lite/` and is **git-ignored**. It is adaptive: two students distilled from the same 22-layer model, a 6-layer one for WebGPU and a 3-layer one for the CPU, sharing one tokenizer ([model card](../docs/MODEL_CARD.md)). Layout (written by [`ml/export/combine_variants.py`](../ml/export/combine_variants.py) from two [`export_onnx.py`](../ml/export/export_onnx.py) exports):

```
public/models/hush-lite/
  config.json                  HF config + `hush` block: labels, thresholds, max_len, files, sizes, version,
                               variant_info (layers and version per file), variant_thresholds (per-file overrides)
  tokenizer.json               13.7 MB
  tokenizer_config.json
  onnx/model_quantized.onnx    q8, 6 layers, 112.5 MB     WebGPU default
  onnx/model_uint8_3L.onnx     uint8, 3 layers, 105.3 MB  WASM default
  onnx/model_q4f16.onnx        q4f16, 6 layers, 61.9 MB   optional, WebGPU only
```

Get it by copying `models/hush-lite/` from a release zip, or by exporting both students and combining them (from the repo root, in the ml/ environment; details in [ml/README.md](../ml/README.md#9-export)):

```sh
python ml/export/export_onnx.py --model ml/runs/v2-6L/best --out ml/out/hush-lite-6L --precisions q8,uint8,q4f16 --model-version v2-6L
python ml/export/export_onnx.py --model ml/runs/v2-3L/best --out ml/out/hush-lite-3L --precisions q8,uint8,q4f16 --model-version v2-3L
python ml/export/combine_variants.py --gpu ml/out/hush-lite-6L --cpu ml/out/hush-lite-3L --out extension/public/models/hush-lite
```

A single `export_onnx.py` export written straight into the folder works too (one student for both backends, `hush.thresholds` for every file).

**How the extension finds it.** The inference worker tries up to two base URLs in order and uses the first whose `config.json` loads:

1. the bundled copy, `chrome-extension://<id>/models/hush-lite/`;
2. `REMOTE_MODEL_URL` from [`src/inference/config.ts`](src/inference/config.ts), only in a build made with `WXT_HUSH_MODEL_URL`. There is no default: release zips bundle the model and never download it.

A build without a bundled model and without `WXT_HUSH_MODEL_URL` has no model. The rules still filter, and the model status says "Model not included in this build".

**Remote model files are pinned.** A build with `WXT_HUSH_MODEL_URL` needs the model folder at build time: [`modules/hush-inference.ts`](modules/hush-inference.ts) computes the SHA-256 and size of `config.json`, the tokenizer files and the ONNX files of the variants in `HUSH_MODEL_VARIANTS` and compiles them into the extension. The worker refuses a remote file that is not pinned or does not match, so whoever controls the host can break the download but cannot change what runs or how it is thresholded. Build such a zip with `HUSH_BUNDLE_MODEL=0` to leave the files out of it. Any static host with the same layout and CORS works (for example a Hugging Face `resolve/<commit>/` URL). The tokenizer and the ONNX file go to Cache Storage (`hush-models-v1`), keyed by URL and pinned hash; cached files this build does not pin are pruned. The two small JSON files are fetched fresh each time and come from the cache only when the network fails.

**Which file runs.** `config.json → hush.files` lists the shipped variants. With WebGPU available (and "Use the GPU" on), the worker picks the first of `q8, q8f16, fp16, q4f16, fp32` that exists; otherwise WASM with `uint8, q8, q4, fp32`. If a variant fails to load or produces non-finite output during warm-up, it falls back to the next one, then to WASM. The reasoning behind this order is in [tests/bench/RESULTS.md](tests/bench/RESULTS.md). The model then uses that file's thresholds (`hush.variant_thresholds[variant]`, else `hush.thresholds`) and reports its version (`hush.variant_info[variant].version`, e.g. `v2-3L`) in the model status, where the side panel's model card reads the layer count from it.

## Build switches

Environment variables read at build time:

| Variable | Default | Effect |
|---|---|---|
| `HUSH_OUT` | `.output` | output folder; give parallel builds their own (`HUSH_OUT=.output-a`) |
| `HUSH_BUNDLE_MODEL` | on | `0` leaves `public/models/` out of the build entirely |
| `HUSH_MODEL_VARIANTS` | `q8,uint8` | which ONNX files to bundle (or, with `WXT_HUSH_MODEL_URL`, to pin), by variant: comma list of `fp32, fp16, q8f16, q8, uint8, q4, q4f16, q8a4`, or `all` (everything except fp32) |
| `WXT_HUSH_MODEL_URL` | none | remote model base URL (must end with `/`); the build reads the model folder to pin every file's hash, so it fails without it ([see above](#the-model)). Adds the URL's origin to `host_permissions`, and `*.hf.co` for a Hugging Face URL; without it the manifest asks for no model host |
| `HUSH_COI` | on | `0` drops cross-origin isolation (COOP/COEP) from extension pages; WASM then runs single-threaded |
| `HUSH_BENCH` | off | `1` also builds the benchmark page (`bench.html`) |

The ONNX Runtime Web files (`ort-wasm-simd-threaded.asyncify.{mjs,wasm}`, about 27 MB) are always copied from `node_modules` into `ort/`: Manifest V3 forbids remote code, so nothing loads from a CDN. Every build also gets the repo's `LICENSE` and `THIRD_PARTY_NOTICES.md` at its root (`hooks` in `wxt.config.ts`).

## Releasing

A release zip is what people without the model install, and where a source build gets its model, so it must contain the model:

1. Set the version in `package.json` (the manifest takes it from there), and in `engine/pyproject.toml` and `engine/hush_engine/__init__.py` if the engine changed.
2. With the model folder in `public/models/hush-lite/`, run `npm run zip`. Check that `.output/hush-<version>-chrome.zip` has `models/hush-lite/onnx/model_quantized.onnx`, `models/hush-lite/onnx/model_uint8_3L.onnx`, `LICENSE` and `THIRD_PARTY_NOTICES.md` (about 213 MB).
3. Load the unzipped folder in Chrome once and open a live chat: the popup should say "Ready · WebGPU" (or CPU) with the model's layer count.
4. Tag `v<version>` and attach the zip to a GitHub release with that tag.

## Debugging

| What | Where to look |
|---|---|
| Content script (adapter, runtime, bar) | the chat page's DevTools console. On YouTube the chat is the `live_chat` iframe: pick that frame in the console's context menu. |
| Routing, model status | `chrome://extensions` → Hush → "service worker" |
| Model loading and inference | `chrome://extensions` → Hush → Inspect views: `offscreen.html` (the worker's messages appear there too) |
| Popup, side panel | right-click inside them → Inspect |
| What Hush decided for a row | hover it (reason tooltip), or look at its `data-hush-a` / `data-hush-c` / `data-hush-r` attributes |

The offscreen document terminates its worker after 10 minutes without requests (WASM memory never shrinks) and starts a new one on the next message, so a cold "loading" status after a pause is normal. A model that failed to load is tried again by the background while any chat is open: after 5 s, then twice as long each time, up to 5 minutes. **Retry** in the popup or in the side panel's model card (Settings) loads it again at once.

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
