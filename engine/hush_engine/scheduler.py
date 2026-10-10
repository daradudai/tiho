"""Request scheduler in front of llama-server.

* bounded concurrency (= llama-server slots, so requests queue *here*, where we
  can still drop them, not inside llama.cpp where we cannot),
* LIFO queue: under overload the newest chat messages are served first and old
  ones expire instead of everything getting uniformly late,
* deadlines: a queued request that can no longer finish in time is dropped,
* in-flight dedup: identical requests (chat waves, copypasta) share one call,
* adaptive concurrency (AIMD on backend latency vs. each request's own deadline):
  when the GPU is shared (a game, another llama client) more requests in flight
  only make *every* answer late, so the in-flight limit shrinks while answers
  take more than 70% of their deadline budget and grows back when they are fast
  (or when nobody set a deadline: bulk work wants throughput),
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
        self.limit = self.max_inflight  # adaptive, min_inflight..max_inflight
        self.adaptive = adaptive
        self.min_inflight = max(1, min_inflight)
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

    # -- lifecycle -------------------------------------------------------------
    def start(self, max_inflight: int | None = None) -> None:
        if max_inflight:
            self.max_inflight = max(1, max_inflight)
            self.limit = self.max_inflight
        if self._workers:
            return
        self._workers = [asyncio.create_task(self._worker(), name=f"hush-worker-{i}") for i in range(self.max_inflight)]

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

    def _adapt(self, dt: float, job: Job) -> None:
        """AIMD on the in-flight limit, at most one step per observed latency."""
        if not self.adaptive:
            return
        now = time.monotonic()
        if now - self._last_adjust < min(dt, 2.0):
            return
        budget = job.deadline - job.enqueued
        slow = dt > 0.7 * budget
        fast = dt < 0.5 * budget  # always true without a deadline
        floor = min(self.min_inflight, self.max_inflight)
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
            t0 = time.monotonic()
            try:
                result = await self.backend.systemone(job.body)
            except BackendUnavailable:
                attempt += 1
                if attempt > self.retries or time.monotonic() + 0.3 > job.deadline:
                    raise
                await asyncio.sleep(0.2)
                continue
            dt = time.monotonic() - t0
            self._ewma = 0.9 * self._ewma + 0.1 * dt
            self._adapt(dt, job)
            tokens = int((result.get("usage") or {}).get("input_tokens") or 0)
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
