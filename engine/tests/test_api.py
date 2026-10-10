from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from hush_engine.app import Engine, EngineConfig, create_app

EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"


def client_for(fake, **cfg) -> TestClient:
    cfg.setdefault("trusted_hosts", ["127.0.0.1", "localhost", "testserver"])
    engine = Engine(EngineConfig(**cfg), fake)
    return TestClient(create_app(engine))


def wait_ready(c: TestClient, timeout: float = 5.0) -> dict:
    t0 = time.monotonic()
    while True:
        h = c.get("/health").json()
        if h["ok"] or time.monotonic() - t0 > timeout:
            return h
        time.sleep(0.05)


def test_health_and_classify(fake):
    with client_for(fake) as c:
        h = wait_ready(c)
        assert h["ok"] is True and h["status"] == "ready"
        for k in ("version", "decision_model", "device", "queue", "uptime", "cache", "limits"):
            assert k in h
        assert h["decision_model"] == "Fake-Clef"
        assert h["queue"]["max_inflight"] == 4  # = backend slots
        r = c.post("/v1/classify", json={
            "messages": [{"id": "m1", "text": "jump left", "author": "bob", "channel": "xqc", "platform": "twitch"}],
            "filters": [{"id": "bs", "question": "Is this message backseating the streamer's gameplay?"}],
            "base": True,
        })
        assert r.status_code == 200, r.text
        d = r.json()
        assert set(d) == {"results", "ms", "expired"}
        res = d["results"][0]
        assert res["id"] == "m1" and 0 <= res["filters"]["bs"] <= 1
        assert set(res["base"]) == {"toxic", "spam", "scam", "noise", "question", "clean", "positive", "negative"}


def test_classify_stream_ndjson(fake):
    with client_for(fake) as c:
        wait_ready(c)
        req = {"messages": [{"id": 1, "text": "jump left"}, {"id": "m2", "text": "gg"}],
               "filters": [{"id": "bs", "question": "Is this message backseating the streamer's gameplay?"}], "stream": True}
        with c.stream("POST", "/v1/classify", json=req) as r:
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("application/x-ndjson")
            lines = [json.loads(line) for line in r.iter_lines() if line]
        assert sorted(str(x["id"]) for x in lines[:-1]) == ["1", "m2"]
        assert all(0 <= x["filters"]["bs"] <= 1 for x in lines[:-1])
        assert lines[-1]["done"] is True and lines[-1]["expired"] == 0 and "ms" in lines[-1]
        plain = c.post("/v1/classify", json={**req, "stream": False}).json()
        assert [x["id"] for x in plain["results"]] == [1, "m2"]


def test_validation(fake):
    with client_for(fake) as c:
        wait_ready(c)
        assert c.post("/v1/classify", json={"filters": []}).status_code == 422
        too_many = {"messages": [{"id": i, "text": "x"} for i in range(300)]}
        assert c.post("/v1/classify", json=too_many).status_code == 422
        assert c.post("/v1/classify", json={"messages": [], "deadline_ms": -1}).status_code == 422
        r = c.post("/v1/systemone", json={"state": "x"})
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_request"


def test_systemone_passthrough(fake):
    with client_for(fake) as c:
        wait_ready(c)
        r = c.post("/v1/systemone", json={"model": "m", "state": "hi", "questions": {"q": {"type": "noul", "instructions": "Is it a greeting?"}}})
        assert r.status_code == 200
        assert r.json()["answers"]["q"]["type"] == "noul"


def test_not_ready_returns_503(fake):
    fake.status = "down"
    with client_for(fake) as c:
        time.sleep(0.1)
        h = c.get("/health").json()
        assert h["ok"] is False and h["status"] == "waiting_backend"
        r = c.post("/v1/classify", json={"messages": [{"id": 1, "text": "hi"}]})
        assert r.status_code == 503


def test_cors_extension_origin_allowed(fake):
    with client_for(fake) as c:
        wait_ready(c)
        pre = c.options("/v1/classify", headers={
            "Origin": EXT, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
            "Access-Control-Request-Private-Network": "true",
        })
        assert pre.status_code == 200
        assert pre.headers["access-control-allow-origin"] == EXT
        assert pre.headers.get("access-control-allow-private-network") == "true"
        r = c.post("/v1/classify", json={"messages": []}, headers={"Origin": EXT})
        assert r.status_code == 200
        assert r.headers["access-control-allow-origin"] == EXT
        r = c.get("/health", headers={"Origin": "moz-extension://0b0c6f0e-7a1b-4a4e-9d55-1c2a3b4c5d6e"})
        assert r.status_code == 200
        assert c.get("/health", headers={"Origin": "http://localhost:5173"}).status_code == 200


def test_cors_web_origin_blocked(fake):
    with client_for(fake) as c:
        wait_ready(c)
        pre = c.options("/v1/classify", headers={
            "Origin": "https://evil.example", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Private-Network": "true",
        })
        assert pre.status_code == 400
        assert "access-control-allow-origin" not in pre.headers  # browser blocks it
        # "simple" cross-site POST (no preflight) must not reach the model
        r = c.post("/v1/classify", content=b'{"messages":[{"id":1,"text":"x"}]}',
                   headers={"Origin": "https://www.youtube.com", "Content-Type": "text/plain"})
        assert r.status_code == 403
        assert fake.calls == []
        # a fake extension id (wrong alphabet) is not an extension
        assert c.get("/health", headers={"Origin": "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}).status_code == 403


def test_extra_allowed_origin(fake):
    with client_for(fake, allow_origins=["https://dashboard.local"]) as c:
        wait_ready(c)
        assert c.get("/health", headers={"Origin": "https://dashboard.local"}).status_code == 200


def test_dns_rebinding_host_rejected(fake):
    with client_for(fake) as c:
        wait_ready(c)
        assert c.get("/health", headers={"Host": "attacker.example"}).status_code == 400
        assert c.get("/health", headers={"Host": "127.0.0.1:7377"}).status_code == 200
