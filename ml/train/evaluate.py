"""Evaluate a student checkpoint (and optionally the teacher) on the gold set,
per label and per language, calibrate per-label thresholds, and write them into
the checkpoint's config.json as `tiho.thresholds`.

The student sees each message the way the extension feeds it (`clean_for_model`).
The shipped thresholds are fit on all of gold, so scoring them on gold would be
optimistic; their precision and recall are estimated out of fold instead: each
fold gets thresholds fit on the other folds, and the decisions are pooled.

Gold oversamples messages the teacher scored high (gold/select_gold.py). With the
selection record (`w` per row, the inverse chance of being picked), the
out-of-fold numbers are also weighted back to the candidate pool, which is closer
to what real chat looks like.

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

from textclean import clean_for_model
from train import LABELS, predict

# What matters for a chat filter: hiding a good message is worse than letting one
# bad message through, so harmful heads are tuned for precision (F-beta, beta<1).
BETA = {"toxic": 0.7, "spam": 0.7, "scam": 0.7, "noise": 1.0, "question": 1.0, "positive": 1.0, "negative": 1.0}
FOLDS = 5


def fbeta(p, r, b):
    return 0.0 if p + r == 0 else (1 + b * b) * p * r / (b * b * p + r)


def best_threshold(y, p, beta):
    best = (0, 0.5)
    for t in np.arange(0.05, 0.96, 0.01):
        pr = precision_score(y, p >= t, zero_division=0)
        rc = recall_score(y, p >= t, zero_division=0)
        best = max(best, (fbeta(pr, rc, beta), float(t)))
    return best[1]


def fit_thresholds(Y, P):
    return {k: round(best_threshold(Y[:, i], P[:, i], BETA[k]), 2) if Y[:, i].sum() else 0.5 for i, k in enumerate(LABELS)}


def decide(P, thr):
    return P >= np.array([thr[k] for k in LABELS])


def out_of_fold(Y, P, folds=FOLDS, seed=0):
    """Decisions for every message at thresholds fit without it: the k-fold estimate
    for thresholds fit on all of gold. -> (decisions, thresholds of each fold)"""
    fold = np.random.default_rng(seed).permutation(len(Y)) % folds
    D = np.zeros(P.shape, dtype=bool)
    fits = []
    for f in range(folds):
        thr = fit_thresholds(Y[fold != f], P[fold != f])
        D[fold == f] = decide(P[fold == f], thr)
        fits.append(thr)
    return D, fits


def report(name, Y, P, D, langs, thr, w=None):
    """`D`: decisions; `thr`: each label's threshold as printed; `w`: sample weights (None = 1)."""
    print(f"\n### {name}")
    print(f"{'label':9} {'n+':>5} {'AP':>6} {'F1':>6} {'P':>6} {'R':>6} {'thr':>9}")
    out = {}
    for i, k in enumerate(LABELS):
        y, p, d = Y[:, i], P[:, i], D[:, i]
        if y.sum() == 0:
            continue
        out[k] = dict(ap=average_precision_score(y, p, sample_weight=w), f1=f1_score(y, d, sample_weight=w),
                      p=precision_score(y, d, sample_weight=w, zero_division=0), r=recall_score(y, d, sample_weight=w),
                      thr=thr[k], pos=int(y.sum()))
        o = out[k]
        print(f"{k:9} {o['pos']:5d} {o['ap']:6.3f} {o['f1']:6.3f} {o['p']:6.3f} {o['r']:6.3f} {thr[k]:>9}")
    print(f"macro F1 {np.mean([o['f1'] for o in out.values()]):.3f}  macro AP {np.mean([o['ap'] for o in out.values()]):.3f}")
    # per-language macro F1 over labels with positives
    by = defaultdict(list)
    for j, l in enumerate(langs):
        by[l or "?"].append(j)
    rows = []
    for l, idx in by.items():
        if len(idx) < 40:
            continue
        f1s = [f1_score(Y[idx, i], D[idx, i]) for i in range(len(LABELS)) if Y[idx, i].sum() >= 3]
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
    P = predict(model, tok, [clean_for_model(t) for t in texts])
    at = lambda t: {k: t for k in LABELS}
    report("student @0.5 (all)", Y, P, decide(P, at(0.5)), langs, at("0.50"))
    D, fits = out_of_fold(Y, P)
    spread = {k: f"{min(f[k] for f in fits):.2f}-{max(f[k] for f in fits):.2f}" for k in LABELS}
    report(f"student calibrated, out of fold ({FOLDS} folds; thr = range over folds)", Y, P, D, langs, spread)
    weights = {}
    if Path(a.selected).exists():
        weights = {r["text"]: r["w"] for r in map(json.loads, open(a.selected, encoding="utf-8")) if "w" in r}
    if all(t in weights for t in texts):
        report("student calibrated, out of fold, weighted to the candidate pool", Y, P, D, langs, spread,
               w=np.array([weights[t] for t in texts]))
    else:
        print(f"\n(no weighted estimate: {a.selected} lacks the selection weight `w` of some gold texts)")
    if a.teacher:
        tmap = {json.loads(l)["text"]: json.loads(l)["t"] for l in open(a.teacher, encoding="utf-8")}
        idx = [j for j, t in enumerate(texts) if t in tmap]
        PT = np.array([[tmap[texts[j]].get(k, 0) for k in LABELS] for j in idx])
        report("teacher Clef-Flash @0.5", Y[idx], PT, decide(PT, at(0.5)), [langs[j] for j in idx], at("0.50"))
    thr_all = fit_thresholds(Y, P)
    print("\nshipping thresholds (fit on all of gold):", thr_all)
    if a.write:
        cfgp = Path(a.ckpt) / "config.json"
        cfg = json.loads(cfgp.read_text())
        cfg.pop("hush", None)  # pre-rename key
        cfg["tiho"] = {"labels": LABELS, "thresholds": thr_all, "max_length": 64}
        cfgp.write_text(json.dumps(cfg, indent=2))
        print("wrote", cfgp)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("ckpt")
    ap.add_argument("--gold", default="data/gold.jsonl")
    ap.add_argument("--selected", default="data/gold_selected.jsonl", help="gold/select_gold.py output, for the weights `w`")
    ap.add_argument("--teacher")
    ap.add_argument("--write", action="store_true")
    main(ap.parse_args())
