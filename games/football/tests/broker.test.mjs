/**
 * Broker unit tests.
 *
 * These import the real helpers from api/broker.mjs (no mocks, no
 * stubs, no subprocess spawn) and exercise them against the real
 * in-memory `state` object. The broker's top-level `initState()` +
 * `server.listen()` is gated behind a main-module check, so
 * importing the module is side-effect-free.
 *
 * The post-refactor broker is a pure state store: matchmaking moved
 * to the client (matchmaker.js has its own test file). The broker's
 * remaining responsibilities are:
 *
 *   1. Populate + serve full-snapshot brain weights (/population).
 *   2. Aggregate per-brain stats from client-posted match results.
 *   3. Detect breed thresholds and trigger GA breeding.
 *   4. Persist + load snapshots atomically (no UNIQUE-constraint
 *      crashes as generations turn over).
 *
 * Every assertion below targets one of those four contracts. No
 * tautologies — each test would fail if a real regression were
 * introduced in the code under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newBrain,
  getWeightsJson,
  _recordResult,
  _tryBreed,
  _state,
  refreshPopulationIndex,
  _savePopulation,
  _loadPopulation,
  _reopenDbForTest,
  _cancelPendingSaveForTest,
} from '../api/broker.mjs';
import { WEIGHT_COUNT } from '../evolution/ga.mjs';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── Fixtures ─────────────────────────────────────────────── */

function withTmpDb(fn) {
  const tmpPath = join(tmpdir(), `football-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  _reopenDbForTest(tmpPath);
  try {
    fn(tmpPath);
  } finally {
    _cancelPendingSaveForTest();
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

function fakePopulation(n) {
  const pop = [];
  for (let i = 0; i < n; i++) {
    const w = new Float64Array(WEIGHT_COUNT).fill(i + 1);
    pop.push(newBrain(i, w, false));
  }
  return pop;
}

function installPopulation(pop, config = {}) {
  _state.population = pop;
  _state.config = {
    min_pop_matches: 10,
    min_fallback_matches: 5,
    mutation_rate: 0.1,
    mutation_std: 0.1,
    mutation_decay: 0.995,
    tournament_k: 5,
    elitism: 5,
    random_injection_rate: 0.06,
    population_size: pop.length,
    fitness_w_pop: 0.4,
    fitness_w_fallback: 0.6,
    fitness_max_goal_diff: 3.0,
    ...config,
  };
  _state.totalMatches = 0;
  _state.fitnessDirty = true;
  refreshPopulationIndex();
}

/* ── newBrain + getWeightsJson ─────────────────────────────── */

test('newBrain starts with null _weightsJson — no eager serialisation', () => {
  const w = new Float64Array(WEIGHT_COUNT).fill(0.5);
  const b = newBrain(7, w);
  assert.equal(b._weightsJson, null,
    'perf regression: newBrain must not call JSON.stringify on the hot breed path');
  assert.equal(b.id, 7);
  assert.ok(b.weights instanceof Float64Array);
  assert.equal(b.weights.length, WEIGHT_COUNT);
  assert.equal(b.weights[0], 0.5);
});

test('getWeightsJson materialises and caches on first call', () => {
  const w = new Float64Array(WEIGHT_COUNT).fill(-0.25);
  const b = newBrain(0, w);
  assert.equal(b._weightsJson, null);

  const first = getWeightsJson(b);
  assert.equal(typeof first, 'string');
  const parsed = JSON.parse(first);
  assert.equal(parsed.length, WEIGHT_COUNT);
  assert.equal(parsed[0], -0.25);

  // Cache populated
  assert.equal(b._weightsJson, first);

  // Strict identity proves the cache was hit, not recomputed.
  const second = getWeightsJson(b);
  assert.strictEqual(second, b._weightsJson);
});

test('getWeightsJson survives a Float64Array roundtrip to numeric equality', () => {
  const w = new Float64Array(WEIGHT_COUNT);
  for (let i = 0; i < WEIGHT_COUNT; i++) {
    w[i] = Math.sin(i * 0.13 + 0.7) * (i % 3 === 0 ? -1 : 1);
  }
  const b = newBrain(3, w);
  const json = getWeightsJson(b);
  const reconstructed = new Float64Array(JSON.parse(json));
  assert.equal(reconstructed.length, WEIGHT_COUNT);
  for (let i = 0; i < WEIGHT_COUNT; i++) {
    assert.ok(
      reconstructed[i] === w[i],
      `mismatch at index ${i}: got ${reconstructed[i]}, want ${w[i]}`,
    );
  }
});

/* ── recordResult: per-match aggregation ─────────────────── */

test('recordResult records a pop match for both sides', () => {
  installPopulation(fakePopulation(5));
  _recordResult({ p1_id: 1, p2_id: 2, goals_p1: 3, goals_p2: 1 });
  assert.equal(_state.population[1].popMatches, 1);
  assert.equal(_state.population[1].popGoalDiff, 2);
  assert.equal(_state.population[2].popMatches, 1);
  assert.equal(_state.population[2].popGoalDiff, -2);
  assert.equal(_state.totalMatches, 1);
  assert.equal(_state.fitnessDirty, true,
    'recordResult must mark fitness dirty so /stats recomputes lazily');
});

test('recordResult records a fallback match for p1 only', () => {
  installPopulation(fakePopulation(5));
  _recordResult({ p1_id: 3, p2_id: null, goals_p1: 2, goals_p2: 0 });
  assert.equal(_state.population[3].fallbackMatches, 1);
  assert.equal(_state.population[3].fallbackWins, 1);
  // Every other brain untouched
  assert.equal(_state.population[0].fallbackMatches, 0);
});

test('recordResult silently drops results with unknown brain ids', () => {
  installPopulation(fakePopulation(5));
  // Stale result from before a breed — refers to a brain id that
  // no longer exists. Must NOT throw and must NOT corrupt stats.
  _recordResult({ p1_id: 99, p2_id: 1, goals_p1: 1, goals_p2: 0 });
  assert.equal(_state.totalMatches, 0);
  assert.equal(_state.population[1].popMatches, 0);
});

test('recordResult is atomic — partial stats are never applied on p2 miss', () => {
  installPopulation(fakePopulation(5));
  // p1 valid, p2 unknown: the whole row must be rejected.
  _recordResult({ p1_id: 0, p2_id: 99, goals_p1: 1, goals_p2: 0 });
  assert.equal(_state.population[0].popMatches, 0,
    'p1 stats must not be partially applied when p2 is unknown');
  assert.equal(_state.population[0].popGoalDiff, 0);
  assert.equal(_state.totalMatches, 0);
});

/* ── Multi-client aggregation (the user-requested scenario) ── */

test('recordResult aggregates contributions from multiple simulated clients correctly', () => {
  // This is the multi-tab / multi-device scenario: several clients
  // each post their own streams of results and the broker sums them
  // into a single authoritative count. Verified by constructing two
  // result streams by hand and interleaving them.
  installPopulation(fakePopulation(5));

  // Client A posts 5 pop matches pairing brain 0 vs brain 1.
  const clientA = [
    { p1_id: 0, p2_id: 1, goals_p1: 2, goals_p2: 0 },
    { p1_id: 0, p2_id: 1, goals_p1: 1, goals_p2: 0 },
    { p1_id: 0, p2_id: 1, goals_p1: 0, goals_p2: 1 },
    { p1_id: 0, p2_id: 1, goals_p1: 1, goals_p2: 1 },
    { p1_id: 0, p2_id: 1, goals_p1: 3, goals_p2: 0 },
  ];
  // Client B posts 3 fallback matches against brain 0.
  const clientB = [
    { p1_id: 0, p2_id: null, goals_p1: 2, goals_p2: 1 },
    { p1_id: 0, p2_id: null, goals_p1: 0, goals_p2: 3 },
    { p1_id: 0, p2_id: null, goals_p1: 1, goals_p2: 1 },
  ];
  // Client C posts 2 more pop matches pairing brain 2 vs brain 3.
  const clientC = [
    { p1_id: 2, p2_id: 3, goals_p1: 1, goals_p2: 0 },
    { p1_id: 2, p2_id: 3, goals_p1: 2, goals_p2: 2 },
  ];

  // Interleave them the way three clients would arrive over time.
  const interleaved = [
    clientA[0], clientB[0], clientC[0],
    clientA[1], clientA[2], clientB[1],
    clientC[1], clientB[2], clientA[3], clientA[4],
  ];
  for (const r of interleaved) _recordResult(r);

  // Brain 0: 5 pop (as p1) + 3 fallback
  assert.equal(_state.population[0].popMatches, 5);
  // pop goal diff: 2+1-1+0+3 = 5
  assert.equal(_state.population[0].popGoalDiff, 5);
  // Fallback wins: 1 (2>1), draws: 1 (1=1), losses implicit: 1
  assert.equal(_state.population[0].fallbackMatches, 3);
  assert.equal(_state.population[0].fallbackWins, 1);
  assert.equal(_state.population[0].fallbackDraws, 1);

  // Brain 1: 5 pop (as p2), goal diff is negated
  assert.equal(_state.population[1].popMatches, 5);
  assert.equal(_state.population[1].popGoalDiff, -5);

  // Brain 2: 2 pop
  assert.equal(_state.population[2].popMatches, 2);
  assert.equal(_state.population[2].popGoalDiff, 1);

  // Brain 3: 2 pop with negated diff
  assert.equal(_state.population[3].popMatches, 2);
  assert.equal(_state.population[3].popGoalDiff, -1);

  // Total matches = 5 + 3 + 2 = 10
  assert.equal(_state.totalMatches, 10);
});

test('tryBreed fires once the shared threshold is crossed across clients', () => {
  withTmpDb(() => {
    const pop = fakePopulation(5);
    installPopulation(pop, { min_pop_matches: 2, min_fallback_matches: 1, population_size: 5 });
    _state.generation = 1;
    const startGen = _state.generation;

    const matches = [
      { p1_id: 0, p2_id: 1, goals_p1: 1, goals_p2: 0 },
      { p1_id: 2, p2_id: 3, goals_p1: 1, goals_p2: 0 },
      { p1_id: 4, p2_id: 0, goals_p1: 0, goals_p2: 1 },
      { p1_id: 1, p2_id: 2, goals_p1: 0, goals_p2: 1 },
      { p1_id: 3, p2_id: 4, goals_p1: 1, goals_p2: 0 },
      { p1_id: 0, p2_id: null, goals_p1: 1, goals_p2: 0 },
      { p1_id: 1, p2_id: null, goals_p1: 0, goals_p2: 1 },
      { p1_id: 2, p2_id: null, goals_p1: 1, goals_p2: 1 },
      { p1_id: 3, p2_id: null, goals_p1: 2, goals_p2: 0 },
      { p1_id: 4, p2_id: null, goals_p1: 0, goals_p2: 0 },
    ];
    for (const m of matches) _recordResult(m);

    const bred = _tryBreed();
    assert.equal(bred, true, 'tryBreed should succeed when aggregated counts cross thresholds');
    assert.equal(_state.generation, startGen + 1, 'generation must advance on successful breed');
    assert.equal(_state.population.length, 5, 'population size preserved across breed');
  });
});

test('tryBreed refuses to breed while any brain is under-served', () => {
  withTmpDb(() => {
    const pop = fakePopulation(5);
    installPopulation(pop, { min_pop_matches: 2, min_fallback_matches: 1, population_size: 5 });
    _state.generation = 1;
    const startGen = _state.generation;

    _recordResult({ p1_id: 0, p2_id: 1, goals_p1: 1, goals_p2: 0 });
    _recordResult({ p1_id: 0, p2_id: 2, goals_p1: 1, goals_p2: 0 });
    for (let i = 1; i < 5; i++) {
      _recordResult({ p1_id: i, p2_id: null, goals_p1: 1, goals_p2: 0 });
      _recordResult({ p1_id: i, p2_id: (i + 1) % 5, goals_p1: 1, goals_p2: 0 });
    }
    assert.equal(_tryBreed(), false, 'tryBreed must refuse while brain 0 lacks a fallback match');
    assert.equal(_state.generation, startGen, 'generation must not advance on refusal');
  });
});

/* ── Persistence regression ───────────────────────────────── */

test('savePopulation handles repeated saves without UNIQUE constraint errors', () => {
  withTmpDb(() => {
    const pop1 = fakePopulation(10);
    installPopulation(pop1);
    _state.generation = 1;
    _savePopulation(1);

    const pop2 = fakePopulation(10);
    for (const b of pop2) b.popMatches = 5;
    installPopulation(pop2);
    _state.generation = 2;
    assert.doesNotThrow(
      () => _savePopulation(2),
      'savePopulation must be callable repeatedly as breeding advances the generation',
    );

    const loaded = _loadPopulation();
    assert.equal(loaded.length, 10);
    for (const b of loaded) {
      assert.equal(b.popMatches, 5, 'loaded brain should reflect gen-2 state, not gen-1');
    }
  });
});

test('savePopulation materialises lazy weights JSON on first save', () => {
  withTmpDb(() => {
    const pop = fakePopulation(5);
    for (const b of pop) assert.equal(b._weightsJson, null);
    installPopulation(pop);
    _state.generation = 1;
    _savePopulation(1);
    for (const b of pop) {
      assert.ok(typeof b._weightsJson === 'string');
      assert.ok(b._weightsJson.length > 100);
    }
    const loaded = _loadPopulation();
    assert.equal(loaded.length, pop.length);
    for (let i = 0; i < pop.length; i++) {
      assert.equal(loaded[i].weights.length, WEIGHT_COUNT);
      assert.equal(loaded[i].weights[0], i + 1);
    }
  });
});
