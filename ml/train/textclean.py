"""The text the model sees: a port of `cleanForModel` in
extension/src/core/normalize.ts, which the extension applies to every message
before it reaches the model. Training, distillation, evaluation and export
parity use this, so they see the same input as the browser. Keep the two in
sync; tests/test_textclean.py checks them against each other.

Light cleaning only: case, script, emoji and character runs stay; invisible
characters are dropped (including ZWJ, ZWNJ and variation selectors), zalgo
stacks squashed, blank runs single-spaced, length capped at 400.
"""
from __future__ import annotations

import re

MODEL_MAX = 400  # UTF-16 code units, like JavaScript string length

_MARKS = "\u0300-\u036f\u0483-\u0489\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f"
INVISIBLE = re.compile("[\u00ad\u034f\u061c\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f"
                       "\ufe00-\ufe0f\ufeff\U000e0000-\U000e01ef]")
ZALGO = re.compile(f"([{_MARKS}])[{_MARKS}]+")
# JavaScript's \s (Python's also matches \x1c-\x1f and \x85) plus invisible fillers.
BLANKS = re.compile("[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
                    "\u115f\u1160\u2800\u3164\uffa0]+")


def _head(s: str, units: int) -> str:
    """`s.slice(0, units)` in JavaScript: cut at UTF-16 code units (a split emoji is dropped)."""
    b = s.encode("utf-16-le", "surrogatepass")
    return s if len(b) <= 2 * units else b[: 2 * units].decode("utf-16-le", "ignore")


def clean_for_model(text: str) -> str:
    s = _head(text, MODEL_MAX * 2)
    s = BLANKS.sub(" ", ZALGO.sub(r"\1", INVISIBLE.sub("", s))).strip(" ")  # every blank is a space by now
    return _head(s, MODEL_MAX)
