"""Light benchmark of a running Hush Engine.

    python bench/bench.py --url http://127.0.0.1:7377 [--backend http://127.0.0.1:7378]

1. latency: 1 message x 3 custom filters, sequential, unique texts (no cache)
   (+ the same call straight to llama-server, to show the engine's overhead)
2. throughput: 32 concurrent clients, 1 message x 3 filters per request
3. batch: requests of 32 messages x 3 filters, 4 in flight
4. cache: the same 32 messages again (engine-only path)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import statistics
import time
from pathlib import Path

import httpx

FILTERS = [
    {"id": "backseat", "question": "Is this message backseating the streamer's gameplay?"},
    {"id": "spoiler", "question": "Does it spoil the plot of Elden Ring?"},
    {"id": "politics", "question": "Is this message about politics?"},
]
WORDS = ("bro just go left the boss is weak to fire why are you not using the shield lmao this run is cursed "
         "chat is he serious first time watching love the vibes what build is this omg that dodge was clean "
         "spoiler alert the ending is wild no way he missed that jump go right next time").split()
RUN = random.randrange(1 << 30)
_n = 0


def msg_text() -> str:
    global _n
    _n += 1
    return " ".join(random.choices(WORDS, k=random.randint(4, 14))) + f" #{RUN % 997}-{_n}"


def pct(xs: list[float], p: float) -> float:
    if not xs:
        return float("nan")
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(p * len(xs)))], 1)


async def latency(c: httpx.AsyncClient, url: str, backend: str | None, n: int) -> dict:
    eng, direct = [], []
    for i in range(n):
        text = msg_text()
        t = time.perf_counter()
        r = await c.post(f"{url}/v1/classify", json={
            "messages": [{"id": i, "text": text, "platform": "twitch"}], "filters": FILTERS, "deadline_ms": 0})
        r.raise_for_status()
        eng.append(1000 * (time.perf_counter() - t))
        if backend:
            qs = {f"f{j + 1}": {"type": "noul", "instructions": f["question"]} for j, f in enumerate(FILTERS)}
            t = time.perf_counter()
            r = await c.post(f"{backend}/v1/systemone", json={
                "model": "clef-flash", "state": f"Twitch live chat message: {text} (direct)", "questions": qs})
            r.raise_for_status()
            direct.append(1000 * (time.perf_counter() - t))
    out = {"n": n, "engine_ms_p50": pct(eng, .5), "engine_ms_p95": pct(eng, .95), "engine_ms_mean": round(statistics.mean(eng), 1)}
    if direct:
        out |= {"direct_ms_p50": pct(direct, .5), "direct_ms_p95": pct(direct, .95)}
    return out


async def throughput(c: httpx.AsyncClient, url: str, concurrency: int, duration: float, batch: int = 1, deadline_ms: int = 3000) -> dict:
    ok = expired = errors = 0
    lats: list[float] = []
    stop = time.perf_counter() + duration

    async def client(k: int):
        nonlocal ok, expired, errors
        while time.perf_counter() < stop:
            msgs = [{"id": f"{k}-{i}", "text": msg_text(), "platform": "twitch"} for i in range(batch)]
            t = time.perf_counter()
            try:
                r = await c.post(f"{url}/v1/classify", json={"messages": msgs, "filters": FILTERS, "deadline_ms": deadline_ms})
                r.raise_for_status()
            except httpx.HTTPError:
                errors += batch
                continue
            dt = 1000 * (time.perf_counter() - t)
            for res in r.json()["results"]:
                if "error" in res:
                    expired += res["error"] == "expired"
                    errors += res["error"] != "expired"
                else:
                    ok += 1
                    lats.append(dt)

    t0 = time.perf_counter()
    await asyncio.gather(*(client(k) for k in range(concurrency)))
    el = time.perf_counter() - t0
    return {"concurrency": concurrency, "batch": batch, "deadline_ms": deadline_ms, "seconds": round(el, 1),
            "ok": ok, "expired": expired, "errors": errors, "msgs_per_s": round(ok / el, 2),
            "ms_p50": pct(lats, .5), "ms_p95": pct(lats, .95)}


async def cached(c: httpx.AsyncClient, url: str, rounds: int = 50) -> dict:
    msgs = [{"id": i, "text": f"cache me {i} {RUN}", "platform": "twitch"} for i in range(32)]
    body = {"messages": msgs, "filters": FILTERS, "deadline_ms": 0}
    (await c.post(f"{url}/v1/classify", json=body)).raise_for_status()  # warm
    t0 = time.perf_counter()
    lats = []
    for _ in range(rounds):
        t = time.perf_counter()
        (await c.post(f"{url}/v1/classify", json=body)).raise_for_status()
        lats.append(1000 * (time.perf_counter() - t))
    el = time.perf_counter() - t0
    return {"msgs_per_s": round(rounds * 32 / el), "ms_p50_per_32": pct(lats, .5)}


async def main(a) -> None:
    async with httpx.AsyncClient(timeout=120, trust_env=False, limits=httpx.Limits(max_connections=128)) as c:
        h = (await c.get(f"{a.url}/health")).json()
        print(f"engine {h['version']} {h['mode']} model={h['decision_model']} device={h['device']} slots={h['limits']['slots']}")
        res = {"health": {k: h[k] for k in ("decision_model", "device", "mode", "limits")}}
        res["latency_1msg_3filters"] = await latency(c, a.url, a.backend, a.n)
        print("latency  ", res["latency_1msg_3filters"])
        res["throughput_32_clients"] = await throughput(c, a.url, a.concurrency, a.duration)
        print("concurrent", res["throughput_32_clients"])
        res["throughput_32_clients_no_deadline"] = await throughput(c, a.url, a.concurrency, a.duration, deadline_ms=0)
        print("no-deadln ", res["throughput_32_clients_no_deadline"])
        res["batch_32msgs_x4"] = await throughput(c, a.url, 4, a.duration, batch=32, deadline_ms=0)
        print("batch     ", res["batch_32msgs_x4"])
        res["cached"] = await cached(c, a.url)
        print("cached    ", res["cached"])
        h = (await c.get(f"{a.url}/health")).json()
        res["engine_queue_after"] = h["queue"]
        if a.out:
            Path(a.out).write_text(json.dumps(res, indent=1))
            print("wrote", a.out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:7377")
    ap.add_argument("--backend", help="llama-server URL for a direct-call comparison")
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--concurrency", type=int, default=32)
    ap.add_argument("--duration", type=float, default=15)
    ap.add_argument("--out", default=str(Path(__file__).with_name("results.json")))
    asyncio.run(main(ap.parse_args()))
