---
license: mit
base_model: jhu-clsp/mmBERT-small
pipeline_tag: text-classification
library_name: onnx
language:
  - multilingual
  - en
  - es
  - ja
  - ru
  - pl
  - pt
  - th
  - tr
  - de
  - ar
  - fr
  - it
  - uk
  - bg
tags:
  - live-chat
  - moderation
  - toxicity
  - spam
  - multi-label
  - modernbert
  - onnx
  - transformers.js
datasets:
  - google/civil_comments
  - FredZhang7/toxi-text-3M
  - thehamkercat/telegram-spam-ham
  - wangyuancheng/discord-phishing-scam
  - FredZhang7/all-scam-spam
  - clapAI/MultiLingualSentiment
---

# Model card: Hush Lite v2-9L

Hush Lite is the small multilingual classifier inside the [Hush](../README.md) browser extension. It reads one live-chat message at a time and gives seven independent probabilities: is it toxic, spam, a scam, low-effort noise, a question, positive, negative. The extension turns those into show / highlight / dim / fold / hide, on the viewer's own device.

| | |
|---|---|
| Version | `v2-9L` (`config.json` → `hush.version`) |
| Base model | [jhu-clsp/mmBERT-small](https://huggingface.co/jhu-clsp/mmBERT-small) (ModernBERT architecture, MIT) |
| Architecture | ModernBERT encoder, 9 layers (layers 0-2, 9-11 and 18-20 of the 22-layer base), hidden size 384, 6 heads, mean pooling, linear head with 7 outputs |
| Parameters | 115.7M total: 98.3M in the 256k-token embedding table, 17.4M in the encoder layers and head |
| Input | one message, at most 64 tokens (whitespace runs collapsed to one space) |
| Output | 7 logits; apply a sigmoid per label. Labels are independent (multi-label). |
| Thresholds | per label, in `config.json` → `hush.thresholds` |
| Runtime | ONNX Runtime Web (WebGPU or WASM) with the Transformers.js tokenizer |
| License | MIT |

## Intended use

- **In scope:** filtering what *one viewer* sees in a live-stream chat (YouTube, Twitch, Kick), with the viewer in control: every filtered message can be shown again with one click, every category's action is a setting, and a strictness slider moves the thresholds.
- **Out of scope:** automated moderation that acts on other people (deleting messages, timeouts, bans), any decision about a person (scoring or profiling users), content outside short live-chat messages (long posts, articles, DMs), and use as a measure of how toxic a community or language is. The model sees one message without context, makes mistakes at the rates below, and was evaluated against AI annotators, not human moderators.

## Labels

These are the definitions the gold and silver annotators followed (abridged from [`ml/gold/gold_workflow.js`](../ml/gold/gold_workflow.js)):

| Label | Means | Does not include |
|---|---|---|
| `toxic` | insult, harassment, hate, slur, threat or sexual harassment aimed at someone (the streamer, a chatter, a group) | swearing at a game or situation, friendly banter, self-deprecation, gaming violence ("kill him") |
| `spam` | flood, copypasta, walls of repeated characters, words or emotes, keyboard mash, ASCII art | |
| `scam` | self-promotion, bots, fake giveaways, "free X", crypto, gambling and betting promos, viewer or follower selling, "check my channel", phishing, ad copy | |
| `noise` | low-effort reaction with no content: one emote or word (`W`, `L`, `lol`, `KEKW`, `first`, `?`, `F`, `+1`) | anything that says something: an opinion, a fact, a joke with content |
| `question` | a genuine question to the streamer or chat | a bare `?` or `what??` outburst (that is noise) |
| `positive` | clearly supportive, kind, grateful, excited or hype | plain neutral statements |
| `negative` | clearly complaining, critical, annoyed or hostile (toxic messages are also negative) | plain neutral statements |

A message with all labels below threshold is "clean" (normal chat).

## Training data

All text the model saw is short and chat-like. Raw chat logs are **never published**; only the trained weights are.

**Real chat (unlabeled pool).** About 550k unique messages collected from public live chats without logging in: Twitch over IRC (no account), Kick over its public Pusher websocket, YouTube through the innertube live-chat endpoint the chat popout itself uses. Channels were picked to cover about 30 stream languages. Messages deleted by moderators, or sent just before their author was timed out or banned, were recorded as weak signals and oversampled into the pool that was sent for labeling. Collectors: [`ml/collect/`](../ml/collect/).

**Teacher labels.** [Cloudflare Clef-Flash](https://huggingface.co/Cloudflare/clef-flash) (9B, a Jev/SystemOne-compatible decision model, Apache-2.0) ran zero-shot through llama.cpp on one RTX 3090, with a compact schema: one 6-way category question (`clean, question, noise, spam, scam, toxic`) and one 3-way tone question (`positive, neutral, negative`). It labeled about 42k messages at 6 to 10 messages per second; v2 was trained on the 24.5k that were done at the time (22.1k train, 2.5k validation). The teacher's probabilities are used as soft targets. See [`ml/teacher/label.py`](../ml/teacher/label.py).

**Silver labels.** About 12k real messages annotated by Claude agents following the gold guideline above, plus 5.8k more chosen by active learning (messages where the v1 student was most uncertain). Silver rows get 3x weight in the loss. Annotators saw only the message text, the platform and the channel's language, never the author's name (a message can still @mention someone).

**Synthetic hard cases.** About 3.6k labeled messages in 28 languages, written for this project, for cases real chat shows too rarely: harmful messages next to similar harmless ones per language group, leetspeak insults (`1d10t`), Bulgarian in both Cyrillic and Latin transliteration, and profanity without a target as hard negatives for `toxic` (Polish `kurwa jaka akcja` is an excited reaction, not an insult).

**Public datasets** (permissive licenses only; each one supervises only the labels it knows, the rest of the loss is masked; 0.5x weight):

| Dataset | License | Used for |
|---|---|---|
| [google/civil_comments](https://huggingface.co/datasets/google/civil_comments) | CC0 | toxic (soft scores) |
| [FredZhang7/toxi-text-3M](https://huggingface.co/datasets/FredZhang7/toxi-text-3M) | Apache-2.0 | toxic, 55 languages |
| [thehamkercat/telegram-spam-ham](https://huggingface.co/datasets/thehamkercat/telegram-spam-ham) | WTFPL | scam |
| [wangyuancheng/discord-phishing-scam](https://huggingface.co/datasets/wangyuancheng/discord-phishing-scam) | MIT | scam |
| [FredZhang7/all-scam-spam](https://huggingface.co/datasets/FredZhang7/all-scam-spam) | Apache-2.0 | scam, multilingual |
| [clapAI/MultiLingualSentiment](https://huggingface.co/datasets/clapAI/MultiLingualSentiment) | Apache-2.0 | positive, negative |
| [YouTube Spam Collection](https://archive.ics.uci.edu/dataset/380/youtube+spam+collection) (Alberto, Lochter, Almeida; UCI ML Repository) | CC BY 4.0 | scam (self-promotion comments) |

Every gold message was removed from the teacher, silver and distillation sets by exact text match.

## Training procedure

| Step | What changed | Gold macro AP |
|---|---|---|
| v0 | mmBERT-small (22 layers) fine-tuned on 7k teacher labels + public data + synthetic | 0.627 |
| v1 | + 12k silver labels, more teacher labels | 0.778 |
| v2 | + 5.8k active-learning labels, synthetic v2, 22k teacher labels; 4 epochs | 0.816 |
| **v2-9L** | v2 cut to 9 layers and distilled | **0.822** |
| v2-6L | v2 cut to 6 layers and distilled | TODO(lead) |

<!-- TODO(lead): fill the v2-6L row (gold macro AP, per-label AP, ONNX sizes) when its run finishes, and say which model ships. -->

- **Fine-tuning** ([`ml/train/train.py`](../ml/train/train.py)): binary cross-entropy per label with masks for partial labels, 2x weight on the rare `toxic` and `scam` heads, AdamW (lr 6e-5, weight decay 0.01), cosine schedule with 6% warm-up, batch 64, bf16, max 64 tokens. v2 took 16 minutes on one RTX 3090.
- **Distillation** ([`ml/train/distill.py`](../ml/train/distill.py)): the student starts from v2's own layers. ModernBERT alternates one global-attention layer with two local ones, so whole aligned blocks of three are kept (blocks 0, 3, 6 → layers 0-2, 9-11, 18-20) to preserve each layer's attention type. Targets are v2's probabilities on 551k unlabeled real messages, plus the 21k labeled rows, where the hard label is mixed 50/50 with v2's probability. 3 epochs, lr 1e-4, batch 128, 12 minutes. The distilled model matches v2 on the gold set while doing about 40% of the per-token compute.
- **Thresholds** ([`ml/train/evaluate.py`](../ml/train/evaluate.py)): chosen per label on the gold set to maximize F-beta, with beta 0.7 for `toxic`, `spam` and `scam` (precision counts more: hiding a good message is worse than missing a bad one) and beta 1 for the others. Shipped thresholds are fit on all 2,000 gold messages: toxic 0.23, spam 0.47, scam 0.13, noise 0.41, question 0.49, positive 0.19, negative 0.13.

## Evaluation

**Gold set.** 2,000 real messages that were in no training pool, from all three platforms (Twitch 1,153, Kick 584, YouTube 263), from channels in about 30 stream languages (largest: English 361, Spanish 179, Japanese 158, Russian 146, Polish 140, Portuguese 121). Rare classes were oversampled using the teacher's scores so that every label has enough positives: toxic 103, scam 86, spam 94, noise 419, question 276, positive 301, negative 296. Two Claude annotators labeled every message independently with the guideline above; they agreed on all seven labels for 92% of messages, and a third Claude agent settled the rest. No human labeled the set, so it measures agreement with careful AI annotators, not with human moderators.

**Ranking quality**, average precision per label (threshold-free):

| | toxic | spam | scam | noise | question | positive | negative | macro |
|---|---|---|---|---|---|---|---|---|
| Teacher, Clef-Flash 9B zero-shot | 0.609 | 0.619 | 0.845 | 0.608 | 0.925 | 0.786 | 0.653 | 0.721 |
| **Hush Lite v2-9L** | **0.632** | **0.910** | **0.883** | **0.933** | **0.938** | **0.778** | **0.680** | **0.822** |

The student beats its teacher mostly on `spam` and `noise`. A likely reason: the silver labels follow the gold guideline's definitions, while the teacher answered from its own one-line label descriptions.

**At calibrated thresholds**, calibrated on a random half of the gold set and scored on the other half (1,000 messages):

| | toxic | spam | scam | noise | question | positive | negative |
|---|---|---|---|---|---|---|---|
| Precision | 0.61 | 0.94 | 0.88 | 0.86 | 0.93 | 0.68 | 0.59 |
| Recall | 0.44 | 0.68 | 0.71 | 0.82 | 0.88 | 0.73 | 0.66 |
| F1 | 0.51 | 0.79 | 0.79 | 0.84 | 0.91 | 0.71 | 0.62 |

Macro F1 0.74. Positives in that half: toxic 45, spam 47, scam 31, so these numbers carry a margin of several points.

**By stream language**, macro F1 on the same held-out half, languages with at least 40 messages. "Language" is the channel's declared stream language, not a per-message detection, and the samples are small, so read these as rough signals:

| en | ja | ar | th | fr | tr | pt | es | pl | ru |
|---|---|---|---|---|---|---|---|---|---|
| 0.77 (186) | 0.80 (86) | 0.80 (41) | 0.76 (46) | 0.74 (43) | 0.72 (42) | 0.70 (70) | 0.66 (79) | 0.60 (64) | 0.59 (82) |

**Export parity.** Each ONNX file was compared with the PyTorch fp32 model on 533 real chat lines; "flips" are label decisions that change at the shipped thresholds ([`ml/export/export_onnx.py`](../ml/export/export_onnx.py)).

| File | Precision | Size | Mean \|Δp\| | Flips | Used by the extension for |
|---|---|---|---|---|---|
| `onnx/model_quantized.onnx` | q8: int8 weight-only MatMulNBits, int8 embeddings, fp32 activations | 119.0 MB | 0.0004 | 0.08% | WebGPU (default) |
| `onnx/model_uint8.onnx` | uint8: dynamic int8 (MatMulInteger) | 116.9 MB | 0.0043 | 0.51% | WASM / CPU (default) |
| `onnx/model_q4f16.onnx` | q4f16: 4-bit weights and embeddings, fp16 | 65.2 MB | 0.0080 | 0.72% | WebGPU, smallest |
| `tokenizer.json` | | 13.7 MB | | | both |

The 256k-token vocabulary is most of the size: the embedding table is 85% of the parameters.

## Limitations

- **It misses a lot of toxicity.** At the shipped threshold, toxic recall is 0.44: more than half of the toxic messages in the gold set get through. This is a deliberate trade for precision (0.61), but 4 in 10 messages flagged toxic are not. The strictness slider trades the other way.
- **One message, no context.** The model never sees the stream, the conversation, earlier messages or who is talking to whom. Sarcasm, in-jokes, copypasta that is a community meme, and replies that are only rude in context are hard.
- **Emote language.** Emotes reach the model as their codes (`KEKW`, `OMEGALUL`, channel emotes like `xqcL`). Meanings drift by community and the model knows only what it saw in training.
- **Uneven languages.** Russian, Polish and Spanish score below English and Japanese on the gold set. Languages with little or no real chat in training rely on what mmBERT learned in pre-training and on public data, and are unmeasured.
- **Real chat has fewer bad messages than the test set.** Toxic, scam and spam messages were oversampled into the gold set so each label has enough examples. In real chat they are rarer, so a larger share of what gets flagged is a false alarm than the precision above suggests.
- **The yardstick is an AI.** Gold and silver labels come from Claude agents following a written guideline. Errors and blind spots shared by those annotators are invisible to this evaluation, and the student partly learned the same annotators' judgment.
- **Optimistic selection.** The best epoch of each run was chosen by gold-set AP, and gold texts were removed from training by exact match only, so near-duplicates (the same copypasta with small edits) may appear on both sides.
- **Short input.** Messages are cut at 64 tokens.

## Bias and fairness

- Classifiers trained on toxicity data are known to over-flag dialects, reclaimed slurs and identity terms used neutrally or positively. We have not measured this for Hush Lite. If it happens to you or your community, please [report it](https://github.com/daradudai/hush/issues/new/choose).
- Public toxicity datasets lean toward English and Western online discourse.
- Mitigations in the product: the broadcaster, moderators and VIPs are never filtered by default, every filtered message stays one click away with the reason shown, and "not spam" feedback creates an allow rule immediately.

## Privacy

- Inference runs entirely in the user's browser. Messages go nowhere else, except to the user's own Hush Engine if they run one.
- Training chat was collected without accounts from public chats. Usernames were not given to the AI annotators. Raw logs stay on the maintainer's machine and are not redistributed; only model weights are.

## Reproducing

The pipeline and its commands are in [ml/README.md](../ml/README.md). It needs a CUDA GPU (training and the teacher ran on one RTX 3090) and re-collecting chat, since raw logs are not published.

## Credits

Base model: mmBERT by the Johns Hopkins University CLSP team. Teacher: Clef-Flash by Cloudflare, served with llama.cpp. Public data: see the table above; the UCI YouTube Spam Collection is used under CC BY 4.0 (T. C. Alberto, J. V. Lochter, T. A. Almeida, "TubeSpam: Comment Spam Filtering on YouTube", ICMLA 2015).
