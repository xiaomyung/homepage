/**
 * Phase 2 unit tests for physics.js — covers all 4 bug fixes plus determinism.
 * Run with: node --test games/football/physics.test.mjs
 *
 * All tests inject a seeded PRNG so match outcomes are reproducible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createField,
  createState,
  createSeededRng,
  tick,
  buildInputs,
  FIELD_HEIGHT,
  MAX_PLAYER_SPEED,
} from './physics.js';

/* ── Test helpers ────────────────────────────────────────────── */

/** Standard no-op action vector — player stands still. */
const NOOP = [0, 0, -1, 0, 0, 0, 0, -1, 0];

/** Action vector for pure horizontal movement at full speed. */
function moveAction(mx, my = 0) {
  return [mx, my, -1, 0, 0, 0, 0, -1, 0];
}

/** Action vector for a push attempt at given power. */
function pushAction(power = 1) {
  return [0, 0, -1, 0, 0, 0, 0, 1, power];
}

/** Fresh state with seeded RNG and grace frames zeroed for goal-line tests. */
function freshState(seed = 42) {
  const field = createField();
  const rng = createSeededRng(seed);
  const state = createState(field, rng);
  state.graceFrames = 0;
  return state;
}

/* ── Test 1: stamina charged from actual displacement ──────── */

test('stamina drains when player moves at full speed', () => {
  const state = freshState();
  // Start p1 at x=200 so 40 ticks of rightward movement won't hit the edge
  state.p1.x = 200;
  const startX = state.p1.x;
  assert.equal(state.p1.stamina, 1);

  for (let i = 0; i < 40; i++) {
    tick(state, moveAction(1), NOOP);
  }

  // Player must have moved meaningfully
  const movedDist = state.p1.x - startX;
  assert.ok(movedDist > 100, `expected player to have moved far, got ${movedDist}`);

  // And stamina must have dropped — fix #1's whole point: displacement costs
  // stamina, regardless of how the displacement was produced.
  assert.ok(state.p1.stamina < 1, `stamina must decrease, got ${state.p1.stamina}`);
  assert.ok(state.p1.stamina > 0.5, `stamina drained too fast: ${state.p1.stamina}`);
});

test('stationary player does not drain stamina beyond regen', () => {
  const state = freshState();
  // p1 stands still for 100 ticks with no-op action
  for (let i = 0; i < 100; i++) {
    tick(state, NOOP, NOOP);
  }
  // Stamina should remain at 1 (regen caps it)
  assert.equal(state.p1.stamina, 1);
  assert.equal(state.p2.stamina, 1);
});

test('player pushed while standing still is still charged for displacement', () => {
  const state = freshState();
  // Position p1 and p2 adjacent so p1 can push p2
  state.p1.x = state.field.midX - 10;
  state.p2.x = state.field.midX + 10;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;

  const p2StartX = state.p2.x;
  const p2StartStamina = state.p2.stamina;

  // p1 pushes, p2 does nothing
  tick(state, pushAction(1), NOOP);
  // Run push physics for several ticks to let pushVx decay
  for (let i = 0; i < 20; i++) {
    tick(state, NOOP, NOOP);
  }

  // p2 should have been displaced by the push
  assert.ok(state.p2.x > p2StartX + 5, `p2 should have been pushed; moved ${state.p2.x - p2StartX}`);
  // p2 stamina should drop from the displacement (plus the push-victim direct drain)
  assert.ok(state.p2.stamina < p2StartStamina, 'push victim stamina must drop');
});

/* ── Test 2: goal frame collision (fix #2) ──────────────────── */

test('player cannot penetrate left goal frame', () => {
  const state = freshState();
  const f = state.field;
  // Position p1 just outside the right edge of the left goal box
  state.p1.x = f.goalLRight + 1;
  state.p1.y = FIELD_HEIGHT / 2;

  // Walk into the goal for 30 ticks
  for (let i = 0; i < 30; i++) {
    tick(state, moveAction(-1), NOOP);
  }

  // p1.x must never be less than goalLRight (can't enter the goal box)
  assert.ok(
    state.p1.x >= f.goalLRight - 0.01,
    `player penetrated left goal frame: x=${state.p1.x}, goalLRight=${f.goalLRight}`
  );
});

test('player cannot penetrate right goal frame', () => {
  const state = freshState();
  const f = state.field;
  state.p2.x = f.goalRLeft - f.playerWidth - 1;
  state.p2.y = FIELD_HEIGHT / 2;

  for (let i = 0; i < 30; i++) {
    tick(state, NOOP, moveAction(1));
  }

  assert.ok(
    state.p2.x + f.playerWidth <= f.goalRLeft + 0.01,
    `player penetrated right goal frame: x=${state.p2.x}`
  );
});

/* ── Test 3: push always lands when in range (fix #3) ──────── */

test('push lands when players are in contact range', () => {
  const state = freshState();
  // Position them overlapping in both axes, well within push range
  state.p1.x = state.field.midX - 10;
  state.p2.x = state.field.midX + 10;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;

  tick(state, pushAction(1), NOOP);

  // p2 should have non-zero pushVx after the tick
  assert.ok(
    state.p2.pushVx !== 0,
    `push did not land: p2.pushVx=${state.p2.pushVx}`
  );
  // The pusher should have entered push cooldown
  assert.ok(state.p1.pushTimer > 0, 'pusher should have cooldown');
  // Events should include a 'push' event
  assert.ok(
    state.events.some(e => e.type === 'push'),
    `no push event emitted: ${JSON.stringify(state.events)}`
  );
});

test('push does not land when players are out of range', () => {
  const state = freshState();
  // Separate them far beyond push range
  state.p1.x = 100;
  state.p2.x = state.field.width - 100;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;

  tick(state, pushAction(1), NOOP);

  assert.equal(state.p2.pushVx, 0, 'push should not land across the field');
  assert.ok(
    !state.events.some(e => e.type === 'push'),
    'no push event expected out of range'
  );
});

/* ── Test 4: OOB before goal, strict ordering (fix #4) ──────── */

test('ball past the OOB margin triggers out, not goal', () => {
  const state = freshState();
  const f = state.field;
  // Place the ball far past the right-edge OOB margin with outward velocity
  state.ball.x = f.width + 100;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 5;
  state.ball.vy = 0;
  state.ball.vz = 0;

  tick(state, NOOP, NOOP);

  assert.ok(state.ball.frozen, 'ball must be frozen after OOB');
  assert.ok(
    state.events.some(e => e.type === 'out'),
    'out event expected'
  );
  assert.ok(
    !state.events.some(e => e.type === 'goal'),
    'no goal event should fire when ball is OOB'
  );
  assert.equal(state.scoreL, 0);
  assert.equal(state.scoreR, 0);
});

test('ball above crossbar crossing goal line bounces off the crossbar', () => {
  const state = freshState();
  const f = state.field;
  // Place ball just past the right goal line, inside the mouth Y range,
  // but above the crossbar z, moving +x (into the goal from the field)
  state.ball.x = f.goalLineR + 5;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = f.goalMouthZMax + 10;
  state.ball.vx = 3;
  state.ball.vy = 0;
  state.ball.vz = 0;

  tick(state, NOOP, NOOP);

  assert.equal(state.scoreL, 0, 'ball above crossbar must not score');
  assert.equal(state.scoreR, 0);
  assert.ok(
    !state.events.some(e => e.type === 'goal'),
    'no goal event when above crossbar'
  );
  // Ball should bounce back (velocity reversed, position pushed back past line)
  assert.ok(state.ball.vx < 0, `expected vx to be reversed, got ${state.ball.vx}`);
  assert.ok(state.ball.x <= f.goalLineR, `expected ball pushed back, got x=${state.ball.x}`);
});

test('ball crossing goal line outside mouth Y range bounces off the post', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = f.goalLineR + 2;
  state.ball.y = f.goalMouthYMin - 3; // outside mouth Y range
  state.ball.z = 0;
  state.ball.vx = 4;
  state.ball.vy = 0;
  state.ball.vz = 0;

  tick(state, NOOP, NOOP);

  assert.equal(state.scoreL, 0, 'post-bounce must not score');
  assert.ok(state.ball.vx < 0, `expected vx reversed, got ${state.ball.vx}`);
});

/* ── Test 5: a valid goal scores ────────────────────────────── */

test('ball in mouth, below crossbar, crossing line scores for the other side', () => {
  const state = freshState();
  const f = state.field;
  // Place ball just past the right goal line, inside the mouth, on the ground
  state.ball.x = f.goalLineR + 1;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 0.5;
  state.ball.vy = 0;
  state.ball.vz = 0;

  tick(state, NOOP, NOOP);

  // Ball crossed goalLineR → right goal conceded → LEFT scores
  assert.equal(state.scoreL, 1, 'left should have scored into right goal');
  assert.equal(state.scoreR, 0);
  assert.ok(
    state.events.some(e => e.type === 'goal' && e.scorer === 'p1'),
    `goal event missing: ${JSON.stringify(state.events)}`
  );
  // Ball must be frozen post-goal
  assert.ok(state.ball.frozen, 'ball must freeze after goal');
  // Pause state must be celebrate
  assert.equal(state.pauseState, 'celebrate');
});

/* ── Test 6: determinism with seeded PRNG ───────────────────── */

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

/* ── Bonus: buildInputs shape ───────────────────────────────── */

test('buildInputs produces 18 floats in [-1, 1]', () => {
  const state = freshState();
  state.p1.x = 100;
  state.ball.vx = 5;
  const inputs = buildInputs(state, 'p1');
  assert.equal(inputs.length, 18);
  for (const v of inputs) {
    assert.ok(v >= -1 && v <= 1, `input out of range: ${v}`);
    assert.ok(Number.isFinite(v), `non-finite input: ${v}`);
  }
});
