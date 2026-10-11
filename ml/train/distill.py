"""Distill the full Tiho Lite student (22 layers) into a shallower one for
CPU/WASM and weak GPUs.

The student is initialized from the teacher's own layers. ModernBERT alternates
one global-attention layer (RoPE theta 160k) with two local ones (theta 10k), and
the type is derived from the layer index, so we keep whole aligned blocks of 3
(global, local, local) to preserve each layer's attention type and RoPE.

With --student-init the student starts from an existing (already distilled)
checkpoint instead; that is needed when a teacher is wider than the student.

Targets: the teacher's probabilities (the average of several teachers', given more
than one --teacher) on every unique real chat message in data/raw/ (no labels
needed) plus the labeled sets, where the hard label is mixed with the teacher
probability. Texts are cleaned the way the extension feeds the model
(`clean_for_model`); gold texts are left out.

    python train/distill.py --teacher runs/v2/best --blocks 0,3,6 --out runs/v2-9L
    python train/distill.py --teacher runs/v3-base/best runs/v2/best --student-init runs/v2-6L/best --out runs/v3-6L-ens
"""
from __future__ import annotations

import argparse
import copy
import glob
import json
import random
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_cosine_schedule_with_warmup

from textclean import clean_for_model
from train import LABELS, ROOT, load_jsonl, metrics, predict, to_example


def build_student(teacher, blocks: list[int]):
    keep = [i for b in blocks for i in (b * 3, b * 3 + 1, b * 3 + 2) if i < teacher.config.num_hidden_layers]
    student = copy.deepcopy(teacher)
    student.model.layers = nn.ModuleList([student.model.layers[i] for i in keep])
    student.config.num_hidden_layers = len(keep)
    if getattr(teacher.config, "layer_types", None):
        student.config.layer_types = [teacher.config.layer_types[i] for i in keep]
    for j, layer in enumerate(student.model.layers):
        if hasattr(layer, "layer_idx"):
            layer.layer_idx = j
        if hasattr(layer, "attn") and hasattr(layer.attn, "layer_idx"):
            layer.attn.layer_idx = j
    print(f"student keeps layers {keep} ({len(keep)} of {teacher.config.num_hidden_layers})")
    return student


def corpus(pattern: str, exclude: set[str]) -> list[str]:
    seen, out = set(), []
    for fp in sorted(glob.glob(str(ROOT / "data" / "raw" / pattern))):
        with open(fp, encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                t = r.get("text")
                if r.get("event") or not t or len(t) > 300:
                    continue
                t = clean_for_model(t)
                k = t.lower()
                if k in seen or t in exclude:
                    continue
                seen.add(k)
                out.append(t)
    return out


def main(a):
    random.seed(0)
    torch.manual_seed(0)
    tok = AutoTokenizer.from_pretrained(a.teacher[0])
    gold = load_jsonl("data/gold.jsonl")
    gold_texts = {clean_for_model(g["text"]) for g in gold}
    labeled = []
    for pat in ["data/silver*.jsonl", "data/synth_v*.jsonl"]:
        for r in load_jsonl(pat):
            e = to_example(r)
            if e and all(m > 0 for m in e[2]):
                labeled.append((e[0], e[1]))
    labeled = [x for x in labeled if x[0] not in gold_texts]
    unl = corpus(a.raw_glob, gold_texts)
    if a.max_unlabeled:
        random.shuffle(unl)
        unl = unl[: a.max_unlabeled]
    texts = unl + [t for t, _ in labeled]
    print(f"distill set: {len(unl)} unlabeled + {len(labeled)} labeled", flush=True)
    t0 = time.time()
    # One teacher, or an ensemble whose probabilities are averaged (all mmBERT, same tokenizer).
    P = None
    for path in a.teacher:
        teacher = AutoModelForSequenceClassification.from_pretrained(path).cuda().eval()
        p = predict(teacher, tok, texts, bs=512)
        P = p if P is None else P + p
        del teacher
        torch.cuda.empty_cache()
    P /= len(a.teacher)
    print(f"teacher probs ({len(a.teacher)} teacher(s)) in {time.time()-t0:.0f}s", flush=True)
    targets = P.copy()
    for j, (_, y) in enumerate(labeled):
        targets[len(unl) + j] = a.label_mix * np.array(y) + (1 - a.label_mix) * P[len(unl) + j]
    data = list(zip(texts, targets.tolist()))

    if a.student_init:
        # Cross-architecture distillation (e.g. a wider teacher): start from an existing student.
        student = AutoModelForSequenceClassification.from_pretrained(a.student_init).cuda()
        print(f"student initialized from {a.student_init} ({student.config.num_hidden_layers} layers)")
    else:
        teacher = AutoModelForSequenceClassification.from_pretrained(a.teacher[0]).cuda()
        student = build_student(teacher, [int(b) for b in a.blocks.split(",")]).cuda()
        del teacher
    torch.cuda.empty_cache()

    def collate(batch):
        enc = tok([b[0] for b in batch], padding=True, truncation=True, max_length=64, return_tensors="pt")
        enc["labels"] = torch.tensor([b[1] for b in batch], dtype=torch.float32)
        return enc

    dl = DataLoader(data, batch_size=a.bs, shuffle=True, collate_fn=collate)
    opt = torch.optim.AdamW(student.parameters(), lr=a.lr, weight_decay=0.01)
    steps = len(dl) * a.epochs
    sched = get_cosine_schedule_with_warmup(opt, int(0.05 * steps), steps)
    bce = nn.BCEWithLogitsLoss()
    gold_ex = [e for e in map(to_example, gold) if e]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "args.json").write_text(json.dumps(vars(a), indent=1))
    best = -1
    step = 0
    t0 = time.time()
    for ep in range(a.epochs):
        student.train()
        for batch in dl:
            labels = batch.pop("labels").cuda()
            batch = {k: v.cuda() for k, v in batch.items()}
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits = student(**batch).logits.float()
            loss = bce(logits, labels)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(student.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            step += 1
            if step % 500 == 0:
                print(f"ep {ep} step {step}/{steps} loss {loss.item():.4f} {(time.time()-t0)/step*1000:.0f}ms/step", flush=True)
        gm = metrics(predict(student, tok, [e[0] for e in gold_ex]), gold_ex)
        score = float(np.mean([v["ap"] for v in gm.values()]))
        print(f"== epoch {ep} GOLD mAP {score:.3f}", json.dumps({k: v["ap"] for k, v in gm.items()}), flush=True)
        if score > best:
            best = score
            student.save_pretrained(out / "best")
            tok.save_pretrained(out / "best")
    print(f"done in {(time.time()-t0)/60:.1f} min, best gold mAP {best:.3f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--teacher", nargs="+", default=["runs/v2/best"], help="one or more teachers; probabilities are averaged")
    ap.add_argument("--student-init", help="start from this checkpoint instead of slicing the teacher (needed when the teacher is wider)")
    ap.add_argument("--blocks", default="0,3,6", help="3-layer blocks to keep (block b = layers 3b..3b+2)")
    ap.add_argument("--out", default="runs/v2-9L")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--bs", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--label-mix", type=float, default=0.5)
    ap.add_argument("--max-unlabeled", type=int, default=0)
    ap.add_argument("--raw-glob", default="*.jsonl", help="collector files in data/raw/ (the *_channels sidecars are .json)")
    main(ap.parse_args())
