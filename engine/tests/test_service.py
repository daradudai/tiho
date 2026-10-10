from __future__ import annotations

import asyncio
import time

import pytest

from hush_engine import schema as S
from hush_engine.backend import InvalidRequest
from hush_engine.scheduler import Scheduler
from hush_engine.service import ClassifyService, Filter, Msg

pytestmark = pytest.mark.anyio

FILTERS = [
    Filter("backseat", "Is this message backseating the streamer's gameplay?"),
    Filter("spoiler", "Does it spoil the plot of Elden Ring?"),
    Filter("spoiler2", "Does it spoil the plot of Elden Ring?"),  # same question, different id
]


def make(fake, budget=992, inflight=4, **kw) -> ClassifyService:
    s = Scheduler(fake, max_inflight=inflight)
    s.start()
    return ClassifyService(s, budget=budget, **kw)


async def test_one_request_per_message_with_all_questions(fake):
    svc = make(fake)
    msgs = [Msg("a", "jump left!!", "twitch"), Msg(2, "W", "youtube")]
    out = await svc.classify(msgs, FILTERS, base=True)
    assert [r["id"] for r in out["results"]] == ["a", 2]
    assert len(fake.calls) == 2
    call = next(c for c in fake.calls if c["state"].startswith("Twitch"))
    assert list(call["questions"]) == ["cat", "tone", "f1", "f2"]  # duplicate question asked once
    assert call["questions"]["cat"] == S.BASE_QUESTIONS["cat"]
    assert call["state"] == "Twitch live chat message: jump left!!"
    r = out["results"][0]
    assert set(r["filters"]) == {"backseat", "spoiler", "spoiler2"}
    assert r["filters"]["spoiler"] == r["filters"]["spoiler2"]
    assert set(r["base"]) == {"toxic", "spam", "scam", "noise", "question", "clean", "positive", "negative"}
    assert r["cached"] is False
    assert out["expired"] == 0
    await svc.scheduler.stop()


async def test_cache_and_wave_dedup(fake):
    svc = make(fake)
    wave = [Msg(i, "KEKW KEKW", "twitch") for i in range(20)]
    out = await svc.classify(wave, FILTERS[:1])
    assert len(fake.calls) == 1
    assert len({r["filters"]["backseat"] for r in out["results"]}) == 1
    out2 = await svc.classify([Msg("x", " KEKW  KEKW\U000e0000", "twitch")], FILTERS[:1])
    assert len(fake.calls) == 1
    assert out2["results"][0]["cached"] is True
    await svc.scheduler.stop()


async def test_no_questions_no_calls(fake):
    svc = make(fake)
    out = await svc.classify([Msg("a", "hi")], [], base=False)
    assert out["results"] == [{"id": "a", "filters": {}}]
    assert fake.calls == []
    await svc.scheduler.stop()


async def test_many_filters_split_into_requests(fake):
    svc = make(fake, budget=600)
    filters = [Filter(f"x{i}", f"Is this message about topic number {i}?") for i in range(10)]
    out = await svc.classify([Msg("a", "hello", "kick")], filters, base=True)
    assert len(fake.calls) > 1
    asked = [q for c in fake.calls for q in c["questions"]]
    assert sorted(asked) == sorted(["cat", "tone"] + [f"f{i}" for i in range(1, 11)])
    assert set(out["results"][0]["filters"]) == {f"x{i}" for i in range(10)}
    await svc.scheduler.stop()


async def test_recovers_from_prompt_too_large(fake):
    fake.max_tokens = 500  # backend is smaller than the engine thinks
    svc = make(fake, budget=2000)
    filters = [Filter(f"x{i}", f"Is this message about topic number {i}?") for i in range(6)]
    out = await svc.classify([Msg("a", "hello", "twitch")], filters, base=True, deadline_ms=0)
    r = out["results"][0]
    assert "error" not in r, r
    assert set(r["filters"]) == {f"x{i}" for i in range(6)}
    assert "base" in r
    assert svc.budget == 500 - 32  # learned the real limit
    await svc.scheduler.stop()


async def test_deadline_returns_partial(fake):
    fake.delay = 0.3
    svc = make(fake, inflight=1)
    t0 = time.monotonic()
    out = await svc.classify([Msg(i, f"msg {i}") for i in range(5)], FILTERS[:1], deadline_ms=150)
    took = time.monotonic() - t0
    assert took < 0.3
    assert all(r.get("error") == "expired" for r in out["results"])
    assert out["expired"] == 5
    await asyncio.sleep(0.4)  # the in-flight one still lands in the cache
    out2 = await svc.classify([Msg(i, f"msg {i}") for i in range(5)], FILTERS[:1], deadline_ms=5000)
    assert sum(1 for r in out2["results"] if r.get("cached")) >= 1
    await svc.scheduler.stop()


async def test_isolate_base_sends_teacher_identical_request(fake):
    svc = make(fake, isolate_base=True)
    await svc.classify([Msg("a", "hello", "youtube")], FILTERS[:1], base=True)
    qsets = sorted((list(c["questions"]) for c in fake.calls), key=len)
    assert qsets == [["f1"], ["cat", "tone"]]
    base_call = next(c for c in fake.calls if "cat" in c["questions"])
    assert base_call["questions"] == S.BASE_QUESTIONS
    assert base_call["state"] == "YouTube live chat message: hello"
    await svc.scheduler.stop()


async def test_systemone_passthrough(fake):
    svc = make(fake)
    r = await svc.systemone({"state": "x", "questions": {"is_rude": {"type": "noul"}}})
    assert "is_rude" in r["answers"]
    assert fake.calls[0]["questions"]["is_rude"]["instructions"] == "is_rude"
    assert fake.calls[0]["model"] == "clef-flash"
    await svc.systemone({"state": "x", "questions": {"is_rude": {"type": "noul"}}})
    assert len(fake.calls) == 1  # cached
    with pytest.raises(InvalidRequest):
        await svc.systemone({"questions": {}})
    await svc.scheduler.stop()
