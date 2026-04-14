"""
Phase 3 smoke test for the Flask broker.

Starts the app with an in-memory-adjacent temporary DB, hits each endpoint
with the Flask test client, and verifies the response shapes and the
breeding trigger behavior.

This is not a full end-to-end test — real training happens in
local_test.py and (eventually) in the browser workers. This test just
proves the HTTP surface works and state transitions correctly.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import app as broker  # noqa: E402


@pytest.fixture
def client(tmp_path):
    db_path = str(tmp_path / "football.db")
    flask_app = broker.create_app(db_path=db_path)
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as c:
        yield c


def test_stats_after_init(client):
    resp = client.get("/stats")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["generation"] == 1
    assert data["population"] == 50
    assert 0 <= data["avg_fitness"] <= 1
    assert 0 <= data["top_fitness"] <= 1
    assert data["total_matches"] == 0


def test_config_get_has_expected_keys(client):
    resp = client.get("/config")
    data = resp.get_json()
    assert "population_size" in data
    assert "fitness_w_pop" in data
    assert "fitness_w_fallback" in data
    assert "fitness_max_goal_diff" in data
    assert data["fitness_w_pop"] + data["fitness_w_fallback"] == pytest.approx(1.0)


def test_config_post_updates_state(client):
    resp = client.post("/config", json={"mutation_rate": 0.15})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["mutation_rate"] == 0.15
    assert client.get("/config").get_json()["mutation_rate"] == 0.15


def test_matchup_returns_valid_shape(client):
    resp = client.get("/matchup")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["type"] in ("pop", "fallback")
    assert data["p1"] is not None
    assert "id" in data["p1"]
    assert "name" in data["p1"]
    assert "weights" in data["p1"]
    assert len(data["p1"]["weights"]) == 1193
    if data["type"] == "pop":
        assert data["p2"] is not None
        assert data["p1"]["id"] != data["p2"]["id"]
    else:
        assert data["p2"] is None


def test_showcase_returns_valid_shape(client):
    resp = client.get("/showcase")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["mode"] in ("recent", "vs_fallback")
    assert data["p1"] is not None
    if data["mode"] == "vs_fallback":
        assert data["p2"] is None
    else:
        assert data["p2"] is not None


def test_showcase_rotation_hits_fallback_mode_within_5_calls(client):
    """4:1 rotation — fallback mode should appear at least once per 5 calls."""
    modes = [client.get("/showcase").get_json()["mode"] for _ in range(10)]
    assert "vs_fallback" in modes
    assert "recent" in modes


def test_results_post_updates_stats(client):
    # Get a matchup, simulate a result
    matchup = client.get("/matchup").get_json()
    if matchup["type"] == "fallback":
        result = {
            "p1_id": matchup["p1"]["id"],
            "p2_id": None,
            "goals_p1": 2,
            "goals_p2": 0,
        }
    else:
        result = {
            "p1_id": matchup["p1"]["id"],
            "p2_id": matchup["p2"]["id"],
            "goals_p1": 3,
            "goals_p2": 1,
        }
    resp = client.post("/results", json=result)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["recorded"] == 1
    assert data["bred"] is False  # single result won't trigger breeding

    stats = client.get("/stats").get_json()
    assert stats["total_matches"] == 1


def test_reset_reinitializes_population(client):
    # Submit a bunch of results to mutate state
    for _ in range(10):
        matchup = client.get("/matchup").get_json()
        result = {
            "p1_id": matchup["p1"]["id"],
            "p2_id": matchup["p2"]["id"] if matchup["p2"] else None,
            "goals_p1": 1,
            "goals_p2": 1,
        }
        client.post("/results", json=result)

    pre_reset_matches = client.get("/stats").get_json()["total_matches"]
    assert pre_reset_matches == 10

    resp = client.post("/reset")
    assert resp.status_code == 200
    assert resp.get_json()["ok"] is True

    stats = client.get("/stats").get_json()
    assert stats["total_matches"] == 0
    assert stats["population"] == 50


def test_history_empty_initially(client):
    resp = client.get("/history")
    assert resp.status_code == 200
    assert resp.get_json() == []
