"""Evaluate a student checkpoint (and optionally the teacher) on the gold set,
per label and per language, calibrate per-label thresholds, and write them into
the checkpoint's config.json as `hush.thresholds`.

    python train/evaluate.py runs/v1/best --gold data/gold.jsonl --teacher data/gold_teacher.jsonl --write
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
from sklearn.metrics import average_precision_score, f1_score, precision_score, recall_score
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from train import LABELS, predict

# What matters for a chat filter: hiding a good message is worse than letting one
# bad message through, so harmful heads are tuned for precision (F-beta, beta<1).
BETA = {"toxic": 0.7, "spam": 0.7, "scam": 0.7, "noise": 1.0, "question": 1.0, "positive": 1.0, "negative": 1.0}


def fbeta(p, r, b):
    return 0.0 if p + r == 0 else (1 + b * b) * p * r / (b * b * p + r)


def best_threshold(y, p, beta):
    best = (0, 0.5)
    for t in np.arange(0.05, 0.96, 0.01):
        pr = precision_score(y, p >= t, zero_division=0)
        rc = recall_score(y, p >= t, zero_division=0)
        best = max(best, (fbeta(pr, rc, beta), float(t)))
    return best[1]


def report(name, Y, P, thr, langs):
    print(f"\n### {name}")
    print(f"{'label':9} {'n+':>5} {'AP':>6} {'F1':>6} {'P':>6} {'R':>6} {'thr':>5}")
    out = {}
    for i, k in enumerate(LABELS):
        y, p = Y[:, i], P[:, i]
        if y.sum() == 0:
            continue
        t = thr[k]
        out[k] = dict(ap=average_precision_score(y, p), f1=f1_score(y, p >= t), p=precision_score(y, p >= t, zero_division=0),
                      r=recall_score(y, p >= t), thr=t, pos=int(y.sum()))
        o = out[k]
        print(f"{k:9} {o['pos']:5d} {o['ap']:6.3f} {o['f1']:6.3f} {o['p']:6.3f} {o['r']:6.3f} {t:5.2f}")
    print(f"macro F1 {np.mean([o['f1'] for o in out.values()]):.3f}  macro AP {np.mean([o['ap'] for o in out.values()]):.3f}")
    # per-language macro F1 over labels with positives
    by = defaultdict(list)
    for j, l in enumerate(langs):
        by[l or "?"].append(j)
    rows = []
    for l, idx in by.items():
        if len(idx) < 40:
            continue
        f1s = [f1_score(Y[idx, i], P[idx, i] >= thr[k]) for i, k in enumerate(LABELS) if Y[idx, i].sum() >= 3]
        if f1s:
            rows.append((l, len(idx), float(np.mean(f1s))))
    print("per-language macro F1:", ", ".join(f"{l}:{f:.2f}(n={n})" for l, n, f in sorted(rows, key=lambda x: -x[1])))
    return out


def main(a):
    gold = [json.loads(l) for l in open(a.gold, encoding="utf-8")]
    texts = [g["text"] for g in gold]
    Y = np.array([[int(g["y"][k]) for k in LABELS] for g in gold])
    langs = [g.get("lang") for g in gold]
    tok = AutoTokenizer.from_pretrained(a.ckpt)
    model = AutoModelForSequenceClassification.from_pretrained(a.ckpt).cuda()
    P = predict(model, tok, texts)
    # calibrate on half, report on the other half, then refit on all for shipping
    rng = np.random.default_rng(0)
    perm = rng.permutation(len(gold))
    cal, tst = perm[: len(perm) // 2], perm[len(perm) // 2:]
    thr_cal = {k: best_threshold(Y[cal, i], P[cal, i], BETA[k]) if Y[cal, i].sum() else 0.5 for i, k in enumerate(LABELS)}
    report("student @0.5 (all)", Y, P, {k: 0.5 for k in LABELS}, langs)
    report("student calibrated (held-out half)", Y[tst], P[tst], thr_cal, [langs[i] for i in tst])
    if a.teacher:
        tmap = {json.loads(l)["text"]: json.loads(l)["t"] for l in open(a.teacher, encoding="utf-8")}
        idx = [j for j, t in enumerate(texts) if t in tmap]
        PT = np.array([[tmap[texts[j]].get(k, 0) for k in LABELS] for j in idx])
        report("teacher Clef-Flash @0.5", Y[idx], PT, {k: 0.5 for k in LABELS}, [langs[j] for j in idx])
    thr_all = {k: round(best_threshold(Y[:, i], P[:, i], BETA[k]), 2) if Y[:, i].sum() else 0.5 for i, k in enumerate(LABELS)}
    print("\nshipping thresholds:", thr_all)
    if a.write:
        cfgp = Path(a.ckpt) / "config.json"
        cfg = json.loads(cfgp.read_text())
        cfg["hush"] = {"labels": LABELS, "thresholds": thr_all, "max_length": 64}
        cfgp.write_text(json.dumps(cfg, indent=2))
        print("wrote", cfgp)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("ckpt")
    ap.add_argument("--gold", default="data/gold.jsonl")
    ap.add_argument("--teacher")
    ap.add_argument("--write", action="store_true")
    main(ap.parse_args())
