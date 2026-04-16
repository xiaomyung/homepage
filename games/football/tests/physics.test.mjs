/**
 * Unit tests for physics.js — covers the 4 v1-bug fixes, field containment,
 * strict goal scoring, and determinism. All tests use a seeded PRNG.
 * Run with: node --test games/football/tests/physics.test.mjs
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
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  BALL_RADIUS,
  MAX_PLAYER_SPEED,
  Z_STRETCH,
  KICK_WINDUP_MS,
  KICK_DURATION_MS,
} from '../physics.js';

const NOOP = [0, 0, -1, 0, 0, 0, 0, -1, 0];

function moveAction(mx, my = 0) {
  return [mx, my, -1, 0, 0, 0, 0, -1, 0];
}

function pushAction(power = 1) {
  return [0, 0, -1, 0, 0, 0, 0, 1, power];
}

function kickAction(dx = 1, dy = 0, dz = 0, power = 1) {
  return [0, 0, 1, dx, dy, dz, power, -1, 0];
}

/** Fresh state with seeded RNG, grace frames zeroed, and events enabled. */
function freshState(seed = 42) {
  const field = createField();
  const rng = createSeededRng(seed);
  const state = createState(field, rng);
  state.graceFrames = 0;
  state.recordEvents = true;
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
  // Position p1 just in front of the left goal mouth (goalLineL is
  // the canonical front-face x of the unified goal collision box).
  state.p1.x = f.goalLineL + 1;
  state.p1.y = FIELD_HEIGHT / 2;

  // Walk into the goal for 30 ticks
  for (let i = 0; i < 30; i++) {
    tick(state, moveAction(-1), NOOP);
  }

  // p1.x must never be less than goalLineL (mouth line / front face).
  assert.ok(
    state.p1.x >= f.goalLineL - 0.01,
    `player penetrated left goal frame: x=${state.p1.x}, goalLineL=${f.goalLineL}`
  );
});

test('player cannot penetrate right goal frame', () => {
  const state = freshState();
  const f = state.field;
  state.p2.x = f.goalLineR - f.playerWidth - 1;
  state.p2.y = FIELD_HEIGHT / 2;

  for (let i = 0; i < 30; i++) {
    tick(state, NOOP, moveAction(1));
  }

  assert.ok(
    state.p2.x + f.playerWidth <= f.goalLineR + 0.01,
    `player penetrated right goal frame: x=${state.p2.x}`
  );
});

/* ── Test 2b: field-edge containment ─────────────────────────── */

test('player cannot cross the top field border', () => {
  const state = freshState();
  state.p1.y = 2;
  state.p1.x = 200;
  for (let i = 0; i < 30; i++) {
    tick(state, moveAction(0, -1), NOOP);
  }
  assert.ok(state.p1.y >= 0, `p1 top edge escaped field: y=${state.p1.y}`);
});

test('player cannot cross the bottom field border (body fully inside)', () => {
  const state = freshState();
  state.p1.y = FIELD_HEIGHT - 10;
  state.p1.x = 200;
  for (let i = 0; i < 30; i++) {
    tick(state, moveAction(0, 1), NOOP);
  }
  // p1.y is the top of the player body; bottom is p1.y + PLAYER_HEIGHT.
  assert.ok(
    state.p1.y + PLAYER_HEIGHT <= FIELD_HEIGHT + 0.01,
    `p1 bottom escaped field: y=${state.p1.y}, bottom=${state.p1.y + PLAYER_HEIGHT}`
  );
});

test('ball bounces off top and bottom walls, never leaves via those borders', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = f.width / 2;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vy = 30;  // strong push toward bottom wall
  state.ball.vz = 0;

  for (let i = 0; i < 200; i++) {
    tick(state, NOOP, NOOP);
    assert.ok(
      state.ball.y - BALL_RADIUS >= -0.01 && state.ball.y + BALL_RADIUS <= FIELD_HEIGHT + 0.01,
      `ball escaped top/bottom at tick ${i}: y=${state.ball.y}`
    );
  }
  // Ball must not have been OOB'd (top/bottom borders bounce, never out)
  assert.ok(
    !state.events.some(e => e.type === 'out'),
    'ball should not be OOB from top/bottom borders'
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

test('ball grazing the crossbar from above bounces off the top', () => {
  const state = freshState();
  const f = state.field;
  // Ball center inside the goal x/y, altitude just above the crossbar
  // so the sphere overlaps the box z range and the unified collision
  // fires on the z axis, flipping vz.
  state.ball.x = f.goalLineR + 2;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = f.goalMouthZMax + 0.5;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = -2; // descending onto the crossbar
  state.ball.frozen = false;

  for (let i = 0; i < 4; i++) tick(state, NOOP, NOOP);

  assert.equal(state.scoreL, 0, 'ball grazing crossbar must not score');
  assert.ok(state.ball.vz >= 0, `expected vz to flip to non-negative, got ${state.ball.vz}`);
});

test('ball clipping the post from outside the mouth bounces back', () => {
  const state = freshState();
  const f = state.field;
  // y just outside the mouth edge by less than BALL_RADIUS so the
  // ball sphere overlaps the mouth y range and collides with the
  // post cylinder, but the center is NOT inside the mouth.
  state.ball.x = f.goalLineR + 2;
  state.ball.y = f.goalMouthYMin - 0.5;
  state.ball.z = 0;
  state.ball.vx = 4;
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 6; i++) tick(state, NOOP, NOOP);

  assert.equal(state.scoreL, 0, 'post-bounce must not score');
  assert.ok(state.ball.vx < 0, `expected vx reversed, got ${state.ball.vx}`);
});

/* ── Test 5: a valid goal scores ────────────────────────────── */

test('ball straddling the goal line (center past, edge not past) does NOT score', () => {
  const state = freshState();
  const f = state.field;
  // Center is past the line by 1, but the near edge is still on the field
  // side (ball.x - BALL_RADIUS < goalLineR). This is the "partial cross"
  // case the new stricter rule rejects.
  state.ball.x = f.goalLineR + 1;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = 0;

  tick(state, NOOP, NOOP);

  assert.equal(state.scoreL, 0, 'no goal on partial cross');
  assert.equal(state.scoreR, 0);
  assert.ok(
    !state.events.some(e => e.type === 'goal'),
    'no goal event on partial cross'
  );
});

test('ball in mouth, below crossbar, fully past goal line scores for the other side', () => {
  const state = freshState();
  const f = state.field;
  // Place ball fully past the right goal line (ball edge past the line, not
  // just the center), inside the mouth, on the ground.
  state.ball.x = f.goalLineR + BALL_RADIUS + 2;
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

test('buildInputs produces 20 floats in [-1, 1]', () => {
  const state = freshState();
  state.p1.x = 100;
  state.ball.vx = 5;
  const inputs = buildInputs(state, 'p1');
  assert.equal(inputs.length, 20);
  for (const v of inputs) {
    assert.ok(v >= -1 && v <= 1, `input out of range: ${v}`);
    assert.ok(Number.isFinite(v), `non-finite input: ${v}`);
  }
});

test('buildInputs heading outputs track cos/sin(heading)', () => {
  const state = freshState();
  state.p1.heading = Math.PI / 4;
  const inputs = buildInputs(state, 'p1');
  assert.ok(
    Math.abs(inputs[18] - Math.cos(Math.PI / 4)) < 1e-10,
    `input[18] should be cos(π/4), got ${inputs[18]}`,
  );
  assert.ok(
    Math.abs(inputs[19] - Math.sin(Math.PI / 4)) < 1e-10,
    `input[19] should be sin(π/4), got ${inputs[19]}`,
  );
});

/* ── Task #59: OOB only via left/right, touchlines bounce ──
 *
 * OOB fires when the ball crosses the short field edges (x<0 or
 * x>width). The long touchlines (y=0 and y=FIELD_HEIGHT) are
 * solid walls — the ball bounces with vy flipped and stays in
 * play. Verifying both axes here so a regression is caught. */

test('ball crossing left field edge triggers OOB', () => {
  const state = freshState();
  state.ball.x = 5;
  state.ball.y = 27;
  state.ball.z = 0;
  state.ball.vx = -6;
  state.ball.vy = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 10 && state.pauseState === null; i++) tick(state, NOOP, NOOP);
  // Out triggers reposition pause (ballOut() in physics.js)
  assert.ok(
    state.pauseState !== null,
    'ball going off left edge should trigger OOB / ball reposition',
  );
});

test('ball crossing right field edge triggers OOB', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = f.width - 5;
  state.ball.y = 27;
  state.ball.z = 0;
  state.ball.vx = 6;
  state.ball.vy = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 10 && state.pauseState === null; i++) tick(state, NOOP, NOOP);
  assert.ok(
    state.pauseState !== null,
    'ball going off right edge should trigger OOB / ball reposition',
  );
});

test('ball hitting top touchline bounces and stays in play', () => {
  const state = freshState();
  state.ball.x = 450;
  state.ball.y = FIELD_HEIGHT - 2;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vy = 4;          // heading toward the touchline
  state.ball.frozen = false;
  // Let it bounce
  for (let i = 0; i < 20; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, null, 'top touchline must not trigger OOB');
  assert.ok(
    state.ball.vy < 0,
    `top touchline should flip vy to negative after bounce, got ${state.ball.vy}`,
  );
  assert.ok(
    state.ball.y < FIELD_HEIGHT,
    'ball must remain inside the field after bouncing off the top touchline',
  );
});

test('ball hitting bottom touchline bounces and stays in play', () => {
  const state = freshState();
  state.ball.x = 450;
  state.ball.y = 2;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vy = -4;
  state.ball.frozen = false;
  for (let i = 0; i < 20; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, null, 'bottom touchline must not trigger OOB');
  assert.ok(
    state.ball.vy > 0,
    `bottom touchline should flip vy to positive after bounce, got ${state.ball.vy}`,
  );
  assert.ok(state.ball.y > 0);
});

test('airborne ball hitting ceiling bounces and stays in play', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = 450;
  state.ball.y = 27;
  state.ball.z = f.ceiling - 2;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = 4;
  state.ball.frozen = false;
  for (let i = 0; i < 20; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, null, 'ceiling bounce must not trigger OOB');
  assert.ok(
    state.ball.vz < 0,
    `ceiling should flip vz to negative after bounce, got ${state.ball.vz}`,
  );
  assert.ok(state.ball.z <= f.ceiling);
});

/* ── Task #63: goal scoring stability at various angles ────
 *
 * Smoke battery covering the full mouth — center, both post
 * edges (clipping the cylinder should bounce, not score),
 * above and below the crossbar, and diagonal approaches. */

test('goal scored from mouth center', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 40 && state.pauseState !== 'celebrate'; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, 'celebrate');
  assert.equal(state.scoreR, 1, 'p2 should have scored on the left goal');
});

test('goal scored from mouth center on the right', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = f.width - 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 40 && state.pauseState !== 'celebrate'; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, 'celebrate');
  assert.equal(state.scoreL, 1);
});

test('ball clipping lower post bounces, does not score', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = 120;
  state.ball.y = f.goalMouthYMin;  // exactly on the post line
  state.ball.z = 0;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 40; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, null, 'post clip must not score');
  assert.equal(state.scoreR, 0);
  assert.ok(state.ball.vx > 0, 'post clip should flip vx to positive (bounce back)');
});

test('ball clipping upper post bounces, does not score', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = 120;
  state.ball.y = f.goalMouthYMax;
  state.ball.z = 0;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 40; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, null, 'post clip must not score');
  assert.equal(state.scoreR, 0);
  assert.ok(state.ball.vx > 0);
});

test('shot well wide of the goal passes behind without scoring', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = 120;
  state.ball.y = 5;                // way below mouth y
  state.ball.z = 0;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  // Should NOT score; should travel past the goal area and eventually OOB
  // when it crosses x < -BALL_RADIUS.
  for (let i = 0; i < 60 && state.pauseState === null; i++) tick(state, NOOP, NOOP);
  assert.equal(state.scoreR, 0);
  // After enough time the ball goes OOB on the left edge.
  assert.ok(
    state.pauseState !== null || state.ball.x > 0,
    'wide ball should either OOB or still be traveling, never score',
  );
});

test('diagonal shot into the mouth center scores', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = 140;
  state.ball.y = 15;
  state.ball.z = 0;
  state.ball.vx = -5; state.ball.vy = 1.2; state.ball.vz = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 40 && state.pauseState !== 'celebrate'; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, 'celebrate', 'diagonal into mouth must score');
});

test('shot over the crossbar with no dip does not score', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = f.goalMouthZMax + 10;  // well above crossbar
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 1; // slight lift so it stays high
  state.ball.frozen = false;
  // Goal scoring requires belowCrossbar — with vz positive enough to beat
  // gravity for a few ticks, ball stays above the crossbar as it crosses
  // the line. It should NOT score on the first few ticks.
  let scoredEarly = false;
  for (let i = 0; i < 6; i++) {
    tick(state, NOOP, NOOP);
    if (state.pauseState === 'celebrate' && state.ball.z + BALL_RADIUS > f.goalMouthZMax) {
      scoredEarly = true;
      break;
    }
  }
  assert.ok(
    !scoredEarly,
    'ball above the crossbar should not register a goal while still above it',
  );
});

/* ── Lateral-reach bug fixes: push and kick must only fire when
 *    players/ball are within the stickman's actual stretched-limb
 *    reach on the depth axis, not across half the field. */

test('push does not land when players are within x range but depth-separated', () => {
  const state = freshState();
  // Place them close in x (well within PUSH_RANGE_X = 30) but far
  // apart in y — more than a full player depth. Under the old
  // PUSH_RANGE_Y = 20, this would have fired. Under the new range
  // (derived from PLAYER_HEIGHT + slack), it must not.
  state.p1.x = state.field.midX - 8;
  state.p2.x = state.field.midX + 8;
  state.p1.y = 4;
  state.p2.y = 4 + PLAYER_HEIGHT + 5;  // bodies well separated on depth

  tick(state, pushAction(1), NOOP);

  assert.equal(state.p2.pushVx, 0, 'push should not land when depth-separated');
  assert.ok(
    !state.events.some(e => e.type === 'push'),
    `no push event expected when depth-separated: ${JSON.stringify(state.events)}`,
  );
});

test('push lands when players overlap in depth (touching)', () => {
  const state = freshState();
  // Touching: p2 top is at p1's bottom.
  state.p1.x = state.field.midX - 8;
  state.p2.x = state.field.midX + 8;
  state.p1.y = 10;
  state.p2.y = state.p1.y + PLAYER_HEIGHT - 0.5;  // 0.5 units of overlap

  tick(state, pushAction(1), NOOP);

  assert.ok(
    state.p2.pushVx !== 0,
    `push should land when players touch in depth: pushVx=${state.p2.pushVx}`,
  );
  assert.ok(state.events.some(e => e.type === 'push'), 'push event expected on touch');
});

test('kick activates when ball is within new lateral reach', () => {
  const state = freshState();
  // Place p1 and park the ball just in front of him (forward in x)
  // at the same mid-Y. Ball should be kickable.
  state.p1.x = 300;
  state.p1.y = 20;
  state.ball.x = state.p1.x + state.field.playerWidth / 2 + 5;
  state.ball.y = state.p1.y + PLAYER_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  tick(state, kickAction(1, 0, 0, 1), NOOP);

  assert.ok(state.p1.kick.active, 'kick should activate when ball is in reach');
});

test('kick does not activate when ball is laterally far in depth', () => {
  const state = freshState();
  // Same forward distance, but offset the ball by a full player depth
  // plus ball radius on the y axis — legs cannot reach laterally at
  // all, so even a small offset past body+ball should be rejected.
  state.p1.x = 300;
  state.p1.y = 20;
  state.ball.x = state.p1.x + state.field.playerWidth / 2 + 5;
  state.ball.y = state.p1.y + PLAYER_HEIGHT / 2 + PLAYER_HEIGHT + BALL_RADIUS + 4;
  state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  tick(state, kickAction(1, 0, 0, 1), NOOP);

  assert.equal(
    state.p1.kick.active, false,
    'kick must not activate when ball is beyond stretched-leg reach on depth axis',
  );
});

/* ── Heading, angular inertia, and movement acceleration ── */

test('player cannot reach full speed in a single tick', () => {
  const state = freshState();
  state.p1.x = 200;
  tick(state, moveAction(1), NOOP);
  // Acceleration cap: per-tick |Δv| is PLAYER_ACCEL (0.5 at default
  // tuning). First tick must produce less than half of full speed.
  assert.ok(
    state.p1.vx < MAX_PLAYER_SPEED / 2,
    `vx should accel, not snap: got ${state.p1.vx}`,
  );
});

test('player reaches full speed after the full ramp and keeps it there', () => {
  const state = freshState();
  state.p1.x = 150;
  for (let i = 0; i < 25; i++) tick(state, moveAction(1), NOOP);
  // After ~PLAYER_ACCEL_TICKS ticks vx should sit at MAX_PLAYER_SPEED
  // (modulo stamina decay). Stamina drops under 1 but stays above
  // MIN_SPEED_STAMINA, so the effective speed cap is still close to
  // MAX_PLAYER_SPEED.
  assert.ok(
    state.p1.vx > MAX_PLAYER_SPEED * 0.7,
    `vx should climb to near max, got ${state.p1.vx}`,
  );
});

test('releasing input decelerates over multiple ticks, not instantly', () => {
  const state = freshState();
  state.p1.x = 300;
  // Keep p2 clear of p1's run so the test isolates deceleration —
  // without this the pair-collision zeros vx exactly as the NOOP
  // tick under test would otherwise decay it.
  state.p2.x = state.field.width - 100;
  for (let i = 0; i < 25; i++) tick(state, moveAction(1), NOOP);
  const topVx = state.p1.vx;
  tick(state, NOOP, NOOP);
  // One tick of coast must reduce speed but not zero it.
  assert.ok(state.p1.vx < topVx, 'speed should decay');
  assert.ok(state.p1.vx > 0, `player must not stop instantly: got ${state.p1.vx}`);
});

test('direction-change drain fires once per commanded reversal, not continuously', () => {
  // Run forward 25 ticks to reach full speed, then flip the command
  // and keep it flipped. Under the acceleration cap, velocity takes
  // ~40 ticks to reverse, during which vx * targetVx < 0 every tick.
  // The edge-detected drain must fire exactly once (on the flip tick),
  // not every tick while vx crosses zero.
  const state = freshState();
  state.p1.x = 300;
  for (let i = 0; i < 25; i++) tick(state, moveAction(1), NOOP);
  const staminaBefore = state.p1.stamina;
  // First tick after the flip: target sign changes. One DCD drain fires.
  tick(state, moveAction(-1), NOOP);
  const staminaAfterFlip = state.p1.stamina;
  const flipDrain = staminaBefore - staminaAfterFlip;
  // Next 20 ticks: target direction stays -1, no more DCD drain.
  for (let i = 0; i < 20; i++) tick(state, moveAction(-1), NOOP);
  const staminaAfterSustain = state.p1.stamina;
  const sustainDrain = staminaAfterFlip - staminaAfterSustain;
  // The flip tick drained DCD + movement. The 20 sustain ticks only
  // drain movement stamina, which is much smaller per-tick. Assert
  // that the sustain drain over 20 ticks is less than ~5× the
  // single-flip drain — that would hold even if DCD kept firing,
  // BUT would fail if we were continuously draining 0.02 per tick.
  // (20 * 0.02 = 0.4, vs one-shot ~0.02-0.04.)
  assert.ok(
    flipDrain > 0.01,
    `flip tick should drain more than movement baseline, got ${flipDrain}`,
  );
  assert.ok(
    sustainDrain < flipDrain * 5,
    `sustain drain should NOT compound (got ${sustainDrain} vs flip ${flipDrain})`,
  );
});

test('heading rotates toward motion direction at bounded rate', () => {
  const state = freshState();
  // Face straight along +x. Start moving in +depth (physics y) — the
  // target heading is ~π/2 (after Z_STRETCH scaling). Over many
  // ticks heading must approach π/2, but one tick should not flip it.
  state.p1.x = 400; state.p1.y = 20;
  state.p1.heading = 0;
  tick(state, moveAction(0, 1), NOOP);
  const afterOne = state.p1.heading;
  assert.ok(afterOne > 0, `heading should have rotated toward target, got ${afterOne}`);
  assert.ok(
    afterOne < Math.PI / 3,
    `heading should not have snapped in one tick, got ${afterOne}`,
  );

  for (let i = 0; i < 40; i++) tick(state, moveAction(0, 1), NOOP);
  assert.ok(
    Math.abs(state.p1.heading - Math.PI / 2) < 0.2,
    `heading should converge near π/2, got ${state.p1.heading}`,
  );
});

test('kick blocked when player faces away from the ball', () => {
  const state = freshState();
  state.p1.x = 300;
  state.p1.y = 20;
  state.p1.heading = Math.PI;  // facing -x
  state.ball.x = state.p1.x + state.field.playerWidth / 2 + 5; // ball in +x
  state.ball.y = state.p1.y + PLAYER_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  tick(state, kickAction(1, 0, 0, 1), NOOP);

  assert.equal(
    state.p1.kick.active, false,
    'kick must not activate when heading is opposite the ball direction',
  );
});

test('push blocked when pusher faces away from the victim', () => {
  const state = freshState();
  state.p1.x = state.field.midX - 8;
  state.p2.x = state.field.midX + 8;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;
  state.p1.heading = Math.PI;  // facing -x, victim is in +x

  tick(state, pushAction(1), NOOP);

  assert.equal(
    state.p2.pushVx, 0,
    'push must not land when pusher is facing away',
  );
  assert.ok(
    !state.events.some(e => e.type === 'push'),
    'no push event when pusher is facing away',
  );
});

test('kick state machine fires impact at windup end and clears at duration end', () => {
  const state = freshState();
  state.p1.x = 300;
  state.p1.y = 20;
  state.ball.x = state.p1.x + state.field.playerWidth / 2 + 5;
  state.ball.y = state.p1.y + PLAYER_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  // Start the kick on tick 1.
  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.ok(state.p1.kick.active, 'kick should be active after start');
  assert.equal(state.p1.kick.fired, false, 'kick should not have fired on tick 1');

  // Drive the state machine up to just after the windup — impact
  // should fire (ball.vx becomes non-zero).
  const windupTicks = Math.ceil(KICK_WINDUP_MS / 16);
  for (let i = 0; i < windupTicks + 1; i++) tick(state, NOOP, NOOP);
  assert.ok(
    state.p1.kick.fired,
    `kick should have fired by tick ${windupTicks + 2}, timer=${state.p1.kick.timer}`,
  );
  assert.ok(
    state.ball.vx > 0,
    `ball should have gained forward velocity after fire, got vx=${state.ball.vx}`,
  );

  // Drive to the end of KICK_DURATION_MS — active must go false.
  const totalTicks = Math.ceil(KICK_DURATION_MS / 16);
  for (let i = 0; i < totalTicks; i++) tick(state, NOOP, NOOP);
  assert.equal(state.p1.kick.active, false, 'kick should deactivate after KICK_DURATION_MS');
});

/* ── Stamina reset on goal ──────────────────────────────────────
 *
 * Fresh legs for both sides on every goal so neither player starts
 * the next point visibly drained. Also covers the match-ending goal
 * since scoreGoal is the single path for both cases.
 */

test('both players regain full stamina when a goal is scored', () => {
  const state = freshState();
  const f = state.field;

  // Pre-drain both players so the reset is observable.
  state.p1.stamina = 0.15;
  state.p2.stamina = 0.22;
  state.p1.exhausted = true;
  state.p2.exhausted = true;

  // Fire a ball straight into the left goal mouth.
  state.ball.x = 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = -5;
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 40 && state.pauseState !== 'celebrate'; i++) {
    tick(state, NOOP, NOOP);
  }
  assert.equal(state.pauseState, 'celebrate', 'goal should have triggered celebrate pause');

  assert.equal(state.p1.stamina, 1, 'p1 stamina must reset to full on goal');
  assert.equal(state.p2.stamina, 1, 'p2 stamina must reset to full on goal');
  assert.equal(state.p1.exhausted, false);
  assert.equal(state.p2.exhausted, false);
});

/* ── Headless / training-mode fast path ────────────────────────
 *
 * `state.headless = true` is the training worker's contract: every
 * tick of the match budget goes into active play, no pauses, no
 * animations, no ball drop, no early match end at WIN_SCORE.
 */

test('headless scoreGoal resets pitch instantly, no pause', () => {
  const state = freshState();
  state.headless = true;
  const f = state.field;

  // Drain stamina + park players off-center so the reset is observable
  state.p1.stamina = 0.2; state.p2.stamina = 0.3;
  state.p1.x = 500; state.p1.y = 3;
  state.p2.x = 600; state.p2.y = 40;

  // Fire the ball into the left goal
  state.ball.x = 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 40 && state.scoreR === 0; i++) tick(state, NOOP, NOOP);
  assert.equal(state.scoreR, 1, 'goal should have scored');

  // No pause at all
  assert.equal(state.pauseState, null, 'headless should bypass all pauses');
  assert.equal(state.pauseTimer, 0);
  assert.equal(state.goalScorer, null, 'headless skips the scorer celebration pointer');
  assert.equal(state.graceFrames, 0);

  // Players teleported back to kickoff with zero velocity
  const midY = FIELD_HEIGHT / 2;
  assert.ok(Math.abs(state.p1.y - midY) < 1, `p1.y ≈ midY, got ${state.p1.y}`);
  assert.ok(Math.abs(state.p2.y - midY) < 1, `p2.y ≈ midY, got ${state.p2.y}`);
  assert.equal(state.p1.vx, 0); assert.equal(state.p1.vy, 0);
  assert.equal(state.p2.vx, 0); assert.equal(state.p2.vy, 0);
  assert.equal(state.p1.pushTimer, 0);
  assert.equal(state.p1.kick.active, false);

  // Ball reset to center, on the ground, stationary, unfrozen
  assert.ok(Math.abs(state.ball.x - f.midX) < 1);
  assert.equal(state.ball.z, 0);
  assert.equal(state.ball.vx, 0);
  assert.equal(state.ball.frozen, false);

  // And critically: play can resume the very next tick
  const tickBefore = state.tick;
  tick(state, NOOP, NOOP);
  assert.equal(state.tick, tickBefore + 1);
  assert.equal(state.pauseState, null, 'still no pause after advancing');
});

test('headless does not end match on WIN_SCORE', () => {
  const state = freshState();
  state.headless = true;
  state.scoreL = 4; // one goal short of default WIN_SCORE=5
  const f = state.field;

  state.ball.x = f.width - 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 40 && state.scoreL < 5; i++) tick(state, NOOP, NOOP);
  assert.equal(state.scoreL, 5, 'fifth goal should have scored');
  assert.equal(state.matchOver, false, 'headless must not set matchOver');
  assert.equal(state.pauseState, null, 'headless must not set matchend pause');
  assert.equal(state.winner, null);
});

test('headless ballOut also resets instantly', () => {
  const state = freshState();
  state.headless = true;
  const f = state.field;
  // Send the ball flying out the right touchline
  state.ball.x = f.width - 1;
  state.ball.y = 20;
  state.ball.z = 0;
  state.ball.vx = 20; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  // Park players off-center so the reset is observable
  state.p1.x = 300; state.p1.y = 5;
  state.p2.x = 700; state.p2.y = 45;

  for (let i = 0; i < 5; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, null, 'headless should skip reposition pause');
  // Ball reset to midfield
  assert.ok(Math.abs(state.ball.x - f.midX) < 1, `ball.x should be ~midX, got ${state.ball.x}`);
  assert.equal(state.ball.vx, 0);
});

test('headless auto-resets a stale match after ~3 wall-clock seconds of no kicks', () => {
  const state = freshState();
  state.headless = true;
  const f = state.field;
  // Push the ball off-center so we can detect the reset.
  state.ball.x = f.midX + 200;
  state.ball.y = 10;
  // Park p2 off-center too.
  state.p2.x = 700;
  state.p2.y = 5;

  // 3000ms / 16ms per tick = ~188 ticks. Pin stall trigger just past.
  const stallTicks = Math.ceil(3000 / 16);
  for (let i = 0; i <= stallTicks + 1; i++) tick(state, NOOP, NOOP);

  // Ball teleported back to midfield.
  assert.ok(Math.abs(state.ball.x - f.midX) < 1, `ball.x should be ~midX, got ${state.ball.x}`);
  assert.ok(Math.abs(state.ball.y - FIELD_HEIGHT / 2) < 1);
  assert.equal(state.ball.vx, 0);
  // Players teleported back to kickoff.
  assert.ok(Math.abs(state.p1.y - FIELD_HEIGHT / 2) < 1);
  assert.ok(Math.abs(state.p2.y - FIELD_HEIGHT / 2) < 1);
});

test('visual mode uses the 10-second stall timeout (NOT the 3s headless one)', () => {
  const state = freshState();
  // default headless=false
  const f = state.field;
  state.ball.x = f.midX + 200;
  state.ball.y = 10;
  // 3000ms / 16ms ≈ 188 ticks. After this many ticks, the ball should
  // NOT have been reset (visual mode waits 10s = 625 ticks).
  for (let i = 0; i <= 200; i++) tick(state, NOOP, NOOP);
  assert.ok(
    Math.abs(state.ball.x - (f.midX + 200)) < 5,
    `visual mode must NOT fast-reset; got ball.x=${state.ball.x}`,
  );
});

test('visual mode still runs the celebrate pause unchanged', () => {
  // Regression: the headless branch must not leak into visual mode.
  const state = freshState();
  // headless defaults to false
  const f = state.field;
  state.ball.x = 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 40 && state.pauseState !== 'celebrate'; i++) {
    tick(state, NOOP, NOOP);
  }
  assert.equal(state.pauseState, 'celebrate', 'visual mode still celebrates');
  assert.ok(state.goalScorer !== null, 'visual mode still flags the scorer');
});

/* ── Player-vs-player collision ──────────────────────────── */

test('two players walking toward each other on x stop at contact', () => {
  const state = freshState();
  state.p1.x = 300; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 350; state.p2.y = state.p1.y;
  // Drive p1 right, p2 left, for long enough that they'd pass through
  // each other (32 unit gap, combined speed ~20/tick, ~2 ticks from
  // contact) if collision weren't enforced.
  for (let i = 0; i < 30; i++) tick(state, moveAction(1), moveAction(-1));
  // p1 right edge must not exceed p2 left edge. Small float slack for
  // the half-half separation math.
  assert.ok(
    state.p1.x + PLAYER_WIDTH <= state.p2.x + 0.01,
    `p1 right (${state.p1.x + PLAYER_WIDTH}) overlapped p2 left (${state.p2.x})`,
  );
});

test('two players walking toward each other on y stop at contact', () => {
  const state = freshState();
  // Stack them x-aligned but y-separated (within PLAYER_HEIGHT so the
  // y-axis is the tighter overlap axis when they meet).
  state.p1.x = 400; state.p1.y = 10;
  state.p2.x = 400; state.p2.y = 25;
  for (let i = 0; i < 50; i++) tick(state, moveAction(0, 1), moveAction(0, -1));
  assert.ok(
    state.p1.y + PLAYER_HEIGHT <= state.p2.y + 0.01,
    `p1 bottom (${state.p1.y + PLAYER_HEIGHT}) overlapped p2 top (${state.p2.y})`,
  );
});

test('overlapping starting positions get separated on the first tick', () => {
  const state = freshState();
  // Place them so x is the minimum-penetration axis (1-unit x overlap,
  // 6-unit y overlap → MPT picks x). PLAYER_WIDTH=18, PLAYER_HEIGHT=6.
  state.p1.x = 400; state.p1.y = 20;
  state.p2.x = 417; state.p2.y = 20;
  tick(state, NOOP, NOOP);
  // No AABB overlap after resolution — either axis clearing is enough.
  const overlapX = Math.min(state.p1.x + PLAYER_WIDTH, state.p2.x + PLAYER_WIDTH)
                 - Math.max(state.p1.x, state.p2.x);
  const overlapY = Math.min(state.p1.y + PLAYER_HEIGHT, state.p2.y + PLAYER_HEIGHT)
                 - Math.max(state.p1.y, state.p2.y);
  assert.ok(
    overlapX <= 0.01 || overlapY <= 0.01,
    `still overlapping: overlapX=${overlapX}, overlapY=${overlapY}`,
  );
});

test('a push impulse cannot impale the opponent body', () => {
  const state = freshState();
  // Position the pusher right next to the victim and facing them.
  state.p1.x = 400; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 415; state.p2.y = state.p1.y;
  state.p1.heading = 0;  // facing +x, toward p2
  // p1 pushes with max power.
  tick(state, pushAction(1), NOOP);
  // Step enough ticks for the push impulse to play out fully.
  for (let i = 0; i < 30; i++) tick(state, NOOP, NOOP);
  // p1 must not have ended up past p2's left edge.
  assert.ok(
    state.p1.x + PLAYER_WIDTH <= state.p2.x + 0.01,
    `pusher pressed through victim: p1.x=${state.p1.x}, p2.x=${state.p2.x}`,
  );
});

/* ── Goal back-face + swept ball collision ───────────────── */

test('ball arriving from BEHIND the right goal does not tunnel through the back', () => {
  const state = freshState();
  state.headless = true;  // skip pause state machine
  const f = state.field;
  // Start outside the goal's back wall, moving left (toward midfield).
  // Without the fix, the "open mouth" exemption fires anywhere inside
  // the goal AABB and the ball passes straight through.
  state.ball.x = f.goalRRight + 3;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 5;
  state.ball.vx = -30; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  const startScore = state.scoreL + state.scoreR;

  tick(state, NOOP, NOOP);

  // Ball from behind must not score for either side.
  assert.equal(state.scoreL + state.scoreR, startScore,
    'ball entering from behind must not score');
  // Ball must still be at or behind the back wall (it bounced off),
  // not on the field side of the line.
  assert.ok(
    state.ball.x >= f.goalRRight - 0.5,
    `ball crossed back wall: x=${state.ball.x}`,
  );
});

test('ball arriving from BEHIND the left goal does not tunnel through the back', () => {
  const state = freshState();
  state.headless = true;
  const f = state.field;
  state.ball.x = f.goalLLeft - 3;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 5;
  state.ball.vx = 30; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  const startScore = state.scoreL + state.scoreR;

  tick(state, NOOP, NOOP);

  assert.equal(state.scoreL + state.scoreR, startScore,
    'ball entering from behind must not score');
  assert.ok(
    state.ball.x <= f.goalLLeft + 0.5,
    `ball crossed back wall: x=${state.ball.x}`,
  );
});

test('hard shot at a goal post bounces instead of tunneling through', () => {
  const state = freshState();
  state.headless = true;
  const f = state.field;
  // Aim a very fast ball at the bottom post (y = mouthYMin). Per-tick
  // motion = 60 units; post thickness ≈ 2.4 units diameter. Without
  // the swept integration the ball skips right past the post in a
  // single step — and since the endpoint is within mouth y/z (ball
  // has drifted inside), the scoring check fires falsely.
  state.ball.x = f.goalLineR - 40;
  state.ball.y = f.goalMouthYMin;  // at the top of the bottom post
  state.ball.z = 5;
  state.ball.vx = 60; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  const startScore = state.scoreL + state.scoreR;
  tick(state, NOOP, NOOP);

  // Ball clipping a post must not produce a score.
  assert.equal(state.scoreL + state.scoreR, startScore,
    'ball clipping the post must not score');
});

test('slow shot directly into the mouth still scores cleanly (regression)', () => {
  const state = freshState();
  state.headless = true;  // skip celebrate pause
  const f = state.field;
  state.ball.x = f.goalLineR - 5;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 5;
  state.ball.vx = 12; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  // Ball travels into right goal → scores for LEFT team (p1).
  for (let i = 0; i < 30 && state.scoreL === 0; i++) {
    tick(state, NOOP, NOOP);
  }

  assert.equal(state.scoreL, 1, 'slow shot into right mouth should still score');
});
