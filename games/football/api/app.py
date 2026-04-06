"""Football evolution API server.

Endpoints:
  GET  /api/football/matchup?count=N  — get N brain pairs to play
  POST /api/football/result           — report match outcome
  GET  /api/football/best             — get best brain weights
  GET  /api/football/stats            — evolution statistics
"""

import base64
import random
import sqlite3
import sys
from pathlib import Path

from flask import Flask, g, jsonify, request

# Add evolution module to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "evolution"))
from ga import (
    POPULATION_SIZE,
    TOTAL_WEIGHTS,
    breed_next_generation,
    random_weights,
    should_breed,
)

app = Flask(__name__)

DB_PATH = Path(__file__).resolve().parent.parent / "evolution" / "football.db"
SCHEMA_PATH = Path(__file__).resolve().parent.parent / "evolution" / "schema.sql"


def get_db():
    """Get or create a database connection for the current request."""
    if "db" not in g:
        g.db = sqlite3.connect(str(DB_PATH))
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA busy_timeout=5000")
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    """Initialize the database schema."""
    db = sqlite3.connect(str(DB_PATH))
    with open(SCHEMA_PATH) as f:
        db.executescript(f.read())
    db.close()


# Always init schema on import (safe — uses IF NOT EXISTS)
init_db()


def ensure_generation_zero(db):
    """Create generation 0 with random brains if no generations exist.

    Uses a transaction to prevent duplicate generation 0 from concurrent requests.
    """
    row = db.execute("SELECT COUNT(*) as c FROM generations").fetchone()
    if row["c"] > 0:
        return
    try:
        db.execute("BEGIN IMMEDIATE")
        # Re-check inside the write lock
        row = db.execute("SELECT COUNT(*) as c FROM generations").fetchone()
        if row["c"] > 0:
            db.execute("ROLLBACK")
            return
        db.execute("INSERT INTO generations DEFAULT VALUES")
        gen_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        for _ in range(POPULATION_SIZE):
            db.execute(
                "INSERT INTO brains (generation_id, weights) VALUES (?, ?)",
                (gen_id, random_weights()),
            )
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise


def current_generation(db):
    """Get the current (latest) generation ID."""
    row = db.execute("SELECT MAX(id) as id FROM generations").fetchone()
    return row["id"]


def get_brains_for_gen(db, gen_id):
    """Get all brains for a generation."""
    return db.execute(
        "SELECT id, weights, fitness, matches_played, goals_scored, goals_conceded "
        "FROM brains WHERE generation_id = ?",
        (gen_id,),
    ).fetchall()


def try_breed(db, gen_id):
    """Check if breeding should happen and do it if so.

    Uses BEGIN IMMEDIATE to prevent concurrent breeding from multiple requests.
    """
    try:
        db.execute("BEGIN IMMEDIATE")
        brains = get_brains_for_gen(db, gen_id)
        brain_dicts = [
            {"weights": b["weights"], "fitness": b["fitness"], "matches_played": b["matches_played"]}
            for b in brains
        ]
        if not should_breed(brain_dicts):
            db.execute("ROLLBACK")
            return

        # Check if a newer generation already exists (another request already bred)
        latest = db.execute("SELECT MAX(id) as id FROM generations").fetchone()["id"]
        if latest and latest > gen_id:
            db.execute("ROLLBACK")
            return

        new_weights = breed_next_generation(brain_dicts)
        db.execute("INSERT INTO generations DEFAULT VALUES")
        new_gen_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        for w in new_weights:
            db.execute(
                "INSERT INTO brains (generation_id, weights) VALUES (?, ?)",
                (new_gen_id, w),
            )
        db.execute("COMMIT")
        # Clean up old data after successful breeding
        _cleanup_old_data(db, new_gen_id)
    except Exception:
        db.execute("ROLLBACK")
        raise


KEEP_GENERATIONS = 5  # keep brains/matches for the last N generations


def _cleanup_old_data(db, current_gen_id):
    """Delete old brain weights and match rows to keep DB size bounded.

    Keeps the last KEEP_GENERATIONS worth of data. Older generations
    and their brains/matches are deleted. Runs outside a transaction
    so it doesn't block training.
    """
    cutoff = current_gen_id - KEEP_GENERATIONS
    if cutoff <= 0:
        return
    db.execute("DELETE FROM matches WHERE generation_id < ?", (cutoff,))
    db.execute("DELETE FROM brains WHERE generation_id < ?", (cutoff,))
    db.execute("DELETE FROM generations WHERE id < ?", (cutoff,))
    db.commit()


def weights_to_b64(blob):
    """Encode weight bytes as base64 string for JSON transport."""
    return base64.b64encode(blob).decode("ascii")


def b64_to_weights(s):
    """Decode base64 string to weight bytes."""
    return base64.b64decode(s)


# ── Endpoints ──────────────────────────────────────────────


@app.route("/api/football/matchup")
def matchup():
    """Get brain pairs to play. ?count=N, ?known=id1,id2,... to skip weights."""
    count = min(int(request.args.get("count", 5)), 100)
    db = get_db()
    ensure_generation_zero(db)

    gen_id = current_generation(db)
    brains = get_brains_for_gen(db, gen_id)

    if len(brains) < 2:
        return jsonify({"error": "Not enough brains"}), 500

    # Parse known brain IDs — worker already has these weights cached
    known_str = request.args.get("known", "")
    known_ids = set()
    if known_str:
        try:
            known_ids = {int(x) for x in known_str.split(",") if x}
        except ValueError:
            pass

    pairs = []
    brain_list = list(brains)
    # Pre-encode weights only for brains the worker doesn't have
    weight_cache = {}
    for _ in range(count):
        a, b = random.sample(brain_list, 2)
        for brain in (a, b):
            bid = brain["id"]
            if bid not in weight_cache:
                weight_cache[bid] = None if bid in known_ids else weights_to_b64(brain["weights"])
        pairs.append({
            "brain_a": {"id": a["id"], "weights": weight_cache[a["id"]]},
            "brain_b": {"id": b["id"], "weights": weight_cache[b["id"]]},
            "generation_id": gen_id,
        })

    return jsonify({"pairs": pairs, "generation_id": gen_id})


SHAPING_WEIGHT = 0.1  # scale factor for shaping vs goals


def compute_shaped_fitness(goals_scored, goals_conceded, matches_played, shaping_score):
    """Combine goal differential with shaping signals.

    Goals are the primary signal (weighted heavily), shaping provides
    gradient for brains that haven't scored yet.
    """
    if matches_played == 0:
        return 0
    goal_fitness = (goals_scored - goals_conceded) / matches_played
    shaping_avg = shaping_score / matches_played
    return goal_fitness + shaping_avg * SHAPING_WEIGHT


def calc_shaping_score(fitness_data):
    """Calculate a single shaping score from per-match fitness metrics.

    Rewards good football decisions, penalizes bad ones.
    All signals are normalized so no single one dominates.
    """
    if not fitness_data or fitness_data.get("ticks", 0) == 0:
        return 0
    ticks = fitness_data["ticks"]

    # === REWARDS ===

    # Ball proximity: average closeness to ball (0–1 per tick), scaled up
    proximity = fitness_data.get("ballProximity", 0) / ticks * 8

    # Kicks: reward each kick, bonus for kicks toward goal
    kicks = fitness_data.get("kicks", 0) * 0.3
    goal_kicks = fitness_data.get("goalKicks", 0) * 0.7  # extra for right direction

    # Ball advance: moving ball toward opponent goal (normalized by field)
    advance = fitness_data.get("ballAdvance", 0) / 100

    # Possession: fraction of time closer to ball than opponent
    possession = fitness_data.get("possession", 0) / ticks * 5

    # Stamina management: average stamina level (reward staying healthy)
    avg_stamina = fitness_data.get("staminaSum", 0) / ticks * 3

    # === PENALTIES ===

    # Exhaustion: fraction of time spent frozen (capped to not dominate rewards)
    exhausted_frac = fitness_data.get("exhaustedTicks", 0) / ticks
    exhaustion_penalty = min(exhausted_frac * 5, 4)

    # Getting pushed: each push received is a small penalty
    pushed_penalty = min(fitness_data.get("pushedReceived", 0) * 0.15, 2)

    score = (
        proximity
        + kicks
        + goal_kicks
        + advance
        + possession
        + avg_stamina
        - exhaustion_penalty
        - pushed_penalty
    )
    return score


@app.route("/api/football/result", methods=["POST"])
def result():
    """Report a match result."""
    data = request.get_json()
    brain_a_id = data["brain_a_id"]
    brain_b_id = data["brain_b_id"]
    score_a = data["score_a"]
    score_b = data["score_b"]
    fitness_a = data.get("fitness_a")
    fitness_b = data.get("fitness_b")
    gen_id = data.get("generation_id")

    shaping_a = calc_shaping_score(fitness_a)
    shaping_b = calc_shaping_score(fitness_b)

    db = get_db()
    cur_gen = current_generation(db)

    # Store the match regardless of generation
    db.execute(
        "INSERT INTO matches (generation_id, brain_a_id, brain_b_id, score_a, score_b) "
        "VALUES (?, ?, ?, ?, ?)",
        (gen_id or cur_gen, brain_a_id, brain_b_id, score_a, score_b),
    )

    # Single UPDATE per brain: update stats + recompute fitness inline
    for bid, gs, gc, shaping in [
        (brain_a_id, score_a, score_b, shaping_a),
        (brain_b_id, score_b, score_a, shaping_b),
    ]:
        db.execute(
            "UPDATE brains SET "
            "matches_played = matches_played + 1, "
            "goals_scored = goals_scored + ?, "
            "goals_conceded = goals_conceded + ?, "
            "shaping_total = shaping_total + ?, "
            "fitness = CAST((goals_scored + ?) - (goals_conceded + ?) AS REAL) "
            "  / (matches_played + 1) "
            "  + (shaping_total + ?) / (matches_played + 1) * ? "
            "WHERE id = ?",
            (gs, gc, shaping, gs, gc, shaping, SHAPING_WEIGHT, bid),
        )

    db.commit()

    # Only try breeding if result is for the current generation
    if gen_id is None or gen_id == cur_gen:
        try_breed(db, cur_gen)

    return jsonify({"ok": True})


@app.route("/api/football/results", methods=["POST"])
def results_batch():
    """Report multiple match results in one request."""
    data = request.get_json()
    items = data.get("results", [])
    if not items:
        return jsonify({"ok": True})

    db = get_db()
    cur_gen = current_generation(db)

    # Pre-compute all SQL params in Python, then batch execute
    match_rows = []
    brain_updates = []

    for item in items:
        brain_a_id = item["brain_a_id"]
        brain_b_id = item["brain_b_id"]
        score_a = item["score_a"]
        score_b = item["score_b"]
        gen_id = item.get("generation_id")
        shaping_a = calc_shaping_score(item.get("fitness_a"))
        shaping_b = calc_shaping_score(item.get("fitness_b"))

        match_rows.append((gen_id or cur_gen, brain_a_id, brain_b_id, score_a, score_b))

        for bid, gs, gc, shaping in [
            (brain_a_id, score_a, score_b, shaping_a),
            (brain_b_id, score_b, score_a, shaping_b),
        ]:
            brain_updates.append((gs, gc, shaping, gs, gc, shaping, SHAPING_WEIGHT, bid))

    # Update running totals
    total_goals = sum(r[3] + r[4] for r in match_rows)  # score_a + score_b
    db.execute(
        "UPDATE stats SET value = value + ? WHERE key = 'total_matches'",
        (len(match_rows),),
    )
    db.execute(
        "UPDATE stats SET value = value + ? WHERE key = 'total_goals'",
        (total_goals,),
    )

    db.executemany(
        "INSERT INTO matches (generation_id, brain_a_id, brain_b_id, score_a, score_b) "
        "VALUES (?, ?, ?, ?, ?)",
        match_rows,
    )
    db.executemany(
        "UPDATE brains SET "
        "matches_played = matches_played + 1, "
        "goals_scored = goals_scored + ?, "
        "goals_conceded = goals_conceded + ?, "
        "shaping_total = shaping_total + ?, "
        "fitness = CAST((goals_scored + ?) - (goals_conceded + ?) AS REAL) "
        "  / (matches_played + 1) "
        "  + (shaping_total + ?) / (matches_played + 1) * ? "
        "WHERE id = ?",
        brain_updates,
    )
    db.commit()

    # Try breeding once after all results processed
    try_breed(db, cur_gen)

    return jsonify({"ok": True, "processed": len(items)})


@app.route("/api/football/best")
def best():
    """Get the best brain from the current generation."""
    db = get_db()
    ensure_generation_zero(db)

    gen_id = current_generation(db)
    row = db.execute(
        "SELECT id, weights, fitness, matches_played FROM brains "
        "WHERE generation_id = ? ORDER BY fitness DESC LIMIT 1",
        (gen_id,),
    ).fetchone()

    if not row or row["matches_played"] == 0:
        return jsonify({"weights": None, "generation_id": gen_id, "brewing": True})

    return jsonify({
        "id": row["id"],
        "weights": weights_to_b64(row["weights"]),
        "fitness": row["fitness"],
        "generation_id": gen_id,
        "brewing": False,
    })


@app.route("/api/football/stats")
def stats():
    """Evolution statistics."""
    db = get_db()
    ensure_generation_zero(db)

    gen_id = current_generation(db)

    # Top fitness in current gen
    top = db.execute(
        "SELECT MAX(fitness) as f FROM brains WHERE generation_id = ?", (gen_id,)
    ).fetchone()

    # Running totals (survive cleanup of old data)
    total_matches = db.execute(
        "SELECT value FROM stats WHERE key = 'total_matches'"
    ).fetchone()
    total_goals = db.execute(
        "SELECT value FROM stats WHERE key = 'total_goals'"
    ).fetchone()
    tm = int(total_matches["value"]) if total_matches else 0
    tg = total_goals["value"] if total_goals else 0
    avg_goals = round(tg / tm, 1) if tm > 0 else 0

    # Population info
    pop = db.execute(
        "SELECT COUNT(*) as c, MIN(matches_played) as min_matches "
        "FROM brains WHERE generation_id = ?",
        (gen_id,),
    ).fetchone()

    return jsonify({
        "generation": gen_id,
        "population": pop["c"],
        "top_fitness": round(top["f"] or 0, 2),
        "total_matches": tm,
        "avg_goals": avg_goals,
        "min_matches_current_gen": pop["min_matches"] or 0,
    })


@app.route("/api/football/reset", methods=["POST"])
def reset():
    """Wipe all evolution data and start fresh with generation 0."""
    db = get_db()
    db.execute("DELETE FROM matches")
    db.execute("DELETE FROM brains")
    db.execute("DELETE FROM generations")
    db.execute("UPDATE stats SET value = 0")
    db.execute("DELETE FROM sqlite_sequence")
    db.commit()
    ensure_generation_zero(db)
    return jsonify({"ok": True, "message": "Evolution reset"})


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5050, threaded=True)
