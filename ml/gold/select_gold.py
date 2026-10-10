"""Select ~2000 gold messages from teacher-labeled candidates, oversampling rare
classes (by teacher score) so every label has enough positives, then write the
workflow args (chunks) for gold_workflow.js.

    python gold/select_gold.py --n 2000 --chunk 200
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUOTAS = [("toxic", 0.25, 260), ("scam", 0.25, 160), ("spam", 0.3, 160), ("negative", 0.4, 160),
          ("question", 0.5, 160), ("positive", 0.4, 140), ("noise", 0.5, 120)]


def main(n, chunk, seed):
    random.seed(seed)
    rows = [json.loads(l) for l in open(ROOT / "data" / "gold_teacher.jsonl", encoding="utf-8")]
    random.shuffle(rows)
    picked, used = [], set()
    for lab, thr, cap in QUOTAS:
        c = 0
        for r in sorted(rows, key=lambda r: -r["t"][lab]):
            if c >= cap or r["t"][lab] < thr:
                break
            if r["text"] in used:
                continue
            used.add(r["text"])
            picked.append(r)
            c += 1
        print(f"{lab}: {c}")
    for r in rows:
        if len(picked) >= n:
            break
        if r["text"] not in used:
            used.add(r["text"])
            picked.append(r)
    random.shuffle(picked)
    for i, r in enumerate(picked):
        r["i"] = i
    (ROOT / "data" / "gold_selected.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in picked) + "\n", encoding="utf-8")
    chunks = [[{"i": r["i"], "text": r["text"], "p": r["p"], "lang": r.get("lang")} for r in picked[s:s + chunk]]
              for s in range(0, len(picked), chunk)]
    (ROOT / "gold" / "workflow_args.json").write_text(json.dumps({"chunks": chunks}, ensure_ascii=False), encoding="utf-8")
    print(f"selected {len(picked)} in {len(chunks)} chunks")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=2000)
    ap.add_argument("--chunk", type=int, default=200)
    ap.add_argument("--seed", type=int, default=3)
    a = ap.parse_args()
    main(a.n, a.chunk, a.seed)
