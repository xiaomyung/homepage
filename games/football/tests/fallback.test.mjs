/**
 * Phase 3 unit tests for fallback.js — the deterministic handcoded AI
 * that serves both as the in-game fallback opponent and as the imitation
 * teacher for the warm-start seed. Any non-determinism here corrupts
 * the teaching signal (see memory: project_football_warm_start_fallback).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createField,
  createState,
  createSeededRng,
  FIELD_HEIGHT,
  ACTION_KICK_GATE,
  ACTION_KICK_DX,
  ACTION_PUSH_GATE,
} from '../physics.js';
import { fallbackAction } from '../fallback.js';

function freshState(seed = 42) {
  return createState(createField(), createSeededRng(seed));
}

/* ── Movement ────────────────────────────────────────────────── */

test('fallback moves toward ball when ball is to the right', () => {
  const state = freshState();
  state.p1.x = 200;
  state.p1.y = FIELD_HEIGHT / 2;
  state.ball.x = 400;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.vx = 0;
  state.ball.vy = 0;

  const [moveX, moveY] = fallbackAction(state, 'p1');
  assert.ok(moveX > 0, `expected positive moveX (toward ball), got ${moveX}`);
  assert.ok(Math.abs(moveY) < 0.1, `expected ~zero moveY (ball is level), got ${moveY}`);
});

test('fallback moves toward ball when ball is to the left', () => {
  const state = freshState();
  state.p1.x = 400;
  state.p1.y = FIELD_HEIGHT / 2;
  state.ball.x = 200;
  state.ball.y = FIELD_HEIGHT / 2;

  const [moveX] = fallbackAction(state, 'p1');
  assert.ok(moveX < 0, `expected negative moveX (toward ball), got ${moveX}`);
});

test('fallback move vector is unit-length (or near it)', () => {
  const state = freshState();
  state.p1.x = 200;
  state.ball.x = 800;
  state.ball.y = 30;
  const [moveX, moveY] = fallbackAction(state, 'p1');
  const mag = Math.sqrt(moveX * moveX + moveY * moveY);
  assert.ok(mag > 0.9 && mag <= 1.001, `move vector should be unit length, got ${mag}`);
});

/* ── Kick ────────────────────────────────────────────────────── */

test('fallback kicks when ball is within reach on the ground', () => {
  const state = freshState();
  const f = state.field;
  // Put ball right in front of the player, aligned with the body
  // axis so the new hip-sphere reach gate accepts it. Under the
  // old bubble-centric check the ball could be `+PLAYER_HEIGHT/2`
  // off-depth; with the IK reach sphere the perp offset eats too
  // much of the `U+L = 20` budget and the kick rejects.
  state.p1.x = 400;
  state.p1.y = 20;
  state.ball.x = state.p1.x + f.playerWidth / 2; // centered on player
  state.ball.y = state.p1.y;
  state.ball.z = 0;
  state.ball.vx = 0;

  const out = fallbackAction(state, 'p1');
  assert.equal(out[ACTION_KICK_GATE], 1, `kick should fire; full out=${JSON.stringify(out)}`);
});

test('fallback does not kick when ball is far away', () => {
  const state = freshState();
  state.p1.x = 100;
  state.ball.x = 800;
  state.ball.y = 21;
  state.ball.z = 0;

  const out = fallbackAction(state, 'p1');
  assert.equal(out[ACTION_KICK_GATE], -1, 'kick should not fire when ball is distant');
});

test('p1 (left side) kicks toward the right goal', () => {
  const state = freshState();
  const f = state.field;
  state.p1.x = 400;
  state.ball.x = state.p1.x + f.playerWidth / 2;
  state.ball.y = state.p1.y + 3;
  state.ball.z = 0;

  const out = fallbackAction(state, 'p1');
  assert.ok(out[ACTION_KICK_DX] > 0, `p1 kickDx should point right, got ${out[ACTION_KICK_DX]}`);
});

test('p2 (right side) kicks toward the left goal', () => {
  const state = freshState();
  const f = state.field;
  state.p2.x = 400;
  state.ball.x = state.p2.x + f.playerWidth / 2;
  state.ball.y = state.p2.y + 3;
  state.ball.z = 0;

  const out = fallbackAction(state, 'p2');
  assert.ok(out[ACTION_KICK_DX] < 0, `p2 kickDx should point left, got ${out[ACTION_KICK_DX]}`);
});

/* ── Push (deterministic, fix for imitation teaching) ───────── */

test('fallback pushes when opponent is adjacent', () => {
  const state = freshState();
  state.p1.x = 400;
  state.p1.y = FIELD_HEIGHT / 2;
  state.p2.x = 420; // 20 px away, within PUSH_RANGE_X=30
  state.p2.y = FIELD_HEIGHT / 2;

  const out = fallbackAction(state, 'p1');
  assert.equal(out[ACTION_PUSH_GATE], 1, `push should fire; full out=${JSON.stringify(out)}`);
});

test('fallback does not push when opponent is far', () => {
  const state = freshState();
  state.p1.x = 100;
  state.p2.x = 800;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;

  const out = fallbackAction(state, 'p1');
  assert.equal(out[ACTION_PUSH_GATE], -1, 'push should not fire when opponent is far');
});

/* ── Determinism (the whole point) ──────────────────────────── */

test('identical state produces identical output across repeated calls', () => {
  const state = freshState();
  state.p1.x = 300; state.p1.y = 15;
  state.p2.x = 400; state.p2.y = 20;
  state.ball.x = 500; state.ball.y = 25; state.ball.vx = 2;

  const out1 = fallbackAction(state, 'p1');
  const out2 = fallbackAction(state, 'p1');
  const out3 = fallbackAction(state, 'p1');
  assert.deepEqual(out1, out2);
  assert.deepEqual(out2, out3);
});

test('fallback output contains no NaN or Infinity', () => {
  const state = freshState();
  // Edge case: ball exactly on player (dist would be 0 without guard)
  state.p1.x = 400;
  state.p1.y = 21;
  state.ball.x = 409;
  state.ball.y = 21;
  state.ball.vx = 0;

  const out = fallbackAction(state, 'p1');
  for (const v of out) {
    assert.ok(Number.isFinite(v), `non-finite output: ${v} in ${JSON.stringify(out)}`);
  }
});
