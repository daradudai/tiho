"""Collect live Twitch chat anonymously over IRC (no account needed).

Raw logs stay local (data/raw/ is git-ignored). They are only used to build
the training corpus; we never redistribute chat logs.

Moderator actions (CLEARMSG = message deleted, CLEARCHAT = user timed out /
banned) are recorded too: they are free weak labels for spam/toxicity.

Usage:
    python collect/twitch_irc.py --minutes 180 --top 90
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import ssl
import time
import urllib.request
from pathlib import Path

GQL_URL = "https://gql.twitch.tv/gql"
# Public web client id used by twitch.tv itself.
GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"

# Languages we want represented even if they are not in the global top list.
EXTRA_LANGS = {"BG": 10, "ES": 12, "DE": 8, "RU": 10, "PT": 10, "FR": 8, "IT": 6, "PL": 6, "TR": 6,
               "UK": 4, "RO": 4, "CS": 3, "JA": 4, "KO": 4, "AR": 3, "NL": 3, "SV": 2, "HU": 2,
               "EL": 2, "FI": 2, "DA": 2, "TH": 2, "VI": 2, "ID": 2, "ZH": 2, "HI": 2}
CHANNELS_PER_CONN = 25

STREAMS_Q = """query($first:Int,$after:Cursor,$langs:[Language!]){streams(first:$first,after:$after,options:{languages:$langs}){
  edges{cursor node{viewersCount broadcaster{login broadcastSettings{language}} game{name}}}}}"""


def gql(query: str, variables: dict) -> dict:
    req = urllib.request.Request(
        GQL_URL,
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={"Client-Id": GQL_CLIENT_ID, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        res = json.load(r)
    if "errors" in res:
        raise RuntimeError(res["errors"])
    return res


def streams(n: int, langs: list[str] | None) -> list[dict]:
    out, after = [], None
    while len(out) < n:
        res = gql(STREAMS_Q, {"first": min(30, n - len(out)), "after": after, "langs": langs})
        edges = res["data"]["streams"]["edges"]
        if not edges:
            break
        for e in edges:
            node, b = e["node"], e["node"]["broadcaster"]
            if not b:
                continue
            out.append({"login": b["login"], "viewers": node["viewersCount"],
                        "lang": ((b.get("broadcastSettings") or {}).get("language") or "").lower() or None,
                        "game": (node.get("game") or {}).get("name")})
        break  # pagination trips Twitch integrity checks; one page per query
    return out


def top_channels(top: int) -> list[dict]:
    chans: dict[str, dict] = {}
    for attempt in range(5):
        try:
            for c in streams(30, None) + streams(30, ["EN"]):
                chans.setdefault(c["login"], c)
            for lang, k in EXTRA_LANGS.items():
                for c in streams(k, [lang]):
                    chans.setdefault(c["login"], c)
            return list(chans.values())
        except Exception as ex:
            print("GQL error, retrying:", ex, flush=True)
            time.sleep(5 * (attempt + 1))
    return list(chans.values())


def parse_tags(raw: str) -> dict:
    tags = {}
    for kv in raw.split(";"):
        k, _, v = kv.partition("=")
        tags[k] = v.replace("\\s", " ").replace("\\:", ";")
    return tags


class Sink:
    def __init__(self, path: Path):
        self.f = path.open("a", encoding="utf-8")
        self.n = 0
        self.ev = 0

    def write(self, rec: dict):
        self.f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        if "event" in rec:
            self.ev += 1
        else:
            self.n += 1


async def connection(chans: list[dict], meta: dict, sink: Sink, deadline: float, cid: int):
    while time.time() < deadline:
        try:
            reader, writer = await asyncio.open_connection("irc.chat.twitch.tv", 6697, ssl=ssl.create_default_context())
            nick = f"justinfan{random.randint(10000, 99999)}"
            writer.write(b"CAP REQ :twitch.tv/tags twitch.tv/commands\r\n")
            writer.write(f"PASS SCHMOOPIIE\r\nNICK {nick}\r\n".encode())
            await writer.drain()
            for i, c in enumerate(chans):
                writer.write(f"JOIN #{c['login']}\r\n".encode())
                if i % 15 == 14:
                    await writer.drain()
                    await asyncio.sleep(11)  # JOIN rate limit: 20 / 10 s
            await writer.drain()
            while time.time() < deadline:
                try:
                    line = await asyncio.wait_for(reader.readline(), timeout=360)
                except asyncio.TimeoutError:
                    raise ConnectionError("idle timeout")
                if not line:
                    raise ConnectionError("closed by server")
                s = line.decode("utf-8", "replace").rstrip("\r\n")
                if s.startswith("PING"):
                    writer.write(b"PONG :tmi.twitch.tv\r\n")
                    await writer.drain()
                    continue
                if " RECONNECT" in s[:80]:
                    raise ConnectionError("server asked to reconnect")
                if not s.startswith("@"):
                    continue
                raw_tags, _, rest = s[1:].partition(" ")
                parts = rest.split(" ", 3)
                if len(parts) < 3:
                    continue
                cmd, chan = parts[1], parts[2].lstrip("#")
                tags = parse_tags(raw_tags)
                if cmd == "PRIVMSG":
                    sink.write({
                        "p": "twitch", "ch": chan, "lang": meta.get(chan, {}).get("lang"),
                        "ts": int(tags.get("tmi-sent-ts", "0") or 0), "id": tags.get("id"),
                        "u": tags.get("display-name"), "uid": tags.get("user-id"),
                        "badges": tags.get("badges", ""), "emotes": tags.get("emotes", ""),
                        "first": tags.get("first-msg") == "1", "reply": "reply-parent-msg-id" in tags,
                        "bits": tags.get("bits"), "text": parts[3][1:] if len(parts) > 3 else "",
                    })
                elif cmd in ("CLEARCHAT", "CLEARMSG"):
                    sink.write({"p": "twitch", "ch": chan, "event": cmd, "ts": int(tags.get("tmi-sent-ts", "0") or 0),
                                "target_msg": tags.get("target-msg-id"), "target_uid": tags.get("target-user-id"),
                                "duration": tags.get("ban-duration"), "text": parts[3][1:] if len(parts) > 3 else ""})
        except Exception as ex:
            print(f"[conn {cid}] {ex!r}; reconnecting in 5s", flush=True)
            await asyncio.sleep(5)


async def run(minutes: float, top: int, out_dir: Path, refresh_min: float) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"twitch_{time.strftime('%Y%m%d_%H%M%S')}.jsonl"
    sink = Sink(path)
    end = time.time() + minutes * 60
    t0 = time.time()
    while time.time() < end:
        chans = top_channels(top)
        meta = {c["login"]: c for c in chans}
        (out_dir / (path.stem + f"_channels_{int(time.time())}.json")).write_text(json.dumps(chans, indent=1))
        langs: dict[str, int] = {}
        for c in chans:
            langs[c["lang"] or "?"] = langs.get(c["lang"] or "?", 0) + 1
        print(f"joining {len(chans)} channels {langs}", flush=True)
        round_end = min(end, time.time() + refresh_min * 60)
        shards = [chans[i:i + CHANNELS_PER_CONN] for i in range(0, len(chans), CHANNELS_PER_CONN)]
        tasks = [asyncio.create_task(connection(s, meta, sink, round_end, i)) for i, s in enumerate(shards)]

        async def report():
            while time.time() < round_end:
                await asyncio.sleep(60)
                sink.f.flush()
                print(f"{sink.n} msgs, {sink.ev} mod events, {sink.n / (time.time() - t0):.0f}/s", flush=True)

        rep = asyncio.create_task(report())
        await asyncio.gather(*tasks)
        rep.cancel()
    sink.f.close()
    print(f"done: {sink.n} messages -> {path}", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=180)
    ap.add_argument("--top", type=int, default=90)
    ap.add_argument("--refresh", type=float, default=20, help="re-pick live channels every N minutes")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "data" / "raw"))
    a = ap.parse_args()
    asyncio.run(run(a.minutes, a.top, Path(a.out), a.refresh))
