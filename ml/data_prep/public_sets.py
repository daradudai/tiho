"""Download permissively-licensed public datasets and convert them to the Hush
label space with per-label masks (a source only supervises the labels it knows).

Output: data/public.jsonl rows {"text", "lang", "src", "y": {label: float}}
Only labels present in "y" are supervised for that row.

Licenses (weights stay redistributable):
  google/civil_comments              CC0            toxic (soft)
  FredZhang7/toxi-text-3M            Apache-2.0     toxic, 55 languages incl. bg
  thehamkercat/telegram-spam-ham     WTFPL          scam
  wangyuancheng/discord-phishing-scam MIT           scam
  FredZhang7/all-scam-spam           Apache-2.0     scam (multilingual)
  tyqiangz/multilingual-sentiments   Apache-2.0     positive / negative
  UCI YouTube Spam Collection        CC-BY-4.0      scam (self-promo comments)
"""
from __future__ import annotations

import io
import json
import random
import urllib.request
import zipfile
from pathlib import Path

from datasets import load_dataset

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "public.jsonl"
random.seed(13)
MAXLEN = 300  # chars; chat is short, keep public text short too


def short(t: str) -> str | None:
    t = (t or "").strip().replace("\n", " ")
    if not t or len(t) > MAXLEN:
        return None
    return t


def emit(f, text, lang, src, y):
    t = short(text)
    if t:
        f.write(json.dumps({"text": t, "lang": lang, "src": src, "y": y}, ensure_ascii=False) + "\n")
        return 1
    return 0


def civil(f, n_pos=25000, n_neg=25000):
    ds = load_dataset("google/civil_comments", split="train", streaming=True)
    pos = neg = 0
    for r in ds:
        tox = float(r["toxicity"])
        sev = max(tox, float(r["insult"]), float(r["threat"]), float(r["identity_attack"]), float(r["severe_toxicity"]))
        if sev >= 0.5 and pos < n_pos:
            pos += emit(f, r["text"], "en", "civil", {"toxic": round(sev, 3)})
        elif sev < 0.1 and neg < n_neg and random.random() < 0.08:
            neg += emit(f, r["text"], "en", "civil", {"toxic": round(sev, 3)})
        if pos >= n_pos and neg >= n_neg:
            break
    return pos + neg


def toxi(f, per_lang_pos=2500, per_lang_neg=2500):
    ds = load_dataset("FredZhang7/toxi-text-3M", split="train", streaming=True)
    cnt: dict[tuple[str, int], int] = {}
    n = 0
    for r in ds:
        lang, lab = r.get("lang") or "?", int(r["is_toxic"])
        cap = per_lang_pos if lab else per_lang_neg
        if lang == "en":
            cap //= 4  # civil covers English
        if cnt.get((lang, lab), 0) >= cap:
            continue
        k = emit(f, r["text"], lang, "toxi3m", {"toxic": float(lab)})
        cnt[(lang, lab)] = cnt.get((lang, lab), 0) + k
        n += k
        if n >= 160000:
            break
    return n


def telegram(f):
    ds = load_dataset("thehamkercat/telegram-spam-ham", split="train")
    n = 0
    for r in ds:
        lab = 1.0 if str(r["text_type"]).lower() == "spam" else 0.0
        n += emit(f, r["text"], None, "telegram", {"scam": lab})
    return n


def discord(f):
    ds = load_dataset("wangyuancheng/discord-phishing-scam", split="train")
    cols = ds.column_names
    tcol = "msg_content" if "msg_content" in cols else ("text" if "text" in cols else cols[0])
    lcol = next(c for c in cols if c in ("label", "is_scam", "scam", "labels"))
    n = 0
    for r in ds:
        n += emit(f, r[tcol], None, "discord", {"scam": float(int(r[lcol]))})
    return n


def allscam(f, cap=20000):
    ds = load_dataset("FredZhang7/all-scam-spam", split="train")
    rows = list(ds)
    random.shuffle(rows)
    n = 0
    for r in rows[: cap * 3]:
        n += emit(f, r["text"], None, "allscam", {"scam": float(int(r["is_spam"]))})
        if n >= cap:
            break
    return n


def sentiment(f, per_lang=5000):
    n = 0
    for lang in ["english", "spanish", "german", "french", "portuguese", "italian", "japanese", "arabic", "chinese", "hindi", "indonesian", "malay"]:
        try:
            ds = load_dataset("tyqiangz/multilingual-sentiments", lang, split="train")
        except Exception as ex:
            print("skip", lang, ex)
            continue
        rows = list(ds)
        random.shuffle(rows)
        k = 0
        for r in rows:
            lab = int(r["label"])  # 0 positive, 1 neutral, 2 negative
            y = {"positive": 1.0 if lab == 0 else 0.0, "negative": 1.0 if lab == 2 else 0.0}
            k += emit(f, r["text"], lang[:2], "sentiment", y)
            if k >= per_lang:
                break
        n += k
    return n


def uci_youtube(f):
    url = "https://archive.ics.uci.edu/static/public/380/youtube+spam+collection.zip"
    data = urllib.request.urlopen(url, timeout=60).read()
    n = 0
    import csv
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            if not name.endswith(".csv") or name.startswith("__MACOSX"):
                continue
            rows = csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8", errors="replace"))
            for r in rows:
                n += emit(f, r["CONTENT"], "en", "uci_yt", {"scam": float(int(r["CLASS"]))})
    return n


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        for name, fn in [("uci_youtube", uci_youtube), ("telegram", telegram), ("discord", discord),
                         ("allscam", allscam), ("sentiment", sentiment), ("toxi", toxi), ("civil", civil)]:
            try:
                print(name, fn(f), flush=True)
            except Exception as ex:
                print("FAILED", name, repr(ex)[:300], flush=True)
