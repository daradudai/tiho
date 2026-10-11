"""Process management, tested with a fake llama-server (no GPU / model needed)."""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from tiho_engine import app as app_module
from tiho_engine.app import Engine, EngineConfig, create_app
from tiho_engine.backend import BackendError, LlamaBackend
from tiho_engine.gpu import PROFILES, Gpu, pick_profile
from tiho_engine.llama import LlamaProcess, build_argv, port_in_use, shown_argv

from .conftest import free_port

HERE = Path(__file__).resolve().parent
FAKE = HERE / "fake_llama_server.py"
# the venv's python.exe on Windows is a launcher that spawns the real interpreter as a
# child; use the base interpreter so the fake server *is* the process we manage
PY = getattr(sys, "_base_executable", None) or sys.executable
REAL = HERE.parent / "vendor" / "llama.cpp" / ("llama-server.exe" if os.name == "nt" else "llama-server")


def fake_proc(tmp_path, *extra: str) -> LlamaProcess:
    port = free_port()
    argv = [PY, str(FAKE), "--port", str(port), *extra]
    return LlamaProcess(argv, port, tmp_path / "llama.log")


def pid_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes

        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000 | 0x00100000, False, pid)  # QUERY_LIMITED_INFORMATION | SYNCHRONIZE
        if not h:
            return False
        try:
            return k32.WaitForSingleObject(h, 0) == 0x102  # WAIT_TIMEOUT -> still running
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def test_profiles():
    assert pick_profile([Gpu("RTX 3090", 24576, 20000)]).quant == "Q8_0"
    assert pick_profile([Gpu("RTX 4060 Ti", 16380, 15000)]).quant == "Q8_0"
    assert pick_profile([Gpu("RTX 3060", 12288, 11000)]).quant == "Q4_K_M"
    assert pick_profile([]).ngl is None
    for p in PROFILES.values():
        assert p.ctx_per_slot >= p.ubatch, p  # one request must fit one slot


def test_argv():
    argv = build_argv("llama-server", "m.gguf", 7379, PROFILES["24gb"], ["--flash-attn", "on"], api_key="k3y")
    s = " ".join(argv)
    assert "--host 127.0.0.1" in s and "--port 7379" in s and "-ngl 99" in s
    assert "-np 8" in s and "-c 16384" in s and "-ub 2048" in s and "-b 2048" in s
    assert "--api-key k3y" in s and "-lv 2" in s  # locked to us; no per-request info lines in the log
    assert argv[-2:] == ["--flash-attn", "on"]
    assert "--api-key" not in build_argv("llama-server", "m.gguf", 7379, PROFILES["24gb"])
    assert shown_argv(argv).count("k3y") == 0 and "--api-key ***" in shown_argv(argv)


@pytest.mark.skipif(not REAL.exists(), reason="llama-server binary not present")
def test_argv_flags_exist_in_real_binary():
    help_text = subprocess.run([str(REAL), "--help"], capture_output=True, text=True, timeout=60,
                               encoding="utf-8", errors="replace").stdout
    for flag in build_argv(REAL, "m.gguf", 1, PROFILES["24gb"], api_key="k"):
        if flag.startswith("-"):
            assert flag in help_text, flag


def test_log_tail_reads_only_the_end(tmp_path):
    p = LlamaProcess(["llama-server"], free_port(), tmp_path / "llama.log")
    assert p.log_tail() == ""  # no log yet
    p.log_path.write_bytes(b"".join(f"line {i} {'x' * 60}\n".encode() for i in range(100_000)))  # ~7 MB
    tail = p.log_tail(3, max_bytes=1000).splitlines()
    assert [t.split()[1] for t in tail] == ["99997", "99998", "99999"]
    assert len(p.log_tail(1000, max_bytes=1000).splitlines()) < 20  # never more than max_bytes
    assert p.log_tail(1000, max_bytes=1000).splitlines()[0].startswith("line ")  # no cut-off first line


def test_spawn_wait_stop(tmp_path):
    import asyncio

    p = fake_proc(tmp_path, "--ready-after", "0.8")
    p.start()
    try:
        assert p.alive
        t0 = time.monotonic()
        asyncio.run(p.wait_ready(timeout=20))
        assert time.monotonic() - t0 >= 0.5  # waited through "loading"
        assert httpx.get(p.url + "/health", trust_env=False).status_code == 200
        with pytest.raises(RuntimeError, match="already in use"):
            LlamaProcess(p.argv, p.port, tmp_path / "x.log").start()
    finally:
        p.stop()
    assert not p.alive
    t0 = time.monotonic()
    while port_in_use(p.port) and time.monotonic() - t0 < 3:
        time.sleep(0.1)
    assert not port_in_use(p.port)


def test_crash_during_load_reports_log(tmp_path):
    import asyncio

    p = fake_proc(tmp_path, "--ready-after", "30", "--crash-after", "0.5")
    p.start()
    try:
        with pytest.raises(RuntimeError, match="exited with code 3"):
            asyncio.run(p.wait_ready(timeout=20))
    finally:
        p.stop()


def test_child_dies_with_parent(tmp_path):
    """Kill the parent hard (no cleanup at all): the job object / pdeathsig must take the child down."""
    port = free_port()
    script = textwrap.dedent(f"""
        import os, sys, time, asyncio
        sys.path.insert(0, {str(HERE.parent)!r})
        from pathlib import Path
        from tiho_engine.llama import LlamaProcess
        p = LlamaProcess([{PY!r}, {str(FAKE)!r}, "--port", "{port}"], {port}, Path({str(tmp_path / 'c.log')!r}))
        p.start()
        asyncio.run(p.wait_ready(20))
        print(p.proc.pid, flush=True)
        os._exit(9)
    """)
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=60)
    child = int(out.stdout.strip().splitlines()[-1])
    deadline = time.monotonic() + 10
    while pid_alive(child) and time.monotonic() < deadline:
        time.sleep(0.1)
    alive = pid_alive(child)
    if alive:  # don't leak it
        subprocess.run(["taskkill", "/F", "/PID", str(child)] if os.name == "nt" else ["kill", "-9", str(child)])
    assert not alive


def test_managed_engine_end_to_end(tmp_path):
    """Engine in managed mode: starts the (fake) server, waits, serves, restarts it after a crash, stops it."""
    key = "per-launch-key"
    p = fake_proc(tmp_path, "--ready-after", "0.5", "-np", "3", "-c", "3072", "--api-key", key)
    cfg = EngineConfig(mode="managed", backend_url=p.url, ubatch=1024,
                       trusted_hosts=["testserver", "127.0.0.1"])
    engine = Engine(cfg, LlamaBackend(p.url, api_key=key), p)
    with TestClient(create_app(engine)) as c:
        t0 = time.monotonic()
        while not c.get("/health").json()["ok"] and time.monotonic() - t0 < 20:
            time.sleep(0.1)
        h = c.get("/health").json()
        assert h["ok"] and h["mode"] == "managed" and h["queue"]["max_inflight"] == 3
        assert h["decision_model"] == "Fake-Clef"
        r = c.post("/v1/classify", json={"messages": [{"id": 1, "text": "hi"}], "filters": [{"id": "a", "question": "Is it hi?"}]})
        assert r.json()["results"][0]["filters"]["a"] == 0.25
        # anyone else (a web page) gets nothing but /health from the child
        assert httpx.get(p.url + "/props", trust_env=False).status_code == 401
        assert httpx.get(p.url + "/health", trust_env=False).status_code == 200
        assert key not in p.log_path.read_text(encoding="utf-8")
        first_pid = p.proc.pid
        p.proc.kill()  # crash
        t0 = time.monotonic()
        while time.monotonic() - t0 < 20:
            time.sleep(0.2)
            if p.alive and p.proc.pid != first_pid and c.get("/health").json()["ok"]:
                break
        assert p.alive and p.proc.pid != first_pid
        child = p.proc.pid
    assert not pid_alive(child)  # stopped with the app


def test_attach_to_a_server_with_an_api_key(tmp_path):
    import asyncio

    p = fake_proc(tmp_path, "--ready-after", "0", "--api-key", "s3cret")
    p.start()

    async def info(key):
        b = LlamaBackend(p.url, api_key=key)
        try:
            return await b.info()
        finally:
            await b.aclose()

    try:
        asyncio.run(p.wait_ready(timeout=20))
        assert asyncio.run(info("s3cret")).model == "Fake-Clef"
        for key in (None, "wrong"):
            with pytest.raises(BackendError, match="--attach-key"):
                asyncio.run(info(key))
    finally:
        p.stop()


class StubProcess:
    """LlamaProcess stand-in for the supervisor: `crash()` kills it; the next `fail` launches die while loading."""

    def __init__(self, fail: int = 0) -> None:
        self.fail = fail
        self.starts = 0
        self.proc: SimpleNamespace | None = None
        self.log_path = Path("llama-server.log")

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    def start(self) -> None:
        self.starts += 1
        self.proc = SimpleNamespace(pid=1000 + self.starts, returncode=None)

    async def wait_ready(self, timeout: float) -> None:
        if self.starts > 1 and self.fail > 0:  # e.g. out of VRAM while a game holds it
            self.fail -= 1
            self.proc.returncode = 1
            raise RuntimeError("llama-server exited with code 1")

    def crash(self) -> None:
        self.proc.returncode = 3

    def stop(self) -> None:
        if self.alive:
            self.proc.returncode = -1

    def log_tail(self, n: int = 25) -> str:
        return ""


def supervise(fake, process: StubProcess, until, timeout: float = 5.0) -> Engine:
    import asyncio

    async def run() -> Engine:
        engine = Engine(EngineConfig(mode="managed", restart_backoff=0.05, max_restarts=3), fake, process)
        await engine.start()
        try:
            t0 = time.monotonic()
            while not engine.ready:
                await asyncio.sleep(0.01)
            process.crash()
            while not until(engine) and time.monotonic() - t0 < timeout:
                await asyncio.sleep(0.01)
            return engine
        finally:
            await engine.stop()

    return asyncio.run(run())


def test_supervisor_retries_a_failed_restart(fake, monkeypatch):
    monkeypatch.setattr(app_module, "SUPERVISE_INTERVAL", 0.02)
    p = StubProcess(fail=2)
    engine = supervise(fake, p, lambda e: e.ready and p.starts == 4)
    assert p.starts == 4  # first launch, two restarts that died while loading, one that worked
    assert engine.status == "ready"


def test_supervisor_gives_up_after_max_restarts(fake, monkeypatch):
    monkeypatch.setattr(app_module, "SUPERVISE_INTERVAL", 0.02)
    p = StubProcess(fail=99)
    engine = supervise(fake, p, lambda e: e.status == "error")
    assert engine.status == "error" and "keeps crashing" in engine.detail
    assert p.starts == 1 + 3  # max_restarts launches, then no more
