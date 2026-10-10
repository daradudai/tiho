"""Quick probe of the Clef-Flash decision endpoint with chat messages."""
import json
import sys
import time
import urllib.request

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7378/v1/systemone"

QUESTIONS = {
    "toxic": {"type": "noul", "instructions": "Is this live-chat message toxic: an insult, harassment, hate, a slur, a threat or sexual harassment?"},
    "spam": {"type": "noul", "instructions": "Is this live-chat message spam: flooding, copypasta, a wall of repeated characters/emotes, or gibberish?"},
    "scam": {"type": "noul", "instructions": "Is this message self-promotion, a bot, a scam, a fake giveaway, or a crypto/gambling/follower-selling pitch?"},
    "noise": {"type": "noul", "instructions": "Is this a low-effort reaction with no content (a single emote or word like W, L, lol, first, ?)?"},
    "question": {"type": "noul", "instructions": "Does this message ask a genuine question?"},
    "sentiment": {"type": "choice", "instructions": "What is the tone of this message?",
                  "criteria": {"positive": "supportive, kind, hype", "neutral": "neutral or informational", "negative": "complaining, critical or hostile"}},
}

MSGS = [
    "W", "KEKW KEKW KEKW KEKW KEKW KEKW", "what game is this?", "kys you fat loser",
    "check out my channel for free vbucks!! link in bio", "this streamer is so bad lmao",
    "love the vibes today <3", "колко време ще стриймваш днес?", "ти си пълен боклук бе",
    "¿cuál es tu configuración de sensibilidad?", "Viewers for $5 — go to streamboo dot com",
    "ich distanziere mich", "first", "the game looks laggy tbh", "aaaaaaaaaaaaaaaaaaaaaaaa",
]


def call(state: str) -> dict:
    body = json.dumps({"model": "clef-flash", "state": state, "questions": QUESTIONS}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


if __name__ == "__main__":
    first = call("hello")
    print(json.dumps(first, indent=1)[:1500])
    for m in MSGS:
        t = time.perf_counter()
        a = call(f"Twitch live chat message: {m}")["answers"]
        dt = (time.perf_counter() - t) * 1000
        def p(k):
            v = a[k]
            return v["noul"] if "noul" in v else v
        flags = {k: round(float(p(k)), 2) for k in ["toxic", "spam", "scam", "noise", "question"]}
        print(f"{dt:6.0f}ms {a['sentiment'].get('choice'):>8} {flags}  | {m}")
