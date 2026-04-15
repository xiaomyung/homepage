/**
 * Football v2 — Node broker.
 *
 * Port of api/app.py to Node 22 using node:http + node:sqlite (no deps).
 * Same endpoints, same JSON shapes, same semantics as the Flask original.
 *
 * The broker is a state machine, not a trainer. It holds the population in
 * SQLite, hands out matchups to browser web workers, receives match results,
 * and triggers breeding when every brain has enough matches. ALL simulation
 * happens on clients.
 *
 * Endpoints (all under /api/football):
 *   GET  /matchup    — next matchup: {type, p1, p2}
 *   POST /results    — one result or array; records + maybe breeds
 *   GET  /showcase   — visual-match brains: {mode, p1, p2}
 *   GET  /stats      — population stats
 *   GET  /history    — fitness history (last 100 generations desc)
 *   GET  /config     — current tunables
 *   POST /config     — partial merge of tunables
 *   POST /reset      — wipe population, re-init from warm-start seed
 */

import http from 'node:http';
import fs from 'node:fs';
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVOLUTION = path.join(HERE, '..', 'evolution');
// DB_PATH and PORT are overridable via env for tests and local boot;
// production systemd unit uses the compiled-in defaults.
const DB_PATH = process.env.FOOTBALL_DB_PATH || path.join(EVOLUTION, 'football.db');
const WARM_START_PATH = path.join(HERE, '..', 'warm_start_weights.json');

const ROUTE_PREFIX = '/api/football';
const PORT = Number(process.env.FOOTBALL_PORT || 5050);
const HOST = '127.0.0.1';

// Matchup-type rotation: 1 fallback match for every 3 pop matches.
const FALLBACK_MATCHUP_EVERY_N = 4;
// Showcase: 1 in 5 is best-vs-fallback.
const SHOWCASE_FALLBACK_EVERY_N = 5;
const SHOWCASE_RECENT_WINDOW = 20;

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
// Node is single-threaded; route handlers run to completion without being
// preempted. The Python version used an RLock for its threaded Flask
// server — we don't need any locking here.

const state = {
  population: [],       // array of brain objects (camelCase internals)
  populationById: [],   // brain.id → brain, O(1) lookup used by recordResult
  generation: 0,
  totalMatches: 0,
  config: {},
  matchupCounter: 0,
  showcaseCounter: 0,
  // Dirty flag set whenever a result mutates brain stats. Consumers
  // (handleStats, tryBreed) recompute fitness lazily only when true so
  // the per-poll /stats cost drops from O(pop) fitness walks to a
  // single no-op check.
  fitnessDirty: true,
};

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
            fallback_matches, fallback_wins, fallback_draws,
            fitness, is_frozen_seed
     FROM brains
     WHERE generation = ?
     ORDER BY id`,
  ).all(maxGen);
  return rows.map((r) => {
    // Cache the JSON-encoded weight array once per brain so hot-path
    // /matchup responses can splice it into the response body as a
    // raw string fragment without re-serializing 1233 floats each time.
    const weightsJson = r.weights;
    const weights = new Float64Array(JSON.parse(r.weights));
    return {
      id: r.id,
      name: r.name,
      weights,
      _weightsJson: weightsJson,
      popMatches: r.pop_matches,
      popGoalDiff: r.pop_goal_diff,
      fallbackMatches: r.fallback_matches,
      fallbackWins: r.fallback_wins,
      fallbackDraws: r.fallback_draws,
      fitness: r.fitness,
      isFrozenSeed: !!r.is_frozen_seed,
    };
  });
}

function savePopulation(generation) {
  const del = db.prepare('DELETE FROM brains WHERE generation = ?');
  del.run(generation);
  const ins = db.prepare(
    `INSERT INTO brains (
        id, generation, name, weights,
        pop_matches, pop_goal_diff,
        fallback_matches, fallback_wins, fallback_draws,
        fitness, is_frozen_seed
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const b of state.population) {
    // Use the cached weightsJson string when available to avoid
    // re-serializing on every save (breed / reset).
    const weightsStr = b._weightsJson || JSON.stringify(Array.from(b.weights));
    if (!b._weightsJson) b._weightsJson = weightsStr;
    ins.run(
      b.id, generation, b.name, weightsStr,
      b.popMatches, b.popGoalDiff,
      b.fallbackMatches, b.fallbackWins, b.fallbackDraws,
      b.fitness, b.isFrozenSeed ? 1 : 0,
    );
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
    // Pre-serialize weights to a JSON string fragment exactly once
    // per brain, when it enters the population. /matchup responses
    // splice this string in directly — avoids re-running JSON.stringify
    // on a 1233-element numeric array for every request.
    _weightsJson: JSON.stringify(Array.from(w)),
    popMatches: base.popMatches ?? 0,
    popGoalDiff: base.popGoalDiff ?? 0,
    fallbackMatches: base.fallbackMatches ?? 0,
    fallbackWins: base.fallbackWins ?? 0,
    fallbackDraws: base.fallbackDraws ?? 0,
    fitness: base.fitness ?? 0,
    isFrozenSeed,
  };
}

function initPopulationFromWarmStart(config) {
  const raw = JSON.parse(fs.readFileSync(WARM_START_PATH, 'utf8'));
  if (!Array.isArray(raw) || raw.length !== WEIGHT_COUNT) {
    throw new Error(
      `warm_start_weights.json has ${Array.isArray(raw) ? raw.length : 'non-array'} entries, expected ${WEIGHT_COUNT}`,
    );
  }
  const seed = new Float64Array(raw);
  const rng = createGaRng((Math.random() * 2 ** 31) >>> 0);
  const population = [newBrain(0, seed, true)];
  for (let i = 1; i < config.population_size; i++) {
    const mutated = gaussianMutate(seed, 0.3, 0.1, rng);
    population.push(newBrain(i, mutated, false));
  }
  return population;
}

// ── Boot ──────────────────────────────────────────────────────

function initState() {
  openDb();
  state.config = loadConfig();
  state.population = loadPopulation();
  state.generation = currentGeneration();
  state.totalMatches = countTotalMatches();
  state.matchupCounter = 0;
  state.showcaseCounter = 0;
  state.fitnessDirty = true;

  if (state.population.length === 0) {
    state.population = initPopulationFromWarmStart(state.config);
    state.generation = 1;
    savePopulation(state.generation);
  }
  refreshPopulationIndex();
}

// ── Fitness / breeding ────────────────────────────────────────

function fitnessWeightsFromConfig(cfg) {
  return makeFitnessWeights({
    wPop: cfg.fitness_w_pop,
    wFallback: cfg.fitness_w_fallback,
    maxGoalDiff: cfg.fitness_max_goal_diff,
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
  savePopulation(state.generation);
  return true;
}

// ── Matchup selection ─────────────────────────────────────────

function needsMoreFallback(brain, cfg) {
  return brain.fallbackMatches < cfg.min_fallback_matches;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Compute the matchup selection pools once per /matchup handler
 *  call. Previously `pickMatchupJson` filtered the full 50-brain
 *  population on every pick — called 40× per request, that's 2000
 *  filter passes, which became the broker's dominant CPU cost once
 *  workers were pushing ~6000 matches/sec. Building the pools once
 *  up front and reusing them across all picks in the batch collapses
 *  that cost to O(pop_size) per request. */
function buildMatchupPools() {
  const cfg = state.config;
  const pop = state.population;
  const fallbackCandidates = [];
  const popWithFew = [];
  for (const b of pop) {
    if (b.fallbackMatches < cfg.min_fallback_matches) fallbackCandidates.push(b);
    if (b.popMatches < cfg.min_pop_matches) popWithFew.push(b);
  }
  return { fallbackCandidates, popWithFew };
}

/** Pick a matchup and return it as a raw JSON string containing
 *  only brain IDs. Workers maintain a local weights cache (fetched
 *  from /population on start and on generation drift), so the
 *  hot-path /matchup response stays a few bytes per matchup
 *  instead of 40+ KB per brain.
 *
 *  `pools` is the per-request cache from `buildMatchupPools()` —
 *  caller constructs it once, we reuse it on every pick. */
function pickMatchupJson(pools) {
  const pop = state.population;
  state.matchupCounter += 1;

  if (state.matchupCounter % FALLBACK_MATCHUP_EVERY_N === 0) {
    const candidates = pools.fallbackCandidates;
    if (candidates.length > 0) {
      const pick = pickRandom(candidates);
      return `{"type":"fallback","p1":${pick.id},"p2":null}`;
    }
  }

  let pool = pools.popWithFew.length > 0 ? pools.popWithFew : pop;
  if (pool.length < 2) pool = pop;

  const a = pickRandom(pool);
  let b = pickRandom(pool);
  for (let attempts = 0; b.id === a.id && attempts < 5; attempts++) {
    b = pickRandom(pool);
  }
  return `{"type":"pop","p1":${a.id},"p2":${b.id}}`;
}

/** Showcase brains keep a structured return so the existing
 *  scoreboard JSON shape stays stable — showcase is called ~1/min,
 *  not on the hot matchup path, so the Array.from cost is immaterial. */
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
  state.showcaseCounter += 1;

  if (state.showcaseCounter % SHOWCASE_FALLBACK_EVERY_N === 0) {
    let best = pop[0];
    for (const b of pop) if (b.fitness > best.fitness) best = b;
    return {
      mode: 'vs_fallback',
      p1: brainView(best),
      p2: null,
    };
  }

  const a = pickRandom(pop);
  let b = pickRandom(pop);
  for (let attempts = 0; b.id === a.id && attempts < 5; attempts++) {
    b = pickRandom(pop);
  }
  return {
    mode: 'recent',
    p1: brainView(a),
    p2: brainView(b),
  };
}

// ── Result recording ──────────────────────────────────────────

function recordResult(result) {
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

// Hard upper bound on the number of matchups returned per request —
// prevents a malicious or buggy client from asking for a huge batch
// that stalls the server serializing weight arrays.
const MATCHUP_BATCH_MAX = 64;

function handleMatchup(req, res) {
  const url = req.url || '';
  const qi = url.indexOf('?');
  let count = 0;
  if (qi >= 0) {
    const params = new URLSearchParams(url.slice(qi + 1));
    const raw = params.get('count');
    if (raw !== null) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) count = Math.min(n, MATCHUP_BATCH_MAX);
    }
  }
  // Response envelope carries the generation counter so clients detect
  // a breed and re-fetch their population cache. The matchups payload
  // is ID-only — brain weights are fetched separately via /population
  // once per generation.
  const pools = buildMatchupPools();
  let matchupsBody;
  if (count === 0) {
    matchupsBody = pickMatchupJson(pools);
  } else {
    const parts = new Array(count);
    for (let i = 0; i < count; i++) parts[i] = pickMatchupJson(pools);
    matchupsBody = '[' + parts.join(',') + ']';
  }
  const body = `{"generation":${state.generation},"matchups":${matchupsBody}}`;
  const buf = Buffer.from(body);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

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
    brainParts[i] = `{"id":${b.id},"name":${JSON.stringify(b.name)},"weights":${b._weightsJson}}`;
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
  const results = Array.isArray(data) ? data : [data];
  for (const r of results) recordResult(r);
  const bred = tryBreed();
  json(res, 200, { recorded: results.length, bred });
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
  json(res, 200, {
    generation: state.generation,
    population: pop.length,
    avg_fitness: avg,
    top_fitness: top,
    total_matches: state.totalMatches,
    fallback_win_rate: fbMatches > 0 ? fbWins / fbMatches : 0,
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

function handleReset(req, res) {
  db.prepare('DELETE FROM brains').run();
  db.prepare('DELETE FROM generations').run();
  // Re-init from warm-start. Config rows are preserved (matches the
  // schema's INSERT OR IGNORE default-seeding behavior).
  state.config = loadConfig();
  state.population = initPopulationFromWarmStart(state.config);
  state.generation = 1;
  state.totalMatches = 0;
  state.matchupCounter = 0;
  state.showcaseCounter = 0;
  state.fitnessDirty = true;
  refreshPopulationIndex();
  savePopulation(state.generation);
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
    case `GET ${ROUTE_PREFIX}/matchup`:      return handleMatchup(req, res);
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
      process.stderr.write(`[football broker] route error: ${err && err.stack || err}\n`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else {
        try { res.end(); } catch { /* ignore */ }
      }
    });
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`[football broker] uncaught: ${err && err.stack || err}\n`);
  process.exit(1);
});

initState();

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `[football broker] listening on ${HOST}:${PORT}, generation=${state.generation}, population=${state.population.length}\n`,
  );
});
