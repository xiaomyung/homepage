/**
 * Unit tests for the tanh-normalised fitness on the pop axis.
 * Replaced the hard-clamped `avgDiff / maxGoalDiff` with
 * `tanh(avgDiff / k)` so nil-nil draws don't divide by zero and
 * blowouts saturate smoothly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFitness,
  makeFitnessWeights,
} from '../evolution/ga.mjs';

function brain(overrides = {}) {
  return {
    popMatches: 0,
    popGoalDiff: 0,
    fallbackMatches: 0,
    fallbackWins: 0,
    fallbackDraws: 0,
    ...overrides,
  };
}

const W = makeFitnessWeights({ wPop: 0.5, wFallback: 0.5, goalDiffScale: 2 });

test('no matches played → fitness 0', () => {
  assert.equal(computeFitness(brain(), W), 0);
});

test('zero goal diff (draw) → pop axis 0.5 (not NaN)', () => {
  const b = brain({ popMatches: 10, popGoalDiff: 0 });
  const f = computeFitness(b, W);
  // Only pop axis has data; fb axis falls back to 0.5. Both 0.5 → total 0.5.
  assert.equal(f, 0.5 * 0.5 + 0.5 * 0.5);
  assert.ok(Number.isFinite(f));
});

test('narrow positive lead produces positive signal', () => {
  const b = brain({ popMatches: 10, popGoalDiff: 5 });  // avg 0.5 per match
  const f = computeFitness(b, W);
  // tanh(0.5/2) ≈ 0.245 → popScore ≈ 0.622. Total = 0.5*0.622 + 0.5*0.5 ≈ 0.561.
  assert.ok(f > 0.55 && f < 0.58, `expected ~0.56, got ${f}`);
});

test('symmetric negative lead lands below 0.5', () => {
  const b = brain({ popMatches: 10, popGoalDiff: -5 });
  const f = computeFitness(b, W);
  assert.ok(f < 0.45 && f > 0.42, `expected ~0.44, got ${f}`);
});

test('blowout saturates toward 1 on pop axis without clipping artifacts', () => {
  const big = computeFitness(brain({ popMatches: 10, popGoalDiff: 100 }), W);
  const huge = computeFitness(brain({ popMatches: 10, popGoalDiff: 1000 }), W);
  // Both should be within ε of the same value because tanh saturates.
  // tanh(5) vs tanh(50) is a ~4e-5 gap in popScore; wPop=0.5 halves it.
  assert.ok(Math.abs(big - huge) < 1e-4, `blowout mismatch: big=${big} huge=${huge}`);
});

test('k=2 scaling: one-goal lead maps to tanh(0.5)-range signal', () => {
  // popGoalDiff of 1 per match → avg 1 → tanh(0.5) ≈ 0.462 → popScore ≈ 0.731.
  const b = brain({ popMatches: 10, popGoalDiff: 10 });
  const popOnlyW = makeFitnessWeights({ wPop: 1, wFallback: 0, goalDiffScale: 2 });
  const f = computeFitness(b, popOnlyW);
  assert.ok(Math.abs(f - ((Math.tanh(0.5) + 1) / 2)) < 1e-10);
});

test('legacy maxGoalDiff keyword is accepted as the scale', () => {
  const wLegacy = makeFitnessWeights({ wPop: 1, wFallback: 0, maxGoalDiff: 2 });
  const wNew    = makeFitnessWeights({ wPop: 1, wFallback: 0, goalDiffScale: 2 });
  const b = brain({ popMatches: 10, popGoalDiff: 10 });
  assert.equal(computeFitness(b, wLegacy), computeFitness(b, wNew));
});

test('fallback axis alone maps wins to score', () => {
  const b = brain({ fallbackMatches: 10, fallbackWins: 7, fallbackDraws: 2 });
  const fbOnlyW = makeFitnessWeights({ wPop: 0, wFallback: 1, goalDiffScale: 2 });
  // (7 + 0.5*2) / 10 = 0.8
  assert.equal(computeFitness(b, fbOnlyW), 0.8);
});
