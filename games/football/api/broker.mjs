/**
 * Football v2 — Node broker.
 *
 * Stateless state-store for the neuroevolution pipeline. Holds the
 * population in SQLite, receives aggregated match results from browser
 * workers, triggers breeding when every brain has enough matches, and
 * serves stats/showcase endpoints. ALL simulation happens on clients.
 *
 * Endpoints (all under /api/football):
 *   GET  /population — full population snapshot (weights + metadata)
 *   POST /results    — aggregated match results; records + maybe breeds
 *   GET  /showcase   — visual-match brains: {mode, p1, p2}
 *   GET  /stats      — population stats + runtime
 *   GET  /history    — fitness history (downsampled)
 *   GET  /config     — current tunables
 *   POST /config     — partial merge of tunables
 *   POST /reset      — body {weights: [...]}; wipe DB + re-seed from
 *                      client-trained warm-start weights + optional
 *                      hard=1 query flag to exit for systemd respawn
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  WEIGHT_COUNT,
  makeFitnessWeights,
  computeFitness,
  breedNextGeneration,
  freshBrain,
  gaussianMutate,
  createGaRng,
} from '../evolution/ga.mjs';
import {
  runtimeNowMs as runtimeNowMsPure,
  recordRuntimeActivity as recordRuntimeActivityPure,
  flushRuntime as flushRuntimePure,
} from './runtime-timer.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVOLUTION = path.join(HERE, '..', 'evolution');
// DB_PATH and PORT are overridable via env for tests and local boot;
// production systemd unit uses the compiled-in defaults.
const DB_PATH = process.env.FOOTBALL_DB_PATH || path.join(EVOLUTION, 'football.db');

const ROUTE_PREFIX = '/api/football';
const PORT = Number(process.env.FOOTBALL_PORT || 5050);
const HOST = '127.0.0.1';

// Showcase cadence. Half the showcases are the top brain playing the
// fallback teacher — that's the visually clearest match (the user
// sees the evolved policy competing against a known baseline). The
// other half sample from the TOP 10 brains for variety — not the
// full 50, because lower-ranked brains often have polarised
// strategies that clash into 0-0 stalemates or 30-0 blowouts when
// paired with each other, which reads as "the game is broken"
// despite the training working fine.
const SHOWCASE_FALLBACK_EVERY_N = 2;
const SHOWCASE_TOP_POOL_SIZE    = 10;

const SURNAMES = [
  'Messi', 'Ronaldo', 'Neymar', 'Mbappe', 'Salah', 'Bruyne', 'Haaland',
  'Modric', 'Kroos', 'Benzema', 'Lewandowski', 'Iniesta', 'Xavi', 'Pele',
  'Maradona', 'Zidane', 'Beckham', 'Figo', 'Kaka', 'Ronaldinho',
];

// SQLite schema — single source of truth. `CREATE TABLE IF NOT EXISTS`
// and `INSERT OR IGNORE` make it idempotent so every boot runs exec().
const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS brains (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    generation      INTEGER NOT NULL,
    name            TEXT    NOT NULL,
    weights         TEXT    NOT NULL,
    pop_matches     INTEGER NOT NULL DEFAULT 0,
    pop_goal_diff   REAL    NOT NULL DEFAULT 0,
    pop_wins        INTEGER NOT NULL DEFAULT 0,
    pop_draws       INTEGER NOT NULL DEFAULT 0,
    fallback_matches INTEGER NOT NULL DEFAULT 0,
    fallback_wins   INTEGER NOT NULL DEFAULT 0,
    fallback_draws  INTEGER NOT NULL DEFAULT 0,
    fitness         REAL    NOT NULL DEFAULT 0,
    is_frozen_seed  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_brains_gen ON brains(generation);
CREATE INDEX IF NOT EXISTS idx_brains_fitness ON brains(fitness DESC);

CREATE TABLE IF NOT EXISTS generations (
    gen             INTEGER PRIMARY KEY,
    avg_fitness     REAL    NOT NULL,
    top_fitness     REAL    NOT NULL,
    total_matches   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('runtime_ms_total', '0');

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
`;

// Config schema: key → parser. Used both when loading from DB and when
// merging POST /config payloads so values stay properly typed.
const CONFIG_KEYS = {
  population_size:        { parse: (v) => parseInt(v, 10),   default: 50 },
  min_pop_matches:        { parse: (v) => parseInt(v, 10),   default: 10 },
  min_fallback_matches:   { parse: (v) => parseInt(v, 10),   default: 5 },
  mutation_rate:          { parse: (v) => parseFloat(v),     default: 0.1 },
  mutation_std:           { parse: (v) => parseFloat(v),     default: 0.1 },
  mutation_decay:         { parse: (v) => parseFloat(v),     default: 0.995 },
  tournament_k:           { parse: (v) => parseInt(v, 10),   default: 5 },
  elitism:                { parse: (v) => parseInt(v, 10),   default: 5 },
  random_injection_rate:  { parse: (v) => parseFloat(v),     default: 0.06 },
  match_duration_ms:      { parse: (v) => parseInt(v, 10),   default: 30000 },
  fitness_w_pop:          { parse: (v) => parseFloat(v),     default: 0.4 },
  fitness_w_fallback:     { parse: (v) => parseFloat(v),     default: 0.6 },
  fitness_max_goal_diff:  { parse: (v) => parseFloat(v),     default: 3.0 },
};

// ── Application state ─────────────────────────────────────────
//
// Node is single-threaded; route handlers run to completion without
// being preempted, so no locking is needed.

const state = {
  population: [],       // array of brain objects (camelCase internals)
  populationById: [],   // brain.id → brain, O(1) lookup used by recordResult
  generation: 0,
  totalMatches: 0,
  config: {},
  showcaseCounter: 0,
  // Dirty flag set whenever a result mutates brain stats. Consumers
  // (handleStats, tryBreed) recompute fitness lazily only when true so
  // the per-poll /stats cost drops from O(pop) fitness walks to a
  // single no-op check.
  fitnessDirty: true,
  // Cumulative active training time since the last /reset, in ms.
  // Persisted in the `meta` table so it survives broker restart and
  // client reload. `runtimeActiveStart` and `runtimeLastPostAt` track
  // the current in-memory active window — any /results POST within
  // RUNTIME_HYSTERESIS_MS of the previous one extends the window;
  // longer gaps close it and fold its duration into the persisted
  // total. All clients (across tabs and devices) contribute to the
  // same global counter.
  runtimeMsTotal: 0,
  runtimeActiveStart: null,
  runtimeLastPostAt: null,
  // Session-wide match-outcome counters since last reset. Cheap O(1)
  // per match so we can show the user "how does training look right
  // now" as percentages in the stats panel.
  matchCounts: {
    total: 0,
    zeroZero: 0,           // final 0-0
    nonzeroDraw: 0,        // 1-1, 2-2, ...
    decisive: 0,           // winner, |diff| < BLOWOUT_THRESHOLD
    blowout: 0,            // |diff| >= BLOWOUT_THRESHOLD
    stalled: 0,            // match had ≥1 stall reset
    decisiveNoStall: 0,    // winner AND no stall — showcase-eligible
  },
  // Ring buffer of recently-reported non-stalemate matches (≥1 goal),
  // tagged with the worker's seed so the client can replay any of
  // them deterministically. `/showcase` picks from this buffer so
  // the visible match is a REAL training match we already know ends
  // with a goal — no pre-simulation needed in the browser.
  interestingMatches: [],
};

// Goal-diff threshold for classifying a match as a blowout. Training
// matches are headless (no WIN_SCORE cap) so goal_diff can realistically
// reach the 20s in an evolved-vs-weak pairing — 10 is a sane "the
// losing side never contested" cutoff.
const BLOWOUT_THRESHOLD = 10;

// Cap on the recent-interesting-match ring buffer. 200 entries × ~32
// bytes = ~6 KB. Enough for good showcase variety without holding
// stale pairings forever. Cleared on breed because brain ids are
// reused with new weights across generations.
const INTERESTING_CAP = 200;

// Gap between consecutive /results POSTs beyond which the broker
// treats the training window as closed. Under normal load POSTs
// arrive every ~1 s (eager sync); 15 s is generous enough that a
// brief breed-time hiccup doesn't accidentally fragment the window.
const RUNTIME_HYSTERESIS_MS = 15_000;

/** Keep `state.populationById` in step with `state.population`. Call
 *  after any assignment that rebuilds the population (boot, reset,
 *  breed). Ids are dense and start at 0, so an array indexed by id is
 *  cheaper than a Map for O(1) lookup. */
function refreshPopulationIndex() {
  const idx = [];
  for (const b of state.population) idx[b.id] = b;
  state.populationById = idx;
}

let db = null;

// ── DB helpers ────────────────────────────────────────────────

function openDb() {
  db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA_SQL);
  migrateSchema();
}

/** Forward-only migrations for live deployments whose DB was created
 *  by an older schema. ALTER TABLE ... ADD COLUMN is idempotent under
 *  a try/catch because SQLite has no IF NOT EXISTS for columns. */
function migrateSchema() {
  const alters = [
    'ALTER TABLE brains ADD COLUMN pop_wins  INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE brains ADD COLUMN pop_draws INTEGER NOT NULL DEFAULT 0',
  ];
  for (const sql of alters) {
    try { db.exec(sql); }
    catch (err) {
      // "duplicate column" means the column already exists — fine.
      if (!/duplicate column/i.test(String(err?.message || err))) throw err;
    }
  }
}

function loadConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const raw = {};
  for (const r of rows) raw[r.key] = r.value;
  const cfg = {};
  for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
    cfg[key] = (key in raw) ? spec.parse(raw[key]) : spec.default;
  }
  return cfg;
}

function loadRuntimeMsTotal() {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('runtime_ms_total');
    if (!row) return 0;
    const n = Number(row.value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function persistRuntimeMsTotal(ms) {
  db.prepare(
    'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
  ).run('runtime_ms_total', String(Math.floor(ms)));
}

/** Total active training ms since last reset. */
function runtimeNowMs() {
  return runtimeNowMsPure(state);
}

/** Apply the runtime-timer state transition produced by a pure
 *  transform — keeps the impure `state` object in sync with the
 *  returned immutable snapshot. */
function applyRuntimeState(next) {
  state.runtimeMsTotal = next.runtimeMsTotal;
  state.runtimeActiveStart = next.runtimeActiveStart;
  state.runtimeLastPostAt = next.runtimeLastPostAt;
}

/** Called on every /results POST. */
function recordRuntimeActivity() {
  applyRuntimeState(recordRuntimeActivityPure(state, Date.now(), RUNTIME_HYSTERESIS_MS));
}

/** Snapshot the current active window into runtimeMsTotal and
 *  persist it. */
function flushRuntime() {
  applyRuntimeState(flushRuntimePure(state, Date.now()));
  persistRuntimeMsTotal(state.runtimeMsTotal);
}

function currentGeneration() {
  const row = db.prepare('SELECT MAX(generation) AS g FROM brains').get();
  return (row && row.g != null) ? row.g : 0;
}

function countTotalMatches() {
  const row = db.prepare(
    'SELECT COALESCE(SUM(pop_matches + fallback_matches), 0) AS t FROM brains',
  ).get();
  return row ? Number(row.t) : 0;
}

function loadPopulation() {
  const maxGen = currentGeneration();
  if (maxGen === 0) return [];
  const rows = db.prepare(
    `SELECT id, name, weights, pop_matches, pop_goal_diff,
            pop_wins, pop_draws,
            fallback_matches, fallback_wins, fallback_draws,
            fitness, is_frozen_seed
     FROM brains
     WHERE generation = ?
     ORDER BY id`,
  ).all(maxGen);
  return rows.map((r) => {
    // Cache the JSON-encoded weight array so /population responses
    // can splice it as a raw string fragment without re-serializing.
    const weightsJson = r.weights;
    const weights = new Float64Array(JSON.parse(r.weights));
    return {
      id: r.id,
      name: r.name,
      weights,
      _weightsJson: weightsJson,
      popMatches: r.pop_matches,
      popGoalDiff: r.pop_goal_diff,
      popWins: r.pop_wins,
      popDraws: r.pop_draws,
      fallbackMatches: r.fallback_matches,
      fallbackWins: r.fallback_wins,
      fallbackDraws: r.fallback_draws,
      fitness: r.fitness,
      isFrozenSeed: !!r.is_frozen_seed,
    };
  });
}

function savePopulation(generation) {
  const ins = db.prepare(
    `INSERT INTO brains (
        id, generation, name, weights,
        pop_matches, pop_goal_diff, pop_wins, pop_draws,
        fallback_matches, fallback_wins, fallback_draws,
        fitness, is_frozen_seed
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM brains').run();
    for (const b of state.population) {
      ins.run(
        b.id, generation, b.name, getWeightsJson(b),
        b.popMatches, b.popGoalDiff, b.popWins ?? 0, b.popDraws ?? 0,
        b.fallbackMatches, b.fallbackWins, b.fallbackDraws,
        b.fitness, b.isFrozenSeed ? 1 : 0,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

// ── Brain construction ────────────────────────────────────────

function randomSurname() {
  return SURNAMES[Math.floor(Math.random() * SURNAMES.length)];
}

function newBrain(id, weights, isFrozenSeed = false) {
  const base = freshBrain(weights);
  const w = base.weights instanceof Float64Array
    ? base.weights
    : new Float64Array(weights);
  return {
    id,
    name: randomSurname(),
    weights: w,
    // Lazy-materialized weights JSON — only consumers are /population
    // and savePopulation; computed on demand to avoid ~30 ms of
    // JSON.stringify per breed on the hot path.
    _weightsJson: null,
    popMatches: base.popMatches ?? 0,
    popGoalDiff: base.popGoalDiff ?? 0,
    popWins: base.popWins ?? 0,
    popDraws: base.popDraws ?? 0,
    fallbackMatches: base.fallbackMatches ?? 0,
    fallbackWins: base.fallbackWins ?? 0,
    fallbackDraws: base.fallbackDraws ?? 0,
    fitness: base.fitness ?? 0,
    isFrozenSeed,
  };
}

/** Materialise a brain's weights as a JSON string fragment on demand,
 *  caching the result so repeat calls (same generation) are O(1).
 *  Used by `/population` and `savePopulation`. */
function getWeightsJson(brain) {
  if (brain._weightsJson === null) {
    brain._weightsJson = JSON.stringify(Array.from(brain.weights));
  }
  return brain._weightsJson;
}

/** Build a population by mutating the given frozen-seed weights.
 *  Brain 0 is the untouched seed; brains 1..N are Gaussian-perturbed
 *  copies so the initial GA pool has variance. Called from boot (when
 *  DB has weights but no population) and from /reset (seed arrives
 *  via request body). */
// Mutation magnitudes applied to the warm-start seed when building
// generation 1. The previous (0.3, 0.1) values — 30% of weights
// shifted by N(0, 0.1) — perturbed ~170 weights per brain and
// dropped gen-1 goals-per-match by 97% vs the pure warm-start. Those
// values were tuned for BREEDING (mixing two parents, want divergent
// offspring), not SEEDING (preserve the teacher, want small variance
// across the pool). The new values still give diversity without
// throwing away the imitation.
const SEED_MUTATION_RATE = 0.05;
const SEED_MUTATION_STD  = 0.02;
function buildPopulationFromSeed(seedWeights, config) {
  if (!(seedWeights instanceof Float64Array) || seedWeights.length !== WEIGHT_COUNT) {
    throw new Error(`seed weights must be Float64Array of length ${WEIGHT_COUNT}`);
  }
  const rng = createGaRng((Math.random() * 2 ** 31) >>> 0);
  const population = [newBrain(0, seedWeights, true)];
  for (let i = 1; i < config.population_size; i++) {
    const mutated = gaussianMutate(seedWeights, SEED_MUTATION_RATE, SEED_MUTATION_STD, rng);
    population.push(newBrain(i, mutated, false));
  }
  return population;
}

function loadWarmStartWeights() {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('warm_start_weights');
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed) || parsed.length !== WEIGHT_COUNT) return null;
    return new Float64Array(parsed);
  } catch {
    return null;
  }
}

function persistWarmStartWeights(weights) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run('warm_start_weights', JSON.stringify(Array.from(weights)));
}

// ── Boot ──────────────────────────────────────────────────────

function initState() {
  openDb();
  state.config = loadConfig();
  state.population = loadPopulation();
  state.generation = currentGeneration();
  state.totalMatches = countTotalMatches();
  state.showcaseCounter = 0;
  state.fitnessDirty = true;
  state.runtimeMsTotal = loadRuntimeMsTotal();
  state.runtimeActiveStart = null;
  state.runtimeLastPostAt = null;

  if (state.population.length === 0) {
    // Fresh install → check if we have warm-start weights stored in
    // the meta table from a prior seed. If yes, rebuild population
    // from them. If no, leave population empty — the client's start
    // button detects `population: 0` via /stats and becomes `[ seed ]`,
    // which spawns a Web Worker that trains fresh weights, POSTs them
    // to /reset, and triggers population seeding here.
    try {
      const seed = loadWarmStartWeights();
      if (seed) {
        state.population = buildPopulationFromSeed(seed, state.config);
        state.generation = 1;
        savePopulation(state.generation);
      } else {
        throw new Error('no warm-start weights in DB yet');
      }
    } catch (err) {
      process.stderr.write(
        `[football broker] warm-start weights unavailable (${err?.message ?? err}); ` +
        `population empty — client must trigger seeding via /reset?hard=1\n`,
      );
      state.population = [];
      state.generation = 0;
    }
  }
  lastSavedGeneration = state.generation;
  refreshPopulationIndex();
}

// ── Fitness / breeding ────────────────────────────────────────

function fitnessWeightsFromConfig(cfg) {
  return makeFitnessWeights({
    wPop: cfg.fitness_w_pop,
    wFallback: cfg.fitness_w_fallback,
  });
}

function recomputeAllFitness(pop, fw) {
  for (const b of pop) b.fitness = computeFitness(b, fw);
}

/** Lazy recompute — no-op unless a result has arrived since the last
 *  call. `fitnessDirty` is set by `recordResult`, cleared here. */
function ensureFitnessFresh() {
  if (!state.fitnessDirty) return;
  recomputeAllFitness(state.population, fitnessWeightsFromConfig(state.config));
  state.fitnessDirty = false;
}

function allBrainsReadyToBreed(pop, cfg) {
  for (const b of pop) {
    if (b.popMatches < cfg.min_pop_matches) return false;
    if (b.fallbackMatches < cfg.min_fallback_matches) return false;
  }
  return true;
}

function tryBreed() {
  const cfg = state.config;
  const pop = state.population;
  if (!allBrainsReadyToBreed(pop, cfg)) return false;

  ensureFitnessFresh();

  let sum = 0;
  let top = -Infinity;
  for (const b of pop) {
    sum += b.fitness;
    if (b.fitness > top) top = b.fitness;
  }
  const avg = pop.length > 0 ? sum / pop.length : 0;
  if (!isFinite(top)) top = 0;

  db.prepare(
    `INSERT OR REPLACE INTO generations (gen, avg_fitness, top_fitness, total_matches)
     VALUES (?, ?, ?, ?)`,
  ).run(state.generation, avg, top, state.totalMatches);

  const rng = createGaRng((Math.random() * 2 ** 31) >>> 0);
  const bred = breedNextGeneration(pop, {
    size: cfg.population_size,
    elitism: cfg.elitism,
    tournamentK: cfg.tournament_k,
    mutationRate: cfg.mutation_rate,
    mutationStd: cfg.mutation_std,
    randomInjectionRate: cfg.random_injection_rate,
    rng,
  });

  // Wrap each bred brain in `newBrain` so the pre-serialized
  // _weightsJson cache is populated uniformly for every member. The
  // frozen seed always takes slot 0.
  const seedBrain = pop.find((b) => b.isFrozenSeed);
  const newPop = new Array(bred.length);
  for (let i = 0; i < bred.length; i++) {
    if (i === 0 && seedBrain) {
      newPop[0] = newBrain(0, new Float64Array(seedBrain.weights), true);
    } else {
      newPop[i] = newBrain(i, bred[i].weights, false);
    }
  }

  state.population = newPop;
  state.generation += 1;
  refreshPopulationIndex();
  state.fitnessDirty = true;
  // Reset match-distribution counters per generation so the panel
  // reflects CURRENT training quality (like `cur top` / `cur avg`),
  // not a lifetime-since-reset average dominated by early bad gens.
  state.matchCounts = {
    total: 0, zeroZero: 0, nonzeroDraw: 0, decisive: 0, blowout: 0,
    stalled: 0, decisiveNoStall: 0,
  };
  // interestingMatches intentionally NOT cleared here — entries are
  // tagged with their generation and pickInterestingReplay filters
  // on current gen. That lets the showcase keep replaying last-gen
  // matches for the first ~1 s of the new gen while the new
  // generation's matches fill in (otherwise we got a visible
  // "no seed → fallback to blind picker" blackout every breed).
  schedulePersist();
  return true;
}

// ── Coalesced population persistence ──────────────────────────
//
// Breeding runs ~2 gens/sec under live load, and each savePopulation
// does a DELETE + 50 INSERTs with ~12 KB of weights JSON each.
// That's ~100 DB writes/sec on the hot path. Coalescing to once per
// N seconds reduces breed-path IO by ~20×, keeps crash recovery
// within one save interval, and doesn't change semantics for any
// other endpoint (loadPopulation just picks up whatever's most
// recently persisted on boot).
const SAVE_COALESCE_MS = 10_000;
let lastSavedGeneration = 0;
let saveTimer = null;
function schedulePersist() {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (state.generation !== lastSavedGeneration) {
      savePopulation(state.generation);
      lastSavedGeneration = state.generation;
    }
    // Fold the active runtime window into the persisted total on
    // every coalesced save, so a crash mid-generation loses at most
    // ~SAVE_COALESCE_MS of accumulated runtime — not the whole
    // active window.
    flushRuntime();
  }, SAVE_COALESCE_MS);
}

// Runtime can accumulate for long stretches between breeds (e.g. if
// the population is stuck, or after all brains are already past
// breeding thresholds and tryBreed gates on nothing). schedulePersist
// only fires when a breed is actually pending, so we also run an
// unconditional runtime flush every RUNTIME_PERSIST_MS to bound the
// loss window on a crash during long flat periods.
const RUNTIME_PERSIST_MS = 30_000;
let runtimePersistTimer = null;
function startRuntimePersistLoop() {
  if (runtimePersistTimer !== null) return;
  runtimePersistTimer = setInterval(() => {
    try { flushRuntime(); } catch { /* best-effort */ }
  }, RUNTIME_PERSIST_MS);
  runtimePersistTimer.unref?.();
}

// ── Matchup selection ─────────────────────────────────────────

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Showcase brains keep a structured return shape — /showcase is
 *  called once per visual match (~30 s), not on a hot path. */
function brainView(brain) {
  return {
    id: brain.id,
    name: brain.name,
    weights: Array.from(brain.weights),
  };
}

// ── Showcase selection ────────────────────────────────────────

function pickShowcase() {
  const pop = state.population;
  if (pop.length === 0) return { mode: 'vs_fallback', p1: null, p2: null };
  state.showcaseCounter += 1;
  ensureFitnessFresh();

  // Prefer replaying a real non-stalemate match the trainer just ran
  // — the seed makes the visual a bit-identical deterministic replay,
  // so we show only matches we KNOW produced at least one goal. This
  // gets rid of the "players run to walls and do nothing" showcase
  // failure the old random-pair picker was prone to.
  const replay = pickInterestingReplay();
  if (replay) return replay;

  // Fallback (buffer empty — fresh broker / right after breed): pick
  // top brain vs fallback, or two top brains against each other.
  if (pop.length < 2 || state.showcaseCounter % SHOWCASE_FALLBACK_EVERY_N === 0) {
    let best = pop[0];
    for (const b of pop) if (b.fitness > best.fitness) best = b;
    return { mode: 'vs_fallback', p1: brainView(best), p2: null };
  }
  const k = Math.min(SHOWCASE_TOP_POOL_SIZE, pop.length);
  const top = pop.slice().sort((x, y) => y.fitness - x.fitness).slice(0, k);
  const a = pickRandom(top);
  let b = pickRandom(top);
  for (let attempts = 0; b.id === a.id && attempts < 5; attempts++) {
    b = pickRandom(top);
  }
  return { mode: 'recent', p1: brainView(a), p2: brainView(b) };
}

/** Pick a recent match with ≥1 goal from the ring buffer. Each
 *  entry carries its own weights snapshot so the replay works even
 *  after breeds have rotated the population's brain ids. Rotates
 *  between fallback-mode and brain-vs-brain so both styles surface.
 *  Returns `null` only when the buffer is empty. */
function pickInterestingReplay() {
  const buf = state.interestingMatches;
  if (buf.length === 0) return null;
  const wantFallback = state.showcaseCounter % SHOWCASE_FALLBACK_EVERY_N === 0;

  const snapView = (snap) => ({
    id: snap.id,
    name: snap.name,
    weights: JSON.parse(snap.weights),  // weights stored as JSON string
  });

  const tryPick = (requireMode) => {
    for (let i = buf.length - 1; i >= 0; i--) {
      const m = buf[i];
      const isFb = m.p2 == null;
      if (requireMode === 'fallback' && !isFb) continue;
      if (requireMode === 'recent' && isFb) continue;
      return {
        mode: isFb ? 'vs_fallback' : 'recent',
        p1: snapView(m.p1),
        p2: isFb ? null : snapView(m.p2),
        seed: m.seed,
        preview_score: [m.goals_p1, m.goals_p2],
      };
    }
    return null;
  };

  return tryPick(wantFallback ? 'fallback' : 'recent') ?? tryPick(null);
}

// ── Result recording ──────────────────────────────────────────

function recordResult(result, freshForReplay = true) {
  const byId = state.populationById;
  const p1 = byId[result.p1_id];
  if (!p1) return; // stale result from a previous generation — silently drop

  const goalsP1 = Number(result.goals_p1) | 0;
  const goalsP2 = Number(result.goals_p2) | 0;
  const diff = goalsP1 - goalsP2;

  if (result.p2_id == null) {
    p1.fallbackMatches += 1;
    if (goalsP1 > goalsP2) p1.fallbackWins += 1;
    else if (goalsP1 === goalsP2) p1.fallbackDraws += 1;
    // No explicit loss counter — losses are (matches - wins - draws).
  } else {
    const p2 = byId[result.p2_id];
    if (!p2) return;
    p1.popMatches += 1;
    p1.popGoalDiff += diff;
    p2.popMatches += 1;
    p2.popGoalDiff -= diff;
    if (goalsP1 > goalsP2)      { p1.popWins += 1; }
    else if (goalsP1 < goalsP2) { p2.popWins += 1; }
    else                        { p1.popDraws += 1; p2.popDraws += 1; }
  }

  // Session-wide match-ending distribution counters. Per-match O(1).
  state.matchCounts.total += 1;
  const isDecisive = goalsP1 !== goalsP2 && Math.abs(diff) < BLOWOUT_THRESHOLD;
  if (goalsP1 === 0 && goalsP2 === 0)           state.matchCounts.zeroZero += 1;
  else if (goalsP1 === goalsP2)                 state.matchCounts.nonzeroDraw += 1;
  else if (Math.abs(diff) >= BLOWOUT_THRESHOLD) state.matchCounts.blowout += 1;
  else                                          state.matchCounts.decisive += 1;
  if (result.stalled) state.matchCounts.stalled += 1;
  if (isDecisive && !result.stalled) state.matchCounts.decisiveNoStall += 1;

  // Remember non-stalemate matches with their seeds so /showcase
  // can replay a known-interesting match visually. Only snapshot
  // when the result came from the CURRENT generation — post-breed
  // brain ids carry different weights, so the snapshot would not
  // match what the worker actually ran.
  const seed = Number.isFinite(result.seed) ? result.seed >>> 0 : null;
  const stalled = !!result.stalled;
  if (freshForReplay && !stalled && seed !== null && (goalsP1 + goalsP2) > 0) {
    const p2 = result.p2_id != null ? byId[result.p2_id] : null;
    if (!result.p2_id || p2) {
      state.interestingMatches.push({
        p1: { id: p1.id, name: p1.name, weights: getWeightsJson(p1) },
        p2: p2 ? { id: p2.id, name: p2.name, weights: getWeightsJson(p2) } : null,
        seed,
        goals_p1: goalsP1,
        goals_p2: goalsP2,
      });
      if (state.interestingMatches.length > INTERESTING_CAP) {
        state.interestingMatches.shift();
      }
    }
  }

  state.totalMatches += 1;
  state.fitnessDirty = true;
}

// ── HTTP helpers ──────────────────────────────────────────────

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

// ── Route handlers ────────────────────────────────────────────

/** Serve the full population snapshot — one brain per entry with
 *  pre-serialized weights JSON fragments. Called by clients on worker
 *  start and on generation drift (detected via handleMatchup's
 *  generation counter). Response size scales with population_size,
 *  not per-matchup traffic: 50 × 12 KB ≈ 600 KB fetched ~once per
 *  generation instead of per matchup. */
function handlePopulation(req, res) {
  const pop = state.population;
  const brainParts = new Array(pop.length);
  for (let i = 0; i < pop.length; i++) {
    const b = pop[i];
    brainParts[i] = `{"id":${b.id},"name":${JSON.stringify(b.name)},"weights":${getWeightsJson(b)}}`;
  }
  const body = `{"generation":${state.generation},"brains":[${brainParts.join(',')}]}`;
  const buf = Buffer.from(body);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

async function handleResults(req, res) {
  let data;
  try {
    data = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'expected JSON body' });
  }
  if (data == null) return json(res, 400, { error: 'expected JSON body' });
  // Accept either the legacy bare-array shape `[result, ...]` or the
  // new envelope shape `{generation, results: [...]}`. The envelope
  // lets the orchestrator detect generation drift on its next sync.
  let results;
  let clientGen = null;
  if (Array.isArray(data)) {
    results = data;
  } else if (Array.isArray(data.results)) {
    results = data.results;
    clientGen = typeof data.generation === 'number' ? data.generation : null;
  } else {
    return json(res, 400, { error: 'expected results array or envelope' });
  }
  // Stale-generation results are silently dropped via recordResult's
  // id-miss guard (broker's population has new ids after a breed).
  // The generation hint decides whether the result's brain weights
  // still match the current population: if the client was on an
  // older gen at match time, the weights we'd snapshot now are a
  // different set than the ones that produced the score, so replay
  // would be non-deterministic. Fitness stats still get counted
  // (goal-diff on gen-N and gen-N+1 brains is roughly fungible),
  // but the replay buffer only accepts fresh-gen results.
  const isFresh = clientGen === null || clientGen === state.generation;
  for (const r of results) recordResult(r, isFresh);
  // Every /results POST is proof that a client is actively training.
  // Used to advance the cumulative runtime counter returned by /stats.
  recordRuntimeActivity();
  const bred = tryBreed();

  // Echo the authoritative counts so the orchestrator can reconcile
  // its local view with the sum of all clients' contributions.
  const counts = new Array(state.population.length);
  for (let i = 0; i < state.population.length; i++) {
    const b = state.population[i];
    counts[i] = {
      id: b.id,
      popMatches: b.popMatches,
      popGoalDiff: b.popGoalDiff,
      fallbackMatches: b.fallbackMatches,
      fallbackWins: b.fallbackWins,
      fallbackDraws: b.fallbackDraws,
    };
  }
  json(res, 200, {
    generation: state.generation,
    counts,
    recorded: results.length,
    bred,
    clientGen,
  });
}

function handleShowcase(req, res) {
  json(res, 200, pickShowcase());
}

function handleStats(req, res) {
  ensureFitnessFresh();
  const pop = state.population;
  let sum = 0;
  let top = -Infinity;
  let fbWins = 0;
  let fbMatches = 0;
  for (const b of pop) {
    sum += b.fitness;
    if (b.fitness > top) top = b.fitness;
    fbWins += b.fallbackWins;
    fbMatches += b.fallbackMatches;
  }
  const avg = pop.length > 0 ? sum / pop.length : 0;
  if (!isFinite(top)) top = 0;
  const mc = state.matchCounts;
  const mcTotal = mc.total;
  const pct = (n) => mcTotal > 0 ? n / mcTotal : 0;
  json(res, 200, {
    generation: state.generation,
    population: pop.length,
    avg_fitness: avg,
    top_fitness: top,
    total_matches: state.totalMatches,
    fallback_win_rate: fbMatches > 0 ? fbWins / fbMatches : 0,
    runtime_ms: runtimeNowMs(),
    match_distribution: {
      total:                   mcTotal,
      zero_zero_rate:          pct(mc.zeroZero),
      nonzero_draw_rate:       pct(mc.nonzeroDraw),
      decisive_rate:           pct(mc.decisive),
      decisive_no_stall_rate:  pct(mc.decisiveNoStall),
      blowout_rate:            pct(mc.blowout),
      stall_rate:              pct(mc.stalled),
    },
  });
}

// Default bucket count for /history downsampling — keeps the payload
// bounded regardless of how long training has run. The graph is ~800
// CSS px wide, so 512 evenly-spaced points give sub-2px resolution
// which is plenty for a 1px line. Client can override via ?points=N.
const HISTORY_POINTS_DEFAULT = 512;
const HISTORY_POINTS_MAX = 4096;

function handleHistory(req, res) {
  const url = req.url || '';
  const qi = url.indexOf('?');
  let points = HISTORY_POINTS_DEFAULT;
  if (qi >= 0) {
    const raw = new URLSearchParams(url.slice(qi + 1)).get('points');
    if (raw !== null) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) points = Math.min(n, HISTORY_POINTS_MAX);
    }
  }
  // Full history, oldest → newest. Downsampling to `points` happens
  // below; returning ASC means the client just plots left-to-right
  // without any reverse step.
  const rows = db.prepare(
    `SELECT gen, avg_fitness, top_fitness
     FROM generations ORDER BY gen ASC`,
  ).all();
  const sampled = stridedDownsample(rows, points);
  json(res, 200, sampled.map((r) => ({
    gen: r.gen,
    avg: r.avg_fitness,
    top: r.top_fitness,
  })));
}

/** Pick at most `maxPoints` representative rows from `rows`, always
 *  keeping the first and last entry. Uses even-stride sampling — good
 *  enough for a ~monotone learning curve and vastly simpler than
 *  LTTB. Runs in O(n) with no allocation beyond the result array. */
function stridedDownsample(rows, maxPoints) {
  const n = rows.length;
  if (n <= maxPoints) return rows;
  const out = new Array(maxPoints);
  // Map output index i ∈ [0, maxPoints-1] → input index via
  // `round(i * (n-1) / (maxPoints-1))` so indices 0 and maxPoints-1
  // land exactly on rows[0] and rows[n-1].
  const scale = (n - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    out[i] = rows[Math.round(i * scale)];
  }
  return out;
}

function handleConfigGet(req, res) {
  json(res, 200, state.config);
}

async function handleConfigPost(req, res) {
  let data;
  try {
    data = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'expected JSON body' });
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return json(res, 400, { error: 'expected JSON body' });
  }
  const ins = db.prepare(
    'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)',
  );
  for (const [k, v] of Object.entries(data)) {
    if (k in CONFIG_KEYS) {
      state.config[k] = CONFIG_KEYS[k].parse(v);
      ins.run(k, String(v));
    }
  }
  json(res, 200, state.config);
}

/** Wipe DB tables transactionally. */
function wipeBrainTables() {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM brains').run();
    db.prepare('DELETE FROM generations').run();
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/** Seed population from given weights + zero every counter. Does NOT
 *  save or persist — caller decides when to commit. */
function seedPopulationFromWeights(seedWeights) {
  state.config = loadConfig();
  state.population = buildPopulationFromSeed(seedWeights, state.config);
  state.generation = 1;
  state.totalMatches = 0;
  state.showcaseCounter = 0;
  state.fitnessDirty = true;
  state.runtimeMsTotal = 0;
  state.runtimeActiveStart = null;
  state.runtimeLastPostAt = null;
  state.matchCounts = {
    total: 0, zeroZero: 0, nonzeroDraw: 0, decisive: 0, blowout: 0,
    stalled: 0, decisiveNoStall: 0,
  };
  state.interestingMatches = [];
  refreshPopulationIndex();
}

/** Handle POST /reset. The client has already done the heavy lifting
 *  (Web Worker ran imitation training and produced the weights), so
 *  this handler stays synchronous and completes in <1 s:
 *
 *    1. Validate the weights array in the request body
 *    2. Wipe brains + generations tables
 *    3. Store new warm-start weights in meta table
 *    4. Seed population from those weights (brain 0 frozen + 49 mutated)
 *    5. Persist
 *    6. If hard=1, exit so systemd respawns the broker with a clean
 *       in-memory state (wipes worker-side caches, timers, etc.)
 *
 *  Body shape:  { "weights": [<WEIGHT_COUNT floats>] }
 *  Query:       ?hard=1   — exit after responding (systemd respawns)
 */
async function handleReset(req, res) {
  const url = req.url || '';
  const qi = url.indexOf('?');
  const hard = qi >= 0 &&
    new URLSearchParams(url.slice(qi + 1)).get('hard') === '1';

  let data;
  try {
    data = await readJsonBody(req);
  } catch {
    return json(res, 400, { error: 'expected JSON body' });
  }
  if (!data || !Array.isArray(data.weights) || data.weights.length !== WEIGHT_COUNT) {
    return json(res, 400, {
      error: `body must be {"weights": [${WEIGHT_COUNT} floats]}`,
    });
  }

  const seedWeights = new Float64Array(data.weights);
  try {
    wipeBrainTables();
    persistWarmStartWeights(seedWeights);
    seedPopulationFromWeights(seedWeights);
    persistRuntimeMsTotal(0);
    savePopulation(state.generation);
    lastSavedGeneration = state.generation;
  } catch (err) {
    process.stderr.write(`[football broker] reset failed: ${err?.stack ?? err}\n`);
    return json(res, 500, { error: 'reset failed', detail: String(err?.message ?? err) });
  }

  if (hard) {
    const payload = JSON.stringify({ ok: true, generation: state.generation, hard: true });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload, () => {
      setTimeout(() => {
        try { if (db) db.close(); } catch { /* ignore */ }
        process.exit(0);
      }, 10);
    });
    return;
  }
  json(res, 200, { ok: true, generation: state.generation });
}

// ── Dispatcher ────────────────────────────────────────────────

async function dispatch(req, res) {
  const url = req.url || '';
  // Strip query string; none of our routes use it, but be defensive.
  const qi = url.indexOf('?');
  const pathname = qi >= 0 ? url.slice(0, qi) : url;
  const key = `${req.method} ${pathname}`;

  switch (key) {
    case `GET ${ROUTE_PREFIX}/population`:   return handlePopulation(req, res);
    case `POST ${ROUTE_PREFIX}/results`:     return handleResults(req, res);
    case `GET ${ROUTE_PREFIX}/showcase`:     return handleShowcase(req, res);
    case `GET ${ROUTE_PREFIX}/stats`:        return handleStats(req, res);
    case `GET ${ROUTE_PREFIX}/history`:      return handleHistory(req, res);
    case `GET ${ROUTE_PREFIX}/config`:       return handleConfigGet(req, res);
    case `POST ${ROUTE_PREFIX}/config`:      return handleConfigPost(req, res);
    case `POST ${ROUTE_PREFIX}/reset`:       return handleReset(req, res);
    default:
      return json(res, 404, { error: 'not found' });
  }
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => dispatch(req, res))
    .catch((err) => {
      process.stderr.write(`[football broker] route error: ${err?.stack ?? err}\n`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else {
        try { res.end(); } catch { /* ignore */ }
      }
    });
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`[football broker] uncaught: ${err?.stack ?? err}\n`);
  process.exit(1);
});

/** Flush any coalesced save and exit cleanly on systemctl stop / SIGTERM
 *  / SIGINT so we don't lose the last <SAVE_COALESCE_MS ms of training. */
function flushAndExit(signal) {
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
  if (runtimePersistTimer !== null) { clearInterval(runtimePersistTimer); runtimePersistTimer = null; }
  try {
    if (state.generation !== lastSavedGeneration) {
      savePopulation(state.generation);
      lastSavedGeneration = state.generation;
    }
    flushRuntime();
  } catch (err) {
    process.stderr.write(`[football broker] flush failed on ${signal}: ${err}\n`);
  }
  process.exit(0);
}
process.on('SIGTERM', () => flushAndExit('SIGTERM'));
process.on('SIGINT',  () => flushAndExit('SIGINT'));

// Only auto-start when invoked directly (`node broker.mjs`) — tests
// import this module for its pure helpers and don't want a server
// listening on a real port or a real DB being opened.
const IS_MAIN = import.meta.url === `file://${process.argv[1]}`;
if (IS_MAIN) {
  initState();
  startRuntimePersistLoop();
  server.listen(PORT, HOST, () => {
    process.stdout.write(
      `[football broker] listening on ${HOST}:${PORT}, generation=${state.generation}, population=${state.population.length}\n`,
    );
  });
}

// Named exports for tests. These are the pure helpers whose
// correctness can be checked without spinning up a full broker
// instance — lazy weights JSON caching, aggregated result
// recording, persistence, plus a targeted reinit that opens a
// fresh DB at a caller-supplied path so the save path can be
// exercised against ephemeral /tmp files.
export {
  newBrain,
  getWeightsJson,
  recordResult as _recordResult,
  tryBreed as _tryBreed,
  state as _state,
  refreshPopulationIndex,
  savePopulation as _savePopulation,
  loadPopulation as _loadPopulation,
};

/** Test-only: close any currently-open DB and open a fresh one at
 *  `path`, applying the schema. Lets broker.test.mjs exercise the
 *  real persistence path against a scratch file in /tmp without
 *  interfering with the production DB. */
export function _reopenDbForTest(path) {
  if (db) try { db.close(); } catch { /* ignore */ }
  db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);
}

/** Test-only: cancel the pending coalesced save timer if any. Tests
 *  that trigger `tryBreed` schedule a save 10 s later; without this
 *  cancel hook the timer keeps the test process alive and also
 *  crashes when it fires against an already-deleted DB file. */
export function _cancelPendingSaveForTest() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
