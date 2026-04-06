"""Football evolution API server.

Uses an in-memory SQLite DB for all hot-path operations (match results,
brain updates, breeding). Persistent data (config, stats, fitness_history)
is flushed to disk every 30 seconds. Population restarts on service restart.

Endpoints:
  GET  /api/football/matchup?count=N  — get N brain pairs to play
  POST /api/football/result           — report match outcome
  POST /api/football/results          — report batch of match outcomes
  GET  /api/football/best             — get best brain weights
  GET  /api/football/stats            — evolution statistics
  GET  /api/football/config           — get/set evolution config
  GET  /api/football/history          — fitness history for graphing
  POST /api/football/reset            — wipe all data and restart
"""

import base64
import random
import sqlite3
import sys
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, request

# Add evolution module to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "evolution"))
from ga import (
    POPULATION_SIZE,
    breed_next_generation,
    get_config,
    random_weights,
    should_breed,
)

app = Flask(__name__)

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "evolution" / "schema.sql"
PERSIST_PATH = Path(__file__).resolve().parent.parent / "evolution" / "football_persist.db"

# ── In-memory DB ─────────────────────────────────────────────

_mem_db = None
_db_lock = threading.Lock()


def get_db():
    """Return the shared in-memory DB connection."""
    return _mem_db


def _init_mem_db():
    """Initialize in-memory DB with schema and load persisted state."""
    global _mem_db
    _mem_db = sqlite3.connect(":memory:", check_same_thread=False)
    _mem_db.row_factory = sqlite3.Row
    _mem_db.execute("PRAGMA foreign_keys=ON")
    with open(SCHEMA_PATH) as f:
        _mem_db.executescript(f.read())
    _load_persisted_state()


def _init_persist_db():
    """Ensure the persist DB has the schema."""
    db = sqlite3.connect(str(PERSIST_PATH))
    with open(SCHEMA_PATH) as f:
        db.executescript(f.read())
    db.close()


def _load_persisted_state():
    """Load config, stats, fitness_history from disk if available."""
    if not PERSIST_PATH.exists():
        return
    try:
        disk = sqlite3.connect(str(PERSIST_PATH))
        disk.row_factory = sqlite3.Row
        for row in disk.execute("SELECT key, value FROM config").fetchall():
            _mem_db.execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
                (row["key"], row["value"]),
            )
        for row in disk.execute("SELECT key, value FROM stats").fetchall():
            _mem_db.execute(
                "UPDATE stats SET value = ? WHERE key = ?",
                (row["value"], row["key"]),
            )
        for row in disk.execute(
            "SELECT generation_id, top_fitness, avg_fitness FROM fitness_history"
        ).fetchall():
            _mem_db.execute(
                "INSERT OR IGNORE INTO fitness_history VALUES (?, ?, ?)",
                (row["generation_id"], row["top_fitness"], row["avg_fitness"]),
            )
        _mem_db.commit()
        disk.close()
    except Exception:
        pass  # persist DB might be corrupted — start fresh


def _flush_to_disk():
    """Background thread: periodically save persistent data to disk."""
    while True:
        time.sleep(30)
        try:
            with _db_lock:
                _do_flush()
        except Exception:
            pass  # best-effort


def _do_flush():
    """Copy config, stats, fitness_history from memory to disk."""
    _init_persist_db()
    disk = sqlite3.connect(str(PERSIST_PATH))
    # Config
    for row in _mem_db.execute("SELECT key, value FROM config").fetchall():
        disk.execute(
            "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
            (row["key"], row["value"]),
        )
    # Stats
    for row in _mem_db.execute("SELECT key, value FROM stats").fetchall():
        disk.execute(
            "INSERT OR REPLACE INTO stats (key, value) VALUES (?, ?)",
            (row["key"], row["value"]),
        )
    # Fitness history
    for row in _mem_db.execute(
        "SELECT generation_id, top_fitness, avg_fitness FROM fitness_history"
    ).fetchall():
        disk.execute(
            "INSERT OR IGNORE INTO fitness_history VALUES (?, ?, ?)",
            (row["generation_id"], row["top_fitness"], row["avg_fitness"]),
        )
    disk.commit()
    disk.close()


# Initialize at import time
_init_persist_db()
_init_mem_db()
threading.Thread(target=_flush_to_disk, daemon=True).start()


# ── Helper functions ─────────────────────────────────────────


def ensure_generation_zero(db):
    """Create generation 0 with random brains if no generations exist."""
    row = db.execute("SELECT COUNT(*) as c FROM generations").fetchone()
    if row["c"] > 0:
        return
    db.execute("INSERT INTO generations DEFAULT VALUES")
    gen_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    for _ in range(POPULATION_SIZE):
        db.execute(
            "INSERT INTO brains (generation_id, weights) VALUES (?, ?)",
            (gen_id, random_weights()),
        )
    db.commit()


def current_generation(db):
    """Get the current (latest) generation ID."""
    return db.execute("SELECT MAX(id) as id FROM generations").fetchone()["id"]


def get_brains_for_gen(db, gen_id):
    """Get all brains for a generation."""
    return db.execute(
        "SELECT id, weights, fitness, matches_played, goals_scored, goals_conceded "
        "FROM brains WHERE generation_id = ?",
        (gen_id,),
    ).fetchall()


def try_breed(db, gen_id):
    """Check if breeding should happen and do it if so."""
    brains = get_brains_for_gen(db, gen_id)
    brain_dicts = [
        {"weights": b["weights"], "fitness": b["fitness"], "matches_played": b["matches_played"]}
        for b in brains
    ]
    if not should_breed(brain_dicts):
        return

    # Check if a newer generation already exists
    latest = db.execute("SELECT MAX(id) as id FROM generations").fetchone()["id"]
    if latest and latest > gen_id:
        return

    # Record fitness history
    top_f = max(b["fitness"] for b in brain_dicts) if brain_dicts else 0
    avg_f = sum(b["fitness"] for b in brain_dicts) / len(brain_dicts) if brain_dicts else 0
    db.execute(
        "INSERT OR REPLACE INTO fitness_history (generation_id, top_fitness, avg_fitness) "
        "VALUES (?, ?, ?)",
        (gen_id, top_f, avg_f),
    )

    cfg = get_config(db)
    new_weights = breed_next_generation(brain_dicts, cfg)
    db.execute("INSERT INTO generations DEFAULT VALUES")
    new_gen_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    for w in new_weights:
        db.execute(
            "INSERT INTO brains (generation_id, weights) VALUES (?, ?)",
            (new_gen_id, w),
        )
    db.commit()

    _shrink_goal_size(db, gen_id)
    _cleanup_old_data(db, new_gen_id)


GOAL_SIZE_SHRINK = 0.02
GOAL_SIZE_MIN    = 1.0


def _shrink_goal_size(db, gen_id):
    """Shrink goal opening toward normal when brains score."""
    row = db.execute("SELECT value FROM config WHERE key = 'goal_size'").fetchone()
    size = row["value"] if row else 2.0
    if size <= GOAL_SIZE_MIN:
        return
    goals = db.execute(
        "SELECT SUM(score_a + score_b) as g FROM matches WHERE generation_id = ?",
        (gen_id,),
    ).fetchone()
    if goals and goals["g"] and goals["g"] > 0:
        new_size = max(GOAL_SIZE_MIN, size - GOAL_SIZE_SHRINK)
        db.execute(
            "INSERT OR REPLACE INTO config (key, value) VALUES ('goal_size', ?)",
            (new_size,),
        )
        db.commit()


KEEP_GENERATIONS = 5


def _cleanup_old_data(db, current_gen_id):
    """Delete old brain weights and match rows to keep memory bounded."""
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


# ── Fitness shaping ──────────────────────────────────────────

SHAPING_WEIGHT = 0.01  # scale factor for shaping vs goals (goals dominate)

# S_ = shaping reward/penalty coefficients
S_PROXIMITY      = 8
S_KICK           = 0.3
S_GOAL_KICK      = 0.7
S_ADVANCE        = 0.5
S_ADVANCE_CAP    = 5
S_ATTACK_ZONE    = 6
S_POSSESSION     = 5
S_NEAR_MISS      = 3.0
S_FRAME_HIT      = 1.0
S_STAMINA        = 3
S_PUSH_LANDED    = 0.2
S_EXHAUSTION     = 5
S_EXHAUSTION_CAP = 4
S_PUSHED         = 0.15
S_PUSHED_CAP     = 2


def calc_shaping_score(fitness_data):
    """Calculate a single shaping score from per-match fitness metrics."""
    if not fitness_data or fitness_data.get("ticks", 0) == 0:
        return 0
    ticks = fitness_data["ticks"]

    proximity = fitness_data.get("ballProximity", 0) / ticks * S_PROXIMITY
    kicks = fitness_data.get("kicks", 0) * S_KICK
    goal_kicks = fitness_data.get("goalKicks", 0) * S_GOAL_KICK
    advance = min(fitness_data.get("ballAdvance", 0) / ticks * S_ADVANCE, S_ADVANCE_CAP)
    attack_zone = fitness_data.get("ballInAttackZone", 0) / ticks * S_ATTACK_ZONE
    possession = fitness_data.get("possession", 0) / ticks * S_POSSESSION
    avg_stamina = fitness_data.get("staminaSum", 0) / ticks * S_STAMINA
    pushes = fitness_data.get("pushesLanded", 0) * S_PUSH_LANDED
    near_misses = fitness_data.get("nearMisses", 0) * S_NEAR_MISS
    frame_hits = fitness_data.get("frameHits", 0) * S_FRAME_HIT

    exhausted_frac = fitness_data.get("exhaustedTicks", 0) / ticks
    exhaustion_penalty = min(exhausted_frac * S_EXHAUSTION, S_EXHAUSTION_CAP)
    pushed_penalty = min(fitness_data.get("pushedReceived", 0) * S_PUSHED, S_PUSHED_CAP)

    return (
        proximity + kicks + goal_kicks + advance + attack_zone
        + possession + pushes + near_misses + frame_hits + avg_stamina
        - exhaustion_penalty - pushed_penalty
    )


# ── Endpoints ────────────────────────────────────────────────


@app.route("/api/football/matchup")
def matchup():
    """Get brain pairs to play. ?count=N, ?known=id1,id2,... to skip weights."""
    count = min(int(request.args.get("count", 5)), 100)
    with _db_lock:
        db = get_db()
        ensure_generation_zero(db)

        gen_id = current_generation(db)
        brains = get_brains_for_gen(db, gen_id)

    if len(brains) < 2:
        return jsonify({"error": "Not enough brains"}), 500

    known_str = request.args.get("known", "")
    known_ids = set()
    if known_str:
        try:
            known_ids = {int(x) for x in known_str.split(",") if x}
        except ValueError:
            pass

    pairs = []
    brain_list = list(brains)
    weight_cache = {}
    for _ in range(count):
        a = random.choice(brain_list)
        if a["id"] not in weight_cache:
            weight_cache[a["id"]] = None if a["id"] in known_ids else weights_to_b64(a["weights"])

        roll = random.random()
        if roll < 0.15:
            pairs.append({
                "brain_a": {"id": a["id"], "weights": weight_cache[a["id"]]},
                "brain_b": {"id": None, "weights": None, "type": "idle"},
                "generation_id": gen_id,
            })
        elif roll < 0.30:
            pairs.append({
                "brain_a": {"id": a["id"], "weights": weight_cache[a["id"]]},
                "brain_b": {"id": None, "weights": weights_to_b64(random_weights()), "type": "random"},
                "generation_id": gen_id,
            })
        else:
            b = random.choice(brain_list)
            while b["id"] == a["id"] and len(brain_list) > 1:
                b = random.choice(brain_list)
            if b["id"] not in weight_cache:
                weight_cache[b["id"]] = None if b["id"] in known_ids else weights_to_b64(b["weights"])
            pairs.append({
                "brain_a": {"id": a["id"], "weights": weight_cache[a["id"]]},
                "brain_b": {"id": b["id"], "weights": weight_cache[b["id"]], "type": "normal"},
                "generation_id": gen_id,
            })

    with _db_lock:
        db = get_db()
        md_row = db.execute("SELECT value FROM config WHERE key = 'match_duration'").fetchone()
        gs_row = db.execute("SELECT value FROM config WHERE key = 'goal_size'").fetchone()

    return jsonify({
        "pairs": pairs,
        "generation_id": gen_id,
        "match_duration": md_row["value"] if md_row else 45,
        "goal_size": gs_row["value"] if gs_row else 2.0,
    })


@app.route("/api/football/result", methods=["POST"])
def result():
    """Report a single match result."""
    data = request.get_json()
    brain_a_id = data["brain_a_id"]
    brain_b_id = data["brain_b_id"]
    score_a = data["score_a"]
    score_b = data["score_b"]
    gen_id = data.get("generation_id")
    shaping_a = calc_shaping_score(data.get("fitness_a"))
    shaping_b = calc_shaping_score(data.get("fitness_b"))

    with _db_lock:
        db = get_db()
        cur_gen = current_generation(db)
        db.execute(
            "INSERT INTO matches (generation_id, brain_a_id, brain_b_id, score_a, score_b) "
            "VALUES (?, ?, ?, ?, ?)",
            (gen_id or cur_gen, brain_a_id, brain_b_id, score_a, score_b),
        )
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

    with _db_lock:
        db = get_db()
        cur_gen = current_generation(db)

        match_rows = []
        brain_updates = []

        for item in items:
            brain_a_id = item["brain_a_id"]
            brain_b_id = item.get("brain_b_id")
            score_a = item["score_a"]
            score_b = item["score_b"]
            gen_id = item.get("generation_id")
            shaping_a = calc_shaping_score(item.get("fitness_a"))

            match_rows.append((gen_id or cur_gen, brain_a_id, brain_b_id or brain_a_id, score_a, score_b))
            brain_updates.append((score_a, score_b, shaping_a, score_a, score_b, shaping_a, SHAPING_WEIGHT, brain_a_id))

            if brain_b_id is not None and item.get("opponent_type", "normal") == "normal":
                shaping_b = calc_shaping_score(item.get("fitness_b"))
                brain_updates.append((score_b, score_a, shaping_b, score_b, score_a, shaping_b, SHAPING_WEIGHT, brain_b_id))

        total_goals = sum(r[3] + r[4] for r in match_rows)
        db.execute("UPDATE stats SET value = value + ? WHERE key = 'total_matches'", (len(match_rows),))
        db.execute("UPDATE stats SET value = value + ? WHERE key = 'total_goals'", (total_goals,))

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
        try_breed(db, cur_gen)

    return jsonify({"ok": True, "processed": len(items)})


@app.route("/api/football/best")
def best():
    """Get the best brain from the current generation."""
    with _db_lock:
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
    with _db_lock:
        db = get_db()
        ensure_generation_zero(db)
        gen_id = current_generation(db)

        top = db.execute(
            "SELECT MAX(fitness) as f FROM brains WHERE generation_id = ?", (gen_id,)
        ).fetchone()

        total_matches = db.execute(
            "SELECT value FROM stats WHERE key = 'total_matches'"
        ).fetchone()
        total_goals = db.execute(
            "SELECT value FROM stats WHERE key = 'total_goals'"
        ).fetchone()

        pop = db.execute(
            "SELECT COUNT(*) as c, MIN(matches_played) as min_matches "
            "FROM brains WHERE generation_id = ?",
            (gen_id,),
        ).fetchone()

    tm = int(total_matches["value"]) if total_matches else 0
    tg = total_goals["value"] if total_goals else 0

    return jsonify({
        "generation": gen_id,
        "population": pop["c"],
        "top_fitness": round(top["f"] or 0, 2),
        "total_matches": tm,
        "avg_goals": round(tg / tm, 1) if tm > 0 else 0,
        "min_matches_current_gen": pop["min_matches"] or 0,
    })


@app.route("/api/football/config", methods=["GET", "POST"])
def config():
    """Get or update evolution config."""
    with _db_lock:
        db = get_db()
        if request.method == "POST":
            data = request.get_json()
            for key, value in data.items():
                db.execute(
                    "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
                    (key, float(value)),
                )
            db.commit()
            return jsonify({"ok": True})
        rows = db.execute("SELECT key, value FROM config").fetchall()
    return jsonify({r["key"]: r["value"] for r in rows})


@app.route("/api/football/history")
def history():
    """Fitness history for graphing. ?limit=N (default 100)."""
    limit = min(int(request.args.get("limit", 100)), 100000)
    with _db_lock:
        db = get_db()
        rows = db.execute(
            "SELECT generation_id, top_fitness, avg_fitness FROM fitness_history "
            "ORDER BY generation_id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return jsonify([
        {"gen": r["generation_id"], "top": round(r["top_fitness"], 2), "avg": round(r["avg_fitness"], 2)}
        for r in reversed(rows)
    ])


@app.route("/api/football/reset", methods=["POST"])
def reset():
    """Wipe all evolution data and start fresh."""
    with _db_lock:
        db = get_db()
        db.execute("DELETE FROM matches")
        db.execute("DELETE FROM brains")
        db.execute("DELETE FROM generations")
        db.execute("DELETE FROM fitness_history")
        db.execute("UPDATE stats SET value = 0")
        db.execute("DELETE FROM sqlite_sequence")
        db.commit()
        ensure_generation_zero(db)
    # Also wipe persist DB
    if PERSIST_PATH.exists():
        PERSIST_PATH.unlink()
    return jsonify({"ok": True, "message": "Evolution reset"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, threaded=True)
