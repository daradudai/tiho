from __future__ import annotations

import asyncio
import time

import pytest

from tiho_engine import schema as S
from tiho_engine.backend import InvalidRequest
from tiho_engine.scheduler import Scheduler
from tiho_engine.service import ClassifyService, Filter, Msg

from .conftest import FakeBackend

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


class StuckOn(FakeBackend):
    """Never answers about a text that contains "stuck"."""

    async def systemone(self, body):
        if "stuck" in body["state"]:
            await asyncio.Event().wait()
        return await super().systemone(body)


async def test_stream_yields_each_result_when_ready():
    svc = make(StuckOn())
    msgs = [Msg("s", "stuck"), Msg("a", "hello"), Msg("b", "hi")]
    t0 = time.monotonic()
    got = [(time.monotonic() - t0, line) async for line in svc.classify_stream(msgs, FILTERS[:1], deadline_ms=400)]
    assert [line.get("id") for _, line in got] == ["a", "b", "s", None]  # in the order they are ready
    assert got[1][0] < 0.2  # long before the deadline the stuck one runs into
    assert set(got[0][1]["filters"]) == {"backseat"}
    assert got[2][1] == {"id": "s", "error": "expired"} and got[2][0] >= 0.35
    assert got[3][1]["done"] is True and got[3][1]["expired"] == 1
    out = await svc.classify(msgs[:2], FILTERS[:1], deadline_ms=200)  # the plain response keeps request order
    assert [r["id"] for r in out["results"]] == ["s", "a"] and out["expired"] == 1
    await svc.scheduler.stop()


async def test_stream_closed_early_cancels_the_rest():
    svc = make(StuckOn())
    lines = svc.classify_stream([Msg("s", "stuck"), Msg("a", "hello")], FILTERS[:1], deadline_ms=0)
    assert (await lines.__anext__())["id"] == "a"
    await lines.aclose()  # the client went away
    await asyncio.sleep(0.05)
    assert not [t for t in asyncio.all_tasks() if getattr(t.get_coro(), "__name__", "") == "_message"]
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
