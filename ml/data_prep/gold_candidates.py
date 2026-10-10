"""Pick gold-set candidates: messages from all platforms that are NOT in any
training pool, deduplicated and spread over languages/channels.

    python data_prep/gold_candidates.py --n 6000 --out data/gold_candidates.jsonl
Then label them with the teacher (for stratification and teacher-vs-gold agreement):
    python teacher/label.py data/gold_candidates.jsonl data/gold_teacher.jsonl
"""
from __future__ import annotations

import argparse
import glob
import json
import random
from collections import defaultdict
from pathlib import Path

from build_pool import norm

ROOT = Path(__file__).resolve().parents[1]


def main(n: int, out: Path, seed: int):
    random.seed(seed)
    excluded = set()
    for fp in glob.glob(str(ROOT / "data" / "pool_*.jsonl")):
        with open(fp, encoding="utf-8") as f:
            excluded.update(norm(json.loads(l)["text"]) for l in f)
    by_key = defaultdict(list)
    seen = set()
    for fp in sorted(glob.glob(str(ROOT / "data" / "raw" / "*.jsonl"))):
        with open(fp, encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if r.get("event") or not r.get("text"):
                    continue
                k = norm(r["text"])
                if k in excluded or k in seen or len(k) < 1:
                    continue
                seen.add(k)
                by_key[(r["p"], r["ch"])].append(r)
    groups = list(by_key.values())
    for g in groups:
        random.shuffle(g)
    picked = []
    # round-robin over channels so no single chat dominates
    i = 0
    while len(picked) < n and any(groups):
        for g in groups:
            if i < len(g):
                picked.append(g[i])
                if len(picked) >= n:
                    break
        i += 1
    random.shuffle(picked)
    with out.open("w", encoding="utf-8") as f:
        for r in picked:
            f.write(json.dumps({"text": r["text"], "p": r["p"], "ch": r["ch"], "lang": r.get("lang"),
                                "badges": r.get("badges", ""), "paid": r.get("paid", False)}, ensure_ascii=False) + "\n")
    plat = defaultdict(int)
    for r in picked:
        plat[r["p"]] += 1
    print(f"{len(picked)} candidates from {len(groups)} chats; per platform {dict(plat)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=6000)
    ap.add_argument("--out", default=str(ROOT / "data" / "gold_candidates.jsonl"))
    ap.add_argument("--seed", type=int, default=11)
    a = ap.parse_args()
    main(a.n, Path(a.out), a.seed)
