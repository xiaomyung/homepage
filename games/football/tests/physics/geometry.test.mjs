import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tick,
  FIELD_HEIGHT,
  BALL_RADIUS,
  GOAL_POST_RADIUS,
} from '../../physics/index.js';
import {
  freshState,
  NOOP,
  moveAction,
} from '../helpers/state.mjs';

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

test('ball fully past the goal-line sensor scores for the other side', () => {
  const state = freshState();
  const f = state.field;
  // Place ball fully past the right goal sensor's back face (ball
  // trailing edge past sensor.maxX), inside the mouth aperture, on
  // the ground.
  state.ball.x = f.goalSensorRight.maxX + BALL_RADIUS + 0.5;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 0.5;
  state.ball.vy = 0;
  state.ball.vz = 0;

  tick(state, NOOP, NOOP);

  // Ball crossed the sensor → right goal conceded → LEFT scores
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

test('side wall is solid from INSIDE the goal box (no tunneling out)', () => {
  // Regression for the "ball flies through the goal frame wall" bug:
  // a ball that ends up inside the goal box without scoring (e.g.
  // post deflection sending it through the mouth at an awkward Y)
  // must still be contained by the side walls. Direction-of-approach
  // gates in the old exterior resolver let inside-going-out balls
  // pass through cleanly. Bidirectional resolver should bounce them.
  const state = freshState();
  const f = state.field;
  // Park the ball inside the left goal box, just above the lower side
  // wall (y = mouthYMin), moving toward it from inside.
  state.ball.x = f.goalLineL - 12;             // well inside the box
  state.ball.y = f.goalMouthYMin + 1;          // 1 unit inside the wall
  state.ball.z = 5;
  state.ball.vx = 0; state.ball.vy = -4; state.ball.vz = 0; // heading toward wall
  state.ball.frozen = false;
  state.ball.inGoal = false;                    // !inGoal so the exterior path runs
  state.graceFrames = 999;                      // suppress scoring during the test
  for (let i = 0; i < 5; i++) tick(state, NOOP, NOOP);
  assert.ok(
    state.ball.y >= f.goalMouthYMin,
    `ball must not tunnel through inside lower wall, got y=${state.ball.y}`,
  );
  assert.ok(
    state.ball.vy >= 0,
    `inside-out hit must flip vy positive, got ${state.ball.vy}`,
  );
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
