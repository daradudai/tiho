"""Managed `llama-server` child process: spawn, health-wait, log capture, kill on exit.

On Windows the child is put into a Job Object with KILL_ON_JOB_CLOSE, so it dies
with the engine even if the engine is killed hard (Task Manager, closed console).
On Linux PR_SET_PDEATHSIG does the same.
"""

from __future__ import annotations

import asyncio
import atexit
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

from .gpu import LaunchProfile

MODEL_ALIAS = "clef-flash"
# llama-server -lv: errors and warnings only. At the default (3, info) it logs three
# lines per request, 10-20 MB an hour on a busy chat.
LOG_VERBOSITY = 2


def build_argv(
    exe: Path | str,
    model: Path | str,
    port: int,
    profile: LaunchProfile,
    extra: list[str] | None = None,
    api_key: str | None = None,
) -> list[str]:
    """llama-server command line. `api_key` locks every endpoint but /health: llama-server
    answers any Origin and any Host, so without one any web page could use (and tie up) it."""
    argv = [
        str(exe),
        "-m", str(model),
        "--host", "127.0.0.1",
        "--port", str(port),
        "-a", MODEL_ALIAS,
        "-np", str(profile.parallel),
        "-c", str(profile.ctx),
        "-ub", str(profile.ubatch),
        "-b", str(profile.ubatch),
        "--no-webui",
        "-lv", str(LOG_VERBOSITY),
    ]
    if api_key:
        argv += ["--api-key", api_key]
    if profile.ngl is not None:
        argv += ["-ngl", str(profile.ngl)]
    return argv + list(extra or [])


def shown_argv(argv: list[str]) -> str:
    """The command line for the log, without the API key."""
    return " ".join("***" if i and argv[i - 1] == "--api-key" else a for i, a in enumerate(argv))


def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex((host, port)) == 0


class _WinJob:
    """Windows Job Object that kills every assigned process when the last handle closes."""

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class BASIC(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class EXTENDED(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BASIC), ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        self._k32 = k32
        self.handle = k32.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        info = EXTENDED()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")

    def assign(self, proc: subprocess.Popen) -> None:
        if not self._k32.AssignProcessToJobObject(self.handle, int(proc._handle)):  # type: ignore[attr-defined]
            import ctypes

            raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")


def _linux_pdeathsig() -> None:  # runs in the child before exec
    try:
        import ctypes

        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:
        pass


class LlamaProcess:
    def __init__(self, argv: list[str], port: int, log_path: Path) -> None:
        self.argv = argv
        self.port = port
        self.url = f"http://127.0.0.1:{port}"
        self.log_path = log_path
        self.proc: subprocess.Popen | None = None
        self.restarts = 0
        self._job: _WinJob | None = None
        self._log = None
        atexit.register(self.stop)

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self) -> None:
        if self.alive:
            return
        if port_in_use(self.port):
            raise RuntimeError(
                f"port {self.port} is already in use. If a llama-server is already running there, "
                f"use --attach {self.url}; otherwise pick another --llama-port."
            )
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log = open(self.log_path, "wb")
        self._log.write((shown_argv(self.argv) + "\n\n").encode())
        self._log.flush()
        kwargs: dict = {}
        if os.name == "nt":
            # own process group: Ctrl+C in the console reaches only us, we stop the child ourselves
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        elif sys.platform.startswith("linux"):
            kwargs["preexec_fn"] = _linux_pdeathsig
        self.proc = subprocess.Popen(
            self.argv,
            stdout=self._log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            cwd=str(Path(self.argv[0]).parent) if Path(self.argv[0]).parent.exists() else None,
            **kwargs,
        )
        if os.name == "nt":
            try:
                self._job = self._job or _WinJob()
                self._job.assign(self.proc)
            except OSError as e:  # still killed by stop()/atexit on a normal exit
                print(f"[tiho-engine] warning: could not attach llama-server to a job object: {e}", file=sys.stderr)

    def log_tail(self, n: int = 25, max_bytes: int = 64 << 10) -> str:
        """The last `n` lines of the log, read from its last `max_bytes` only (it can be large)."""
        try:
            with self.log_path.open("rb") as f:
                size = f.seek(0, os.SEEK_END)
                f.seek(max(0, size - max_bytes))
                lines = f.read().decode("utf-8", errors="replace").splitlines()
        except OSError:
            return ""
        if size > max_bytes:
            lines = lines[1:]  # cut off in the middle
        return "\n".join(lines[-n:])

    async def wait_ready(self, timeout: float = 600.0, on_tick=None) -> None:
        """Poll /health until the model is loaded; fail fast if the process dies."""
        t0 = time.monotonic()
        async with httpx.AsyncClient(timeout=2.0, trust_env=False) as c:
            while True:
                if not self.alive:
                    code = self.proc.returncode if self.proc else None
                    raise RuntimeError(f"llama-server exited with code {code}:\n{await asyncio.to_thread(self.log_tail)}")
                try:
                    r = await c.get(f"{self.url}/health")
                    if r.status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                if time.monotonic() - t0 > timeout:
                    raise TimeoutError(f"llama-server not ready after {timeout:.0f}s:\n{await asyncio.to_thread(self.log_tail)}")
                if on_tick:
                    on_tick(time.monotonic() - t0)
                await asyncio.sleep(0.5)

    def stop(self, timeout: float = 10.0) -> None:
        p = self.proc
        if p is not None and p.poll() is None:
            try:
                p.terminate()  # TerminateProcess on Windows, SIGTERM elsewhere
                p.wait(timeout)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(5)
            except OSError:
                pass
        if self._log is not None:
            try:
                self._log.close()
            except OSError:
                pass
            self._log = None
