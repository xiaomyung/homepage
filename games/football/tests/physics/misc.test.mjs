import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tick,
  FIELD_HEIGHT,
  MAX_PLAYER_SPEED,
  STICKMAN_HEAD_RADIUS,
  STICKMAN_TORSO_RADIUS,
  PLAYER_PAIR_SEPARATION_GAP,
  PLAYER_PAIR_STUCK_TICKS,
} from '../../physics/index.js';
import {
  freshState,
  NOOP,
  moveAction,
  pushAction,
  capsuleDist,
} from '../helpers/state.mjs';

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

test('post-collision pair distance includes the personal-space gap', () => {
  // Regression for the steady-state lock: the old resolver settled
  // pairs at exactly dist=r, so an AI inward press could re-overlap
  // them every tick and lock them at the contact distance forever.
  // After the gap fix, post-resolution distance must be at least
  // r + PLAYER_PAIR_SEPARATION_GAP.
  const state = freshState();
  state.p1.x = 400; state.p1.y = 27;
  state.p2.x = 400; state.p2.y = 27;
  tick(state, NOOP, NOOP);
  // capsuleDist returns surface-to-surface distance for the torso
  // capsule (radius STICKMAN_TORSO_RADIUS). The pair-collision uses
  // a wider radius (2 * STICKMAN_HEAD_RADIUS), so the centre-to-centre
  // distance after resolution is r + GAP. Reconstruct centre distance:
  const centreDist = capsuleDist(state.p1, state.p2) + 2 * STICKMAN_TORSO_RADIUS;
  const targetCentre = 2 * STICKMAN_HEAD_RADIUS + PLAYER_PAIR_SEPARATION_GAP;
  assert.ok(
    centreDist >= targetCentre - 0.05,
    `pair must separate to centre dist ≥ ${targetCentre}, got ${centreDist.toFixed(3)}`,
  );
});

test('stuck pair escalator fires after PLAYER_PAIR_STUCK_TICKS in contact', () => {
  // Drive both players inward toward each other for longer than the
  // stuck threshold, with no AI movement. The escalator should add
  // an outward velocity impulse and reset the counter.
  const state = freshState();
  state.headless = true;        // skip pause-state side effects
  state.graceFrames = 99999;    // suppress scoring
  state.p1.x = 400; state.p1.y = 27;
  state.p2.x = 408; state.p2.y = 27; // already touching at r=8
  state.p1.heading = 0;
  state.p2.heading = Math.PI;
  // Hold inward velocity each tick by feeding a converging move
  // action — moveX +1 for p1 (rightward, into p2), -1 for p2.
  let escalated = false;
  for (let i = 0; i < PLAYER_PAIR_STUCK_TICKS + 5; i++) {
    tick(state, moveAction(1), moveAction(-1));
    // Counter resets to 0 the tick the escalator fires.
    if (state.pairContactTicks === 0 && i >= PLAYER_PAIR_STUCK_TICKS - 1) {
      escalated = true;
      break;
    }
  }
  assert.ok(escalated, 'stuck escalator must fire and reset the counter');
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
