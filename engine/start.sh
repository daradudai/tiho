#!/usr/bin/env sh
# Hush Engine launcher (Linux / macOS / Git Bash).
# First run creates engine/.venv and installs the engine (uv if available, else venv+pip).
# All arguments go to `python -m hush_engine`, e.g.
#   ./start.sh                                  # start llama-server + Clef-Flash (downloads if missing)
#   ./start.sh --quant Q4_K_M                   # 8-12 GB cards
#   ./start.sh --attach http://127.0.0.1:7378   # reuse a running llama-server
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"
if [ -x "$VENV/bin/python" ]; then PY="$VENV/bin/python"; else PY="$VENV/Scripts/python.exe"; fi

if [ ! -x "$PY" ]; then
  SYS=""
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then SYS="$c"; break; fi
  done
  [ -n "$SYS" ] || { echo "Python 3.10+ not found" >&2; exit 1; }
  echo "[hush-engine] creating $VENV ..."
  if "$SYS" -m uv --version >/dev/null 2>&1; then
    "$SYS" -m uv venv "$VENV" --quiet
    if [ -x "$VENV/bin/python" ]; then PY="$VENV/bin/python"; else PY="$VENV/Scripts/python.exe"; fi
    "$SYS" -m uv pip install --quiet --python "$PY" -e "$HERE"
  else
    "$SYS" -m venv "$VENV"
    if [ -x "$VENV/bin/python" ]; then PY="$VENV/bin/python"; else PY="$VENV/Scripts/python.exe"; fi
    "$PY" -m pip install --quiet --upgrade pip
    "$PY" -m pip install --quiet -e "$HERE"
  fi
fi

exec "$PY" -m hush_engine "$@"
