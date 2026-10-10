"""Supplement to public_sets.py: discord scam (MIT) + clapAI multilingual sentiment (Apache-2.0).
Prefers short, social-media-like domains; writes data/public_extra.jsonl."""
import json, random
from collections import Counter
from datasets import load_dataset
from public_sets import emit, ROOT
OUT = ROOT / "data" / "public_extra.jsonl"

random.seed(5)
SOCIAL = ("tweet", "twitter", "social", "comment", "youtube", "chat", "forum", "reddit")

with OUT.open("w", encoding="utf-8") as f:
    n = 0
    for r in load_dataset("wangyuancheng/discord-phishing-scam", split="train"):
        if r["msg_content"]:
            n += emit(f, r["msg_content"], None, "discord", {"scam": float(int(r["lable"]))})
    print("discord", n, flush=True)

    cnt = Counter()
    n = 0
    for r in load_dataset("clapAI/MultiLingualSentiment", split="train", streaming=True):
        lang = r["language"]
        dom = (r.get("domain") or "").lower()
        social = any(s in dom for s in SOCIAL)
        if not social and random.random() > 0.15:
            continue
        if cnt[lang] >= 6000:
            continue
        lab = r["label"]
        y = {"positive": 1.0 if lab == "positive" else 0.0, "negative": 1.0 if lab == "negative" else 0.0}
        k = emit(f, r["text"], lang, "sentiment", y)
        cnt[lang] += k
        n += k
        if n >= 70000:
            break
    print("sentiment", n, dict(cnt), flush=True)
