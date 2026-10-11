from __future__ import annotations

import ast
from pathlib import Path

import pytest

from tiho_engine import schema as S

TEACHER = Path(__file__).resolve().parents[2] / "ml" / "teacher" / "label.py"


def _teacher_literal(name: str):
    tree = ast.parse(TEACHER.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise KeyError(name)


@pytest.mark.skipif(not TEACHER.exists(), reason="ml/teacher/label.py not present")
def test_base_schema_identical_to_teacher():
    assert S.BASE_QUESTIONS == _teacher_literal("QUESTIONS")
    # same insertion order too (it is part of the prompt)
    assert list(S.BASE_QUESTIONS) == list(_teacher_literal("QUESTIONS"))
    assert list(S.BASE_QUESTIONS["cat"]["criteria"]) == list(_teacher_literal("QUESTIONS")["cat"]["criteria"])


@pytest.mark.skipif(not TEACHER.exists(), reason="ml/teacher/label.py not present")
def test_state_identical_to_teacher():
    plat = _teacher_literal("PLAT")
    for p in ("twitch", "youtube", "kick", None, "rumble"):
        expected = f"{plat.get(p or '', 'live-stream')} live chat message: hello"
        assert S.build_state("hello", p) == expected


def test_state_with_context():
    s = S.build_state("no spoilers pls", "twitch", context="Playing Elden Ring, first run")
    assert s == "Stream context: Playing Elden Ring, first run\nTwitch live chat message: no spoilers pls"


def test_clean_text():
    assert S.clean_text("  hi\n\tthere  ") == "hi there"
    assert S.clean_text("KEKW \U000e0000") == "KEKW"  # 7TV duplicate-bypass tag char
    assert S.clean_text("he​llo͏") == "hello"
    assert len(S.clean_text("a" * 5000)) == S.MAX_TEXT_CHARS
    assert S.cache_text("FREE Robux") != S.cache_text("free robux")  # case kept: it matters for spam


# (text, real token count from llama-server /tokenize on Clef-Flash)
TOKENIZED = [
    ("Twitch live chat message: hi", 7),
    ("bro just jump on the left ledge, why are you going right??", 14),
    ("колко време ще стриймваш днес?", 10),
    ("日本語のテキストです。配信楽しい！", 8),
    ("배그 하는 거 재밌다 ㅋㅋㅋㅋ", 10),
    ("😂😂😂😂🔥🔥", 14),
    ("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 5),
    ("KEKW KEKW KEKW KEKW KEKW KEKW KEKW", 14),
    ("x9#kd!!@@l;;", 8),
    ("𝓯𝓻𝓮𝓮 𝓻𝓸𝓫𝓾𝔁", 27),
    ("a̸̢̛̛̛͎͎͎b̸̢̛̛̛͎͎͎c̸̢̛̛̛͎͎͎", 51),
]


@pytest.mark.parametrize("text,real", TOKENIZED)
def test_estimate_is_conservative(text, real):
    est = S.estimate_tokens(text)
    assert est >= real
    assert est <= real * 3 + 4  # but not absurdly so


# (questions, real llama-server usage.input_tokens with state "Twitch live chat message: hi")
def test_prompt_estimate_vs_measured():
    st = S.build_state("hi", "twitch")
    f = S.filter_question("Is this message backseating the streamer's gameplay?")
    assert S.prompt_tokens(st, S.BASE_QUESTIONS) >= 355
    assert S.prompt_tokens(st, {"f1": f}) >= 156
    three = {"f1": f, "f2": S.filter_question("Does it spoil the plot of Elden Ring?"),
             "f3": S.filter_question("Is the message about politics?")}
    assert S.prompt_tokens(st, three) >= 324
    assert S.prompt_tokens(st, {**S.BASE_QUESTIONS, **three}) >= 611
    assert S.prompt_tokens(st, {**S.BASE_QUESTIONS, **three}) <= 611 * 1.4


def _filters(n):
    return [{f"f{i}": S.filter_question(f"Is this message about topic number {i}?")} for i in range(1, n + 1)]


def test_plan_single_request_when_it_fits():
    state, chunks = S.plan_requests("hello", "twitch", None, [dict(S.BASE_QUESTIONS), *_filters(2)], 992)
    assert state == "Twitch live chat message: hello"
    assert len(chunks) == 1
    assert list(chunks[0]) == ["cat", "tone", "f1", "f2"]


def test_plan_splits_and_keeps_order_and_base_together():
    groups = [dict(S.BASE_QUESTIONS), *_filters(12)]
    state, chunks = S.plan_requests("hello", "twitch", None, groups, 700)
    assert len(chunks) > 1
    assert list(chunks[0])[:2] == ["cat", "tone"]
    flat = [k for c in chunks for k in c]
    assert flat == ["cat", "tone"] + [f"f{i}" for i in range(1, 13)]
    for c in chunks:
        assert S.prompt_tokens(state, c) <= 700


def test_plan_truncates_huge_message():
    text = "ꙮ" * 600  # 3-byte chars, ~1 token each
    state, chunks = S.plan_requests(text, "kick", None, [dict(S.BASE_QUESTIONS)], 700)
    assert len(chunks) == 1
    assert S.prompt_tokens(state, chunks[0]) <= 700
    assert state.startswith("Kick live chat message: ꙮ")


def test_plan_no_questions():
    assert S.plan_requests("x", None, None, [], 900)[1] == []


def test_split_questions_keeps_base_pair():
    qs = {**S.BASE_QUESTIONS, **{k: v for g in _filters(3) for k, v in g.items()}}
    left, right = S.split_questions(qs)
    assert list(left) == ["cat", "tone", "f1"]
    assert list(right) == ["f2", "f3"]
    assert S.split_questions({"f1": qs["f1"]}) == [{"f1": qs["f1"]}]


def test_keys():
    q = {"f1": S.filter_question("Is it rude?")}
    k = S.request_key(S.message_state_key("hello  world", "twitch", None), q)
    assert k == S.request_key(S.message_state_key(" hello world​", "twitch", None), q)
    assert k != S.request_key(S.message_state_key("hello world", "youtube", None), q)
    assert k != S.request_key(S.message_state_key("Hello world", "twitch", None), q)
    assert k != S.request_key(S.message_state_key("hello world", "twitch", "ctx"), q)
    q2 = {"f2": q["f1"]}
    assert k != S.request_key(S.message_state_key("hello world", "twitch", None), q2)


def test_answer_mapping():
    answers = {
        "cat": {"type": "choice", "probabilities": {"clean": 0.1, "question": 0.05, "noise": 0.05, "spam": 0.1, "scam": 0.6, "toxic": 0.1}},
        "tone": {"type": "choice", "probabilities": {"positive": 0.7, "neutral": 0.2, "negative": 0.1}},
        "f1": {"type": "noul", "noul": 0.912345},
    }
    b = S.base_scores(answers)
    assert b == {"toxic": 0.1, "spam": 0.1, "scam": 0.6, "noise": 0.05, "question": 0.05, "clean": 0.1, "positive": 0.7, "negative": 0.1}
    assert S.noul_probability(answers["f1"]) == 0.9123
