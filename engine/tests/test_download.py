from __future__ import annotations

import io
import tarfile
import zipfile
from pathlib import Path

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
