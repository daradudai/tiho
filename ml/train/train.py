"""Train the Hush Lite student: mmBERT-small + 7 sigmoid heads.

Data (JSONL):
  teacher   data/teacher*.jsonl  rows with "t": soft probs from Clef-Flash  (all 7 labels supervised)
  public    data/public.jsonl    rows with "y": partial labels              (masked loss)
  synth     data/synth*.jsonl    rows with "y": labels for synthetic hard cases
  gold      data/gold.jsonl      rows with "y": human/agent labels — eval only

    python train/train.py --out runs/v1 --epochs 3
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import random
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_cosine_schedule_with_warmup

LABELS = ["toxic", "spam", "scam", "noise", "question", "positive", "negative"]
ROOT = Path(__file__).resolve().parents[1]


def load_jsonl(pattern: str) -> list[dict]:
    rows = []
    for fp in sorted(glob.glob(str(ROOT / pattern))):
        with open(fp, encoding="utf-8") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # tolerate a torn line from an interrupted writer
    return rows


def to_example(r: dict, w: float = 1.0) -> tuple[str, list[float], list[float], float] | None:
    """-> (text, target[7], mask[7], weight)"""
    tgt = [0.0] * 7
    mask = [0.0] * 7
    if "t" in r:  # teacher soft labels, every head supervised
        for i, k in enumerate(LABELS):
            tgt[i] = float(r["t"].get(k, 0.0))
            mask[i] = 1.0
    if "y" in r:  # explicit labels override teacher
        for k, v in r["y"].items():
            if k in LABELS and v is not None:
                i = LABELS.index(k)
                tgt[i], mask[i] = float(v), 1.0
    if not any(mask):
        return None
    return r["text"], tgt, mask, w


class DS(Dataset):
    def __init__(self, ex):
        self.ex = ex

    def __len__(self):
        return len(self.ex)

    def __getitem__(self, i):
        return self.ex[i]


def collate(tok, max_len):
    def fn(batch):
        texts = [b[0] for b in batch]
        enc = tok(texts, padding=True, truncation=True, max_length=max_len, return_tensors="pt")
        enc["labels"] = torch.tensor([b[1] for b in batch], dtype=torch.float32)
        enc["mask"] = torch.tensor([b[2] for b in batch], dtype=torch.float32)
        enc["w"] = torch.tensor([b[3] for b in batch], dtype=torch.float32)
        return enc
    return fn


@torch.no_grad()
def predict(model, tok, texts, bs=256, max_len=64, device="cuda"):
    model.eval()
    out = []
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    for s in range(0, len(texts), bs):
        idx = order[s:s + bs]
        enc = tok([texts[i] for i in idx], padding=True, truncation=True, max_length=max_len, return_tensors="pt").to(device)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            logits = model(**enc).logits.float()
        out.append((idx, torch.sigmoid(logits).cpu().numpy()))
    probs = np.zeros((len(texts), len(LABELS)), dtype=np.float32)
    for idx, p in out:
        probs[idx] = p
    return probs


def metrics(probs, ex, thr=0.5):
    """Per-label F1 / AUC-ish agreement against (soft) targets binarized at 0.5, honoring masks."""
    from sklearn.metrics import average_precision_score, f1_score
    tgt = np.array([e[1] for e in ex])
    mask = np.array([e[2] for e in ex])
    res = {}
    for i, k in enumerate(LABELS):
        m = mask[:, i] > 0
        if m.sum() < 20:
            continue
        y = (tgt[m, i] >= 0.5).astype(int)
        if y.sum() == 0 or y.sum() == len(y):
            continue
        p = probs[m, i]
        best = max(((f1_score(y, p >= t), t) for t in np.arange(0.1, 0.91, 0.05)), key=lambda x: x[0])
        res[k] = {"n": int(m.sum()), "pos": int(y.sum()), "f1@.5": round(f1_score(y, p >= thr), 3),
                  "best_f1": round(best[0], 3), "best_thr": round(float(best[1]), 2),
                  "ap": round(average_precision_score(y, p), 3)}
    return res


def main(a):
    random.seed(a.seed)
    torch.manual_seed(a.seed)
    teacher = load_jsonl(a.teacher)
    public = load_jsonl(a.public) if a.public else []
    synth = load_jsonl(a.synth) if a.synth else []
    silver = load_jsonl(a.silver) if a.silver else []
    gold = load_jsonl(a.gold) if a.gold else []
    gold_texts = {g["text"] for g in gold}
    teacher = [r for r in teacher if r["text"] not in gold_texts]
    random.shuffle(teacher)
    n_val = min(3000, len(teacher) // 10)
    val_t, train_t = teacher[:n_val], teacher[n_val:]
    random.shuffle(public)
    public = public[: int(len(train_t) * a.public_ratio)] if a.public_ratio > 0 else []
    silver = [r for r in silver if r["text"] not in gold_texts]
    train_ex = [e for e in (to_example(r) for r in train_t + synth * a.synth_repeat) if e]
    train_ex += [e for e in (to_example(r, a.public_w) for r in public) if e]
    train_ex += [e for e in (to_example(r, a.silver_w) for r in silver) if e]
    val_ex = [e for e in map(to_example, val_t) if e]
    gold_ex = [e for e in map(to_example, gold) if e]
    print(f"train {len(train_ex)} (teacher {len(train_t)}, silver {len(silver)} w{a.silver_w}, public {len(public)}, synth {len(synth)}x{a.synth_repeat}) | val {len(val_ex)} | gold {len(gold_ex)}", flush=True)

    tok = AutoTokenizer.from_pretrained(a.base)
    model = AutoModelForSequenceClassification.from_pretrained(
        a.base, num_labels=len(LABELS), problem_type="multi_label_classification",
        id2label=dict(enumerate(LABELS)), label2id={k: i for i, k in enumerate(LABELS)},
    ).cuda()
    dl = DataLoader(DS(train_ex), batch_size=a.bs, shuffle=True, collate_fn=collate(tok, a.max_len), num_workers=0)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    steps = len(dl) * a.epochs
    sched = get_cosine_schedule_with_warmup(opt, int(0.06 * steps), steps)
    bce = nn.BCEWithLogitsLoss(reduction="none")
    # Rare heads (toxic/scam) get more weight so they aren't drowned by noise/clean.
    lw = torch.tensor([a.rare_w, 1.0, a.rare_w, 1.0, 1.0, 1.0, 1.0], device="cuda")
    step = 0
    t0 = time.time()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    best = -1
    for ep in range(a.epochs):
        model.train()
        for batch in dl:
            labels = batch.pop("labels").cuda()
            mask = batch.pop("mask").cuda()
            w = batch.pop("w").cuda().unsqueeze(1)
            batch = {k: v.cuda() for k, v in batch.items()}
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits = model(**batch).logits.float()
            loss = (bce(logits, labels) * mask * lw * w).sum() / (mask * w).sum().clamp(min=1)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            step += 1
            if step % 200 == 0:
                print(f"ep {ep} step {step}/{steps} loss {loss.item():.4f} {(time.time()-t0)/step*1000:.0f}ms/step", flush=True)
        probs = predict(model, tok, [e[0] for e in val_ex], max_len=a.max_len)
        m = metrics(probs, val_ex)
        score = float(np.mean([v["ap"] for v in m.values()])) if m else 0
        print(f"== epoch {ep} val(teacher agreement) mAP {score:.3f}", json.dumps(m), flush=True)
        if gold_ex:
            gm = metrics(predict(model, tok, [e[0] for e in gold_ex], max_len=a.max_len), gold_ex)
            gscore = float(np.mean([v["ap"] for v in gm.values()]))
            print(f"== epoch {ep} GOLD mAP {gscore:.3f}", json.dumps(gm), flush=True)
            score = gscore
        if score > best:
            best = score
            model.save_pretrained(out / "best")
            tok.save_pretrained(out / "best")
            (out / "val_metrics.json").write_text(json.dumps({"epoch": ep, "val": m}, indent=1))
    print(f"done in {(time.time()-t0)/60:.1f} min, best val mAP {best:.3f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="jhu-clsp/mmBERT-small")
    ap.add_argument("--teacher", default="data/teacher*.jsonl")
    ap.add_argument("--public", default="data/public.jsonl")
    ap.add_argument("--synth", default="data/synth*.jsonl")
    ap.add_argument("--gold", default="data/gold.jsonl")
    ap.add_argument("--silver", default="data/silver.jsonl")
    ap.add_argument("--silver-w", type=float, default=3.0)
    ap.add_argument("--public-w", type=float, default=0.5)
    ap.add_argument("--public-ratio", type=float, default=0.5)
    ap.add_argument("--synth-repeat", type=int, default=2)
    ap.add_argument("--out", default="runs/v1")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--bs", type=int, default=64)
    ap.add_argument("--lr", type=float, default=6e-5)
    ap.add_argument("--max-len", type=int, default=64)
    ap.add_argument("--rare-w", type=float, default=2.0)
    ap.add_argument("--seed", type=int, default=7)
    main(ap.parse_args())
