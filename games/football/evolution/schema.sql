CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS brains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_id INTEGER NOT NULL REFERENCES generations(id),
    weights BLOB NOT NULL,
    fitness REAL DEFAULT 0,
    matches_played INTEGER DEFAULT 0,
    goals_scored INTEGER DEFAULT 0,
    goals_conceded INTEGER DEFAULT 0,
    shaping_total REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_id INTEGER NOT NULL REFERENCES generations(id),
    brain_a_id INTEGER NOT NULL REFERENCES brains(id),
    brain_b_id INTEGER NOT NULL REFERENCES brains(id),
    score_a INTEGER NOT NULL,
    score_b INTEGER NOT NULL,
    played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_brains_gen ON brains(generation_id);
CREATE INDEX IF NOT EXISTS idx_matches_gen ON matches(generation_id);

CREATE TABLE IF NOT EXISTS stats (
    key TEXT PRIMARY KEY,
    value REAL DEFAULT 0
);

INSERT OR IGNORE INTO stats (key, value) VALUES ('total_matches', 0);
INSERT OR IGNORE INTO stats (key, value) VALUES ('total_goals', 0);
