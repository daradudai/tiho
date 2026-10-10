# Hush — specification (v1)

> An ad-blocker for live chat. Hush reads YouTube / Twitch / Kick live chat as it
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
- Multilingual: every language the base model saw (mmBERT: 1800+), tuned on real
  chat in EN, ES, DE, PT, FR, RU, BG, PL, TR, IT, JA, KO, …
- Zero setup: install → open a stream → it works. Model downloads once and is
  cached.
- Optional **Hush Engine**: a local GPU server (RTX-class) running an open
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
      core/         platform-agnostic: types, pipeline, rules, waves, cache, settings
      platforms/    youtube.ts, twitch.ts, kick.ts  (DOM adapters)
      inference/    offscreen host + worker running ONNX model (WebGPU → WASM)
      ui/           overlay (in-chat, shadow DOM), popup, sidepanel, onboarding
      entrypoints/  WXT entrypoints (content scripts, background, offscreen, pages)
    tests/          vitest unit + playwright e2e (mock chat + live smoke)
  engine/           Hush Engine: local server (Python, FastAPI) in front of
                    llama.cpp `llama-server` running Clef-Flash; also serves the
                    student ONNX on CUDA for bulk/benchmarks.
  ml/               data collection, labeling (gold + teacher), training,
                    ONNX export/quantization, evaluation, benchmarks.
  docs/             architecture notes, model card, screenshots.
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
  paid?: boolean         // superchat / bits / kicks — never hidden by default
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

`clean` = none of 0–3 above threshold. Labels are independent (a message can be
`toxic` + `negative`). Thresholds per label are calibrated on the gold set and
shipped in `model/config.json` as `hush.thresholds`.

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
                          Hush Engine (localhost) ─▶ refine
```

Actions: `show` | `highlight` | `dim` | `collapse` (thin "hidden" pill) | `hide`.
Applied by setting ONE attribute (`data-hush-a="dim"` etc.) plus category
attribute `data-hush-c`; all visuals live in one injected stylesheet so the
browser does a single style recalc per frame.

Hold policy: when a category the user hides is ML-dependent, new messages are
held invisible (`visibility:hidden`, no layout shift... see adapter notes) for at
most `holdMs` (default 250 ms). If inference does not answer in time the message
is shown and re-evaluated when the score lands (can still collapse later).

Never hidden by default: broadcaster, moderators, paid messages, messages that
mention the viewer.

### Tier 0 rules (core/rules.ts)
- user allow/block lists (users, words, regex)
- `!command` → noise
- link detection (with allow-list of harmless domains: clips.twitch.tv, youtu.be when
  posted by mods, …) → scam signal
- char/emote floods, caps ratio, repeated tokens → spam signal
- duplicate by same user within 30 s → spam
- **Waves**: SimHash over normalized text in a 10 s sliding window across users.
  When ≥ N users post near-identical text the wave is detected; first message stays,
  the rest collapse into a live counter on it ("KEKW ×37"). Waves are culture, not
  spam: shown compact by default.

### Normalization (core/normalize.ts)
NFKC, lowercase, strip zero-width & combining abuse, map homoglyphs/leet
(`fr33 r0bux` → `free robux`), collapse char repeats (`soooo` → `soo`), trim. The
cache key is the normalized text; the model sees the original (lightly cleaned).

## 5. In-browser model ("Hush Lite")

- Base: `jhu-clsp/mmBERT-small` (ModernBERT arch, 140 M params, 256k vocab, MIT).
- Fine-tuned multi-label head (7 sigmoid outputs), max_len 64 tokens.
- Training data: real chat (Twitch IRC collection, YouTube/Kick samples) labeled by
  a teacher (Clef-Flash decision model on the RTX 3090) + moderator-deletion weak
  labels + public datasets (toxicity / spam) + synthetic hard cases. Gold eval set
  hand-labeled (multilingual) by Claude agents and spot-checked.
- Export: ONNX, int8 (and fp16 for WebGPU), loaded with transformers.js v4.
- Budget: ≤ 150 MB download, p95 ≤ 25 ms for a batch of 32 on a mid GPU, ≥ 300 msg/s
  on WASM (4 threads) on a mid laptop CPU. Cached by text, so effective throughput is
  much higher.

## 6. Hush Engine (optional, local GPU)

- `engine/`: FastAPI on `127.0.0.1:7377`. Endpoints:
  - `GET /health` → model, device, version
  - `POST /v1/classify` `{messages:[{text, author, channel}], filters:[{id, question}]}`
    → per message: student scores (CUDA ONNX) + answers to custom filters from Clef.
- Clef-Flash (9B, GGUF Q8_0) via llama.cpp `llama-server` decision endpoint.
- Batches, dedups and caches. Extension auto-detects it; status shown in UI.

## 7. UI

- **In-chat bar** (shadow DOM, docked at top of chat): Hush logo, live "calm meter"
  (filtered %), one preset switch (Raw · Chill · Focus · Questions), compact chips per
  category with live counters; click chip cycles show/dim/collapse/hide. Expands to a
  mini dashboard (msgs/s sparkline, vibe trend, top waves).
- **Message decorations**: left accent tint per category, `?` glow for questions,
  collapsed pill "3 hidden · show", hover tooltip with reason ("toxic · 94%", "wave ×37").
- **Popup**: on/off per site, preset, model status, open side panel.
- **Side panel**: dashboard (stats, vibe timeline), Questions inbox, filtered log with
  reasons + "not spam" feedback, rules editor, Engine connection, model details.
- **Onboarding page**: model download progress + quick preset pick.
- Respect platform light/dark theme; animations ≤ 150 ms, `prefers-reduced-motion`.

## 8. Performance rules

- One `MutationObserver` on the chat list container only (childList, no subtree when
  possible). Never poll the whole DOM, never traverse shadow roots per tick.
- Read DOM in one pass, write attributes in one pass per frame (rAF), no forced
  layout (no `offsetHeight` reads in hot path).
- Content script holds only a bounded LRU (≤ 5k entries) and WeakMap for nodes.
- Inference: dynamic batching (max 64, max wait 1 frame), dedup within batch,
  LRU cache 20k in offscreen.
- Telemetry stays local: p50/p95 latency, msg/s, cache hit rate, shown in side panel.

## 9. Testing

- Unit (vitest): normalize, rules, waves, policy, adapters against saved HTML fixtures.
- Perf harness: `extension/tests/stress/` a mock chat page per platform skin that
  emits N msg/s from the real collected corpus; Playwright loads the unpacked
  extension and measures long tasks, frame drops, latency.
- Live smoke (Playwright, headed Chrome): open a live stream on each platform, assert
  messages get `data-hush-c` within 1 s.
- ML eval: macro-F1 per label on gold set, per language.
