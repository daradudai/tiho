"""clean_for_model must give the model what the extension gives it (cleanForModel)."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from textclean import clean_for_model

NORMALIZE = Path(__file__).resolve().parents[2] / "extension" / "src" / "core" / "normalize.ts"
CASES = [
    "KEKW", "what game is this?", "", "   ", "Soooooooooo\u200b GOOD  \n !!!!!!!",
    "TORCIDA DO CHAVES KKKKKKKKKKKKKK", "jkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    "KEKW \U000e0000", "Love From malaysia \u2764\u200d\U0001f525\U0001f4aa", "\u26a0\ufe0f\u26a0\ufe0f\u5f7c\u5973",
    "\u0645\u06cc\u200c\u062e\u0648\u0627\u0645", "h\u0336\u0336\u0301e\u0489\u0489llo", "\u2800\u2800art\u2800 \u3164",
    "a\x1cb\x85c", "\ufeffbom\u00a0nbsp\u3000ideo\u2028line", "\u0417\u0434\u0440\u0430\u0432\u0435\u0439",
    "x" * 900, "a b " * 500, "\U0001f602" * 300, "ma la chat \u00e8 team sirio o barni? \u034f",
]


def test_keeps_runs_case_and_script():
    assert clean_for_model("Soooooooooo\u200b GOOD  \n !!!!!!!") == "Soooooooooo GOOD !!!!!!!"
    assert clean_for_model("\u0417\u0434\u0440\u0430\u0432\u0435\u0439") == "\u0417\u0434\u0440\u0430\u0432\u0435\u0439"
    assert clean_for_model("KEKW \U000e0000") == "KEKW"
    assert clean_for_model("\u2800 \u3164") == ""


def test_caps_length_in_utf16_units():
    assert clean_for_model("\U0001f602" * 300) == "\U0001f602" * 200
    assert clean_for_model("a" + "\U0001f602" * 250) == "a" + "\U0001f602" * 199  # a split emoji is dropped


def test_matches_the_extension():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not found")
    script = (f"import {{ cleanForModel }} from {json.dumps(NORMALIZE.as_uri())};"
              "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () =>"
              " process.stdout.write(JSON.stringify(JSON.parse(s).map(cleanForModel))));")
    run = subprocess.run([node, "--experimental-strip-types", "--input-type=module", "-e", script],
                         input=json.dumps(CASES), capture_output=True, text=True, encoding="utf-8")
    if run.returncode:
        pytest.skip(f"node cannot load {NORMALIZE.name}: {run.stderr.strip()[:200]}")
    assert [clean_for_model(c) for c in CASES] == json.loads(run.stdout)
