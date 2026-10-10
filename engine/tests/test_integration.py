"""Against a real llama-server running Clef-Flash (default http://127.0.0.1:7378, override with
HUSH_TEST_BACKEND). Skipped when nothing answers there."""

from __future__ import annotations

import os
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from hush_engine import schema as S
from hush_engine.app import Engine, EngineConfig, create_app
from hush_engine.backend import LlamaBackend

URL = os.environ.get("HUSH_TEST_BACKEND", "http://127.0.0.1:7378")


def _up() -> bool:
    try:
        return httpx.get(URL + "/health", timeout=2, trust_env=False).status_code == 200
    except httpx.HTTPError:
        return False


pytestmark = [pytest.mark.integration, pytest.mark.skipif(not _up(), reason=f"no llama-server at {URL}")]


@pytest.fixture(scope="module")
def client():
    cfg = EngineConfig(mode="attach", backend_url=URL, trusted_hosts=["testserver"], default_deadline_ms=0)
    with TestClient(create_app(Engine(cfg, LlamaBackend(URL)))) as c:
        t0 = time.monotonic()
        while not c.get("/health").json()["ok"] and time.monotonic() - t0 < 30:
            time.sleep(0.2)
        yield c


def test_health(client):
    h = client.get("/health").json()
    assert h["ok"] and "Clef" in h["decision_model"]
    assert h["limits"]["prompt_budget"] >= 512


def test_custom_filters_and_base(client):
    r = client.post("/v1/classify", json={
        "messages": [
            {"id": "bs", "text": "bro just jump on the left ledge, why are you going right??", "platform": "twitch"},
            {"id": "sp", "text": "lol wait till he finds out Malenia is Miquella's twin sister and the Elden Beast is the real final boss", "platform": "youtube"},
            {"id": "sc", "text": "check out my channel for free vbucks!! link in bio", "platform": "kick"},
        ],
        "filters": [
            {"id": "backseat", "question": "Is this message backseating the streamer's gameplay?"},
            {"id": "spoiler", "question": "Does it spoil the plot of Elden Ring?"},
        ],
        "base": True,
        "deadline_ms": 30000,
    })
    assert r.status_code == 200, r.text
    res = {x["id"]: x for x in r.json()["results"]}
    assert all("error" not in x for x in res.values()), res
    assert res["bs"]["filters"]["backseat"] > 0.5
    assert res["bs"]["filters"]["spoiler"] < 0.5
    assert res["sp"]["filters"]["spoiler"] > 0.5
    assert res["sc"]["filters"]["backseat"] < 0.5
    sc = res["sc"]["base"]
    assert max(("toxic", "spam", "scam", "noise", "question", "clean"), key=sc.get) == "scam"


def test_base_only_matches_teacher_exactly(client):
    """base=true without filters sends the teacher's exact prompt -> identical numbers."""
    text = "what game is this?"
    r = client.post("/v1/classify", json={"messages": [{"id": 1, "text": text, "platform": "twitch"}], "base": True, "deadline_ms": 30000})
    engine_scores = r.json()["results"][0]["base"]
    direct = httpx.post(URL + "/v1/systemone", timeout=60, trust_env=False, json={
        "model": "clef-flash", "state": f"Twitch live chat message: {text}", "questions": S.BASE_QUESTIONS}).json()
    assert engine_scores == S.base_scores(direct["answers"])


def test_systemone_passthrough(client):
    r = client.post("/v1/systemone", json={
        "model": "clef-flash", "state": "Twitch live chat message: hello chat!",
        "questions": {"greeting": {"type": "noul", "instructions": "Is this a greeting?"},
                      "level": {"type": "score", "instructions": "How excited is it?", "criteria": ["calm", "some", "very"]}},
    })
    assert r.status_code == 200, r.text
    a = r.json()["answers"]
    assert a["greeting"]["noul"] > 0.5
    assert a["level"]["type"] == "score"


def test_many_filters_split_transparently(client):
    filters = [{"id": f"t{i}", "question": f"Is this message about {topic}?"} for i, topic in enumerate(
        ["cooking", "football", "politics", "the weather", "music", "cars", "money", "anime", "school", "dogs", "the streamer's outfit", "a video game"])]
    r = client.post("/v1/classify", json={
        "messages": [{"id": 1, "text": "this boss fight is insane, the dodge timing is brutal", "platform": "twitch"}],
        "filters": filters, "base": True, "deadline_ms": 60000})
    res = r.json()["results"][0]
    assert "error" not in res, res
    assert len(res["filters"]) == 12
    assert res["filters"]["t11"] > 0.5  # video game
    assert res["filters"]["t0"] < 0.5  # cooking
