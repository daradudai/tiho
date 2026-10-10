"""`hush-engine` / `python -m hush_engine` command line."""

from __future__ import annotations

import argparse
import dataclasses
import os
import shlex
import sys
from pathlib import Path

from . import __version__

ENGINE_DIR = Path(__file__).resolve().parent.parent


def _parser() -> argparse.ArgumentParser:
    from .gpu import PROFILES

    ap = argparse.ArgumentParser(
        prog="hush-engine",
        description="Hush Engine: local server for custom natural-language chat filters (Clef-Flash on llama.cpp).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--version", action="version", version=f"hush-engine {__version__}")
    ap.add_argument("--attach", metavar="URL", help="use an already running llama-server (e.g. http://127.0.0.1:7378) instead of starting one")
    ap.add_argument("--host", default="127.0.0.1", help="interface to bind; keep it on loopback")
    ap.add_argument("--port", type=int, default=7377)

    g = ap.add_argument_group("managed llama-server (ignored with --attach)")
    g.add_argument("--llama-dir", type=Path, default=Path(os.environ.get("HUSH_LLAMA_DIR", ENGINE_DIR / "vendor" / "llama.cpp")),
                   help="where llama.cpp binaries live (downloaded here if missing)")
    g.add_argument("--llama-server", type=Path, help="explicit path to llama-server(.exe)")
    g.add_argument("--models-dir", type=Path, default=Path(os.environ.get("HUSH_MODELS_DIR", ENGINE_DIR / "vendor" / "models")),
                   help="model cache; the GGUF goes to <dir>/clef-flash/")
    g.add_argument("--model", type=Path, help="explicit GGUF path")
    g.add_argument("--quant", default="auto", choices=["auto", "Q8_0", "Q4_K_M"], help="auto: Q8_0 on >=14 GB VRAM, else Q4_K_M")
    g.add_argument("--profile", default="auto", choices=["auto", *PROFILES], help="slot/context preset by VRAM")
    g.add_argument("--llama-port", type=int, default=7379)
    g.add_argument("--parallel", type=int, help="llama-server -np (slots)")
    g.add_argument("--ctx", type=int, help="llama-server -c (total context, split across slots)")
    g.add_argument("--ubatch", type=int, help="llama-server -ub/-b (max prompt tokens per request)")
    g.add_argument("--ngl", type=int, help="llama-server -ngl")
    g.add_argument("--llama-args", default="", help='extra llama-server args, e.g. "--flash-attn on"')
    g.add_argument("--no-download", action="store_true", help="never download the model or llama.cpp")
    g.add_argument("--download-only", action="store_true", help="fetch model + llama.cpp if missing, then exit")
    g.add_argument("--log-dir", type=Path, default=ENGINE_DIR / "logs")

    s = ap.add_argument_group("serving")
    s.add_argument("--max-inflight", type=int, help="concurrent requests to llama-server (default: its slot count)")
    s.add_argument("--fixed-concurrency", action="store_true",
                   help="always keep --max-inflight requests in flight (no adaptive limit)")
    s.add_argument("--max-queue", type=int, default=1024, help="queued requests before the oldest are dropped")
    s.add_argument("--cache-size", type=int, default=50_000, help="LRU entries (one per message x question set)")
    s.add_argument("--deadline-ms", type=int, default=3000, help="default per-request deadline (0 = none)")
    s.add_argument("--max-prompt-tokens", type=int, help="prompt budget per llama-server request (default: from the server)")
    s.add_argument("--isolate-base", action="store_true",
                   help="ask the base schema in its own request (teacher-identical numbers, ~+12%% tokens)")
    s.add_argument("--allow-origin", action="append", default=[], help="extra exact CORS origin (repeatable)")
    s.add_argument("--log-level", default="warning", choices=["critical", "error", "warning", "info", "debug"])
    s.add_argument("--access-log", action="store_true")
    return ap


def main(argv: list[str] | None = None) -> int:
    a = _parser().parse_args(argv)

    from .gpu import PROFILES, detect_gpus, device_label, pick_profile
    from .llama import LlamaProcess, build_argv, port_in_use

    def log(msg: str) -> None:
        print(f"[hush-engine] {msg}", file=sys.stderr, flush=True)

    if a.host not in ("127.0.0.1", "localhost", "::1"):
        log(f"WARNING: binding to {a.host} exposes the engine beyond this machine")
    if not a.download_only and port_in_use(a.port):
        log(f"port {a.port} is already in use (another Hush Engine running?). Use --port to pick another.")
        return 2

    gpus = detect_gpus()
    device = device_label(gpus)
    process = None
    ubatch = None
    max_inflight = a.max_inflight

    if a.attach:
        mode, backend_url = "attach", a.attach.rstrip("/")
        if a.download_only:
            log("--download-only has nothing to do with --attach")
            return 0
    else:
        from .download import ensure_llama_server, ensure_model, model_filename

        mode = "managed"
        profile = PROFILES[a.profile] if a.profile != "auto" else pick_profile(gpus)
        parallel = a.parallel or profile.parallel
        ub = a.ubatch or profile.ubatch
        profile = dataclasses.replace(
            profile,
            parallel=parallel,
            ubatch=ub,
            # every slot must hold one full request (<= -ub tokens)
            ctx=a.ctx or parallel * max(profile.ctx_per_slot, ub),
            ngl=a.ngl if a.ngl is not None else profile.ngl,
        )
        quant = profile.quant if a.quant == "auto" else a.quant
        try:
            exe = a.llama_server or ensure_llama_server(a.llama_dir, nvidia=bool(gpus), allow_download=not a.no_download)
            model = a.model or ensure_model(a.models_dir, quant, allow_download=not a.no_download)
        except (OSError, FileNotFoundError) as e:
            log(str(e))
            return 1
        if a.download_only:
            log(f"llama-server: {exe}\nmodel: {model}")
            return 0
        if gpus and model.exists():
            need_mb = model.stat().st_size / 2**20 + 1500
            if gpus[0].free_mb < need_mb:
                log(f"WARNING: {gpus[0].free_mb} MiB VRAM free, ~{int(need_mb)} MiB needed for {model_filename(quant)}; "
                    "llama.cpp will offload fewer layers (slower). Close GPU-heavy apps or use --quant Q4_K_M.")
        posix = os.name != "nt"
        argv = build_argv(Path(exe).resolve(), Path(model).resolve(), a.llama_port, profile, shlex.split(a.llama_args, posix=posix))
        process = LlamaProcess(argv, a.llama_port, a.log_dir / "llama-server.log")
        backend_url = process.url
        ubatch = profile.ubatch
        max_inflight = max_inflight or profile.parallel
        log(f"profile {profile.name}: {model_filename(quant)}, -np {profile.parallel} -c {profile.ctx} -ub {profile.ubatch}"
            + (f" -ngl {profile.ngl}" if profile.ngl is not None else " (auto offload)"))

    import uvicorn

    from .app import Engine, EngineConfig, create_app
    from .backend import LlamaBackend

    cfg = EngineConfig(
        mode=mode,
        backend_url=backend_url,
        max_inflight=max_inflight,
        max_queue=a.max_queue,
        cache_size=a.cache_size,
        default_deadline_ms=a.deadline_ms,
        max_prompt_tokens=a.max_prompt_tokens,
        ubatch=ubatch,
        allow_origins=a.allow_origin,
        isolate_base=a.isolate_base,
        adaptive=not a.fixed_concurrency,
        device=device,
    )
    backend = LlamaBackend(backend_url, max_connections=max(64, (max_inflight or 16) * 2))
    engine = Engine(cfg, backend, process)
    app = create_app(engine)
    log(f"v{__version__} {mode} mode, backend {backend_url}, device {device}")
    log(f"listening on http://{a.host}:{a.port}  (GET /health, POST /v1/classify, POST /v1/systemone)")
    try:
        uvicorn.run(app, host=a.host, port=a.port, log_level=a.log_level, access_log=a.access_log)
    finally:
        if process:
            process.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
