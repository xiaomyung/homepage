/**
 * Tests for ai/controller.js — end-to-end decide(state, side).
 * Includes the anti-corner-camp regression: a 600-tick match
 * starting with both players in opposite corners must keep them
 * moving (no standing still, no camping).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tick as physicsTick,
  FIELD_HEIGHT,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  ACTION_MOVE_X,
  ACTION_MOVE_Y,
  ACTION_KICK_GATE,
  ACTION_PUSH_GATE,
} from '../physics/index.js';
import { decide, ACTION_VEC_SIZE } from '../ai/controller.js';
import { freshState as baseFreshState } from './helpers/state.mjs';

const freshState = (seed = 42) => baseFreshState(seed, { withAI: true, recordEvents: false });

test('decide returns Float64Array of ACTION_VEC_SIZE finite floats', () => {
  const state = freshState();
  const v = decide(state, 'p1');
  assert.ok(v instanceof Float64Array);
  assert.equal(v.length, ACTION_VEC_SIZE);
  for (let i = 0; i < v.length; i++) assert.ok(Number.isFinite(v[i]));
});

test('Pure determinism: two consecutive calls with same state -> same output', () => {
  const state = freshState();
  state.p1.x = 200; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;

  const v1 = decide(state, 'p1');
  const v2 = decide(state, 'p1');
  for (let i = 0; i < v1.length; i++) {
    assert.equal(v1[i], v2[i], `slot ${i} differs across calls`);
  }
});

test('Self next to ball -> KICK_GATE active', () => {
  const state = freshState();
  // Position ball directly at player centerline, on the ground — the same
  // setup the canKickReach hip-sphere gate accepts (matches existing
  // fallback kick-test fixture).
  state.p1.x = 400;
  state.p1.y = 20;
  state.p1.heading = 0;
  state.p2.x = 800; state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2;
  state.ball.y = state.p1.y;
  state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;

  const v = decide(state, 'p1');
  assert.equal(v[ACTION_KICK_GATE], 1);
});

test('Opp next to ball, self far -> support runs toward ball area (positive moveX for left side)', () => {
  const state = freshState();
  state.p1.x = 100; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 380; state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;

  const v = decide(state, 'p1');
  assert.ok(v[ACTION_MOVE_X] > 0, `expected positive moveX, got ${v[ACTION_MOVE_X]}`);
});

test('Pause state -> all gates -1, MOVE=0', () => {
  const state = freshState();
  state.pauseState = 'celebrate';
  const v = decide(state, 'p1');
  assert.equal(v[ACTION_KICK_GATE], -1);
  assert.equal(v[ACTION_PUSH_GATE], -1);
  assert.equal(v[ACTION_MOVE_X], 0);
  assert.equal(v[ACTION_MOVE_Y], 0);
});

test('Anti-corner-camp regression: players engage on >80% of free ticks across 600-tick match', () => {
  const state = freshState(123);
  // Start both players in opposite corners — the failure mode being tested.
  state.p1.x = 30;
  state.p1.y = 10;
  state.p2.x = state.field.width - 50;
  state.p2.y = FIELD_HEIGHT - 10;
  state.ball.x = state.field.midX;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.recordEvents = false;
  state.headless = true;

  // "Free" tick = neither paused nor self-blocked (kick/push/exhausted).
  // Push and kick windows are forms of engagement, not standing still,
  // so we exclude them from the denominator.
  let p1Moves = 0, p1Free = 0;
  let p2Moves = 0, p2Free = 0;

  const isBlocked = (p) => p.exhausted || p.kick.active || p.pushTimer > 0 || p.reactTimer > 0;

  const TOTAL = 600;
  for (let i = 0; i < TOTAL; i++) {
    if (state.pauseState !== null) {
      physicsTick(state, null, null);
      continue;
    }
    const a1 = decide(state, 'p1');
    const a2 = decide(state, 'p2');
    if (!isBlocked(state.p1)) {
      p1Free++;
      if (Math.hypot(a1[ACTION_MOVE_X], a1[ACTION_MOVE_Y]) > 0.05) p1Moves++;
    }
    if (!isBlocked(state.p2)) {
      p2Free++;
      if (Math.hypot(a2[ACTION_MOVE_X], a2[ACTION_MOVE_Y]) > 0.05) p2Moves++;
    }
    physicsTick(state, a1, a2);
    if (state.matchOver) break;
  }

  const p1Frac = p1Moves / Math.max(1, p1Free);
  const p2Frac = p2Moves / Math.max(1, p2Free);
  assert.ok(p1Frac > 0.8, `p1 moved on ${(p1Frac * 100).toFixed(1)}% of free ticks (need > 80%)`);
  assert.ok(p2Frac > 0.8, `p2 moved on ${(p2Frac * 100).toFixed(1)}% of free ticks (need > 80%)`);
});

test('Anti-corner-camp regression: players engage (kick or push fires) over 600 ticks', () => {
  const state = freshState(456);
  // Start just outside the goal-box footprint so the goal-frame collision
  // doesn't pin a player whose initial pursuit happens to clip the mouth.
  // The test is about engagement, not goal-line behaviour.
  state.p1.x = 130; state.p1.y = 5;
  state.p2.x = state.field.width - 150; state.p2.y = FIELD_HEIGHT - 5;
  state.ball.x = state.field.midX;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.recordEvents = false;
  state.headless = true;

  // Engagement = either side committed to a kick OR a push gate over the
  // window. Both demonstrate "they reached and acted on the ball/opp",
  // which is the anti-camp invariant.
  let actions = 0;
  for (let i = 0; i < 600; i++) {
    if (state.pauseState !== null) {
      physicsTick(state, null, null);
      continue;
    }
    const a1 = decide(state, 'p1');
    const a2 = decide(state, 'p2');
    if (a1[ACTION_KICK_GATE] === 1 || a1[ACTION_PUSH_GATE] === 1) actions++;
    if (a2[ACTION_KICK_GATE] === 1 || a2[ACTION_PUSH_GATE] === 1) actions++;
    physicsTick(state, a1, a2);
    if (state.matchOver) break;
  }

  assert.ok(actions > 0, 'expected at least one kick or push committed over 600 ticks of pure-press');
});
