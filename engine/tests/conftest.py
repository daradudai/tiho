from __future__ import annotations

import asyncio
import contextlib
import hashlib
import socket
from typing import Any

import pytest

from hush_engine import schema
from hush_engine.backend import BackendInfo, BackendUnavailable, PromptTooLarge


@pytest.fixture
def anyio_backend():
    return "asyncio"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _p(*parts: str) -> float:
    """Deterministic pseudo-probability from strings."""
    h = hashlib.blake2b("|".join(parts).encode(), digest_size=4).digest()
    return round(int.from_bytes(h, "big") / 2**32, 4)


class FakeBackend:
    """In-process stand-in for llama-server's /v1/systemone.

    * answers are deterministic functions of (state, question)
    * `max_tokens`: estimated prompts above it fail like llama.cpp ("too large")
    * `gate`: an asyncio.Event every call waits on (to hold calls in flight)
    * `serial`: one call at a time (each `delay` long), like llama.cpp runs decision requests
    """

    def __init__(self, delay: float = 0.0, max_tokens: int | None = None, slots: int = 4, n_ctx: int = 1024) -> None:
        self.delay = delay
        self.max_tokens = max_tokens
        self.calls: list[dict[str, Any]] = []
        self.active = 0
        self.peak = 0
        self.gate: asyncio.Event | None = None
        self.serial = False
        self._lock = asyncio.Lock()
        self.fail_unavailable = 0
        self.status = "ok"
        self.info_ = BackendInfo(model="Fake-Clef", slots=slots, n_ctx_slot=n_ctx)

    async def systemone(self, body: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(body)
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            if self.fail_unavailable > 0:
                self.fail_unavailable -= 1
                raise BackendUnavailable("fake: down")
            if self.gate is not None:
                await self.gate.wait()
            if self.delay:
                async with self._lock if self.serial else contextlib.nullcontext():
                    await asyncio.sleep(self.delay)
            qs = body["questions"]
            if self.max_tokens is not None:
                n = schema.prompt_tokens(body["state"], qs)
                if n > self.max_tokens:
                    raise PromptTooLarge(
                        f"input ({n} tokens) is too large to process. increase the physical batch size (current batch size: {self.max_tokens})",
                        n, self.max_tokens)
            out = {}
            for qid, q in qs.items():
                if q["type"] == "noul":
                    out[qid] = {"type": "noul", "noul": _p(body["state"], q["instructions"])}
                else:
                    opts = list(q["criteria"])
                    raw = [_p(body["state"], q["instructions"], o) + 0.01 for o in opts]
                    s = sum(raw)
                    probs = {o: r / s for o, r in zip(opts, raw)}
                    out[qid] = {"type": "choice", "choice": max(probs, key=probs.get), "probabilities": probs, "confidence": 0.5}
            return {"model": "fake", "answers": out, "usage": {"input_tokens": 300, "output_tokens": 0}}
        finally:
            self.active -= 1

    async def health(self) -> str:
        return self.status

    async def info(self) -> BackendInfo:
        return self.info_

    async def aclose(self) -> None:
        pass


@pytest.fixture
def fake() -> FakeBackend:
    return FakeBackend()
