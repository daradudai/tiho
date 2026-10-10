"""Client for llama.cpp `llama-server` running a decision model (`/v1/systemone`)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import PurePath
from typing import Any, Protocol

import httpx


class BackendError(Exception):
    status = 502
    code = "backend_error"


class BackendUnavailable(BackendError):
    status = 503
    code = "backend_unavailable"


class InvalidRequest(BackendError):
    status = 400
    code = "invalid_request"


class PromptTooLarge(BackendError):
    """llama-server refuses prompts larger than one physical batch (decision models run in embedding mode)."""

    status = 413
    code = "prompt_too_large"

    def __init__(self, message: str, tokens: int | None = None, limit: int | None = None) -> None:
        super().__init__(message)
        self.tokens = tokens
        self.limit = limit


@dataclass
class BackendInfo:
    model: str = "unknown"
    slots: int = 4
    n_ctx_slot: int = 1024
    raw: dict[str, Any] = field(default_factory=dict)


class Backend(Protocol):
    async def systemone(self, body: dict[str, Any]) -> dict[str, Any]: ...

    async def health(self) -> str: ...

    async def info(self) -> BackendInfo: ...

    async def aclose(self) -> None: ...


_TOO_LARGE = re.compile(r"input \((\d+) tokens\) is too large.*?batch size: (\d+)", re.S)


def _error_message(r: httpx.Response) -> str:
    try:
        data = r.json()
        err = data.get("error", data)
        if isinstance(err, dict):
            return str(err.get("message") or err)
        return str(err)
    except Exception:
        return r.text[:500]


class LlamaBackend:
    """Async client for one llama-server. `health()` returns "ok" | "loading" | "down"."""

    def __init__(self, base_url: str, timeout: float = 60.0, max_connections: int = 64) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(timeout, connect=3.0),
            limits=httpx.Limits(max_connections=max_connections, max_keepalive_connections=max_connections),
            trust_env=False,  # never route localhost through HTTP(S)_PROXY
        )

    async def systemone(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            r = await self._client.post("/v1/systemone", json=body)
        except httpx.TimeoutException as e:
            raise BackendUnavailable(f"llama-server timed out: {e!r}") from e
        except httpx.TransportError as e:
            raise BackendUnavailable(f"llama-server unreachable at {self.base_url}: {e!r}") from e
        if r.status_code == 200:
            return r.json()
        msg = _error_message(r)
        m = _TOO_LARGE.search(msg)
        if m or "too large" in msg:
            raise PromptTooLarge(msg, int(m.group(1)) if m else None, int(m.group(2)) if m else None)
        if r.status_code == 503:
            raise BackendUnavailable(msg)
        if 400 <= r.status_code < 500:
            raise InvalidRequest(msg)
        raise BackendError(f"llama-server HTTP {r.status_code}: {msg}")

    async def health(self) -> str:
        try:
            r = await self._client.get("/health", timeout=2.0)
        except httpx.HTTPError:
            return "down"
        if r.status_code == 200:
            return "ok"
        if r.status_code == 503:
            return "loading"
        return "down"

    async def info(self) -> BackendInfo:
        info = BackendInfo()
        try:
            props = (await self._client.get("/props", timeout=5.0)).json()
            info.raw["props"] = {k: props.get(k) for k in ("total_slots", "model_path", "model_alias", "build_info")}
            info.slots = int(props.get("total_slots") or info.slots)
            n_ctx = (props.get("default_generation_settings") or {}).get("n_ctx")
            if n_ctx:
                info.n_ctx_slot = int(n_ctx)
            path = props.get("model_path") or props.get("model_alias")
            if path:
                info.model = PurePath(str(path).replace("\\", "/")).stem
        except (httpx.HTTPError, ValueError):
            pass
        if info.model == "unknown":
            try:
                models = (await self._client.get("/v1/models", timeout=5.0)).json()
                mid = models["data"][0]["id"]
                info.model = PurePath(str(mid).replace("\\", "/")).stem
            except (httpx.HTTPError, ValueError, KeyError, IndexError):
                pass
        return info

    async def aclose(self) -> None:
        await self._client.aclose()
