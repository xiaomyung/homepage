import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createField,
  createState,
  createSeededRng,
  resetStateInPlace,
  tick,
} from '../../physics/index.js';
import {
  freshState,
} from '../helpers/state.mjs';

test('1000-tick deterministic trajectory with seeded PRNG', () => {
  // Run 1000 ticks twice with the same seed and same action sequence.
  // Every state fingerprint must match exactly.
  function runSeed(seed, numTicks) {
    const state = freshState(seed);
    // Use the injected rng to generate pseudo-random action vectors
    // (we can't just read state.rng because it's consumed by physics —
    // create a separate action-rng with the same seed).
    const actRng = createSeededRng(seed ^ 0xdeadbeef);
    const trajectory = [];
    for (let i = 0; i < numTicks; i++) {
      const p1Act = [
        actRng() * 2 - 1, actRng() * 2 - 1,
        actRng() > 0.8 ? 1 : -1,
        actRng() * 2 - 1, actRng() * 2 - 1, actRng() * 2 - 1,
        actRng() * 2 - 1,
        actRng() > 0.8 ? 1 : -1,
        actRng() * 2 - 1,
      ];
      const p2Act = [
        actRng() * 2 - 1, actRng() * 2 - 1,
        actRng() > 0.8 ? 1 : -1,
        actRng() * 2 - 1, actRng() * 2 - 1, actRng() * 2 - 1,
        actRng() * 2 - 1,
        actRng() > 0.8 ? 1 : -1,
        actRng() * 2 - 1,
      ];
      tick(state, p1Act, p2Act);
      trajectory.push([
        state.p1.x, state.p1.y, state.p1.stamina,
        state.p2.x, state.p2.y, state.p2.stamina,
        state.ball.x, state.ball.y, state.ball.z,
        state.scoreL, state.scoreR,
      ]);
    }
    return trajectory;
  }

  const run1 = runSeed(12345, 1000);
  const run2 = runSeed(12345, 1000);

  assert.equal(run1.length, run2.length);
  for (let i = 0; i < run1.length; i++) {
    for (let j = 0; j < run1[i].length; j++) {
      assert.equal(
        run1[i][j],
        run2[i][j],
        `divergence at tick ${i}, field ${j}: ${run1[i][j]} vs ${run2[i][j]}`
      );
    }
  }
});

test('different seeds produce different trajectories', () => {
  function fingerprint(seed) {
    const state = freshState(seed);
    const actRng = createSeededRng(seed ^ 0xfeedface);
    for (let i = 0; i < 500; i++) {
      const act = [
        actRng() * 2 - 1, actRng() * 2 - 1,
        actRng() > 0.5 ? 1 : -1,
        actRng() * 2 - 1, actRng() * 2 - 1, actRng() * 2 - 1,
        actRng() * 2 - 1,
        actRng() > 0.5 ? 1 : -1,
        actRng() * 2 - 1,
      ];
      tick(state, act, null);
    }
    return state.p1.x;
  }
  // Different seeds should lead to different player positions after 500 ticks
  assert.notEqual(fingerprint(1), fingerprint(2));
});

test('resetStateInPlace: object references are preserved', () => {
  const field = createField();
  const state = createState(field, createSeededRng(1));
  const ballRef = state.ball;
  const p1Ref = state.p1;
  const p2Ref = state.p2;
  const p1KickRef = state.p1.kick;
  const p2KickRef = state.p2.kick;
  const eventsRef = state.events;

  // Dirty the state so reset has work to do.
  state.scoreL = 2;
  state.scoreR = 1;
  state.tick = 500;
  state.ball.x = 123; state.ball.vx = 45;
  state.p1.kick.active = true; state.p1.kick.timer = 5;
  state.events.push({ type: 'goal', scorer: 'p1' });

  resetStateInPlace(state, field, createSeededRng(2));

  assert.equal(state.ball, ballRef, 'ball object must be reused');
  assert.equal(state.p1, p1Ref, 'p1 object must be reused');
  assert.equal(state.p2, p2Ref, 'p2 object must be reused');
  assert.equal(state.p1.kick, p1KickRef, 'p1.kick object must be reused');
  assert.equal(state.p2.kick, p2KickRef, 'p2.kick object must be reused');
  assert.equal(state.events, eventsRef, 'events array must be reused');
});

test('resetStateInPlace: counters and flags are reset', () => {
  const field = createField();
  const state = createState(field, createSeededRng(1));

  state.scoreL = 2;
  state.scoreR = 3;
  state.tick = 999;
  state.stallCount = 4;
  state.matchOver = true;
  state.winner = 'left';
  state.pauseState = 'matchend';
  state.pauseTimer = 12;
  state.goalScorer = state.p1;
  state.headless = true;
  state.recordEvents = true;
  state.events.push({ type: 'out' });
  state.p1.vx = 7; state.p1.stamina = 0.2;
  state.p1.kick.active = true; state.p1.pushTimer = 3;

  resetStateInPlace(state, field, createSeededRng(2));

  assert.equal(state.scoreL, 0);
  assert.equal(state.scoreR, 0);
  assert.equal(state.tick, 0);
  assert.equal(state.stallCount, 0);
  assert.equal(state.matchOver, false);
  assert.equal(state.winner, null);
  assert.equal(state.pauseState, null);
  assert.equal(state.pauseTimer, 0);
  assert.equal(state.goalScorer, null);
  assert.equal(state.headless, false);
  assert.equal(state.recordEvents, false);
  assert.equal(state.events.length, 0);
  assert.equal(state.p1.vx, 0);
  assert.equal(state.p1.stamina, 1);
  assert.equal(state.p1.kick.active, false);
  assert.equal(state.p1.pushTimer, 0);
});

test('resetStateInPlace: equivalent to createState for subsequent ticking', () => {
  const SEED = 12345;
  const TICKS = 300;

  // Path A — fresh state.
  const fieldA = createField();
  const stateA = createState(fieldA, createSeededRng(SEED));
  stateA.graceFrames = 0;
  for (let i = 0; i < TICKS; i++) tick(stateA, null, null);

  // Path B — dirty an old state then reset it with the same seed.
  const fieldB = createField();
  const stateB = createState(fieldB, createSeededRng(99));
  // Burn some ticks to mutate the object meaningfully before resetting.
  for (let i = 0; i < 50; i++) tick(stateB, null, null);
  stateB.scoreL = 2; stateB.ball.x = 500; stateB.ball.vx = 10;
  resetStateInPlace(stateB, fieldB, createSeededRng(SEED));
  stateB.graceFrames = 0;
  for (let i = 0; i < TICKS; i++) tick(stateB, null, null);

  assert.equal(stateA.tick, stateB.tick);
  assert.equal(stateA.scoreL, stateB.scoreL);
  assert.equal(stateA.scoreR, stateB.scoreR);
  assert.ok(Math.abs(stateA.ball.x - stateB.ball.x) < 1e-9);
  assert.ok(Math.abs(stateA.ball.y - stateB.ball.y) < 1e-9);
  assert.ok(Math.abs(stateA.ball.vx - stateB.ball.vx) < 1e-9);
  assert.ok(Math.abs(stateA.ball.vy - stateB.ball.vy) < 1e-9);
  assert.ok(Math.abs(stateA.p1.x - stateB.p1.x) < 1e-9);
  assert.ok(Math.abs(stateA.p2.x - stateB.p2.x) < 1e-9);
});

test('resetStateInPlace: swapping the rng produces a different stream than before', () => {
  const field = createField();
  const state = createState(field, createSeededRng(1));
  resetStateInPlace(state, field, createSeededRng(1));
  const a1 = state.rng(), a2 = state.rng();

  resetStateInPlace(state, field, createSeededRng(2));
  const b1 = state.rng(), b2 = state.rng();

  assert.notEqual(a1, b1, 'different seed must advance to a different first value');
  assert.notEqual(a2, b2, 'different seed must advance to a different second value');
});
