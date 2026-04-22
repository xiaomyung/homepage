/**
 * Fitness is now a plain weighted win-rate blend:
 *   pop_win_rate = (pop_wins + 0.5 * pop_draws) / pop_matches
 *   fb_win_rate  = (fb_wins  + 0.5 * fb_draws)  / fb_matches
 *   fitness      = wPop * pop_win_rate + wFallback * fb_win_rate
 * No tanh, no goal-diff normalisation.
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
    popWins: 0,
    popDraws: 0,
    popGoalDiff: 0,
    fallbackMatches: 0,
    fallbackWins: 0,
    fallbackDraws: 0,
    ...overrides,
  };
}

const W = makeFitnessWeights({ wPop: 0.5, wFallback: 0.5 });

test('no matches played → fitness 0', () => {
  assert.equal(computeFitness(brain(), W), 0);
});

test('pop wins and draws count on the pop axis', () => {
  const b = brain({ popMatches: 10, popWins: 7, popDraws: 2 });
  // pop_win_rate = (7 + 0.5*2) / 10 = 0.8. fb axis missing → neutral 0.5.
  const f = computeFitness(b, W);
  assert.equal(f, 0.5 * 0.8 + 0.5 * 0.5);
});

test('pop stalemate (all draws) lands at 0.5 on pop axis', () => {
  const b = brain({ popMatches: 10, popDraws: 10 });
  const popOnlyW = makeFitnessWeights({ wPop: 1, wFallback: 0 });
  assert.equal(computeFitness(b, popOnlyW), 0.5);
});

test('pop all losses lands at 0 on pop axis', () => {
  const b = brain({ popMatches: 10 });
  const popOnlyW = makeFitnessWeights({ wPop: 1, wFallback: 0 });
  assert.equal(computeFitness(b, popOnlyW), 0);
});

test('pop all wins lands at 1 on pop axis', () => {
  const b = brain({ popMatches: 10, popWins: 10 });
  const popOnlyW = makeFitnessWeights({ wPop: 1, wFallback: 0 });
  assert.equal(computeFitness(b, popOnlyW), 1);
});

test('fallback axis independent of pop axis', () => {
  const b = brain({ fallbackMatches: 10, fallbackWins: 8, fallbackDraws: 1 });
  const fbOnlyW = makeFitnessWeights({ wPop: 0, wFallback: 1 });
  // (8 + 0.5*1) / 10 = 0.85
  assert.equal(computeFitness(b, fbOnlyW), 0.85);
});

test('mixed data: blended axes', () => {
  const b = brain({
    popMatches: 10, popWins: 4, popDraws: 2,                  // 0.5
    fallbackMatches: 10, fallbackWins: 10, fallbackDraws: 0,  // 1.0
  });
  assert.equal(computeFitness(b, W), 0.5 * 0.5 + 0.5 * 1.0);
});

test('absent axis uses 0.5 neutral', () => {
  // fallback only
  const b = brain({ fallbackMatches: 10, fallbackWins: 10 });
  assert.equal(computeFitness(b, W), 0.5 * 0.5 + 0.5 * 1.0);
});

test('fitness bounded in [0, 1]', () => {
  const worst = computeFitness(brain({ popMatches: 10, fallbackMatches: 10 }), W);
  const best = computeFitness(brain({
    popMatches: 10, popWins: 10,
    fallbackMatches: 10, fallbackWins: 10,
  }), W);
  assert.equal(worst, 0);
  assert.equal(best, 1);
});
