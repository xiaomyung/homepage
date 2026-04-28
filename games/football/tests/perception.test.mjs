/**
 * Tests for ai/perception.js — pure state -> facts.
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
import { perceive, interceptTicks } from '../ai/perception.js';

function freshState(seed = 42) {
  return createState(createField(), createSeededRng(seed));
}

test('selfDistToBall and oppDistToBall are Euclidean distances', () => {
  const state = freshState();
  // Place players so their CENTERS sit on FIELD_HEIGHT/2 to align with ball.y.
  state.p1.x = 100; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 600; state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 200; state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = 0; state.ball.vy = 0;

  const facts = perceive(state, 'p1');
  const selfCx = state.p1.x + PLAYER_WIDTH / 2;
  const oppCx = state.p2.x + PLAYER_WIDTH / 2;
  assert.ok(Math.abs(facts.selfDistToBall - Math.abs(state.ball.x - selfCx)) < 1e-6);
  assert.ok(Math.abs(facts.oppDistToBall - Math.abs(state.ball.x - oppCx)) < 1e-6);
});

test('selfInterceptTicks < oppInterceptTicks when self closer', () => {
  const state = freshState();
  state.p1.x = 200; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 700; state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 300; state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = 0; state.ball.vy = 0;

  const facts = perceive(state, 'p1');
  assert.ok(facts.selfInterceptTicks < facts.oppInterceptTicks);
});

test('equal-distance produces equal intercept ticks', () => {
  const state = freshState();
  // Mirror-symmetric around ball: self center x and opp center x equidistant from ball.x.
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = 0; state.ball.vy = 0;
  state.p1.x = 200 - PLAYER_WIDTH / 2;
  state.p2.x = 600 - PLAYER_WIDTH / 2;
  state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;

  const facts1 = perceive(state, 'p1');
  const facts2 = perceive(state, 'p2');
  assert.equal(facts1.selfInterceptTicks, facts2.selfInterceptTicks);
});

test('attackKickSpot lies on ball -> opp goal line for left side', () => {
  const state = freshState();
  state.p1.x = 200; state.p1.y = FIELD_HEIGHT / 2;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = 0; state.ball.vy = 0;

  const facts = perceive(state, 'p1');
  const kickSpot = facts.attackKickSpot;
  // kickSpot should be just behind ball (toward midfield from ball, since
  // we're aiming toward right goal which is past the ball).
  assert.ok(kickSpot.x < state.ball.x, 'kickSpot should be on ball-side of ball -> right goal line');
  assert.ok(Math.abs(kickSpot.y - state.ball.y) < 1, 'y-coordinate close to ball when ball is at field centre');
});

test('attackKickSpot mirror for right side', () => {
  const state = freshState();
  state.p2.x = 600; state.p2.y = FIELD_HEIGHT / 2;
  state.ball.x = 400; state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = 0; state.ball.vy = 0;

  const facts = perceive(state, 'p2');
  // Right side aims at left goal — kickSpot is on the right of the ball.
  assert.ok(facts.attackKickSpot.x > state.ball.x);
});

test('pushOpportunity true when opp between self and ball, in range, facing aligned', () => {
  const state = freshState();
  state.p1.x = 100; state.p1.y = FIELD_HEIGHT / 2;
  state.p2.x = 105; state.p2.y = FIELD_HEIGHT / 2;
  state.ball.x = 130; state.ball.y = FIELD_HEIGHT / 2;
  state.p1.heading = 0;

  const facts = perceive(state, 'p1');
  assert.equal(facts.pushOpportunity, true);
});

test('pushOpportunity false when opp far away', () => {
  const state = freshState();
  state.p1.x = 100; state.p1.y = FIELD_HEIGHT / 2;
  state.p2.x = 600; state.p2.y = FIELD_HEIGHT / 2;
  state.ball.x = 700; state.ball.y = FIELD_HEIGHT / 2;
  state.p1.heading = 0;

  const facts = perceive(state, 'p1');
  assert.equal(facts.pushOpportunity, false);
});

test('threatensOwnGoal true when ball heads toward own goal at speed past midfield', () => {
  const state = freshState();
  state.p1.x = 100; state.p1.y = FIELD_HEIGHT / 2;
  state.ball.x = state.field.midX - 50;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = -5;
  state.ball.vy = 0;

  const facts = perceive(state, 'p1');
  assert.equal(facts.threatensOwnGoal, true);
  assert.ok(facts.ownGoalInterceptY !== null);
});

test('threatensOwnGoal false when ball heads away from own goal', () => {
  const state = freshState();
  state.p1.x = 100;
  state.ball.x = state.field.midX - 50;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = +5;
  state.ball.vy = 0;

  const facts = perceive(state, 'p1');
  assert.equal(facts.threatensOwnGoal, false);
});

test('selfBlocked true when pauseState set', () => {
  const state = freshState();
  state.pauseState = 'celebrate';
  const facts = perceive(state, 'p1');
  assert.equal(facts.selfBlocked, true);
});

test('selfBlocked true when player is exhausted', () => {
  const state = freshState();
  state.p1.exhausted = true;
  const facts = perceive(state, 'p1');
  assert.equal(facts.selfBlocked, true);
});

test('selfBlocked true when push is in progress', () => {
  const state = freshState();
  state.p1.pushTimer = 500;
  const facts = perceive(state, 'p1');
  assert.equal(facts.selfBlocked, true);
});

test('selfKicking reflects player.kick.active', () => {
  const state = freshState();
  state.p1.kick.active = true;
  const facts = perceive(state, 'p1');
  assert.equal(facts.selfKicking, true);
});

test('perceive does not mutate state', () => {
  const state = freshState();
  state.p1.x = 200;
  state.ball.x = 400;
  const before = JSON.stringify({
    p1: { x: state.p1.x, y: state.p1.y },
    ball: { x: state.ball.x, y: state.ball.y },
    pauseState: state.pauseState,
  });
  perceive(state, 'p1');
  const after = JSON.stringify({
    p1: { x: state.p1.x, y: state.p1.y },
    ball: { x: state.ball.x, y: state.ball.y },
    pauseState: state.pauseState,
  });
  assert.equal(before, after);
});

test('interceptTicks zero when player is on the ball', () => {
  const state = freshState();
  state.p1.x = 200 - PLAYER_WIDTH / 2;
  state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.ball.x = 200;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = 0; state.ball.vy = 0;

  assert.equal(interceptTicks(state.ball, state.p1, 30), 0);
});
