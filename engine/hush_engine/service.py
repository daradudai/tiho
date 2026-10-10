"""Classification service: turns /v1/classify requests into scheduled systemone calls."""

from __future__ import annotations

import asyncio
import math
import time
from dataclasses import dataclass
from typing import Any, Sequence

from . import schema
from .backend import InvalidRequest, PromptTooLarge
from .scheduler import INF, Expired, Scheduler


@dataclass
class Msg:
    id: Any
    text: str
    platform: str | None = None
    author: str | None = None
    channel: str | None = None


@dataclass
class Filter:
    id: str
    question: str


def _error_code(exc: BaseException | None) -> str:
    if exc is None:
        return "expired"
    return getattr(exc, "code", "backend_error")


class ClassifyService:
    def __init__(
        self,
        scheduler: Scheduler,
        budget: int = 1024 - 32,
        default_deadline_ms: int = 3000,
        model_name: str = "clef-flash",
        isolate_base: bool = False,
    ) -> None:
        self.scheduler = scheduler
        self.budget = budget
        # Clef scores all questions of a request jointly: asking base + filters in one
        # request moves base probabilities by up to ~0.05 vs the teacher (and filters
        # by up to ~0.15). isolate_base trades ~70 prompt tokens/message for exact parity.
        self.isolate_base = isolate_base
        self.default_deadline_ms = default_deadline_ms
        self.model_name = model_name
        self.requests = 0
        self.messages = 0
        self.expired = 0

    # -- helpers ---------------------------------------------------------------
    def deadline_for(self, deadline_ms: int | None) -> float:
        if deadline_ms is None:
            deadline_ms = self.default_deadline_ms
        if deadline_ms <= 0:
            return INF
        return time.monotonic() + deadline_ms / 1000.0

    def _learn_limit(self, e: PromptTooLarge) -> None:
        if e.limit:
            self.budget = min(self.budget, e.limit - 32)

    async def _answers(
        self,
        text: str,
        platform: str | None,
        context: str | None,
        groups: list[schema.Questions],
        deadline: float,
    ) -> tuple[dict[str, Any], bool]:
        """Answers for all questions in `groups` about one message; returns (answers, all_cached)."""
        state, chunks = schema.plan_requests(text, platform, context, groups, self.budget)
        skey = schema.message_state_key(text, platform, context)
        answers: dict[str, Any] = {}
        all_cached = True
        pending = list(chunks)
        attempts = 0
        while pending:
            waits = []
            for chunk in pending:
                key = schema.request_key(skey, chunk)
                hit = self.scheduler.cached(key)
                if hit is not None:
                    answers.update(hit["answers"])
                    continue
                all_cached = False
                body = {"model": self.model_name, "state": state, "questions": chunk}
                waits.append((chunk, self.scheduler.submit(key, body, deadline)))
            pending = []
            for chunk, fut in waits:
                try:
                    resp = await asyncio.shield(fut)
                except PromptTooLarge as e:
                    # our estimate was off (or the server's batch is smaller than we think):
                    # split the questions, or cut the message if it is a single question
                    self._learn_limit(e)
                    attempts += 1
                    if attempts > 12:
                        raise
                    parts = schema.split_questions(chunk)
                    if len(parts) == 1:
                        text = text[: max(1, len(text) // 2)]
                        state = schema.build_state(text, platform, context)
                        skey = schema.message_state_key(text, platform, context) + f"\x1e{len(text)}"
                    pending.extend(parts)
                    continue
                answers.update(resp["answers"])
        return answers, all_cached

    async def _message(
        self,
        m: Msg,
        base: bool,
        fquestions: schema.Questions,
        fmap: list[tuple[str, str]],
        context: str | None,
        deadline: float,
    ) -> dict[str, Any]:
        fgroups = [{qid: q} for qid, q in fquestions.items()]
        bgroup = [dict(schema.BASE_QUESTIONS)] if base else []
        res: dict[str, Any] = {"id": m.id}
        if not fgroups and not bgroup:
            res["filters"] = {}
            return res
        text = schema.clean_text(m.text)
        if bgroup and fgroups and self.isolate_base:
            # base alone = byte-identical prompt to the teacher; filters in their own request(s)
            (a1, c1), (a2, c2) = await asyncio.gather(
                self._answers(text, m.platform, context, bgroup, deadline),
                self._answers(text, m.platform, context, fgroups, deadline),
            )
            answers, cached = {**a1, **a2}, c1 and c2
        else:
            answers, cached = await self._answers(text, m.platform, context, bgroup + fgroups, deadline)
        res["filters"] = {fid: schema.noul_probability(answers[qid]) for fid, qid in fmap}
        if base:
            res["base"] = schema.base_scores(answers)
        res["cached"] = cached
        return res

    # -- API -------------------------------------------------------------------
    async def classify(
        self,
        messages: Sequence[Msg],
        filters: Sequence[Filter] = (),
        base: bool = False,
        deadline_ms: int | None = None,
        context: str | None = None,
    ) -> dict[str, Any]:
        t0 = time.monotonic()
        deadline = self.deadline_for(deadline_ms)
        self.requests += 1
        self.messages += len(messages)

        # custom filters -> noul questions f1..fN (identical questions share one id)
        fquestions: schema.Questions = {}
        by_text: dict[str, str] = {}
        fmap: list[tuple[str, str]] = []
        for f in filters:
            q = schema.filter_question(f.question)
            qid = by_text.get(q["instructions"])
            if qid is None:
                qid = f"f{len(fquestions) + 1}"
                by_text[q["instructions"]] = qid
                fquestions[qid] = q
            fmap.append((f.id, qid))

        tasks = [
            asyncio.ensure_future(self._message(m, base, fquestions, fmap, context, deadline)) for m in messages
        ]
        if tasks:
            timeout = None if math.isinf(deadline) else max(0.0, deadline - time.monotonic())
            done, not_done = await asyncio.wait(tasks, timeout=timeout)
            for t in not_done:
                t.cancel()  # the shared backend jobs keep running and still fill the cache
        results = []
        n_expired = 0
        for m, t in zip(messages, tasks):
            if t.done() and not t.cancelled() and t.exception() is None:
                results.append(t.result())
                continue
            exc = None if (t.cancelled() or not t.done()) else t.exception()
            if exc is None or isinstance(exc, Expired):
                n_expired += 1
            results.append({"id": m.id, "error": _error_code(exc)})
        self.expired += n_expired
        return {"results": results, "ms": round(1000 * (time.monotonic() - t0), 1), "expired": n_expired}

    async def systemone(self, body: dict[str, Any], deadline_ms: int | None = 0) -> dict[str, Any]:
        """Raw Jev/SystemOne passthrough (cached, deduped, queued like everything else)."""
        questions = body.get("questions")
        if "state" not in body or not isinstance(questions, dict) or not questions:
            raise InvalidRequest('"state" and a non-empty "questions" object are required')
        fixed: schema.Questions = {}
        for qid, q in questions.items():
            q = dict(q) if isinstance(q, dict) else {}
            if not q.get("instructions"):
                q["instructions"] = str(qid)  # reference semantics; llama-server insists on it
            fixed[str(qid)] = q
        body = {**body, "questions": fixed, "model": body.get("model") or self.model_name}
        rest = {k: v for k, v in body.items() if k not in ("model", "questions")}  # state, images, ...
        key = schema.request_key("raw\x1f" + schema._render(rest), fixed)
        hit = self.scheduler.cached(key)
        if hit is not None:
            return hit
        return await asyncio.shield(self.scheduler.submit(key, body, self.deadline_for(deadline_ms)))

    def stats(self) -> dict[str, Any]:
        return {"requests": self.requests, "messages": self.messages, "expired": self.expired, "budget": self.budget}
