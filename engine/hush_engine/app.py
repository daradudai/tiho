"""FastAPI app: /health, /v1/classify, /v1/systemone."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, AsyncIterator, Callable

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .backend import Backend, BackendError, BackendInfo, InvalidRequest
from .cache import LRUCache
from .llama import LlamaProcess
from .scheduler import Expired, Overloaded, Scheduler
from .service import ClassifyService, Filter, Msg

MAX_MESSAGES = 256
MAX_FILTERS = 32
SUPERVISE_INTERVAL = 2.0  # seconds between checks of the backend
RESTART_WINDOW = 600.0  # max_restarts llama-server launches per this many seconds

# Chrome / Edge / Brave extension ids are 32 chars a-p; Firefox uses a UUID.
DEFAULT_ORIGIN_RE = (
    r"chrome-extension://[a-p]{32}"
    r"|moz-extension://[0-9a-fA-F-]{36}"
    r"|https?://(localhost|127\.0\.0\.1)(:\d+)?"
)


@dataclass
class EngineConfig:
    mode: str = "attach"  # attach | managed
    backend_url: str = "http://127.0.0.1:7379"
    max_inflight: int | None = None  # default: llama-server slots
    max_queue: int = 1024
    cache_size: int = 50_000
    default_deadline_ms: int = 3000
    max_prompt_tokens: int | None = None  # default: per-slot context (and -ub when managed) - margin
    ubatch: int | None = None  # known when managed
    isolate_base: bool = False  # base schema in its own request (teacher-identical numbers)
    adaptive: bool = True  # shrink concurrency when answers miss their deadlines (shared GPU)
    allow_origins: list[str] = field(default_factory=list)
    trusted_hosts: list[str] = field(default_factory=lambda: ["127.0.0.1", "localhost"])
    device: str = "unknown"
    ready_timeout: float = 900.0
    max_restarts: int = 3  # per RESTART_WINDOW
    restart_backoff: float = 15.0  # wait before retrying a failed restart, doubled each time


# --- request models -----------------------------------------------------------------

class MessageIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str | int
    text: str = Field(max_length=4000)
    author: str | None = Field(default=None, max_length=200)
    channel: str | None = Field(default=None, max_length=200)
    platform: str | None = Field(default=None, max_length=32)


class FilterIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(max_length=128)
    question: str = Field(min_length=1, max_length=500)


class ClassifyIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    messages: list[MessageIn] = Field(max_length=MAX_MESSAGES)
    filters: list[FilterIn] = Field(default_factory=list, max_length=MAX_FILTERS)
    base: bool = False
    deadline_ms: int | None = Field(default=None, ge=0, le=120_000)
    context: str | None = Field(default=None, max_length=300)
    stream: bool = False  # NDJSON: one line per message as soon as it is ready, then {"done": true, ...}


# --- engine ---------------------------------------------------------------------------

class Engine:
    """Owns the backend, scheduler, service and (in managed mode) the llama-server process."""

    def __init__(self, cfg: EngineConfig, backend: Backend, process: LlamaProcess | None = None) -> None:
        self.cfg = cfg
        self.backend = backend
        self.process = process
        self.cache: LRUCache = LRUCache(cfg.cache_size)
        self.scheduler = Scheduler(backend, cfg.max_inflight or 8, cfg.max_queue, self.cache, adaptive=cfg.adaptive)
        self.service = ClassifyService(
            self.scheduler, default_deadline_ms=cfg.default_deadline_ms, isolate_base=cfg.isolate_base
        )
        self.status = "starting"
        self.detail = ""
        self.info = BackendInfo()
        self.started_at = time.monotonic()
        self._task: asyncio.Task | None = None

    @property
    def ready(self) -> bool:
        return self.status == "ready"

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="hush-engine-supervisor")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        await self.scheduler.stop()
        await self.backend.aclose()
        if self.process:
            self.process.stop()

    def _log(self, msg: str) -> None:
        print(f"[hush-engine] {msg}", file=sys.stderr, flush=True)

    async def _launch(self) -> None:
        assert self.process is not None
        self.status = "loading"
        self.detail = "starting llama-server and loading the model"
        self.process.start()
        self._log(f"llama-server started (pid {self.process.proc.pid}), loading model; log: {self.process.log_path}")
        await self.process.wait_ready(self.cfg.ready_timeout)

    async def _wait_backend(self) -> None:
        self.status = "waiting_backend"
        self.detail = f"waiting for llama-server at {self.cfg.backend_url}"
        warned = False
        while True:
            h = await self.backend.health()
            if h == "ok":
                return
            self.status = "loading" if h == "loading" else "waiting_backend"
            if not warned and h == "down":
                self._log(f"llama-server at {self.cfg.backend_url} is not reachable yet; retrying")
                warned = True
            await asyncio.sleep(1.0)

    async def _configure(self) -> None:
        self.info = await self.backend.info()
        slots = self.cfg.max_inflight or self.info.slots
        limit = self.info.n_ctx_slot
        if self.cfg.ubatch:
            limit = min(limit, self.cfg.ubatch)
        self.service.budget = self.cfg.max_prompt_tokens or max(256, limit - 32)
        self.scheduler.start(slots)
        self.status, self.detail = "ready", ""
        self._log(
            f"ready: model={self.info.model} slots={self.info.slots} ctx/slot={self.info.n_ctx_slot} "
            f"inflight={self.scheduler.limit}..{self.scheduler.max_inflight} prompt_budget={self.service.budget}"
        )

    async def _relaunch(self, restarts: list[float]) -> bool:
        """Restart a crashed llama-server, retrying failed launches (e.g. no VRAM while a game
        holds it) with backoff. False, with status "error", once max_restarts are used up."""
        assert self.process is not None
        failures = 0
        while True:
            now = time.monotonic()
            restarts[:] = [t for t in restarts if now - t < RESTART_WINDOW]
            code = self.process.proc.returncode if self.process.proc else None
            if len(restarts) >= self.cfg.max_restarts:
                self.process.stop()  # a launch that timed out may still be loading
                self.status = "error"
                self.detail = f"llama-server keeps crashing (exit {code}); see {self.process.log_path}"
                self._log(self.detail + "\n" + await asyncio.to_thread(self.process.log_tail))
                return False
            if failures:
                delay = self.cfg.restart_backoff * 2 ** (failures - 1)
                self.status = "backend_down"
                self.detail = f"llama-server did not come back (exit {code}); retrying in {delay:.0f} s"
                await asyncio.sleep(delay)
            else:
                self._log(f"llama-server exited (code {code}); restarting\n{await asyncio.to_thread(self.process.log_tail, 10)}")
            restarts.append(time.monotonic())
            self.process.stop()
            try:
                await self._launch()
            except Exception as e:  # noqa: BLE001 - counted, retried until max_restarts
                failures += 1
                self._log(f"restarting llama-server failed: {e}")
                continue
            self.status, self.detail = "ready", ""
            return True

    async def _run(self) -> None:
        restarts: list[float] = []
        try:
            if self.process:
                await self._launch()
            else:
                await self._wait_backend()
            await self._configure()
            while True:
                await asyncio.sleep(SUPERVISE_INTERVAL)
                if self.process and not self.process.alive:
                    if not await self._relaunch(restarts):
                        return
                    continue
                h = await self.backend.health()
                if h == "ok":
                    if self.status != "ready":
                        self._log("backend is back")
                    self.status, self.detail = "ready", ""
                else:
                    if self.status == "ready":
                        self._log(f"backend {h}")
                    self.status = "loading" if h == "loading" else "backend_down"
                    self.detail = f"llama-server at {self.cfg.backend_url}: {h}"
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            self.status = "error"
            self.detail = str(e)
            self._log(f"error: {e}")

    def health(self) -> dict[str, Any]:
        return {
            "ok": self.ready,
            "status": self.status,
            "detail": self.detail,
            "version": __version__,
            "decision_model": self.info.model,
            "device": self.cfg.device,
            "mode": self.cfg.mode,
            "backend": self.cfg.backend_url,
            "queue": self.scheduler.stats(),
            "cache": self.cache.stats(),
            "service": self.service.stats(),
            "limits": {
                "max_messages": MAX_MESSAGES,
                "max_filters": MAX_FILTERS,
                "default_deadline_ms": self.cfg.default_deadline_ms,
                "prompt_budget": self.service.budget,
                "slots": self.info.slots,
                "isolate_base": self.service.isolate_base,
            },
            "uptime": round(time.monotonic() - self.started_at, 1),
        }


# --- middleware -------------------------------------------------------------------------

class OriginGuard:
    """Reject non-preflight requests that carry a foreign Origin (blocks CSRF-style "simple" POSTs from web pages)."""

    def __init__(self, app, allowed: Callable[[str], bool]) -> None:
        self.app = app
        self.allowed = allowed

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("method") != "OPTIONS":
            origin = next((v.decode("latin-1") for k, v in scope.get("headers", []) if k == b"origin"), None)
            if origin and not self.allowed(origin):
                resp = JSONResponse({"error": {"code": "forbidden_origin", "message": f"origin {origin} not allowed"}}, 403)
                await resp(scope, receive, send)
                return
        await self.app(scope, receive, send)


class PrivateNetworkAccess:
    """Answer Chrome's Private Network Access preflight for allowed origins."""

    def __init__(self, app, allowed: Callable[[str], bool]) -> None:
        self.app = app
        self.allowed = allowed

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "OPTIONS":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        origin = headers.get(b"origin", b"").decode("latin-1")
        wants = headers.get(b"access-control-request-private-network") == b"true"
        if not (wants and origin and self.allowed(origin)):
            return await self.app(scope, receive, send)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                message["headers"] = list(message["headers"]) + [(b"access-control-allow-private-network", b"true")]
            await send(message)

        return await self.app(scope, receive, send_wrapper)


def _error(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


async def _ndjson(lines: AsyncGenerator[dict[str, Any], None]) -> AsyncIterator[bytes]:
    async with contextlib.aclosing(lines):
        async for line in lines:
            yield json.dumps(line, separators=(",", ":")).encode() + b"\n"


def create_app(engine: Engine) -> FastAPI:
    cfg = engine.cfg
    pattern = "^(" + DEFAULT_ORIGIN_RE + ("|" + "|".join(re.escape(o) for o in cfg.allow_origins) if cfg.allow_origins else "") + ")$"
    origin_re = re.compile(pattern)

    def allowed(origin: str) -> bool:
        return bool(origin_re.match(origin))

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        await engine.start()
        try:
            yield
        finally:
            await engine.stop()

    # no /docs: Swagger UI would pull scripts from a CDN; the schema is at /openapi.json
    app = FastAPI(title="Hush Engine", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.engine = engine
    # added innermost first: OriginGuard -> CORS -> PNA -> TrustedHost (outermost)
    app.add_middleware(OriginGuard, allowed=allowed)
    cors: dict[str, Any] = dict(
        allow_origin_regex=pattern,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["content-type"],
        max_age=600,
    )
    native_pna = "allow_private_network" in inspect.signature(CORSMiddleware.__init__).parameters
    if native_pna:  # Starlette >= 0.4x answers Chrome's Private Network Access preflight itself
        cors["allow_private_network"] = True
    app.add_middleware(CORSMiddleware, **cors)
    if not native_pna:
        app.add_middleware(PrivateNetworkAccess, allowed=allowed)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=cfg.trusted_hosts)

    @app.exception_handler(BackendError)
    async def _backend_error(_: Request, e: BackendError):
        return _error(e.code, str(e), e.status)

    @app.exception_handler(Expired)
    @app.exception_handler(Overloaded)
    async def _sched_error(_: Request, e: Exception):
        return _error(getattr(e, "code", "error"), str(e), getattr(e, "status", 503))

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, e: RequestValidationError):
        return JSONResponse({"error": {"code": "invalid_request", "message": "invalid request", "details": json.loads(json.dumps(e.errors(), default=str))}}, 422)

    def not_ready() -> JSONResponse:
        return _error(engine.status, engine.detail or f"engine is {engine.status}", 503)

    @app.get("/health")
    async def health():
        return engine.health()

    @app.get("/")
    async def root():
        return {"name": "hush-engine", "version": __version__, "endpoints": ["/health", "/v1/classify", "/v1/systemone", "/openapi.json"]}

    @app.post("/v1/classify")
    async def classify(req: ClassifyIn):
        if not engine.ready:
            return not_ready()
        args = (
            [Msg(m.id, m.text, m.platform, m.author, m.channel) for m in req.messages],
            [Filter(f.id, f.question) for f in req.filters],
        )
        kwargs: dict[str, Any] = dict(base=req.base, deadline_ms=req.deadline_ms, context=req.context)
        if req.stream:
            return StreamingResponse(_ndjson(engine.service.classify_stream(*args, **kwargs)), media_type="application/x-ndjson")
        return await engine.service.classify(*args, **kwargs)

    @app.post("/v1/systemone")
    async def systemone(request: Request):
        if not engine.ready:
            return not_ready()
        try:
            body = await request.json()
        except ValueError:
            raise InvalidRequest("body must be JSON")
        if not isinstance(body, dict):
            raise InvalidRequest("body must be a JSON object")
        deadline_ms = body.pop("deadline_ms", 0)
        return await engine.service.systemone(body, deadline_ms=int(deadline_ms or 0))

    return app
