/**
 * Tests for ai/action.js — intent + perception -> 9-float action vector.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD_HEIGHT,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  ACTION_MOVE_X,
  ACTION_MOVE_Y,
  ACTION_KICK_GATE,
  ACTION_KICK_DX,
  ACTION_KICK_POWER,
  ACTION_PUSH_GATE,
  ACTION_PUSH_POWER,
} from '../physics.js';
import { perceive } from '../ai/perception.js';
import { encode, ACTION_VEC_SIZE } from '../ai/action.js';
import { INTENT_KINDS } from '../ai/decision.js';
import {
  STAMINA_CONSERVE_THRESHOLD,
  STAMINA_CONSERVE_MAGNITUDE,
  PUSH_POWER_BASE,
} from '../ai/tuning.js';
import { freshState } from './helpers/state.mjs';

const personality = { kickAimYOffset: 0, pushPowerScale: 1 };

test('NEUTRAL intent encodes all gates -1 and zero movement', () => {
  const state = freshState();
  const perception = perceive(state, 'p1');
  const intent = { kind: INTENT_KINDS.NEUTRAL, role: null, push: false };
  const v = encode(state, 'p1', perception, intent, personality);
  assert.equal(v.length, ACTION_VEC_SIZE);
  assert.equal(v[ACTION_MOVE_X], 0);
  assert.equal(v[ACTION_MOVE_Y], 0);
  assert.equal(v[ACTION_KICK_GATE], -1);
  assert.equal(v[ACTION_PUSH_GATE], -1);
});

test('CONTENDER_RUN moves toward target, no kick', () => {
  const state = freshState();
  state.p1.x = 200; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  const perception = perceive(state, 'p1');
  const intent = {
    kind: INTENT_KINDS.CONTENDER_RUN,
    role: 'contender',
    target: perception.attackKickSpot,
    push: false,
  };
  const v = encode(state, 'p1', perception, intent, personality);
  assert.ok(v[ACTION_MOVE_X] > 0, 'expected positive moveX toward kick spot');
  assert.equal(v[ACTION_KICK_GATE], -1);
});

test('CONTENDER_KICK fires kick gate with positive power', () => {
  const state = freshState();
  state.p1.x = 380; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p1.heading = 0;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  const perception = perceive(state, 'p1');
  const intent = { kind: INTENT_KINDS.CONTENDER_KICK, role: 'contender', push: false };
  const v = encode(state, 'p1', perception, intent, personality);
  assert.equal(v[ACTION_KICK_GATE], 1);
  assert.ok(v[ACTION_KICK_POWER] > 0);
  assert.ok(v[ACTION_KICK_DX] > 0, 'kick direction X should point toward right goal for left side');
});

test('CONTENDER_KICK leaves MOVE at zero (player has arrived, plant + strike)', () => {
  const state = freshState();
  state.p1.x = 380; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p1.heading = 0;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  const perception = perceive(state, 'p1');
  const intent = { kind: INTENT_KINDS.CONTENDER_KICK, role: 'contender', push: false };
  const v = encode(state, 'p1', perception, intent, personality);
  // Approach already aligned heading; nudging during windup would shift
  // the hip and break foot-ball contact at strike time.
  assert.equal(v[ACTION_MOVE_X], 0, `CONTENDER_KICK should not move, got MOVE_X=${v[ACTION_MOVE_X]}`);
  assert.equal(v[ACTION_MOVE_Y], 0, `CONTENDER_KICK should not move, got MOVE_Y=${v[ACTION_MOVE_Y]}`);
  // Kick gate still fires.
  assert.equal(v[ACTION_KICK_GATE], 1);
});

test('SUPPORT moves toward kick spot (presses ball)', () => {
  const state = freshState();
  state.p1.x = 100; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  const perception = perceive(state, 'p1');
  const intent = {
    kind: INTENT_KINDS.SUPPORT,
    role: 'support',
    target: perception.attackKickSpot,
    push: false,
  };
  const v = encode(state, 'p1', perception, intent, personality);
  assert.ok(v[ACTION_MOVE_X] > 0);
});

test('Push overlay sets PUSH_GATE and scaled power', () => {
  const state = freshState();
  state.p1.x = 200; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  const perception = perceive(state, 'p1');
  const intent = {
    kind: INTENT_KINDS.SUPPORT,
    role: 'support',
    target: perception.attackKickSpot,
    push: true,
  };
  const customPersonality = { kickAimYOffset: 0, pushPowerScale: 1.1 };
  const v = encode(state, 'p1', perception, intent, customPersonality);
  assert.equal(v[ACTION_PUSH_GATE], 1);
  assert.ok(Math.abs(v[ACTION_PUSH_POWER] - PUSH_POWER_BASE * 1.1) < 1e-6);
});

test('Stamina conserve reduces movement magnitude', () => {
  const state = freshState();
  state.p1.x = 100; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p1.stamina = STAMINA_CONSERVE_THRESHOLD - 0.05;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  const perception = perceive(state, 'p1');
  const intent = {
    kind: INTENT_KINDS.SUPPORT,
    role: 'support',
    target: perception.attackKickSpot,
    push: false,
  };
  const v = encode(state, 'p1', perception, intent, personality);
  const mag = Math.hypot(v[ACTION_MOVE_X], v[ACTION_MOVE_Y]);
  assert.ok(Math.abs(mag - STAMINA_CONSERVE_MAGNITUDE) < 1e-6, `expected reduced magnitude ${STAMINA_CONSERVE_MAGNITUDE}, got ${mag}`);
});

test('Aggressive press: opp.exhausted suppresses conserve mode', () => {
  const state = freshState();
  state.p1.x = 100; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p1.stamina = STAMINA_CONSERVE_THRESHOLD - 0.05;
  state.p2.exhausted = true;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  const perception = perceive(state, 'p1');
  const intent = {
    kind: INTENT_KINDS.SUPPORT,
    role: 'support',
    target: perception.attackKickSpot,
    push: false,
  };
  const v = encode(state, 'p1', perception, intent, personality);
  const mag = Math.hypot(v[ACTION_MOVE_X], v[ACTION_MOVE_Y]);
  assert.ok(mag > 0.99, `expected full magnitude when opp exhausted, got ${mag}`);
});

test('Action vector all values finite', () => {
  const state = freshState();
  state.p1.x = 200; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  const perception = perceive(state, 'p1');
  const intent = {
    kind: INTENT_KINDS.CONTENDER_RUN,
    role: 'contender',
    target: perception.attackKickSpot,
    push: true,
  };
  const v = encode(state, 'p1', perception, intent, personality);
  for (let i = 0; i < v.length; i++) {
    assert.ok(Number.isFinite(v[i]), `slot ${i} non-finite: ${v[i]}`);
  }
});

test('CONTENDER_RUN pursuit closes y proportionally to world distance, not physics distance', async () => {
  // Z_STRETCH = 4.7 compresses physics y vs world z. A pure physics-distance
  // unit vector under-weights y (player closes x fast, y slow → arrives
  // y-mismatched). World-proportional moveToward closes y at a rate
  // proportional to the world depth offset.
  const { Z_STRETCH } = await import('../physics.js');
  const state = freshState();
  state.p1.x = 50; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2 - 5;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2 + 0;
  const perception = perceive(state, 'p1');
  const intent = { kind: INTENT_KINDS.CONTENDER_RUN, role: 'contender', target: { x: 400, y: FIELD_HEIGHT / 2 }, push: false };
  const v = encode(state, 'p1', perception, intent, personality);

  // The unit-vector ratio my/mx should match (dyWorld/dx), not (dyPhys/dx).
  const dx = state.ball.x - (state.p1.x + PLAYER_WIDTH / 2);
  const dyPhys = state.ball.y - (state.p1.y + PLAYER_HEIGHT / 2);
  const expectedRatio = (dyPhys * Z_STRETCH) / dx;
  const actualRatio = v[ACTION_MOVE_Y] / v[ACTION_MOVE_X];
  assert.ok(Math.abs(actualRatio - expectedRatio) < 0.01,
    `expected my/mx ≈ dyWorld/dx = ${expectedRatio.toFixed(3)}, got ${actualRatio.toFixed(3)}`);
});

test('CONTENDER_RUN slows on approach (anti-overshoot)', () => {
  const state = freshState();
  // Far from ball — should run at full magnitude.
  state.p1.x = 50; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  let perception = perceive(state, 'p1');
  let intent = { kind: INTENT_KINDS.CONTENDER_RUN, role: 'contender', target: { x: 400, y: FIELD_HEIGHT / 2 }, push: false };
  let v = encode(state, 'p1', perception, intent, personality);
  const farMag = Math.hypot(v[ACTION_MOVE_X], v[ACTION_MOVE_Y]);
  assert.ok(farMag > 0.9, `far magnitude should be ~1.0, got ${farMag}`);

  // Close to ball — should be at the slowdown floor.
  state.p1.x = 396; // ~5 units from ball center
  perception = perceive(state, 'p1');
  intent = { kind: INTENT_KINDS.CONTENDER_RUN, role: 'contender', target: { x: 400, y: FIELD_HEIGHT / 2 }, push: false };
  v = encode(state, 'p1', perception, intent, personality);
  const closeMag = Math.hypot(v[ACTION_MOVE_X], v[ACTION_MOVE_Y]);
  assert.ok(closeMag < farMag, `close magnitude (${closeMag}) should be less than far magnitude (${farMag})`);
  assert.ok(closeMag <= 0.5, `close magnitude should hit the slowdown floor, got ${closeMag}`);
});

test('Kick power scales with distance to opp goal', () => {
  const state = freshState();
  state.p1.heading = 0;

  state.p1.x = 380;
  state.ball.x = 400;
  state.ball.y = FIELD_HEIGHT / 2;
  const pNear = perceive(state, 'p1');
  const intentNear = { kind: INTENT_KINDS.CONTENDER_KICK, role: 'contender', push: false };
  const vNear = encode(state, 'p1', pNear, intentNear, personality);

  state.p1.x = 80;
  state.ball.x = 100;
  const pFar = perceive(state, 'p1');
  const intentFar = { kind: INTENT_KINDS.CONTENDER_KICK, role: 'contender', push: false };
  const vFar = encode(state, 'p1', pFar, intentFar, personality);

  assert.ok(vFar[ACTION_KICK_POWER] > vNear[ACTION_KICK_POWER]);
});
