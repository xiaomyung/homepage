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

EVOLUTION_DIR = Path(__file__).resolve().parent.parent / "evolution"
SCHEMA_PATH = EVOLUTION_DIR / "schema.sql"
PERSIST_PATH = EVOLUTION_DIR / "football_persist.db"

# ── In-memory DB ─────────────────────────────────────────────

_mem_db = None
_db_lock = threading.Lock()
_trainer_stats = {}  # source_id → {"sims_per_sec": N, "last_seen": timestamp}
TRAINER_STALE_SECONDS = 15  # drop trainers not seen within this window


def get_db():
    """Return the shared in-memory DB connection."""
    return _mem_db


def _apply_schema(db):
    """Apply the evolution schema to a DB connection."""
    with open(SCHEMA_PATH) as f:
        db.executescript(f.read())


def _init_mem_db():
    """Initialize in-memory DB with schema and load persisted state."""
    global _mem_db
    _mem_db = sqlite3.connect(":memory:", check_same_thread=False)
    _mem_db.row_factory = sqlite3.Row
    _mem_db.execute("PRAGMA foreign_keys=ON")
    _apply_schema(_mem_db)
    _load_persisted_state()


def _init_persist_db():
    """Ensure the persist DB has the schema."""
    db = sqlite3.connect(str(PERSIST_PATH))
    _apply_schema(db)
    db.close()


def _load_persisted_state():
    """Load all persistent state from disk: config, stats, history, and population."""
    if not PERSIST_PATH.exists():
        return
    try:
        disk = sqlite3.connect(str(PERSIST_PATH))
        disk.row_factory = sqlite3.Row
        # Config
        for row in disk.execute("SELECT key, value FROM config").fetchall():
            _mem_db.execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
                (row["key"], row["value"]),
            )
        # Stats
        for row in disk.execute("SELECT key, value FROM stats").fetchall():
            _mem_db.execute(
                "UPDATE stats SET value = ? WHERE key = ?",
                (row["value"], row["key"]),
            )
        # Fitness history
        for row in disk.execute(
            "SELECT generation_id, top_fitness, avg_fitness FROM fitness_history"
        ).fetchall():
            _mem_db.execute(
                "INSERT OR IGNORE INTO fitness_history VALUES (?, ?, ?)",
                (row["generation_id"], row["top_fitness"], row["avg_fitness"]),
            )
        # Hall of fame
        try:
            for row in disk.execute(
                "SELECT generation_id, weights, fitness FROM hall_of_fame"
            ).fetchall():
                _mem_db.execute(
                    "INSERT OR IGNORE INTO hall_of_fame (generation_id, weights, fitness) "
                    "VALUES (?, ?, ?)",
                    (row["generation_id"], row["weights"], row["fitness"]),
                )
        except sqlite3.OperationalError:
            pass  # table may not exist in old persist DBs
        # Generation + brains (restore population so evolution continues)
        gen_row = disk.execute("SELECT MAX(id) as id FROM generations").fetchone()
        if gen_row and gen_row["id"]:
            gen_id = gen_row["id"]
            _mem_db.execute("INSERT OR IGNORE INTO generations (id) VALUES (?)", (gen_id,))
            for row in disk.execute(
                "SELECT id, generation_id, weights, fitness, matches_played, "
                "goals_scored, goals_conceded, shaping_total "
                "FROM brains WHERE generation_id = ?", (gen_id,)
            ).fetchall():
                _mem_db.execute(
                    "INSERT OR IGNORE INTO brains (id, generation_id, weights, fitness, "
                    "matches_played, goals_scored, goals_conceded, shaping_total) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (row["id"], row["generation_id"], row["weights"], row["fitness"],
                     row["matches_played"], row["goals_scored"], row["goals_conceded"],
                     row["shaping_total"]),
                )
        _mem_db.commit()
        disk.close()
    except (sqlite3.DatabaseError, OSError):
        pass  # persist DB might be corrupted or unreadable — start fresh


def _flush_to_disk():
    """Background thread: periodically save persistent data to disk."""
    while True:
        time.sleep(30)
        try:
            with _db_lock:
                _do_flush()
        except (sqlite3.DatabaseError, OSError):
            pass  # best-effort


def _do_flush():
    """Copy persistent state from memory to disk (~200KB every 30s)."""
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
    # Fitness history (append only — INSERT OR IGNORE skips existing)
    for row in _mem_db.execute(
        "SELECT generation_id, top_fitness, avg_fitness FROM fitness_history"
    ).fetchall():
        disk.execute(
            "INSERT OR IGNORE INTO fitness_history VALUES (?, ?, ?)",
            (row["generation_id"], row["top_fitness"], row["avg_fitness"]),
        )
    # Hall of fame (append only)
    for row in _mem_db.execute(
        "SELECT generation_id, weights, fitness FROM hall_of_fame"
    ).fetchall():
        disk.execute(
            "INSERT OR IGNORE INTO hall_of_fame (generation_id, weights, fitness) "
            "VALUES (?, ?, ?)",
            (row["generation_id"], row["weights"], row["fitness"]),
        )
    # Current generation + brains (overwrite — only keep latest snapshot)
    gen_id = _mem_db.execute("SELECT MAX(id) as id FROM generations").fetchone()["id"]
    if gen_id:
        disk.execute("DELETE FROM brains")
        disk.execute("DELETE FROM generations")
        disk.execute("DELETE FROM matches")
        disk.execute("DELETE FROM sqlite_sequence WHERE name IN ('brains','generations','matches')")
        disk.execute("INSERT INTO generations (id) VALUES (?)", (gen_id,))
        for row in _mem_db.execute(
            "SELECT id, generation_id, weights, fitness, matches_played, "
            "goals_scored, goals_conceded, shaping_total "
            "FROM brains WHERE generation_id = ?", (gen_id,)
        ).fetchall():
            disk.execute(
                "INSERT INTO brains (id, generation_id, weights, fitness, matches_played, "
                "goals_scored, goals_conceded, shaping_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (row["id"], row["generation_id"], row["weights"], row["fitness"],
                 row["matches_played"], row["goals_scored"], row["goals_conceded"],
                 row["shaping_total"]),
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


# ── Evolution constants ──────────────────────────────────────
STAGNATION_WINDOW = 20   # compare last 10 gens vs 10 before that
STAGNATION_THRESH = 0.01 # min improvement to count as progress (fitness is [0,1])
MUTATION_RATE_MAX = 0.25
MUTATION_STD_MAX  = 0.8
GOAL_SIZE_SHRINK  = 0.02
GOAL_SIZE_MIN     = 1.0
HOF_INTERVAL      = 50
KEEP_GENERATIONS  = 5
MATCHUP_HOF_RATE  = 0.10   # fraction of training matches vs HoF opponents
MATCHUP_RAND_RATE = 0.05   # fraction of training matches vs random brains
MATCHUP_MAX_COUNT = 100    # max pairs per /matchup request
HISTORY_MAX_LIMIT = 100000 # max rows from /history endpoint


def _adapt_mutation(db, cfg):
    """Ramp mutation when fitness plateaus, based on fitness_history."""
    history = db.execute(
        "SELECT top_fitness FROM fitness_history ORDER BY generation_id DESC LIMIT ?",
        (STAGNATION_WINDOW,),
    ).fetchall()
    if len(history) < STAGNATION_WINDOW:
        return
    recent_best = max(r["top_fitness"] for r in history[:10])
    older_best = max(r["top_fitness"] for r in history[10:])
    improvement = recent_best - older_best
    if improvement < STAGNATION_THRESH:
        factor = min(3.0, 1.0 + (STAGNATION_THRESH - improvement) * 100)
        cfg["mutation_rate"] = min(cfg.get("mutation_rate", 0.05) * factor, MUTATION_RATE_MAX)
        cfg["mutation_std"] = min(cfg.get("mutation_std", 0.3) * factor, MUTATION_STD_MAX)


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
    top_f = max(b["fitness"] for b in brain_dicts)
    avg_f = sum(b["fitness"] for b in brain_dicts) / len(brain_dicts)
    db.execute(
        "INSERT OR REPLACE INTO fitness_history (generation_id, top_fitness, avg_fitness) "
        "VALUES (?, ?, ?)",
        (gen_id, top_f, avg_f),
    )

    cfg = get_config(db)
    _adapt_mutation(db, cfg)
    new_weights = breed_next_generation(brain_dicts, cfg)
    db.execute("INSERT INTO generations DEFAULT VALUES")
    new_gen_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    for w in new_weights:
        db.execute(
            "INSERT INTO brains (generation_id, weights) VALUES (?, ?)",
            (new_gen_id, w),
        )
    db.commit()

    # Save best brain to hall of fame periodically
    if gen_id % HOF_INTERVAL == 0 and brain_dicts:
        best = max(brain_dicts, key=lambda b: b["fitness"])
        db.execute(
            "INSERT INTO hall_of_fame (generation_id, weights, fitness) VALUES (?, ?, ?)",
            (gen_id, best["weights"], best["fitness"]),
        )
        db.commit()

    _shrink_goal_size(db, gen_id)
    _cleanup_old_data(db, new_gen_id)


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
    if goals and goals["g"] > 0:
        new_size = max(GOAL_SIZE_MIN, size - GOAL_SIZE_SHRINK)
        db.execute(
            "INSERT OR REPLACE INTO config (key, value) VALUES ('goal_size', ?)",
            (new_size,),
        )
        db.commit()


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


# ── Fitness weights ──────────────────────────────────────────
# Positive weights sum to 1.0 (perfect play = 1.0).
# Penalty weights sum to 1.0 (worst possible play = -1.0).
# Range: [-1.0, 1.0]. Proximity-first: strong gradient toward ball.

# POSITIVE (sum = 1.00)
W_PROXIMITY         = 0.25  # avg closeness to ball (tight engagement radius)
W_GOALS             = 0.20  # goals / CAP_GOALS
W_WIN_BONUS         = 0.12  # 1.0 win / 0.5 draw / 0.0 loss
W_STAMINA           = 0.10  # avg stamina
W_NEAR_MISS         = 0.08  # nearMisses / CAP_NEAR_MISS
W_KICK_ACCURACY     = 0.07  # (goalKicks / kicks) * volume_guard
W_FRAME_HIT         = 0.06  # frameHits / CAP_FRAME_HIT
W_SAVES             = 0.05  # saves / CAP_SAVES
W_ADVANCE           = 0.04  # ball movement toward opponent goal
W_AIR_KICK_ACCURACY = 0.03  # (goalAirKicks / airKicks) * volume_guard

# PENALTIES (sum = 1.00)
W_EXHAUSTION        = 0.40  # fraction of match exhausted
W_CONCEDED          = 0.25  # goals conceded / CAP_GOALS
W_WASTED_KICKS      = 0.20  # wastedKicks / max(kicks, 1)
W_WASTED_AIR_KICKS  = 0.10  # wastedAirKicks / max(airKicks, 1)
W_PUSHED            = 0.05  # pushed / CAP_PUSHED

# Caps for count-based metrics
CAP_GOALS     = 2
CAP_NEAR_MISS = 3
CAP_FRAME_HIT = 3
CAP_SAVES     = 5
CAP_PUSHED    = 5

# Volume guard — prevents gaming ratio metrics with tiny kick counts
KICK_VOLUME_FLOOR = 10


def calc_match_fitness(fitness_data, goals_scored, goals_conceded):
    """Calculate per-match fitness in [-1, 1]. Positive = skill, negative = penalties."""
    goals = min(goals_scored / CAP_GOALS, 1)
    conceded = min(goals_conceded / CAP_GOALS, 1)

    if goals_scored > goals_conceded:
        win_bonus = 1.0
    elif goals_scored == goals_conceded:
        win_bonus = 0.5
    else:
        win_bonus = 0.0

    if not fitness_data or fitness_data.get("ticks", 0) == 0:
        return W_GOALS * goals + W_WIN_BONUS * win_bonus - W_CONCEDED * conceded

    ticks = fitness_data["ticks"]
    kicks = fitness_data.get("kicks", 0)
    air_kicks_raw = fitness_data.get("airKicks", 0)

    # Volume guard: scales ratio metrics down when kick count is below floor
    kick_volume = min(kicks / KICK_VOLUME_FLOOR, 1)

    # Per-tick averages [0, 1]
    proximity  = fitness_data.get("ballProximity", 0) / ticks
    advance    = max(0, min(fitness_data.get("ballAdvance", 0) / ticks, 1))
    stamina    = fitness_data.get("staminaSum", 0) / ticks
    exhaustion = fitness_data.get("exhaustedTicks", 0) / ticks

    # Ratio-based with volume guard
    kick_accuracy     = (fitness_data.get("goalKicks", 0) / max(kicks, 1)) * kick_volume
    air_kick_accuracy = (fitness_data.get("goalAirKicks", 0) / max(air_kicks_raw, 1)) * kick_volume
    wasted_kicks      = fitness_data.get("wastedKicks", 0) / max(kicks, 1)
    wasted_air_kicks  = fitness_data.get("wastedAirKicks", 0) / max(air_kicks_raw, 1)

    # Count-based (capped to [0, 1])
    near_misses = min(fitness_data.get("nearMisses", 0) / CAP_NEAR_MISS, 1)
    frame_hits  = min(fitness_data.get("frameHits", 0) / CAP_FRAME_HIT, 1)
    saves       = min(fitness_data.get("saves", 0) / CAP_SAVES, 1)
    pushed      = min(fitness_data.get("pushedReceived", 0) / CAP_PUSHED, 1)

    positive = (
        W_PROXIMITY         * proximity
        + W_GOALS             * goals
        + W_WIN_BONUS         * win_bonus
        + W_STAMINA           * stamina
        + W_NEAR_MISS         * near_misses
        + W_KICK_ACCURACY     * kick_accuracy
        + W_FRAME_HIT         * frame_hits
        + W_SAVES             * saves
        + W_ADVANCE           * advance
        + W_AIR_KICK_ACCURACY * air_kick_accuracy
    )
    penalty = (
        W_EXHAUSTION        * exhaustion
        + W_WASTED_KICKS      * wasted_kicks
        + W_CONCEDED          * conceded
        + W_WASTED_AIR_KICKS  * wasted_air_kicks
        + W_PUSHED            * pushed
    )
    return positive - penalty


# ── Endpoints ────────────────────────────────────────────────


@app.route("/api/football/matchup")
def matchup():
    """Get brain pairs to play. ?count=N, ?known=id1,id2,... to skip weights."""
    count = min(int(request.args.get("count", 5)), MATCHUP_MAX_COUNT)
    with _db_lock:
        db = get_db()
        ensure_generation_zero(db)

        gen_id = current_generation(db)
        brains = get_brains_for_gen(db, gen_id)
        hof_rows = db.execute("SELECT weights FROM hall_of_fame").fetchall()

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
        if roll < MATCHUP_HOF_RATE and hof_rows:
            # Hall of fame opponent
            hof = random.choice(hof_rows)
            pairs.append({
                "brain_a": {"id": a["id"], "weights": weight_cache[a["id"]]},
                "brain_b": {"id": None, "weights": weights_to_b64(hof["weights"]), "type": "hof"},
                "generation_id": gen_id,
            })
        elif roll < MATCHUP_HOF_RATE + MATCHUP_RAND_RATE:
            # Random opponent (5%)
            pairs.append({
                "brain_a": {"id": a["id"], "weights": weight_cache[a["id"]]},
                "brain_b": {"id": None, "weights": weights_to_b64(random_weights()), "type": "random"},
                "generation_id": gen_id,
            })
        else:
            # Self-play (remainder, or higher when HoF is empty)
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
    if not data:
        return jsonify({"error": "invalid JSON"}), 400
    try:
        brain_a_id = data["brain_a_id"]
        brain_b_id = data["brain_b_id"]
        score_a = data["score_a"]
        score_b = data["score_b"]
    except KeyError:
        return jsonify({"error": "missing required fields"}), 400
    gen_id = data.get("generation_id")
    fit_a = calc_match_fitness(data.get("fitness_a"), score_a, score_b)
    fit_b = calc_match_fitness(data.get("fitness_b"), score_b, score_a)

    with _db_lock:
        db = get_db()
        cur_gen = current_generation(db)
        db.execute(
            "INSERT INTO matches (generation_id, brain_a_id, brain_b_id, score_a, score_b) "
            "VALUES (?, ?, ?, ?, ?)",
            (gen_id or cur_gen, brain_a_id, brain_b_id, score_a, score_b),
        )
        for bid, gs, gc, fit in [
            (brain_a_id, score_a, score_b, fit_a),
            (brain_b_id, score_b, score_a, fit_b),
        ]:
            db.execute(
                "UPDATE brains SET "
                "matches_played = matches_played + 1, "
                "goals_scored = goals_scored + ?, "
                "goals_conceded = goals_conceded + ?, "
                "shaping_total = shaping_total + ?, "
                "fitness = (shaping_total + ?) / (matches_played + 1) "
                "WHERE id = ?",
                (gs, gc, fit, fit, bid),
            )
        db.commit()
        if gen_id is None or gen_id == cur_gen:
            try_breed(db, cur_gen)

    return jsonify({"ok": True})


@app.route("/api/football/results", methods=["POST"])
def results_batch():
    """Report multiple match results in one request."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "invalid JSON"}), 400

    source = data.get("source")
    sps = data.get("sims_per_sec")
    if source and sps is not None:
        _trainer_stats[source] = {"sims_per_sec": int(sps), "last_seen": time.time()}

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
            fit_a = calc_match_fitness(item.get("fitness_a"), score_a, score_b)

            match_rows.append((gen_id or cur_gen, brain_a_id, brain_b_id or brain_a_id, score_a, score_b))
            brain_updates.append((score_a, score_b, fit_a, fit_a, brain_a_id))

            if brain_b_id is not None and item.get("opponent_type", "normal") == "normal":
                fit_b = calc_match_fitness(item.get("fitness_b"), score_b, score_a)
                brain_updates.append((score_b, score_a, fit_b, fit_b, brain_b_id))

        total_goals = sum(sa + sb for (_, _, _, sa, sb) in match_rows)
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
            "fitness = (shaping_total + ?) / (matches_played + 1) "
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


@app.route("/api/football/showcase")
def showcase():
    """Get two different brains for the visual match display."""
    with _db_lock:
        db = get_db()
        ensure_generation_zero(db)
        gen_id = current_generation(db)
        best = db.execute(
            "SELECT id, weights, fitness FROM brains "
            "WHERE matches_played > 0 ORDER BY fitness DESC LIMIT 1",
        ).fetchone()
        mid = db.execute(
            "SELECT id, weights, fitness FROM brains "
            "WHERE matches_played > 0 ORDER BY fitness DESC LIMIT 1 OFFSET ?",
            (random.randint(20, 40),),
        ).fetchone()
        rand_pop = db.execute(
            "SELECT id, weights, fitness FROM brains "
            "WHERE matches_played > 0 ORDER BY RANDOM() LIMIT 1",
        ).fetchone()
        hof_rows = db.execute(
            "SELECT weights, fitness, generation_id FROM hall_of_fame"
        ).fetchall()

    if not best:
        return jsonify({"brewing": True})

    roll = random.random()
    if roll < 0.40 and hof_rows:
        # Best vs random HoF champion (different era/lineage)
        brain_a, brain_b = best, random.choice(hof_rows)
        matchup_type = "vs_hof"
    elif roll < 0.70 and mid:
        # Best vs mid-ranked brain (different strategy niche)
        brain_a, brain_b = best, mid
        matchup_type = "vs_mid"
    elif roll < 0.90 and rand_pop and rand_pop["id"] != best["id"]:
        # Best vs random population member
        brain_a, brain_b = best, rand_pop
        matchup_type = "vs_random"
    elif len(hof_rows) >= 2:
        # Two HoF brains from different eras
        a, b = random.sample(hof_rows, 2)
        brain_a, brain_b = a, b
        matchup_type = "hof_vs_hof"
    else:
        # Fallback: best vs any available
        brain_a = best
        brain_b = rand_pop or mid or best
        matchup_type = "fallback"

    return jsonify({
        "brain_a": weights_to_b64(brain_a["weights"]),
        "brain_b": weights_to_b64(brain_b["weights"]),
        "generation_id": gen_id,
        "matchup_type": matchup_type,
        "brewing": False,
    })


@app.route("/api/football/stats")
def stats():
    """Evolution statistics."""
    with _db_lock:
        db = get_db()
        ensure_generation_zero(db)
        gen_id = current_generation(db)

        # Use fitness_history for last completed generation (current gen may be 0)
        last_hist = db.execute(
            "SELECT top_fitness, avg_fitness FROM fitness_history "
            "ORDER BY generation_id DESC LIMIT 1"
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

        hof_size = db.execute("SELECT COUNT(*) as c FROM hall_of_fame").fetchone()["c"]

        cfg_rows = db.execute("SELECT key, value FROM config").fetchall()
        cfg = {r["key"]: r["value"] for r in cfg_rows}

    tm = int(total_matches["value"]) if total_matches else 0
    tg = total_goals["value"] if total_goals else 0

    # Aggregate trainer stats by category (active in last 15s)
    now = time.time()
    trainers = {"browser": 0, "server": 0, "other": 0}
    for src, info in list(_trainer_stats.items()):
        if now - info["last_seen"] > TRAINER_STALE_SECONDS:
            del _trainer_stats[src]
            continue
        if src.startswith("browser-"):
            trainers["browser"] += info["sims_per_sec"]
        elif src.startswith("server"):
            trainers["server"] += info["sims_per_sec"]
        else:
            trainers["other"] += info["sims_per_sec"]

    return jsonify({
        "generation": gen_id,
        "population": pop["c"],
        "top_fitness": round(last_hist["top_fitness"], 2) if last_hist else 0,
        "avg_fitness": round(last_hist["avg_fitness"], 2) if last_hist else 0,
        "total_matches": tm,
        "avg_goals": round(tg / tm, 1) if tm > 0 else 0,
        "min_matches_current_gen": pop["min_matches"] or 0,
        "hof_size": hof_size,
        "goal_size": round(cfg.get("goal_size", 2.0), 2),
        "mutation_rate": cfg.get("mutation_rate", 0.05),
        "mutation_std": cfg.get("mutation_std", 0.3),
        "trainers": trainers,
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
    limit = min(int(request.args.get("limit", 100)), HISTORY_MAX_LIMIT)
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
