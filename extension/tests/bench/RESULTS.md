# Hush Lite in-browser inference — benchmark results

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
