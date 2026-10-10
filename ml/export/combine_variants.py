"""Combine two exported students that share a tokenizer into one model folder:
a deeper one for WebGPU (q8 / q4f16 files) and a shallower one for CPU/WASM
(uint8 file). The extension picks the file by backend (see
extension/src/inference/config.ts VARIANT_PREFERENCE) and uses that file's own
calibrated thresholds (`hush.variant_thresholds`).

    python ml/export/combine_variants.py --gpu ml/out/hush-lite-6L --cpu ml/out/hush-lite-3L --out extension/public/models/hush-lite
"""
from __future__ import annotations

import argparse
import filecmp
import json
import shutil
from pathlib import Path


def main(gpu: Path, cpu: Path, out: Path, version: str):
    for f in ("tokenizer.json", "tokenizer_config.json"):
        if not filecmp.cmp(gpu / f, cpu / f, shallow=False):
            raise SystemExit(f"{f} differs between {gpu} and {cpu}: the variants must share a tokenizer")
    gcfg = json.loads((gpu / "config.json").read_text(encoding="utf-8"))
    ccfg = json.loads((cpu / "config.json").read_text(encoding="utf-8"))
    gh, ch = gcfg["hush"], ccfg["hush"]
    if out.exists():
        shutil.rmtree(out)
    (out / "onnx").mkdir(parents=True)
    for f in ("tokenizer.json", "tokenizer_config.json"):
        shutil.copy2(gpu / f, out / f)
    files, sizes, vt, info = {}, {}, {}, {}
    for v in ("q8", "q8f16", "q4f16", "fp16"):
        if v in gh["files"] and (gpu / gh["files"][v]).exists():
            files[v] = gh["files"][v]
            shutil.copy2(gpu / gh["files"][v], out / files[v])
            sizes[v] = (out / files[v]).stat().st_size
            info[v] = {"layers": gcfg["num_hidden_layers"], "version": gh.get("version")}
    for v in ("uint8", "q4"):
        if v in ch["files"] and (cpu / ch["files"][v]).exists():
            name = ch["files"][v].replace(".onnx", f"_{ccfg['num_hidden_layers']}L.onnx")
            files[v] = name
            shutil.copy2(cpu / ch["files"][v], out / name)
            sizes[v] = (out / name).stat().st_size
            vt[v] = ch["thresholds"]
            info[v] = {"layers": ccfg["num_hidden_layers"], "version": ch.get("version")}
    gh = dict(gh, files=files, sizes=sizes, variant_thresholds=vt, variant_info=info, version=version)
    gcfg["hush"] = gh
    (out / "config.json").write_text(json.dumps(gcfg, indent=2), encoding="utf-8")
    for v, f in files.items():
        print(f"{v:6} {info[v]['layers']:2d} layers  {sizes[v] / 1e6:6.1f} MB  {f}")
    print("->", out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--gpu", required=True, type=Path)
    ap.add_argument("--cpu", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--version", default="v2-6L+3L")
    a = ap.parse_args()
    main(a.gpu, a.cpu, a.out, a.version)
