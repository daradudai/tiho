"""First-run downloads: the Clef-Flash GGUF (Hugging Face) and a llama.cpp release (GitHub).

Resumable (`.part` + HTTP Range), with a progress line and SHA-256 verification
for the known model files and llama.cpp archives. Nothing is downloaded if the
files already exist.
"""

from __future__ import annotations

import hashlib
import os
import platform
import shutil
import sys
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path

import httpx

HF_REPO = "ggml-org/Clef-Flash-GGUF"
# quant -> (file name, size in bytes, sha256) from the HF repo tree
MODEL_FILES = {
    "Q8_0": ("Clef-Flash-Q8_0.gguf", 9_657_260_192, "d7c352faf1bdd9ea24d0b9347e8eb1eb4bbadeff6c02383bf750215a74f2f1f1"),
    "Q4_K_M": ("Clef-Flash-Q4_K_M.gguf", 6_486_448_288, "fd3e90605e8103307dca37cb5a8cdb036267e2fe3cb2d908d80a8ceb9ec0638c"),
}
# First llama.cpp release tested with the Clef decision endpoint (needs PR #29831).
LLAMA_BUILD = "b11541"
LLAMA_RELEASE_URL = "https://github.com/ggml-org/llama.cpp/releases/download/{build}/{asset}"
# LLAMA_BUILD release asset -> (size in bytes, sha256) from the GitHub release. These are
# binaries we run, so a replaced or tampered archive must fail like a bad model file does.
LLAMA_ASSETS = {
    "llama-b11541-bin-win-cuda-12.4-x64.zip": (265_224_711, "c5ccdd22e6b11c013efd6a931f93c3707e6fa5ab2f90df5c7d1838785540ece3"),
    "cudart-llama-bin-win-cuda-12.4-x64.zip": (391_443_627, "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6"),
    "llama-b11541-bin-win-vulkan-x64.zip": (33_464_528, "37bba511d120222f13c3d520dd875f739a530cc124e78f7cbce0026de0173d8a"),
    "llama-b11541-bin-win-cpu-arm64.zip": (12_343_725, "8f112d39c0bde44451ae5878709fdf2196e8d680cb8cb9354ca5332337f0942b"),
    "llama-b11541-bin-macos-arm64.tar.gz": (12_078_846, "226929037cfcb956f50ae1d54bac13d3d9446d8d819c439580e1e2c00197da5e"),
    "llama-b11541-bin-macos-x64.tar.gz": (11_602_041, "f74c3e79f68e9d0099bd2adc45c72208ec9748cd39e4098eeef7e49011445565"),
    "llama-b11541-bin-ubuntu-cuda-12.8-x64.tar.gz": (171_990_585, "551ee13d02dd42599861c8ffbd71c7a110f379a51cb9c5947cb799cdbbc610b2"),
    "cudart-llama-b11541-bin-ubuntu-cuda-12.8-x64.tar.gz": (594_377_950, "6c8acf749cb80a5932b8c5ba16476c3626ce72b09bcfe9078c27b1087ae39c4f"),
    "llama-b11541-bin-ubuntu-vulkan-x64.tar.gz": (31_770_592, "bf91ce14ddfda55c01c8b8846aa7d6093a07b0213913b6216ed4a2d6ea78b1f8"),
    "llama-b11541-bin-ubuntu-arm64.tar.gz": (13_799_565, "fcd44afd8ecdd2068d0c8505c0f96fa32014b4814d0dc74947a471deddcb9998"),
}


def model_filename(quant: str) -> str:
    if quant in MODEL_FILES:
        return MODEL_FILES[quant][0]
    return f"Clef-Flash-{quant}.gguf"


def hf_url(filename: str, repo: str = HF_REPO, revision: str = "main") -> str:
    return f"https://huggingface.co/{repo}/resolve/{revision}/{filename}"


def _fmt_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} GB"


class Progress:
    def __init__(self, label: str, total: int | None, start: int = 0) -> None:
        self.label = label
        self.total = total
        self.done = start
        self.start_bytes = start
        self.t0 = time.monotonic()
        self._last = 0.0
        self._last_pct = -1
        self.tty = sys.stderr.isatty()

    def update(self, n: int) -> None:
        self.done += n
        now = time.monotonic()
        if now - self._last < (0.5 if self.tty else 5.0):
            return
        self._last = now
        self._print()

    def _print(self, end: str = "") -> None:
        el = max(time.monotonic() - self.t0, 1e-6)
        rate = (self.done - self.start_bytes) / el
        if self.total:
            pct = 100 * self.done / self.total
            eta = (self.total - self.done) / rate if rate > 0 else 0
            msg = (f"  {self.label}  {_fmt_bytes(self.done)} / {_fmt_bytes(self.total)}  {pct:5.1f}%  "
                   f"{_fmt_bytes(rate)}/s  ETA {int(eta // 60)}m{int(eta % 60):02d}s")
        else:
            msg = f"  {self.label}  {_fmt_bytes(self.done)}  {_fmt_bytes(rate)}/s"
        if self.tty:
            sys.stderr.write("\r" + msg.ljust(100) + end)
        else:
            sys.stderr.write(msg + "\n")
        sys.stderr.flush()

    def finish(self) -> None:
        self._print(end="\n" if self.tty else "")


def download(url: str, dest: Path, size: int | None = None, sha256: str | None = None, label: str | None = None) -> Path:
    """Download `url` to `dest` (resumable). Verifies size and SHA-256 when given."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    label = label or dest.name
    headers = {"User-Agent": "tiho-engine"}
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if token and "huggingface.co" in url:
        headers["Authorization"] = f"Bearer {token}"
    have = part.stat().st_size if part.exists() else 0
    hasher = hashlib.sha256() if sha256 else None
    if hasher and have:
        with part.open("rb") as f:
            for chunk in iter(lambda: f.read(8 << 20), b""):
                hasher.update(chunk)
    with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30.0, read=120.0), headers=headers) as client:
        req_headers = {"Range": f"bytes={have}-"} if have else {}
        with client.stream("GET", url, headers=req_headers) as r:
            if r.status_code == 416 and have and (size is None or have == size):
                pass  # already complete
            else:
                if have and r.status_code == 200:  # server ignored Range: start over
                    have = 0
                    hasher = hashlib.sha256() if sha256 else None
                r.raise_for_status()
                length = int(r.headers.get("content-length") or 0)
                total = (have + length) if length else size
                prog = Progress(label, total, have)
                with part.open("ab" if have else "wb") as f:
                    for chunk in r.iter_bytes(1 << 20):
                        f.write(chunk)
                        if hasher:
                            hasher.update(chunk)
                        prog.update(len(chunk))
                prog.finish()
    got = part.stat().st_size
    if size is not None and got != size:
        raise IOError(f"{label}: size mismatch ({got} != {size}); delete {part} and retry")
    if hasher is not None and hasher.hexdigest() != sha256:
        bad = part.with_suffix(".corrupt")
        part.replace(bad)
        raise IOError(f"{label}: SHA-256 mismatch, moved to {bad}")
    part.replace(dest)
    return dest


def ensure_model(models_dir: Path, quant: str = "Q8_0", allow_download: bool = True) -> Path:
    """Path of the Clef-Flash GGUF, downloading it from Hugging Face if missing."""
    name = model_filename(quant)
    path = models_dir / "clef-flash" / name
    if path.exists():
        expected = MODEL_FILES.get(quant, (None, None, None))[1]
        if expected and path.stat().st_size != expected:
            print(f"[tiho-engine] warning: {path} has unexpected size {path.stat().st_size} (expected {expected})", file=sys.stderr)
        return path
    if not allow_download:
        raise FileNotFoundError(f"model not found: {path} (run without --no-download, or pass --model)")
    _, size, sha = MODEL_FILES.get(quant, (name, None, None))
    print(f"[tiho-engine] downloading {name} from huggingface.co/{HF_REPO} ...", file=sys.stderr)
    return download(hf_url(name), path, size=size, sha256=sha)


def server_exe_name() -> str:
    return "llama-server.exe" if os.name == "nt" else "llama-server"


def release_assets(build: str = LLAMA_BUILD, nvidia: bool = True) -> list[str]:
    """llama.cpp release archives for this OS/arch (binaries first, CUDA runtime second)."""
    machine = platform.machine().lower()
    arm = machine in ("arm64", "aarch64")
    if sys.platform == "win32":
        if arm:
            return [f"llama-{build}-bin-win-cpu-arm64.zip"]
        if nvidia:
            return [f"llama-{build}-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip"]
        return [f"llama-{build}-bin-win-vulkan-x64.zip"]
    if sys.platform == "darwin":
        return [f"llama-{build}-bin-macos-{'arm64' if arm else 'x64'}.tar.gz"]
    if arm:
        return [f"llama-{build}-bin-ubuntu-arm64.tar.gz"]
    if nvidia:
        return [f"llama-{build}-bin-ubuntu-cuda-12.8-x64.tar.gz", f"cudart-llama-{build}-bin-ubuntu-cuda-12.8-x64.tar.gz"]
    return [f"llama-{build}-bin-ubuntu-vulkan-x64.tar.gz"]


def _extract_flat(archive: Path, target: Path) -> None:
    """Extract an archive and copy the directory holding the binaries/libraries into `target`."""
    with tempfile.TemporaryDirectory(dir=target.parent) as tmp:
        tmpd = Path(tmp)
        if archive.name.endswith(".zip"):
            with zipfile.ZipFile(archive) as z:
                z.extractall(tmpd)
        else:
            with tarfile.open(archive) as t:
                if sys.version_info >= (3, 12):
                    t.extractall(tmpd, filter="data")
                else:
                    t.extractall(tmpd)  # noqa: S202 - trusted GitHub release archive
        exe = next(tmpd.rglob(server_exe_name()), None)
        if exe is not None:
            root = exe.parent
        else:  # runtime-only archive: the directory with the most libraries
            libs = [p for p in tmpd.rglob("*") if p.suffix in (".dll", ".so") or ".so." in p.name]
            root = max({p.parent for p in libs}, key=lambda d: sum(1 for p in libs if p.parent == d)) if libs else tmpd
        for p in root.rglob("*"):
            dst = target / p.relative_to(root)
            if p.is_dir():
                dst.mkdir(parents=True, exist_ok=True)
            elif p.is_file() or p.is_symlink():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, dst, follow_symlinks=False)


def ensure_llama_server(llama_dir: Path, build: str = LLAMA_BUILD, nvidia: bool = True, allow_download: bool = True) -> Path:
    """Path of llama-server, downloading and unpacking the llama.cpp release if missing."""
    exe = llama_dir / server_exe_name()
    if exe.exists():
        return exe
    if not allow_download:
        raise FileNotFoundError(f"llama-server not found: {exe} (run without --no-download, or pass --llama-server)")
    llama_dir.mkdir(parents=True, exist_ok=True)
    dl = llama_dir / ".download"
    for asset in release_assets(build, nvidia):
        print(f"[tiho-engine] downloading llama.cpp {build}: {asset} ...", file=sys.stderr)
        size, sha = LLAMA_ASSETS.get(asset, (None, None)) if build == LLAMA_BUILD else (None, None)
        archive = download(LLAMA_RELEASE_URL.format(build=build, asset=asset), dl / asset, size=size, sha256=sha)
        _extract_flat(archive, llama_dir)
        archive.unlink(missing_ok=True)
    shutil.rmtree(dl, ignore_errors=True)
    if not exe.exists():
        raise FileNotFoundError(f"llama-server not found in the release archive (expected {exe})")
    if os.name != "nt":
        exe.chmod(0o755)
    return exe
