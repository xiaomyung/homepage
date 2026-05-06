// Mirror of tests/physics.test.mjs — player group.
// Auto-split; tweak imports here if you add tests that need new exports.


import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createField,
  createState,
  createSeededRng,
  resetStateInPlace,
  tick,
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
  ACTION_VEC_SIZE,
  endMatchByTime,
} from '../../physics.js';
import {
  freshState,
  action,
  NOOP,
  moveAction,
  pushAction,
  kickAction,
} from '../helpers/state.mjs';
import { capsuleDist, trapState, footError, reconstructFoot, kickBenchState } from '../helpers/state.mjs';

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
  assert.equal(ACTION_VEC_SIZE,    9);
});

