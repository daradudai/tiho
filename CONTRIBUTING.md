# Contributing to Tiho

Thanks for helping. Tiho is small and opinionated: it has to stay fast in 150 msg/s chats, private, and calm to look at. This page tells you how to work on it without breaking any of that.

## Ways to help

- **Report a wrong verdict.** A message that was hidden but should not have been, or the other way round. These are the most useful reports we get. Use the [wrong verdict template](https://github.com/daradudai/tiho/issues/new?template=wrong_verdict.yml). Leave out the author's name.
- **Report a broken site.** YouTube, Twitch and Kick change their chat markup without warning. If Tiho stops tagging messages, open a [bug report](https://github.com/daradudai/tiho/issues/new?template=bug_report.yml) with the page URL and, if you can, the chat's HTML (see [Platform adapters](#platform-adapters)).
- **Your language.** Hard cases in your language (slang, insults that look harmless, harmless swearing that looks like an insult) make the next model better. Put them in an issue with what each one should be.
- **Code.** Look for issues labeled `good first issue`, or open an issue before a big change so we can agree on the approach.

## Repository map

| Folder | What | Guide |
|---|---|---|
| `extension/` | Chrome MV3 extension: WXT, TypeScript, Preact, `@preact/signals` | [extension/README.md](extension/README.md) |
| `engine/` | Tiho Engine: Python, FastAPI, llama.cpp | [engine/README.md](engine/README.md) |
| `ml/` | data collection, labeling, training, ONNX export | [ml/README.md](ml/README.md) |
| `docs/` | architecture, model card, screenshots | [docs/architecture.md](docs/architecture.md) |

[SPEC.md](SPEC.md) is the contract between these parts (message model, labels, pipeline, performance rules). If your change touches that contract, update SPEC.md in the same pull request.

## Set up

**Extension** (Node.js 22):

```sh
cd extension
npm ci
npm run dev            # WXT dev mode: opens Chrome with Tiho loaded, reloads on change
npx tsc --noEmit       # typecheck
npx vitest run         # unit tests
npm run build          # production build into .output/chrome-mv3
```

The model is not in git. To work with the real model, put it in `extension/public/models/tiho-lite/` (see [extension/README.md](extension/README.md#the-model)). Without it, Tiho still runs: rules filter on their own and the model status says "Model not included in this build".

**Engine** (Python 3.10+, no GPU needed for tests):

```sh
cd engine
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"      # Linux/macOS: .venv/bin/python
.venv/Scripts/python -m pytest -q -m "not integration"
```

**ML** needs a CUDA GPU and its own environment; see [ml/README.md](ml/README.md). The raw chat logs are not published, so you can retrain only on data you collect yourself.

## Rules of the house

**Privacy.** Chat text never leaves the device. No analytics, no telemetry, no remote code (Manifest V3 forbids it anyway), no new network destinations without discussion. The only allowed requests are the model download (only in builds made with `WXT_TIHO_MODEL_URL`, and only files whose hashes the build pins) and the user's own Tiho Engine.

**Performance** (SPEC.md §8). The content script shares the page's main thread with the chat itself:

- One `MutationObserver` on the chat list, `childList` only. Never poll or walk the whole DOM.
- Read in one pass, write in one pass, once per animation frame. No layout reads (`offsetHeight`, `getBoundingClientRect`, ...) in the hot path.
- Rows get attributes only (`data-tiho-*`, plus the button attributes of a pill row); all visuals live in the one injected stylesheet. No inline styles on rows.
- Bounded memory: LRU caches with a size, `WeakMap` for nodes.

If you touch `src/runtime`, `src/core` or `src/platforms`, run the stress harness before and after and put both numbers in the PR:

```sh
cd extension
node tests/stress/make-corpus.mjs      # once; samples ml/data/raw/*.jsonl (git-ignored)
node tests/stress/run-stress.mjs --rates=100 --soak=0 --cpu=0 --bar=0 --out=.stress.md
```

The corpus is sampled from real chat logs, which are not in git. If you have none, a few minutes of `python ml/collect/twitch_irc.py --minutes 10` gives you enough.

**UI.** Animations of 150 ms or less, `prefers-reduced-motion` respected, light and dark themes on every surface, colors from `src/ui/tokens.css`. If you change how something looks, regenerate the screenshots (`node tests/ui/shoot.mjs`) and attach the relevant ones to the PR.

**Code style.** TypeScript strict. Match the code around you: a header comment per file that says what it is for and why it is built that way, short comments on non-obvious lines, no comments that restate the code. Keep `src/core` free of `chrome.*` and DOM globals so it stays unit-testable. Python: type hints, standard library first, small modules.

## Platform adapters

Each adapter in `extension/src/platforms/` turns a chat row into a `ChatMessage`. Its header comment documents the live DOM it was written against, with the date. When a site changes:

1. Reproduce on a live channel: `node tests/tools/live-check.mjs <url> 20 --headed` bundles the adapters into a real page and reports extracted vs. skipped rows.
2. Capture fresh markup and turn it into a sanitized fixture: `tests/tools/collect-chat.mjs`, then `tests/tools/make-fixtures.mjs` (it removes scripts and replaces every viewer name with a fake one).
3. Fix the adapter, update its header comment, add the fixture and a test in `tests/unit/platforms/adapters.test.ts`.

Never commit raw captures: they contain real usernames.

## Pull requests

- One topic per PR. Small is good.
- Say what changed and why; link the issue.
- Before you push:
  - extension: `npx tsc --noEmit`, `npx vitest run`, `npm run build`
  - engine: `pytest -q -m "not integration"`
- CI runs the same checks (typecheck, unit tests, a build without the model, engine tests on Linux and Windows).
- New behavior comes with a test. Bug fixes come with the test that would have caught them.

## Security

Please do not open public issues for security problems (for example in Tiho Engine's local server). See [SECURITY.md](.github/SECURITY.md).

## License and contributor agreement

Tiho is released under the [Functional Source License 1.1, MIT Future License](LICENSE) (FSL-1.1-MIT):
anyone can use, change and share it for any purpose except offering a competing commercial product or
service, and every version becomes plain MIT two years after it is released.

By opening a pull request you agree to the following, for everything you contribute:

1. You wrote it, or you have the right to contribute it.
2. It is licensed to everyone under the project's license (FSL-1.1-MIT, so MIT after two years).
3. You also give the maintainer (Petar Georgiev) a perpetual, worldwide, royalty-free, irrevocable
   license to use, change, relicense and sublicense it, including under other terms. This lets the
   project offer exceptions to the Competing Use rule. You keep the copyright to your work and can use
   it however you like.

If you can't agree to this, say so in the pull request before it is merged.
