# Chrome Web Store: what to paste where

Developer console: https://chrome.google.com/webstore/devconsole (account pesho.georgiev@gmail.com,
publisher "Tiho"). Fields are in the order the dashboard shows them. Everything in a code block is
meant to be copied as is.

The listing title and the short description come from the manifest, not from this page. Section 1 has
the values the release manifest carries; the text below assumes them.

---

## 0. Account (once)

| Field | Value |
|---|---|
| Publisher name | `Tiho` |
| Contact email | `hello@tiho.chat` (verify via the email that arrives in Gmail) |
| Trader / non-trader | **Non-trader** while the extension is free and published by a private person. Switch to Trader before any paid feature. |
| 2-Step Verification | must be on for the Google account |

## 1. Package

**+ New item** → upload `extension/.output-release/tiho-0.1.0-chrome.zip`: the release zip from
`TIHO_OUT=.output-release npx wxt zip` in `extension/`, model inside, 213 MB (213,422,366 bytes;
259 MB unpacked; v3 model `v3-6L+3L`; built 2026-10-11, same files as `.output-final/chrome-mv3`).

Inside the zip: `manifest.json`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `ort/` (ONNX Runtime Web) and
`models/tiho-lite/` with exactly `config.json`, `tokenizer.json`, `tokenizer_config.json`,
`onnx/model_quantized.onnx` (6-layer q8, WebGPU) and `onnx/model_uint8_3L.onnx` (3-layer uint8, CPU).

The release manifest (`extension/wxt.config.ts`) says exactly this. If it changes, the listing and the
justifications below no longer match:

| Manifest field | Value |
|---|---|
| `name` (listing title, max 75) | `Tiho — live chat filter` (23 characters) |
| `short_name` | `Tiho` |
| `description` (listing summary, max 132) | `Hides spam, scam links and abuse in YouTube, Twitch and Kick live chat. A small AI model runs on your own computer.` (115 characters) |
| `version` | `0.1.0` |
| `homepage_url` | `https://tiho.chat` |
| `action.default_title` | `Tiho` |
| `permissions` | `storage`, `offscreen`, `sidePanel`, `scripting` (no `unlimitedStorage`) |
| `host_permissions` | `*://*.youtube.com/*`, `*://*.twitch.tv/*`, `*://kick.com/*`, `*://*.kick.com/*`, `http://127.0.0.1/*`, `http://localhost/*` (nothing else: the release build bundles the model, so no model host) |
| `content_scripts` | one script on `www.youtube.com/live_chat*`, `www.twitch.tv`, `dashboard.twitch.tv` and `kick.com` |
| `minimum_chrome_version` | `124` |

## 2. Store listing

**Description** (plain text; the store keeps line breaks and the bullets)

```
Tiho hides spam, scam links and abuse in YouTube, Twitch and Kick live chat. A small AI model inside the extension reads each new message on your own computer. The chat never leaves it.

This is an early version. We're testing it on real streams right now, and it still makes mistakes: some abuse gets through, and now and then a normal message is hidden. Anything Tiho hides is one click away.

WHAT IT DOES
• Takes insults, harassment and scam links out of the chat.
• Folds spam into a small "2 hidden · show" line. Click it to see what's inside.
• Folds copy-paste waves: when many people post the same thing within a few seconds, you see it once with a count (KEKW ×37).
• Gives real questions a soft highlight, so they don't get lost in a fast chat.
• Leaves the streamer, moderators, VIPs and paid messages (Super Chats, Bits, Kicks) alone. On YouTube and Twitch it also leaves alone messages that mention you.
• "Show hidden" brings back everything Tiho took out of that chat, faded and tagged with why, until you press it again.

TWO WAYS TO USE IT
Basic (the default): pick Off, Clean or Quiet above the chat. That's all.
Advanced, for streamers and mods: choose what happens to each kind of message, add your own word, regex and user rules, set how strict it is, click a category to see only that one, and see live counts and a log of what was hidden. If Tiho hid something it shouldn't have, mark it "not spam" in the log and it stops hiding it.

WHERE IT STANDS
• Languages: so far we've checked it properly on English and about a dozen others. Other languages may work, but we haven't tested them.
• Your computer does the work, on the graphics card (WebGPU) or the processor. On older computers it can fall behind in very busy chats.
• The AI model is inside the extension, so the download is large (about 200 MB). After that it needs nothing from the internet.
• Free, no account. No analytics, no tracking, no Tiho server. Your settings and rules stay in this browser.

OPTIONAL: TIHO ENGINE
A separate app for people with a strong graphics card. It runs a larger AI model on your own computer and lets you write filters in plain words, like "hide backseating". You don't need it for anything above, and it is off until you turn it on.

Works in Chrome and Edge 124 or newer, on desktop. Questions and bug reports: hello@tiho.chat · https://tiho.chat
```

Before you submit: if Tiho Engine has no public download yet (the repo is private), delete the
"OPTIONAL: TIHO ENGINE" paragraph. The localhost justification below still holds, because the switch
for it is in the extension.

| Field | Value |
|---|---|
| Category | **Social Networking** (under Lifestyle) |
| Language | **English** |
| Store icon (128×128) | `extension/public/icon/128.png` |
| Screenshots (1280×800, up to 5) | `docs/store/img/screenshot-1.png` … `screenshot-5.png`, in that order (list below) |
| Small promo tile (440×280) | `docs/store/img/promo-small.png` |
| Marquee promo tile (1400×560) | `docs/store/img/promo-marquee.png` (optional) |
| Promo video | none |
| Homepage URL | `https://tiho.chat` |
| Support URL | `https://tiho.chat` (the page links `hello@tiho.chat`; the store takes no `mailto:`) |
| Mature content | **No** |

**Screenshots** (all 1280×800, 24-bit RGB, no alpha)

| File | Caption on the image | What it shows |
|---|---|---|
| `screenshot-1.png` | Hides spam, scam links and abuse in live chat | Twitch chat, dark, Basic bar on Clean, with notes on the pill, the wave count and the question highlight |
| `screenshot-2.png` | Anything it hides is one click away | The same Twitch chat on Clean and with Show hidden on, side by side |
| `screenshot-3.png` | One click: see only one category | Advanced: chat soloed on spam, each row tagged, next to the side panel's Categories card |
| `screenshot-4.png` | Runs on your computer. Nothing leaves it. | Advanced chat, the toolbar popup and the side panel's Live tab |
| `screenshot-5.png` | YouTube, Twitch and Kick | A YouTube chat (cricket, mostly Sinhala) and a Kick chat (CS2, Turkish), both on Clean |

Current set: captured 2026-10-11 with `.output-final/chrome-mv3` on twitch.tv/eslcs (ESL Pro League),
kick.com/maj3r and a YouTube cricket stream. The YouTube capture has YouTube's own "Welcome to live
chat!" notice in the middle of the list; re-run the capture if that bothers you.

The images are made from `docs/store/src/` (captions, layout, promo tiles) by
`extension/tests/tools/store-assets.mjs`, run in `extension/` against the release build:

```
node tests/tools/store-assets.mjs promo
node tests/tools/store-assets.mjs shots https://www.twitch.tv/<channel> https://kick.com/<channel> "https://www.youtube.com/watch?v=<id>" --ext .output-final/chrome-mv3
node tests/tools/store-assets.mjs compose   # again from docs/store/img/raw, after a caption change
```

Chatter names are replaced by fake handles (`tests/tools/anonymize.js`, also inside the bar) and the
channel name by "streamer"; rows with insults or slurs are waited out or blurred. Pick a busy chat in
English for Twitch and other languages for Kick and YouTube. Look at every image before uploading;
the chats are live and the model still makes mistakes. `docs/store/img/raw/` is input only, don't
upload it.

## 3. Privacy practices

**Single purpose**

```
Tiho filters live-chat messages on YouTube, Twitch and Kick for the viewer: an AI model that runs in the browser hides spam, scam links and abuse, folds repeated messages and highlights questions.
```

**Permission justifications** (one box per permission)

| Permission | Paste |
|---|---|
| `storage` | `Saves the user's settings, rules and "not spam" feedback in this browser (chrome.storage.local), and the AI model's status for the current browser session (chrome.storage.session). Nothing is synced or uploaded.` |
| `offscreen` | `Runs the bundled AI model in one offscreen document (reason WORKERS) shared by all tabs, so the model loads once and chat pages stay responsive.` |
| `sidePanel` | `Shows Tiho's side panel: live counts, the questions inbox, the log of hidden messages and the rules editor.` |
| `scripting` | `After install or update, starts Tiho in YouTube, Twitch and Kick chats that are already open, so filtering works without reloading those pages. Used on those sites only.` |

**Host permission justification** (one box for all of them; each pattern is named in it)

```
*://*.youtube.com/*: read new messages in YouTube live chat (the live_chat frame) and mark them as hidden, folded or highlighted.
*://*.twitch.tv/*: the same for Twitch chat on channel pages, popout chat and the creator dashboard.
*://kick.com/* and *://*.kick.com/*: the same for Kick chat.
http://127.0.0.1/* and http://localhost/*: talk to the optional Tiho Engine app on the user's own computer. It is off by default and used only after the user turns it on.
Tiho runs on no other site and sends chat to no server.
```

**Are you using remote code?** → **No, I am not using remote code.**

```
All JavaScript and WebAssembly (ONNX Runtime Web) is included in the package. The AI model is a data file bundled in the package. Nothing is loaded from the internet.
```

**Data usage**

- Tick **Website content**: Tiho reads chat messages on the supported sites in order to classify them.
  They are processed and stored only on the user's device (and, if the user turns on Tiho Engine, sent
  to that app on the user's own computer).
- Leave everything else unticked (no personally identifiable, health, financial, authentication or
  location data, no personal communications, no web history, no user activity).
- Tick all three certifications:
  - I do not sell or transfer user data to third parties, outside of the approved use cases
  - I do not use or transfer user data for purposes that are unrelated to my item's single purpose
  - I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**: `https://tiho.chat/privacy`

## 4. Distribution

| Field | Value |
|---|---|
| Visibility | **Public** |
| Regions | **All regions** |
| Pricing | Free |

## 5. Submit

**Submit for review.** Typical review is a few days; broad host access can take 1–3 weeks. After approval,
replace the "Coming soon to Chrome" button on https://tiho.chat (`site/public/index.html`) with the
store link and redeploy (`cd site && npx wrangler deploy`).
