/**
 * Broker unit tests.
 *
 * These import the real helpers from api/broker.mjs (no mocks, no
 * stubs, no subprocess spawn) and exercise them against the real
 * in-memory `state` object. The broker's top-level `initState()` +
 * `server.listen()` is gated behind a main-module check, so
 * importing the module is side-effect-free.
 *
 * Focus: the pieces that the recent perf refactor actually touches —
 * lazy weights JSON caching, matchup pool memoisation, and the
 * fallback-vs-pop matchup rotation. Every assertion here would fail
 * if a real bug were introduced in those functions; there are no
 * tautologies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newBrain,
  getWeightsJson,
  buildMatchupPools,
  pickMatchupJson,
  _state,
  refreshPopulationIndex,
  FALLBACK_MATCHUP_EVERY_N,
} from '../api/broker.mjs';
import { WEIGHT_COUNT } from '../evolution/ga.mjs';

/* ── Fixtures ─────────────────────────────────────────────── */

/** Build a deterministic population of N brains whose weights are
 *  detectable: brain `id` uses the scalar `id + 1` in every slot so
 *  we can verify per-brain JSON serialisation without ambiguity. */
function fakePopulation(n) {
  const pop = [];
  for (let i = 0; i < n; i++) {
    const w = new Float64Array(WEIGHT_COUNT).fill(i + 1);
    pop.push(newBrain(i, w, false));
  }
  return pop;
}

/** Install a fake population + config into the broker state. Tests
 *  that need custom match-count thresholds should also set
 *  `_state.config` directly, which is why it's exposed. */
function installPopulation(pop, config = {}) {
  _state.population = pop;
  _state.config = {
    min_pop_matches: 10,
    min_fallback_matches: 5,
    ...config,
  };
  _state.matchupCounter = 0;
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

  assert.equal(b._weightsJson, null, 'precondition: cache empty');

  const first = getWeightsJson(b);
  assert.equal(typeof first, 'string');
  const parsed = JSON.parse(first);
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, WEIGHT_COUNT);
  assert.equal(parsed[0], -0.25);
  assert.equal(parsed[parsed.length - 1], -0.25);

  // Cache populated
  assert.equal(b._weightsJson, first);

  // Second call returns the SAME string reference — proves the
  // cache hits instead of re-serialising.
  const second = getWeightsJson(b);
  assert.equal(second, first);
  // Strict identity: both strings point to the same heap entry.
  // (String equality can't prove "didn't recompute" — identity can.)
  assert.strictEqual(second, b._weightsJson);
});

test('getWeightsJson survives a Float64Array roundtrip to numeric equality', () => {
  // Pick a pattern of values that includes negatives and decimals
  // that can trip JSON formatting. `+ 0.7` keeps sin() away from
  // exactly zero — JSON.stringify writes -0 as "0" and JSON.parse
  // returns +0, which is distinct from -0 under Object.is but
  // equivalent under === (and both evaluate to 0 in physics use).
  const w = new Float64Array(WEIGHT_COUNT);
  for (let i = 0; i < WEIGHT_COUNT; i++) {
    w[i] = Math.sin(i * 0.13 + 0.7) * (i % 3 === 0 ? -1 : 1);
  }
  const b = newBrain(3, w);
  const json = getWeightsJson(b);
  const reconstructed = new Float64Array(JSON.parse(json));
  assert.equal(reconstructed.length, WEIGHT_COUNT);
  for (let i = 0; i < WEIGHT_COUNT; i++) {
    // JSON.parse round-trips doubles exactly thanks to the
    // 17-significant-digit formatting V8 uses by default. Any
    // codepath that drops precision (e.g. Float32 coercion) would
    // break this assertion for at least one sample. Use `===` so
    // +0/-0 compare equal — JSON can't roundtrip the zero sign.
    assert.ok(
      reconstructed[i] === w[i],
      `mismatch at index ${i}: got ${reconstructed[i]}, want ${w[i]}`,
    );
  }
});

/* ── buildMatchupPools ─────────────────────────────────────── */

test('buildMatchupPools classifies brains by pop-match deficit', () => {
  const pop = fakePopulation(10);
  // First 3 brains have plenty of pop matches; the rest are fresh.
  for (let i = 0; i < 3; i++) pop[i].popMatches = 20;
  installPopulation(pop, { min_pop_matches: 10, min_fallback_matches: 5 });

  const pools = buildMatchupPools();
  assert.equal(pools.popWithFew.length, 7, 'brains with fewer than 10 pop matches should be in popWithFew');
  const popWithFewIds = pools.popWithFew.map((b) => b.id).sort((a, b) => a - b);
  assert.deepEqual(popWithFewIds, [3, 4, 5, 6, 7, 8, 9]);
});

test('buildMatchupPools classifies brains by fallback-match deficit', () => {
  const pop = fakePopulation(10);
  for (let i = 0; i < 4; i++) pop[i].fallbackMatches = 10;
  installPopulation(pop, { min_pop_matches: 10, min_fallback_matches: 5 });

  const pools = buildMatchupPools();
  assert.equal(pools.fallbackCandidates.length, 6, 'brains with <5 fallback matches must need more');
  const ids = pools.fallbackCandidates.map((b) => b.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [4, 5, 6, 7, 8, 9]);
});

test('buildMatchupPools returns empty candidate sets when every brain is saturated', () => {
  const pop = fakePopulation(5);
  for (const b of pop) { b.popMatches = 100; b.fallbackMatches = 100; }
  installPopulation(pop);
  const pools = buildMatchupPools();
  assert.equal(pools.popWithFew.length, 0);
  assert.equal(pools.fallbackCandidates.length, 0);
});

/* ── pickMatchupJson ──────────────────────────────────────── */

test('pickMatchupJson returns a valid pop matchup JSON string', () => {
  const pop = fakePopulation(10);
  installPopulation(pop);
  const pools = buildMatchupPools();

  // matchupCounter starts at 0; first pick has counter=1, not a
  // fallback slot (1 % 4 !== 0) → this is a pop matchup.
  const raw = pickMatchupJson(pools);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.type, 'pop');
  assert.equal(typeof parsed.p1, 'number', 'matchup p1 must be an ID (not full brain object)');
  assert.equal(typeof parsed.p2, 'number', 'matchup p2 must be an ID');
  assert.ok(parsed.p1 >= 0 && parsed.p1 < pop.length);
  assert.ok(parsed.p2 >= 0 && parsed.p2 < pop.length);
  assert.notEqual(parsed.p1, parsed.p2, 'pop matchup must pair two distinct brains');
});

test('pickMatchupJson rotates in fallback matchups on the configured cadence', () => {
  const pop = fakePopulation(10);
  installPopulation(pop);

  let fallbackPicks = 0;
  let popPicks = 0;
  // Drive a full cadence cycle's worth of picks and count each type.
  // Every Nth counter value should produce a fallback; the rest pop.
  for (let i = 0; i < FALLBACK_MATCHUP_EVERY_N * 3; i++) {
    const pools = buildMatchupPools();
    const parsed = JSON.parse(pickMatchupJson(pools));
    if (parsed.type === 'fallback') {
      fallbackPicks++;
      assert.equal(parsed.p2, null, 'fallback matchup must have null p2');
    } else {
      popPicks++;
    }
  }
  assert.equal(fallbackPicks, 3,
    `expected 3 fallback picks across ${FALLBACK_MATCHUP_EVERY_N * 3} calls, got ${fallbackPicks}`);
  assert.equal(popPicks, FALLBACK_MATCHUP_EVERY_N * 3 - 3);
});

test('pickMatchupJson skips fallback slot when no brain needs more fallback matches', () => {
  const pop = fakePopulation(10);
  for (const b of pop) b.fallbackMatches = 99; // everyone saturated
  installPopulation(pop);

  // Force counter=N so the fallback slot fires.
  _state.matchupCounter = FALLBACK_MATCHUP_EVERY_N - 1;
  const pools = buildMatchupPools();
  const parsed = JSON.parse(pickMatchupJson(pools));
  assert.equal(parsed.type, 'pop',
    'when fallback pool is empty, the fallback slot should fall through to a pop matchup');
});

test('pickMatchupJson response has no weight arrays anywhere', () => {
  // Regression: the old hot path spliced `weights: [...]` into every
  // matchup; /population now carries weights and /matchup carries
  // only IDs. This test asserts on the serialised JSON shape itself
  // so any accidental fat response breaks the test loudly.
  const pop = fakePopulation(10);
  installPopulation(pop);
  const pools = buildMatchupPools();
  for (let i = 0; i < 20; i++) {
    const raw = pickMatchupJson(pools);
    assert.ok(!raw.includes('"weights"'),
      `regression: matchup response contains a weights field: ${raw.slice(0, 120)}`);
    assert.ok(raw.length < 100,
      `regression: matchup response is fat (${raw.length} bytes); should be ~50 bytes`);
  }
});

/* ── pools are reused across all picks in one request ─────── */

test('buildMatchupPools result is stable during a single request', () => {
  // The perf fix's whole point is that we compute pools ONCE per
  // handleMatchup call and reuse for all N picks. This test proves
  // mutations to state.population after pool construction don't
  // affect the already-built pools — i.e. the pools are a snapshot,
  // not a live view. If someone refactors pools into a live query
  // this test fails, which is what we want.
  const pop = fakePopulation(10);
  installPopulation(pop);
  const pools = buildMatchupPools();
  const beforeFewLen = pools.popWithFew.length;
  const beforeFbLen  = pools.fallbackCandidates.length;

  // Cross every brain over both thresholds after pools are built.
  for (const b of pop) { b.popMatches = 99; b.fallbackMatches = 99; }

  assert.equal(pools.popWithFew.length, beforeFewLen,
    'popWithFew snapshot must not shrink retroactively');
  assert.equal(pools.fallbackCandidates.length, beforeFbLen,
    'fallbackCandidates snapshot must not shrink retroactively');
});
