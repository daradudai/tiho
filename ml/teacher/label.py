"""Label chat messages with the Clef-Flash decision model (teacher).

Reads a JSONL of {"text", "lang"?, "p"?, "ch"?} and writes the same rows with a
"t" dict of teacher probabilities per label. Resumable: skips texts already in out.

    python teacher/label.py data/pool.jsonl data/teacher.jsonl --workers 24
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

import aiohttp

LABELS = ["toxic", "spam", "scam", "noise", "question", "positive", "negative"]

QUESTIONS = {
    "toxic": {"type": "noul", "instructions": "Is this live-chat message toxic: an insult, harassment, hate speech, a slur, a threat, or sexual harassment toward anyone (streamer, chatters, groups)? Banter and swearing without a target are not toxic."},
    "spam": {"type": "noul", "instructions": "Is this live-chat message spam: flooding, a copypasta, a wall of repeated characters, words or emotes, or keyboard-mash gibberish?"},
    "scam": {"type": "noul", "instructions": "Is this message self-promotion, a bot, a scam, a fake giveaway, begging for follows/subs, or a crypto / gambling / viewer-selling pitch?"},
    "noise": {"type": "noul", "instructions": "Is this a low-effort reaction with no real content, e.g. a single emote or word like W, L, lol, KEKW, first, ?, 1, F?"},
    "question": {"type": "noul", "instructions": "Does this message ask a genuine question (to the streamer or to chat)?"},
    "tone": {"type": "choice", "instructions": "What is the tone of this message?",
             "criteria": {"positive": "supportive, kind, grateful, excited hype",
                          "neutral": "neutral, informational or plain reaction",
                          "negative": "complaining, critical, annoyed or hostile"}},
}

PLAT = {"twitch": "Twitch", "youtube": "YouTube", "kick": "Kick"}


def state_for(row: dict) -> str:
    p = PLAT.get(row.get("p") or "", "live-stream")
    return f"{p} live chat message: {row['text']}"


async def worker(name, q: asyncio.Queue, session, url, out, stats):
    while True:
        row = await q.get()
        if row is None:
            q.task_done()
            return
        body = {"model": "clef-flash", "state": state_for(row), "questions": QUESTIONS}
        for attempt in range(4):
            try:
                async with session.post(url, json=body, timeout=aiohttp.ClientTimeout(total=120)) as r:
                    data = await r.json()
                a = data["answers"]
                t = {k: round(a[k]["noul"], 4) for k in ["toxic", "spam", "scam", "noise", "question"]}
                probs = a["tone"]["probabilities"]
                t["positive"] = round(probs["positive"], 4)
                t["negative"] = round(probs["negative"], 4)
                row["t"] = t
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                stats["n"] += 1
                break
            except Exception as ex:  # transient server hiccup
                stats["err"] += 1
                await asyncio.sleep(1 + attempt)
        q.task_done()


async def main(inp: Path, outp: Path, url: str, workers: int, limit: int | None):
    done = set()
    if outp.exists():
        with outp.open(encoding="utf-8") as f:
            for line in f:
                try:
                    done.add(json.loads(line)["text"])
                except Exception:
                    pass
    rows = []
    with inp.open(encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            if r["text"] not in done:
                rows.append(r)
            if limit and len(rows) >= limit:
                break
    print(f"{len(done)} already labeled, {len(rows)} to go", flush=True)
    q: asyncio.Queue = asyncio.Queue(maxsize=workers * 4)
    stats = {"n": 0, "err": 0}
    t0 = time.time()
    with outp.open("a", encoding="utf-8") as out:
        async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=workers)) as s:
            tasks = [asyncio.create_task(worker(i, q, s, url, out, stats)) for i in range(workers)]
            for i, r in enumerate(rows):
                await q.put(r)
                if i and i % 2000 == 0:
                    out.flush()
                    el = time.time() - t0
                    print(f"{stats['n']} labeled, {stats['n']/el:.1f}/s, errors {stats['err']}", flush=True)
            for _ in tasks:
                await q.put(None)
            await asyncio.gather(*tasks)
    el = time.time() - t0
    print(f"done {stats['n']} in {el:.0f}s ({stats['n']/max(el,1):.1f}/s), errors {stats['err']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("inp")
    ap.add_argument("out")
    ap.add_argument("--url", default="http://127.0.0.1:7378/v1/systemone")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    asyncio.run(main(Path(a.inp), Path(a.out), a.url, a.workers, a.limit))
