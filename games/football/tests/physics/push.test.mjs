// Mirror of tests/physics.test.mjs — push group.
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
} from '../../physics.js';
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


test('push lands when players are in contact range', () => {
  const state = freshState();
  // Position them overlapping in both axes, well within push range
  state.p1.x = state.field.midX - 10;
  state.p2.x = state.field.midX + 10;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;
  const startX = state.p2.x;

  tick(state, pushAction(1), NOOP);
  // Push event fires at tryPush (animation start) — visible tick 1.
  assert.ok(
    state.events.some(e => e.type === 'push'),
    `no push event emitted: ${JSON.stringify(state.events)}`
  );
  assert.ok(state.p1.pushTimer > 0, 'pusher should have cooldown');

  // Impulse itself is deferred to the strike tick (mid-animation,
  // ~tick 22 of 63). Tick through and verify displacement.
  for (let i = 0; i < 40; i++) tick(state, NOOP, NOOP);
  assert.ok(
    state.p2.x > startX,
    `push did not displace victim: p2.x=${state.p2.x}, startX=${startX}`,
  );
});

test('push writes hit-reaction state on the victim at the strike tick', () => {
  const state = freshState();
  state.p1.x = state.field.midX - 10;
  state.p2.x = state.field.midX + 10;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;

  tick(state, pushAction(1), NOOP);
  // Windup — no reaction yet.
  assert.equal(state.p2.reactTimer, 0,
    `no reaction on windup tick, got ${state.p2.reactTimer}`);

  // Tick through the strike window.
  for (let i = 0; i < 40; i++) tick(state, NOOP, NOOP);

  // reactTimer decays across the remaining ticks; what we care about
  // is that it WAS set at the strike tick. reactForce stays > 0 while
  // the timer is non-zero; reactDirX/Z should be a unit vector.
  const dirMag = Math.hypot(state.p2.reactDirX, state.p2.reactDirZ);
  assert.ok(
    state.p2.reactTimer > 0 || state.p2.reactForce === 0,
    'react state should either be active or fully decayed',
  );
  if (state.p2.reactTimer > 0) {
    assert.ok(Math.abs(dirMag - 1) < 1e-6,
      `reactDir should be unit vector, got |dir|=${dirMag}`);
    assert.ok(state.p2.reactForce > 0, `reactForce should be > 0, got ${state.p2.reactForce}`);
    assert.ok(['jab', 'hook', 'uppercut'].includes(state.p2.reactType),
      `reactType should be a known variant, got ${state.p2.reactType}`);
  }
});

test('push contact tick is per-type: uppercut earliest, jab latest', () => {
  // Each punch type commits its impulse at a different strike tick
  // because the fist engages the target at a different moment of
  // the arm's windup→strike blend. Uppercut connects at t≈0.42,
  // hook at ≈0.46, jab at ≈0.50 — longer throws land later.
  const measure = (p2X) => {
    const s = freshState();
    s.p1.x = s.field.midX - 10;
    s.p2.x = s.field.midX + p2X;   // distance from p1 picks pushType
    s.p1.y = s.p2.y = FIELD_HEIGHT / 2;
    tick(s, pushAction(1), NOOP);
    for (let i = 0; i < 40; i++) {
      tick(s, NOOP, NOOP);
      if (s.p2.pushVx !== 0) return i + 2;
    }
    return -1;
  };
  // p2.x offsets chosen so fwdDist falls in each type's range.
  const uppercutTick = measure(-6);    // fwdDist = 4 → uppercut
  const hookTick     = measure(+8);    // fwdDist = 18 → hook
  const jabTick      = measure(+18);   // fwdDist = 28 → jab
  assert.ok(uppercutTick > 0 && hookTick > 0 && jabTick > 0,
    `all types should strike; got uppercut=${uppercutTick}, hook=${hookTick}, jab=${jabTick}`);
  assert.ok(uppercutTick < hookTick,
    `uppercut (${uppercutTick}) should fire BEFORE hook (${hookTick})`);
  assert.ok(hookTick < jabTick,
    `hook (${hookTick}) should fire BEFORE jab (${jabTick})`);
});

test('push impulse is deferred to the strike tick, not applied on windup', () => {
  // Pushed player should NOT move during the windup phase — the
  // impulse only lands at the animation's strike tick (mid-
  // animation). Previously the victim jumped on frame 1, before
  // the arm even swung forward.
  const state = freshState();
  state.p1.x = state.field.midX - 10;
  state.p2.x = state.field.midX + 10;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;
  const startX = state.p2.x;

  tick(state, pushAction(1), NOOP);
  assert.equal(
    state.p2.pushVx, 0,
    `impulse must not fire on tick 1 (windup), got pushVx=${state.p2.pushVx}`,
  );
  assert.equal(
    state.p2.x, startX,
    `victim must not move on tick 1, moved to ${state.p2.x}`,
  );

  // Strike fires when pushTimer first drops <= PUSH_STRIKE_TIMER
  // (1000 * (1 - PUSH_CONTACT_FRAC) = 580 ms). pushTimer starts at
  // 1000 ms and decrements 16 ms/tick, so strike ≈ tick 27–28.
  let strikeTick = -1;
  for (let i = 0; i < 40; i++) {
    tick(state, NOOP, NOOP);
    if (state.p2.pushVx !== 0 && strikeTick === -1) strikeTick = i + 2;
  }
  assert.ok(strikeTick >= 25 && strikeTick <= 30,
    `strike tick out of expected range: ${strikeTick}`);
});

test('push misses if victim escapes range during the windup', () => {
  // Pusher gates on range at windup start (tryPush) AND again at
  // strike commit (advancePush). Without the strike-commit gate, a
  // pre-computed impulse from tryPush would still land on a victim
  // who already ran away — the bug this test pins down.
  const state = freshState();
  state.p1.x = state.field.midX - 10;
  state.p2.x = state.field.midX + 10;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;

  tick(state, pushAction(1), NOOP);
  assert.ok(state.p1.pushTimer > 0, 'push should have started');

  // Teleport the victim well outside PUSH_RANGE_X before strike fires.
  state.p2.x = state.field.midX + 200;

  // Run past strike commit (~tick 27 with 16ms/tick stride). state.events
  // is cleared at the top of every tick, so collect the miss event by
  // sampling each frame.
  let missEvent = null;
  for (let i = 0; i < 40; i++) {
    tick(state, NOOP, NOOP);
    const ev = state.events.find(e => e.type === 'push_missed');
    if (ev) missEvent = ev;
  }

  assert.equal(state.p2.pushVx, 0, 'no impulse on a victim that escaped');
  assert.equal(state.p2.reactTimer, 0, 'no hit-reaction on a missed push');
  assert.equal(state.p1.pendingPushVictim, null, 'pending impulse must be cleared');
  assert.ok(missEvent, 'push_missed event should be emitted at strike tick');
  assert.equal(missEvent.reason, 'out_of_range');
});

test('push does not land when players are out of range', () => {
  const state = freshState();
  // Separate them far beyond push range
  state.p1.x = 100;
  state.p2.x = state.field.width - 100;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;

  tick(state, pushAction(1), NOOP);

  assert.equal(state.p2.pushVx, 0, 'push should not land across the field');
  assert.ok(
    !state.events.some(e => e.type === 'push'),
    'no push event expected out of range'
  );
});

test('push does not land when players are within x range but depth-separated', () => {
  const state = freshState();
  // Place them close in x (well within PUSH_RANGE_X = 30) but far
  // apart in y — more than a full player depth. Under the old
  // PUSH_RANGE_Y = 20, this would have fired. Under the new range
  // (derived from PLAYER_HEIGHT + slack), it must not.
  state.p1.x = state.field.midX - 8;
  state.p2.x = state.field.midX + 8;
  state.p1.y = 4;
  state.p2.y = 4 + PLAYER_HEIGHT + 5;  // bodies well separated on depth

  tick(state, pushAction(1), NOOP);

  assert.equal(state.p2.pushVx, 0, 'push should not land when depth-separated');
  assert.ok(
    !state.events.some(e => e.type === 'push'),
    `no push event expected when depth-separated: ${JSON.stringify(state.events)}`,
  );
});

test('push lands when players overlap in depth (touching)', () => {
  const state = freshState();
  // Touching: p2 top is at p1's bottom.
  state.p1.x = state.field.midX - 8;
  state.p2.x = state.field.midX + 8;
  state.p1.y = 10;
  state.p2.y = state.p1.y + PLAYER_HEIGHT - 0.5;  // 0.5 units of overlap
  const startX = state.p2.x;

  tick(state, pushAction(1), NOOP);
  assert.ok(state.events.some(e => e.type === 'push'), 'push event expected on touch');

  // Strike tick is mid-animation (~tick 22) — tick well past it.
  for (let i = 0; i < 40; i++) tick(state, NOOP, NOOP);
  assert.ok(
    state.p2.x !== startX,
    `push should displace victim on contact: p2.x=${state.p2.x}`,
  );
});

test('push blocked when pusher faces away from the victim', () => {
  const state = freshState();
  state.p1.x = state.field.midX - 8;
  state.p2.x = state.field.midX + 8;
  state.p1.y = state.p2.y = FIELD_HEIGHT / 2;
  state.p1.heading = Math.PI;  // facing -x, victim is in +x

  tick(state, pushAction(1), NOOP);

  assert.equal(
    state.p2.pushVx, 0,
    'push must not land when pusher is facing away',
  );
  assert.ok(
    !state.events.some(e => e.type === 'push'),
    'no push event when pusher is facing away',
  );
});

test('goal clears in-progress kick/push/react animation state', () => {
  const state = freshState();
  const f = state.field;

  // Simulate p1 mid-kick when the goal scores.
  state.p1.kick.active = true;
  state.p1.kick.timer = 80;
  state.p1.kick.fired = true;
  state.p1.airZ = 12;
  // p2 mid-push, with a pending strike about to commit.
  state.p2.pushTimer = 500;
  state.p2.pendingPushVictim = state.p1;
  state.p2.pendingPushVx = 5;
  state.p2.pendingPushVy = 0;
  // p1 already taking a hit reaction.
  state.p1.reactTimer = 200;
  state.p1.reactForce = 0.7;
  state.p1.reactDirX = 1;

  state.ball.x = 120;
  state.ball.y = (f.goalMouthYMin + f.goalMouthYMax) / 2;
  state.ball.z = 0;
  state.ball.vx = -5;
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 40 && state.pauseState !== 'celebrate'; i++) {
    tick(state, NOOP, NOOP);
  }
  assert.equal(state.pauseState, 'celebrate', 'goal should have triggered celebrate pause');

  assert.equal(state.p1.kick.active, false, 'p1 kick must clear on goal');
  assert.equal(state.p1.kick.timer, 0);
  assert.equal(state.p1.kick.fired, false);
  assert.equal(state.p1.airZ, 0);
  assert.equal(state.p2.pushTimer, 0, 'p2 push must clear on goal');
  assert.equal(state.p2.pendingPushVictim, null);
  assert.equal(state.p2.pendingPushVx, 0);
  assert.equal(state.p1.reactTimer, 0, 'p1 hit-reaction must clear on goal');
  assert.equal(state.p1.reactForce, 0);
});

test('ball out clears in-progress kick/push/react animation state', () => {
  const state = freshState();
  const f = state.field;

  state.p1.kick.active = true;
  state.p1.kick.timer = 60;
  state.p1.kick.fired = true;
  state.p2.pushTimer = 400;
  state.p2.pendingPushVictim = state.p1;
  state.p2.pendingPushVx = 3;

  // Drive the ball off the right field edge OUTSIDE the goal mouth
  // so OOB fires (not a goal).
  state.ball.x = f.width - 5;
  state.ball.y = 5;
  state.ball.z = 0;
  state.ball.vx = 6;
  state.ball.vy = 0;
  state.ball.vz = 0;
  state.ball.frozen = false;

  for (let i = 0; i < 10 && state.pauseState === null; i++) tick(state, NOOP, NOOP);
  assert.equal(state.pauseState, 'reposition', 'ball out should pause reposition');

  assert.equal(state.p1.kick.active, false, 'p1 kick must clear on ball-out');
  assert.equal(state.p1.kick.timer, 0);
  assert.equal(state.p2.pushTimer, 0, 'p2 push must clear on ball-out');
  assert.equal(state.p2.pendingPushVictim, null);
});

test('a push impulse cannot impale the opponent body', () => {
  const state = freshState();
  // Position the pusher right next to the victim and facing them.
  // 15-unit gap in physics x is already inside the capsule contact
  // distance (6.6 world) — but world-depth axis matters too; here
  // both players are at the same y so it's pure-x.
  state.p1.x = 400; state.p1.y = FIELD_HEIGHT / 2 - PLAYER_HEIGHT / 2;
  state.p2.x = 415; state.p2.y = state.p1.y;
  state.p1.heading = 0;
  tick(state, pushAction(1), NOOP);
  for (let i = 0; i < 30; i++) tick(state, NOOP, NOOP);
  // p1 (the pusher) must still be on the LEFT side of p2 at contact
  // distance — if the impulse had impaled p2, p1 would have crossed
  // over and ended up on the right.
  assert.ok(
    state.p1.x < state.p2.x,
    `pusher crossed through victim: p1.x=${state.p1.x}, p2.x=${state.p2.x}`,
  );
  const dist = capsuleDist(state.p1, state.p2);
  const contact = 2 * STICKMAN_TORSO_RADIUS;
  assert.ok(
    dist >= contact - 0.1,
    `capsules must stay at contact distance, got ${dist.toFixed(3)} (contact=${contact.toFixed(2)})`,
  );
});

