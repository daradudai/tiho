"""Collect YouTube live chat without an API key via the innertube get_live_chat
endpoint (what the live_chat popout itself polls). Streams are found through
YouTube search in several languages. Moderator deletions are weak labels.

    python collect/youtube_live.py --minutes 150 --streams 30
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import time
import urllib.parse
from pathlib import Path

import aiohttp

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9", "Cookie": "CONSENT=YES+1; SOCS=CAI"}
QUERIES = [("live gaming", None), ("live stream", None), ("en vivo", "es"), ("ao vivo", "pt"), ("на живо", "bg"),
           ("стрийм", "bg"), ("стрим", "ru"), ("live deutsch", "de"), ("en direct", "fr"), ("ライブ配信", "ja"),
           ("canlı yayın", "tr"), ("vtuber live", None), ("transmisja na żywo", "pl"), ("diretta", "it"),
           ("live fortnite", None), ("live minecraft", None), ("live football", None), ("live news", None)]
LIVE_FILTER = "EgJAAQ%253D%253D"
INIT = re.compile(r'(?:window\["ytInitialData"\]|var ytInitialData)\s*=\s*(\{.*?\});\s*</script>', re.S)


async def text_of(s, url):
    async with s.get(url, headers=UA, timeout=aiohttp.ClientTimeout(total=25)) as r:
        return await r.text()


def walk_videos(o, out):
    if isinstance(o, dict):
        if "videoRenderer" in o:
            v = o["videoRenderer"]
            runs = (v.get("viewCountText") or {}).get("runs") or [{}]
            w = re.sub(r"[^\d]", "", runs[0].get("text", "0")) or "0"
            out.append((v["videoId"], int(w)))
        for x in o.values():
            walk_videos(x, out)
    elif isinstance(o, list):
        for x in o:
            walk_videos(x, out)


async def search_live(s, q):
    html = await text_of(s, f"https://www.youtube.com/results?search_query={urllib.parse.quote(q)}&sp={LIVE_FILTER}")
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", html, re.S)
    out = []
    if m:
        walk_videos(json.loads(m.group(1)), out)
    return out


def runs_text(runs):
    parts, emotes = [], 0
    for r in runs or []:
        if "text" in r:
            parts.append(r["text"])
        elif "emoji" in r:
            e = r["emoji"]
            emotes += 1
            if e.get("isCustomEmoji"):
                sc = (e.get("shortcuts") or [""])[0]
                parts.append(sc.strip(":"))
            else:
                parts.append((e.get("emojiId") or ""))
    return "".join(parts), emotes


def parse_actions(actions, vid, lang, sink, stats):
    for a in actions or []:
        if "replayChatItemAction" in a:
            continue
        add = (a.get("addChatItemAction") or {}).get("item") or {}
        for kind, paid in (("liveChatTextMessageRenderer", False), ("liveChatPaidMessageRenderer", True)):
            r = add.get(kind)
            if not r:
                continue
            text, emotes = runs_text((r.get("message") or {}).get("runs"))
            badges = ",".join(((b.get("liveChatAuthorBadgeRenderer") or {}).get("tooltip") or "") for b in r.get("authorBadges") or [])
            sink.write(json.dumps({"p": "youtube", "ch": vid, "lang": lang, "ts": int(r.get("timestampUsec", "0")) // 1000,
                                   "id": r.get("id"), "u": (r.get("authorName") or {}).get("simpleText"),
                                   "uid": r.get("authorExternalChannelId"), "badges": badges, "emotes": emotes,
                                   "paid": paid, "text": text}, ensure_ascii=False) + "\n")
            stats["n"] += 1
        d = a.get("markChatItemAsDeletedAction")
        if d:
            sink.write(json.dumps({"p": "youtube", "ch": vid, "event": "CLEARMSG", "ts": int(time.time() * 1000),
                                   "target_msg": d.get("targetItemId")}) + "\n")
            stats["ev"] += 1
        d = a.get("markChatItemsByAuthorAsDeletedAction")
        if d:
            sink.write(json.dumps({"p": "youtube", "ch": vid, "event": "CLEARCHAT", "ts": int(time.time() * 1000),
                                   "target_uid": d.get("externalChannelId")}) + "\n")
            stats["ev"] += 1


async def poll(s, vid, lang, sink, stats, deadline):
    try:
        html = await text_of(s, f"https://www.youtube.com/live_chat?is_popout=1&v={vid}")
        key = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html).group(1)
        ver = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', html).group(1)
        data = json.loads(INIT.search(html).group(1))
        lcr = data["contents"]["liveChatRenderer"]
        parse_actions(lcr.get("actions"), vid, lang, sink, stats)
        cont = next(iter(lcr["continuations"][0].values()))["continuation"]
    except Exception as ex:
        stats["fail"] += 1
        return
    stats["live"] += 1
    url = f"https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key={key}&prettyPrint=false"
    try:
        while time.time() < deadline and cont:
            body = {"context": {"client": {"clientName": "WEB", "clientVersion": ver, "hl": "en"}}, "continuation": cont}
            async with s.post(url, json=body, headers=UA, timeout=aiohttp.ClientTimeout(total=25)) as r:
                res = await r.json(content_type=None)
            lc = (res.get("continuationContents") or {}).get("liveChatContinuation")
            if not lc:
                break
            parse_actions(lc.get("actions"), vid, lang, sink, stats)
            c = (lc.get("continuations") or [{}])[0]
            v = next(iter(c.values()), {}) if c else {}
            cont = v.get("continuation")
            await asyncio.sleep(min(max(v.get("timeoutMs", 5000) / 1000, 1.5), 10))
    except Exception as ex:
        print(f"[{vid}] {type(ex).__name__}: {str(ex)[:80]}", flush=True)
    finally:
        stats["live"] -= 1


async def main(minutes, n, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"youtube_{time.strftime('%Y%m%d_%H%M%S')}.jsonl"
    end = time.time() + minutes * 60
    stats = {"n": 0, "ev": 0, "fail": 0, "live": 0}
    tasks: dict[str, asyncio.Task] = {}
    async with aiohttp.ClientSession() as s:
        with path.open("a", encoding="utf-8") as sink:
            while time.time() < end:
                cands = []
                for q, lang in QUERIES:
                    try:
                        cands += [(v, w, lang) for v, w in await search_live(s, q)]
                    except Exception as ex:
                        print("search failed", q, ex, flush=True)
                    await asyncio.sleep(1)
                cands.sort(key=lambda x: -x[1])
                for vid, w, lang in cands:
                    alive = sum(1 for t in tasks.values() if not t.done())
                    if alive >= n:
                        break
                    if w < 200 or (vid in tasks and not tasks[vid].done()):
                        continue
                    tasks[vid] = asyncio.create_task(poll(s, vid, lang, sink, stats, end))
                    await asyncio.sleep(2)  # stagger page loads
                for _ in range(10):
                    await asyncio.sleep(60)
                    sink.flush()
                    print(f"{stats['n']} msgs, {stats['ev']} mod events, {stats['live']} live chats, {stats['fail']} without chat", flush=True)
                    if time.time() > end:
                        break


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=150)
    ap.add_argument("--streams", type=int, default=30)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "data" / "raw"))
    a = ap.parse_args()
    asyncio.run(main(a.minutes, a.streams, Path(a.out)))
