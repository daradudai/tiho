# Privacy

Tiho filters live chat on your own device. It has no server, no account, no analytics and no telemetry. Chat messages never leave your computer.

This page explains exactly what the extension reads, stores and sends, so you can check it against the code. It covers Tiho 0.1.

## What Tiho reads

- **Chat on YouTube, Twitch and Kick.** A content script reads each new chat row on those sites: author name, badges (to know who is a moderator or VIP), message text, emotes and whether it is a paid message. That is what gets classified.
- **Your own username, where possible.** On Twitch (from the `login` cookie or the user menu) and on YouTube (from the name above the chat box), so that messages mentioning you are never hidden. It is used in the page and never stored or sent.
- **The chat's theme** (light or dark), so the bar matches the site.
- **The addresses of the frames in open YouTube, Twitch and Kick tabs**, once, when Tiho is installed or updated, to find the chats that are already open and start Tiho in them without a reload.

Tiho does not read anything else on those pages, and does not run on any other site.

## Where the work happens

Every message is classified inside your browser, by a model running in an offscreen extension document on your GPU (WebGPU) or CPU (WebAssembly). The ONNX Runtime code ships inside the extension; Chrome's Manifest V3 forbids loading code from the internet, and Tiho does not try.

## What Tiho stores

| What | Where | How long |
|---|---|---|
| Your settings, presets, rules, custom filter questions and per-channel stream context | `chrome.storage.local` (this browser only, not synced) | until you remove the extension |
| "Not spam" feedback: the message text, author, platform, channel and the original verdict, at most 500 entries, kept for future tuning | `chrome.storage.local` | until you remove the extension; never uploaded |
| The model files, if they were downloaded instead of bundled | the extension's Cache Storage | until an update with other model files replaces them, or you remove the extension |
| The model's current status | `chrome.storage.session` | until the browser closes |
| The filtered log (at most 200 messages) and the questions inbox (at most 100) | memory of the chat tab | until you close or reload the tab |

Removing the extension deletes all of it.

## What Tiho sends over the network

Only two kinds of requests:

1. **The model download**, once, and only in a build made to download it. Release zips include the model, so they never download it, and there is no default download location. Someone who builds Tiho from source can compile in a URL to fetch the model from instead (`WXT_TIHO_MODEL_URL`); such a build fetches the model files from that URL, checks each one against the SHA-256 hash compiled into it, and uses nothing that does not match. No chat text is sent. Like any download, the host sees your IP address and the files requested.
2. **Tiho Engine, if you turn it on.** It is off by default, and while it is off the extension sends it nothing. (The one exception is a status check without any chat text: if the extension's background worker does not answer, the side panel asks the engine URL for its status directly.) When you turn the engine on, the extension's background service worker checks the engine's status every few seconds and sends it the text of chat messages that reached the in-browser model (with the platform name), your custom filter questions and any stream context you typed. All of it goes only to the engine URL in your settings, by default `http://127.0.0.1:7377`, which is your own computer: with that URL none of it leaves your machine. If you change the URL to another host, all of it goes there instead, so only do that for a machine you control.

The `127.0.0.1` and `localhost` entries in the extension's permissions exist for Tiho Engine. A build made to download the model also lists the host it downloads from; release zips list none.

## Tiho Engine

The optional engine (`engine/`) runs on your machine:

- It and its llama.cpp child listen on `127.0.0.1` only.
- It accepts requests only from browser-extension and localhost origins and checks the `Host` header, so web pages cannot use it. The llama.cpp child it starts is locked with a random API key that is new on every run and known only to the engine.
- Message text is kept only in an in-memory cache (up to 50,000 entries) and is never logged by the engine. The HTTP access log is off by default.
- On first start it downloads llama.cpp from GitHub and the Clef-Flash model from Hugging Face.

## Permissions

| Permission | Why |
|---|---|
| `storage` | settings, rules, feedback and the model's status. A build made to download the model caches one model file and the tokenizer (119 to 126 MB) in Cache Storage, which needs no extra permission. |
| `offscreen` | runs the model in an offscreen document shared by all tabs |
| `sidePanel` | the dashboard |
| `scripting` | after an install or update, start Tiho in chats that are already open, so they filter without a reload |
| YouTube, Twitch, Kick hosts | read and decorate their live chat |
| `127.0.0.1`, `localhost` | talk to Tiho Engine |
| the model host (only in builds made with `WXT_TIHO_MODEL_URL`) | download the model from that host; for a Hugging Face URL also `*.hf.co`, where its files are served from. Release zips have no such entry. |

## Training data

The model was trained on public live-chat messages collected without an account, together with permissively licensed public datasets. Some message texts (without author names) were labeled by AI annotators (Claude) and by a local model. Raw chat logs are kept privately by the maintainer, used only to build training data, and never published or shared; only the trained model weights are. Details: [docs/MODEL_CARD.md](docs/MODEL_CARD.md).

Questions about any of this: write to [hello@tiho.chat](mailto:hello@tiho.chat) or [open an issue](https://github.com/daradudai/tiho/issues).
