# Hush Lite in-browser inference — benchmark results

## Current: shipped models on an idle GPU (2026-10-11)

What the release bundles: **v2-6L** (`onnx/model_quantized.onnx`, 112.5 MB, int8 weight-only) for
WebGPU and **v2-3L** (`onnx/model_uint8_3L.onnx`, 105.3 MB, dynamic int8) for WASM, plus
`model_q4f16.onnx` (61.9 MB) for comparison. Same machine and method as below (Ryzen 9 3950X,
RTX 3090, Playwright Chromium 156, 4 000 real chat lines, score cache off), but this time the GPU
was **idle** (2–5 % load, 25 W, no training or llama-server running).

msgs/s and p50/p95 latency per call in ms:

| backend | model / file | threads | load | B=1 | B=8 | B=32 | B=64 |
|---|---|---|---|---|---|---|---|
| **webgpu** | **6L q8** (default) | – | 1.8 s | 112/s (8.6/10.1) | 856/s (9.3/11.0) | 1 731/s (19.0/**21.6**) | 2 932/s (20.7/31.1) |
| webgpu | 6L q4f16 | – | 2.5 s | 101/s (9.2/11.7) | 785/s (10.1/11.9) | 1 636/s (20.2/22.6) | 2 545/s (23.8/35.8) |
| wasm | 6L q8 | 4 | 2.3 s | 55/s (17.2/24.8) | 126/s (61/90) | 148/s (194/299) | 180/s (362/376) |
| **wasm** | **3L uint8** (default) | **4** | 1.8 s | 357/s (2.5/4.7) | 472/s (16.2/24.6) | 492/s (57/92) | **577/s** (112/113) |
| wasm | 3L uint8 | 1 | 1.8 s | 211/s (4.2/8.3) | 237/s (31/45) | 252/s (107/190) | 277/s (233/245) |
| wasm | 3L uint8 | 8 | 1.5 s | 486/s (1.9/3.2) | 796/s (9.7/13.7) | 818/s (30/60) | 1 071/s (59/64) |

Simulated chat stream with the production batching wait (12 ms): WebGPU 6L at 150 msg/s →
**p50 23.5 ms / p95 27.5 ms**; WASM 3L ×4 threads at 60 msg/s → p50 15.0 ms / p95 18.5 ms.

End to end like a content script (Port → background → offscreen → worker, default backend =
WebGPU 6L, batches of 16): **p50 23.2 ms, p95 30.7 ms**, 0 errors; status carries the 6L
thresholds (0.22, 0.53, 0.22, 0.44, 0.52, 0.26, 0.10).

**Against the spec budgets:**
- *p95 ≤ 25 ms for a batch of 32 on a mid GPU*: **21.6 ms** on an RTX 3090 (a high-end GPU;
  not yet measured on a mid-range or integrated one).
- *≥ 300 msg/s on WASM with 4 threads on a mid laptop CPU*: **577 msg/s** on a desktop Ryzen 9
  3950X (single-thread 277 msg/s). A typical laptop CPU is roughly 2–3× slower per core, so this
  should still land around the target, but it is not measured.

Peak extra browser memory (private bytes): about +0.7 GB with WebGPU 6L q8 and +0.5–0.6 GB with
WASM 3L uint8 at 1–4 threads.

Raw JSON: `tests/bench/.data/results-1791716852437.json`.

### Mac mini (Apple M4, 10 cores, 16 GB, macOS 26.3)

Same build, bench and texts, run over SSH on the Mac's logged-in desktop (headed Playwright
Chromium 156; WebGPU on Apple Metal 3 with shader-f16; cross-origin isolated):

| backend | model / file | threads | load | B=1 | B=8 | B=32 | B=64 |
|---|---|---|---|---|---|---|---|
| webgpu | 6L q8 (default) | – | 0.7 s | 194/s (4.9/5.9) | 735/s (10.1/18.9) | 1 420/s (22.7/27.4) | 1 603/s (39.2/48.5) |
| webgpu | 6L q4f16 | – | 0.9 s | 197/s (4.9/5.3) | 824/s (9.2/15.2) | 1 628/s (19.6/**23.4**) | 2 178/s (28.6/33.8) |
| wasm | 6L q8 | 4 | 0.8 s | 161/s (4.7/12.6) | 386/s (20/29) | 435/s (64/102) | 510/s (126/130) |
| **wasm** | **3L uint8** (default) | **4** | 0.5 s | 807/s (1.0/2.5) | 1 015/s (7.2/10.8) | 1 027/s (27/45) | **1 146/s** (57/58) |
| wasm | 3L uint8 | 1 | 0.7 s | 354/s (2.3/5.8) | 322/s (23/35) | 312/s (88/147) | 353/s (181/188) |
| wasm | 3L uint8 | 8 | 0.5 s | 633/s (1.5/2.6) | 826/s (9.4/14.2) | 873/s (32/51) | 1 032/s (63/64) |

Stream at 150 msg/s: WebGPU 6L q8 p50 24.3 / p95 29.1 ms; 6L q4f16 p50 18.8 / p95 21.3 ms. End to
end (Port → background → offscreen → worker, batches of 16): p50 37.8 ms, p95 49.9 ms, 0 errors.

Notes:
- On Apple Metal the **q4f16** file is faster than q8 (fp16 math pays off there; on the RTX 3090
  q8 was slightly faster). With q8 the batch-of-32 p95 is 27.4 ms, just over the 25 ms budget;
  q4f16 meets it at 23.4 ms. q4f16 trades some accuracy (it flipped 1.5 % of decisions for v2;
  not yet measured for 6L), so this is a per-platform choice to make with the parity numbers.
- The M4's CPU is very fast for the 3L model: 1 146 msg/s on 4 threads, 353 msg/s single-threaded.
  4 threads beat 8 (4 performance cores + 6 efficiency cores), which matches the worker's default
  of min(4, cores / 2).
- Process memory is not sampled on macOS (the sampler is Windows-only).

Raw: `tests/bench/.data/mac-m4-results-1791719354549.json`, `mac-m4-full.log`.

---

## History: v2 (22 layers) on a busy GPU (2026-10-10)

Model **v2** (`ml/runs/v2/best`, mmBERT-small + 7-label head, max_len 64), exported with
`ml/export/export_onnx.py` (fused graph: `com.microsoft` RotaryEmbedding + MultiHeadAttention,
466 nodes instead of 1404). Measured 2026-10-10.

**Machine:** Ryzen 9 3950X (16C/32T), RTX 3090, Windows 11. Playwright Chromium 156 (headed),
onnxruntime-web 1.31.0-dev (asyncify build: WASM + WebGPU EP), transformers.js 4.3.1 (tokenizer).

> ⚠ **The GPU was 95–100 % busy the whole time** (llama-server teacher labeling + training on
> the same RTX 3090). WebGPU numbers therefore include GPU time-slicing with another process
> and are pessimistic; per-call latency is dominated by waiting for the GPU, not by compute.
> Re-run on an idle GPU before quoting WebGPU numbers externally. The CPU was ~8 % busy, so WASM
> numbers are representative of this CPU.

Texts: 4 000 real chat lines sampled from `ml/data/raw/*.jsonl` (DE/JA/EN/RU/FR/PL/ES/IT/…,
mean ≈ 10 tokens). Worker score cache **off** for all runs (every text is a model call).

## Model files (v2)

Parity vs PyTorch fp32 on 533 real chat lines; *flips* = label decisions that change at the
calibrated thresholds (`hush.thresholds`).

| file | dtype key | size | flips | mean \|Δp\| | notes |
|---|---|---|---|---|---|
| `onnx/model.onnx` | fp32 | 562.7 MB | 0 | 0 | reference only (never bundled) |
| `onnx/model_fp16.onnx` | fp16 | 281.4 MB | 0.03 % | 0.0000 | exact, too big |
| `onnx/model_q8f16.onnx` | q8f16 | 144.0 MB | 0.08 % | 0.0008 | fp16 act, int8 weight-only MatMulNBits, int8 per-row embeddings |
| `onnx/model_quantized.onnx` | **q8** | **147.2 MB** | **0.08 %** | 0.0009 | fp32 act, same weights — **WebGPU default** |
| `onnx/model_uint8.onnx` | **uint8** | **144.6 MB** | 0.64 % | 0.0069 | dynamic int8 (MatMulInteger), 2 "massive-activation" MatMuls kept fp32 — **WASM default** |
| `onnx/model_q4.onnx` | q4 | 126.0 MB | 1.72 % | 0.0160 | 4-bit MatMulNBits + int8 embeddings |
| `onnx/model_q4f16.onnx` | q4f16 | 79.3 MB | 1.55 % | 0.0159 | 4-bit MatMulNBits + 4-bit GatherBlockQuantized embeddings (WebGPU only) |

+ `tokenizer.json` 13.7 MB (compact), `tokenizer_config.json`, `config.json`.
A user downloads **one** model file (≈145 MB) + tokenizer (13.7 MB) ≈ **160 MB**.

Why the embedding dominates: 256k vocab × 384 = 98 M of the 140 M params. Weight-only int8 is
~lossless; classic dynamic int8 suffers from mmBERT's *massive activations* (|x| ≈ 12 000 at the
input of two MLP.Wo layers), hence the fp32 exclusion; 4-bit costs 1.5–1.7 % flips.

## Fixed batch size (worker only, no batching wait)

msgs/s and p50/p95 latency per call in ms. "load" = worker spawn → ready, incl. reading the
bundled file, session creation and warm-up (4 shapes).

| backend | file | threads | load ms | B=1 | B=8 | B=32 | B=64 |
|---|---|---|---|---|---|---|---|
| webgpu | q8 | – | 1 751 | 46/s (21.5/24.8) | 264/s (26.3/43.1) | 564/s (58.5/65.7) | 731/s (83.6/108) |
| webgpu | q8f16 | – | 2 216 | 37/s (27.6/30.1) | 257/s (29.6/39.2) | 538/s (61.0/69.8) | 794/s (77.7/108) |
| webgpu | fp16 | – | 2 385 | 58/s (16.9/21.7) | 341/s (23.0/29.3) | 660/s (49.5/55.0) | 930/s (68.7/75.9) |
| webgpu | q4f16 | – | 1 699 | 49/s (20.3/23.5) | 333/s (23.9/29.7) | 653/s (51.0/54.8) | 955/s (63.6/87.1) |
| wasm | uint8 | 1 | 3 986 | 27/s (31.9/76.6) | 35/s (211/308) | 36/s (766/1287) | 41/s (1593/1617) |
| wasm | **uint8** | **4** | 2 378 | 70/s (12.7/26.2) | 102/s (76/105) | 115/s (238/398) | 132/s (493/497) |
| wasm | uint8 | 8 | 1 987 | 89/s (10.5/17.3) | 131/s (58/84) | 146/s (204/280) | 165/s (396/397) |
| wasm | q8 | 4 | 2 879 | 26/s (37.0/55.6) | 48/s (155/233) | 59/s (491/777) | 80/s (821/833) |
| wasm | q4 | 4 | 2 672 | 23/s (41.5/57.9) | 48/s (165/213) | 58/s (432/861) | 67/s (1015/1018) |

## Simulated chat stream (dynamic batching, production wait 12 ms)

A frame's worth of messages every 16 ms, as content scripts send them.

| backend | file | offered | achieved | p50 / p95 ms | avg batch | pad ratio |
|---|---|---|---|---|---|---|
| webgpu | q8 | 150 msg/s | 142 | 35.3 / 52.6 | 7.8 | 1.75 |
| webgpu | fp16 | 150 msg/s | 141 | 35.1 / 176.7 | 8.2 | 1.75 |
| webgpu | q4f16 | 150 msg/s | 142 | 34.9 / 44.7 | 5.3 | 1.74 |
| wasm | uint8 ×4 | 60 msg/s | 56 | 57.6 / 135.7 | 4.3 | 1.17 |
| wasm | uint8 ×8 | 60 msg/s | 57 | 32.4 / 62.6 | 4.1 | 1.14 |
| wasm | q8 ×4 | 60 msg/s | 53 | 517 / 843 (saturated) | 4.9 | 1.15 |

## End-to-end (Port → background SW → offscreen document → worker)

Bench page opens a `hush:classify` Port exactly like a content script; default backend choice
(WebGPU, `q8`): batches of 16 → **p50 52.5 ms, p95 74 ms**, 0 errors; status pushed over the
Port carries `thresholds` (v2: 0.28, 0.42, 0.37, 0.47, 0.55, 0.18, 0.11). The offscreen worker is
cross-origin isolated (`crossOriginIsolated: true`, 4 WASM threads available).

## Memory (whole browser, private bytes, peak during a run minus before)

| backend | file | Δ peak |
|---|---|---|
| webgpu | q8 | +1.3 GB (GPU process staging + WASM heap copy of the model) |
| wasm | uint8 ×4 | +0.64 GB |
| wasm | q8 ×4 | +2.0 GB (MatMulNBits on CPU unpacks weights) |

WASM linear memory never shrinks, so the offscreen document **terminates the worker** after the
engine's idle disposal (10 min without requests) and respawns it on the next request.

## Conclusions

1. **WebGPU → `q8`** (147 MB, ~lossless). Under contention all WebGPU files land within ~25 % of
   each other (dispatch / time-slicing bound, not compute bound); fp16/q4f16 are a bit faster
   but fp16 is 2× the download and q4f16 flips 1.5 % of decisions. q8f16 was not faster than q8.
2. **WASM → `uint8`, 4 threads** (cross-origin isolated offscreen doc): ~70 msg/s at batch 1,
   115–130 msg/s saturated, ~12 ms for a single message. MatMulNBits (q8/q4) kernels are 2× slower
   in WASM. 8 threads → 165 msg/s.
3. Spec budgets: *p95 ≤ 25 ms for 32 on a mid GPU* — not met here under contention (55–65 ms);
   needs an idle-GPU re-run. *≥ 300 msg/s on WASM 4 threads* — **not reachable with this model**:
   22 layers × 42 M non-embedding params ≈ 84 MFLOP/token, and the WASM backend is already doing
   ~100 GFLOP/s. Hitting it needs a ~3× cheaper student (e.g. 6–8 layers distilled from v2) for the
   WASM path; caching (repeats, waves) and Tier-0 rules cut the model load in real chats.
4. Batching works as intended: in the stream runs the batch size adapts to load (avg 4–8),
   bucketing keeps padding at 1.15× on WASM (on WebGPU one bucket is cheaper: pad ≈ 1.75×).

## Re-run

```bash
cd extension
node tests/bench/make-sample.mjs                       # once; sample is git-ignored (.data/)
HUSH_OUT=.output-inference HUSH_BENCH=1 HUSH_MODEL_VARIANTS=all npx wxt build
node tests/bench/bench.mjs            # full; --quick, --only webgpu|wasm, --variants q8,uint8, --pipeline-only
node tests/bench/tokenizer-parity.mjs # JS vs Python tokenizer on the sample (expects 0 mismatches)
```

Raw JSON per run: `tests/bench/.data/results-*.json`.
