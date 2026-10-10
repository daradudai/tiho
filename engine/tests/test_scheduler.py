from __future__ import annotations

import asyncio
import time

import pytest

from hush_engine.backend import BackendUnavailable
from hush_engine.cache import LRUCache
from hush_engine.scheduler import Expired, Overloaded, Scheduler

pytestmark = pytest.mark.anyio


def body(i) -> dict:
    return {"model": "x", "state": f"Twitch live chat message: m{i}", "questions": {"f1": {"type": "noul", "instructions": "q?"}}}


def test_lru_cache():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    assert c.get("a") == 1  # a is now most recent
    c.put("c", 3)  # evicts b
    assert c.get("b") is None
    assert c.get("a") == 1 and c.get("c") == 3
    st = c.stats()
    assert st["size"] == 2 and st["hits"] == 3 and st["misses"] == 1


def test_lru_ttl(monkeypatch):
    c = LRUCache(10, ttl=1.0)
    now = [100.0]
    monkeypatch.setattr(time, "monotonic", lambda: now[0])
    c.put("a", 1)
    now[0] += 0.5
    assert c.get("a") == 1
    now[0] += 1.0
    assert c.get("a") is None


async def test_concurrency_limit(fake):
    fake.delay = 0.02
    s = Scheduler(fake, max_inflight=3, adaptive=False)
    s.start()
    futs = [s.submit(f"k{i}", body(i)) for i in range(12)]
    await asyncio.gather(*futs)
    assert fake.peak == 3
    assert len(fake.calls) == 12
    await s.stop()


async def test_inflight_dedup_and_cache(fake):
    fake.delay = 0.02
    s = Scheduler(fake, max_inflight=2)
    s.start()
    f1 = s.submit("same", body(1))
    f2 = s.submit("same", body(1))
    assert f1 is f2
    r = await f1
    assert len(fake.calls) == 1
    assert s.cached("same") == r
    assert s.deduped == 1
    await s.stop()


async def test_lifo_order(fake):
    fake.gate = asyncio.Event()
    s = Scheduler(fake, max_inflight=1)
    s.start()
    first = s.submit("k0", body(0))
    await asyncio.sleep(0.01)  # k0 is now running and blocked on the gate
    futs = [s.submit(f"k{i}", body(i)) for i in (1, 2, 3)]
    fake.gate.set()
    await asyncio.gather(first, *futs)
    order = [c["state"][-2:] for c in fake.calls]
    assert order == ["m0", "m3", "m2", "m1"]  # newest first
    await s.stop()


async def test_dedup_moves_job_to_top(fake):
    fake.gate = asyncio.Event()
    s = Scheduler(fake, max_inflight=1)
    s.start()
    first = s.submit("k0", body(0))
    await asyncio.sleep(0.01)
    futs = [s.submit(f"k{i}", body(i)) for i in (1, 2, 3)]
    futs.append(s.submit("k1", body(1)))  # k1 asked again -> fresh again
    fake.gate.set()
    await asyncio.gather(first, *futs)
    assert [c["state"][-2:] for c in fake.calls] == ["m0", "m1", "m3", "m2"]
    await s.stop()


async def test_expired_jobs_are_dropped(fake):
    fake.gate = asyncio.Event()
    s = Scheduler(fake, max_inflight=1)
    s.start()
    first = s.submit("k0", body(0))
    await asyncio.sleep(0.01)
    stale = s.submit("k1", body(1), deadline=time.monotonic() + 0.01)
    await asyncio.sleep(0.05)
    fake.gate.set()
    await first
    with pytest.raises(Expired):
        await stale
    assert len(fake.calls) == 1
    assert s.expired == 1
    await s.stop()


async def test_queue_overflow_drops_oldest(fake):
    fake.gate = asyncio.Event()
    s = Scheduler(fake, max_inflight=1, max_queue=2)
    s.start()
    first = s.submit("k0", body(0))
    await asyncio.sleep(0.01)
    a = s.submit("k1", body(1))
    b = s.submit("k2", body(2))
    c = s.submit("k3", body(3))  # pushes k1 out
    with pytest.raises(Overloaded):
        await a
    fake.gate.set()
    await asyncio.gather(first, b, c)
    assert s.dropped == 1
    await s.stop()


async def test_retry_on_unavailable(fake):
    fake.fail_unavailable = 1
    s = Scheduler(fake, max_inflight=1, retries=1)
    s.start()
    r = await s.submit("k", body(1))
    assert "answers" in r and len(fake.calls) == 2
    fake.fail_unavailable = 5
    with pytest.raises(BackendUnavailable):
        await s.submit("k2", body(2))
    await s.stop()


async def test_stop_fails_queued(fake):
    fake.gate = asyncio.Event()
    s = Scheduler(fake, max_inflight=1)
    s.start()
    running = s.submit("k0", body(0))
    await asyncio.sleep(0.01)
    queued = s.submit("k1", body(1))
    await s.stop()
    for f in (running, queued):
        with pytest.raises(BackendUnavailable):
            await f


async def test_adaptive_concurrency_shrinks_when_slow(fake):
    fake.delay = 0.16
    s = Scheduler(fake, max_inflight=8)
    s.start()
    s.limit = 8
    for wave in range(4):  # answers take ~80% of their 200 ms budget
        dl = time.monotonic() + 0.2
        await asyncio.gather(*(s.submit(f"k{wave}-{i}", body(i), deadline=dl) for i in range(8)), return_exceptions=True)
    assert 2 <= s.limit < 8
    assert s.stats()["inflight_limit"] == s.limit
    await s.stop()


# (the fake's delays are long enough that Windows' 15.6 ms timer ticks do not look like queueing)

async def test_adaptive_concurrency_starts_low_and_grows_when_calls_overlap(fake):
    fake.delay = 0.1  # calls run side by side: several in flight are as fast as one
    s = Scheduler(fake, max_inflight=8)
    s.start()
    assert s.limit == 2
    await s.submit("alone", body(0))
    await asyncio.gather(*(s.submit(f"k{i}", body(i)) for i in range(80)))
    assert s.limit > 4
    assert fake.peak <= 8
    await s.stop()


async def test_adaptive_concurrency_shrinks_when_calls_queue_in_the_backend(fake):
    """llama.cpp runs decision requests one at a time: more in flight only queues inside it."""
    fake.delay = 0.05
    fake.serial = True
    s = Scheduler(fake, max_inflight=8)
    s.start()
    await s.submit("alone", body(0))
    s.limit = 8
    await asyncio.gather(*(s.submit(f"k{i}", body(i)) for i in range(40)))  # no deadline: throughput only
    assert s.limit == 2
    fake.peak = 0
    await asyncio.gather(*(s.submit(f"n{i}", body(i)) for i in range(12)))
    assert fake.peak == 2  # and it does not grow back
    await s.stop()


async def test_fixed_concurrency(fake):
    fake.delay = 0.05
    s = Scheduler(fake, max_inflight=4, adaptive=False)
    s.start()
    await asyncio.gather(*(s.submit(f"k{i}", body(i), deadline=time.monotonic() + 0.06) for i in range(12)), return_exceptions=True)
    assert s.limit == 4
    await s.stop()
