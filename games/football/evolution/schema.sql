-- Football v2 evolution schema.
--
-- Single source of truth for population state. Wiped on reset; persisted
-- to disk at shutdown by app.py. No history beyond `generations`.

PRAGMA foreign_keys = ON;

-- One row per brain in the current generation plus the hall of fame.
-- Weights are stored as a JSON array of 1193 floats (small, human-readable).
CREATE TABLE IF NOT EXISTS brains (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    generation      INTEGER NOT NULL,
    name            TEXT    NOT NULL,             -- display name shown in scoreboard
    weights         TEXT    NOT NULL,             -- JSON array, 1193 floats
    -- Fitness components; aggregated into `fitness` after breeding trigger
    pop_matches     INTEGER NOT NULL DEFAULT 0,
    pop_goal_diff   REAL    NOT NULL DEFAULT 0,
    blowout_bonus   REAL    NOT NULL DEFAULT 0,
    fallback_matches INTEGER NOT NULL DEFAULT 0,
    fallback_wins   INTEGER NOT NULL DEFAULT 0,
    fallback_draws  INTEGER NOT NULL DEFAULT 0,
    fallback_losses INTEGER NOT NULL DEFAULT 0,
    fitness         REAL    NOT NULL DEFAULT 0,
    -- Bookkeeping
    is_frozen_seed  INTEGER NOT NULL DEFAULT 0,  -- 1 for the warm-start brain #0; never mutated
    created_tick    INTEGER NOT NULL DEFAULT 0   -- wall-clock placeholder, not used by physics
);

CREATE INDEX IF NOT EXISTS idx_brains_gen ON brains(generation);
CREATE INDEX IF NOT EXISTS idx_brains_fitness ON brains(fitness DESC);

-- One row per completed generation. Used for the fitness history graph.
CREATE TABLE IF NOT EXISTS generations (
    gen             INTEGER PRIMARY KEY,
    avg_fitness     REAL    NOT NULL,
    top_fitness     REAL    NOT NULL,
    total_matches   INTEGER NOT NULL
);

-- Key-value config. Tunable at runtime via GET/POST /api/football/config.
CREATE TABLE IF NOT EXISTS config (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL
);

-- Default tuning values. Insert-or-ignore so a reset wipes population but
-- leaves config intact; an explicit DELETE FROM config restores defaults.
INSERT OR IGNORE INTO config (key, value) VALUES
    ('population_size',         '50'),
    ('min_pop_matches',         '10'),
    ('min_fallback_matches',    '5'),
    ('mutation_rate',           '0.1'),
    ('mutation_std',            '0.1'),
    ('mutation_decay',          '0.995'),
    ('tournament_k',            '5'),
    ('elitism',                 '5'),
    ('random_injection_rate',   '0.06'),
    ('match_duration_ms',       '30000'),
    ('fitness_w_pop',           '0.4'),
    ('fitness_w_fallback',      '0.6'),
    ('fitness_max_goal_diff',   '3.0');
