// Mirror of tests/physics.test.mjs — collisions group.
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
} from '../../physics/index.js';
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

