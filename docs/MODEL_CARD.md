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

# Model card: Hush Lite v2-6L + v2-3L

Hush Lite is the small multilingual classifier inside the [Hush](../README.md) browser extension. It reads one live-chat message at a time and gives seven independent probabilities: is it toxic, spam, a scam, low-effort noise, a question, positive, negative. The extension turns those into show / highlight / dim / fold / hide, on the viewer's own device.

It is adaptive: one model folder holds two students distilled from the same 22-layer model, and the extension loads the one that suits the device. **v2-6L** (6 layers) runs on the GPU through WebGPU; **v2-3L** (3 layers) runs on the CPU through WebAssembly, where compute is scarcer. Both share the tokenizer, and each browser loads only one of them.

| | |
|---|---|
| Version | `v2-6L+3L` (`config.json` → `hush.version`); per file `v2-6L` or `v2-3L` (`hush.variant_info`) |
| Base model | [jhu-clsp/mmBERT-small](https://huggingface.co/jhu-clsp/mmBERT-small) (ModernBERT architecture, MIT) |
| Architecture | ModernBERT encoder, hidden size 384, 6 heads, mean pooling, linear head with 7 outputs. v2-6L keeps layers 0-2 and 18-20 of the 22-layer v2, v2-3L keeps layers 0-2. |
| Parameters | v2-6L 110.0M, v2-3L 104.2M. Of each, 98.3M is the 256k-token embedding table; the encoder layers and head are 11.7M and 5.9M. |
| Input | one message, at most 64 tokens, lightly cleaned as the extension does it: invisible characters dropped, zalgo stacks squashed, blanks collapsed to one space; case, emoji and repeated characters kept ([`ml/train/textclean.py`](../ml/train/textclean.py), a port of the extension's `cleanForModel`) |
| Output | 7 logits; apply a sigmoid per label. Labels are independent (multi-label). |
| Thresholds | per label and per student: `config.json` → `hush.thresholds` (v2-6L) and `hush.variant_thresholds.uint8` (v2-3L) |
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

**Real chat (unlabeled pool).** About 680k unique messages by the last training run, collected from public live chats without logging in: Twitch over IRC (no account), Kick over its public Pusher websocket, YouTube through the innertube live-chat endpoint the chat popout itself uses. Channels were picked to cover about 30 stream languages. Messages deleted by moderators, or sent just before their author was timed out or banned, were recorded as weak signals and oversampled into the pool that was sent for labeling. Collectors: [`ml/collect/`](../ml/collect/).

**Teacher labels.** [Cloudflare Clef-Flash](https://huggingface.co/Cloudflare/clef-flash) (9B, a Jev/SystemOne-compatible decision model, Apache-2.0) ran zero-shot through llama.cpp on one RTX 3090, with a compact schema: one 6-way category question (`clean, question, noise, spam, scam, toxic`) and one 3-way tone question (`positive, neutral, negative`). It labeled about 42k messages at 6 to 10 messages per second; v2 was trained on the 24.5k that were done at the time (22.1k train, 2.5k validation). The teacher's probabilities are used as soft targets. See [`ml/teacher/label.py`](../ml/teacher/label.py).

**Silver labels.** About 12k real messages annotated by Claude agents following the gold guideline above, plus 5.8k more chosen by active learning (messages where the v1 student was most uncertain). Silver rows get 3x weight in the loss. Annotators saw only the message text, the platform and the channel's language, never the author's name (a message can still @mention someone).

**Synthetic hard cases.** About 3.6k labeled messages in 28 languages, written for this project, for cases real chat shows too rarely: harmful messages next to similar harmless ones per language group, leetspeak insults (`1d10t`), Bulgarian in both Cyrillic and Latin transliteration, and profanity without a target as hard negatives for `toxic` (Polish `kurwa jaka akcja` is an excited reaction, not an insult).

**Public datasets** (permissive licenses only; each one supervises only the labels it knows, the rest of the loss is masked; 0.3x weight; v2 drew 22k rows at random from all of them together, as many as it had teacher rows):

| Dataset | License | Used for |
|---|---|---|
| [google/civil_comments](https://huggingface.co/datasets/google/civil_comments) | CC0 | toxic (soft scores) |
| [FredZhang7/toxi-text-3M](https://huggingface.co/datasets/FredZhang7/toxi-text-3M) | Apache-2.0 | toxic, 55 languages |
| [thehamkercat/telegram-spam-ham](https://huggingface.co/datasets/thehamkercat/telegram-spam-ham) | WTFPL | scam |
| [wangyuancheng/discord-phishing-scam](https://huggingface.co/datasets/wangyuancheng/discord-phishing-scam) | MIT | scam |
| [FredZhang7/all-scam-spam](https://huggingface.co/datasets/FredZhang7/all-scam-spam) | Apache-2.0 | scam, multilingual |
| [clapAI/MultiLingualSentiment](https://huggingface.co/datasets/clapAI/MultiLingualSentiment) | Apache-2.0 | positive, negative |
| [YouTube Spam Collection](https://archive.ics.uci.edu/dataset/380/youtube+spam+collection) (Alberto, Lochter, Almeida; UCI ML Repository) | CC BY 4.0 | scam (self-promotion comments) |

Gold texts are removed from every training set by exact match (after the cleaning in the Input row) and kept out of the labeling pools. v2 predates part of that: 10 very short gold texts, such as `boo`, `yikes` and `KEKW KEKW KEKW`, were also in its synthetic or public data and were trained on.

## Training procedure

| Step | What changed | Gold macro AP |
|---|---|---|
| v0 | mmBERT-small (22 layers) fine-tuned on 7k teacher labels + public data + synthetic | 0.627 |
| v1 | + 12k silver labels, more teacher labels | 0.778 |
| v2 | + 5.8k active-learning labels, synthetic v2, 22k teacher labels; 4 epochs | 0.816 |
| v2-9L | v2 cut to 9 layers and distilled | 0.822 |
| **v2-6L** | v2 cut to 6 layers and distilled; **shipped for WebGPU** | **0.822** |
| **v2-3L** | v2 cut to 3 layers and distilled; **shipped for the CPU** | **0.815** |

- **Fine-tuning** ([`ml/train/train.py`](../ml/train/train.py)): binary cross-entropy per label with masks for partial labels, 2x weight on the rare `toxic` and `scam` heads, AdamW (lr 6e-5, weight decay 0.01), cosine schedule with 6% warm-up, batch 64, bf16, max 64 tokens. v2 took 16 minutes on one RTX 3090.
- **Distillation** ([`ml/train/distill.py`](../ml/train/distill.py)): each student starts from v2's own layers. ModernBERT alternates one global-attention layer with two local ones, and a layer's type (and its RoPE base) follows from its index, so whole aligned blocks of three are kept to preserve each layer's attention type: blocks 0 and 6 (layers 0-2 and 18-20) for v2-6L, block 0 (layers 0-2) for v2-3L. Targets are v2's probabilities on every unique unlabeled real message collected so far (614k for v2-6L, 682k for v2-3L), plus the 21k labeled rows, where the hard label is mixed 50/50 with v2's probability. 3 epochs, lr 1e-4, batch 128: 11 minutes for v2-6L, 8 for v2-3L. The students match v2 on the gold set (v2-6L) or come within 0.001 macro AP (v2-3L) while running 6 or 3 encoder layers instead of 22. v2 and both students were trained on text that was at most whitespace-collapsed; the scripts now apply the extension's own cleaning everywhere, which moves the shipped students' gold AP by at most 0.003 per label.
- **Combining** ([`ml/export/combine_variants.py`](../ml/export/combine_variants.py)): both students are exported separately, then one folder takes the 6-layer `q8` and `q4f16` files and the 3-layer `uint8` file, checks that the tokenizers are identical, and records each file's layers, version and thresholds.
- **Thresholds** ([`ml/train/evaluate.py`](../ml/train/evaluate.py)): chosen per label and per student on the gold set to maximize F-beta, with beta 0.7 for `toxic`, `spam` and `scam` (precision counts more: hiding a good message is worse than missing a bad one) and beta 1 for the others. Shipped thresholds are fit on all 2,000 gold messages; their precision and recall below are estimated by cross-validation. v2-6L: toxic 0.22, spam 0.53, scam 0.22, noise 0.44, question 0.52, positive 0.26, negative 0.10. v2-3L: toxic 0.17, spam 0.34, scam 0.23, noise 0.45, question 0.39, positive 0.28, negative 0.10.

## Evaluation

**Gold set.** 2,000 real messages, chosen from chat that was in no labeling pool at the time and kept out of training (see above), from all three platforms (Twitch 1,153, Kick 584, YouTube 263), from channels in about 30 stream languages (largest: English 361, Spanish 179, Japanese 158, Russian 146, Polish 140, Portuguese 121). Rare classes were oversampled using the teacher's scores so that every label has enough positives: of 5,000 candidates, 1,090 were picked because the teacher scored them high for some label, and the other 910 at random from the remaining 3,910. Positives: toxic 103, scam 86, spam 94, noise 419, question 276, positive 301, negative 296. Two Claude annotators labeled every message independently with the guideline above; they agreed on all seven labels for 92% of messages, and a third Claude agent settled the rest. No human labeled the set, so it measures agreement with careful AI annotators, not with human moderators.

Every number below scores the students on the text exactly as the extension feeds it to the model ([`ml/train/textclean.py`](../ml/train/textclean.py)).

**Ranking quality**, average precision per label (threshold-free):

| | toxic | spam | scam | noise | question | positive | negative | macro |
|---|---|---|---|---|---|---|---|---|
| Teacher, Clef-Flash 9B zero-shot | 0.609 | 0.619 | 0.845 | 0.608 | 0.925 | 0.786 | 0.653 | 0.721 |
| **Hush Lite v2-6L** (WebGPU) | **0.623** | **0.910** | **0.894** | **0.931** | **0.940** | **0.782** | **0.674** | **0.822** |
| **Hush Lite v2-3L** (CPU) | **0.618** | **0.902** | **0.882** | **0.930** | **0.935** | **0.771** | **0.663** | **0.815** |

The students beat their teacher mostly on `spam` and `noise`. A likely reason: the silver labels follow the gold guideline's definitions, while the teacher answered from its own one-line label descriptions.

**At calibrated thresholds**, each student with its own. The shipped thresholds were fit on all of gold, so scoring them on gold would flatter them. Instead, 5-fold cross-validation fits thresholds on four fifths of the set and scores the fifth they never saw, and the five fifths are pooled: every message is judged by thresholds fit without it. This estimates how thresholds fit this way do on new messages:

| v2-6L | toxic | spam | scam | noise | question | positive | negative |
|---|---|---|---|---|---|---|---|
| Precision | 0.72 | 0.91 | 0.91 | 0.84 | 0.92 | 0.74 | 0.54 |
| Recall | 0.40 | 0.67 | 0.74 | 0.85 | 0.86 | 0.69 | 0.64 |
| F1 | 0.51 | 0.77 | 0.82 | 0.85 | 0.89 | 0.71 | 0.58 |

| v2-3L | toxic | spam | scam | noise | question | positive | negative |
|---|---|---|---|---|---|---|---|
| Precision | 0.71 | 0.85 | 0.96 | 0.86 | 0.88 | 0.76 | 0.55 |
| Recall | 0.50 | 0.73 | 0.74 | 0.85 | 0.87 | 0.67 | 0.62 |
| F1 | 0.59 | 0.79 | 0.84 | 0.85 | 0.87 | 0.71 | 0.58 |

Macro F1 0.734 (v2-6L) and 0.748 (v2-3L). With 103 toxic, 94 spam and 86 scam messages, these numbers carry a margin of several points (toxic recall has a standard error of about 5 points). The folds' own thresholds vary, most for spam (0.41 to 0.58 for v2-6L, 0.34 to 0.58 for v2-3L), and the estimate includes that.

**Weighted back to the candidate pool.** Most toxic, spam and scam messages in gold were picked because the teacher scored them high, so the ones the teacher misses are underrepresented, and the recall above is optimistic. Weighting each message by the inverse of its chance to be picked (1 for a teacher-score pick, 4.3 for a random one) estimates the numbers for the 5,000 candidates, a channel-balanced sample of unseen chat. This rests on few random picks (12 toxic, 6 spam, 4 scam), so treat it as a rough correction:

| Weighted | toxic | spam | scam | noise | question | positive | negative |
|---|---|---|---|---|---|---|---|
| v2-6L precision / recall | 0.68 / 0.33 | 0.92 / 0.61 | 0.89 / 0.75 | 0.82 / 0.87 | 0.93 / 0.80 | 0.67 / 0.62 | 0.41 / 0.57 |
| v2-3L precision / recall | 0.67 / 0.43 | 0.84 / 0.69 | 0.96 / 0.75 | 0.83 / 0.87 | 0.89 / 0.81 | 0.70 / 0.61 | 0.42 / 0.55 |

Of the 12 toxic messages in the random part, v2-6L catches 2 and v2-3L 3.

**By stream language**, macro F1 with the same cross-validation over all 2,000 messages, for the 13 stream languages with at least 40 messages. "Language" is the channel's declared stream language, not a per-message detection, and the samples are small, so read these as rough signals:

| | en | es | ja | ru | pl | pt | th | tr | de | ar | fr | it | uk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| messages | 361 | 179 | 158 | 146 | 140 | 121 | 87 | 84 | 78 | 75 | 74 | 62 | 42 |
| v2-6L | 0.77 | 0.71 | 0.76 | 0.59 | 0.68 | 0.69 | 0.72 | 0.60 | 0.82 | 0.81 | 0.78 | 0.68 | 0.81 |
| v2-3L | 0.77 | 0.70 | 0.81 | 0.60 | 0.68 | 0.77 | 0.71 | 0.65 | 0.70 | 0.80 | 0.81 | 0.66 | 0.89 |

**Export parity.** Each ONNX file was compared with its own PyTorch fp32 model on 533 real chat lines; "flips" are label decisions that change at the shipped thresholds ([`ml/export/export_onnx.py`](../ml/export/export_onnx.py)).

| File | Student | Precision | Size | Mean \|Δp\| | Flips | Used by the extension for |
|---|---|---|---|---|---|---|
| `onnx/model_quantized.onnx` | v2-6L | q8: int8 weight-only MatMulNBits, int8 embeddings, fp32 activations | 112.5 MB | 0.0004 | 0.00% | WebGPU (default) |
| `onnx/model_uint8_3L.onnx` | v2-3L | uint8: dynamic int8 (MatMulInteger) | 105.3 MB | 0.0044 | 0.54% | WASM / CPU (default) |
| `onnx/model_q4f16.onnx` | v2-6L | q4f16: 4-bit weights and embeddings, fp16 | 61.9 MB | 0.0087 | 0.70% | WebGPU, smallest, not the default |
| `tokenizer.json` | both | | 13.7 MB | | | both |

A browser loads one model file plus the tokenizer: 126 MB on WebGPU, 119 MB on the CPU. The 256k-token vocabulary is most of the size: the embedding table is 89% of v2-6L's parameters and 94% of v2-3L's.

## Limitations

- **It misses a lot of toxicity.** At the calibrated threshold, toxic recall is 0.40 for v2-6L and 0.50 for v2-3L (cross-validated): half or more of the toxic messages in the gold set get through, and likely more in live chat, where weighting puts recall at 0.33 and 0.43. This is a deliberate trade for precision (0.72 and 0.71), and still about 3 in 10 messages flagged toxic are not. The strictness slider trades the other way.
- **The two students differ.** The same message can get a different verdict on a GPU and on a CPU. On the gold set the 3-layer student is 0.007 macro AP behind the 6-layer one, but its own thresholds make it flag more toxic messages (recall 0.50 vs 0.40 at about the same precision) and fold spam less precisely (0.85 vs 0.91).
- **One message, no context.** The model never sees the stream, the conversation, earlier messages or who is talking to whom. Sarcasm, in-jokes, copypasta that is a community meme, and replies that are only rude in context are hard.
- **Emote language.** Emotes reach the model as their codes (`KEKW`, `OMEGALUL`, channel emotes like `xqcL`). Meanings drift by community and the model knows only what it saw in training.
- **Uneven languages.** Russian and Turkish score lowest on the gold set (about 0.6 macro F1), below English, Japanese, French and Arabic (0.76 to 0.81). Languages with little or no real chat in training rely on what mmBERT learned in pre-training and on public data, and are unmeasured.
- **Real chat has fewer bad messages than the test set.** Toxic, scam and spam messages were oversampled into the gold set so each label has enough examples. In real chat they are rarer, so a larger share of what gets flagged is a false alarm than the precision above suggests. Weighted back to the candidate pool, toxic precision drops a little (0.72 to 0.68 for v2-6L) and negative precision a lot (0.54 to 0.41).
- **The yardstick is an AI.** Gold and silver labels come from Claude agents following a written guideline. Errors and blind spots shared by those annotators are invisible to this evaluation, and the student partly learned the same annotators' judgment.
- **Optimistic selection.** The best epoch of each run was chosen by gold-set AP. Gold texts are removed from training by exact match only, so near-duplicates (the same copypasta with small edits) may appear on both sides, and v2 trained on 10 short gold texts (see Training data).
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
