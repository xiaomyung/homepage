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
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  ACTION_KICK_GATE,
  ACTION_KICK_DX,
  ACTION_MOVE_X,
  ACTION_MOVE_Y,
  ACTION_PUSH_GATE,
} from '../physics.js';
import {
  fallbackAction,
  interceptTicks,
  possessionSignal,
  opponentBlocksKick,
  attackWaypoint,
  defenseWaypoint,
  resetTeacher,
  FALLBACK_DEAD_ZONE,
  POSSESSION_COOLDOWN_TICKS,
  PRESS_COMMITMENT_TICKS,
} from '../fallback.js';

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

test('fallback never fires push — symmetric mirror-push destroys match dynamics', () => {
  // Adjacent opp, ball-neutral — old teacher would push; new teacher
  // leaves push to evolution.
  const state = freshState();
  state.p1.x = 400; state.p1.y = FIELD_HEIGHT / 2;
  state.p2.x = 420; state.p2.y = FIELD_HEIGHT / 2;
  assert.equal(fallbackAction(state, 'p1')[ACTION_PUSH_GATE], -1);

  // Far opp — also off.
  state.p1.x = 100;
  state.p2.x = 800;
  assert.equal(fallbackAction(state, 'p1')[ACTION_PUSH_GATE], -1);
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

/* ── Geometric helpers ──────────────────────────────────────── */

test('interceptTicks: stationary player reaches stationary ball in expected ticks', () => {
  // Player centre = (player.x + PLAYER_WIDTH/2, player.y + PLAYER_HEIGHT/2).
  // Put ball 50 world-units away along +x so intercept = 5 ticks at speed 10.
  const ball   = { x: 100, y: 30, vx: 0, vy: 0 };
  const player = { x: 50 - PLAYER_WIDTH / 2, y: 30 - PLAYER_HEIGHT / 2 };
  const t = interceptTicks(ball, player);
  assert.equal(t, 5, `expected 5 ticks, got ${t}`);
});

test('interceptTicks: ball moving away is unreachable in horizon', () => {
  const ball   = { x: 100, y: 30, vx: 20, vy: 0 };            // flees at 20/tick
  const player = { x: 50 - PLAYER_WIDTH / 2, y: 30 - PLAYER_HEIGHT / 2 };
  const t = interceptTicks(ball, player, 30);
  assert.equal(t, Infinity, `expected Infinity, got ${t}`);
});

test('possessionSignal: closer player has positive signal', () => {
  const state = freshState();
  state.p1.x = 100; state.p1.y = 27;
  state.p2.x = 700; state.p2.y = 27;
  state.ball.x = 150; state.ball.y = 27;
  assert.ok(possessionSignal(state, 'p1') > 0);
  assert.ok(possessionSignal(state, 'p2') < 0);
});

test('opponentBlocksKick: opponent pressed against ball on kick side blocks', () => {
  // Ball at (100, 27), kicking right (+x); opponent at (110, 27) — right
  // behind the ball. Should block.
  assert.equal(opponentBlocksKick(100, 27, 1, 0, 110, 27), true);
});

test('opponentBlocksKick: distant opponent on lane does NOT near-block', () => {
  // Same kick, opponent is 100 units downrange — well past NEAR_BLOCK_DIST.
  assert.equal(opponentBlocksKick(100, 27, 1, 0, 200, 27), false);
});

test('opponentBlocksKick: opponent off to the side does not block', () => {
  // Perpendicular distance > body radius.
  assert.equal(opponentBlocksKick(100, 27, 1, 0, 110, 50), false);
});

test('opponentBlocksKick: opponent behind the kicker is NOT in front of the kick', () => {
  // Behind = opposite of kick dir; t < 0.
  assert.equal(opponentBlocksKick(100, 27, 1, 0, 80, 27), false);
});

test('attackWaypoint: target lies BETWEEN ball and own side (on kicking line)', () => {
  const state = freshState();
  state.ball.x = 500; state.ball.y = 27;
  const wp = attackWaypoint(state, state.p1, { x: 0, y: 0 });
  // For p1 (left), goal is on +x side. Waypoint should be slightly to
  // the left of the ball (player runs UP to the ball, hitting it
  // toward the goal).
  assert.ok(wp.x < 500, `expected waypoint.x < ball.x for left-side player, got ${wp.x}`);
});

test('defenseWaypoint: frac=0 is at own goal line, frac=1 is at ball', () => {
  const state = freshState();
  state.ball.x = 500; state.ball.y = 20;
  const f = state.field;
  const atGoal = defenseWaypoint(state, state.p1, 0.0, { x: 0, y: 0 });
  assert.equal(atGoal.x, f.goalLineL);
  const atBall = defenseWaypoint(state, state.p1, 1.0, { x: 0, y: 0 });
  assert.equal(atBall.x, 500);
  assert.equal(atBall.y, 20);
});

/* ── Motion stability ──────────────────────────────────────── */

test('dead zone: tiny move vectors are snapped to zero per-axis', () => {
  // Put the ball almost directly above the player (capture radius
  // misses, but the horizontal axis has a tiny component that dead-
  // zones to 0).
  const state = freshState();
  state.p1.x = 400; state.p1.y = 10;
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 + 0.5;      // 0.5 units to the right
  state.ball.y = state.p1.y + 60;                         // far above
  state.ball.vx = 0; state.ball.vy = 0;
  const out = fallbackAction(state, 'p1');
  assert.equal(out[ACTION_MOVE_X], 0, `moveX should be dead-zoned, got ${out[ACTION_MOVE_X]}`);
  assert.ok(out[ACTION_MOVE_Y] > FALLBACK_DEAD_ZONE, `moveY should stay active, got ${out[ACTION_MOVE_Y]}`);
});

test('capture radius: on-waypoint emits zero move', () => {
  // Place the ball directly on the player's centre — the waypoint
  // offset moves the target back by ~6 units; at this distance
  // we're inside CAPTURE_RADIUS.
  const state = freshState();
  state.p1.x = 400; state.p1.y = 20;
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2 - 2;
  state.ball.y = state.p1.y + 1;
  state.ball.vx = 0; state.ball.vy = 0;
  const out = fallbackAction(state, 'p1');
  // Being inside capture radius, at least the MOVE_Y should be zero.
  // MOVE_X is likely also zero since the player is already roughly on
  // the kick-spot (ball close, waypoint behind ball is near the player).
  const mag = Math.hypot(out[ACTION_MOVE_X], out[ACTION_MOVE_Y]);
  assert.ok(mag < 0.1, `expected near-zero move near waypoint, got mag=${mag}`);
});

/* ── Mode / hysteresis ─────────────────────────────────────── */

test('mode cooldown prevents per-tick flicker on possession ties', () => {
  const state = freshState();
  // Near-tied intercept distance: both players equidistant from ball.
  state.p1.x = 300 - PLAYER_WIDTH / 2; state.p1.y = 27;
  state.p2.x = 500 - PLAYER_WIDTH / 2; state.p2.y = 27;
  state.ball.x = 400; state.ball.y = 27; state.ball.vx = 0; state.ball.vy = 0;
  resetTeacher(state);
  state.tick = 0;

  // First call locks in the teacher's mode.
  fallbackAction(state, 'p1');
  const mode0 = state.p1.teacher.mode;

  // Flip the ball slightly to opposite side (would normally flip mode).
  // Advance only a few ticks — less than cooldown.
  state.tick = Math.floor(POSSESSION_COOLDOWN_TICKS / 2);
  state.ball.x = 350;
  fallbackAction(state, 'p1');
  assert.equal(state.p1.teacher.mode, mode0, 'mode should NOT change before cooldown');

  // Past cooldown: re-evaluation is allowed.
  state.tick = POSSESSION_COOLDOWN_TICKS + 1;
  // Ball is now clearly closer to p1; possession should fire attack.
  state.ball.x = 305;
  fallbackAction(state, 'p1');
  assert.equal(state.p1.teacher.mode, 'attack', 'mode should re-evaluate past cooldown');
});

test('press commitment keeps defender moving toward ball through signal drift', () => {
  const state = freshState();
  // p1 is defender (farther from ball), but close enough to press.
  state.p1.x = 400; state.p1.y = 27;
  state.p2.x = 350; state.p2.y = 27;
  state.ball.x = 340; state.ball.y = 27; state.ball.vx = 0; state.ball.vy = 0;
  resetTeacher(state);
  state.tick = 0;

  fallbackAction(state, 'p1');

  // Press commitment should be set — check the memory flag.
  assert.ok(state.p1.teacher.pressUntil > 0, 'press commitment must activate');

  // Now make the opp dominant (ball further from p1) — naive teacher
  // would retreat. Committed press should keep chasing.
  state.tick = Math.floor(PRESS_COMMITMENT_TICKS / 2);
  state.ball.vx = -20;    // ball flees away from p1

  const second = fallbackAction(state, 'p1');
  // Commitment means we still move toward the ball (attack-style chase).
  // moveX should be negative (ball is left of p1).
  assert.ok(second[ACTION_MOVE_X] < 0,
    `committed press should still chase; got moveX=${second[ACTION_MOVE_X]}`);
});

/* ── Block-to-stop behaviour ─────────────────────────────── */

test('near-blocked kick: teacher stops rather than running into opponent', () => {
  const state = freshState();
  // Player in attack position; opponent pressed right up against the
  // ball on the shot side.
  state.p1.x = 400; state.p1.y = 20;
  state.ball.x = state.p1.x + PLAYER_WIDTH / 2;
  state.ball.y = 20; state.ball.z = 0;
  state.p2.x = state.ball.x + 5; state.p2.y = 20;

  const out = fallbackAction(state, 'p1');
  // Reach-gated + near-blocked → kickGate off, move = zero.
  assert.equal(out[ACTION_KICK_GATE], -1, 'kick should NOT fire when near-blocked');
  assert.equal(out[ACTION_MOVE_X], 0, 'movement should stop, not run into opponent');
});
