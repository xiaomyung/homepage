import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tick,
  FIELD_HEIGHT,
  PLAYER_WIDTH,
  BALL_RADIUS,
  MAX_PLAYER_SPEED,
  Z_STRETCH,
  STICKMAN_TORSO_RADIUS,
} from '../../physics/index.js';
import {
  freshState,
  NOOP,
  trapState,
} from '../helpers/state.mjs';

test('ball bounces off top and bottom walls, never leaves via those borders', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = f.width / 2;
  state.ball.y = FIELD_HEIGHT / 2;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vy = 30;  // strong push toward bottom wall
  state.ball.vz = 0;

  for (let i = 0; i < 200; i++) {
    tick(state, NOOP, NOOP);
    assert.ok(
      state.ball.y - BALL_RADIUS >= -0.01 && state.ball.y + BALL_RADIUS <= FIELD_HEIGHT + 0.01,
      `ball escaped top/bottom at tick ${i}: y=${state.ball.y}`
    );
  }
  // Ball must not have been OOB'd (top/bottom borders bounce, never out)
  assert.ok(
    !state.events.some(e => e.type === 'out'),
    'ball should not be OOB from top/bottom borders'
  );
});

test('ball hitting top touchline bounces and stays in play', () => {
  const state = freshState();
  state.ball.x = 450;
  state.ball.y = FIELD_HEIGHT - 2;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vy = 4;          // heading toward the touchline
  state.ball.frozen = false;
  // Let it bounce
  for (let i = 0; i < 20; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, null, 'top touchline must not trigger OOB');
  assert.ok(
    state.ball.vy < 0,
    `top touchline should flip vy to negative after bounce, got ${state.ball.vy}`,
  );
  assert.ok(
    state.ball.y < FIELD_HEIGHT,
    'ball must remain inside the field after bouncing off the top touchline',
  );
});

test('ball hitting bottom touchline bounces and stays in play', () => {
  const state = freshState();
  state.ball.x = 450;
  state.ball.y = 2;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vy = -4;
  state.ball.frozen = false;
  for (let i = 0; i < 20; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, null, 'bottom touchline must not trigger OOB');
  assert.ok(
    state.ball.vy > 0,
    `bottom touchline should flip vy to positive after bounce, got ${state.ball.vy}`,
  );
  assert.ok(state.ball.y > 0);
});

test('airborne ball hitting ceiling bounces and stays in play', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = 450;
  state.ball.y = 27;
  state.ball.z = f.ceiling - 2;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = 4;
  state.ball.frozen = false;
  for (let i = 0; i < 20; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, null, 'ceiling bounce must not trigger OOB');
  assert.ok(
    state.ball.vz < 0,
    `ceiling should flip vz to negative after bounce, got ${state.ball.vz}`,
  );
  assert.ok(state.ball.z <= f.ceiling);
});

test('ball continues moving after scoring instead of freezing', () => {
  const state = freshState();
  const f = state.field;
  // Shot from the field side into the right mouth on the ground.
  state.ball.x = f.goalLineR - 1;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = 12; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  tick(state, NOOP, NOOP);

  // Goal fires, ball NOT frozen, inGoal flag is set.
  assert.equal(state.scoreL, 1);
  assert.equal(state.pauseState, 'celebrate');
  assert.equal(state.ball.frozen, false, 'ball should remain unfrozen');
  assert.ok(state.ball.inGoal, 'inGoal flag should be set');
});

test('ball cleanly through the lower mouth shoulder scores', () => {
  // The old inset gate added GOAL_POST_RADIUS to mouthYMin in the
  // scoring test, killing goals where ball.y was just inside the post.
  // Posts physically deflect anything they touch — once the ball is
  // past the line and inside the aperture it must score.
  const state = freshState();
  const f = state.field;
  state.ball.x = f.goalLineL + 1;                                  // field side, just outside line
  state.ball.y = f.goalMouthYMin + BALL_RADIUS + 0.01;             // just clear of the lower post
  state.ball.z = 0;
  state.ball.vx = -12; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  tick(state, NOOP, NOOP);
  assert.equal(state.scoreR, 1, `lower-shoulder shot must score, ball.y=${state.ball.y}`);
});

test('ball cleanly through the upper mouth shoulder scores', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = f.goalLineR - 1;
  state.ball.y = f.goalMouthYMax - BALL_RADIUS - 0.01;             // just clear of the upper post
  state.ball.z = 0;
  state.ball.vx = 12; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  tick(state, NOOP, NOOP);
  assert.equal(state.scoreL, 1, `upper-shoulder shot must score, ball.y=${state.ball.y}`);
});

test('low-velocity shot rolling between the posts still scores', () => {
  // Original bug was reproducible at very low ball speeds. With the
  // sensor approach a ball that crosses the line keeps inheriting the
  // crossing flag and eventually clears the slab even under friction.
  const state = freshState();
  const f = state.field;
  state.ball.x = f.goalLineL + 2;                                  // just on field side
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = -2; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  for (let i = 0; i < 80 && state.scoreR === 0; i++) tick(state, NOOP, NOOP);
  assert.equal(state.scoreR, 1, 'low-velocity rolling shot must score');
});

test('ball just below the crossbar scores', () => {
  const state = freshState();
  const f = state.field;
  state.ball.x = f.goalLineR - 1;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = f.goalMouthZMax - BALL_RADIUS - 0.01;             // just below crossbar
  state.ball.vx = 12; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;
  tick(state, NOOP, NOOP);
  assert.equal(state.scoreL, 1, `under-bar shot must score, ball.z=${state.ball.z}`);
});

test('ball straight at torso — trap fires immediately and kills normal velocity', () => {
  const state = trapState();
  state.recordEvents = true;
  const p = state.p1;
  const initialSpeed = 10;
  // Ball waist-high, on the body axis y, moving directly at the torso.
  state.ball.x = p.x + PLAYER_WIDTH / 2 - 10;
  state.ball.y = p.y;
  state.ball.z = 12;
  state.ball.vx = initialSpeed; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  // One tick is enough for the ball to contact the torso
  // (distance 10, vx=10 → contact this tick).
  tick(state, NOOP, NOOP);

  // Trap event fired.
  assert.ok(
    state.events.some((e) => e.type === 'ball_trap'),
    'trap event must fire on torso contact',
  );
  // Head-on hit: normal is purely -x, tangential velocity is zero, so
  // the cushion brings ball.vx all the way to 0 (within float noise).
  assert.ok(
    Math.abs(state.ball.vx) < 0.01,
    `head-on trap must zero the normal-component velocity, got vx=${state.ball.vx}`,
  );
});

test('ball that was trapped settles on the ground close to the player', () => {
  const state = trapState();
  const p = state.p1;
  state.ball.x = p.x + PLAYER_WIDTH / 2 - 10;
  state.ball.y = p.y;
  state.ball.z = 12;
  state.ball.vx = 10; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 60; i++) tick(state, NOOP, NOOP);

  assert.ok(state.ball.z <= BALL_RADIUS + 0.1,
    `ball should settle on ground, got z=${state.ball.z}`);
  // Head-on hit zeroes horizontal velocity; ball drops through gravity
  // to the ground and sits roughly at the clamp point. Bound is the
  // expected contact distance plus a small margin — any meaningful
  // roll would exceed this.
  const contactDist = STICKMAN_TORSO_RADIUS + BALL_RADIUS;
  const horizontalDist = Math.hypot(
    state.ball.x - (p.x + PLAYER_WIDTH / 2),
    state.ball.y - (p.y),
  );
  assert.ok(horizontalDist <= contactDist + 1,
    `trapped ball should stop at ~contact distance (${contactDist.toFixed(2)}), got ${horizontalDist.toFixed(2)}`);
});

test('ball falling onto head fires a trap event and kills normal velocity', () => {
  const state = trapState();
  state.recordEvents = true;
  const p = state.p1;
  state.ball.x = p.x + PLAYER_WIDTH / 2 - 1;
  state.ball.y = p.y;
  state.ball.z = 60;
  state.ball.vx = 1; state.ball.vy = 0; state.ball.vz = -8;
  state.ball.frozen = false;

  // Advance until trap fires. Head-hit is expected ~1 tick after
  // ball.z crosses head-contact (≈52.87). Gravity + vz=−8 → ~1 tick.
  let fireTickVz = null;
  for (let i = 0; i < 20; i++) {
    tick(state, NOOP, NOOP);
    if (state.events.some((e) => e.type === 'ball_trap')) {
      fireTickVz = state.ball.vz;
      break;
    }
  }

  assert.ok(fireTickVz !== null, 'trap event must fire when ball contacts the head');
  // The cushion kills the normal-component (mostly −y) completely —
  // the stuck-escape nudge zeroes vz when it kicks in, and even a
  // small lateral component leaves the surviving vertical tiny. A
  // full tick of gravity afterwards (−0.3) is the only real residue.
  assert.ok(
    fireTickVz > -0.5,
    `head trap must kill most of downward velocity (was −8), got vz=${fireTickVz}`,
  );
});

test('ball that was head-trapped settles on the ground close to the player', () => {
  const state = trapState();
  const p = state.p1;
  state.ball.x = p.x + PLAYER_WIDTH / 2 - 1;
  state.ball.y = p.y;
  state.ball.z = 60;
  state.ball.vx = 1; state.ball.vy = 0; state.ball.vz = -8;
  state.ball.frozen = false;

  // Stop short of the 188-tick headless stall reset which would
  // teleport the ball to midfield and hide the real settling point.
  for (let i = 0; i < 150; i++) tick(state, NOOP, NOOP);

  assert.ok(state.ball.z <= BALL_RADIUS + 0.1,
    `ball must end up on ground, got z=${state.ball.z}`);
  // Tight bound: post-trap the ball drops mostly straight down off
  // the head (tunnel-correction places it ~contact distance to the
  // player's front), so it should rest within one player-width.
  const horizontalDist = Math.hypot(
    state.ball.x - (p.x + PLAYER_WIDTH / 2),
    state.ball.y - (p.y),
  );
  assert.ok(horizontalDist <= PLAYER_WIDTH,
    `head-trapped ball should settle within one player-width, got ${horizontalDist.toFixed(2)}`);
});

test('ball passing at shoulder clearance does NOT contact torso', () => {
  const state = trapState();
  state.recordEvents = true;
  const p = state.p1;
  // Lateral clearance (physics y in world-depth units): translate the
  // world-space "just past torso+ball radii" into physics y by
  // dividing by Z_STRETCH.
  const clearanceWorld = STICKMAN_TORSO_RADIUS + BALL_RADIUS + 1;
  const clearancePhysY = clearanceWorld / Z_STRETCH;
  const initialVx = 15;
  state.ball.x = p.x + PLAYER_WIDTH / 2 - 60;
  state.ball.y = p.y + clearancePhysY;
  state.ball.z = 12;
  state.ball.vx = initialVx; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  // Run just long enough for the ball to cross the player's x range,
  // staying airborne (no ground friction). Air friction * ~10 ticks
  // is ~10 %, so we check vx stays >70 % of initial.
  for (let i = 0; i < 10; i++) tick(state, NOOP, NOOP);

  assert.ok(
    !state.events.some((e) => e.type === 'ball_trap'),
    'ball passing at shoulder clearance must not fire trap',
  );
  assert.ok(state.ball.x > p.x + PLAYER_WIDTH,
    `ball should have passed player, x=${state.ball.x}`);
  assert.ok(state.ball.vx > initialVx * 0.7,
    `ball vx should retain most of its speed in 10 ticks, got ${state.ball.vx}`);
});

test('walking into a stationary ball pins it ahead of the player (dribble, stable regime)', () => {
  // Drive the player at a modest constant speed (5 u/tick) that the
  // ball can track — GROUND_FRICTION decays ball.vx ~5.6 %/tick, so
  // the per-contact boost just needs to refill that. Max-speed ramp
  // is the RUN case and is tested separately below.
  const state = trapState();
  const p = state.p1;
  state.ball.x = p.x + PLAYER_WIDTH / 2 + 30;
  state.ball.y = p.y;
  state.ball.z = BALL_RADIUS;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  const walkHalf = [0.5, 0, -1, 0, 0, 0, 0, -1, 0];  // target vx = 5

  // Let the player ramp + catch the ball (takes about 10-15 ticks).
  for (let i = 0; i < 20; i++) tick(state, walkHalf, NOOP);

  // Now verify that the dribble stays stable for the NEXT 20 ticks:
  // the gap must stay at contact distance each tick (tight tolerance).
  const expected = STICKMAN_TORSO_RADIUS + BALL_RADIUS;
  for (let i = 0; i < 20; i++) {
    tick(state, walkHalf, NOOP);
    const gap = state.ball.x - (state.p1.x + PLAYER_WIDTH / 2);
    assert.ok(
      Math.abs(gap - expected) < 0.5,
      `dribble tick ${i}: gap should be ~${expected.toFixed(2)}, got ${gap.toFixed(2)}`,
    );
  }
});

test('dribble survives a full sprint (tunnel-correction keeps ball in front)', () => {
  // User's choice for this task was "ball stays pinned at feet" even
  // at sprint speed (arcade feel, not realistic-physics). This test
  // pins that contract: if the player runs past the ball, the
  // tunnel-correction teleports the ball back to the front, dribble
  // continues.
  const state = trapState();
  const p = state.p1;
  state.ball.x = p.x + PLAYER_WIDTH / 2 + 30;
  state.ball.y = p.y;
  state.ball.z = BALL_RADIUS;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
  state.ball.frozen = false;

  const moveRight = [1, 0, -1, 0, 0, 0, 0, -1, 0];
  // 40 ticks of full sprint gives the player time to ramp to
  // MAX_PLAYER_SPEED (10 u/tick) and then some.
  for (let i = 0; i < 40; i++) tick(state, moveRight, NOOP);

  const gap = state.ball.x - (state.p1.x + PLAYER_WIDTH / 2);
  const expected = STICKMAN_TORSO_RADIUS + BALL_RADIUS;
  // Ball should be on the player's forward side (+x) at roughly the
  // contact distance, even after acceleration past the ball.
  assert.ok(
    gap > 0 && gap < expected + 1,
    `ball should still be pinned in front after sprint, got gap=${gap.toFixed(2)}`,
  );
});
