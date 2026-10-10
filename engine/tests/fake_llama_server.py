"""A tiny stand-in for `llama-server` (decision model) used by the process-management tests.

Accepts (and ignores) llama-server flags; honours --port and --api-key (everything but
/health then needs `Authorization: Bearer <key>`). Extra flags:
  --ready-after SECONDS   /health answers 503 "loading" until then
  --crash-after SECONDS   exit(3) after that long
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=7379)
ap.add_argument("--ready-after", type=float, default=0.3)
ap.add_argument("--crash-after", type=float, default=0.0)
ap.add_argument("-np", type=int, default=4)
ap.add_argument("-c", type=int, default=4096)
ap.add_argument("--api-key")
args, _unknown = ap.parse_known_args()
T0 = time.monotonic()


def answers(questions: dict) -> dict:
    out = {}
    for qid, q in questions.items():
        if q.get("type") == "noul":
            out[qid] = {"type": "noul", "noul": 0.25}
        else:
            opts = list(q.get("criteria") or {})
            p = {o: round(1.0 / len(opts), 4) for o in opts}
            out[qid] = {"type": "choice", "choice": opts[0], "probabilities": p, "confidence": 0.0}
    return out


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _denied(self) -> bool:
        if not args.api_key or self.headers.get("Authorization") == f"Bearer {args.api_key}":
            return False
        self._json(401, {"error": {"code": 401, "message": "Invalid API Key", "type": "authentication_error"}})
        return True

    def do_GET(self):
        ready = time.monotonic() - T0 >= args.ready_after
        if self.path == "/health":
            return self._json(200, {"status": "ok"}) if ready else self._json(503, {"error": {"code": 503, "message": "Loading model"}})
        if self._denied():
            return
        if self.path == "/props":
            return self._json(200, {"total_slots": args.np, "model_path": "fake/Fake-Clef.gguf",
                                    "default_generation_settings": {"n_ctx": args.c // args.np}})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self._denied():
            return
        if self.path == "/v1/systemone":
            return self._json(200, {"model": "fake", "answers": answers(body.get("questions") or {}),
                                    "usage": {"input_tokens": 100, "output_tokens": 0}})
        return self._json(404, {"error": "not found"})


def crasher():
    time.sleep(args.crash_after)
    os._exit(3)


if args.crash_after > 0:
    threading.Thread(target=crasher, daemon=True).start()
print(f"fake llama-server pid {os.getpid()} listening on {args.port}", flush=True)
ThreadingHTTPServer(("127.0.0.1", args.port), H).serve_forever()
