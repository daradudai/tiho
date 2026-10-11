"""Request scheduler in front of llama-server.

* bounded concurrency, so requests queue *here*, where we can still reorder and
  drop them, not inside llama.cpp where we cannot,
* LIFO queue: under overload the newest chat messages are served first and old
  ones expire instead of everything getting uniformly late,
* deadlines: a queued request that can no longer finish in time is dropped,
* in-flight dedup: identical requests (chat waves, copypasta) share one call,
* adaptive concurrency (AIMD on queueing in the backend): llama.cpp runs decision
  requests one at a time, so with k of them in flight each takes about k times as
  long for the same throughput, and the extra ones wait inside llama.cpp, which
  serves them unfairly (some wait seconds). The in-flight limit starts at
  `min_inflight`, grows only while calls in flight together are about as fast as
  one alone (a backend that really overlaps them), and shrinks when they queue or
  when answers take more than 70% of their deadline budget (a game or another
  client on the GPU),
* LRU result cache.
"""

from __future__ import annotations

import asyncio
import math
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .backend import Backend, BackendUnavailable
from .cache import LRUCache

INF = math.inf


class Expired(Exception):
    status = 504
    code = "expired"


class Overloaded(Exception):
    status = 503
    code = "overloaded"


@dataclass(eq=False)
class Job:
    key: str
    body: dict[str, Any]
    deadline: float
    future: asyncio.Future
    enqueued: float = field(default_factory=time.monotonic)
    running: bool = False


def _consume(fut: asyncio.Future) -> None:
    # Results nobody waits for any more (client gave up) must not log
    # "Future exception was never retrieved".
    if not fut.cancelled():
        fut.exception()


class Scheduler:
    def __init__(
        self,
        backend: Backend,
        max_inflight: int = 8,
        max_queue: int = 1024,
        cache: LRUCache | None = None,
        retries: int = 1,
        adaptive: bool = True,
        min_inflight: int = 2,
    ) -> None:
        self.backend = backend
        self.max_inflight = max(1, max_inflight)
        self.adaptive = adaptive
        self.min_inflight = max(1, min_inflight)
        self.limit = self._initial_limit()  # adaptive, min_inflight..max_inflight
        self._last_adjust = 0.0
        self.max_queue = max(1, max_queue)
        self.cache: LRUCache = cache if cache is not None else LRUCache(50_000)
        self.retries = retries
        self._queue: deque[Job] = deque()
        self._jobs: dict[str, Job] = {}
        self._event = asyncio.Event()
        self._workers: list[asyncio.Task] = []
        self.running = 0
        # stats
        self.submitted = 0
        self.deduped = 0
        self.expired = 0
        self.dropped = 0
        self.errors = 0
        self.completed = 0
        self._lat: deque[tuple[float, float, int]] = deque(maxlen=512)  # (t_done, seconds, prompt tokens)
        self._ewma = 0.15
        self._solo: float | None = None  # seconds per prompt token of calls that had the backend to themselves
        self._calls = 0  # calls started (tells whether another call overlapped one)

    # -- lifecycle -------------------------------------------------------------
    def start(self, max_inflight: int | None = None) -> None:
        if max_inflight:
            self.max_inflight = max(1, max_inflight)
            self.limit = self._initial_limit()
        if self._workers:
            return
        self._workers = [asyncio.create_task(self._worker(), name=f"tiho-worker-{i}") for i in range(self.max_inflight)]

    async def stop(self) -> None:
        for w in self._workers:
            w.cancel()
        for w in self._workers:
            try:
                await w
            except (asyncio.CancelledError, Exception):
                pass
        self._workers = []
        while self._queue:
            self._finish(self._queue.popleft(), exc=BackendUnavailable("engine shutting down"))

    @property
    def started(self) -> bool:
        return bool(self._workers)

    # -- API -------------------------------------------------------------------
    def cached(self, key: str) -> dict[str, Any] | None:
        return self.cache.get(key)

    def submit(self, key: str, body: dict[str, Any], deadline: float = INF) -> asyncio.Future:
        """Queue one systemone call. Await the result through `asyncio.shield` (the future is shared)."""
        self.submitted += 1
        job = self._jobs.get(key)
        if job is not None:
            self.deduped += 1
            if deadline > job.deadline:
                job.deadline = deadline
            if not job.running:
                # someone wants it again *now*: move it to the top of the LIFO
                try:
                    self._queue.remove(job)
                    self._queue.append(job)
                except ValueError:
                    pass
            return job.future
        fut = asyncio.get_running_loop().create_future()
        fut.add_done_callback(_consume)
        job = Job(key=key, body=body, deadline=deadline, future=fut)
        self._jobs[key] = job
        self._queue.append(job)
        while len(self._queue) > self.max_queue:
            old = self._queue.popleft()
            self.dropped += 1
            self._finish(old, exc=Overloaded("queue full, dropped oldest request"))
        self._event.set()
        return fut

    # -- internals -------------------------------------------------------------
    def _floor(self) -> int:
        return min(self.min_inflight, self.max_inflight)

    def _initial_limit(self) -> int:
        return self._floor() if self.adaptive else self.max_inflight

    def _finish(self, job: Job, result: Any = None, exc: BaseException | None = None) -> None:
        if self._jobs.get(job.key) is job:
            del self._jobs[job.key]
        if job.future.done():
            return
        if exc is not None:
            job.future.set_exception(exc)
        else:
            job.future.set_result(result)

    def _hopeless(self, job: Job, now: float) -> bool:
        # would not finish before its deadline even if started right now
        return now + 0.8 * self._ewma > job.deadline

    async def _worker(self) -> None:
        while True:
            while not self._queue or self.running >= self.limit:
                self._event.clear()
                await self._event.wait()
            job = self._queue.pop()  # newest first
            if job.future.done():
                continue
            if self._hopeless(job, time.monotonic()):
                self.expired += 1
                self._finish(job, exc=Expired("deadline passed while queued"))
                continue
            job.running = True
            self.running += 1
            try:
                result = await self._call(job)
            except asyncio.CancelledError:
                self._finish(job, exc=BackendUnavailable("engine shutting down"))
                raise
            except Exception as e:  # noqa: BLE001 - delivered to the waiters
                self.errors += 1
                self._finish(job, exc=e)
            else:
                self.completed += 1
                self.cache.put(job.key, result)
                self._finish(job, result=result)
            finally:
                self.running -= 1
                self._event.set()  # a slot is free: let a waiting worker re-check

    def _adapt(self, dt: float, tokens: int, others: int, alone: bool, job: Job) -> None:
        """AIMD on the in-flight limit, at most one step per observed latency.

        Queueing shows in a call's time per prompt token (base + filters prompts are
        ~3x a filter-only one) against that of calls that ran alone: about 1x when the
        backend overlaps calls, about k with k in flight on llama.cpp. Only a call that
        started while `others` were in flight shows overlap; the first of a burst is
        fast on any backend.
        """
        per = dt / max(1, tokens)
        # calls in flight together are never faster than one alone; when one is, the
        # baseline was measured on a busier GPU (a game, another client) and is stale
        if alone or (self._solo is not None and per < self._solo):
            self._solo = per if self._solo is None else 0.8 * self._solo + 0.2 * per
        if not self.adaptive:
            return
        now = time.monotonic()
        if now - self._last_adjust < min(dt, 2.0):
            return
        queued = self._solo is not None and per > 1.5 * self._solo
        overlapped = others > 0 and self._solo is not None and per < 1.25 * self._solo
        budget = job.deadline - job.enqueued
        slow = queued or dt > 0.7 * budget
        fast = overlapped and dt < 0.5 * budget  # (the budget part is always true without a deadline)
        floor = self._floor()
        if slow and self.limit > floor:
            self.limit = max(floor, int(self.limit * 0.75))
            self._last_adjust = now
        elif fast and self._queue and self.limit < self.max_inflight:
            self.limit += 1
            self._last_adjust = now
            self._event.set()

    async def _call(self, job: Job) -> dict[str, Any]:
        attempt = 0
        while True:
            t0 = time.perf_counter()  # monotonic() ticks in 15.6 ms on Windows before Python 3.13
            self._calls += 1
            mark, others = self._calls, self.running - 1
            try:
                result = await self.backend.systemone(job.body)
            except BackendUnavailable:
                attempt += 1
                if attempt > self.retries or time.monotonic() + 0.3 > job.deadline:
                    raise
                await asyncio.sleep(0.2)
                continue
            dt = time.perf_counter() - t0
            alone = others == 0 and self._calls == mark  # no other call overlapped this one
            self._ewma = 0.9 * self._ewma + 0.1 * dt
            tokens = int((result.get("usage") or {}).get("input_tokens") or 0)
            self._adapt(dt, tokens, others, alone, job)
            self._lat.append((time.monotonic(), dt, tokens))
            return result

    def stats(self) -> dict[str, Any]:
        now = time.monotonic()
        lat = sorted(x[1] for x in self._lat)
        recent = [x for x in self._lat if now - x[0] <= 10.0]

        def pct(p: float) -> float | None:
            if not lat:
                return None
            return round(1000 * lat[min(len(lat) - 1, int(p * len(lat)))], 1)

        return {
            "pending": len(self._queue),
            "inflight": self.running,
            "inflight_limit": self.limit,
            "max_inflight": self.max_inflight,
            "max_queue": self.max_queue,
            "submitted": self.submitted,
            "completed": self.completed,
            "deduped": self.deduped,
            "expired": self.expired,
            "dropped": self.dropped,
            "errors": self.errors,
            "backend_ms_p50": pct(0.5),
            "backend_ms_p95": pct(0.95),
            "req_per_s_10s": round(len(recent) / 10.0, 2),
            "prompt_tok_per_s_10s": round(sum(x[2] for x in recent) / 10.0, 1),
        }
