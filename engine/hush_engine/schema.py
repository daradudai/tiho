"""Building Clef-Flash `/v1/systemone` requests for live-chat messages.

Everything that ends up in the prompt lives here: the state string, the base
schema (identical to the teacher in `ml/teacher/label.py`, so a second opinion
from the engine is directly comparable with what the student was trained on),
custom-filter questions, prompt-size estimation and splitting of questions
into several requests when they do not fit into one llama.cpp slot.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from typing import Any, Iterable

Questions = dict[str, dict[str, Any]]

PLATFORM_NAMES = {"twitch": "Twitch", "youtube": "YouTube", "kick": "Kick"}
DEFAULT_PLATFORM = "live-stream"

# Base schema: one 6-way category + one 3-way tone question.
# MUST stay byte-identical to QUESTIONS in ml/teacher/label.py.
BASE_QUESTIONS: Questions = {
    "cat": {
        "type": "choice",
        "instructions": "Classify this live-chat message.",
        "criteria": {
            "clean": "normal on-topic chat",
            "question": "asks a genuine question",
            "noise": "low-effort reaction: single emote/word (W, L, lol, first)",
            "spam": "flood, copypasta, repeated chars/emotes, gibberish",
            "scam": "self-promo, bot, scam, giveaway, crypto/gambling, follow-begging",
            "toxic": "insult, harassment, hate, slur, threat",
        },
    },
    "tone": {
        "type": "choice",
        "instructions": "What is the tone of this message?",
        "criteria": {"positive": "supportive, kind, hype", "neutral": "neutral", "negative": "complaining, critical, hostile"},
    },
}
BASE_CAT_LABELS = ("toxic", "spam", "scam", "noise", "question", "clean")
BASE_TONE_LABELS = ("positive", "negative")

# Chat messages are short (Twitch caps at 500 chars, YouTube at 200); anything
# longer is cut before it reaches the model.
MAX_TEXT_CHARS = 600
MAX_CONTEXT_CHARS = 300

# Noul defaults used by the model when no criteria are given (from the reference
# implementation); only needed for prompt-size estimation.
_NOUL_DEFAULTS = {
    "true": "The proposition is true or the answer is yes.",
    "false": "The proposition is false or the answer is no.",
}

# Fixed prompt overhead around the state and the schema (system prompt, headers,
# assistant prefix). Measured on llama.cpp b11541: 61-62 tokens.
TEMPLATE_TOKENS = 64

# Invisible characters used to dodge duplicate filters (7TV/Chatterino append
# U+E0000 or U+034F) and other zero-width junk.
_INVISIBLE = re.compile("[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ﻿ﾠ\U000e0000-\U000e007f]")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SPACE = re.compile(r"\s+")


def platform_name(platform: str | None) -> str:
    return PLATFORM_NAMES.get((platform or "").strip().lower(), DEFAULT_PLATFORM)


def clean_text(text: str, limit: int = MAX_TEXT_CHARS) -> str:
    """What the model sees: control/invisible chars removed, whitespace collapsed, length capped."""
    text = _CONTROL.sub("", _INVISIBLE.sub("", text or ""))
    text = _SPACE.sub(" ", text).strip()
    return text[:limit]


def cache_text(text: str) -> str:
    """Cache-key form of a message.

    Deliberately conservative: case, repeats, zalgo and fullwidth letters change
    what the model says (spam / caps / evasion), so only invisible characters and
    whitespace are folded. Exact waves ("KEKW KEKW", copypasta) still share one entry.
    """
    return clean_text(text)


def build_state(text: str, platform: str | None = None, context: str | None = None) -> str:
    """State string. Without context it is exactly the teacher's: "<Platform> live chat message: <text>"."""
    p = platform_name(platform)
    state = f"{p} live chat message: {text}"
    if context:
        state = f"Stream context: {clean_text(context, MAX_CONTEXT_CHARS)}\n{state}"
    return state


def filter_question(question: str) -> dict[str, Any]:
    """A user-written filter ("Is this message backseating?") as a noul question."""
    return {"type": "noul", "instructions": clean_text(question, 500)}


# --- prompt-size estimation -------------------------------------------------------

def estimate_tokens(s: str) -> int:
    """Conservative token estimate for the Qwen3.5 tokenizer, without the tokenizer.

    Calibrated against llama-server /tokenize: English ~4 chars/token,
    Cyrillic ~2-3, CJK ~2, emoji/math-alphanumerics 2-3 tokens each,
    combining marks (zalgo) ~2 each. The estimate errs on the high side;
    the engine also recovers from a "too large" error by splitting.
    """
    n = 0.0
    for ch in s:
        o = ord(ch)
        if o < 128:
            if ch.isalnum():
                n += 0.45
            elif ch == " ":
                n += 0.05
            else:
                n += 0.7
        elif 0x300 <= o < 0x370:
            n += 2.0  # combining diacritics
        elif o < 0x800:
            n += 0.6
        elif o < 0x10000:
            n += 2.0 if unicodedata.category(ch).startswith("M") else 1.1
        else:
            n += 3.0
    return int(n) + 2


def _render(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _options(q: dict[str, Any]) -> list[tuple[str, Any]]:
    t = q.get("type")
    if t == "noul":
        crit = {**_NOUL_DEFAULTS, **(q.get("criteria") or {})}
        return [(k, crit[k]) for k in ("true", "false")]
    crit = q.get("criteria") or {}
    if t == "choice" and isinstance(crit, dict):
        return sorted((str(k), v) for k, v in crit.items())
    return [(str(i), v) for i, v in enumerate(crit)]


# Fixed parts of one schema field ("\nFIELD n\nID: ..\nTYPE: ..\nINSTRUCTION: ..
# ALLOWED OPTIONS:\n ... END FIELD\n") and of one option line
# ('OPTION k: {"description":..,"option_id":..}\n'), measured on llama.cpp b11541.
_FIELD_FIXED = 26
_OPTION_FIXED = 11
# A default noul field costs ~74 tokens + instruction + id (two fixed option lines).
_NOUL_FIXED = 74


def question_tokens(qid: str, q: dict[str, Any], index: int = 1) -> int:
    """Estimated prompt tokens one schema field costs (mirrors the reference encoder)."""
    n = estimate_tokens(qid) + estimate_tokens(_render(q.get("instructions") or qid))
    if q.get("type") == "noul" and not q.get("criteria"):
        return _NOUL_FIXED + n
    n += _FIELD_FIXED
    for oid, desc in _options(q):
        n += _OPTION_FIXED + estimate_tokens(oid) + (estimate_tokens(_render(desc)) if desc is not None else 0)
    return n


def prompt_tokens(state: str, questions: Questions) -> int:
    return TEMPLATE_TOKENS + estimate_tokens(state) + sum(
        question_tokens(qid, q, i) for i, (qid, q) in enumerate(questions.items(), 1)
    )


def plan_requests(
    text: str,
    platform: str | None,
    context: str | None,
    groups: list[Questions],
    budget: int,
) -> tuple[str, list[Questions]]:
    """Pack question groups into as few systemone requests as fit `budget` prompt tokens.

    A group (e.g. the base cat+tone pair) is never split. Order is preserved, so
    the base group always rides in the first request. If the message itself is so
    long that even the largest group would not fit next to it, the text is cut.
    Returns (state, [questions per request]).
    """
    groups = [g for g in groups if g]
    if not groups:
        return build_state(text, platform, context), []
    costs = [sum(question_tokens(k, q) for k, q in g.items()) for g in groups]
    room = budget - TEMPLATE_TOKENS - max(costs)
    state = build_state(text, platform, context)
    st = estimate_tokens(state)
    if st > room and text:
        overhead = st - estimate_tokens(text)
        keep = len(text)
        for _ in range(8):
            keep = max(16, int(keep * max(room - overhead, 1) / max(estimate_tokens(text[:keep]), 1)) - 1)
            state = build_state(text[:keep], platform, context)
            st = estimate_tokens(state)
            if st <= room or keep <= 16:
                break
    chunks: list[Questions] = []
    cur: Questions = {}
    used = TEMPLATE_TOKENS + st
    for g, c in zip(groups, costs):
        if cur and used + c > budget:
            chunks.append(cur)
            cur, used = {}, TEMPLATE_TOKENS + st
        cur.update(g)
        used += c
    if cur:
        chunks.append(cur)
    return state, chunks


def split_questions(questions: Questions, atomic: Iterable[str] = ("cat", "tone")) -> list[Questions]:
    """Split one request's questions in two halves (keeping the base pair together)."""
    atomic = set(atomic)
    groups: list[Questions] = []
    base = {k: v for k, v in questions.items() if k in atomic}
    if base:
        groups.append(base)
    groups += [{k: v} for k, v in questions.items() if k not in atomic]
    if len(groups) < 2:
        return [questions]
    mid = (len(groups) + 1) // 2
    left: Questions = {}
    right: Questions = {}
    for g in groups[:mid]:
        left.update(g)
    for g in groups[mid:]:
        right.update(g)
    return [left, right]


# --- keys and answers -------------------------------------------------------------

def request_key(state_key: str, questions: Questions) -> str:
    """Cache / in-flight dedup key of one systemone request."""
    blob = json.dumps([state_key, questions], ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    return hashlib.blake2b(blob.encode("utf-8"), digest_size=16).hexdigest()


def message_state_key(text: str, platform: str | None, context: str | None) -> str:
    return "\x1f".join((platform_name(platform), clean_text(context or "", MAX_CONTEXT_CHARS), cache_text(text)))


def noul_probability(answer: dict[str, Any]) -> float:
    if "noul" in answer:
        return round(float(answer["noul"]), 4)
    probs = answer.get("probabilities") or {}
    return round(float(probs.get("true", 0.0)), 4)


def base_scores(answers: dict[str, Any]) -> dict[str, float]:
    """Map cat/tone answers to the Hush label space (same mapping as the teacher)."""
    cat = answers["cat"]["probabilities"]
    tone = answers["tone"]["probabilities"]
    out = {k: round(float(cat.get(k, 0.0)), 4) for k in BASE_CAT_LABELS}
    for k in BASE_TONE_LABELS:
        out[k] = round(float(tone.get(k, 0.0)), 4)
    return out
