# Tiho — specification (v1)

> An ad-blocker for live chat. Tiho reads YouTube / Twitch / Kick live chat as it
> streams, classifies every message on-device with a small multilingual model, and
> hides, dims or highlights it according to the viewer's taste. Free, open source,
> private: no message ever leaves the machine.

This file is the contract between the parts of the project. Old project
(`~/livechat-filter`, Plasmo + DistilBERT SST-2 + regex) was used only as a
reference for scope; nothing is carried over.

## 0. Goals / non-goals

Goals
- Works in the heaviest chats (Kai Cenat / xQc / Ibai scale, 50–150 msg/s) with
  no visible jank: the content script must never block the page main thread for
  more than ~2 ms per frame.
- Multilingual: tuned on real chat in about 30 stream languages (EN, ES, DE, PT,
  FR, RU, BG, PL, TR, IT, JA, KO, …) and measured on the 13 with enough test
  messages; other languages rely on mmBERT's pre-training and are untested.
- Zero setup: install → open a stream → it works. The release zip carries the
  model, so nothing is downloaded and it works offline.
- Optional **Tiho Engine**: a local GPU server (RTX-class) running an open
  Jev-style decision model (Cloudflare Clef-Flash) for custom natural-language
  filters ("hide backseating", "hide spoilers for Elden Ring") and a second
  opinion on uncertain messages.
- Beautiful, calm UI that feels native on each platform.

Non-goals (v1): moderating as a streamer (deleting / banning), sending data to
any cloud, mobile apps.

## 1. Repository layout

```
hush/
  extension/        WXT + TypeScript + Preact. Chrome MV3 (Firefox later).
    src/
      core/         platform-agnostic: types, normalize, rules, waves, policy,
                    settings, store
      platforms/    youtube.ts, twitch.ts, kick.ts  (DOM adapters)
      runtime/      content-script engine: observer, per-frame passes, classifier Port
      inference/    offscreen host + worker running the ONNX model (WebGPU → WASM)
      engine-client/  background client for the optional Tiho Engine
      ui/           overlay (in-chat, shadow DOM), popup, sidepanel, onboarding
      entrypoints/  WXT entrypoints (content scripts, background, offscreen, pages)
    tests/          vitest unit + UI tests, Playwright stress harness and
                    inference benchmark on mock chats, live-site tools
  engine/           Tiho Engine: local server (Python, FastAPI) in front of
                    llama.cpp `llama-server` running Clef-Flash.
  ml/               data collection, labeling (gold + teacher), training,
                    distillation, ONNX export/quantization, evaluation.
  docs/             architecture notes, model card, live test report, screenshots.
```

## 2. Message model

```ts
type Platform = 'youtube' | 'twitch' | 'kick'

interface ChatMessage {
  key: string            // stable per DOM node (platform id if available)
  platform: Platform
  channel: string
  author: string         // display name
  authorId?: string
  roles: number          // bitmask: BROADCASTER=1 MOD=2 VIP=4 SUB=8 MEMBER=16 VERIFIED=32
  text: string           // plain text, emotes replaced by their code (":KEKW:" → "KEKW")
  emotes: number         // count of emote images in the message
  mentions: string[]     // @names
  isReply: boolean
  isFirstMessage: boolean // Twitch "first time chatter" etc.
  paid: boolean          // superchat / bits / kicks / sticker — never hidden by default
  ts: number
}
```

## 3. Label taxonomy (model heads, multi-label sigmoid)

| id | label      | meaning |
|----|------------|---------|
| 0  | `toxic`    | insults, harassment, hate, slurs, threats, sexual harassment |
| 1  | `spam`     | flooding, copypasta, character/emote walls, gibberish |
| 2  | `scam`     | self-promo, bots, "free X", crypto / gambling links, follow-for-follow |
| 3  | `noise`    | low-effort reaction: single emote/word ("W", "L", "lol", "first", "?") |
| 4  | `question` | a genuine question (to streamer or chat) |
| 5  | `positive` | supportive, kind, hype |
| 6  | `negative` | complaining / criticism without abuse |

Labels are independent (a message can be `toxic` + `negative`). A message's
category is the first label at or above its threshold in priority order
(toxic > scam > spam > noise > question > negative > positive), or `clean` when
none is. Thresholds per label are calibrated on the gold set for each student
and shipped in the model's `config.json`: `tiho.thresholds`, overridden per
model file by `tiho.variant_thresholds`.

## 4. Pipeline (per message)

```
DOM node ─▶ adapter.extract() ─▶ Tier 0 rules (sync, <0.05 ms)
                                   │  decided? (role allow-list, user rules, links,
                                   │  floods, waves, commands, emote-only)
                                   ▼
                              cache lookup (normalized text → scores)
                                   │ miss
                                   ▼
                     batcher (per tab, flush every frame / 32 msgs)
                                   │  chrome.runtime Port
                                   ▼
          background SW ─▶ offscreen document ─▶ inference worker
                                   │  (one model for all tabs; WebGPU, WASM fallback)
                                   ▼
                      scores ─▶ policy(settings) ─▶ Action
                                   │
                         optional: uncertain or custom-filter
                                   ▼
                          Tiho Engine (localhost) ─▶ refine
```

Actions: `show` | `highlight` | `dim` | `collapse` (thin "hidden" pill) | `hide`.
Applied by setting ONE attribute (`data-tiho-a="dim"` etc.) plus category
attribute `data-tiho-c`; all visuals live in one injected stylesheet so the
browser does a single style recalc per frame.

Hold policy: when a category the user hides is ML-dependent, new messages are
held invisible (`visibility:hidden`, no layout shift... see adapter notes) for at
most `holdMs` (default 250 ms). If inference does not answer in time the message
is shown and re-evaluated when the score lands (can still collapse later).

Never hidden by default: broadcaster, moderators, VIPs, paid messages, the
viewer's own messages and messages that mention the viewer.

### Tier 0 rules (core/rules.ts)
- user allow/block lists (users, words, regex)
- `!command` → noise
- link detection → scam signal, unless the domain is allow-listed (twitch.tv,
  kick.com, wikipedia, emote sites, …) or the author is privileged
- char/emote floods, caps ratio, repeated tokens → spam signal
- duplicate by same user within 30 s → spam
- **Waves**: exact keys for short texts, SimHash over normalized text for longer
  ones, in a 10 s sliding window across users. When ≥ 4 users post near-identical
  text the wave is detected; first message stays, the rest collapse into a live
  counter on it ("KEKW ×37"). Waves are culture, not spam: shown compact by default.

### Normalization (core/normalize.ts)
NFKC, lowercase, strip zero-width & combining abuse, map homoglyphs/leet
(`fr33 r0bux` → `free robux`), collapse char repeats (`soooo` → `soo`), trim. The
cache key is the normalized text; the model sees the original (lightly cleaned).

## 5. In-browser model ("Tiho Lite")

- Base: `jhu-clsp/mmBERT-small` (ModernBERT arch, 140 M params, 256k vocab, MIT),
  fine-tuned as a 22-layer model (v2), then distilled into two students: 6 layers
  for WebGPU and 3 layers for WASM. The shipped v3 students (v3-6L, v3-3L) were
  distilled again from the average of v2 and a fine-tuned mmBERT-base teacher.
  One model folder holds both; each browser loads only the one for its backend.
- Fine-tuned multi-label head (7 sigmoid outputs), max_len 64 tokens.
- Training data: real chat (Twitch IRC, Kick Pusher, YouTube live chat) labeled by
  a teacher (Clef-Flash decision model on the RTX 3090) and by Claude agents
  (silver, active learning; messages moderators deleted were oversampled into the
  labeling pool) + public datasets (toxicity / spam / sentiment) + synthetic hard
  cases. Gold eval set: 2,000 real messages labeled by two Claude annotators and a
  third that settled disagreements; no human labels
  ([docs/MODEL_CARD.md](docs/MODEL_CARD.md)).
- Export: ONNX with fused attention ops: `q8` (int8 weight-only) for WebGPU, `uint8`
  (dynamic int8) for WASM. Run with ONNX Runtime Web; Transformers.js is used for
  the tokenizer only.
- Shipped in the release zip. A build may instead download it from a URL set at
  build time, and then uses only files matching the SHA-256 hashes pinned in the
  build.
- Budget: ≤ 150 MB download, p95 ≤ 25 ms for a batch of 32 on a mid GPU, ≥ 300 msg/s
  on WASM (4 threads) on a mid laptop CPU. Cached by text, so effective throughput is
  much higher.

## 6. Tiho Engine (optional, local GPU)

- `engine/`: FastAPI on `127.0.0.1:7377`, extension and localhost origins only.
  Endpoints:
  - `GET /health` → status, decision model, device, version, queue and cache stats
  - `POST /v1/classify` `{messages:[{id, text, platform}], filters:[{id, question}],
    base, deadline_ms, context, stream}` → per message: a probability per custom
    filter and, with `base`, Clef-Flash's own category + tone scores (second
    opinion); `{id, error: "expired"}` past the deadline.
  - `POST /v1/systemone`: raw decision-model passthrough.
- Clef-Flash (9B, GGUF `Q8_0` or `Q4_K_M` by VRAM) via the llama.cpp `llama-server`
  decision endpoint. The engine starts and supervises its own llama-server, locked
  with a random API key, or attaches to one that already runs.
- Batches, dedups, caches, drops what misses its deadline (newest first under load).
- Off by default. The viewer turns it on in the side panel; only then does the
  background service worker poll `/health` and send it texts that reached the
  in-browser model (none from background tabs): custom filters for each, the
  second opinion only where the local model is unsure. Answers stream back to the
  tab as they come in and re-decide rows already on screen. Status is shown in the
  UI.

## 7. UI

- **Two modes** (`settings.uiMode`, UI only: filtering is the same in both). **Basic**
  (default): one choice, Off · Clean · Quiet, and Show hidden; no numbers, categories
  or percentages. **Advanced** (streamers, mods): presets, per-category actions, live
  counts, rules, custom AI filters, Solo. Spec: [docs/ux-modes.md](docs/ux-modes.md).
- **In-chat bar** (shadow DOM, docked at top of chat). Basic: Tiho logo, the level
  switch, Show hidden. Advanced: one preset switch (Raw · Clean · Quiet · Questions),
  compact chips per category with what is in chat now; click a chip for Solo (only
  that category, each row tagged with its reason and normal action), right-click to
  change its action. Expands to a mini dashboard (msgs/s sparkline, mood over the
  last 5 min, top waves, latest questions).
- **Show hidden / Solo**: per-tab views, never saved, one stylesheet swap each.
- **Message decorations**: left accent tint per category (Advanced), `?` glow for
  questions, collapsed pill "3 hidden · show", hover tooltip with reason ("toxic ·
  94%", "wave ×37", Advanced).
- **Popup**: Basic: level cards, Advanced mode switch. Advanced: on/off per site,
  preset, strictness, model status, open side panel.
- **Side panel**: Basic: one page (level, Advanced mode switch). Advanced: live view
  (in chat now, rate, mood, per-category control and Solo), Questions inbox, filtered
  log with reasons + "not spam" feedback, rules editor, Engine connection, model
  details.
- **Onboarding page**: model download progress + level pick (Clean or Quiet) and an
  Advanced mode checkbox.
- Respect platform light/dark theme; animations ≤ 150 ms, `prefers-reduced-motion`.

## 8. Performance rules

- One `MutationObserver` on the chat list container only (childList, no subtree when
  possible). Never poll the whole DOM, never traverse shadow roots per tick.
- Read DOM in one pass, write attributes in one pass per frame (rAF), no forced
  layout (no `offsetHeight` reads in hot path).
- Content script holds only a bounded LRU (≤ 5k entries) and WeakMap for nodes.
- Inference: dynamic batching (max 64, max wait 12 ms ≈ 1 frame), dedup across
  requests and tabs, LRU cache 20k in offscreen. Under load the newest texts go
  first; a text not asked for again within 2 s is dropped, and above 4,096 queued
  texts new ones are rejected (their rows keep the rules-only verdict).
- Telemetry stays local: p50/p95 latency, msg/s, cache hit rate, shown in side panel.

## 9. Testing

- Unit (vitest): normalize, rules, waves, policy, runtime, inference, engine client,
  UI, adapters against saved HTML fixtures.
- Perf harness: `extension/tests/stress/` a mock chat page per platform skin that
  emits N msg/s from the real collected corpus; Playwright runs the content-script
  runtime on it (and, in `ext-smoke.mjs`, the real built extension) and measures
  main-thread cost, long tasks, frame drops, latency.
- Live sites: `extension/tests/tools/live-check.mjs` runs the adapters on a real live
  page and reports extracted vs. skipped rows.
- ML eval: average precision and cross-validated precision / recall / F1 per label
  on the gold set, macro-F1 per stream language.
