"""Collect live Kick chat anonymously via Kick's public Pusher websocket.

Same output format as twitch_irc.py (data/raw/kick_*.jsonl). Moderator events
(MessageDeletedEvent / UserBannedEvent) are kept as weak labels.

    python collect/kick_pusher.py --minutes 180 --channels 60
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import time
from pathlib import Path

import aiohttp

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"
PUSHER = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false"
EMOTE = re.compile(r"\[emote:(\d+):([^\]]+)\]")
LANGS = {"English": "en", "Spanish": "es", "Portuguese": "pt", "Arabic": "ar", "German": "de", "French": "fr",
         "Turkish": "tr", "Russian": "ru", "Italian": "it", "Polish": "pl", "Bulgarian": "bg", "Romanian": "ro"}
PER_CONN = 40


async def get_json(s: aiohttp.ClientSession, url: str):
    async with s.get(url, headers={"User-Agent": UA, "Accept": "application/json"}, timeout=aiohttp.ClientTimeout(total=20)) as r:
        return await r.json(content_type=None)


async def top_channels(s, n: int) -> list[dict]:
    out: dict[str, dict] = {}
    page = 1
    while len(out) < n and page <= 6:
        data = await get_json(s, f"https://kick.com/stream/livestreams/en?page={page}&limit=24&sort=desc")
        for ls in data.get("data", []):
            ch = ls.get("channel") or {}
            slug = ch.get("slug")
            if slug:
                out.setdefault(slug, {"slug": slug, "lang": LANGS.get(ls.get("language"), (ls.get("language") or "")[:2].lower() or None),
                                      "viewers": ls.get("viewer_count")})
        page += 1
    chans = list(out.values())[:n]
    for c in chans:
        try:
            info = await get_json(s, f"https://kick.com/api/v2/channels/{c['slug']}")
            c["chatroom"] = (info.get("chatroom") or {}).get("id")
        except Exception as ex:
            print("chatroom lookup failed", c["slug"], ex, flush=True)
        await asyncio.sleep(0.3)
    return [c for c in chans if c.get("chatroom")]


async def conn(s, chans, sink, deadline, cid):
    by_room = {str(c["chatroom"]): c for c in chans}
    while time.time() < deadline:
        try:
            async with s.ws_connect(PUSHER, headers={"User-Agent": UA}, heartbeat=60) as ws:
                for room in by_room:
                    await ws.send_str(json.dumps({"event": "pusher:subscribe", "data": {"auth": "", "channel": f"chatrooms.{room}.v2"}}))
                async for msg in ws:
                    if time.time() > deadline:
                        return
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    ev = json.loads(msg.data)
                    name = ev.get("event", "")
                    if name == "pusher:ping":
                        await ws.send_str(json.dumps({"event": "pusher:pong", "data": {}}))
                        continue
                    room = (ev.get("channel") or "").split(".")[1] if "." in (ev.get("channel") or "") else None
                    c = by_room.get(room or "")
                    if not c:
                        continue
                    data = ev.get("data")
                    if isinstance(data, str):
                        try:
                            data = json.loads(data)
                        except Exception:
                            continue
                    if not isinstance(data, dict):
                        continue
                    if name.endswith("ChatMessageEvent"):
                        snd = data.get("sender") or {}
                        badges = ",".join(b.get("type", "") for b in (snd.get("identity") or {}).get("badges") or [])
                        raw = data.get("content") or ""
                        n_emotes = len(EMOTE.findall(raw))
                        text = EMOTE.sub(lambda m: m.group(2), raw)
                        sink.write({"p": "kick", "ch": c["slug"], "lang": c.get("lang"), "ts": int(time.time() * 1000),
                                    "id": data.get("id"), "u": snd.get("username"), "uid": str(snd.get("id")),
                                    "badges": badges, "emotes": n_emotes, "reply": data.get("type") == "reply", "text": text})
                    elif name.endswith("MessageDeletedEvent"):
                        sink.write({"p": "kick", "ch": c["slug"], "event": "CLEARMSG", "ts": int(time.time() * 1000),
                                    "target_msg": (data.get("message") or {}).get("id")})
                    elif name.endswith("UserBannedEvent"):
                        sink.write({"p": "kick", "ch": c["slug"], "event": "CLEARCHAT", "ts": int(time.time() * 1000),
                                    "target_uid": str((data.get("user") or {}).get("id"))})
        except Exception as ex:
            print(f"[conn {cid}] {ex!r}; reconnecting", flush=True)
            await asyncio.sleep(5)


class Sink:
    def __init__(self, path):
        self.f = path.open("a", encoding="utf-8")
        self.n = self.ev = 0

    def write(self, r):
        self.f.write(json.dumps(r, ensure_ascii=False) + "\n")
        if "event" in r:
            self.ev += 1
        else:
            self.n += 1


async def main(minutes, n, out_dir: Path, refresh):
    out_dir.mkdir(parents=True, exist_ok=True)
    sink = Sink(out_dir / f"kick_{time.strftime('%Y%m%d_%H%M%S')}.jsonl")
    end = time.time() + minutes * 60
    t0 = time.time()
    async with aiohttp.ClientSession() as s:
        while time.time() < end:
            chans = await top_channels(s, n)
            langs = {}
            for c in chans:
                langs[c.get("lang")] = langs.get(c.get("lang"), 0) + 1
            print(f"subscribing {len(chans)} kick chatrooms {langs}", flush=True)
            round_end = min(end, time.time() + refresh * 60)
            shards = [chans[i:i + PER_CONN] for i in range(0, len(chans), PER_CONN)]
            tasks = [asyncio.create_task(conn(s, sh, sink, round_end, i)) for i, sh in enumerate(shards)]
            while time.time() < round_end:
                await asyncio.sleep(60)
                sink.f.flush()
                print(f"{sink.n} msgs, {sink.ev} mod events, {sink.n / (time.time() - t0):.0f}/s", flush=True)
            for t in tasks:
                t.cancel()
    sink.f.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=180)
    ap.add_argument("--channels", type=int, default=60)
    ap.add_argument("--refresh", type=float, default=30)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "data" / "raw"))
    a = ap.parse_args()
    asyncio.run(main(a.minutes, a.channels, Path(a.out), a.refresh))
