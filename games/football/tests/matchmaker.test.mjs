/**
 * Matchmaker unit tests.
 *
 * These exercise the pure functions in matchmaker.js against fixed
 * populations + fixed counts. Every assertion fails loudly if the
 * selection algorithm regresses — no tautologies, no mocks of the
 * code under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickMatchup,
  pickMatchups,
  emptyCounts,
  applyResultToCounts,
  reconcileCounts,
  FALLBACK_MATCHUP_EVERY_N,
} from '../matchmaker.js';

/* ── Fixtures ─────────────────────────────────────────────── */

function fakePop(n) {
  const pop = [];
  for (let i = 0; i < n; i++) pop.push({ id: i });
  return pop;
}

function emptyCountsMap(n) {
  const m = new Map();
  for (let i = 0; i < n; i++) m.set(i, emptyCounts());
  return m;
}

/** Deterministic RNG for reproducible picks. */
function seededRng(seed = 42) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const CFG = { min_pop_matches: 10, min_fallback_matches: 5 };

/* ── pickMatchup: shape + basic invariants ─────────────────── */

test('pickMatchup returns a valid pop matchup when counter is not on a fallback slot', () => {
  const pop = fakePop(10);
  const counts = emptyCountsMap(10);
  const m = pickMatchup(pop, counts, CFG, 1, seededRng(1));
  assert.equal(m.type, 'pop');
  assert.equal(typeof m.p1, 'number');
  assert.equal(typeof m.p2, 'number');
  assert.ok(m.p1 !== m.p2, 'pop matchup must pair two distinct brains');
  assert.ok(m.p1 >= 0 && m.p1 < 10);
  assert.ok(m.p2 >= 0 && m.p2 < 10);
});

test('pickMatchup returns a fallback matchup on the cadence slot', () => {
  const pop = fakePop(10);
  const counts = emptyCountsMap(10);
  const m = pickMatchup(pop, counts, CFG, FALLBACK_MATCHUP_EVERY_N, seededRng(1));
  assert.equal(m.type, 'fallback');
  assert.equal(m.p2, null);
  assert.ok(m.p1 >= 0 && m.p1 < 10);
});

test('pickMatchup falls through to pop when every brain is fallback-saturated', () => {
  const pop = fakePop(10);
  const counts = emptyCountsMap(10);
  for (const [, c] of counts) c.fallbackMatches = 100; // everyone saturated
  // Counter is on a fallback slot — but the fallback pool is empty.
  const m = pickMatchup(pop, counts, CFG, FALLBACK_MATCHUP_EVERY_N, seededRng(1));
  assert.equal(m.type, 'pop', 'empty fallback pool should fall through to pop');
});

test('pickMatchup throws on empty population', () => {
  assert.throws(() => pickMatchup([], new Map(), CFG, 1, seededRng(1)), /empty/);
});

test('pickMatchup throws if fewer than 2 brains available for a pop matchup', () => {
  const pop = [{ id: 0 }];
  const counts = new Map([[0, emptyCounts()]]);
  assert.throws(
    () => pickMatchup(pop, counts, CFG, 1, seededRng(1)),
    /at least 2/,
  );
});

/* ── pickMatchup: deficit-first preference ─────────────────── */

test('pickMatchup prefers brains below the pop-match threshold', () => {
  const pop = fakePop(10);
  const counts = emptyCountsMap(10);
  // Brains 0-7 are fully served; 8 and 9 are fresh.
  for (let i = 0; i < 8; i++) counts.get(i).popMatches = 50;
  // Force many draws and verify 8/9 dominate the results.
  const rng = seededRng(123);
  const picks = new Map();
  for (let i = 1; i < 400; i++) {
    if (i % FALLBACK_MATCHUP_EVERY_N === 0) continue; // skip fallback slots
    const m = pickMatchup(pop, counts, CFG, i, rng);
    picks.set(m.p1, (picks.get(m.p1) || 0) + 1);
    picks.set(m.p2, (picks.get(m.p2) || 0) + 1);
  }
  // Brain 8 and 9 should each appear way more often than any of 0-7.
  const needy = (picks.get(8) || 0) + (picks.get(9) || 0);
  const served = Array.from({ length: 8 }, (_, i) => picks.get(i) || 0).reduce((a, b) => a + b, 0);
  assert.ok(needy > served * 5,
    `under-served brains 8+9 should dominate picks: needy=${needy}, served=${served}`);
});

test('pickMatchup prefers brains below the fallback-match threshold', () => {
  const pop = fakePop(10);
  const counts = emptyCountsMap(10);
  // Only brains 7-9 need more fallback matches.
  for (let i = 0; i < 7; i++) counts.get(i).fallbackMatches = 100;
  const rng = seededRng(99);
  const fallbackPicks = new Map();
  for (let i = FALLBACK_MATCHUP_EVERY_N; i < 400; i += FALLBACK_MATCHUP_EVERY_N) {
    const m = pickMatchup(pop, counts, CFG, i, rng);
    if (m.type === 'fallback') {
      fallbackPicks.set(m.p1, (fallbackPicks.get(m.p1) || 0) + 1);
    }
  }
  // Every fallback pick must be one of {7, 8, 9}.
  for (const [id] of fallbackPicks) {
    assert.ok(id >= 7, `fallback picker chose saturated brain ${id}`);
  }
  // And 7/8/9 should each have received picks (no starvation).
  assert.ok((fallbackPicks.get(7) || 0) > 0);
  assert.ok((fallbackPicks.get(8) || 0) > 0);
  assert.ok((fallbackPicks.get(9) || 0) > 0);
});

/* ── Determinism via seeded rng ────────────────────────────── */

test('pickMatchup is deterministic given the same seeded rng', () => {
  const pop = fakePop(10);
  const counts = emptyCountsMap(10);
  const runs = [];
  for (let r = 0; r < 2; r++) {
    const rng = seededRng(2026);
    const picks = [];
    for (let i = 1; i < 50; i++) picks.push(pickMatchup(pop, counts, CFG, i, rng));
    runs.push(picks);
  }
  assert.deepEqual(runs[0], runs[1], 'same seed → same matchup stream');
});

/* ── pickMatchups (batch variant) ──────────────────────────── */

test('pickMatchups produces N matchups and advances the counter by N', () => {
  const pop = fakePop(10);
  const counts = emptyCountsMap(10);
  const { matchups, counter } = pickMatchups(pop, counts, CFG, 100, 20, seededRng(7));
  assert.equal(matchups.length, 20);
  assert.equal(counter, 120);
  for (const m of matchups) {
    assert.ok(m.type === 'pop' || m.type === 'fallback');
    assert.equal(typeof m.p1, 'number');
  }
});

test('pickMatchups maintains the fallback cadence across the batch boundary', () => {
  const pop = fakePop(10);
  const counts = emptyCountsMap(10);
  // Start at counter=0 so slots 4, 8, 12, 16, 20 fire.
  const { matchups } = pickMatchups(pop, counts, CFG, 0, 20, seededRng(11));
  // Exactly 5 fallbacks expected across 20 picks at counter 1..20.
  const fbCount = matchups.filter((m) => m.type === 'fallback').length;
  assert.equal(fbCount, 5,
    `expected 5 fallback matchups in a 20-batch at cadence ${FALLBACK_MATCHUP_EVERY_N}, got ${fbCount}`);
});

/* ── applyResultToCounts ───────────────────────────────────── */

test('applyResultToCounts records a pop win correctly for both sides', () => {
  const counts = emptyCountsMap(5);
  const ok = applyResultToCounts(counts, { p1_id: 1, p2_id: 2, goals_p1: 3, goals_p2: 1 });
  assert.equal(ok, true);
  assert.equal(counts.get(1).popMatches, 1);
  assert.equal(counts.get(1).popGoalDiff, 2);
  assert.equal(counts.get(2).popMatches, 1);
  assert.equal(counts.get(2).popGoalDiff, -2);
});

test('applyResultToCounts records a fallback match for p1 only', () => {
  const counts = emptyCountsMap(5);
  applyResultToCounts(counts, { p1_id: 3, p2_id: null, goals_p1: 2, goals_p2: 0 });
  assert.equal(counts.get(3).fallbackMatches, 1);
  assert.equal(counts.get(3).fallbackWins, 1);
  assert.equal(counts.get(3).fallbackDraws, 0);
  // Other brains untouched
  assert.equal(counts.get(0).fallbackMatches, 0);
});

test('applyResultToCounts counts a draw against the fallback', () => {
  const counts = emptyCountsMap(5);
  applyResultToCounts(counts, { p1_id: 0, p2_id: null, goals_p1: 1, goals_p2: 1 });
  assert.equal(counts.get(0).fallbackDraws, 1);
  assert.equal(counts.get(0).fallbackWins, 0);
});

test('applyResultToCounts returns false for unknown p1 id and does nothing', () => {
  const counts = emptyCountsMap(5);
  const ok = applyResultToCounts(counts, { p1_id: 99, p2_id: 1, goals_p1: 1, goals_p2: 0 });
  assert.equal(ok, false);
  // All counts remain zero
  for (const [, c] of counts) {
    assert.equal(c.popMatches, 0);
    assert.equal(c.fallbackMatches, 0);
  }
});

test('applyResultToCounts returns false when p2_id is unknown in a pop match', () => {
  const counts = emptyCountsMap(5);
  const ok = applyResultToCounts(counts, { p1_id: 0, p2_id: 99, goals_p1: 1, goals_p2: 0 });
  assert.equal(ok, false);
  // p1 stats must NOT be partially applied (atomicity)
  assert.equal(counts.get(0).popMatches, 0);
  assert.equal(counts.get(0).popGoalDiff, 0);
});

/* ── reconcileCounts (broker sync) ─────────────────────────── */

test('reconcileCounts overwrites local values with broker-authoritative snapshot', () => {
  const counts = emptyCountsMap(3);
  // Simulate local-only work that hasn't synced yet.
  counts.get(0).popMatches = 3;
  counts.get(1).fallbackWins = 1;
  // Broker sends its authoritative view.
  const server = [
    { id: 0, popMatches: 8, popGoalDiff: 2, fallbackMatches: 2, fallbackWins: 1, fallbackDraws: 0 },
    { id: 1, popMatches: 5, popGoalDiff: -1, fallbackMatches: 1, fallbackWins: 0, fallbackDraws: 1 },
    { id: 2, popMatches: 1, popGoalDiff: 0, fallbackMatches: 0, fallbackWins: 0, fallbackDraws: 0 },
  ];
  reconcileCounts(counts, server);
  assert.equal(counts.get(0).popMatches, 8);
  assert.equal(counts.get(0).popGoalDiff, 2);
  assert.equal(counts.get(1).fallbackWins, 0);
  assert.equal(counts.get(1).fallbackDraws, 1);
  assert.equal(counts.get(2).popMatches, 1);
});

test('reconcileCounts creates entries for brains that appeared after last sync', () => {
  const counts = new Map(); // completely empty
  reconcileCounts(counts, [
    { id: 7, popMatches: 3, popGoalDiff: 1, fallbackMatches: 0, fallbackWins: 0, fallbackDraws: 0 },
  ]);
  assert.equal(counts.size, 1);
  assert.equal(counts.get(7).popMatches, 3);
  assert.equal(counts.get(7).popGoalDiff, 1);
});
