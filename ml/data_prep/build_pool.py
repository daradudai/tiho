"""Build a deduplicated, language/channel-balanced pool of chat messages to label.

Also attaches moderator weak labels: a message deleted by a mod (CLEARMSG) or
sent shortly before its author got timed out/banned (CLEARCHAT) gets "mod": 1.
Gold texts (data/gold.jsonl, once it exists) never enter a pool.

    python data_prep/build_pool.py --per-channel 4000 --out data/pool.jsonl
"""
from __future__ import annotations

import argparse
import glob
import json
import random
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPEAT = re.compile(r"(.)\1{2,}")
WS = re.compile(r"\s+")


def norm(t: str) -> str:
    t = unicodedata.normalize("NFKC", t).lower()
    t = REPEAT.sub(r"\1\1", t)
    return WS.sub(" ", t).strip()


def main(per_channel: int, out: Path, seed: int, pattern: str):
    random.seed(seed)
    by_ch: dict[str, list[dict]] = defaultdict(list)
    seen: set[str] = set()
    norm_count: dict[str, int] = defaultdict(int)
    deleted_ids: set[str] = set()
    bans: dict[tuple[str, str], list[int]] = defaultdict(list)
    gold: set[str] = set()  # eval only: gold texts and their near-copies stay out of every pool
    if (ROOT / "data" / "gold.jsonl").exists():
        with open(ROOT / "data" / "gold.jsonl", encoding="utf-8") as f:
            gold.update(norm(json.loads(l)["text"]) for l in f)
    files = sorted(glob.glob(str(ROOT / "data" / "raw" / pattern)))
    msgs = []
    for fp in files:
        with open(fp, encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                ev = r.get("event")
                if ev == "CLEARMSG" and r.get("target_msg"):
                    deleted_ids.add(r["target_msg"])
                elif ev == "CLEARCHAT" and r.get("target_uid"):
                    bans[(r["ch"], r["target_uid"])].append(r["ts"])
                elif not ev and r.get("text"):
                    msgs.append(r)
    for r in msgs:
        n = norm(r["text"])
        norm_count[n] += 1
        mod = 0
        if r.get("id") in deleted_ids:
            mod = 1
        else:
            for ts in bans.get((r["ch"], r.get("uid")), ()):
                if 0 <= ts - r["ts"] <= 60_000:
                    mod = 1
                    break
        if mod:
            r["mod"] = 1
        if n in seen or n in gold:
            continue
        seen.add(n)
        by_ch[r["ch"]].append(r)
    pool = []
    for ch, rows in by_ch.items():
        # keep every mod-flagged message; sample the rest
        flagged = [r for r in rows if r.get("mod")]
        rest = [r for r in rows if not r.get("mod")]
        random.shuffle(rest)
        pool.extend(flagged + rest[: max(0, per_channel - len(flagged))])
    random.shuffle(pool)
    with out.open("w", encoding="utf-8") as f:
        for r in pool:
            row = {"text": r["text"], "p": r.get("p"), "ch": r["ch"], "lang": (r.get("lang") or "").lower() or None,
                   "badges": r.get("badges", ""), "emotes": r.get("emotes", ""), "dup": norm_count[norm(r["text"])]}
            if r.get("mod"):
                row["mod"] = 1
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    langs = defaultdict(int)
    for r in pool:
        langs[(r.get("lang") or "?").lower()] += 1
    print(f"{len(msgs)} raw msgs, {len(seen)} unique, pool {len(pool)}, mod-flagged {sum(1 for r in pool if r.get('mod'))}")
    print(dict(sorted(langs.items(), key=lambda x: -x[1])))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-channel", type=int, default=4000)
    ap.add_argument("--out", default=str(ROOT / "data" / "pool.jsonl"))
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--glob", default="twitch_*.jsonl")
    a = ap.parse_args()
    main(a.per_channel, Path(a.out), a.seed, a.glob)
