"""GPU detection (nvidia-smi) and llama-server launch profiles by VRAM."""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass


@dataclass
class Gpu:
    name: str
    total_mb: int
    free_mb: int
    driver: str = ""


def detect_gpus() -> list[Gpu]:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return []
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 3:
            try:
                gpus.append(Gpu(parts[0], int(float(parts[1])), int(float(parts[2])), parts[3] if len(parts) > 3 else ""))
            except ValueError:
                continue
    return gpus


def device_label(gpus: list[Gpu]) -> str:
    if not gpus:
        return "unknown (no nvidia-smi)"
    g = gpus[0]
    return f"{g.name} ({round(g.total_mb / 1024)} GB)"


@dataclass
class LaunchProfile:
    name: str
    quant: str
    parallel: int  # -np
    ctx: int  # -c (total, split across slots)
    ubatch: int  # -ub / -b: max prompt tokens per request for a decision model
    ngl: int | None  # None = let llama.cpp --fit decide (partial offload)

    @property
    def ctx_per_slot(self) -> int:
        return self.ctx // max(1, self.parallel)


# Clef-Flash 9B: Q8_0 = 9.0 GiB, Q4_K_M = 6.0 GiB of weights. The model is a
# hybrid (Gated DeltaNet + attention) so KV cache is small; the compute buffer
# grows with -ub. Decision requests run in embedding mode, so one request must
# fit one physical batch (-ub) *and* one slot (-c / -np).
PROFILES = {
    "24gb": LaunchProfile("24gb", "Q8_0", parallel=8, ctx=16384, ubatch=2048, ngl=99),
    "16gb": LaunchProfile("16gb", "Q8_0", parallel=4, ctx=4096, ubatch=1024, ngl=99),
    "12gb": LaunchProfile("12gb", "Q4_K_M", parallel=4, ctx=4096, ubatch=1024, ngl=99),
    "8gb": LaunchProfile("8gb", "Q4_K_M", parallel=2, ctx=2048, ubatch=1024, ngl=99),
    "low": LaunchProfile("low", "Q4_K_M", parallel=2, ctx=2048, ubatch=1024, ngl=None),
}


def pick_profile(gpus: list[Gpu]) -> LaunchProfile:
    if not gpus:
        return PROFILES["low"]
    gb = gpus[0].total_mb / 1024
    if gb >= 20:
        return PROFILES["24gb"]
    if gb >= 14:
        return PROFILES["16gb"]
    if gb >= 10:
        return PROFILES["12gb"]
    if gb >= 7.5:
        return PROFILES["8gb"]
    return PROFILES["low"]
