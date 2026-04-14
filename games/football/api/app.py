"""
Football v2 — Flask broker.

The broker is a state machine, not a trainer. It holds the population in
SQLite, hands out matchups to browser clients, receives match results,
and triggers breeding when every brain has enough matches.

ALL simulation happens client-side (browser web workers). This process
runs ~2% of one CPU core at steady state and has no GPU dependency.

Endpoints:
  GET  /matchup           — next matchup: {type, p1: {id, weights}, p2}
  POST /results           — [{brain1, brain2, goals1, goals2, against_fallback}]
  GET  /showcase          — visual-match brains: {mode, p1, p2}
  GET  /stats             — population stats
  GET  /history           — fitness history
  GET  /config            — current tunables
  POST /config            — update tunables
  POST /reset             — wipe population, re-init from warm-start seed

All routes return JSON. 500 is returned only for unrecoverable errors;
expected states (e.g. "no matchup available yet") return 200 with a
status field.
"""
from __future__ import annotations

import json
import os
import random
import sqlite3
import sys
import threading
import time
from typing import Optional

import numpy as np
from flask import Flask, jsonify, request

HERE = os.path.dirname(os.path.abspath(__file__))
EVOLUTION = os.path.join(HERE, "..", "evolution")
sys.path.insert(0, EVOLUTION)

from ga import (  # noqa: E402
    FitnessWeights,
    WEIGHT_COUNT,
    breed_next_generation,
    compute_fitness,
    gaussian_mutate,
)

DB_PATH = os.path.join(EVOLUTION, "football.db")
SCHEMA_PATH = os.path.join(EVOLUTION, "schema.sql")
WARM_START_PATH = os.path.join(HERE, "..", "warm_start_weights.json")

# Matchup-type rotation: hand out 1 fallback match for every 3 pop matches
# so every brain gets MIN_FALLBACK_MATCHES fallback matches within about
# the same time as MIN_POP_MATCHES pop matches.
FALLBACK_MATCHUP_EVERY_N = 4

# Showcase rotation: 1 in 5 showcases is best-vs-fallback (see plan).
SHOWCASE_FALLBACK_EVERY_N = 5
SHOWCASE_RECENT_WINDOW = 20

# Blowout bonus threshold: margin above this counts as extra fitness.
BLOWOUT_MARGIN = 2

SURNAMES = [
    "Messi", "Ronaldo", "Neymar", "Mbappe", "Salah", "Bruyne", "Haaland",
    "Modric", "Kroos", "Benzema", "Lewandowski", "Iniesta", "Xavi", "Pele",
    "Maradona", "Zidane", "Beckham", "Figo", "Kaka", "Ronaldinho",
]


# ── Application state ─────────────────────────────────────────

app = Flask(__name__)
_lock = threading.RLock()
_state: dict = {}  # populated by _init_state()


def _init_state() -> None:
    """Initialize in-memory state from the DB. Must hold _lock."""
    conn = _db_connect()
    try:
        _ensure_schema(conn)
        _state["population"] = _load_population(conn)
        _state["generation"] = _current_generation(conn)
        _state["total_matches"] = _count_total_matches(conn)
        _state["config"] = _load_config(conn)
        _state["matchup_counter"] = 0
        _state["showcase_counter"] = 0

        if not _state["population"]:
            # First boot or post-reset — seed from warm-start
            _state["population"] = _init_population_from_warm_start(_state["config"])
            _state["generation"] = 1
            _save_population(conn, _state["generation"])
            conn.commit()
    finally:
        conn.close()


def _db_connect() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH)


def _ensure_schema(conn: sqlite3.Connection) -> None:
    with open(SCHEMA_PATH) as f:
        conn.executescript(f.read())


def _load_config(conn: sqlite3.Connection) -> dict:
    rows = conn.execute("SELECT key, value FROM config").fetchall()
    raw = {k: v for k, v in rows}
    return {
        "population_size": int(raw.get("population_size", 50)),
        "min_pop_matches": int(raw.get("min_pop_matches", 10)),
        "min_fallback_matches": int(raw.get("min_fallback_matches", 5)),
        "mutation_rate": float(raw.get("mutation_rate", 0.1)),
        "mutation_std": float(raw.get("mutation_std", 0.1)),
        "mutation_decay": float(raw.get("mutation_decay", 0.995)),
        "tournament_k": int(raw.get("tournament_k", 5)),
        "elitism": int(raw.get("elitism", 5)),
        "random_injection_rate": float(raw.get("random_injection_rate", 0.06)),
        "match_duration_ms": int(raw.get("match_duration_ms", 30000)),
        "fitness_w_pop": float(raw.get("fitness_w_pop", 0.4)),
        "fitness_w_fallback": float(raw.get("fitness_w_fallback", 0.6)),
        "fitness_max_goal_diff": float(raw.get("fitness_max_goal_diff", 3.0)),
    }


def _current_generation(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT MAX(generation) FROM brains").fetchone()
    return row[0] if row and row[0] is not None else 0


def _count_total_matches(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(pop_matches + fallback_matches), 0) FROM brains"
    ).fetchone()
    return int(row[0]) if row else 0


def _load_population(conn: sqlite3.Connection) -> list[dict]:
    max_gen = _current_generation(conn)
    if max_gen == 0:
        return []
    rows = conn.execute(
        """
        SELECT id, name, weights, pop_matches, pop_goal_diff, blowout_bonus,
               fallback_matches, fallback_wins, fallback_draws, fallback_losses,
               fitness, is_frozen_seed
        FROM brains
        WHERE generation = ?
        ORDER BY id
        """,
        (max_gen,),
    ).fetchall()
    return [
        {
            "id": row[0],
            "name": row[1],
            "weights": np.array(json.loads(row[2]), dtype=np.float64),
            "pop_matches": row[3],
            "pop_goal_diff": row[4],
            "blowout_bonus": row[5],
            "fallback_matches": row[6],
            "fallback_wins": row[7],
            "fallback_draws": row[8],
            "fallback_losses": row[9],
            "fitness": row[10],
            "is_frozen_seed": bool(row[11]),
        }
        for row in rows
    ]


def _save_population(conn: sqlite3.Connection, generation: int) -> None:
    conn.execute("DELETE FROM brains WHERE generation = ?", (generation,))
    for b in _state["population"]:
        conn.execute(
            """
            INSERT INTO brains (
                id, generation, name, weights,
                pop_matches, pop_goal_diff, blowout_bonus,
                fallback_matches, fallback_wins, fallback_draws, fallback_losses,
                fitness, is_frozen_seed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                b["id"], generation, b["name"], json.dumps(b["weights"].tolist()),
                b["pop_matches"], b["pop_goal_diff"], b["blowout_bonus"],
                b["fallback_matches"], b["fallback_wins"], b["fallback_draws"], b["fallback_losses"],
                b["fitness"], int(b.get("is_frozen_seed", False)),
            ),
        )


def _init_population_from_warm_start(config: dict) -> list[dict]:
    """Load the warm-start seed and create a fresh population. Brain #0 is
    the frozen seed; brains #1..N-1 are mutated copies."""
    with open(WARM_START_PATH) as f:
        seed_weights = np.array(json.load(f), dtype=np.float64)

    rng = random.Random()
    population: list[dict] = []
    population.append(_new_brain(0, seed_weights, is_frozen_seed=True))
    for i in range(1, config["population_size"]):
        mutated = gaussian_mutate(seed_weights, rate=0.3, std=0.1, rng=rng)
        population.append(_new_brain(i, mutated, is_frozen_seed=False))
    return population


def _new_brain(brain_id: int, weights: np.ndarray, is_frozen_seed: bool = False) -> dict:
    return {
        "id": brain_id,
        "name": random.choice(SURNAMES),
        "weights": weights,
        "pop_matches": 0,
        "pop_goal_diff": 0.0,
        "blowout_bonus": 0.0,
        "fallback_matches": 0,
        "fallback_wins": 0,
        "fallback_draws": 0,
        "fallback_losses": 0,
        "fitness": 0.0,
        "is_frozen_seed": is_frozen_seed,
    }


# ── Fitness / breeding ─────────────────────────────────────────

def _fitness_weights_from_config(config: dict) -> FitnessWeights:
    return FitnessWeights(
        w_pop=config["fitness_w_pop"],
        w_fallback=config["fitness_w_fallback"],
        max_goal_diff=config["fitness_max_goal_diff"],
    )


def _recompute_all_fitness(population: list[dict], weights: FitnessWeights) -> None:
    for b in population:
        b["fitness"] = compute_fitness(b, weights)


def _all_brains_ready_to_breed(population: list[dict], config: dict) -> bool:
    return all(
        b["pop_matches"] >= config["min_pop_matches"]
        and b["fallback_matches"] >= config["min_fallback_matches"]
        for b in population
    )


def _try_breed(conn: sqlite3.Connection) -> bool:
    config = _state["config"]
    population = _state["population"]
    if not _all_brains_ready_to_breed(population, config):
        return False

    weights = _fitness_weights_from_config(config)
    _recompute_all_fitness(population, weights)

    # Record the generation stats
    avg_fitness = sum(b["fitness"] for b in population) / len(population)
    top_fitness = max(b["fitness"] for b in population)
    conn.execute(
        "INSERT OR REPLACE INTO generations (gen, avg_fitness, top_fitness, total_matches) "
        "VALUES (?, ?, ?, ?)",
        (_state["generation"], avg_fitness, top_fitness, _state["total_matches"]),
    )

    # Breed
    rng = random.Random()
    new_pop = breed_next_generation(
        population,
        size=config["population_size"],
        elitism=config["elitism"],
        tournament_k=config["tournament_k"],
        mutation_rate=config["mutation_rate"],
        mutation_std=config["mutation_std"],
        random_injection_rate=config["random_injection_rate"],
        rng=rng,
    )

    # Preserve the frozen seed at index 0
    seed_brain = next(b for b in population if b.get("is_frozen_seed"))
    new_pop[0] = _new_brain(0, seed_brain["weights"].copy(), is_frozen_seed=True)
    for i, b in enumerate(new_pop):
        b["id"] = i
        b["name"] = random.choice(SURNAMES)

    _state["population"] = new_pop
    _state["generation"] += 1
    _save_population(conn, _state["generation"])
    return True


# ── Matchup selection ─────────────────────────────────────────

def _needs_more_fallback(brain: dict, config: dict) -> bool:
    return brain["fallback_matches"] < config["min_fallback_matches"]


def _pick_matchup(config: dict) -> dict:
    population = _state["population"]
    rng = random.Random()
    _state["matchup_counter"] += 1

    # Every Nth matchup is a fallback anchor match IF any brain needs one
    if _state["matchup_counter"] % FALLBACK_MATCHUP_EVERY_N == 0:
        candidates = [b for b in population if _needs_more_fallback(b, config)]
        if candidates:
            brain = rng.choice(candidates)
            return {
                "type": "fallback",
                "p1": _brain_view(brain),
                "p2": None,
            }

    # Otherwise pick a random pair of brains for a pop match
    # Prefer brains with fewer pop matches to equalize counts
    pop_with_few = [b for b in population if b["pop_matches"] < config["min_pop_matches"]]
    pool = pop_with_few if pop_with_few else population
    if len(pool) < 2:
        # Degenerate case — fall back to full population
        pool = population
    a = rng.choice(pool)
    b = rng.choice(pool)
    attempts = 0
    while b["id"] == a["id"] and attempts < 5:
        b = rng.choice(pool)
        attempts += 1
    return {
        "type": "pop",
        "p1": _brain_view(a),
        "p2": _brain_view(b),
    }


def _brain_view(brain: dict) -> dict:
    """Serialize a brain for the matchup/showcase response."""
    return {
        "id": brain["id"],
        "name": brain["name"],
        "weights": brain["weights"].tolist(),
    }


# ── Showcase selection ───────────────────────────────────────

def _pick_showcase() -> dict:
    population = _state["population"]
    _state["showcase_counter"] += 1
    rng = random.Random()

    if _state["showcase_counter"] % SHOWCASE_FALLBACK_EVERY_N == 0:
        # Best brain vs fallback
        best = max(population, key=lambda b: b["fitness"])
        return {
            "mode": "vs_fallback",
            "p1": _brain_view(best),
            "p2": None,
        }

    # Random pair (not the frozen seed repeatedly) — use the SHOWCASE_RECENT_WINDOW
    # as a guide, but for now the current population IS the most recent.
    a = rng.choice(population)
    b = rng.choice(population)
    attempts = 0
    while b["id"] == a["id"] and attempts < 5:
        b = rng.choice(population)
        attempts += 1
    return {
        "mode": "recent",
        "p1": _brain_view(a),
        "p2": _brain_view(b),
    }


# ── Result recording ──────────────────────────────────────────

def _record_result(result: dict) -> None:
    """Update in-memory brain stats for one match result.

    Result shape:
      {
        "p1_id": int,
        "p2_id": int | null,   // null = fallback
        "goals_p1": int,
        "goals_p2": int,
      }
    """
    population = _state["population"]
    by_id = {b["id"]: b for b in population}

    p1 = by_id.get(result["p1_id"])
    if p1 is None:
        # Stale result from a previous generation — silently drop
        return

    goals_p1 = int(result["goals_p1"])
    goals_p2 = int(result["goals_p2"])
    diff = goals_p1 - goals_p2

    if result.get("p2_id") is None:
        # Fallback-anchor match
        p1["fallback_matches"] += 1
        if goals_p1 > goals_p2:
            p1["fallback_wins"] += 1
        elif goals_p1 == goals_p2:
            p1["fallback_draws"] += 1
        else:
            p1["fallback_losses"] += 1
    else:
        p2 = by_id.get(result["p2_id"])
        if p2 is None:
            return
        p1["pop_matches"] += 1
        p1["pop_goal_diff"] += diff
        if diff >= BLOWOUT_MARGIN + 1:
            p1["blowout_bonus"] += diff - BLOWOUT_MARGIN
        p2["pop_matches"] += 1
        p2["pop_goal_diff"] += -diff
        if -diff >= BLOWOUT_MARGIN + 1:
            p2["blowout_bonus"] += -diff - BLOWOUT_MARGIN

    _state["total_matches"] += 1


# ── Routes ───────────────────────────────────────────────────

@app.route("/matchup", methods=["GET"])
def route_matchup():
    with _lock:
        matchup = _pick_matchup(_state["config"])
    return jsonify(matchup)


@app.route("/results", methods=["POST"])
def route_results():
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "expected JSON body"}), 400
    results = data if isinstance(data, list) else [data]
    with _lock:
        for r in results:
            _record_result(r)
        conn = _db_connect()
        try:
            bred = _try_breed(conn)
            conn.commit()
        finally:
            conn.close()
    return jsonify({"recorded": len(results), "bred": bred})


@app.route("/showcase", methods=["GET"])
def route_showcase():
    with _lock:
        showcase = _pick_showcase()
    return jsonify(showcase)


@app.route("/stats", methods=["GET"])
def route_stats():
    with _lock:
        pop = _state["population"]
        weights = _fitness_weights_from_config(_state["config"])
        _recompute_all_fitness(pop, weights)
        avg = sum(b["fitness"] for b in pop) / max(1, len(pop))
        top = max((b["fitness"] for b in pop), default=0.0)
        fb_wins = sum(b["fallback_wins"] for b in pop)
        fb_matches = sum(b["fallback_matches"] for b in pop)
        return jsonify({
            "generation": _state["generation"],
            "population": len(pop),
            "avg_fitness": avg,
            "top_fitness": top,
            "total_matches": _state["total_matches"],
            "fallback_win_rate": fb_wins / max(1, fb_matches),
        })


@app.route("/history", methods=["GET"])
def route_history():
    with _lock:
        conn = _db_connect()
        try:
            rows = conn.execute(
                "SELECT gen, avg_fitness, top_fitness, total_matches "
                "FROM generations ORDER BY gen DESC LIMIT 100"
            ).fetchall()
        finally:
            conn.close()
    return jsonify([
        {"gen": r[0], "avg": r[1], "top": r[2], "total_matches": r[3]}
        for r in rows
    ])


@app.route("/config", methods=["GET"])
def route_config_get():
    with _lock:
        return jsonify(_state["config"])


@app.route("/config", methods=["POST"])
def route_config_post():
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "expected JSON body"}), 400
    with _lock:
        conn = _db_connect()
        try:
            for k, v in data.items():
                if k in _state["config"]:
                    _state["config"][k] = type(_state["config"][k])(v)
                    conn.execute(
                        "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
                        (k, str(v)),
                    )
            conn.commit()
        finally:
            conn.close()
        return jsonify(_state["config"])


@app.route("/reset", methods=["POST"])
def route_reset():
    with _lock:
        conn = _db_connect()
        try:
            conn.execute("DELETE FROM brains")
            conn.execute("DELETE FROM generations")
            conn.commit()
        finally:
            conn.close()
        _init_state()
    return jsonify({"ok": True, "generation": _state["generation"]})


# ── Entry point ──────────────────────────────────────────────

def create_app(db_path: Optional[str] = None) -> Flask:
    """Factory for tests — allows overriding the DB path before init."""
    global DB_PATH
    if db_path is not None:
        DB_PATH = db_path
    with _lock:
        _init_state()
    return app


if __name__ == "__main__":
    with _lock:
        _init_state()
    app.run(host="127.0.0.1", port=5099, threaded=True)
