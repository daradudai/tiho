from __future__ import annotations

import hashlib
import io
import tarfile
import zipfile
from pathlib import Path

import httpx
import pytest

from hush_engine import download as D


def _zip(path: Path, files: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return path


def test_release_assets_names():
    assets = D.release_assets("b1", nvidia=True)
    assert all("b1" in a or a.startswith("cudart-") for a in assets)
    assert len(D.release_assets("b1", nvidia=False)) == 1


def test_every_release_asset_is_pinned(monkeypatch):
    """Whatever this OS / CPU / GPU downloads of LLAMA_BUILD has a known size and SHA-256."""
    wanted = set()
    for plat in ("win32", "darwin", "linux"):
        for machine in ("AMD64", "x86_64", "arm64", "aarch64"):
            for nvidia in (True, False):
                monkeypatch.setattr(D.sys, "platform", plat)
                monkeypatch.setattr(D.platform, "machine", lambda m=machine: m)
                wanted.update(D.release_assets(D.LLAMA_BUILD, nvidia))
    assert wanted == set(D.LLAMA_ASSETS)
    for size, sha in D.LLAMA_ASSETS.values():
        assert size > 1_000_000 and len(sha) == 64 and int(sha, 16) >= 0


def test_ensure_llama_server_flattens_archives(tmp_path, monkeypatch):
    exe = D.server_exe_name()
    src = tmp_path / "src"
    src.mkdir()
    archives = {
        D.release_assets("bX", True)[0]: {f"build/bin/{exe}": b"exe", "build/bin/ggml-cuda.dll": b"dll", "build/bin/sub/x.txt": b"x"},
    }
    if len(D.release_assets("bX", True)) > 1:
        archives[D.release_assets("bX", True)[1]] = {"cudart64_12.dll": b"rt", "cublas64_12.dll": b"bl"}
    urls = []

    def fake_download(url, dest, size=None, sha256=None, label=None):
        urls.append(url)
        name = url.rsplit("/", 1)[1]
        dest.parent.mkdir(parents=True, exist_ok=True)
        files = archives[name]
        if name.endswith(".zip"):
            return _zip(dest, files)
        with tarfile.open(dest, "w:gz") as t:
            for n, data in files.items():
                info = tarfile.TarInfo(n)
                info.size = len(data)
                t.addfile(info, io.BytesIO(data))
        return dest

    monkeypatch.setattr(D, "download", fake_download)
    target = tmp_path / "llama"
    got = D.ensure_llama_server(target, build="bX", nvidia=True)
    assert got == target / exe and got.read_bytes() == b"exe"
    assert (target / "ggml-cuda.dll").exists() and (target / "sub" / "x.txt").exists()
    if len(archives) > 1:
        assert (target / "cudart64_12.dll").exists()
    assert not (target / ".download").exists()
    assert all(u.startswith("https://github.com/ggml-org/llama.cpp/releases/download/bX/") for u in urls)
    # second call: nothing to do
    urls.clear()
    D.ensure_llama_server(target, build="bX")
    assert urls == []


def test_tampered_llama_archive_is_refused(tmp_path, monkeypatch):
    asset = D.release_assets(D.LLAMA_BUILD, nvidia=False)[0]
    good, bad = b"release archive.", b"replaced archive"  # same size, other bytes
    monkeypatch.setitem(D.LLAMA_ASSETS, asset, (len(good), hashlib.sha256(good).hexdigest()))
    client = httpx.Client
    serve = lambda req: httpx.Response(200, content=bad)  # noqa: E731
    monkeypatch.setattr(D.httpx, "Client", lambda **kw: client(transport=httpx.MockTransport(serve), **kw))
    with pytest.raises(IOError, match="SHA-256 mismatch"):
        D.ensure_llama_server(tmp_path / "llama", nvidia=False)
    assert not (tmp_path / "llama" / D.server_exe_name()).exists()


def test_ensure_model_existing_and_missing(tmp_path):
    p = tmp_path / "clef-flash" / "Clef-Flash-Q4_K_M.gguf"
    p.parent.mkdir(parents=True)
    p.write_bytes(b"gguf")
    assert D.ensure_model(tmp_path, "Q4_K_M", allow_download=False) == p  # (size warning only)
    try:
        D.ensure_model(tmp_path, "Q8_0", allow_download=False)
    except FileNotFoundError as e:
        assert "Clef-Flash-Q8_0.gguf" in str(e)
    else:
        raise AssertionError("expected FileNotFoundError")
    assert D.hf_url("Clef-Flash-Q8_0.gguf") == "https://huggingface.co/ggml-org/Clef-Flash-GGUF/resolve/main/Clef-Flash-Q8_0.gguf"
