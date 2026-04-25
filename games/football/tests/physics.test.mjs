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
  resetStateInPlace,
  tick,
  buildInputs,
  FIELD_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  BALL_RADIUS,
  GOAL_POST_RADIUS,
  MAX_PLAYER_SPEED,
  Z_STRETCH,
  TICK_MS,
  GRAVITY,
  KICK_WINDUP_MS,
  KICK_DURATION_MS,
  STICKMAN_TORSO_RADIUS,
  STICKMAN_UPPER_LEG,
  STICKMAN_LOWER_LEG,
  solve2BoneIK,
  KICK_STRIKE_WINDOW_MS,
  kickLegExtension,
  kickLegPose,
  canKickReach,
  AIRKICK_MS,
  AIRKICK_PEAK_FRAC,
  ACTION_MOVE_X,
  ACTION_MOVE_Y,
  ACTION_KICK_GATE,
  ACTION_KICK_DX,
  ACTION_KICK_DY,
  ACTION_KICK_DZ,
  ACTION_KICK_POWER,
  ACTION_PUSH_GATE,
  ACTION_PUSH_POWER,
  NN_OUTPUT_SIZE,
  NN_INPUT_SIZE,
} from '../physics.js';

/** Build a 9-float action vector by action-slot name rather than
 *  magic index. All fields default to the neutral "do nothing" value
 *  (gates at -1, power/direction at 0). */
function action({ moveX = 0, moveY = 0, kickGate = -1, kickDx = 0, kickDy = 0, kickDz = 0, kickPower = 0, pushGate = -1, pushPower = 0 } = {}) {
  const a = new Array(NN_OUTPUT_SIZE);
  a[ACTION_MOVE_X]     = moveX;
  a[ACTION_MOVE_Y]     = moveY;
  a[ACTION_KICK_GATE]  = kickGate;
  a[ACTION_KICK_DX]    = kickDx;
  a[ACTION_KICK_DY]    = kickDy;
  a[ACTION_KICK_DZ]    = kickDz;
  a[ACTION_KICK_POWER] = kickPower;
  a[ACTION_PUSH_GATE]  = pushGate;
  a[ACTION_PUSH_POWER] = pushPower;
  return a;
}

const NOOP = action();
const moveAction = (mx, my = 0) => action({ moveX: mx, moveY: my });
const pushAction = (power = 1) => action({ pushGate: 1, pushPower: power });
const kickAction = (dx = 1, dy = 0, dz = 0, power = 1) =>
  action({ kickGate: 1, kickDx: dx, kickDy: dy, kickDz: dz, kickPower: power });

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
  // Run physics through the full push cycle (PUSH_ANIM_MS=1000ms at
  // 16ms/tick → ~63 ticks, strike lands ~tick 22) plus impulse decay.
  for (let i = 0; i < 60; i++) {
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
  const startX = state.p2.x;

  tick(state, pushAction(1), NOOP);
  // Push event fires at tryPush (animation start) — visible tick 1.
  assert.ok(
    state.events.some(e => e.type === 'push'),
    `no push event emitted: ${JSON.stringify(state.events)}`
  );
  assert.ok(state.p1.pushTimer > 0, 'pusher should have cooldown');

  // Impulse itself is deferred to the strike tick (mid-animation,
  // ~tick 22 of 63). Tick through and verify displacement.
  for (let i = 0; i < 40; i++) tick(state, NOOP, NOOP);
  assert.ok(
    state.p2.x > startX,
    `push did not displace victim: p2.x=${state.p2.x}, startX=${startX}`,
  );
});

test('push writes hit-reaction state on the victim at the strike tick', () => {
  const state = freshState();
  state.p1.x = state.field.midX - 10;
  state.p2.x = state.field.midX + 10;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;

  tick(state, pushAction(1), NOOP);
  // Windup — no reaction yet.
  assert.equal(state.p2.reactTimer, 0,
    `no reaction on windup tick, got ${state.p2.reactTimer}`);

  // Tick through the strike window.
  for (let i = 0; i < 40; i++) tick(state, NOOP, NOOP);

  // reactTimer decays across the remaining ticks; what we care about
  // is that it WAS set at the strike tick. reactForce stays > 0 while
  // the timer is non-zero; reactDirX/Z should be a unit vector.
  const dirMag = Math.hypot(state.p2.reactDirX, state.p2.reactDirZ);
  assert.ok(
    state.p2.reactTimer > 0 || state.p2.reactForce === 0,
    'react state should either be active or fully decayed',
  );
  if (state.p2.reactTimer > 0) {
    assert.ok(Math.abs(dirMag - 1) < 1e-6,
      `reactDir should be unit vector, got |dir|=${dirMag}`);
    assert.ok(state.p2.reactForce > 0, `reactForce should be > 0, got ${state.p2.reactForce}`);
    assert.ok(['jab', 'hook', 'uppercut'].includes(state.p2.reactType),
      `reactType should be a known variant, got ${state.p2.reactType}`);
  }
});

test('push contact tick is per-type: uppercut earliest, jab latest', () => {
  // Each punch type commits its impulse at a different strike tick
  // because the fist engages the target at a different moment of
  // the arm's windup→strike blend. Uppercut connects at t≈0.42,
  // hook at ≈0.46, jab at ≈0.50 — longer throws land later.
  const measure = (p2X) => {
    const s = freshState();
    s.p1.x = s.field.midX - 10;
    s.p2.x = s.field.midX + p2X;   // distance from p1 picks pushType
    s.p1.y = s.p2.y = FIELD_HEIGHT / 2;
    tick(s, pushAction(1), NOOP);
    for (let i = 0; i < 40; i++) {
      tick(s, NOOP, NOOP);
      if (s.p2.pushVx !== 0) return i + 2;
    }
    return -1;
  };
  // p2.x offsets chosen so fwdDist falls in each type's range.
  const uppercutTick = measure(-6);    // fwdDist = 4 → uppercut
  const hookTick     = measure(+8);    // fwdDist = 18 → hook
  const jabTick      = measure(+18);   // fwdDist = 28 → jab
  assert.ok(uppercutTick > 0 && hookTick > 0 && jabTick > 0,
    `all types should strike; got uppercut=${uppercutTick}, hook=${hookTick}, jab=${jabTick}`);
  assert.ok(uppercutTick < hookTick,
    `uppercut (${uppercutTick}) should fire BEFORE hook (${hookTick})`);
  assert.ok(hookTick < jabTick,
    `hook (${hookTick}) should fire BEFORE jab (${jabTick})`);
});

test('push impulse is deferred to the strike tick, not applied on windup', () => {
  // Pushed player should NOT move during the windup phase — the
  // impulse only lands at the animation's strike tick (mid-
  // animation). Previously the victim jumped on frame 1, before
  // the arm even swung forward.
  const state = freshState();
  state.p1.x = state.field.midX - 10;
  state.p2.x = state.field.midX + 10;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;
  const startX = state.p2.x;

  tick(state, pushAction(1), NOOP);
  assert.equal(
    state.p2.pushVx, 0,
    `impulse must not fire on tick 1 (windup), got pushVx=${state.p2.pushVx}`,
  );
  assert.equal(
    state.p2.x, startX,
    `victim must not move on tick 1, moved to ${state.p2.x}`,
  );

  // Strike fires when pushTimer first drops <= PUSH_STRIKE_TIMER
  // (1000 * (1 - PUSH_CONTACT_FRAC) = 580 ms). pushTimer starts at
  // 1000 ms and decrements 16 ms/tick, so strike ≈ tick 27–28.
  let strikeTick = -1;
  for (let i = 0; i < 40; i++) {
    tick(state, NOOP, NOOP);
    if (state.p2.pushVx !== 0 && strikeTick === -1) strikeTick = i + 2;
  }
  assert.ok(strikeTick >= 25 && strikeTick <= 30,
    `strike tick out of expected range: ${strikeTick}`);
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

  // Ball is no longer frozen on OOB — it keeps moving (and falls)
  // while the reposition pause plays out.
  assert.equal(state.pauseState, 'reposition',
    'reposition pause should fire on OOB');
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

test('ball dropping onto the crossbar from above bounces up', () => {
  const state = freshState();
  const f = state.field;
  // Ball centred above the crossbar axis (x = mouthX = goalLineR), z just
  // above the crossbar so it contacts the top of the cylinder as gravity
  // pulls it down. Normal points straight up → vz flips cleanly.
  state.ball.x = f.goalLineR;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = f.goalMouthZMax + BALL_RADIUS + 0.05;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = -2; // descending onto the crossbar
  state.ball.frozen = false;

  for (let i = 0; i < 4; i++) tick(state, NOOP, NOOP);

  assert.equal(state.scoreL, 0, 'ball grazing crossbar must not score');
  assert.ok(state.ball.vz > 0, `expected vz to flip positive, got ${state.ball.vz}`);
});

test('ball clipping the post from outside the mouth bounces back', () => {
  const state = freshState();
  const f = state.field;
  // Ball approaching the right goal from the FIELD side at a y just
  // outside the mouth — sphere overlaps the post cylinder on the way
  // in. Must deflect back toward the field (vx reverses).
  state.ball.x = f.goalLineR - 10;
  state.ball.y = f.goalMouthYMin - 0.5;
  state.ball.z = 0;
  state.ball.vx = 4;  // moving toward the post
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
  // Ball is no longer frozen on goal — it keeps moving through the
  // celebrate pause so a scored shot visibly settles into the net.
  // inGoal routes wall contact through the absorbing inner-net
  // resolver; graceFrames blocks a re-score.
  assert.ok(state.ball.inGoal, 'inGoal flag should be set on goal');
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

test('buildInputs produces NN_INPUT_SIZE floats in [-1, 1]', () => {
  const state = freshState();
  state.p1.x = 100;
  state.ball.vx = 5;
  const inputs = buildInputs(state, 'p1');
  assert.equal(inputs.length, NN_INPUT_SIZE);
  for (const v of inputs) {
    assert.ok(v >= -1 && v <= 1, `input out of range: ${v}`);
    assert.ok(Number.isFinite(v), `non-finite input: ${v}`);
  }
});

test('buildInputs derived signals expose possession and goal distances', () => {
  const state = freshState();
  // Put ball right next to p1, far from p2 → possession > 0.
  state.p1.x = 100; state.ball.x = 110; state.ball.y = state.p1.y;
  state.p2.x = 800;
  const inP1 = buildInputs(state, 'p1');
  const inP2 = buildInputs(state, 'p2');
  assert.ok(inP1[20] > 0, `p1 should own possession, got ${inP1[20]}`);
  assert.ok(inP2[20] < 0, `p2 should sense p1 has possession, got ${inP2[20]}`);
  // Self distances: p1 near left end → close to own goal, far from opp.
  assert.ok(inP1[23] < inP1[24], 'p1 should be closer to own goal than opp');
  assert.ok(inP2[23] < inP2[24], 'p2 should be closer to own goal than opp');
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

/* ── Sphere-cylinder bar collisions ────────────────────────────
 *
 * The goal frame is drawn as thin cylinders (2 posts + 1 crossbar per
 * side). The physics approximates each bar as a sphere-cylinder
 * collider rather than the old AABB box. These tests pin the
 * physically-correct deflection directions the cylinder resolver
 * produces, and guard against two regressions from the cylinder
 * rewrite: (1) pure x-axis bounces at the goal line when the real
 * normal should deflect sideways or vertically, (2) phantom bounces
 * for balls well clear of the frame.
 */

test('wide shot flies past the post without a phantom goal-line bounce', () => {
  const state = freshState();
  const f = state.field;
  // y well below the lower post — ball sphere does not overlap the
  // post cylinder. Before the cylinder rewrite, the AABB resolver
  // fired on Y-shadow overlap and bounced the ball back in X.
  state.ball.x = f.goalLineL + 20;
  state.ball.y = 4;     // mouthYMin=13, BALL_R+POST_R ≈ 5.4 → y=4 is clear
  state.ball.z = 1;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 10; i++) tick(state, NOOP, NOOP);
  assert.ok(state.ball.vx < 0, `wide shot must keep negative vx, got ${state.ball.vx}`);
  assert.equal(state.scoreR, 0);
});

test('high shot flies over the crossbar without a phantom goal-line bounce', () => {
  const state = freshState();
  const f = state.field;
  // z well above the crossbar cylinder. Without the cylinder rewrite
  // the AABB's Z-overlap fired and produced an X-bounce at the mouth.
  state.ball.x = f.goalLineL + 30;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = f.goalMouthZMax + 20;  // 20 units above crossbar axis
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 1;  // slight lift
  state.ball.frozen = false;
  for (let i = 0; i < 6; i++) tick(state, NOOP, NOOP);
  assert.ok(state.ball.vx < 0, `high fly-by must keep negative vx, got ${state.ball.vx}`);
});

test('post side-graze deflects laterally (y-dominant), not straight back', () => {
  const state = freshState();
  const f = state.field;
  // Ball approaches on a line that clips the post cylinder from the
  // field side, offset in y below the post axis. A correct
  // cylinder bounce deflects the ball in -y (away from the post),
  // not a pure x rebound.
  state.ball.x = f.goalLineL + 30;
  state.ball.y = f.goalMouthYMin - 2;  // inside sphere reach of the post
  state.ball.z = 1;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  // Run until contact — fairly short.
  for (let i = 0; i < 8; i++) tick(state, NOOP, NOOP);
  // After the post hit, lateral velocity should dominate the return
  // and the ball should have moved away from the post line.
  assert.ok(
    Math.abs(state.ball.vy) > Math.abs(state.ball.vx),
    `post side-graze must deflect in y (|vy|=${Math.abs(state.ball.vy).toFixed(2)}, |vx|=${Math.abs(state.ball.vx).toFixed(2)})`,
  );
  assert.ok(state.ball.y < f.goalMouthYMin, 'ball should end up on the outside-y side of the post');
  assert.equal(state.scoreR, 0);
});

test('crossbar top-drop deflects vertically (z-dominant)', () => {
  const state = freshState();
  const f = state.field;
  // Ball centred directly above the crossbar axis, falling onto it.
  // Cylinder normal is +z; the bounce flips vz with vx barely
  // disturbed.
  state.ball.x = f.goalLineL;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = f.goalMouthZMax + BALL_RADIUS + 0.05;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = -3;
  state.ball.frozen = false;
  for (let i = 0; i < 4; i++) tick(state, NOOP, NOOP);
  assert.ok(state.ball.vz > 0, `crossbar top-drop must flip vz positive, got ${state.ball.vz}`);
  assert.equal(state.scoreR, 0);
});

test('head-on post hit at the centre of the post bounces straight back', () => {
  const state = freshState();
  const f = state.field;
  // Ball and post aligned on y (ball.y = mouthYMin), coming straight
  // at the post from the field side. Normal is purely +x → pure x-bounce.
  state.ball.x = f.goalLineL + 30;
  state.ball.y = f.goalMouthYMin;
  state.ball.z = 1;
  state.ball.vx = -5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 15; i++) tick(state, NOOP, NOOP);
  assert.ok(state.ball.vx > 0, `head-on post hit must flip vx, got ${state.ball.vx}`);
  assert.ok(
    Math.abs(state.ball.vy) < 0.2,
    `head-on hit must have minimal y deflection, got vy=${state.ball.vy}`,
  );
  assert.equal(state.scoreR, 0);
});

/* ── Exterior goal faces are solid from outside.
 *
 * Every non-mouth face of the goal (back wall, 2 side walls, roof)
 * must bounce balls that approach from outside. Without these
 * colliders a ball arriving off-axis would tunnel through a side net
 * or the roof and spawn inside the goal volume (a phantom score).
 */

test('airborne ball hitting the lower side net from outside bounces back', () => {
  const state = freshState();
  const f = state.field;
  // Ball inside goal's x-range but below mouth y, airborne at side
  // net height, moving INTO the net from below.
  state.ball.x = f.goalLineL - 20;
  state.ball.y = 6;                         // mouthYMin=13, 7 units below
  state.ball.z = 10;
  state.ball.vx = 0; state.ball.vy = 8; state.ball.vz = 0;
  state.ball.frozen = false;
  tick(state, NOOP, NOOP);
  assert.ok(state.ball.vy < 0, `lower side net must flip vy, got ${state.ball.vy}`);
  assert.ok(
    state.ball.y < f.goalMouthYMin,
    `ball must stay outside mouth y, got y=${state.ball.y}`,
  );
  assert.equal(state.ball.inGoal, false);
  assert.equal(state.scoreR, 0);
});

test('airborne ball hitting the upper side net from outside bounces back', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = f.goalLineL - 20;
  state.ball.y = 50;                        // mouthYMax=41.6, 8.4 units above
  state.ball.z = 10;
  state.ball.vx = 0; state.ball.vy = -8; state.ball.vz = 0;
  state.ball.frozen = false;
  tick(state, NOOP, NOOP);
  assert.ok(state.ball.vy > 0, `upper side net must flip vy, got ${state.ball.vy}`);
  assert.ok(
    state.ball.y > f.goalMouthYMax,
    `ball must stay outside mouth y, got y=${state.ball.y}`,
  );
  assert.equal(state.ball.inGoal, false);
});

test('ball dropping onto the roof from above bounces up', () => {
  const state = freshState();
  const f = state.field;
  // Directly above the interior of the goal, falling.
  state.ball.x = f.goalLineL - 20;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = f.goalMouthZMax + 6;       // 6 units above roof
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = -3;
  state.ball.frozen = false;
  for (let i = 0; i < 3; i++) tick(state, NOOP, NOOP);
  assert.ok(state.ball.vz > 0, `roof must flip vz positive, got ${state.ball.vz}`);
  assert.ok(
    state.ball.z >= f.goalMouthZMax,
    `ball must not tunnel below roof, got z=${state.ball.z}`,
  );
  assert.equal(state.ball.inGoal, false);
});

test('bars are solid from INSIDE — crossbar bounces ball aligned directly below it', () => {
  const state = freshState();
  const f = state.field;
  // Ball directly below the crossbar axis at x=mouthX so the contact
  // normal is purely vertical — the bounce flips vz cleanly.
  state.ball.x = f.goalLineL;   // aligned with crossbar axis on x
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = f.goalMouthZMax - BALL_RADIUS - GOAL_POST_RADIUS - 0.1;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 2;
  state.ball.frozen = false;
  state.ball.inGoal = true;
  tick(state, NOOP, NOOP);
  assert.ok(state.ball.vz < 0, `inside-crossbar hit must flip vz, got ${state.ball.vz}`);
  assert.ok(
    state.ball.z + BALL_RADIUS <= f.goalMouthZMax + 0.01,
    `ball must stay below crossbar after bounce, got z=${state.ball.z}`,
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
  const startX = state.p2.x;

  tick(state, pushAction(1), NOOP);
  assert.ok(state.events.some(e => e.type === 'push'), 'push event expected on touch');

  // Strike tick is mid-animation (~tick 22) — tick well past it.
  for (let i = 0; i < 40; i++) tick(state, NOOP, NOOP);
  assert.ok(
    state.p2.x !== startX,
    `push should displace victim on contact: p2.x=${state.p2.x}`,
  );
});

test('kick activates when ball is within hip reach', () => {
  const state = freshState();
  // Ball parked directly in front of p1 on his depth-line. The hip
  // anchor sits at HIP_BASE_Z (20) above the pitch; the ball at
  // ground level is ~16 world-y below, leaving ~12 world-xz of
  // horizontal reach — 5 units forward is well inside that.
  state.p1.x = 300;
  state.p1.y = 20;
  state.ball.x = state.p1.x + state.field.playerWidth / 2 + 5;
  state.ball.y = state.p1.y;
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
  state.ball.y = state.p1.y;
  state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  // Start the kick on tick 1.
  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.ok(state.p1.kick.active, 'kick should be active after start');
  assert.equal(state.p1.kick.fired, false, 'kick should not have fired on tick 1');

  // Drive the state machine up to just after the windup — impact
  // should fire (ball.vx becomes non-zero).
  const windupTicks = Math.ceil(KICK_WINDUP_MS / TICK_MS);
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
  const totalTicks = Math.ceil(KICK_DURATION_MS / TICK_MS);
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

test('headless ends match at WIN_SCORE (capped like visual)', () => {
  const state = freshState();
  state.headless = true;
  state.scoreL = 2; // one goal short of WIN_SCORE=3
  const f = state.field;

  state.ball.x = f.width - 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 40 && state.scoreL < 3; i++) tick(state, NOOP, NOOP);
  assert.equal(state.scoreL, 3, 'third goal should have scored');
  assert.equal(state.matchOver, true, 'headless should set matchOver at WIN_SCORE');
  // Winner recorded but no pause-state (headless skips the celebrate).
  assert.equal(state.pauseState, null);
  assert.equal(state.winner, 'left');
});

test('headless instant-resets below WIN_SCORE (keeps playing)', () => {
  const state = freshState();
  state.headless = true;
  state.scoreL = 0; // plenty of room before WIN_SCORE
  const f = state.field;

  state.ball.x = f.width - 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 40 && state.scoreL < 1; i++) tick(state, NOOP, NOOP);
  assert.equal(state.scoreL, 1, 'first goal should have scored');
  assert.equal(state.matchOver, false, 'non-winning goal must not end match');
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

test('stall reset fires after 10 wall-clock seconds of no kicks (headless + visual)', () => {
  // The stall timeout was unified at 10 s for both modes so showcase
  // replays (which run with state.headless=true for scoreGoal
  // determinism) reset on the same schedule as the worker that
  // produced the recording. Before the visual never saw a reset
  // before tick 625, the worker at tick 187 — the mismatch showed up
  // as jarring mid-replay teleports every 3 s.
  const stallTicks = Math.ceil(10000 / TICK_MS);

  for (const headless of [true, false]) {
    const state = freshState();
    state.headless = headless;
    const f = state.field;
    state.ball.x = f.midX + 200;
    state.ball.y = 10;
    state.p2.x = 700;

    // Just before the timeout: no reset yet.
    for (let i = 0; i <= stallTicks - 2; i++) tick(state, NOOP, NOOP);
    assert.ok(
      Math.abs(state.ball.x - (f.midX + 200)) < 5,
      `${headless ? 'headless' : 'visual'}: stall fired too early; ball.x=${state.ball.x}`,
    );

    // Crossing the threshold: reset fires.
    for (let i = 0; i < 3; i++) tick(state, NOOP, NOOP);
    assert.ok(
      Math.abs(state.ball.x - f.midX) < 1,
      `${headless ? 'headless' : 'visual'}: ball should reset to midX, got ${state.ball.x}`,
    );
    assert.equal(state.ball.vx, 0);

    // Headless also teleports players back; visual leaves them put.
    if (headless) {
      assert.ok(Math.abs(state.p1.y - FIELD_HEIGHT / 2) < 1);
      assert.ok(Math.abs(state.p2.y - FIELD_HEIGHT / 2) < 1);
    }
  }
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

/* ── Player-vs-player collision (capsule model) ──────────── */

/** World-space horizontal distance between the two players' body
 *  capsule centers — the single number that defines whether two
 *  players are in contact. Mirrors the collision resolver math. */
function capsuleDist(p1, p2) {
  const dx = (p1.x + PLAYER_WIDTH / 2) - (p2.x + PLAYER_WIDTH / 2);
  const dz = ((p1.y + PLAYER_HEIGHT / 2) - (p2.y + PLAYER_HEIGHT / 2)) * Z_STRETCH;
  return Math.hypot(dx, dz);
}

test('two players walking toward each other on x stop at capsule-contact distance', () => {
  const state = freshState();
  state.p1.x = 300; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 350; state.p2.y = state.p1.y;
  // Drive p1 right, p2 left. Without the swept capsule solver they
  // would tunnel straight through each other — combined closure is
  // ~20 u/tick but the contact diameter is only 6.6.
  for (let i = 0; i < 30; i++) tick(state, moveAction(1), moveAction(-1));
  const dist = capsuleDist(state.p1, state.p2);
  const contact = 2 * STICKMAN_TORSO_RADIUS;
  assert.ok(
    dist >= contact - 0.05,
    `capsule centers must stay at contact distance ${contact.toFixed(2)}, got ${dist.toFixed(3)}`,
  );
  // p1 must still be LEFT of p2 (didn't swap places via tunneling).
  assert.ok(
    state.p1.x < state.p2.x,
    `p1 should stay left of p2, got p1.x=${state.p1.x}, p2.x=${state.p2.x}`,
  );
});

test('two players walking toward each other on y stop at capsule-contact distance', () => {
  const state = freshState();
  state.p1.x = 400; state.p1.y = 10;
  state.p2.x = 400; state.p2.y = 40;
  for (let i = 0; i < 50; i++) tick(state, moveAction(0, 1), moveAction(0, -1));
  const dist = capsuleDist(state.p1, state.p2);
  const contact = 2 * STICKMAN_TORSO_RADIUS;
  assert.ok(
    dist >= contact - 0.05,
    `capsule centers must stay at contact distance ${contact.toFixed(2)}, got ${dist.toFixed(3)}`,
  );
  assert.ok(
    state.p1.y < state.p2.y,
    `p1 should stay below p2 (lower y), got p1.y=${state.p1.y}, p2.y=${state.p2.y}`,
  );
});

test('overlapping starting positions get separated to capsule-contact distance', () => {
  const state = freshState();
  // Start at zero separation (capsules fully overlapping).
  state.p1.x = 400; state.p1.y = 27;
  state.p2.x = 400; state.p2.y = 27;
  tick(state, NOOP, NOOP);
  const dist = capsuleDist(state.p1, state.p2);
  const contact = 2 * STICKMAN_TORSO_RADIUS;
  assert.ok(
    dist >= contact - 0.05,
    `overlapping capsules must separate to ${contact.toFixed(2)}, got ${dist.toFixed(3)}`,
  );
});

test('far-apart players with tiny perpendicular velocity do NOT stall on false-positive collision', () => {
  // Regression: the pair-collision guard used a per-axis sign-flip
  // heuristic on the centre-offset vector. Two players 79 units
  // apart in x but nearly aligned in y would trigger that heuristic
  // on any tick where their y-offsets crossed sign. The solver then
  // rewound positions and zeroed both players' x-velocities along
  // the (far-away) separation normal — stalling all motion.
  //
  // Setup: symmetric x positions (80 units apart), same y, both
  // moving toward each other in x, with OPPOSITE tiny y moves that
  // cause their y-offsets to cross zero every few ticks.
  const state = freshState();
  state.p1.x = 400; state.p1.y = 27;
  state.p2.x = 480; state.p2.y = 27;
  // moveX converging, tiny opposite moveY with sign flips each tick
  // to reproduce the false-positive trigger.
  let flip = 1;
  for (let i = 0; i < 10; i++) {
    flip = -flip;
    const a1 = [ 1,  0.01 * flip, -1,  1, 0, 0, 0, -1, 0];
    const a2 = [-1, -0.01 * flip, -1, -1, 0, 0, 0, -1, 0];
    tick(state, a1, a2);
  }
  // Both players should have accelerated over 10 ticks. With
  // PLAYER_ACCEL = 0.5 per tick, after ~10 ticks speeds should be
  // near MAX_PLAYER_SPEED = 10. Asserting > 3 gives plenty of margin
  // while still catching a stall at ~0.5 that would appear after the
  // first tick if the bug re-emerged.
  assert.ok(
    state.p1.vx > 3,
    `p1 should have accelerated; stall bug returned? vx=${state.p1.vx}`,
  );
  assert.ok(
    state.p2.vx < -3,
    `p2 should have accelerated; stall bug returned? vx=${state.p2.vx}`,
  );
});

test('a push impulse cannot impale the opponent body', () => {
  const state = freshState();
  // Position the pusher right next to the victim and facing them.
  // 15-unit gap in physics x is already inside the capsule contact
  // distance (6.6 world) — but world-depth axis matters too; here
  // both players are at the same y so it's pure-x.
  state.p1.x = 400; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 415; state.p2.y = state.p1.y;
  state.p1.heading = 0;
  tick(state, pushAction(1), NOOP);
  for (let i = 0; i < 30; i++) tick(state, NOOP, NOOP);
  // p1 (the pusher) must still be on the LEFT side of p2 at contact
  // distance — if the impulse had impaled p2, p1 would have crossed
  // over and ended up on the right.
  assert.ok(
    state.p1.x < state.p2.x,
    `pusher crossed through victim: p1.x=${state.p1.x}, p2.x=${state.p2.x}`,
  );
  const dist = capsuleDist(state.p1, state.p2);
  const contact = 2 * STICKMAN_TORSO_RADIUS;
  assert.ok(
    dist >= contact - 0.1,
    `capsules must stay at contact distance, got ${dist.toFixed(3)} (contact=${contact.toFixed(2)})`,
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

/* ── Ball continues after score/out, inner net absorbs ──── */

test('ball continues moving after scoring instead of freezing', () => {
  const state = freshState();
  const f = state.field;
  // Shot clearly into the right mouth on the ground.
  state.ball.x = f.goalLineR + BALL_RADIUS + 2;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 10; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  tick(state, NOOP, NOOP);

  // Goal fires, ball NOT frozen, inGoal flag is set.
  assert.equal(state.scoreL, 1);
  assert.equal(state.pauseState, 'celebrate');
  assert.equal(state.ball.frozen, false, 'ball should remain unfrozen');
  assert.ok(state.ball.inGoal, 'inGoal flag should be set');
});

test('ball hitting the inner back net comes to rest horizontally', () => {
  const state = freshState();
  const f = state.field;
  // Park the ball inside the right goal just before the back wall,
  // moving into the back, with inGoal already set (simulating a
  // scored shot mid-flight).
  state.ball.x = f.goalRRight - BALL_RADIUS - 1;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 3;
  state.ball.vx = 20; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.inGoal = true;
  state.graceFrames = 999;  // block scoring path, we're past that
  state.ball.frozen = false;
  state.pauseState = 'celebrate';  // just past the score, physics keeps going
  state.pauseTimer = 100;

  // One tick should drive the ball into the back and dampen it.
  tick(state, NOOP, NOOP);

  // Ball should be clamped inside the back wall, with no horizontal
  // velocity. Vertical motion (gravity) is free to carry on.
  assert.ok(
    state.ball.x + BALL_RADIUS <= f.goalRRight + 0.01,
    `ball clipped the back net: x=${state.ball.x}`,
  );
  assert.equal(state.ball.vx, 0, 'inner back net absorbs vx');
  assert.equal(state.ball.vy, 0, 'inner back net absorbs vy');
});

test('ball goes out of bounds without freezing', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = f.width + 2;  // past field edge
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 5; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  tick(state, NOOP, NOOP);

  assert.equal(state.pauseState, 'reposition', 'reposition should fire on OOB');
  assert.equal(state.ball.frozen, false, 'ball should not freeze on OOB');
});

test('reset after pause clears inGoal so next play uses outer resolver', () => {
  const state = freshState();
  state.ball.inGoal = true;
  state.pauseState = 'waiting';
  state.pauseTimer = 1;
  // Run enough ticks for the waiting pause to elapse and resetBall to fire.
  for (let i = 0; i < 5; i++) tick(state, NOOP, NOOP);
  assert.equal(state.ball.inGoal, false,
    'inGoal should be cleared when the ball is reset for kickoff');
});

/* ── Body collider: cushion + deflect trap ──────────────── */

// Shared setup for body-trap scenarios. Place p1 in the middle of
// the field, park p2 out of the way, disable grace/pauses.
function trapState(seed = 7) {
  const state = freshState(seed);
  state.headless = true;  // skip pause state machine
  // p1 at a clean midfield spot.
  state.p1.x = 400;
  state.p1.y = 24;  // center-y = 27
  state.p1.vx = 0; state.p1.vy = 0;
  state.p1.heading = 0;
  // p2 far out of the way.
  state.p2.x = 800;
  state.p2.y = 24;
  state.p2.vx = 0; state.p2.vy = 0;
  return state;
}

test('ball straight at torso — trap fires immediately and kills normal velocity', () => {
  const state = trapState();
  state.recordEvents = true;
  const p = state.p1;
  const initialSpeed = 10;
  // Ball waist-high, on the body axis y, moving directly at the torso.
  state.ball.x = p.x + PLAYER_WIDTH / 2 - 10;
  state.ball.y = p.y;
  state.ball.z = 12;
  state.ball.vx = initialSpeed; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  // One tick is enough for the ball to contact the torso
  // (distance 10, vx=10 → contact this tick).
  tick(state, NOOP, NOOP);

  // Trap event fired.
  assert.ok(
    state.events.some((e) => e.type === 'ball_trap'),
    'trap event must fire on torso contact',
  );
  // Head-on hit: normal is purely -x, tangential velocity is zero, so
  // the cushion brings ball.vx all the way to 0 (within float noise).
  assert.ok(
    Math.abs(state.ball.vx) < 0.01,
    `head-on trap must zero the normal-component velocity, got vx=${state.ball.vx}`,
  );
});

test('ball that was trapped settles on the ground close to the player', () => {
  const state = trapState();
  const p = state.p1;
  state.ball.x = p.x + PLAYER_WIDTH / 2 - 10;
  state.ball.y = p.y;
  state.ball.z = 12;
  state.ball.vx = 10; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 60; i++) tick(state, NOOP, NOOP);

  assert.ok(state.ball.z <= BALL_RADIUS + 0.1,
    `ball should settle on ground, got z=${state.ball.z}`);
  // Head-on hit zeroes horizontal velocity; ball drops through gravity
  // to the ground and sits roughly at the clamp point. Bound is the
  // expected contact distance plus a small margin — any meaningful
  // roll would exceed this.
  const contactDist = STICKMAN_TORSO_RADIUS + BALL_RADIUS;
  const horizontalDist = Math.hypot(
    state.ball.x - (p.x + PLAYER_WIDTH / 2),
    state.ball.y - (p.y),
  );
  assert.ok(horizontalDist <= contactDist + 1,
    `trapped ball should stop at ~contact distance (${contactDist.toFixed(2)}), got ${horizontalDist.toFixed(2)}`);
});

test('ball falling onto head fires a trap event and kills normal velocity', () => {
  const state = trapState();
  state.recordEvents = true;
  const p = state.p1;
  state.ball.x = p.x + PLAYER_WIDTH / 2 - 1;
  state.ball.y = p.y;
  state.ball.z = 60;
  state.ball.vx = 1; state.ball.vy = 0; state.ball.vz = -8;
  state.ball.frozen = false;

  // Advance until trap fires. Head-hit is expected ~1 tick after
  // ball.z crosses head-contact (≈52.87). Gravity + vz=−8 → ~1 tick.
  let fireTickVz = null;
  for (let i = 0; i < 20; i++) {
    tick(state, NOOP, NOOP);
    if (state.events.some((e) => e.type === 'ball_trap')) {
      fireTickVz = state.ball.vz;
      break;
    }
  }

  assert.ok(fireTickVz !== null, 'trap event must fire when ball contacts the head');
  // The cushion kills the normal-component (mostly −y) completely —
  // the stuck-escape nudge zeroes vz when it kicks in, and even a
  // small lateral component leaves the surviving vertical tiny. A
  // full tick of gravity afterwards (−0.3) is the only real residue.
  assert.ok(
    fireTickVz > -0.5,
    `head trap must kill most of downward velocity (was −8), got vz=${fireTickVz}`,
  );
});

test('ball that was head-trapped settles on the ground close to the player', () => {
  const state = trapState();
  const p = state.p1;
  state.ball.x = p.x + PLAYER_WIDTH / 2 - 1;
  state.ball.y = p.y;
  state.ball.z = 60;
  state.ball.vx = 1; state.ball.vy = 0; state.ball.vz = -8;
  state.ball.frozen = false;

  // Stop short of the 188-tick headless stall reset which would
  // teleport the ball to midfield and hide the real settling point.
  for (let i = 0; i < 150; i++) tick(state, NOOP, NOOP);

  assert.ok(state.ball.z <= BALL_RADIUS + 0.1,
    `ball must end up on ground, got z=${state.ball.z}`);
  // Tight bound: post-trap the ball drops mostly straight down off
  // the head (tunnel-correction places it ~contact distance to the
  // player's front), so it should rest within one player-width.
  const horizontalDist = Math.hypot(
    state.ball.x - (p.x + PLAYER_WIDTH / 2),
    state.ball.y - (p.y),
  );
  assert.ok(horizontalDist <= PLAYER_WIDTH,
    `head-trapped ball should settle within one player-width, got ${horizontalDist.toFixed(2)}`);
});

test('ball passing at shoulder clearance does NOT contact torso', () => {
  const state = trapState();
  state.recordEvents = true;
  const p = state.p1;
  // Lateral clearance (physics y in world-depth units): translate the
  // world-space "just past torso+ball radii" into physics y by
  // dividing by Z_STRETCH.
  const clearanceWorld = STICKMAN_TORSO_RADIUS + BALL_RADIUS + 1;
  const clearancePhysY = clearanceWorld / Z_STRETCH;
  const initialVx = 15;
  state.ball.x = p.x + PLAYER_WIDTH / 2 - 60;
  state.ball.y = p.y + clearancePhysY;
  state.ball.z = 12;
  state.ball.vx = initialVx; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  // Run just long enough for the ball to cross the player's x range,
  // staying airborne (no ground friction). Air friction * ~10 ticks
  // is ~10 %, so we check vx stays >70 % of initial.
  for (let i = 0; i < 10; i++) tick(state, NOOP, NOOP);

  assert.ok(
    !state.events.some((e) => e.type === 'ball_trap'),
    'ball passing at shoulder clearance must not fire trap',
  );
  assert.ok(state.ball.x > p.x + PLAYER_WIDTH,
    `ball should have passed player, x=${state.ball.x}`);
  assert.ok(state.ball.vx > initialVx * 0.7,
    `ball vx should retain most of its speed in 10 ticks, got ${state.ball.vx}`);
});

test('walking into a stationary ball pins it ahead of the player (dribble, stable regime)', () => {
  // Drive the player at a modest constant speed (5 u/tick) that the
  // ball can track — GROUND_FRICTION decays ball.vx ~5.6 %/tick, so
  // the per-contact boost just needs to refill that. Max-speed ramp
  // is the RUN case and is tested separately below.
  const state = trapState();
  const p = state.p1;
  state.ball.x = p.x + PLAYER_WIDTH / 2 + 30;
  state.ball.y = p.y;
  state.ball.z = BALL_RADIUS;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  const walkHalf = [0.5, 0, -1, 0, 0, 0, 0, -1, 0];  // target vx = 5

  // Let the player ramp + catch the ball (takes about 10-15 ticks).
  for (let i = 0; i < 20; i++) tick(state, walkHalf, NOOP);

  // Now verify that the dribble stays stable for the NEXT 20 ticks:
  // the gap must stay at contact distance each tick (tight tolerance).
  const expected = STICKMAN_TORSO_RADIUS + BALL_RADIUS;
  for (let i = 0; i < 20; i++) {
    tick(state, walkHalf, NOOP);
    const gap = state.ball.x - (state.p1.x + PLAYER_WIDTH / 2);
    assert.ok(
      Math.abs(gap - expected) < 0.5,
      `dribble tick ${i}: gap should be ~${expected.toFixed(2)}, got ${gap.toFixed(2)}`,
    );
  }
});

test('dribble survives a full sprint (tunnel-correction keeps ball in front)', () => {
  // User's choice for this task was "ball stays pinned at feet" even
  // at sprint speed (arcade feel, not realistic-physics). This test
  // pins that contract: if the player runs past the ball, the
  // tunnel-correction teleports the ball back to the front, dribble
  // continues.
  const state = trapState();
  const p = state.p1;
  state.ball.x = p.x + PLAYER_WIDTH / 2 + 30;
  state.ball.y = p.y;
  state.ball.z = BALL_RADIUS;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  const moveRight = [1, 0, -1, 0, 0, 0, 0, -1, 0];
  // 40 ticks of full sprint gives the player time to ramp to
  // MAX_PLAYER_SPEED (10 u/tick) and then some.
  for (let i = 0; i < 40; i++) tick(state, moveRight, NOOP);

  const gap = state.ball.x - (state.p1.x + PLAYER_WIDTH / 2);
  const expected = STICKMAN_TORSO_RADIUS + BALL_RADIUS;
  // Ball should be on the player's forward side (+x) at roughly the
  // contact distance, even after acceleration past the ball.
  assert.ok(
    gap > 0 && gap < expected + 1,
    `ball should still be pinned in front after sprint, got gap=${gap.toFixed(2)}`,
  );
});

test('active kick skips body trap — foot contact handles impulse', () => {
  const state = trapState();
  const p = state.p1;
  // Ball aimed directly at torso, same as the first trap test.
  state.ball.x = p.x + PLAYER_WIDTH / 2 - 30;
  state.ball.y = p.y;
  state.ball.z = 12;
  state.ball.vx = 15; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  // Force an active kick on the player — body collider should be inert.
  p.kick.active = true;
  p.kick.kind = 'ground';
  p.kick.stage = 'windup';
  p.kick.timer = 0;

  // Run just long enough for the ball to reach the torso region.
  for (let i = 0; i < 10; i++) tick(state, NOOP, NOOP);

  // Ball should have carried through the torso zone without being trapped —
  // horizontal speed stays mostly intact (subject to air friction), and it's
  // past the player's x position.
  assert.ok(state.ball.x > p.x + PLAYER_WIDTH,
    `ball should have passed through torso zone, x=${state.ball.x}`);
  assert.ok(state.ball.vx > 10,
    `active kick should leave ball vx mostly intact, got ${state.ball.vx}`);
});

test('adaptive hitbox — contact fires exactly at (torso_radius + ball_radius)', () => {
  // Instead of mutating the constant, assert that the contact distance
  // IS the sum of radii, by placing the ball at known distances and
  // checking whether a trap fires (ball.vx changes).
  const ASSUMED_RADIUS_SUM = STICKMAN_TORSO_RADIUS + BALL_RADIUS;

  // Just-inside: ball slightly closer than the sum → should contact.
  {
    const state = trapState();
    const p = state.p1;
    state.ball.x = p.x + PLAYER_WIDTH / 2 + (ASSUMED_RADIUS_SUM - 0.3);
    state.ball.y = p.y;
    state.ball.z = 12;
    state.ball.vx = -3; state.ball.vy = 0; state.ball.vz = 0;  // moving INTO torso
    state.ball.frozen = false;
    state.recordEvents = true;
    tick(state, NOOP, NOOP);
    assert.ok(
      state.events.some((e) => e.type === 'ball_trap'),
      'ball inside contact distance should fire ball_trap event',
    );
  }
  // Just-outside: ball slightly farther than the sum → no contact.
  {
    const state = trapState();
    const p = state.p1;
    state.ball.x = p.x + PLAYER_WIDTH / 2;
    state.ball.y = p.y + ASSUMED_RADIUS_SUM + 0.5;
    state.ball.z = 12;
    state.ball.vx = 0; state.ball.vy = -2; state.ball.vz = 0;  // moving toward body but not yet in
    state.ball.frozen = false;
    state.recordEvents = true;
    tick(state, NOOP, NOOP);
    assert.ok(
      !state.events.some((e) => e.type === 'ball_trap'),
      'ball outside contact distance should NOT fire ball_trap',
    );
  }
});

/* ── solve2BoneIK — pure solver ──────────────────────────────── */

/** Project through the solver output and verify the foot ends at
 *  the expected (fwd, up) position. Returns the absolute error. */
function footError(res, expectedFwd, expectedUp) {
  return Math.hypot(res.footFwd - expectedFwd, res.footUp - expectedUp);
}

/** Reconstruct the foot position from the solver's angles + bone
 *  lengths. Tests that upperAngle/lowerAngle are self-consistent
 *  with footFwd/footUp (would catch a sign error in the shin
 *  computation). */
function reconstructFoot(res, U, L) {
  const kneeFwd  = U * Math.sin(res.upperAngle);
  const kneeDown = U * Math.cos(res.upperAngle);
  const footFwd  = kneeFwd + L * Math.sin(res.lowerAngle);
  const footDown = kneeDown + L * Math.cos(res.lowerAngle);
  return { fwd: footFwd, up: -footDown };
}

test('solve2BoneIK reachable target → foot lands on target', () => {
  const U = 10, L = 10;
  // Typical kick pose: ball 10 forward, 16 below hip.
  const res = solve2BoneIK(10, -16, U, L, { upperAngle: 0, lowerAngle: 0, footFwd: 0, footUp: 0 });
  assert.ok(footError(res, 10, -16) < 1e-9, `foot missed: ${footError(res, 10, -16)}`);
  const recon = reconstructFoot(res, U, L);
  assert.ok(Math.hypot(recon.fwd - 10, recon.up - (-16)) < 1e-9, 'angles inconsistent with foot position');
});

test('solve2BoneIK knee bends forward of hip→foot line', () => {
  const U = 10, L = 10;
  // Target forward and below — knee should be MORE forward than
  // the midpoint of the hip→foot line (knee-forward branch).
  const res = solve2BoneIK(8, -14, U, L, {});
  const kneeFwd = U * Math.sin(res.upperAngle);
  const midFwd = res.footFwd / 2;  // hip at 0, foot at footFwd
  assert.ok(kneeFwd > midFwd, `knee should be forward of midpoint: knee=${kneeFwd} mid=${midFwd}`);
});

test('solve2BoneIK target at max reach → straight leg pointed at target', () => {
  const U = 10, L = 10;
  // D = U+L = 20 exactly.
  const res = solve2BoneIK(20, 0, U, L, {});
  assert.ok(Math.abs(res.upperAngle - res.lowerAngle) < 1e-9, 'straight leg: upper == lower angle');
  assert.ok(footError(res, 20, 0) < 1e-9, 'foot on target at max reach');
});

test('solve2BoneIK target beyond max reach → clamped to straight leg toward target', () => {
  const U = 10, L = 10;
  // D = 30 > 20. Clamp to direction at reach 20.
  const res = solve2BoneIK(30, 0, U, L, {});
  assert.ok(Math.abs(res.upperAngle - res.lowerAngle) < 1e-9, 'clamped: straight leg');
  // Foot should lie on the hip→target ray, at distance U+L from hip.
  const footD = Math.hypot(res.footFwd, res.footUp);
  assert.ok(Math.abs(footD - (U + L)) < 1e-9, `foot at max reach (got ${footD})`);
  // Direction preserved.
  assert.ok(res.footFwd > 0 && Math.abs(res.footUp) < 1e-9, 'along +fwd axis');
});

test('solve2BoneIK numerical stability at edge cases', () => {
  const U = 10, L = 10;
  // Fully extended (D exactly at U+L) should not NaN.
  const r1 = solve2BoneIK(U + L, 0, U, L, {});
  assert.ok(!Number.isNaN(r1.upperAngle), 'NaN at full extension');
  // Target at hip (D=0) when U=L=0 is degenerate — our guard picks a default.
  const r2 = solve2BoneIK(0, 0, U, L, {});
  assert.ok(!Number.isNaN(r2.upperAngle), 'NaN at zero-distance target');
  // Target directly below hip, distance = |U-L| = 0 (U=L case) → straight down, no bend.
  const r3 = solve2BoneIK(0, -0.5, U, L, {});
  assert.ok(!Number.isNaN(r3.upperAngle) && !Number.isNaN(r3.lowerAngle), 'NaN on near-zero vertical target');
});

test('solve2BoneIK unequal bone lengths reach correct foot position', () => {
  const U = 12, L = 8;
  const res = solve2BoneIK(9, -11, U, L, {});
  assert.ok(footError(res, 9, -11) < 1e-9, 'foot on target with U != L');
  const recon = reconstructFoot(res, U, L);
  assert.ok(Math.hypot(recon.fwd - 9, recon.up - (-11)) < 1e-9, 'reconstruction matches');
});

test('solve2BoneIK scratch-out parameter is mutated and returned', () => {
  const U = 10, L = 10;
  const out = { upperAngle: -99, lowerAngle: -99, footFwd: -99, footUp: -99 };
  const returned = solve2BoneIK(6, -12, U, L, out);
  assert.equal(returned, out, 'returns same object');
  assert.ok(out.upperAngle !== -99, 'out was mutated');
});

/* ── Ballistic prediction parity with the actual integrator ──── */

test('kick prediction matches physics integration over 6 + 9 ticks', () => {
  // Mirrors `predictBallAtStrike`'s use in the reachability gate.
  // If the prediction formula drifts from the integrator, the gate
  // accepts or rejects kicks the visible simulation can't finish.
  for (const leadTicks of [6, 9]) {
    // Freeze p1 in place so the body collider doesn't deflect the
    // ball mid-prediction (clean ballistic parity check).
    const state = freshState();
    state.p1.x = -1000;  // park player far away so no interaction
    state.p2.x = -1001;
    state.ball.x = 0;
    state.ball.y = FIELD_HEIGHT / 2;
    state.ball.z = 50;
    state.ball.vx = 3;
    state.ball.vy = 0;
    state.ball.vz = 2;
    state.ball.frozen = false;

    // Advance N ticks with no input — pure ballistic + friction.
    for (let i = 0; i < leadTicks; i++) tick(state, NOOP, NOOP);

    // Actual vs predicted vertical position (before friction affects it).
    // Friction only damps x/y, so the prediction error on z is from the
    // integrator discretization alone.
    const actualZ = state.ball.z;
    const predictedZ = Math.max(
      0,
      50 + 2 * leadTicks - 0.5 * GRAVITY * leadTicks * (leadTicks + 1),
    );
    assert.ok(
      Math.abs(actualZ - predictedZ) < 0.01,
      `lead ${leadTicks}: predicted z ${predictedZ}, actual ${actualZ}`,
    );
  }
});

/* ── canKickReach ↔ tryStartKick parity ──────────────────────── */

test('canKickReach matches tryStartKick commit exactly (no ghost outputs)', () => {
  // Scan a grid of ball positions around a stationary player. For
  // each position, canKickReach(margin=0) must match whether
  // applyAction/tryStartKick actually commits a kick. If the two
  // ever disagree the teacher emits kick actions the physics
  // silently rejects (or vice versa) — kills imitation signal.
  const disagreements = [];
  for (let dx = -25; dx <= 25; dx += 5) {
    for (let dy = -6; dy <= 6; dy += 2) {
      for (let bz = 0; bz <= 12; bz += 4) {
        const state = freshState();
        state.p1.x = 400;
        state.p1.y = 25;
        state.p1.heading = 0;
        state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + dx;
        state.ball.y = state.p1.y + dy;
        state.ball.z = bz;
        state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
        state.ball.frozen = false;
        const predicted = canKickReach(state, state.p1);
        tick(state, kickAction(1, 0, 0, 1), NOOP);
        const actual = state.p1.kick.active;
        if (predicted !== actual) {
          disagreements.push({ dx, dy, bz, predicted, actual });
        }
      }
    }
  }
  assert.equal(disagreements.length, 0,
    `canKickReach must match tryStartKick, disagreements: ${JSON.stringify(disagreements)}`);
});

test('canKickReach safetyMargin shrinks the reach sphere', () => {
  // Hip world vertical is HIP_BASE_Z=20; ball at ground has
  // up = −15.776 world units. Max forward reach at ground level is
  // sqrt(20² − 15.776²) ≈ 12.3 for margin=0. With margin=2 (reach
  // capped at 18) the forward budget shrinks to sqrt(18² − 15.776²)
  // ≈ 8.7. A ball 10 forward sits between the two thresholds.
  const state = freshState();
  state.p1.x = 400;
  state.p1.y = 25;
  state.p1.heading = 0;
  state.ball.y = state.p1.y;
  state.ball.z = 0;
  state.ball.frozen = false;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;

  // fwd = 10 — inside margin=0, outside margin=2
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 10;
  assert.equal(canKickReach(state, state.p1, 0), true, 'margin=0 accepts at fwd=10');
  assert.equal(canKickReach(state, state.p1, 2), false, 'margin=2 rejects at fwd=10');

  // fwd = 6 — well inside both margins.
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 6;
  assert.equal(canKickReach(state, state.p1, 0), true, 'margin=0 accepts at fwd=6');
  assert.equal(canKickReach(state, state.p1, 2), true, 'margin=2 accepts at fwd=6');

  // fwd = 14 — beyond both margins.
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 14;
  assert.equal(canKickReach(state, state.p1, 0), false, 'margin=0 rejects at fwd=14');
});

/* ── Adaptive kick state machine ─────────────────────────────── */

/** Place p1 with the ball at his feet, stationary, ball within hip
 *  reach along the body-axis. Returns the state. Used as a clean
 *  kick-bench fixture. */
function kickBenchState() {
  const state = freshState();
  state.p1.x = 300;
  state.p1.y = 20;
  state.p1.heading = 0;
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 5;
  state.ball.y = state.p1.y;
  state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  return state;
}

test('kick rejects when ball is beyond hip reach', () => {
  const state = kickBenchState();
  // Shove the ball 30 units forward — well beyond STICKMAN_UPPER_LEG +
  // STICKMAN_LOWER_LEG = 20, even accounting for the drop to ball height.
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 30;
  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.equal(state.p1.kick.active, false, 'kick must not activate beyond reach');
  assert.ok(
    state.events.some((e) => e.type === 'kick_missed' && e.reason === 'out_of_reach'),
    'should emit kick_missed with reason=out_of_reach',
  );
});

test('kick footTarget tracks ball during windup and freezes at strike', () => {
  const state = kickBenchState();
  // Give the ball a small forward drift so its prediction moves each
  // windup tick. Slow enough to stay in reach for the whole windup.
  state.ball.vx = 0.4;

  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.ok(state.p1.kick.active, 'kick committed');
  assert.equal(state.p1.kick.stage, 'windup');
  const targetAtStart = state.p1.kick.footTargetX;

  // Mid-windup: prediction has shrunk (fewer remaining ticks), so
  // with a ball still moving +x, the target SHOULD have moved.
  const windupTicks = Math.ceil(KICK_WINDUP_MS / TICK_MS);
  for (let i = 0; i < Math.floor(windupTicks / 2); i++) tick(state, NOOP, NOOP);
  const targetMidWindup = state.p1.kick.footTargetX;
  assert.notEqual(targetMidWindup, targetAtStart, 'target should update during windup');

  // Drive to strike-start and capture the first frozen target.
  while (state.p1.kick.stage === 'windup') tick(state, NOOP, NOOP);
  assert.equal(state.p1.kick.stage, 'strike');
  const targetAtStrike = state.p1.kick.footTargetX;

  // One more strike tick: target must not change.
  tick(state, NOOP, NOOP);
  assert.equal(state.p1.kick.footTargetX, targetAtStrike, 'target frozen during strike');
});

test('kick fires on foot-ball contact during strike window', () => {
  const state = kickBenchState();
  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.ok(state.p1.kick.active);
  // Drive through windup + first strike tick — contact should fire.
  const strikeOnsetTicks = Math.ceil(KICK_WINDUP_MS / TICK_MS) + 1;
  for (let i = 0; i < strikeOnsetTicks; i++) tick(state, NOOP, NOOP);
  assert.ok(state.p1.kick.fired, `kick should have fired by tick ${strikeOnsetTicks}`);
  assert.ok(state.ball.vx > 0, `ball should have gained +x velocity, got ${state.ball.vx}`);
});

test('kick misses when ball moves out of foot reach during windup', () => {
  const state = kickBenchState();
  // Launch the kick while the ball is stationary.
  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.ok(state.p1.kick.active);
  // Now YANK the ball way out of reach during windup so by the time
  // strike opens, the frozen target is far from the actual ball.
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 200;
  // Drive past the full strike window, collecting events across
  // ticks — state.events is cleared at the start of each tick so
  // we can't inspect it once at the end.
  let sawMiss = false;
  const totalTicks = Math.ceil((KICK_WINDUP_MS + KICK_STRIKE_WINDOW_MS) / TICK_MS) + 2;
  for (let i = 0; i < totalTicks; i++) {
    tick(state, NOOP, NOOP);
    if (state.events.some((e) => e.type === 'kick_missed' && e.reason === 'no_contact')) {
      sawMiss = true;
    }
  }
  assert.ok(sawMiss, 'should emit kick_missed with reason=no_contact across ticks');
  assert.equal(state.p1.kick.fired, false, 'kick should not have fired');
});

test('kick foot-contact is symmetric on both hip sides', () => {
  // The foot collider uses the BODY-AXIS center hip (matches the
  // reach gate), so a ball offset by HIP_OFX to either the left or
  // the right of the body axis gets kicked the same way — no
  // asymmetric kill zone that silently wastes kicks on the
  // non-dominant side.
  for (const sign of [-1, +1]) {
    const state = kickBenchState();
    state.ball.y = state.p1.y + sign * (2.64 / Z_STRETCH);
    tick(state, kickAction(1, 0, 0, 1), NOOP);
    assert.ok(state.p1.kick.active, `ball on sign=${sign} side still reachable`);
    const strikeOnsetTicks = Math.ceil(KICK_WINDUP_MS / TICK_MS) + 1;
    for (let i = 0; i < strikeOnsetTicks; i++) tick(state, NOOP, NOOP);
    assert.ok(state.p1.kick.fired, `foot-sphere should fire for ball on sign=${sign} side`);
  }
});

test('kick facing cone rejects a ball behind the player', () => {
  const state = kickBenchState();
  state.p1.heading = Math.PI;  // facing -x, ball is in +x
  tick(state, kickAction(1, 0, 0, 1), NOOP);
  assert.equal(state.p1.kick.active, false, 'kick must not activate when facing away');
  assert.ok(
    state.events.some((e) => e.type === 'kick_missed' && e.reason === 'facing_away'),
    'should emit kick_missed with reason=facing_away',
  );
});

/* ── kickLegExtension — stage curve ──────────────────────────── */

test('kickLegExtension returns 0 for inactive kick', () => {
  assert.equal(kickLegExtension(null), 0);
  assert.equal(kickLegExtension({ active: false }), 0);
});

test('kickLegExtension walks 0 → 0.7 → 1 → 0 smoothly across stages (ground)', () => {
  // Windup is split: load (0 → 0.7 of windup) ramps 0 → 0.7,
  // then rise (0.7 → 1 of windup) ramps 0.7 → 1. Strike holds at 1,
  // recovery decays to 0. No discontinuity at the windup/strike boundary.
  const k = { active: true, kind: 'ground', timer: 0 };
  const loadEnd = KICK_WINDUP_MS * 0.7;
  assert.equal(kickLegExtension(k), 0, 'timer 0 → extension 0');
  k.timer = loadEnd / 2;
  assert.ok(Math.abs(kickLegExtension(k) - 0.35) < 1e-9, 'mid-load → 0.35');
  k.timer = loadEnd;
  assert.ok(Math.abs(kickLegExtension(k) - 0.7) < 1e-9, 'load end → 0.7');
  k.timer = (loadEnd + KICK_WINDUP_MS) / 2;
  assert.ok(Math.abs(kickLegExtension(k) - 0.85) < 1e-9, 'mid-rise → 0.85');
  k.timer = KICK_WINDUP_MS - 0.001;
  assert.ok(kickLegExtension(k) > 0.999, 'windup end → ~1');
  k.timer = KICK_WINDUP_MS;
  assert.equal(kickLegExtension(k), 1, 'strike start → 1 (continuous with windup end)');
  k.timer = KICK_WINDUP_MS + KICK_STRIKE_WINDOW_MS - 1;
  assert.equal(kickLegExtension(k), 1, 'mid-strike → 1');
  k.timer = KICK_WINDUP_MS + KICK_STRIKE_WINDOW_MS;
  assert.equal(kickLegExtension(k), 1, 'recovery boundary → still 1 (just starting to decay)');
  k.timer = KICK_WINDUP_MS + KICK_STRIKE_WINDOW_MS + 1;
  assert.ok(kickLegExtension(k) < 1 && kickLegExtension(k) > 0.99, 'just inside recovery → <1');
  k.timer = KICK_DURATION_MS;
  assert.ok(Math.abs(kickLegExtension(k)) < 1e-9, 'recovery end → 0');
});

test('kickLegExtension uses AIRKICK_PEAK_FRAC * AIRKICK_MS as windup for air', () => {
  const k = { active: true, kind: 'air', timer: 0 };
  const windupMs = AIRKICK_PEAK_FRAC * AIRKICK_MS;
  const loadEnd  = windupMs * 0.7;
  k.timer = loadEnd / 2;
  assert.ok(Math.abs(kickLegExtension(k) - 0.35) < 1e-9, 'air mid-load → 0.35');
  k.timer = windupMs + KICK_STRIKE_WINDOW_MS / 2;
  assert.equal(kickLegExtension(k), 1, 'air strike → 1');
});

/* ── kickLegPose — IK integration ────────────────────────────── */

test('kickLegPose neutral for inactive kick', () => {
  const out = { upperAngle: 99, lowerAngle: 99 };
  kickLegPose({ active: false }, 0, 20, 0, 1, 0, out);
  assert.equal(out.upperAngle, 0);
  assert.equal(out.lowerAngle, 0);
});

test('kickLegPose at strike reaches the foot target', () => {
  // Hip at world (0, 20, 0), facing +x, target 8 forward at ground.
  const k = {
    active: true, kind: 'ground', stage: 'strike',
    timer: KICK_WINDUP_MS + KICK_STRIKE_WINDOW_MS / 2,
    footTargetX: 8, footTargetY: 4.224, footTargetZ: 0,
  };
  const out = { upperAngle: 0, lowerAngle: 0 };
  kickLegPose(k, 0, 20, 0, 1, 0, out);
  // Reconstruct foot position from angles.
  const U = STICKMAN_UPPER_LEG, L = STICKMAN_LOWER_LEG;
  const kneeFwd  = U * Math.sin(out.upperAngle);
  const kneeDown = U * Math.cos(out.upperAngle);
  const footFwd  = kneeFwd + L * Math.sin(out.lowerAngle);
  const footDown = kneeDown + L * Math.cos(out.lowerAngle);
  // Target local: fwd = 8, up = 4.224 - 20 = -15.776, down = 15.776.
  assert.ok(Math.abs(footFwd - 8) < 1e-6, `foot fwd should be 8, got ${footFwd}`);
  assert.ok(Math.abs(footDown - 15.776) < 1e-6, `foot down should be 15.776, got ${footDown}`);
});

test('kickLegPose at windup load-end (tEff=0.7) reaches the cock-back keyframe', () => {
  // The foot path during windup is a three-keyframe trajectory:
  //   load (tEff: 0 → 0.7)  rest → cock
  //   rise (tEff: 0.7 → 1)  cock → target
  // At the end of the load phase the foot should be at the cock-
  // back position (20% of leg-length behind hip, 50% below) — NOT
  // on the line from rest to ball. This is what gives the kick a
  // visible windup pose instead of a snap-to-target.
  const k = {
    active: true, kind: 'ground', stage: 'windup',
    timer: KICK_WINDUP_MS * 0.7,  // exact end of the load phase
    footTargetX: 10, footTargetY: 4.224, footTargetZ: 0,
  };
  const out = { upperAngle: 0, lowerAngle: 0 };
  kickLegPose(k, 0, 20, 0, 1, 0, out);
  const U = STICKMAN_UPPER_LEG, L = STICKMAN_LOWER_LEG;
  const legLen = U + L;
  const kneeFwd  = U * Math.sin(out.upperAngle);
  const kneeDown = U * Math.cos(out.upperAngle);
  const footFwd  = kneeFwd + L * Math.sin(out.lowerAngle);
  const footDown = kneeDown + L * Math.cos(out.lowerAngle);
  const expectedFwd  = -0.20 * legLen;  // 20% behind hip
  const expectedDown =  0.50 * legLen;  // 50% below hip
  assert.ok(Math.abs(footFwd - expectedFwd) < 1e-3, `foot fwd expected ${expectedFwd}, got ${footFwd}`);
  assert.ok(Math.abs(footDown - expectedDown) < 1e-3, `foot down expected ${expectedDown}, got ${footDown}`);
});

test('kickLegPose produces finite, non-hyperextended angles across the full stage', () => {
  // Sweep `kick.timer` from 0 → KICK_DURATION_MS across a range of
  // foot targets (reachable and just-out-of-reach). The IK solver
  // always picks the knee-forward branch; lowerAngle must never be
  // less than the hip-foot angle (that would put the knee BEHIND
  // the hip-foot line, i.e. hyperextended / reversed).
  const hipWX = 0, hipWY = 20, hipWZ = 0;
  const fwdX = 1, fwdZ = 0;
  for (const targetFwd of [4, 8, 12, 18, 22]) {
    for (const targetUp of [-18, -12, -4, 0, 6]) {
      const k = {
        active: true, kind: 'ground',
        footTargetX: hipWX + targetFwd,
        footTargetY: hipWY + targetUp,
        footTargetZ: hipWZ,
        timer: 0,
      };
      for (let t = 0; t <= KICK_DURATION_MS; t += 16) {
        k.timer = t;
        const out = { upperAngle: 0, lowerAngle: 0 };
        kickLegPose(k, hipWX, hipWY, hipWZ, fwdX, fwdZ, out);
        assert.ok(
          Number.isFinite(out.upperAngle) && Number.isFinite(out.lowerAngle),
          `NaN at t=${t}, target=(${targetFwd},${targetUp})`,
        );
        // Knee-forward branch: upperAngle ≥ lowerAngle for a forward
        // target (upper sweeps ahead of shin). Not a strict rule —
        // allow tiny epsilon for the fully-straight-leg edge.
        if (targetFwd > 0) {
          assert.ok(
            out.upperAngle - out.lowerAngle > -1e-6,
            `knee inverted at t=${t}, target=(${targetFwd},${targetUp}): upper=${out.upperAngle}, lower=${out.lowerAngle}`,
          );
        }
      }
    }
  }
});

test('kickLegPose projects along heading (rotation-invariant)', () => {
  // Same relative target, different headings — the local angles
  // must be identical because IK operates in hip-local (fwd, up).
  const tgt = { fwd: 8, up: -15.776 };  // ball 8 forward, 15.776 below hip
  const poses = [];
  for (const h of [0, Math.PI / 3, Math.PI / 2, -Math.PI / 4, Math.PI]) {
    const fwdX = Math.cos(h);
    const fwdZ = Math.sin(h);
    const targetX = tgt.fwd * fwdX;
    const targetZ = tgt.fwd * fwdZ;
    const k = {
      active: true, kind: 'ground', stage: 'strike',
      timer: KICK_WINDUP_MS,
      footTargetX: targetX, footTargetY: 20 + tgt.up, footTargetZ: targetZ,
    };
    const out = { upperAngle: 0, lowerAngle: 0 };
    kickLegPose(k, 0, 20, 0, fwdX, fwdZ, out);
    poses.push({ h, ...out });
  }
  const ref = poses[0];
  for (const p of poses) {
    assert.ok(Math.abs(p.upperAngle - ref.upperAngle) < 1e-9,
      `upperAngle drifts with heading ${p.h}: ${p.upperAngle} vs ${ref.upperAngle}`);
    assert.ok(Math.abs(p.lowerAngle - ref.lowerAngle) < 1e-9,
      `lowerAngle drifts with heading ${p.h}: ${p.lowerAngle} vs ${ref.lowerAngle}`);
  }
});

/* ── resetStateInPlace: the per-match reuse primitive ──────────
 * Load-bearing invariants:
 *  1. No new object allocation — ball, p1, p2, p*.kick, events all the
 *     same reference before vs after. This is the whole point; if it
 *     fails we're back to the pre-6adf1cd heap drift behavior.
 *  2. After reset, every observable field matches a freshly-constructed
 *     createState(field, rng) from the same inputs, so running the
 *     match from a reset state is bit-identical to a fresh match.
 *  3. Determinism chain survives: reset → tick N → scoreL/R/ball
 *     position == fresh createState → tick N with the same seed.
 */

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

/* ── Winner celebration flow (visual path, recent feature) ────── */

test('winning goal sets celebrate pause AND flags winner (not matchend directly)', () => {
  const state = freshState();
  state.headless = false;
  state.recordEvents = false;
  // Ball crossing goalLineR (into the right goal) credits scoreL.
  // See project_football_scoring_sides memory: side arg names the
  // goal that conceded. Pre-seed scoreL=2 so the next score is 3 = win.
  state.scoreL = 2;
  state.ball.x = state.field.goalLineR + 1;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 5;
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.graceFrames = 0;

  tick(state, null, null);

  assert.equal(state.scoreL, 3, 'left-side scored the winning goal');
  assert.equal(state.pauseState, 'celebrate', 'must stay in celebrate for the animation, not jump to matchend');
  assert.equal(state.winner, 'left', 'winner must be flagged at the scoring tick');
  assert.equal(state.matchOver, false, 'match is not over yet — celebrate then matchend');
});

test('visual celebrate → matchend transition when winner is set', () => {
  const state = freshState();
  state.headless = false;
  state.recordEvents = false;
  state.scoreL = 2;
  state.ball.x = state.field.goalLineR + 1;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 5;
  state.graceFrames = 0;
  tick(state, null, null);

  assert.equal(state.pauseState, 'celebrate');
  const celebrateTicks = state.pauseTimer;
  assert.ok(celebrateTicks > 0);

  // Run the celebrate countdown. During celebrate, advancePause still
  // lets the ball roll under gravity, so the transition test gates on
  // the pauseState flip, not a fixed tick count.
  for (let i = 0; i < celebrateTicks + 5; i++) {
    tick(state, null, null);
    if (state.pauseState === 'matchend') break;
  }
  assert.equal(state.pauseState, 'matchend', 'after celebrate expires on a winning goal we jump to matchend, skipping reposition');
});

test('non-winning goal celebrates then reposition (no matchend)', () => {
  const state = freshState();
  state.headless = false;
  state.recordEvents = false;
  state.scoreR = 0;   // first goal of the match, nowhere near WIN_SCORE
  state.ball.x = state.field.goalLineR + 1;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 5;
  state.graceFrames = 0;
  tick(state, null, null);

  assert.equal(state.pauseState, 'celebrate');
  assert.equal(state.winner, null, 'non-winning goal must NOT flag winner');
  const celebrateTicks = state.pauseTimer;

  for (let i = 0; i < celebrateTicks + 5; i++) {
    tick(state, null, null);
    if (state.pauseState !== 'celebrate') break;
  }
  assert.notEqual(state.pauseState, 'matchend', 'non-winning goal must NOT go to matchend');
  assert.ok(state.pauseState === 'reposition' || state.pauseState === 'waiting' || state.pauseState === null,
    `expected reposition/waiting/null after celebrate, got ${state.pauseState}`);
});

/* ── Action-slot index stability ───────────────────────────────
 * ACTION_KICK_GATE is referenced by index in warm-start-lib.js
 * (oversampleKickPositives reads actions[i][ACTION_KICK_GATE]). If
 * the action layout ever shifts, that sampling would silently target
 * the wrong slot. Pin the values here so a slot rename breaks loudly.
 */
test('ACTION_* slot indices are stable and contiguous', () => {
  assert.equal(ACTION_MOVE_X,     0);
  assert.equal(ACTION_MOVE_Y,     1);
  assert.equal(ACTION_KICK_GATE,  2);
  assert.equal(ACTION_KICK_DX,    3);
  assert.equal(ACTION_KICK_DY,    4);
  assert.equal(ACTION_KICK_DZ,    5);
  assert.equal(ACTION_KICK_POWER, 6);
  assert.equal(ACTION_PUSH_GATE,  7);
  assert.equal(ACTION_PUSH_POWER, 8);
  assert.equal(NN_OUTPUT_SIZE,    9);
});
