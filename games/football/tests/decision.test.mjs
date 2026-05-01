/**
 * Tests for ai/decision.js — perception + role state -> tactical intent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createField,
  createState,
  createSeededRng,
  FIELD_HEIGHT,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
} from '../physics.js';
import { perceive } from '../ai/perception.js';
import { decide, INTENT_KINDS, ROLES } from '../ai/decision.js';
import { ROLE_HYSTERESIS_TICKS } from '../ai/tuning.js';

function freshState(seed = 42) {
  const s = createState(createField(), createSeededRng(seed));
  s.aiRoleState = { left: { role: null, since: 0 }, right: { role: null, since: 0 } };
  s.aiPersonality = {
    left: { kickAimYOffset: 0, pushPowerScale: 1 },
    right: { kickAimYOffset: 0, pushPowerScale: 1 },
  };
  return s;
}

function decideFor(state, which) {
  const perception = perceive(state, which);
  return decide(state, which, perception);
}

test('CONTENDER role assigned when self closer to ball', () => {
  const state = freshState();
  state.p1.x = 250; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 700; state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 300; state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = 0; state.ball.vy = 0;

  const intent = decideFor(state, 'p1');
  assert.equal(intent.role, ROLES.CONTENDER);
});

test('SUPPORT role when opp closer', () => {
  const state = freshState();
  state.p1.x = 700; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 250; state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 300; state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = 0; state.ball.vy = 0;

  const intent = decideFor(state, 'p1');
  assert.equal(intent.role, ROLES.SUPPORT);
});

test('Tiebreak: ball stationary -> side=left is contender', () => {
  const state = freshState();
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = 0; state.ball.vy = 0;
  state.p1.x = 200 - PLAYER_WIDTH / 2;
  state.p2.x = 600 - PLAYER_WIDTH / 2;
  state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;

  const intentL = decideFor(state, 'p1');
  assert.equal(intentL.role, ROLES.CONTENDER);
});

test('Tiebreak: ball moving toward right half -> right is contender', () => {
  const state = freshState();
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = +5; state.ball.vy = 0;
  state.p1.x = 200 - PLAYER_WIDTH / 2;
  state.p2.x = 600 - PLAYER_WIDTH / 2;
  state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;

  const intentR = decideFor(state, 'p2');
  assert.equal(intentR.role, ROLES.CONTENDER);
});

test('Hysteresis: role sticks for ROLE_HYSTERESIS_TICKS once set', () => {
  const state = freshState();
  state.p1.x = 250; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 700; state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 300; state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = 0; state.ball.vy = 0;

  // First call sets role=contender.
  decideFor(state, 'p1');
  assert.equal(state.aiRoleState.left.role, ROLES.CONTENDER);

  // Now flip distances mid-tick — opp is closer.
  state.p1.x = 700;
  state.p2.x = 250;

  // Within hysteresis window the role should stay contender.
  state.tick = 5;
  const intent = decideFor(state, 'p1');
  assert.equal(intent.role, ROLES.CONTENDER);

  // After hysteresis window, role flips.
  state.tick = ROLE_HYSTERESIS_TICKS + 1;
  const intent2 = decideFor(state, 'p1');
  assert.equal(intent2.role, ROLES.SUPPORT);
});

test('Hysteresis: instant flip when opp possesses ball', () => {
  const state = freshState();
  state.p1.x = 250; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 700; state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 300; state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = 0; state.ball.vy = 0;
  decideFor(state, 'p1');
  assert.equal(state.aiRoleState.left.role, ROLES.CONTENDER);

  // Reverse positions and put opp on ball with kick active.
  state.p1.x = 700;
  state.p2.x = 290;
  state.p2.kick.active = true;
  state.tick = 1;

  const intent = decideFor(state, 'p1');
  assert.equal(intent.role, ROLES.SUPPORT);
});

test('Goalie reflex fires only for the threatened side', () => {
  const state = freshState();
  state.p1.x = 100; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 500; state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = state.field.midX - 50;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = -5;
  state.ball.vy = 0;

  const intentL = decideFor(state, 'p1');
  const intentR = decideFor(state, 'p2');
  assert.equal(intentL.kind, INTENT_KINDS.GOALIE);
  assert.notEqual(intentR.kind, INTENT_KINDS.GOALIE);
});

test('Push intent fires when push opportunity true', () => {
  const state = freshState();
  state.p1.x = 100; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 105; state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 130; state.ball.y = FIELD_HEIGHT / 2;
  state.p1.heading = 0;

  const intent = decideFor(state, 'p1');
  assert.equal(intent.push, true);
});

test('Push intent suppressed when opp is exhausted (mercy gate)', () => {
  const state = freshState();
  state.p1.x = 100; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 105; state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 130; state.ball.y = FIELD_HEIGHT / 2;
  state.p1.heading = 0;
  state.p2.exhausted = true;
  state.p2.stamina = 0;

  const intent = decideFor(state, 'p1');
  assert.equal(intent.push, false);
});

test('Push gate covers the opp-winding-up branch too', () => {
  const state = freshState();
  state.p1.x = 100; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 200; state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 250; state.ball.y = FIELD_HEIGHT / 2;
  state.p1.heading = 0;
  state.p2.kick.active = true;
  state.p2.exhausted = true;

  const intent = decideFor(state, 'p1');
  assert.equal(intent.push, false);
});

test('NEUTRAL intent on pause state', () => {
  const state = freshState();
  state.pauseState = 'celebrate';
  const intent = decideFor(state, 'p1');
  assert.equal(intent.kind, INTENT_KINDS.NEUTRAL);
});

test('NEUTRAL intent when self exhausted', () => {
  const state = freshState();
  state.p1.exhausted = true;
  const intent = decideFor(state, 'p1');
  assert.equal(intent.kind, INTENT_KINDS.NEUTRAL);
});
