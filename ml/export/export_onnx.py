"""Export a Hush Lite classifier (ModernBERT / mmBERT + 7-label multi-label head)
to ONNX for the browser (onnxruntime-web, loaded by the extension's inference
worker; tokenizer via transformers.js).

    python ml/export/export_onnx.py --model ml/runs/v0/best --out extension/public/models/hush-lite

Output layout (identical locally and in a HF repo):

    <out>/config.json               HF config + `hush: {labels, thresholds, max_len, files, ...}`
    <out>/tokenizer.json            compact fast-tokenizer JSON (transformers.js reads this)
    <out>/tokenizer_config.json
    <out>/onnx/model.onnx           fp32 (reference)
    <out>/onnx/model_fp16.onnx      fp16 everything
    <out>/onnx/model_q8f16.onnx     fp16 activations, int8 weight-only MatMulNBits, int8 per-row embeddings   [WebGPU]
    <out>/onnx/model_quantized.onnx fp32 activations, int8 weight-only MatMulNBits, int8 per-row embeddings   [WASM]
    <out>/onnx/model_uint8.onnx     classic dynamic quantization (MatMulInteger, uint8 activations); MatMuls fed
                                    by "massive activations" are left in fp32 (auto-detected)
    <out>/onnx/model_q4.onnx        fp32 activations, 4-bit MatMulNBits (int8 compute), int8 per-row embeddings  [WASM]
    <out>/onnx/model_q4f16.onnx     fp16, 4-bit MatMulNBits + 4-bit GatherBlockQuantized embeddings (smallest;
                                    GatherBlockQuantized has no WASM kernel -> WebGPU only)
    <out>/hush_export.json          sizes + parity vs PyTorch on real chat texts

The standard transformers.js suffixes are kept where the meaning matches
(`model.onnx`, `_fp16`, `_quantized`=q8, `_uint8`, `_q4`, `_q4f16`); `_q8f16` is
Hush-specific (the worker picks files from `config.hush.files`).

Graph I/O: input_ids int64 [batch, seq], attention_mask int64 [batch, seq] ->
logits float32 [batch, num_labels]. Sigmoid is applied in the client.

If the source checkpoint has no N-label head (e.g. `jhu-clsp/mmBERT-small`), a
seeded random head is attached -> a *placeholder* (plumbing/speed only), marked
`hush.placeholder: true`.

Thresholds: `--thresholds path.json` ({"toxic": 0.62, ...} or a list aligned
with labels). Otherwise an existing `hush.thresholds` in the source config is
kept, else 0.5 everywhere.

Notes
- TorchScript exporter (`dynamo=False`): `optimum-onnx` pins transformers 4.x,
  and ModernBERT traces fine. The graph is simplified with onnxslim (~2x fewer
  nodes -> fewer WebGPU dispatches).
- mmBERT has "massive activations" (|x| ~ 1e4 at the input of a couple of
  MLP.Wo layers). Classic dynamic int8 (per-tensor activation quantization) is
  badly hurt by that; weight-only int8 (MatMulNBits bits=8) is ~lossless.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from onnx import TensorProto, helper, numpy_helper

# Keep in sync with extension/src/core/types.ts LABELS.
LABELS = ["toxic", "spam", "scam", "noise", "question", "positive", "negative"]
FILE_FOR = {
    "fp32": "model.onnx",
    "fp16": "model_fp16.onnx",
    "q8f16": "model_q8f16.onnx",
    "q8": "model_quantized.onnx",
    "uint8": "model_uint8.onnx",
    "q4": "model_q4.onnx",
    "q4f16": "model_q4f16.onnx",
    # experimental: q8 with int8 compute in MatMulNBits (accuracy_level 4)
    "q8a4": "model_q8a4.onnx",
}
DEFAULT_PRECISIONS = ["fp32", "fp16", "q8f16", "q8", "uint8", "q4", "q4f16"]
REPO = Path(__file__).resolve().parents[2]
DEFAULT_EVAL = REPO / "extension" / "tests" / "bench" / ".data" / "chat_sample.json"

VALIDATION_TEXTS = [
    "KEKW", "W", "first", "what game is this?", "you are so trash at this game uninstall",
    "free robux at bit.ly/xyz follow for follow", "que pasa chat, alguien sabe cuando empieza el torneo?",
    "das war richtig gut gespielt, gg", "ну и зачем он это сделал", "очень круто, спасибо за стрим",
    "LETS GOOOOOOO POGGERS POGGERS POGGERS", "これ何のゲーム？", "이거 진짜 재밌다 ㅋㅋㅋㅋ", "kocham ten stream <3",
    "bu oyun çok sıkıcı", "mano que jogada absurda kkkkkkk", "c'est quoi cette musique ?",
    "come si chiama questa canzone?", "@streamer can you play valorant next",
    "LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL LUL",
    "Здравейте от България! Много добър стрийм",
]


def log(*a):
    print("[export]", *a, flush=True)


class LogitsOnly(torch.nn.Module):
    def __init__(self, model: torch.nn.Module):
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask):
        return self.model(input_ids=input_ids, attention_mask=attention_mask).logits


# --------------------------------------------------------------------------- model / tokenizer


def load_model(args):
    from transformers import AutoConfig, AutoModelForSequenceClassification, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(args.model)
    src_cfg = AutoConfig.from_pretrained(args.model)
    labels = args.labels.split(",") if args.labels else LABELS
    has_head = getattr(src_cfg, "num_labels", None) == len(labels) and any(
        a.endswith("ForSequenceClassification") for a in (src_cfg.architectures or [])
    )
    if has_head and src_cfg.id2label:
        src_labels = [src_cfg.id2label[i] for i in range(len(labels))]
        if src_labels != labels:
            log(f"WARNING: checkpoint labels {src_labels} != expected {labels}")
    torch.manual_seed(args.seed)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model,
        num_labels=len(labels),
        id2label=dict(enumerate(labels)),
        label2id={l: i for i, l in enumerate(labels)},
        problem_type="multi_label_classification",
        attn_implementation="eager",
        dtype=torch.float32,
    ).eval()
    if not has_head:
        log(f"WARNING: {args.model} has no {len(labels)}-label head -> RANDOM head (placeholder).")
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
    if isinstance(hush, dict) and hush.get("thresholds"):
        t = hush["thresholds"]
        return [float(t[l]) for l in labels] if isinstance(t, dict) else [float(x) for x in t]
    return [0.5] * len(labels)


def write_tokenizer(src: str, tok, out: Path, max_len: int):
    """tokenizer.json compact (transformers 5 pretty-prints it to 2.5x size) and a
    tokenizer_config.json that transformers.js understands."""
    tmp = out / "_tok_tmp"
    tok.save_pretrained(str(tmp))
    tj = json.loads((tmp / "tokenizer.json").read_text(encoding="utf-8"))
    tj["truncation"] = None  # truncation/padding are passed per call by the extension
    tj["padding"] = None
    (out / "tokenizer.json").write_text(json.dumps(tj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tc = json.loads((tmp / "tokenizer_config.json").read_text(encoding="utf-8"))
    if tc.get("tokenizer_class") in (None, "TokenizersBackend"):
        tc["tokenizer_class"] = "PreTrainedTokenizerFast"
    tc["model_max_length"] = max_len
    for k in ("is_local", "local_files_only", "backend"):
        tc.pop(k, None)
    (out / "tokenizer_config.json").write_text(json.dumps(tc, indent=1, ensure_ascii=False), encoding="utf-8")
    shutil.rmtree(tmp, ignore_errors=True)
    (out / "special_tokens_map.json").unlink(missing_ok=True)


# --------------------------------------------------------------------------- export + transforms


def save(m: onnx.ModelProto, path: Path):
    onnx.save_model(m, str(path), save_as_external_data=False)


def export_fp32(model, tok, path: Path, opset: int, slim: bool, fused: bool, max_len: int):
    enc = tok(["hello there chat", "a slightly longer message so that padding happens ok"], padding=True,
              return_tensors="pt")
    t = time.time()
    if fused:
        from fused_modernbert import FusedModernBertForSequenceClassification, fix_mha_inputs

        wrapper = FusedModernBertForSequenceClassification(model, max_len).eval()
        with torch.inference_mode():
            ref = model(**enc).logits
            got = wrapper(enc["input_ids"], enc["attention_mask"])
        diff = float((ref - got).abs().max())
        if diff > 1e-3:
            raise RuntimeError(f"fused graph differs from HF model in PyTorch: {diff}")
    else:
        wrapper = LogitsOnly(model)
    with torch.inference_mode():
        torch.onnx.export(
            wrapper, (enc["input_ids"], enc["attention_mask"]), str(path), dynamo=False,
            input_names=["input_ids", "attention_mask"], output_names=["logits"],
            dynamic_axes={"input_ids": {0: "batch_size", 1: "sequence_length"},
                          "attention_mask": {0: "batch_size", 1: "sequence_length"},
                          "logits": {0: "batch_size"}},
            opset_version=opset, do_constant_folding=True,
            custom_opsets={"com.microsoft": 1} if fused else None,
        )
    m = onnx.load(str(path), load_external_data=True)
    for f in path.parent.glob("*.data"):
        f.unlink()
    if fused:
        fix_mha_inputs(m)
    n0 = len(m.graph.node)
    if slim:
        try:
            import onnxslim

            m = onnxslim.slim(m)
        except ImportError:
            log("onnxslim not installed -> skipping graph simplification (pip install onnxslim)")
    save(m, path)
    log(f"fp32 exported in {time.time() - t:.1f}s ({n0} -> {len(m.graph.node)} nodes)")


def to_fp16(m: onnx.ModelProto) -> onnx.ModelProto:
    from onnxruntime.transformers.float16 import DEFAULT_OP_BLOCK_LIST, convert_float_to_float16

    # keep_io_types: inputs are int64; logits stay float32 so the JS side is dtype-agnostic.
    return convert_float_to_float16(m, keep_io_types=True, op_block_list=list(DEFAULT_OP_BLOCK_LIST))


def find_embedding_gather(m: onnx.ModelProto):
    inits = {i.name: i for i in m.graph.initializer}
    best = None
    for n in m.graph.node:
        if n.op_type == "Gather" and n.input[0] in inits:
            dims = list(inits[n.input[0]].dims)
            if len(dims) == 2 and (best is None or dims[0] > best[2][0]):
                best = (n, inits[n.input[0]], dims)
    if best is None:
        raise RuntimeError("embedding Gather not found")
    return best[0], best[1]


def quantize_embeddings_int8(m: onnx.ModelProto) -> onnx.ModelProto:
    """Embedding table -> int8 with one fp scale per row (symmetric):
    Gather(Wq, ids) -> Cast(float) -> Mul(Gather(scale, ids)). Works on every EP,
    ~lossless, 4x smaller than fp32 (2x vs fp16)."""
    node, init = find_embedding_gather(m)
    w = numpy_helper.to_array(init)
    fdtype = w.dtype  # float32 or float16 graph
    wf = w.astype(np.float32)
    scale = np.maximum(np.abs(wf).max(axis=1, keepdims=True), 1e-8) / 127.0
    wq = np.clip(np.round(wf / scale), -127, 127).astype(np.int8)
    base = init.name
    m.graph.initializer.remove(init)
    m.graph.initializer.extend([
        numpy_helper.from_array(wq, base + "_int8"),
        numpy_helper.from_array(scale.astype(fdtype), base + "_scale"),
    ])
    ids, out = node.input[1], node.output[0]
    to = TensorProto.FLOAT16 if fdtype == np.float16 else TensorProto.FLOAT
    new = [
        helper.make_node("Gather", [base + "_int8", ids], [out + "_q"], name=node.name + "_q8", axis=0),
        helper.make_node("Cast", [out + "_q"], [out + "_f"], name=node.name + "_q8cast", to=to),
        helper.make_node("Gather", [base + "_scale", ids], [out + "_s"], name=node.name + "_q8scale", axis=0),
        helper.make_node("Mul", [out + "_f", out + "_s"], [out], name=node.name + "_q8mul"),
    ]
    idx = list(m.graph.node).index(node)
    m.graph.node.remove(node)
    for i, nn in enumerate(new):
        m.graph.node.insert(idx + i, nn)
    return m


def nbits(m: onnx.ModelProto, bits: int, ops: tuple[str, ...], block_size: int,
          accuracy_level: int | None = None, exclude: list[str] | None = None) -> onnx.ModelProto:
    """Weight-only block quantization (MatMul -> MatMulNBits, Gather -> GatherBlockQuantized)."""
    import logging

    from onnxruntime.quantization.matmul_nbits_quantizer import DefaultWeightOnlyQuantConfig, MatMulNBitsQuantizer

    logging.getLogger("onnxruntime.quantization.matmul_nbits_quantizer").setLevel(logging.ERROR)
    axes = tuple((o, 0 if o == "MatMul" else 1) for o in ops)
    cfg = DefaultWeightOnlyQuantConfig(block_size=block_size, is_symmetric=True, accuracy_level=accuracy_level,
                                       op_types_to_quantize=ops, quant_axes=axes, bits=bits)
    q = MatMulNBitsQuantizer(m, nodes_to_exclude=exclude or [], algo_config=cfg)
    q.process()
    return q.model.model


def dynamic_uint8(src: Path, dst: Path, exclude: list[str]):
    import logging

    from onnxruntime.quantization import QuantType, quantize_dynamic

    logging.getLogger().setLevel(logging.WARNING)
    quantize_dynamic(str(src), str(dst), op_types_to_quantize=["MatMul"], weight_type=QuantType.QUInt8,
                     per_channel=False, reduce_range=False, nodes_to_exclude=exclude,
                     extra_options={"MatMulConstBOnly": True})
    m = quantize_embeddings_int8(onnx.load(str(dst)))
    save(m, dst)


def massive_activation_matmuls(model, tok, texts: list[str], max_len: int, threshold: float,
                               onnx_path: Path) -> dict[str, float]:
    """ONNX MatMul node names (in `onnx_path`) whose input |x|max exceeds `threshold` on `texts`.
    Linear -> MatMul matching is by weight values (node names differ between graph styles)."""
    stats: dict[str, float] = {}
    linears: dict[str, torch.nn.Linear] = {}
    hooks = []
    for name, mod in model.named_modules():
        if isinstance(mod, torch.nn.Linear):
            linears[name] = mod

            def hook(_m, inp, name=name):
                v = float(inp[0].detach().abs().max())
                stats[name] = max(stats.get(name, 0.0), v)
            hooks.append(mod.register_forward_pre_hook(hook))
    with torch.inference_mode():
        for i in range(0, len(texts), 64):
            enc = tok(texts[i:i + 64], padding=True, truncation=True, max_length=max_len, return_tensors="pt")
            model(input_ids=enc["input_ids"], attention_mask=enc["attention_mask"])
    for h in hooks:
        h.remove()
    g = onnx.load(str(onnx_path)).graph
    inits = {i.name: i for i in g.initializer}
    by_fp: dict[tuple, list[str]] = {}
    for n in g.node:
        if n.op_type == "MatMul" and n.input[1] in inits:
            w = numpy_helper.to_array(inits[n.input[1]])
            by_fp.setdefault((w.shape, round(float(w.astype(np.float64).sum()), 3), float(w.flat[0])), []).append(n.name)
    out = {}
    for name, v in stats.items():
        if v <= threshold:
            continue
        wt = linears[name].weight.detach().numpy().T
        hits = by_fp.get((wt.shape, round(float(wt.astype(np.float64).sum()), 3), float(wt.flat[0])), [])
        if not hits:
            log(f"WARNING: no ONNX MatMul found for {name}")
        for n in hits:
            out[n] = v
    return out


# --------------------------------------------------------------------------- parity


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def ort_logits(path: Path, ids: np.ndarray, mask: np.ndarray, bs: int = 64) -> np.ndarray:
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.log_severity_level = 3
    sess = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
    outs = [sess.run(["logits"], {"input_ids": ids[i:i + bs], "attention_mask": mask[i:i + bs]})[0]
            for i in range(0, len(ids), bs)]
    return np.concatenate(outs).astype(np.float32)


def load_eval_texts(path: str | None, n: int) -> list[str]:
    p = Path(path) if path else DEFAULT_EVAL
    if p.exists():
        raw = p.read_text(encoding="utf-8")
        if p.suffix == ".jsonl":
            items = [json.loads(l) for l in raw.splitlines() if l.strip()]
        else:
            items = json.loads(raw)
        texts = [it["text"] if isinstance(it, dict) else str(it) for it in items]
        texts = [t for t in texts if t.strip()][:n]
        if texts:
            return list(VALIDATION_TEXTS) + texts
    return list(VALIDATION_TEXTS)


# --------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="HF hub id or local dir (fine-tuned checkpoint or base model)")
    ap.add_argument("--out", required=True, help="output dir (e.g. extension/public/models/hush-lite)")
    ap.add_argument("--precisions", default=",".join(DEFAULT_PRECISIONS), help=f"comma list from {list(FILE_FOR)}")
    ap.add_argument("--labels", default=None, help="comma list; default = LABELS from types.ts")
    ap.add_argument("--thresholds", default=None, help='json file: {"toxic": 0.6, ...} or [..]')
    ap.add_argument("--max-len", type=int, default=None,
                    help="default: source config hush.max_length / hush.max_len, else 64")
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--no-slim", action="store_true")
    ap.add_argument("--graph", default="fused", choices=["fused", "hf"],
                    help="fused: RotaryEmbedding + MultiHeadAttention contrib ops (~5x fewer nodes; default); "
                         "hf: plain trace of the transformers model")
    ap.add_argument("--block-size", type=int, default=32, help="MatMulNBits / GatherBlockQuantized block size")
    ap.add_argument("--q4-accuracy-level", type=int, default=4,
                    help="MatMulNBits accuracy_level for q4 (4 = int8 compute on CPU, faster in WASM)")
    ap.add_argument("--outlier-threshold", type=float, default=200.0,
                    help="uint8: MatMuls whose input |x|max exceeds this stay fp32")
    ap.add_argument("--eval-texts", default=None,
                    help=f"json list / jsonl with `text` for parity (default {DEFAULT_EVAL.relative_to(REPO)})")
    ap.add_argument("--eval-n", type=int, default=512)
    ap.add_argument("--model-version", default=None, help="string stored in config.hush.version")
    ap.add_argument("--save-hf", default=None, help="also save the (possibly placeholder) PyTorch checkpoint here")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    out = Path(args.out)
    onnx_dir = out / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)
    precisions = [p.strip() for p in args.precisions.split(",") if p.strip()]
    for p in precisions:
        assert p in FILE_FOR, f"unknown precision {p}"

    tok, model, labels, has_head, src_cfg = load_model(args)
    thresholds = resolve_thresholds(args, labels, src_cfg)
    src_hush = dict(getattr(src_cfg, "hush", None) or {})
    if args.max_len is None:
        args.max_len = int(src_hush.get("max_length") or src_hush.get("max_len") or 64)
    placeholder = (not has_head) or bool(src_hush.get("placeholder"))
    if args.save_hf:
        model.config.hush = {"labels": labels, "thresholds": thresholds, "max_len": args.max_len,
                             "placeholder": placeholder}
        model.save_pretrained(args.save_hf)
        tok.save_pretrained(args.save_hf)
        log(f"saved PyTorch checkpoint -> {args.save_hf}")

    write_tokenizer(args.model, tok, out, args.max_len)
    texts = load_eval_texts(args.eval_texts, args.eval_n)

    # ---- fp32 reference graph -------------------------------------------------
    fp32 = onnx_dir / FILE_FOR["fp32"]
    export_fp32(model, tok, fp32, args.opset, slim=not args.no_slim, fused=args.graph == "fused", max_len=args.max_len)
    m32 = onnx.load(str(fp32))
    built: dict[str, str] = {}

    def timed(name, fn):
        t = time.time()
        fn()
        built[name] = f"{time.time() - t:.1f}s"
        log(f"{name:6s} built in {built[name]}")

    m16 = None
    if any(p in precisions for p in ("fp16", "q8f16", "q4f16")):
        m16 = to_fp16(onnx.load(str(fp32)))
    if "fp16" in precisions:
        timed("fp16", lambda: save(m16, onnx_dir / FILE_FOR["fp16"]))
    if "q8f16" in precisions:
        timed("q8f16", lambda: save(nbits(quantize_embeddings_int8(onnx.ModelProto.FromString(m16.SerializeToString())),
                                          8, ("MatMul",), args.block_size), onnx_dir / FILE_FOR["q8f16"]))
    if "q8" in precisions:
        timed("q8", lambda: save(nbits(quantize_embeddings_int8(onnx.load(str(fp32))), 8, ("MatMul",), args.block_size),
                                 onnx_dir / FILE_FOR["q8"]))
    outliers = {}
    if "uint8" in precisions:
        outliers = massive_activation_matmuls(model, tok, texts, args.max_len, args.outlier_threshold, fp32)
        log(f"uint8: keeping {len(outliers)} MatMul(s) fp32 (massive activations): "
            + ", ".join(f"{k}={v:.0f}" for k, v in outliers.items()))
        timed("uint8", lambda: dynamic_uint8(fp32, onnx_dir / FILE_FOR["uint8"], list(outliers)))
    if "q8a4" in precisions:
        timed("q8a4", lambda: save(nbits(quantize_embeddings_int8(onnx.load(str(fp32))), 8, ("MatMul",), args.block_size,
                                         accuracy_level=4), onnx_dir / FILE_FOR["q8a4"]))
    if "q4" in precisions:
        timed("q4", lambda: save(nbits(quantize_embeddings_int8(onnx.load(str(fp32))), 4, ("MatMul",), args.block_size,
                                       accuracy_level=args.q4_accuracy_level), onnx_dir / FILE_FOR["q4"]))
    if "q4f16" in precisions:
        timed("q4f16", lambda: save(nbits(onnx.ModelProto.FromString(m16.SerializeToString()), 4, ("MatMul", "Gather"),
                                          args.block_size), onnx_dir / FILE_FOR["q4f16"]))
    del m32, m16

    # ---- config ------------------------------------------------------------------
    cfg = model.config.to_dict()
    cfg["architectures"] = [type(model).__name__]
    cfg["problem_type"] = "multi_label_classification"
    files = {p: f"onnx/{FILE_FOR[p]}" for p in precisions}
    cfg["hush"] = {
        **src_hush,  # keep whatever training wrote (calibration info etc.)
        "labels": labels,
        "thresholds": dict(zip(labels, thresholds)),
        "max_len": args.max_len,
        "max_length": args.max_len,
        "activation": "sigmoid",
        "placeholder": placeholder,
        "source": str(args.model),
        "version": args.model_version or time.strftime("%Y%m%d-%H%M"),
        "files": files,
        "sizes": {p: (onnx_dir / FILE_FOR[p]).stat().st_size for p in precisions},
    }
    for k in ("_name_or_path", "torch_dtype", "dtype", "transformers.js_config"):
        cfg.pop(k, None)
    (out / "config.json").write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")

    # ---- parity vs PyTorch on real texts ------------------------------------------
    enc = tok(texts, padding=True, truncation=True, max_length=args.max_len, return_tensors="pt")
    with torch.inference_mode():
        ref = np.concatenate([model(input_ids=enc["input_ids"][i:i + 64], attention_mask=enc["attention_mask"][i:i + 64])
                             .logits.float().numpy() for i in range(0, len(texts), 64)])
    ids, mask = enc["input_ids"].numpy().astype(np.int64), enc["attention_mask"].numpy().astype(np.int64)
    pr = sigmoid(ref)
    thr = np.array(thresholds, dtype=np.float32)
    # batch=1, unpadded path for the first text
    n1 = int(mask[0].sum())
    report = {"model": str(args.model), "placeholder": placeholder, "labels": labels, "eval_texts": len(texts),
              "uint8_fp32_matmuls": outliers, "files": {}}
    log(f"parity on {len(texts)} texts (flip = decision change at thresholds vs PyTorch fp32)")
    ok_all = True
    for p in precisions:
        path = onnx_dir / FILE_FOR[p]
        size = path.stat().st_size
        try:
            got = ort_logits(path, ids, mask)
            got1 = ort_logits(path, ids[:1, :n1], mask[:1, :n1])
            pg = sigmoid(got)
            d = np.abs(pg - pr)
            r = {
                "mean_abs_prob_diff": float(d.mean()),
                "p99_abs_prob_diff": float(np.quantile(d, 0.99)),
                "max_abs_prob_diff": float(d.max()),
                "flip_rate": float(((pg > thr) != (pr > thr)).mean()),
                "logit_corr": float(np.corrcoef(got.ravel(), ref.ravel())[0, 1]),
                "batch1_max_abs_logit_diff": float(np.abs(got1[0] - ref[0]).max()),
            }
            r["ok"] = r["max_abs_prob_diff"] < 1e-3 if p == "fp32" else r["flip_rate"] < 0.05
        except Exception as e:  # noqa: BLE001
            r = {"ok": False, "error": str(e)[:500]}
        report["files"][p] = {"file": f"onnx/{path.name}", "bytes": size, "mb": round(size / 1e6, 1), **r}
        ok_all &= r["ok"] or p != "fp32"
        if "error" in r:
            log(f"{p:6s} {size / 1e6:7.1f} MB  ERROR {r['error']}")
        else:
            log(f"{p:6s} {size / 1e6:7.1f} MB  mean|dp|={r['mean_abs_prob_diff']:.4f} p99={r['p99_abs_prob_diff']:.4f} "
                f"max={r['max_abs_prob_diff']:.3f} flips={r['flip_rate'] * 100:.2f}% corr={r['logit_corr']:.4f} "
                f"b1={r['batch1_max_abs_logit_diff']:.4f} {'OK' if r['ok'] else 'CHECK'}")

    tok_bytes = sum((out / f).stat().st_size for f in ("tokenizer.json", "tokenizer_config.json", "config.json"))
    report["tokenizer_and_config_bytes"] = tok_bytes
    report["build_times"] = built
    report["settings"] = {k: v for k, v in vars(args).items()}
    (out / "hush_export.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    log(f"done -> {out}  (tokenizer+config {tok_bytes / 1e6:.1f} MB)")
    if not ok_all:
        sys.exit(2)


if __name__ == "__main__":
    main()
