# Live end-to-end report

Hush on real, busy live chats on Twitch, Kick and YouTube, with the bundled model and with Hush Engine. Run on 2026-10-10 (evening, CET) against the working tree at `44694ce` plus the uncommitted changes present at that time.

**Result:** the content-script pipeline works on all three sites: rows get verdicts, the bar renders, questions are highlighted, spam is folded, waves are counted, and the model runs on WebGPU and on WASM. Hush Engine answered every question in time. Five bugs were found. The most serious one is [BUG-1](#bug-1-side-panel-and-popup-never-get-live-data): the side panel and the popup never get live data, so the Live, Inbox and Log tabs, the popup stats and the stream-context field do not work on a real page.

## Setup

| | |
|---|---|
| Machine | Windows 11, Ryzen 9 3950X, RTX 3090. llama-server with Clef-Flash-Q8_0 was running on `:7378` and other agents were using the GPU at the same time. |
| Build | `HUSH_OUT=.output-e2e npx wxt build` (default variants). Output: `model_quantized.onnx` (112.5 MB), tokenizer and config. **The 3-layer `model_uint8_3L.onnx` was not bundled** ([BUG-3](#bug-3-the-3-layer-wasm-student-is-never-bundled)). |
| Browser | Playwright 1.64 bundled Chromium 156.0.8078.4, headed, `launchPersistentContext` with `--disable-extensions-except/--load-extension`, device scale 2. Each run used a fresh profile with default settings (Chill preset). |
| Perf numbers | Every `hush:perf` message, captured by a listener added to the service worker. Worker statistics came from `hush:getPerf` and `hush:getStatus` sent from an extension page. |
| Engine | `engine\.venv\Scripts\python.exe -m hush_engine --attach http://127.0.0.1:7378` on `:7377`. It was stopped after the runs, and llama-server was left running. |

The test scripts are in the session scratchpad and are not committed. If you want them in the repo, they are close to `extension/tests/tools/live-look.mjs`. Two browser limits are not Hush bugs. Playwright's Chromium has no proprietary codecs, so YouTube's player shows "Something went wrong" and some Twitch players stay black. The chat is not affected.

## What was verified

| Check | Twitch | Kick | YouTube |
|---|---|---|---|
| Channels | ohnepixel (EN, CS2 watch party, 39k viewers), illojuan (ES, Just Chatting, 16k) | cuvey (EN, Fortnite), korekore_ch (JA, 71k), clavicular (EN, followers-only) | `EnbiWqK76qw` watch page (EN), `lvfB2KhWSBE` and `-JZZSdwNXTw` popout chat |
| Hush ran ≥ 60 s | yes (5 runs) | yes (2 runs + scroll test) | yes (watch page + 2 popouts) |
| Rows get `data-hush-a` / `data-hush-c` | yes: all 150 mounted rows. 0 to 3 rows were briefly without a verdict while held for the model. | yes (virtual list, about 30 rows mounted) | yes (watch-page iframe and popout) |
| System rows left alone (`data-hush-a=""`) | "Subscribed with Prime", watch streaks | dividers | `yt-gift-message-view-model` (Jewels gifts, a renderer the adapter does not know; harmless) |
| Bar inside the shadow root of `<hush-bar>` | yes | yes | yes |
| Questions highlighted | yes (e.g. `question · 97%` "Since when is Cache back in the game @chat?") | yes | yes |
| Folded pills (`data-hush-run`, "N hidden · show") | yes | yes | yes |
| Waves (`×N` badge, members folded) | yes (`??? ×18`, `KEK ×29`, `zimmer ×26`) | none in these chats | yes (`W ×22`) |
| Hover reason chip | yes (seen in the recording: `positive · 48%`, `noise · 93%`) | – | yes (`question · 73%`) |
| Expanded bar dashboard | yes | yes | yes |
| "Open dashboard" opens the real side panel | yes (`chrome.runtime.getContexts` lists a `SIDE_PANEL` context) | yes | yes |
| Side panel / popup show live data | **no**, see [BUG-1](#bug-1-side-panel-and-popup-never-get-live-data) | **no** | **no** |
| Console errors from Hush or `chrome-extension://` | none | none | none |

The model ran on **WebGPU** (`hush-lite/q8`, v2-6L) by default. With `preferGpu: false` it ran on **WASM** with 4 threads and cross-origin isolation, but with the 6-layer q8 file instead of the 3-layer uint8 student ([BUG-3](#bug-3-the-3-layer-wasm-student-is-never-bundled)).

### Numbers

All numbers come from `hush:perf` (content script) and the worker's own statistics, over the last 70 to 90 s of each run. "Rate" is messages Hush classified divided by the wall time. "Peak" is the highest 1-second bucket. "Verdict" is the time from row insert to the model's verdict (p50 / p95). "Main" is the content-script main-thread time per message (mean / max of the 2-second averages). "Forward" is the time of one model forward pass in the worker.

| Run | Backend | Msgs | Rate | Peak | Cache hit | Verdict p50 / p95 | Main ms/msg | Forward p50 / p95 | Model calls |
|---|---|---|---|---|---|---|---|---|---|
| Twitch ohnepixel | WebGPU | 380 | 4.6/s | 16 | 9% | 45 / 100 ms | 0.35 / 1.09 | 26 / 84 ms | 100 |
| Twitch illojuan (ES) | WebGPU | 682 | 7.2/s | 22 | 8% | 40 / 74 ms | 0.27 / 0.41 | 19 / 26 ms | 468 |
| Twitch illojuan (ES) | WASM (q8, 6L) | 276 | 3.3/s | 10 | 4% | 35 / 54 ms | 0.44 / 1.71 | 12 / 21 ms | 215 |
| Kick cuvey | WebGPU | 161 | 1.7/s | 25 | 0% | 54 / 195 ms | 0.51 / 1.58 | 33 / 133 ms | 20 |
| YouTube `EnbiWqK76qw` | WebGPU | 239 | 2.2/s | 75 (backlog burst) | 4% | 38 / 49 ms | 0.55 / 0.90 | 26 / 98 ms | 55 |
| Twitch ohnepixel + Engine | WebGPU | 208 | 5.1/s | 11 | 17% | 33 / 100 ms | 0.44 / 0.84 | 12 / 37 ms | 161 |

Model load (download not needed, bundled) took 2.7 to 3.8 s on WebGPU and 1.4 s on WASM. Main-thread cost stayed under 2 ms per message in every 2-second window, and the mean was 0.27 to 0.55 ms. Between 12% (Kick, mostly emotes and repeats) and 78% (Spanish chat with full sentences) of messages reached the model. The rest were decided by rules, waves or the cache. Categories, Twitch ohnepixel: noise 293, spam 36, clean 30, scam 7, negative 6, question 5, positive 2, toxic 1. Twitch illojuan: noise 344, clean 201, negative 53, question 41, positive 29, toxic 7, spam 6, scam 1.

These chats were slower than usual at that hour. Anonymous IRC measured 2 to 10 msg/s on the busiest Twitch chats and 2 to 9 msg/s on Kick. So these numbers show behaviour on real DOM, not peak load (see [stress results](../extension/tests/stress/RESULTS.md) for 100 to 200 msg/s).

### Hush Engine on a live chat

The test was done through the side panel UI, on Twitch ohnepixel. Steps: **Rules → Custom AI filters → Use Hush Engine** on, then the **Backseating** preset. The stream context could not be typed in the shipped build ([BUG-1](#bug-1-side-panel-and-popup-never-get-live-data)), so it was written to `engine.contexts["twitch/ohnepixel"]` in storage.

- The card showed **Connected · Clef-Flash-Q8_0 · RTX 3090 (24 GB) · ~90 ms**, then "230 messages refined".
- After 80 s, the extension's engine status was 179 answered, 0 expired, latency 87 to 166 ms. Engine `/health` showed 253 messages, backend p50 93 ms / p95 250 ms, 0 errors, 1 expired.
- Follow-up verdicts re-decided rows after their local verdict. The local category of these rows was `clean` (show) or `spam` (fold), and the engine's answer raised them to `data-hush-a="hide" data-hush-r="filter: backseating"`:
  - "dont gotothe village in the east"
  - "Avoid the villages to the east"
  - the same line as copypasta
  ```html
  <div class="Layout-sc-1xcs6mc-0" data-hush-a="hide" data-hush-c="clean" data-hush-r="filter: backseating">…TimooDZ: Avoid the villages to the east…
  ```
- After switching the filter to **Dim** (the action button in the filter list), new matches stayed visible and dimmed, for example `dim (filter: backseating)` on "@ohnePixel Remember to avoid the villages to the east".
- With BUG-1 patched in a scratch build ([below](#media)), the stream-context field showed and saved per channel. In that run the engine answered 140 texts with 0 expired.

## Media

All of these files are in `docs/img/`. Every PNG and WebP is under 600 KB, and the GIF is under 8 MB.

| File | What | Source |
|---|---|---|
| `hush-live.gif` (420×780, 8 fps, 20 s, 6.4 MB) and `hush-live.mp4` (same clip, 1.4 MB) | Twitch ohnepixel popout chat with Hush on: `×6` wave, "1 hidden · show" pills, highlighted questions, live counters in the bar | Playwright `recordVideo`, converted with ffmpeg. `recordVideo` records at CSS pixels and ignores device scale, so a narrow popout window was used to keep text sharp. |
| `live-twitch-chat.png` | Twitch popout, dark theme. The bar shows 37% hushed and counters. Questions are highlighted and messages have category edges. | shipped build |
| `live-twitch-dashboard.png` | Expanded bar on illojuan (Spanish): 16% hushed · 112 of 691, rate and vibe charts, category grid, waves `Sisi ×11 · KEK ×29 · LOL ×12`, latest questions, "Ready · WebGPU · 40 ms" | shipped build |
| `live-kick-chat.webp` | Kick cuvey (Fortnite) with video: "4 hidden · show" pill, highlighted question, bar | shipped build |
| `live-youtube-chat.png` | YouTube popout, Live chat, light theme: pill, highlighted questions, negative edges | shipped build |
| `live-twitch-sidepanel.png`, `live-twitch-inbox.png`, `live-twitch-log.png`, `live-twitch-popup.png`, `live-twitch-engine.png` | Side panel Live, Inbox and Log tabs, popup, and the Custom AI filters card connected to the engine with a stream context | **Scratch build with BUG-1 patched** (`serveLive` wired in `runtime/index.ts`, 3 lines, outside the repo). Until BUG-1 is fixed, the shipped extension shows "No stream open" or "waiting for chat" instead. Use these only after the fix. The Live tab also shows BUG-2 ("497680h ago") at the bottom edge. |
| `e2e/*` | Evidence for the bugs below | |

A suggested README row, if wanted:

```html
<p align="center"><img src="docs/img/hush-live.gif" width="420" alt="Hush on a live Twitch chat"></p>
```

Content check: the media were chosen to avoid visible slurs. The GIF contains one mild profanity ("played like shit"). Toxic lines in the Log screenshot are blurred by the UI.

## Bugs

### BUG-1: side panel and popup never get live data

**Severity: high.** The Live, Inbox and Log tabs, the popup stats, "Not spam" and "reveal" from the Log, and the stream-context field all depend on it.

- **Cause.** `serveLive()` (`extension/src/ui/bridge.ts:89`) is never called. Nothing in the content script answers the `hush:live` Port or the `hush:getSnapshot` message. The built `content-scripts/chat.js` contains neither string (`grep -c "hush:getSnapshot\|hush:live"` returns 0). Only `ui/bridge.ts` defines it. `git log -S serveLive` shows it was added in `7ec20fb` and never wired.
- **Repro.**
  1. Load the build.
  2. Open any live Twitch channel and wait for the bar.
  3. Click the bar's expand arrow, then **Open dashboard**. The side panel opens and stays on "Open a live stream" with "No stream open" in its header. The Inbox and Log tabs are empty.
  4. Open the popup: it shows "Twitch · waiting for chat" and only msgs/s (the `hush:getPerf` fallback).
  5. In Rules → Custom AI filters with the engine on, the stream context shows "Open a stream to give the engine context about it…" instead of the field.
- **Evidence.** `docs/img/e2e/bug1-real-build-sidepanel-popup.webp`. With this 3-line change in a scratch copy, everything works (see the `live-twitch-*` side panel and popup images):
  ```ts
  // runtime/index.ts, startHush
  let offLive: (() => void) | null = null;
  // in onAttach:
  offLive ??= serveLive(store, { reveal: (key) => rt?.reveal(key) });
  // in stop():
  offLive?.();
  ```
  A real fix should also pass a `feedback` handler if the Log's "Not spam" needs more than reveal.

### BUG-2: wave times mix two clocks ("497680h ago", live marker never on)

**Severity: medium. It is visible as soon as BUG-1 is fixed, and in the bar already.**

- **Cause.** The runtime clock is `performance.now()` (`runtime/engine.ts:253`), so `WaveInfo.startedAt` and `lastAt` are milliseconds since page load. The UI compares them with `Date.now()`:
  - `ui/sidepanel/LiveTab.tsx:89` (`data-live`) and `:93` (`ago(w.lastAt)`)
  - `ui/bar/Bar.tsx:612` (`data-live`, `title={… ago(w.startedAt)}`)
- **Repro.** Open a chat with waves (e.g. Twitch ohnepixel during a round) and expand the bar. Each wave pill has `title="14 people · 497680h ago"` and no pill has `data-live`, even for a wave that is still growing.
  ```json
  [{"text":"zimmer×26","live":false,"title":"25 people · 497680h ago"},{"text":"mhm×12","live":false,"title":"14 people · 497680h ago"}]
  ```
  This JSON was read from the open shadow root. The side panel's Waves card shows "5 people · 497680h ago".
- **Evidence.** `docs/img/e2e/bug2-wave-ago.png`.
- **Fix.** Convert to wall time when building `WaveInfo` (store `Date.now()`-based times), or send the age instead of timestamps.

### BUG-3: the 3-layer WASM student is never bundled

**Severity: medium.** CPU users get the larger, slower 6-layer q8 file, and the README is wrong.

- **Cause.** `extension/modules/hush-inference.ts:27` maps `uint8: 'model_uint8.onnx'`. The shipped `config.json` lists `"uint8": "onnx/model_uint8_3L.onnx"`. The default `HUSH_MODEL_VARIANTS=q8,uint8` therefore keeps only `model_quantized.onnx`.
- **Repro.**
  1. Run `HUSH_OUT=.output-e2e npx wxt build`. The build listing has `models/hush-lite/onnx/model_quantized.onnx` only.
  2. Set `preferGpu: false` (Settings → "Use the GPU" off) and open a chat. The model status is `{"backend":"wasm","modelId":"hush-lite/q8","version":"v2-6L"}`, not uint8 / v2-3L. The worker's fetch of `model_uint8_3L.onnx` fails and it falls back to the second WASM preference.
- **Contradicts.** `README.md:91` ("By default only the two files … the 3-layer `onnx/model_uint8_3L.onnx` for WASM") and `extension/README.md:59`.
- **Fix.** Take the file names from `config.json` → `hush.files` in the module, or map `uint8` to `model_uint8_3L.onnx`.

### BUG-4: re-rendered or re-mounted rows are folded as "repeat" spam

**Severity: high on Kick and YouTube.** Scrolling up on Kick, or switching YouTube's chat mode, folds most of the history into "N hidden" pills. Toxic messages that were hidden become one click away as "spam". The spam counters inflate.

- **Cause.** When a new DOM node arrives for a message Hush has already seen (same `msg.key`), `HushRuntime.process()` (`runtime/engine.ts:753`) finds no `RowState` for the new node and evaluates it again. `RuleEngine.trackDuplicate()` (`core/rules.ts:417`) then sees the same author and normalized text within 30 s and returns `spam / repeat`. Keys are not considered, so a re-mount looks like the user posting twice.
- **Repro, YouTube.**
  1. Open `https://www.youtube.com/live_chat?is_popout=1&v=<live id>` and wait about 8 s.
  2. Open the chat-mode menu and pick **Live chat**. Picking **Top chat** again has the same effect.
  3. YouTube re-creates every row with the same element id. 50 of 71 messages changed verdict, for example:
     ```json
     {"id":"ChwKGkNQbmF5TXZ0cjVjREZUSEU1d01kUWtjUHlB","before":"data-hush-a=\"show\" data-hush-c=\"clean\"","after":"data-hush-a=\"collapse\" data-hush-c=\"spam\" data-hush-r=\"repeat\" data-hush-run=\"1\"","newNode":true,"text":"@ajm64sc2: betting sponsored team ez"}
     ```
  4. In another run, every one of the 68 re-created rows ended as `collapse/repeat`, and no row was hidden any more (2 were hidden as toxic before the switch). So toxic lines end up one click away, behind "show".
  5. The chat shows a stack of "7 hidden · show", "6 hidden · show" pills: `docs/img/e2e/bug4-youtube-mode-switch.webp`.
- **Repro, Kick.**
  1. Open `https://kick.com/korekore_ch` and wait 25 s.
  2. Scroll the chat up about 1500 px. The virtual list re-mounts older rows as new nodes.
  3. 47 of 56 previously seen messages changed from `show/negative · 14%`, `highlight/question · 62%` and so on to `collapse/repeat`. The scrolled-back history reads "105 hidden · show" and the spam counter jumped to 608: `docs/img/e2e/bug4-kick-scroll-up.webp`.
  4. This contradicts `docs/architecture.md`: "Keys are content hashes so a re-mounted row keeps its verdict."
- **Fix.** In `process()`, when there is no `prev` for the node but `byKey` (or a small key → `RowState` / verdict map) knows `msg.key` with the same text, reuse that state (`knownDup`) instead of feeding the rule tracker again. The duplicate tracker could also ignore entries with the same key. The `seen` and count totals should not count re-mounts.

### BUG-5 (minor): the side panel says "No stream open" on a chat page when the content script does not answer

- **Cause.** In `connectLive()` (`ui/bridge.ts:259` and `:283`), when the Port to the tab disconnects at once (no receiver), `onDisconnect` schedules `connect` in 2 s. The next `connect()` calls `clear()`, which cancels the 3.5 s stale timer before it fires. `onUpdate(null, tab)` therefore never runs, and `activeTab` stays `null`.
- **Effect.** The header shows "No stream open" and the empty state says "Open a live stream" even with a Twitch channel in the active tab. The "Waiting for chat…" branch is unreachable in this case. Today every chat page hits this because of BUG-1. After the fix it will still happen on pages before chat attaches, and on YouTube pages without chat.
- **Fix.** Report the tab (`onUpdate(null, tab)`) as soon as it is resolved, or in `onDisconnect`.

## Other observations (not bugs)

- **Model misses seen live:**
  - "jewnicker" (Kick, clavicular) was shown as clean.
  - "sped" used as an insult (Twitch) was shown.
  - English chat is very noise-heavy (77% noise on ohnepixel), mostly `???` and `gg` waves. That is expected, and noise is shown under Chill.
- **YouTube channel.** The YouTube adapter reports the video id as the channel (by design). The side panel and the per-channel engine context are therefore per video, e.g. "lvfB2KhWSBE".
- **Bar width.** In Twitch's 340 px chat the bar's chip row scrolls: the negative and question chips are off-screen unless scrolled. On YouTube the "HUSHED" label takes more room.
- **Hover chip.** The chip straddles the row's top edge. On the first row under the bar it is clipped by the chat scroller.
- **Initial burst.** YouTube inserts its backlog in one burst (`msgsPerSec` peak 75 at load). Nothing broke, and no long frames came from Hush.
