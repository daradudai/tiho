"""Export a Hush Lite classifier (ModernBERT / mmBERT + 7-label multi-label head)
to ONNX in the folder layout transformers.js v4 expects.

    python ml/export/export_onnx.py --model <hf id or local dir> --out <dir>

Output layout (what the extension loads, locally or from a HF repo):

    <out>/config.json              HF config + `hush: {labels, thresholds, max_len, ...}`
    <out>/tokenizer.json           fast tokenizer (transformers.js reads this)
    <out>/tokenizer_config.json
    <out>/special_tokens_map.json  (if the tokenizer writes one)
    <out>/onnx/model.onnx          fp32            (dtype "fp32")
    <out>/onnx/model_fp16.onnx     fp16            (dtype "fp16")
    <out>/onnx/model_quantized.onnx int8 dynamic   (dtype "q8")
    <out>/onnx/model_q4.onnx       4-bit MatMulNBits + 4-bit GatherBlockQuantized embeddings (dtype "q4")
    <out>/onnx/model_q4f16.onnx    same on top of fp16 (dtype "q4f16")
    <out>/hush_export.json         sizes, parity numbers, export settings

Graph I/O: input_ids int64 [batch, seq], attention_mask int64 [batch, seq] ->
logits float32 [batch, num_labels]. Apply sigmoid in the client.

If the source checkpoint has no 7-label head (e.g. `jhu-clsp/mmBERT-small`), a
randomly initialised one is attached (seeded) -- a *placeholder* useful for
plumbing and speed only. A fine-tuned checkpoint saved with
`AutoModelForSequenceClassification.save_pretrained()` is exported as-is.

Thresholds: `--thresholds path.json` ({"toxic": 0.62, ...} or a list aligned with
labels). If omitted, an existing `hush.thresholds` in the source config is kept,
else 0.5 everywhere.

We use the TorchScript exporter (`dynamo=False`) because `optimum-onnx` pins
transformers 4.x and the current ModernBERT code traces fine; each precision is
validated against PyTorch with onnxruntime.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import torch

# Keep in sync with extension/src/core/types.ts LABELS.
LABELS = ["toxic", "spam", "scam", "noise", "question", "positive", "negative"]
ALL_PRECISIONS = ["fp32", "fp16", "q8", "q4", "q4f16"]
FILE_FOR = {
    "fp32": "model.onnx",
    "fp16": "model_fp16.onnx",
    "q8": "model_quantized.onnx",
    "int8": "model_int8.onnx",
    "q4": "model_q4.onnx",
    "q4f16": "model_q4f16.onnx",
}

VALIDATION_TEXTS = [
    "KEKW",
    "W",
    "first",
    "what game is this?",
    "you are so trash at this game uninstall",
    "free robux at bit.ly/xyz follow for follow",
    "que pasa chat, alguien sabe cuando empieza el torneo?",
    "das war richtig gut gespielt, gg",
    "ну и зачем он это сделал",
    "очень круто, спасибо за стрим",
    "LETS GOOOOOOO POGGERS POGGERS POGGERS",
    "これ何のゲーム？",
    "이거 진짜 재밌다 ㅋㅋㅋㅋ",
    "kocham ten stream <3",
    "bu oyun çok sıkıcı",
    "mano que jogada absurda kkkkkkk",
    "c'est quoi cette musique ?",
    "come si chiama questa canzone?",
    "@streamer can you play valorant next",
    "LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL",
    "Здравейте от България! Много добър стрийм",
]


class LogitsOnly(torch.nn.Module):
    def __init__(self, model: torch.nn.Module):
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask):
        return self.model(input_ids=input_ids, attention_mask=attention_mask).logits


def log(*a):
    print("[export]", *a, flush=True)


def load_model(args):
    from transformers import AutoConfig, AutoModelForSequenceClassification, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(args.model)
    src_cfg = AutoConfig.from_pretrained(args.model)
    labels = args.labels.split(",") if args.labels else LABELS
    id2label = {i: l for i, l in enumerate(labels)}
    label2id = {l: i for i, l in enumerate(labels)}

    has_head = (
        getattr(src_cfg, "num_labels", None) == len(labels)
        and any(a.endswith("ForSequenceClassification") for a in (src_cfg.architectures or []))
    )
    torch.manual_seed(args.seed)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model,
        num_labels=len(labels),
        id2label=id2label,
        label2id=label2id,
        problem_type="multi_label_classification",
        attn_implementation=args.attn,
        dtype=torch.float32,
    )
    model.eval()
    if not has_head:
        log(f"WARNING: {args.model} has no {len(labels)}-label classification head -> RANDOM head (placeholder).")
    return tok, model, labels, has_head, src_cfg


def resolve_thresholds(args, labels, src_cfg) -> list[float]:
    if args.thresholds:
        raw = json.loads(Path(args.thresholds).read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            raw = raw.get("thresholds", raw)
        if isinstance(raw, dict):
            return [float(raw[l]) for l in labels]
        assert len(raw) == len(labels), "thresholds list must align with labels"
        return [float(x) for x in raw]
    hush = getattr(src_cfg, "hush", None)
    if isinstance(hush, dict) and "thresholds" in hush:
        t = hush["thresholds"]
        return [float(t[l]) for l in labels] if isinstance(t, dict) else [float(x) for x in t]
    return [0.5] * len(labels)


def write_tokenizer(src: str, tok, out: Path, max_len: int):
    """Write tokenizer.json (compact; transformers 5 pretty-prints it to 2x size) and a
    tokenizer_config.json that transformers.js understands."""
    from transformers.utils import cached_file

    tmp = out / "_tok_tmp"
    tok.save_pretrained(str(tmp))  # canonical source of truth (works for hub ids and local dirs)
    tj = json.loads((tmp / "tokenizer.json").read_text(encoding="utf-8"))
    tj["truncation"] = None  # truncation/padding are passed per call by the extension
    tj["padding"] = None
    (out / "tokenizer.json").write_text(json.dumps(tj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    try:
        tc = json.loads(Path(cached_file(src, "tokenizer_config.json")).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        tc = json.loads((tmp / "tokenizer_config.json").read_text(encoding="utf-8"))
    if tc.get("tokenizer_class") in (None, "TokenizersBackend"):
        tc["tokenizer_class"] = "PreTrainedTokenizerFast"
    tc["model_max_length"] = max_len
    for k in ("is_local", "local_files_only", "backend"):
        tc.pop(k, None)
    (out / "tokenizer_config.json").write_text(json.dumps(tc, indent=1, ensure_ascii=False), encoding="utf-8")
    shutil.rmtree(tmp, ignore_errors=True)
    (out / "special_tokens_map.json").unlink(missing_ok=True)


def export_fp32(model, tok, path: Path, opset: int):
    wrapper = LogitsOnly(model)
    enc = tok(["hello there chat", "a slightly longer message to make padding happen ok"], padding=True,
              return_tensors="pt")
    args = (enc["input_ids"], enc["attention_mask"])
    t = time.time()
    with torch.inference_mode():
        torch.onnx.export(
            wrapper,
            args,
            str(path),
            dynamo=False,
            input_names=["input_ids", "attention_mask"],
            output_names=["logits"],
            dynamic_axes={
                "input_ids": {0: "batch_size", 1: "sequence_length"},
                "attention_mask": {0: "batch_size", 1: "sequence_length"},
                "logits": {0: "batch_size"},
            },
            opset_version=opset,
            do_constant_folding=True,
        )
    # Re-save as a single self-contained file (transformers.js fetches one .onnx per dtype).
    m = onnx.load(str(path), load_external_data=True)
    for f in path.parent.glob("*.data"):
        f.unlink()
    onnx.save_model(m, str(path), save_as_external_data=False)
    log(f"fp32 exported in {time.time() - t:.1f}s -> {path.name}")


def to_fp16(src: Path, dst: Path):
    from onnxruntime.transformers.float16 import convert_float_to_float16

    m = onnx.load(str(src))
    # keep_io_types: inputs are int64 anyway; logits stay float32 so the JS side is dtype-agnostic.
    m16 = convert_float_to_float16(m, keep_io_types=True, disable_shape_infer=False)
    onnx.save_model(m16, str(dst))


def to_q8(src: Path, dst: Path, weight_type: str = "QUInt8"):
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(
        str(src),
        str(dst),
        weight_type=getattr(QuantType, weight_type),
        per_channel=False,
        reduce_range=False,
        extra_options={"MatMulConstBOnly": True},
    )


def to_q4(src: Path, dst: Path, block_size: int, quant_embeddings: bool, accuracy_level: int | None):
    from onnxruntime.quantization.matmul_nbits_quantizer import DefaultWeightOnlyQuantConfig, MatMulNBitsQuantizer

    m = onnx.load(str(src))
    op_types = ("MatMul", "Gather") if quant_embeddings else ("MatMul",)
    axes = (("MatMul", 0), ("Gather", 1)) if quant_embeddings else (("MatMul", 0),)
    cfg = DefaultWeightOnlyQuantConfig(
        block_size=block_size,
        is_symmetric=True,
        accuracy_level=accuracy_level,
        op_types_to_quantize=op_types,
        quant_axes=axes,
        bits=4,
    )
    q = MatMulNBitsQuantizer(m, algo_config=cfg, op_types_to_quantize=op_types, quant_axes=axes,
                             block_size=block_size, is_symmetric=True, accuracy_level=accuracy_level)
    q.process()
    q.model.save_model_to_file(str(dst), use_external_data_format=False)


def ort_logits(path: Path, enc: dict, provider: str = "CPUExecutionProvider") -> np.ndarray:
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.log_severity_level = 3
    providers = [provider] if provider == "CPUExecutionProvider" else [provider, "CPUExecutionProvider"]
    sess = ort.InferenceSession(str(path), so, providers=providers)
    out = sess.run(["logits"], {"input_ids": enc["input_ids"].astype(np.int64),
                                "attention_mask": enc["attention_mask"].astype(np.int64)})[0]
    return out.astype(np.float32)


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="HF hub id or local dir (fine-tuned checkpoint or base model)")
    ap.add_argument("--out", required=True, help="output dir (e.g. extension/public/models/hush-lite)")
    ap.add_argument("--precisions", default=",".join(ALL_PRECISIONS),
                    help=f"comma list from {ALL_PRECISIONS + ['int8']}")
    ap.add_argument("--labels", default=None, help="comma list; default = LABELS from types.ts")
    ap.add_argument("--thresholds", default=None, help="json file: {label: thr} or [thr...]")
    ap.add_argument("--max-len", type=int, default=64)
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--attn", default="eager", choices=["eager", "sdpa"])
    ap.add_argument("--q4-block-size", type=int, default=32)
    ap.add_argument("--q4-no-embeddings", action="store_true", help="keep embeddings fp32/fp16 in q4 variants")
    ap.add_argument("--q4-accuracy-level", type=int, default=None, help="MatMulNBits accuracy_level (4 = int8 compute on CPU)")
    ap.add_argument("--model-version", default=None, help="string stored in config.hush.version")
    ap.add_argument("--save-hf", default=None, help="also save the (possibly placeholder) PyTorch checkpoint here")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--validate-provider", default="CPUExecutionProvider",
                    help="ORT provider for fp16 parity check (CUDAExecutionProvider is faster)")
    args = ap.parse_args()

    out = Path(args.out)
    onnx_dir = out / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)
    precisions = [p.strip() for p in args.precisions.split(",") if p.strip()]

    tok, model, labels, has_head, src_cfg = load_model(args)
    thresholds = resolve_thresholds(args, labels, src_cfg)

    if args.save_hf:
        model.config.hush = {"labels": labels, "thresholds": thresholds, "max_len": args.max_len,
                             "placeholder": not has_head}
        model.save_pretrained(args.save_hf)
        tok.save_pretrained(args.save_hf)
        log(f"saved PyTorch checkpoint -> {args.save_hf}")

    # ---- config + tokenizer -------------------------------------------------
    write_tokenizer(args.model, tok, out, args.max_len)
    cfg = model.config.to_dict()
    cfg["architectures"] = [type(model).__name__]
    cfg["problem_type"] = "multi_label_classification"
    cfg["hush"] = {
        "labels": labels,
        "thresholds": dict(zip(labels, thresholds)),
        "max_len": args.max_len,
        "activation": "sigmoid",
        "placeholder": (not has_head) or bool((getattr(src_cfg, "hush", None) or {}).get("placeholder")),
        "source": args.model,
        "version": args.model_version or time.strftime("%Y%m%d"),
    }
    cfg["transformers.js_config"] = {"dtype": {"webgpu": "fp16", "wasm": "q8"}}
    for k in ("_name_or_path", "torch_dtype", "dtype"):
        cfg.pop(k, None)
    (out / "config.json").write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")

    # ---- reference outputs ----------------------------------------------------
    enc_pt = tok(VALIDATION_TEXTS, padding=True, truncation=True, max_length=args.max_len, return_tensors="pt")
    with torch.inference_mode():
        ref = model(**enc_pt).logits.float().numpy()
    enc_np = {k: v.numpy() for k, v in enc_pt.items() if k in ("input_ids", "attention_mask")}
    # also check batch=1 / no padding path
    enc1 = {k: v[:1, : int(enc_pt["attention_mask"][0].sum())].numpy() for k, v in enc_pt.items()
            if k in ("input_ids", "attention_mask")}

    report = {"model": args.model, "placeholder": cfg["hush"]["placeholder"], "labels": labels, "files": {}}
    fp32 = onnx_dir / FILE_FOR["fp32"]
    need_fp32 = any(p in precisions for p in ("fp32", "fp16", "q8", "int8", "q4", "q4f16"))
    if need_fp32:
        export_fp32(model, tok, fp32, args.opset)
    fp16 = onnx_dir / FILE_FOR["fp16"]
    if "fp16" in precisions or "q4f16" in precisions:
        t = time.time()
        to_fp16(fp32, fp16)
        log(f"fp16 in {time.time() - t:.1f}s")
    if "q8" in precisions:
        t = time.time()
        to_q8(fp32, onnx_dir / FILE_FOR["q8"], "QUInt8")
        log(f"q8 in {time.time() - t:.1f}s")
    if "int8" in precisions:
        to_q8(fp32, onnx_dir / FILE_FOR["int8"], "QInt8")
    if "q4" in precisions:
        t = time.time()
        to_q4(fp32, onnx_dir / FILE_FOR["q4"], args.q4_block_size, not args.q4_no_embeddings, args.q4_accuracy_level)
        log(f"q4 in {time.time() - t:.1f}s")
    if "q4f16" in precisions:
        t = time.time()
        to_q4(fp16, onnx_dir / FILE_FOR["q4f16"], args.q4_block_size, not args.q4_no_embeddings, args.q4_accuracy_level)
        log(f"q4f16 in {time.time() - t:.1f}s")

    # ---- parity ---------------------------------------------------------------
    for p in precisions:
        path = onnx_dir / FILE_FOR[p]
        provider = args.validate_provider if p in ("fp16", "q4f16") else "CPUExecutionProvider"
        try:
            got = ort_logits(path, enc_np, provider)
            got1 = ort_logits(path, enc1, provider)
            d_logit = float(np.abs(got - ref).max())
            d_prob = float(np.abs(sigmoid(got) - sigmoid(ref)).max())
            d_b1 = float(np.abs(got1[0] - ref[0]).max())
            ok = d_prob < (1e-3 if p == "fp32" else 0.08)
            err = None
        except Exception as e:  # noqa: BLE001
            d_logit = d_prob = d_b1 = float("nan")
            ok, err = False, str(e)[:400]
        size = path.stat().st_size
        report["files"][p] = {
            "file": f"onnx/{path.name}",
            "bytes": size,
            "mb": round(size / 1e6, 1),
            "max_abs_logit_diff": d_logit,
            "max_abs_prob_diff": d_prob,
            "batch1_max_abs_logit_diff": d_b1,
            "ok": ok,
            **({"error": err} if err else {}),
        }
        log(f"{p:6s} {size / 1e6:8.1f} MB  max|dlogit|={d_logit:.5f}  max|dprob|={d_prob:.5f}  b1={d_b1:.5f}  "
            f"{'OK' if ok else 'CHECK'}" + (f"  ERROR {err}" if err else ""))

    if "fp32" not in precisions and fp32.exists():
        fp32.unlink()
    if "fp16" not in precisions and fp16.exists() and "fp16" not in report["files"]:
        fp16.unlink()
    tok_bytes = sum((out / f).stat().st_size for f in os.listdir(out) if (out / f).is_file())
    report["tokenizer_and_config_bytes"] = tok_bytes
    report["settings"] = {k: v for k, v in vars(args).items()}
    (out / "hush_export.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    log(f"done -> {out}  (tokenizer+config {tok_bytes / 1e6:.1f} MB)")
    if any(not f["ok"] for f in report["files"].values()):
        sys.exit(2)


if __name__ == "__main__":
    main()
